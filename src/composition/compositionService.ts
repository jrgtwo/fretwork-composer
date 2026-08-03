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
  INSTRUMENTS,
  MAX_COMPOSITION_TRACKS,
  getInstrument,
  placementEffectiveLength,
  placementEndTick,
  selectEditingComposition,
  usePatternsStore,
  type Composition,
  type FretInstrumentId,
  type PatternTimeSignature,
  type Placement,
  type Tick,
  type Track,
} from '@fretwork/lib';
import { createHistory } from '../patterns/history';
// The PATTERN seam's history, cleared whenever the edit target moves — see
// `openPlacementForEditing`. One-directional: `patternService` imports nothing
// from here, so there is no cycle to reason about.
import { clearHistory as clearPatternHistory } from '../patterns/patternService';

export { MAX_COMPOSITION_TRACKS, placementEffectiveLength, placementEndTick };

type SelectionMode = 'replace' | 'add' | 'toggle';

/**
 * Every write that can be refused reports it rather than throwing or silently
 * doing nothing. The lib's actions return `void` and simply no-op when they
 * decline (past the track cap, on the last remaining track, on an unknown id),
 * which leaves a caller unable to tell "done" from "declined" — the seam is
 * where that distinction is recovered.
 */
export type Result<T = void> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const refuse = (reason: string): Result<never> => ({ ok: false, reason });

const store = () => usePatternsStore.getState();

const NO_TRACKS: readonly Track[] = [];
const NO_IDS: readonly string[] = [];

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
 */
function arrangementEnd(composition: Composition): Tick {
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
  return composition ? arrangementEnd(composition) : 0;
}

/** React hook form of {@link totalDurationTicks}, for the ruler's extent. */
export function useTotalDurationTicks(): Tick {
  return usePatternsStore((s) => {
    const composition = selectEditingComposition(s);
    return composition ? arrangementEnd(composition) : 0;
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

function writeCompositionBack(snapshot: Composition): void {
  const live = getEditingComposition();
  storeComposition(
    live && live.id === snapshot.id ? mergeSettingsForward(snapshot, live) : snapshot,
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

export function undo(): void {
  const current = getEditingComposition();
  if (!current) return;
  const previous = history.undo(current);
  if (!previous) return;
  writeCompositionBack(previous);
  prunePlacementSelection();
  pruneTrackSelection();
}

export function redo(): void {
  const current = getEditingComposition();
  if (!current) return;
  const next = history.redo(current);
  if (!next) return;
  writeCompositionBack(next);
  prunePlacementSelection();
  pruneTrackSelection();
}

export function clearHistory(): void {
  gestureSnapshot = null;
  gestureDepth = 0;
  history.clear();
}

/** React hook: whether undo/redo are currently available. */
export function useHistoryState(): { canUndo: boolean; canRedo: boolean } {
  const canUndo = useSyncExternalStore(history.subscribe, history.canUndo, history.canUndo);
  const canRedo = useSyncExternalStore(history.subscribe, history.canRedo, history.canRedo);
  return { canUndo, canRedo };
}

// ------------------------------------------------------------- lifecycle ---

/**
 * Open whatever composition was last arranged, seeding a draft if there is none.
 *
 * Verified rather than assumed: `ensureEditingComposition` runs the subscription
 * gate and returns WITHOUT CREATING and WITHOUT ERROR if it is refused. The free
 * cap is 500 compositions so it succeeds in practice, but a page that renders
 * empty with no explanation is the worst possible way to find out otherwise.
 */
export function ensureComposition(): Result<Composition> {
  const openBefore = getEditingComposition()?.id ?? null;
  store().ensureEditingComposition();
  const composition = getEditingComposition();
  if (!composition) {
    return refuse("Couldn't open a composition — the library refused to create one.");
  }
  // Not always a no-op: when the remembered id is stale the store opens the
  // most-recently-updated composition instead, which is a switch like any other.
  if (composition.id !== openBefore) forgetPerCompositionState();
  return ok(composition);
}

/** Create a fresh composition and open it for arranging. */
export function openBlankComposition(name?: string): Result<Composition> {
  // The lib's `createComposition` also nulls `editingPatternId`: it assumes the
  // two documents are separate PAGES, one closing as the other opens. Here they
  // are two views of one running app, and `App.tsx` re-seeds a demo pattern the
  // moment nothing is open — so leaving it nulled appends a junk pattern to the
  // library on every press. Pattern state belongs to the pattern seam; put back
  // exactly what was clobbered and nothing else.
  const priorPatternId = usePatternsStore.getState().editingPatternId;
  // `createComposition` returns '' when the tier gate declines, which is the
  // only signal it gives.
  const id = store().createComposition(name);
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
  const composition = getEditingComposition();
  if (!composition) return refuse('No composition is open.');
  if (composition.tracks.length >= MAX_COMPOSITION_TRACKS) {
    // The reason travels WITH the refusal rather than being printed next to a
    // greyed-out button, because the agent gets the refusal and not the button.
    // The number is a MEMORY limit and saying so is the difference between a
    // rule someone can plan around and one that looks arbitrary.
    return refuse(TRACK_CAP_REASON);
  }
  const chosen = name ?? nextTrackName(composition.tracks);
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
 * TODO(CP-13): the lib CLEARS `Track.voiceRef` as part of this write (the chosen
 * voice may have been for the old instrument), and this write pushes no undo
 * step — so once CP-13 wires `setTrackVoiceRef` to a control, instrument →A →B
 * →A loses a per-track voice override with no route back. `mergeSettingsForward`
 * carries the CLEARED ref forward over a restored snapshot, so undo cannot
 * recover it either. Whoever wires that picker owns the answer: mention the loss
 * in the confirmation, or make this one write undoable.
 */
export function setTrackInstrument(
  trackId: string,
  instrumentId: FretInstrumentId,
): Result {
  const track = findTrack(trackId);
  if (!track) return refuse('No such track.');
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
 */
export function setTrackVoiceRef(trackId: string, voiceRef: unknown): Result {
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
  const track = findTrack(trackId);
  if (!track) return refuse('No such track.');
  if (!Number.isFinite(volumeDb)) return refuse('That is not a volume.');
  const clamped = clampDb(volumeDb);
  if (track.volumeDb === clamped) return ok(clamped);
  store().setCompositionTrackVolumeDb(trackId, clamped);
  return ok(clamped);
}

export function setTrackMuted(trackId: string, muted: boolean): Result {
  const track = findTrack(trackId);
  if (!track) return refuse('No such track.');
  if (track.muted === muted) return ok(undefined);
  store().setCompositionTrackMuted(trackId, muted);
  return ok(undefined);
}

export function setTrackSoloed(trackId: string, soloed: boolean): Result {
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
  const placementId = commit(() =>
    store().addPlacementToTrack(patternId, trackId, atTick),
  );
  if (placementId === null) {
    return refuse("Couldn't place that pattern — unknown pattern or track.");
  }
  writeSelection([placementId]);
  return ok(placementId);
}

/** Move a placement, possibly to another track. The lib BLOCKS/CLAMPS rather
 *  than rejecting: the block lands in the free slot nearest the requested tick
 *  and never overlaps or pushes a neighbour. */
export function movePlacement(
  placementId: string,
  destTrackId: string,
  destStartTick: Tick,
): void {
  commit(() => store().movePlacement(placementId, destTrackId, destStartTick));
}

/** Cut a placement in two. Both halves are NEW placements with new ids — the
 *  original is discarded — so the selection has to be reconciled or it keeps
 *  naming a block that no longer exists and every later gesture no-ops. */
export function splitPlacement(placementId: string, atTick: Tick): void {
  commit(() => store().splitPlacement(placementId, atTick));
  prunePlacementSelection();
}

/** Truncate a placement to `lengthTicks`. Clamped to at least one beat and at
 *  most the snapshot's own duration; a legacy `repeat > 1` collapses to 1. */
export function resizePlacement(placementId: string, lengthTicks: Tick): void {
  commit(() => store().resizePlacement(placementId, lengthTicks));
}

/** Non-destructive render-time pitch shift, clamped by the lib to ±24. */
export function setPlacementTranspose(placementId: string, semitones: number): void {
  commit(() => store().setPlacementTranspose(placementId, semitones));
}

export function removePlacement(placementId: string): void {
  commit(() => store().removePlacement(placementId));
  prunePlacementSelection();
}

/** Clone placements with their start ticks offset. `destTrackId` sends every
 *  clone to one track; omitting it clones each within its own. */
export function duplicatePlacements(
  ids: readonly string[],
  deltaTicks: Tick,
  destTrackId?: string,
): void {
  if (ids.length === 0) return;
  commit(() => store().duplicatePlacements([...ids], deltaTicks, destTrackId));
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
 */
export function openPlacementForEditing(placementId: string): Result<string> {
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

export function setCompositionName(name: string): void {
  const composition = getEditingComposition();
  if (composition) store().renameComposition(composition.id, name);
}

/** The composition's tempo. Pushed into the metronome on play; not the
 *  metronome's live value until then. */
export function setCompositionBpm(bpm: number): void {
  const composition = getEditingComposition();
  if (composition) store().setCompositionBpm(composition.id, bpm);
}

export function setCompositionTimeSignature(timeSignature: PatternTimeSignature): void {
  const composition = getEditingComposition();
  if (composition) store().setCompositionTimeSignature(composition.id, timeSignature);
}

/** Whether arrangement playback repeats. Stored on the composition rather than
 *  in transport state, so it survives reopening — as it is for patterns. */
export function setCompositionLoop(loop: boolean): void {
  const composition = getEditingComposition();
  if (composition) store().setCompositionLoop(composition.id, loop);
}
