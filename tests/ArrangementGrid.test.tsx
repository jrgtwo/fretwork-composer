import { useState } from 'react';
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
  laneHeightResolver,
  laneRects,
  lanesHeight,
  placementRect,
  placementRepeatRects,
  rulerMarks,
  setTrackView,
  viewOf,
  zoomAnchoredScrollLeft,
  type ArrangementMode,
  type CompositionTrackViews,
} from '../src/composition/arrangementMath';
import {
  addPlacement,
  addTrack,
  clearHistory,
  getEditingComposition,
  getSelectedPlacementIds,
  getSelectedTrackId,
  getTracks,
  openBlankComposition,
  selectPlacements,
  selectTrack,
  trackInstrumentId,
} from '../src/composition/compositionService';
import { getEditingPattern, openBlankPattern, stampNote } from '../src/patterns/patternService';

/**
 * Every track of the open composition in ONE view — the uniform stack this suite
 * assumed back when the page had a single global mode (COMPS-TRACK-TABS
 * milestone 4 made the view per track).
 *
 * Built from the LIVE composition at the moment it is called, so it goes in the
 * render call after the fixtures are up. Tracks added afterwards are not in it,
 * and that is the real rule rather than a limitation of the helper: a new track
 * defaults to Pattern (§3).
 */
const viewsOf = (view: ArrangementMode): CompositionTrackViews => {
  const composition = getEditingComposition();
  if (!composition || view === 'pattern') return {};
  return {
    [composition.id]: Object.fromEntries(
      composition.tracks.map((track) => [track.id, view] as const),
    ),
  };
};


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

/**
 * The lane stack this component is expected to draw for one global mode.
 *
 * Built through `laneHeightResolver` with the same three inputs the component
 * hands it, rather than through a table of per-view heights: there is no such
 * table any more (a lane is `max(header, content)`), and an edit lane is sized
 * by its OWN track's string count. Mirroring the resolver means a per-track
 * height regression fails here instead of waiting for someone to seed a bass.
 */
const modeLanes = (tracks: readonly Track[], mode: ArrangementMode) =>
  laneRects(
    tracks,
    laneHeightResolver({
      viewOf: () => mode,
      instrumentOf: (trackId) => {
        const track = tracks.find((candidate) => candidate.id === trackId);
        return track ? trackInstrumentId(track) : '';
      },
      // `tests/setup.ts` installs a `ResizeObserver` stub whose `observe`
      // never fires, and every box in jsdom is 0×0, so no rack is ever measured
      // in this file — a voice lane falls to the header's height, which is
      // exactly what the component computes here. `tests/VoiceMode.test.tsx`
      // swaps in a FIRING stub where the measured path itself is pinned.
      voiceRackHeight: () => 0,
    }),
  );
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
/** The song-sized content div inside the scroller. Addressed by testid rather
 *  than as the scroller's first child: that slot belongs to the zero-height
 *  voice layer, which must stay first for its origin to be content y=0
 *  (`ArrangementGrid`). */
const lanesContent = () => screen.getByTestId('arrangement-lanes-content');
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
    render(<ArrangementGrid />);

    const expected = modeLanes(tracksNow(), MODE);
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
    expect(lanesContent()).toHaveStyle({ height: px(lanesHeight(expected)) });
  });

  it('marks every lane with the attribute the lane styling keys off', () => {
    seedArrangement();
    render(<ArrangementGrid />);

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
    render(<ArrangementGrid views={viewsOf('edit')} />);

    const expected = modeLanes(tracksNow(), 'edit');
    // The modes genuinely differ, or this assertion would hold for a component
    // that ignored the prop entirely.
    expect(expected[0].height).not.toBe(modeLanes(tracksNow(), 'pattern')[0].height);
    expect(laneEls()[0].style.height).toBe(px(expected[0].height));
  });

  it('renders every track up to the composition cap', () => {
    openBlankComposition('Song');
    while (getTracks().length < MAX_COMPOSITION_TRACKS) addTrack();
    render(<ArrangementGrid />);

    expect(laneEls()).toHaveLength(MAX_COMPOSITION_TRACKS);
    expect(screen.getAllByRole('button', { name: /^Select track / })).toHaveLength(
      MAX_COMPOSITION_TRACKS,
    );
  });
});

describe('placement blocks', () => {
  it('positions every block exactly where placementRect puts it', () => {
    seedArrangement();
    render(<ArrangementGrid />);

    const lanes = modeLanes(tracksNow(), MODE);
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
    render(<ArrangementGrid />);
    const placement = tracksNow()[0].placements[1];
    const lanes = modeLanes(tracksNow(), MODE);

    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));

    const zoomed = ARRANGEMENT_ZOOM_LEVELS[DEFAULT_ARRANGEMENT_ZOOM_INDEX + 1];
    expect(blockEl(placement.id)).toHaveStyle({
      left: px(placementRect(placement, zoomed, 0, lanes[0].height).left),
      width: px(placementRect(placement, zoomed, 0, lanes[0].height).width),
    });
  });

  it('draws no repeat division on an ordinary unrepeated placement', () => {
    seedArrangement();
    render(<ArrangementGrid />);

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

    render(<ArrangementGrid />);

    const placement = placementsNow()[0];
    expect(placement.repeat).toBe(3);
    const laneHeight = modeLanes(tracksNow(), MODE)[0].height;
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
    render(<ArrangementGrid />);

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
    render(<ArrangementGrid />);
    act(() => selectPlacements([first.id]));
    return first.id;
  }

  const transposeOf = (id: string) =>
    placementsNow().find((p) => p.id === id)?.transposeSemitones;

  it('appears only with a selection, and counts it', () => {
    seedArrangement();
    render(<ArrangementGrid />);
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
    render(<ArrangementGrid />);
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
    render(<ArrangementGrid />);

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
    render(<ArrangementGrid />);

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
    render(<ArrangementGrid />);

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
    render(<ArrangementGrid />);

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
    render(<ArrangementGrid />);

    for (let step = 0; step < 3; step++) {
      const zoom = ARRANGEMENT_ZOOM_LEVELS[DEFAULT_ARRANGEMENT_ZOOM_INDEX - step];
      const width = px(arrangementWidth(barsNow(), timeSignature(), zoom));
      expect(rulerContent().style.width).toBe(width);
      expect(lanesContent()).toHaveStyle({ width });
      await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    }
  });

  it('thins its labels out as the zoom gets too coarse to number every bar', async () => {
    seedArrangement();
    render(<ArrangementGrid />);
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
    render(<ArrangementGrid />);

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
    render(<ArrangementGrid />);

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
    render(<ArrangementGrid />);
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
    render(<ArrangementGrid />);
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
    render(<ArrangementGrid />);

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
    render(<ArrangementGrid />);

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
    render(<ArrangementGrid />);

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
    render(<ArrangementGrid />);

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
    render(<ArrangementGrid />);

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
    render(<ArrangementGrid />);

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
    render(<ArrangementGrid />);

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
    render(<ArrangementGrid />);

    expect(screen.queryByText(/nothing placed yet/i)).not.toBeInTheDocument();
  });

  it('keeps the time axis for a trackless composition, whatever the map holds', () => {
    // Not reachable through `compositionService` — the seam refuses to delete the
    // last track — so it is forced here the way `tests/CommandCatalog.test.ts`
    // forces it. A composition made elsewhere can carry zero tracks, and
    // `timed`'s "does any lane want an axis" question has no lane to ask: `some`
    // on nothing is `false`, which is the WRONG answer. The fallback is the
    // composition's own default view, and that default is Pattern — so a
    // trackless composition is timed.
    //
    // ⚠ This is the behaviour COMPS-TRACK-TABS milestone 4 CHANGED. Under the
    // old global mode the fallback was `mode !== 'voice'`, so the same empty
    // stack hid its ruler in voice mode; there is no page mode to ask any more,
    // and a map keyed by track id says nothing about a composition with no
    // tracks in it.
    openBlankComposition('Song');
    usePatternsStore.setState((state) => ({
      library: {
        ...state.library,
        compositions: state.library.compositions.map((composition) => ({
          ...composition,
          tracks: [],
        })),
      },
    }));
    const composition = getEditingComposition()!;

    // A map that puts a track id — one this composition does not have — on
    // voice, to prove the answer comes from the LANES and not from the map.
    render(
      <ArrangementGrid views={{ [composition.id]: { 'gone-track': 'voice' } }} />,
    );
    expect(screen.getByTestId('arrangement-ruler')).toBeInTheDocument();
    expect(screen.getByText(/nothing placed yet/i)).toBeInTheDocument();
  });

  it('says so, rather than rendering an empty grid, when no composition is open', () => {
    render(<ArrangementGrid />);

    expect(screen.getByText(/no composition open/i)).toBeInTheDocument();
    expect(screen.queryByTestId('arrangement-lanes-scroller')).not.toBeInTheDocument();
  });

  it('offers a way out of the empty state', async () => {
    // CP-17 made this state reachable and STABLE — `ensureComposition` no longer
    // creates one on arrival, and a delete leaves you here. Without a way out it
    // is a dead end, which is the only reason the auto-create existed.
    const user = userEvent.setup();
    render(<ArrangementGrid />);

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
      render(<ArrangementGrid />);

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
    render(<CompositionPage />);

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
          modeLanes(tracksNow(), MODE)[0].height,
        ).left,
      ),
    });
    // Sanity on the fixture itself: a block at bar 2 has to be a bar in.
    expect(placement.startTick).toBe(ticksPerBar(timeSignature()));
  });
});

/**
 * ── A MIXED STACK (COMPS-TRACK-TABS milestone 4, acceptance 1) ────────────────
 *
 * Three tracks in three different views AT ONCE — the state the page could not
 * express at all while a single global mode decided every lane, and the state
 * every per-lane branch in `ArrangementGrid` was written for.
 *
 * ⚠ THE FAILURE THIS BLOCK IS FOR is the index pairing §5 names: `lanes.map((lane,
 * index) => tracks[index])` is correct only while the two arrays stay the same
 * length and order, and it draws the wrong header on the wrong track while
 * looking entirely plausible. Every assertion below pairs a lane or a header
 * with a track BY ID for that reason.
 */
describe('three views at once', () => {
  /** Guitar on Pattern, Rhythm on Edit, Lead on Voice — in that order, so a
   *  Voice lane sits at the END and an Edit one in the MIDDLE. */
  const mixed = () => {
    const { patternId, trackIds } = seedArrangement();
    // Something for the middle lane to edit: `seedArrangement` leaves the third
    // track empty on purpose, and an Edit lane with no block draws no surface.
    place(patternId, trackIds[1], 0);
    const composition = getEditingComposition()!;
    const views: CompositionTrackViews = {
      [composition.id]: { [trackIds[1]]: 'edit', [trackIds[2]]: 'voice' },
    };
    return { patternId, trackIds, views };
  };
  const laneFor = (trackId: string) =>
    document.querySelector<HTMLElement>(`[data-lane-track="${trackId}"]`)!;
  const headerFor = (trackId: string) =>
    document.querySelector<HTMLElement>(`[data-track-header="${trackId}"]`)!;

  it('draws each lane its own view, and each header beside its own track', () => {
    const { trackIds, views } = mixed();
    render(<ArrangementGrid views={views} />);
    const tracks = tracksNow();

    // Pattern: blocks. Edit: note surfaces, no blocks. Voice: neither — its rack
    // is in the layer above and what is left here is a spacer.
    expect(laneFor(trackIds[0]).querySelectorAll('[data-placement]').length).toBeGreaterThan(0);
    expect(laneFor(trackIds[0]).querySelectorAll('[data-edit-placement]')).toHaveLength(0);
    expect(laneFor(trackIds[1]).querySelectorAll('[data-edit-placement]').length).toBeGreaterThan(0);
    expect(laneFor(trackIds[1]).querySelectorAll('[data-placement]')).toHaveLength(0);
    expect(laneFor(trackIds[2]).children).toHaveLength(0);
    expect(
      document.querySelector(`[data-voice-lane-track="${trackIds[2]}"]`),
    ).not.toBeNull();
    // One rack, on the track that asked for one — not three, and not the first.
    expect(document.querySelectorAll('[data-voice-rack]')).toHaveLength(1);
    expect(
      document.querySelector('[data-voice-rack]')?.getAttribute('data-voice-rack'),
    ).toBe(trackIds[2]);

    // ⚠ THE PAIRING. Each header carries its own track's name and its own
    // track's view — a header drawn from `tracks[index]` against a filtered lane
    // list is exactly what this catches.
    for (const track of tracks) {
      const header = within(headerFor(track.id));
      expect(header.getByRole('button', { name: `Select track ${track.name}` })).toBeInTheDocument();
    }
    expect(
      within(headerFor(trackIds[0])).getByRole('button', {
        name: `Pattern view, ${tracks[0].name}`,
      }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      within(headerFor(trackIds[1])).getByRole('button', {
        name: `Edit view, ${tracks[1].name}`,
      }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      within(headerFor(trackIds[2])).getByRole('button', {
        name: `Voice view, ${tracks[2].name}`,
      }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('gives every lane the height its own view earns', () => {
    const { trackIds, views } = mixed();
    render(<ArrangementGrid views={views} />);
    const composition = getEditingComposition()!;
    // The component's own resolver, fed the same map — a per-lane height
    // regression fails here rather than waiting for an eye.
    const expected = laneRects(
      tracksNow(),
      laneHeightResolver({
        viewOf: (trackId) => viewOf(views, composition.id, trackId),
        instrumentOf: (trackId) =>
          trackInstrumentId(tracksNow().find((track) => track.id === trackId)!),
        voiceRackHeight: () => 0,
      }),
    );
    for (const [index, trackId] of trackIds.entries()) {
      expect(laneFor(trackId).style.height).toBe(px(expected[index].height));
      expect(headerFor(trackId).style.height).toBe(px(expected[index].height));
    }
    // The stack is not uniform — otherwise the assertion above would hold for
    // any height rule at all.
    expect(new Set(expected.map((lane) => lane.height)).size).toBeGreaterThan(1);
  });

  /**
   * The grid with an OWNER, which is how the app runs it: `App` holds the map
   * and hands back the updated one. A map passed with no handler is a fixture
   * the caller does not want changed (see the `views` prop), so a test that
   * presses a view button has to own it the way the app does.
   */
  function OwnedGrid({ initial }: { initial: CompositionTrackViews }) {
    const [views, setViews] = useState(initial);
    return (
      <ArrangementGrid
        views={views}
        onTrackViewChange={(compositionId, trackId, view) =>
          setViews((was) => setTrackView(was, compositionId, trackId, view))
        }
      />
    );
  }

  it('changes ONE lane and selects its track, leaving the other two alone', async () => {
    const user = userEvent.setup();
    const { trackIds, views } = mixed();
    render(<OwnedGrid initial={views} />);
    const tracks = tracksNow();

    await user.click(
      within(headerFor(trackIds[0])).getByRole('button', {
        name: `Voice view, ${tracks[0].name}`,
      }),
    );

    expect(document.querySelectorAll('[data-voice-rack]')).toHaveLength(2);
    // The other two lanes did not move.
    expect(laneFor(trackIds[1]).querySelectorAll('[data-edit-placement]').length).toBeGreaterThan(0);
    expect(
      within(headerFor(trackIds[2])).getByRole('button', {
        name: `Voice view, ${tracks[2].name}`,
      }),
    ).toHaveAttribute('aria-pressed', 'true');
    // …and the press SELECTED the track it changed (§2).
    expect(getSelectedTrackId()).toBe(trackIds[0]);
  });

  /**
   * ⚠ ONE POINTER HANDLER, A MIXED STACK UNDER IT (§4, §5).
   *
   * `.lanes` carries the arrangement's pointer handlers whenever SOME lane is a
   * Pattern lane, and every lane in the stack is underneath it — including the
   * Edit lanes, whose note surfaces do not stop propagation. What keeps the two
   * apart is the hit test: the gesture layer filters `geo.lanes` through
   * `isPatternLane` and KEEPS THE ORIGINAL TOPS, so an Edit or Voice row is a
   * GAP that `laneAt` answers null for, and the press returns before it takes
   * focus or suppresses the default.
   *
   * This was unreachable before milestone 4 — the handlers were attached only in
   * pattern mode, where every lane was a Pattern lane.
   */
  it('starts no block gesture from a drag inside an Edit lane', async () => {
    const user = userEvent.setup();
    const { trackIds, views } = mixed();
    render(<ArrangementGrid views={views} />);
    // `addPlacement` selects what it places, so the fixture leaves one standing
    // — captured rather than assumed empty, since what matters is that the drag
    // does not CHANGE it.
    const selectionBefore = getSelectedPlacementIds();
    const onEditTrack = tracksNow()[1].placements[0];
    expect(onEditTrack).toBeDefined();

    // jsdom reports every box as 0×0 at the origin, so a clientY is a distance
    // down the lane stack and a clientX is a lane-content pixel — the same
    // identity the gesture suite relies on. The first lane's height puts this
    // inside the SECOND lane, which is the Edit one, and the x is past both of
    // that track's blocks: EMPTY lane is what a marquee starts from, and a
    // marquee is what this must not produce. (Probe-checked: admitting this row
    // to the hit test makes the rubber band appear and this test fail.)
    const y = modeLanes(tracksNow(), 'pattern')[0].height + 8;
    await user.pointer([
      {
        target: screen.getByTestId('arrangement-lanes'),
        keys: '[MouseLeft>]',
        coords: { clientX: 1500, clientY: y },
      },
      { coords: { clientX: 1740, clientY: y + 12 } },
    ]);

    // No rubber band across a lane the arrangement does not own — this is what
    // the Pattern-only hit test with ORIGINAL TOPS buys: the row is a gap, not a
    // lane one row up.
    expect(screen.queryByTestId('arrangement-marquee')).toBeNull();

    await user.pointer({ keys: '[/MouseLeft]' });
    expect(getSelectedPlacementIds()).toEqual(selectionBefore);
    // And nothing on that track moved either. (`trackIds` is ordered Pattern,
    // Edit, Voice.)
    const after = tracksNow()[1].placements.find(
      (candidate) => candidate.id === onEditTrack.id,
    )!;
    expect(after.startTick).toBe(onEditTrack.startTick);
    expect(trackIds).toHaveLength(3);
  });

  it('still drags blocks on the Pattern lane while another track is in Edit', async () => {
    const user = userEvent.setup();
    const { trackIds, views } = mixed();
    render(<ArrangementGrid views={views} />);
    const placement = tracksNow()[0].placements[0];
    const laneHeight = modeLanes(tracksNow(), 'pattern')[0].height;

    // A press on the first lane's block, which is a Pattern lane — the pointer
    // surface does not care which track is SELECTED, only that the lane it hit
    // is one it owns.
    await user.pointer([
      {
        target: screen.getByTestId('arrangement-lanes'),
        keys: '[MouseLeft>]',
        coords: { clientX: 4, clientY: laneHeight / 2 },
      },
      { coords: { clientX: 4 + PX_PER_BEAT * 4, clientY: laneHeight / 2 } },
      { keys: '[/MouseLeft]' },
    ]);

    const moved = tracksNow()[0].placements.find((candidate) => candidate.id === placement.id)!;
    expect(moved.startTick).toBeGreaterThan(placement.startTick);
    // …and the press took its own track, as any lane press does.
    expect(getSelectedTrackId()).toBe(trackIds[0]);
  });

  /**
   * THE FIXTURE CONTRACT, pinned so it cannot rot into a half-controlled press.
   *
   * A caller that passes `views` and NO handler owns the map and does not want
   * it written from inside the grid — the local fallback is for a caller that
   * passes neither. So the press does what belongs to the seam (it selects) and
   * nothing that belongs to the map, rather than writing local state nothing
   * reads and re-rendering for it.
   */
  it('leaves a passed-in map alone when there is no handler to report to', async () => {
    const user = userEvent.setup();
    const { trackIds, views } = mixed();
    render(<ArrangementGrid views={views} />);
    const tracks = tracksNow();

    await user.click(
      within(headerFor(trackIds[2])).getByRole('button', {
        name: `Pattern view, ${tracks[2].name}`,
      }),
    );

    // Still the rack the passed map asked for…
    expect(
      within(headerFor(trackIds[2])).getByRole('button', {
        name: `Voice view, ${tracks[2].name}`,
      }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelectorAll('[data-voice-rack]')).toHaveLength(1);
    // …and the selection, which is the seam's and not the map's, DID move.
    expect(getSelectedTrackId()).toBe(trackIds[2]);
  });

  /**
   * ── THE RING AND THE ACTIONS ROW GO TOGETHER ─────────────────────────────────
   *
   * A selection made on a Pattern lane SURVIVES a selection change to a track in
   * another view — `effectiveSelection` filters by LANE, and that lane is still
   * a Pattern lane. What does not survive is the right to act on it: the plan's
   * direct-editing table gives the Voice and Edit rows no placement-selection
   * commands, so the toolbar's Split / ♭ / ♯ / Duplicate / Delete row and the
   * keyboard twins are both gone.
   *
   * ⚠ WHICH LEFT THE BLOCKS DRAWN SELECTED WITH NOTHING ABLE TO TOUCH THEM. This
   * was unreachable under the old global mode — 'voice' meant no Pattern lane
   * was drawn at all — and milestone 4 is what makes a mixed stack put a live
   * ring beside a vanished toolbar. The two are gated on the same value now.
   */
  it('stops drawing the selection ring exactly when the actions that act on it go', async () => {
    const user = userEvent.setup();
    const { trackIds, views } = mixed();
    render(<ArrangementGrid views={views} />);
    const tracks = tracksNow();
    const onPattern = tracks[0].placements[0];
    expect(onPattern).toBeDefined();

    act(() => {
      selectTrack(trackIds[0]);
      selectPlacements([onPattern.id]);
    });
    expect(blockEl(onPattern.id)).toHaveAttribute('data-selected');
    expect(screen.getByRole('button', { name: 'Split at cursor' })).toBeInTheDocument();

    // The VOICE track becomes the selected one. The Pattern lane is untouched —
    // it still draws its blocks — and the selection is still in the store.
    await user.click(screen.getByRole('button', { name: `Select track ${tracks[2].name}` }));

    expect(screen.queryByRole('button', { name: 'Split at cursor' })).toBeNull();
    expect(blockEl(onPattern.id)).not.toHaveAttribute('data-selected');
    expect(getSelectedPlacementIds()).toEqual([onPattern.id]);

    // Back to a Pattern track and both return — nothing was thrown away.
    await user.click(screen.getByRole('button', { name: `Select track ${tracks[0].name}` }));
    expect(blockEl(onPattern.id)).toHaveAttribute('data-selected');
    expect(screen.getByRole('button', { name: 'Split at cursor' })).toBeInTheDocument();
  });

  it('keeps a time axis while any lane has one, and bands it around the voice lane', () => {
    const { trackIds, views } = mixed();
    render(<ArrangementGrid views={views} />);

    // One ruler for the stack — the axis is up unless EVERY lane is a rack.
    expect(screen.getByTestId('arrangement-ruler')).toBeInTheDocument();
    // Two timed lanes, contiguous, so one band of grid lines: the voice lane is
    // last here, which is what makes a single band the right answer.
    const bands = Array.from(
      document.querySelectorAll<HTMLElement>('[data-grid-line]'),
    ).map((line) => line.parentElement);
    expect(new Set(bands).size).toBe(1);
    expect(trackIds).toHaveLength(3);
  });
});
