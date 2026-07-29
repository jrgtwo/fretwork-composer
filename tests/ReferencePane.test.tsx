import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PPQ, useFretworkStore } from '@fretwork/lib';

/**
 * Same seam as the two view tests: no AudioContext under jsdom, so the scheduler's
 * active set can only ever be the idle empty array. Everything else runs for real,
 * including both views — the point of this file is the wiring between them, and a
 * mocked view would prove nothing about it.
 */
vi.mock('../src/audio/playbackService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/audio/playbackService')>()),
  useActiveEventIds: () => [],
}));

const { ReferencePane } = await import('../src/reference/ReferencePane');
const { App } = await import('../src/App');
const { openBlankPattern, stampNote } = await import('../src/patterns/patternService');

beforeEach(() => {
  // The pattern's instrument comes from the lib's global store at creation time, and
  // that store is a module singleton — a test that moves it has to put it back.
  useFretworkStore.getState().setInstrumentId('guitar');
  openBlankPattern('Reference test');
  stampNote({ stringIndex: 1, fret: 5, tick: 0, durationTicks: PPQ / 2 });
});

const fretboard = () => screen.queryByTestId('fretboard-view');
const tab = () => screen.queryByTestId('tablature-view');
const button = (name: 'Fretboard' | 'Tab') => screen.getByRole('button', { name });
const pressed = () =>
  screen
    .getAllByRole('button')
    .filter((el) => el.getAttribute('aria-pressed') === 'true')
    .map((el) => el.textContent);

describe('ReferencePane', () => {
  it('draws the view it is given, and only that one', () => {
    const { rerender } = render(<ReferencePane view="fretboard" onViewChange={() => {}} />);

    expect(fretboard()).toBeVisible();
    // Switched, not stacked: both views want the pane's whole height.
    expect(tab()).toBeNull();

    rerender(<ReferencePane view="tab" onViewChange={() => {}} />);

    expect(tab()).toBeVisible();
    expect(fretboard()).toBeNull();
    expect(screen.getByRole('figure', { name: /^Reference test —/ })).toBeVisible();
  });

  it('says which view is showing', () => {
    const { rerender } = render(<ReferencePane view="fretboard" onViewChange={() => {}} />);

    expect(pressed()).toEqual(['Fretboard']);

    rerender(<ReferencePane view="tab" onViewChange={() => {}} />);

    // Exactly one, and it's the one you're looking at — a switch that leaves both lit
    // is worse than no switch.
    expect(pressed()).toEqual(['Tab']);
  });

  it('asks for the other view when its button is pressed', async () => {
    const onViewChange = vi.fn();
    render(<ReferencePane view="fretboard" onViewChange={onViewChange} />);

    await userEvent.click(button('Tab'));

    expect(onViewChange).toHaveBeenCalledWith('tab');
  });

  it('is operable from the keyboard alone', async () => {
    const onViewChange = vi.fn();
    const user = userEvent.setup();
    render(<ReferencePane view="fretboard" onViewChange={onViewChange} />);

    // Reached by tabbing rather than by `.focus()`: the switch being in the tab order
    // at all is half of what's being claimed here. Both views are read-only, so these
    // two buttons are the pane's entire keyboard surface.
    await user.tab();
    expect(button('Fretboard')).toHaveFocus();
    await user.tab();
    expect(button('Tab')).toHaveFocus();

    await user.keyboard('{Enter}');
    await user.keyboard('[Space]');

    expect(onViewChange.mock.calls).toEqual([['tab'], ['tab']]);
  });
});

describe('the Reference pane in the app shell', () => {
  const referencePane = () => document.querySelector<HTMLElement>('[data-pane="reference"]')!;
  const collapse = () => screen.getByRole('button', { name: 'Collapse Reference' });
  const expand = () => screen.getByRole('button', { name: 'Expand Reference' });

  it('is what the Reference pane draws', () => {
    render(<App />);

    // By its accessible name, not by testid: the board and its "wrong neck / no
    // instrument" notice are two different elements, and this is the only assertion in
    // the file that the shell wiring produced a *board*. A testid shared with the notice
    // would pass on exactly the failure `FretboardView` exists to report.
    expect(
      within(referencePane()).getByRole('figure', { name: /cells? on the neck$/ }),
    ).toBeVisible();
    expect(screen.queryByTestId('reference-notice')).toBeNull();
    // The placeholder it replaced named itself; nothing should still be advertising a
    // view that isn't there.
    expect(screen.queryByText('Fretboard / Tablature')).toBeNull();
  });

  it('switches view on a real click', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(button('Tab'));

    expect(within(referencePane()).getByTestId('tablature-view')).toBeVisible();
    expect(pressed()).toContain('Tab');
  });

  it('keeps the chosen view across a collapse and re-expand', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(button('Tab'));
    await user.click(collapse());

    // Collapse unmounts the pane body rather than hiding it — which is why the view id
    // is held above the stack.
    expect(tab()).toBeNull();
    expect(fretboard()).toBeNull();

    await user.click(expand());

    expect(tab()).toBeVisible();
    expect(button('Tab')).toHaveAttribute('aria-pressed', 'true');
  });

  /**
   * jsdom's `ResizeObserver` is a stub that never fires (tests/setup.ts) and every
   * element measures 0×0, so there's no asserting what a re-measure *produces*. What
   * can be asserted is lifecycle: a collapsed pane holds no observer at all. Counted as
   * a delta because the timeline observes its own pane for the whole test.
   */
  describe('while collapsed', () => {
    const live = new Set<object>();
    const real = globalThis.ResizeObserver;

    beforeEach(() => {
      live.clear();
      globalThis.ResizeObserver = class {
        observe() {
          live.add(this);
        }
        unobserve() {
          live.delete(this);
        }
        disconnect() {
          live.delete(this);
        }
      } as unknown as typeof ResizeObserver;
    });

    afterEach(() => {
      globalThis.ResizeObserver = real;
    });

    it('observes nothing of its own', async () => {
      const user = userEvent.setup();
      render(<App />);

      // The fretboard view sizes itself in CSS and observes nothing, so this baseline
      // is the rest of the app — which makes the +1 below the tab staff's, and only it.
      const base = live.size;

      await user.click(button('Tab'));
      expect(live.size).toBe(base + 1);

      await user.click(collapse());
      expect(live.size).toBe(base);

      await user.click(expand());
      expect(live.size).toBe(base + 1);
    });
  });
});
