import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PATTERNS_STATE,
  PPQ,
  ticksPerBar,
  usePatternsStore,
  type PatternTimeSignature,
} from '@fretwork/lib';
import { PatternLibraryRail } from '../src/composition/PatternLibraryRail';
import { CompositionPage } from '../src/composition/CompositionPage';
import {
  ARRANGEMENT_ZOOM_LEVELS,
  DEFAULT_ARRANGEMENT_ZOOM_INDEX,
  barsSpanned,
  tickToPx,
} from '../src/composition/arrangementMath';
import {
  addTrack,
  clearHistory,
  getSelectedTrackId,
  getTracks,
  openBlankComposition,
  selectPlacements,
  selectTrack,
  setTrackInstrument,
  undo,
} from '../src/composition/compositionService';
import {
  getEditingPattern,
  openBlankPattern,
  setEditingPatternInstrument,
  stampNote,
} from '../src/patterns/patternService';

/**
 * The pattern library rail (CP-05).
 *
 * Read and drag only — there is deliberately no create, rename, delete or
 * folder control to test for, because authoring stays on the pattern page. What
 * is asserted here is what the rail is FOR: that the store's patterns appear,
 * that the length shown is derived rather than remembered, that a press reaches
 * `addPlacement` through the seam, and that a refusal is stated out loud.
 *
 * Dragging itself belongs to `ArrangementGestures.test.tsx` — it is the grid's
 * geometry that decides where a drop lands, and jsdom has none. What this file
 * checks about the drag is only that the rail hands the press over.
 */

const TS: PatternTimeSignature = { numerator: 4, denominator: 4 };
const PX = ARRANGEMENT_ZOOM_LEVELS[DEFAULT_ARRANGEMENT_ZOOM_INDEX];

beforeEach(() => {
  sessionStorage.clear();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  selectPlacements([]);
  selectTrack(null);
  clearHistory();
});

/** A library pattern `beats` long — length comes from its content, which is why
 *  the note has to be stamped rather than a duration set. */
function seedPattern(name: string, beats = 4, instrumentId?: 'guitar' | 'bass'): string {
  openBlankPattern(name);
  if (instrumentId) setEditingPatternInstrument(instrumentId);
  stampNote({ stringIndex: 0, fret: 3, tick: 0, durationTicks: beats * PPQ });
  const pattern = getEditingPattern();
  if (!pattern) throw new Error('pattern seam did not open a pattern');
  return pattern.id;
}

const rows = () => screen.queryAllByRole('button', { name: /^Place pattern / });
const rowFor = (name: string) => screen.getByRole('button', { name: `Place pattern ${name}` });

describe('what the rail lists', () => {
  it('shows one row per library pattern, with its name, instrument and length in bars', () => {
    openBlankComposition('Song');
    seedPattern('Riff', 4);
    seedPattern('Verse', 16);
    seedPattern('Walkline', 8, 'bass');
    render(<PatternLibraryRail />);

    expect(rows()).toHaveLength(3);
    expect(within(rowFor('Riff')).getByText('1 bar')).toBeInTheDocument();
    expect(within(rowFor('Verse')).getByText('4 bars')).toBeInTheDocument();
    expect(within(rowFor('Walkline')).getByText('bass')).toBeInTheDocument();
    expect(within(rowFor('Riff')).getByText('guitar')).toBeInTheDocument();
  });

  it('derives the bar count rather than remembering one — a longer pattern re-reads longer', () => {
    openBlankComposition('Song');
    seedPattern('Riff', 4);
    const view = render(<PatternLibraryRail />);
    expect(within(rowFor('Riff')).getByText('1 bar')).toBeInTheDocument();

    // Pattern length auto-fits to content on every edit, so stamping past the
    // end IS how a pattern gets longer. A stored bar count would still say 1.
    act(() => {
      stampNote({ stringIndex: 1, fret: 0, tick: 8 * PPQ, durationTicks: 4 * PPQ });
    });
    view.rerender(<PatternLibraryRail />);

    const pattern = getEditingPattern();
    if (!pattern) throw new Error('no pattern');
    // Re-derived through the same function the component calls, so what this
    // pins is that the row RE-READS rather than caches — not the value, which
    // the hard-coded `1 bar` / `4 bars` above own. Don't delete those two on the
    // grounds that this covers them; it does not.
    expect(within(rowFor('Riff')).getByText(`${barsSpanned(pattern.durationTicks, TS)} bars`))
      .toBeInTheDocument();
    expect(pattern.durationTicks).toBeGreaterThan(ticksPerBar(TS));
  });

  it('picks up a pattern created after it mounted, with no reload', () => {
    openBlankComposition('Song');
    seedPattern('Riff');
    render(<PatternLibraryRail />);
    expect(rows()).toHaveLength(1);

    // The rail subscribes to the store through the pattern seam, so a pattern
    // written on the other page arrives here on its own.
    act(() => {
      seedPattern('Chorus');
    });
    expect(rows()).toHaveLength(2);
    expect(rowFor('Chorus')).toBeInTheDocument();
  });

  it('says so when the library is empty rather than showing an empty box', () => {
    openBlankComposition('Song');
    render(<PatternLibraryRail />);
    expect(rows()).toHaveLength(0);
    expect(screen.getByText(/No patterns yet/i)).toBeInTheDocument();
  });

  it('offers no authoring controls — read and drag only', () => {
    openBlankComposition('Song');
    seedPattern('Riff');
    render(<PatternLibraryRail />);

    for (const label of [/new pattern/i, /rename/i, /delete/i, /new folder/i]) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});

describe('placing from the rail', () => {
  it('appends to the focused track through the seam, as one undo step', async () => {
    const user = userEvent.setup();
    openBlankComposition('Song');
    seedPattern('Riff');
    addTrack('Rhythm');
    const trackIds = getTracks().map((t) => t.id);
    selectTrack(trackIds[1]);
    clearHistory();
    render(<PatternLibraryRail />);

    await user.click(rowFor('Riff'));

    expect(getTracks()[1].placements).toHaveLength(1);
    expect(getTracks()[0].placements).toHaveLength(0);

    undo();
    expect(getTracks()[1].placements).toHaveLength(0);
    undo();
    expect(getTracks()[1].placements).toHaveLength(0);
  });

  it('butts each press against the last block rather than stacking them', async () => {
    const user = userEvent.setup();
    openBlankComposition('Song');
    seedPattern('Riff', 4);
    render(<PatternLibraryRail />);

    await user.click(rowFor('Riff'));
    await user.click(rowFor('Riff'));

    expect(getTracks()[0].placements.map((p) => p.startTick)).toEqual([0, 4 * PPQ]);
  });

  it('names the track a press will land on', () => {
    openBlankComposition('Song');
    seedPattern('Riff');
    addTrack('Rhythm');
    selectTrack(getTracks()[1].id);
    render(<PatternLibraryRail />);

    expect(screen.getByText(/press to append to Rhythm/i)).toBeInTheDocument();
  });

  it('refuses an instrument mismatch out loud, and places nothing', async () => {
    const user = userEvent.setup();
    openBlankComposition('Song');
    seedPattern('Walkline', 4, 'bass');
    expect(getTracks()[0].instrumentId).toBe('guitar');
    render(<PatternLibraryRail />);

    await user.click(rowFor('Walkline'));

    // Not a silent no-op: the whole point of the check is that the user is told.
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Walkline/);
    expect(alert).toHaveTextContent(/bass pattern/);
    expect(getTracks()[0].placements).toHaveLength(0);
  });

  it('accepts the same pattern once the track is on its instrument', async () => {
    const user = userEvent.setup();
    openBlankComposition('Song');
    seedPattern('Walkline', 4, 'bass');
    setTrackInstrument(getTracks()[0].id, 'bass');
    render(<PatternLibraryRail />);

    await user.click(rowFor('Walkline'));

    expect(getTracks()[0].placements).toHaveLength(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('hands a press over to the grid as a drag, without placing anything itself', async () => {
    const user = userEvent.setup();
    openBlankComposition('Song');
    seedPattern('Riff');
    const presses: string[] = [];
    render(<PatternLibraryRail onPatternPointerDown={(id) => presses.push(id)} />);

    await user.pointer({
      target: rowFor('Riff'),
      keys: '[MouseLeft>]',
      coords: { clientX: 0, clientY: 0 },
    });

    expect(presses).toHaveLength(1);
    // The drop is the grid's to make: nothing lands until it says where.
    expect(getTracks()[0].placements).toHaveLength(0);
    await user.pointer({ keys: '[/MouseLeft]' });
  });
});

describe('where the rail appears', () => {
  it('is the rail in pattern mode', () => {
    seedPattern('Riff');
    // CP-17 folded the library into a disclosure, and the page's UNCONTROLLED
    // default is everything shut — `App` is what opens Patterns by default. So a
    // test rendering the page directly has to say which sections are open.
    render(
      <CompositionPage openRailSections={['patterns']} />,
    );

    const rail = screen.getByRole('complementary', { name: 'Pattern library' });
    expect(within(rail).getByRole('button', { name: 'Place pattern Riff' })).toBeInTheDocument();
  });

  /**
   * The rail and the grid are siblings, and the drag crosses between them
   * through a ref the grid publishes. jsdom reports every box as 0×0 AT THE
   * ORIGIN, which happens to make the grid's own `toContent` the identity here
   * — so a `clientX` is a lane-content pixel and a `clientY` is a distance down
   * the lane stack, exactly as in the gesture suite. Nothing about the SIZE of
   * anything is being asserted; what is, is that the press reaches the grid at
   * all and that the drop goes through the seam.
   *
   * It also pins the DOUBLE-PLACE hazard, which is not a test artifact: a row
   * is a button, and touch input has implicit pointer capture, so the
   * `pointerup` over a lane is still delivered to the row and the browser
   * fires `click` on it. Placing on both the drop and that click puts the
   * pattern down twice — hence the length assertion below is 1, not 2.
   */
  it('drags from the rail into a lane and places there', async () => {
    const user = userEvent.setup();
    seedPattern('Riff');
    // A lane to drop into. CP-17 stopped the page creating a composition on
    // mount, so without this the drop crosses into an empty state.
    openBlankComposition('Song');
    render(
      <CompositionPage openRailSections={['patterns']} />,
    );
    const twoBars = 2 * ticksPerBar(TS);

    await user.pointer([
      { target: rowFor('Riff'), keys: '[MouseLeft>]', coords: { clientX: 0, clientY: 0 } },
      { coords: { clientX: tickToPx(twoBars, PX), clientY: 10 } },
      { keys: '[/MouseLeft]' },
    ]);

    expect(getTracks()[0].placements).toHaveLength(1);
    expect(getTracks()[0].placements[0].startTick).toBe(twoBars);
  });

  /**
   * ── A DRAG ACROSS A MIXED STACK (§F) ─────────────────────────────────────────
   *
   * "A library drag may target ANY Pattern track — do not select a new track just
   * by dragging over it." Both halves of that were unreachable before
   * COMPS-TRACK-TABS milestone 4: every lane used to be a Pattern lane, and the
   * library was only on screen when they were.
   *
   * The lane tops are read off the rendered lanes rather than recomputed, so this
   * cannot drift with the height rule. jsdom reports every box as 0×0 at the
   * ORIGIN, which makes the grid's `toContent` the identity — a `clientY` is a
   * distance down the lane stack.
   */
  const laneTopOf = (trackId: string): number => {
    let top = 0;
    for (const lane of document.querySelectorAll<HTMLElement>('[data-lane-track]')) {
      if (lane.dataset.laneTrack === trackId) return top;
      top += Number.parseFloat(lane.style.height);
    }
    throw new Error(`no lane for ${trackId}`);
  };

  it('drops onto a Pattern track that is not the selected one, and leaves the selection where it was', async () => {
    const user = userEvent.setup();
    seedPattern('Riff');
    openBlankComposition('Song');
    addTrack('Bass');
    addTrack('Keys');
    const [lead, middle, last] = getTracks();
    const composition = usePatternsStore.getState().library.compositions.at(-1)!;
    // The MIDDLE lane is a rack, so the third Pattern lane does not sit where a
    // uniform stack would put it — the drop has to find it by geometry.
    const views = { [composition.id]: { [middle.id]: 'voice' as const } };
    selectTrack(lead.id);
    render(<CompositionPage views={views} openRailSections={['patterns']} />);
    const twoBars = 2 * ticksPerBar(TS);

    await user.pointer([
      { target: rowFor('Riff'), keys: '[MouseLeft>]', coords: { clientX: 0, clientY: 0 } },
      {
        coords: { clientX: tickToPx(twoBars, PX), clientY: laneTopOf(last.id) + 8 },
      },
      { keys: '[/MouseLeft]' },
    ]);

    const placedOn = getTracks().find((track) => track.id === last.id)!;
    expect(placedOn.placements).toHaveLength(1);
    expect(placedOn.placements[0].startTick).toBe(twoBars);
    // Not on the selected track, and not on the rack's.
    expect(getTracks().find((track) => track.id === lead.id)!.placements).toHaveLength(0);
    expect(getTracks().find((track) => track.id === middle.id)!.placements).toHaveLength(0);
    // ⚠ AND THE SELECTION DID NOT MOVE. Dragging over a lane is not a press on
    // it: only `onLanesPointerDown` activates a track. Drop this and the rail
    // would swap out from under the drag that is still in flight.
    expect(getSelectedTrackId()).toBe(lead.id);
  });

  /**
   * And the state milestone 4 makes reachable in the other direction: the rail
   * falls back to the pattern library with no valid selected track, so the
   * library is on screen over a stack where nothing can take a block. The drag
   * declines — `pointerEnabled` is false — and a decline that says nothing is
   * indistinguishable from a broken library.
   */
  it('says why, rather than doing nothing, when no lane is on Pattern', async () => {
    const user = userEvent.setup();
    seedPattern('Riff');
    openBlankComposition('Song');
    addTrack('Bass');
    const composition = usePatternsStore.getState().library.compositions.at(-1)!;
    const views = {
      [composition.id]: Object.fromEntries(
        getTracks().map((track) => [track.id, 'edit' as const]),
      ),
    };
    render(<CompositionPage views={views} openRailSections={['patterns']} />);
    // The fallback is what put the library here: nothing is selected.
    expect(screen.getByRole('complementary', { name: 'Pattern library' })).toBeInTheDocument();

    await user.pointer([
      { target: rowFor('Riff'), keys: '[MouseLeft>]', coords: { clientX: 0, clientY: 0 } },
      { coords: { clientX: 200, clientY: 8 } },
      { keys: '[/MouseLeft]' },
    ]);

    expect(screen.getByRole('alert', { name: 'Track message' })).toHaveTextContent(
      'Put a track in Pattern view to place a block.',
    );
    expect(getTracks().every((track) => track.placements.length === 0)).toBe(true);
  });

  it('is replaced when the SELECTED track is in a view that owns its own rail', () => {
    seedPattern('Riff');
    // COMPS-TRACK-TABS milestone 4: the rail follows the selected track's view,
    // so putting a rail on screen is now "select a track and set its view".
    // Each rail names itself for what it holds — CP-15 gave the voice list its
    // own name, so 'Inspector' is no longer the name for both.
    const railName = { edit: 'Inspector', voice: 'Voices' } as const;
    for (const view of ['edit', 'voice'] as const) {
      openBlankComposition('Song');
      const track = getTracks()[0];
      selectTrack(track.id);
      const composition = usePatternsStore.getState().library.compositions.at(-1)!;
      const rendered = render(
        <CompositionPage views={{ [composition.id]: { [track.id]: view } }} />,
      );
      expect(screen.queryByRole('button', { name: 'Place pattern Riff' })).not.toBeInTheDocument();
      expect(screen.getByRole('complementary', { name: railName[view] })).toBeInTheDocument();
      rendered.unmount();
    }
  });
});
