import { useCallback, useRef, useState, type ReactNode } from 'react';
import {
  allCollapsed,
  clampHeight,
  fillerId,
  reorder,
  splitTarget,
  type PaneSpec,
  type PaneState,
} from './paneLayout';

export interface Pane extends PaneSpec {
  /** Right-aligned controls in the pane header. */
  actions?: ReactNode;
  children?: ReactNode;
}

const HEADER_H = 31;
const DRAG_THRESHOLD = 5;

/**
 * A vertical stack of collapsible, reorderable, resizable panes.
 *
 * All the layout decisions live in ./paneLayout — this component only turns
 * pointer gestures into calls on those rules.
 */
export function PaneStack({ panes }: { panes: Pane[] }) {
  const specs = panes;
  const [order, setOrder] = useState<string[]>(() => panes.map((p) => p.id));
  const [states, setStates] = useState<Record<string, PaneState>>(() =>
    Object.fromEntries(
      panes.map((p) => [p.id, { height: p.min ?? 200, collapsed: false }]),
    ),
  );
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const stackRef = useRef<HTMLDivElement>(null);

  const paneById = (id: string) => specs.find((p) => p.id === id)!;
  const filler = fillerId(order, specs, states);
  const empty = allCollapsed(order, states);
  // Panes the dragged one could land between. A drop index equal to this length
  // means "after the last pane", which needs its own indicator below the stack.
  const others = dragging ? order.filter((id) => id !== dragging) : [];

  const dropline = (
    <div
      data-testid="dropline"
      className="my-0.5 h-1 flex-none rounded-sm bg-brass-hi shadow-[0_0_10px_rgb(208_168_102/0.6)]"
    />
  );

  const setHeight = useCallback((id: string, height: number) => {
    setStates((prev) => ({ ...prev, [id]: { ...prev[id], height } }));
  }, []);

  const toggleCollapse = useCallback((id: string) => {
    setStates((prev) => ({
      ...prev,
      [id]: { ...prev[id], collapsed: !prev[id].collapsed },
    }));
  }, []);

  const expandAll = useCallback(() => {
    setStates((prev) =>
      Object.fromEntries(
        Object.entries(prev).map(([id, s]) => [id, { ...s, collapsed: false }]),
      ),
    );
  }, []);

  // ---- splitter drag ------------------------------------------------------
  const onSplitterDown = (index: number) => (e: React.MouseEvent) => {
    const target = splitTarget(order, index, specs, states);
    if (!target) return;
    e.preventDefault();
    const spec = paneById(target.id);
    const startY = e.clientY;
    const startH = states[target.id].height;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    const move = (ev: MouseEvent) => {
      const delta = (ev.clientY - startY) * target.dir;
      setHeight(target.id, clampHeight(spec, startH + delta));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
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
      if (moved) setOrder((prev) => reorder(prev, id, target));
      setDragging(null);
      setDropIndex(null);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div ref={stackRef} className="flex min-h-0 min-w-0 flex-col px-3 pt-2.5 pb-3">
      {order.map((id, i) => {
        const pane = paneById(id);
        const state = states[id];
        const isFiller = filler === id && !state.collapsed;
        const target = splitTarget(order, i, specs, states);
        const othersIndex = others.indexOf(id);

        return (
          <div key={id} className="contents">
            {dropIndex !== null && othersIndex === dropIndex && dropline}

            <section
              data-pane={id}
              style={{
                height: state.collapsed ? HEADER_H : isFiller ? undefined : state.height,
                flex: state.collapsed ? '0 0 auto' : isFiller ? '1 1 0' : '0 0 auto',
              }}
              className={`tray flex min-h-0 flex-col overflow-hidden ${
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
                  aria-label={state.collapsed ? `Expand ${pane.title}` : `Collapse ${pane.title}`}
                  aria-expanded={!state.collapsed}
                  onClick={() => toggleCollapse(id)}
                  className="flex h-[19px] w-[19px] items-center justify-center rounded-[5px] font-mono text-[9px] text-ink-mut hover:bg-raise hover:text-brass-hi"
                >
                  {state.collapsed ? '▸' : '▾'}
                </button>
                <h2 className="font-mono text-[9px] font-semibold tracking-[0.16em] text-ink-mut uppercase">
                  {pane.title}
                </h2>
                <span className="flex-1" />
                {pane.actions}
              </header>

              {!state.collapsed && (
                <div className="flex min-h-0 flex-1 flex-col p-1.5">{pane.children}</div>
              )}
            </section>

            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label={target ? `Resize ${paneById(target.id).title}` : 'Resize (unavailable)'}
              data-testid={`splitter-${i}`}
              onMouseDown={onSplitterDown(i)}
              className={`flex h-2.5 flex-none items-center justify-center ${
                target ? 'cursor-ns-resize' : 'cursor-default'
              }`}
            >
              <i
                className={`block h-1 w-10 rounded-sm bg-linear-to-b from-[#50555f] to-[#3a3e47] shadow-[0_1px_0_rgb(255_255_255/0.1)_inset,0_1px_3px_rgb(0_0_0/0.5)] ${
                  target ? 'hover:from-brass-hi hover:to-brass' : 'opacity-35'
                }`}
              />
            </div>
          </div>
        );
      })}

      {/* dropping past the last pane — the loop above can only draw *before* a pane */}
      {dropIndex !== null && dropIndex >= others.length && dropline}

      {empty && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2.5 rounded-xl border border-dashed border-line bg-black/10">
          <p className="font-mono text-[9.5px] font-semibold tracking-[0.16em] text-ink-mut uppercase">
            All panels collapsed
          </p>
          <button type="button" onClick={expandAll} className="pressable control rounded-lg px-3 py-1.5 font-mono text-[9.5px] font-bold tracking-[0.09em] uppercase">
            Expand all
          </button>
        </div>
      )}
    </div>
  );
}
