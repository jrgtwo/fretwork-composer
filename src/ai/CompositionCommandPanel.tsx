import { useEffect, useRef, useState } from 'react';
import { commandsForPage } from './commandCatalog';
import { COMMAND_BUTTON, SlotFields } from './commandSlots';
import { defaultValues, fillForNow } from './slotSources';
import type { Command, SlotValue } from './commandTypes';
import { COMPOSITION_AGENT, COMPOSITION_WRITE_TOOLS } from './compositionAgent';
import { PATTERN_AGENT, PATTERN_WRITE_TOOLS } from './patternAgent';
import { runAgentTask, type AgentEvent, type AgentSpec } from './agentService';
import { beginTranscript } from './runTranscript';
import { RunTranscriptControl } from './RunTranscriptControl';
import { isConfigured } from './connectorSettings';
import { useConnectorSettings } from './connectorView';
import { runIrCompositionJob } from './irCompositionJob';
import {
  MAX_COMPOSITION_TRACKS,
  abortEditGesture,
  beginJob,
  clearHistory as clearCompositionHistory,
  closePlacementEditing,
  endJob,
  selectPlacements,
  selectTrack,
  beginEditGesture as beginCompositionGesture,
  endEditGesture as endCompositionGesture,
  useEditingComposition,
  useEditingPlacementId,
} from '../composition/compositionService';
import {
  beginEditGesture as beginPatternGesture,
  endEditGesture as endPatternGesture,
  useEditingPattern,
} from '../patterns/patternService';
import type { ArrangementMode } from '../composition/arrangementMath';
import type { ArrangementChart } from './arrangementChart';
import type { IrCompositionJobEvent, IrCompositionJobStop } from './irCompositionJob';
import type { ImportedDocuments } from '../patterns/patternService';

/**
 * The composition page's command panel — a generation JOB, not an edit (AG-07).
 *
 * Its slot half is `./commandSlots`, shared with the pattern page's panel. Its
 * run half is here and is deliberately not shared, because every one of the five
 * things a run does differs: which agent drives it, which seam's history it
 * brackets, whether the document is LOCKED for the duration, whether a failure
 * ROLLS BACK, and how long it is allowed to take. See `commandSlots`' header.
 *
 * ── ONE PANEL, THREE MODES, AND THE RUN READS NONE OF THEM ──────────────────
 *
 * `mode` decides the LIST — pattern and voice mode offer the composition page's
 * rows, edit mode offers the pattern page's six, because
 * `openPlacementForEditing` aims the lib's single pattern-editing pointer at the
 * block and `patternService` routes writes to that placement's snapshot (see
 * `Command.mode`). Nothing else here looks at it.
 *
 * The run's progress, its tool trace, its Cancel button and its outcome
 * therefore live OUTSIDE the selected-command block, and survive a mode change
 * untouched — rendering them inside the form would take them with the list,
 * since `selected` is looked up in the mode's own array. The run also names the
 * command it is running, because after a mode switch the form that started it
 * may not be on screen.
 *
 * ⚠ MID-RUN, THAT IS DEFENCE AND NOT THE LIVE PATH, and an earlier draft of this
 * note overstated it. `CompositionPage` disables the mode bar for the duration
 * of a job (`useIsJobRunning`) and `mode` reaches this panel from nowhere else,
 * so a mode change WHILE a run is in flight is currently unreachable in the app;
 * the disable is what protects edit mode's pointer, and it is the stronger of
 * the two guards. What is reachable, and what this structure buys today, is the
 * FINISHED run: its outcome, its refusals and its tool trace stay on screen
 * after the lock is released and the user goes to look at what was built. The
 * hazard the ticket names — a control vanishing out from under the user — is
 * covered by `select` below, which is the reachable version of it: choosing
 * another command mid-run must not take Cancel with it.
 *
 * ── THE JOB LOCK, AND WHY IT WRAPS EVERY RUN ────────────────────────────────
 *
 * `beginJob()` takes the document: the user's writes are refused at the seam for
 * the duration and the agent's go through (`compositionService`). That is
 * data-loss prevention rather than tidiness — a rollback restores the whole
 * composition, so anything the user edited while they waited would be rolled
 * back WITH it.
 *
 * It is taken for EDIT-MODE runs too, which act on the pattern seam and would
 * not otherwise need it. The reason is the mode bar: `CompositionPage` closes an
 * open placement on every mode change, and a switch mid-run would repoint the
 * lib's one pattern pointer out from under the agent and land its next notes in
 * the user's LIBRARY pattern — which no rollback here restores. The lock is what
 * disables that bar (`useIsJobRunning`), so an edit-mode run needs it most.
 *
 * ⚠ BOTH BRACKETS CLOSE IN A `finally`, ON EVERY PATH. A leaked gesture wedges
 * undo for the session — a defect that has shipped in this project before — and
 * a leaked LOCK is worse: the page stays read-only until it is reloaded.
 *
 * ── TWO ROUTES, AND THE SECOND ONE DOES NOT EDIT ANYTHING ───────────────────
 *
 * Everything above is the `'single-run'` route: one tool-using agent writing
 * into the OPEN composition. A row that declares `route: 'ir-job'`
 * (`commandTypes`) runs `irCompositionJob` instead — a tool-free chart run, a
 * tool-free run per part, then one `patternService.importIR` — and the
 * difference is not how it is driven but WHAT IT PRODUCES.
 *
 * ⚠ THE IMPORT CREATES A NEW COMPOSITION. It never touches the open one. Until
 * `importIR` runs, nothing anywhere has been written; after it runs, the job is
 * over. Three things follow, and each of them is a `finally` clause that is NOT
 * there on this path:
 *
 *   - **NO GESTURE, AND NO ROLLBACK.** There is no partial edit to restore,
 *     because there was never a partial edit.
 *
 *     ⚠ AND NOTHING WOULD CATCH ONE OPENED BY HABIT, which is why the reason is
 *     written here rather than left to a test to state. `abortEditGesture`
 *     restores BY ID — `writeCompositionBack` maps the snapshot over the library
 *     row with the same id — and after the import the store is pointed at a
 *     DIFFERENT composition, so the restore would land on the document nobody is
 *     looking at and move nothing a reader of this seam can see. An earlier
 *     draft of this note claimed it would stamp the old arrangement over the new
 *     one; it would not, and a test written against that claim passes whether
 *     the bracket is there or not (tests/CompositionCommandPanel). What a
 *     bracket WOULD do is push an undo step, or a restore, for work in another
 *     document — meaningless either way. So it is not opened, and there is
 *     nothing to close.
 *   - **NOTHING TO UNDO EITHER.** `importIR` is not an undo step and says so;
 *     the way back out of an import is to delete what it made. So the panel
 *     promises no restore on this route, and the sentence under the Run button
 *     says which route the user is on.
 *   - **BUT THE LOCK IS STILL TAKEN.** Not for a rollback it does not perform:
 *     for the minutes the job runs, the mode bar has to be dead (`useIsJobRunning`
 *     is what disables it) and a second job must not start.
 *
 *     ⚠ WITH ONE KNOWN WART, and it is the lock's sentence rather than this
 *     route's: `beginJob` refuses with "No composition is open", and this panel
 *     DOES render in that state — `CompositionPage` shows its open-failure alert
 *     and keeps the rail — so a row whose whole product is a NEW composition,
 *     and which needs no open one, is refused for the want of a document it was
 *     never going to touch. Known and accepted for now — the alternative is a
 *     second gate with a sentence of its own, kept in step with the seam's by
 *     hand — but it is a misleading refusal and not a correct one.
 *
 * ⚠ AND THE PANEL CLEANS UP AFTER THE SEAM. `importIR` repoints the store at
 * what it created but "cannot clean up after the composition seam" — its own
 * header lists the four pieces of state left naming a document nobody is looking
 * at, and names the caller holding both seams as the one that must. That caller
 * is this panel; the four calls are in `startIrJob`.
 *
 * ── PHASES, NOT TOOL NAMES ──────────────────────────────────────────────────
 *
 * The `'single-run'` route's report is a scrolled list of tool names, because a
 * tool call is the only evidence that route's loop did anything. There are no
 * tools on the `'ir-job'` route at all, so there is nothing to list — the job
 * emits typed progress instead (chart, part N of M, import) and {@link JobReport}
 * renders that. The two reports are separate components on purpose: they are
 * reporting on different things, and folding them together would put a "no tools
 * called" line under a job that could not have called one.
 */

/**
 * Model round trips per run.
 *
 * The harness default is 8 and the pattern page allows 12. Sixty was MEASURED,
 * on the largest row this route then had: a backing track is a pattern per
 * chord, so a dozen patterns — open, stamp, place, three calls each — plus the
 * read, the tracks, the settings, the chord lookup and an answer at the end,
 * and a run on 2026-08-11 that did the job RIGHT hit forty exactly. Sixty left
 * room for a handful of recoveries on top of that.
 *
 * ⚠ THAT ROW HAS SINCE MOVED TO THE `'ir-job'` ROUTE, which has no round trips
 * to budget (see {@link MAX_JOB_RUNS}), so the number is now a CEILING over rows
 * that are materially smaller — `composition-extend` reads the composition,
 * authors a few patterns and places them. It is deliberately left where it is:
 * the cost of a ceiling that is too high is a dead run held for the wall clock
 * below, and the cost of one that is too low is a half-built arrangement that
 * has to be rolled back.
 *
 * Running out of them mid-arrangement is not a partial success, and it is one of
 * the things the rollback below exists to catch.
 */
const MAX_ITERS = 60;

/** How long one round trip is allowed to take, on average, before the wall
 *  clock rather than the step budget is what ends the run. Measured, not
 *  chosen: on the local llama-server this design targets, a single round trip
 *  with the whole tool set in the prompt is tens of seconds. */
const SECONDS_PER_ITER = 15;

/**
 * Outer bound on the wall clock of a single run.
 *
 * Sized for the job and not for the command. AG-06 allows 180 s, which is right
 * for one read and one batched write; a composition row is a part at a time,
 * each authored, stamped and placed — `composition-extend` writes a whole new
 * section that way.
 *
 * ⚠ DERIVED, so the two bounds cannot drift apart. It is {@link MAX_ITERS}
 * counted the other way: leaving this behind a raised step budget would make the
 * wall clock bind first and the extra steps unreachable, which is the failure
 * the budget was raised to fix — and writing the product out as a literal is how
 * that happens, because the next person to move the budget updates the number
 * and not the arithmetic.
 *
 * It is a CEILING, not a budget: an edit-mode run started from this panel gets
 * the same one and finishes in seconds. What the deadline actually bounds is how
 * long a dead provider can hold the document lock while the user waits, and
 * Cancel is mounted the whole time for anyone unwilling to wait that long.
 */
const RUN_TIMEOUT_MS = MAX_ITERS * SECONDS_PER_ITER * 1_000;

/**
 * Model runs an `'ir-job'` can make, at the very most.
 *
 * DERIVED, and derivable exactly — which is the difference from {@link MAX_ITERS}
 * and the reason the deleted orchestrator needed a ceiling of its own. The job is
 * `1 + chart.tracks.length` runs and `reviewChart` refuses a chart naming more
 * parts than a composition can hold, so the worst case is a number this file can
 * name rather than guess at.
 */
const MAX_JOB_RUNS = 1 + MAX_COMPOSITION_TRACKS;

/**
 * How long ONE of those runs is allowed to take, on average.
 *
 * Far longer than {@link SECONDS_PER_ITER}, and not for slack: a round trip there
 * is a tool call and a sentence, while a track run writes every note of a whole
 * part as one JSON object in a single generation. Those are different orders of
 * output from the same local endpoint.
 */
const SECONDS_PER_JOB_RUN = 120;

/**
 * Outer bound on the wall clock of a whole job, for {@link RUN_TIMEOUT_MS}'
 * reason and no other: what it actually bounds is how long a dead provider can
 * hold the document lock while the user waits. Cancel is mounted the whole time
 * for anyone unwilling to wait that long, and a job cancelled before the import
 * has written nothing at all.
 */
const JOB_TIMEOUT_MS = MAX_JOB_RUNS * SECONDS_PER_JOB_RUN * 1_000;

type RunView =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running';
      readonly command: string;
      readonly tools: readonly string[];
      readonly refusals: readonly string[];
      readonly transcriptId?: string;
    }
  | {
      readonly kind: 'answered';
      readonly command: string;
      readonly tools: readonly string[];
      readonly refusals: readonly string[];
      readonly content: string;
      readonly stoppedReason: string;
      readonly rolledBack: boolean;
      readonly keptPatterns: boolean;
      readonly transcriptId?: string;
    }
  /** Everything that came back `{ok:false}`, plus the three the panel decides
   *  itself: a slot that no longer fills, a job it could not take, and the
   *  deadline above. */
  | {
      readonly kind: 'refused';
      readonly command: string;
      readonly tools: readonly string[];
      readonly refusals: readonly string[];
      readonly reason: string;
      readonly rolledBack: boolean;
      readonly keptPatterns: boolean;
      /** Absent on the refusals decided BEFORE a run exists — there is no
       *  transcript of a run that never started. */
      readonly transcriptId?: string;
    };

/** A tool that returned `{ok:false, reason}` — a refusal the model was handed and
 *  may or may not have acted on. `tool.finished` carries the tool's own result,
 *  and `ok` on the EVENT means the handler did not throw, which a refusal does
 *  not. Hence the shape test rather than reading `event.ok`. */
function refusalIn(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const shape = result as { ok?: unknown; reason?: unknown };
  return shape.ok === false && typeof shape.reason === 'string' ? shape.reason : null;
}

/** The two refusals the panel decides before a run exists — a slot that no
 *  longer fills and a job it could not take. Neither has tools to report and
 *  neither wrote anything, so neither can have been rolled back. */
const refusal = (command: string, reason: string): RunView => ({
  kind: 'refused',
  command,
  tools: [],
  refusals: [],
  reason,
  rolledBack: false,
  keptPatterns: false,
});

// -------------------------------------------------------------- the ir job ---

/**
 * One part of the chart, as the panel is told about it.
 *
 * ⚠ `'running'` IS AN END STATE TOO, on one path. `irCompositionJob` emits a
 * `track.finished` for a part that failed as well as one that was written, but
 * deliberately NOT for a part the user cancelled out of — reporting somebody's
 * own click as a part the model got wrong would put a failure mark against work
 * nobody claims is bad. So a cancelled job leaves its last part `'running'` and
 * {@link JobReport} reads the job's own kind to say what became of it.
 */
interface JobPart {
  /** 1-based, as the job counts them and as a person would say it. */
  readonly index: number;
  readonly count: number;
  readonly name: string;
  readonly state: 'running' | 'written' | 'failed';
  /** `runIRTrack`'s own sentence, on a part that failed. */
  readonly reason?: string;
}

/**
 * WHAT THE JOB IS DOING, AND WHAT IT DID — the `'ir-job'` route's whole view.
 *
 * Separate state from {@link RunView} rather than a fourth `kind` on it, because
 * nothing in that type describes this route: `tools` is empty by construction,
 * `refusals` is a tool-result channel that does not exist here, and `rolledBack`
 * is a promise this route deliberately does not make. One shape carrying both
 * would be six fields that are dead on whichever half is live.
 *
 * `chart` and `documents` are held rather than summarised on arrival because the
 * report derives from BOTH: a job that came back `ok` with fewer patterns than
 * the chart named lost parts in the import, and only the pair says so.
 */
type JobView =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running' | 'done' | 'refused';
      readonly command: string;
      /**
       * Whether the job was ever handed the request.
       *
       * ⚠ Not derivable from the fields below, and the phase list depends on it:
       * a job that failed at the chart and a refusal decided BEFORE any job
       * existed — no provider, a slot that no longer fills — both have no chart
       * and no parts. Only the first has a chart phase to report on, and
       * "Chart — not written" over the second would describe a run that was
       * never asked for.
       */
      readonly started: boolean;
      /** Null until the chart run comes back; its absence IS the chart phase. */
      readonly chart: ArrangementChart | null;
      readonly parts: readonly JobPart[];
      /** True from `import.started`, so the import shows as a phase of its own
       *  rather than as a gap between the last part and the report. */
      readonly importing: boolean;
      /** Null unless the import committed. */
      readonly documents: ImportedDocuments | null;
      /** Why it stopped, on `refused`. The job's sentence, verbatim. */
      readonly reason?: string;
      /**
       * The job's own discriminant, carried so the report can word the header.
       *
       * ⚠ IT IS HERE FOR ONE VALUE: `'cancelled'`. The job types its stops
       * precisely so a caller can tell a cancel from a failure — its own doc
       * says a cancel "must not be reported as one" — and heading somebody's own
       * Cancel press REFUSED is exactly that report. Absent on the refusals the
       * panel decides itself, and deliberately absent on the DEADLINE: the job
       * hears that abort and calls it a cancel, which is true of every abort but
       * the one nobody asked for.
       */
      readonly stopped?: IrCompositionJobStop;
      readonly transcriptId?: string;
    };

/** The idle-to-refused shortcut, for the three refusals the panel decides before
 *  the job exists — a slot that no longer fills, no provider, and a lock it
 *  could not take. None of them ran anything, so there is no phase to show. */
const jobRefusal = (command: string, reason: string): JobView => ({
  kind: 'refused',
  command,
  started: false,
  chart: null,
  parts: [],
  importing: false,
  documents: null,
  reason,
});

/**
 * How many parts the chart asked for that are NOT in the imported piece.
 *
 * ⚠ THE JOB CANNOT ANSWER THIS AND THE IMPORT DOES NOT VOLUNTEER IT. A part the
 * model could not write ends the job outright, so a job that returns `ok` had
 * every part in hand — and the pipeline can still drop one after that, silently:
 * `validateImportIR` drops any note whose tick or fret is not a whole number,
 * and a track left with nothing survives as an empty one that the mapper does
 * not turn into a pattern. Nothing warns.
 *
 * The document carries no sections, so the mapper cuts exactly one pattern per
 * non-empty track (pinned in tests/ImportIR.test.ts) — which is what makes this
 * subtraction meaningful rather than a guess: `patternIds` short of
 * `chart.tracks` is parts missing from the piece, one for one.
 */
function partsMissing(chart: ArrangementChart | null, documents: ImportedDocuments | null): number {
  if (chart === null || documents === null) return 0;
  return Math.max(0, chart.tracks.length - documents.patternIds.length);
}

/**
 * Edit mode's rows: the pattern page's, less the ones that open a DIFFERENT
 * document.
 *
 * `pattern-generate` reads "Open a blank pattern, set its instrument, then stamp
 * the notes", and `openPatternForEditing` nulls `editingPlacementId` — so run
 * against a block it repoints the lib's one pattern pointer out of the block and
 * every later stamp lands in a library pattern nobody is looking at. Dropped
 * here so it is not OFFERED; `pattern_open_blank` refuses for itself while a
 * block is open, because `Command.tools` is not enforcement and a model is free
 * to reach for it from any of the other five.
 *
 * A module constant, not a filter per render: `commandsForPage` returns frozen
 * per-page arrays precisely so the list keeps its identity, and a fresh array
 * here would throw that away again.
 */
const EDIT_MODE_COMMANDS: readonly Command[] = commandsForPage('pattern').filter(
  (command) => !command.tools.includes('pattern_open_blank'),
);

export function CompositionCommandPanel({ mode }: { mode: ArrangementMode }) {
  // Edit mode is served by the PATTERN page's rows, acting on the placement the
  // lib's editing pointer is aimed at. `page` picks the agent, the tools and the
  // history; `mode` only picks what is offered — see `Command.mode`.
  const commands = mode === 'edit' ? EDIT_MODE_COMMANDS : commandsForPage('composition', mode);

  /**
   * ⚠ EDIT MODE IS NOT THE SAME AS A BLOCK BEING OPEN. Entering the mode only
   * ever CLOSES a placement (`CompositionPage`'s mode effect); one opens when a
   * lane is pressed. With none open, `patternService.writePatternBack` falls
   * through to its LIBRARY branch — so the six rows would run against whatever
   * pattern the pattern page left open, off-screen, covered by neither the
   * composition rollback nor the job lock. So they are not offered at all.
   */
  const editingPlacementId = useEditingPlacementId();
  const noBlockOpen = mode === 'edit' && editingPlacementId === null;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [values, setValues] = useState<Readonly<Record<string, SlotValue>>>({});
  const [run, setRun] = useState<RunView>({ kind: 'idle' });
  /** The `'ir-job'` route's view. Held apart from `run` for {@link JobView}'s
   *  reason; exactly one of the two is ever non-idle, because `start` clears the
   *  other before it takes either route. */
  const [job, setJob] = useState<JobView>({ kind: 'idle' });

  /** The run in flight, if any. Doubles as the re-entrancy guard, so the Run
   *  button never has to be `disabled` — disabling it under the pointer drops
   *  focus to `<body>`, which is the trap the connector dialog goes out of its
   *  way to avoid. */
  const inFlightRef = useRef<AbortController | null>(null);
  /** The live run's deadline, so an unmount can disarm it. Both routes set it;
   *  each clears it in the same `finally` that clears {@link inFlightRef}. */
  const deadlineRef = useRef<number | null>(null);
  const liveRef = useRef(true);

  const configured = isConfigured(useConnectorSettings());

  // Both subscriptions are deliberately unused values. Every choice slot's
  // DEFAULT is read off live state — the composition's key, tempo and length and
  // its track list for the composition rows, the open pattern's key and groove
  // for the edit-mode ones — so a panel that did not re-render when either
  // changed would open a command on a track that has since been renamed, or on
  // the last pattern's key.
  useEditingComposition();
  useEditingPattern();

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      // A run holds the document lock and an open gesture, so an orphaned one is
      // cancelled rather than left to finish into a component that is gone. Both
      // brackets still close: the `finally` below is not React's to unmount, and
      // with the rollback it now leaves the composition as it was rather than
      // half-built.
      inFlightRef.current?.abort();
      // And the deadline with it. An abort normally settles the run, whose
      // `finally` clears this — but a promise that never settles is precisely
      // the case the deadline exists for, and one left armed holds a timer for
      // up to eighteen minutes against a controller nothing is listening to.
      if (deadlineRef.current !== null) window.clearTimeout(deadlineRef.current);
      deadlineRef.current = null;
      // The belt to that brace, and the ONE bracket worth a second release: the
      // `finally` runs only if the harness settles its promise, and a run that
      // never comes back would leave the whole page read-only until the tab is
      // reloaded. `endJob` is idempotent and the `finally`'s `release` is gated
      // on still being the holder, so the pair cannot fight. The GESTURE has no
      // equivalent — closing it here would either push a step for work the run
      // is still doing or roll back underneath it — so it stays the `finally`'s.
      endJob();
    };
  }, []);

  const selected = commands.find((command) => command.id === selectedId) ?? null;

  const select = (command: Command) => {
    setSelectedId(command.id);
    // Seeded from live state, and only here. Re-seeding on every render would
    // undo the user's own choices between opening a command and running it.
    setValues(defaultValues(command));
    // ⚠ ONLY WHEN NOTHING IS IN FLIGHT. Clearing this unconditionally is the
    // reachable version of the failure the header names: `running` is derived
    // from `run.kind`, so one click on another row would disable Cancel while
    // the job still held the document — the mode bar dead, undo inert, every
    // user write refused, and nothing on screen saying why or offering a way
    // out. Reading the ref rather than `run.kind` because it is the run itself,
    // not the report about it, that decides.
    //
    // Deliberately NOT reset by a mode change either — only by choosing another
    // command. See the header: the run outlives the list it was started from.
    if (!inFlightRef.current) {
      setRun({ kind: 'idle' });
      setJob({ kind: 'idle' });
    }
  };

  const setValue = (id: string, value: SlotValue) =>
    setValues((was) => ({ ...was, [id]: value }));

  const cancel = () => inFlightRef.current?.abort();

  /**
   * THE `'ir-job'` ROUTE — chart, a part at a time, then one import that creates
   * a NEW composition. Read the header before adding a gesture here.
   *
   * `filled` is the command's template, filled: it is the CHART run's input and
   * the piece's name, and nothing else reads it. The parts are briefed from the
   * chart rather than from this text, which is `irCompositionJob`'s decision and
   * the reason the whole job is not one call.
   */
  const startIrJob = (label: string, input: string) => {
    // ⚠ THE LOCK, AND NOT A GESTURE. The header says why at length; the short
    // version is that this route writes nothing until the import and then is
    // over, so there is nothing to snapshot and `abortEditGesture` would restore
    // the OLD composition over the new one. What the lock buys is the minutes in
    // between: the mode bar dead, and no second job.
    const held = beginJob();
    if (!held.ok) {
      setJob(jobRefusal(label, held.reason));
      return;
    }
    const release = held.value;

    const controller = new AbortController();
    inFlightRef.current = controller;
    let timedOut = false;
    const deadline = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, JOB_TIMEOUT_MS);
    deadlineRef.current = deadline;

    // Accumulated OUTSIDE the setState callbacks, so the phase a progress event
    // reports is folded into the phases already seen rather than into whatever
    // React last rendered. `chart` in particular is read by two later events.
    let chart: ArrangementChart | null = null;
    let parts: JobPart[] = [];
    let importing = false;
    let transcriptId: string | undefined;
    /**
     * Whether the job was ever handed the request — `JobView.started`, and the
     * thing the phase list is withheld on.
     *
     * Set from `job.started` alone, which is the one event that means the runner
     * took the job (its own doc: first, before anything runs, and emitted for
     * every job but one that was cancelled before it began). A `show` that
     * hard-coded `true` would head a job runner's own throw — a rejection out of
     * `runIrCompositionJob`, which is reachable around its `try` — with
     * "Chart — not written", describing a run nobody ever asked for.
     */
    let started = false;

    const show = (
      kind: 'running' | 'done' | 'refused',
      extra: {
        readonly documents?: ImportedDocuments;
        readonly reason?: string;
        readonly stopped?: IrCompositionJobStop;
        /** Both default to what the progress events carried; the OUTCOME passes
         *  its own, because it holds the same two facts and is the account that
         *  cannot have been missed. See the success path. */
        readonly chart?: ArrangementChart;
        readonly transcriptId?: string;
      } = {},
    ): void => {
      if (!liveRef.current) return;
      const id = extra.transcriptId ?? transcriptId;
      setJob({
        kind,
        command: label,
        started,
        chart: extra.chart ?? chart,
        parts: [...parts],
        importing,
        documents: extra.documents ?? null,
        ...(extra.reason === undefined ? {} : { reason: extra.reason }),
        ...(extra.stopped === undefined ? {} : { stopped: extra.stopped }),
        ...(id === undefined ? {} : { transcriptId: id }),
      });
    };

    const onProgress = (event: IrCompositionJobEvent) => {
      switch (event.type) {
        case 'job.started':
          started = true;
          // Carried from the first event because a job that HANGS is exactly
          // when its log is wanted, and the job opens one transcript for the
          // whole of itself rather than one per run.
          transcriptId = event.transcriptId;
          break;
        case 'chart.finished':
          chart = event.chart;
          break;
        case 'track.started':
          parts = [
            ...parts,
            { index: event.index, count: event.count, name: event.track.name, state: 'running' },
          ];
          break;
        case 'track.finished':
          // Matched on the part's own index rather than on the last entry: the
          // job runs its parts one at a time today, and a report that quietly
          // depended on that would be wrong the day it does not.
          parts = parts.map((part) =>
            part.index === event.index
              ? {
                  ...part,
                  state: event.ok ? 'written' : 'failed',
                  ...(event.reason === undefined ? {} : { reason: event.reason }),
                }
              : part,
          );
          break;
        case 'import.started':
          importing = true;
          break;
        case 'job.finished':
          // ⚠ IGNORED, AND ONLY THIS ONE. It arrives just BEFORE the awaited
          // outcome, which carries the same verdict plus the documents — so
          // rendering it would repaint "Running…" over a job that has ended and
          // then correct itself a microtask later. The outcome is the one
          // account of what happened.
          return;
        default:
          // `chart.started` and `import.finished` say nothing this view does not
          // already hold: the first IS the state before any chart, and the
          // second is the outcome's `documents`.
          break;
      }
      show('running');
    };

    void (async () => {
      try {
        const outcome = await runIrCompositionJob(input, {
          signal: controller.signal,
          label,
          onProgress,
        });

        if (!outcome.ok) {
          // The deadline is not a cancel and must not read as one: the job hears
          // an abort and says the user stopped it, which is true of every abort
          // but this one. So the discriminant is dropped along with the
          // sentence — see `JobView.stopped`, which is what heads the report.
          if (timedOut && outcome.stopped === 'cancelled') {
            show('refused', {
              reason: `Gave up after ${JOB_TIMEOUT_MS / 60_000} minutes — the provider never finished. Nothing was written.`,
            });
            return;
          }
          show('refused', { reason: outcome.reason, stopped: outcome.stopped });
          return;
        }

        // ⚠ AFTER THE IMPORT, AND BEFORE ANYTHING IS RENDERED ABOUT IT. The four
        // calls `importIR`'s header requires of a caller holding both seams: it
        // repointed the store at what it created and cannot reach this seam's
        // per-composition state, all of which now names the document that WAS
        // open. Unconditional on the panel still being mounted — this is app
        // state, not view state, and an unmount does not make a stale selection
        // safe.
        closePlacementEditing();
        selectPlacements([], 'replace');
        selectTrack(null);
        // Or an undo stamps a snapshot of the previously-open composition over
        // the one the import just opened.
        clearCompositionHistory();

        // ⚠ THE CHART COMES OFF THE OUTCOME, not out of the closure the
        // `chart.finished` event filled. `partsMissing` — the whole of whether
        // this reads as "Done" or "Incomplete" — is the chart's part count
        // against the imported one, so a chart the view happened not to receive
        // would return 0 and head a short import as a clean success. The outcome
        // carries the chart every part was written against and cannot have been
        // missed. Same for the transcript id, for a smaller version of the same
        // reason: the log is offered off the account of the run, not off having
        // seen its first event.
        show('done', {
          documents: outcome.value.documents,
          chart: outcome.value.chart,
          transcriptId: outcome.value.transcriptId,
        });
      } catch (error) {
        // `runIrCompositionJob` returns every failure it knows about and catches
        // its own bugs, so arriving here is a defect — but the lock below must
        // still go back and the panel must not be left saying "Running…".
        show('refused', {
          reason: `The job could not complete: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      } finally {
        // NO GESTURE TO CLOSE AND NO ROLLBACK TO RUN — the two clauses the
        // single-run path has here. The lock is the only thing taken and the
        // only thing given back.
        release();
        window.clearTimeout(deadline);
        deadlineRef.current = null;
        inFlightRef.current = null;
      }
    })();
  };

  const start = () => {
    // Guarded here rather than with `disabled` — see `inFlightRef`.
    if (inFlightRef.current || !selected) return;
    const command = selected;
    const label = command.label;
    const irJob = command.route === 'ir-job';

    // Exactly one of the two reports is ever live — see `JobView`. Cleared
    // together rather than per branch so a refusal on one route cannot be left
    // on screen under a run on the other.
    setRun({ kind: 'idle' });
    setJob({ kind: 'idle' });

    // `fillForNow`, never `fillCommand`: the one-argument form has the live
    // allow-list composed in, so a slot holding something the app no longer
    // offers is refused here instead of being spent on a dead id by the model.
    const filled = fillForNow(command, values);
    if (!filled.ok) {
      if (irJob) setJob(jobRefusal(label, filled.reason));
      else setRun(refusal(label, filled.reason));
      return;
    }

    // Before the lock, deliberately. `runAgentTask` refuses an unconfigured
    // provider itself, but not until after this panel has taken the document,
    // opened a bracket and run the whole rollback path over a run that never
    // existed — which is a page that flickers read-only for the app's own
    // default state. Same sentence the seam would have answered with.
    if (!configured) {
      const reason =
        'No provider is configured. Open Connector and set the base URL of an OpenAI-compatible endpoint.';
      if (irJob) setJob(jobRefusal(label, reason));
      else setRun(refusal(label, reason));
      return;
    }

    if (irJob) {
      startIrJob(label, filled.value);
      return;
    }

    /**
     * `page` decides everything the run does with history.
     *
     * A composition row drives `COMPOSITION_AGENT` and brackets the COMPOSITION
     * seam, whose `abortEditGesture` can put the whole document back. An
     * edit-mode row drives `PATTERN_AGENT` and brackets the PATTERN seam, which
     * has no such thing and needs none — see the rollback note below.
     */
    const onComposition = command.page === 'composition';
    const agent: AgentSpec = onComposition ? COMPOSITION_AGENT : PATTERN_AGENT;
    const writeTools = onComposition ? COMPOSITION_WRITE_TOOLS : PATTERN_WRITE_TOOLS;

    // THE LOCK IS TAKEN FIRST, before the gesture, so a refused job leaves no
    // bracket open. The seam documents the opposite order; both work, because
    // nothing writes in between, and this one has no failure path that has to
    // remember to close something it just opened.
    // `held`, not `job`: `job` is the IR route's view state in this same scope,
    // and one function with two of them is the kind of hazard the route split
    // introduced. `startIrJob` names its lock handle the same way.
    const held = beginJob();
    if (!held.ok) {
      setRun(refusal(label, held.reason));
      return;
    }
    // `endJob` gated on still being the holder — a run that was refused the job
    // cannot release the one that got it.
    const release = held.value;

    const controller = new AbortController();
    inFlightRef.current = controller;
    let timedOut = false;
    const deadline = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, RUN_TIMEOUT_MS);
    deadlineRef.current = deadline;

    // Live progress, which is the one thing `AgentRunSummary` cannot give: it
    // arrives only when the run is over. The finished list still comes from the
    // summary — HARNESS-GAP(1)'s reconstruction stays in the seam and is not
    // repeated here.
    const started: string[] = [];
    /**
     * Refusals the TOOLS returned, deduplicated, in the order they first
     * happened.
     *
     * This is where the track cap surfaces. `composition_add_track` refuses at
     * `MAX_COMPOSITION_TRACKS` with `TRACK_CAP_REASON` and hands the sentence to
     * the model, which is free to write a confident summary that never mentions
     * it — "a silent stop" from where the user sits. Collected generically
     * rather than pattern-matched on the cap, because every seam refusal has the
     * same claim on being seen.
     */
    const refusals: string[] = [];
    /**
     * Whether anything that can WRITE actually ran.
     *
     * `tool.started` and not `tool.finished`: the harness emits `started` only
     * after schema validation passes, and a handler that throws mid-batch has
     * already written. Reads are excluded because every command opens with one.
     *
     * A write tool that ran and refused end to end counts as a write here. That
     * is the deliberate side of the trade — the opposite mistake, deciding
     * "nothing changed" about a run that did, costs the user the ability to undo
     * the agent at all.
     */
    let wrote = false;
    /**
     * Whether the run wrote to the PATTERN library — which the rollback does not
     * reach.
     *
     * A composition job mints patterns (`pattern_open_blank` is in three of the
     * seven commands' tool lists) and those live in the other seam's history, so
     * a cancel leaves them behind. The report says so rather than promising a
     * restore it did not perform; the prefix is enough because every
     * `pattern_*` tool is a write and the pattern READ is `read_pattern`.
     */
    let wrotePatterns = false;

    /**
     * The full record of the run, for handing to somebody else.
     *
     * Everything below this line already reaches `onEvent` and was being dropped
     * — the arguments, the results, the model's reasoning, the token spend. Two
     * jobs in a row were debugged from a photograph of this panel because of it.
     * `beginTranscript` never throws and never refuses, so nothing on the run
     * path has to account for it failing.
     */
    const transcript = beginTranscript({
      page: command.page,
      command: label,
      agent: agent.name,
      systemPrompt: agent.systemPrompt,
      input: filled.value,
    });

    setRun({
      kind: 'running',
      command: label,
      tools: [],
      refusals: [],
      transcriptId: transcript.id,
    });

    void (async () => {
      /** Did the loop finish of its own accord, having been asked to? Anything
       *  else is an incomplete arrangement — see the rollback below. */
      let completed = false;
      /**
       * What to close the transcript with, filled at whichever exit is taken and
       * written once in the `finally`.
       *
       * There rather than beside each `setRun` because one of the exits below
       * returns WITHOUT calling `setRun` — the unmounted case — and that is
       * precisely the run somebody will want the log of: the panel went away
       * mid-job and rolled the arrangement back.
       */
      let outcome: { stoppedReason?: string; content?: string; error?: string } = {};

      try {
        // Inside the `try` whose `finally` closes it, so a throw between here
        // and the run cannot leak the bracket. Safe because both closers are
        // no-ops at depth 0 — a `finally` that closes a bracket nobody opened
        // does nothing at all.
        if (onComposition) beginCompositionGesture();
        else beginPatternGesture();


        const result = await runAgentTask(agent, filled.value, {
          signal: controller.signal,
          maxIters: MAX_ITERS,
          onEvent: (event: AgentEvent) => {
            // First, and unconditionally: the transcript wants every event,
            // including the ones the progress view below returns early on.
            transcript.record(event);
            if (event.type === 'tool.started') {
              started.push(event.name);
              if (writeTools.has(event.name)) {
                wrote = true;
                if (event.name.startsWith('pattern_')) wrotePatterns = true;
              }
            } else if (event.type === 'tool.finished') {
              const reason = refusalIn(event.result);
              if (reason !== null && !refusals.includes(reason)) refusals.push(reason);
            } else {
              return;
            }
            if (liveRef.current) {
              setRun({
                kind: 'running',
                command: label,
                tools: [...started],
                refusals: [...refusals],
              });
            }
          },
        });

        completed = result.ok && !timedOut && result.value.stoppedReason === 'answered';
        const rolledBack = onComposition && !completed && wrote;
        // Only worth saying alongside a rollback: on a run that KEPT its work
        // there is nothing surprising about the patterns it wrote still being
        // there.
        const keptPatterns = rolledBack && wrotePatterns;

        outcome = result.ok
          ? { stoppedReason: result.value.stoppedReason, content: result.value.content }
          : { error: result.reason };

        if (!liveRef.current) return;
        if (!result.ok) {
          setRun({
            kind: 'refused',
            command: label,
            tools: started,
            refusals,
            reason: result.reason,
            rolledBack,
            keptPatterns,
            transcriptId: transcript.id,
          });
          return;
        }
        // An abort comes back as a SUCCESS with `stoppedReason: 'aborted'`,
        // which read plainly says the user cancelled. Nobody cancelled a run the
        // deadline killed, and saying so is the whole point of having one.
        if (timedOut) {
          setRun({
            kind: 'refused',
            command: label,
            tools: started,
            refusals,
            reason: `Gave up after ${RUN_TIMEOUT_MS / 60_000} minutes — the provider never finished.`,
            rolledBack,
            keptPatterns,
            transcriptId: transcript.id,
          });
          return;
        }
        setRun({
          kind: 'answered',
          command: label,
          tools: result.value.toolCalls,
          refusals,
          content: result.value.content,
          stoppedReason: result.value.stoppedReason,
          rolledBack,
          keptPatterns,
          transcriptId: transcript.id,
        });
      } catch (error) {
        // `runAgentTask` returns its failures rather than throwing, so arriving
        // here is a defect in this app — but both brackets below must close all
        // the same, and the panel must not be left saying "Running…" forever.
        const message = error instanceof Error ? error.message : String(error);
        outcome = { error: message };
        if (liveRef.current) {
          setRun({
            kind: 'refused',
            command: label,
            tools: started,
            refusals,
            reason: `The agent run could not complete: ${message}`,
            rolledBack: onComposition && wrote,
            keptPatterns: onComposition && wrote && wrotePatterns,
            transcriptId: transcript.id,
          });
        }
      } finally {
        // ── EVERY PATH OUT, IN THIS ORDER ───────────────────────────────────
        // The lock goes back first: the rollback writes the composition, and
        // the seam's own writes are not what the lock is holding out.
        release();

        // Closed here rather than beside each `setRun`, so the exits that never
        // reach one — an unmount mid-run, above all — still leave a complete log.
        transcript.finish({
          ...outcome,
          rolledBack: onComposition && !completed && wrote,
        });

        if (!onComposition) {
          // AG-06's behaviour, kept deliberately for edit-mode rows: NO
          // ROLLBACK. A pattern command is a handful of calls over seconds and
          // its partial work is one undo press, which the panel says out loud;
          // `patternService` has no `abortEditGesture` and does not need one.
          endPatternGesture(wrote);
        } else if (completed) {
          // No argument on purpose: the seam's default is a reference test
          // against the composition it snapshotted, which is a better answer
          // than anything reconstructed from an event stream — a run whose every
          // write was refused wrote nothing, and pushes nothing.
          endCompositionGesture();
        } else {
          /**
           * ⚠ THE ROLLBACK, AND IT IS A DELIBERATE DIVERGENCE FROM AG-06.
           *
           * A pattern command's partial work is one undo press. A composition
           * job is dozens of calls over minutes — tracks added, patterns minted,
           * blocks placed — and half of that is not a partial success, it is a
           * mess the user has to dismantle by hand. The ticket's acceptance
           * criterion is that after a cancel "the composition is as it was", and
           * `abortEditGesture` is precisely that: the bracket's own snapshot,
           * restored, with no undo step pushed.
           *
           * It fires for every incomplete end, not only for Cancel — the
           * deadline, a provider that died, a loop that ran out of turns
           * half-way. That last one is why {@link MAX_ITERS} is generous: the
           * cost of the ceiling being too low is a lost run, not a broken
           * document.
           *
           * ⚠ What it does NOT put back is the PATTERNS a job minted, which live
           * in the other seam's history — documented on `abortEditGesture` and
           * in docs/FOLLOW-UPS.md. And the restore is irreversible by design (no
           * step is pushed, so there is nothing to redo), which is affordable
           * only because the job lock guarantees that everything inside the
           * snapshot's diff is the AGENT's work and none of it is the user's.
           */
          abortEditGesture();
        }

        window.clearTimeout(deadline);
        deadlineRef.current = null;
        inFlightRef.current = null;
      }
    })();
  };

  const running = run.kind === 'running' || job.kind === 'running';

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2">
      {!configured && (
        // A STATE, not an error — it is the state the app ships in, and the
        // panel stays entirely usable in it.
        <p className="tray px-2 py-1.5 text-[10px] leading-relaxed text-ink-mut">
          No provider yet — set one under <span className="text-ink">Connector</span>, in the
          header.
        </p>
      )}

      {noBlockOpen ? (
        // The list and the form are BOTH withheld, not merely disabled: a
        // selected command survives a mode change, so leaving the form up would
        // leave a Run button that writes into a document off-screen. Withholding
        // it is also what makes the `start` guard unnecessary — there is no
        // button to press. The run report below stays mounted regardless.
        <p className="tray px-2 py-1.5 text-[10px] leading-relaxed text-ink-mut">
          Press a block in the arrangement to open it — these commands act on the block you
          are editing.
        </p>
      ) : (
        <ul className="flex flex-col gap-[3px]">
          {commands.map((command) => (
            <li key={command.id}>
              <button
                type="button"
                aria-pressed={command.id === selectedId}
                onClick={() => select(command)}
                className={`w-full rounded-md px-2 py-1 text-left font-mono text-[10px] font-semibold ${
                  command.id === selectedId
                    ? 'control-accent pressable text-ink-hi'
                    : 'text-ink-mut hover:text-brass-hi'
                }`}
              >
                {command.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && !noBlockOpen && (
        <div className="flex flex-col gap-2 border-t border-rim-dark pt-2">
          <p className="text-[10.5px] leading-relaxed text-ink-mut">{selected.summary}</p>

          <SlotFields command={selected} values={values} onChange={setValue} />

          <button
            type="button"
            onClick={start}
            className={`${COMMAND_BUTTON} self-start ${running ? 'opacity-60' : 'control-accent'}`}
          >
            {running ? 'Running…' : 'Run'}
          </button>

          {/* Stated where the button is, and unconditionally: a user who does not
              know what a run costs them will not risk one. The three sentences
              differ because the three paths genuinely do — see the `finally` on
              each. */}
          <p className="font-mono text-[9px] leading-relaxed text-ink-mut">
            {selected.route === 'ir-job'
              ? // ⚠ NEITHER PROMISE THE OTHER TWO MAKE IS TRUE HERE. Nothing is
                // written until the import, so a cancel has nothing to put back —
                // and the import is not an undo step, so what it makes is undone
                // by deleting it. Both halves said, because a user who expects
                // the arrangement they are looking at to change will not find it.
                // ⚠ AND THE THIRD SENTENCE IS THE ONE THAT COSTS SOMETHING. The
                // undo stack is the seam's single global one, not per document
                // (`clearHistory`), so clearing it after the import — which
                // `importIR` requires, or a press stamps the old composition
                // back — takes the user's OWN earlier edits with it. Disclosed
                // for the same reason the single-run route discloses the
                // patterns it leaves behind.
                'This builds a NEW composition and opens it; the one you have open is not touched. Cancelling before it finishes writes nothing at all — and a finished one is undone by deleting what it made, not by undo. It also clears the undo history, so your own earlier edits stop being undoable.'
              : selected.page === 'composition'
                ? // Qualified, because the rollback is not total and a promise the
                  // cancel cannot keep is the one that matters — this is the
                  // sentence that makes pressing Cancel feel safe. What it restores
                  // is the ARRANGEMENT; patterns the run authored live in the other
                  // seam's history and stay in the library (`abortEditGesture`).
                  'Cancelling puts the arrangement back as it was, though patterns it wrote stay in your library. A finished run undoes in one press.'
                : 'Everything a run changes undoes in one press — cancelling included.'}
          </p>
        </div>
      )}

      {/* ── THE RUN, OUTSIDE THE FORM ────────────────────────────────────────
          Mounted for the whole life of the panel and never inside the selected
          command's block: a job outlives the list it was started from, and the
          mode switch that swaps that list must not take the Cancel button with
          it. Disabled while idle, so the keyboard skips it and it cannot strand
          anyone by disappearing under the pointer that just pressed it. */}
      <div className="flex flex-col gap-2 border-t border-rim-dark pt-2">
        <button type="button" onClick={cancel} disabled={!running} className={COMMAND_BUTTON}>
          Cancel
        </button>

        {/* `aria-live` WITHOUT `role="status"`: the connector dialog owns the
            app's one `status` landmark, and a second one makes "the status
            region" ambiguous both to a screen reader user moving by role and to
            `getByRole('status')`. Always mounted, because a live region that
            appears together with its content is announced inconsistently. */}
        {/* Both reports, and only ever one of them at a time — see `JobView`.
            Inside the SAME live region, so a screen reader hears one running
            commentary whichever route the user took. */}
        <div aria-live="polite" className="empty:hidden">
          <RunReport run={run} />
          <JobReport job={job} />
        </div>
      </div>
    </div>
  );
}

/**
 * What the run did, in the order it matters: which command, whether it is still
 * going, what it CALLED, what got refused along the way, and only then what the
 * model said.
 *
 * The tool names come before the answer because they are the only evidence the
 * loop did anything — a model that answers "done!" without calling a tool is the
 * commonest failure of this whole design and it is invisible in `content`. The
 * refusals come before it for the same reason one step down: the model is free
 * to summarise a run that hit the track cap without mentioning the cap.
 */
function RunReport({ run }: { run: RunView }) {
  if (run.kind === 'idle') return null;

  return (
    <div className="well px-2 py-1.5">
      <p className="font-mono text-[9px] font-bold tracking-[0.12em] text-ink-hi uppercase">
        {/* "Done" is reserved for a loop that finished because it had FINISHED.
            A cancelled or truncated run is `{ok:true}` all the same — the seam
            treats an abort as a success, because the user got what they asked
            for — and calling that "Done" over a rolled-back arrangement is the
            one word this report must not use. */}
        {run.kind === 'running'
          ? 'Running…'
          : run.kind === 'refused'
            ? 'Refused'
            : run.stoppedReason === 'answered'
              ? 'Done'
              : 'Stopped'}
        <span className="text-ink-mut"> · {run.command}</span>
      </p>

      <ToolTrace tools={run.tools} running={run.kind === 'running'} />

      {run.kind === 'running' && (
        // No progress bar and no percentage, deliberately: a job has no fixed
        // number of steps to count towards, and a bar drawn against a guess is a
        // promise the run cannot keep.
        <p className="mt-1 font-mono text-[9px] text-ink-mut">
          No total to count towards — a job runs until it is done.
        </p>
      )}

      {run.refusals.length > 0 && (
        <div className="mt-1.5">
          <p className="font-mono text-[9px] font-bold tracking-[0.12em] text-ink-mut uppercase">
            Refused along the way
          </p>
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {run.refusals.map((reason) => (
              // Verbatim. The seams author these sentences so that a model can
              // act on them, which also makes them the clearest thing a user can
              // be shown — `TRACK_CAP_REASON` says what the cap is and why.
              <li key={reason} className="text-[10px] leading-relaxed text-ink">
                {reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {run.kind !== 'running' && run.rolledBack && (
        <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink">
          The arrangement was put back the way it was before the run.
          {/* Said only when it happened. `abortEditGesture` restores the
              COMPOSITION and nothing else, so a job that authored parts leaves
              them in the library — unreferenced, and not undoable. Claiming a
              clean restore over that is the one thing this report must not
              do. */}
          {run.keptPatterns ? ' Patterns it wrote are still in your library.' : ''}
        </p>
      )}

      {run.kind === 'refused' && (
        <p className="mt-1 text-[10.5px] leading-relaxed text-ink">{run.reason}</p>
      )}

      {run.kind === 'answered' && (
        <p className="mt-1 text-[10.5px] leading-relaxed text-ink">
          {run.content.trim() === '' ? `The run ended: ${run.stoppedReason}.` : run.content}
        </p>
      )}

      {run.kind === 'answered' && run.stoppedReason !== 'answered' && (
        // The model did not choose to stop; something stopped it. Said out loud
        // because `content` from a truncated run reads exactly like a finished
        // one.
        <p className="mt-1 font-mono text-[9px] leading-relaxed text-ink-mut">
          {run.stoppedReason === 'aborted'
            ? 'Cancelled.'
            : `The run was cut short: ${run.stoppedReason}.`}
        </p>
      )}

      {/* On every ENDED run, not only the ones that went wrong: a job that
          answered confidently and built the wrong thing is the case a
          failure-only affordance would miss, and it is the case that has come
          up. Withheld while running because the log is still growing. */}
      {run.kind !== 'running' && run.transcriptId !== undefined && (
        <RunTranscriptControl transcriptId={run.transcriptId} />
      )}
    </div>
  );
}

// ------------------------------------------------------ the ir job's report ---

/**
 * One phase line, as ONE string.
 *
 * Built rather than interpolated into JSX because a line assembled from three
 * expressions is three text nodes, and the only way to assert on it is a regex
 * loose enough to pass while the numbers are wrong. `Part 2 of 3: Bass` is the
 * whole claim and it should be assertable as the whole claim.
 */
function partLine(part: JobPart, live: boolean): string {
  const head = `Part ${part.index} of ${part.count}: ${part.name}`;
  if (part.state === 'written') return head;
  if (part.state === 'failed') return `${head} — could not be written`;
  // Still `'running'` after the job ended: the job emits no `track.finished` for
  // a part the user cancelled out of, deliberately — see `JobPart`. So the state
  // means "in flight" while the job is live and "never finished" afterwards, and
  // neither is a mark against the model.
  return live ? `${head} …` : `${head} — stopped`;
}

/**
 * WHAT THE JOB IS DOING, AND WHAT IT DID.
 *
 * The order is the job's own — chart, then each part, then the import — because
 * that IS the progress here. There are no tool names to list (this route offers
 * no tools at all), and the phases are emitted by the job rather than inferred
 * from an event stream, which is what lets a part say "2 of 3" at a point where
 * nothing else in the app knows there are three.
 *
 * ⚠ THE TWO THINGS THIS MUST NOT DO, both of which are the same mistake: read as
 * a clean success when it was not.
 *   - A part MISSING from the imported piece is not a detail. The job refuses
 *     outright for a part it could not write, but the import can still drop one
 *     silently afterwards — see {@link partsMissing} — so a job that returned
 *     `ok` is checked against its own chart and headed `Incomplete` when it
 *     falls short.
 *   - WARNINGS ARE THE USER'S BUSINESS. They are the pipeline's account of what
 *     it dropped and what it approximated, and they arrive on a SUCCESS. Shown
 *     in the shape the single-run route shows tool refusals in, for the same
 *     reason: the run is free to look like it went perfectly.
 */
function JobReport({ job }: { job: JobView }) {
  if (job.kind === 'idle') return null;

  const live = job.kind === 'running';
  const missing = partsMissing(job.chart, job.documents);
  const documents = job.documents;
  const warnings = documents?.warnings ?? [];

  return (
    <div className="well px-2 py-1.5">
      <p className="font-mono text-[9px] font-bold tracking-[0.12em] text-ink-hi uppercase">
        {/* "Done" is a claim about the whole piece, so it is withheld from a job
            that came back short — see above. And "Refused" is a claim about the
            JOB, so it is withheld from a job the user stopped: the stop is typed
            precisely so a cancel is not reported as a failure, and the
            single-run report next door says 'Cancelled.' for the same event. */}
        {live
          ? 'Running…'
          : job.kind === 'refused'
            ? job.stopped === 'cancelled'
              ? 'Cancelled'
              : 'Refused'
            : missing > 0
              ? 'Incomplete'
              : 'Done'}
        <span className="text-ink-mut"> · {job.command}</span>
      </p>

      {/* Withheld entirely for a refusal decided before the job existed — see
          `started`. Capped and scrolled for `ToolTrace`'s reason: eight parts
          plus the chart and the import is ten lines in a rail with no scroller
          of its own. Not assertable in jsdom, which has no layout. */}
      {job.started && (
        <ol className="mt-1 flex max-h-40 flex-col overflow-y-auto font-mono text-[9.5px] text-ink-mut">
          <li className={live && job.chart === null ? 'text-ink' : undefined}>
            {job.chart === null
              ? live
                ? 'Chart …'
                : 'Chart — not written'
              : `Chart — ${job.chart.bars} bars at ${job.chart.bpm} bpm, ${job.chart.tracks.length} parts`}
          </li>
          {job.parts.map((part) => (
            <li
              key={part.index}
              className={
                part.state === 'failed' || (live && part.state === 'running')
                  ? 'text-ink'
                  : undefined
              }
            >
              {partLine(part, live)}
            </li>
          ))}
          {job.importing && (
            <li className={live ? 'text-ink' : undefined}>
              {documents !== null ? 'Imported' : live ? 'Importing …' : 'Import — refused'}
            </li>
          )}
        </ol>
      )}

      {/* ⚠ THE HEADLINE FACT OF THIS WHOLE ROUTE, and the one thing a user
          watching their own arrangement for changes will otherwise never work
          out. Said on the outcome rather than only in the caption under Run,
          because by the time a job of this length finishes the caption is
          minutes behind them. */}
      {job.kind === 'done' && documents !== null && (
        <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink">
          {documents.compositionId !== null
            ? `A new composition was created from ${documents.patternIds.length} parts and is now open. The composition you had open was not changed.`
            : `No composition was created — what the import produced is ${documents.patternIds.length} pattern${
                documents.patternIds.length === 1 ? '' : 's'
              } in your library. The composition you had open was not changed.`}
          {/* Said HERE as well as under the Run button, because by the time a
              job of this length finishes the caption is minutes behind the user
              — and the press it warns about is one they make on their way back
              to the composition they had open. */}
          {' Undo history was cleared, so your earlier edits can no longer be undone.'}
        </p>
      )}

      {missing > 0 && job.chart !== null && documents !== null && (
        <p className="mt-1 text-[10.5px] leading-relaxed text-ink">
          {`The chart named ${job.chart.tracks.length} parts and ${documents.patternIds.length} were imported — ${missing} did not survive, so this is not the arrangement that was asked for.`}
        </p>
      )}

      {warnings.length > 0 && (
        <div className="mt-1.5">
          <p className="font-mono text-[9px] font-bold tracking-[0.12em] text-ink-mut uppercase">
            Warnings from the import
          </p>
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {warnings.map((warning, index) => (
              // Verbatim, like the single-run route's refusals: the validator and
              // the mapper author these, and a second account of one drop is what
              // this codebase keeps paying for.
              //
              // Indexed key, unlike those refusals, because these are NOT
              // deduplicated: `importIR` concatenates four lists and the same
              // sentence can legitimately arrive from two of them. On the name
              // alone React drops the duplicate row and logs about it.
              <li key={`${index}:${warning}`} className="text-[10px] leading-relaxed text-ink">
                {warning}
              </li>
            ))}
          </ul>
        </div>
      )}

      {job.kind === 'refused' && job.reason !== undefined && (
        // The job's own sentence — it already names the part, its place in the
        // run and what became of the parts written before it.
        <p className="mt-1 text-[10.5px] leading-relaxed text-ink">{job.reason}</p>
      )}

      {!live && job.transcriptId !== undefined && (
        <RunTranscriptControl transcriptId={job.transcriptId} />
      )}
    </div>
  );
}

/** Which tools have run, and which one is running now. */
function ToolTrace({ tools, running }: { tools: readonly string[]; running: boolean }) {
  if (tools.length === 0) {
    return (
      <p className="mt-1 font-mono text-[9.5px] text-ink-mut">
        {running ? 'No tools called yet' : 'No tools called'}
      </p>
    );
  }
  return (
    // CAPPED AND SCROLLED, not left to grow: `MAX_ITERS` is 60 and a
    // composition row is around three calls a part, so a run that spends its
    // budget is fifty-odd lines —
    // and this section is `flex-none` in a rail with no scroller of its own, so
    // an uncapped trace squeezes the mode rail below it towards zero and
    // overflows the column. The cap is a HEIGHT (`max-h-40`) and not a count,
    // so it did not have to move when the budget did. Not assertable in jsdom,
    // which has no layout.
    <ol className="mt-1 flex max-h-40 flex-col overflow-y-auto font-mono text-[9.5px] text-ink-mut">
      {tools.map((name, index) => {
        // `tool.started` arrives before the call runs, so while the run is live
        // the LAST name in the list is the one in flight. It is marked rather
        // than merely listed because a job's tools take seconds each and a
        // static list of names looks identical to a stalled one.
        const inFlight = running && index === tools.length - 1;
        return (
          // Indexed key on purpose: the same tool legitimately appears more than
          // once in call order, so the name is not an identity.
          <li key={`${name}-${index}`} className={inFlight ? 'text-ink' : undefined}>
            {index + 1}. {name}
            {inFlight ? ' …' : ''}
          </li>
        );
      })}
    </ol>
  );
}
