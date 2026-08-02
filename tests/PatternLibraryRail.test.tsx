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
  ensureComposition,
  getTracks,
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
    ensureComposition();
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
    ensureComposition();
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
    ensureComposition();
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
    ensureComposition();
    render(<PatternLibraryRail />);
    expect(rows()).toHaveLength(0);
    expect(screen.getByText(/No patterns yet/i)).toBeInTheDocument();
  });

  it('offers no authoring controls — read and drag only', () => {
    ensureComposition();
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
    ensureComposition();
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
    ensureComposition();
    seedPattern('Riff', 4);
    render(<PatternLibraryRail />);

    await user.click(rowFor('Riff'));
    await user.click(rowFor('Riff'));

    expect(getTracks()[0].placements.map((p) => p.startTick)).toEqual([0, 4 * PPQ]);
  });

  it('names the track a press will land on', () => {
    ensureComposition();
    seedPattern('Riff');
    addTrack('Rhythm');
    selectTrack(getTracks()[1].id);
    render(<PatternLibraryRail />);

    expect(screen.getByText(/press to append to Rhythm/i)).toBeInTheDocument();
  });

  it('refuses an instrument mismatch out loud, and places nothing', async () => {
    const user = userEvent.setup();
    ensureComposition();
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
    ensureComposition();
    seedPattern('Walkline', 4, 'bass');
    setTrackInstrument(getTracks()[0].id, 'bass');
    render(<PatternLibraryRail />);

    await user.click(rowFor('Walkline'));

    expect(getTracks()[0].placements).toHaveLength(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('hands a press over to the grid as a drag, without placing anything itself', async () => {
    const user = userEvent.setup();
    ensureComposition();
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
    render(<CompositionPage mode="pattern" onModeChange={() => {}} />);

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
    render(<CompositionPage mode="pattern" onModeChange={() => {}} />);
    const twoBars = 2 * ticksPerBar(TS);

    await user.pointer([
      { target: rowFor('Riff'), keys: '[MouseLeft>]', coords: { clientX: 0, clientY: 0 } },
      { coords: { clientX: tickToPx(twoBars, PX), clientY: 10 } },
      { keys: '[/MouseLeft]' },
    ]);

    expect(getTracks()[0].placements).toHaveLength(1);
    expect(getTracks()[0].placements[0].startTick).toBe(twoBars);
  });

  it('is replaced by a placeholder in the modes that own their own rail', () => {
    seedPattern('Riff');
    for (const mode of ['edit', 'voice'] as const) {
      const view = render(<CompositionPage mode={mode} onModeChange={() => {}} />);
      expect(screen.queryByRole('button', { name: 'Place pattern Riff' })).not.toBeInTheDocument();
      expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeInTheDocument();
      view.unmount();
    }
  });
});
