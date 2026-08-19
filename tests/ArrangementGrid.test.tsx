import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PATTERNS_STATE,
  MAX_COMPOSITION_TRACKS,
  PPQ,
  ticksPerBar,
  usePatternsStore,
  type Placement,
  type Track,
} from '@fretwork/lib';
import { ArrangementGrid } from '../src/composition/ArrangementGrid';
import { CompositionPage } from '../src/composition/CompositionPage';
import {
  ARRANGEMENT_ZOOM_LEVELS,
  DEFAULT_ARRANGEMENT_ZOOM_INDEX,
  arrangementBars,
  arrangementWidth,
  laneRects,
  lanesHeight,
  placementRect,
  placementRepeatRects,
  rulerMarks,
  zoomAnchoredScrollLeft,
  type ArrangementMode,
} from '../src/composition/arrangementMath';
import {
  addPlacement,
  addTrack,
  clearHistory,
  getEditingComposition,
  getSelectedTrackId,
  getTracks,
  openBlankComposition,
  selectPlacements,
  selectTrack,
} from '../src/composition/compositionService';
import { getEditingPattern, openBlankPattern, stampNote } from '../src/patterns/patternService';

/**
 * The arrangement grid — its geometry, its scroll sync and its toolbar.
 *
 * The GESTURES the lane area dispatches are `tests/ArrangementGestures.test.tsx`'s;
 * what is checked here is that this component asks `arrangementMath` for every
 * number it draws, and that each toolbar control reaches the capability its
 * keyboard twin reaches.
 *
 * jsdom has NO LAYOUT and NO SCROLLING: every box is 0×0 and every `scrollLeft`
 * reads 0 forever. So nothing here asserts that anything LOOKS right — that is
 * not available at any price in this environment, and a test that pretended
 * otherwise would pass whatever the component did. What is asserted instead:
 *
 *   - the component asks `arrangementMath` for its geometry and applies exactly
 *     what it gets back (every position is compared against a fresh call, not
 *     against a number copied into the test),
 *   - the scroll handler is on the lane area and drives the ruler horizontally
 *     and the headers vertically,
 *   - track count, placement count and repeat count each produce the matching
 *     number of elements,
 *   - selection round-trips through the seam,
 *   - both empty states render something a user can read.
 *
 * The scroll offsets in the sync tests are STUBBED onto the element, because
 * jsdom will never produce one on its own. Note what the stub has to fake and
 * what that means: jsdom's `scrollLeft` also never CLAMPS — it accepts any
 * number, past the end of the content or not — so the one behaviour that used to
 * be untestable here is the browser's own correction after the content shrinks
 * under a zoom-out. `stubScroller` below supplies that clamp explicitly rather
 * than leaving it to be discovered in a browser.
 */

const MODE: ArrangementMode = 'pattern';
const PX_PER_BEAT = ARRANGEMENT_ZOOM_LEVELS[DEFAULT_ARRANGEMENT_ZOOM_INDEX];
const px = (value: number) => `${value}px`;

beforeEach(() => {
  sessionStorage.clear();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  selectPlacements([]);
  selectTrack(null);
});

/**
 * A library pattern one bar long, created through the pattern seam.
 *
 * The note matters: a pattern with no events has a duration of nothing, and a
 * zero-width block is a block whose left edge cannot be told from a wrong one.
 * The lib auto-fits the pattern's length to its content, so stamping is how a
 * length is set.
 */
function seedPattern(name: string, beats = 4): string {
  openBlankPattern(name);
  const pattern = getEditingPattern();
  if (!pattern) throw new Error('pattern seam did not open a pattern');
  stampNote({ stringIndex: 0, fret: 0, tick: 0, durationTicks: beats * PPQ });
  return pattern.id;
}

function place(patternId: string, trackId: string, atTick: number): string {
  const result = addPlacement(patternId, trackId, atTick);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

/** Three tracks: two with blocks, one deliberately empty. */
function seedArrangement(): { patternId: string; trackIds: string[] } {
  // Idempotent, as the `ensureComposition` this replaced was: a helper that
  // CREATES unconditionally would switch away from a composition the test had
  // already opened, and the switch is silent.
  if (!getEditingComposition()) openBlankComposition('Song');
  const patternId = seedPattern('Riff');
  addTrack('Rhythm');
  addTrack('Lead');
  const trackIds = getTracks().map((t) => t.id);
  place(patternId, trackIds[0], 0);
  place(patternId, trackIds[0], 8 * PPQ);
  place(patternId, trackIds[1], 4 * PPQ);
  // `addPlacement` selects what it places, and seeding is seam writes like any
  // other — so without these two every test opens with the last block selected
  // and a stack of undo steps the toolbar would report as available.
  selectPlacements([]);
  clearHistory();
  return { patternId, trackIds };
}

const tracksNow = (): readonly Track[] => getTracks();

function placementsNow(): Placement[] {
  return tracksNow().flatMap((track) => [...track.placements]);
}

function timeSignature() {
  const composition = getEditingComposition();
  if (!composition) throw new Error('no composition open');
  return composition.timeSignature;
}

/** The bar count the grid lays itself out from — the same call the component
 *  makes, so a changed policy in one place fails the test rather than silently
 *  splitting the two. */
function barsNow(): number {
  return arrangementBars(tracksNow(), timeSignature(), { minBars: 8, trailingBars: 2 });
}

const scroller = () => screen.getByTestId('arrangement-lanes-scroller');
const rulerContent = () => screen.getByTestId('arrangement-ruler-content');
const headerStack = () => screen.getByTestId('track-header-stack');
const laneEls = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-lane-track]'));
const blockEl = (id: string) =>
  document.querySelector<HTMLElement>(`[data-placement="${id}"]`);

/** jsdom has no scrolling, so an offset has to be planted. Writable on purpose:
 *  the component moves the view itself after a zoom, and a read-only stub would
 *  make that write throw in strict mode. */
function scrollTo(left: number, top = 0): void {
  const el = scroller();
  Object.defineProperty(el, 'scrollLeft', { value: left, writable: true, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: top, writable: true, configurable: true });
  fireEvent.scroll(el);
}

/**
 * A `scrollLeft` that behaves like a real one and records what was written to
 * it: it CLAMPS to `maxScrollLeft`, which is what a browser does when the
 * content shrinks under a zoom-out, and what jsdom's own never does.
 *
 * Install after render. `userScrollTo` is the user's own scrolling — the element
 * moves first and the event follows, which is the ordering that distinguishes a
 * component reacting to a scroll from one imposing one.
 */
function stubScroller(maxScrollLeft = Number.POSITIVE_INFINITY) {
  const el = scroller();
  const writes: number[] = [];
  let max = maxScrollLeft;
  let value = 0;
  Object.defineProperty(el, 'scrollLeft', {
    configurable: true,
    get: () => value,
    set: (next: number) => {
      writes.push(next);
      value = Math.max(0, Math.min(next, max));
    },
  });
  return {
    writes,
    /** The ceiling moves when the content is re-laid out under a zoom: the width
     *  shrinks by the zoom ratio but the viewport does not, so the maximum falls
     *  further than the anchored offset does. That gap is the whole bug.
     *
     *  Deliberately does NOT pull the current offset down with it. The real
     *  re-layout happens between the click handler (which has already read the
     *  pre-zoom offset it anchors from) and the layout effect, so what is being
     *  modelled is only the ceiling the effect's write runs into. */
    setMax(next: number) {
      max = next;
    },
    userScrollTo(left: number) {
      value = Math.max(0, Math.min(left, max));
      fireEvent.scroll(el);
    },
  };
}

describe('lanes and headers', () => {
  it('draws one lane and one header per track, at the heights arrangementMath gives', () => {
    seedArrangement();
    render(<ArrangementGrid mode={MODE} />);

    const expected = laneRects(tracksNow(), MODE);
    const lanes = laneEls();
    expect(lanes).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: /^Select track / })).toHaveLength(3);

    lanes.forEach((lane, index) => {
      expect(lane.dataset.laneTrack).toBe(expected[index].trackId);
      expect(lane.style.height).toBe(px(expected[index].height));
    });

    // Headers are the lanes' own heights, not a constant of their own — this is
    // what keeps row N of the column beside row N of the grid.
    tracksNow().forEach((track, index) => {
      const header = document.querySelector<HTMLElement>(`[data-track-header="${track.id}"]`);
      expect(header?.style.height).toBe(px(expected[index].height));
    });

    // Both scrollable surfaces are exactly the lanes' total height, which is
    // what makes the vertical lock a single shared offset.
    expect(headerStack().style.height).toBe(px(lanesHeight(expected)));
    expect(scroller().firstElementChild).toHaveStyle({ height: px(lanesHeight(expected)) });
  });

  it('marks every lane with the attribute the lane styling keys off', () => {
    seedArrangement();
    render(<ArrangementGrid mode={MODE} />);

    // `.lanes > [data-lane]` in src/styles/index.css is what carves the
    // recessed channel, the divider between lanes and the zebra shading — the
    // "recessed-tray beat grid" the design language is built on. Both halves
    // matter: the attribute, AND being a DIRECT child of `.lanes`. Nothing else
    // in this file would notice the styling silently switching off.
    const styled = Array.from(document.querySelectorAll<HTMLElement>('.lanes > [data-lane]'));
    expect(styled.map((lane) => lane.dataset.laneTrack)).toEqual(
      tracksNow().map((track) => track.id),
    );
    expect(styled.map((lane) => lane.dataset.lane)).toEqual(
      tracksNow().map((track) => track.name),
    );
  });

  it('takes its lane height from the mode it is given', () => {
    seedArrangement();
    render(<ArrangementGrid mode="edit" />);

    const expected = laneRects(tracksNow(), 'edit');
    // The modes genuinely differ, or this assertion would hold for a component
    // that ignored the prop entirely.
    expect(expected[0].height).not.toBe(laneRects(tracksNow(), 'pattern')[0].height);
    expect(laneEls()[0].style.height).toBe(px(expected[0].height));
  });

  it('renders every track up to the composition cap', () => {
    openBlankComposition('Song');
    while (getTracks().length < MAX_COMPOSITION_TRACKS) addTrack();
    render(<ArrangementGrid mode={MODE} />);

    expect(laneEls()).toHaveLength(MAX_COMPOSITION_TRACKS);
    expect(screen.getAllByRole('button', { name: /^Select track / })).toHaveLength(
      MAX_COMPOSITION_TRACKS,
    );
  });
});

describe('placement blocks', () => {
  it('positions every block exactly where placementRect puts it', () => {
    seedArrangement();
    render(<ArrangementGrid mode={MODE} />);

    const lanes = laneRects(tracksNow(), MODE);
    let drawn = 0;
    tracksNow().forEach((track, index) => {
      for (const placement of track.placements) {
        // laneTop 0: the block sits inside its lane element, which is already
        // stacked at the lane's own top. Same function, lane-local frame.
        const rect = placementRect(placement, PX_PER_BEAT, 0, lanes[index].height);
        const el = blockEl(placement.id);
        expect(el).not.toBeNull();
        expect(el).toHaveStyle({
          left: px(rect.left),
          top: px(rect.top),
          width: px(rect.width),
          height: px(rect.height),
        });
        // …and inside the right lane, not merely somewhere on the page.
        expect(laneEls()[index].contains(el)).toBe(true);
        drawn++;
      }
    });
    expect(drawn).toBe(3);
    expect(document.querySelectorAll('[data-placement]')).toHaveLength(3);
  });

  it('moves every block when the zoom changes', async () => {
    seedArrangement();
    render(<ArrangementGrid mode={MODE} />);
    const placement = tracksNow()[0].placements[1];
    const lanes = laneRects(tracksNow(), MODE);

    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));

    const zoomed = ARRANGEMENT_ZOOM_LEVELS[DEFAULT_ARRANGEMENT_ZOOM_INDEX + 1];
    expect(blockEl(placement.id)).toHaveStyle({
      left: px(placementRect(placement, zoomed, 0, lanes[0].height).left),
      width: px(placementRect(placement, zoomed, 0, lanes[0].height).width),
    });
  });

  it('draws no repeat division on an ordinary unrepeated placement', () => {
    seedArrangement();
    render(<ArrangementGrid mode={MODE} />);

    // A division is a RESTART mark. The first repetition starts at the block's
    // own left edge, so drawing it would put a second dark rule down the left of
    // every block in the arrangement — not an edge case, the common case.
    expect(placementsNow().every((placement) => placement.repeat === 1)).toBe(true);
    expect(document.querySelectorAll('[data-repeat]')).toHaveLength(0);
  });

  it('divides a legacy repeated placement at its restart points', () => {
    openBlankComposition('Song');
    const patternId = seedPattern('Riff');
    const trackId = getTracks()[0].id;
    const placementId = place(patternId, trackId, 0);
    // The new UI exposes no repeat control by design (the lib says so), so this
    // is imported / legacy data reaching the store the only way it can.
    act(() => usePatternsStore.getState().setPlacementRepeat(placementId, 3));

    render(<ArrangementGrid mode={MODE} />);

    const placement = placementsNow()[0];
    expect(placement.repeat).toBe(3);
    const laneHeight = laneRects(tracksNow(), MODE)[0].height;
    const expected = placementRepeatRects(placement, PX_PER_BEAT, 0, laneHeight);
    const segments = Array.from(
      document.querySelectorAll<HTMLElement>(`[data-repeat="${placementId}"]`),
    );

    // Three repetitions, TWO internal divisions: the marks are where the pattern
    // restarts, and it does not restart at its own beginning.
    expect(segments).toHaveLength(2);
    segments.forEach((segment, index) => {
      expect(segment).toHaveStyle({
        left: px(expected[index + 1].left),
        width: px(expected[index + 1].width),
      });
    });
    // Stated so a component that simply dropped the last one instead passes for
    // the wrong reason: the divisions are strictly inside the block.
    expect(expected[1].left).toBeGreaterThan(
      placementRect(placement, PX_PER_BEAT, 0, laneHeight).left,
    );
    // The block itself spans all three, which is the bug a per-repetition block
    // would hide: three correct segments inside a one-repetition-wide block.
    expect(blockEl(placementId)).toHaveStyle({
      width: px(placementRect(placement, PX_PER_BEAT, 0, laneHeight).width),
    });
  });

  it('marks the selected placement, and stays inert DOM', () => {
    seedArrangement();
    const [first, second] = placementsNow();
    render(<ArrangementGrid mode={MODE} />);

    expect(blockEl(first.id)?.dataset.selected).toBeUndefined();

    act(() => selectPlacements([second.id]));

    expect(blockEl(second.id)?.dataset.selected).toBe('true');
    expect(blockEl(first.id)?.dataset.selected).toBeUndefined();
    // The lane area hit-tests presses; a block that carried its own controls
    // would be a second source of truth for where it is.
    expect(blockEl(second.id)?.querySelector('button')).toBeNull();
  });
});

/**
 * Each control is the twin of a keyboard shortcut and calls the same capability
 * — so what has to be checked here is only the WIRING, which is the part a
 * shared implementation cannot get right for you: a ♯ hooked to −1 would pass
 * every test in the gesture file.
 */
describe('the selection toolbar', () => {
  const button = (name: string) => screen.getByRole('button', { name });

  function seedSelected() {
    seedArrangement();
    const [first] = placementsNow();
    render(<ArrangementGrid mode={MODE} />);
    act(() => selectPlacements([first.id]));
    return first.id;
  }

  const transposeOf = (id: string) =>
    placementsNow().find((p) => p.id === id)?.transposeSemitones;

  it('appears only with a selection, and counts it', () => {
    seedArrangement();
    render(<ArrangementGrid mode={MODE} />);
    expect(screen.queryByRole('button', { name: 'Delete selection' })).toBeNull();

    act(() => selectPlacements(placementsNow().map((p) => p.id)));
    expect(button('Delete selection')).toBeInTheDocument();
    expect(screen.getByText(`${placementsNow().length} sel`)).toBeInTheDocument();
  });

  it('transposes up on ♯ and down on ♭', async () => {
    const user = userEvent.setup();
    const id = seedSelected();

    await user.click(button('Transpose up a semitone'));
    expect(transposeOf(id)).toBe(1);

    await user.click(button('Transpose down a semitone'));
    await user.click(button('Transpose down a semitone'));
    expect(transposeOf(id)).toBe(-1);
  });

  it('duplicates and deletes the selection', async () => {
    const user = userEvent.setup();
    seedArrangement();
    const before = placementsNow().length;
    render(<ArrangementGrid mode={MODE} />);
    act(() => selectPlacements([placementsNow()[0].id]));

    await user.click(button('Duplicate selection'));
    expect(placementsNow()).toHaveLength(before + 1);

    await user.click(button('Delete selection'));
    expect(placementsNow()).toHaveLength(before);
  });

  it('undoes and redoes through the toolbar, enabling each only when it can', async () => {
    const user = userEvent.setup();
    const id = seedSelected();
    expect(button('Undo')).toBeDisabled();

    await user.click(button('Transpose up a semitone'));
    expect(button('Undo')).toBeEnabled();
    expect(button('Redo')).toBeDisabled();

    await user.click(button('Undo'));
    expect(transposeOf(id)).toBe(0);

    await user.click(button('Redo'));
    expect(transposeOf(id)).toBe(1);
  });

  it('states why a split did nothing, and lets the message be dismissed', async () => {
    const user = userEvent.setup();
    seedSelected();

    // Nothing has been pressed on the lanes, so there is no cut point — the one
    // outcome that is indistinguishable from a broken button in silence.
    await user.click(button('Split at cursor'));
    expect(screen.getByRole('alert')).toHaveTextContent(/cursor/i);

    await user.click(button('Dismiss message'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('ruler', () => {
  it('draws the marks arrangementMath returns, where it puts them', () => {
    seedArrangement();
    render(<ArrangementGrid mode={MODE} />);

    const marks = rulerMarks(barsNow(), timeSignature(), PX_PER_BEAT);
    const lines = Array.from(
      rulerContent().querySelectorAll<HTMLElement>('[data-ruler-line]'),
    );
    expect(lines).toHaveLength(marks.length);
    lines.forEach((line, index) => {
      expect(line.dataset.rulerLine).toBe(String(marks[index].tick));
      expect(line.style.left).toBe(px(marks[index].x));
    });

    const labels = Array.from(
      rulerContent().querySelectorAll<HTMLElement>('[data-ruler-label]'),
    );
    expect(labels.map((label) => label.textContent)).toEqual(
      marks.filter((mark) => mark.label !== null).map((mark) => mark.label),
    );
  });

  it('rules the lanes with the very same lines', () => {
    seedArrangement();
    render(<ArrangementGrid mode={MODE} />);

    // The surface the blocks are read against. Drawn from the ruler's own mark
    // list rather than a second computation — round the two differently and
    // every block sits a pixel off the bar line it starts on.
    const marks = rulerMarks(barsNow(), timeSignature(), PX_PER_BEAT);
    const lines = Array.from(scroller().querySelectorAll<HTMLElement>('[data-grid-line]'));
    expect(lines).toHaveLength(marks.length);
    lines.forEach((line, index) => {
      expect(line.dataset.gridLine).toBe(String(marks[index].tick));
      expect(line.style.left).toBe(px(marks[index].x));
    });

    const rulerLines = Array.from(
      rulerContent().querySelectorAll<HTMLElement>('[data-ruler-line]'),
    );
    expect(lines.map((line) => line.style.left)).toEqual(
      rulerLines.map((line) => line.style.left),
    );
  });

  it('is a picture, not something a screen reader reads out as numbers', () => {
    seedArrangement();
    render(<ArrangementGrid mode={MODE} />);

    // Bar numbers announced as content read "1 2 3 4 5 6 7 8" with no way to
    // tell what they are. The track and bar counts are stated in words instead.
    expect(screen.getByTestId('arrangement-ruler')).toHaveAttribute('aria-hidden', 'true');
  });

  it('leaves empty bars past the last block, so there is room to place after it', () => {
    openBlankComposition('Song');
    const patternId = seedPattern('Riff');
    // Bar 13, well past the 8-bar minimum, so it is the trailing room being
    // measured and not the floor.
    place(patternId, getTracks()[0].id, 12 * ticksPerBar(timeSignature()));
    render(<ArrangementGrid mode={MODE} />);

    // No minimum, no trailing room: what the content alone fills.
    const filled = arrangementBars(tracksNow(), timeSignature(), {});
    expect(filled).toBe(13);
    expect(rulerContent().style.width).toBe(
      px(arrangementWidth(filled + 2, timeSignature(), PX_PER_BEAT)),
    );
    // Named: an axis that stopped dead on the last block has nowhere to drop the
    // next one (CP-05), and this is the only test that would notice.
    expect(rulerContent().style.width).not.toBe(
      px(arrangementWidth(filled, timeSignature(), PX_PER_BEAT)),
    );
  });

  it('is exactly as wide as the lane area, at every zoom', async () => {
    seedArrangement();
    render(<ArrangementGrid mode={MODE} />);

    for (let step = 0; step < 3; step++) {
      const zoom = ARRANGEMENT_ZOOM_LEVELS[DEFAULT_ARRANGEMENT_ZOOM_INDEX - step];
      const width = px(arrangementWidth(barsNow(), timeSignature(), zoom));
      expect(rulerContent().style.width).toBe(width);
      expect(scroller().firstElementChild).toHaveStyle({ width });
      await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    }
  });

  it('thins its labels out as the zoom gets too coarse to number every bar', async () => {
    seedArrangement();
    render(<ArrangementGrid mode={MODE} />);
    const labelCount = () => rulerContent().querySelectorAll('[data-ruler-label]').length;
    const dense = labelCount();

    // Three steps down from the default lands on the coarse whole-song levels,
    // where `rulerMarks` drops the beat lines and all but the major bars.
    for (let step = 0; step < 3; step++) {
      await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    }

    const coarseZoom = ARRANGEMENT_ZOOM_LEVELS[DEFAULT_ARRANGEMENT_ZOOM_INDEX - 3];
    const coarseMarks = rulerMarks(barsNow(), timeSignature(), coarseZoom);
    expect(labelCount()).toBe(coarseMarks.filter((mark) => mark.label !== null).length);
    // The point of the thinning, stated so a component that ignored zoom fails.
    expect(labelCount()).toBeLessThan(dense);
  });

  it('stops zooming at the ends of the scale', async () => {
    seedArrangement();
    render(<ArrangementGrid mode={MODE} />);

    for (let step = 0; step < ARRANGEMENT_ZOOM_LEVELS.length; step++) {
      await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    }
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
    expect(rulerContent().style.width).toBe(
      px(arrangementWidth(barsNow(), timeSignature(), ARRANGEMENT_ZOOM_LEVELS[0])),
    );

    for (let step = 0; step < ARRANGEMENT_ZOOM_LEVELS.length; step++) {
      await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    }
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
  });
});

describe('scroll sync', () => {
  /**
   * The whole reason the page keeps one shared time axis. Desynced, it still
   * looks plausible — the ruler simply names the wrong bar — so the wiring is
   * what gets tested, not the appearance.
   */
  it('locks the ruler to the lane area horizontally and the headers vertically', () => {
    seedArrangement();
    render(<ArrangementGrid mode={MODE} />);

    expect(rulerContent().style.transform).toBe('translateX(0px)');
    expect(headerStack().style.transform).toBe('translateY(0px)');

    scrollTo(480, 40);

    expect(rulerContent().style.transform).toBe('translateX(-480px)');
    expect(headerStack().style.transform).toBe('translateY(-40px)');

    // Axes crossed is the failure this catches: a vertical-only scroll must not
    // move the ruler, and a horizontal-only one must not move the headers.
    scrollTo(0, 90);

    expect(rulerContent().style.transform).toBe('translateX(0px)');
    expect(headerStack().style.transform).toBe('translateY(-90px)');
  });

  it('keeps the leftmost visible tick fixed across a zoom', async () => {
    seedArrangement();
    render(<ArrangementGrid mode={MODE} />);
    scrollTo(960);

    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));

    const zoomedIn = ARRANGEMENT_ZOOM_LEVELS[DEFAULT_ARRANGEMENT_ZOOM_INDEX + 1];
    const anchored = zoomAnchoredScrollLeft(960, PX_PER_BEAT, zoomedIn);
    // Both halves matter: the view is moved (the scroller is told where to go)
    // and the ruler goes with it.
    expect(scroller().scrollLeft).toBe(anchored);
    expect(rulerContent().style.transform).toBe(`translateX(${-anchored}px)`);
    // The tick under the left edge is the same one it was before the zoom.
    expect(anchored / zoomedIn).toBeCloseTo(960 / PX_PER_BEAT, 9);

    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));

    expect(scroller().scrollLeft).toBe(960);
    expect(rulerContent().style.transform).toBe('translateX(-960px)');
  });

  it('writes nothing back onto a scroller the user is driving', () => {
    seedArrangement();
    render(<ArrangementGrid mode={MODE} />);
    const stub = stubScroller();

    stub.userScrollTo(480);

    // The element is the source of truth. A component that mirrored the offset
    // and pushed it back would write here — and would push a STALE offset,
    // because a fast scroll moves on between the event and the commit. That is
    // the rubber-banding `Timeline.tsx` already documents having fought.
    expect(stub.writes).toEqual([]);
    expect(rulerContent().style.transform).toBe('translateX(-480px)');
  });

  it('follows the element, not its own arithmetic, when a zoom-out is clamped', async () => {
    seedArrangement();
    render(<ArrangementGrid mode={MODE} />);

    const stub = stubScroller();
    stub.userScrollTo(10_000);
    const zoomedOut = ARRANGEMENT_ZOOM_LEVELS[DEFAULT_ARRANGEMENT_ZOOM_INDEX - 1];
    const wanted = zoomAnchoredScrollLeft(10_000, PX_PER_BEAT, zoomedOut);
    // The narrower content cannot be scrolled as far as the anchor asks for.
    // Scaling the offset by the zoom ratio is not enough on its own: the content
    // width shrinks by that ratio, the viewport does not, so the reachable
    // maximum falls further than the offset does. At the right-hand end of a
    // long arrangement, zooming out always overshoots.
    const clamped = Math.floor(wanted) - 100;
    stub.setMax(clamped);

    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));

    // It asked for the anchored offset…
    expect(stub.writes).toContain(wanted);
    // …the browser refused it, and the ruler is where the LANES ended up. Left
    // translated to what was asked for, the ruler would name a bar 100 px from
    // the one under it — permanently, because a refused write fires no scroll
    // event to correct itself with.
    expect(scroller().scrollLeft).toBe(clamped);
    expect(rulerContent().style.transform).toBe(`translateX(${-clamped}px)`);
  });
});

describe('reaching the lanes without a pointer', () => {
  it('puts the lane area in the tab order, named', () => {
    seedArrangement();
    render(<ArrangementGrid mode={MODE} />);

    // Nothing inside a lane is focusable in this ticket — blocks are inert by
    // design (CP-06 owns every gesture) — so without this the arrangement past
    // the fold is unreachable for a keyboard-only user. jsdom refuses focus() on
    // an element that is not focusable, which is what makes this assertion real.
    const lanes = screen.getByRole('group', { name: 'Arrangement lanes' });
    expect(lanes).toBe(scroller());
    lanes.focus();
    expect(lanes).toHaveFocus();
  });

  it('takes focus when the lane area is pressed', async () => {
    const user = userEvent.setup();
    seedArrangement();
    render(<ArrangementGrid mode={MODE} />);

    // The lane handler calls `preventDefault` to stop the browser selecting
    // block labels the drag passes over — which also suppresses the focus the
    // press would have moved. Without putting it back by hand, clicking the
    // arrangement leaves focus wherever it was and the view cannot then be
    // scrolled by keyboard.
    await user.pointer({ target: screen.getByTestId('arrangement-lanes'), keys: '[MouseLeft]' });
    expect(scroller()).toHaveFocus();
  });
});

describe('track selection', () => {
  it('round-trips a header press through the seam', async () => {
    seedArrangement();
    const names = tracksNow().map((track) => track.name);
    const ids = tracksNow().map((track) => track.id);
    render(<ArrangementGrid mode={MODE} />);

    const header = (name: string) =>
      screen.getByRole('button', { name: `Select track ${name}` });
    expect(header(names[1])).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(header(names[1]));

    // Through the seam, not into component state: everything else that cares
    // about the focused track reads it from there.
    expect(getSelectedTrackId()).toBe(ids[1]);
    expect(header(names[1])).toHaveAttribute('aria-pressed', 'true');
    expect(header(names[0])).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(header(names[2]));

    expect(getSelectedTrackId()).toBe(ids[2]);
    expect(header(names[1])).toHaveAttribute('aria-pressed', 'false');
  });

  it('reflects a selection made anywhere else', () => {
    seedArrangement();
    const [track] = tracksNow();
    render(<ArrangementGrid mode={MODE} />);

    act(() => selectTrack(track.id));

    expect(
      screen.getByRole('button', { name: `Select track ${track.name}` }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  // CP-07 made these live. What they DO — solo precedence, the track cap, the
  // reorder, the two confirmations — is `tests/TrackManagement.test.tsx`; all
  // that is checked here is that the grid mounts a real control per track
  // rather than the placeholder it used to draw, which is this file's business
  // because the header stack is what it renders.
  it('renders a mix control per header', () => {
    seedArrangement();
    const [track] = tracksNow();
    render(<ArrangementGrid mode={MODE} />);

    const header = document.querySelector<HTMLElement>(`[data-track-header="${track.id}"]`);
    if (!header) throw new Error('no header rendered');
    expect(within(header).getByRole('button', { name: `Mute ${track.name}` })).toBeEnabled();
    expect(within(header).getByRole('button', { name: `Solo ${track.name}` })).toBeEnabled();
    expect(
      within(header).getByRole('slider', { name: `Volume for ${track.name} in decibels` }),
    ).toBeEnabled();
  });
});

describe('empty states', () => {
  it('renders a usable grid for a composition with one empty track', () => {
    openBlankComposition('Song');
    render(<ArrangementGrid mode={MODE} />);

    // A grid, not a blank box: a lane to drop into, a header, and a ruler that
    // spans the minimum span rather than zero bars.
    expect(laneEls()).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /^Select track / })).toHaveLength(1);
    expect(barsNow()).toBe(8);
    expect(rulerContent().querySelectorAll('[data-ruler-label]').length).toBeGreaterThan(0);
    expect(rulerContent().style.width).toBe(
      px(arrangementWidth(8, timeSignature(), PX_PER_BEAT)),
    );
    const hint = screen.getByText(/nothing placed yet/i);
    expect(hint).toBeInTheDocument();
    // Outside the scrolled content: the one message telling a user what to do
    // next must not scroll off the moment they look around the empty grid.
    expect(scroller().contains(hint)).toBe(false);
  });

  it('drops the empty-arrangement hint once something is placed', () => {
    seedArrangement();
    render(<ArrangementGrid mode={MODE} />);

    expect(screen.queryByText(/nothing placed yet/i)).not.toBeInTheDocument();
  });

  it('says so, rather than rendering an empty grid, when no composition is open', () => {
    render(<ArrangementGrid mode={MODE} />);

    expect(screen.getByText(/no composition open/i)).toBeInTheDocument();
    expect(screen.queryByTestId('arrangement-lanes-scroller')).not.toBeInTheDocument();
  });

  it('offers a way out of the empty state', async () => {
    // CP-17 made this state reachable and STABLE — `ensureComposition` no longer
    // creates one on arrival, and a delete leaves you here. Without a way out it
    // is a dead end, which is the only reason the auto-create existed.
    const user = userEvent.setup();
    render(<ArrangementGrid mode={MODE} />);

    await user.click(screen.getByRole('button', { name: 'New composition' }));

    expect(usePatternsStore.getState().library.compositions).toHaveLength(1);
    expect(usePatternsStore.getState().editingCompositionId).not.toBeNull();
    expect(await screen.findByTestId('arrangement-lanes-scroller')).toBeInTheDocument();
    expect(screen.queryByText(/no composition open/i)).not.toBeInTheDocument();
  });

  it('says why when the library refuses to create one', async () => {
    const user = userEvent.setup();
    const real = usePatternsStore.getState().createComposition;
    usePatternsStore.setState({ createComposition: () => '' });
    try {
      render(<ArrangementGrid mode={MODE} />);

      await user.click(screen.getByRole('button', { name: 'New composition' }));

      expect(screen.getByRole('alert')).toHaveTextContent(/refused/i);
    } finally {
      usePatternsStore.setState({ createComposition: real });
    }
  });
});

describe('on the composition page', () => {
  it('replaces the page placeholder with the grid', async () => {
    const patternId = seedPattern('Riff');
    // Seeded rather than left to the page: CP-17 stopped `ensureComposition`
    // creating one, so mounting an empty library lands on the empty state
    // (asserted just above). What this test is about is that an ADOPTED
    // composition fills the tray with the grid.
    openBlankComposition('Song');
    usePatternsStore.setState({ editingCompositionId: null });
    render(<CompositionPage mode={MODE} onModeChange={() => {}} />);

    expect(await screen.findByTestId('arrangement-lanes-scroller')).toBeInTheDocument();
    expect(laneEls().length).toBeGreaterThan(0);

    act(() => {
      place(patternId, getTracks()[0].id, 4 * PPQ);
    });

    const placement = placementsNow()[0];
    expect(blockEl(placement.id)).toHaveStyle({
      left: px(
        placementRect(
          placement,
          PX_PER_BEAT,
          0,
          laneRects(tracksNow(), MODE)[0].height,
        ).left,
      ),
    });
    // Sanity on the fixture itself: a block at bar 2 has to be a bar in.
    expect(placement.startTick).toBe(ticksPerBar(timeSignature()));
  });
});
