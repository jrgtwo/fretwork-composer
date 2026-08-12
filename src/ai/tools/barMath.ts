/**
 * Tick ↔ bar for the agent's tools, in ONE place.
 *
 * `timelineMath` states the rule this module obeys at a different address: one
 * module owns tick↔bar so two surfaces cannot disagree about which bar a tick
 * is in. The tools cannot import it — `src/ai/**` reaches the app only through
 * the seams — so the conversion lives here instead, on the far side of
 * `compositionService`, and both `readTools` and `compositionTools` call it.
 *
 * It was hand-rolled in both of those first, with two different guards, and
 * they promptly disagreed: `read_composition` omitted bar numbers in a 4/7
 * signature while `composition_place_pattern` replied `atBar: 4,
 * ticksIntoBar: 548.571` for the same block. A reply carrying a fractional tick
 * in a document whose every tick is an integer is worse than no bar number.
 *
 * ⚠ NULL IS A REAL ANSWER, not an error. `composition_set_settings` takes any
 * denominator from 1 to 32, not only the powers of two that are real note
 * values, so a 4/7 bar is 1097.142... ticks and no bar after the first starts
 * on a whole one. Callers that WRITE refuse the bar form there; callers that
 * READ report ticks alone. Neither may round: a bar rounded down sits a
 * fraction short of its barline and reads back as the previous bar.
 */
import { ticksPerBar } from '../../composition/compositionService';

/** The composition's time signature, spelled as the seam spells it. */
export type SignatureOf = Parameters<typeof ticksPerBar>[0];

export interface BarConverter {
  /** Ticks in one bar — a positive integer, or this converter would be null. */
  readonly ticksPerBar: number;
  /** Which bar a tick falls in, counted FROM 1. */
  toBar(tick: number): number;
  /** Where bar N starts, counted FROM 1 — the off-by-one, done once. */
  toTick(bar: number): number;
  /** How far past the barline a tick sits. 0 means on it. */
  ticksIntoBar(tick: number): number;
}

/** A converter for this signature, or null where a bar is not a whole number
 *  of ticks and bar numbers therefore do not mean anything exact. */
export function barConverter(signature: SignatureOf): BarConverter | null {
  const perBar = ticksPerBar(signature);
  if (!Number.isInteger(perBar) || perBar <= 0) return null;
  return {
    ticksPerBar: perBar,
    toBar: (tick) => Math.floor(tick / perBar) + 1,
    toTick: (bar) => (bar - 1) * perBar,
    ticksIntoBar: (tick) => tick % perBar,
  };
}
