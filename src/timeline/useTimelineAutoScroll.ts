import { useEffect, type RefObject } from 'react';
import { readTransportTicks, wrapToDuration } from '../audio/transportClock';
import { tickToPx } from './timelineMath';

/**
 * Keeps the playhead on screen during playback.
 *
 * Ported from guitar-tutor, which learned two things the hard way:
 *
 *  - Read `Tone.Transport.ticks` in one rAF loop rather than subscribing to head
 *    updates. A head position pushed through React state at 60Hz cascades a
 *    re-render through every consumer.
 *  - Rate-limit the smooth scroll. Without the lockout, every frame past the
 *    threshold starts another `scrollTo({behavior:'smooth'})` and the animations
 *    stack, so the view stutters and fights itself.
 *
 * The view page-flips rather than tracking continuously: crossing 75% of the
 * viewport jumps forward and lands the head a quarter in, so the grid doesn't
 * crawl underneath a stationary playhead.
 */
export function useTimelineAutoScroll(
  scrollRef: RefObject<HTMLDivElement | null>,
  pxPerBeat: number,
  isPlaying: boolean,
  durationTicks: number,
  loop: boolean,
): void {
  useEffect(() => {
    if (!isPlaying) return;
    let rafId: number | null = null;
    let lastScrollAt = 0;

    const frame = () => {
      rafId = requestAnimationFrame(frame);
      const el = scrollRef.current;
      if (!el) return;

      // The transport climbs forever while looping — the scheduler reschedules
      // at increasing absolute ticks — so wrap it to match what's audible.
      const headTick = loop
        ? wrapToDuration(readTransportTicks(), durationTicks)
        : readTransportTicks();

      const headX = tickToPx(headTick, pxPerBeat);
      const viewLeft = el.scrollLeft;
      const viewWidth = el.clientWidth;
      const landing = viewWidth * 0.25;

      // Looped back, or the user scrolled ahead of the head: jump, so the first
      // notes of the pass aren't hidden behind a ~300ms animation.
      if (headX < viewLeft) {
        el.scrollLeft = Math.max(0, headX - landing);
        lastScrollAt = 0;
        return;
      }

      if (performance.now() - lastScrollAt < 350) return;

      if (headX > viewLeft + viewWidth * 0.75) {
        el.scrollTo({ left: Math.max(0, headX - landing), behavior: 'smooth' });
        lastScrollAt = performance.now();
      }
    };

    rafId = requestAnimationFrame(frame);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [isPlaying, pxPerBeat, durationTicks, loop, scrollRef]);
}
