import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Drag-edge auto-scroll: while a pointer gesture holds near the edge of a
 * horizontal scroller, the view keeps moving so the gesture can reach content
 * that was never on screen when it started.
 *
 * Both decisions the loop makes are pure functions here — how fast to go
 * (`edgeScrollSpeed`) and how far that is this frame (`stepFor`) — so the
 * tuning can be tested without a browser. What is left inside the hook is
 * plumbing: reading a box, writing `scrollLeft`, and calling back. jsdom gives
 * every element a 0x0 box, so a test has to hand the loop a geometry before any
 * of it does anything (tests/Timeline.test.tsx does exactly that).
 */

/**
 * How close to an edge the pointer has to get before the view moves. Wide
 * enough to hit without aiming, narrow enough that ordinary editing near the
 * end of a long pattern doesn't set the view sliding.
 */
const EDGE_ZONE_PX = 48;
/** Slowest useful creep: any less and crossing the threshold reads as nothing. */
export const MIN_SPEED = 80;
/** Full tilt, reached at the viewport edge — roughly six bars a second at the
 *  default zoom, which is fast without losing the plot. */
const MAX_SPEED = 1200;
/** A frame longer than this means the tab was away; don't lurch on the way back. */
const MAX_FRAME_S = 0.05;

/** Just the horizontal span of a viewport, in client coordinates. */
export interface EdgeBox {
  readonly left: number;
  readonly right: number;
}

/**
 * Scroll speed in px/sec for a pointer at `pointerX`: negative scrolls left,
 * positive right, zero not at all.
 *
 * Speed grows with the square of how far into the zone the pointer is, so the
 * first pixel past the threshold creeps and the last one flies — you can still
 * place a note precisely at the edge, and you can still cross ten bars by
 * shoving the pointer off the end.
 */
export function edgeScrollSpeed(pointerX: number, box: EdgeBox, edge: number = EDGE_ZONE_PX): number {
  const width = box.right - box.left;
  // A degenerate box (unmeasured, or jsdom's universal 0x0) has no edges to be
  // near, so nothing is ever scrolling.
  if (width <= 0) return 0;
  // Two zones wider than the viewport would overlap, leaving a pointer in the
  // middle "at both edges" at once. Splitting the difference keeps the two
  // halves distinct however narrow the well gets.
  const zone = Math.min(edge, width / 2);
  // A zero-width zone has no inside, and dividing by it below would make every
  // pointer infinitely deep — i.e. full speed everywhere.
  if (zone <= 0) return 0;

  const past =
    pointerX < box.left + zone
      ? pointerX - (box.left + zone)
      : pointerX > box.right - zone
        ? pointerX - (box.right - zone)
        : 0;
  if (past === 0) return 0;

  // Clamped, so the ramp tops out at the viewport edge rather than running away
  // with a pointer dragged far outside the window.
  const depth = Math.min(1, Math.abs(past) / zone);
  return Math.sign(past) * (MIN_SPEED + (MAX_SPEED - MIN_SPEED) * depth * depth);
}

/**
 * How many whole pixels to travel this frame at `speed`, given how long the
 * frame took and the sub-pixel remainder left over from the last one.
 *
 * Whole pixels because `scrollLeft` is integral in some engines: a fractional
 * step would round away to nothing and the slowest speeds would sit still
 * forever. The remainder is carried instead, so they creep rather than stall.
 */
export function stepFor(
  speed: number,
  dtSeconds: number,
  carry: number,
): { step: number; carry: number } {
  // Time-based rather than per-frame, so the same drag covers the same ground on
  // a 60Hz panel and a 144Hz one — but clamped, because a frame that took a
  // second means the tab was backgrounded, not that the user dragged that far.
  const dt = Math.min(MAX_FRAME_S, Math.max(0, dtSeconds));
  const total = carry + speed * dt;
  const step = Math.trunc(total);
  return { step, carry: total - step };
}

export interface EdgeAutoScroll {
  /** True from the first `track` until `end` — a gesture owns the scroller.
   *  Deliberately the whole gesture, not just the frames that scroll: a caller
   *  suspending something for the duration shouldn't see it flicker back on
   *  every time the pointer leaves the edge. */
  readonly engaged: boolean;
  /**
   * Feed the pointer's latest x. `onScroll` runs after every frame that
   * actually moved the view, and is how the gesture re-derives itself from a
   * pointer that hasn't moved while the content slid underneath it.
   */
  track: (clientX: number, onScroll: () => void) => void;
  /** Stop. Idempotent, and safe when nothing is running. */
  end: () => void;
}

const noop = () => {};

export function useEdgeAutoScroll(scrollRef: RefObject<HTMLDivElement | null>): EdgeAutoScroll {
  const [engaged, setEngaged] = useState(false);
  const pointerX = useRef(0);
  const onScroll = useRef<() => void>(noop);
  const rafId = useRef<number | null>(null);
  const lastAt = useRef(0);
  /** Sub-pixel remainder carried between frames. */
  const carry = useRef(0);

  // A gesture parks its listeners on `window` and can outlive this component,
  // so the loop has to be cut here as well as on pointerup. Cleared rather than
  // just cancelled: this effect's cleanup is not guaranteed to run last, and a
  // stale id cancelled afterwards would be someone else's frame.
  useEffect(
    () => () => {
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
      rafId.current = null;
    },
    [],
  );

  const frame = (now: number) => {
    rafId.current = null;
    const el = scrollRef.current;
    // No scroller any more (the timeline renders null while no pattern is open):
    // let the loop die rather than re-arming it forever. A pointermove restarts
    // it if one ever comes back.
    if (!el) return;

    const speed = edgeScrollSpeed(pointerX.current, el.getBoundingClientRect());
    // Out of the zone: nothing can put the pointer back in it except another
    // move, and `track` will restart the loop when it does.
    if (speed === 0) {
      carry.current = 0;
      return;
    }

    const dt = (now - lastAt.current) / 1000;
    lastAt.current = now;
    // Re-armed before the work, so an exception in the callback can't silently
    // strand a gesture that is still holding the edge.
    rafId.current = requestAnimationFrame(frame);

    const next = stepFor(speed, dt, carry.current);
    carry.current = next.carry;
    if (next.step === 0) return;

    const before = el.scrollLeft;
    el.scrollLeft = before + next.step;
    // Already against one end: there is nothing to re-track, and no reason to
    // let the remainder pile up into a lurch when the drag turns around.
    if (el.scrollLeft === before) {
      carry.current = 0;
      return;
    }
    onScroll.current();
  };

  const end = () => {
    if (rafId.current !== null) cancelAnimationFrame(rafId.current);
    rafId.current = null;
    carry.current = 0;
    // The callback closes over the finished gesture's snapshots and that
    // render's pattern; holding it until the next drag pins all of it.
    onScroll.current = noop;
    setEngaged(false);
  };

  const track = (clientX: number, next: () => void) => {
    pointerX.current = clientX;
    onScroll.current = next;
    setEngaged(true);
    if (rafId.current !== null) return;
    const el = scrollRef.current;
    // Only spin while the pointer is actually in an edge zone. The loop reads a
    // box every frame, which forces layout, and a drag through the middle of the
    // well would pay that for the whole gesture to compute zero every time.
    // Nothing but a move can carry the pointer *into* a zone, and once inside
    // the loop keeps itself alive.
    if (!el || edgeScrollSpeed(clientX, el.getBoundingClientRect()) === 0) return;
    lastAt.current = performance.now();
    rafId.current = requestAnimationFrame(frame);
  };

  return { engaged, track, end };
}
