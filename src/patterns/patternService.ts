/**
 * The seam between the app and `@fretwork/lib`'s pattern store.
 *
 * Components call this, never `usePatternsStore` directly. That keeps four
 * things contained to one file:
 *   - the store is a module singleton that persists to sessionStorage, so tests
 *     and any future multi-pattern UI need one place to control it;
 *   - it carries a lot we don't use (collections, placements, chord buffering,
 *     pre-roll), which shouldn't leak into components;
 *   - its shape can change between lib versions;
 *   - the agent's tools will need exactly this surface, and must reach the same
 *     code path as the UI rather than a parallel one.
 *
 * Everything below delegates to the lib's ops, which already enforce the rules
 * we care about — no same-string overlap, duration clamped against the next
 * note, and pattern length auto-fitted to content on every edit.
 */
import { useSyncExternalStore } from 'react';
import {
  DEFAULT_INSTRUMENT_ID,
  INSTRUMENTS,
  getInstrument,
  usePatternsStore,
  selectEditingPattern,
  type DynamicMark,
  type EventDragSnapshot,
  type FretInstrumentId,
  type Pattern,
  type PatternEvent,
  type Tick,
} from '@fretwork/lib';
import { createHistory } from './history';
import { toPitchPatch, type NotePitch } from './articulations';

type SelectionMode = 'replace' | 'add' | 'toggle';

/** The lib exports `EventDragSnapshot` but not its resize counterpart, so the
 *  shape is mirrored here. Structural typing makes it interchangeable. */
interface EventResizeSnapshot {
  readonly id: string;
  readonly durationTicks: Tick;
}

const store = () => usePatternsStore.getState();

// ---------------------------------------------------------------- reading ---

/** React hook: the pattern currently being edited, or null. */
export function useEditingPattern(): Pattern | null {
  return usePatternsStore(selectEditingPattern);
}

/** React hook: ids of the currently selected events. */
export function useSelectedIds(): string[] {
  return usePatternsStore((s) => s.selectedEventIds);
}

/** Non-reactive read — for event handlers and tests. */
export function getEditingPattern(): Pattern | null {
  return selectEditingPattern(usePatternsStore.getState());
}

export function getSelectedIds(): string[] {
  return store().selectedEventIds;
}

export function findEvent(id: string): PatternEvent | undefined {
  return getEditingPattern()?.events.find((e) => e.id === id);
}

/**
 * `Pattern.instrumentId` is a free-form string; everything downstream of it —
 * the voice builder, the tuning list, the fretboard's `InstrumentDef` — is not.
 *
 * One resolver for the whole app on purpose: the audio engine and any view that
 * draws a neck have to agree on how many strings the pattern has, or notes on
 * the strings the other one doesn't believe in vanish without a trace.
 *
 * Membership is asked of the lib's catalog rather than listed here. The list would
 * match today, but `FretInstrumentId` and `INSTRUMENTS` are grown together on the
 * lib side ("add an entry here … the renderer + UI pick up the new instrument
 * automatically"), so a fourth instrument would otherwise be silently coerced to
 * guitar — which then reads as the pattern being on the wrong neck.
 */
export function patternInstrumentId(pattern: Pattern): FretInstrumentId {
  return getInstrument(pattern.instrumentId) !== undefined
    ? (pattern.instrumentId as FretInstrumentId)
    : DEFAULT_INSTRUMENT_ID;
}

/**
 * The instruments a pattern can be on, for a picker.
 *
 * Read from the lib's catalog rather than listed here for the same reason
 * `patternInstrumentId` asks the catalog about membership: `INSTRUMENTS` and
 * `FretInstrumentId` are grown together on the lib side, and a hardcoded list would
 * silently omit a fourth instrument the moment one lands.
 */
export function listInstruments(): readonly { id: FretInstrumentId; name: string }[] {
  return INSTRUMENTS.map((instrument) => ({
    id: instrument.id as FretInstrumentId,
    name: instrument.name,
  }));
}

// ------------------------------------------------------------------ undo ---
// LIB-GAP(1): the lib has no history support and no way to write a whole
// pattern back. Everything undo-related is confined to this section plus
// ./history so it can be deleted in one go. See docs/FOLLOW-UPS.md.

const history = createHistory<Pattern>();

/**
 * The one place we reach past the lib's public actions.
 *
 * The store exposes granular ops and a metadata patch, but no way to write a
 * whole pattern back — which is exactly what restoring a snapshot needs. Until
 * the lib grows `replacePattern(id, pattern)`, we swap the entry in `library`
 * ourselves. Keeping it in a single function means the lib migration touches
 * one call site.
 */
function writePatternBack(pattern: Pattern): void {
  usePatternsStore.setState((state) => ({
    library: {
      ...state.library,
      patterns: state.library.patterns.map((p) => (p.id === pattern.id ? pattern : p)),
    },
  }));
}

/** Snapshot the current pattern before a mutation. */
function capture(): void {
  const pattern = getEditingPattern();
  if (pattern) history.capture(pattern);
}

/**
 * Bracket a multi-step edit — a drag fires dozens of mutations but must undo as
 * one step. Safe to call without a pattern open.
 */
export function beginEditGesture(): void {
  const pattern = getEditingPattern();
  if (pattern) history.beginGesture(pattern);
}

export function endEditGesture(changed = true): void {
  history.endGesture({ changed });
}

export function undo(): void {
  const current = getEditingPattern();
  if (!current) return;
  const previous = history.undo(current);
  if (previous) writePatternBack(previous);
}

export function redo(): void {
  const current = getEditingPattern();
  if (!current) return;
  const next = history.redo(current);
  if (next) writePatternBack(next);
}

export function clearHistory(): void {
  history.clear();
}

/** React hook: whether undo/redo are currently available. */
export function useHistoryState(): { canUndo: boolean; canRedo: boolean } {
  const canUndo = useSyncExternalStore(history.subscribe, history.canUndo, history.canUndo);
  const canRedo = useSyncExternalStore(history.subscribe, history.canRedo, history.canRedo);
  return { canUndo, canRedo };
}

// ---------------------------------------------------------------- writing ---

/** Create a fresh pattern and open it for editing. */
export function openBlankPattern(name?: string): void {
  const id = store().createPattern(name);
  store().openPatternForEditing(id);
  store().selectEvents([], 'replace');
  // History is per-pattern; carrying it across a switch would undo into a
  // pattern that is no longer open.
  history.clear();
}

/** Open whatever pattern was last edited, seeding a draft if there is none. */
export function ensurePattern(): void {
  store().ensureEditingPattern();
}

export interface StampArgs {
  stringIndex: number;
  fret: number;
  tick: Tick;
  durationTicks?: Tick;
}

/**
 * Place a note at an explicit tick.
 *
 * The store's `stampAt` always stamps at its own cursor, so we move the cursor
 * first — that's the intended flow, and it keeps the cursor where the user last
 * acted. A stamp that would overlap an existing note on the same string is
 * rejected by the lib and simply leaves the pattern unchanged.
 */
export function stampNote({ stringIndex, fret, tick, durationTicks }: StampArgs): void {
  capture();
  const s = store();
  s.setCursorTick(tick);
  if (durationTicks !== undefined) {
    const before = getEditingPattern()?.events.map((e) => e.id) ?? [];
    s.stampAt({ stringIndex, fret }, false);
    const added = getEditingPattern()?.events.find((e) => !before.includes(e.id));
    if (added) s.resizeEvent(added.id, durationTicks);
    return;
  }
  s.stampAt({ stringIndex, fret }, false);
}

export function moveNote(id: string, startTick: Tick, stringIndex?: number): void {
  capture();
  store().moveEvent(id, startTick, stringIndex);
}

export function resizeNote(id: string, durationTicks: Tick): void {
  capture();
  store().resizeEvent(id, durationTicks);
}

export function setNoteFret(id: string, fret: number): void {
  capture();
  store().setEventFret(id, fret);
}

/**
 * The top of the neck. The lib floors a fret at 0 but has no ceiling of its own
 * (`setEventFret` only does `Math.max(0, …)`), so the upper bound is the app's
 * rule and has to be applied on the way in. Exported so the popup's stepper and
 * keyboard entry can't drift apart.
 */
export const MAX_FRET = 24;

/**
 * Put every selected note on an explicit fret — keyboard fret entry.
 *
 * One store write per note: the lib has a bulk *relative* action
 * (`nudgeSelectedFret`) but no absolute one, so the loop is unavoidable. Undo is
 * unaffected — the single `capture()` covers the whole selection.
 */
export function setSelectedFret(fret: number): void {
  const ids = getSelectedIds();
  // Capture only once there is something to change, so an empty selection can't
  // push a no-op undo step — matching `nudgeSelectedFret` below.
  if (ids.length === 0) return;
  capture();
  const clamped = Math.max(0, Math.min(MAX_FRET, Math.floor(fret)));
  const s = store();
  for (const id of ids) s.setEventFret(id, clamped);
}

/**
 * Nudge the whole selection by `delta` frets, in one store write.
 *
 * The delta is clamped against the extremes of the selection rather than note
 * by note: the lib floors each event at 0 independently, so a chord nudged past
 * the nut would flatten onto it instead of stopping there. Clamping the shared
 * delta keeps the selection's shape when it hits either end — the same
 * reasoning as the group-resize clamp in Timeline.
 */
export function nudgeSelectedFret(delta: number): void {
  const pattern = getEditingPattern();
  if (!pattern) return;
  const ids = getSelectedIds();
  const frets = pattern.events.filter((e) => ids.includes(e.id)).map((e) => e.fret);
  if (frets.length === 0) return;
  // Room measured only in the direction being asked for. `MAX_FRET` is our rule,
  // not the lib's — a pattern imported or restored with a note above it has
  // negative headroom, and folding both bounds into one min/max chain would turn
  // that into a nudge *down* when the user pressed up.
  const room =
    delta > 0
      ? Math.max(0, MAX_FRET - Math.max(...frets))
      : Math.min(0, -Math.min(...frets));
  const clamped = delta > 0 ? Math.min(room, delta) : Math.max(room, delta);
  if (clamped === 0) return;
  capture();
  store().nudgeSelectedFret(clamped);
}

export function deleteNotes(ids: readonly string[]): void {
  capture();
  store().deleteEvents(ids);
}

/**
 * Whether editor playback repeats. Stored on the pattern (the lib defaults it to
 * true) rather than held in transport state, so it survives reopening.
 */
export function setPatternLoop(loop: boolean): void {
  store().setEditingPatternLoop(loop);
}

/**
 * The pattern's preferred tempo. The lib treats this as the author's intent and
 * loads it into the metronome when the pattern is opened; the metronome holds
 * the live value during playback.
 */
export function setPatternBpm(bpm: number | null): void {
  store().setEditingPatternSuggestedBpm(bpm);
}

/**
 * Which voice the pattern plays through — a `VariantRef` from the lib's voices
 * module, or null to fall back to the instrument's active voice.
 *
 * Typed `unknown` because it is `unknown` on `Pattern`: the lib keeps its pattern
 * model independent of the voices module and documents casting at use.
 * `src/voice/voiceService.ts` owns that cast and its validation — this is only the
 * store write, which has to live on this side of the seam.
 *
 * Not *captured* for undo, matching loop and tempo above: it is a preference about how
 * the pattern sounds, not an edit to its notes, so choosing a voice doesn't push an undo
 * step. It is still *restored* by one — `writePatternBack` swaps in a whole `Pattern`
 * snapshot — so undoing past the point where the voice was chosen reverts it as a side
 * effect. Fix that for all three at once by carrying them forward in `writePatternBack`.
 */
export function setEditingPatternVoiceRef(voiceRef: unknown): void {
  store().setEditingPatternVoiceRef(voiceRef);
}

/**
 * Which instrument the pattern is on — how many strings it has, which tunings apply,
 * and which voices the voice pane may offer.
 *
 * The lib's op writes the field and nothing else, so events on strings the new
 * instrument doesn't have (a guitar's index 4–5 on a four-string bass) stay on the
 * pattern and simply stop being drawn. Left that way deliberately: it is lossless and
 * reverses by switching back, where dropping them would not. A guard belongs with the
 * slice that owns instrument switching as an *editing* operation rather than as the
 * voice pane's prerequisite.
 *
 * Not captured for undo, matching loop, tempo and voice above.
 */
export function setEditingPatternInstrument(instrumentId: FretInstrumentId): void {
  const pattern = getEditingPattern();
  if (!pattern) return;
  // The store's action addresses a pattern by id — there is no editing-pattern
  // shorthand for this one, unlike loop/tempo/voiceRef.
  store().setPatternInstrument(pattern.id, instrumentId);
}

export function selectNotes(ids: readonly string[], mode: SelectionMode = 'replace'): void {
  store().selectEvents(ids, mode);
}

/** Drag-start state for a group move — the lib clamps against these, not against
 *  the live positions, so repeated pointer moves don't compound. */
export function snapshotForDrag(ids: readonly string[]): EventDragSnapshot[] {
  const pattern = getEditingPattern();
  if (!pattern) return [];
  return pattern.events
    .filter((event) => ids.includes(event.id))
    .map(({ id, startTick, stringIndex, durationTicks }) => ({
      id,
      startTick,
      stringIndex,
      durationTicks,
    }));
}

export function snapshotForResize(ids: readonly string[]): EventResizeSnapshot[] {
  const pattern = getEditingPattern();
  if (!pattern) return [];
  return pattern.events
    .filter((event) => ids.includes(event.id))
    .map(({ id, durationTicks }) => ({ id, durationTicks }));
}

/**
 * Move a group. Unlike `moveNote`, the lib *clamps* this rather than rejecting
 * it — the group slides up against obstacles instead of refusing to budge, which
 * is what makes dragging a multi-selection feel right.
 */
export function moveNotesBy(
  snapshots: readonly EventDragSnapshot[],
  deltaTicks: Tick,
  deltaStrings: number,
  stringCount: number,
): void {
  capture();
  store().moveEventsBy(snapshots, deltaTicks, deltaStrings, stringCount);
}

export function resizeNotesBy(
  snapshots: readonly EventResizeSnapshot[],
  deltaTicks: Tick,
): void {
  capture();
  store().resizeEventsBy(snapshots, deltaTicks);
}

/**
 * Patch articulation fields. `undefined` clears a field; the lib keeps
 * hammer-on and pull-off mutually exclusive for us.
 */
export function setArticulations(
  id: string,
  patch: Parameters<ReturnType<typeof store>['updateEventArticulations']>[1],
): void {
  capture();
  store().updateEventArticulations(id, patch);
}

/** Replace the note's pitch movement — slides and bends. */
export function setNotePitch(id: string, pitch: NotePitch): void {
  capture();
  store().updateEventArticulations(id, toPitchPatch(pitch) as never);
}

/**
 * LIB-GAP(5): the numbers below are the lib's own dynamic → velocity curve,
 * copied. The model documents that authoring a dynamic must back-fill
 * `velocity` "via the same curve the mapper uses", but that function
 * (`dynamicToVelocity`, import/mapper.js) is private to the importer, so a
 * pattern typed here and one imported from a file would otherwise disagree
 * about what mf sounds like. Delete when the lib exports it.
 *
 * Sub-linear at the soft end, compressed at the loud end — the curve is tuned
 * by ear, not derived, so it must be mirrored rather than re-invented.
 *
 * `dynamicToVelocity` itself can't be called, but the importer that uses it is
 * public, so the drift test in tests/NotePopup.test.tsx pins these numbers by
 * running each mark through `mapImportToLibrary`. Keep that test alive until
 * this block dies.
 */
const DYNAMIC_VELOCITY: Record<DynamicMark, number> = {
  ppp: 0.08,
  pp: 0.18,
  p: 0.32,
  mp: 0.5,
  mf: 0.65,
  f: 0.8,
  ff: 0.92,
  fff: 1.0,
};

/** Softest → loudest, ordered by the curve itself rather than by how the literal
 *  above happens to be written, so a picker can't drift from it. */
export const DYNAMICS = Object.entries(DYNAMIC_VELOCITY)
  .sort(([, a], [, b]) => a - b)
  .map(([mark]) => mark as DynamicMark);

/**
 * Set (or clear, with `undefined`) a note's dynamic.
 *
 * The two fields are always written together: `dynamic` is display-only and
 * `velocity` is the only one playback reads, so letting them drift would give a
 * note labelled *pp* that plays at full force. Clearing has to clear both for
 * the same reason.
 */
export function setNoteDynamic(id: string, dynamic: DynamicMark | undefined): void {
  capture();
  store().updateEventArticulations(id, {
    dynamic,
    velocity: dynamic === undefined ? undefined : DYNAMIC_VELOCITY[dynamic],
  });
}
