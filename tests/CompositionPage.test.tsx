import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_PATTERNS_STATE, usePatternsStore } from '@fretwork/lib';
import { CompositionPage } from '../src/composition/CompositionPage';
import {
  beginJob,
  endJob,
  JOB_LOCK_REASON,
  openBlankComposition,
} from '../src/composition/compositionService';

/**
 * `CompositionPage` is a controlled component: `mode` comes in as a prop and
 * every change goes back out through `onModeChange`, because `App` owns the
 * mode and this page unmounts on every visit to the pattern page.
 *
 * That is exactly what `App`-level tests cannot show — with Edit and Voice
 * disabled the mode never changes there, so hard-coding the highlight or
 * dropping the callback would pass every one of them. Rendering the page
 * directly at a mode `App` can't currently reach is the only way to make the
 * ownership falsifiable.
 */
beforeEach(() => {
  sessionStorage.clear();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  // Module state on the seam — a leaked job would disable the mode bar in every
  // test after the one that left it open.
  endJob();
});

const modeButton = (label: string) => screen.getByRole('button', { name: `${label} mode` });

describe('the rail (CP-17)', () => {
  const railSection = (name: string) =>
    screen.getByRole('button', { name: new RegExp(`^${name}$`, 'i') });

  it('holds three independently foldable sections in pattern mode', () => {
    render(
      <CompositionPage
        mode="pattern"
        onModeChange={() => {}}
        openRailSections={['commands', 'patterns', 'compositions']}
      />,
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
        mode="pattern"
        onModeChange={() => {}}
        openRailSections={['commands', 'patterns', 'compositions']}
        onOpenRailSectionsChange={onOpenRailSectionsChange}
      />,
    );

    await user.click(railSection('Compositions'));

    // Controlled, like `mode`: the page reports the change and `App` owns it, so
    // a fold survives the unmount every visit to the pattern page causes.
    expect(onOpenRailSectionsChange).toHaveBeenCalled();
    const next = onOpenRailSectionsChange.mock.calls[0][0](['commands', 'patterns', 'compositions']);
    expect(next).toEqual(['commands', 'patterns']);
  });

  it('offers neither library outside pattern mode', () => {
    render(
      <CompositionPage
        mode="voice"
        onModeChange={() => {}}
        openRailSections={['commands', 'patterns', 'compositions']}
      />,
    );

    expect(screen.getByRole('region', { name: 'Commands section' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Patterns section' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Compositions section' })).not.toBeInTheDocument();
  });
});

describe('CompositionPage mode bar', () => {
  it('presses the mode it is given, not a hard-coded default', () => {
    render(<CompositionPage mode="edit" onModeChange={() => {}} />);

    expect(modeButton('Edit')).toHaveAttribute('aria-pressed', 'true');
    expect(modeButton('Pattern')).toHaveAttribute('aria-pressed', 'false');
    expect(modeButton('Voice')).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports a press back out rather than changing mode itself', async () => {
    const onModeChange = vi.fn();
    render(<CompositionPage mode="edit" onModeChange={onModeChange} />);

    await userEvent.click(modeButton('Pattern'));

    expect(onModeChange).toHaveBeenCalledWith('pattern');
    // Still 'edit': the prop did not change, so neither did the page.
    expect(modeButton('Edit')).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers all three modes now that the last one is built', () => {
    render(<CompositionPage mode="pattern" onModeChange={() => {}} />);

    // CP-11 built edit mode and CP-14 built voice mode; nothing here is a
    // placeholder any more, so nothing here is inert.
    expect(modeButton('Pattern')).toBeEnabled();
    expect(modeButton('Edit')).toBeEnabled();
    expect(modeButton('Voice')).toBeEnabled();
  });

  /**
   * AG-07. The mode effect closes an open placement on EVERY mode change, and a
   * generation job may be inside one — the switch would repoint the lib's single
   * pattern pointer out from under it and land the job's next notes in the user's
   * LIBRARY pattern, which cancelling the job does not restore. The seam refuses
   * `openPlacementForEditing` for the same reason, but `mode` lives in `App` and
   * reaches no seam, so this is the only place it can be refused.
   */
  it('closes the mode bar while a generation job owns the composition', async () => {
    const onModeChange = vi.fn();
    // `beginJob` needs a document to own, and CP-17 stopped the page seeding one
    // on mount — a composition has to exist before the job can take it.
    openBlankComposition('Song');
    const { rerender } = render(
      <CompositionPage mode="pattern" onModeChange={onModeChange} />,
    );
    expect(modeButton('Edit')).toBeEnabled();

    act(() => {
      const started = beginJob();
      if (!started.ok) throw new Error('job refused');
    });
    rerender(<CompositionPage mode="pattern" onModeChange={onModeChange} />);

    // Disabled rather than left to refuse: `onModeChange` is `App`'s and there is
    // no seam call in the path to return a reason through.
    expect(modeButton('Edit')).toBeDisabled();
    expect(modeButton('Voice')).toBeDisabled();
    expect(modeButton('Edit')).toHaveAttribute('title', JOB_LOCK_REASON);
    await userEvent.click(modeButton('Edit'));
    expect(onModeChange).not.toHaveBeenCalled();

    // And it comes back on its own — the flag is reactive, not read once.
    act(() => {
      endJob();
    });
    expect(modeButton('Edit')).toBeEnabled();
  });
});

/**
 * The Commands section — AG-07. Its open state is `App`'s to own, for the reason
 * `mode` is: this page unmounts on every visit to the pattern page. But the pair
 * is OPTIONAL, the way `collapsedRacks` is, and an optional prop that leaves the
 * control it names permanently dead is worse than one that works locally.
 */
describe('CompositionPage rail sections', () => {
  const commandsButton = () => screen.getByRole('button', { name: 'Commands' });

  it('opens and closes on its own when nobody is controlling it', async () => {
    openBlankComposition('Song');
    render(<CompositionPage mode="pattern" onModeChange={() => {}} />);

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
        mode="pattern"
        onModeChange={() => {}}
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
