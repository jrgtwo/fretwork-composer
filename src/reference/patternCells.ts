/**
 * Pattern → fretboard cells: the two layers the reference board draws.
 *
 * Kept out of React because none of it is about pixels — the board is a pure
 * function of these two lists plus the neck's size, and that is worth being able
 * to assert without mounting anything.
 *
 * Both functions are order-stable (first occurrence in `pattern.events` wins) and
 * deduplicated: a cell is a place on the neck, so two notes at the same string
 * and fret are one cell, not two markers stacked on each other.
 *
 * Both are also bounded by the neck they're drawn on. `MAX_FRET` in
 * `patternService` is 24 while a guitar's `fretCount` is 22, so a legal pattern
 * can name a fret the board has no room for. The lib clamps rather than dropping
 * it (`fretX` returns the scale length for any `fret >= fretCount`), so frets 23
 * and 24 both land on the same point just past the last fret line — inside the
 * viewBox, drawn, stacked on each other, at a position that isn't theirs. A
 * confidently misplaced marker is worse than an absent one, so they're dropped
 * here and the view *says* they're missing — see `cellsAboveFret`.
 */
import { patternFootprint, type FootprintCell, type Pattern } from '@fretwork/lib';

/**
 * Shared empty result. `useFretboardModel` memoizes on the array identity and
 * rebuilds its keyed sets whenever it changes, so an idle board handing it a
 * fresh `[]` every render would recompute the whole marker set 60×/s during
 * playback.
 */
const NO_CELLS: readonly FootprintCell[] = [];

/**
 * Every distinct cell the pattern visits that fits on a `fretCount`-fret neck —
 * its shape at rest.
 *
 * Delegates the dedupe to the lib, which already defines this exact concept; the
 * wrapper adds "no pattern open", the neck bound, and the shared empty array.
 */
export function footprintCellsFor(
  pattern: Pattern | null,
  fretCount: number,
): readonly FootprintCell[] {
  if (!pattern || pattern.events.length === 0) return NO_CELLS;
  const cells = patternFootprint(pattern).filter((cell) => cell.fret <= fretCount);
  return cells.length === 0 ? NO_CELLS : cells;
}

/**
 * The cells currently sounding, from the scheduler's active event ids.
 *
 * Driven by iterating the pattern rather than the ids, which is what makes ids the
 * pattern doesn't own drop out silently — the scheduler holds the stream it was
 * given, so after switching or clearing a pattern its last active ids can still
 * arrive for a frame, and looking those up would either throw or light a cell that
 * no longer exists.
 */
export function activeCellsFor(
  pattern: Pattern | null,
  activeIds: readonly string[],
  fretCount: number,
): readonly FootprintCell[] {
  if (!pattern || activeIds.length === 0) return NO_CELLS;

  const sounding = new Set(activeIds);
  const seen = new Set<string>();
  const cells: FootprintCell[] = [];

  for (const event of pattern.events) {
    if (!sounding.has(event.id)) continue;
    if (event.fret > fretCount) continue;
    const key = `${event.stringIndex}:${event.fret}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cells.push({ stringIndex: event.stringIndex, fret: event.fret });
  }

  return cells.length === 0 ? NO_CELLS : cells;
}

/**
 * How many distinct cells sit above the neck's last fret — i.e. how much of the
 * pattern the board cannot show. Zero for every pattern the timeline's own fret
 * ceiling and the drawn instrument agree about.
 */
export function cellsAboveFret(pattern: Pattern | null, fretCount: number): number {
  if (!pattern || pattern.events.length === 0) return 0;
  return patternFootprint(pattern).filter((cell) => cell.fret > fretCount).length;
}
