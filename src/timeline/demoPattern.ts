/**
 * Seeds a pattern to work with until saved patterns exist. Goes through the
 * pattern service, so it takes exactly the path the UI and the agent will —
 * no separate construction route that could drift from the real one.
 */
import { PPQ } from '@fretwork/lib';
import { clearHistory, openBlankPattern, stampNote } from '../patterns/patternService';

/**
 * [stringIndex, fret, startTick] — stringIndex follows the lib: 0 = low E,
 * 5 = high e, matching its tuning arrays.
 */
const NOTES: ReadonlyArray<readonly [number, number, number]> = [
  [1, 5, 0], //  A string, 5th fret — D
  [2, 7, PPQ], //  D string
  [3, 6, PPQ * 2], //  G string
  [4, 5, PPQ * 3], //  B string
  [3, 9, PPQ * 5],
  [1, 5, PPQ * 8],
  [2, 7, PPQ * 9],
  [4, 5, PPQ * 10],
  [5, 5, PPQ * 12], //  high e
  [3, 9, PPQ * 13],
];

export function seedDemoPattern(): void {
  openBlankPattern('A major arpeggio');
  NOTES.forEach(([stringIndex, fret, tick]) =>
    stampNote({ stringIndex, fret, tick, durationTicks: PPQ / 2 }),
  );
  // Seeding isn't a user edit — the seeded pattern is the baseline, so undo
  // shouldn't be able to unpick it note by note.
  clearHistory();
}
