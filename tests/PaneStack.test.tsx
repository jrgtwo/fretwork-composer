import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PaneStack, type Pane } from '../src/shell/PaneStack';

const PANES: Pane[] = [
  { id: 'reference', title: 'Reference', min: 60, max: 220, children: <p>fretboard</p> },
  { id: 'amp', title: 'Instrument & Amp', canFill: true, children: <p>amp rack</p> },
  { id: 'timeline', title: 'Timeline', min: 150, max: 700, children: <p>beat grid</p> },
];

const collapse = (title: string) =>
  fireEvent.click(screen.getByRole('button', { name: `Collapse ${title}` }));

describe('PaneStack', () => {
  it('renders every pane with its content', () => {
    render(<PaneStack panes={PANES} />);
    expect(screen.getByText('Reference')).toBeInTheDocument();
    expect(screen.getByText('beat grid')).toBeInTheDocument();
  });

  it('collapsing a pane hides its body', () => {
    render(<PaneStack panes={PANES} />);
    expect(screen.getByText('amp rack')).toBeInTheDocument();

    collapse('Instrument & Amp');

    expect(screen.queryByText('amp rack')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand Instrument & Amp' })).toBeInTheDocument();
  });

  it('offers a way out once every pane is collapsed', () => {
    render(<PaneStack panes={PANES} />);

    PANES.forEach((pane) => collapse(pane.title));

    expect(screen.getByText('All panels collapsed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));

    expect(screen.queryByText('All panels collapsed')).not.toBeInTheDocument();
    expect(screen.getByText('beat grid')).toBeInTheDocument();
  });

  it('marks a splitter unavailable when neither neighbour can be resized', () => {
    render(<PaneStack panes={PANES} />);

    // Collapsing Reference leaves splitter 0 between it and the fill pane —
    // nothing there is resizable, so the handle must read as inactive rather
    // than looking live and doing nothing.
    collapse('Reference');

    expect(screen.getByTestId('splitter-0')).toHaveAttribute(
      'aria-label',
      'Resize (unavailable)',
    );
  });

  it('gives the bottom pane a trailing splitter so it can claim free space', () => {
    render(<PaneStack panes={PANES} />);
    expect(screen.getByTestId('splitter-2')).toHaveAttribute('aria-label', 'Resize Timeline');
  });

  it('keeps each pane titled within its own section', () => {
    render(<PaneStack panes={PANES} />);
    const timeline = document.querySelector<HTMLElement>('[data-pane="timeline"]')!;
    expect(within(timeline).getByText('Timeline')).toBeInTheDocument();
  });
});
