import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PATTERNS_STATE, PPQ, usePatternsStore } from '@fretwork/lib';
import {
  ARRANGEMENT_JOB_DEPS,
  runArrangementJob,
  type ArrangementJobDeps,
  type ArrangementJobEvent,
  type RunTask,
} from '../src/ai/arrangementJob';
import { ARRANGEMENT_PLAN_AGENT } from '../src/ai/arrangementPlan';
import { ARRANGEMENT_PLAN_SCHEMA } from '../src/ai/arrangementPlanSchema';
import { PATTERN_SUB_RUN_AGENT } from '../src/ai/patternSubRun';
import {
  clearTranscripts,
  getTranscript,
  recentTranscripts,
  transcriptText,
} from '../src/ai/runTranscript';
import type { ArrangementAssembly } from '../src/ai/arrangementAssembly';
import type { ArrangementPlan, PlannedPattern } from '../src/ai/arrangementPlanSchema';
import type {
  AgentEvent,
  AgentRunSummary,
  AgentSpec,
  RunAgentTaskOptions,
} from '../src/ai/agentService';
import {
  addPlacement,
  addTrack,
  beginJob,
  clearHistory as clearCompositionHistory,
  endEditGesture as endCompositionGesture,
  endJob,
  openBlankComposition,
  openPlacementForEditing,
  writesLockedOut,
} from '../src/composition/compositionService';
import {
  clearHistory as clearPatternHistory,
  endEditGesture as endPatternGesture,
  getEditingPattern,
  openBlankPattern,
  patternInstrumentId,
  stampNote,
} from '../src/patterns/patternService';
import type { Result } from '../src/patterns/patternService';

/**
 * OR-05 — the orchestrated job: plan, then one pattern at a time, then assembly.
 *
 * ⚠ THERE IS NO MODEL IN THIS FILE. Every model call goes through the injected
 * `runTask`, which is a function that returns what the test says it returns —
 * because what this module actually decides is the ORDER of the phases, what
 * carries between them, when to stop, and what to call a failure. None of that
 * needs a provider, and a test that needed one could not assert any of it.
 *
 * The two side effects are faked for the same reason and not for speed:
 * `openPattern` is the app's ONE editing pointer, and `assemble` writes a whole
 * arrangement — both are covered by their own files (`ArrangementAssembly`,
 * `PatternSubRun`), and driving them here would mean asserting the job's order
 * through the document rather than directly.
 *
 * What is REAL: `planRunInput` (so the plan run is briefed off the actual
 * document), `reviewPlan`, `patternRunInput` — including its chord lookup — and
 * the transcript. Those are the parts a fake would assert away.
 */

// ---------------------------------------------------------------- fixtures ---

/** A four-bar form, two two-bar patterns, one track — the smallest plan that
 *  still has more than one sub-run in it, which is where the ordering and the
 *  cancellation questions live. */
const plan = (): ArrangementPlan => ({
  bars: 4,
  tracks: [{ name: 'Rhythm Guitar', instrumentId: 'guitar' }],
  patterns: [
    { name: 'C7 Comp', instrumentId: 'guitar', chord: 'C7', lengthBars: 2 },
    { name: 'F7 Comp', instrumentId: 'guitar', chord: 'F7', lengthBars: 2 },
  ],
  placements: [
    { patternName: 'C7 Comp', trackName: 'Rhythm Guitar', atBars: [1] },
    { patternName: 'F7 Comp', trackName: 'Rhythm Guitar', atBars: [3] },
  ],
});

/** Two copies of a two-bar pattern one bar apart: `reviewPlan`'s `self-overlap`,
 *  the 2026-08-11 failure, and a plan that must never reach a sub-run. */
const stackedPlan = (): ArrangementPlan => ({
  ...plan(),
  placements: [{ patternName: 'C7 Comp', trackName: 'Rhythm Guitar', atBars: [1, 2] }],
});

const summary = (over: Partial<AgentRunSummary> = {}): AgentRunSummary => ({
  content: 'done',
  stoppedReason: 'answered',
  toolCalls: [],
  ...over,
});

/** What the faked assembly hands back. Its contents are `ArrangementAssembly`'s
 *  business, not this module's — what is asserted here is what went IN. */
const assembled = (): ArrangementAssembly => ({
  bars: 4,
  tracks: [],
  blocks: [],
  holes: [],
  plannedBlocks: 2,
  emptyBars: [],
});

/** One run of the job, with every outside call recorded. */
interface Rig {
  /** Every model call, in order: the agent's name, the input it was given, the
   *  iteration bound it was run under, and the two options the header calls
   *  load-bearing — the ONE signal, and the schema that makes the plan run's
   *  answer a grammar rather than a hope. */
  readonly runs: {
    agent: string;
    input: string;
    maxIters?: number;
    signal: AbortSignal | undefined;
    outputSchema: unknown;
  }[];
  /** The patterns `openPattern` was asked for, in order. */
  readonly opened: string[];
  /** What `assemble` was called with — `null` until it is called, which is the
   *  assertion three tests below are actually making. */
  assembleArgs: { plan: ArrangementPlan; ids: Map<string, string> } | null;
  readonly events: ArrangementJobEvent[];
}

/**
 * The deps a test runs against: everything answers success, and each test
 * overrides the one thing it is about.
 *
 * `onRun` is the hook the cancellation test needs — it fires INSIDE a model
 * call, which is the only place a real cancel can land.
 */
function rig(
  over: Partial<ArrangementJobDeps> = {},
  onRun?: (spec: AgentSpec, rig: Rig, options: RunAgentTaskOptions) => void,
  answer: () => unknown = plan,
): { rig: Rig; deps: Partial<ArrangementJobDeps> } {
  const state: Rig = { runs: [], opened: [], assembleArgs: null, events: [] };

  const runTask: RunTask = async (spec, input, options) => {
    state.runs.push({
      agent: spec.name,
      input,
      ...(options.maxIters === undefined ? {} : { maxIters: options.maxIters }),
      signal: options.signal,
      outputSchema: options.outputSchema,
    });
    onRun?.(spec, state, options);
    if (spec.name !== ARRANGEMENT_PLAN_AGENT.name) return { ok: true, value: summary() };
    // `content` is what the model SAID and `structured` is that same answer
    // parsed, which is how the harness fills the two — so a prose answer is
    // prose in both, and the log carries what it was.
    const value = answer();
    const content = typeof value === 'string' ? value : JSON.stringify(value);
    return { ok: true, value: summary({ content, structured: value }) };
  };

  const openPattern = (pattern: PlannedPattern): Result<string> => {
    state.opened.push(pattern.name);
    return { ok: true, value: `lib-${pattern.name}` };
  };

  const assemble = (
    given: ArrangementPlan,
    ids: ReadonlyMap<string, string>,
  ): Result<ArrangementAssembly> => {
    state.assembleArgs = { plan: given, ids: new Map(ids) };
    return { ok: true, value: assembled() };
  };

  return {
    rig: state,
    deps: { runTask, openPattern, hasNotes: () => true, assemble, ...over },
  };
}

beforeEach(() => {
  sessionStorage.clear();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  // Module state on the seams: a job left open or a bracket left nested would
  // refuse or mis-record every write in every test after it.
  endJob();
  for (let i = 0; i < 8; i += 1) endCompositionGesture(false);
  for (let i = 0; i < 8; i += 1) endPatternGesture(false);
  clearPatternHistory();
  clearCompositionHistory();
  clearTranscripts();
  // `planRunInput` reads the open composition — the run that plans has no tools
  // and cannot look anything up, so the document goes into its prompt.
  const opened = openBlankComposition('Arrangement');
  if (!opened.ok) throw new Error(opened.reason);
});

// ------------------------------------------------------------------ phases ---

describe('the phases', () => {
  it('plans, writes one pattern at a time, then assembles what the sub-runs produced', async () => {
    const { rig: state, deps } = rig();
    const outcome = await runArrangementJob('a four-bar blues', { deps });

    if (!outcome.ok) throw new Error(outcome.reason);
    // The plan run FIRST, then one sub-run per planned pattern in plan order —
    // and never two at once, because the app has one open-pattern pointer.
    expect(state.runs.map((run) => run.agent)).toEqual([
      ARRANGEMENT_PLAN_AGENT.name,
      PATTERN_SUB_RUN_AGENT.name,
      PATTERN_SUB_RUN_AGENT.name,
    ]);
    // A blank pattern is opened for each, by the orchestrator and not by the
    // sub-run, which has no tool that could.
    expect(state.opened).toEqual(['C7 Comp', 'F7 Comp']);

    // THE HANDOVER: assembly is given the ids the sub-runs actually produced,
    // keyed by the plan's names — the only handle a plan has.
    expect(state.assembleArgs?.ids).toEqual(
      new Map([
        ['C7 Comp', 'lib-C7 Comp'],
        ['F7 Comp', 'lib-F7 Comp'],
      ]),
    );
    expect(state.assembleArgs?.plan).toEqual(plan());
    expect(outcome.value.assembly).toEqual(assembled());
    expect(outcome.value.patternRuns.map((entry) => entry.patternId)).toEqual([
      'lib-C7 Comp',
      'lib-F7 Comp',
    ]);
  });

  it('briefs each sub-run from its own plan entry, not from the request', async () => {
    const { rig: state, deps } = rig();
    await runArrangementJob('a four-bar blues', { deps });

    // The chord and the length of THAT pattern, in that sub-run's input — which
    // is what makes the brief narrow enough to be hard to fill with filler.
    expect(state.runs[1]?.input).toContain('C7');
    expect(state.runs[1]?.input).not.toContain('F7');
    expect(state.runs[2]?.input).toContain('F7');
    // ⚠ AND NOT THE REQUEST. Appending it to every brief would put the whole job
    // back inside one call, which is the thing this design exists to stop — and
    // is a one-line change that the assertion above alone would not catch.
    expect(state.runs[1]?.input).not.toContain('a four-bar blues');
    // And the plan run gets the document, because it has no tool to read it.
    expect(state.runs[0]?.input).toContain('a four-bar blues');
  });

  it('asks the plan run — and only the plan run — for a structured answer', async () => {
    const { rig: state, deps } = rig();
    await runArrangementJob('a four-bar blues', { deps });

    // ⚠ IDENTITY, not equality: the harness caches the compiled validator on the
    // schema OBJECT, so a copy would compile a fresh one per run and never be
    // evicted. And without the schema the plan run loses grammar-enforced
    // decoding altogether — the failure would surface as `plan-unusable`, which
    // reads as the model's fault.
    expect(state.runs[0]?.outputSchema).toBe(ARRANGEMENT_PLAN_SCHEMA);
    // The sub-runs have TOOLS, and a run with tools is not sent the schema at
    // all — asking for one would buy a validator and no guarantee.
    expect(state.runs[1]?.outputSchema).toBeUndefined();
    expect(state.runs[2]?.outputSchema).toBeUndefined();
  });

  it('threads ONE signal into every model call it makes', async () => {
    // The job's own between-phase checks are asserted below; this is the other
    // half of the same ⚠ — without the signal ON the call, a cancel would not
    // abort the run in flight and the user would wait out a full round trip.
    const controller = new AbortController();
    const { rig: state, deps } = rig();
    await runArrangementJob('a four-bar blues', { deps, signal: controller.signal });

    expect(state.runs).toHaveLength(3);
    for (const run of state.runs) expect(run.signal).toBe(controller.signal);
  });

  it('bounds every sub-run, whether or not the caller named a bound', async () => {
    // A sub-run that ran out of iterations hands back a half-written pattern
    // that HAS notes in it, so the truncation is invisible downstream — which is
    // why the bound is not left to whatever the harness defaults to.
    const { rig: bounded, deps } = rig();
    await runArrangementJob('a four-bar blues', { deps });
    expect(bounded.runs[1]?.maxIters).toBeGreaterThan(0);
    // The plan run is left alone: it has no tools, so it answers in one.
    expect(bounded.runs[0]?.maxIters).toBeUndefined();

    const { rig: asked, deps: askedDeps } = rig();
    await runArrangementJob('a four-bar blues', { deps: askedDeps, maxIters: 3 });
    expect(asked.runs[1]?.maxIters).toBe(3);
  });

  it('stops before any sub-run when the plan fails review', async () => {
    // Two copies of a two-bar pattern a bar apart — the stack that
    // `composition_place_pattern` refuses at write time, caught here before a
    // note exists.
    const { rig: state, deps } = rig({}, undefined, stackedPlan);
    const outcome = await runArrangementJob('a four-bar blues', { deps });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stopped).toBe('plan-refused');
    // `reviewPlan`'s own sentence, passed on rather than re-authored.
    expect(outcome.reason).toContain('self-overlap');
    expect(outcome.reason).toContain('lands on top of');
    // NOTHING was attempted: no sub-run, no pattern opened, no assembly.
    expect(state.runs.map((run) => run.agent)).toEqual([ARRANGEMENT_PLAN_AGENT.name]);
    expect(state.opened).toEqual([]);
    expect(state.assembleArgs).toBeNull();
  });

  it('stops when the planning run answers with something that is not a plan', async () => {
    // `reviewPlan` takes its argument on trust and THROWS on a malformed one, so
    // a prose answer has to be turned away before it gets there.
    const { rig: state, deps } = rig({}, undefined, () => 'Sure! Here is a blues.');
    const outcome = await runArrangementJob('a four-bar blues', { deps });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stopped).toBe('plan-unusable');
    expect(state.opened).toEqual([]);
    expect(state.assembleArgs).toBeNull();
    // The stop line promises the answer is in the log, so the answer has to BE
    // in the log — the plan section is finished with what the model said, and
    // the job's one artifact carries it.
    expect(transcriptText(recentTranscripts()[0]?.id ?? '')).toContain('Sure! Here is a blues.');
  });

  it('turns away a reply whose entries are the wrong shape, one entry at a time', async () => {
    // `reviewPlan` iterates these lists without guarding them and THROWS on a
    // malformed one, so each of the three has to be narrowed here. A whole-string
    // reply is the easy case; these are the ones a provider that ignored the
    // schema actually produces.
    const malformed: Record<string, () => unknown> = {
      'a track with no instrument': () => ({ ...plan(), tracks: [{ name: 'Rhythm Guitar' }] }),
      'a length that is a string': () => ({
        ...plan(),
        patterns: [{ name: 'C7 Comp', instrumentId: 'guitar', chord: 'C7', lengthBars: '2' }],
      }),
      'a bar that is a string': () => ({
        ...plan(),
        placements: [{ patternName: 'C7 Comp', trackName: 'Rhythm Guitar', atBars: ['1'] }],
      }),
    };

    for (const [what, answer] of Object.entries(malformed)) {
      const { rig: state, deps } = rig({}, undefined, answer);
      const outcome = await runArrangementJob('a four-bar blues', { deps });

      expect(outcome.ok, what).toBe(false);
      if (outcome.ok) return;
      expect(outcome.stopped, what).toBe('plan-unusable');
      // ⚠ NOT a plan with the bad entry dropped: a placement refers to a track
      // and a pattern BY NAME, so dropping one would build an arrangement that
      // is quietly missing a part.
      expect(state.opened, what).toEqual([]);
      expect(state.assembleArgs, what).toBeNull();
    }
  });

  it('stops when there is no document to plan against', async () => {
    // `planRunInput` reads the open composition into the prompt, because the
    // plan agent has no tool to read it with. No composition, no brief.
    usePatternsStore.setState({
      ...DEFAULT_PATTERNS_STATE,
      library: { patterns: [], compositions: [], collections: [] },
    });
    const { rig: state, deps } = rig();
    const outcome = await runArrangementJob('a four-bar blues', { deps });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stopped).toBe('plan-failed');
    expect(outcome.reason).toContain('composition');
    expect(state.runs).toEqual([]);
  });

  it('refuses a plan that names more patterns than a job will write', async () => {
    // ⚠ THE ONLY THING THAT BOUNDS THE JOB'S COST: the sub-run count comes out
    // of the model, the schema puts no ceiling on it, and `reviewPlan` caps
    // tracks and says nothing about patterns. Refused BEFORE the first sub-run,
    // so an over-long plan costs one model call rather than forty.
    const many = (): ArrangementPlan => ({
      ...plan(),
      bars: 200,
      patterns: Array.from({ length: 25 }, (_, index) => ({
        name: `Part ${index + 1}`,
        instrumentId: 'guitar',
        chord: 'C7',
        lengthBars: 1,
      })),
      placements: Array.from({ length: 25 }, (_, index) => ({
        patternName: `Part ${index + 1}`,
        trackName: 'Rhythm Guitar',
        atBars: [index + 1],
      })),
    });
    const { rig: state, deps } = rig({}, undefined, many);
    const outcome = await runArrangementJob('a four-bar blues', { deps });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stopped).toBe('plan-refused');
    expect(outcome.reason).toContain('25 patterns');
    expect(state.runs).toHaveLength(1);
    expect(state.opened).toEqual([]);
    expect(state.assembleArgs).toBeNull();
  });

  it('does not spend a run on a pattern the plan never places', async () => {
    const orphan = (): ArrangementPlan => ({
      ...plan(),
      patterns: [
        ...plan().patterns,
        { name: 'Unused Riff', instrumentId: 'guitar', chord: 'G7', lengthBars: 1 },
      ],
    });
    const { rig: state, deps } = rig({}, undefined, orphan);
    const outcome = await runArrangementJob('a four-bar blues', { deps });

    if (!outcome.ok) throw new Error(outcome.reason);
    // Two sub-runs for three declared patterns, and no blank opened for the one
    // with nowhere to go — a model call and a stray library pattern saved.
    expect(state.opened).toEqual(['C7 Comp', 'F7 Comp']);
    expect(state.runs).toHaveLength(3);
    // Still REPORTED, though: an over-declared plan is worth seeing.
    expect(outcome.value.patternRuns[2]?.reason).toContain('never places it');
  });

  it('carries the plan review, so the empty bars are reported by something', async () => {
    // The 2026-08-12 failure: a one-bar pattern at bars 1, 4, 7 and 10 of a
    // twelve-bar form, eight bars of silence, and nothing said about it.
    const gappy = (): ArrangementPlan => ({
      ...plan(),
      patterns: [{ name: 'C7 Comp', instrumentId: 'guitar', chord: 'C7', lengthBars: 1 }],
      placements: [{ patternName: 'C7 Comp', trackName: 'Rhythm Guitar', atBars: [1] }],
    });
    const { deps } = rig({}, undefined, gappy);
    const outcome = await runArrangementJob('a four-bar blues', { deps });

    if (!outcome.ok) throw new Error(outcome.reason);
    // Bars 2-4 of the four-bar form have nothing under them. `reviewPlan` does
    // not refuse for it — whether silence is a failure is the caller's call —
    // so the job carries the grading rather than re-running it.
    expect(outcome.value.review.emptyBars).toHaveLength(1);
    expect(outcome.value.review.emptyBars[0]?.trackName).toBe('Rhythm Guitar');
  });

  it('ends with a sentence and a closed log when a phase throws', async () => {
    // Everything else here is RETURNED, never thrown. A bug in one of them must
    // not reject the promise with the transcript left open — which reads in the
    // buffer as a job that is still running.
    const assemble = (): Result<ArrangementAssembly> => {
      throw new Error('assembly blew up');
    };
    const { deps } = rig({ assemble });
    const outcome = await runArrangementJob('a four-bar blues', { deps });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stopped).toBe('job-error');
    expect(outcome.reason).toContain('assembly blew up');
    expect(recentTranscripts()[0]?.finishedAt).toBeDefined();
  });

  it('assembles as the JOB even when the caller holds the job lock', async () => {
    // ⚠ `assembleArrangement` asks `writesLockedOut()` before its first write, so
    // without the job's own `asJobWrite` around it, a panel that took
    // `beginJob()` and awaited this would spend every model call and then be
    // refused the only phase that touches the document. The fake asks the same
    // question the real one does.
    const seen: boolean[] = [];
    const assemble = (): Result<ArrangementAssembly> => {
      seen.push(writesLockedOut());
      return writesLockedOut()
        ? { ok: false, reason: 'A generation job is building this arrangement.' }
        : { ok: true, value: assembled() };
    };
    const { deps } = rig({ assemble });
    const release = beginJob();
    if (!release.ok) throw new Error(release.reason);
    try {
      const outcome = await runArrangementJob('a four-bar blues', { deps });
      expect(outcome.ok).toBe(true);
    } finally {
      release.value();
    }
    expect(seen).toEqual([false]);
  });

  it('reports a refused model call as a stop rather than throwing', async () => {
    const runTask: RunTask = async () => ({
      ok: false,
      reason: 'No provider is configured.',
    });
    const { rig: state, deps } = rig({ runTask });
    const outcome = await runArrangementJob('a four-bar blues', { deps });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stopped).toBe('plan-failed');
    expect(outcome.reason).toBe('No provider is configured.');
    expect(state.assembleArgs).toBeNull();
  });
});

// ------------------------------------------------------------ cancellation ---

describe('cancelling', () => {
  it('stops between two sub-runs and does not assemble', async () => {
    const controller = new AbortController();
    // Aborted during the FIRST sub-run — the harness would end that run, and
    // what this asserts is the half only this module can do: not starting the
    // next one, and not assembling a half-built arrangement.
    const { rig: state, deps } = rig({}, (spec) => {
      if (spec.name === PATTERN_SUB_RUN_AGENT.name && state.opened.length === 1) {
        controller.abort();
      }
    });
    const outcome = await runArrangementJob('a four-bar blues', {
      deps,
      signal: controller.signal,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stopped).toBe('cancelled');
    expect(outcome.reason).toContain('after 1 of 2 patterns');
    // The second sub-run never started, and assembly never ran.
    expect(state.opened).toEqual(['C7 Comp']);
    expect(state.runs).toHaveLength(2);
    expect(state.assembleArgs).toBeNull();
  });

  it('stops before the plan run when it was cancelled first', async () => {
    const controller = new AbortController();
    controller.abort();
    const { rig: state, deps } = rig();
    const outcome = await runArrangementJob('a four-bar blues', {
      deps,
      signal: controller.signal,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stopped).toBe('cancelled');
    expect(state.runs).toEqual([]);
  });

  it('stops after the last sub-run rather than assembling', async () => {
    const controller = new AbortController();
    // Aborted inside the LAST sub-run: every pattern is written, and the check
    // that matters is the one before assembly.
    const { rig: state, deps } = rig({}, (spec) => {
      if (spec.name === PATTERN_SUB_RUN_AGENT.name && state.opened.length === 2) {
        controller.abort();
      }
    });
    const outcome = await runArrangementJob('a four-bar blues', {
      deps,
      signal: controller.signal,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stopped).toBe('cancelled');
    expect(state.assembleArgs).toBeNull();
  });
});

// ------------------------------------------------------------------- holes ---

describe('a sub-run that produces nothing', () => {
  it('is a hole in the arrangement, and the job carries on', async () => {
    // The run answered — this is the "done!" that wrote nothing, which is the
    // commonest failure of the whole design and is invisible in `content`.
    const { rig: state, deps } = rig({ hasNotes: (id) => id !== 'lib-C7 Comp' });
    const outcome = await runArrangementJob('a four-bar blues', { deps });

    if (!outcome.ok) throw new Error(outcome.reason);
    const [first, second] = outcome.value.patternRuns;
    expect(first?.patternId).toBeUndefined();
    expect(first?.reason).toContain('nothing written');
    expect(second?.patternId).toBe('lib-F7 Comp');
    // The second pattern was still written and the arrangement was still built:
    // the user's next move is to re-run the one that failed, and they can only
    // see that if the rest of it exists.
    expect(state.opened).toEqual(['C7 Comp', 'F7 Comp']);
    // Assembly is handed the ids that exist and NOT the one that does not, so
    // its own `unwritten` hole names the bars that are empty.
    expect(state.assembleArgs?.ids).toEqual(new Map([['F7 Comp', 'lib-F7 Comp']]));
  });

  it('is a hole when the sub-run itself refuses, and is not retried', async () => {
    const calls: string[] = [];
    const runTask: RunTask = async (spec, input) => {
      calls.push(spec.name);
      if (spec.name === ARRANGEMENT_PLAN_AGENT.name) {
        return { ok: true, value: summary({ content: input, structured: plan() }) };
      }
      return { ok: false, reason: 'The agent run ended in an error: 401.' };
    };
    const { rig: state, deps } = rig({ runTask });
    const outcome = await runArrangementJob('a four-bar blues', { deps });

    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.value.patternRuns.map((entry) => entry.reason)).toEqual([
      'The agent run ended in an error: 401.',
      'The agent run ended in an error: 401.',
    ]);
    // ⚠ TWO sub-runs for two patterns, not four: a phase runs ONCE. A retry
    // landing here without the header being read would break this.
    expect(calls).toHaveLength(3);
    expect(state.assembleArgs?.ids.size).toBe(0);
  });

  it('is a hole when the pattern cannot be opened, and never runs the model for it', async () => {
    const openPattern = (pattern: PlannedPattern): Result<string> =>
      pattern.name === 'C7 Comp'
        ? { ok: false, reason: 'A composition block is open for editing.' }
        : { ok: true, value: `lib-${pattern.name}` };
    const { rig: state, deps } = rig({ openPattern });
    const outcome = await runArrangementJob('a four-bar blues', { deps });

    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.value.patternRuns[0]?.reason).toContain('composition block is open');
    // One plan run and ONE sub-run: no pattern to write into means no model call
    // spent on it.
    expect(state.runs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- progress ---

describe('progress', () => {
  it('is emitted for each phase, in order, counting the patterns', async () => {
    const { deps } = rig();
    const events: ArrangementJobEvent[] = [];
    const outcome = await runArrangementJob('a four-bar blues', {
      deps,
      onProgress: (event) => events.push(event),
    });

    expect(events.map((event) => event.type)).toEqual([
      'job.started',
      'plan.started',
      'plan.finished',
      'pattern.started',
      'pattern.finished',
      'pattern.started',
      'pattern.finished',
      'assembly.started',
      'assembly.finished',
      'job.finished',
    ]);

    // "pattern 2 of 2" — the thing the composition panel cannot say today,
    // because it infers phases from tool names and nothing tells it how many
    // there are.
    const started = events.filter((event) => event.type === 'pattern.started');
    expect(started.map((event) => `${event.index} of ${event.count}`)).toEqual([
      '1 of 2',
      '2 of 2',
    ]);
    expect(started.map((event) => event.pattern.name)).toEqual(['C7 Comp', 'F7 Comp']);
    // The id is emitted BEFORE the job ends, because the log of a job that hung
    // is wanted while it is still hanging.
    const started0 = events[0];
    if (started0?.type !== 'job.started') throw new Error('no job.started');
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(started0.transcriptId).toBe(outcome.value.transcriptId);

    // ⚠ AND THE PAYLOAD, not only the sequence: a panel that cannot say WHICH
    // pattern came back with what is back to inferring, which is the thing this
    // event exists to end.
    const done = events.filter((event) => event.type === 'pattern.finished');
    expect(done.map((event) => event.patternId)).toEqual(['lib-C7 Comp', 'lib-F7 Comp']);
    expect(done.map((event) => event.pattern.name)).toEqual(['C7 Comp', 'F7 Comp']);
    // Each one names its own section of the log, so "pattern 2 of 2" can be
    // opened rather than counted to.
    const job = getTranscript(outcome.value.transcriptId);
    expect(done.map((event) => event.runTranscriptId)).toEqual([
      job?.runs?.[1]?.id,
      job?.runs?.[2]?.id,
    ]);
    const finishedAssembly = events.find((event) => event.type === 'assembly.finished');
    expect(finishedAssembly?.assembly).toEqual(assembled());
  });

  it('says on the event which pattern came back empty, and where its blank is', async () => {
    const { deps } = rig({ hasNotes: (id) => id !== 'lib-C7 Comp' });
    const events: ArrangementJobEvent[] = [];
    await runArrangementJob('a four-bar blues', {
      deps,
      onProgress: (event) => events.push(event),
    });

    const done = events.filter((event) => event.type === 'pattern.finished');
    expect(done[0]?.patternId).toBeUndefined();
    expect(done[0]?.reason).toContain('nothing written');
    // The blank opened for it is still in the library — see the header on why
    // it is not deleted — and the id is the only way a caller could find it.
    expect(done[0]?.blankPatternId).toBe('lib-C7 Comp');
    expect(done[1]?.patternId).toBe('lib-F7 Comp');
    expect(done[1]?.blankPatternId).toBeUndefined();
  });

  it('says a cancel is a cancel rather than a failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps } = rig();
    const events: ArrangementJobEvent[] = [];
    await runArrangementJob('a four-bar blues', {
      deps,
      signal: controller.signal,
      onProgress: (event) => events.push(event),
    });

    const last = events[events.length - 1];
    if (last?.type !== 'job.finished') throw new Error('no job.finished');
    expect(last.ok).toBe(false);
    expect(last.stopped).toBe('cancelled');
  });

  it('is not the job′s problem when a view throws', async () => {
    const { rig: state, deps } = rig();
    const outcome = await runArrangementJob('a four-bar blues', {
      deps,
      onProgress: () => {
        throw new Error('the panel unmounted');
      },
    });

    expect(outcome.ok).toBe(true);
    expect(state.assembleArgs).not.toBeNull();
  });
});

// -------------------------------------------------------------- transcript ---

describe('the job log', () => {
  it('holds every run of the job under one id', async () => {
    const { deps } = rig();
    const outcome = await runArrangementJob('a four-bar blues', { deps });

    if (!outcome.ok) throw new Error(outcome.reason);
    const job = getTranscript(outcome.value.transcriptId);
    expect(job?.runs?.map((run) => run.agent)).toEqual([
      ARRANGEMENT_PLAN_AGENT.name,
      PATTERN_SUB_RUN_AGENT.name,
      PATTERN_SUB_RUN_AGENT.name,
    ]);
    // Each section carries the prompt and the input THAT run was given — which
    // is the whole reason a job cannot be one transcript with one prompt.
    expect(job?.runs?.[0]?.systemPrompt).toBe(ARRANGEMENT_PLAN_AGENT.systemPrompt);
    expect(job?.runs?.[1]?.input).toContain('C7');
    expect(job?.runs?.[2]?.input).toContain('F7');
    // The job's own input is what the user asked for.
    expect(job?.input).toBe('a four-bar blues');
  });

  it('closes the job and every section, with what each one answered', async () => {
    const { deps } = rig();
    const outcome = await runArrangementJob('a four-bar blues', { deps });

    if (!outcome.ok) throw new Error(outcome.reason);
    const job = getTranscript(outcome.value.transcriptId);
    // An unfinished entry in the buffer is how a HUNG job reads. A finished one
    // that never said so is indistinguishable from it.
    expect(job?.finishedAt).toBeDefined();
    expect(job?.outcome?.stoppedReason).toBe('answered');
    // Counted in COPIES, not in hole groups: one hole can stand for six missing
    // copies of one pattern.
    expect(job?.outcome?.content).toBe('0 of 2 blocks placed, 2 copies missing.');
    for (const section of job?.runs ?? []) {
      expect(section.finishedAt).toBeDefined();
      // The model's own account of what it wrote — the half `stoppedReason`
      // cannot give.
      expect(section.outcome?.content).toBeDefined();
    }
  });

  it('records each run′s tool calls onto that run′s own section', async () => {
    // The events are pushed through `runTask`'s `onEvent`, which is where they
    // come from in production. ⚠ The consumer's callback THROWS: `runAgentTask`
    // swallows a throw from the caller's view, and what is asserted is that the
    // log was fed FIRST and so cannot lose an event to it.
    const seen: AgentEvent[] = [];
    const { deps } = rig({}, (spec, _state, options) => {
      const name = spec.name === ARRANGEMENT_PLAN_AGENT.name ? 'read_composition' : 'pattern_stamp_notes';
      for (const event of [
        {
          type: 'tool.requested' as const,
          runId: 'r',
          callId: 'c1',
          name,
          args: { agent: spec.name },
        },
        {
          type: 'tool.finished' as const,
          runId: 'r',
          callId: 'c1',
          name,
          ok: true,
          result: { done: true },
          ms: 3,
        },
      ]) {
        try {
          options.onEvent?.(event);
        } catch {
          /* the harness swallows a throw from the host's view; so does this */
        }
      }
    });
    const outcome = await runArrangementJob('a four-bar blues', {
      deps,
      onEvent: (event) => {
        seen.push(event);
        throw new Error('the panel unmounted');
      },
    });

    if (!outcome.ok) throw new Error(outcome.reason);
    const job = getTranscript(outcome.value.transcriptId);
    // Onto the section that made them, and NOT onto the job — a job has no
    // event stream of its own.
    expect(job?.calls).toHaveLength(0);
    expect(job?.runs?.[0]?.calls[0]?.name).toBe('read_composition');
    expect(job?.runs?.[1]?.calls[0]?.args).toEqual({ agent: PATTERN_SUB_RUN_AGENT.name });
    expect(job?.runs?.[1]?.calls[0]?.result).toEqual({ done: true });
    expect(job?.runs?.[2]?.calls).toHaveLength(1);
    // And forwarded whole to a caller that wanted the live stream.
    expect(seen).toHaveLength(6);
  });
});

// -------------------------------------------------------------- what ships ---

describe('the shipped dependencies', () => {
  it('are the real seam functions, so the tests above are not testing a fake', () => {
    // The fakes are the point of this file, and they would be worthless if the
    // defaults had drifted away from what the app runs.
    expect(ARRANGEMENT_JOB_DEPS.assemble.name).toBe('assembleArrangement');
    expect(ARRANGEMENT_JOB_DEPS.runTask.name).toBe('runAgentTask');
  });

  it('refuses to open a pattern while a composition block is open', async () => {
    // The hazard `pattern_open_blank` refuses for a model: the lib keeps ONE
    // editing pointer, and opening a pattern with a block open silently
    // repoints the editor. A job opens patterns itself, so it has to refuse it
    // too.
    const seed = openBlankPattern('Seed');
    if (!seed.ok) throw new Error(seed.reason);
    const track = addTrack('Rhythm Guitar', 'guitar');
    if (!track.ok) throw new Error(track.reason);
    const placed = addPlacement(seed.value.id, track.value.id, 0);
    if (!placed.ok) throw new Error(placed.reason);
    const opened = openPlacementForEditing(placed.value);
    if (!opened.ok) throw new Error(opened.reason);

    const refused = ARRANGEMENT_JOB_DEPS.openPattern({
      name: 'C7 Comp',
      instrumentId: 'guitar',
      chord: 'C7',
      lengthBars: 1,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain('composition block is open');
  });

  it('opens the blank on the PLAN′s instrument, and refuses one this app has not got', () => {
    // A bass part written onto a guitar pattern stamps cleanly and sounds like a
    // different chord — the grip in the brief is voiced for the plan's neck.
    const opened = ARRANGEMENT_JOB_DEPS.openPattern({
      name: 'Walking Bass',
      instrumentId: 'bass',
      chord: 'F7',
      lengthBars: 2,
    });
    if (!opened.ok) throw new Error(opened.reason);
    const editing = getEditingPattern();
    expect(editing?.id).toBe(opened.value);
    expect(editing && patternInstrumentId(editing)).toBe('bass');
    expect(editing?.events).toHaveLength(0);

    const refused = ARRANGEMENT_JOB_DEPS.openPattern({
      name: 'Sitar Part',
      instrumentId: 'sitar',
      chord: 'F7',
      lengthBars: 2,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain('sitar');
    // Refused BEFORE anything is opened: an instrument this app has not got must
    // not leave a pattern behind.
    expect(getEditingPattern()?.id).toBe(opened.value);
  });

  it('asks whether the pattern has NOTES in it, not whether the run said so', () => {
    // ⚠ The commonest failure of the whole design: a run that answers "done"
    // having written nothing. The pattern it leaves is empty but a whole bar
    // long, so assembly would place it as silence with nothing said about it.
    const opened = openBlankPattern('C7 Comp');
    if (!opened.ok) throw new Error(opened.reason);
    expect(ARRANGEMENT_JOB_DEPS.hasNotes(opened.value.id)).toBe(false);

    const stamped = stampNote({ stringIndex: 0, fret: 3, tick: 0, durationTicks: PPQ });
    if (!stamped.ok) throw new Error(stamped.reason);
    expect(ARRANGEMENT_JOB_DEPS.hasNotes(opened.value.id)).toBe(true);
    // And a pattern that is not there at all is not notes either.
    expect(ARRANGEMENT_JOB_DEPS.hasNotes('no-such-pattern')).toBe(false);
  });
});
