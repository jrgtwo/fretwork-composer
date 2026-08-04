import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_PATTERNS_STATE, usePatternsStore } from '@fretwork/lib';
import { CompositionPage } from '../src/composition/CompositionPage';

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
});

const modeButton = (label: string) => screen.getByRole('button', { name: `${label} mode` });

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
});
