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
 */
export function laneMetrics(
  availableHeight: number,
  stringCount: number,
  rulerHeight: number,
): LaneMetrics {
  const usable = availableHeight - rulerHeight;
  const rowHeight = Math.max(
    MIN_ROW,
    Math.min(MAX_ROW, Math.floor(usable / Math.max(1, stringCount))),
  );
  const noteHeight = Math.min(Math.round(rowHeight * 0.62), MAX_NOTE);
  return {
    rowHeight,
    noteHeight,
    noteTop: Math.round((rowHeight - noteHeight) / 2),
    isTall: rowHeight >= TALL_ROW,
  };
}
