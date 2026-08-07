/**
 * Geometry for the timeline: ticks ↔ pixels, where the bar/beat lines fall, and
 * how tall the string lanes should be.
 *
 * The lib owns musical time (PPQ, ticksPerBar) and knows nothing about pixels;
 * this module is the only place the two meet, so zoom and row sizing stay pure
 * and testable rather than being derived inside a render pass.
 */
import { PPQ, ticksPerBar, ticksPerBeat, type PatternTimeSignature, type Tick } from '@fretwork/lib';

/** Zoom steps in pixels-per-beat. Discrete so gridlines stay pixel-aligned. */
export const ZOOM_LEVELS = [12, 24, 48, 96, 192] as const;
export const DEFAULT_ZOOM_INDEX = 2;

const MIN_ROW = 22;
const MAX_ROW = 96;
const MAX_NOTE = 52;
/** Rows past this height have room to show the pitch name as well as the fret. */
export const TALL_ROW = 44;

export function tickToPx(tick: Tick, pxPerBeat: number): number {
  return (tick / PPQ) * pxPerBeat;
}

export function pxToTick(px: number, pxPerBeat: number): Tick {
  return Math.max(0, Math.round((px / pxPerBeat) * PPQ));
}

export interface GridLine {
  x: number;
  /** Absolute tick this line falls on. Carried rather than left to the caller
   *  to re-derive from `bar`/`beat`: a second copy of that arithmetic is free to
   *  drift from this one, and the arrangement ruler needs the tick. */
  tick: Tick;
  bar: number;
  beat: number;
  isBar: boolean;
}

/** One entry per beat across `bars`, flagged where a new bar starts. */
export function barBeatLines(
  bars: number,
  ts: PatternTimeSignature,
  pxPerBeat: number,
): GridLine[] {
  const perBeat = ticksPerBeat(ts);
  const lines: GridLine[] = [];
  for (let bar = 0; bar < bars; bar++) {
    for (let beat = 0; beat < ts.numerator; beat++) {
      const tick = bar * ticksPerBar(ts) + beat * perBeat;
      lines.push({
        x: tickToPx(tick, pxPerBeat),
        tick,
        bar: bar + 1,
        beat: beat + 1,
        isBar: beat === 0,
      });
    }
  }
  return lines;
}

/**
 * How many bars a span of ticks occupies, rounded up.
 *
 * Here rather than beside either library rail because BOTH print it — the
 * pattern page's `PatternLibraryPanel` and the composition page's
 * `PatternLibraryRail` — and a pattern that reads "4 bars" on one page and
 * "5 bars" on the other is a disagreement nobody reports and everybody
 * distrusts. This module already owns tick↔bar conversion, and it is the one
 * module both pages may import without either importing the other.
 *
 * DERIVED, never stored. `fitPatternDuration` re-fits a pattern's length to its
 * content on every edit (docs/HANDOFF.md, hard-won facts), so a bar count cached
 * anywhere is a bar count that goes stale the next time a note is dragged.
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

/**
 * Grid resolutions for snapping and for the length of a newly stamped note.
 *
 * Richer than the lib's `StepLength` (quarter/eighth/sixteenth only) because
 * `snapTick` takes arbitrary tick values, and triplets are table stakes for a
 * guitar editor. `null` ticks means no snapping at all.
 */
export interface SnapOption {
  id: string;
  label: string;
  ticks: number | null;
}

export function snapOptions(ts: PatternTimeSignature): SnapOption[] {
  return [
    { id: 'bar', label: 'Bar', ticks: ticksPerBar(ts) },
    { id: '4', label: '1/4', ticks: PPQ },
    { id: '8', label: '1/8', ticks: PPQ / 2 },
    { id: '16', label: '1/16', ticks: PPQ / 4 },
    { id: '32', label: '1/32', ticks: PPQ / 8 },
    // Triplets divide the beat into three rather than two.
    { id: '8t', label: '1/8T', ticks: PPQ / 3 },
    { id: '16t', label: '1/16T', ticks: PPQ / 6 },
    { id: 'off', label: 'Off', ticks: null },
  ];
}

export const DEFAULT_SNAP_ID = '16';

/** Fallback note length when snapping is off — an eighth reads as "a note". */
export const FREE_NOTE_TICKS = PPQ / 2;

/**
 * The rows, top to bottom, as `stringIndex` values.
 *
 * Tab puts the highest string on top and `PatternEvent.stringIndex` counts from
 * the bottom one — the lib's `standard` tuning is `['E2','A2','D3','G3','B3','E4']`
 * and the scheduler reads `openStrings[stringIndex]` — so display order is the
 * REVERSE of index order. Getting it backwards puts every note on the wrong
 * string and still looks completely plausible.
 *
 * One function rather than one per view: the note surface draws the rows and the
 * chrome draws the labels beside them, and a second copy of the reversal is free
 * to drift from this one. `reference/tabLayout.rowForString` is the same rule
 * from the other end — string to row, rather than rows in order.
 */
export function rowOrder(stringCount: number): number[] {
  return [...Array(Math.max(0, stringCount)).keys()].reverse();
}

export interface LaneMetrics {
  rowHeight: number;
  noteHeight: number;
  noteTop: number;
  isTall: boolean;
}

/**
 * Rows grow with the pane so a taller timeline means bigger targets, but both the
 * row and the note are clamped: unbounded rows leave a mostly-empty well, and
 * unbounded notes turn into slabs that read as panels rather than events.
 *
 * `laneAreaHeight` is the height the ROWS have, with any chrome the host draws
 * already taken off. Subtracting a ruler here as well would mean two callers
 * disagreeing about whose job it was, and the note surface has no ruler at all.
 */
export function laneMetrics(laneAreaHeight: number, stringCount: number): LaneMetrics {
  const rowHeight = Math.max(
    MIN_ROW,
    Math.min(MAX_ROW, Math.floor(laneAreaHeight / Math.max(1, stringCount))),
  );
  const noteHeight = Math.min(Math.round(rowHeight * 0.62), MAX_NOTE);
  return {
    rowHeight,
    noteHeight,
    noteTop: Math.round((rowHeight - noteHeight) / 2),
    isTall: rowHeight >= TALL_ROW,
  };
}

/**
 * The CSS background that carves a string lane into a beat grid — a shadow line
 * and a light catch at every division, three of them stacked: the snap
 * resolution, the beat, and the bar.
 *
 * A string rather than markup because it is a repeating background: one
 * declaration per lane instead of an element per gridline, which at 192px per
 * beat across a long pattern is the difference between three nodes and
 * thousands. It lives here with the rest of the tick→pixel arithmetic because
 * that is where the widths it interpolates come from.
 *
 * `gridTicks` is null when snapping is off; the finest line then falls back to a
 * sixteenth, so the well still reads as time rather than as a blank slab.
 */
export function laneGridImage(
  pxPerBeat: number,
  gridTicks: number | null,
  ts: PatternTimeSignature,
): string {
  const carve = (width: number, dark: number, light: number) => {
    // A carve spends 2px on its shadow and its light catch, so anything under 3px
    // interpolates a NEGATIVE length — invalid CSS. The three carves are one
    // comma-joined `background-image`, so one bad layer drops the beat and bar
    // lines with it and the lane goes blank. Reachable: a 1/32 grid at the lowest
    // zoom is 1.5px. Drawn too coarse beats not drawn at all.
    const w = Math.max(3, width);
    return (
      `repeating-linear-gradient(90deg,transparent 0 ${w - 2}px,` +
      `rgb(0 0 0/${dark}) ${w - 2}px ${w - 1}px,rgb(255 255 255/${light}) ${w - 1}px ${w}px)`
    );
  };
  return [
    // The finest grid line follows the snap setting, so the visual grid and the
    // positions notes can actually take always agree.
    carve(tickToPx(gridTicks ?? PPQ / 4, pxPerBeat), 0.3, 0.022),
    carve(pxPerBeat, 0.5, 0.045),
    carve(tickToPx(ticksPerBar(ts), pxPerBeat), 0.72, 0.085),
  ].join(',');
}

// --------------------------------------------------------- note drag clamps ---
// Note-tick arithmetic for the two drag gestures `NoteSurface` runs. Here rather
// than in `arrangementMath` — which is where CP-11 first put them — because they
// contain no arrangement geometry at all, and the pattern editor's own surface
// must not depend on the composition page's module for its core drag maths.

/**
 * `-0` normalised to `0`.
 *
 * Reachable: a group already against tick 0 dragged further left clamps to
 * `-(0)`. It is not what any caller means by "did not move" — `Object.is`
 * separates the two, which is what `Number` assertions and React's own memo
 * comparison both use.
 */
const zeroed = (value: number): number => (value === 0 ? 0 : value);

/** A note's extent in its pattern's own ticks — what both clamps below reason
 *  about. `EventDragSnapshot` satisfies it. */
export interface NoteSpan {
  readonly startTick: Tick;
  readonly durationTicks: Tick;
}

/**
 * How much room a group has before its farthest-reaching note passes
 * `windowTicks`, never negative.
 *
 * The floor at 0 is load-bearing rather than defensive: a note can already
 * OVERHANG its window — trim a placement in pattern mode and every event past
 * the cut still exists in the snapshot — and a negative ceiling would then beat
 * a zero delta, so merely grabbing such a note would shove the whole group left
 * by the overhang. Zero lets it be dragged left or shortened and refuses to move
 * it on its own.
 */
function windowCeiling(windowTicks: Tick | null, maxEnd: number): number {
  if (windowTicks === null || !Number.isFinite(windowTicks)) return Infinity;
  return Math.max(0, windowTicks - maxEnd);
}

/**
 * A shared move delta, clamped so no note leaves `[0, windowTicks]`.
 *
 * THE CLAMP IS SHARED, not per note, for `planGroupMove`'s reason: clamping each
 * note independently piles a chord up against the wall — the leading note stops
 * and the trailing ones keep coming, so a drag to the boundary silently
 * collapses a spread phrase into a stack. Clamping the delta keeps every
 * relative offset and the group simply stops moving.
 *
 * The UPPER bound is applied before the lower, so a selection LONGER than the
 * window ends up against tick 0 rather than pushed negative — the lib would
 * floor each note at 0 independently and flatten the group, which is the bug
 * this ordering exists to avoid.
 *
 * `windowTicks` is null on the pattern page, where the pattern's length auto-fits
 * to its content and there is no boundary to stop at.
 */
export function clampMoveDelta(
  spans: readonly NoteSpan[],
  deltaTicks: Tick,
  windowTicks: Tick | null,
): Tick {
  if (spans.length === 0 || !Number.isFinite(deltaTicks)) return 0;
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const span of spans) {
    minStart = Math.min(minStart, span.startTick);
    maxEnd = Math.max(maxEnd, span.startTick + Math.max(0, span.durationTicks));
  }
  const ceiling = windowCeiling(windowTicks, maxEnd);
  return zeroed(Math.max(-minStart, Math.min(ceiling, Math.round(deltaTicks))));
}

/**
 * A shared resize delta, clamped so the shortest note keeps `minDuration` and
 * the longest-reaching one ends no later than `windowTicks`.
 *
 * Same shared-clamp reasoning as {@link clampMoveDelta}: the lib's floor is one
 * tick, so a group dragged past its own left edge would collapse into invisible
 * slivers while a per-note ceiling would flatten every note in the group onto
 * the boundary.
 *
 * The floor is capped at 0 for the mirror of `windowCeiling`'s reason: a note
 * SHORTER than `minDuration` (the grid step is a stamp default, not a minimum
 * anything enforces afterwards) would otherwise make the floor positive, and
 * grabbing its edge to drag it left would LENGTHEN every note in the group.
 */
export function clampResizeDelta(
  spans: readonly NoteSpan[],
  deltaTicks: Tick,
  windowTicks: Tick | null,
  minDuration: Tick,
): Tick {
  if (spans.length === 0 || !Number.isFinite(deltaTicks)) return 0;
  let shortest = Infinity;
  let maxEnd = -Infinity;
  for (const span of spans) {
    shortest = Math.min(shortest, Math.max(0, span.durationTicks));
    maxEnd = Math.max(maxEnd, span.startTick + Math.max(0, span.durationTicks));
  }
  const ceiling = windowCeiling(windowTicks, maxEnd);
  const floor = Math.min(0, minDuration - shortest);
  return zeroed(Math.max(floor, Math.min(ceiling, Math.round(deltaTicks))));
}
