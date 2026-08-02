import { describe, it, expect } from 'vitest';
import { PPQ } from '@fretwork/lib';
import {
  DEFAULT_SNAP_ID,
  barBeatLines,
  laneGridImage,
  laneMetrics,
  pxToTick,
  rowOrder,
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

describe('rowOrder', () => {
  // The single fact every string display in this app rests on. `stringIndex` 0
  // is the bottom string and tab draws the highest string on top, so the rows
  // run in reverse index order — backwards, every note lands on the wrong
  // string and still looks entirely plausible.
  it('runs from the last string index down to zero', () => {
    expect(rowOrder(6)).toEqual([5, 4, 3, 2, 1, 0]);
    expect(rowOrder(4)).toEqual([3, 2, 1, 0]);
  });

  it('has no rows for a neck with no strings', () => {
    expect(rowOrder(0)).toEqual([]);
  });
});

describe('laneMetrics', () => {
  // The argument is the height the ROWS have — every caller takes its own chrome
  // off first, so 300px here is a 320px pane less a 20px ruler.
  it('divides available height between the strings', () => {
    const { rowHeight } = laneMetrics(300, 6);
    expect(rowHeight).toBe(50);
  });

  it('clamps rows so a tall pane does not leave an empty well', () => {
    expect(laneMetrics(1980, 6).rowHeight).toBe(96);
  });

  it('clamps rows so a short pane stays usable', () => {
    expect(laneMetrics(40, 6).rowHeight).toBe(22);
  });

  it('centres the note within its row and keeps it a sensible size', () => {
    const { rowHeight, noteHeight, noteTop } = laneMetrics(300, 6);
    expect(noteHeight).toBeLessThan(rowHeight);
    expect(noteTop).toBe(Math.round((rowHeight - noteHeight) / 2));
  });

  it('caps note height so tall rows do not produce giant slabs', () => {
    expect(laneMetrics(1980, 6).noteHeight).toBeLessThanOrEqual(52);
  });

  it('divides the same height differently for a shorter neck', () => {
    expect(laneMetrics(300, 4).rowHeight).toBe(75);
    expect(laneMetrics(300, 6).rowHeight).toBe(50);
  });
});

describe('laneGridImage', () => {
  // Three stacked carves — snap, beat, bar — each one a 1px shadow and a 1px
  // light catch at the end of its repeat.
  it('draws a line at the snap resolution, the beat and the bar', () => {
    const image = laneGridImage(48, PPQ / 4, FOUR_FOUR);
    const widths = [...image.matchAll(/transparent 0 (\d+)px/g)].map((m) => Number(m[1]));

    // A sixteenth is 12px at 48px/beat, a beat is 48, a 4/4 bar is 192 — each
    // stated two pixels short, where its shadow starts.
    expect(widths).toEqual([12 - 2, 48 - 2, 192 - 2]);
  });

  it('follows the snap setting, so the grid and the legal positions agree', () => {
    const eighth = laneGridImage(48, PPQ / 2, FOUR_FOUR);
    expect(eighth.startsWith('repeating-linear-gradient(90deg,transparent 0 22px')).toBe(true);
  });

  // Snapping off still needs a readable grid — a blank slab reads as no time at
  // all — so the finest line falls back to a sixteenth.
  it('falls back to a sixteenth when snapping is off', () => {
    expect(laneGridImage(48, null, FOUR_FOUR)).toBe(laneGridImage(48, PPQ / 4, FOUR_FOUR));
  });

  it('takes the bar line from the time signature', () => {
    const inThree = laneGridImage(48, PPQ / 4, { numerator: 3, denominator: 4 });
    expect(inThree).toContain('transparent 0 142px'); // 3 beats x 48px, less 2
  });

  // A carve spends 2px on its shadow and light catch, so a division narrower than
  // that interpolates a negative length — invalid CSS, and since all three carves
  // are one comma-joined value the browser drops the beat and bar lines with it.
  // A 1/32 grid at the lowest zoom is 1.5px, i.e. two clicks of "Zoom out".
  it('never emits a negative length, however fine the grid', () => {
    const widths = [...laneGridImage(12, PPQ / 8, FOUR_FOUR).matchAll(/transparent 0 (\S+?)px/g)]
      .map((m) => Number(m[1]));

    // A 1.5px snap division floors at 3px; the 12px beat and 48px bar are unaffected.
    expect(widths).toEqual([1, 10, 46]);
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
