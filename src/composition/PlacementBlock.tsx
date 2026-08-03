import { memo } from 'react';
import type { Placement } from '@fretwork/lib';
import {
  droppedByTranspose,
  placementRect,
  placementRepeatRects,
  previewMarks,
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
 *
 * MEMOIZED, and it has to be: the grid subscribes to the playback head, which
 * ticks once per animation frame, so every block re-renders 60 times a second
 * for the whole of playback. Since CP-09 that means re-running `previewMarks`
 * and re-reconciling one `<rect>` per note per block per frame — hundreds of
 * elements across a full arrangement, for a head tick that changes at most one
 * block's `playing`. Every prop is a primitive or the store's own stable
 * `placement`, so the default shallow comparison is the right one.
 */
export const PlacementBlock = memo(function PlacementBlock({
  placement,
  pxPerBeat,
  laneHeight,
  selected,
  playing = false,
  drifted = false,
}: {
  placement: Placement;
  pxPerBeat: number;
  laneHeight: number;
  selected: boolean;
  /**
   * This block's snapshot no longer says what the library pattern it is named
   * after says — someone edited it in place (CP-11).
   *
   * Marked because placement editing is placement-LOCAL by design: the snapshot
   * was deep-copied when the block was placed and rippling an edit back to the
   * library is explicitly deferred. Unmarked, "Riff A" quietly comes to mean
   * four different things in one arrangement and there is no way to tell which
   * copy you are listening to. Computed by the grid, not here: it needs the
   * library, which a block has no business reading.
   */
  drifted?: boolean;
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
  const marks = previewMarks(placement, pxPerBeat, rect.height);

  return (
    <>
      <div
        data-placement={placement.id}
        data-selected={selected || undefined}
        data-playing={playing || undefined}
        data-drifted={drifted || undefined}
        title={
          // States the DIFFERENCE and not a cause: the snapshot is compared
          // against the library pattern as it stands now, so this is equally
          // true of a block edited in place and of one left alone while the
          // library pattern moved on. Naming either would be a guess.
          drifted
            ? `${placement.patternSnapshot.name} — no longer matches the pattern it was placed from`
            : placement.patternSnapshot.name
        }
        style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        className={`absolute flex cursor-grab touch-none flex-col justify-between overflow-hidden rounded-md px-1.5 py-1 select-none ${
          selected
            ? 'border border-brass bg-linear-to-b from-select-hi to-select-lo shadow-[0_0_0_1px_var(--color-brass)]'
            : 'control pressable'
        } ${playing ? 'ring-1 ring-brass-hi' : ''}`}
      >
        {/* The mini note preview (CP-09). ONE `<svg>` per block, one `<rect>`
            per mark: eight tracks × many placements × many notes is the one
            place on this page where node count could matter, and an SVG rect
            has no CSS box, no layout pass and no stacking context where an
            absolutely-positioned `<div>` per note would have all three. It is
            not collapsed further into a single `<path>` because the marks then
            stop being individually assertable, and jsdom (every rect 0×0)
            leaves that as the ONLY way this drawing can be verified at all.

            Inert: `aria-hidden` because it restates the block's own content, and
            `pointer-events-none` so the press still reaches the lane area's
            hit test. Clicking a block selects it, in the preview or out of it.

            Separation from the chrome is `previewMarks`' job, not z-order's:
            it reserves the label's and the badges' rows out of the strip before
            it places anything. It has to be, because DOM order does NOT settle
            this — a positioned descendant paints above the in-flow inline
            content of the same stacking context regardless of where it sits in
            the tree, so an absolute SVG drawn first still paints over the name.

            `inset-0` sizes the SVG to the block's PADDING box — one border
            narrower and shorter than the rect the marks were measured against —
            while the viewBox is that full rect, so `preserveAspectRatio="none"`
            COMPRESSES the strip by one border on each axis (~1 px, ~2% of an
            88 px block) and shifts it 1 px in. Deliberate: the padding box is
            the block's visible interior AND the box `overflow-hidden` clips to,
            so nothing can escape the rounded corners, and the error is smaller
            than the mark gap. The alternative — subtracting a border width in
            `arrangementMath` — would put a CSS detail into the geometry. */}
        {marks.length > 0 && (
          <svg
            aria-hidden
            data-preview={placement.id}
            viewBox={`0 0 ${rect.width} ${rect.height}`}
            preserveAspectRatio="none"
            className="pointer-events-none absolute inset-0"
          >
            {marks.map((mark) => (
              <rect
                key={`${mark.eventId}:${mark.repeat}`}
                data-mark={mark.eventId}
                x={mark.left}
                y={mark.top}
                width={mark.width}
                height={mark.height}
                // How far up the neck the note SOUNDS — the one thing a
                // transposition changes that the string/time geometry cannot
                // show. Resolved in `arrangementMath`, applied verbatim here.
                fillOpacity={mark.opacity}
                // Brass, like every accent on this page — slate and plum are
                // reserved for stage types. Held well under full strength so it
                // reads as texture behind the name rather than as a second
                // label; brighter on a selected block only because the selected
                // fill is itself brass-tinted and would swallow it.
                className={selected ? 'fill-brass-hi/70' : 'fill-brass/50'}
              />
            ))}
          </svg>
        )}

        <span
          className={`truncate font-mono text-[9.5px] font-bold ${
            selected ? 'text-brass-hi' : 'text-ink'
          }`}
        >
          {/* The mark rides IN the name rather than in the badge row below,
              because it qualifies the name: it is this copy of "Riff A" that
              has moved on, and a badge at the other end of the block reads as a
              separate fact about it. An asterisk for the reason every editor
              uses one for an unsaved buffer. */}
          {placement.patternSnapshot.name}
          {drifted && ' *'}
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
});
