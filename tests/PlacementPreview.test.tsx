import { cleanup, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PPQ, createEmptyPattern, ticksPerBar, type PatternEvent, type Placement } from '@fretwork/lib';
import { PlacementBlock } from '../src/composition/PlacementBlock';
import {
  DEFAULT_LANE_HEIGHTS,
  MIN_PREVIEW_WIDTH,
  placementRect,
  previewMarks,
} from '../src/composition/arrangementMath';

/**
 * The mini note preview inside a placement block (CP-09).
 *
 * jsdom has NO LAYOUT — every `getBoundingClientRect` is 0×0 — so nothing here
 * asserts that the preview LOOKS right. That is not available at any price in
 * this environment, and an assertion that pretended otherwise would pass
 * whatever the component drew. Where the drawing IS testable is that every
 * coordinate the component emits is the one `previewMarks` returned, compared
 * against a fresh call rather than against a number copied into the test; the
 * geometry itself is proved in `src/composition/arrangementMath.test.ts`, which
 * is exactly why it is a pure function.
 */

const BAR = ticksPerBar({ numerator: 4, denominator: 4 });
const PX_PER_BEAT = 48;
const BLOCK_H = DEFAULT_LANE_HEIGHTS.pattern;

function note(over: Partial<PatternEvent> & { id: string }): PatternEvent {
  return { stringIndex: 0, fret: 5, startTick: 0, durationTicks: PPQ, ...over };
}

function placement(events: PatternEvent[], over: Partial<Placement> = {}): Placement {
  return {
    id: 'p1',
    patternSnapshot: { ...createEmptyPattern('Riff A'), durationTicks: BAR, events },
    startTick: 2 * BAR,
    repeat: 1,
    transposeSemitones: 0,
    lengthTicks: null,
    ...over,
  };
}

/** A riff across four strings and four beats — enough that a preview which
 *  collapsed every note onto one row or one column would show it. */
const RIFF: PatternEvent[] = [
  note({ id: 'e1', stringIndex: 0, fret: 3, startTick: 0 }),
  note({ id: 'e2', stringIndex: 2, fret: 5, startTick: PPQ }),
  note({ id: 'e3', stringIndex: 5, fret: 7, startTick: 2 * PPQ }),
  note({ id: 'e4', stringIndex: 3, fret: 20, startTick: 3 * PPQ }),
];

function draw(placed: Placement, pxPerBeat = PX_PER_BEAT, laneHeight = BLOCK_H) {
  render(
    <PlacementBlock
      placement={placed}
      pxPerBeat={pxPerBeat}
      laneHeight={laneHeight}
      selected={false}
    />,
  );
  return {
    svg: document.querySelector<SVGSVGElement>(`[data-preview="${placed.id}"]`),
    marks: [...document.querySelectorAll<SVGRectElement>('[data-mark]')],
  };
}

const attr = (el: Element, name: string): number => Number(el.getAttribute(name));

describe('placement block note preview', () => {
  it('draws exactly the marks the maths returns, in the block’s own coordinates', () => {
    const placed = placement(RIFF);
    const { svg, marks } = draw(placed);
    const expected = previewMarks(placed, PX_PER_BEAT, BLOCK_H);
    expect(expected.length).toBe(RIFF.length);
    expect(marks).toHaveLength(expected.length);

    marks.forEach((mark, index) => {
      expect(attr(mark, 'x')).toBe(expected[index].left);
      expect(attr(mark, 'y')).toBe(expected[index].top);
      expect(attr(mark, 'width')).toBe(expected[index].width);
      expect(attr(mark, 'height')).toBe(expected[index].height);
      // Shading is the maths' answer too — it is how far up the neck the note
      // sounds, which is the only thing a transposition moves.
      expect(attr(mark, 'fill-opacity')).toBe(expected[index].opacity);
    });

    // The marks are block-LOCAL, so the viewBox has to be the block's own rect
    // or every one of them lands somewhere else. The block starts at bar 3;
    // a viewBox that carried the placement's absolute left would push the whole
    // preview off the block, and jsdom would never show it.
    const rect = placementRect(placed, PX_PER_BEAT, 0, BLOCK_H);
    expect(svg?.getAttribute('viewBox')).toBe(`0 0 ${rect.width} ${rect.height}`);
  });

  it('is one SVG per block, and lives inside the block it describes', () => {
    const placed = placement(RIFF);
    const { svg } = draw(placed);
    expect(document.querySelectorAll('[data-preview]')).toHaveLength(1);
    // Inside the block element, which is the `overflow-hidden rounded-md` box —
    // what stops a mark escaping the block's rounded corners.
    expect(svg?.parentElement?.getAttribute('data-placement')).toBe(placed.id);
    expect(svg?.parentElement?.className).toContain('overflow-hidden');
  });

  it('is inert: it neither takes the pointer nor speaks to a screen reader', () => {
    // The press has to reach the lane area's hit test, which is the only thing
    // that knows what a click on a block means. And the preview restates the
    // block's own content, so announcing it twice tells a reader nothing.
    const { svg } = draw(placement(RIFF));
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('class')).toContain('pointer-events-none');
  });

  it('draws nothing at all below the width threshold', () => {
    // One bar at 4 px/beat is 16 px — under `MIN_PREVIEW_WIDTH`.
    const narrow = MIN_PREVIEW_WIDTH / 4 - 1;
    const { svg, marks } = draw(placement(RIFF), narrow);
    expect(svg).toBeNull();
    expect(marks).toHaveLength(0);
    // The block itself still draws, with its name — degrading is not vanishing.
    expect(document.querySelector('[data-placement="p1"]')?.textContent).toContain('Riff A');
  });

  it('draws nothing past a trimmed block’s right edge', () => {
    const trimmed = placement(RIFF, { lengthTicks: 2 * PPQ });
    const { marks } = draw(trimmed);
    const rect = placementRect(trimmed, PX_PER_BEAT, 0, BLOCK_H);

    // Two of the four notes start after the cut.
    expect(marks.map((mark) => mark.getAttribute('data-mark'))).toEqual(['e1', 'e2']);
    for (const mark of marks) {
      expect(attr(mark, 'x') + attr(mark, 'width')).toBeLessThanOrEqual(rect.width);
    }
  });

  it('stops drawing a note the transposition pushes off the neck', () => {
    // `e4` is fret 20; +5 puts it at 25, past a guitar's 22, and
    // `flattenComposition` drops it. A preview that kept showing it would be
    // pointing at a note the arrangement no longer plays.
    const { marks } = draw(placement(RIFF, { transposeSemitones: 5 }));
    expect(marks.map((mark) => mark.getAttribute('data-mark'))).toEqual(['e1', 'e2', 'e3']);
  });

  it('shades the surviving marks by the fret they will sound at', () => {
    // `e1` is fret 3 and `e3` fret 7, so the shading already differs; +5 moves
    // both up the neck. Without this channel a transposition that keeps every
    // note on the neck would draw a pixel-identical preview.
    const shading = (transposeSemitones: number) => {
      const { marks } = draw(placement(RIFF, { transposeSemitones }));
      cleanup();
      return Object.fromEntries(
        marks.map((mark) => [mark.getAttribute('data-mark'), attr(mark, 'fill-opacity')]),
      );
    };

    const plain = shading(0);
    const up = shading(4);
    expect(plain.e3).toBeGreaterThan(plain.e1);
    expect(up.e1).toBeGreaterThan(plain.e1);
    expect(up.e3).toBeGreaterThan(plain.e3);
  });

  /**
   * The grid subscribes to the playback head, which ticks every animation frame,
   * so an unmemoized block re-runs `previewMarks` and re-reconciles one `<rect>`
   * per note 60 times a second for every block in the arrangement — the ticket's
   * "no measurable frame-rate cost during playback" is exactly what CP-09 puts
   * at risk. Observed through a counting getter on the prop the render reads,
   * because jsdom cannot show a dropped frame.
   */
  it('does not re-render — or redraw its preview — when nothing about it changed', () => {
    let reads = 0;
    const snapshot = placement(RIFF).patternSnapshot;
    const counted = placement(RIFF);
    Object.defineProperty(counted, 'patternSnapshot', {
      get() {
        reads++;
        return snapshot;
      },
    });

    const props = {
      placement: counted,
      pxPerBeat: PX_PER_BEAT,
      laneHeight: BLOCK_H,
      selected: false,
    };
    const { rerender } = render(<PlacementBlock {...props} />);
    expect(reads).toBeGreaterThan(0);

    const afterFirst = reads;
    // A head tick that leaves this block alone: same props, new element.
    rerender(<PlacementBlock {...props} />);
    expect(reads).toBe(afterFirst);

    // …and a prop that DOES change still gets through.
    rerender(<PlacementBlock {...props} playing />);
    expect(reads).toBeGreaterThan(afterFirst);
  });

  it('repeats the marks once per repetition of a repeated placement', () => {
    const { marks } = draw(placement(RIFF, { repeat: 3 }));
    expect(marks).toHaveLength(3 * RIFF.length);
    // Keys have to be unique per repetition or React collapses the repeats into
    // one; distinct x positions for the same event id is the observable form.
    const firsts = marks.filter((mark) => mark.getAttribute('data-mark') === 'e1');
    expect(new Set(firsts.map((mark) => attr(mark, 'x'))).size).toBe(3);
  });
});
