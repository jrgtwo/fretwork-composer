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
 */
export function selectAllPlacements(): Result<number> {
  const ids = getTracks().flatMap((track) => track.placements.map((p) => p.id));
  if (ids.length === 0) return refuse('Nothing is placed yet.');
  selectPlacements(ids);
  return ok(ids.length);
}

/** Remove every selected placement as one undo step. */
export function deleteSelectedPlacements(): Result<number> {
  const ids = getSelectedPlacementIds();
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
export function duplicateSelectedPlacements(): Result<number> {
  const ids = getSelectedPlacementIds();
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
export function transposeSelectedPlacements(semitones: number): Result<number> {
  const ids = getSelectedPlacementIds();
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
export function splitSelectedPlacements(atTick: Tick): Result<number> {
  const ids = getSelectedPlacementIds();
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
  /** Split the selection at the last tick the pointer was over. */
  splitAtCursor(): void;
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
}

export function useArrangementGestures({
  geometry,
  scrollerRef,
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
  const selectedRef = useRef(selectedIds);
  selectedRef.current = selectedIds;
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;

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

  const beginPointerGesture = (e: React.PointerEvent, handlers: GestureHandlers) => {
    const startX = e.clientX;
    const startY = e.clientY;
    let dragged = false;
    let last = { x: startX, y: startY };

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
      // Only once the press has become a drag: a click held over the edge is
      // not a request to go anywhere.
      edgeScrollRef.current.track(ev.clientX, apply);
    };

    /** The ONE place listeners come off and the undo bracket closes. */
    const teardown = () => {
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
  const startMove = (hit: Extract<ArrangementHit, { kind: 'placement' }>, e: React.PointerEvent, geo: GestureGeometry) => {
    const alreadySelected = selectedRef.current.includes(hit.placementId);
    // Grabbing a block outside the selection replaces it; grabbing one inside
    // keeps the group, so a multi-selection drags as a unit. Same rule as
    // `Timeline.tsx`, deliberately — one selection model for both surfaces.
    const group = alreadySelected ? [...selectedRef.current] : [hit.placementId];
    if (!alreadySelected) selectPlacements([hit.placementId]);

    const laneIndexOf = new Map(geo.lanes.map((lane, index) => [lane.trackId, index]));
    const items: PlacementDragItem[] = [];
    for (const id of group) {
      const found = findPlacement(id);
      if (!found) continue;
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
        const wantedTick = snapArrangementTick(
          pxToTick(Math.max(0, point.x), live.pxPerBeat) - grabOffset,
          live.snap,
        );
        const lane = laneAt(live.lanes, point.y);
        const laneIndex = lane
          ? live.lanes.findIndex((candidate) => candidate.trackId === lane.trackId)
          : anchor.trackIndex;

        const deltaTicks = wantedTick - anchor.startTick;
        let plan = planGroupMove(
          items,
          deltaTicks,
          laneIndex - anchor.trackIndex,
          live.lanes.length,
        );
        // A drag across lanes is a placement onto another track, so it is held
        // to the same instrument rule a drop from the rail is — otherwise the
        // refusal CP-05 states out loud is defeated by dropping on the right
        // track and then dragging down one. The lane change is dropped rather
        // than the whole gesture: the block keeps following the pointer along
        // its own lane, which is the half of the drag that is still legal.
        const blocked = laneChangeRefusal(plan, live.lanes);
        if (blocked !== null) {
          setRefusal(blocked);
          plan = planGroupMove(items, deltaTicks, 0, live.lanes.length);
        } else {
          // Cleared as soon as the drag comes back to a lane it may enter, so
          // the reason describes where the block IS rather than where it was
          // briefly refused. Same value twice is a no-op re-render.
          setRefusal(null);
        }
        for (const move of plan) {
          const trackId = live.lanes[move.trackIndex]?.trackId;
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
  ) => {
    const found = findPlacement(hit.placementId);
    if (!found) return;
    if (!selectedRef.current.includes(hit.placementId)) selectPlacements([hit.placementId]);

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

  /** Rubber-band over empty lane space. Selection is not an edit, so no undo
   *  bracket is opened — there is nothing here for an abort to wedge. */
  const startMarquee = (e: React.PointerEvent, geo: GestureGeometry) => {
    // The anchor is kept in CONTENT space for the same reason the drag targets
    // are: under edge auto-scroll the lanes slide but the corner the user
    // started from stays on the block they started from, so the band grows
    // instead of sliding along with the view.
    const origin = geo.toContent(e.clientX, e.clientY);
    const additive = e.shiftKey;
    const before = additive ? [...selectedRef.current] : [];
    /** The previous frame's hits, so an auto-scroll frame that changes nothing
     *  doesn't re-render the whole arrangement 60 times a second. */
    let lastHits: string | null = null;

    beginPointerGesture(e, {
      drag(point) {
        const live = geometryRef.current();
        if (!live) return;
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

        const hits = placementsInBand(band, live.lanes, live.tracks, live.pxPerBeat);
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
        const target = dropTarget(point, live.lanes, live.pxPerBeat, live.snap);
        const lane = target
          ? live.lanes.find((candidate) => candidate.trackId === target.trackId)
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
        const target = dropTarget(point, live.lanes, live.pxPerBeat, live.snap);
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
    abortInFlight();
    const geo = geometry();
    if (!geo) return;
    // Stops the browser selecting the block labels the drag passes over — which
    // also suppresses the focus the press would otherwise move, so the scroller
    // is focused by hand. Without it, pressing a lane leaves focus wherever it
    // was and the arrangement cannot be scrolled by keyboard afterwards.
    e.preventDefault();
    scrollerRef.current?.focus();
    setRefusal(null);

    const point = geo.toContent(e.clientX, e.clientY);
    const hit = hitTest(point, geo.lanes, geo.tracks, geo.pxPerBeat);
    if (hit === null) return;
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
      selectPlacements([hit.placementId], 'toggle');
      return;
    }
    if (hit.zone === 'body') startMove(hit, e, geo);
    else startTrim(hit, e, hit.zone === 'trim-start' ? 'start' : 'end');
  };

  const onLanesPointerMove = (e: React.PointerEvent) => {
    const geo = geometry();
    if (!geo) return;
    const point = geo.toContent(e.clientX, e.clientY);
    cursorTickRef.current = snapArrangementTick(
      pxToTick(Math.max(0, point.x), geo.pxPerBeat),
      geo.snap,
    );
  };

  const splitAtCursor = () => {
    const tick = cursorTickRef.current;
    if (tick === null) {
      setRefusal('Move the cursor to where the cut should go, then split.');
      return;
    }
    const result = splitSelectedPlacements(tick);
    setRefusal(result.ok ? null : result.reason);
  };

  // Editing shortcuts. One listener for all of them, so nothing races a second
  // handler for the same key. `Timeline`'s equivalent is never mounted at the
  // same time — `App` swaps the whole page — so the two cannot collide.
  useEffect(() => {
    /** Close the bracket swallowing a held arrow's repeats. Its snapshot is
     *  DISCARDED rather than pushed: the key's first press already recorded the
     *  pre-transpose state, so the whole hold undoes as that one step. */
    const endTransposeRun = () => {
      if (!transposeRun.current) return;
      transposeRun.current = false;
      endEditGesture(false);
    };

    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // A `select` counts: arrows are how you change one.
      if (target?.matches('input, textarea, select, [contenteditable]')) {
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
        const result = duplicateSelectedPlacements();
        if (!result.ok) setRefusal(result.reason);
        return;
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const result = selectAllPlacements();
        if (!result.ok) setRefusal(result.reason);
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (selectedRef.current.length === 0) return;
        e.preventDefault();
        deleteSelectedPlacements();
        return;
      }

      // Everything below edits the selection, so there has to be one.
      if (selectedRef.current.length === 0) return;

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
        transposeSelectedPlacements((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1));
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
      abortRef.current?.();
      if (transposeRun.current) {
        transposeRun.current = false;
        endEditGesture(false);
      }
    },
    [],
  );

  return {
    onLanesPointerDown,
    onLanesPointerMove,
    startPatternDrag,
    preview,
    refusal,
    dismissRefusal: () => setRefusal(null),
    splitAtCursor,
  };
}
