// LIB-GAP(3b): what's left of this module exists because `EventScheduler` emits
// `onActive` and `onPlacementChange` from its rAF loop but never `onHead`, so the
// playhead has to read the transport itself. Delete `wrapToDuration` and its callers
// once `onHead` sweeps during playback. See docs/FOLLOW-UPS.md § "Lib gaps we are masking".
//
// The 3a half is gone: `getTransportTicks` no longer throws without an AudioContext
// (it returns 0 and guards against non-finite results), so the try/catch wrapper that
// used to live here is deleted and callers use the lib directly.
import { wrapTick } from '@fretwork/lib';

/**
 * Fold the transport's ever-climbing tick count back into a loop of `duration`.
 * The scheduler reschedules each iteration at increasing absolute ticks, so an
 * unwrapped head runs off the end of the grid.
 */
export function wrapToDuration(tick: number, duration: number): number {
  return duration > 0 ? wrapTick(tick, 0, duration) : tick;
}
