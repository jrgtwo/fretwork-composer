/**
 * Pure layout rules for the pane stack.
 *
 * There is almost nothing left here, and that is the point. This module used to own
 * drag-resize: per-pane `min`/`max`, a `clampHeight`, a `splitTarget` resolver, and a
 * `canFill` pane that absorbed whatever the others didn't claim. All of it is gone.
 *
 * Why: `canFill` and "resizable" were mutually exclusive by construction — the fill
 * pane could never be a splitter target, so it had no handle of its own and changed
 * size only as leftovers. With three panes that meant two handles both driving the
 * Timeline in opposite directions and none driving the Instrument & Amp pane at all.
 *
 * The replacement is that **every pane is as tall as its content needs**, and the only
 * control is collapse. Heights are therefore not a layout concern any more: no pane is
 * measured, clamped or given a size, and the stack simply scrolls when the panes
 * together outgrow it. This is deliberately a stopgap — a better layout is planned —
 * but it is a stopgap with no arithmetic in it, which is why it can't go subtly wrong
 * the way the resize rules did.
 */

export interface PaneSpec {
  id: string;
  title: string;
}

export interface PaneState {
  collapsed: boolean;
}

/**
 * Move `id` to `toIndex` in the visible order.
 *
 * `toIndex` is an index into the list *without* `id` in it, which is what a drop
 * indicator between the remaining panes actually means. Out-of-range indices clamp
 * rather than dropping the pane, so a drop past the end lands last.
 */
export function reorder(order: readonly string[], id: string, toIndex: number): string[] {
  const without = order.filter((paneId) => paneId !== id);
  if (without.length === order.length) return [...order]; // unknown id
  const index = Math.max(0, Math.min(without.length, toIndex));
  without.splice(index, 0, id);
  return without;
}
