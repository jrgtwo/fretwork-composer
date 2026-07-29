import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { PPQ, useFretworkStore, usePatternsStore } from '@fretwork/lib';

/**
 * The active-cell layer is fed by the scheduler, and there is no scheduler here:
 * `playbackService` needs an AudioContext to build one, so under jsdom
 * `useActiveEventIds` can only ever return the idle empty array and the lit-up
 * behaviour would be untestable. That one seam is stubbed — the rest of the module
 * is kept real, since the view also reads the pattern instrument resolver through it.
 * Everything else in the view runs for real.
 *
 * A real subscription rather than a function returning a mutable array, matching
 * `TablatureView.test.tsx`: the scheduler pushes a new set several times a beat and
 * nothing re-renders this view from above, so a component that captured the set once at
 * mount would light up the first chord, never change again in the app, and still pass
 * every test driven by `rerender`.
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

const { FretboardView } = await import('../src/reference/FretboardView');
const { openBlankPattern, stampNote, getEditingPattern } = await import(
  '../src/patterns/patternService'
);

/**
 * The lib's markers are SVG `<g>` elements — no role, no accessible name, and their
 * only identifying text is a `<title>` nested one level too deep for `getByTitle`.
 * So the layers are read by the class names the lib puts on them, and each marker is
 * identified by the cell its title names.
 *
 * `string N` in that title is `stringIndex + 1`, so string 1 is the low E — the same
 * bottom-to-top order the timeline reverses for display. Parsed with a regex that
 * throws rather than degrading if the lib's title format ever changes, and sorted
 * numerically so fret 10 doesn't come before fret 3.
 */
function cellsIn(selector: string): string[] {
  return [...document.querySelectorAll(`${selector} > title`)]
    .map((title) => {
      const match = /string (\d+), fret (\d+)/.exec(title.textContent ?? '');
      if (!match) throw new Error(`unrecognised marker title: ${title.textContent}`);
      return [Number(match[1]), Number(match[2])] as const;
    })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([string, fret]) => `string ${string}, fret ${fret}`);
}

const markerCount = () => document.querySelectorAll('.fb-marker').length;

/** Low E fret 3, D string fret 5, then low E fret 3 again — one repeated cell. */
function seedPattern() {
  openBlankPattern('Reference');
  stampNote({ stringIndex: 0, fret: 3, tick: 0, durationTicks: PPQ / 2 });
  stampNote({ stringIndex: 2, fret: 5, tick: PPQ, durationTicks: PPQ / 2 });
  stampNote({ stringIndex: 0, fret: 3, tick: PPQ * 2, durationTicks: PPQ / 2 });
}

const idOfEvent = (index: number) => getEditingPattern()!.events[index].id;

beforeEach(() => {
  audio.emit([]);
  // The board's neck comes from the lib's own global store, which no app code writes
  // — but it is a module singleton, so a test that moves it has to put it back.
  useFretworkStore.getState().setInstrumentId('guitar');
  seedPattern();
});

describe('FretboardView', () => {
  it('describes the pattern it drew', () => {
    render(<FretboardView />);

    // Not the board's own `aria-label`: the lib hardcodes that from its global scale
    // state ("… showing A major in Standard"), which is a claim this view doesn't
    // make, so the board is hidden from the a11y tree and named by its caption.
    const figure = screen.getByRole('figure', { name: 'Reference — 2 cells on the neck' });
    expect(figure).toBeVisible();
    // …and that label is not exposed *as well*: the board's svg is `role="img"`, so
    // this fails the moment it stops being hidden from the accessibility tree.
    expect(screen.queryByRole('img')).toBeNull();
    // Hiding the board costs the lib's own horizontal scroller its only route to the
    // keyboard, so the figure takes both scrollers and the focus that reaches them. Not a
    // cosmetic attribute: without it the upper frets are pointer-only at a narrow pane.
    // What it *scrolls* is unassertable — jsdom lays nothing out and scrolls nothing.
    expect(figure).toHaveAttribute('tabindex', '0');
    expect(figure.className).toContain('overflow-auto');
  });

  it('ghosts every distinct cell the pattern visits, and only those', () => {
    render(<FretboardView />);

    expect(cellsIn('.fb-ghosted')).toEqual(['string 1, fret 3', 'string 3, fret 5']);
    // Two notes at low E fret 3 are one marker, and nothing else is drawn.
    expect(markerCount()).toBe(2);
  });

  it('lights the cells that are sounding, and stops ghosting them', () => {
    audio.emit([idOfEvent(1)]);
    render(<FretboardView />);

    expect(cellsIn('.fb-playhead')).toEqual(['string 3, fret 5']);
    expect(cellsIn('.fb-ghosted')).toEqual(['string 1, fret 3']);
  });

  it('lights a chord as several cells at once', () => {
    audio.emit([idOfEvent(0), idOfEvent(1)]);
    render(<FretboardView />);

    expect(cellsIn('.fb-playhead')).toEqual(['string 1, fret 3', 'string 3, fret 5']);
    expect(cellsIn('.fb-ghosted')).toEqual([]);
  });

  it('follows the scheduler as it plays, with nothing re-rendering it from above', () => {
    render(<FretboardView />);
    // Driven by the subscription rather than by a `rerender`, because that is the only
    // path the app has: the pane above this view re-renders for nothing during playback.
    act(() => audio.emit([idOfEvent(0)]));
    expect(cellsIn('.fb-playhead')).toEqual(['string 1, fret 3']);

    act(() => audio.emit([idOfEvent(1)]));
    expect(cellsIn('.fb-playhead')).toEqual(['string 3, fret 5']);
  });

  it('goes dark when playback stops', () => {
    audio.emit([idOfEvent(0)]);
    render(<FretboardView />);
    expect(cellsIn('.fb-playhead')).toHaveLength(1);

    act(() => audio.emit([]));

    expect(cellsIn('.fb-playhead')).toEqual([]);
    expect(cellsIn('.fb-ghosted')).toHaveLength(2);
    // An *empty* activity layer, not an absent one: `activeCellsFor` returns `[]` rather
    // than `undefined` so the lib's legacy single-cell playhead
    // (`usePlaybackStore.currentPlayheadCell`, `activeCells ? null : storePlayheadCell`)
    // can't take the layer over. Nothing here can fail if that changes — jsdom has no
    // metronome, so that store cell is permanently null. Stated rather than faked.
  });

  it('ignores active ids the open pattern does not own', () => {
    audio.emit(['from-a-pattern-that-was-closed']);
    render(<FretboardView />);

    expect(cellsIn('.fb-playhead')).toEqual([]);
  });

  it('is read-only — nothing installs a click target', () => {
    render(<FretboardView />);

    // `.fb-cell-hit` is the invisible full-grid click layer, and it exists if and only
    // if `onCellClickOverride` was passed — so this is the assertion that catches
    // wiring the board for input.
    expect(document.querySelector('.fb-cell-hit')).toBeNull();
    // `.fb-clickable` marks a marker that got an onClick. It cannot appear here for a
    // second, structural reason: the lib only attaches onClick to markers in its
    // *render* set, which is empty while we pass no highlights. So this assertion
    // holds even if someone adds `alwaysClickable` — that prop is genuinely inert on
    // this board, and no test can distinguish it. Stated rather than faked.
    expect(document.querySelector('.fb-clickable')).toBeNull();
  });

  it('still shows the whole pattern once the pattern has a key', () => {
    // No app-level action sets key/scale yet (see docs/FOLLOW-UPS.md §5), so the
    // store is driven directly — from the test, never from a component.
    usePatternsStore.getState().setEditingPatternKeyScale('A', 'minor-pentatonic');
    // Low E fret 1 is F: outside A minor pentatonic (A C D E G), unlike the seeded
    // notes, which are both G.
    stampNote({ stringIndex: 0, fret: 1, tick: PPQ * 3, durationTicks: PPQ / 2 });

    render(<FretboardView />);

    // LIB-GAP(8): a key must not turn the scale layer on. The lib's footprint layer
    // skips cells the render set already drew, so drawing A minor pentatonic would
    // leave only the out-of-scale F ghosted and hide the two G's among ~57 identical
    // scale markers — the pattern would disappear from its own reference view.
    expect(cellsIn('.fb-ghosted')).toEqual([
      'string 1, fret 1',
      'string 1, fret 3',
      'string 3, fret 5',
    ]);
    expect(markerCount()).toBe(3);
  });

  it('leaves the neck bare when the pattern names a scale the lib does not know', () => {
    usePatternsStore.getState().setEditingPatternKeyScale('A', 'not-a-scale');

    render(<FretboardView />);

    // LIB-GAP(7): the fallback would be the *global* fretwork store's scale, which
    // has nothing to do with this pattern.
    expect(markerCount()).toBe(2);
  });

  it('survives having no pattern open', () => {
    usePatternsStore.getState().openPatternForEditing(null);

    render(<FretboardView />);

    expect(screen.getByRole('figure', { name: 'Fretboard — no pattern open' })).toBeVisible();
    expect(markerCount()).toBe(0);
  });

  it('says so instead of drawing the pattern on the wrong instrument', () => {
    // The neck comes from the lib's global store and the pattern's instrument from the
    // pattern; nothing syncs them (docs/FOLLOW-UPS.md §3). On a 4-string neck the lib
    // would drop this 6-string pattern's D-string note without a word and still look
    // entirely plausible, which is the failure this guard exists to prevent.
    useFretworkStore.getState().setInstrumentId('bass');

    render(<FretboardView />);

    expect(screen.getByText('Guitar pattern — the board is set to Bass')).toBeVisible();
    expect(markerCount()).toBe(0);
  });

  it('admits to the notes it cannot draw', () => {
    // The timeline allows frets up to `MAX_FRET` (24) and a guitar neck has 22. The lib
    // clamps rather than dropping (`fretX` returns the scale length for any
    // `fret >= fretCount`), so both of these would be drawn on the same spot just past
    // the last fret line — visible, plausible, and on the wrong fret.
    stampNote({ stringIndex: 4, fret: 23, tick: PPQ * 4, durationTicks: PPQ / 2 });
    stampNote({ stringIndex: 5, fret: 24, tick: PPQ * 5, durationTicks: PPQ / 2 });

    render(<FretboardView />);

    expect(
      screen.getByRole('figure', { name: 'Reference — 2 cells on the neck, 2 above the last fret' }),
    ).toBeVisible();
    expect(markerCount()).toBe(2);
  });
});
