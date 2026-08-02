import type { Placement } from '@fretwork/lib';
import { placementRect, placementRepeatRects } from './arrangementMath';

/**
 * One placement, drawn in its lane.
 *
 * Read-only: no drag, no trim, no click. CP-06 owns every gesture, and the
 * `selected` treatment is rendered here now so that ticket has only the wiring
 * left to do. Geometry is `arrangementMath`'s — this component does no
 * arithmetic on ticks or pixels, which is what keeps the block, the ruler and
 * CP-06's hit test from ever disagreeing about where the block is.
 *
 * Coordinates are LANE-LOCAL: the lane element is already positioned in the lane
 * stack, so the rects are taken with a `laneTop` of 0. `hitTest` works in
 * lanes-content space and will pass the lane's real top — the same function,
 * called in whichever frame the caller is working in.
 */
export function PlacementBlock({
  placement,
  pxPerBeat,
  laneHeight,
  selected,
}: {
  placement: Placement;
  pxPerBeat: number;
  laneHeight: number;
  selected: boolean;
}) {
  const rect = placementRect(placement, pxPerBeat, 0, laneHeight);
  // `slice(1)`: the divisions mark where the pattern RESTARTS, and the first
  // repetition starts at the block's own left edge — drawing it would paint a
  // second dark rule over that edge on every block in the arrangement, not just
  // repeated ones.
  const restarts = placementRepeatRects(placement, pxPerBeat, 0, laneHeight).slice(1);
  const transpose = placement.transposeSemitones;

  return (
    <>
      <div
        data-placement={placement.id}
        data-selected={selected || undefined}
        title={placement.patternSnapshot.name}
        style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        className={`absolute flex flex-col justify-between overflow-hidden rounded-md px-1.5 py-1 ${
          selected
            ? 'border border-brass bg-linear-to-b from-select-hi to-select-lo shadow-[0_0_0_1px_var(--color-brass)]'
            : 'control pressable'
        }`}
      >
        <span
          className={`truncate font-mono text-[9.5px] font-bold ${
            selected ? 'text-brass-hi' : 'text-ink'
          }`}
        >
          {placement.patternSnapshot.name}
        </span>
        {transpose !== 0 && (
          <span className="truncate font-mono text-[8px] font-bold tracking-[0.1em] text-brass-hi uppercase">
            {transpose > 0 ? `+${transpose}` : transpose}
          </span>
        )}
        {/* TODO(CP-09): the mini note preview goes here, inside the block. */}
      </div>

      {/* One per repetition AFTER the first, drawn OVER the block rather than
          inside it: their lefts are lane-local like the block's own, so nesting
          them would mean subtracting the block's left in this component — the
          arithmetic this module has no business doing. `repeat` is legacy data
          with no control in the new UI (the lib documents it so), but a
          composition that carries one has to draw its restart points or the
          block lies about its content. An unrepeated placement draws none. */}
      {restarts.map((repeatRect, index) => (
        <i
          // The repetition's ordinal: its left edge would collide with the next
          // one's for a zero-length snapshot, and two children keyed the same
          // are one child as far as React is concerned.
          key={index}
          aria-hidden
          data-repeat={placement.id}
          style={{
            left: repeatRect.left,
            top: repeatRect.top,
            width: repeatRect.width,
            height: repeatRect.height,
          }}
          className="pointer-events-none absolute rounded-md border-l border-rim-dark"
        />
      ))}
    </>
  );
}
