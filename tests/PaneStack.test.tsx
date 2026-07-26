import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaneStack, type Pane } from '../src/shell/PaneStack';

const PANES: Pane[] = [
  { id: 'reference', title: 'Reference', min: 60, max: 220, children: <p>fretboard</p> },
  { id: 'amp', title: 'Instrument & Amp', canFill: true, children: <p>amp rack</p> },
  { id: 'timeline', title: 'Timeline', min: 150, max: 700, children: <p>beat grid</p> },
];

const setup = () => ({ user: userEvent.setup(), ...render(<PaneStack panes={PANES} />) });
const collapseBtn = (title: string) => screen.getByRole('button', { name: `Collapse ${title}` });
const paneOrder = () =>
  [...document.querySelectorAll('[data-pane]')].map((el) => el.getAttribute('data-pane'));

describe('PaneStack', () => {
  it('renders every pane with its content', () => {
    setup();
    expect(screen.getByText('Reference')).toBeInTheDocument();
    expect(screen.getByText('beat grid')).toBeInTheDocument();
  });

  it('collapsing a pane hides its body', async () => {
    const { user } = setup();
    expect(screen.getByText('amp rack')).toBeInTheDocument();

    await user.click(collapseBtn('Instrument & Amp'));

    expect(screen.queryByText('amp rack')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand Instrument & Amp' })).toBeInTheDocument();
  });

  // The collapse button sits inside the header, which is also the drag handle.
  // user-event fires the real mousedown → mouseup → click sequence, so this
  // actually exercises the guard that stops a button press starting a drag —
  // fireEvent.click never dispatched mousedown and silently skipped it.
  it('clicking the collapse button does not start a pane drag', async () => {
    const { user } = setup();
    const before = paneOrder();

    await user.click(collapseBtn('Reference'));

    expect(paneOrder()).toEqual(before);
    expect(screen.getByRole('button', { name: 'Expand Reference' })).toBeInTheDocument();
  });

  it('offers a way out once every pane is collapsed', async () => {
    const { user } = setup();

    for (const pane of PANES) await user.click(collapseBtn(pane.title));

    expect(screen.getByText('All panels collapsed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand all' }));

    expect(screen.queryByText('All panels collapsed')).not.toBeInTheDocument();
    expect(screen.getByText('beat grid')).toBeInTheDocument();
  });

  it('marks a splitter unavailable when neither neighbour can be resized', async () => {
    const { user } = setup();

    // Collapsing Reference leaves splitter 0 between it and the fill pane —
    // nothing there is resizable, so the handle must read as inactive rather
    // than looking live and doing nothing.
    await user.click(collapseBtn('Reference'));

    expect(screen.getByTestId('splitter-0')).toHaveAttribute(
      'aria-label',
      'Resize (unavailable)',
    );
  });

  it('gives the bottom pane a trailing splitter so it can claim free space', () => {
    setup();
    expect(screen.getByTestId('splitter-2')).toHaveAttribute('aria-label', 'Resize Timeline');
  });

  it('keeps each pane titled within its own section', () => {
    setup();
    const timeline = document.querySelector<HTMLElement>('[data-pane="timeline"]')!;
    expect(within(timeline).getByText('Timeline')).toBeInTheDocument();
  });

  describe('dragging a header', () => {
    it('ignores movement below the drag threshold', async () => {
      const { user } = setup();
      const before = paneOrder();
      const header = screen.getByText('Timeline');

      await user.pointer([
        { target: header, keys: '[MouseLeft>]', coords: { clientY: 100 } },
        { target: header, coords: { clientY: 102 } }, // 2px — under the 5px threshold
        { keys: '[/MouseLeft]' },
      ]);

      expect(paneOrder()).toEqual(before);
    });

    it('shows a drop indicator once the drag passes the threshold', async () => {
      const { user } = setup();
      const header = screen.getByText('Timeline');

      await user.pointer([
        { target: header, keys: '[MouseLeft>]', coords: { clientY: 100 } },
        { target: header, coords: { clientY: 140 } },
      ]);

      expect(screen.getByTestId('dropline')).toBeInTheDocument();

      await user.pointer({ keys: '[/MouseLeft]' });
      expect(screen.queryByTestId('dropline')).not.toBeInTheDocument();
    });
  });
});
