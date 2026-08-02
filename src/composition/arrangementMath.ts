/**
 * Geometry for the arrangement grid: ticks ↔ pixels at composition scale, where
 * the lanes sit, where a placement's block lands, and what is under the cursor.
 *
 * Separate from `timelineMath` in charter, not in arithmetic — the tick↔pixel
 * conversion, the bar/beat lines, the zoom steps and the snap menu are all
 * imported from there rather than restated. Two copies of a time↔pixel
 * conversion that drift is a silent wrong-note bug, and the two surfaces share a
 * time axis by design (see `tickets/composition-page/README.md`).
 *
 * No React, no DOM, no store. jsdom has no layout — every `getBoundingClientRect`
 * is 0×0 — so geometry is only testable while it is a plain function.
 */
import {
  getInstrument,
  placementEffectiveLength,
  placementEndTick,
  snapTick,
  ticksPerBar,
  ticksPerBeat,
  type PatternEvent,
  type PatternTimeSignature,
  type Placement,
  type Tick,
} from '@fretwork/lib';
import {
  DEFAULT_ZOOM_INDEX,
  ZOOM_LEVELS,
  barBeatLines,
  pxToTick,
  snapOptions,
  tickToPx,
  type GridLine,
  type SnapOption,
} from '../timeline/timelineMath';

export { pxToTick, tickToPx };

// ------------------------------------------------------------------- zoom ---

/**
 * Composition-scale zoom, derived from the pattern editor's steps rather than
 * restated, with two coarser levels prepended: a whole song has to fit on
 * screen, and at 12 px/beat a 100-bar arrangement is 4800 px wide.
 *
 * Deliberately a separate list instead of widening `ZOOM_LEVELS` in place:
 * prepending there would silently shift `DEFAULT_ZOOM_INDEX`, and with it the
 * pattern page's default zoom. The values still come from one place.
 */
export const ARRANGEMENT_ZOOM_LEVELS = [3, 6, ...ZOOM_LEVELS] as const;

const COARSE_ZOOM_COUNT = ARRANGEMENT_ZOOM_LEVELS.length - ZOOM_LEVELS.length;

/** Opens at the same px/beat the pattern editor opens at, so switching pages
 *  does not rescale the time axis under the user. */
export const DEFAULT_ARRANGEMENT_ZOOM_INDEX = COARSE_ZOOM_COUNT + DEFAULT_ZOOM_INDEX;

// ------------------------------------------------------------------- snap ---

/**
 * Arrangement gestures snap to the bar, not the 16th. This is the one place the
 * two surfaces intentionally disagree: note entry needs sub-beat resolution,
 * dropping a four-bar riff a 16th late is never what was meant.
 */
export const DEFAULT_ARRANGEMENT_SNAP_ID = 'bar';

/** Resolve a snap id against the same menu the pattern editor offers. Unknown
 *  ids fall back to the bar rather than to the editor's 16th — `snapOptions`
 *  emits the bar first, so `options[0]` IS the arrangement default (pinned by a
 *  test, because that ordering is `timelineMath`'s to change). */
export function arrangementSnap(ts: PatternTimeSignature, snapId: string): SnapOption {
  const options = snapOptions(ts);
  return options.find((option) => option.id === snapId) ?? options[0];
}

/** Quantize a tick to a snap option. A `null` grid (`'off'`) passes through. */
export function snapArrangementTick(tick: Tick, snap: SnapOption | null): Tick {
  if (snap === null || snap.ticks === null) return Math.max(0, Math.round(tick));
  return Math.max(0, snapTick(Math.max(0, tick), snap.ticks));
}

/**
 * How many bars a span of ticks occupies, rounded up.
 *
 * The pattern library rail's "4 bars" is this and nothing else — DERIVED, never
 * stored. `fitPatternDuration` re-fits a pattern's length to its content on
 * every edit (docs/HANDOFF.md, hard-won facts), so a bar count cached anywhere
 * is a bar count that goes stale the next time a note is dragged.
 *
 * Rounded up because a riff that runs a beat into bar 3 occupies three bars of
 * the arrangement, not two and a bit. A non-positive or non-finite span is 0
 * bars rather than NaN — an empty pattern has no length to print.
 */
export function barsSpanned(ticks: Tick, ts: PatternTimeSignature): number {
  const perBar = ticksPerBar(ts);
  if (!(perBar > 0) || !Number.isFinite(ticks) || ticks <= 0) return 0;
  return Math.ceil(ticks / perBar);
}

// ------------------------------------------------------------------ ruler ---

/** Every Nth bar gets a stronger line and a printed number when the ruler is
 *  too dense to number every bar. */
export const MAJOR_DIVISION_BARS = 4;

/** Below this, beat lines are closer together than the eye resolves and the
 *  ruler reads as a smear — draw bars only. */
const MIN_BEAT_LINE_PX = 18;

/** Below this bar width, numbering every bar collides; number the majors only. */
const MIN_BAR_LABEL_PX = 44;

export interface RulerMark extends GridLine {
  /** Bar line at a `MAJOR_DIVISION_BARS` boundary — stronger rule. */
  major: boolean;
  /** Printed bar number, or null when this mark is unlabelled. */
  label: string | null;
}

/**
 * Ruler marks across `bars`, built on the pattern editor's `barBeatLines` so the
 * arrangement ruler and the note grid cannot disagree about where beat 3 is.
 *
 * The composition ruler labels BARS, not beats, and thins itself out as it zooms
 * out: beat lines disappear first, then all but every fourth bar number.
 *
 * Constant meter only. `Composition.timeSignatureTrack` exists in the lib and its
 * import pipeline populates it, but nothing in this app writes it and no ticket
 * in `tickets/composition-page/` reads it; a meter map would have to be walked
 * here (and in `arrangementBars`) exactly as guitar-tutor's `computeBarLines`
 * walks one, or every bar line after the first change lands on the wrong tick.
 */
export function rulerMarks(
  bars: number,
  ts: PatternTimeSignature,
  pxPerBeat: number,
): RulerMark[] {
  // Measured against the REAL spacing, not against pxPerBeat: `tickToPx` divides
  // by PPQ, so pxPerBeat is pixels per QUARTER. In 7/8 the notated beat is half
  // that, and comparing the two directly draws beat lines 12 px apart under an
  // 18 px legibility floor.
  const showBeats = tickToPx(ticksPerBeat(ts), pxPerBeat) >= MIN_BEAT_LINE_PX;
  const labelEveryBar = tickToPx(ticksPerBar(ts), pxPerBeat) >= MIN_BAR_LABEL_PX;
  const marks: RulerMark[] = [];
  for (const line of barBeatLines(bars, ts, pxPerBeat)) {
    if (!line.isBar && !showBeats) continue;
    const major = line.isBar && (line.bar - 1) % MAJOR_DIVISION_BARS === 0;
    marks.push({
      ...line,
      major,
      label: line.isBar && (labelEveryBar || major) ? String(line.bar) : null,
    });
  }
  return marks;
}

// ------------------------------------------------------------------ lanes ---

/**
 * What a lane draws. The grid itself — ruler, headers, time axis, scroll — is
 * identical in all three; only the lane content and the rail change
 * (`tickets/composition-page/README.md`).
 */
export type ArrangementMode = 'pattern' | 'edit' | 'voice';

/**
 * Default lane height per mode. Pattern mode draws one block row, so eight
 * tracks plus a ruler fit a laptop viewport without scrolling; edit mode has to
 * hold a full set of string rows, and voice mode a rack face.
 *
 * The edit and voice figures are placeholders owned by CP-11 and CP-14 — those
 * tickets know their content's real height. Nothing in slice 1 renders them.
 */
export const DEFAULT_LANE_HEIGHTS: Record<ArrangementMode, number> = {
  pattern: 88,
  edit: 192,
  voice: 192,
};

/** The height of the ruler strip. Lanes start below it. */
export const RULER_HEIGHT = 28;

/** Width of the fixed track-header column to the left of the lanes. */
export const TRACK_HEADER_WIDTH = 200;

/** Only the identity is needed to lay a lane out; a lib `Track` satisfies it. */
export interface LaneTrack {
  readonly id: string;
}

/** A track that also carries its content, for hit testing. A lib `Track`
 *  satisfies this too. */
export interface PlacedTrack extends LaneTrack {
  readonly placements: readonly Placement[];
}

export interface LaneRect {
  readonly trackId: string;
  readonly top: number;
  readonly height: number;
}

/**
 * How tall each lane is. A per-mode table covers the common case; the function
 * form exists because edit mode's height genuinely varies per track — a bass
 * lane has four string rows where a guitar lane has six.
 */
export type LaneHeights =
  | Partial<Record<ArrangementMode, number>>
  | ((track: LaneTrack, mode: ArrangementMode) => number);

function resolveLaneHeight(
  track: LaneTrack,
  mode: ArrangementMode,
  laneHeights: LaneHeights,
): number {
  const raw =
    typeof laneHeights === 'function'
      ? laneHeights(track, mode)
      : (laneHeights[mode] ?? DEFAULT_LANE_HEIGHTS[mode]);
  return Number.isFinite(raw) ? Math.max(0, raw) : DEFAULT_LANE_HEIGHTS[mode];
}

/**
 * Stack the lanes top to bottom. Rects are half-open (`top <= y < top + height`)
 * so a point on a boundary belongs to exactly one lane — the alternative silently
 * hits two, and the second one wins by iteration order.
 *
 * Coordinates are lane-area content space: y = 0 is the first lane's top, the
 * ruler is not included, and the caller has already undone scroll.
 */
export function laneRects(
  tracks: readonly LaneTrack[],
  mode: ArrangementMode,
  laneHeights: LaneHeights = DEFAULT_LANE_HEIGHTS,
): LaneRect[] {
  const rects: LaneRect[] = [];
  let top = 0;
  for (const track of tracks) {
    const height = resolveLaneHeight(track, mode, laneHeights);
    rects.push({ trackId: track.id, top, height });
    top += height;
  }
  return rects;
}

/** Total height of a stack of lanes — the lane area's scrollable content height.
 *  Takes the lowest edge rather than the last entry's: `laneRects` returns them
 *  in order, but callers hand-build lane arrays too. */
export function lanesHeight(lanes: readonly LaneRect[]): number {
  return lanes.reduce((height, lane) => Math.max(height, lane.top + lane.height), 0);
}

/** The lane containing `y`, or null above the first / below the last. */
export function laneAt(lanes: readonly LaneRect[], y: number): LaneRect | null {
  return lanes.find((lane) => y >= lane.top && y < lane.top + lane.height) ?? null;
}

// ------------------------------------------------------------- placements ---

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * `repeat` as a drawable count. The lib documents `repeat >= 1` and the new UI
 * writes nothing else, but a legacy or hand-edited composition can carry 0 or a
 * fraction — and a zero-width block cannot be grabbed to fix itself.
 *
 * Shared by `placementRect` and `placementRepeatRects` so the block and its
 * internal divisions can never disagree about where the right edge is. Note
 * `Math.floor(NaN)` is `NaN` and `Math.max(1, NaN)` is `NaN`, so the finiteness
 * check has to come after the floor, not instead of it.
 */
function repeatCount(placement: Placement): number {
  const repeat = Math.floor(placement.repeat);
  return Number.isFinite(repeat) ? Math.max(1, repeat) : 1;
}

/**
 * Where a placement's block draws inside its lane.
 *
 * Length comes from the lib's `placementEffectiveLength`, never from
 * `patternSnapshot.durationTicks`: `lengthTicks` OVERRIDES the snapshot's
 * duration when non-null (a trimmed placement) and `repeat` multiplies it
 * (legacy placements only — the new UI exposes no repeat control). Recomputing
 * that formula here is the exact bug this indirection exists to prevent; for any
 * well-formed placement this is `placementEndTick` exactly, and a test pins it.
 */
export function placementRect(
  placement: Placement,
  pxPerBeat: number,
  laneTop: number,
  laneHeight: number,
): Rect {
  const endTick =
    placement.startTick + placementEffectiveLength(placement) * repeatCount(placement);
  const left = tickToPx(placement.startTick, pxPerBeat);
  return {
    left,
    top: laneTop,
    width: tickToPx(endTick, pxPerBeat) - left,
    height: laneHeight,
  };
}

/**
 * One rect per repetition, left to right. A repeated legacy placement is a
 * single block with internal divisions — the divisions have to land on the
 * repetition boundaries or the block lies about where its pattern restarts.
 */
export function placementRepeatRects(
  placement: Placement,
  pxPerBeat: number,
  laneTop: number,
  laneHeight: number,
): Rect[] {
  const length = placementEffectiveLength(placement);
  const repeats = repeatCount(placement);
  const rects: Rect[] = [];
  for (let i = 0; i < repeats; i++) {
    const startTick = placement.startTick + length * i;
    const left = tickToPx(startTick, pxPerBeat);
    rects.push({
      left,
      top: laneTop,
      width: tickToPx(startTick + length, pxPerBeat) - left,
      height: laneHeight,
    });
  }
  return rects;
}

/**
 * Last tick occupied by any placement on any track. 0 when nothing is placed.
 *
 * LIB-GAP(11): this is the lib's `totalDurationTicks(comp)` done correctly — that
 * one measures a placement as `startTick + patternSnapshot.durationTicks * repeat`
 * and never consults `lengthTicks`, so a trimmed block claims its snapshot's full
 * width and the ruler draws up to 4× too many bars. `compositionService.arrangementEnd`
 * masks the same gap on a whole `Composition`; delete both when the lib's
 * `totalDurationTicks` routes through `placementEndTick`.
 */
export function contentEndTick(tracks: readonly PlacedTrack[]): Tick {
  let end = 0;
  for (const track of tracks) {
    for (const placement of track.placements) {
      end = Math.max(end, placementEndTick(placement));
    }
  }
  return end;
}

/**
 * How many bars the ruler and grid should span: enough to cover the content,
 * never fewer than `minBars`, plus `trailingBars` of empty room to drop into.
 * Without the trailing room there is nowhere to place a block past the end of
 * the arrangement.
 *
 * Constant meter only, for the reason given on `rulerMarks`.
 */
export function arrangementBars(
  tracks: readonly PlacedTrack[],
  ts: PatternTimeSignature,
  opts: { minBars?: number; trailingBars?: number } = {},
): number {
  const { minBars = 1, trailingBars = 0 } = opts;
  const perBar = ticksPerBar(ts);
  const filled = Math.ceil(contentEndTick(tracks) / perBar);
  return Math.max(minBars, filled + trailingBars);
}

// --------------------------------------------------------------- viewport ---

/**
 * Width of the scrollable content, in px. The ruler's and the lane area's are
 * the same number by construction — they share one time axis, and a ruler even a
 * bar wider than the lanes puts bar 40's label past where bar 40 can be drawn.
 *
 * Bars rather than ticks, so the axis always ends on a bar line.
 */
export function arrangementWidth(
  bars: number,
  ts: PatternTimeSignature,
  pxPerBeat: number,
): number {
  return tickToPx(Math.max(0, bars) * ticksPerBar(ts), pxPerBeat);
}

/**
 * Where to scroll to after a zoom so the leftmost visible tick stays put.
 *
 * Zoom that leaves `scrollLeft` alone teleports the view: 960 px in is bar 6 at
 * 48 px/beat and bar 21 at 12. The ratio is exact and deliberately NOT a round
 * trip through `pxToTick`/`tickToPx` — `pxToTick` rounds to whole ticks, and at
 * 3 px/beat one pixel is 160 ticks, so a there-and-back zoom would walk the view
 * a bar to the left every few presses.
 *
 * A non-positive `from` has no anchor to preserve — there is no tick at "0 px per
 * beat" — so the view goes home rather than to NaN or Infinity.
 */
export function zoomAnchoredScrollLeft(
  scrollLeft: number,
  fromPxPerBeat: number,
  toPxPerBeat: number,
): number {
  if (!(fromPxPerBeat > 0) || !Number.isFinite(toPxPerBeat)) return 0;
  if (!Number.isFinite(scrollLeft)) return 0;
  return Math.max(0, scrollLeft) * (toPxPerBeat / fromPxPerBeat);
}

// ------------------------------------------------------------ hit testing ---

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Which part of a block the cursor is over. CP-06 branches on this: the body
 * drags the placement, the edges trim it.
 */
export type HitZone = 'body' | 'trim-start' | 'trim-end';

export type ArrangementHit =
  | {
      readonly kind: 'placement';
      readonly trackId: string;
      readonly placementId: string;
      readonly zone: HitZone;
      /** Unsnapped tick under the cursor — snap belongs to the gesture. */
      readonly tick: Tick;
    }
  | {
      readonly kind: 'lane';
      readonly trackId: string;
      readonly tick: Tick;
    }
  | null;

/** Grab width of a trim edge, in px. */
export const TRIM_HANDLE_PX = 8;

/**
 * What is under `point`, in lane-area content coordinates.
 *
 * Rects are half-open horizontally as well as vertically, so two placements that
 * abut exactly (the common case — the lib cascades placements to prevent
 * overlap) hit as two distinct blocks rather than both claiming the shared edge.
 * Where placements do overlap, the last one wins, matching paint order.
 *
 * An x left of the origin reports the lane at tick 0, exactly as `dropTarget`
 * does — a drag that overshoots the left edge must not have its track evaporate
 * out from under the drop indicator that is still showing it.
 */
export function hitTest(
  point: Point,
  lanes: readonly LaneRect[],
  tracks: readonly PlacedTrack[],
  pxPerBeat: number,
  opts: { trimHandlePx?: number } = {},
): ArrangementHit {
  const lane = laneAt(lanes, point.y);
  if (lane === null) return null;

  const tick = pxToTick(Math.max(0, point.x), pxPerBeat);
  const track = tracks.find((candidate) => candidate.id === lane.trackId);
  if (track === undefined) return { kind: 'lane', trackId: lane.trackId, tick };

  const handle = Math.max(0, opts.trimHandlePx ?? TRIM_HANDLE_PX);
  for (let i = track.placements.length - 1; i >= 0; i--) {
    const placement = track.placements[i];
    const rect = placementRect(placement, pxPerBeat, lane.top, lane.height);
    if (point.x < rect.left || point.x >= rect.left + rect.width) continue;
    return {
      kind: 'placement',
      trackId: lane.trackId,
      placementId: placement.id,
      zone: trimZone(point.x - rect.left, rect.width, handle),
      tick,
    };
  }
  return { kind: 'lane', trackId: lane.trackId, tick };
}

/**
 * How wide a block's trim handle actually is, for a block `width` px across.
 *
 * A block narrower than three handles would be all edge and no body, leaving it
 * undraggable at low zoom; the handles shrink instead so the middle third always
 * drags.
 *
 * Exported because `PlacementBlock` draws the two edge affordances that show
 * where those zones are. Drawing them from a second `Math.min` would let the
 * cursor say "resize" a pixel either side of where a press actually resizes —
 * the sort of disagreement that reads as the app being imprecise rather than as
 * a bug, and so never gets reported.
 */
export function trimHandleWidth(width: number, handlePx: number = TRIM_HANDLE_PX): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  return Math.min(Math.max(0, handlePx), width / 3);
}

function trimZone(offsetX: number, width: number, handlePx: number): HitZone {
  const handle = trimHandleWidth(width, handlePx);
  if (offsetX < handle) return 'trim-start';
  if (offsetX >= width - handle) return 'trim-end';
  return 'body';
}

// ------------------------------------------------------------ drop target ---

export interface DropTarget {
  readonly trackId: string;
  readonly tick: Tick;
}

/**
 * Where a drag from the pattern library would land. `null` outside the lanes —
 * the caller shows no drop indicator rather than guessing a track.
 *
 * The tick is snapped (to the bar by default) because a dropped block that
 * starts a 16th before the downbeat is never what the gesture meant.
 */
export function dropTarget(
  point: Point,
  lanes: readonly LaneRect[],
  pxPerBeat: number,
  snap: SnapOption | null,
): DropTarget | null {
  const lane = laneAt(lanes, point.y);
  if (lane === null) return null;
  return {
    trackId: lane.trackId,
    tick: snapArrangementTick(pxToTick(Math.max(0, point.x), pxPerBeat), snap),
  };
}

// ---------------------------------------------------------------- marquee ---

/** A rubber-band selection rectangle, in lane-area content coordinates. Corners
 *  in either order — the band is normalized before it is used. */
export interface MarqueeBand {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * Ids of every placement the band touches.
 *
 * Geometric rather than DOM-measured, which is the opposite of `Timeline.tsx`'s
 * marquee — that one hit-tests `getBoundingClientRect` on each `[data-note]`.
 * The arrangement already HAS every rect as a pure function of the model, so
 * asking the DOM would be asking a second, slower source that jsdom answers
 * 0×0 to. Here the band test is exactly as testable as the block positions are.
 *
 * Half-open on both axes, matching `hitTest` and `laneRects`: a band whose edge
 * lands exactly on a block's edge does not catch it, so two abutting blocks
 * can be separated by a band drawn along the seam between them.
 */
export function placementsInBand(
  band: MarqueeBand,
  lanes: readonly LaneRect[],
  tracks: readonly PlacedTrack[],
  pxPerBeat: number,
): string[] {
  const left = Math.min(band.left, band.right);
  const right = Math.max(band.left, band.right);
  const top = Math.min(band.top, band.bottom);
  const bottom = Math.max(band.top, band.bottom);

  const ids: string[] = [];
  for (const lane of lanes) {
    if (lane.top >= bottom || lane.top + lane.height <= top) continue;
    const track = tracks.find((candidate) => candidate.id === lane.trackId);
    if (track === undefined) continue;
    for (const placement of track.placements) {
      const rect = placementRect(placement, pxPerBeat, lane.top, lane.height);
      if (rect.left >= right || rect.left + rect.width <= left) continue;
      ids.push(placement.id);
    }
  }
  return ids;
}

// ------------------------------------------------------------- group move ---

/** One placement's position at the moment a drag began: which lane it was in,
 *  and where it started. Captured once, so repeated pointer moves resolve
 *  against the gesture's origin instead of compounding. */
export interface PlacementDragItem {
  readonly id: string;
  /** Index into the lane stack, not a track id — a cross-lane drag is a delta
   *  of ROWS, and only the index makes "one lane down" expressible. */
  readonly trackIndex: number;
  readonly startTick: Tick;
}

/**
 * Where each member of a dragged group should land, and in what order to move
 * them there.
 *
 * Two decisions, both of which look like details and are not:
 *
 * 1. THE CLAMPS ARE SHARED, not per item. Clamping each block against tick 0
 *    and against the ends of the lane stack independently piles the group up
 *    against the wall — the leading block stops and the trailing ones keep
 *    coming, so a drag to the left edge silently collapses a four-bar spread
 *    into a stack. Clamping the DELTA against the extreme member keeps every
 *    relative offset exactly, and the group simply stops moving. Same reasoning
 *    as the group-fret clamp in `patternService.nudgeSelectedFret`.
 *
 * 2. THE ORDER IS BY DESTINATION, farthest-travelled first, ON BOTH AXES. The
 *    lib's `movePlacement` BLOCKS/CLAMPS against whatever is already in the
 *    destination lane — including the group's own members, which are still
 *    sitting at their old positions. Moving a group one bar right leftmost-first
 *    parks block 1 on top of where block 2 still is, and the lib deflects it.
 *    Moving the rightmost first vacates each slot before the next block needs
 *    it. The lib's own `duplicatePlacements` sorts for the same reason.
 *
 *    THE LANE AXIS COMES FIRST, because a purely vertical drag has no tick
 *    delta to order by: dragging two stacked blocks down one lane top-first
 *    lands the upper one on the lower one's old slot and the lib deflects it a
 *    bar sideways — an offset that did not exist before the drag, which is
 *    exactly what "group move preserves relative timing" forbids. Moving the
 *    bottom-most first vacates each lane before the block above it arrives.
 */
export function planGroupMove(
  items: readonly PlacementDragItem[],
  deltaTicks: Tick,
  deltaLanes: number,
  laneCount: number,
): PlacementDragItem[] {
  if (items.length === 0 || laneCount <= 0) return [];

  const ticksWanted = Number.isFinite(deltaTicks) ? Math.round(deltaTicks) : 0;
  const lanesWanted = Number.isFinite(deltaLanes) ? Math.round(deltaLanes) : 0;

  let minStart = Infinity;
  let minLane = Infinity;
  let maxLane = -Infinity;
  for (const item of items) {
    minStart = Math.min(minStart, item.startTick);
    minLane = Math.min(minLane, item.trackIndex);
    maxLane = Math.max(maxLane, item.trackIndex);
  }

  const ticks = Math.max(ticksWanted, -minStart);
  // Upper bound before lower: with a group taller than the stack the lower
  // bound has to win, or the top member would be pushed off the top.
  const lanes = Math.max(-minLane, Math.min(lanesWanted, laneCount - 1 - maxLane));

  return items
    .map((item) => ({
      id: item.id,
      trackIndex: item.trackIndex + lanes,
      startTick: item.startTick + ticks,
    }))
    .sort((a, b) => {
      // Only when the group actually changes lane: with no lane delta nothing
      // vacates a lane for anything else, and ordering by an axis that isn't
      // moving would override the axis that is.
      if (lanes !== 0) {
        const byLane = lanes > 0 ? b.trackIndex - a.trackIndex : a.trackIndex - b.trackIndex;
        if (byLane !== 0) return byLane;
      }
      return ticks > 0 ? b.startTick - a.startTick : a.startTick - b.startTick;
    });
}

// ----------------------------------------------------------- diagnostics ---
// What a placement COSTS at play time, so the surface can say so before the
// user finds out by ear. Pure, like everything else here — it reads the lib's
// instrument catalog and the placement's own snapshot, nothing else.

/**
 * The lib's own fallback when a placement's snapshot names an instrument the
 * catalog doesn't have (`composition-ops.ts`, `DEFAULT_FRETBOARD_FRET_COUNT`).
 * Not exported by the lib, so it is restated — see the LIB-GAP note below.
 */
const FALLBACK_FRET_COUNT = 22;

/** Six, because the catalog's default instrument is a guitar. Only reached by a
 *  snapshot naming an instrument the catalog doesn't have. */
const FALLBACK_STRING_COUNT = 6;

/**
 * The neck a placement's notes are measured against: the SNAPSHOT's instrument,
 * not the track's, exactly as `flattenTrack` measures it. Those can differ, and
 * using the track's would judge the wrong notes on a mismatched placement.
 */
function snapshotNeck(placement: Placement): { strings: number; frets: number } {
  const instrument = getInstrument(placement.patternSnapshot.instrumentId);
  return {
    strings: instrument?.stringCount ?? FALLBACK_STRING_COUNT,
    frets: instrument?.fretCount ?? FALLBACK_FRET_COUNT,
  };
}

/**
 * The fret an event actually plays at once the placement's transposition is
 * applied, or `null` when the shift pushes it outside `0..fretCount` and
 * `flattenTrack` therefore DROPS it.
 *
 * One rule, two callers — `droppedByTranspose` counts the nulls and
 * `previewMarks` refuses to draw them (and shades its marks by the fret this
 * returns). Stated twice, a preview would eventually show a note the arrangement
 * no longer plays, which is worse than showing none.
 *
 * LIB-GAP(12): this IS the restatement that gap covers — see the full note on
 * `droppedByTranspose`, which is the entry named in docs/FOLLOW-UPS.md. This
 * function, both its callers and BOTH fallback constants disappear together when
 * the lib exposes the diagnostic; the row in docs/FOLLOW-UPS.md names all of them.
 */
function soundingFret(fret: number, transpose: number, fretCount: number): number | null {
  const shifted = fret + transpose;
  return shifted < 0 || shifted > fretCount ? null : shifted;
}

/**
 * How many of the placement's notes a transposition pushes off the neck.
 *
 * `flattenComposition` DROPS any event whose transposed fret leaves
 * `0..fretCount` — silently, at play time, with no trace on screen. A block
 * transposed +7 can therefore go quiet in its top voice and look untouched, and
 * the first sign is a mix that has lost a part.
 *
 * Counted per PATTERN note, not per repetition: "3 notes won't sound" is the
 * fact the user can act on, where a legacy `repeat: 4` block would otherwise
 * report 12 of the same three.
 *
 * The fret range comes from `snapshotNeck` for the reason given there.
 *
 * LIB-GAP(12): this restates a rule the lib already implements and does not
 * expose. `flattenTrack` applies it but is not on the root barrel, and nothing
 * reports which events a placement would lose, so the only alternative is
 * running `flattenComposition` over the whole arrangement on every render and
 * attributing its ids back to placements. Delete when the lib exposes the
 * diagnostic (or exports `flattenTrack`). See docs/FOLLOW-UPS.md.
 */
export function droppedByTranspose(placement: Placement): number {
  const transpose = placement.transposeSemitones ?? 0;
  if (transpose === 0) return 0;
  const { frets } = snapshotNeck(placement);
  const length = placementEffectiveLength(placement);

  let dropped = 0;
  for (const event of placement.patternSnapshot.events) {
    // Events past the truncation point are already not played, so they are not
    // notes the transposition costs.
    if (event.startTick >= length) continue;
    if (soundingFret(event.fret, transpose, frets) === null) dropped++;
  }
  return dropped;
}

// -------------------------------------------------------- block preview ---
// A miniature of a placement's notes, drawn inside its own block so a wall of
// identically-sized rectangles reads as music. Non-interactive by construction:
// it returns rects and nothing else, and `hitTest` never consults it.

/**
 * NOT greenfield: guitar-tutor already shipped this drawing as
 * `src/patterns/arranger/MiniPatternSignature.tsx`, and its approach is what is
 * ported here — one `<svg preserveAspectRatio="none">` per block, one row per
 * string in REVERSE `stringIndex` order, a minimum mark width so a short note
 * still shows, events at or past the effective length dropped and a straddling
 * event's duration clipped to it. Three deliberate divergences:
 *
 *  - the time axis is the arrangement's `tickToPx`, not the pattern's duration
 *    normalised to a fixed 100×28 box, so a placement's notes line up with the
 *    ruler and with every other block at the same zoom;
 *  - `repeat` is honoured (that component drew one snapshot, always);
 *  - its six per-string guide `<line>`s are NOT drawn. That is a decision, not
 *    an oversight: they are 6 more nodes on every block on a page that can carry
 *    hundreds, and at 88 px lane height the strip is ~32 px — guides at that
 *    pitch read as a grey wash behind the name rather than as strings. A preview
 *    with notes on only two strings therefore floats, which is the accepted cost.
 *
 * The two in-repo reuse candidates were checked and neither fits:
 *
 *  - `src/reference/patternCells.ts` is fretboard-oriented — `footprintCellsFor`
 *    and friends return cells on a NECK. There is no time axis in them at all.
 *  - `src/reference/tabLayout.ts` is a full tablature renderer with systems,
 *    bars, glyphs and stems, and it WRAPS into systems. A preview that wraps
 *    inside a block is not a preview.
 *
 * What is reused is the part that could drift: the tick→px mapping and the
 * repetition rects are `tickToPx` and `placementRepeatRects`, so a mark can
 * never land somewhere its block does not cover.
 */
export interface PreviewMark extends Rect {
  /** The snapshot event drawn. Not unique on its own — a repeated placement
   *  draws the same event once per repetition. */
  readonly eventId: string;
  /** Which repetition this mark belongs to, 0-based. */
  readonly repeat: number;
  /**
   * How far up the neck the note SOUNDS, as a fill opacity in
   * `PREVIEW_OPACITY_MIN..PREVIEW_OPACITY_MAX` — open strings faintest, the last
   * fret fullest.
   *
   * The one non-geometric field here, and it earns its place: the lib transposes
   * FRETS and leaves `stringIndex` alone, so without it a placement at +5 whose
   * notes all stay on the neck would draw a pixel-identical preview to the
   * untransposed one and the drawing would be silent about the single edit most
   * likely to have changed what it shows. It is resolved here rather than in the
   * component for the same reason the rects are: the component does no
   * arithmetic, so the value it applies is the value the tests pin.
   */
  readonly opacity: number;
}

/**
 * Narrower than this and a repetition is all trim handle and no readable
 * content — 3 × `TRIM_HANDLE_PX` is exactly the width at which `trimHandleWidth`
 * stops shrinking the handles and a middle third exists to draw into. Below it
 * the preview draws NOTHING rather than a smear; the block keeps its label.
 */
export const MIN_PREVIEW_WIDTH = 3 * TRIM_HANDLE_PX;

/** A string row thinner than this cannot show a gap between itself and its
 *  neighbour, so six of them read as one grey bar rather than as six strings.
 *  The floor is per string, so a four-string bass previews in a shorter strip
 *  than a six-string guitar does — which is correct, not a coincidence. */
export const MIN_PREVIEW_ROW_PX = 2;

/**
 * Vertical room the block's own chrome needs: the name across the top, the
 * transpose and dropped-note badges across the bottom. The preview is
 * SUBORDINATE to both — it may not overlap either, so these are subtracted
 * before anything is drawn rather than trusted to z-order.
 *
 * Both are the rendered line boxes of `PlacementBlock`'s two rows plus its
 * `py-1` (4 px). Neither `text-[9.5px]` nor `text-[8px]` sets a line height, so
 * both inherit the sheet's `line-height: 1.55` (src/styles/index.css): the name
 * is 9.5 × 1.55 + 4 ≈ 18.7 and the badge row is 8 × 1.55 + 4 ≈ 16.4, rounded UP
 * — an under-reserve puts the top string row under the name at the height
 * threshold, where the strip fills the band exactly.
 *
 * They live here rather than in the component because the component is not
 * allowed to do pixel arithmetic — that rule is why this module exists.
 */
const PREVIEW_TOP_PX = 19;
const PREVIEW_BOTTOM_PX = 17;

/** Past this the preview starts to look like the content rather than a hint at
 *  it. A pattern lane is 88 px tall; without a cap the strip would be over half
 *  the block and compete with the name. */
const MAX_PREVIEW_HEIGHT = 32;

/** Blank space above and below each mark inside its row, so adjacent strings
 *  stay legible as separate rows. Exported because the row pitch a caller (or a
 *  test) can observe is `mark.height + 2 × this`, and restating the literal is
 *  how an assertion quietly stops testing what it names. */
export const PREVIEW_ROW_GAP_PX = 0.5;

/** A 16th note at the coarsest zoom is under a pixel wide. Marks get a floor so
 *  a fast passage reads as notes rather than as nothing. */
const MIN_MARK_PX = 1.5;

/** The horizontal counterpart of `PREVIEW_ROW_GAP_PX`, and the reason it exists
 *  is `MIN_MARK_PX`: the floor is the one thing here that can draw a mark WIDER
 *  than the distance to the next onset on its string, i.e. fabricate an overlap
 *  the music has not got. `previewMarks` refuses to draw at all when the tightest
 *  onset spacing on any one string falls below `MIN_MARK_PX + this`, so the floor
 *  can never do that and two consecutive short notes always show daylight. */
const PREVIEW_MARK_GAP_PX = 0.5;

/** The fill opacity of a mark at fret 0 and at the neck's last fret. The span is
 *  narrow on purpose: the preview is SUBORDINATE to the block's name and to its
 *  selected fill, so the shading has to be readable as a gradient across a phrase
 *  without any single mark reading as a second label. */
const PREVIEW_OPACITY_MIN = 0.55;
const PREVIEW_OPACITY_MAX = 1;

/**
 * Where every note of a placement draws INSIDE its own block, in block-local
 * pixels — (0, 0) is the block's top-left corner, so the caller applies these
 * verbatim to one `<svg>` laid over the block.
 *
 * The preview shows what will PLAY, which is three separate obligations:
 *
 *  - `lengthTicks` TRUNCATION. Events at or past `placementEffectiveLength` are
 *    not emitted by `flattenComposition`, so they are not drawn; an event
 *    straddling the cut has its mark clipped exactly as the lib clips its
 *    duration. A trimmed block therefore draws nothing past its right edge.
 *  - `transposeSemitones`. The lib shifts FRETS, not strings, so a transposition
 *    moves no mark vertically — the axis here is the string, and the string is
 *    what does not change. It changes the marks in two other ways: notes shifted
 *    off `0..fretCount` are dropped from playback (LIB-GAP(12)) and are dropped
 *    here by the same `soundingFret` rule `droppedByTranspose` counts them with,
 *    and every surviving mark's `opacity` is taken from its SOUNDING fret, so a
 *    transposition that keeps every note on the neck still visibly moves.
 *  - `repeat`. A repeated legacy placement replays its snapshot, so the marks
 *    repeat too, once per rect from `placementRepeatRects`.
 *
 * ONE exception to "what will play", inherited from `placementRect` so that the
 * marks cannot leave their block: repetitions are counted with `repeatCount`
 * (floored, minimum 1) where `flattenTrack` loops on the raw `repeat`. A
 * malformed `repeat: 0` therefore draws one set of marks and plays none, and
 * `repeat: 2.5` draws two where three sound. The new UI writes neither.
 *
 * Row order is the REVERSE of `stringIndex`: index 0 is the low E, which is the
 * physically bottom string, and every display in this app draws the high string
 * on top (`ROW_ORDER` in `Timeline.tsx` is the authority). Inverted, every note
 * lands on the wrong string and at this scale still looks entirely plausible.
 *
 * Returns `[]` — draw nothing at all — when a repetition is too narrow, the strip
 * too short for the instrument's strings, or the notes too dense at this zoom to
 * stay apart. Mush that implies notes that aren't there is worse than an
 * unadorned block.
 */
export function previewMarks(
  placement: Placement,
  pxPerBeat: number,
  blockHeight: number,
): PreviewMark[] {
  if (!(pxPerBeat > 0) || !Number.isFinite(pxPerBeat) || !Number.isFinite(blockHeight)) return [];

  const { strings, frets } = snapshotNeck(placement);
  if (!(strings > 0)) return [];

  const band = blockHeight - PREVIEW_TOP_PX - PREVIEW_BOTTOM_PX;
  const stripHeight = Math.min(band, MAX_PREVIEW_HEIGHT);
  if (stripHeight < strings * MIN_PREVIEW_ROW_PX) return [];
  const stripTop = PREVIEW_TOP_PX + (band - stripHeight) / 2;
  const rowHeight = stripHeight / strings;
  // Positive by construction: the row floor above is wider than both gaps, so
  // there is no clamp here and no case where one would silently fire.
  const markHeight = rowHeight - 2 * PREVIEW_ROW_GAP_PX;

  const length = placementEffectiveLength(placement);
  if (!(length > 0)) return [];

  // Lane-local rects, one per repetition, taken from the same function the block
  // draws its restart divisions from. Rebased to the block's own left edge here
  // and not in the component, which does no arithmetic.
  const repeats = placementRepeatRects(placement, pxPerBeat, 0, blockHeight);
  const originX = tickToPx(placement.startTick, pxPerBeat);
  // Every repetition is the same width, so the first one decides for all of
  // them. Testing the REPETITION rather than the whole block is what keeps a
  // legacy `repeat: 16` from drawing sixteen unreadable smears in a wide block —
  // and it bounds the mark count, since repetitions cannot be narrower than this.
  if (repeats.length === 0 || repeats[0].width < MIN_PREVIEW_WIDTH) return [];

  const transpose = placement.transposeSemitones ?? 0;

  // Resolved ONCE, not once per repetition: which events survive to be drawn,
  // and everything about each that does not depend on which repetition it is in.
  const drawable: { event: PatternEvent; row: number; opacity: number }[] = [];
  for (const event of placement.patternSnapshot.events) {
    if (!(event.startTick >= 0) || event.startTick >= length) continue;
    // Display order, reversed. Out of range means the snapshot carries more
    // strings than its instrument has — draw nothing rather than a mark clamped
    // onto a string that isn't the note's.
    const row = strings - 1 - event.stringIndex;
    if (row < 0 || row >= strings) continue;
    const fret = soundingFret(event.fret, transpose, frets);
    if (fret === null) continue;
    const upTheNeck = frets > 0 ? Math.min(Math.max(fret / frets, 0), 1) : 0;
    drawable.push({
      event,
      row,
      opacity: PREVIEW_OPACITY_MIN + upTheNeck * (PREVIEW_OPACITY_MAX - PREVIEW_OPACITY_MIN),
    });
  }

  // Trap 3 on the OTHER axis: the width thresholds above bound the block, not the
  // notes in it, and at 6 px/beat — a real zoom level — a 16th is exactly
  // `MIN_MARK_PX`, so a 16th line draws as one solid bar and a 32nd run draws
  // marks wider than the space between their onsets. Measured per STRING because
  // marks in different rows cannot collide however close their onsets are.
  if (tickToPx(tightestOnsetGap(drawable), pxPerBeat) < MIN_MARK_PX + PREVIEW_MARK_GAP_PX) {
    return [];
  }

  const marks: PreviewMark[] = [];
  for (let repeat = 0; repeat < repeats.length; repeat++) {
    const rect = repeats[repeat];
    const base = rect.left - originX;
    for (const { event, row, opacity } of drawable) {
      const left = base + tickToPx(event.startTick, pxPerBeat);
      const clipped = Math.min(Math.max(event.durationTicks, 0), length - event.startTick);
      marks.push({
        eventId: event.id,
        repeat,
        opacity,
        left,
        top: stripTop + row * rowHeight + PREVIEW_ROW_GAP_PX,
        // Clamped to THIS repetition's right edge, not the block's: a note held
        // over the loop point does not sound into the next repetition, so it
        // must not be drawn there either. Doubles as the guarantee that no mark
        // escapes the block's rounded corners.
        width: Math.min(Math.max(tickToPx(clipped, pxPerBeat), MIN_MARK_PX), base + rect.width - left),
        height: markHeight,
      });
    }
  }
  return marks;
}

/**
 * The smallest tick distance between two DISTINCT onsets sharing a string,
 * `Infinity` when no string carries two. Simultaneous notes (a chord, or a
 * doubled event) are a distance of 0 and are excluded: they are one mark drawn
 * over another, not two marks that read as a smear.
 */
function tightestOnsetGap(drawable: readonly { event: PatternEvent; row: number }[]): number {
  const byRow = new Map<number, number[]>();
  for (const { event, row } of drawable) {
    const onsets = byRow.get(row);
    if (onsets) onsets.push(event.startTick);
    else byRow.set(row, [event.startTick]);
  }

  let tightest = Number.POSITIVE_INFINITY;
  for (const onsets of byRow.values()) {
    onsets.sort((a, b) => a - b);
    for (let i = 1; i < onsets.length; i++) {
      const gap = onsets[i] - onsets[i - 1];
      if (gap > 0 && gap < tightest) tightest = gap;
    }
  }
  return tightest;
}
