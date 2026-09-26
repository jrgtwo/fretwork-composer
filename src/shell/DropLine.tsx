/**
 * Where a dragged item would land in a `useDragReorder` list. One element
 * for every such list, for the reason the hook is one: a second hand-drawn copy
 * had already drifted from this one.
 */
export function DropLine() {
  return (
    <div
      data-testid="dropline"
      className="my-0.5 h-1 flex-none rounded-sm bg-brass-hi shadow-[0_0_10px_color-mix(in_srgb,var(--color-brass-hi)_60%,transparent)]"
    />
  );
}
