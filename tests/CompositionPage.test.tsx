import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_PATTERNS_STATE, usePatternsStore } from '@fretwork/lib';
import { CompositionPage } from '../src/composition/CompositionPage';
import {
  addTrack,
  beginJob,
  endJob,
  getEditingComposition,
  getTracks,
  JOB_LOCK_REASON,
  openBlankComposition,
  selectTrack,
} from '../src/composition/compositionService';
import type {
  ArrangementMode,
  CompositionTrackViews,
} from '../src/composition/arrangementMath';

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
 * `CompositionPage` after COMPS-TRACK-TABS milestone 4.
 *
 * ⚠ THERE IS NO MODE BAR AND NO PAGE MODE. Each TRACK carries its own view, the
 * map lives in `App` (this page unmounts on every visit to the pattern page),
 * and the page's one remaining view question is which rail to draw — the
 * SELECTED track's view, with Pattern as the fallback when nothing valid is
 * selected.
 *
 * The map is a controlled prop with local state behind it, the way the rail
 * sections are: a render passing neither half gets working view buttons that
 * simply do not outlive the component. That is what most of this file uses.
 */
beforeEach(() => {
  sessionStorage.clear();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  // Module state on the seam — a leaked job would disable every header's view
  // buttons in every test after the one that left it open. `selectTrack` is the
  // same kind of module state and decides which rail is drawn.
  endJob();
  selectTrack(null);
});

/** A track's view button. Named with the TRACK, because eight headers are on
 *  screen in a full composition and the letter on the button is not a name. */
const viewButton = (label: string, track: string) =>
  screen.getByRole('button', { name: `${label} view, ${track}` });
const railName = () => screen.getByRole('complementary').getAttribute('aria-label');

describe('the rail (CP-17)', () => {
  const railSection = (name: string) =>
    screen.getByRole('button', { name: new RegExp(`^${name}$`, 'i') });

  it('holds three independently foldable sections on a Pattern rail', () => {
    render(
      <CompositionPage openRailSections={['commands', 'patterns', 'compositions']} />,
    );

    for (const name of ['Commands', 'Patterns', 'Compositions']) {
      expect(screen.getByRole('region', { name: `${name} section` })).toBeInTheDocument();
    }
  });

  it('folds one without touching the others', async () => {
    const user = userEvent.setup();
    const onOpenRailSectionsChange = vi.fn();
    render(
      <CompositionPage
        openRailSections={['commands', 'patterns', 'compositions']}
        onOpenRailSectionsChange={onOpenRailSectionsChange}
      />,
    );

    await user.click(railSection('Compositions'));

    // Controlled, like the view map: the page reports the change and `App` owns
    // it, so a fold survives the unmount every visit to the pattern page causes.
    expect(onOpenRailSectionsChange).toHaveBeenCalled();
    const next = onOpenRailSectionsChange.mock.calls[0][0](['commands', 'patterns', 'compositions']);
    expect(next).toEqual(['commands', 'patterns']);
  });

  it('offers neither library when the selected track is not on Pattern', () => {
    openBlankComposition('Song');
    selectTrack(getTracks()[0].id);
    render(
      <CompositionPage
        views={viewsOf('voice')}
        openRailSections={['commands', 'patterns', 'compositions']}
      />,
    );

    expect(screen.getByRole('region', { name: 'Commands section' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Patterns section' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Compositions section' })).not.toBeInTheDocument();
  });

  /** A Voice map with NOTHING SELECTED is still the Pattern rail — the fallback
   *  is about the selection, not about what the stack happens to be showing. It
   *  is the one case a naive "is any track on voice" reading would get wrong. */
  it('keeps the library when the stack is on Voice but nothing is selected', () => {
    openBlankComposition('Song');
    render(
      <CompositionPage views={viewsOf('voice')} openRailSections={['patterns']} />,
    );

    expect(screen.getByRole('region', { name: 'Patterns section' })).toBeInTheDocument();
    expect(railName()).toBe('Pattern library');
  });
});

/**
 * ⚠ THE RAIL-LEVEL HALF OF ACCEPTANCE 13 (COMPS-TRACK-TABS milestone 5).
 *
 * The panel's own suite drives the groups in detail; what this file can say that
 * that one cannot is that the PAGE is what wires the selected track's view into
 * them — and that the wiring reaches only the track group. The Commands section
 * itself is persistent and sits above the swapped region, so a job's progress
 * and its Cancel survive a user going to look at what the agent just built.
 */
describe('the Commands section (milestone 5)', () => {
  const groupNames = () =>
    screen
      .getAllByRole('group')
      .map((group) => group.getAttribute('aria-label'))
      .filter((label): label is string => label !== null);

  it('shows the composition group whatever the selected track is showing', () => {
    openBlankComposition('Song');
    const track = getTracks()[0];
    selectTrack(track.id);
    const { rerender } = render(
      <CompositionPage views={viewsOf('pattern')} openRailSections={['commands']} />,
    );

    const backingTrack = () =>
      screen.queryByRole('button', { name: 'Create a backing track' });
    expect(backingTrack()).toBeInTheDocument();
    expect(groupNames()).toContain(`Track commands — ${track.name}`);

    rerender(<CompositionPage views={viewsOf('voice')} openRailSections={['commands']} />);
    // The row that used to vanish here. The track group followed the view; the
    // composition group did not, because it does not read it.
    expect(backingTrack()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dial in a tone' })).toBeInTheDocument();

    rerender(<CompositionPage views={viewsOf('edit')} openRailSections={['commands']} />);
    expect(backingTrack()).toBeInTheDocument();
    // Edit with nothing open has no track rows, and that gates ITS group alone.
    expect(screen.getByText(/Press a block in this track/)).toBeInTheDocument();
  });

  it('keeps the composition group with no track selected at all', () => {
    openBlankComposition('Song');
    render(<CompositionPage views={viewsOf('voice')} openRailSections={['commands']} />);

    expect(
      screen.getByRole('button', { name: 'Create a backing track' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/No track is selected/)).toBeInTheDocument();
  });

  /**
   * ⚠ ACCEPTANCE 15'S FOLDING CASE, AND IT HOLDS BY A STRUCTURAL PROPERTY THAT
   * NOTHING ELSE PINS: `Section` keeps its body MOUNTED when closed (`hidden`),
   * where `PaneStack` unmounts a folded pane's outright. A job runs for minutes
   * and the user folds the rail to look at what it built; an unmounting section
   * would take the run's progress and its Cancel button with it, leaving the
   * document locked with nothing on screen offering a way out.
   *
   * Asserted on the NODE rather than on its presence: a section that unmounted
   * and remounted would put a second, fresh button in the same place — and a
   * fresh one belongs to a panel that has forgotten the run. No run is needed to
   * show that, which is the point; the panel's own suite owns what Cancel does.
   */
  it('keeps the run’s Cancel mounted across folding the section', async () => {
    openBlankComposition('Song');
    // Uncontrolled, so the disclosure actually folds: with `openRailSections`
    // passed the page defers to its owner and leaves itself open (see the rail
    // sections suite below).
    render(<CompositionPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Commands' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });

    await userEvent.click(screen.getByRole('button', { name: 'Commands' }));

    // Out of the accessibility tree, as a folded disclosure must be: the region
    // carries `hidden`, so a screen reader and the keyboard both skip it.
    expect(screen.getByRole('button', { name: 'Commands' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    // ⚠ AND STILL THE SAME ELEMENT, which is the claim: hidden, not unmounted.
    // A remount would put a fresh button here — one belonging to a panel that
    // has forgotten the run.
    expect(screen.getByRole('button', { name: 'Cancel', hidden: true })).toBe(cancel);

    await userEvent.click(screen.getByRole('button', { name: 'Commands' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBe(cancel);
  });
});

describe('the mode bar is gone (COMPS-TRACK-TABS milestone 4)', () => {
  it('offers no page-wide mode control at all', () => {
    openBlankComposition('Song');
    render(<CompositionPage />);

    // The three buttons were named '<label> mode' and grouped as 'Composition
    // mode'. Nothing may answer to either: a leftover bar is the second
    // authority this milestone exists to delete, and it would look right.
    expect(screen.queryByRole('group', { name: 'Composition mode' })).not.toBeInTheDocument();
    for (const label of ['Pattern', 'Edit', 'Voice']) {
      expect(screen.queryByRole('button', { name: `${label} mode` })).not.toBeInTheDocument();
    }
  });

  it('keeps the transport, which never depended on a view', () => {
    openBlankComposition('Song');
    render(<CompositionPage />);

    // Page-wide and true whatever mix of views the stack is in — the reason it
    // is in the page chrome rather than the grid's toolbar.
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });
});

describe('the rail follows the SELECTED track (§1, §2)', () => {
  /** Three tracks, three views, at once — the state the old page could not
   *  express at all. */
  const threeViews = () => {
    openBlankComposition('Song');
    addTrack('Bass');
    addTrack('Keys');
    const [pattern, edit, voice] = getTracks();
    const composition = getEditingComposition()!;
    return {
      pattern,
      edit,
      voice,
      views: {
        [composition.id]: { [edit.id]: 'edit', [voice.id]: 'voice' },
      } as CompositionTrackViews,
    };
  };

  it('draws the selected track own rail, with the other two unchanged', async () => {
    const user = userEvent.setup();
    const { pattern, edit, voice, views } = threeViews();
    render(<CompositionPage views={views} openRailSections={[]} />);

    // A header press selects, and the rail follows that selection rather than
    // any page-wide state.
    await user.click(screen.getByRole('button', { name: `Select track ${voice.name}` }));
    expect(railName()).toBe('Voices');

    await user.click(screen.getByRole('button', { name: `Select track ${edit.name}` }));
    expect(railName()).toBe('Inspector');

    await user.click(screen.getByRole('button', { name: `Select track ${pattern.name}` }));
    expect(railName()).toBe('Pattern library');

    // The views themselves did not move: selecting a track never changes what it
    // shows (§2).
    expect(viewButton('Voice', voice.name)).toHaveAttribute('aria-pressed', 'true');
    expect(viewButton('Edit', edit.name)).toHaveAttribute('aria-pressed', 'true');
    expect(viewButton('Pattern', pattern.name)).toHaveAttribute('aria-pressed', 'true');
  });

  it('falls back to the Pattern rail with no valid selected track', async () => {
    const user = userEvent.setup();
    const { voice, views } = threeViews();
    render(<CompositionPage views={views} openRailSections={[]} />);

    await user.click(screen.getByRole('button', { name: `Select track ${voice.name}` }));
    expect(railName()).toBe('Voices');

    // Nothing selected — the agent can do this, and so can an undo that retracts
    // the selected track.
    act(() => selectTrack(null));
    expect(railName()).toBe('Pattern library');
  });

  /**
   * ⚠ THE RETAINED ENTRY, seen from the rail. A deleted track KEEPS its view
   * entry for the session (§3, so an undo restoring the id restores the view) —
   * so the rail has to check MEMBERSHIP and not merely read the map, or a
   * selection left pointing at a track that has gone draws a Voice rail for a
   * track the stack no longer has.
   */
  it('checks membership rather than trusting the retained entry', () => {
    const { voice, views } = threeViews();
    // A selection the pruner has not seen — the shape an external write leaves.
    selectTrack(voice.id);
    usePatternsStore.setState((state) => ({
      ...state,
      library: {
        ...state.library,
        compositions: state.library.compositions.map((composition) => ({
          ...composition,
          tracks: composition.tracks.filter((track) => track.id !== voice.id),
        })),
      },
    }));
    render(<CompositionPage views={views} openRailSections={[]} />);

    expect(railName()).toBe('Pattern library');
  });
});

describe('a track view button', () => {
  it('sets that track view and selects it, leaving every other track alone', async () => {
    const user = userEvent.setup();
    openBlankComposition('Song');
    addTrack('Bass');
    const [lead, bass] = getTracks();
    render(<CompositionPage openRailSections={[]} />);

    // Uncontrolled: the page holds the map itself, which is what a render
    // passing neither half of the pair gets.
    await user.click(viewButton('Voice', bass.name));

    expect(viewButton('Voice', bass.name)).toHaveAttribute('aria-pressed', 'true');
    expect(viewButton('Pattern', lead.name)).toHaveAttribute('aria-pressed', 'true');
    // It SELECTED it as well as setting it (§2) — which is why the rail moved.
    expect(railName()).toBe('Voices');
  });

  it('selects its track even when that view is already the active one', async () => {
    const user = userEvent.setup();
    openBlankComposition('Song');
    addTrack('Bass');
    const [lead, bass] = getTracks();
    render(<CompositionPage openRailSections={[]} />);

    selectTrack(lead.id);
    // Bass is already on Pattern — the press changes nothing about its view and
    // must still take the selection (§2).
    await user.click(viewButton('Pattern', bass.name));

    expect(
      screen.getByRole('button', { name: `Select track ${bass.name}` }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  /**
   * AG-07, moved from the mode bar to the buttons that replaced it. A view
   * change can CLOSE an open placement, and a generation job may be inside one —
   * the close would repoint the lib's single pattern pointer out from under it
   * and land the job's next notes in the user's LIBRARY pattern, which
   * cancelling does not restore.
   */
  it('goes dead while a generation job owns the composition', async () => {
    openBlankComposition('Song');
    const [lead] = getTracks();
    const { rerender } = render(<CompositionPage openRailSections={[]} />);
    expect(viewButton('Edit', lead.name)).toBeEnabled();

    act(() => {
      const started = beginJob();
      if (!started.ok) throw new Error('job refused');
    });
    rerender(<CompositionPage openRailSections={[]} />);

    expect(viewButton('Edit', lead.name)).toBeDisabled();
    expect(viewButton('Voice', lead.name)).toBeDisabled();
    // The seam's own sentence, so the tooltip and the refusal agree.
    expect(viewButton('Edit', lead.name)).toHaveAttribute('title', JOB_LOCK_REASON);
    await userEvent.click(viewButton('Edit', lead.name));
    expect(viewButton('Edit', lead.name)).toHaveAttribute('aria-pressed', 'false');

    // And it comes back on its own — the flag is reactive, not read once.
    act(() => {
      endJob();
    });
    expect(viewButton('Edit', lead.name)).toBeEnabled();
  });
});

/**
 * The Commands section — AG-07. Its open state is `App`'s to own, for the reason
 * the view map is: this page unmounts on every visit to the pattern page. But the pair
 * is OPTIONAL, the way `collapsedRacks` is, and an optional prop that leaves the
 * control it names permanently dead is worse than one that works locally.
 */
describe('CompositionPage rail sections', () => {
  const commandsButton = () => screen.getByRole('button', { name: 'Commands' });

  it('opens and closes on its own when nobody is controlling it', async () => {
    openBlankComposition('Song');
    render(<CompositionPage />);

    expect(commandsButton()).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(commandsButton());
    expect(commandsButton()).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(commandsButton());
    expect(commandsButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('defers to the owner when there is one, and never writes its own copy', async () => {
    const onOpenRailSectionsChange = vi.fn();
    openBlankComposition('Song');
    render(
      <CompositionPage
        openRailSections={['commands']}
        onOpenRailSectionsChange={onOpenRailSectionsChange}
      />,
    );

    expect(commandsButton()).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(commandsButton());

    // The owner is told; the page does not fold itself behind the owner's back,
    // which is what would make the two states disagree after a remount.
    expect(onOpenRailSectionsChange).toHaveBeenCalledTimes(1);
    expect(commandsButton()).toHaveAttribute('aria-expanded', 'true');
  });
});
