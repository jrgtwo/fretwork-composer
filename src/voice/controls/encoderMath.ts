/**
 * The two pieces of `ParamEncoder` arithmetic that owe a test but cannot get one through
 * the DOM: the encoder's ring is `aria-hidden` decoration and its value rounding is
 * invisible behind `toFixed`. They live here rather than in the component so they are
 * assertable without a render — and so the component file exports only a component.
 */

/** Ticks around the encoder's full ring — one per increment. */
export const DETENTS = 24;

/**
 * Kill the float dust a repeated `+= 0.1` leaves behind. `Knob` rounds for the same
 * reason: `toFixed` in the readout would hide `0.30000000000000004`, but the number
 * written into the preset would keep it.
 */
export const tidy = (n: number) => Math.round(n * 1e9) / 1e9;

/**
 * Which of `detents` ticks the shaft sits on. Wraps, both ways — the modulo is written
 * twice because JS `%` keeps the sign of the dividend, so a negative value would
 * otherwise index off the front of the ring and light no tick at all.
 */
export function detentIndexOf(value: number, step: number, detents = DETENTS): number {
  if (step <= 0 || !Number.isFinite(value)) return 0;
  // `+ 0` collapses the `-0` that `Math.round` returns across the whole (-0.5, 0]
  // interval; `-0` compared against a tick index matches nothing.
  return (((Math.round(value / step) + 0) % detents) + detents) % detents;
}
