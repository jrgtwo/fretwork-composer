// Permanent adapter, not a lib gap. Both of this module's reasons for existing are
// gone: `getTransportTicks` no longer throws without an AudioContext (was 3a), and
// `EventScheduler.onHead` now sweeps during playback (was 3b), so the playhead is a
// subscription rather than a loop of our own.
//
// What remains is for `useTimelineAutoScroll`, which deliberately does NOT subscribe:
// a head position pushed through React state at 60Hz re-renders every consumer, so it
// reads the transport in its own rAF and never touches React. That read is raw, so it
// still has to be folded into the loop itself.
import { wrapTick } from '@fretwork/lib';

/**
 * Fold the transport's ever-climbing tick count back into a loop of `duration`.
 * The scheduler reschedules each iteration at increasing absolute ticks, so an
 * unwrapped head runs off the end of the grid.
 */
export function wrapToDuration(tick: number, duration: number): number {
  return duration > 0 ? wrapTick(tick, 0, duration) : tick;
}
