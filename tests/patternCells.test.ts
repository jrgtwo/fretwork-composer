import { describe, it, expect } from 'vitest';
import { PPQ, createEmptyPattern, type Pattern, type PatternEvent, type Tick } from '@fretwork/lib';
import { activeCellsFor, cellsAboveFret, footprintCellsFor } from '../src/reference/patternCells';

/** A guitar neck, which is what every case here that isn't about the bound uses. */
const FRETS = 22;

/**
 * Built from the lib's own constructor rather than the pattern store: these are pure
 * functions and the point is to test them without a singleton, sessionStorage, or a
 * ruleset that would quietly reject the overlapping notes some cases here need.
 */
function patternOf(...cells: Array<{ string: number; fret: number; tick?: number }>): Pattern {
  const events: PatternEvent[] = cells.map((cell, index) => ({
    id: `e${index}`,
    stringIndex: cell.string,
    fret: cell.fret,
    startTick: ((cell.tick ?? index * PPQ) as Tick),
    durationTicks: (PPQ as Tick),
  }));
  return { ...createEmptyPattern('Cells'), events };
}

describe('footprintCellsFor', () => {
  it('returns one cell per distinct string and fret', () => {
    const pattern = patternOf(
      { string: 0, fret: 3 },
      { string: 2, fret: 5 },
      { string: 0, fret: 3 }, // same place on the neck, later in the bar
    );

    expect(footprintCellsFor(pattern, FRETS)).toEqual([
      { stringIndex: 0, fret: 3 },
      { stringIndex: 2, fret: 5 },
    ]);
  });

  it('keeps the same fret on different strings apart', () => {
    const pattern = patternOf({ string: 1, fret: 7 }, { string: 4, fret: 7 });

    expect(footprintCellsFor(pattern, FRETS)).toHaveLength(2);
  });

  it('treats open strings as cells', () => {
    expect(footprintCellsFor(patternOf({ string: 5, fret: 0 }), FRETS)).toEqual([
      { stringIndex: 5, fret: 0 },
    ]);
  });

  it('has nothing to draw for an empty or absent pattern', () => {
    expect(footprintCellsFor(patternOf(), FRETS)).toEqual([]);
    expect(footprintCellsFor(null, FRETS)).toEqual([]);
  });

  it('drops cells the neck has no room for', () => {
    // `MAX_FRET` in patternService is 24; a guitar has 22 frets. The lib would place
    // fret 23 past the last fret line and fret 24 outside the viewBox entirely.
    const pattern = patternOf({ string: 0, fret: 22 }, { string: 0, fret: 23 }, { string: 1, fret: 24 });

    expect(footprintCellsFor(pattern, FRETS)).toEqual([{ stringIndex: 0, fret: 22 }]);
    // A shorter neck drops more of the same pattern — the bound is the argument,
    // not a constant.
    expect(footprintCellsFor(pattern, 15)).toEqual([]);
  });

  it('keeps a stable identity when everything is off the neck', () => {
    const pattern = patternOf({ string: 0, fret: 24 });

    expect(footprintCellsFor(pattern, FRETS)).toBe(footprintCellsFor(null, FRETS));
  });
});

describe('activeCellsFor', () => {
  const pattern = patternOf(
    { string: 0, fret: 3 },
    { string: 2, fret: 5 },
    { string: 0, fret: 3 },
  );

  it('maps sounding event ids to their cells', () => {
    expect(activeCellsFor(pattern, ['e1'], FRETS)).toEqual([{ stringIndex: 2, fret: 5 }]);
  });

  it('lights a chord as several cells at once', () => {
    expect(activeCellsFor(pattern, ['e0', 'e1'], FRETS)).toEqual([
      { stringIndex: 0, fret: 3 },
      { stringIndex: 2, fret: 5 },
    ]);
  });

  it('collapses two sounding notes at the same place into one cell', () => {
    expect(activeCellsFor(pattern, ['e0', 'e2'], FRETS)).toEqual([{ stringIndex: 0, fret: 3 }]);
  });

  it('ignores ids the pattern does not own', () => {
    // The scheduler holds the stream it was handed, so ids from a pattern that has
    // since been closed can still arrive for a frame.
    expect(activeCellsFor(pattern, ['gone', 'e1'], FRETS)).toEqual([{ stringIndex: 2, fret: 5 }]);
    expect(activeCellsFor(pattern, ['gone'], FRETS)).toEqual([]);
  });

  it('is empty when nothing is sounding', () => {
    expect(activeCellsFor(pattern, [], FRETS)).toEqual([]);
    expect(activeCellsFor(null, ['e0'], FRETS)).toEqual([]);
  });

  it('does not light a sounding note that is off the neck', () => {
    const high = patternOf({ string: 0, fret: 23 }, { string: 1, fret: 4 });

    expect(activeCellsFor(high, ['e0', 'e1'], FRETS)).toEqual([{ stringIndex: 1, fret: 4 }]);
  });

  it('keeps a stable identity while idle, so the board does not rebuild every frame', () => {
    expect(activeCellsFor(pattern, [], FRETS)).toBe(activeCellsFor(pattern, ['gone'], FRETS));
  });
});

describe('cellsAboveFret', () => {
  it('counts the distinct cells the board cannot show', () => {
    const pattern = patternOf(
      { string: 0, fret: 3 },
      { string: 0, fret: 23 },
      { string: 0, fret: 23 }, // one cell, twice
      { string: 1, fret: 24 },
    );

    expect(cellsAboveFret(pattern, FRETS)).toBe(2);
  });

  it('is zero when the whole pattern fits, or there is no pattern', () => {
    expect(cellsAboveFret(patternOf({ string: 0, fret: 22 }), FRETS)).toBe(0);
    expect(cellsAboveFret(patternOf(), FRETS)).toBe(0);
    expect(cellsAboveFret(null, FRETS)).toBe(0);
  });
});
