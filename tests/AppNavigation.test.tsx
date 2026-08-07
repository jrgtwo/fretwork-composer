import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_PATTERNS_STATE, usePatternsStore } from '@fretwork/lib';
import { App } from '../src/App';
import { stop } from '../src/audio/playbackService';

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
const modes = () => within(screen.getByRole('group', { name: 'Composition mode' }));
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
  // Scoped to the rail landmark: the app title also reads "Composer".
  expect(within(screen.getByRole('complementary')).getByText('Composer')).toBeInTheDocument();
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

  it('opens a composition through the seam and titles the header with it', async () => {
    render(<App />);
    expect(usePatternsStore.getState().library.compositions).toHaveLength(0);

    await goTo('Composition');

    const composition = usePatternsStore.getState().library.compositions[0];
    expect(composition).toBeDefined();
    expect(usePatternsStore.getState().editingCompositionId).toBe(composition.id);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(composition.name);
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

  it('says so when the library refuses to open a composition', async () => {
    // `ensureEditingComposition` returns without creating and without error when
    // the subscription gate declines. Store actions live in store state, so this
    // stands in for that refusal.
    const real = usePatternsStore.getState().ensureEditingComposition;
    usePatternsStore.setState({ ensureEditingComposition: () => {} });
    try {
      render(<App />);

      await goTo('Composition');

      expect(screen.getByRole('alert')).toHaveTextContent(/refused/i);
      // Not the ordinary empty page: nothing may read as a composition being open.
      expect(screen.queryByText('Arrangement')).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('—');
    } finally {
      usePatternsStore.setState({ ensureEditingComposition: real });
    }
  });

  it('keeps rendering the theme reference for ?theme', () => {
    window.history.replaceState({}, '', '/?theme=1');
    render(<App />);

    expect(screen.getByRole('heading', { level: 1, name: /Theme reference/ })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Editor' })).not.toBeInTheDocument();
  });
});

describe('composition mode bar', () => {
  it('offers three modes, all built, with Pattern active', async () => {
    render(<App />);
    await goTo('Composition');

    expect(modes().getByRole('button', { name: 'Pattern mode' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Edit mode landed in CP-11, voice mode in CP-14. The `pending` tooltip and
    // the `disabled` flag went with the placeholder they described.
    expect(modes().getByRole('button', { name: 'Edit mode' })).toBeEnabled();
    const voice = modes().getByRole('button', { name: 'Voice mode' });
    expect(voice).toBeEnabled();
    expect(voice).not.toHaveAttribute('title');
  });
});

describe('state that outlives the page swap', () => {
  it('preserves the amp pane unsaved voice and its open sections', async () => {
    render(<App />);

    // `Level` starts folded, so opening it is a change to `openSections`; the
    // slider edit inside it is working-voice state the pane never persists.
    await userEvent.click(screen.getByRole('button', { name: 'Level' }));
    const volume = screen.getByLabelText('Volume') as HTMLInputElement;
    fireEvent.change(volume, { target: { value: '-6' } });
    expect(screen.getByText('Unsaved')).toBeInTheDocument();

    await goTo('Composition');
    await goTo('Pattern');

    expect(screen.getByRole('button', { name: 'Level' })).toHaveAttribute('aria-expanded', 'true');
    expect((screen.getByLabelText('Volume') as HTMLInputElement).value).toBe('-6');
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
