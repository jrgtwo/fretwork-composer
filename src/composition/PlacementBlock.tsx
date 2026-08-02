import type { Placement } from '@fretwork/lib';
import {
  droppedByTranspose,
  placementRect,
  placementRepeatRects,
  trimHandleWidth,
} from './arrangementMath';

/**
 * One placement, drawn in its lane.
 *
 * Inert DOM: there is no pointer handler here and there is not meant to be one.
 * The lane area carries a single handler and asks `arrangementMath.hitTest`
 * what is under the cursor — including which EDGE — so the block's position and
 * the gesture's idea of its position come from one function and cannot drift.
 * The two edge strips below are cursor affordances only; they take their width
 * from the same `trimHandleWidth` the hit test's zones do.
 *
 * Geometry is `arrangementMath`'s — this component does no arithmetic on ticks
 * or pixels, which is what keeps the block, the ruler and the hit test from ever
 * disagreeing about where the block is.
 *
 * Coordinates are LANE-LOCAL: the lane element is already positioned in the lane
 * stack, so the rects are taken with a `laneTop` of 0. `hitTest` works in
 * lanes-content space and is passed the lane's real top — the same function,
 * called in whichever frame the caller is working in.
 */
export function PlacementBlock({
  placement,
  pxPerBeat,
  laneHeight,
  selected,
  playing = false,
}: {
  placement: Placement;
  pxPerBeat: number;
  laneHeight: number;
  selected: boolean;
  /**
   * The head is inside this block. A SEPARATE state from `selected`, drawn as an
   * outline rather than a fill, because the two are orthogonal and routinely
   * both true — a block you are dragging is very often the one you are listening
   * to, and collapsing them would make the arrangement look like playback kept
   * changing the selection.
   */
  playing?: boolean;
}) {
  const rect = placementRect(placement, pxPerBeat, 0, laneHeight);
  // `slice(1)`: the divisions mark where the pattern RESTARTS, and the first
  // repetition starts at the block's own left edge — drawing it would paint a
  // second dark rule over that edge on every block in the arrangement, not just
  // repeated ones.
  const restarts = placementRepeatRects(placement, pxPerBeat, 0, laneHeight).slice(1);
  const transpose = placement.transposeSemitones;
  const dropped = droppedByTranspose(placement);
  const handle = trimHandleWidth(rect.width);

  return (
    <>
      <div
        data-placement={placement.id}
        data-selected={selected || undefined}
        data-playing={playing || undefined}
        title={placement.patternSnapshot.name}
        style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        className={`absolute flex cursor-grab touch-none flex-col justify-between overflow-hidden rounded-md px-1.5 py-1 select-none ${
          selected
            ? 'border border-brass bg-linear-to-b from-select-hi to-select-lo shadow-[0_0_0_1px_var(--color-brass)]'
            : 'control pressable'
        } ${playing ? 'ring-1 ring-brass-hi' : ''}`}
      >
        <span
          className={`truncate font-mono text-[9.5px] font-bold ${
            selected ? 'text-brass-hi' : 'text-ink'
          }`}
        >
          {placement.patternSnapshot.name}
        </span>
        <span className="flex items-end gap-1">
          {transpose !== 0 && (
            <span className="truncate font-mono text-[8px] font-bold tracking-[0.1em] text-brass-hi uppercase">
              {transpose > 0 ? `+${transpose}` : transpose}
            </span>
          )}
          {/* Not `aria-hidden`, and not a colour cue alone: this is the only
              warning that part of the block has stopped sounding, and the
              alternative to reading it is noticing a missing part by ear. */}
          {dropped > 0 && (
            <span
              data-dropped={dropped}
              title={`${dropped} ${dropped === 1 ? 'note falls' : 'notes fall'} off the neck at ${
                transpose > 0 ? `+${transpose}` : transpose
              } and won't sound`}
              className="truncate font-mono text-[8px] font-bold tracking-[0.1em] text-ink-hi uppercase"
            >
              ⚠ {dropped}
            </span>
          )}
        </span>
        {/* TODO(CP-09): the mini note preview goes here, inside the block. */}
      </div>

      {/* Cursor affordances for the trim zones. `pointer-events-none` is
          deliberately NOT set — they need to be pointer targets to change the
          cursor — but they carry no handler of their own: the press bubbles to
          the lane area, which hit-tests it like any other. Width from
          `trimHandleWidth`, so what says "resize" is what resizes. */}
      {handle > 0 &&
        (['trim-start', 'trim-end'] as const).map((zone) => (
          <i
            key={zone}
            aria-hidden
            data-trim={`${placement.id}:${zone}`}
            style={{
              left: zone === 'trim-start' ? rect.left : rect.left + rect.width - handle,
              top: rect.top,
              width: handle,
              height: rect.height,
            }}
            className="absolute cursor-ew-resize"
          />
        ))}

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
