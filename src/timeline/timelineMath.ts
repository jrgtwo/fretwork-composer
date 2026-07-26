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
        bar: bar + 1,
        beat: beat + 1,
        isBar: beat === 0,
      });
    }
  }
  return lines;
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
