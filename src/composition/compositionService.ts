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

/** The one place this module reaches past the lib's public actions — restoring
 *  a snapshot needs a whole-composition write, which the store doesn't offer. */
function writeCompositionBack(snapshot: Composition): void {
  const live = getEditingComposition();
  const composition =
    live && live.id === snapshot.id ? mergeSettingsForward(snapshot, live) : snapshot;
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
 *  switch would undo into a composition that is no longer open. */
function forgetPerCompositionState(): void {
  writeSelection(NO_IDS);
  selectTrack(null);
  clearHistory();
}

// ------------------------------------------------------------ track writes ---

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
    return refuse(`A composition can hold at most ${MAX_COMPOSITION_TRACKS} tracks.`);
  }
  commit(() => store().addCompositionTrack(name, instrumentId));
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

export function setTrackName(trackId: string, name: string): Result {
  const track = findTrack(trackId);
  if (!track) return refuse('No such track.');
  if (track.name === name) return ok(undefined);
  store().setCompositionTrackName(trackId, name);
  return ok(undefined);
}

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

export function setTrackVolumeDb(trackId: string, volumeDb: number): Result {
  const track = findTrack(trackId);
  if (!track) return refuse('No such track.');
  if (track.volumeDb === volumeDb) return ok(undefined);
  store().setCompositionTrackVolumeDb(trackId, volumeDb);
  return ok(undefined);
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

export function setMasterVolumeDb(masterVolumeDb: number): void {
  store().setCompositionMasterVolumeDb(masterVolumeDb);
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

// `setPlacementSnapshot` — writing an edited pattern back into a placement — is
// deliberately absent. The store exposes no action for it and the lib's root
// barrel does not export the pure op, so the only route would be a
// whole-composition write-back of our own. It is not needed until edit mode
// (slice 2) exists to produce the edited snapshot, and the lib's own route into
// that mode is `openPlacementForEditing(compositionId, placementId)` — which
// points the PATTERN editor at the placement, so the write-back is the pattern
// seam's, not a placement op here. See tickets/composition-page/README.md, which
// leaves the placement-edit flow explicitly open.

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
