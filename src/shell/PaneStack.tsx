import { useRef, useState, type ReactNode } from 'react';
import { reorder, type PaneSpec } from './paneLayout';

export interface Pane extends PaneSpec {
  /** Right-aligned controls in the pane header. */
  actions?: ReactNode;
  children?: ReactNode;
}

/**
 * Which panes are folded and what order they sit in — owned by the caller, not
 * by this component.
 *
 * It used to be local `useState`, which was safe only while nothing could
 * unmount the stack. The composition page unmounts it on every visit, so held
 * here a collapse or a reorder would be silently undone by a page round trip.
 * Same rule, same reason as `referenceView` and `workingVoice` in `App`.
 */
export interface PaneLayoutControl {
  order: readonly string[];
  onOrderChange: (order: string[]) => void;
  /** Ids of the collapsed panes; anything absent is open. */
  collapsed: readonly string[];
  onCollapsedChange: (collapsed: readonly string[]) => void;
}

const DRAG_THRESHOLD = 5;

/**
 * A vertical stack of collapsible, reorderable panes.
 *
 * Each pane is exactly as tall as its content. Nothing here sizes a pane — no heights,
 * no flex grow, no min/max — so a pane's height is decided entirely by what it holds.
 * When the panes together outgrow the viewport, *this* element scrolls; panes no longer
 * scroll individually, which is the visible trade for losing the resize handles.
 *
 * Collapsing is the only size control. With every pane collapsed you get three headers
 * and empty space below them, and each header keeps its own expand toggle, so there is
 * no separate empty-state affordance to get back.
 */
export function PaneStack({
  panes,
  order: requestedOrder,
  onOrderChange,
  collapsed,
  onCollapsedChange,
}: { panes: Pane[] } & PaneLayoutControl) {
  const specs = panes;
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const stackRef = useRef<HTMLDivElement>(null);

  // The order is caller-owned, so it can disagree with the pane list — the two
  // are edited in different places and a pane added to one is not automatically
  // in the other. Reconcile rather than trusting it: unknown ids drop out, panes
  // it never heard of land at the end.
  const order = [
    ...requestedOrder.filter((id) => specs.some((p) => p.id === id)),
    ...specs.filter((p) => !requestedOrder.includes(p.id)).map((p) => p.id),
  ];

  const paneById = (id: string) => specs.find((p) => p.id === id)!;
  // Panes the dragged one could land between. A drop index equal to this length
  // means "after the last pane", which needs its own indicator below the stack.
  const others = dragging ? order.filter((id) => id !== dragging) : [];

  const dropline = (
    <div
      data-testid="dropline"
      className="my-0.5 h-1 flex-none rounded-sm bg-brass-hi shadow-[0_0_10px_rgb(208_168_102/0.6)]"
    />
  );

  const toggleCollapse = (id: string) => {
    onCollapsedChange(
      collapsed.includes(id) ? collapsed.filter((paneId) => paneId !== id) : [...collapsed, id],
    );
  };

  // ---- header drag to reorder ---------------------------------------------
  const onHeaderDown = (id: string) => (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return; // controls stay clickable
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
      const others = order.filter((o) => o !== id);
      let next = others.length;
      for (let i = 0; i < others.length; i++) {
        const el = stackRef.current?.querySelector<HTMLElement>(`[data-pane="${others[i]}"]`);
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
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (moved) onOrderChange(reorder(order, id, target));
      setDragging(null);
      setDropIndex(null);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div
      ref={stackRef}
      className="flex min-h-0 min-w-0 flex-col gap-2.5 overflow-y-auto px-3 pt-2.5 pb-3"
    >
      {order.map((id) => {
        const pane = paneById(id);
        const isCollapsed = collapsed.includes(id);
        const othersIndex = others.indexOf(id);

        return (
          <div key={id} className="contents">
            {dropIndex !== null && othersIndex === dropIndex && dropline}

            <section
              data-pane={id}
              className={`tray flex flex-none flex-col overflow-hidden ${
                dragging === id ? 'opacity-45 outline outline-dashed outline-brass' : ''
              }`}
            >
              <header
                onMouseDown={onHeaderDown(id)}
                className="flex flex-none cursor-grab items-center gap-1.5 border-b border-rim-dark bg-linear-to-b from-[#464a54] to-[#3b3f47] px-2 py-1 active:cursor-grabbing"
              >
                <span aria-hidden className="flex-none px-px font-mono text-[10px] tracking-tighter text-ink-mut">
                  ⠿
                </span>
                <button
                  type="button"
                  aria-label={isCollapsed ? `Expand ${pane.title}` : `Collapse ${pane.title}`}
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleCollapse(id)}
                  className="flex h-[19px] w-[19px] items-center justify-center rounded-[5px] font-mono text-[9px] text-ink-mut hover:bg-raise hover:text-brass-hi"
                >
                  {isCollapsed ? '▸' : '▾'}
                </button>
                <h2 className="font-mono text-[9px] font-semibold tracking-[0.16em] text-ink-mut uppercase">
                  {pane.title}
                </h2>
                <span className="flex-1" />
                {pane.actions}
              </header>

              {!isCollapsed && <div className="flex flex-col p-1.5">{pane.children}</div>}
            </section>
          </div>
        );
      })}

      {/* dropping past the last pane — the loop above can only draw *before* a pane */}
      {dropIndex !== null && dropIndex >= others.length && dropline}
    </div>
  );
}
