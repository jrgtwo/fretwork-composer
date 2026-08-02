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
  placementEffectiveLength,
  placementEndTick,
  snapTick,
  ticksPerBar,
  ticksPerBeat,
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
 * A block narrower than three handles would be all edge and no body, leaving it
 * undraggable at low zoom; the handles shrink instead so the middle third always
 * drags.
 */
function trimZone(offsetX: number, width: number, handlePx: number): HitZone {
  const handle = Math.min(handlePx, width / 3);
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
