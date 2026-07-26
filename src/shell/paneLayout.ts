/**
 * Pure layout rules for the resizable pane stack.
 *
 * Kept free of React and the DOM because these are the rules that are easy to get
 * subtly wrong — a collapsed pane that still absorbs space, a splitter that looks
 * live but drives a collapsed pane, a bottom pane with no way to claim the empty
 * area beneath it. They're much easier to pin down as functions than as pointer
 * handlers, so PaneStack owns only the gestures and defers every decision here.
 */

export interface PaneSpec {
  id: string;
  title: string;
  /** Smallest height in px. Ignored when `canFill` is set. */
  min?: number;
  /** Largest height in px — panes are capped so they can't stretch into dead space. */
  max?: number;
  /** This pane soaks up whatever height the others don't claim. At most one. */
  canFill?: boolean;
}

export interface PaneState {
  height: number;
  collapsed: boolean;
}

/** Which pane a splitter drives, and which way a downward drag moves it. */
export interface SplitTarget {
  id: string;
  /** +1 = dragging down grows it (it sits above the splitter); -1 = the reverse. */
  dir: 1 | -1;
}

const isResizable = (spec: PaneSpec | undefined): spec is PaneSpec =>
  !!spec && !spec.canFill;

export function clampHeight(spec: PaneSpec, height: number): number {
  if (spec.canFill) return height; // a fill pane's height is decided by flex, not us
  const min = spec.min ?? 0;
  const max = spec.max ?? Number.POSITIVE_INFINITY;
  return Math.max(min, Math.min(max, height));
}

export function reorder(order: readonly string[], id: string, toIndex: number): string[] {
  const without = order.filter((paneId) => paneId !== id);
  if (without.length === order.length) return [...order]; // unknown id
  const index = Math.max(0, Math.min(without.length, toIndex));
  without.splice(index, 0, id);
  return without;
}

/**
 * Resolve the splitter at `index`, which sits *below* `order[index]`.
 *
 * The last splitter is the trailing one under the bottom pane; it exists so that
 * pane can grow into free space, which it otherwise has no handle for. A splitter
 * prefers the pane above, but skips it when collapsed or unresizable and falls
 * back to the pane below, so a collapsed neighbour never leaves a dead handle.
 */
export function splitTarget(
  order: readonly string[],
  index: number,
  specs: readonly PaneSpec[],
  states: Readonly<Record<string, PaneState>>,
): SplitTarget | null {
  const usable = (id: string | undefined): id is string => {
    if (!id) return false;
    const spec = specs.find((s) => s.id === id);
    return isResizable(spec) && !states[id]?.collapsed;
  };

  const above = order[index];
  const below = order[index + 1];

  if (usable(above)) return { id: above, dir: 1 };
  if (usable(below)) return { id: below, dir: -1 };
  return null;
}

/** The pane currently allowed to absorb slack — never a collapsed one. */
export function fillerId(
  order: readonly string[],
  specs: readonly PaneSpec[],
  states: Readonly<Record<string, PaneState>>,
): string | null {
  const id = order.find((paneId) => specs.find((s) => s.id === paneId)?.canFill);
  if (!id || states[id]?.collapsed) return null;
  return id;
}

export function allCollapsed(
  order: readonly string[],
  states: Readonly<Record<string, PaneState>>,
): boolean {
  return order.length > 0 && order.every((id) => states[id]?.collapsed);
}
