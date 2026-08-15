/**
 * The seam between the app and `agent-harness` — the FIFTH one, and the last.
 *
 * Components call this, never `agent-harness` directly. It is the same charter
 * the other four were written under (`patternService`, `compositionService`,
 * `voiceService`, `playbackService`) and it contains the same four things:
 *   - the harness is a sibling package under active co-development, so its shape
 *     can change between builds and exactly one file should have to follow;
 *   - it carries a lot we do not use — a WebSocket server, a client SDK, session
 *     stores, consent transports — none of which should leak into a component;
 *   - running a model is asynchronous, refusable and cancellable, and every one
 *     of those has to be a RETURNED value rather than an exception a `onClick`
 *     has to remember to catch;
 *   - it is the only place a provider URL and token are turned into a request,
 *     which is the one thing in this app that must not be scattered.
 *
 * ⚠ **This is the only module in the app that may import `agent-harness`**, and
 * the only entry it may import is `agent-harness/browser`. The default `.` entry
 * pulls in `ws` and Node builtins and does not survive a browser build; the
 * `./client` entry is a WebSocket client to a harness SERVER, which is precisely
 * what this app has decided not to run. The tripwire in `tests/AgentTools.test
 * .ts` pins both facts.
 *
 * ── What it deliberately does NOT own ───────────────────────────────────────
 *
 *   - **What the agent can DO.** That is `./tools` (AG-04), which names no
 *     harness type on purpose. This file only ADAPTS that shape — see
 *     {@link toToolDef}, which is the whole reason the two layers can be
 *     versioned apart.
 *   - **What the user is OFFERED.** That is `./commandCatalog` (AG-05).
 *   - **Where the provider lives.** That is `./connectorSettings` (AG-08), and
 *     there is no second config path — a run reads the same values the Connector
 *     panel writes, or it refuses.
 */
import {
  OpenAICompatibleClient,
  ToolRegistry,
  runAgent,
  type Agent,
  type AgentEvent,
  type ModelClient,
  type ToolDef,
} from 'agent-harness/browser';
import { getConnectorSettings, isConfigured, type ConnectorSettings } from './connectorSettings';
import { normalizeBaseUrl, validateBaseUrl } from './testConnection';
import type { AgentTool, JsonSchema } from './tools/types';
import type { Result } from '../patterns/patternService';

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const refuse = (reason: string): Result<never> => ({ ok: false, reason });

export type { AgentEvent };

/**
 * The model name sent in the request body when a caller does not name one.
 *
 * There is no model field in the connector settings, and this seam does not add
 * one — a second config path is exactly what the ticket forbids. The value is
 * mostly decorative for the target of this slice: a local llama-server serves
 * whichever model it was started with and ignores the name. A provider that
 * routes on it needs {@link RunAgentTaskOptions.modelId}, and giving it a real
 * home is the connector's problem to solve when a run actually needs it — it is
 * tracked in `docs/FOLLOW-UPS.md` §4b.
 *
 * ⚠ Deliberately NOT `TEST_REQUEST_MODEL`. That name is one the probe wants to
 * be REJECTED — `testConnection`'s whole 404 story is "this probe sends a model
 * that is not meant to exist, so a 404 need not mean your path is wrong". A run
 * wants the opposite: a name a provider might actually serve. Collapsing the two
 * would make one of those two sentences false. What they share — that neither is
 * a name the user chose — is the gap, and it is in the doc rather than papered
 * over by giving a probe and a run the same wrong answer.
 */
export const DEFAULT_MODEL_ID = 'local-model';

/**
 * The ceiling on ONE model reply, in completion tokens.
 *
 * ── What it is a bound on ───────────────────────────────────────────────────
 *
 * ONE `pattern_stamp_notes` call carrying one pass of a phrase plus its
 * `repeat`, AND the reasoning that precedes it. Both halves, because a ceiling
 * is on COMPLETION tokens and this model's `reasoning_content` is billed to the
 * same budget — the harness streams it apart from the content (`onThinking`) but
 * the provider does not budget it apart.
 *
 * The stamp half is what AG-10's `repeat` was built to bound: twelve bars of a
 * one-bar riff is one bar of notes and a count, not twelve bars of notes. A note
 * costs roughly 25-40 tokens (`{"stringIndex":2,"fret":5,"tick":480,
 * "durationTicks":240}`), so the widest legitimate call — a through-composed
 * pass, say a 48-note walking line, which `repeat` cannot compress — is about
 * 2000. The reasoning half is measured, not guessed: the largest iteration that
 * SUCCEEDED in the 2026-08-10 backing-track run cost 1610 completion tokens and
 * was mostly reasoning (the other four cost 173, 292, 416 and 736). So a real
 * worst case is around 4000, and this is that doubled.
 *
 * The headroom is deliberate and asymmetric. Overshooting costs tokens on a run
 * that was already failing; undershooting truncates a legitimate call mid-JSON,
 * which is not degradation but the very failure below — a cap set tight enough
 * to bite manufactures what it exists to bound. The harness's history
 * `summarizeMessages` reuses this same client, so the cap applies to a summary
 * too; a summary is far smaller than this and never bumps it.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 *
 * It does not prevent a runaway, and it does not change what one looks like. A
 * tool call truncated at a token ceiling is malformed JSON whichever ceiling
 * stopped it, so the provider still answers "Failed to parse tool call arguments
 * as JSON … unexpected end of input" and the run still ends in error and rolls
 * back. What changes is the PRICE: the run this came from burned 51593
 * completion tokens in one call (65536 for the iteration) before dying, and this
 * bounds that at 8192 — the same ending, roughly a sixth of the cost and of the
 * wait. Damage control, nothing more. What actually PREVENTS this class is
 * refusing the impossible call up front, in the tool.
 *
 * Deliberately not a `RunAgentTaskOptions` field. It is a property of what this
 * app's tools can be asked for, not a per-caller preference.
 */
const MAX_COMPLETION_TOKENS = 8192;

/**
 * An agent, described WITHOUT naming a harness type.
 *
 * Same reason `./tools/types` does not name one: an agent is a prompt and a set
 * of capabilities, and which runner drives it is a separate question. Keeping
 * the description on this side of the seam is what lets `composerAgent.ts` — and
 * every agent after it — be written, read and tested without the harness in the
 * room.
 */
export interface AgentSpec {
  readonly name: string;
  readonly systemPrompt: string;
  readonly tools: readonly AgentTool[];
}

/**
 * What a finished run tells the caller. Deliberately small: a trigger needs to
 * know that it ran, what it said and what it touched.
 *
 * `toolCalls` is here because it is the only evidence a caller has that the loop
 * did anything — a model that answers "done!" without calling a tool is the
 * commonest failure of this whole design, and it is invisible in `content`.
 */
export interface AgentRunSummary {
  readonly content: string;
  /** The harness's own `StopReason` — `answered`, `max_iters`, `loop_break`, `aborted`. */
  readonly stoppedReason: string;
  /** Tool names in call order, including repeats. */
  readonly toolCalls: readonly string[];
  /**
   * The final answer parsed and validated against {@link RunAgentTaskOptions
   * .outputSchema}, when the caller asked for one and the model produced JSON
   * that satisfies it. `undefined` otherwise — including when the run declared a
   * schema and the model answered in prose. Read the caveat on that option
   * before treating a present value as the normal case.
   *
   * ⚠ Only ever produced on `stoppedReason: 'answered'`. The harness parses on
   * exactly one path — the turn where the model called no tools — so a run that
   * hit the iteration cap, the loop breaker or an abort has none even when its
   * `content` is valid JSON. Check {@link stoppedReason} before concluding from
   * an absent value that the model wrote prose.
   *
   * `unknown`, deliberately, and not a generic parameterised on the schema. The
   * harness validated this against the schema the caller handed in, but THIS
   * seam did not author that schema and cannot promise the shape it describes —
   * a generic here would be a cast wearing a type parameter. A caller that wants
   * a type narrows this itself, next to the schema it wrote.
   */
  readonly structured?: unknown;
}

// ---------------------------------------------------------------- adapter ---

/**
 * `AgentTool` → the harness's `ToolDef`. THE ADAPTER, and the point of this
 * ticket.
 *
 * The two shapes are close enough that the conversion is dull, which is the
 * evidence that AG-04 got the abstraction right — but they are not the same
 * shape, and the three differences are all decisions:
 *
 *   - **`parameters` → `params`.** Only a rename. The cast is a TypeScript
 *     artefact and not a claim about the value: `JsonSchema` is an `interface`,
 *     so TS gives it no implicit index signature and it is therefore not
 *     assignable to the harness's `JSONSchema = Record<string, unknown>` even
 *     though every inhabitant of one is an inhabitant of the other.
 *
 *   - **`mode: 'auto'`.** Everything the model asks for runs without asking a
 *     human first. That is a real decision and it is defensible only because of
 *     the seams: every write is undoable in one step and refusals come back
 *     typed, so the worst case is an edit the user presses undo on. When there
 *     is a surface that can ASK (AG-06/AG-07), gated modes belong to the tool
 *     that declares them, not to this function.
 *
 *   - **A refusal is RETURNED, not thrown.** `tool.run` hands back
 *     `{ ok: false, reason }` and this passes it straight to the model as the
 *     tool's result. Throwing instead would surface it as `tool.finished` with
 *     `ok: false` and a bare error string — which reads as "the tool is broken"
 *     rather than "the track you named does not exist", and the second is the
 *     one a model can recover from. The seams author those sentences for exactly
 *     this.
 */
export function toToolDef(tool: AgentTool): ToolDef {
  return {
    name: tool.name,
    description: tool.description,
    params: { ...tool.parameters } as Record<string, unknown>,
    mode: 'auto',
    handler: (args: unknown) => tool.run(args),
  };
}

/**
 * A registry holding one agent's tools.
 *
 * Built fresh per run rather than cached, because `ToolRegistry` compiles an
 * `ajv` validator per tool and a registry shared between agents would be the
 * isolation the harness's own comment says is "by construction".
 */
export function registryFor(tools: readonly AgentTool[]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(tools.map(toToolDef));
  return registry;
}

/** `AgentSpec` → the harness's `Agent`. Separated from {@link runAgentTask} so a
 *  test can assert the conversion without driving a run. */
export function toHarnessAgent(spec: AgentSpec): Agent {
  return {
    name: spec.name,
    systemPrompt: spec.systemPrompt,
    tools: registryFor(spec.tools),
  };
}

// ------------------------------------------------------------------ model ---

/**
 * Connector settings → a model backend.
 *
 * `normalizeBaseUrl` rather than the raw field so this posts to the URL the
 * Connector panel SAYS it will post to — the panel renders
 * `chatCompletionsUrl(baseUrl)` from the same helper, and a trailing slash that
 * changed one and not the other would make that display a lie.
 *
 * The token is passed as `apiKey` and touched nowhere else. It is omitted rather
 * than sent empty: a bare `Bearer ` is a malformed credential and a local server
 * that wants none will reject it.
 *
 * `maxTokens` is set unconditionally — see {@link MAX_COMPLETION_TOKENS} for the
 * number and what it is a bound on. VERIFIED, not assumed: it is declared on the
 * harness's `ModelProfile`, and `OpenAICompatibleClient.chat` writes
 * `body.max_tokens` from it when it is not null, so this reaches the provider
 * rather than sitting unread on the profile. Cited by symbol on purpose — the
 * dist file it lives in is content-hashed and renamed on every harness build.
 */
function modelFor(settings: ConnectorSettings, modelId: string): ModelClient {
  const apiKey = settings.token.trim();
  return new OpenAICompatibleClient({
    baseUrl: normalizeBaseUrl(settings.baseUrl),
    model: modelId,
    maxTokens: MAX_COMPLETION_TOKENS,
    ...(apiKey === '' ? {} : { apiKey }),
  });
}

// -------------------------------------------------------------------- run ---

export interface RunAgentTaskOptions {
  /** Defaults to the stored connector settings. A parameter so a caller can run
   *  against something other than what is configured without writing it first. */
  readonly settings?: ConnectorSettings;
  readonly modelId?: string;
  /** The complete trace, in order. A view is optional; the loop always emits. */
  readonly onEvent?: (event: AgentEvent) => void;
  /** Cancellation. Honoured mid-run by the harness — AG-07's cancel button. */
  readonly signal?: AbortSignal;
  /** Outer bound on model round-trips (harness default 8). */
  readonly maxIters?: number;
  /**
   * Ask for an OBJECT rather than prose: the final answer is parsed and
   * validated against this schema and comes back as {@link AgentRunSummary
   * .structured}.
   *
   * OUR `JsonSchema`, not the harness's `JSONSchema`, for the reason `AgentSpec`
   * exists — this seam's surface names no harness type, so a caller can be
   * written and tested without the harness in the room. The conversion is the
   * same one-line widening {@link toToolDef} does, and for the same TypeScript
   * reason.
   *
   * ⚠ **A RUN THAT MUST RETURN A STRUCTURE HAS TO HAVE AN EMPTY TOOL LIST.**
   * This is invisible from the type and it decides how a caller is built, so it
   * is here rather than in a commit message. The harness only sends the schema
   * to the backend for grammar-enforced decoding on turns where NO tools are
   * OFFERED at all (`browser.d.ts` says so on `outputSchema`; the loop's own
   * call site passes the schema to `ModelClient.chat` only when the offered list
   * — registry schemas plus any client tools — is empty. This seam exposes no
   * client tools, so today that is the same as "the `AgentSpec` has no tools").
   *
   * What an agent WITH tools loses is the CONSTRAINT, not the parse: the harness
   * compiles the validator whichever way, and still tries a parse on the turn
   * the model answers. So `structured` on a tool-ful run reflects only whether
   * the model happened to write schema-valid JSON of its own accord — and the
   * parse is `JSON.parse` over the WHOLE answer with no fence stripping and no
   * extraction, so a ```json block, the commonest way a chat model returns an
   * object, yields `undefined` just as a leading sentence does.
   *
   * VERIFIED against the real harness (`tests/AgentService.test.ts` drives the
   * unmocked module): with an empty tool list the schema reaches
   * `ModelClient.chat` and the parsed object comes back; with one tool
   * registered the schema never reaches `chat`, and `structured` is then only
   * whatever the final answer happened to parse and validate to.
   *
   * A run that has tools may still pass a schema — it is then a hint that costs
   * nothing — but it must not be RELIED on, and the prompt has to ask for JSON
   * as well.
   */
  readonly outputSchema?: JsonSchema;
}

/** Whatever came out of a `catch`, as one line. Never interpolates settings, so
 *  a token cannot reach a message this way. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run an agent in this tab. No app server, no WebSocket, no proxy — the page
 * posts to the configured provider from its own origin.
 *
 * **Refusals are returned.** Four things can go wrong before a run is a run and
 * all four come back as `{ ok: false, reason }`:
 *   - nothing is configured, which is the state the app ships in and must not be
 *     a crash;
 *   - what is configured is not a URL a browser can post to;
 *   - the request never completes — a dead provider, a CORS refusal, an abort —
 *     which arrives as a `fetch` rejection through the harness;
 *   - the loop itself ends in `error`.
 *
 * A run that was CANCELLED is a success with `stoppedReason: 'aborted'`, not a
 * refusal: the user got what they asked for.
 *
 * A caller that wants an OBJECT back rather than prose passes
 * {@link RunAgentTaskOptions.outputSchema} — and reads the caveat there first,
 * because it is a constraint on the AGENT (no tools), not just on the call.
 */
export async function runAgentTask(
  spec: AgentSpec,
  input: string,
  options: RunAgentTaskOptions = {},
): Promise<Result<AgentRunSummary>> {
  const settings = options.settings ?? getConnectorSettings();
  if (!isConfigured(settings)) {
    return refuse(
      'No provider is configured. Open Connector and set the base URL of an OpenAI-compatible endpoint.',
    );
  }

  /**
   * The same pre-flight the Test button runs, and the sibling seam authors those
   * sentences so this does not write a second set.
   *
   * Not belt-and-braces: a scheme-less base URL — `localhost:8080/v1`, the
   * commonest typo there is — is not an error in `fetch`. The browser resolves
   * it against THIS PAGE's origin, the dev server answers 200 with the app's own
   * HTML, the harness finds no `data:` lines in it and reports an ordinary run
   * that answered nothing and called nothing. Refusing here is the only place
   * that failure is still legible; one step later it is indistinguishable from a
   * model that simply chose not to act.
   */
  const invalid = validateBaseUrl(settings.baseUrl);
  if (invalid) return refuse(`${invalid.title}. ${invalid.detail}`);

  // HARNESS-GAP(1): `RunResult` reports neither which tools ran nor what the run
  // failed with, so both are reconstructed from the event stream — see
  // docs/FOLLOW-UPS.md. Collected here rather than left to the caller because
  // every caller would otherwise repeat it.
  //
  // ⚠ `toolCalls` UNDER-REPORTS by construction: `tool.started` is not emitted
  // when a call fails argument validation or consent denies it, so a name absent
  // from this list is "did not run", never "was not asked for".
  const toolCalls: string[] = [];
  // A box rather than a `let`, because TypeScript's flow analysis does not model
  // a closure's writes and would type the read below as `null`.
  const failure = { error: '' };

  try {
    const result = await runAgent(toHarnessAgent(spec), input, {
      model: modelFor(settings, options.modelId ?? DEFAULT_MODEL_ID),
      signal: options.signal,
      maxIters: options.maxIters,
      // Handed over BY REFERENCE, not copied. The harness compiles the schema
      // with a module-level `ajv` whose cache is keyed on the schema OBJECT and
      // never evicted, so copying per run would compile a fresh validator and
      // leave a permanent cache entry on every run — and the plan step is meant
      // to run repeatedly against one module-level schema. `ajv` does not mutate
      // a schema, and neither does the client (it only serializes it into the
      // request body).
      //
      // The cast is a TypeScript artefact and not a claim about the value:
      // `JsonSchema` is an `interface`, so TS gives it no implicit index
      // signature and it is not assignable to `JSONSchema = Record<string,
      // unknown>` even though every inhabitant of one inhabits the other.
      ...(options.outputSchema === undefined
        ? {}
        : { outputSchema: options.outputSchema as Record<string, unknown> }),
      onEvent: (event) => {
        if (event.type === 'tool.started') toolCalls.push(event.name);
        if (event.type === 'run.error') failure.error = event.error;
        // A throw from a caller's view must not take down the run. The harness
        // swallows one from its own callback; this keeps that promise for the
        // callback we wrap.
        try {
          options.onEvent?.(event);
        } catch {
          /* the host's view is not the run's problem */
        }
      },
    });

    if (result.stoppedReason === 'error') {
      // `failure.error` FIRST, and it is the one that is ever populated: the
      // harness's error path returns `content: ''` unconditionally, so the whole
      // of what went wrong — `model request failed (401): …`, `Failed to fetch` —
      // exists only on the event. Reading `content` too costs nothing and is the
      // half that survives if the harness starts filling it in.
      const detail = failure.error.trim() || result.content.trim();
      return refuse(
        detail === ''
          ? 'The agent run ended in an error.'
          : `The agent run ended in an error: ${detail}`,
      );
    }

    return ok({
      content: result.content,
      stoppedReason: result.stoppedReason,
      toolCalls,
      // Spread rather than assigned, so a run that asked for nothing structured
      // has no `structured` KEY at all — `'structured' in summary` then means
      // "the harness produced one", which is the question a caller asks.
      ...(result.structured === undefined ? {} : { structured: result.structured }),
    });
  } catch (error) {
    return refuse(`The agent run could not complete: ${describe(error)}`);
  }
}
