/**
 * The seam between the app and `@fretwork/lib`'s COMPOSITION store.
 *
 * The fourth seam, and the only module allowed to touch `library.compositions`
 * or the lib's `composition-ops`. `patternService` is the same thing for
 * patterns and its charter stays patterns — one module owning two unrelated
 * documents is how a boundary stops being one.
 *
 * ⚠ The lib offers TWO routes to composition data and only one of them persists:
 *
 *   - `composition-ops` exports PURE `(comp) => comp` functions (`addTrack`,
 *     `movePlacement`, …). They return a new `Composition` and write nothing.
 *   - `usePatternsStore` exposes id-based ACTIONS that wrap those same ops and
 *     DO write back. They are named differently for tracks
 *     (`addCompositionTrack`, `setCompositionTrackMuted`, …) and identically for
 *     placements (`movePlacement`, `splitPlacement`, …).
 *
 * Everything below goes through the STORE ACTIONS. Reaching for the pure ops
 * means hand-rolling write-back and persistence, which passes a unit test and
 * silently loses the user's arrangement in the running app. The only pure ops
 * imported here are the read-only geometry helpers, which have nothing to write.
 */
import { useSyncExternalStore } from 'react';
import {
  DEFAULT_INSTRUMENT_ID,
  GROOVE_PRESETS,
  INSTRUMENTS,
  MAX_COMPOSITION_TRACKS,
  TIME_SIGNATURES,
  TRACK_INPUT_GAIN_RANGE_DB,
  getInstrument,
  placementEffectiveLength,
  placementEndTick,
  presetMatching,
  selectEditingComposition,
  ticksPerBar,
  usePatternsStore,
  type Composition,
  type FretInstrumentId,
  type GroovePresetId,
  type PatternTimeSignature,
  type Placement,
  type Tick,
  type Track,
} from '@fretwork/lib';
import { createHistory } from '../patterns/history';
// The PATTERN seam's history, cleared whenever the edit target moves — see
// `openPlacementForEditing`. One-directional: `patternService` imports nothing
// from here, so there is no cycle to reason about.
import {
  SUBDIVISION_OPTIONS,
  clearHistory as clearPatternHistory,
  listGrooves,
  type GrooveId,
  type Result,
  type SubdivisionId,
} from '../patterns/patternService';
// The transposition's COST, for the write that incurs it — see
// `setPlacementTranspose`. A pure per-placement count with no store in it, so
// this direction is safe: `arrangementMath` imports the lib and `timelineMath`
// and nothing else.
import { droppedByTranspose } from './arrangementMath';

export { MAX_COMPOSITION_TRACKS, placementEffectiveLength, placementEndTick };

/**
 * Ticks in one bar of a given time signature — the lib's own function, at this
 * seam's address.
 *
 * Re-exported for `PPQ`'s reason in `patternService`: a caller that counts bars
 * out of a tick total needs the conversion, and the alternative every time is
 * `(PPQ * 4 * numerator) / denominator` written out again. That expression is
 * correct and also a copy of lib maths, which is how 6/8 quietly becomes six
 * quarter-notes somewhere.
 */
export { ticksPerBar };

/**
 * Re-exported so a caller that PRICES a transposition and one that MAKES it
 * reach the same module — the reason `strandedByInstrument` and
 * `mismatchedPlacements` live here rather than beside it. The function itself
 * stays in `arrangementMath`, where the neck arithmetic and the LIB-GAP(12)
 * note belong; this is only its address.
 */
export { droppedByTranspose };

/**
 * Every write that can be refused reports it rather than throwing or silently
 * doing nothing. The lib's actions return `void` and simply no-op when they
 * decline (past the track cap, on the last remaining track, on an unknown id),
 * which leaves a caller unable to tell "done" from "declined" — the seam is
 * where that distinction is recovered.
 *
 * Declared in `patternService` and re-exported here so both seams speak ONE
 * type: AG-04 gave the pattern side the same refusals, and two structurally
 * identical `Result`s in two files is one of them drifting later.
 */
export type { Result };

/** The feel list and its ids, re-exported so a caller doing composition work
 *  reaches one module — the values are the lib's `GROOVE_PRESETS` either way. */
export { listGrooves, type GrooveId };

type SelectionMode = 'replace' | 'add' | 'toggle';

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const refuse = (reason: string): Result<never> => ({ ok: false, reason });

const store = () => usePatternsStore.getState();

const NO_TRACKS: readonly Track[] = [];
const NO_IDS: readonly string[] = [];

// --------------------------------------------------------------- job lock ---
/**
 * While an agent job owns the document, the USER's writes are refused and the
 * job's own go through.
 *
 * ⚠ THIS IS DATA-LOSS PREVENTION, not tidiness. A generation job runs for
 * minutes and can be cancelled, and cancelling rolls the document back to the
 * snapshot taken when the job started ({@link abortEditGesture}). Anything the
 * user edited while they waited would be rolled back WITH it — their work,
 * destroyed by the agent's rollback. Refusing their writes for the duration is
 * the only way "cancel" can mean "undo what the AGENT did" rather than "undo
 * the last few minutes".
 *
 * Enforced at the SEAM rather than by disabling controls, which is `addTrack`'s
 * argument turned around: five components write to the composition
 * (`ArrangementGrid`, `PatternLibraryRail`, `TrackControls`, `TransportBar`,
 * `TrackVoiceRack`, plus `useArrangementGestures` as the grid's gesture hub) and
 * a `locked` prop threaded to five places is forgotten by the sixth. All five
 * render a typed refusal already, so this needs no new UI.
 *
 * ── Why TWO flags and not one ───────────────────────────────────────────────
 *
 * `jobRunning` is a state that outlives any single call: the agent's run is
 * asynchronous and the user's clicks land BETWEEN its tool calls, so a flag held
 * across the whole run cannot tell the two apart. `jobWriteDepth` is what does —
 * {@link asJobWrite} is raised and lowered inside ONE synchronous tool handler
 * (`AgentTool.run` returns `ToolResult`, never a promise, and every composition
 * handler is synchronous — checked against the handlers, not assumed), so
 * nothing of the user's can run while it is up. It is a DEPTH and not a boolean
 * because `src/ai/tools/index.ts` wraps EVERY tool list, and a composition tool
 * reached from inside another wrap must nest rather than unlock early.
 *
 * ── What is deliberately NOT locked ─────────────────────────────────────────
 *
 *   - **Reads and selection.** Neither writes the document, and a user who
 *     cannot click a block to look at it while the agent works is being punished
 *     for waiting.
 *   - **`playbackService`.** Play/stop is not a document write and listening
 *     while the arrangement builds is the whole point of watching it build.
 *     (`setCompositionBpm` and `setCompositionLoop` sit on the same transport bar
 *     and ARE document writes, so those two do lock.)
 *   - **The gesture brackets** (`beginEditGesture` and friends). They record
 *     nothing on their own, and a user bracket opened during a job nests inside
 *     the job's, so it closes having written nothing and pushes no step.
 *   - **`ensureComposition` and `closePlacementEditing`.** Lifecycle, wired to
 *     `CompositionPage`'s effects rather than to a control. Refusing the cleanup
 *     one re-opens the CP-11 cross-page leak it exists to close — the pattern
 *     page would keep drawing a placement's snapshot — and that is a worse
 *     failure than the one the lock prevents.
 *
 *     ⚠ THE COST, and it is not only "navigating away": `CompositionPage` wires
 *     that cleanup to a `mode` effect, so ANY mode switch closes an open
 *     placement too — and `mode` lives in `App`, which reaches no seam and so
 *     cannot be refused from here. Either exit, taken while the agent is inside a
 *     placement, leaves its later `pattern_*` writes pointed at the LIBRARY
 *     pattern — the user's own document, which {@link abortEditGesture} does not
 *     restore. `openPlacementForEditing` being locked stops the user repointing
 *     the editor INTO a block, but not out of one. The mode bar is therefore
 *     disabled from {@link useIsJobRunning} (`CompositionPage`), which is the
 *     only one of the two exits worth a control; leaving the page entirely is
 *     rare enough, and destructive enough to interrupt, that it stays open.
 *
 * ── The pattern seam is a SEPARATE lock, and there isn't one ────────────────
 *
 * Everything here concerns the COMPOSITION document. `patternService` has its own
 * history and its own writes, and a composition job creates patterns
 * (`pattern_open_blank` is in three composition commands' tool lists). Two
 * consequences, both deliberate for now and both in docs/FOLLOW-UPS.md:
 * a cancelled job leaves every pattern it minted in the library, unreferenced and
 * not undoable; and the pattern page's own writes are not refused during a
 * composition job. Closing that needs a run-level bracket spanning both seams,
 * which is a bigger change than this lock.
 */

let jobRunning = false;
let jobWriteDepth = 0;
/** Identity of the CURRENT holder, so a caller that was refused the job cannot
 *  release the one that got it (its own `finally` would otherwise unlock the
 *  winner). Compared by reference; never read for anything else. */
let jobToken: object | null = null;
const jobListeners = new Set<() => void>();

const notifyJob = () => jobListeners.forEach((listener) => listener());

function subscribeJob(listener: () => void): () => void {
  jobListeners.add(listener);
  return () => jobListeners.delete(listener);
}

/** The one authoring of the refusal, for `TRACK_CAP_REASON`'s reason: the panel
 *  wants the same sentence for its banner that the seam returns to the control. */
export const JOB_LOCK_REASON =
  'A generation job is building this arrangement — wait for it to finish, or cancel it.' as const;

/** True when this call is the USER's and a job holds the document. */
const lockedOut = (): boolean => jobRunning && jobWriteDepth === 0;

/**
 * Take the document for an agent job. Returns the RELEASE — call it when the run
 * ends, however it ends.
 *
 * A closure rather than a bare `endJob()` because this is an open bracket, and
 * this repo has already been bitten by one: a release that only the holder can
 * perform means a caller refused the job cannot unlock the job that got it, and
 * calling it twice is a no-op. {@link endJob} remains as the unconditional escape
 * hatch (and the tests' reset), which is the thing you want when a bracket HAS
 * leaked — but nothing in the normal path should reach for it.
 *
 * Refused if a job already holds the document (two jobs would each roll back over
 * the other's work) or if nothing is open — a job with no document would lock the
 * user out while every one of its own writes answered "No composition is open."
 *
 * Does NOT open the undo bracket. That belongs to the caller, for the reason
 * `CommandPanel` gives: a bracket has to name a history, and the panel is what
 * knows which page it is on. The expected order is
 * `beginEditGesture(); const release = beginJob();` … `release(); endEditGesture()`
 * on success, or `release(); abortEditGesture()` on cancel.
 */
export function beginJob(): Result<() => void> {
  if (jobRunning) return refuse('A generation job is already running.');
  if (!getEditingComposition()) return refuse('No composition is open.');
  const token = {};
  jobToken = token;
  jobRunning = true;
  notifyJob();
  return ok(() => {
    if (jobToken !== token) return;
    endJob();
  });
}

/** Hand the document back unconditionally — the escape hatch for a leaked
 *  bracket, and what the tests reset with. Idempotent. */
export function endJob(): void {
  if (!jobRunning) return;
  jobRunning = false;
  jobToken = null;
  notifyJob();
}

/** Whether a job holds the document. Non-reactive, for event handlers and tests;
 *  {@link useIsJobRunning} is the one a component wants. */
export function isJobRunning(): boolean {
  return jobRunning;
}

/**
 * React hook: whether a job holds the document.
 *
 * The lock refuses through `Result`, and the two writes that cannot — `undo` and
 * `redo` — are silently inert instead (see their comment). A control that would
 * be dead needs to LOOK dead, which is what this is for: `useHistoryState` folds
 * it in for those two, and `CompositionPage` disables the mode bar with it.
 */
export function useIsJobRunning(): boolean {
  return useSyncExternalStore(subscribeJob, isJobRunning, isJobRunning);
}

/**
 * Run one agent tool handler as the JOB's write, exempt from the lock.
 *
 * ⚠ Must wrap a SYNCHRONOUS call and nothing longer. The exemption is safe only
 * because no user event can be dispatched while it is raised; wrapping an
 * `await` would hand the user the agent's key.
 */
export function asJobWrite<T>(write: () => T): T {
  jobWriteDepth++;
  try {
    return write();
  } finally {
    jobWriteDepth--;
  }
}

// ---------------------------------------------------------------- reading ---

/** React hook: the composition currently being arranged, or null. */
export function useEditingComposition(): Composition | null {
  return usePatternsStore(selectEditingComposition);
}

/** Non-reactive read — for event handlers and tests. */
export function getEditingComposition(): Composition | null {
  return selectEditingComposition(usePatternsStore.getState());
}

/** React hook: the editing composition's tracks. Always at least one once a
 *  composition exists — the lib's model invariant, enforced by `removeTrack`. */
export function useTracks(): readonly Track[] {
  return usePatternsStore((s) => selectEditingComposition(s)?.tracks ?? NO_TRACKS);
}

export function getTracks(): readonly Track[] {
  return getEditingComposition()?.tracks ?? NO_TRACKS;
}

export function findTrack(trackId: string): Track | undefined {
  return getTracks().find((t) => t.id === trackId);
}

/**
 * Locate a placement within the editing composition.
 *
 * Deliberately not the lib's exported `findPlacement`: that one is a store
 * selector that searches EVERY composition in the library, so it can return a
 * placement belonging to a composition the user isn't arranging. Geometry code
 * asking "where is this block" always means "in the open composition".
 */
export function findPlacement(
  placementId: string,
): { track: Track; placement: Placement } | undefined {
  for (const track of getTracks()) {
    const placement = track.placements.find((p) => p.id === placementId);
    if (placement) return { track, placement };
  }
  return undefined;
}

/**
 * LIB-GAP(11): the lib's own `totalDurationTicks` measures every placement as
 * `startTick + patternSnapshot.durationTicks * repeat`, ignoring `lengthTicks`,
 * so a block truncated to a beat still claims its snapshot's full width — up to
 * 4× too long, and the ruler would draw the excess. `placementEndTick` is the
 * lib's own correct answer (it routes through `placementEffectiveLength`, as
 * playback does), so summing it here is the whole workaround.
 *
 * Delete when the lib's `totalDurationTicks` routes through `placementEndTick`.
 *
 * Exported (CP-17) because the composition rail measures rows that are NOT the
 * open document, and {@link totalDurationTicks} answers only for that one. A
 * second sum written at the call site would be a second copy of this workaround,
 * which is the thing the LIB-GAP registry exists to stop.
 */
export function compositionEndTick(composition: Composition): Tick {
  let end = 0;
  for (const track of composition.tracks) {
    for (const placement of track.placements) {
      end = Math.max(end, placementEndTick(placement));
    }
  }
  return end;
}

/** How long the arrangement runs — the end of its longest track. */
export function totalDurationTicks(): Tick {
  const composition = getEditingComposition();
  return composition ? compositionEndTick(composition) : 0;
}

/** React hook form of {@link totalDurationTicks}, for the ruler's extent. */
export function useTotalDurationTicks(): Tick {
  return usePatternsStore((s) => {
    const composition = selectEditingComposition(s);
    return composition ? compositionEndTick(composition) : 0;
  });
}

/**
 * `Track.instrumentId` is a free-form string and everything downstream of it —
 * the voice rack, the string count a lane draws — is not. Resolved exactly as
 * `patternService.patternInstrumentId` resolves a pattern's, and for the same
 * reason: membership is asked of the lib's catalog rather than listed here,
 * because `INSTRUMENTS` and `FretInstrumentId` are grown together on the lib
 * side and a hardcoded list would silently coerce a fourth instrument to guitar.
 */
export function trackInstrumentId(track: Track): FretInstrumentId {
  return getInstrument(track.instrumentId) !== undefined
    ? (track.instrumentId as FretInstrumentId)
    : DEFAULT_INSTRUMENT_ID;
}

/** The instruments a track can be on, for a picker. Same catalog read as
 *  `patternService.listInstruments`. */
export function listTrackInstruments(): readonly { id: FretInstrumentId; name: string }[] {
  return INSTRUMENTS.map((instrument) => ({
    id: instrument.id as FretInstrumentId,
    name: instrument.name,
  }));
}

// ------------------------------------------------------------------- mix ---

/**
 * The fader's travel, in dB. 0 is unity, not a midpoint — a volume control that
 * is a 0–100 percentage of something is the wrong control for this model, since
 * both the track and the master are dB all the way down to the gain node.
 *
 * The numbers are the lib's own clamp (`composition-ops.setTrackVolumeDb` and
 * `setMasterVolumeDb` both hard-limit to `-60..+6`) and its documented range
 * (`types.ts`: "Range typically -60..+6"). Restated because a fader needs an
 * extent and the lib is deliberately pixel-free; NOT a lib gap — the clamp is
 * documented API, and the seam would refuse nothing by asking for it.
 */
export const VOLUME_RANGE_DB = { min: -60, max: 6 } as const;

const clampDb = (db: number) =>
  Math.max(VOLUME_RANGE_DB.min, Math.min(VOLUME_RANGE_DB.max, db));

/**
 * The pan pot's travel. -1 hard left, 0 centre, +1 hard right.
 *
 * Unlike the fader's, this range is not a restatement of a lib clamp for a
 * pixel-free model's benefit — it is the `Tone.Panner` parameter's own domain,
 * and the lib clamps to exactly this. Named here so the control, the seam and
 * the agent's schema all read one number.
 *
 * Note it IS a midpoint control, which the fader deliberately is not: 0 means
 * centre rather than unity, and that is why it gets a detent and the fader
 * does not.
 */
export const PAN_RANGE = { min: -1, max: 1 } as const;

const clampPan = (pan: number) => Math.max(PAN_RANGE.min, Math.min(PAN_RANGE.max, pan));

/**
 * Bounds for a track's input gain, re-exported from the lib.
 *
 * Re-exported rather than restated so the control, the seam and the agent's
 * schema all read the same number, and so that number stays the audio engine's:
 * these are the voice's own input-gain bounds, not a UI preference. `PAN_RANGE`
 * above is declared here for the same reason but from the opposite direction —
 * that one IS the `Tone.Panner` domain and has no lib constant to borrow.
 */
export { TRACK_INPUT_GAIN_RANGE_DB };

/**
 * Whether this track will actually be HEARD, by the engine's own rule.
 *
 * The precedence, decided once here so the screen and the ear cannot disagree
 * (CP-07):
 *
 *   - **Solo is not "mute the others".** Any soloed track anywhere silences
 *     every UN-soloed track; two tracks soloed means exactly those two sound.
 *     Nothing is written to the other tracks, so un-soloing restores the mix
 *     that was there — which is the whole difference from muting them by hand.
 *   - **Mute wins over solo.** A track that is both muted and soloed is SILENT.
 *     Mute is a statement about THIS track; solo is a statement about the
 *     others, and the specific instruction beats the general one. The lib's
 *     engine already resolves it this way, and a mixer whose buttons imply a
 *     different order than the audio uses is the classic version of this bug.
 *
 * LIB-GAP(14): `MultiTrackPlayback.applyTrackState` computes exactly
 * `!track.muted && (!anySoloed || track.soloed)` and exposes nothing — there is
 * no way to ask the engine which tracks it is about to silence, so the rule is
 * restated. Kept to this one function, so the copy that could drift is one
 * function and not a condition spread across the header. Delete when the lib
 * exports the predicate (or a per-track audibility read on the playback object).
 * See docs/FOLLOW-UPS.md.
 */
export function isTrackAudible(track: Track, tracks: readonly Track[]): boolean {
  if (track.muted) return false;
  return !tracks.some((t) => t.soloed) || track.soloed;
}

// ----------------------------------------------------------- diagnostics ---
// These two live at the SEAM rather than beside `droppedByTranspose` in
// `arrangementMath` — which is otherwise the right home for pure per-placement
// counts — because they price a seam WRITE before it is made. `setTrackInstrument`
// is the only caller's reason to ask, the agent needs the same answer through the
// same module it will make the write through, and `arrangementMath` is imported by
// geometry code that has no business knowing about instruments.

/**
 * How many of a track's notes sit on strings the given instrument has not got.
 *
 * A placement carries its OWN `patternSnapshot.instrumentId`, so a six-string
 * riff dropped onto a track set to bass keeps two strings the bass does not
 * have. That is a fact about the ARRANGEMENT and is true whatever plays it: the
 * notes have nowhere on that instrument to be.
 *
 * ⚠ It is NOT, today, a prediction about what will be heard — see LIB-GAP(15) on
 * {@link mismatchedPlacements}, which covers both of these.
 *
 * Counted per pattern note rather than per repetition, and skipping notes past
 * the placement's truncation, for the same reasons `droppedByTranspose` does:
 * "8 notes have nowhere to go" is the fact a user can act on.
 */
export function strandedByInstrument(
  track: Track,
  instrumentId: FretInstrumentId,
): number {
  const stringCount = getInstrument(instrumentId)?.stringCount;
  if (stringCount === undefined) return 0;
  let stranded = 0;
  for (const placement of track.placements) {
    const length = placementEffectiveLength(placement);
    for (const event of placement.patternSnapshot.events) {
      if (event.startTick >= length) continue;
      if (event.stringIndex >= stringCount) stranded++;
    }
  }
  return stranded;
}

/**
 * How many of a track's blocks were written for a different instrument.
 *
 * Not the same question as {@link strandedByInstrument} and both are worth
 * asking: a bass riff on a guitar track strands nothing (four strings fit in
 * six) and is still not the part its author wrote, because it was fingered
 * against a different set of open strings.
 *
 * LIB-GAP(15): both of these describe the arrangement rather than the audio,
 * because the lib gives a track no tuning to describe. `MultiTrackPlaybackOpts`
 * takes ONE `tuning` and ONE `capo` for the whole composition and hands the same
 * pair to every per-track `EventScheduler` (`setTuning` is documented as "sync
 * tuning + capo across every scheduler"); `CompositionTrackSource` emits bare
 * `stringIndex`/`fret` and carries neither. A track's `instrumentId` therefore
 * selects its VOICE and nothing else — not its string set, not its pitch.
 *
 * Two consequences worth stating rather than discovering:
 *
 *  - a stranded note is silenced only if the COMPOSITION's tuning also lacks
 *    that string, so the count is what the arrangement holds, not a promise
 *    about what the engine will drop;
 *  - the inverse is unreportable from here — a four-string composition tuning
 *    drops string 4/5 events on EVERY track, guitar ones included.
 *
 * Delete when a track's tuning is derived from its own `instrumentId`
 * (`MultiTrackPlayback` building one `EventScheduler` tuning per track). Until
 * then the surface must describe strings, never audibility. See
 * docs/FOLLOW-UPS.md.
 */
export function mismatchedPlacements(track: Track): number {
  return track.placements.filter(
    (placement) => placement.patternSnapshot.instrumentId !== track.instrumentId,
  ).length;
}

// -------------------------------------------------------------- selection ---
// The lib's store holds a SINGLE `selectedPlacementId`. The arranger needs a
// multi-selection (`duplicatePlacements` takes an array, so the lib anticipates
// one), so the set is held here and the store's single id is kept pointed at the
// primary — the last id touched — so anything reading the store agrees with us.

let selectedPlacementIds: readonly string[] = NO_IDS;
let selectedTrackId: string | null = null;
const selectionListeners = new Set<() => void>();

const notifySelection = () => selectionListeners.forEach((l) => l());

function subscribeSelection(listener: () => void): () => void {
  selectionListeners.add(listener);
  return () => selectionListeners.delete(listener);
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

function writeSelection(next: readonly string[]): void {
  if (sameIds(next, selectedPlacementIds)) return;
  selectedPlacementIds = next.length === 0 ? NO_IDS : [...next];
  store().selectPlacement(selectedPlacementIds.at(-1) ?? null);
  notifySelection();
}

export function getSelectedPlacementIds(): readonly string[] {
  return selectedPlacementIds;
}

/** React hook: ids of the currently selected placements. */
export function useSelectedPlacementIds(): readonly string[] {
  return useSyncExternalStore(
    subscribeSelection,
    getSelectedPlacementIds,
    getSelectedPlacementIds,
  );
}

/** Mirrors `patternService.selectNotes` — same three modes, so marquee and
 *  shift-click behave identically on both surfaces. */
export function selectPlacements(
  ids: readonly string[],
  mode: SelectionMode = 'replace',
): void {
  if (mode === 'replace') {
    writeSelection(ids);
    return;
  }
  if (mode === 'add') {
    const merged = [...selectedPlacementIds];
    for (const id of ids) if (!merged.includes(id)) merged.push(id);
    writeSelection(merged);
    return;
  }
  const next = selectedPlacementIds.filter((id) => !ids.includes(id));
  for (const id of ids) if (!selectedPlacementIds.includes(id)) next.push(id);
  writeSelection(next);
}

/**
 * Drop ids whose placements no longer exist.
 *
 * Needed because a removal is not the only way a placement disappears: an undo
 * restores a whole `Composition`, so it can retract placements the selection
 * still points at. A stale id is invisible until something tries to drag it.
 */
function prunePlacementSelection(): void {
  if (selectedPlacementIds.length === 0) return;
  const live = new Set(getTracks().flatMap((t) => t.placements.map((p) => p.id)));
  writeSelection(selectedPlacementIds.filter((id) => live.has(id)));
}

/** The track focus needs the same treatment for the same reason: an undo can
 *  retract the track it names, and a write aimed at a track that no longer
 *  exists is refused with no visible cause. */
function pruneTrackSelection(): void {
  if (selectedTrackId !== null && !findTrack(selectedTrackId)) selectTrack(null);
}

/**
 * And the EDITING pointer, which is the same hazard with teeth.
 *
 * The lib nulls `editingPlacementId` itself when its own `removePlacement` action
 * runs — but a restore is a raw `storeComposition` setState (LIB-GAP(1)), so
 * nothing nulls it there. Left dangling, `patternService.writePatternBack` finds
 * no placement to write to and every note edit silently hits nothing, while the
 * pattern page keeps drawing a retracted block's snapshot. Cheaper to close here
 * than to explain later.
 */
function pruneEditingPlacement(): void {
  const editing = getEditingPlacementId();
  if (editing !== null && !findPlacement(editing)) closePlacementEditing();
}

export function getSelectedTrackId(): string | null {
  return selectedTrackId;
}

/** React hook: the focused track, or null. Track focus is app state — the lib
 *  has no notion of it — so it lives here beside the placement selection. */
export function useSelectedTrackId(): string | null {
  return useSyncExternalStore(subscribeSelection, getSelectedTrackId, getSelectedTrackId);
}

export function selectTrack(trackId: string | null): void {
  if (selectedTrackId === trackId) return;
  selectedTrackId = trackId;
  notifySelection();
}

// ------------------------------------------------------------------ undo ---
// LIB-GAP(1): the lib has no history support and no way to write a whole
// document back — the same gap `patternService` masks for patterns, so it
// carries the same tag and the same deletion condition (docs/FOLLOW-UPS.md:
// "lib gains history, or at least `replacePattern(id, pattern)`" — for this
// module, `replaceComposition(id, composition)`). Everything undo-related is
// confined to this section so it can be deleted in one go.

const history = createHistory<Composition>();

/**
 * Merge the live settings onto a snapshot about to be restored.
 *
 * Undo covers the ARRANGEMENT — which tracks exist, which blocks sit where. The
 * mix and the naming push no undo step of their own (see the settings section),
 * but a snapshot is a whole `Composition`, so restoring one verbatim would roll
 * back a rename or a fader move made after it was captured and recorded nowhere
 * — destroying it, since a later edit clears the redo stack. Carrying those
 * fields forward is what keeps "not undoable" from meaning "undoable by
 * accident, in the wrong direction".
 *
 * A track the snapshot has and the live composition doesn't is one this very
 * undo is restoring; its settings are the snapshot's own.
 */
function mergeSettingsForward(snapshot: Composition, live: Composition): Composition {
  const liveTracks = new Map(live.tracks.map((t) => [t.id, t]));
  return {
    ...snapshot,
    name: live.name,
    bpm: live.bpm,
    timeSignature: live.timeSignature,
    loop: live.loop,
    masterVolumeDb: live.masterVolumeDb,
    tracks: snapshot.tracks.map((track) => {
      const current = liveTracks.get(track.id);
      if (!current) return track;
      return {
        ...track,
        name: current.name,
        instrumentId: current.instrumentId,
        voiceRef: current.voiceRef,
        volumeDb: current.volumeDb,
        pan: current.pan,
        // AU-03. THIRD time a field has had to be added to this list — AG-07's
        // `groove` and CP-19's `pan` were the first two, both found by a test
        // after the control had already shipped forgetting itself. Undo restores
        // a whole document, so anything that pushes no undo step of its own has
        // to be carried forward here or an unrelated undo silently reverts it.
        inputGainDb: current.inputGainDb,
        muted: current.muted,
        soloed: current.soloed,
      };
    }),
  };
}

/**
 * Swap one composition in the library for another.
 *
 * The one place this module reaches past the lib's public actions: the store
 * offers granular ops and no whole-document write, which is exactly what
 * restoring a snapshot — and, since CP-07, reordering tracks — needs. Kept as a
 * single private function so the reach is one call site to delete, not two.
 */
function storeComposition(composition: Composition): void {
  usePatternsStore.setState((state) => ({
    library: {
      ...state.library,
      compositions: state.library.compositions.map((c) =>
        c.id === composition.id ? composition : c,
      ),
    },
  }));
}

/**
 * Restore a snapshot over the live composition.
 *
 * `mergeSettings` is true for UNDO, whose caller is the user: the mix and the
 * naming push no undo step of their own, so rolling them back would destroy an
 * edit recorded nowhere. It is false for {@link abortEditGesture}, whose caller
 * is a cancelled agent job — see there.
 */
function writeCompositionBack(snapshot: Composition, mergeSettings = true): void {
  const live = getEditingComposition();
  storeComposition(
    mergeSettings && live && live.id === snapshot.id
      ? mergeSettingsForward(snapshot, live)
      : snapshot,
  );
}

/**
 * Run a write and record an undo step only if it actually changed something.
 *
 * `patternService` captures unconditionally before every mutation; it can,
 * because its ops always apply. The composition ops return the SAME composition
 * reference when they DECLINE — an unknown id, a value already set, a split at
 * the block's own edge — and the store's `applyComposition` then skips the write
 * entirely, so an unconditional capture here would push an undo step for every
 * refused write. Reference identity is the lib's own declined signal, so it is
 * what we test. Note it is not a *value* comparison: a move that lands back on
 * the tick it started from still produces a new composition, which is what
 * gestures rather than this guard are for.
 */
function commit<T>(write: () => T): T {
  const before = getEditingComposition();
  const result = write();
  if (before && getEditingComposition() !== before) history.capture(before);
  return result;
}

let gestureSnapshot: Composition | null = null;
/**
 * How many brackets are open. `history` keeps ONE gesture slot, so a nested
 * `beginGesture` overwrites the outer snapshot and the inner `endGesture` closes
 * the outer bracket — after which the outer gesture's remaining writes each push
 * their own step. That is not hypothetical: every capability in
 * `useArrangementGestures` brackets itself, and a keyboard shortcut fired during
 * a held drag nests one inside the other. Counting here is what keeps "one
 * gesture, one step" true regardless of the order callers reach the seam in,
 * which the agent's tools need as much as the UI does.
 */
let gestureDepth = 0;

/** Bracket a multi-step edit — a drag fires dozens of mutations but must undo as
 *  one step. Safe to call with no composition open, and safe to nest. */
export function beginEditGesture(): void {
  // Nested: the outermost bracket's snapshot already covers everything inside
  // it, so this one records nothing and only deepens the count.
  if (gestureDepth++ > 0) return;
  gestureSnapshot = getEditingComposition();
  if (gestureSnapshot) history.beginGesture(gestureSnapshot);
}

/**
 * `changed` defaults to the same reference test `commit` uses, so a gesture that
 * wrote nothing — a click that never became a drag — pushes no step. Passing it
 * explicitly is for a caller that has already put the composition back itself;
 * it is honoured only on the OUTERMOST close, because only that one decides
 * whether a step is pushed.
 */
export function endEditGesture(changed?: boolean): void {
  if (gestureDepth === 0) return;
  if (--gestureDepth > 0) return;
  const didChange =
    changed ?? (gestureSnapshot !== null && getEditingComposition() !== gestureSnapshot);
  gestureSnapshot = null;
  history.endGesture({ changed: didChange });
}

/**
 * Close the bracket WITHOUT pushing an undo step, putting the document back the
 * way the bracket found it. The rollback half of the job lock.
 *
 * Not a new capability: `beginEditGesture` already snapshots, and `undo` already
 * restores a whole `Composition` through `writeCompositionBack`. This is those
 * two pieces meeting — which is why the whole-document reach stays the single
 * `storeComposition` call it already was (LIB-GAP(1)) and no new one appears.
 *
 * ⚠ THE RESTORE IS VERBATIM, and that is the one place it parts company with
 * `undo`. `undo` merges the live settings forward (`mergeSettingsForward`)
 * because the mix and the naming push no undo step of their own, so reverting
 * them would destroy an edit recorded nowhere. A cancel cannot borrow that
 * argument: the job lock refuses the user EVERY field that merge carries — name,
 * bpm, time signature, loop, master volume, and each track's name, instrument,
 * voice, level, mute and solo — so by construction the only writer of any of them
 * during the job is the AGENT, and carrying them forward would mean cancelling a
 * job that keeps the tempo, the title and the mix it chose. (It was also
 * incoherent: `groove` is not in the merge list, so a single
 * `composition_set_settings({bpm, groove})` half-reverted.) The lock is what
 * makes verbatim safe; if a field is ever unlocked, it belongs in a merge on this
 * path too.
 *
 * ⚠ Nested aborts DEGRADE, they do not escalate. The depth is honoured exactly
 * as `endEditGesture` honours it, because that symmetry is the only thing
 * keeping "one gesture, one step" true regardless of the order callers reach the
 * seam in. So an abort at depth > 1 decrements and does NOTHING ELSE — no
 * restore — and the outer bracket's eventual `endEditGesture` then pushes an
 * ordinary undo step for everything that was written. The user gets one undo
 * instead of an automatic rollback, which is degraded but not wrong. It should
 * not arise: the panel aborts after the run has RETURNED, and every tool bracket
 * is closed in a `finally`, so depth is 1 there.
 *
 * ⚠ WHAT IT DOES NOT REACH — this restores the COMPOSITION and nothing else:
 *
 *   - **Patterns the job minted.** `pattern_open_blank` is in three composition
 *     commands' tool lists, and `patternService` has its own history and its own
 *     documents. A cancel leaves those in the library, unreferenced and not
 *     undoable. Closing it needs a run-level bracket spanning both seams — see
 *     the job lock's header and docs/FOLLOW-UPS.md.
 *   - **A composition SWITCH inside the bracket.** `openBlankComposition` clears
 *     the history and `clearHistory` re-arms the bracket on the NEW document, so
 *     the snapshot this would restore is the blank one and the pre-job
 *     composition is never put back. That is why `openBlankComposition` refuses
 *     for the duration of a job outright — the agent's exemption does not reach
 *     it — rather than being left to the caller to settle.
 */
export function abortEditGesture(): void {
  if (gestureDepth === 0) return;
  if (--gestureDepth > 0) return;
  const snapshot = gestureSnapshot;
  gestureSnapshot = null;
  // `changed: false` is what makes this an abort rather than an undo: the
  // gesture slot is released and no step is pushed, so the stacks are left
  // exactly as the job found them and the user's own undo still reaches their
  // own last edit.
  history.endGesture({ changed: false });
  if (!snapshot) return;
  writeCompositionBack(snapshot, false);
  // `undo`'s reason: a restore can retract tracks and placements the selection
  // still names, and a stale id is invisible until something tries to drag it.
  pruneEditingPlacement();
  prunePlacementSelection();
  pruneTrackSelection();
}

/**
 * ⚠ Both of these are DEAD while a job holds the document, and this is the trap
 * they are dead for. `history` keeps ONE gesture slot and the job's bracket is
 * holding it, so an undo mid-job would pop a step from BEFORE the job and write
 * it over a document the agent is still building — a hybrid neither side asked
 * for, and a job whose rollback snapshot no longer describes anything that
 * followed. The user's way out of a running job is CANCEL, which restores the
 * very snapshot an undo would have been reaching past.
 *
 * Silently, because these two return `void` — the only writes here with no
 * channel to refuse through. So they are not left LOOKING alive either:
 * {@link useHistoryState} reports both unavailable while a job runs, which is
 * what the ↶/↷ buttons and their ⌘Z twin already derive `disabled` from. A dead
 * key with an enabled button beside it is the one refusal in this design with no
 * channel at all.
 */
export function undo(): void {
  if (lockedOut()) return;
  const current = getEditingComposition();
  if (!current) return;
  const previous = history.undo(current);
  if (!previous) return;
  writeCompositionBack(previous);
  pruneEditingPlacement();
  prunePlacementSelection();
  pruneTrackSelection();
}

export function redo(): void {
  if (lockedOut()) return;
  const current = getEditingComposition();
  if (!current) return;
  const next = history.redo(current);
  if (!next) return;
  writeCompositionBack(next);
  pruneEditingPlacement();
  prunePlacementSelection();
  pruneTrackSelection();
}

/**
 * Drop the stacks — done on every switch of composition, because history is
 * per-composition.
 *
 * ⚠ The bracket DEPTH deliberately survives, for `patternService.clearHistory`'s
 * reason: `forgetPerCompositionState` clears from inside whatever bracket the
 * caller opened, and zeroing the count there would orphan it — every later write
 * in the same command pushing its own step and the outer close finding nothing.
 * The bracket is re-armed on whatever is open now instead.
 */
export function clearHistory(): void {
  history.clear();
  gestureSnapshot = gestureDepth > 0 ? getEditingComposition() : null;
  if (gestureSnapshot) history.beginGesture(gestureSnapshot);
}

/**
 * React hook: whether undo/redo are currently available.
 *
 * A running job makes both unavailable — see {@link undo}. Folded in HERE rather
 * than left to each caller because the ↶/↷ buttons already derive `disabled`
 * from this hook, so a control that would be inert is drawn inert without a
 * second code path to remember.
 */
export function useHistoryState(): { canUndo: boolean; canRedo: boolean } {
  const canUndo = useSyncExternalStore(history.subscribe, history.canUndo, history.canUndo);
  const canRedo = useSyncExternalStore(history.subscribe, history.canRedo, history.canRedo);
  const running = useIsJobRunning();
  return { canUndo: canUndo && !running, canRedo: canRedo && !running };
}

// ------------------------------------------------------------- lifecycle ---

/**
 * Every composition in the library.
 *
 * `usePatternsStore` selects the ARRAY, so the identity check that stops a
 * re-render is the array's own — the store replaces it only when the library
 * actually changes. Mirrors `patternService.useLibraryPatterns` exactly, and for
 * the same reasons; the two rails are siblings.
 */
export function useLibraryCompositions(): readonly Composition[] {
  return usePatternsStore((s) => s.library.compositions);
}

export function getLibraryCompositions(): readonly Composition[] {
  return store().library.compositions;
}

export function findLibraryComposition(id: string): Composition | undefined {
  return getLibraryCompositions().find((composition) => composition.id === id);
}

/** The lib's own name for a blank composition, uniquified before use. */
const BLANK_COMPOSITION_NAME = 'Untitled composition';

/**
 * A name no other composition in the library already has.
 *
 * `patternService.uniqueLibraryName`'s twin, and deliberately a second copy
 * rather than a shared helper: the two seams own different libraries and
 * `patternService` exports nothing that reaches `library.compositions` on
 * purpose. Sharing it would mean one of them importing the other's store view.
 */
function uniqueCompositionName(base: string, exceptId?: string): string {
  const taken = new Set(
    getLibraryCompositions()
      .filter((composition) => composition.id !== exceptId)
      .map((composition) => composition.name),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n <= taken.size + 1; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

/**
 * Open whatever composition was last arranged. **Creates nothing.**
 *
 * ⚠ CP-17 CHANGED THIS, and the change is the point rather than an
 * optimisation. The lib's `ensureEditingComposition` does three things in order:
 * keep the open one if it still exists, else adopt the most recently updated,
 * else CREATE "Untitled composition". This does the first two and refuses the
 * third, so arriving with an empty library lands on the page's empty state and
 * its New button instead of minting a document nobody asked for. Two things
 * follow that are worth more than the tidiness:
 *
 *   - `openBlankComposition` becomes the ONLY thing in the app that creates a
 *     composition, so "where did this come from" always has one answer.
 *   - the tier cap is reported when the user presses New, which is when it is
 *     true, rather than as a refusal on page load — which used to read as the
 *     page being broken.
 *
 * `null` IS A SUCCESS, not a failure, and the distinction is load-bearing:
 * `CompositionPage` renders `openFailure` as an alert, so a refusal here would
 * put an error on screen for the ordinary first visit. A refusal now means the
 * store genuinely would not open a composition that exists.
 *
 * The stale-id case needs no handling of its own: `getEditingComposition` reads
 * through `selectEditingComposition`, which finds nothing when the remembered id
 * has been deleted, so it falls through to the adoption below.
 */
export function ensureComposition(): Result<Composition | null> {
  const open = getEditingComposition();
  if (open) return ok(open);

  const library = getLibraryCompositions();
  if (library.length === 0) return ok(null);

  let mostRecent = library[0];
  for (const composition of library) {
    if (composition.updatedAt > mostRecent.updatedAt) mostRecent = composition;
  }
  store().openCompositionForArranging(mostRecent.id);
  // Adopting is a switch like any other — the selection and history that are
  // live belong to whatever was open before this page mounted.
  forgetPerCompositionState();
  const opened = getEditingComposition();
  if (!opened || opened.id !== mostRecent.id) {
    return refuse(`Couldn't open ${mostRecent.name}.`);
  }
  return ok(opened);
}

/**
 * Switch to another composition in the library.
 *
 * ⚠ Guarded on `jobRunning` rather than `lockedOut()`, exactly as
 * {@link openBlankComposition} is and for the same reason — the AGENT'S
 * exemption must not reach it either. Switching mid-job destroys the rollback:
 * `forgetPerCompositionState` calls `clearHistory`, which re-arms the open
 * bracket on the NEW document, so the snapshot a cancel would restore becomes
 * the wrong one and the pre-job composition is never put back.
 *
 * Re-opening what is already open still goes through the switch, unlike
 * `patternService.openPattern`'s guard. `openCompositionForArranging` sets three
 * fields and resets nothing the user would miss (there is no cursor and no
 * pending stamp on this document), and pressing the row you are already in is a
 * reasonable way to ask for a clean slate.
 */
export function openComposition(id: string): Result<Composition> {
  if (jobRunning) return refuse(JOB_LOCK_REASON);
  const target = findLibraryComposition(id);
  if (!target) return refuse(`No such composition: ${id}.`);
  store().openCompositionForArranging(id);
  forgetPerCompositionState();
  const opened = getEditingComposition();
  if (!opened || opened.id !== id) return refuse(`Couldn't open ${target.name}.`);
  return ok(opened);
}

/**
 * Rename a library composition, by id — it need not be the one that is open.
 *
 * {@link setCompositionName} is the other half and they are not duplicates: that
 * one renames whatever is OPEN and is what the header's field calls, this one
 * takes an id and is what a row in a list calls. Both exist for the reason every
 * capability here is a function first — a rename reachable only by opening the
 * document first is one an agent cannot make on a document it isn't in.
 *
 * The trim and the emptiness check are ours, matching `renamePattern`: the lib's
 * `renameComposition` writes whatever string it is given, and a composition
 * named `''` has no handle left in any list that shows it.
 *
 * `lockedOut()` rather than `jobRunning`: this changes nothing about which
 * document is open, so the agent naming the arrangement it just built is safe
 * and is exactly what {@link setCompositionName} already allows.
 */
export function renameComposition(id: string, name: string): Result<Composition> {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  const target = findLibraryComposition(id);
  if (!target) return refuse(`No such composition: ${id}.`);
  const trimmed = name.trim();
  if (trimmed === '') return refuse('A composition needs a name.');
  store().renameComposition(id, trimmed);
  const renamed = findLibraryComposition(id);
  if (!renamed || renamed.name !== trimmed) return refuse(`Couldn't rename ${target.name}.`);
  return ok(renamed);
}

/**
 * Copy a composition, tracks and placements and all. The copy is NOT opened.
 *
 * Deliberate, and `duplicatePattern`'s reasoning applies unchanged: a duplicate
 * is usually made to keep the original safe before changing it, so switching the
 * arranger away from what you were doing is the wrong default. A caller that
 * wants it open follows with `openComposition(result.value.id)`.
 *
 * ⚠ LIB-GAP(22): there is no `duplicateComposition` in the lib to mirror
 * `duplicatePattern`. The nearest action is `forkComposition(source)`, which is
 * built for forking someone else's PUBLISHED work — it takes the composition
 * object rather than an id, keeps the source's name verbatim, and stamps
 * `forkedFromId` / `forkedFromCreatorName` as provenance. Nothing in this app
 * reads those fields, so the fork is used and renamed after; the rename is not a
 * nicety, since two rows sharing one name cannot be told apart in the rail. The
 * deep copy itself is correct — fresh track ids and cloned placements — which is
 * why this masks the gap rather than hand-rolling a clone.
 */
export function duplicateComposition(id: string): Result<Composition> {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  const target = findLibraryComposition(id);
  if (!target) return refuse(`No such composition: ${id}.`);
  // ⚠ `forkComposition` OPENS what it makes and clobbers three other pointers on
  // the way — `editingCompositionId`, `editingPatternId` (CP-02's defect: `App`
  // re-seeds a demo pattern the moment nothing is open, so an uncorrected null
  // appends a junk pattern to the library on every press), `editingPlacementId`
  // and `selectedPlacementId`. It is written for forking someone's published
  // work, where landing in the fork is the point. Here it is a copy, so all four
  // are captured and put back: this function's contract is that NOTHING moves
  // except the library gaining a row.
  const before = {
    editingCompositionId: store().editingCompositionId,
    editingPatternId: store().editingPatternId,
    editingPlacementId: store().editingPlacementId,
    selectedPlacementId: store().selectedPlacementId,
  };
  const copyId = store().forkComposition(target);
  if (copyId === '') {
    usePatternsStore.setState(before);
    return refuse(`Couldn't copy ${target.name} — the library refused.`);
  }
  const forked = findLibraryComposition(copyId);
  if (!forked) {
    usePatternsStore.setState(before);
    return refuse(`Couldn't copy ${target.name}.`);
  }
  const unique = uniqueCompositionName(`${target.name} (copy)`, copyId);
  store().renameComposition(copyId, unique);
  usePatternsStore.setState(before);
  const copy = findLibraryComposition(copyId);
  if (!copy) return refuse(`Couldn't copy ${target.name}.`);
  return ok(copy);
}

/**
 * Remove a composition, and leave nothing in its place.
 *
 * ⚠ THE OPPOSITE OF `patternService.deletePattern`, deliberately. That one calls
 * `ensurePattern` afterwards so the editor is never pointed at nothing. This one
 * does NOT chase a successor, because "no composition open" is a state this page
 * already renders properly — `ArrangementGrid` has an empty state for it,
 * `syncComposition(null)` disposes the audio engine, and `TransportBar` draws
 * nothing. Opening some other arrangement because you deleted this one is a
 * surprise, and the only reason it was ever necessary is that the empty state
 * had no way out; CP-17's New button is that way out.
 *
 * The lib does the pointer work: `deleteComposition` nulls `editingCompositionId`
 * (and `editingPlacementId`) when it removes the one they point at, and leaves
 * them alone otherwise. What it cannot know about is OUR per-composition
 * state — the selection, the track selection and the undo stack — so that is
 * cleared here, and only when the document that went was the one being arranged.
 *
 * `jobRunning` rather than `lockedOut()`, on {@link openComposition}'s terms: a
 * job's rollback writes a snapshot back by id, and there is nothing to write it
 * into if the document has been deleted underneath it.
 */
export function deleteComposition(id: string): Result<Composition> {
  if (jobRunning) return refuse(JOB_LOCK_REASON);
  const target = findLibraryComposition(id);
  if (!target) return refuse(`No such composition: ${id}.`);
  const wasOpen = store().editingCompositionId === id;
  store().deleteComposition(id);
  if (wasOpen) forgetPerCompositionState();
  return ok(target);
}

/**
 * Create a fresh composition and open it for arranging.
 *
 * ⚠ Guarded on `jobRunning` rather than `lockedOut()`, so the AGENT'S exemption
 * does not reach it either — the one write in this module the job cannot make.
 * Switching composition mid-job destroys the rollback: `forgetPerCompositionState`
 * calls `clearHistory`, which re-arms the open bracket on the NEW document, so
 * the snapshot a cancel would restore becomes the blank one and the pre-job
 * composition is never put back or even reopened. No composition command lists
 * this tool, but `Command.tools` is documented as not enforcement, so the model
 * choosing it anyway has to be answered here rather than assumed away.
 *
 * An unnamed composition gets a name that is unique in the library rather than
 * the lib's flat "Untitled composition" — see {@link uniqueCompositionName}. A
 * name the caller passed is used verbatim: it said what it wanted. Reachable in
 * two clicks now that CP-17 put a New button in the rail, and two rows sharing
 * one name cannot be told apart in it.
 */
export function openBlankComposition(name?: string): Result<Composition> {
  if (jobRunning) return refuse(JOB_LOCK_REASON);
  // The lib's `createComposition` also nulls `editingPatternId`: it assumes the
  // two documents are separate PAGES, one closing as the other opens. Here they
  // are two views of one running app, and `App.tsx` re-seeds a demo pattern the
  // moment nothing is open — so leaving it nulled appends a junk pattern to the
  // library on every press. Pattern state belongs to the pattern seam; put back
  // exactly what was clobbered and nothing else.
  const priorPatternId = usePatternsStore.getState().editingPatternId;
  // `createComposition` returns '' when the tier gate declines, which is the
  // only signal it gives.
  const id = store().createComposition(name ?? uniqueCompositionName(BLANK_COMPOSITION_NAME));
  if (priorPatternId !== null && usePatternsStore.getState().editingPatternId === null) {
    usePatternsStore.setState({ editingPatternId: priorPatternId });
  }
  const composition = getEditingComposition();
  if (id === '' || composition?.id !== id) {
    return refuse("Couldn't create a composition — the library refused.");
  }
  forgetPerCompositionState();
  return ok(composition);
}

/** Selection and history are both per-composition; carrying either across a
 *  switch would undo into a composition that is no longer open. So is an open
 *  placement — it names a block in the document that just closed, and leaving it
 *  open would keep the pattern page showing that block's snapshot. */
function forgetPerCompositionState(): void {
  closePlacementEditing();
  writeSelection(NO_IDS);
  selectTrack(null);
  clearHistory();
}

// ------------------------------------------------------------ track writes ---

/**
 * Why an add past the cap is refused — the ONE authoring of it.
 *
 * Exported because the button wants the same sentence for its tooltip before
 * the press that the seam returns after it. Three paraphrases of one memory
 * budget is three things to keep in step, and the one that drifts is always the
 * one the user reads first.
 */
export const TRACK_CAP_REASON =
  `A composition can hold at most ${MAX_COMPOSITION_TRACKS} tracks — each track loads its own sample bank, and ${MAX_COMPOSITION_TRACKS} is already around 50 MB.` as const;

/**
 * The default name for the next track.
 *
 * The lib's own is `Track ${tracks.length + 1}`, which repeats itself the moment
 * a middle track is removed — add, add, remove #2, add gives two "Track 3"s. Two
 * tracks with one name is not cosmetic here: every control in the header builds
 * its accessible name out of it ("Mute Track 3", "Move Track 3 up"), so a
 * duplicate makes two headers indistinguishable to a screen reader and to any
 * by-name query. First unused number instead.
 */
function nextTrackName(tracks: readonly Track[]): string {
  const taken = new Set(tracks.map((track) => track.name));
  let n = tracks.length + 1;
  while (taken.has(`Track ${n}`)) n++;
  return `Track ${n}`;
}

/**
 * Append a track.
 *
 * The cap is refused HERE and not merely greyed out in the UI, matching the
 * precedent that built-in voices are unsaveable at the seam: the agent's tools
 * reach this module, not a button, and a rule only a button enforces is a rule
 * the agent can walk straight past. The cap is real — each sampler voice loads
 * its own sample bank.
 */
export function addTrack(name?: string, instrumentId?: FretInstrumentId): Result<Track> {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  const composition = getEditingComposition();
  if (!composition) return refuse('No composition is open.');
  if (composition.tracks.length >= MAX_COMPOSITION_TRACKS) {
    // The reason travels WITH the refusal rather than being printed next to a
    // greyed-out button, because the agent gets the refusal and not the button.
    // The number is a MEMORY limit and saying so is the difference between a
    // rule someone can plan around and one that looks arbitrary.
    return refuse(TRACK_CAP_REASON);
  }
  if (instrumentId !== undefined && !getInstrument(instrumentId)) {
    return refuse(`No such instrument: ${instrumentId}.`);
  }
  // The same non-blank rule `setTrackName` applies, for the same reason — every
  // control in the header builds its accessible name out of it, so a track added
  // as "   " gives two headers nothing to tell them apart. Omitting the name is
  // a different request and still means "number it for me".
  const trimmed = name?.trim();
  if (name !== undefined && trimmed === '') return refuse('A track needs a name.');
  const chosen = trimmed ?? nextTrackName(composition.tracks);
  commit(() => store().addCompositionTrack(chosen, instrumentId));
  const added = getTracks().at(-1);
  if (!added || added.id === composition.tracks.at(-1)?.id) {
    return refuse("Couldn't add a track.");
  }
  return ok(added);
}

/** Remove a track and everything on it. The lib refuses to remove the last
 *  remaining one — the model's invariant is at least one track. */
export function removeTrack(trackId: string): Result {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  const tracks = getTracks();
  if (!tracks.some((t) => t.id === trackId)) return refuse('No such track.');
  if (tracks.length === 1) return refuse("A composition can't have zero tracks.");
  commit(() => store().removeCompositionTrack(trackId));
  prunePlacementSelection();
  pruneTrackSelection();
  return ok(undefined);
}

/**
 * Move a track to another position in the stack.
 *
 * By INDEX and by ID, never only by dragging a header: the agent's tools reach
 * this module rather than a pointer, and a capability that exists only as a
 * gesture is one the agent cannot use. `toIndex` is CLAMPED rather than refused
 * — `moveTrack(id, 99)` means "put it last", which is the same thing the lib's
 * own `movePlacement` does with a tick past the end — and the index it landed at
 * is returned so a caller never has to re-read the store to find out.
 *
 * Undoable, unlike the mix and the naming below: which tracks exist and what
 * order they are in is the arrangement's CONTENT. The line drawn once, so the
 * next person does not have to guess it — an edit that changes what exists or
 * where it sits pushes an undo step; a setting that changes how it sounds or
 * what it is called does not, and is carried forward over a restored snapshot
 * by `mergeSettingsForward`.
 *
 * LIB-GAP(13): the lib has no track-reorder op at all — neither a pure
 * `composition-ops` function nor a store action — so the new order is computed
 * here and written with the whole-composition write above. The ARRAY WORK is
 * ours to keep either way (nothing about it is musical); what the gap is masking
 * is only the write. Delete when the lib ships `moveTrack(comp, trackId, index)`
 * plus its store action, or gains the `replaceComposition` gap 1 already wants.
 * See docs/FOLLOW-UPS.md.
 */
export function moveTrack(trackId: string, toIndex: number): Result<number> {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  const composition = getEditingComposition();
  if (!composition) return refuse('No composition is open.');
  const from = composition.tracks.findIndex((track) => track.id === trackId);
  if (from === -1) return refuse('No such track.');
  if (!Number.isFinite(toIndex)) return refuse('That is not a track position.');
  const to = Math.max(0, Math.min(composition.tracks.length - 1, Math.trunc(toIndex)));
  // Already there. Not a refusal — the caller asked for a state, and it holds —
  // but it must not write, or an undo step appears for a no-op.
  if (to === from) return ok(to);
  commit(() => {
    const tracks = [...composition.tracks];
    const [moved] = tracks.splice(from, 1);
    tracks.splice(to, 0, moved);
    storeComposition({ ...composition, tracks, updatedAt: Date.now() });
  });
  return ok(to);
}

// Naming, mix and routing are settings rather than edits to the arrangement's
// content, so — matching `patternService`'s treatment of loop, tempo and voice —
// they push no undo step. Nor are they DESTROYED by one: `writeCompositionBack`
// carries them forward over the restored snapshot, which is where that decision
// is implemented and explained.
//
// They do all guard their id, because the lib's track ops apply `replaceTrack`
// and return a bumped composition whether or not anything matched — an unknown
// id would otherwise persist a phantom write and re-render every subscriber
// while telling the caller nothing. They also skip a write that would set the
// value already there, so a fader dragged across a value it passes through
// doesn't persist the composition once per pointermove.

/**
 * Rename a track.
 *
 * The empty-name rule is enforced HERE and not only in the rename field, for
 * `addTrack`'s reason: the agent's tools reach this module rather than a
 * control, and a rule only a control enforces is a rule the agent walks past. A
 * blank name is not merely an empty plate — every accessible name in the header
 * is built from it, so it blanks "Mute ", "Solo ", "Instrument for ". The field
 * still DROPS an emptied draft rather than showing this refusal, because
 * clearing a box and tabbing away does not mean "call it nothing".
 */
export function setTrackName(trackId: string, name: string): Result {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  const track = findTrack(trackId);
  if (!track) return refuse('No such track.');
  const trimmed = name.trim();
  if (trimmed === '') return refuse('A track needs a name.');
  if (track.name === trimmed) return ok(undefined);
  store().setCompositionTrackName(trackId, trimmed);
  return ok(undefined);
}

/**
 * Put a track on another instrument.
 *
 * **Allowed with a placed arrangement on it, and never silently** — the CP-07
 * decision, written down here because the alternative reading is reasonable and
 * somebody will re-litigate it. Refusing would make the picker dead on any track
 * that has been arranged, and "guitar part, actually wanted an octave down on
 * bass" is a real intent, not a mistake. But the cost is real too and invisible:
 * a placement keeps its OWN snapshot instrument, and playback resolves pitch
 * through the TRACK's tuning, dropping any note whose string the new instrument
 * hasn't got. So the seam applies the change and {@link strandedByInstrument} /
 * {@link mismatchedPlacements} exist to let the surface state the cost BEFORE
 * the write and keep stating it afterwards. Silence is the one wrong answer;
 * refusal is merely the unhelpful one.
 *
 * ── CP-13: this write DESTROYS the track's voice override, and says so first ──
 *
 * The lib CLEARS `Track.voiceRef` here (the chosen voice may have been for the
 * old instrument), this write pushes no undo step, and `mergeSettingsForward`
 * carries the CLEARED ref forward over a restored snapshot — so instrument
 * A → B → A loses a per-track voice with no route back at all, by undo or
 * otherwise. CP-13 wired a picker, which put that three clicks away.
 *
 * THE ANSWER IS THE CONFIRMATION, not undo. `TrackControls` now asks whenever a
 * track HAS an override, whether or not the change also strands notes, and names
 * the loss. The alternative — dropping `voiceRef` from `mergeSettingsForward` so
 * this one write became undoable — was rejected: that field is carried forward
 * precisely because the mix and the naming push no undo step of their own, and
 * an undo of some unrelated arrangement edit would then silently revert a voice
 * pick made after the snapshot was captured, destroying it (a later edit clears
 * the redo stack). That trades a loss the user was warned about for a quieter one
 * they were not, and reverses a settled CP-06/CP-07 decision to do it. If this is
 * ever revisited, the honest fix is an undo step for the instrument write itself,
 * not an exception in the merge.
 */
export function setTrackInstrument(
  trackId: string,
  instrumentId: FretInstrumentId,
): Result {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  const track = findTrack(trackId);
  if (!track) return refuse('No such track.');
  // Membership checked rather than trusted, as on the pattern side: an id the
  // catalog hasn't got leaves the track pointing at an instrument that does not
  // exist, and every read then answers with the fallback instead.
  if (!getInstrument(instrumentId)) return refuse(`No such instrument: ${instrumentId}.`);
  // Guarded on the instrument alone, deliberately: the lib clears the track's
  // voice override as part of this write, because the chosen voice may have been
  // for the old instrument — and a picker re-emitting the value it already has
  // must not throw the voice away.
  if (track.instrumentId === instrumentId) return ok(undefined);
  store().setCompositionTrackInstrument(trackId, instrumentId);
  return ok(undefined);
}

/**
 * Which voice this track plays through.
 *
 * `unknown` because it is `unknown` on `Track`, exactly as on `Pattern`: the lib
 * keeps its pattern model independent of the voices module and documents casting
 * at use. `src/voice/voiceService.ts` owns that cast — this seam stores and
 * returns it opaquely and must not narrow it.
 *
 * Locked like every other track write. It reaches the seam through a DIFFERENT
 * tool group (`voice_set_for_track`, which the `composition-track-voice` command
 * calls), which is why `src/ai/tools/index.ts` marks every list as the job's and
 * not just `COMPOSITION_TOOLS` — otherwise this guard would refuse a composition
 * command its own tool.
 */
export function setTrackVoiceRef(trackId: string, voiceRef: unknown): Result {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  const track = findTrack(trackId);
  if (!track) return refuse('No such track.');
  // Reference equality, not a deep one: the value is opaque here by charter, so
  // this seam has no business knowing what makes two of them the same.
  if (track.voiceRef === voiceRef) return ok(undefined);
  store().setCompositionTrackVoiceRef(trackId, voiceRef);
  return ok(undefined);
}

/**
 * A track's fader, in dB. Returns the value actually STORED.
 *
 * Clamped here rather than only in the lib, and the returned value is the
 * clamped one, because the lib clamps silently and — unlike `setMasterVolumeDb`
 * — does not return the same composition when nothing changed. Comparing the
 * REQUEST against the stored value would then make `setTrackVolumeDb(id, -100)`
 * write on every call forever, bumping `updatedAt` and re-rendering every
 * subscriber while reporting plain `ok`. A slider cannot produce an
 * out-of-range value; the agent can, and it is the caller least able to notice
 * a silent coercion.
 */
export function setTrackVolumeDb(trackId: string, volumeDb: number): Result<number> {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  const track = findTrack(trackId);
  if (!track) return refuse('No such track.');
  if (!Number.isFinite(volumeDb)) return refuse('That is not a volume.');
  const clamped = clampDb(volumeDb);
  if (track.volumeDb === clamped) return ok(clamped);
  store().setCompositionTrackVolumeDb(trackId, clamped);
  return ok(clamped);
}

/**
 * Where a track sits in the stereo field. Returns the value actually STORED.
 *
 * The fader's shape exactly, and for the fader's reasons: the lib clamps
 * silently and returns a bumped composition either way, so comparing the
 * REQUEST against the stored value would make `setTrackPan(id, 5)` write on
 * every call forever. This control is DRAGGED, which makes that the difference
 * between one write and one per pointermove.
 *
 * Not undoable, like the rest of the mix — track structure is undoable, where a
 * track sits in the picture is not.
 *
 * The VOICE has a pan of its own and the two stack. This one is the mix
 * decision; the voice's belongs to the sound and lives in the Sound Lab.
 */
export function setTrackPan(trackId: string, pan: number): Result<number> {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  const track = findTrack(trackId);
  if (!track) return refuse('No such track.');
  if (!Number.isFinite(pan)) return refuse('That is not a pan position.');
  const clamped = clampPan(pan);
  // `?? 0` because a track persisted before CP-19 has no `pan` at all — a raw
  // comparison would read undefined !== 0 and write on the first centring call.
  if ((track.pan ?? 0) === clamped) return ok(clamped);
  store().setCompositionTrackPan(trackId, clamped);
  return ok(clamped);
}

/**
 * How hard a track drives its own voice, in dB, at the front of the chain.
 *
 * NOT the fader. `setTrackVolumeDb` is downstream of the whole voice and changes
 * how loud its output is; this is upstream of the pedals, the EQ and the amp and
 * changes how hard the amp is driven. Pulling the fader down on an overdriven
 * track gives a quieter copy of the same distortion, which is the confusion this
 * control exists to end.
 *
 * On the TRACK rather than the voice preset on purpose: a preset is chosen and
 * swapped, so an input level stored there is reset every time the user auditions
 * another amp. See `Track.inputGainDb` in the lib for the whole argument.
 */
export function setTrackInputGainDb(trackId: string, inputGainDb: number): Result<number> {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  const track = findTrack(trackId);
  if (!track) return refuse('No such track.');
  if (!Number.isFinite(inputGainDb)) return refuse('That is not an input gain.');
  const clamped = Math.max(
    TRACK_INPUT_GAIN_RANGE_DB.min,
    Math.min(TRACK_INPUT_GAIN_RANGE_DB.max, inputGainDb),
  );
  // `?? 0` for `pan`'s reason — a track that has never had one reads undefined,
  // and a raw comparison would write on the first call that asks for unity.
  if ((track.inputGainDb ?? 0) === clamped) return ok(clamped);
  store().setCompositionTrackInputGainDb(trackId, clamped);
  return ok(clamped);
}

export function setTrackMuted(trackId: string, muted: boolean): Result {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  const track = findTrack(trackId);
  if (!track) return refuse('No such track.');
  if (track.muted === muted) return ok(undefined);
  store().setCompositionTrackMuted(trackId, muted);
  return ok(undefined);
}

export function setTrackSoloed(trackId: string, soloed: boolean): Result {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  const track = findTrack(trackId);
  if (!track) return refuse('No such track.');
  if (track.soloed === soloed) return ok(undefined);
  store().setCompositionTrackSoloed(trackId, soloed);
  return ok(undefined);
}

/** The composition's output fader, in dB — the one gain every track passes
 *  through. Reports the missing composition rather than no-opping into it, for
 *  the same reason every other write here does, and returns the value actually
 *  stored for {@link setTrackVolumeDb}'s. */
export function setMasterVolumeDb(masterVolumeDb: number): Result<number> {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  if (!getEditingComposition()) return refuse('No composition is open.');
  if (!Number.isFinite(masterVolumeDb)) return refuse('That is not a volume.');
  const clamped = clampDb(masterVolumeDb);
  store().setCompositionMasterVolumeDb(clamped);
  return ok(clamped);
}

// -------------------------------------------------------- placement writes ---

/**
 * Drop a copy of a library pattern onto a track.
 *
 * `patternSnapshot` is DEEP-COPIED at placement time — a settled decision, not an
 * oversight (tickets/composition-page/README.md). Editing the library pattern
 * afterwards does not touch the placement and vice versa. The snapshot keeps the
 * source pattern's id, which is the provenance a future linked mode would need.
 */
export function addPlacement(
  patternId: string,
  trackId: string,
  atTick?: Tick,
): Result<string> {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  // Named separately from the pattern/track refusal below: the lib returns the
  // same `null` for "nothing is open" as for "no such id", and telling a caller
  // to check ids it got right is the unrecoverable kind of wrong answer.
  if (!getEditingComposition()) return refuse('No composition is open.');
  const placementId = commit(() =>
    store().addPlacementToTrack(patternId, trackId, atTick),
  );
  if (placementId === null) {
    return refuse("Couldn't place that pattern — unknown pattern or track.");
  }
  writeSelection([placementId]);
  return ok(placementId);
}

/**
 * Every placement id in the composition, for the before/after diffs the writes
 * that MINT ids have to do.
 *
 * LIB-GAP(20): `composition-ops` knows exactly which placements it created —
 * `splitPlacement` and `duplicatePlacements` build them — and the store's
 * actions return `void`, so the only way back to them is to diff the document
 * around the call. See docs/FOLLOW-UPS.md.
 */
function placementIds(): readonly string[] {
  return getTracks().flatMap((track) => track.placements.map((p) => p.id));
}

/**
 * Move a placement, possibly to another track, reporting where it landed.
 *
 * The lib BLOCKS/CLAMPS rather than rejecting: the block lands in the free slot
 * nearest the requested tick and never overlaps or pushes a neighbour. So the
 * refusals are only the ids, and the landing tick is returned because it is
 * routinely NOT the one asked for — a caller that cannot see the grid would
 * otherwise carry on believing the block is where it aimed it.
 */
export function movePlacement(
  placementId: string,
  destTrackId: string,
  destStartTick: Tick,
): Result<{ trackId: string; startTick: Tick }> {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  if (!findPlacement(placementId)) return refuse('No such block in this composition.');
  if (!findTrack(destTrackId)) return refuse('No such track.');
  commit(() => store().movePlacement(placementId, destTrackId, destStartTick));
  const landed = findPlacement(placementId);
  if (!landed) return refuse('No such block in this composition.');
  return ok({ trackId: landed.track.id, startTick: landed.placement.startTick });
}

/**
 * Cut a placement in two, reporting the two halves.
 *
 * Both halves are NEW placements with new ids — the original is discarded — so
 * the selection has to be reconciled or it keeps naming a block that no longer
 * exists and every later gesture no-ops. For the same reason the new ids are
 * RETURNED: without them a caller holding the old id is holding nothing, and
 * finding the halves means diffing the whole composition.
 *
 * A split at the block's own edge is declined by the lib (it would produce a
 * zero-length half), which is reference-identical to no write at all — hence
 * the diff rather than a trust in "it must have worked".
 */
export function splitPlacement(placementId: string, atTick: Tick): Result<readonly string[]> {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  if (!findPlacement(placementId)) return refuse('No such block in this composition.');
  const before = new Set(placementIds());
  commit(() => store().splitPlacement(placementId, atTick));
  prunePlacementSelection();
  const created = placementIds().filter((id) => !before.has(id));
  if (created.length === 0) {
    return refuse(
      `Nothing to split at tick ${atTick} — the cut has to fall inside the block, not on its edge.`,
    );
  }
  return ok(created);
}

/** Truncate a placement to `lengthTicks`, reporting the length that stuck.
 *  Clamped to at least one beat and at most the snapshot's own duration (and by
 *  the next block on the track); a legacy `repeat > 1` collapses to 1. */
export function resizePlacement(placementId: string, lengthTicks: Tick): Result<Tick> {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  const found = findPlacement(placementId);
  if (!found) return refuse('No such block in this composition.');
  commit(() => store().resizePlacement(placementId, lengthTicks));
  const after = findPlacement(placementId)?.placement;
  return ok(after?.lengthTicks ?? placementEffectiveLength(found.placement));
}

/**
 * Non-destructive render-time pitch shift, clamped by the lib to ±24 — and it
 * PRICES ITSELF.
 *
 * LIB-GAP(12): `flattenComposition` silently DROPS any event whose transposed
 * fret leaves `0..fretCount`, so a transposition can delete a part from playback
 * with no trace. `PlacementBlock` shows the count as a badge; a caller with no
 * screen has to be TOLD, so the applied shift and the number of notes it costs
 * come back with the write. `droppedByTranspose` is the same restatement of the
 * lib's rule the badge uses — one function, so the two can't disagree — and it
 * goes when that gap does. See docs/FOLLOW-UPS.md.
 */
export function setPlacementTranspose(
  placementId: string,
  semitones: number,
): Result<{ semitones: number; droppedNotes: number }> {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  if (!findPlacement(placementId)) return refuse('No such block in this composition.');
  if (!Number.isFinite(semitones)) return refuse('That is not a number of semitones.');
  commit(() => store().setPlacementTranspose(placementId, semitones));
  const after = findPlacement(placementId)?.placement;
  if (!after) return refuse('No such block in this composition.');
  return ok({
    semitones: after.transposeSemitones ?? 0,
    droppedNotes: droppedByTranspose(after),
  });
}

export function removePlacement(placementId: string): Result {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  if (!findPlacement(placementId)) return refuse('No such block in this composition.');
  commit(() => store().removePlacement(placementId));
  prunePlacementSelection();
  return ok(undefined);
}

/**
 * Clone placements with their start ticks offset, reporting the clones' ids —
 * which the lib mints and does not return (LIB-GAP(20), see
 * {@link placementIds}). `destTrackId` sends every clone to one track; omitting
 * it clones each within its own.
 *
 * ⚠ The ids come back in DOCUMENT order — track by track, then by start tick —
 * and not in the order `ids` was given, because they are recovered by diffing
 * the composition rather than reported by the op. A caller that needs to pair an
 * original with its clone has to match on position.
 */
export function duplicatePlacements(
  ids: readonly string[],
  deltaTicks: Tick,
  destTrackId?: string,
): Result<readonly string[]> {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  if (ids.length === 0) return ok([]);
  const missing = ids.filter((id) => !findPlacement(id));
  if (missing.length > 0) return refuse(`No such block: ${missing.join(', ')}.`);
  if (destTrackId !== undefined && !findTrack(destTrackId)) return refuse('No such track.');
  const before = new Set(placementIds());
  commit(() => store().duplicatePlacements([...ids], deltaTicks, destTrackId));
  return ok(placementIds().filter((id) => !before.has(id)));
}

// ------------------------------------------------------- placement editing ---
// CP-11. Note there is deliberately NO `setPlacementSnapshot` here: the lib
// already routes note edits at a placement, so the whole of edit mode is
// "point the store at the right block" plus the surface that draws it.
//
//   openPlacementForEditing(compositionId, placementId)   // the lib's action
//     → currentEditTarget() resolves to placement.patternSnapshot
//     → updateTarget() writes back to the placement, not the library
//
// Every existing `patternService` note operation therefore works on a placement
// unchanged. The one write-back that is NOT an ordinary edit — restoring an undo
// snapshot — routes the same way inside `patternService.writePatternBack`, which
// is where the corresponding LIB-GAP(17) note lives.

/**
 * The library pattern that was open when placement editing began.
 *
 * ⚠ THE CROSS-PAGE LEAK THIS EXISTS TO CLOSE. `selectEditingPattern` **is**
 * `currentEditTarget()?.pattern`, and `useEditingPattern()` is what the PATTERN
 * PAGE and `App` read — so while a placement is open the pattern page would show
 * that placement's snapshot. Worse, `openPlacementForEditing` sets
 * `editingPatternId: null` OUTRIGHT: the library pattern is closed, not merely
 * shadowed, and `App`'s `ensurePattern` effect would adopt whatever pattern was
 * updated most recently on the way back.
 *
 * Same family as the CP-02 defect where `openBlankComposition` nulled the
 * pointer and `App` answered by creating a junk pattern on every call — and
 * fixed the same way: remember exactly what was clobbered and put it back.
 * Captured on the way IN and restored on every way OUT.
 *
 * ⚠ Captured on the VALUE, never on "is a placement already open". The obvious
 * guard — only remember when `editingPlacementId` is null, so switching between
 * blocks doesn't overwrite this with the null the first switch left — is WRONG,
 * because the lib clears `editingPlacementId` behind our back: `removePlacement`
 * nulls it when the open block is the one being removed, and restores nothing.
 * Open a placement, remove it, open another, and that guard would happily record
 * `null` and forget the pattern for good. Testing the value covers both: a null
 * is never worth remembering, and a non-null one is only ever there because
 * nothing of ours has taken the pointer yet.
 */
let patternIdBeforePlacementEdit: string | null = null;

/** Put the pattern pointer back if we are the ones holding it. Idempotent, so
 *  every exit path can call it without checking whether another already has. */
function restorePatternPointer(): void {
  const remembered = patternIdBeforePlacementEdit;
  patternIdBeforePlacementEdit = null;
  if (remembered === null) return;
  // Something else has already opened a pattern (the user switched pages and
  // picked one); putting the old id back would close it under them.
  if (usePatternsStore.getState().editingPatternId !== null) return;
  // The lib's own action, not a raw `setState`: it clears `selectedEventIds`,
  // `cursorTick` and `pendingChordStamp` along with setting the pointer, and
  // that is not tidiness. `snapshotPatternForPlacement` copies events VERBATIM,
  // ids included, so the ids selected inside a placement exist in the library
  // pattern too — leaving them selected would hand the pattern page a live
  // selection the user made somewhere else, and the next Backspace would delete
  // from a document they were not editing.
  store().openPatternForEditing(remembered);
}

/** React hook: which placement the note editor is pointed at, or null. */
export function useEditingPlacementId(): string | null {
  return usePatternsStore((s) => s.editingPlacementId);
}

/** Non-reactive read — for event handlers and tests. */
export function getEditingPlacementId(): string | null {
  return usePatternsStore.getState().editingPlacementId;
}

/**
 * Point the note editor at a placement, BY ID — no pointer required, which is
 * the standing rule for every capability here.
 *
 * Already-open is `ok`, not a refusal: the caller asked for a state and it
 * holds, and re-opening would clear the selection and the cursor for nothing.
 *
 * Pattern history is cleared on every move of the target, and that is not
 * housekeeping: `history` is per-document, and `writePatternBack` writes to
 * WHICHEVER target is current — so an undo carried across a switch would stamp
 * one block's old notes into another block.
 *
 * ⚠ COVERED BY THE JOB LOCK, and this is the write that had to be. The lib keeps
 * ONE pattern-editing pointer, and a composition job creates patterns
 * (`pattern_open_blank` is in `composition-bass-line`'s tool list) — so a user
 * entering edit mode mid-job would repoint that pointer out from under the job,
 * and the agent's next note would be stamped into the user's block. Refusing it
 * HERE is what makes "edit mode is unavailable during a job" fall out of the
 * same mechanism as every other refusal, rather than being a special case
 * someone has to remember to add to the grid.
 */
export function openPlacementForEditing(placementId: string): Result<string> {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  const composition = getEditingComposition();
  if (!composition) return refuse('No composition is open.');
  if (!findPlacement(placementId)) return refuse('No such block in this composition.');

  const state = usePatternsStore.getState();
  if (state.editingPlacementId === placementId) return ok(placementId);
  // On the VALUE, not on `editingPlacementId === null` — see the note on the
  // variable: the lib nulls that pointer itself when the open block is removed.
  if (state.editingPatternId !== null) {
    patternIdBeforePlacementEdit = state.editingPatternId;
  }
  store().openPlacementForEditing(composition.id, placementId);
  clearPatternHistory();
  return ok(placementId);
}

/**
 * Close placement editing and put the pattern pointer back.
 *
 * Must run on EVERY exit — leaving edit mode, leaving the composition page, and
 * unmount — because all three leave the pattern page pointed at a snapshot
 * otherwise. Safe to call when nothing is open, which is what lets the caller
 * wire it to a mode effect's cleanup and stop thinking about it.
 *
 * `openCompositionForArranging` is the lib's own documented way back. It also
 * nulls the store's `selectedPlacementId`, so this seam's multi-selection —
 * which is kept pointed at that single id — is emptied with it rather than left
 * naming a block the store no longer agrees is selected.
 */
export function closePlacementEditing(): Result<void> {
  const state = usePatternsStore.getState();
  if (state.editingPlacementId !== null) {
    store().openCompositionForArranging(state.editingCompositionId);
    writeSelection(NO_IDS);
    clearPatternHistory();
  }
  // Unconditional: the lib clears `editingPlacementId` behind our back when the
  // placement being edited is removed, so "nothing is open" is not proof that
  // the pointer was never taken.
  restorePatternPointer();
  return ok(undefined);
}

// ---------------------------------------------------- composition settings ---

// Each of these reports the missing composition rather than no-opping into it,
// for the reason every other write in this module does: an agent that cannot see
// the page needs "nothing is open" to be a sentence, not a silence.

/** Returns the name actually STORED, which is the trimmed one — a caller that
 *  echoed its own argument back would be reporting a value the document does not
 *  hold. */
export function setCompositionName(name: string): Result<string> {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  const composition = getEditingComposition();
  if (!composition) return refuse('No composition is open.');
  const trimmed = name.trim();
  // The same rule tracks have, for the same reason: every accessible name on the
  // page is built out of it, and a blank one blanks them all.
  if (trimmed === '') return refuse('A composition needs a name.');
  store().renameComposition(composition.id, trimmed);
  return ok(trimmed);
}

/**
 * The composition's tempo. Pushed into the metronome on play; not the
 * metronome's live value until then.
 *
 * Locked during a job even though it sits on the transport bar next to play and
 * stop, which are NOT: the tempo is stored on the document and the transport is
 * not. Listening while the arrangement builds has to keep working; rewriting the
 * document under the agent does not.
 */
export function setCompositionBpm(bpm: number): Result {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  const composition = getEditingComposition();
  if (!composition) return refuse('No composition is open.');
  if (!Number.isFinite(bpm) || bpm <= 0) return refuse('That is not a tempo.');
  store().setCompositionBpm(composition.id, bpm);
  return ok(undefined);
}

/** The meters this app offers, and the only ones it accepts — the lib's own
 *  catalog rather than a list of our own, so the picker and the seam cannot
 *  drift apart and a meter the metronome cannot click is never storable. */
export const TIME_SIGNATURE_OPTIONS = TIME_SIGNATURES;

/** The click subdivisions the metronome has settings for. Ours to state because
 *  `SubdivisionId` is a type and a type cannot be iterated at runtime — a picker
 *  needs the values and the seam needs to check them. */
/** Re-exported so the tools file can name both without importing the lib — a
 *  charter test asserts it reaches the lib only through this seam. The list
 *  itself belongs to `patternService`, which this module already imports and
 *  which both seams need it for; one authoring, two addresses. */
export type { SubdivisionId };
export { SUBDIVISION_OPTIONS };

/**
 * The composition's meter — saved ON THE DOCUMENT, which is the whole point.
 *
 * It drives the arrangement's bars, its width and its ruler (`ArrangementGrid`
 * reads `composition.timeSignature`), so it has to survive a reload and travel
 * with the composition. Making the click follow it is a separate, additional
 * write to the metronome store, and the caller does both — see `TransportBar`.
 *
 * ⚠ CHECKED AGAINST THE LIB'S CATALOG (CP-18), where it used to take anything.
 * The seam is reachable by value with no pointer, and `ticksPerBar` is
 * `numerator * (PPQ * 4 / denominator)` — so a 4/7 bar is 1097.142… ticks and no
 * bar after the first starts on one. `composition_place_pattern` already has to
 * refuse bar input in exactly that case; refusing the meter itself means it
 * never arises, and it also means every stored meter is one the metronome can
 * actually click.
 */
export function setCompositionTimeSignature(
  timeSignature: PatternTimeSignature,
): Result {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  const composition = getEditingComposition();
  if (!composition) return refuse('No composition is open.');
  const known = TIME_SIGNATURE_OPTIONS.some(
    (option) =>
      option.numerator === timeSignature.numerator &&
      option.denominator === timeSignature.denominator,
  );
  if (!known) {
    return refuse(
      `${timeSignature.numerator}/${timeSignature.denominator} is not one of the meters this app plays: ${TIME_SIGNATURE_OPTIONS.map((option) => option.id).join(', ')}.`,
    );
  }
  store().setCompositionTimeSignature(composition.id, timeSignature);
  return ok(undefined);
}

/**
 * The composition's click subdivision — also saved on the document.
 *
 * The lib documents `null` as "use the metronome's current value at play time",
 * which is what an untouched composition carries. Nothing here writes null back:
 * `off` already means no sub-clicks, and two ways to say nearly-nothing is a
 * worse control than one. A null on an older document reads as `off`.
 */
export function setCompositionSubdivision(subdivision: SubdivisionId): Result {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  const composition = getEditingComposition();
  if (!composition) return refuse('No composition is open.');
  if (!SUBDIVISION_OPTIONS.includes(subdivision)) {
    return refuse(
      `${subdivision} is not one of the click subdivisions: ${SUBDIVISION_OPTIONS.join(', ')}.`,
    );
  }
  store().setEditingCompositionSubdivision(subdivision);
  return ok(undefined);
}

/** Whether arrangement playback repeats. Stored on the composition rather than
 *  in transport state, so it survives reopening — as it is for patterns. */
export function setCompositionLoop(loop: boolean): Result {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  const composition = getEditingComposition();
  if (!composition) return refuse('No composition is open.');
  store().setCompositionLoop(composition.id, loop);
  return ok(undefined);
}

/**
 * The composition's feel, by preset id — see {@link listGrooves}.
 *
 * The lib's `grooveMode` decides whether this is the WHOLE arrangement's feel
 * ('global') or only the fallback for placements whose source pattern has none
 * ('inherit'). `createEmptyComposition` sets 'global' and nothing in this app
 * changes it, so this is the arrangement's feel — verified rather than assumed,
 * because setting a groove that is only a fallback would look identical from
 * here and be inaudible.
 */
export function setCompositionGroove(grooveId: GrooveId): Result {
  if (lockedOut()) return refuse(JOB_LOCK_REASON);
  if (!getEditingComposition()) return refuse('No composition is open.');
  const preset = GROOVE_PRESETS.find((candidate) => candidate.id === grooveId);
  if (!preset) return refuse(`No such groove: ${grooveId}.`);
  store().setEditingCompositionGroove(preset.groove);
  return ok(undefined);
}

/** The open composition's feel, as an id — the read half of
 *  {@link setCompositionGroove}. `'custom'` for a spec matching no named preset;
 *  null when nothing is open. */
export function compositionGrooveId(): GroovePresetId | null {
  const composition = getEditingComposition();
  if (!composition) return null;
  return presetMatching(composition.groove ?? null);
}
