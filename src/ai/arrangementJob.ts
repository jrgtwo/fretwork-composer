/**
 * THE ORCHESTRATED JOB — plan, then one pattern at a time, then assembly.
 *
 * The epic's premise is that one model call holding the whole job — the form,
 * the harmony, the fret arithmetic and the placement at once — defaults to
 * generic output, and that every mechanical failure it made was assembly work a
 * model should never have been doing:
 *
 *   - a four-bar pattern placed at bars 1, 2, 3 and 4, four copies stacked, then
 *     every block removed and the whole thing restarted twice until the step
 *     budget ran out;
 *   - a twelve-bar block dropped over four one-bar blocks on one track, the
 *     overlap warning fired twice and the run shipped it anyway;
 *   - a one-bar pattern at bars 1, 4, 7 and 10 of a twelve-bar form, eight bars
 *     of silence and nothing said about it;
 *   - a second 'Guitar 1' created beside an empty track of that very name.
 *
 * So the job is three phases with three different shapes, and this module is the
 * only place that knows the order:
 *
 *   1. **PLAN** — `ARRANGEMENT_PLAN_AGENT`, which has NO tools and answers with
 *      an object (`ARRANGEMENT_PLAN_SCHEMA` as `outputSchema` — the empty tool
 *      list is what makes that a grammar rather than a hope; see
 *      `RunAgentTaskOptions.outputSchema`). Then `reviewPlan` grades it as DATA,
 *      before a note exists.
 *   2. **PATTERNS** — one narrow sub-run per planned pattern, briefed by
 *      `patternRunInput` and restricted by `PATTERN_SUB_RUN_AGENT`.
 *   3. **ASSEMBLY** — `assembleArrangement`. No model at all: bars to ticks,
 *      copies to blocks, tracks to lanes.
 *
 * ── STRICTLY SEQUENTIAL, and that is not a performance choice ───────────────
 *
 * ⚠ THE APP HAS ONE OPEN-PATTERN POINTER. The sub-runs write into whatever
 * pattern is open, and `PATTERN_SUB_RUN_AGENT` deliberately cannot open one —
 * `patternSubRun`'s header spends a section on why. So the ORCHESTRATOR owns the
 * pointer: it opens a blank pattern, runs one sub-run against it, records the id,
 * and only then moves on. Two sub-runs in flight would be two runs stamping into
 * one pattern, with the second's notes landing in the first's part.
 *
 * ── NO RETRIES. A FIXED PIPELINE, BOUNDED BY CONSTRUCTION AND BY COUNT ──────
 *
 * ⚠ Each phase runs exactly ONCE. A sub-run that produces nothing is reported as
 * a HOLE and the job carries on; it is never attempted again, and a plan that
 * fails review is never sent back for a second try. This is deliberate and not an
 * oversight: a retry is a second model call spent on the same failure, and the
 * only thing this app knows about the first one is that it did not work. The
 * value of a job that always terminates in a known number of calls is higher than
 * the value of the occasional recovery — and a hole is legible, which is what the
 * user needs to re-run one pattern by hand. Retry is a later ticket if it earns
 * one; when it lands it belongs HERE, around the sub-run loop, not inside a
 * phase.
 *
 * ⚠ AND THE COUNT IS BOUNDED TOO — see {@link MAX_SUB_RUNS}. "One run per planned
 * pattern" is a number the MODEL chooses: the plan schema puts no ceiling on the
 * pattern list and `reviewPlan` caps tracks but not patterns, so without this a
 * plan naming forty parts would be forty sequential model calls, at twelve
 * iterations each, with no cancel button wired yet. A plan over the ceiling is
 * refused before the first sub-run, having written nothing.
 *
 * ── CANCELLATION IS CHECKED BETWEEN PHASES AS WELL AS INSIDE THEM ───────────
 *
 * ⚠ ONE `AbortSignal`, threaded to every `runAgentTask` AND checked before each
 * phase begins — including between two sub-runs, which is where a cancel most
 * often lands, because that is where the wall-clock time is. The harness aborts a
 * run in flight; nothing but this module can stop the NEXT one from starting. A
 * cancel that landed between sub-run 3 and sub-run 4 and then assembled would
 * build half an arrangement out of a plan the user has already abandoned, so
 * assembly is never reached after an abort.
 *
 * What a cancel does NOT do is un-write anything. The patterns already written
 * stay in the library and nothing has been placed, because assembly is the only
 * phase that touches the composition and it runs last.
 *
 * ⚠ AND A BLANK IS OPENED BEFORE EACH SUB-RUN, so a cancel — or a hole — leaves
 * an EMPTY pattern in the library under the plan's name. It is left there on
 * purpose rather than deleted: `deletePattern` on the pattern that is open calls
 * `ensurePattern` and `clearHistory`, which would throw away the user's own
 * pattern undo stack as a side effect of a failed sub-run, and this job owns no
 * bracket it could restore it from. The id is on the report
 * ({@link PatternRunReport.blankPatternId}) so a caller that wants it gone can
 * say so; the wider "a job leaves the patterns it minted behind" question is
 * `compositionService`'s, which states it and tracks it in docs/FOLLOW-UPS.md.
 *
 * ── WHAT THIS JOB DELIBERATELY DOES NOT DO ─────────────────────────────────
 *
 *   - **It does not open or close the undo bracket**, and **it does not take the
 *     job lock**. Both belong to the panel, which already brackets a single run,
 *     and widening that to a whole job is the next card's work — it is the card
 *     that also owns the cancel button, so all three arrive together with
 *     something to wrap. Deliberate, not forgotten.
 *
 *     ⚠ WHAT IT DOES DO IS WRAP ITS OWN ASSEMBLY WRITE in `asJobWrite`, and that
 *     is not the same thing. `assembleArrangement` asks `writesLockedOut()`
 *     before its first write, so a caller that took `beginJob()` and then awaited
 *     this job would spend every model call in it and be refused the one phase
 *     that touches the document — after the fact, with the plan and the patterns
 *     already paid for. The exemption cannot be raised by the caller instead:
 *     `asJobWrite` must wrap a SYNCHRONOUS call (its own ⚠ says so — wrapping an
 *     `await` hands the user the agent's key), and this function is a long
 *     `await`. Assembly is synchronous, so the wrap goes there, around it alone.
 *   - **It is wired to no panel.** This card delivers the module and its tests.
 *   - **It does not pre-flight assembly's own guards.** `assembleArrangement`
 *     refuses, having written nothing, on a signature whose bars do not convert,
 *     a track instrument `listTrackInstruments` does not have (a DIFFERENT
 *     catalog from the pattern one the plan schema is typed off — see
 *     `instrumentCatalog`), a blank track name, and the track cap counted against
 *     what the document already holds. None of those can change while the
 *     sub-runs are running, so all of them are knowable before the first one —
 *     and every one of them is found after the last. Closing that means a pure
 *     `canAssemble` exported from `arrangementAssembly` and called here; it is
 *     not authored twice, which is what this codebase keeps paying for.
 *   - **It reports; it does not judge.** A job that assembled with holes in it
 *     comes back `ok` carrying those holes. Whether eight bars of silence is a
 *     failure is the caller's call — `reviewPlan` made the same choice about
 *     empty bars, for the same reason.
 */
import {
  runAgentTask,
  type AgentEvent,
  type AgentRunSummary,
  type AgentSpec,
  type RunAgentTaskOptions,
} from './agentService';
import {
  ARRANGEMENT_PLAN_AGENT,
  planRunInput,
  reviewPlan,
  type PlanReview,
} from './arrangementPlan';
import { ARRANGEMENT_PLAN_SCHEMA } from './arrangementPlanSchema';
import { PATTERN_SUB_RUN_AGENT, patternRunInput } from './patternSubRun';
import { assembleArrangement, type ArrangementAssembly } from './arrangementAssembly';
import { beginJobTranscript, type JobTranscriptRecorder } from './runTranscript';
import { namedRefusals } from './tools/types';
import { asJobWrite, getEditingPlacementId } from '../composition/compositionService';
import {
  findLibraryPattern,
  listInstruments,
  openBlankPattern,
  setEditingPatternInstrument,
  unknownInstrumentRefusal,
} from '../patterns/patternService';
import type { ArrangementPlan, PlannedPattern } from './arrangementPlanSchema';
import type { Result } from '../patterns/patternService';

/** The instrument vocabulary as the PATTERN seam spells it — derived rather than
 *  imported, because `src/ai/**` may not reach the lib and a tripwire test
 *  enforces it. */
type PatternInstrumentId = ReturnType<typeof listInstruments>[number]['id'];

// ------------------------------------------------------------------ report ---

/**
 * Why a job stopped short. TYPED rather than left to the sentence, for
 * `PlanRule`'s reason: the repairs are different, and a caller that has to say
 * what to do next needs to know which of these it is looking at without reading
 * English. A cancel in particular is not a failure and must not be reported as
 * one.
 */
export type ArrangementJobStop =
  /** The signal aborted — before the plan, between two sub-runs, or in flight. */
  | 'cancelled'
  /** The plan run never produced an answer: nothing configured, a dead provider,
   *  a run that ended in error, or no composition to plan against. */
  | 'plan-failed'
  /** It answered, and the answer is not a plan. A prose reply, or JSON of the
   *  wrong shape — see {@link asPlan} on why that is checked here. */
  | 'plan-unusable'
  /** It answered with a plan and the plan breaks rules a write tool would
   *  enforce later. `reviewPlan`'s refusals, verbatim. */
  | 'plan-refused'
  /** Everything was written and the arrangement still could not be built — the
   *  document moved, the track cap, a signature whose bars do not convert. */
  | 'assembly-refused'
  /** A phase threw. Nothing here is meant to: every failure above is RETURNED,
   *  and this exists so a bug in one of them ends the job with a closed
   *  transcript and a sentence rather than a rejected promise the panel has to
   *  guess at. */
  | 'job-error';

/** One planned pattern and what its sub-run left behind. Exactly one of
 *  {@link patternId} and {@link reason} is present. */
export interface PatternRunReport {
  readonly pattern: PlannedPattern;
  /** The library pattern the sub-run wrote, when it wrote one. */
  readonly patternId?: string;
  /** Why there is nothing, in the register the seams refuse in. A HOLE, not a
   *  failure of the job: the other parts were still built, because the user's
   *  next move is to re-write this one and they can only see that if the rest of
   *  the arrangement exists. */
  readonly reason?: string;
  /** The blank this run was given and left EMPTY, on the hole paths where one
   *  was opened at all. It is still in the library — see the header on why it is
   *  not deleted — and this is the handle a caller needs to clean it up or to
   *  re-write it by hand. */
  readonly blankPatternId?: string;
  /** This run's section of the job transcript, so "pattern 3 of 7 came back
   *  empty" can be linked to the log of the run that did it. Absent when the run
   *  never started — a brief that refused, a pattern that would not open. */
  readonly runTranscriptId?: string;
}

/** What a finished job hands back. */
export interface ArrangementJobResult {
  readonly plan: ArrangementPlan;
  /** The plan as `reviewPlan` graded it — carried so a caller can report the
   *  empty bars without re-running it. */
  readonly review: PlanReview;
  /** One entry per planned pattern, in plan order, including the ones that
   *  produced nothing. */
  readonly patternRuns: readonly PatternRunReport[];
  readonly assembly: ArrangementAssembly;
  /** The whole job's log, as ONE artifact — see `runTranscript`. Also emitted on
   *  `job.started`, because the log of a job that hung is wanted while it is
   *  still hanging. */
  readonly transcriptId: string;
}

/**
 * `Result`-shaped, plus the discriminant. A caller that only reads `ok` and
 * `reason` — which is every caller the panels have today — works unchanged; one
 * that has to word a report differently for a cancel reads {@link stopped}.
 */
export type ArrangementJobOutcome =
  | { readonly ok: true; readonly value: ArrangementJobResult }
  | { readonly ok: false; readonly stopped: ArrangementJobStop; readonly reason: string };

// ---------------------------------------------------------------- progress ---

/**
 * What the job is doing, as it does it.
 *
 * ⚠ EMITTED RATHER THAN INFERRED. The composition panel reads phases out of tool
 * NAMES today, which is why its progress display is a flat list — it cannot say
 * "pattern 3 of 7" because nothing tells it there are seven. A job knows, so it
 * says so.
 *
 * Shaped like `AgentEvent`: a union discriminated on `type`, one callback, every
 * event delivered whether anything is listening or not.
 */
export type ArrangementJobEvent =
  /** First, and before the plan run: it carries the transcript id, which a panel
   *  needs while the job is still running. */
  | { readonly type: 'job.started'; readonly transcriptId: string }
  /** Carries the plan run's own section id, for `pattern.started`'s reason
   *  below: a panel that says "planning" wants to link to the planning log. */
  | { readonly type: 'plan.started'; readonly runTranscriptId: string }
  | { readonly type: 'plan.finished'; readonly plan: ArrangementPlan }
  | {
      readonly type: 'pattern.started';
      /** 1-based, so `index` of `count` reads as a person would say it. */
      readonly index: number;
      readonly count: number;
      readonly pattern: PlannedPattern;
    }
  | {
      readonly type: 'pattern.finished';
      readonly index: number;
      readonly count: number;
      readonly pattern: PlannedPattern;
      readonly patternId?: string;
      readonly reason?: string;
      /** Both as {@link PatternRunReport} carries them — the event IS the report,
       *  numbered. `runTranscriptId` is what lets a panel link "pattern 3 came
       *  back empty" to that run's own section of the log. */
      readonly blankPatternId?: string;
      readonly runTranscriptId?: string;
    }
  | { readonly type: 'assembly.started' }
  | { readonly type: 'assembly.finished'; readonly assembly: ArrangementAssembly }
  | {
      readonly type: 'job.finished';
      readonly ok: boolean;
      readonly stopped?: ArrangementJobStop;
      readonly reason?: string;
    };

// -------------------------------------------------------------------- deps ---

/** The model call, exactly as `runAgentTask` gives it, with the options no longer
 *  optional — a job always passes some. Spelled out rather than
 *  `typeof runAgentTask` so a fake in a test is a two-line function whose
 *  `options` parameter is not `| undefined`. */
export type RunTask = (
  spec: AgentSpec,
  input: string,
  options: RunAgentTaskOptions,
) => Promise<Result<AgentRunSummary>>;

/**
 * Everything the job reaches OUTSIDE itself, in one injectable bundle.
 *
 * The point is the tests: the phases, their order, the cancellation checks and
 * the hole reporting are the whole of what this module does, and none of it
 * should need a model, a provider or a document to assert. `ArrangementJob.test`
 * drives all four of these with fakes.
 *
 * ⚠ NOT a general extension point. The defaults below are what ships, and a
 * caller passing its own is a test.
 */
export interface ArrangementJobDeps {
  readonly runTask: RunTask;
  /**
   * Open a blank pattern for one planned part and hand back its id — the
   * orchestrator's half of the single-pointer rule.
   */
  readonly openPattern: (pattern: PlannedPattern) => Result<string>;
  /**
   * Did the sub-run actually write anything into it?
   *
   * ⚠ THE ANSWER IS NOT "the run returned ok". A run that answered "done" without
   * calling a tool is the commonest failure of this whole design, and the pattern
   * it leaves behind is EMPTY BUT NOT ZERO-LENGTH — `fitPatternDuration` rounds
   * up to a whole bar with a one-bar minimum — so assembly would place it happily
   * and the arrangement would come out with a silent part in it. Asked here so
   * that failure becomes a hole with a sentence on it.
   */
  readonly hasNotes: (patternId: string) => boolean;
  readonly assemble: typeof assembleArrangement;
}

/**
 * What ships. Split out so a test can override ONE of them and keep the rest
 * real if it wants to.
 */
export const ARRANGEMENT_JOB_DEPS: ArrangementJobDeps = {
  runTask: runAgentTask,

  openPattern: (pattern) => {
    /**
     * ⚠ REFUSED WHILE A COMPOSITION BLOCK IS OPEN, for `pattern_open_blank`'s
     * reason at this address: the lib keeps ONE pattern-editing pointer and
     * `openPatternForEditing` nulls `editingPlacementId`, so opening a pattern
     * with a block open silently repoints the editor and every later stamp lands
     * somewhere the user is not looking, outside the composition's rollback.
     * The tool refuses it for the model; a job opens patterns itself and has to
     * refuse it for the same reason.
     */
    if (getEditingPlacementId() !== null) {
      return {
        ok: false,
        reason:
          'A composition block is open for editing, so a new pattern cannot be opened without repointing the editor. Close the block first.',
      };
    }
    const known = listInstruments().some((entry) => entry.id === pattern.instrumentId);
    if (!known) return { ok: false, reason: unknownInstrumentRefusal(pattern.instrumentId) };
    // ⚠ THE PLAN'S NAME, VERBATIM — `openBlankPattern` only uniquifies the name
    // it invents for itself, so two jobs that both plan a "Rhythm Guitar" leave
    // two library patterns of that name. Accepted rather than worked around: the
    // name is the plan's product and the one the user asked for, assembly
    // resolves patterns by ID so nothing inside a job is ambiguous, and
    // `uniqueLibraryName` is private to the pattern seam. What it costs is a rail
    // the user has to tell apart by hand.
    const opened = openBlankPattern(pattern.name);
    if (!opened.ok) return opened;
    // The cast is the check above, cashed in. A blank pattern is a guitar until
    // it is told otherwise, and the grip in the brief was voiced for the plan's
    // neck — a bass part written onto a guitar pattern stamps cleanly and sounds
    // like a different chord, which is `patternSubRun`'s ⚠ about injected frets.
    const set = setEditingPatternInstrument(pattern.instrumentId as PatternInstrumentId);
    if (!set.ok) return set;
    return { ok: true, value: opened.value.id };
  },

  hasNotes: (patternId) => (findLibraryPattern(patternId)?.events.length ?? 0) > 0,

  assemble: assembleArrangement,
};

// --------------------------------------------------------------- the plan ---

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * `AgentRunSummary.structured` — typed `unknown` — as a plan, or null.
 *
 * ⚠ THIS IS NOT BELT AND BRACES. `reviewPlan` takes its argument ON TRUST and
 * THROWS on a malformed one: its three lists are iterated, not guarded, and its
 * header says in as many words that a caller which casts instead of narrowing
 * has a bug. `structured` is `unknown` for exactly this reason. So the narrowing
 * happens here, once, and a reply that is not a plan is a typed stop rather than
 * a `TypeError` out of the validator.
 *
 * ⚠ TYPES ONLY, NEVER VALUES. `bars: 0`, a length of 1.5, a placement naming a
 * pattern that does not exist — all of those pass here and are `reviewPlan`'s to
 * refuse, with the sentences it authored. Re-checking them here would put two
 * accounts of one mistake in circulation, which is the thing `barMath` and
 * `instrumentCatalog` exist because of.
 *
 * The fields are COPIED rather than the reply cast, so a provider that ignored
 * `additionalProperties: false` cannot smuggle an extra key into the plan the
 * report is written from.
 */
function asPlan(value: unknown): ArrangementPlan | null {
  if (!isObject(value)) return null;
  const { bars, tracks, patterns, placements } = value;
  if (!isNumber(bars)) return null;
  if (!Array.isArray(tracks) || !Array.isArray(patterns) || !Array.isArray(placements)) return null;

  const plannedTracks = tracks.map((track) =>
    isObject(track) && isText(track.name) && isText(track.instrumentId)
      ? { name: track.name, instrumentId: track.instrumentId }
      : null,
  );
  const plannedPatterns = patterns.map((pattern) =>
    isObject(pattern) &&
    isText(pattern.name) &&
    isText(pattern.instrumentId) &&
    isText(pattern.chord) &&
    isNumber(pattern.lengthBars)
      ? {
          name: pattern.name,
          instrumentId: pattern.instrumentId,
          chord: pattern.chord,
          lengthBars: pattern.lengthBars,
        }
      : null,
  );
  const plannedPlacements = placements.map((placement) =>
    isObject(placement) &&
    isText(placement.patternName) &&
    isText(placement.trackName) &&
    Array.isArray(placement.atBars) &&
    placement.atBars.every(isNumber)
      ? {
          patternName: placement.patternName,
          trackName: placement.trackName,
          atBars: [...(placement.atBars as number[])],
        }
      : null,
  );

  // One bad entry makes the whole reply unusable rather than a plan with a gap
  // in it: a plan is read as a whole — the placements refer to the tracks and
  // the patterns by name — so dropping the entry a placement points at would
  // turn a decoding failure into an arrangement that is quietly missing a part.
  if (
    plannedTracks.includes(null) ||
    plannedPatterns.includes(null) ||
    plannedPlacements.includes(null)
  ) {
    return null;
  }

  return {
    bars,
    tracks: plannedTracks as ArrangementPlan['tracks'],
    patterns: plannedPatterns as ArrangementPlan['patterns'],
    placements: plannedPlacements as ArrangementPlan['placements'],
  };
}

// --------------------------------------------------------------------- run ---

/** The label the job's transcript is filed under, and the one a panel shows. */
const JOB_LABEL = 'Arrange';

/**
 * Model round-trips a sub-run gets, when the caller names no bound.
 *
 * `CommandPanel`'s number for a pattern-page run, because a sub-run IS one: read
 * the pattern, stamp it, mark the dynamics, mark the articulations, answer. Not
 * the composition panel's 60, which is sized for a whole arrangement in one call
 * — the thing this job exists to stop being.
 *
 * ⚠ DEFAULTED HERE rather than left to the harness's 8. A sub-run that ran out of
 * iterations comes back with a half-written pattern and `stoppedReason:
 * 'max_iters'`, which this job reports as a WRITTEN pattern — it has notes in it
 * — so an invisible truncation would ship as a part that stops half way. A number
 * that has to be passed in is a number a caller will forget.
 */
const SUB_RUN_MAX_ITERS = 12;

/**
 * How many patterns a plan may name before the job refuses it whole.
 *
 * ⚠ THE ONLY THING THAT BOUNDS THE JOB'S COST. Everything else here is fixed by
 * construction — three phases, one call each, no retries — but the sub-run count
 * comes out of the model: `ARRANGEMENT_PLAN_SCHEMA` gives `patterns` a minimum
 * and no maximum, and `reviewPlan` caps TRACKS and says nothing about patterns.
 * Forty parts is forty sequential runs of up to {@link SUB_RUN_MAX_ITERS}
 * round-trips, and the cancel button is not wired yet.
 *
 * The number is under `MAX_RUNS_PER_JOB` (32 sections) BY MORE THAN THE PLAN RUN
 * ON PURPOSE, so a job that ran to the end always has a complete log — a job
 * whose transcript is truncated is one that cannot be diagnosed, which is the
 * one thing this epic has been living on. Twenty-four parts is already more than
 * an arrangement of this app's size plausibly needs; a plan that wants more is
 * asking for something the pattern-per-run design is not shaped for.
 */
const MAX_SUB_RUNS = 24;

export interface ArrangementJobOptions {
  /** ONE signal for the whole job — see the header. */
  readonly signal?: AbortSignal;
  /** Progress, as the job makes it. Never required; the job always emits. */
  readonly onProgress?: (event: ArrangementJobEvent) => void;
  /**
   * The raw harness events of every run, for a caller that wants live tool
   * output. The transcript is recorded whether this is passed or not — it is fed
   * FIRST, so a view that throws cannot cost the log an event.
   */
  readonly onEvent?: (event: AgentEvent) => void;
  /** Outer bound on model round-trips per SUB-RUN, defaulting to
   *  {@link SUB_RUN_MAX_ITERS}. The plan run is left at the harness default: it
   *  has no tools, so it answers in one. */
  readonly maxIters?: number;
  /** What the job is called in the transcript and in a panel. */
  readonly label?: string;
  /** Test seam. See {@link ArrangementJobDeps} — a caller passing this is a
   *  test. */
  readonly deps?: Partial<ArrangementJobDeps>;
}

const stop = (stopped: ArrangementJobStop, reason: string): ArrangementJobOutcome => ({
  ok: false,
  stopped,
  reason,
});

/**
 * RUN THE WHOLE JOB: plan, patterns one at a time, assembly.
 *
 * `request` is what the user asked for, in their own words — it goes to the plan
 * run and nowhere else. The sub-runs are briefed from the PLAN, deliberately:
 * "write two bars of walking bass over F7" is a brief narrow enough to be hard to
 * fill with generic material, and handing the original request down beside it
 * would put the whole job back inside one call, which is what this exists to
 * stop.
 *
 * Returns a refusal for anything that stopped the job, and `ok` — with holes in
 * it, possibly — for anything that finished. Read the header before adding a
 * retry, an undo bracket or a job lock: none of the three is missing by accident.
 */
export async function runArrangementJob(
  request: string,
  options: ArrangementJobOptions = {},
): Promise<ArrangementJobOutcome> {
  const deps: ArrangementJobDeps = { ...ARRANGEMENT_JOB_DEPS, ...options.deps };
  const signal = options.signal;
  const label = options.label ?? JOB_LABEL;

  const emit = (event: ArrangementJobEvent): void => {
    try {
      options.onProgress?.(event);
    } catch {
      /* a view's throw is not the job's problem — `runAgentTask` says the same */
    }
  };

  // ⚠ BEFORE THE TRANSCRIPT EXISTS. A job cancelled before it started has
  // nothing to log, and registering it anyway would spend one of the buffer's
  // five slots evicting the log somebody is most likely on their way to read.
  if (signal?.aborted) {
    const reason = 'The job was cancelled before it started. Nothing was assembled.';
    emit({ type: 'job.finished', ok: false, stopped: 'cancelled', reason });
    return stop('cancelled', reason);
  }

  const job = beginJobTranscript({
    page: 'composition',
    command: label,
    agent: 'arrangement-job',
    input: request,
  });

  /**
   * Every exit goes through here, so the transcript is closed and the caller is
   * told in one place.
   *
   * `content` is the one-line account of a job that FINISHED — a job that
   * assembled with holes in it is an `ok` outcome, and the log should say so
   * without the reader having to count the sections.
   *
   * Guarded against a second call: the `catch` below is reached from anywhere,
   * including from inside a transcript listener that threw during this very
   * function, and a job closed twice would have the first account of itself
   * overwritten by the second.
   */
  let closed = false;
  const finish = (outcome: ArrangementJobOutcome, content = ''): ArrangementJobOutcome => {
    if (closed) return outcome;
    closed = true;
    job.finish(
      outcome.ok
        ? { stoppedReason: 'answered', content }
        : { stoppedReason: outcome.stopped, error: outcome.reason },
    );
    emit(
      outcome.ok
        ? { type: 'job.finished', ok: true }
        : { type: 'job.finished', ok: false, stopped: outcome.stopped, reason: outcome.reason },
    );
    return outcome;
  };

  const cancelled = (where: string): ArrangementJobOutcome =>
    finish(stop('cancelled', `The job was cancelled ${where}. Nothing was assembled.`));

  emit({ type: 'job.started', transcriptId: job.id });

  // ⚠ EVERY FAILURE BELOW IS RETURNED, NOT THROWN — this catches the ones that
  // are bugs. A throw out of `reviewPlan`, out of a consumer's callback or out of
  // assembly would otherwise reject the promise with the transcript left open,
  // which reads in the buffer as a job that is still running and leaves the panel
  // with no sentence to show. See `ArrangementJobStop['job-error']`.
  try {
    // ---------------------------------------------------------- 1. the plan ---

    const planInput = planRunInput(request);
    if (!planInput.ok) return finish(stop('plan-failed', planInput.reason));

    const planSection = job.beginRun({
      command: `${label} — plan`,
      agent: ARRANGEMENT_PLAN_AGENT.name,
      systemPrompt: ARRANGEMENT_PLAN_AGENT.systemPrompt,
      input: planInput.value,
    });
    emit({ type: 'plan.started', runTranscriptId: planSection.id });
    const planRun = await deps.runTask(ARRANGEMENT_PLAN_AGENT, planInput.value, {
      ...(signal ? { signal } : {}),
      onEvent: (event) => {
        planSection.record(event);
        options.onEvent?.(event);
      },
      outputSchema: ARRANGEMENT_PLAN_SCHEMA,
    });
    planSection.finish(
      planRun.ok
        ? { stoppedReason: planRun.value.stoppedReason, content: planRun.value.content }
        : { error: planRun.reason },
    );

    // The abort is checked BEFORE the result is read: a cancelled run comes back
    // `ok` with `stoppedReason: 'aborted'` and a partial answer, and reporting
    // that as an unusable plan would blame the model for the user's own click.
    if (signal?.aborted) return cancelled('while it was planning');
    if (!planRun.ok) return finish(stop('plan-failed', planRun.reason));

    const plan = asPlan(planRun.value.structured);
    if (!plan) {
      return finish(
        stop(
          'plan-unusable',
          `The planning run did not answer with a plan (${planRun.value.stoppedReason}). Nothing was written. The answer is in the run log.`,
        ),
      );
    }

    const review = reviewPlan(plan);
    if (review.refusals.length > 0) {
      // The plan step's own sentences, unedited — they are its product, and a
      // second account of one mistake is what this codebase keeps paying for.
      return finish(
        stop(
          'plan-refused',
          `The plan cannot be built as it stands, so nothing was written. ${namedRefusals(
            review.refusals.map((entry) => ({ label: entry.rule, reason: entry.reason })),
          )}`,
        ),
      );
    }

    // The one rule that is this module's and not `reviewPlan`'s, because it is
    // about what a JOB costs rather than about whether the arrangement is sound.
    // Checked here, before a note exists — see {@link MAX_SUB_RUNS}.
    if (plan.patterns.length > MAX_SUB_RUNS) {
      return finish(
        stop(
          'plan-refused',
          `The plan names ${plan.patterns.length} patterns, and a job writes at most ${MAX_SUB_RUNS} — one model run each, one after another. Nothing was written. Ask for fewer distinct parts, or build it in two passes.`,
        ),
      );
    }
    emit({ type: 'plan.finished', plan });

    // ------------------------------------------------------ 2. the patterns ---

    // A pattern nothing places costs a model call and leaves a pattern in the
    // library that no block refers to. `reviewPlan` checks the other direction
    // (a placement naming a pattern that does not exist) and has no rule for
    // this one, so it is reported here rather than run.
    const placed = new Set(plan.placements.map((placement) => placement.patternName));

    const patternRuns: PatternRunReport[] = [];
    const patternIds = new Map<string, string>();
    const count = plan.patterns.length;

    for (const [position, pattern] of plan.patterns.entries()) {
      // ⚠ BEFORE THE SUB-RUN, not only inside it: this is the check that stops a
      // job the user abandoned between two patterns from going on to assemble.
      // `position` counts the patterns ATTEMPTED, which is not the same as the
      // ones written — some of them may be holes.
      if (signal?.aborted) return cancelled(`after ${position} of ${count} patterns`);
      const index = position + 1;
      emit({ type: 'pattern.started', index, count, pattern });

      const report = placed.has(pattern.name)
        ? await writePattern(pattern, deps, options, signal, job)
        : {
            pattern,
            reason: `The plan declares "${pattern.name}" and never places it, so there is nowhere for it to go. It was not written.`,
          };
      patternRuns.push(report);
      if (report.patternId !== undefined) patternIds.set(pattern.name, report.patternId);
      emit({ type: 'pattern.finished', index, count, ...report });
    }

    // ----------------------------------------------------- 3. the assembly ---

    if (signal?.aborted) return cancelled('after the patterns were written');

    emit({ type: 'assembly.started' });
    // ⚠ INSIDE THE JOB'S OWN EXEMPTION. Assembly is the one phase that writes to
    // the composition, and it asks `writesLockedOut()` before its first write —
    // so a caller holding `beginJob()` would otherwise be refused the whole
    // arrangement after every model call had been spent on it. The wrap is here
    // rather than around the call to this function because `asJobWrite` may only
    // hold a SYNCHRONOUS call; assembly is one. Harmless when no job is running.
    const assembled = asJobWrite(() => deps.assemble(plan, patternIds));
    if (!assembled.ok) return finish(stop('assembly-refused', assembled.reason));
    emit({ type: 'assembly.finished', assembly: assembled.value });

    const built = assembled.value;
    // `blocks` plus the bars named across `holes` is always `plannedBlocks` —
    // `ArrangementAssembly` states that identity — so COPIES are what is counted
    // here. `holes.length` would count GROUPS: one hole can stand for six
    // missing copies of one pattern on one track.
    const missing = built.plannedBlocks - built.blocks.length;
    return finish(
      {
        ok: true,
        value: { plan, review, patternRuns, assembly: built, transcriptId: job.id },
      },
      `${built.blocks.length} of ${built.plannedBlocks} blocks placed, ${missing} ${
        missing === 1 ? 'copy' : 'copies'
      } missing.`,
    );
  } catch (error) {
    return finish(
      stop(
        'job-error',
        `The job stopped on an unexpected error: ${
          error instanceof Error ? error.message : String(error)
        }. Whatever it had written is in the library; the arrangement may be half built.`,
      ),
    );
  }
}

/**
 * ONE pattern: brief it, open a blank one for it, run it, and check that
 * something actually got written.
 *
 * ⚠ NOTHING HERE ABORTS THE JOB. Every failure is a hole with a sentence on it —
 * a brief that refuses, a pattern that will not open, a run that errors, a run
 * that answered without writing. The other parts are still worth building: the
 * user's next move is to re-write this one part, and they can only see that if
 * the rest of the arrangement is in front of them. Assembly turns each of these
 * into its own `unwritten` hole, with the bars it would have covered.
 *
 * ⚠ AND NOTHING HERE RETRIES. See the header.
 */
async function writePattern(
  pattern: PlannedPattern,
  deps: ArrangementJobDeps,
  options: ArrangementJobOptions,
  signal: AbortSignal | undefined,
  job: JobTranscriptRecorder,
): Promise<PatternRunReport> {
  // The brief FIRST: it refuses an unreadable chord symbol, an instrument this
  // app has not got and a length that is not a whole bar, and all three are
  // knowable without touching the document. Opening a blank pattern first would
  // leave a dead one in the library for every plan entry that cannot be briefed.
  const brief = patternRunInput(pattern);
  if (!brief.ok) return { pattern, reason: brief.reason };

  const opened = deps.openPattern(pattern);
  if (!opened.ok) return { pattern, reason: opened.reason };
  const patternId = opened.value;

  const section = job.beginRun({
    command: `${pattern.name} (${pattern.chord})`,
    agent: PATTERN_SUB_RUN_AGENT.name,
    systemPrompt: PATTERN_SUB_RUN_AGENT.systemPrompt,
    input: brief.value,
  });
  const runTranscriptId = section.id;
  const run = await deps.runTask(PATTERN_SUB_RUN_AGENT, brief.value, {
    ...(signal ? { signal } : {}),
    maxIters: options.maxIters ?? SUB_RUN_MAX_ITERS,
    onEvent: (event) => {
      section.record(event);
      options.onEvent?.(event);
    },
  });
  section.finish(
    run.ok
      ? { stoppedReason: run.value.stoppedReason, content: run.value.content }
      : { error: run.reason },
  );

  // The blank stays in the library on both hole paths below — the header says
  // why — so its id goes on the report, which is the only place a caller could
  // learn of it.
  if (!run.ok) return { pattern, reason: run.reason, blankPatternId: patternId, runTranscriptId };

  // ⚠ THE RUN RETURNING `ok` IS NOT THE QUESTION — see `ArrangementJobDeps
  // .hasNotes`. An empty pattern is a whole bar long and would be placed as
  // silence with nothing said about it.
  if (!deps.hasNotes(patternId)) {
    return {
      pattern,
      reason: `The run for "${pattern.name}" ended (${run.value.stoppedReason}) with nothing written into the pattern, so there is nothing to place. Its bars are empty.`,
      blankPatternId: patternId,
      runTranscriptId,
    };
  }

  return { pattern, patternId, runTranscriptId };
}
