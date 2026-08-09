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
const runResult = (over: Partial<{ content: string; stoppedReason: string }> = {}) => ({
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

  it('builds the model from the connector settings, and only from those', async () => {
    await runAgentTask(PATTERN_AGENT, INPUT);
    expect(harness.profiles).toEqual([
      // Normalized: the panel renders `<base>/chat/completions` from the same
      // helper, so a trailing slash handled in one and not the other makes that
      // display a lie.
      { baseUrl: 'http://localhost:5174/v1', model: DEFAULT_MODEL_ID, apiKey: 'sk-test' },
    ]);
  });

  it('honours an explicit model id', async () => {
    await runAgentTask(PATTERN_AGENT, INPUT, { modelId: 'qwen' });
    expect(harness.profiles[0]).toMatchObject({ model: 'qwen' });
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
