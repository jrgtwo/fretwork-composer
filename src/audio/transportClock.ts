// Permanent adapter, not a lib gap. Both of this module's reasons for existing are
// gone: `getTransportTicks` no longer throws without an AudioContext (was 3a), and
// `EventScheduler.onHead` now sweeps during playback (was 3b), so the playhead is a
// subscription rather than a loop of our own.
//
// Two callers remain, for two different reasons:
//
//   - `useTimelineAutoScroll` deliberately does NOT subscribe: a head position pushed
//     through React state at 60Hz re-renders every consumer, so it reads the transport
//     in its own rAF and never touches React. That read is raw, so it still has to be
//     folded into the loop itself.
//   - the COMPOSITION path in `playbackService` has no head to subscribe to at all.
//     3b was closed for the primary scheduler, and `MultiTrackPlayback` builds every
//     one of its schedulers as a FOLLOWER — see LIB-GAP(16). Until that closes, the
//     arrangement playhead is a loop of our own again.
import { wrapTick } from '@fretwork/lib';

/**
 * Fold the transport's ever-climbing tick count back into a loop of `duration`.
 * The scheduler reschedules each iteration at increasing absolute ticks, so an
 * unwrapped head runs off the end of the grid.
 */
export function wrapToDuration(tick: number, duration: number): number {
  return duration > 0 ? wrapTick(tick, 0, duration) : tick;
}
