/**
 * Every pointer and keyboard gesture the arrangement grid understands, in one
 * place, plus the capability each of them is a way of CALLING.
 *
 * ── The rule this module exists to keep ──────────────────────────────────────
 *
 * Every capability here is a plain exported function FIRST and a gesture
 * second. Drag-to-place is a way of calling `addPlacement`; marquee select is a
 * way of calling `selectPlacements`; trimming an edge is a way of calling
 * `resizePlacement`. The agent this app is being built for reaches functions,
 * not pointers, and a capability that exists only as a drag is a capability the
 * agent cannot use at all — the same rule `patternService`'s header states, and
 * the reason `compositionService.addTrack` enforces the track cap at the seam
 * rather than by disabling a button.
 *
 * Refusals are returned, typed, and stated. Never thrown, never silent.
 *
 * ── Why CP-05 and CP-06 share a file ─────────────────────────────────────────
 *
 * Dropping a pattern from the rail and dragging a block within a lane are the
 * same machine: window-parked pointer listeners, a snap, edge auto-scroll, a
 * live preview, and a teardown that has to run on every way a gesture can end.
 * Two implementations of that diverge, and the half that diverges is always the
 * teardown.
 *
 * ── The teardown, which is the whole game ────────────────────────────────────
 *
 * `beginEditGesture` opens an undo bracket and `endEditGesture` closes it.
 * While one is open `history.capture` is IGNORED (see patterns/history.ts), so
 * a gesture that is never closed does not merely lose its own step — it
 * silently swallows every later edit's step for the life of the page. That has
 * happened in this project once already. So `endGesture` runs from ONE place
 * (`teardown` below) which is wired to pointerup, pointercancel, Escape, window
 * blur AND unmount. There is deliberately no second call site.
 *
 * Escape ENDS the drag where it stands rather than reverting it. Reverting
 * would need a whole-composition write, which only `compositionService` may do
 * and which it does not expose; leaving the arrangement moved with no undo step
 * to move it back would be strictly worse than leaving it moved with one.
 *
 * ── Coordinate frame ─────────────────────────────────────────────────────────
 *
 * Everything here works in LANE-AREA CONTENT space: x = 0 is tick 0, y = 0 is
 * the first lane's top, and scroll is already undone. `PlacementBlock` draws in
 * lane-LOCAL space (laneTop 0) because its lane element is already positioned —
 * mixing the two puts every hit one lane off and still looks plausible. The
 * caller supplies `toContent`, so this module never measures anything and stays
 * testable where `getBoundingClientRect` is 0×0.
 */
import { useEffect, useRef, useState } from 'react';
import { PPQ, type Pattern, type Tick, type Track } from '@fretwork/lib';
import {
  laneAt,
  placementsInBand,
  planGroupMove,
  pxToTick,
  snapArrangementTick,
  tickToPx,
  dropTarget,
  hitTest,
  type ArrangementHit,
  type LaneRect,
  type PlacedTrack,
  type PlacementDragItem,
  type Point,
} from './arrangementMath';
import type { SnapOption } from '../timeline/timelineMath';
import {
  addPlacement,
  beginEditGesture,
  duplicatePlacements,
  endEditGesture,
  findPlacement,
  findTrack,
  getEditingComposition,
  getSelectedPlacementIds,
  getSelectedTrackId,
  getTracks,
  isJobRunning,
  movePlacement,
  placementEffectiveLength,
  placementEndTick,
  redo,
  removePlacement,
  resizePlacement,
  selectPlacements,
  setPlacementTranspose,
  splitPlacement,
  trackInstrumentId,
  undo,
  useSelectedPlacementIds,
  type Result,
} from './compositionService';
import { findLibraryPattern, patternInstrumentId } from '../patterns/patternService';
import { insideKeyboardControl } from '../timeline/keyboardBoundary';
import { useEdgeAutoScroll } from '../timeline/useEdgeAutoScroll';

/**
 * Movement before a press counts as a drag. Same figure as `Timeline.tsx`, so a
 * click doesn't mean different things on the two surfaces.
 *
 * Exported because the library rail has to make the same call independently:
 * its rows are buttons, and a browser still fires `click` after a drag that
 * began and ended within one. Two thresholds would leave a band of movement
 * that is a drag to the grid and a click to the rail — which places the pattern
 * twice.
 */
export const DRAG_THRESHOLD_PX = 3;

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const refuse = (reason: string): Result<never> => ({ ok: false, reason });

// -------------------------------------------------------------- eligibility ---
// ONE rule for "which blocks may this UI touch", used by the toolbar, by every
// shortcut, by the marquee and by a group drag — see `TrackFilter`.

/**
 * Which tracks a UI command may act on.
 *
 * ⚠ THE DEFAULT IS THE WHOLE DOCUMENT, and that is the contract, not a
 * convenience: the filter is an argument the VIEW passes, never something baked
 * into a capability. A caller with no notion of a view — a test, a keyboard
 * route, a future headless driver — gets the composition, exactly as it always
 * has.
 *
 * ⚠ And NOT because the agent calls these. It cannot: `src/ai` may import only
 * its siblings and the four seam modules (pinned by `tests/AgentTools.test.ts`)
 * and this is neither. The agent's document-wide capabilities live in
 * `compositionService`, and keeping them independent of view state is that
 * module's job, not this one's. What this default buys is that view state never
 * leaks INTO a capability by being its only spelling.
 *
 * What the view passes is "this track's lane is a Pattern lane". Since
 * COMPS-TRACK-TABS milestone 4 that is a REAL filter on every stack with a
 * mixed set of views: each track carries its own, so a hit test, a drop or a
 * marquee has to ask lane by lane rather than once for the page. (It was
 * written one milestone ahead of that, while the page still had a single mode
 * and this was the identity function — deliberately, so the per-track step
 * replaced a body and not a signature.)
 */
export type TrackFilter = (trackId: string) => boolean;

/** What a caller with no notion of a view — the agent, a test, a keyboard
 *  route — gets. */
const EVERY_TRACK: TrackFilter = () => true;

/**
 * The selected blocks a UI command may act on: still in the document, and on a
 * lane the filter admits.
 *
 * This is the "prune" §5 asks for, and it PRUNES BY DERIVING rather than by
 * writing a narrower selection back to the seam. The store's selection can be
 * set from outside this page — an agent run selects across every track it just
 * wrote — and a UI that overwrote it to satisfy its own view would make a
 * document-wide capability depend on React view state, which §4 forbids. So the
 * ineligible ids stay selected in the document, the UI neither draws nor
 * touches them, and nothing the agent did is lost.
 */
function eligibleSelection(
  ids: readonly string[],
  eligible: TrackFilter = EVERY_TRACK,
): string[] {
  return ids.filter((id) => {
    const found = findPlacement(id);
    return found !== undefined && eligible(found.track.id);
  });
}

/** Every placement the filter admits, in track then placement order. */
function eligiblePlacementIds(eligible: TrackFilter = EVERY_TRACK): string[] {
  return getTracks()
    .filter((track) => eligible(track.id))
    .flatMap((track) => track.placements.map((placement) => placement.id));
}

// ------------------------------------------------------------- capabilities ---
// Plain functions, each one undoable as exactly one step. The gestures below
// call these; so can a toolbar button, a keyboard shortcut or an agent tool.

/**
 * Whether `pattern` may be dropped on `track`, and why not when it may not.
 *
 * The instrument match is the app's rule, not the lib's: `addPlacementToTrack`
 * happily places a bass riff on a ukulele track, and the result plays on four
 * strings that are not the ones the notes were written for.
 *
 * ⚠ This belongs in `compositionService.addPlacement` so the agent is held to it
 * too — a rule only the UI enforces is a rule the agent walks straight past,
 * which is precisely what the track cap is placed at the seam to avoid. It is
 * stated here because CP-05/06 may not widen that module; tracked under
 * "Owed, small" in docs/FOLLOW-UPS.md so it does not calcify here.
 */
export function patternDropRefusal(pattern: Pattern, track: Track): string | null {
  const from = patternInstrumentId(pattern);
  const to = trackInstrumentId(track);
  if (from === to) return null;
  return `“${pattern.name}” is a ${from} pattern — “${track.name}” is a ${to} track.`;
}

/** Track a placement lands on when no lane was aimed at: the focused one, else
 *  the first. Never "none" while a composition is open — the lib's model
 *  guarantees at least one track. */
function defaultTargetTrack(): Track | undefined {
  const focused = getSelectedTrackId();
  return (focused !== null ? findTrack(focused) : undefined) ?? getTracks()[0];
}

/**
 * Place a library pattern at the end of a track's content — the keyboard route
 * to the rail's drag.
 *
 * A capability reachable only by pointer is not reachable by a keyboard user or
 * by the agent, so the rail's rows are buttons and this is what they press.
 * Appended at the track's own content end rather than at a snapped bar line:
 * the lib cascades placements to prevent overlap anyway, and butting the new
 * block against the last one is the unambiguous meaning of "add this next".
 */
export function appendPatternToTrack(patternId: string, trackId?: string): Result<string> {
  const pattern = findLibraryPattern(patternId);
  if (!pattern) return refuse('That pattern is no longer in the library.');
  const track = trackId !== undefined ? findTrack(trackId) : defaultTargetTrack();
  if (!track) return refuse('No track to place onto.');
  const blocked = patternDropRefusal(pattern, track);
  if (blocked) return refuse(blocked);

  const atTick = track.placements.reduce((end, placement) => {
    return Math.max(end, placementEndTick(placement));
  }, 0);

  beginEditGesture();
  const placed = addPlacement(pattern.id, track.id, atTick);
  endEditGesture();
  return placed;
}

/**
 * Select every placement in the arrangement.
 *
 * The keyboard's only route INTO a selection, and therefore into delete,
 * duplicate, transpose and split: blocks are inert DOM by design (the lane area
 * hit-tests presses rather than carrying handlers per block), so there is
 * nothing to tab to and no way to name one block without a pointer. Selecting
 * all of them is not the same capability as picking one, and it is what stops
 * every capability below from being pointer-only.
 *
 * TODO(CP-10): per-block keyboard selection needs focusable blocks, which is a
 * change to how the whole lane area dispatches — not a shortcut.
 *
 * ⚠ `eligible` IS WHAT ⌘A PASSES, and it is why this function could not stay as
 * it was. Unfiltered it enumerates every track, so Select All in a mixed view
 * would hand the block commands placements on lanes that are not drawing
 * blocks — and the next Delete would remove them. The default is still the
 * whole document, for the agent and for every pointer-free caller.
 */
export function selectAllPlacements(eligible: TrackFilter = EVERY_TRACK): Result<number> {
  const ids = eligiblePlacementIds(eligible);
  if (ids.length === 0) return refuse('Nothing is placed yet.');
  selectPlacements(ids);
  return ok(ids.length);
}

/**
 * Remove every selected placement as one undo step.
 *
 * `eligible` is resolved HERE, at execution time, against the live selection —
 * not captured when the button rendered. A placement can leave the selection,
 * leave its track or leave the document between the render that enabled a
 * button and the press that fires it.
 */
export function deleteSelectedPlacements(eligible: TrackFilter = EVERY_TRACK): Result<number> {
  const ids = eligibleSelection(getSelectedPlacementIds(), eligible);
  if (ids.length === 0) return refuse('Nothing is selected.');
  beginEditGesture();
  for (const id of ids) removePlacement(id);
  endEditGesture();
  return ok(ids.length);
}

/**
 * Clone the selection one selection-span to the right.
 *
 * The span is measured across the WHOLE selection rather than per block, which
 * is what makes duplicating a two-bar phrase spread over three tracks land as
 * that phrase again rather than as three blocks stacked on their originals.
 */
export function duplicateSelectedPlacements(
  eligible: TrackFilter = EVERY_TRACK,
): Result<number> {
  const ids = eligibleSelection(getSelectedPlacementIds(), eligible);
  if (ids.length === 0) return refuse('Nothing is selected.');

  let start = Infinity;
  let end = 0;
  for (const id of ids) {
    const found = findPlacement(id);
    if (!found) continue;
    start = Math.min(start, found.placement.startTick);
    end = Math.max(end, placementEndTick(found.placement));
  }
  if (!Number.isFinite(start) || end <= start) {
    return refuse("Couldn't measure the selection.");
  }

  beginEditGesture();
  duplicatePlacements(ids, end - start);
  endEditGesture();
  return ok(ids.length);
}

/**
 * Shift the selection's playback pitch. Non-destructive — the snapshots are
 * untouched and the lib clamps the total to ±24.
 *
 * Relative to each placement's OWN current transpose, so a mixed selection
 * keeps its internal intervals instead of being flattened onto one value.
 */
export function transposeSelectedPlacements(
  semitones: number,
  eligible: TrackFilter = EVERY_TRACK,
): Result<number> {
  const ids = eligibleSelection(getSelectedPlacementIds(), eligible);
  if (ids.length === 0) return refuse('Nothing is selected.');
  beginEditGesture();
  for (const id of ids) {
    const found = findPlacement(id);
    if (!found) continue;
    setPlacementTranspose(id, found.placement.transposeSemitones + semitones);
  }
  endEditGesture();
  return ok(ids.length);
}

/**
 * Cut every selected placement that `atTick` falls inside.
 *
 * The lib is a silent no-op when the tick is at or outside a placement's range,
 * and `compositionService.splitPlacement` returns void, so "did anything
 * happen" is recovered the way the seam itself recovers it: by comparing the
 * composition's reference across the write.
 *
 * Note the selection empties: both halves are NEW placements with new ids, so
 * the seam prunes the ids that named the original. That is the lib's model, not
 * something to paper over — reselecting a half you can no longer name would
 * mean guessing which half was meant.
 */
export function splitSelectedPlacements(
  atTick: Tick,
  eligible: TrackFilter = EVERY_TRACK,
): Result<number> {
  const ids = eligibleSelection(getSelectedPlacementIds(), eligible);
  if (ids.length === 0) return refuse('Nothing is selected.');

  let cut = 0;
  beginEditGesture();
  for (const id of ids) {
    const before = getEditingComposition();
    splitPlacement(id, atTick);
    if (getEditingComposition() !== before) cut++;
  }
  endEditGesture();

  if (cut === 0) {
    return refuse('Nothing to split there — put the cursor inside a selected block.');
  }
  return ok(cut);
}

// ----------------------------------------------------------------- preview ---

/**
 * What the grid should draw on top of the lanes for the gesture in flight, in
 * lane-area CONTENT coordinates.
 *
 * There is no preview for a move or a trim, and that is not an omission: those
 * gestures mutate the composition on every pointer move, so the block itself is
 * the preview — already snapped, and already showing the lib's own clamping
 * against its neighbours. guitar-tutor needed a `CascadeGhost` because HTML5
 * drag-and-drop cannot move the real thing until the drop.
 */
export type GesturePreview =
  | {
      readonly kind: 'drop';
      readonly trackId: string;
      readonly left: number;
      readonly top: number;
      readonly width: number;
      readonly height: number;
      readonly label: string;
      /** Non-null when this drop would be refused — the reason, shown against
       *  the indicator rather than discovered by releasing the pointer. */
      readonly refusal: string | null;
    }
  | {
      readonly kind: 'marquee';
      readonly left: number;
      readonly top: number;
      readonly width: number;
      readonly height: number;
    };

/** Everything a gesture needs to know about the view, read fresh on every
 *  pointer event so a zoom or an edit mid-drag is picked up rather than frozen
 *  into the closure. */
export interface GestureGeometry {
  readonly lanes: readonly LaneRect[];
  readonly tracks: readonly PlacedTrack[];
  readonly pxPerBeat: number;
  readonly snap: SnapOption | null;
  /** Client coordinates → lane-area content coordinates. */
  toContent(clientX: number, clientY: number): Point;
  /**
   * Whether a client point is over the lane area's VIEWPORT.
   *
   * `toContent` is a subtraction, so it happily maps a point over the pattern
   * rail — a horizontal sibling of the grid — onto a lane several bars to the
   * right, and a rail drag released there would place a block off-screen where
   * nobody saw the preview. `dropTarget` bounds only y (`laneAt` returns null
   * off the stack), which catches the toolbar above and the space below and
   * nothing on the x axis. HTML5 drag-and-drop bounded this for free by never
   * firing `drop` outside the target; pointer events do not, so the bound is
   * restated here.
   */
  inViewport(clientX: number, clientY: number): boolean;
}

export interface ArrangementGestures {
  /** One handler for the whole lane area. Which block — and which part of it —
   *  was pressed is `hitTest`'s answer, not the DOM's. */
  onLanesPointerDown(e: React.PointerEvent): void;
  /** Remembers where the cursor is, so Split has a point to cut at. */
  onLanesPointerMove(e: React.PointerEvent): void;
  /** Begin a drag from the pattern library rail. */
  startPatternDrag(patternId: string, e: React.PointerEvent): void;
  preview: GesturePreview | null;
  /** The last refusal, for a live region. Cleared when the next gesture starts. */
  refusal: string | null;
  dismissRefusal(): void;
  /**
   * ── THE UI'S OWN COMMAND SET ────────────────────────────────────────────────
   *
   * The toolbar's buttons and the window shortcuts are the SAME functions, and
   * these are they. Each resolves eligibility at EXECUTION time against live
   * state, so a button that was enabled when it rendered still cannot touch a
   * block that has since left its lane, left the selection or left the
   * document.
   *
   * They exist on the hook rather than being imported straight from this module
   * by the grid because `isPatternLane` is the hook's to hold: a caller that
   * imported `deleteSelectedPlacements` directly would get the DOCUMENT-WIDE
   * default and quietly delete blocks the view is not drawing. The exported
   * capabilities keep that default on purpose — see `TrackFilter`.
   */
  /** The selected blocks this view may act on — `selectedIds` pruned to the
   *  lanes the filter admits, and to placements that still exist. */
  effectiveSelection: readonly string[];
  /** Select every ELIGIBLE placement. Not `selectAllPlacements()`. */
  selectAll(): void;
  deleteSelection(): void;
  duplicateSelection(): void;
  transposeSelection(semitones: number): void;
  /** Split the selection at the last tick the pointer was over. */
  splitAtCursor(): void;
  /**
   * End every piece of work this hook still holds — an in-flight pointer drag's
   * WINDOW listeners and its undo bracket, a held arrow's transpose bracket, and
   * the edge auto-scroll — synchronously, against the geometry they started on.
   *
   * For the activation coordinator (COMPS-TRACK-TABS milestone 3 §B): a track
   * switch repoints the document, and a bracket still open over the OUTGOING
   * target would have its next close swallow the incoming one, after which
   * `history.capture` ignores every later edit for the life of the page.
   * Waiting for an effect cleanup is too late — the new target is already open
   * by then.
   *
   * Idempotent: every piece clears its own handle, so calling it twice, or with
   * nothing in flight, does nothing.
   */
  endGestures(): void;
}

interface GestureHandlers {
  /** Every move past the threshold, AND every edge-auto-scroll frame — which is
   *  why it takes a position rather than a delta: under auto-scroll the pointer
   *  hasn't moved, the content has. A delta-based handler computes zero and
   *  sticks.
   *
   *  `client` is the same position in CLIENT space, unprojected — the frame the
   *  viewport test has to be asked in, and one `toContent` has already thrown
   *  away by the time it returns. */
  drag(point: Point, client: Point): void;
  /** A clean pointer-up only. */
  up(point: Point, dragged: boolean, client: Point): void;
  /** ALWAYS last — up, cancel, Escape, window blur or unmount. */
  finish(dragged: boolean): void;
}

export interface ArrangementGesturesOptions {
  /** Null while no composition is open; every handler no-ops rather than
   *  guessing a geometry. */
  geometry(): GestureGeometry | null;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Whether this machinery is the one the lane area is currently driven by.
   * Defaults to true.
   *
   * False in EDIT MODE (CP-11), where the lanes are note surfaces and those own
   * the pointer. Two gesture systems on one surface is how a drag ends up doing
   * two things — but the sharper reason is the keyboard: these shortcuts are on
   * `window` and so are `NoteSurface`'s, so ⌘Z would pop an arrangement step AND
   * a note step for one press, and Backspace would delete the selected BLOCK
   * while the user meant the selected note.
   *
   * ── WHY THIS IS TWO FLAGS AND NOT ONE ───────────────────────────────────────
   *
   * One `enabled` gated the pointer entry points AND the window key handler,
   * which forced them to agree. They must not. A POINTER press names its own
   * target — the lane it landed on — and activates that track before it writes
   * anything, so it stays available while some other track's view is selected.
   * The KEYBOARD names nothing; it acts on whatever the page is pointed at, and
   * a second keyboard system over one surface is how a single ⌘Z pops an
   * arrangement step and a note step at once. So keyboard eligibility is
   * exclusive with a focused `NoteSurface` and pointer eligibility is not.
   *
   * Whether the arrangement's pointer surface is live at all. Per-LANE
   * eligibility is `isPatternLane`'s job, checked at the press; this is the
   * page-level question of whether there is any Pattern lane to press.
   */
  pointerEnabled?: boolean;
  /**
   * Whether the window shortcuts are this surface's.
   *
   * Mutually exclusive with a focused `NoteSurface`, which owns the same keys
   * against the notes. A mode switch mid-hold still ends a transpose run in
   * flight rather than leaving its bracket open — see the key handler.
   */
  keyboardEnabled?: boolean;
  /**
   * Whether this track's lane is a PATTERN lane: the only lanes the arrangement
   * hit-tests, drops onto, marquees over, or lets a block command touch.
   *
   * Read LIVE, through a ref, because window handlers outlive the render that
   * installed them. Each track carries its own view since COMPS-TRACK-TABS
   * milestone 4, so this genuinely excludes lanes today — a Voice or Edit lane
   * sitting between two Pattern ones is not a surface the arrangement's
   * pointer work may touch.
   */
  isPatternLane?: TrackFilter;
  /**
   * Take ownership of the track a lane press has landed on, BEFORE the gesture
   * writes anything — the arrangement's entry into the page's activation
   * coordinator (COMPS-TRACK-TABS milestone 3).
   *
   * Returning false REFUSES, and the press then does nothing at all: a track
   * that has gone, or a generation job holding the document, must not fall
   * through into a move, a trim or a marquee. Called once per press, from
   * `onLanesPointerDown` only — a drag PASSING over a lane does not activate it,
   * and neither does a hover or a library drop (plan §2).
   *
   * Defaults to allowing everything, which is what a host with no notion of an
   * active track gets.
   */
  activateTrack?(trackId: string): boolean;
}

/** What a host with no notion of an active track answers — see
 *  `ArrangementGesturesOptions.activateTrack`. */
const ALWAYS_ACTIVE = () => true;

export function useArrangementGestures({
  geometry,
  scrollerRef,
  pointerEnabled = true,
  keyboardEnabled = true,
  isPatternLane = EVERY_TRACK,
  activateTrack = ALWAYS_ACTIVE,
}: ArrangementGesturesOptions): ArrangementGestures {
  const selectedIds = useSelectedPlacementIds();
  const [preview, setPreview] = useState<GesturePreview | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  /** Tears down whichever pointer gesture is in flight. Null when none is. */
  const abortRef = useRef<(() => void) | null>(null);
  /** Last tick the pointer was seen over the lanes — Split's cut point. Held in
   *  a ref rather than state on purpose: it changes on every pointermove, and
   *  re-rendering the whole arrangement to move a number nothing draws would
   *  cost a frame per mouse move for no visible effect. */
  const cursorTickRef = useRef<Tick | null>(null);
  /** True while a held arrow key's repeats are being folded into the one undo
   *  step its first press recorded. */
  const transposeRun = useRef(false);

  // Read inside window handlers, which outlive the render that installed them.
  //
  // There is no `selectedRef` any more: every handler that used to read this
  // render's selection now calls `uiSelection()`, which reads the SEAM at the
  // moment it fires and prunes it to the lanes this view owns. A ref would have
  // been one render stale and unfiltered — two ways to act on a block that is
  // not there.
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  // A ref, not a dependency: the keyboard effect installs its listeners once and
  // must not re-install them on a mode change, which would drop a run in flight.
  const keyboardEnabledRef = useRef(keyboardEnabled);
  keyboardEnabledRef.current = keyboardEnabled;
  // Same reason: a gesture's window handlers and the key handler both ask which
  // lanes are Pattern lanes, and both outlive the render that installed them.
  const isPatternLaneRef = useRef(isPatternLane);
  isPatternLaneRef.current = isPatternLane;

  /**
   * The lanes this surface's gestures act on, WITH THEIR ORIGINAL TOPS.
   *
   * An Edit or Voice lane is a GAP in this array, not a shifted neighbour: the
   * tops still describe where the Pattern lanes are on screen, so `laneAt` over
   * this list answers null for a press on a lane the arrangement does not own
   * — which is exactly the refusal wanted — instead of answering the wrong
   * lane. §5's "preserve original tops and IDs; Edit and Voice rows are gaps".
   *
   * The full `geo.tracks` is passed to `hitTest` and `placementsInBand`
   * unfiltered on purpose: both resolve a track BY ID from the lane they
   * matched, so a lane that is not in this list is never looked up. Filtering a
   * parallel array and pairing it by index is the failure §5 names.
   */
  const patternLanesOf = (geo: GestureGeometry): LaneRect[] =>
    geo.lanes.filter((lane) => isPatternLaneRef.current(lane.trackId));

  /** The selection this view may act on, read LIVE — the toolbar's buttons and
   *  the shortcuts both resolve through this at the moment they fire. */
  const uiSelection = (): string[] =>
    eligibleSelection(getSelectedPlacementIds(), isPatternLaneRef.current);

  // Drives the view while a drag is held near the lane area's edge, so a block
  // can be taken somewhere that wasn't on screen when the drag started.
  const edgeScroll = useEdgeAutoScroll(scrollerRef);
  const edgeScrollRef = useRef(edgeScroll);
  edgeScrollRef.current = edgeScroll;

  /**
   * Own the pointer for the length of a gesture.
   *
   * Listeners go on `window`, not on the element, so the gesture keeps tracking
   * once the pointer leaves the lane — which is also why nothing else would
   * tear them down if this unmounts mid-drag.
   */
  /**
   * End whatever gesture is still holding the pointer.
   *
   * Called at the TOP of every entry point, before any `beginEditGesture` —
   * ordering that is not cosmetic. A second press while the first is held (a
   * second mouse button, a second finger) would otherwise open the new bracket
   * first, and the old gesture's teardown would then close the NEW one,
   * leaving the old snapshot dangling and every later capture swallowed.
   */
  const abortInFlight = () => abortRef.current?.();

  /**
   * Close the bracket swallowing a held arrow's repeats. Its snapshot is
   * DISCARDED rather than pushed: the key's first press already recorded the
   * pre-transpose state, so the whole hold undoes as that one step.
   *
   * At hook scope rather than inside the keyboard effect, because three things
   * need it now — the effect, the unmount cleanup, and `endGestures` for the
   * activation coordinator. It reads nothing but refs and module imports, so
   * the effect's `[]`-deps closure over the first render's copy is the same
   * function every later render would have built.
   */
  const endTransposeRun = () => {
    if (!transposeRun.current) return;
    transposeRun.current = false;
    endEditGesture(false);
  };

  /**
   * See `ArrangementGestures.endGestures`.
   *
   * ⚠ THE TRANSPOSE RUN FIRST. The two brackets NEST — a pointer drag opens
   * depth 1 and a held arrow over it opens depth 2 (the reverse cannot happen:
   * the capture-phase `pointerdown` listener in the keyboard effect ends a run
   * before any press is handled) — and `endEditGesture(changed)` honours
   * `changed` only on the OUTERMOST close. Ending the drag first would close at
   * depth 2 (ignored) and then close the run at depth 1 with its own `false`,
   * discarding the drag's snapshot and leaving its writes un-undoable.
   */
  const endGestures = () => {
    endTransposeRun();
    abortInFlight();
    // Belt and braces: `abortInFlight` ends it through the gesture's own
    // teardown when there IS one in flight, and this covers an auto-scroll left
    // spinning by anything that is not.
    edgeScrollRef.current.end();
  };

  /**
   * ── WHAT A DOCUMENT-WRITING GESTURE CAPTURES AT ITS START ───────────────────
   *
   * The Pattern lane ID ORDER and the geometry that order was measured in, plus
   * which composition it belongs to. §5: `planGroupMove` works in LANE INDICES,
   * and an index is only meaningful against the array it was taken from — so the
   * whole gesture resolves targets and refusals through `lanes` HERE, never
   * through the live array and never through the full track list.
   *
   * `signature` is the cheap form of the same thing, re-derived each frame and
   * compared. It folds in order, tops and heights because all three can move
   * under a drag (a track added or removed, a voice rack measured or folded, a
   * lane leaving Pattern) and every one of them silently re-points an index.
   */
  interface GestureCapture {
    readonly lanes: readonly LaneRect[];
    readonly compositionId: string | null;
    readonly pxPerBeat: number;
    readonly signature: string;
  }

  const laneSignature = (lanes: readonly LaneRect[], pxPerBeat: number): string =>
    `${pxPerBeat}|${lanes.map((lane) => `${lane.trackId}:${lane.top}:${lane.height}`).join(',')}`;

  const capture = (geo: GestureGeometry): GestureCapture => {
    const lanes = patternLanesOf(geo);
    return {
      lanes,
      compositionId: getEditingComposition()?.id ?? null,
      pxPerBeat: geo.pxPerBeat,
      signature: laneSignature(lanes, geo.pxPerBeat),
    };
  };

  /**
   * Whether the world has moved out from under a gesture that captured it.
   *
   * A true here means FINISH THROUGH THE EXISTING TEARDOWN and write nothing
   * more (§5). The alternative — carrying on against stale indices — moves the
   * wrong block to the wrong lane and leaves an undo step that says it was
   * asked for.
   *
   * Job ownership is in here for the same reason it is step 1 of the page's
   * activation coordinator: a job that starts mid-drag owns the document, and
   * the seam would refuse each write separately while the gesture kept painting
   * a preview of edits that were not happening.
   */
  const invalidated = (captured: GestureCapture, live: GestureGeometry): boolean =>
    isJobRunning() ||
    (getEditingComposition()?.id ?? null) !== captured.compositionId ||
    laneSignature(patternLanesOf(live), live.pxPerBeat) !== captured.signature;

  const beginPointerGesture = (e: React.PointerEvent, handlers: GestureHandlers) => {
    const startX = e.clientX;
    const startY = e.clientY;
    let dragged = false;
    let last = { x: startX, y: startY };
    /**
     * Whether this gesture is still the one holding the pointer.
     *
     * `handlers.drag` CAN END THE GESTURE — `invalidated` aborts from inside it
     * — and the code that called `drag` then keeps running. Without this flag
     * `onMove` re-arms the edge auto-scroll the teardown just stopped, against a
     * `pointermove` listener that is no longer installed: `pointerX` can never
     * change again, so the speed never returns to 0 and the rAF loop scrolls the
     * arrangement to the end forever.
     *
     * Not `abortRef.current !== abort` for the same job: a nested gesture would
     * make that read answer about somebody else's.
     */
    let live = true;

    const pointAt = (x: number, y: number): Point | null => {
      const geo = geometryRef.current();
      return geo ? geo.toContent(x, y) : null;
    };

    const apply = () => {
      const point = pointAt(last.x, last.y);
      if (point) handlers.drag(point, { x: last.x, y: last.y });
    };

    const onMove = (ev: PointerEvent) => {
      if (
        !dragged &&
        Math.abs(ev.clientX - startX) < DRAG_THRESHOLD_PX &&
        Math.abs(ev.clientY - startY) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      dragged = true;
      last = { x: ev.clientX, y: ev.clientY };
      apply();
      // `apply` may have torn this gesture down — see `live`. Re-arming the
      // auto-scroll after that is a rAF loop nothing can stop.
      if (!live) return;
      // Only once the press has become a drag: a click held over the edge is
      // not a request to go anywhere.
      edgeScrollRef.current.track(ev.clientX, apply);
    };

    /** The ONE place listeners come off and the undo bracket closes. */
    const teardown = () => {
      live = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', abort);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', abort);
      edgeScrollRef.current.end();
      abortRef.current = null;
      handlers.finish(dragged);
    };

    const abort = () => teardown();

    const onUp = (ev: PointerEvent) => {
      const point = pointAt(ev.clientX, ev.clientY);
      // Before the teardown, so the handler still sees the gesture's own state;
      // `teardown` is what closes the undo bracket either way.
      if (point) handlers.up(point, dragged, { x: ev.clientX, y: ev.clientY });
      teardown();
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      abort();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', abort);
    // Capture phase, so Escape reaches this before anything inside the page can
    // stop it — an aborted drag must never depend on who else is listening.
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', abort);
    abortRef.current = abort;
  };

  // ------------------------------------------------------------- gestures ---

  /**
   * Why a planned group move's lane change may not happen, or null.
   *
   * Measured against each placement's own SNAPSHOT — which is a `Pattern` — so a
   * mixed selection is judged member by member rather than by whatever the
   * anchor happens to be.
   */
  const laneChangeRefusal = (
    plan: readonly PlacementDragItem[],
    lanes: readonly LaneRect[],
  ): string | null => {
    for (const move of plan) {
      const trackId = lanes[move.trackIndex]?.trackId;
      if (trackId === undefined) continue;
      const found = findPlacement(move.id);
      // Already on that track: not a lane change, so nothing to refuse.
      if (!found || found.track.id === trackId) continue;
      const track = findTrack(trackId);
      if (!track) continue;
      const blocked = patternDropRefusal(found.placement.patternSnapshot, track);
      if (blocked !== null) return blocked;
    }
    return null;
  };

  /** Drag a block, or a whole selection, along its lane and across lanes. */
  const startMove = (
    hit: Extract<ArrangementHit, { kind: 'placement' }>,
    e: React.PointerEvent,
    geo: GestureGeometry,
  ) => {
    // THE CAPTURE, before anything is selected or written: every index below is
    // an index into `captured.lanes`, and the gesture resolves through that one
    // array for its whole life — see `GestureCapture`.
    const captured = capture(geo);
    const eligible = uiSelection();
    const alreadySelected = eligible.includes(hit.placementId);
    // Grabbing a block outside the selection replaces it; grabbing one inside
    // keeps the group, so a multi-selection drags as a unit. Same rule as
    // `Timeline.tsx`, deliberately — one selection model for both surfaces.
    //
    // `eligible`, not the raw store selection: a selection written from outside
    // this page can name blocks on lanes the arrangement is not drawing, and
    // dragging one visible block must not drag those along with it.
    const group = alreadySelected ? eligible : [hit.placementId];
    if (!alreadySelected) selectPlacements([hit.placementId]);

    const laneIndexOf = new Map(captured.lanes.map((lane, index) => [lane.trackId, index]));
    const items: PlacementDragItem[] = [];
    for (const id of group) {
      const found = findPlacement(id);
      if (!found) continue;
      // MEMBERSHIP VALIDATED BEFORE THE MOVE STARTS (§5): a block whose track is
      // not one of the captured Pattern lanes has no index in this frame, and a
      // gesture cannot express a delta from a lane that is not in the stack.
      const trackIndex = laneIndexOf.get(found.track.id);
      if (trackIndex === undefined) continue;
      items.push({ id, trackIndex, startTick: found.placement.startTick });
    }
    const anchor = items.find((item) => item.id === hit.placementId);
    if (!anchor) return;

    // Ticks between the pointer and the block's start, UNSNAPPED, so the block
    // doesn't jump to the cursor on grab.
    const grabOffset = hit.tick - anchor.startTick;

    beginEditGesture();
    beginPointerGesture(e, {
      drag(point) {
        const live = geometryRef.current();
        if (!live) return;
        // The world moved: end the drag through the ONE teardown, before this
        // frame writes anything against indices that no longer mean what they
        // meant. `abortInFlight` closes the undo bracket, so the moves already
        // made stay undoable as the one step they were.
        if (invalidated(captured, live)) {
          abortInFlight();
          return;
        }
        const wantedTick = snapArrangementTick(
          pxToTick(Math.max(0, point.x), live.pxPerBeat) - grabOffset,
          live.snap,
        );
        // Against the CAPTURED lanes, not the live ones — the point is current
        // (`toContent` is read live, so scrolling is already undone) but the
        // stack it is measured against is the gesture's own.
        const lane = laneAt(captured.lanes, point.y);
        const laneIndex = lane
          ? captured.lanes.findIndex((candidate) => candidate.trackId === lane.trackId)
          : anchor.trackIndex;

        const deltaTicks = wantedTick - anchor.startTick;
        let plan = planGroupMove(
          items,
          deltaTicks,
          laneIndex - anchor.trackIndex,
          captured.lanes.length,
        );
        // A drag across lanes is a placement onto another track, so it is held
        // to the same instrument rule a drop from the rail is — otherwise the
        // refusal CP-05 states out loud is defeated by dropping on the right
        // track and then dragging down one. The lane change is dropped rather
        // than the whole gesture: the block keeps following the pointer along
        // its own lane, which is the half of the drag that is still legal.
        const blocked = laneChangeRefusal(plan, captured.lanes);
        if (blocked !== null) {
          setRefusal(blocked);
          plan = planGroupMove(items, deltaTicks, 0, captured.lanes.length);
        } else {
          // Cleared as soon as the drag comes back to a lane it may enter, so
          // the reason describes where the block IS rather than where it was
          // briefly refused. Same value twice is a no-op re-render.
          setRefusal(null);
        }
        for (const move of plan) {
          const trackId = captured.lanes[move.trackIndex]?.trackId;
          if (trackId !== undefined) movePlacement(move.id, trackId, move.startTick);
        }
      },
      up() {},
      // No explicit `changed`: the seam's default is a reference comparison, so
      // a click that never became a drag wrote nothing and pushes no step.
      finish: () => endEditGesture(),
    });
  };

  /**
   * Drag either edge of a block.
   *
   * The right edge is one write. THE LEFT EDGE IS TWO, and they belong
   * together: the block's start moves and its length shrinks by the same
   * amount, so getting one right leaves a block that looks correct and plays
   * wrong. `lengthTicks` truncates from the snapshot's START — the lib's model
   * has no offset — so a left trim starts the same material later and shorter.
   *
   * The two writes are ordered by direction. Trimming inward, the resize goes
   * first: shortening the block frees the room the move then needs, so it never
   * momentarily overlaps its right-hand neighbour and gets deflected by the
   * lib's block/clamp. Growing outward, the move goes first, into space that is
   * already empty.
   *
   * Both targets are absolute against the gesture's opening snapshot, never
   * deltas against the live placement, so dozens of pointer moves cannot
   * compound — and a clamped intermediate state doesn't poison the next frame.
   */
  const startTrim = (
    hit: Extract<ArrangementHit, { kind: 'placement' }>,
    e: React.PointerEvent,
    edge: 'start' | 'end',
    geo: GestureGeometry,
  ) => {
    const found = findPlacement(hit.placementId);
    if (!found) return;
    // A trim never changes lane, so it captures nothing but the invalidation
    // baseline — which it still needs: a job taking the document, or the
    // composition being swapped, mid-trim is the same "write nothing more".
    const captured = capture(geo);
    if (!uiSelection().includes(hit.placementId)) selectPlacements([hit.placementId]);

    const from = {
      id: found.placement.id,
      trackId: found.track.id,
      startTick: found.placement.startTick,
      length: placementEffectiveLength(found.placement),
      /** A placement can never be longer than the material it was cut from. */
      maxLength: found.placement.patternSnapshot.durationTicks,
    };
    /**
     * The window `startTick` may move in.
     *
     * `resizePlacement` CLAMPS the length to `[PPQ, snapshot duration]` while
     * `movePlacement` honours whatever start it is given, so an unclamped start
     * makes the two writes disagree: dragging the left edge of an untrimmed
     * block further left refuses the (impossible) growth and performs the move
     * on its own — the user grabs an edge and the whole block slides, right edge
     * included. Dragging it past the block's own end is the same failure
     * mirrored: the length floors at one beat and the block relocates entirely
     * past where it was. Clamping the start into what the resize can actually
     * honour is what keeps the pair consistent.
     */
    const minStart = Math.max(0, from.startTick + from.length - from.maxLength);
    const maxStart = Math.max(minStart, from.startTick + from.length - PPQ);

    beginEditGesture();
    beginPointerGesture(e, {
      drag(point) {
        const live = geometryRef.current();
        if (!live) return;
        if (invalidated(captured, live)) {
          abortInFlight();
          return;
        }
        const tick = snapArrangementTick(pxToTick(Math.max(0, point.x), live.pxPerBeat), live.snap);

        if (edge === 'end') {
          resizePlacement(from.id, tick - from.startTick);
          return;
        }

        const nextStart = Math.min(Math.max(tick, minStart), maxStart);
        const nextLength = from.length - (nextStart - from.startTick);
        if (nextStart > from.startTick) {
          resizePlacement(from.id, nextLength);
          movePlacement(from.id, from.trackId, nextStart);
        } else {
          movePlacement(from.id, from.trackId, nextStart);
          resizePlacement(from.id, nextLength);
        }
      },
      up() {},
      finish: () => endEditGesture(),
    });
  };

  /**
   * Rubber-band over empty lane space. Selection is not an edit, so no undo
   * bracket is opened — there is nothing here for an abort to wedge.
   *
   * It captures and checks `invalidated` anyway (§5: EVERY gesture finishes or
   * cancels through the existing teardown). A band measured against one stack of
   * lanes and swept over another selects rows the user never dragged across, and
   * `before` — captured once — can name a placement a job has since deleted.
   * Cheaper to end it than to re-derive a band nobody asked for.
   */
  const startMarquee = (e: React.PointerEvent, geo: GestureGeometry) => {
    const captured = capture(geo);
    // The anchor is kept in CONTENT space for the same reason the drag targets
    // are: under edge auto-scroll the lanes slide but the corner the user
    // started from stays on the block they started from, so the band grows
    // instead of sliding along with the view.
    const origin = geo.toContent(e.clientX, e.clientY);
    const additive = e.shiftKey;
    // The ELIGIBLE selection is what a shift-marquee adds to. Starting from the
    // raw store selection would write ineligible ids back through
    // `selectPlacements` as though the user had just picked them.
    const before = additive ? uiSelection() : [];
    /** The previous frame's hits, so an auto-scroll frame that changes nothing
     *  doesn't re-render the whole arrangement 60 times a second. */
    let lastHits: string | null = null;

    beginPointerGesture(e, {
      drag(point) {
        const live = geometryRef.current();
        if (!live) return;
        if (invalidated(captured, live)) {
          abortInFlight();
          return;
        }
        const band = {
          left: Math.min(origin.x, point.x),
          right: Math.max(origin.x, point.x),
          top: Math.min(origin.y, point.y),
          bottom: Math.max(origin.y, point.y),
        };
        setPreview({
          kind: 'marquee',
          left: band.left,
          top: band.top,
          width: band.right - band.left,
          height: band.bottom - band.top,
        });

        // Pattern lanes only: a band dragged across an Edit or Voice row must
        // not sweep up blocks that row is not drawing.
        const hits = placementsInBand(
          band,
          patternLanesOf(live),
          live.tracks,
          live.pxPerBeat,
        );
        const key = hits.join(' ');
        if (key === lastHits) return;
        lastHits = key;
        selectPlacements([...new Set([...before, ...hits])]);
      },
      up(_point, dragged) {
        // A plain click on empty lane space clears the selection. Shift-click
        // on empty space keeps it — otherwise the modifier that means "add"
        // would be the one that wipes.
        if (!dragged && !additive) selectPlacements([]);
      },
      finish: () => setPreview(null),
    });
  };

  /** Drag a pattern out of the library rail and onto a lane. */
  const startPatternDrag = (patternId: string, e: React.PointerEvent) => {
    // Guarded HERE and not only in the rail's row: this is a public member of
    // `ArrangementGestures`, and a right- or middle-press that reached it would
    // start a drag whose `pointerup` may never arrive.
    if (e.button !== 0) return;
    // The rail holds the note inspector in edit mode, so nothing there can start
    // a pattern drag — but the entry point is public and must refuse anyway.
    // POINTER eligibility: a drop needs a Pattern lane to land on, and it names
    // its own target, so it does not care which track is selected.
    if (!pointerEnabled) return;
    abortInFlight();
    const pattern = findLibraryPattern(patternId);
    if (!pattern) return;
    setRefusal(null);

    beginPointerGesture(e, {
      drag(point, client) {
        const live = geometryRef.current();
        if (!live) return;
        // Off the lane viewport there is nothing to drop onto — see
        // `GestureGeometry.inViewport`.
        if (!live.inViewport(client.x, client.y)) {
          setPreview(null);
          return;
        }
        // Pattern lanes only, with their original tops: an Edit or Voice row is
        // a gap a drop falls through rather than a lane it lands on.
        const dropLanes = patternLanesOf(live);
        const target = dropTarget(point, dropLanes, live.pxPerBeat, live.snap);
        const lane = target
          ? dropLanes.find((candidate) => candidate.trackId === target.trackId)
          : undefined;
        // Outside the lanes there is no track to guess at, so no indicator —
        // `dropTarget` returns null for exactly this reason.
        if (!target || !lane) {
          setPreview(null);
          return;
        }
        const track = findTrack(target.trackId);
        const left = tickToPx(target.tick, live.pxPerBeat);
        setPreview({
          kind: 'drop',
          trackId: target.trackId,
          left,
          top: lane.top,
          // The snapshot's own duration: a fresh placement is never truncated,
          // so this is exactly the width the block will have.
          width: tickToPx(target.tick + pattern.durationTicks, live.pxPerBeat) - left,
          height: lane.height,
          label: pattern.name,
          refusal: track ? patternDropRefusal(pattern, track) : 'That track is gone.',
        });
      },
      up(point, dragged, client) {
        // A press that never moved is the rail button's click, not a drop.
        if (!dragged) return;
        const live = geometryRef.current();
        if (!live) return;
        // Released over the rail, the toolbar or off the window entirely: the
        // gesture ends with nothing placed, exactly as a release outside an
        // HTML5 drop target would.
        if (!live.inViewport(client.x, client.y)) return;
        const target = dropTarget(point, patternLanesOf(live), live.pxPerBeat, live.snap);
        if (!target) return;
        const track = findTrack(target.trackId);
        if (!track) return;

        const blocked = patternDropRefusal(pattern, track);
        if (blocked) {
          setRefusal(blocked);
          return;
        }
        beginEditGesture();
        const placed = addPlacement(pattern.id, target.trackId, target.tick);
        endEditGesture();
        if (!placed.ok) setRefusal(placed.reason);
      },
      finish: () => setPreview(null),
    });
  };

  const onLanesPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (!pointerEnabled) return;
    abortInFlight();
    const geo = geometry();
    if (!geo) return;

    const point = geo.toContent(e.clientX, e.clientY);
    // PATTERN LANES ONLY, with their original tops. A press on an Edit or Voice
    // row lands in a gap and `laneAt` answers null, so `hitTest` answers null
    // and the press does nothing here — which is what lets the note surface
    // underneath own it. The full `geo.tracks` is safe: `hitTest` resolves a
    // track by the id of the lane it matched.
    const hit = hitTest(point, patternLanesOf(geo), geo.tracks, geo.pxPerBeat);
    // BEFORE `preventDefault` and before the focus is taken, and that ordering
    // is the whole of the split in §4. While `pointerEnabled` meant "the page is
    // in pattern view" this handler never ran over a lane it did not own; it now
    // means "SOME lane is a Pattern lane", and `NoteSurface.onLaneDown` does not
    // stop propagation — so a press on an Edit lane's empty row bubbles here.
    // Suppressing its default and yanking DOM focus to the scroller on the way
    // past would break the row's own handling of a press the arrangement has
    // just declined.
    if (hit === null) return;
    // Stops the browser selecting the block labels the drag passes over — which
    // also suppresses the focus the press would otherwise move, so the scroller
    // is focused by hand. Without it, pressing a lane leaves focus wherever it
    // was and the arrangement cannot be scrolled by keyboard afterwards.
    e.preventDefault();
    scrollerRef.current?.focus();
    setRefusal(null);
    // THE LANE'S ENTRY INTO THE ACTIVATION COORDINATOR, and it comes before the
    // cursor tick is recorded and before any gesture starts: a press on a lane
    // selects the track that owns it, and a REFUSED activation (the track has
    // gone, a job holds the document) must leave the press doing nothing at all
    // rather than moving a block on a track the page is not pointed at.
    if (!activateTrack(hit.trackId)) return;
    // Snapped, exactly as `onLanesPointerMove` snaps it: `hitTest` reports an
    // UNSNAPPED tick on purpose (snap belongs to the gesture), and storing it
    // raw here would make Split cut at an arbitrary tick after a press and at a
    // bar line after a move — one button doing two things.
    cursorTickRef.current = snapArrangementTick(hit.tick, geo.snap);

    if (hit.kind === 'lane') {
      startMarquee(e, geo);
      return;
    }
    // Shift is the selection modifier wherever a block can be grabbed —
    // including the trim edges, which are easy to hit by accident.
    if (e.shiftKey) {
      // Computed rather than `'toggle'`, because the seam's toggle acts on the
      // STORE's selection and would carry ineligible ids — a selection written
      // from outside this page — along with the one block the user picked.
      const current = uiSelection();
      selectPlacements(
        current.includes(hit.placementId)
          ? current.filter((id) => id !== hit.placementId)
          : [...current, hit.placementId],
      );
      return;
    }
    if (hit.zone === 'body') startMove(hit, e, geo);
    else startTrim(hit, e, hit.zone === 'trim-start' ? 'start' : 'end', geo);
  };

  const onLanesPointerMove = (e: React.PointerEvent) => {
    if (!pointerEnabled) return;
    const geo = geometry();
    if (!geo) return;
    const point = geo.toContent(e.clientX, e.clientY);
    cursorTickRef.current = snapArrangementTick(
      pxToTick(Math.max(0, point.x), geo.pxPerBeat),
      geo.snap,
    );
  };

  // ---------------------------------------------------- the UI's commands ---
  // ONE implementation per command, shared by the toolbar button and the
  // shortcut — see `ArrangementGestures.effectiveSelection`. Each reads
  // `isPatternLaneRef` at the moment it fires, so eligibility is decided at
  // EXECUTION time and not at the render that drew the button.

  /** Report a capability's refusal in the gesture strip, and clear it on
   *  success so a stale sentence doesn't outlive the thing it described. */
  const report = (result: Result<unknown>) => setRefusal(result.ok ? null : result.reason);

  const selectAll = () => report(selectAllPlacements(isPatternLaneRef.current));
  const deleteSelection = () => report(deleteSelectedPlacements(isPatternLaneRef.current));
  const duplicateSelection = () => report(duplicateSelectedPlacements(isPatternLaneRef.current));
  const transposeSelection = (semitones: number) =>
    report(transposeSelectedPlacements(semitones, isPatternLaneRef.current));

  const splitAtCursor = () => {
    const tick = cursorTickRef.current;
    if (tick === null) {
      setRefusal('Move the cursor to where the cut should go, then split.');
      return;
    }
    report(splitSelectedPlacements(tick, isPatternLaneRef.current));
  };

  /** The same four, for the window key handler — which installs its listeners
   *  once and so outlives the render that built them. Same reason as
   *  `geometryRef` and `isPatternLaneRef` above. */
  const commandsRef = useRef({ selectAll, deleteSelection, duplicateSelection, transposeSelection });
  commandsRef.current = { selectAll, deleteSelection, duplicateSelection, transposeSelection };

  // Editing shortcuts. One listener for all of them, so nothing races a second
  // handler for the same key. `Timeline`'s equivalent is never mounted at the
  // same time — `App` swaps the whole page — so the two cannot collide.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not ours in edit mode — `NoteSurface` answers the same keys against the
      // notes. Still ends a run in flight: a mode switch mid-hold must not leave
      // the bracket open.
      if (!keyboardEnabledRef.current) {
        endTransposeRun();
        return;
      }
      // Inside a control that answers arrows for itself — a field, a `select`,
      // a `Knob` (`role="slider"`) or a `ParamEncoder` (`role="spinbutton"`).
      // ONE predicate, shared with `NoteSurface`'s handler, because a second
      // copy of the list is how the two dials came to be missing from both.
      if (insideKeyboardControl(e.target)) {
        endTransposeRun();
        return;
      }
      if (!e.repeat) endTransposeRun();

      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        commandsRef.current.duplicateSelection();
        return;
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        // Not `selectAllPlacements()`: Select All enumerates only the lanes this
        // view owns, or the next Delete reaches blocks nothing is drawing (§5).
        commandsRef.current.selectAll();
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (uiSelection().length === 0) return;
        e.preventDefault();
        commandsRef.current.deleteSelection();
        return;
      }

      // Everything below edits the selection, so there has to be one — and an
      // ELIGIBLE one. Resolved here, at the keystroke, against live state.
      if (uiSelection().length === 0) return;

      if (!mod && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        // Without this the lane area scrolls under the gesture.
        e.preventDefault();
        // A held key repeats ~30 times a second; bracketing the repeats keeps
        // the whole hold to the one step the first press pushed. This works
        // only because `beginEditGesture` counts depth: the capability below
        // brackets itself, and without the count its inner close would end THIS
        // bracket on the first repeat and every later repeat would push a step
        // of its own.
        if (e.repeat && !transposeRun.current) {
          transposeRun.current = true;
          beginEditGesture();
        }
        // Shift is an octave, matching the pattern editor's fret nudge.
        commandsRef.current.transposeSelection(
          (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1),
        );
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') endTransposeRun();
    };
    // Capture phase: a pointer edit landing mid-run would otherwise open a
    // gesture inside the keyboard one, and `history` holds a single snapshot —
    // so one of the two edits would vanish from the undo stack entirely.
    const onPointerDown = () => endTransposeRun();

    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);

  // A pointer gesture parks its listeners on `window` and can outlive this
  // component. Without this an unmount mid-drag leaves the undo bracket open,
  // and `history.capture` then ignores EVERY later edit for the life of the
  // page — the failure this whole module is arranged around. A held arrow key
  // leaves the same bracket open, so it closes here too.
  useEffect(
    () => () => {
      // Inner bracket first — see `endGestures` for why the order decides
      // whether the drag's undo step survives.
      endTransposeRun();
      abortRef.current?.();
    },
    // `endTransposeRun` reads only refs, so the first render's copy is the same
    // function every later one would build — see its declaration.
    [],
  );

  return {
    onLanesPointerDown,
    onLanesPointerMove,
    startPatternDrag,
    preview,
    refusal,
    dismissRefusal: () => setRefusal(null),
    // Render-time, from the reactive selection — what the toolbar counts and
    // shows. The COMMANDS re-derive it at execution time instead.
    effectiveSelection: eligibleSelection(selectedIds, isPatternLane),
    selectAll,
    deleteSelection,
    duplicateSelection,
    transposeSelection,
    splitAtCursor,
    endGestures,
  };
}
