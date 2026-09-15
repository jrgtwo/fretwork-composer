import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_PATTERNS_STATE, usePatternsStore } from '@fretwork/lib';
import { App } from '../src/App';
import { stop } from '../src/audio/playbackService';
import { getTracks, openBlankComposition } from '../src/composition/compositionService';

// Only `stop` is stood in for — jsdom has no Web Audio, so the transport's
// having been released is not observable any other way. Everything else in the
// seam stays real; the pattern page renders through it.
vi.mock('../src/audio/playbackService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audio/playbackService')>();
  return { ...actual, stop: vi.fn(actual.stop) };
});

/**
 * Page routing, and what has to survive it.
 *
 * What jsdom cannot tell us, so nobody writes it: the composition page's
 * defining property is that it FILLS the viewport and never scrolls the
 * document. jsdom has no layout — every box is 0x0 and nothing scrolls — so the
 * `h-screen` / `min-h-0` chain is a by-eye check (the ticket says so too), not
 * an assertion. What is assertable is which page is mounted, the mode bar's
 * semantics, and which state survives the round trip.
 *
 * The round-trip test is the one that matters. `CompositionPage` replaces the
 * pane stack outright, so the pattern page unmounts on every visit: any state
 * held inside a pane would be silently destroyed, and the amp pane's is the
 * user's UNSAVED tone. That it survives is the proof `App` still owns it.
 */

const nav = () => within(screen.getByRole('navigation', { name: 'Editor' }));
/** One track's view group, in its own header — the per-track control that
 *  replaced the page's `Composition mode` bar (COMPS-TRACK-TABS milestone 4). */
const views = (trackName: string) =>
  within(screen.getByRole('group', { name: `View for ${trackName}` }));
const goTo = (page: 'Pattern' | 'Composition') =>
  userEvent.click(nav().getByRole('button', { name: page }));

beforeEach(() => {
  sessionStorage.clear();
  // The `?theme` test rewrites the URL; reset it here rather than in one
  // describe's `afterEach`, which would stop covering the file the moment a
  // block moved below it.
  window.history.replaceState({}, '', '/');
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
});

/** Everything the pattern page owes: all three panes, and the rail beside them.
 *  Asserted whole, because "renders identically to before" is the constraint the
 *  `AppShell` body split is most likely to break — and to break invisibly. */
const expectPatternPage = () => {
  for (const title of ['Reference', 'Instrument & Amp', 'Timeline']) {
    expect(screen.getByText(title)).toBeInTheDocument();
  }
  // Scoped to the rail landmark, which since PP-01 holds the pattern library
  // rather than a label. The library's own behaviour is `PatternLibrary.test.tsx`;
  // what matters here is only that the rail is still beside the panes.
  const rail = within(screen.getByRole('complementary'));
  expect(rail.getByText('Patterns')).toBeInTheDocument();
  expect(rail.getByRole('button', { name: 'New pattern' })).toBeInTheDocument();
};

describe('page routing', () => {
  it('starts on the pattern page with its panes', () => {
    render(<App />);

    expect(nav().getByRole('button', { name: 'Pattern' })).toHaveAttribute('aria-current', 'page');
    expectPatternPage();
    expect(screen.queryByRole('group', { name: 'Composition mode' })).not.toBeInTheDocument();
  });

  // The connector is APP config, not a property of either document, so it lives
  // in the shared header rather than in a rail. Asserted here because the panel's
  // own tests render it in isolation: deleting it from `AppShell` leaves those
  // green while the settings become unreachable from the running app.
  it('keeps the connector in the frame on both pages', async () => {
    render(<App />);

    expect(screen.getByRole('button', { name: /^connector/i })).toBeInTheDocument();

    await goTo('Composition');

    expect(screen.getByRole('button', { name: /^connector/i })).toBeInTheDocument();
  });

  it('the Composition button swaps the body and moves aria-current', async () => {
    render(<App />);

    await goTo('Composition');

    expect(nav().getByRole('button', { name: 'Composition' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(nav().getByRole('button', { name: 'Pattern' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('region', { name: 'Arrangement' })).toBeInTheDocument();
    // The pane stack is gone, not merely hidden — this page owns its own layout.
    expect(screen.queryByText('Instrument & Amp')).not.toBeInTheDocument();
  });

  it('CREATES NO COMPOSITION on arrival, and lands on the empty state', async () => {
    // CP-17. Arriving used to mint "Untitled composition" — a document nobody
    // asked for, and the reason the empty state was previously unreachable.
    render(<App />);
    expect(usePatternsStore.getState().library.compositions).toHaveLength(0);

    await goTo('Composition');

    expect(usePatternsStore.getState().library.compositions).toHaveLength(0);
    expect(usePatternsStore.getState().editingCompositionId).toBeNull();
    // The page's own empty state, not the refusal — nothing may read as an error.
    expect(screen.getByText('No composition open')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('opens the existing composition through the seam and titles the header with it', async () => {
    openBlankComposition('Blues in C');
    usePatternsStore.setState({ editingCompositionId: null });
    render(<App />);

    await goTo('Composition');

    const composition = usePatternsStore.getState().library.compositions[0];
    expect(composition).toBeDefined();
    expect(usePatternsStore.getState().editingCompositionId).toBe(composition.id);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Blues in C');
    // Adopting the last-arranged one is not creating a second.
    expect(usePatternsStore.getState().library.compositions).toHaveLength(1);
  });

  it('opening a composition does not close the pattern being edited', async () => {
    render(<App />);
    const patternId = usePatternsStore.getState().editingPatternId;

    await goTo('Composition');

    expect(usePatternsStore.getState().editingPatternId).toBe(patternId);
  });

  it('Pattern goes back, with the whole page intact', async () => {
    render(<App />);

    await goTo('Composition');
    await goTo('Pattern');

    expectPatternPage();
    expect(nav().getByRole('button', { name: 'Pattern' })).toHaveAttribute('aria-current', 'page');
  });

  // The composition page draws no transport (that is CP-08), and the engine is
  // module-level, so a running metronome would otherwise keep playing with
  // nothing on screen able to stop it.
  it('stops the transport when it leaves the pattern page', async () => {
    render(<App />);
    const stopped = vi.mocked(stop);
    stopped.mockClear();

    await goTo('Composition');

    expect(stopped).toHaveBeenCalled();
  });

  it('says so when the store will not open a composition that exists', async () => {
    // CP-17 narrowed this path: with no auto-create left, the only way to fail
    // is the store declining to open a composition the library is holding. An
    // EMPTY library is not this case — that is the empty state above, and the
    // two must not be confused on screen.
    openBlankComposition('Blues in C');
    usePatternsStore.setState({ editingCompositionId: null });
    const real = usePatternsStore.getState().openCompositionForArranging;
    usePatternsStore.setState({ openCompositionForArranging: () => {} });
    try {
      render(<App />);

      await goTo('Composition');

      expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t open/i);
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('—');
    } finally {
      usePatternsStore.setState({ openCompositionForArranging: real });
    }
  });

  it('keeps rendering the theme reference for ?theme', () => {
    window.history.replaceState({}, '', '/?theme=1');
    render(<App />);

    expect(screen.getByRole('heading', { level: 1, name: /Theme reference/ })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Editor' })).not.toBeInTheDocument();
  });
});

describe('per-track view controls', () => {
  it('offers three views per track, all built, with Pattern active', async () => {
    // A composition to hold a track: arriving creates none (CP-17), and the
    // view controls live in a track's header.
    openBlankComposition('Song');
    render(<App />);
    await goTo('Composition');
    // ⚠ THE MODE BAR IS GONE (COMPS-TRACK-TABS milestone 4). The view is a
    // property of a TRACK now, so there is one group per header rather than one
    // for the page.
    expect(screen.queryByRole('group', { name: 'Composition mode' })).not.toBeInTheDocument();

    const trackName = getTracks()[0].name;
    // A missing entry means Pattern, which is what a fresh composition has.
    expect(views(trackName).getByRole('button', { name: `Pattern view, ${trackName}` })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Edit landed in CP-11, voice in CP-14. Both are live, and each carries a
    // tooltip saying what its view holds — the letter on the button does not.
    const edit = views(trackName).getByRole('button', { name: `Edit view, ${trackName}` });
    expect(edit).toBeEnabled();
    expect(edit).toHaveAttribute('title', expect.stringContaining('Edit'));
    const voice = views(trackName).getByRole('button', { name: `Voice view, ${trackName}` });
    expect(voice).toBeEnabled();
    expect(voice).toHaveAttribute('title', expect.stringContaining('Voice'));
  });
});

describe('state that outlives the page swap', () => {
  it('preserves the amp pane unsaved voice and its open sections', async () => {
    render(<App />);

    // `Level` starts folded, so opening it is a change to the folded-sections
    // list `App` holds; the knob edit inside it is draft state the pane never
    // persists. A `Knob`, not a range input — the pattern page draws the
    // composition page's controls now.
    await userEvent.click(screen.getByRole('button', { name: 'Level' }));
    const volume = screen.getByRole('slider', { name: 'Volume' });
    const before = Number(volume.getAttribute('aria-valuenow'));
    fireEvent.keyDown(volume, { key: 'ArrowUp' });
    const edited = Number(screen.getByRole('slider', { name: 'Volume' }).getAttribute('aria-valuenow'));
    expect(edited).toBeGreaterThan(before);
    expect(screen.getByText('Unsaved')).toBeInTheDocument();

    await goTo('Composition');
    await goTo('Pattern');

    expect(screen.getByRole('button', { name: 'Level' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('slider', { name: 'Volume' })).toHaveAttribute(
      'aria-valuenow',
      String(edited),
    );
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
  });

  // `PaneStack` is unmounted outright by the page swap, so its own state is
  // destroyed by it — collapse and order are held in `App` for that reason.
  // Only collapse is asserted: reordering is a drag, and jsdom's every box is
  // 0x0, so the drop target can't be resolved here.
  it('preserves which panes are folded', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'Collapse Reference' }));

    await goTo('Composition');
    await goTo('Pattern');

    expect(screen.getByRole('button', { name: 'Expand Reference' })).toBeInTheDocument();
  });
});

/**
 * The demo seed, and the reason it needs a guard.
 *
 * The lib persists `library` but NOT `editingPatternId` (see `partialize` in
 * `usePatternsStore`), so a reload comes back with every saved pattern and no
 * pointer at one. An unconditional seed therefore appends a fresh copy on every
 * load — invisible until CP-05 put the library on screen, and by then there
 * were eight of them.
 */
describe('the demo seed', () => {
  it('adopts the pattern a reload left behind instead of seeding another', () => {
    const { unmount } = render(<App />);
    expect(usePatternsStore.getState().library.patterns).toHaveLength(1);
    unmount();

    // The reload: the library survives, the pointer into it does not.
    usePatternsStore.setState({ editingPatternId: null });

    render(<App />);
    expect(usePatternsStore.getState().library.patterns).toHaveLength(1);
  });

  it('still seeds when the library is genuinely empty', () => {
    render(<App />);
    expect(usePatternsStore.getState().library.patterns).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'A major arpeggio' })).toBeInTheDocument();
  });
});
