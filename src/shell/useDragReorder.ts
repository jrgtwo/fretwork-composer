import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';

/** Pixels the pointer has to travel before a press on a handle becomes a drag,
 *  so a click on a header stays a click. */
const DRAG_THRESHOLD = 5;

export interface DragReorder {
  /** The id being dragged, once the press has crossed the threshold. */
  readonly dragging: string | null;
  /** Where it would land: an index into {@link others}, where `others.length`
   *  means after the last one. */
  readonly dropIndex: number | null;
  /** The order without the dragged id — the slots a drop index counts. Empty
   *  while nothing is being dragged. */
  readonly others: readonly string[];
  /** The handle's `onMouseDown`. A press on a `<button>` inside the handle is
   *  left alone, so the controls on a header stay clickable. */
  readonly onHandleDown: (id: string) => (event: ReactMouseEvent) => void;
}

/**
 * Drag-to-reorder over a vertical list: press a handle, drag past the threshold,
 * and the item under the pointer's midline decides the drop slot.
 *
 * One gesture for every reorderable list in the app — the pane stack and the
 * pedalboard. It was written inside `PaneStack` and lifted out unchanged when
 * the pedalboard needed the same thing, because a second copy of a drag
 * transport is how the knob drag reached three copies with a defect fixed in
 * only one of them.
 *
 * Owns only the gesture. The pure step is the caller's — `paneLayout.reorder`
 * or the lib's `movePedal`, which share the `toIndex` semantics `onDrop` hands
 * over (an index into the list WITHOUT the moving item, clamped) — and so is
 * drawing `DropLine` from `dropIndex`.
 *
 * Items are found by `itemAttribute` inside `containerRef`, and their rects are
 * read on every move. jsdom has no layout — every rect is 0×0 — so there a drag
 * can only land past the last item and the midline test is a browser check; the
 * pedalboard also offers a keyboard path (Move up / Move down), which is what its
 * ordering tests drive.
 */
export function useDragReorder({
  order,
  containerRef,
  itemAttribute,
  onDrop,
}: {
  order: readonly string[];
  containerRef: RefObject<HTMLElement | null>;
  itemAttribute: string;
  onDrop: (id: string, toIndex: number) => void;
}): DragReorder {
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // The live gesture's window listeners, so something other than its own mouseup
  // can end it. The pedalboard sits in a stage body that unmounts when folded and
  // in an editor that unmounts on a page switch or a deleted track; a gesture
  // outliving its list would fire `onDrop` on the next mouseup anywhere, against
  // the holder and order captured at mousedown.
  const detachRef = useRef<(() => void) | null>(null);
  useEffect(() => () => detachRef.current?.(), []);

  const onHandleDown = (id: string) => (e: ReactMouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const startY = e.clientY;
    let moved = false;
    let target = order.indexOf(id);

    const move = (ev: MouseEvent) => {
      if (!moved && Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return;
      if (!moved) {
        moved = true;
        setDragging(id);
      }
      const rest = order.filter((o) => o !== id);
      let next = rest.length;
      for (let i = 0; i < rest.length; i++) {
        const el = containerRef.current?.querySelector<HTMLElement>(
          `[${itemAttribute}="${rest[i]}"]`,
        );
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) {
          next = i;
          break;
        }
      }
      target = next;
      setDropIndex(next);
    };
    // Ends the gesture WITHOUT a drop — an unmount, or the window losing focus
    // mid-drag (alt-tab), where the mouseup is never going to arrive here.
    const detach = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('blur', cancel);
      detachRef.current = null;
    };
    const cancel = () => {
      detach();
      setDragging(null);
      setDropIndex(null);
    };
    const up = () => {
      detach();
      if (moved) onDrop(id, target);
      setDragging(null);
      setDropIndex(null);
    };
    detachRef.current?.();
    detachRef.current = detach;
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('blur', cancel);
  };

  return {
    dragging,
    dropIndex,
    others: dragging ? order.filter((id) => id !== dragging) : [],
    onHandleDown,
  };
}
