// Permanent adapter, not a lib gap. Both of this module's reasons for existing are
// gone: `getTransportTicks` no longer throws without an AudioContext (was 3a), and
// `EventScheduler.onHead` now sweeps during playback (was 3b), so the playhead is a
// subscription rather than a loop of our own.
//
// Two callers remain, for two different reasons:
//
//   - `useTimelineAutoScroll` deliberately does NOT subscribe: a head position pushed
//     through React state at 60Hz re-renders every consumer, so it reads the transport
//     in its own rAF and never touches React. That read is unfolded, so it still has to
//     be wrapped into the loop itself.
//
// A third reason has since appeared, and it applies to BOTH of them plus every other
// transport read in the app: `getTransportTicks` corrects for output latency and not
// for Tone's lookAhead, so a head drawn straight from it leads the ear. See
// `audibleTransportTicks` below — nothing in this app should read the transport
// without it.
//   - the COMPOSITION path in `playbackService` has no head to subscribe to at all.
//     3b was closed for the primary scheduler, and `MultiTrackPlayback` builds every
//     one of its schedulers as a FOLLOWER — see LIB-GAP(16). Until that closes, the
//     arrangement playhead is a loop of our own again.
import * as Tone from 'tone';
import { getTransportTicks, wrapTick } from '@fretwork/lib';

/**
 * Fold the transport's ever-climbing tick count back into a loop of `duration`.
 * The scheduler reschedules each iteration at increasing absolute ticks, so an
 * unwrapped head runs off the end of the grid.
 */
export function wrapToDuration(tick: number, duration: number): number {
  return duration > 0 ? wrapTick(tick, 0, duration) : tick;
}

/**
 * Where playback actually IS, as opposed to where the transport says it is.
 *
 * `getTransportTicks` compensates for `AudioContext.outputLatency` — the gap
 * between a rendered sample and an audible one — and stops there. It reads
 * `Transport.ticks`, and Tone evaluates that at `now()`, which is
 * `context.currentTime + context.lookAhead` (`Clock.ticks` -> `ToneWithContext.now`).
 * The lookAhead is Tone's scheduling runway, 0.1 s by default: the raw tick is
 * a prediction of where the transport WILL be once the frames now being
 * assembled reach the device.
 *
 * So a head drawn from the lib's read leads the ear by a whole lookAhead
 * window, on top of any latency the browser under-reports. Nothing in the lib
 * subtracts it and nothing downstream can — the term is only knowable from the
 * context. Hence this, applied at the two places that draw from the transport.
 *
 * The correction is a DURATION, so it converts to ticks at the current tempo:
 * 0.1 s is 96 ticks at 120bpm and 48 at 60bpm. Reading the transport's own
 * `bpm.value` rather than the composition's keeps it right across a tempo
 * change mid-arrangement.
 *
 * Same contract as the lib's read, and for the same reason — every caller is an
 * rAF loop. **Never throws, never returns a non-finite number, never returns a
 * position before the start.** Without an AudioContext both Tone accessors
 * throw, which is normal under jsdom and before the first user gesture; that
 * case corrects by nothing rather than refusing to answer.
 */
export function audibleTransportTicks(ppq: number): number {
  const audible = getTransportTicks(ppq) - lookAheadTicks(ppq);
  return audible > 0 ? audible : 0;
}

/** Tone's scheduling runway, in ticks at the transport's current tempo. */
function lookAheadTicks(ppq: number): number {
  try {
    const lookAhead = Tone.getContext().lookAhead;
    const bpm = Tone.getTransport().bpm.value;
    const ticks = (lookAhead * ppq * bpm) / 60;
    return Number.isFinite(ticks) ? ticks : 0;
  } catch {
    // No AudioContext — there is no runway to correct for.
    return 0;
  }
}
