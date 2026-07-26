import { describe, it, expect } from 'vitest';
import { PPQ } from '@fretwork/lib';
import { barBeatLines, laneMetrics, pxToTick, tickToPx } from '../src/timeline/timelineMath';

const FOUR_FOUR = { numerator: 4, denominator: 4 };

describe('tickToPx / pxToTick', () => {
  it('maps a quarter note to one beat of width', () => {
    expect(tickToPx(PPQ, 48)).toBe(48);
    expect(tickToPx(PPQ * 4, 48)).toBe(192);
  });

  it('round-trips through pxToTick', () => {
    expect(pxToTick(tickToPx(PPQ * 3, 48), 48)).toBe(PPQ * 3);
  });

  it('never returns a negative tick', () => {
    expect(pxToTick(-500, 48)).toBe(0);
  });
});

describe('barBeatLines', () => {
  it('emits one line per beat, marking bar starts', () => {
    const lines = barBeatLines(2, FOUR_FOUR, 48);
    expect(lines).toHaveLength(8); // 2 bars x 4 beats

    expect(lines[0]).toEqual({ x: 0, bar: 1, beat: 1, isBar: true });
    expect(lines[1]).toEqual({ x: 48, bar: 1, beat: 2, isBar: false });
    expect(lines[4]).toEqual({ x: 192, bar: 2, beat: 1, isBar: true });
  });

  it('follows the time signature', () => {
    const lines = barBeatLines(2, { numerator: 3, denominator: 4 }, 48);
    expect(lines).toHaveLength(6);
    expect(lines[3]).toEqual({ x: 144, bar: 2, beat: 1, isBar: true });
  });
});

describe('laneMetrics', () => {
  it('divides available height between the strings', () => {
    // 6 strings in 300px, minus a 20px ruler => ~46px each
    const { rowHeight } = laneMetrics(320, 6, 20);
    expect(rowHeight).toBe(50);
  });

  it('clamps rows so a tall pane does not leave an empty well', () => {
    expect(laneMetrics(2000, 6, 20).rowHeight).toBe(96);
  });

  it('clamps rows so a short pane stays usable', () => {
    expect(laneMetrics(60, 6, 20).rowHeight).toBe(22);
  });

  it('centres the note within its row and keeps it a sensible size', () => {
    const { rowHeight, noteHeight, noteTop } = laneMetrics(320, 6, 20);
    expect(noteHeight).toBeLessThan(rowHeight);
    expect(noteTop).toBe(Math.round((rowHeight - noteHeight) / 2));
  });

  it('caps note height so tall rows do not produce giant slabs', () => {
    expect(laneMetrics(2000, 6, 20).noteHeight).toBeLessThanOrEqual(52);
  });
});
