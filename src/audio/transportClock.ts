import { PPQ, getTransportTicks, wrapTick } from '@fretwork/lib';

/**
 * The transport position, in the lib's ticks.
 *
 * Guarded because `getTransportTicks` reads `Tone.Transport.bpm.value`, which
 * doesn't exist until a real AudioContext does — under jsdom it throws. Both
 * callers run inside requestAnimationFrame loops, where an exception escapes
 * every try/catch the caller has and surfaces as an unhandled error.
 */
export function readTransportTicks(): number {
  try {
    return getTransportTicks(PPQ);
  } catch {
    return 0;
  }
}

/**
 * Fold the transport's ever-climbing tick count back into a loop of `duration`.
 * The scheduler reschedules each iteration at increasing absolute ticks, so an
 * unwrapped head runs off the end of the grid.
 */
export function wrapToDuration(tick: number, duration: number): number {
  return duration > 0 ? wrapTick(tick, 0, duration) : tick;
}
