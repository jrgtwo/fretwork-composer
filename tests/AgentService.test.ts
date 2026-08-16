import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PATTERNS_STATE, usePatternsStore } from '@fretwork/lib';

/**
 * AG-03 — the fifth seam, and what a test can honestly say about it.
 *
 * ⚠ **THE END-TO-END RUN IS NOT TESTED HERE, AND CANNOT BE.** jsdom has no
 * network: there is no provider to reach, so a "run" asserted in this file would
 * be an assertion about a mock talking to itself. The acceptance criterion — a
 * trigger runs the agent in the browser with no app server and a pattern appears
 * — is a BY-HAND check against a real llama-server, and this file does not
 * pretend otherwise.
 *
 * What is left is worth pinning, and is the part that breaks silently:
 *
 *   1. **The adapter.** `AgentTool` → the harness's `ToolDef`. A field dropped
 *      here is a tool the model never sees the arguments of, and nothing else
 *      would notice.
 *   2. **The refusals.** No provider configured is the state the app SHIPS in.
 *      It has to be a returned sentence, not a throw and not a crash.
 *   3. **The write.** The stub tool's edit lands through `patternService` and
 *      collapses to ONE undo step — the thing that makes an agent edit
 *      indistinguishable from the UI's.
 *
 * The harness is mocked at the module boundary. That is possible only because
 * the seam exists: one file imports `agent-harness/browser`, so one `vi.mock`
 * replaces it. Mocking it is also the only way to assert what is HANDED to it,
 * which is the adapter's whole output.
 */

// -------------------------------------------------------- the harness mock ---

/** `vi.mock` is hoisted above the imports, so anything its factory closes over
 *  has to be hoisted with it. */
const harness = vi.hoisted(() => {
  interface ToolDefLike {
    name: string;
    description: string;
    params: Record<string, unknown>;
    mode: string;
    handler: (args: unknown) => unknown;
  }
  return {
    runAgent: vi.fn(),
    /** Every `ModelProfile` the seam constructed, in order. */
    profiles: [] as unknown[],
    registries: [] as ToolDefLike[][],
  };
});

vi.mock('agent-harness/browser', () => {
  class ToolRegistry {
    readonly defs: unknown[] = [];
    constructor() {
      harness.registries.push(this.defs as never);
    }
    register(tools: unknown[]): void {
      this.defs.push(...tools);
    }
  }
  class OpenAICompatibleClient {
    constructor(profile: unknown) {
      harness.profiles.push(profile);
    }
  }
  return {
    ToolRegistry,
    OpenAICompatibleClient,
    runAgent: harness.runAgent,
  };
});

// Types only, so this does not defeat the `vi.mock` above — and the seam's
// tripwire (`tests/AgentTools.test.ts`) globs `src/**` alone, so a TEST reaching
// the harness directly is deliberate rather than a hole in the charter.
import type { ModelClient } from 'agent-harness/browser';
import {
  DEFAULT_MODEL_ID,
  registryFor,
  runAgentTask,
  toHarnessAgent,
  toToolDef,
  type AgentSpec,
} from '../src/ai/agentService';
import { PATTERN_AGENT } from '../src/ai/patternAgent';
import { setConnectorSettings } from '../src/ai/connectorSettings';
import { validateBaseUrl } from '../src/ai/testConnection';
import { defineTool, fail, obj, ok, str, type AgentTool } from '../src/ai/tools/types';
import { clearHistory as clearPatternHistory } from '../src/patterns/patternService';

/** Any input at all: the seam passes it through untouched, and the command
 *  catalog is what turns a user's choices into a real one (AG-05/AG-06). */
const INPUT = 'Tidy the timing of the pattern that is open.';

/** The shape the seam is supposed to produce. Declared locally rather than
 *  imported from the harness, so a change to `ToolDef` shows up here as a
 *  compile error in the SEAM and not as a test that quietly follows it. */
interface ToolDefLike {
  name: string;
  description: string;
  params: Record<string, unknown>;
  mode: string;
  handler: (args: unknown) => unknown;
}

const defsOf = (index = 0): ToolDefLike[] => harness.registries[index] as ToolDefLike[];

const CONFIGURED = { baseUrl: 'http://localhost:5174/v1/', token: 'sk-test' };

/** A `RunResult` shaped just enough for the seam. */
const runResult = (
  over: Partial<{ content: string; stoppedReason: string; structured: unknown }> = {},
) => ({
  messages: [],
  newMessages: [],
  content: 'done',
  stoppedReason: 'answered',
  ...over,
});

beforeEach(() => {
  // Merged, not replaced: the lib's store keeps its ACTIONS in the same object
  // as its data, so `setState(…, true)` leaves a store with no `createPattern`
  // on it and every write silently refuses.
  sessionStorage.clear();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  clearPatternHistory();
  harness.runAgent.mockReset();
  harness.profiles.length = 0;
  harness.registries.length = 0;
  setConnectorSettings({ baseUrl: '', token: '' });
});

// ---------------------------------------------------------------- adapter ---

describe('the tool adapter', () => {
  const sample: AgentTool = defineTool<{ what: string }>({
    name: 'sample_tool',
    description: 'A tool that exists only to be adapted, and is described at length.',
    parameters: obj({ what: str('Anything at all.') }, ['what']),
    run: ({ what }) => (what === 'no' ? fail('It said no.') : ok({ echoed: what })),
  });

  it('carries every field the model is shown', () => {
    const def = toToolDef(sample) as ToolDefLike;
    expect(def.name).toBe(sample.name);
    expect(def.description).toBe(sample.description);
    // Deep equality, not identity: `params` is a fresh object, but a field
    // dropped in the copy is a constraint the validator stops enforcing.
    expect(def.params).toEqual(sample.parameters);
  });

  it('runs every tool without asking, which is the decision `mode` records', () => {
    expect((toToolDef(sample) as ToolDefLike).mode).toBe('auto');
  });

  it('hands the result straight through, refusals included', () => {
    const def = toToolDef(sample) as ToolDefLike;
    expect(def.handler({ what: 'hi' })).toEqual({ ok: true, value: { echoed: 'hi' } });
    // The refusal has to arrive as the tool's RESULT. Thrown, the model reads
    // "the tool is broken" instead of the seam's sentence about what it did.
    expect(() => def.handler({ what: 'no' })).not.toThrow();
    expect(def.handler({ what: 'no' })).toEqual({ ok: false, reason: 'It said no.' });
  });

  it('gives each agent its own registry, holding exactly its own tools', () => {
    const spec: AgentSpec = { name: 'a', systemPrompt: 'p', tools: [sample] };
    const first = toHarnessAgent(spec);
    const second = toHarnessAgent(spec);
    expect(first.tools).not.toBe(second.tools);
    expect(defsOf(0).map((d) => d.name)).toEqual(['sample_tool']);
    expect(defsOf(1).map((d) => d.name)).toEqual(['sample_tool']);
  });

  it('registers nothing for an empty tool set rather than inventing one', () => {
    registryFor([]);
    expect(defsOf()).toEqual([]);
  });
});

// -------------------------------------------------------- structured output ---

/**
 * A run with NO tools, which is the only shape structured output is reliable in
 * — see the caveat on `RunAgentTaskOptions.outputSchema`.
 *
 * ⚠ What these tests can and cannot say. The harness is mocked here, so they pin
 * what the SEAM does: it builds an empty registry, hands the schema over, and
 * reports back what came out. Whether the REAL harness accepts a tool-free agent
 * and sends the schema on such a turn is a different question, and it is pinned
 * separately against the unmocked module — see "the real harness" at the bottom
 * of this file.
 */
describe('asking a run for a structure', () => {
  const PLAN_SCHEMA = obj({ form: str('The section letters, e.g. AABA.') }, ['form']);
  const PLANNER: AgentSpec = {
    name: 'planner',
    systemPrompt: 'Answer with JSON and nothing else.',
    tools: [],
  };

  beforeEach(() => {
    setConnectorSettings(CONFIGURED);
    harness.runAgent.mockResolvedValue(runResult());
  });

  it('runs an agent that has no tools at all', async () => {
    const result = await runAgentTask(PLANNER, INPUT, { outputSchema: PLAN_SCHEMA });
    // The one assertion here a mutation can move: a seam that rejected or
    // short-circuited an empty tool list fails on one of these two lines.
    expect(result.ok).toBe(true);
    expect(harness.runAgent).toHaveBeenCalledTimes(1);
    // An empty registry, not a missing one: the loop asks the registry for its
    // schemas every iteration, so `tools` has to be a real object either way.
    expect(harness.registries).toHaveLength(1);
    expect(defsOf()).toHaveLength(0);
  });

  it('hands the schema to the harness — the caller’s own object, uncopied', async () => {
    await runAgentTask(PLANNER, INPUT, { outputSchema: PLAN_SCHEMA });
    const [, , options] = harness.runAgent.mock.calls[0] as [
      unknown,
      unknown,
      { outputSchema?: unknown },
    ];
    // Identity, not deep equality, and that is the point: the harness compiles
    // the schema with a module-level `ajv` whose cache is keyed on the OBJECT
    // and never evicted, so a per-run copy would compile a fresh validator and
    // leak a cache entry on every run of a step meant to run repeatedly.
    expect(options.outputSchema).toBe(PLAN_SCHEMA);
  });

  it('passes a schema through on a run that HAS tools, because the doc says that is legal', async () => {
    harness.runAgent.mockResolvedValue(
      runResult({ content: '{"form":"AABA"}', structured: { form: 'AABA' } }),
    );
    const result = await runAgentTask(PATTERN_AGENT, INPUT, { outputSchema: PLAN_SCHEMA });
    // The caveat on `outputSchema` says a tool-ful run may still ask, and gets a
    // hint rather than a guarantee. This pins that the SEAM does not quietly
    // gate the pass-through on the tool count and decide that for the caller.
    const [, , options] = harness.runAgent.mock.calls[0] as [
      unknown,
      unknown,
      { outputSchema?: unknown },
    ];
    expect(options.outputSchema).toBe(PLAN_SCHEMA);
    expect(result.ok && result.value.structured).toEqual({ form: 'AABA' });
  });

  it('sends no schema at all when the caller did not ask for one', async () => {
    await runAgentTask(PATTERN_AGENT, INPUT);
    const [, , options] = harness.runAgent.mock.calls[0] as [unknown, unknown, object];
    // Absent rather than `undefined`: the harness falls back to `agent.outputSchema`
    // with `??`, so either would do — this pins that the seam adds no key of its own.
    expect(options).not.toHaveProperty('outputSchema');
  });

  it('reports the parsed answer when the harness produced one', async () => {
    harness.runAgent.mockResolvedValue(
      runResult({ content: '{"form":"AABA"}', structured: { form: 'AABA' } }),
    );
    const result = await runAgentTask(PLANNER, INPUT, { outputSchema: PLAN_SCHEMA });
    expect(result.ok && result.value.structured).toEqual({ form: 'AABA' });
    // The prose is still there. A caller that wants to show what the model said
    // does not have to re-serialize the object.
    expect(result.ok && result.value.content).toBe('{"form":"AABA"}');
  });

  it('leaves it off when the model answered in prose', async () => {
    // The failure mode the caveat is about: a schema was asked for, the model
    // wrote a sentence, and the harness's parse produced nothing.
    harness.runAgent.mockResolvedValue(runResult({ content: 'Sure — an AABA form.' }));
    const result = await runAgentTask(PLANNER, INPUT, { outputSchema: PLAN_SCHEMA });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).not.toHaveProperty('structured');
  });
});

// --------------------------------------------------------------- refusals ---

describe('running without a provider', () => {
  it('is a stated refusal, and never reaches the harness', async () => {
    const result = await runAgentTask(PATTERN_AGENT, INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no provider is configured/i);
    // Naming the surface that fixes it: a refusal that does not say where to go
    // is the same as no refusal.
    expect(result.reason).toMatch(/Connector/);
    expect(harness.runAgent).not.toHaveBeenCalled();
  });

  it('is decided by the URL alone — a blank token is a legitimate local server', async () => {
    harness.runAgent.mockResolvedValue(runResult());
    setConnectorSettings({ baseUrl: 'http://localhost:5174/v1', token: '' });
    const result = await runAgentTask(PATTERN_AGENT, INPUT);
    expect(result.ok).toBe(true);
    // No token means no `apiKey` at all. An empty `Bearer ` is a malformed
    // credential and a local server that wants none rejects it.
    expect(harness.profiles[0]).not.toHaveProperty('apiKey');
  });

  /** Base URLs that `isConfigured` accepts — it only asks whether the field is
   *  non-empty — and that a browser cannot post to. */
  it.each([
    // Parses — as a URL whose scheme is `localhost:`. Which is why the check is
    // `new URL` AND a protocol test, and why this typo is the dangerous one:
    // `fetch('localhost:8080/v1/chat/completions')` is resolved against THIS
    // page's origin, so the app answers its own HTML with a 200 and the run
    // comes back looking like a model that simply chose not to act.
    ['a scheme-less host', 'localhost:8080/v1'],
    ['a scheme a browser cannot fetch', 'ws://localhost:8080/v1'],
    ['something that is not a URL at all', 'not a url'],
    // `/chat/completions` is appended to the whole string, so this would land in
    // the middle of the path.
    ['a base URL carrying a query', 'https://api.example.com/v1?api-version=1'],
  ])('refuses %s before a request is built', async (_label, baseUrl) => {
    setConnectorSettings({ baseUrl, token: '' });
    const result = await runAgentTask(PATTERN_AGENT, INPUT);
    expect(result.ok).toBe(false);
    expect(harness.runAgent).not.toHaveBeenCalled();
  });

  it('states the invalid-URL refusal in the same words the Test button uses', async () => {
    setConnectorSettings({ baseUrl: 'localhost:8080/v1', token: '' });
    const result = await runAgentTask(PATTERN_AGENT, INPUT);
    const outcome = validateBaseUrl('localhost:8080/v1');
    expect(outcome).not.toBeNull();
    // Not two sets of sentences about the same fact: the connector authors them.
    if (!result.ok && outcome) {
      expect(result.reason).toContain(outcome.title);
      expect(result.reason).toContain(outcome.detail);
    }
  });

  it('turns a request that never completes into a refusal, not a throw', async () => {
    setConnectorSettings(CONFIGURED);
    // Defence in depth, and say so: the REAL harness does not take this path —
    // `run()` catches everything internally and resolves with
    // `stoppedReason: 'error'` (see the test below). This pins the `catch` for
    // the day something upstream of the loop throws.
    harness.runAgent.mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await runAgentTask(PATTERN_AGENT, INPUT);
    expect(result).toEqual({
      ok: false,
      reason: 'The agent run could not complete: Failed to fetch',
    });
  });

  /**
   * The shape the real harness actually produces, and the reason the seam reads
   * the EVENT rather than the result: `run()`'s error path is
   * `return done('', 'error')` — `content` is always `''`, and the whole of what
   * went wrong is on `run.error`. Reading only `content` here would report every
   * failed run as the bare sentence "The agent run ended in an error", which is
   * the single likeliest outcome of a mis-typed base URL or a stale token and
   * says nothing anyone can act on.
   */
  it('reports what the loop failed WITH, which only the event carries', async () => {
    setConnectorSettings(CONFIGURED);
    harness.runAgent.mockImplementation(
      async (
        _agent: unknown,
        _input: unknown,
        options: { onEvent?: (event: { type: string; error?: string }) => void },
      ) => {
        options.onEvent?.({
          type: 'run.error',
          error: 'model request failed (401): {"error":"invalid api key"}',
        });
        return runResult({ stoppedReason: 'error', content: '' });
      },
    );
    const result = await runAgentTask(PATTERN_AGENT, INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('model request failed (401)');
  });

  it('still has something to say when nothing reported a reason', async () => {
    setConnectorSettings(CONFIGURED);
    harness.runAgent.mockResolvedValue(runResult({ stoppedReason: 'error', content: '' }));
    const result = await runAgentTask(PATTERN_AGENT, INPUT);
    expect(result).toEqual({ ok: false, reason: 'The agent run ended in an error.' });
  });

  it('reports a cancelled run as a result, because the user got what they asked for', async () => {
    setConnectorSettings(CONFIGURED);
    harness.runAgent.mockResolvedValue(runResult({ stoppedReason: 'aborted', content: '' }));
    const result = await runAgentTask(PATTERN_AGENT, INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stoppedReason).toBe('aborted');
  });
});

// ------------------------------------------------------------ what is sent ---

describe('what the seam hands the harness', () => {
  beforeEach(() => {
    setConnectorSettings(CONFIGURED);
    harness.runAgent.mockResolvedValue(runResult());
  });

  it('builds the model from the connector settings, plus the reply cap, and nothing else', async () => {
    await runAgentTask(PATTERN_AGENT, INPUT);
    expect(harness.profiles).toEqual([
      // Normalized: the panel renders `<base>/chat/completions` from the same
      // helper, so a trailing slash handled in one and not the other makes that
      // display a lie.
      {
        baseUrl: 'http://localhost:5174/v1',
        model: DEFAULT_MODEL_ID,
        // NOT from the connector settings — the one field here the user does not
        // choose. It bounds what a single reply may cost: the run that prompted
        // it spent 51593 completion tokens on one call. Written out rather than
        // imported so changing the number costs an edit against its
        // justification in the seam.
        maxTokens: 8192,
        apiKey: 'sk-test',
      },
    ]);
  });

  it('honours an explicit model id, and still caps the reply', async () => {
    await runAgentTask(PATTERN_AGENT, INPUT, { modelId: 'qwen' });
    // The cap asserted on THIS route and not only on the default one: the model
    // id is the one profile field a caller can set, and it is applied by spread
    // over the same object literal the cap lives in.
    expect(harness.profiles[0]).toMatchObject({ model: 'qwen', maxTokens: 8192 });
  });

  it('passes the agent, the input and the cancellation signal', async () => {
    const controller = new AbortController();
    await runAgentTask(PATTERN_AGENT, 'go', { signal: controller.signal, maxIters: 2 });
    const [agent, input, options] = harness.runAgent.mock.calls[0] as [
      { name: string; systemPrompt: string },
      string,
      { signal?: AbortSignal; maxIters?: number },
    ];
    expect(agent.name).toBe('pattern');
    expect(agent.systemPrompt).toContain('read_pattern');
    expect(input).toBe('go');
    expect(options.signal).toBe(controller.signal);
    expect(options.maxIters).toBe(2);
  });

  it('reports the tools that ran, in order', async () => {
    harness.runAgent.mockImplementation(
      async (
        _agent: unknown,
        _input: unknown,
        options: { onEvent?: (event: { type: string; name?: string }) => void },
      ) => {
        options.onEvent?.({ type: 'tool.started', name: 'read_pattern' });
        options.onEvent?.({ type: 'token' });
        options.onEvent?.({ type: 'tool.started', name: 'read_pattern' });
        return runResult();
      },
    );
    const result = await runAgentTask(PATTERN_AGENT, INPUT);
    expect(result.ok && result.value.toolCalls).toEqual(['read_pattern', 'read_pattern']);
  });

  it('does not let a throw from the caller’s event view take down the run', async () => {
    harness.runAgent.mockImplementation(
      async (_a: unknown, _i: unknown, options: { onEvent?: (e: { type: string }) => void }) => {
        options.onEvent?.({ type: 'run.started' });
        return runResult();
      },
    );
    const result = await runAgentTask(PATTERN_AGENT, INPUT, {
      onEvent: () => {
        throw new Error('a bug in a view');
      },
    });
    expect(result.ok).toBe(true);
  });
});

// ----------------------------------------------------- the real harness ---

/**
 * The one fact the seam's `outputSchema` caveat rests on, pinned against the
 * REAL `agent-harness/browser` rather than the mock above.
 *
 * Everything else in this file asserts what the seam HANDS the harness. That is
 * the right shape for a seam test, but it means the sentence the caveat actually
 * turns on — "a tool-free agent is accepted, and only then does the schema reach
 * the backend" — would be pinned nowhere, and any caller that must come back
 * with a structure depends on it entirely. The orchestrated composition job's
 * plan step was that caller until 2026-08-16; the design replacing it, where the
 * agent emits one JSON document for the lib to validate, turns on the same
 * property. The harness is a sibling package under active co-development; if it
 * stops accepting an empty registry, or stops forwarding the schema on tool-free
 * turns, something has to fail.
 *
 * `vi.importActual` bypasses this file's own `vi.mock`. No network is involved:
 * the model is a stub `ModelClient` that records what it was called with. What
 * these do NOT prove is that a provider honours `response_format` — that is the
 * provider's half and stays a by-hand check.
 */
describe('the real harness, unmocked', () => {
  const SCHEMA = { type: 'object', properties: { form: { type: 'string' } }, required: ['form'] };

  interface ChatCall {
    readonly offered: readonly unknown[];
    readonly responseSchema: unknown;
  }

  /** Answers once, with JSON and no tool calls, and records the turn. */
  const recordingModel = (calls: ChatCall[]): ModelClient => ({
    chat: async (_messages, tools, _handlers, _signal, responseSchema) => {
      calls.push({ offered: tools, responseSchema });
      return { content: '{"form":"AABA"}', toolCalls: [], finishReason: 'stop' };
    },
  });

  const realHarness = async (): Promise<typeof import('agent-harness/browser')> =>
    vi.importActual<typeof import('agent-harness/browser')>('agent-harness/browser');

  it('accepts an agent whose registry is empty, and gives that turn the schema', async () => {
    const real = await realHarness();
    const registry = new real.ToolRegistry();
    // The seam's own `registryFor([])` cannot be reused here: it builds the
    // MOCKED registry. What it does is `register([])`, which is this line.
    registry.register([]);
    expect(registry.names()).toEqual([]);

    const calls: ChatCall[] = [];
    const result = await real.runAgent(
      { name: 'planner', systemPrompt: 'Answer with JSON.', tools: registry },
      'go',
      { model: recordingModel(calls), outputSchema: SCHEMA },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].offered).toEqual([]);
    // The whole point of the empty tool list: this is the turn the backend is
    // asked to constrain its decoding.
    expect(calls[0].responseSchema).toEqual(SCHEMA);
    expect(result.stoppedReason).toBe('answered');
    expect(result.structured).toEqual({ form: 'AABA' });
  });

  it('withholds the schema once a tool is registered — but still parses the answer', async () => {
    const real = await realHarness();
    const registry = new real.ToolRegistry();
    registry.register([
      toToolDef(
        defineTool<{ what: string }>({
          name: 'sample_tool',
          description: 'A tool that exists only to occupy the registry, described at length.',
          parameters: obj({ what: str('Anything at all.') }, ['what']),
          run: ({ what }) => ok({ echoed: what }),
        }),
      ),
    ]);

    const calls: ChatCall[] = [];
    const result = await real.runAgent(
      { name: 'composer', systemPrompt: 'Answer with JSON.', tools: registry },
      'go',
      { model: recordingModel(calls), outputSchema: SCHEMA },
    );

    // The corrected half of the seam's caveat, and the reason it is worded the
    // way it is: what a tool-ful run loses is the CONSTRAINT, not the parse.
    expect(calls[0].offered).toHaveLength(1);
    expect(calls[0].responseSchema).toBeUndefined();
    // So a present `structured` does NOT imply a tool-free run. It only means
    // the model happened to write schema-valid JSON of its own accord.
    expect(result.structured).toEqual({ form: 'AABA' });
  });

  it('produces no `structured` when the run did not end by answering', async () => {
    const real = await realHarness();
    const registry = new real.ToolRegistry();
    registry.register([]);

    const controller = new AbortController();
    controller.abort();
    const result = await real.runAgent(
      { name: 'planner', systemPrompt: 'Answer with JSON.', tools: registry },
      'go',
      { model: recordingModel([]), outputSchema: SCHEMA, signal: controller.signal },
    );

    // Pins the sentence on `AgentRunSummary.structured`: the harness parses on
    // exactly one path, so an absent value is not evidence the model wrote
    // prose. A caller has to read `stoppedReason` before saying that.
    expect(result.stoppedReason).toBe('aborted');
    expect(result.structured).toBeUndefined();
  });
});
