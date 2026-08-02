import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaneStack, type Pane } from '../src/shell/PaneStack';

const PANES: Pane[] = [
  { id: 'reference', title: 'Reference', children: <p>fretboard</p> },
  { id: 'amp', title: 'Instrument & Amp', children: <p>amp rack</p> },
  { id: 'timeline', title: 'Timeline', children: <p>beat grid</p> },
];

/** Order and collapse are the caller's — `App` owns them so a page swap can't
 *  reset them. This stands in for that owner. */
function Harness({ panes = PANES, order }: { panes?: Pane[]; order?: readonly string[] }) {
  const [paneOrder, setPaneOrder] = useState<readonly string[]>(order ?? panes.map((p) => p.id));
  const [collapsed, setCollapsed] = useState<readonly string[]>([]);
  return (
    <PaneStack
      panes={panes}
      order={paneOrder}
      onOrderChange={setPaneOrder}
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
    />
  );
}

const setup = () => ({ user: userEvent.setup(), ...render(<Harness />) });
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

  // The whole point of the rewrite: a pane is as tall as its content, so nothing
  // may write a height (or a flex grow/basis) onto a section. If one creeps back
  // in, a pane starts being sized by the stack again instead of by what it holds.
  it('never sizes a pane — no inline height, no flex, on any section', () => {
    setup();
    for (const id of ['reference', 'amp', 'timeline']) {
      const el = document.querySelector<HTMLElement>(`[data-pane="${id}"]`)!;
      expect(el.style.height).toBe('');
      expect(el.style.minHeight).toBe('');
      expect(el.style.maxHeight).toBe('');
      expect(el.style.flexGrow).toBe('');
    }
  });

  it('has no resize handles at all', () => {
    setup();
    expect(screen.queryAllByRole('separator')).toHaveLength(0);
    expect(document.querySelector('[data-testid^="splitter-"]')).toBeNull();
  });

  // "If they are all collapsed there should just be empty space below." No filler
  // pane, no empty-state panel offering a way out — every header keeps its own
  // expand toggle, so the way out is already on screen.
  it('leaves empty space when every pane is collapsed', async () => {
    const { user } = setup();

    for (const pane of PANES) await user.click(collapseBtn(pane.title));

    expect(screen.queryByText('beat grid')).not.toBeInTheDocument();
    expect(paneOrder()).toEqual(['reference', 'amp', 'timeline']);
    for (const pane of PANES) {
      expect(screen.getByRole('button', { name: `Expand ${pane.title}` })).toBeInTheDocument();
    }
  });

  // The order comes from the caller now, so it can name a pane that no longer
  // exists or miss one that just appeared. Neither may drop a pane off screen.
  it('reconciles an order that disagrees with the pane list', () => {
    render(<Harness order={['timeline', 'gone', 'reference']} />);

    expect(paneOrder()).toEqual(['timeline', 'reference', 'amp']);
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
