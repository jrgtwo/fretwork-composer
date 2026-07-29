import { onTestFinished, vi } from 'vitest';
import { act } from '@testing-library/react';

/**
 * Hands `requestAnimationFrame` to the test.
 *
 * Both of the timeline's scrollers are rAF loops, and jsdom's own rAF fires on a
 * real ~16ms timer: waiting on it is slow, flaky, and offers no way to say "now
 * three frames have passed at 50ms each". This queues the callbacks instead and
 * runs them on demand.
 *
 * Install it *before* rendering anything whose loop is already running at mount
 * — a frame armed by the real rAF is not in the queue and will fire on its own.
 */
export function installFrameClock() {
  const pending = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
    pending.set(nextId, cb);
    return nextId++;
  });
  const caf = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id) => {
    pending.delete(id);
  });
  // Registered rather than left to the caller's last statement, so a failing
  // expectation can't leave the whole file running on a stubbed rAF.
  onTestFinished(() => {
    raf.mockRestore();
    caf.mockRestore();
  });

  let clock = performance.now();
  return {
    /** How many frames are armed right now. Zero means the loop has stopped. */
    scheduled: () => pending.size,
    /** Run every armed frame, `ms` after the previous step. */
    step(ms = 16) {
      // Kept ahead of the real clock: the loops seed themselves from
      // performance.now(), and a fake timestamp behind that reads as a frame
      // that took negative time.
      clock = Math.max(clock, performance.now()) + ms;
      const due = [...pending.values()];
      pending.clear();
      act(() => {
        for (const cb of due) cb(clock);
      });
    },
  };
}
