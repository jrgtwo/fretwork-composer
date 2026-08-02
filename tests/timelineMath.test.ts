import { describe, it, expect } from 'vitest';
import { PPQ } from '@fretwork/lib';
import {
  DEFAULT_SNAP_ID,
  barBeatLines,
  laneMetrics,
  pxToTick,
  snapOptions,
  tickToPx,
} from '../src/timeline/timelineMath';

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

    expect(lines[0]).toEqual({ x: 0, tick: 0, bar: 1, beat: 1, isBar: true });
    expect(lines[1]).toEqual({ x: 48, tick: PPQ, bar: 1, beat: 2, isBar: false });
    expect(lines[4]).toEqual({ x: 192, tick: 4 * PPQ, bar: 2, beat: 1, isBar: true });
  });

  it('follows the time signature', () => {
    const lines = barBeatLines(2, { numerator: 3, denominator: 4 }, 48);
    expect(lines).toHaveLength(6);
    expect(lines[3]).toEqual({ x: 144, tick: 3 * PPQ, bar: 2, beat: 1, isBar: true });
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

describe('snapOptions', () => {
  it('resolves a bar from the time signature', () => {
    const inFour = snapOptions(FOUR_FOUR).find((o) => o.id === 'bar')!;
    const inThree = snapOptions({ numerator: 3, denominator: 4 }).find((o) => o.id === 'bar')!;

    expect(inFour.ticks).toBe(PPQ * 4);
    expect(inThree.ticks).toBe(PPQ * 3);
  });

  it('divides the beat in two for straight values', () => {
    const byId = Object.fromEntries(snapOptions(FOUR_FOUR).map((o) => [o.id, o.ticks]));

    expect(byId['4']).toBe(PPQ);
    expect(byId['8']).toBe(PPQ / 2);
    expect(byId['16']).toBe(PPQ / 4);
    expect(byId['32']).toBe(PPQ / 8);
  });

  // Triplets are the reason we don't use the lib's StepLength, which has none.
  it('divides the beat in three for triplets', () => {
    const byId = Object.fromEntries(snapOptions(FOUR_FOUR).map((o) => [o.id, o.ticks]));

    expect(byId['8t']).toBe(PPQ / 3);
    expect(byId['16t']).toBe(PPQ / 6);
    // three eighth-triplets fill exactly one beat
    expect(byId['8t']! * 3).toBe(PPQ);
  });

  it('offers an unsnapped option', () => {
    expect(snapOptions(FOUR_FOUR).find((o) => o.id === 'off')!.ticks).toBeNull();
  });

  it('defaults to a sixteenth', () => {
    expect(snapOptions(FOUR_FOUR).some((o) => o.id === DEFAULT_SNAP_ID)).toBe(true);
  });
});
