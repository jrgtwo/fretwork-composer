import { describe, it, expect } from 'vitest';
import { PPQ } from '@fretwork/lib';
import {
  DEFAULT_SNAP_ID,
  barBeatLines,
  clampMoveDelta,
  clampResizeDelta,
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

describe('clampMoveDelta', () => {
  const span = (startTick: number, durationTicks = PPQ) => ({ startTick, durationTicks });

  it('passes a delta that keeps everything inside the window', () => {
    expect(clampMoveDelta([span(0)], PPQ, 4 * PPQ)).toBe(PPQ);
  });

  it('stops the group at the boundary rather than carrying it into the next block', () => {
    // The last note ends at 4 beats in a 4-beat window: there is nowhere to go.
    expect(clampMoveDelta([span(3 * PPQ)], 8 * PPQ, 4 * PPQ)).toBe(0);
    expect(clampMoveDelta([span(2 * PPQ)], 8 * PPQ, 4 * PPQ)).toBe(PPQ);
  });

  it('clamps the delta across the GROUP, so a spread phrase keeps its shape', () => {
    const group = [span(0), span(2 * PPQ)];
    const delta = clampMoveDelta(group, 8 * PPQ, 4 * PPQ);
    // Clamped by the LAST note; the first travels exactly as far, so the two
    // are still two beats apart. Clamping each note on its own would have piled
    // them both onto the boundary.
    expect(delta).toBe(PPQ);
    expect(group[1].startTick + delta - (group[0].startTick + delta)).toBe(2 * PPQ);
  });

  it('never lets a note start before tick 0', () => {
    expect(clampMoveDelta([span(PPQ), span(2 * PPQ)], -8 * PPQ, 4 * PPQ)).toBe(-PPQ);
  });

  it('prefers tick 0 when the group is longer than the window', () => {
    // Upper bound before lower: a group that cannot fit must sit against the
    // start rather than be pushed negative, which the lib would then flatten.
    expect(clampMoveDelta([span(0, 8 * PPQ)], 5 * PPQ, 4 * PPQ)).toBe(0);
  });

  it('is unbounded on the right with no window — the pattern page', () => {
    expect(clampMoveDelta([span(0)], 500 * PPQ, null)).toBe(500 * PPQ);
    expect(clampMoveDelta([span(0)], -PPQ, null)).toBe(0);
  });

  it('answers 0 for nothing to move or a delta that is not a number', () => {
    expect(clampMoveDelta([], PPQ, null)).toBe(0);
    expect(clampMoveDelta([span(0)], Number.NaN, null)).toBe(0);
  });

  it('does not shove a note that already OVERHANGS its window', () => {
    // Reachable: trim a placement in pattern mode and every event past the cut
    // survives in the snapshot. Here the note starts inside a 4-beat window and
    // ends a beat past it, so the raw ceiling is negative — and a negative
    // ceiling beats a zero delta, which would move the note a beat left the
    // instant it was grabbed.
    const overhanging = [span(3 * PPQ, 2 * PPQ)];
    expect(clampMoveDelta(overhanging, 0, 4 * PPQ)).toBe(0);
    expect(clampMoveDelta(overhanging, 8 * PPQ, 4 * PPQ)).toBe(0);
    // It may still be dragged LEFT, which is the one direction that helps.
    expect(clampMoveDelta(overhanging, -PPQ, 4 * PPQ)).toBe(-PPQ);
  });
});

describe('clampResizeDelta', () => {
  const span = (startTick: number, durationTicks: number) => ({ startTick, durationTicks });

  it('keeps the shortest member at the minimum instead of collapsing the group', () => {
    const group = [span(0, PPQ), span(2 * PPQ, 2 * PPQ)];
    // Asked to shrink by two beats, which would leave the first note at -1.
    expect(clampResizeDelta(group, -2 * PPQ, null, PPQ / 4)).toBe(-(PPQ - PPQ / 4));
  });

  it('stops growth at the window', () => {
    expect(clampResizeDelta([span(2 * PPQ, PPQ)], 4 * PPQ, 4 * PPQ, PPQ / 4)).toBe(PPQ);
    expect(clampResizeDelta([span(3 * PPQ, PPQ)], 4 * PPQ, 4 * PPQ, PPQ / 4)).toBe(0);
  });

  it('grows without limit when there is no window', () => {
    expect(clampResizeDelta([span(0, PPQ)], 40 * PPQ, null, PPQ / 4)).toBe(40 * PPQ);
  });

  it('never LENGTHENS a note that is already shorter than the minimum', () => {
    // `minDuration` is the grid step, which is a stamp default and not a floor
    // anything enforces afterwards — so a note can be shorter than it. An
    // uncapped `minDuration - shortest` floor is then positive, and dragging the
    // resize edge to the LEFT would grow the whole group instead.
    expect(clampResizeDelta([span(0, PPQ / 4)], -PPQ, null, PPQ)).toBe(0);
    expect(clampResizeDelta([span(0, PPQ / 4)], 0, null, PPQ)).toBe(0);
  });

  it('does not shrink a note that already overhangs its window', () => {
    expect(clampResizeDelta([span(3 * PPQ, 2 * PPQ)], 0, 4 * PPQ, PPQ / 4)).toBe(0);
  });
});
