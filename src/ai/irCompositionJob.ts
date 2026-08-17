/**
 * THE WHOLE JOB, IN ONE FUNCTION: a chart, a part at a time, then the import.
 *
 * Three surfaces already exist and none of them knows about the others. This is
 * the only module that knows the ORDER:
 *
 *   1. `runArrangementChart` — one tool-free run that settles the form, the
 *      tempo, the parts and the harmony, already graded by `reviewChart` inside
 *      that function. It writes nothing.
 *   2. `runIRTrack`, once per part, IN ORDER — a tool-free run per track,
 *      briefed from the chart, range-checked by `reviewTrack` on the way back.
 *      It writes nothing either.
 *   3. `patternService.importIR` — the one call that writes, and it writes
 *      everything at once.
 *
 * Nothing exists in the library until step 3. That single fact is what makes the
 * failure policy below possible at all: nothing is committed until every part
 * that is going to be written has been, so what to do about a part that failed is
 * still an open question when the answer is known.
 *
 * ── ⚠ ONE RETRY PER PART, AND NEVER MORE THAN ONE ───────────────────────────
 *
 * A part whose own review refused it is asked AGAIN, once, with the refusal
 * appended to its brief. What is bounded, exactly:
 *   - ONE extra run per part, never chained. The second answer is reviewed and
 *     that is the end of it; a third is never asked for, whatever the second says.
 *   - ONLY on a review refusal — `runIRTrack`'s `'review'` stop. A dead provider,
 *     a brief that will not build, an answer that was not a structure and an
 *     aborted run are all asked for exactly once, because nothing the app knows
 *     about them would make the second attempt different.
 *   - The CHART is never re-asked. `runArrangementChart` refuses in its own
 *     sentences and this module has no addendum to give it.
 *
 * ⚠ THIS REVERSES A DECISION, DELIBERATELY. Until 2026-08-16 nothing here was
 * retried, and the reason given was that "the only thing this app knows about the
 * first one is that it did not work". That is no longer true of a review refusal:
 * `reviewTrack` names the offending event, prints the notes in it, prints the
 * shape that belongs there and says to write `strum` instead. The 2026-08-16 run
 * is the evidence — 'Guitar 2' typed F7's barre where the chart said C7, out of a
 * brief that listed both — and feeding that sentence back is the cheapest repair
 * available, at the cost of one model call and only when a part has failed.
 *
 * The COUNT is still bounded without a ceiling of this module's own, which is the
 * difference from the job deleted at b8582bb — that one needed a `MAX_SUB_RUNS`
 * because the model chose how many patterns to write. Here the worst case is
 * `1 + 2 * chart.tracks.length`, and `reviewChart` already refuses a chart naming
 * more than `MAX_COMPOSITION_TRACKS` (8) parts. So the worst case is seventeen
 * runs, still under `runTranscript`'s 32-section cap — a job that ran to the end
 * always has a complete log, which is the thing every failure since 2026-08-09
 * has been diagnosed from.
 *
 * ── ⚠ WHAT SURVIVED IS IMPORTED. THE FLOOR IS TWO PARTS ─────────────────────
 *
 * A part that fails BOTH attempts no longer throws the job away. The parts that
 * were written are imported and the one that was not is reported, by name, with
 * its reason. The 2026-08-16 run is the evidence for that too: a correct bass and
 * a correct guitar were discarded over one bad event in a third part.
 *
 * ⚠ THE FLOOR IS TWO SURVIVING PARTS, and it is a fact about the mapper rather
 * than a preference. `mapImportToLibrary` picks `composition` topology only when
 * the document has MORE THAN ONE non-empty track (pinned in
 * tests/ImportIR.test.ts). With one survivor there is no composition to import —
 * only a loose pattern in the library — so that case refuses whole, and the
 * refusal says so in those terms rather than as a generic failure.
 *
 * (A chart that named ONE part and wrote it is untouched by this: it never lost a
 * part, and the mapper's `single-pattern` is the honest answer to a one-part
 * chart. The floor applies only where something failed.)
 *
 * ⚠ A SHORT IMPORT IS NOT A CLEAN SUCCESS, and must not read as one. Two channels
 * the panel ALREADY renders carry it, and no third is invented:
 *   - the `track.finished` event for the failed part carries `ok: false` and its
 *     reason, so the phase list marks the part where the part is;
 *   - the missing part's sentence is appended to `documents.warnings`, which the
 *     panel prints verbatim on a success — and the panel's own headline reads
 *     `Incomplete` rather than `Done` because it compares the chart's part count
 *     against the imported pattern count, which now differs.
 * {@link IrCompositionJobResult.missing} carries the same facts structurally, for
 * a caller that should not have to find ours among the pipeline's warnings.
 *
 * ── SEQUENTIAL, NOT CONCURRENT ──────────────────────────────────────────────
 *
 * The runs go one at a time. They are model calls against ONE provider, and a
 * failure part way through should not leave three of them in flight against a
 * job that has already stopped — which is also the only way the cancellation
 * checks below can mean anything.
 *
 * ── CANCELLATION ────────────────────────────────────────────────────────────
 *
 * ⚠ ONE `AbortSignal`, threaded into every run AND checked BETWEEN them. The
 * harness aborts a run that is in flight; nothing but this module can stop the
 * NEXT one from starting, and between two track runs is where a cancel most
 * often lands because that is where the wall-clock time is.
 *
 * It is checked after each run as well as before, because a cancelled run comes
 * back `ok` with `stoppedReason: 'aborted'` and no structure — reporting that as
 * a part the model wrote badly would blame the model for the user's own click.
 *
 * ⚠ THE LAST CHECK IS IMMEDIATELY BEFORE THE IMPORT, and after that the job is
 * committed. `importIR` is one `commitImport` and is not interruptible: there is
 * no point in the write where a signal could be consulted, and no undo step to
 * take back afterwards (the import creates new rows rather than editing the open
 * document). So the guarantee this module gives is exactly this: a cancel that
 * lands before the import means nothing was written at all.
 *
 * ── THE ENVELOPE IS OURS, NOT THE MODEL'S ───────────────────────────────────
 *
 * The track runs return musical content and nothing else. `meta`,
 * `ticksPerQuarter`, `totalTicks`, `tempos`, `timeSignatures` and the track IDS
 * are built HERE, from the chart, for the standing reason this area exists:
 * every field the model had to author that the app could derive was a field it
 * eventually got wrong. `totalTicks` is `chart.bars * TICKS_PER_BAR` and the
 * meter is `IR_TIME_SIGNATURE`, both imported from `irTrackRun` rather than
 * recomputed — the briefs quote those same numbers to the model, and a document
 * that disagreed with its own briefs would put every chord change on the wrong
 * beat with nothing refused anywhere.
 *
 * ⚠ NO `sections`, NO `chords`, NO `keySignatures` — and the arrays that ARE
 * emitted are empty only because the lib's `ImportIR` requires the keys:
 *   - LIB-GAP(21): `chords` is DISCARDED by `validateImportIR` — it is not copied
 *     onto the IR the mapper receives, so the harmony lane is always empty
 *     however much is written into it. This is where that gap first COSTS
 *     something: `runArrangementChart` settles a whole progression, every part is
 *     written against it, and the imported composition carries no record of it.
 *     Delete this bullet, and write `chart.value.chords` into the document, when
 *     `validateImportIR` copies `chords` through with `symbol` sanitized. See
 *     docs/FOLLOW-UPS.md row 21.
 *   - `keySignatures` is never read by the mapper at all; every pattern is built
 *     with `key: null`.
 *   - `sections` are OPTIONAL, against the mapper's own doc comment: two or more
 *     non-empty tracks is enough to get a composition. What markers change is the
 *     CUT — patterns come out as tracks × sections, so three parts over four
 *     sections is twelve patterns rather than four. One pattern per part,
 *     spanning the piece, is what this job wants first.
 * All three are pinned in tests/ImportIR.test.ts.
 *
 * ⚠ `meta.title` NAMES THE COMPOSITION. `mapImportToLibrary` uses
 * `ir.meta.title || selectedTrack.name`, so leaving it off would file the piece
 * under whichever part happened to sort first — a composition called "Bass".
 * The chart has no title field to read (adding one is `arrangementChart`'s call,
 * not this module's), so it comes from the request, first line, trimmed. See
 * {@link documentTitle}.
 *
 * ⚠ `meta.sourceFormat` IS REQUIRED AND DEAD. Neither the validator nor the
 * mapper reads it; the union has no value meaning "written here", and inventing
 * one is a lib change. `'ascii-tab'` is what tests/ImportIR.test.ts' fixtures
 * use and is the nearest true thing — strings and frets, no pitch.
 *
 * ⚠ NO `tuning` ON A TRACK, DELIBERATELY. `validateNote` bounds `string` by
 * `t.tuning?.length ?? 6` and the mapper does the same, so every part in this
 * document is range-checked against a six-string neck whatever it is played on.
 * The bound that actually holds is `reviewTrack`'s, which counts the strings of
 * the part's OWN instrument and refuses before the document is ever assembled —
 * see `irTrackRun`'s header, which names this job as the caller that sends no
 * tuning. Writing one here would need a tuning accessor the seam does not export
 * and would put a second string bound in circulation with the first; if
 * `reviewTrack` ever loosens, this is the paragraph to come back to.
 *
 * ⚠ NO `ImportOptions`, so the chart's FIRST part is the primary one. The
 * mapper's default `selectedTrackId` is the first track with notes, every part
 * here has notes (`reviewTrack` refuses an empty one), and the primary track
 * sorts first among the composition's tracks and gives the composition its
 * instrument. That is the chart's own running order, which is the order the
 * model wrote the parts in — deliberate, and the reason no option is passed.
 *
 * ── THE PARTS ARE RENAMED HERE, AND THIS IS THE STEP THAT WAS MEANT TO ──────
 *
 * `reviewChart` says so itself: duplicate track names are "a later step's to
 * derive around". This is that step, and nothing after it derives anything — the
 * mapper names a composition-mode pattern `irTrack.name` with no fallback and
 * names the composition's track the same, so whatever the chart wrote is what
 * the library gets. Two consequences, both silent:
 *   - TWO PARTS CALLED "Guitar" is how a person names a chart, and it produces
 *     two patterns and two tracks with one name between them. Every control in a
 *     track header builds its accessible name out of that name ("Mute Guitar",
 *     "Move Guitar up"), which is why `compositionService.nextTrackName` exists
 *     at all — and the import path goes nowhere near it.
 *   - A BLANK NAME passes the grammar (`minLength: 1` admits `" "`) and would
 *     otherwise end the whole job: `trackRunInput` refuses a part with no name,
 *     and a refused part refuses the job. Losing an arrangement to a stray space
 *     is not a decision anybody made.
 * So {@link partNames} renames the parts ONCE, before the first run, and the
 * renamed parts are what everything downstream reads — the briefs, the document,
 * the transcript sections, the progress events and the refusal. See it for the
 * two rules; neither invents anything the chart did not say.
 *
 * ── WHAT A ONE-PART CHART PRODUCES ──────────────────────────────────────────
 *
 * A pattern, and `compositionId: null`. `reviewChart` deliberately allows a
 * one-part chart, the mapper deliberately calls that `single-pattern`, and no
 * `topology` is forced here — forcing `'composition'` would build a composition
 * of one lane that nobody asked for. The outcome carries `documents.topology`
 * and `documents.compositionId`, so a caller that needs to say which it got can.
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
 *
 *   - It takes no undo bracket and no job lock. The import is not an edit to the
 *     open document — it creates new rows and repoints the store — so there is
 *     nothing to bracket; `importIR`'s own header lists the four pieces of
 *     `compositionService` state a caller with both seams in scope must clear
 *     afterwards, and that caller is the panel, not this.
 *   - So it does none of what its ONE caller does around it.
 *     `CompositionCommandPanel` runs this for the row that declares
 *     `route: 'ir-job'` (`commandTypes`), and it is the panel that holds both
 *     seams: it takes the job lock for the minutes this runs, performs the four
 *     cleanups above when the import comes back, and renders the progress events
 *     below as phases. Nothing here should acquire any of that — a lock taken in
 *     both places is one that outlives the run that took it.
 */
import { PPQ, importIR } from '../patterns/patternService';
import { runAgentTask } from './agentService';
import { runArrangementChart } from './arrangementChart';
import { IR_TIME_SIGNATURE, TICKS_PER_BAR, runIRTrack } from './irTrackRun';
import { beginJobTranscript } from './runTranscript';
import type { AgentEvent, AgentRunSummary, AgentSpec, RunAgentTaskOptions } from './agentService';
import type { ArrangementChart, ChartTrack } from './arrangementChart';
import type { IRTrack, TrackBrief, TrackRunOutcome } from './irTrackRun';
import type { ImportedDocuments, Result } from '../patterns/patternService';

// -------------------------------------------------------------- the shape ---

/**
 * The document this job assembles, declared STRUCTURALLY.
 *
 * ⚠ `src/ai/**` MAY NOT IMPORT `@fretwork/lib` — a tripwire test in
 * `tests/AgentTools.test.ts` fails any file that does, and `ImportIR` lives
 * there. So the shape is written out and the agreement is checked where the
 * document crosses the seam: {@link IrCompositionJobDeps.importDocument} is
 * `typeof importIR`, which takes an `ImportIR`, so a document this module builds
 * that does not fit stops the COMPILE at the call site rather than at run time.
 *
 * ⚠ THAT CHECK IS ONLY WORTH ANYTHING IF IT PASSES FOR A GOOD DOCUMENT, which
 * is why the narrowing here is what it is — the same rule `irTrackRun`'s
 * {@link IRTrack} states at its own address:
 *   - the ARRAYS are mutable, because the lib's are and a `readonly` array is
 *     not assignable to one. The PROPERTIES are readonly, which costs nothing:
 *     a readonly property is assignable to a mutable one.
 *   - `sourceFormat` is the literal rather than `string`, because the lib's
 *     `SourceFormat` is a union.
 *   - `keySignatures` and `sections` are `never[]` rather than a shape, because
 *     they are always empty and saying so is more honest than declaring a type
 *     for entries this module will not write. See the header for why.
 * A shape that failed to compile for every input would teach the next author to
 * write `as ImportIR`, which throws the real check away.
 */
interface IRDocument {
  readonly meta: {
    readonly title: string;
    readonly sourceFormat: 'ascii-tab';
  };
  readonly ticksPerQuarter: number;
  readonly totalTicks: number;
  readonly tempos: { readonly atTick: number; readonly bpm: number; readonly interpolation: 'step' }[];
  readonly timeSignatures: {
    readonly atTick: number;
    readonly numerator: number;
    readonly denominator: number;
  }[];
  readonly keySignatures: never[];
  readonly sections: never[];
  readonly tracks: IRTrack[];
}

// ------------------------------------------------------------------ report ---

/**
 * Why a job stopped short. TYPED rather than left to the sentence, because the
 * repairs are different and a caller that has to say what to do next should not
 * have to read English to tell them apart. A cancel above all is not a failure
 * and must not be reported as one.
 */
export type IrCompositionJobStop =
  /** The signal aborted — before the chart, between two parts, or in flight. */
  | 'cancelled'
  /** The chart run produced no usable chart: nothing configured, a dead
   *  provider, a run that ended in error, an answer that is not a chart, or a
   *  chart `reviewChart` refused. `runArrangementChart` collapses all five into
   *  one refusal, in its own sentences. */
  | 'chart-failed'
  /** Too few parts survived to import anything. Fewer than TWO parts came back
   *  usable after their retries, so there is no composition to make — see the
   *  header on the floor. The reason names every part that failed and why. */
  | 'track-failed'
  /** Every part was written and the document was still refused by the import
   *  pipeline. Nothing was created. */
  | 'import-refused'
  /** A step threw. Nothing here is meant to: every failure above is RETURNED,
   *  and this exists so a bug in one of them ends the job with a closed
   *  transcript and a sentence rather than a rejected promise the caller has to
   *  guess at. */
  | 'job-error';

/**
 * A part the chart named that is NOT in the imported piece — see the header on
 * why a job can now finish with one of these and still be `ok`.
 */
export interface MissingPart {
  /** 1-based, the same number `track.started` and `track.finished` carried. */
  readonly index: number;
  /** The name it was filed under — {@link partNames}' derived one, which is what
   *  every other account of this job says too. */
  readonly name: string;
  /** `runIRTrack`'s own sentence about its LAST attempt, unedited — the second
   *  where the part was asked again, the first where it was not, because only a
   *  review refusal is retried and the other three stops never get a second. */
  readonly reason: string;
}

/** What a finished job hands back. */
export interface IrCompositionJobResult {
  /** The chart every part was written against — carried so a caller can report
   *  the form, the tempo and the changes without re-deriving them from the
   *  patterns. */
  readonly chart: ArrangementChart;
  /** What the import put in the library: the pattern ids, the composition id
   *  (null for a one-part chart — see the header), the topology, and every
   *  warning the pipeline produced.
   *
   *  ⚠ `warnings` CARRIES THIS JOB'S OWN SENTENCES TOO, appended after the
   *  pipeline's: one per entry of {@link missing}. That is the channel the panel
   *  already prints verbatim on a success, and a part absent from the piece is
   *  exactly what a user reading warnings needs to be told. */
  readonly documents: ImportedDocuments;
  /**
   * The parts the chart named that are not in the piece. EMPTY on a job that
   * wrote everything, which is the only shape that reads as a clean success.
   *
   * Structural as well as in `documents.warnings`, because a caller cannot tell
   * our sentence from the validator's once both are strings in one array — and
   * "is this the arrangement that was asked for" is a yes/no a report should not
   * have to answer by reading English.
   */
  readonly missing: readonly MissingPart[];
  /** The whole job's log, as ONE artifact — see `runTranscript`. Also emitted on
   *  `job.started`, because the log of a job that hung is wanted while it is
   *  still hanging. */
  readonly transcriptId: string;
}

/**
 * `Result`-shaped, plus the discriminant. A caller that only reads `ok` and
 * `reason` works unchanged; one that has to word a report differently for a
 * cancel reads {@link IrCompositionJobOutcome.stopped}.
 */
export type IrCompositionJobOutcome =
  | { readonly ok: true; readonly value: IrCompositionJobResult }
  | { readonly ok: false; readonly stopped: IrCompositionJobStop; readonly reason: string };

// ---------------------------------------------------------------- progress ---

/**
 * What the job is doing, as it does it.
 *
 * ⚠ EMITTED RATHER THAN INFERRED. A panel reading phases out of tool names
 * cannot say "part 2 of 3" because nothing tells it there are three, and these
 * runs have no tools at all to read. The job knows, so it says so.
 *
 * Shaped like `AgentEvent`, whose shape `runAgentTask` establishes: a union
 * discriminated on `type`, one callback, every event delivered whether anything
 * is listening or not.
 *
 * ⚠ A `started` CARRIES NO TRANSCRIPT ID and its `finished` carries one, which
 * is not an oversight: the section is opened by the run itself, at the moment
 * the model is actually called, and a part whose brief refused never opens one.
 * Emitting `track.started` before that is what makes the index/count sequence
 * complete — a panel counting parts must see one per part, including the part
 * that never reached a model. The job's own transcript id, on `job.started`,
 * resolves to a record the sections nest inside.
 */
export type IrCompositionJobEvent =
  /**
   * First, and before anything runs: it carries the transcript id, which a
   * panel needs while the job is still going.
   *
   * ⚠ ONE EXCEPTION, and it is the only one: a job whose signal was ALREADY
   * aborted emits `job.finished` and nothing else. There is no transcript id to
   * carry — the log is deliberately not opened for a job that never ran, so it
   * cannot evict one of the buffer's five entries — and inventing one would
   * hand a panel an id that resolves to nothing. A consumer therefore keys its
   * teardown off `job.finished`, which always arrives, rather than off a
   * `started` it may never have seen.
   */
  | { readonly type: 'job.started'; readonly transcriptId: string }
  | { readonly type: 'chart.started' }
  /** Success only — the payload IS the chart. A chart run that failed is
   *  reported by `job.finished`, which carries the reason. */
  | {
      readonly type: 'chart.finished';
      readonly chart: ArrangementChart;
      readonly runTranscriptId?: string;
    }
  | {
      readonly type: 'track.started';
      /** 1-based, so `index` of `count` reads as a person would say it. */
      readonly index: number;
      readonly count: number;
      readonly track: ChartTrack;
    }
  /**
   * Emitted for a part that failed as well as one that was written — `ok` says
   * which, and `reason` is `runIRTrack`'s own sentence.
   *
   * ⚠ ONE PER PART, NOT ONE PER RUN. A part that was refused and then asked
   * again emits this once, when the SECOND answer has been reviewed, carrying
   * that attempt's verdict, sentence and transcript section. A panel counting
   * parts sees one `started` and one `finished` for each, whatever it cost.
   *
   * A failed part no longer ends the job — the parts that worked are still
   * imported when two or more of them did — so this event is how a panel marks
   * the part that is missing from a piece that was otherwise built.
   *
   * ⚠ A CANCELLED PART HAS NO `track.finished`, and that is deliberate rather
   * than a missing case: `ok: false` here means the model wrote something
   * unusable, and reporting the user's own stop in the same field would put a
   * failure mark against a part nobody claims is wrong. So a cancel leaves the
   * last `track.started` unpaired, and the `job.finished` that follows it
   * immediately carries `stopped: 'cancelled'` — which is what a panel clears
   * the in-flight part on.
   */
  | {
      readonly type: 'track.finished';
      readonly index: number;
      readonly count: number;
      readonly track: ChartTrack;
      readonly ok: boolean;
      readonly reason?: string;
      readonly runTranscriptId?: string;
    }
  /** The one step that writes. `trackCount` is what is about to be committed. */
  | { readonly type: 'import.started'; readonly trackCount: number }
  | { readonly type: 'import.finished'; readonly documents: ImportedDocuments }
  | {
      readonly type: 'job.finished';
      readonly ok: boolean;
      readonly stopped?: IrCompositionJobStop;
      readonly reason?: string;
    };

// -------------------------------------------------------------------- deps ---

/** The model call, exactly as `runAgentTask` gives it — and exactly as
 *  `ChartRunDeps` and `TrackRunDeps` take it, so one function satisfies all
 *  three without a wrapper of its own. */
export type RunTask = (
  spec: AgentSpec,
  input: string,
  options?: RunAgentTaskOptions,
) => Promise<Result<AgentRunSummary>>;

/**
 * Everything the job reaches OUTSIDE itself, in one injectable bundle.
 *
 * The point is the tests: the order of the steps, the cancellation checks, the
 * envelope this module builds and what happens to a part that fails are the
 * whole of what this file does, and none of it should need a model, a provider
 * or a library to assert. `tests/IrCompositionJob.test.ts` drives both of these
 * with fakes.
 *
 * ⚠ NOT a general extension point. {@link IR_COMPOSITION_JOB_DEPS} is what
 * ships, and a caller passing its own is a test.
 */
export interface IrCompositionJobDeps {
  readonly runTask: RunTask;
  /**
   * The seam's import, and the reason this dep is spelled `typeof importIR`
   * rather than with a hand-written signature: it is what makes
   * {@link IRDocument} structurally checked against the lib's `ImportIR` at
   * compile time, without this module naming a lib type it is forbidden to
   * import.
   */
  readonly importDocument: typeof importIR;
}

/** What ships. Split out so a test can override ONE of them and keep the other
 *  real if it wants to. */
export const IR_COMPOSITION_JOB_DEPS: IrCompositionJobDeps = {
  runTask: runAgentTask,
  importDocument: importIR,
};

// ------------------------------------------------------------------ pieces ---

/** The label the job's transcript is filed under, and the one a panel shows. */
const JOB_LABEL = 'Compose';

/** How much of the request becomes the composition's name before it is cut. A
 *  library row is read at a glance; the validator's own cap is 500 characters,
 *  which is a paragraph in a list of names. */
const MAX_TITLE = 60;

/**
 * The request as a name for the piece — see the header on why `meta.title` is
 * not optional in practice.
 *
 * First LINE, because a multi-line request is a brief whose second paragraph is
 * not a title. Truncation is marked, because a name silently cut at 60
 * characters reads as a name somebody chose.
 *
 * Never blank: `runArrangementChart` refuses an empty request before this is
 * reached, so by the time a document is built the first line has something in it.
 */
function documentTitle(request: string): string {
  const firstLine = request.trim().split('\n')[0].trim();
  return firstLine.length > MAX_TITLE ? `${firstLine.slice(0, MAX_TITLE).trimEnd()}…` : firstLine;
}

/**
 * How many usable parts the mapper needs before it makes a COMPOSITION rather
 * than a loose pattern — `> 1` non-empty tracks, its own rule, pinned in
 * tests/ImportIR.test.ts. Named here because it is the floor the header argues
 * from, and a number nobody can read as a preference.
 */
const MIN_PARTS_FOR_A_COMPOSITION = 2;

/** One part that failed both of its attempts, as a sentence — the same words
 *  whether it ends up in a refusal or in the warnings of a piece that was built
 *  without it. `runIRTrack`'s own account, unedited; what is added is the part's
 *  place in the job, which only this module knows. */
const missingPartLine = (missing: MissingPart, count: number): string =>
  `"${missing.name}" — part ${missing.index} of ${count} — could not be written, and it is missing from this arrangement. ${missing.reason}`;

/**
 * Why a job that lost parts has nothing to import.
 *
 * Said in the mapper's own terms rather than as a generic failure, because the
 * two cases fail for different reasons and only one of them is about the count:
 * with nothing written there is no music at all, and with one part written there
 * IS music but no composition to put it in — see the header on the floor.
 */
const tooFewParts = (survived: number, count: number): string => {
  if (survived === 0) {
    return count === 1
      ? 'The one part this arrangement names could not be written, so nothing was imported.'
      : `Not one of the ${count} parts could be written, so nothing was imported.`;
  }
  return `Only 1 of the ${count} parts could be written. A composition is made of two or more parts — one on its own imports as a loose pattern rather than as the arrangement that was asked for — so nothing was imported and the part already written was not kept.`;
};

/**
 * A display name per part, in the chart's order — see the header on why this is
 * this module's job and nobody else's.
 *
 * Two rules, and neither invents anything the chart did not say:
 *   - a name that is blank once trimmed becomes `Track N` at its 1-based
 *     position. The same shape the validator's own fallback uses, and the same
 *     one `compositionService.nextTrackName` hands a new lane, so an imported
 *     nameless part is indistinguishable from one added by hand.
 *   - a repeat is suffixed with the FIRST UNUSED number — "Guitar", "Guitar 2",
 *     "Guitar 3". In the SPIRIT of `compositionService.nextTrackName` rather than
 *     lifted from it: that function is unexported, takes live `Track[]` and only
 *     ever produces `Track ${n}`, so this is a second rule and says so.
 * The chart's own name is otherwise untouched: it is the model's word for the
 * part and the only one the user will recognise.
 *
 * ⚠ TWO PASSES, AND THE FIRST ONE IS WHY A DERIVED NAME CANNOT DISPLACE A GIVEN
 * ONE. Counting only the names derived SO FAR, a chart of "Guitar", "Guitar",
 * "Guitar 2" renames the second part to "Guitar 2" — which is the third part's
 * OWN name, taken off it, so the collision is pushed one place along rather than
 * resolved. So every name the chart actually wrote is collected first, and a
 * derived name may land on none of them; a part keeps the name it was given
 * unless an EARLIER part already took it.
 *
 * ⚠ COMPARED CASE-INSENSITIVELY, for the reason the derivation exists at all: a
 * screen reader announcing "Mute Guitar" and "Mute guitar" has said the same
 * thing twice. The name a part is FILED under is the chart's own casing — only
 * the collision test is folded.
 */
function partNames(tracks: readonly ChartTrack[]): ChartTrack[] {
  const key = (name: string): string => name.toLowerCase();
  const given = new Set(
    tracks.map((track) => key(track.name.trim())).filter((name) => name !== ''),
  );
  const taken = new Set<string>();
  return tracks.map((track, position) => {
    const written = track.name.trim();
    const base = written === '' ? `Track ${position + 1}` : written;
    let name = base;
    let n = 2;
    // `name !== written` is what lets a part keep its own name: the exemption is
    // for the name the CHART gave this part, never for one derived here.
    while (taken.has(key(name)) || (name !== written && given.has(key(name)))) {
      name = `${base} ${n}`;
      n++;
    }
    taken.add(key(name));
    // The whole part, renamed — so the brief, the document, the transcript
    // section, the progress events and the refusal all say ONE name. A panel
    // showing the chart's word for a part the library filed under another is the
    // kind of drift this area keeps paying for.
    return { ...track, name };
  });
}

/** One part's brief, from the chart. Structural rather than mapped: `name`,
 *  `instrumentId` and `role` ARE a `ChartTrack` and `bars`/`chords` are the
 *  chart's own, which is what `TrackBrief` was shaped for. The ID is the only
 *  thing added, and it is the caller's precisely because a model must never be
 *  asked to keep one unique — as, after {@link partNames}, is the name. */
const briefFor = (track: ChartTrack, index: number, chart: ArrangementChart): TrackBrief => ({
  id: `track-${index}`,
  name: track.name,
  instrumentId: track.instrumentId,
  role: track.role,
  bars: chart.bars,
  chords: chart.chords,
});

// --------------------------------------------------------------------- run ---

export interface IrCompositionJobOptions {
  /** ONE signal for the whole job — see the header. */
  readonly signal?: AbortSignal;
  /** Progress, as the job makes it. Never required; the job always emits. */
  readonly onProgress?: (event: IrCompositionJobEvent) => void;
  /**
   * The raw harness events of every run, for a caller that wants live output.
   * The transcript is recorded whether this is passed or not — it is fed FIRST,
   * so a view that throws cannot cost the log an event.
   */
  readonly onEvent?: (event: AgentEvent) => void;
  /** What the job is called in the transcript and in a panel. */
  readonly label?: string;
  /** Test seam. See {@link IrCompositionJobDeps} — a caller passing this is a
   *  test. */
  readonly deps?: Partial<IrCompositionJobDeps>;
}

const stop = (stopped: IrCompositionJobStop, reason: string): IrCompositionJobOutcome => ({
  ok: false,
  stopped,
  reason,
});

/**
 * RUN THE WHOLE THING: chart, a part at a time, import.
 *
 * `request` is what the user asked for, in their own words. It goes to the chart
 * run and to the composition's name, and nowhere else — the parts are briefed
 * from the CHART, deliberately, because "walking bass, quarter notes, over these
 * changes" is a brief narrow enough to be hard to fill with generic material,
 * and handing the original request down beside it would put the whole job back
 * inside one call, which is what this exists to stop.
 *
 * Returns a refusal for anything that stopped it, and `ok` only for a job that
 * imported. Read the header before adding a retry, a per-part fallback or a
 * forced topology: none of the three is missing by accident.
 */
export async function runIrCompositionJob(
  request: string,
  options: IrCompositionJobOptions = {},
): Promise<IrCompositionJobOutcome> {
  const deps: IrCompositionJobDeps = { ...IR_COMPOSITION_JOB_DEPS, ...options.deps };
  const signal = options.signal;
  const label = options.label ?? JOB_LABEL;

  const emit = (event: IrCompositionJobEvent): void => {
    try {
      options.onProgress?.(event);
    } catch {
      /* a view's throw is not the job's problem — `runAgentTask` says the same */
    }
  };
  const relay = (event: AgentEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      /* likewise */
    }
  };

  // ⚠ BEFORE THE TRANSCRIPT EXISTS. A job cancelled before it started has
  // nothing to log, and registering it anyway would spend one of the buffer's
  // five slots evicting the log somebody is most likely on their way to read.
  if (signal?.aborted) {
    const reason = 'The job was cancelled before it started. Nothing was written.';
    emit({ type: 'job.finished', ok: false, stopped: 'cancelled', reason });
    return stop('cancelled', reason);
  }

  const job = beginJobTranscript({
    page: 'composition',
    command: label,
    agent: 'ir-composition-job',
    input: request,
  });

  /**
   * Every exit goes through here, so the transcript is closed and the caller is
   * told in one place.
   *
   * Guarded against a second call: the `catch` below is reachable from anywhere,
   * including from inside a transcript listener that threw during this very
   * function, and a job closed twice would have the first account of itself
   * overwritten by the second.
   */
  let closed = false;
  const finish = (outcome: IrCompositionJobOutcome, content = ''): IrCompositionJobOutcome => {
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

  const cancelled = (where: string): IrCompositionJobOutcome =>
    finish(stop('cancelled', `The job was cancelled ${where}. Nothing was written.`));

  /**
   * ONE run, recorded.
   *
   * The section is opened HERE rather than by the caller because this is the
   * only place that has what a section needs: the spec's own prompt and the
   * exact input the model was given. `runIRTrack` builds that input internally
   * from the brief, and rebuilding it out here to log it would be the same
   * string derived twice — the thing this area keeps paying for.
   *
   * It also means a run that never happened has no section, which is the honest
   * record: a brief `trackRunInput` refused never reached a model.
   */
  const recorded =
    (command: string, onStarted: (transcriptId: string) => void): RunTask =>
    async (spec, input, runOptions) => {
      const section = job.beginRun({
        command,
        agent: spec.name,
        systemPrompt: spec.systemPrompt,
        input,
      });
      onStarted(section.id);
      // ⚠ EVERY OPENED SECTION IS CLOSED, including one whose run THREW. An
      // unfinished section is this log format's signal for "the run hung here",
      // so a seam that rejected would be filed as a hang — a wrong answer to the
      // one question the transcript is read to answer.
      let result: Result<AgentRunSummary>;
      try {
        result = await deps.runTask(spec, input, {
          ...runOptions,
          onEvent: (event) => {
            // The log FIRST, then the view — see `onEvent` above.
            section.record(event);
            relay(event);
          },
        });
      } catch (error) {
        section.finish({ error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      section.finish(
        result.ok
          ? { stoppedReason: result.value.stoppedReason, content: result.value.content }
          : { error: result.reason },
      );
      return result;
    };

  emit({ type: 'job.started', transcriptId: job.id });

  // ⚠ EVERY FAILURE BELOW IS RETURNED, NOT THROWN — this catches the ones that
  // are bugs. A throw out of a consumer's callback, out of the seam or out of
  // the narrowing would otherwise reject the promise with the transcript left
  // open, which reads in the buffer as a job that is still running and leaves
  // the caller with no sentence to show.
  try {
    // --------------------------------------------------------- 1. the chart ---

    emit({ type: 'chart.started' });
    let chartRunId: string | undefined;
    const chart = await runArrangementChart(request, {
      ...(signal ? { signal } : {}),
      deps: {
        runTask: recorded(`${label} — chart`, (id) => {
          chartRunId = id;
        }),
      },
    });

    // The abort is read BEFORE the result: a cancelled run comes back `ok` with
    // `stoppedReason: 'aborted'` and no structure, which `runArrangementChart`
    // turns into "no usable chart" — blaming the model for the user's own click.
    if (signal?.aborted) return cancelled('while it was writing the chart');
    if (!chart.ok) return finish(stop('chart-failed', chart.reason));
    emit({
      type: 'chart.finished',
      chart: chart.value,
      ...(chartRunId === undefined ? {} : { runTranscriptId: chartRunId }),
    });

    // --------------------------------------------------------- 2. the parts ---

    // Renamed here and read nowhere else afterwards — see the header. The chart
    // handed back to the caller keeps the model's own names, because it is the
    // record of what the model said.
    const parts = partNames(chart.value.tracks);
    const count = parts.length;
    const tracks: IRTrack[] = [];
    const missing: MissingPart[] = [];

    /**
     * ONE attempt at one part, recorded under its own transcript section.
     *
     * The section's command names the ATTEMPT, not just the part: two sections
     * called "Compose — Guitar 2" in one log are two runs nobody can tell apart,
     * and which of them the imported part came from is the first thing a reader
     * of that log wants.
     */
    const attempt = async (
      part: ChartTrack,
      index: number,
      previousRefusal?: string,
    ): Promise<{ readonly outcome: TrackRunOutcome; readonly runTranscriptId?: string }> => {
      let runId: string | undefined;
      const outcome = await runIRTrack(briefFor(part, index, chart.value), {
        ...(signal ? { signal } : {}),
        ...(previousRefusal === undefined ? {} : { previousRefusal }),
        deps: {
          runTask: recorded(
            previousRefusal === undefined
              ? `${label} — ${part.name}`
              : `${label} — ${part.name} (second attempt)`,
            (id) => {
              runId = id;
            },
          ),
        },
      });
      return { outcome, ...(runId === undefined ? {} : { runTranscriptId: runId }) };
    };

    for (const [position, part] of parts.entries()) {
      // ⚠ BEFORE THE RUN, not only inside it: this is the check that stops a job
      // the user abandoned between two parts from going on to import.
      if (signal?.aborted) {
        return cancelled(
          position === 0
            ? 'before the first part was written'
            : `after ${position} of ${count} parts`,
        );
      }

      const index = position + 1;
      const where = `"${part.name}", part ${index} of ${count}`;
      emit({ type: 'track.started', index, count, track: part });

      let written = await attempt(part, index);
      if (signal?.aborted) return cancelled(`while it was writing ${where}`);

      // ── THE ONE RETRY ─────────────────────────────────────────────────────
      // Only for a review refusal, never chained, and only ever here — see the
      // header. The refusal goes back as an addendum to the SAME brief, which
      // `irTrackRun` owns; this module chooses when, not what to say.
      if (!written.outcome.ok && written.outcome.stopped === 'review') {
        written = await attempt(part, index, written.outcome.reason);
        // Read again between the two: the second run is where the user's stop
        // most often lands now, and a cancel reported as a bad part blames the
        // model for a click.
        if (signal?.aborted) return cancelled(`while it was writing ${where} a second time`);
      }

      const runTranscriptId =
        written.runTranscriptId === undefined ? {} : { runTranscriptId: written.runTranscriptId };

      if (!written.outcome.ok) {
        // ⚠ THE JOB GOES ON. The part is recorded as missing and the next one is
        // written; what happens to a piece that lost a part is decided once,
        // below, when it is known how many survived.
        //
        // Reported on the event stream AND kept for the report, because they are
        // read by different people at different times — the panel marks the part
        // that failed, and the sentence is what somebody pastes into a bug
        // report. `runIRTrack`'s own words, unedited: a second account of one
        // mistake is what this codebase keeps paying for.
        emit({
          type: 'track.finished',
          index,
          count,
          track: part,
          ok: false,
          reason: written.outcome.reason,
          ...runTranscriptId,
        });
        missing.push({ index, name: part.name, reason: written.outcome.reason });
        continue;
      }
      emit({ type: 'track.finished', index, count, track: part, ok: true, ...runTranscriptId });
      tracks.push(written.outcome.value);
    }

    // -------------------------------------------------------- 3. the import ---

    // ⚠ THE FLOOR, AND ONLY WHERE SOMETHING WAS LOST. A one-part chart that wrote
    // its one part is a `single-pattern` import and always was; this is about a
    // piece that came back short, where one surviving track is not a composition
    // at all — see the header.
    if (missing.length > 0 && tracks.length < MIN_PARTS_FOR_A_COMPOSITION) {
      return finish(
        stop(
          'track-failed',
          [
            tooFewParts(tracks.length, count),
            ...missing.map((part) => missingPartLine(part, count)),
          ].join(' '),
        ),
      );
    }

    // ⚠ THE LAST CHECK. `importDocument` is one `commitImport` and cannot be
    // interrupted, so after this line the job is committed — see the header.
    if (signal?.aborted) {
      return cancelled(
        missing.length === 0
          ? `with all ${count} parts written`
          : `with ${tracks.length} of ${count} parts written`,
      );
    }

    const document: IRDocument = {
      meta: { title: documentTitle(request), sourceFormat: 'ascii-tab' },
      // The project's own resolution, so the document passes through the
      // mapper's rescaling unscaled — and the same constant `TICKS_PER_BAR` is
      // derived from, which is what every brief quoted to the model.
      ticksPerQuarter: PPQ,
      totalTicks: chart.value.bars * TICKS_PER_BAR,
      tempos: [{ atTick: 0, bpm: chart.value.bpm, interpolation: 'step' }],
      timeSignatures: [{ atTick: 0, ...IR_TIME_SIGNATURE }],
      // Empty because the keys are required, not because there was nothing to
      // say — see the header on all three.
      keySignatures: [],
      sections: [],
      tracks,
    };

    emit({ type: 'import.started', trackCount: tracks.length });
    const imported = deps.importDocument(document);
    if (!imported.ok) return finish(stop('import-refused', imported.reason));

    // ⚠ THE MISSING PARTS GO IN `warnings`, AFTER THE PIPELINE'S OWN. That is the
    // channel a success already has for "what is not in what you just got", and
    // it is the one the panel prints verbatim — see the header. Appended rather
    // than prepended so the pipeline's account of its own document is not pushed
    // down a list by ours.
    const documents: ImportedDocuments =
      missing.length === 0
        ? imported.value
        : {
            ...imported.value,
            warnings: [
              ...imported.value.warnings,
              ...missing.map((part) => missingPartLine(part, count)),
            ],
          };
    emit({ type: 'import.finished', documents });

    return finish(
      { ok: true, value: { chart: chart.value, documents, missing, transcriptId: job.id } },
      // ⚠ THE WARNINGS GO IN THE LOG, not only on the returned value. They are
      // the pipeline's account of what it DROPPED and what it approximated —
      // silent clamps, dropped events, notes on strings the instrument hasn't
      // got — plus this job's own account of any part that is not there at all,
      // and the log is the artifact that gets exported and pasted into a bug
      // report. A caller may or may not render them; the log always has them.
      [
        `Imported ${documents.patternIds.length} pattern${
          documents.patternIds.length === 1 ? '' : 's'
        } as ${documents.topology}${
          missing.length === 0 ? '' : `, ${missing.length} of ${count} parts missing`
        }.`,
        ...documents.warnings,
      ].join('\n'),
    );
  } catch (error) {
    return finish(
      stop(
        'job-error',
        `The job stopped on an unexpected error and nothing was imported: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
  }
}
