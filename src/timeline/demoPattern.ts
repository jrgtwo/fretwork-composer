/**
 * Seeds a pattern to work with until saved patterns exist. Goes through the
 * pattern service, so it takes exactly the path the UI and the agent will —
 * no separate construction route that could drift from the real one.
 */
import { PPQ } from '@fretwork/lib';
import { clearHistory, openBlankPattern, stampNote } from '../patterns/patternService';

/** [stringIndex (0 = high e), fret, startTick] */
const NOTES: ReadonlyArray<readonly [number, number, number]> = [
  [4, 5, 0],
  [3, 7, PPQ],
  [2, 6, PPQ * 2],
  [1, 5, PPQ * 3],
  [2, 9, PPQ * 5],
  [4, 5, PPQ * 8],
  [3, 7, PPQ * 9],
  [1, 5, PPQ * 10],
  [0, 5, PPQ * 12],
  [2, 9, PPQ * 13],
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
