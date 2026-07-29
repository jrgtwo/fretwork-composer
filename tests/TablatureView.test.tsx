import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PPQ, ticksPerBar, useFretworkStore, usePatternsStore } from '@fretwork/lib';

/**
 * Same seam as `FretboardView.test.tsx`: the active-event set comes from the
 * scheduler, and there is no scheduler under jsdom (no AudioContext), so
 * `useActiveEventIds` could only ever return the idle empty array. Everything else
 * in the module stays real — the view reads the pattern instrument resolver through
 * `patternService`, which this doesn't touch.
 *
 * A subscription rather than a plain function returning a mutable array: the real hook
 * pushes a new set several times a beat with nothing re-rendering the view from above,
 * so a component that read a snapshot once at mount would pass a test driven by
 * `rerender` and light up nothing at all in the app.
 */
const audio = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let ids: readonly string[] = [];
  return {
    read: () => ids,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Emit a new active set, exactly as the scheduler's head loop does. */
    emit(next: readonly string[]) {
      ids = next;
      listeners.forEach((listener) => listener());
    },
  };
});
vi.mock('../src/audio/playbackService', async (importOriginal) => {
  const { useSyncExternalStore } = await import('react');
  return {
    ...(await importOriginal<typeof import('../src/audio/playbackService')>()),
    useActiveEventIds: () => useSyncExternalStore(audio.subscribe, audio.read),
  };
});

const { TablatureView } = await import('../src/reference/TablatureView');
const { openBlankPattern, stampNote, getEditingPattern, setArticulations } = await import(
  '../src/patterns/patternService'
);

const BAR = ticksPerBar({ numerator: 4, denominator: 4 });

/**
 * A ResizeObserver whose callback can be fired with a width of our choosing.
 *
 * jsdom reports every element as 0×0 and never fires a real observation, so this is
 * the *only* way to exercise the thing requirement 3 is about: bars per system
 * following the pane width. The stub in tests/setup.ts is a no-op, which is enough
 * to mount but proves nothing.
 *
 * `live` drops its entry on `disconnect`, so a stale observer can neither be fired by
 * `resizeTo` nor be counted as still watching — which is what makes the cleanup
 * assertable, and what stops a second mount in one test being driven by the first
 * mount's observer.
 */
interface FakeObserver {
  fire: (width: number) => void;
  disconnected: boolean;
}
const observers: FakeObserver[] = [];
const live = () => observers.filter((o) => !o.disconnected);
const RealResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
  observers.length = 0;
  globalThis.ResizeObserver = class {
    private entry: FakeObserver;
    constructor(callback: ResizeObserverCallback) {
      this.entry = {
        disconnected: false,
        fire: (width) => {
          callback(
            [{ contentRect: { width } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        },
      };
      observers.push(this.entry);
    }
    observe() {}
    unobserve() {}
    disconnect() {
      this.entry.disconnected = true;
    }
  } as unknown as typeof ResizeObserver;

  audio.emit([]);
  // The pattern's instrument comes from the lib's global store at creation time, and
  // that store is a module singleton — a test that moves it has to put it back.
  useFretworkStore.getState().setInstrumentId('guitar');
});

afterEach(() => {
  globalThis.ResizeObserver = RealResizeObserver;
});

/** Report a pane width to every observer still watching. */
function resizeTo(width: number) {
  act(() => live().forEach((observer) => observer.fire(width)));
}

const systems = () => document.querySelectorAll('[data-tab-system]');
const glyphs = () => [...document.querySelectorAll<HTMLElement>('[data-tab-note]')];
const notation = () => glyphs().map((el) => el.textContent);
const labels = () =>
  [...document.querySelectorAll('[data-tab-string]')].map((el) => el.textContent);
const barNumbers = () =>
  [...document.querySelectorAll('[data-tab-bar]')].map((el) => el.textContent);
const barlines = () => document.querySelectorAll('[data-tab-barline]');
const tails = () => [...document.querySelectorAll<HTMLElement>('[data-tab-tail]')];
/** The notation of every note currently lit by the transport. */
const active = () =>
  glyphs()
    .filter((el) => el.dataset.active !== undefined)
    .map((el) => el.textContent);

/** Two bars: an open-A-string note, a chord, then a note in bar 2. */
function seedPattern() {
  openBlankPattern('Tab test');
  stampNote({ stringIndex: 1, fret: 5, tick: 0, durationTicks: PPQ / 2 });
  stampNote({ stringIndex: 3, fret: 7, tick: PPQ, durationTicks: PPQ / 2 });
  stampNote({ stringIndex: 5, fret: 12, tick: PPQ, durationTicks: PPQ / 2 });
  stampNote({ stringIndex: 0, fret: 3, tick: BAR, durationTicks: PPQ / 2 });
}

const idOfEvent = (index: number) => getEditingPattern()!.events[index].id;

describe('TablatureView', () => {
  beforeEach(seedPattern);

  it('describes the tab it drew', () => {
    render(<TablatureView />);
    const figure = screen.getByRole('figure', { name: 'Tab test — 2 bars, 4 notes' });
    expect(figure).toBeVisible();
    // The staff is a wall of absolutely-positioned numbers with no reading order, so the
    // caption is the whole accessible description — and the staff itself is hidden rather
    // than left to be tabbed through as unlabelled text.
    expect(figure.querySelector('[aria-hidden="true"]')).not.toBeNull();
    // The figure is the scroller, so it has to be reachable without a pointer: a narrow
    // pane wraps this taller than the pane, and jsdom cannot assert the scrolling itself.
    expect(figure).toHaveAttribute('tabindex', '0');
  });

  it('draws one line per string with the high string on top', () => {
    render(<TablatureView />);
    // Top-to-bottom, which is the reverse of `stringIndex` order (E A D G B e). The
    // top E is lowercase, as tab writes it and as `Timeline.tsx` labels the same string.
    expect(labels().slice(0, 6)).toEqual(['e', 'B', 'G', 'D', 'A', 'E']);
  });

  it('puts a note on the line labelled with its own string', () => {
    render(<TablatureView />);
    // Wide enough for both bars to share a system, so there is only one set of labels to
    // compare against — at jsdom's zero width this wraps and each system has its own.
    resizeTo(900);

    // The two inversions — `stringLabels().reverse()` here and `rowForString` in the
    // layout — are separate code paths, and flipping both together would leave the label
    // test above passing while every note sat on the wrong line. This pins them to each
    // other: the note stamped on `stringIndex: 0` has to share a row with the `E` label.
    const lowE = [...document.querySelectorAll<HTMLElement>('[data-tab-string]')].find(
      (el) => el.textContent === 'E',
    )!;
    const onLowE = glyphs()[3]; // the bar-2 note, stamped on stringIndex 0
    expect(notation()[3]).toBe('3');
    // The label is drawn half a row high so it reads as sitting *on* the line; the glyph
    // is centred on it by transform. Hence the 4px, which is the offset `System` applies.
    expect(parseFloat(onLowE.style.top)).toBe(parseFloat(lowE.style.top) + 4);
  });

  it('writes a fret number for every note', () => {
    render(<TablatureView />);
    expect(notation()).toEqual(['5', '7', '12', '3']);
  });

  it('puts the notes of a chord on one x and different rows', () => {
    render(<TablatureView />);
    resizeTo(900);

    const [, onD, onHighE] = glyphs();
    expect(onD.style.left).toBe(onHighE.style.left);
    expect(onD.style.top).not.toBe(onHighE.style.top);
  });

  it('re-wraps when the pane is resized', () => {
    render(<TablatureView />);
    // jsdom measures 0, which `layoutTab` floors at one bar of width — so the
    // starting point is one bar per system.
    expect(systems()).toHaveLength(2);

    resizeTo(900);
    expect(systems()).toHaveLength(1);

    resizeTo(200);
    expect(systems()).toHaveLength(2);
  });

  it('numbers the bar each system opens on, and only that one', () => {
    render(<TablatureView />);
    resizeTo(200);
    // One number per system, counting through the wrap. Numbering every bar is
    // clutter in a wrapped score; the leading number is what says where you are.
    expect(barNumbers()).toEqual(['1', '2']);

    resizeTo(900);
    expect(barNumbers()).toEqual(['1']);
  });

  it('lights the notes that are sounding', () => {
    audio.emit([idOfEvent(1), idOfEvent(2)]);
    render(<TablatureView />);

    expect(glyphs().filter((el) => el.dataset.active !== undefined).map((el) => el.textContent))
      .toEqual(['7', '12']);
  });

  it('follows the scheduler as it plays, with nothing re-rendering it from above', () => {
    render(<TablatureView />);
    // The real hook emits several times a beat and no parent re-renders the view, so
    // this is the path that matters: reading the active set once at mount would light
    // up the first chord and then never change again.
    act(() => audio.emit([idOfEvent(0)]));
    expect(active()).toEqual(['5']);

    act(() => audio.emit([idOfEvent(1), idOfEvent(2)]));
    expect(active()).toEqual(['7', '12']);

    act(() => audio.emit([]));
    expect(active()).toEqual([]);
  });

  it('ignores active ids the open pattern does not own', () => {
    audio.emit(['from-a-pattern-that-was-closed']);
    render(<TablatureView />);
    expect(active()).toEqual([]);
  });

  it('draws a ring-out tail per note, dimmed for a palm mute', () => {
    setArticulations(idOfEvent(0), { palmMute: true });
    render(<TablatureView />);

    // One tail per note — the thing that shows how long a note holds, and the only
    // notation here that isn't text.
    expect(tails()).toHaveLength(4);
    // Palm mute is a tint, not a character: the number still reads `5`, and the mute
    // shows on the note rather than in it.
    expect(notation()[0]).toBe('5');
    expect(glyphs()[0].dataset.palmMute).toBe('true');
    expect(glyphs()[1].dataset.palmMute).toBeUndefined();
    expect(tails()[0].className).not.toBe(tails()[1].className);
  });

  it('draws every barline plus the one that closes each system', () => {
    render(<TablatureView />);
    resizeTo(200);
    // One bar per system, so two bar lines and two closing ones. Without the closing
    // line a wrapped system reads as unfinished rather than as a wrap.
    expect(barlines()).toHaveLength(4);
    expect(document.querySelectorAll('[data-tab-barline="close"]')).toHaveLength(2);

    resizeTo(900);
    expect(barlines()).toHaveLength(3);
    expect(document.querySelectorAll('[data-tab-barline="close"]')).toHaveLength(1);
  });

  it('stops watching the pane once unmounted', () => {
    const { unmount } = render(<TablatureView />);
    expect(live()).toHaveLength(1);

    unmount();

    // `PaneStack` unmounts a collapsed pane's children, so this is a real path, not a
    // hypothetical one — a missed disconnect leaks an observer per collapse.
    expect(live()).toHaveLength(0);
    // And a stale observation must not reach a torn-down component.
    expect(() => act(() => observers[0].fire(900))).not.toThrow();
  });

  it('spells articulations the way tab does, not the way the timeline does', () => {
    setArticulations(idOfEvent(0), { hammerOn: true, vibrato: 'slight' });
    setArticulations(idOfEvent(3), { dead: true });
    render(<TablatureView />);

    // `h5~`, not the timeline's `H` flag and `~` corner glyph.
    expect(notation()).toEqual(['h5~', '7', '12', 'x']);
  });

  it('is read-only — clicking a note edits nothing', async () => {
    render(<TablatureView />);
    const before = getEditingPattern();

    await userEvent.click(glyphs()[0]);

    // Reference-identical, not merely equal: the timeline owns editing, and a stamp or
    // a selection wired into this view would be a silent edit from a read-only surface.
    expect(getEditingPattern()).toBe(before);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('TablatureView — patterns it cannot fully draw', () => {
  it('follows the pattern instrument for how many lines to draw', () => {
    useFretworkStore.getState().setInstrumentId('bass');
    openBlankPattern('Bassline');
    stampNote({ stringIndex: 0, fret: 3, tick: 0, durationTicks: PPQ / 2 });

    render(<TablatureView />);

    // Four lines, labelled from the bass tuning — not six with two silent ones.
    expect(labels()).toEqual(['G', 'D', 'A', 'E']);
  });

  it('admits to the notes it has no line for', () => {
    useFretworkStore.getState().setInstrumentId('bass');
    openBlankPattern('Bassline');
    stampNote({ stringIndex: 0, fret: 3, tick: 0, durationTicks: PPQ / 2 });
    // Nothing in the UI authors this, but a pattern whose instrument changed under
    // it can hold one — and a note drawn nowhere at all, unremarked, is the failure
    // mode this whole caption exists for.
    stampNote({ stringIndex: 5, fret: 3, tick: PPQ, durationTicks: PPQ / 2 });

    render(<TablatureView />);

    // The first count is what got drawn, and the second is what didn't — the same
    // arithmetic as the fretboard's "N cells on the neck, M above the last fret". A
    // total that already included the off-staff note would make the two captions read
    // alike and mean opposite things.
    expect(
      screen.getByRole('figure', { name: 'Bassline — 1 bar, 1 note, 1 off the staff' }),
    ).toBeVisible();
    expect(glyphs()).toHaveLength(1);
  });

  it('survives having no pattern open', () => {
    usePatternsStore.getState().openPatternForEditing(null);

    render(<TablatureView />);

    expect(screen.getByRole('figure', { name: 'Tab — no pattern open' })).toBeVisible();
    expect(glyphs()).toHaveLength(0);
    // Still a staff, so the pane doesn't collapse to a caption on its own.
    expect(systems()).toHaveLength(1);
  });
});
