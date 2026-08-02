import { describe, it, expect, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PPQ } from '@fretwork/lib';
import { Timeline } from '../src/timeline/Timeline';
import { edgeScrollSpeed, stepFor, MIN_SPEED } from '../src/timeline/useEdgeAutoScroll';
import { installFrameClock } from './frameClock';
import {
  clearHistory,
  getEditingPattern,
  getSelectedIds,
  openBlankPattern,
  setEditingPatternInstrument,
  stampNote,
  undo,
} from '../src/patterns/patternService';

/**
 * Two notes a beat apart on different strings, as a freshly-loaded baseline.
 * stringIndex follows the lib: 0 = low E, so 1 is the A string and 3 is G.
 */
function seedTwoNotes() {
  openBlankPattern('Test');
  stampNote({ stringIndex: 1, fret: 5, tick: 0, durationTicks: PPQ / 2 });
  stampNote({ stringIndex: 3, fret: 7, tick: PPQ, durationTicks: PPQ / 2 });
  clearHistory(); // loading a pattern is not an undoable edit
}

const noteEl = (id: string) => document.querySelector<HTMLElement>(`[data-note="${id}"]`)!;
/** The drag strip on a note's right edge. It has no role or name of its own —
 *  it's a grab target, not a control — so it's found by its data hook. */
const resizeEl = (id: string) => document.querySelector<HTMLElement>(`[data-resize="${id}"]`)!;
const events = () => getEditingPattern()!.events;

/**
 * jsdom has no layout, so `tickAt` measures against a lane rect of 0 — which
 * makes clientX map straight onto ticks at the default zoom of 48px/beat: a
 * beat (PPQ ticks) is 48px in. Row height bottoms out at its 22px floor.
 */
const BEAT_PX = 48;
const ROW_PX = 22;

/** The rigged well: a 400px window onto 1200px of content. */
const WELL_W = 400;
const CONTENT_W = 1200;
const MAX_SCROLL = CONTENT_W - WELL_W;

/**
 * Give the timeline a geometry, since jsdom measures everything as 0x0 and the
 * edge auto-scroll has nothing to be near without one. Call after `render`.
 *
 * `scrollLeft` is a plain stored property in jsdom, so it only needs clamping to
 * behave like a scroller; the lanes and the notes then report themselves shifted
 * by it, exactly as the real ones would.
 */
function rigScroller() {
  const scroller = screen.getByTestId('well');
  const lanes = document.querySelector<HTMLElement>('.lanes')!;
  let scrollLeft = 0;
  Object.defineProperty(scroller, 'scrollLeft', {
    configurable: true,
    get: () => scrollLeft,
    // The browser stops at the end of the content; jsdom would happily store
    // 10_000, and the loop's end-of-travel branch would never be reached.
    set: (v: number) => {
      scrollLeft = Math.max(0, Math.min(MAX_SCROLL, v));
    },
  });
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, WELL_W, 120);
  lanes.getBoundingClientRect = () => new DOMRect(-scrollLeft, 0, CONTENT_W, 120);
  for (const el of document.querySelectorAll<HTMLElement>('[data-note]')) {
    // Read at call time: a dragged note's `left` changes under it.
    el.getBoundingClientRect = () => new DOMRect(parseFloat(el.style.left) - scrollLeft, 0, 14, 20);
  }
  return { ...installFrameClock(), scrollLeft: () => scrollLeft };
}

async function selectBoth(user: ReturnType<typeof userEvent.setup>, ids: string[]) {
  await user.pointer({ target: noteEl(ids[0]), keys: '[MouseLeft]' });
  await user.keyboard('{Shift>}');
  await user.pointer({ target: noteEl(ids[1]), keys: '[MouseLeft]' });
  await user.keyboard('{/Shift}');
}

const fretOf = (id: string) => events().find((e) => e.id === id)!.fret;
/** Comfortably past the 800ms fret-typing window in Timeline.tsx. */
const PAST_WINDOW_MS = 900;

beforeEach(() => seedTwoNotes());

describe('Timeline', () => {
  it('renders a lane per string', () => {
    render(<Timeline />);
    expect(document.querySelectorAll('[data-lane]')).toHaveLength(6);
  });

  // The lib indexes strings low-to-high (its `standard` tuning is
  // ['E2','A2','D3','G3','B3','E4'] and the scheduler reads
  // openStrings[stringIndex]), while tab draws the high string on top. Get this
  // backwards and every note plays on the wrong string.
  it('draws the high string on top while keeping the lib\'s index order', () => {
    render(<Timeline />);
    const lanes = [...document.querySelectorAll('[data-lane]')].map((el) =>
      el.getAttribute('data-lane'),
    );
    expect(lanes).toEqual(['e', 'B', 'G', 'D', 'A', 'E']);
  });

  it('shows the pitch the lib would actually sound for a string index', () => {
    render(<Timeline />);
    // stringIndex 1 is the A string; its 5th fret is a D
    expect(screen.getByTitle('Fret 5 · D')).toBeInTheDocument();
  });

  it('renders one element per pattern event', () => {
    render(<Timeline />);

    expect(document.querySelectorAll('[data-note]')).toHaveLength(events().length);
    // 5th fret of the A string is D — the standard tuning reference note
    expect(screen.getByTitle('Fret 5 · D')).toBeInTheDocument();
    // 7th fret of the G string is also a D, an octave up
    expect(screen.getByTitle('Fret 7 · D')).toBeInTheDocument();
  });

  it('places a note at its tick position, scaled by zoom', async () => {
    const user = userEvent.setup();
    render(<Timeline />);
    const onBeatTwo = events().find((e) => e.startTick === PPQ)!;

    // default zoom is 48px per beat, so a note one beat in sits at 48px
    expect(noteEl(onBeatTwo.id).style.left).toBe('48px');

    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(noteEl(onBeatTwo.id).style.left).toBe('96px');
  });

  it('disables zoom controls at the extremes', async () => {
    const user = userEvent.setup();
    render(<Timeline />);

    const zoomOut = screen.getByRole('button', { name: 'Zoom out' });
    await user.click(zoomOut);
    await user.click(zoomOut);
    expect(zoomOut).toBeDisabled();
  });

  // A note on a string the instrument hasn't got is drawn nowhere at all, so it
  // cannot be clicked, banded or deleted — while still counting in "N notes" and
  // still sounding. `setPatternInstrument` swaps the id and prunes nothing, so the
  // state is one instrument change away; the editor has to admit to it rather than
  // being the only view in the app that hides notes in silence.
  describe('notes with no lane to be drawn in', () => {
    it('says how many the neck cannot show', () => {
      seedTwoNotes(); // stringIndex 1 and 3
      stampNote({ stringIndex: 5, fret: 3, tick: 0, durationTicks: PPQ / 2 });
      setEditingPatternInstrument('bass');
      render(<Timeline />);

      expect(document.querySelectorAll('[data-lane]')).toHaveLength(4);
      // Only index 5 is past a four-string neck; 1 and 3 still have lanes.
      expect(document.querySelectorAll('[data-note]')).toHaveLength(2);
      expect(screen.getByText('⚠ 1 off-instrument')).toBeInTheDocument();
    });

    it('stays quiet when every note has a string', () => {
      render(<Timeline />);
      expect(screen.queryByText(/off-instrument/)).not.toBeInTheDocument();
    });
  });

  describe('editing', () => {
    it('selects a note when you press it', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const target = events()[0];

      await user.pointer({ target: noteEl(target.id), keys: '[MouseLeft]' });

      expect(getSelectedIds()).toEqual([target.id]);
      expect(noteEl(target.id)).toHaveAttribute('data-selected');
    });

    it('deletes the selection with the Delete key', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const target = events()[0];
      const before = events().length;

      await user.pointer({ target: noteEl(target.id), keys: '[MouseLeft]' });
      await user.keyboard('{Delete}');

      expect(events()).toHaveLength(before - 1);
      expect(events().find((e) => e.id === target.id)).toBeUndefined();
    });

    it('stamps a note when you press empty lane space', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const before = events().length;
      const emptyLane = document.querySelector<HTMLElement>('[data-lane="E"]')!;

      await user.pointer({ target: emptyLane, keys: '[MouseLeft]' });

      expect(events()).toHaveLength(before + 1);
      // the low E lane is stringIndex 0 in the lib's ordering
      expect(events().some((e) => e.stringIndex === 0)).toBe(true);
    });

    it('ignores Delete while nothing is selected', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const before = events().length;

      await user.keyboard('{Delete}');

      expect(events()).toHaveLength(before);
    });
  });

  describe('undo', () => {
    it('undoes a stamp from the toolbar button', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const before = events().length;
      const emptyLane = document.querySelector<HTMLElement>('[data-lane="E"]')!;

      await user.pointer({ target: emptyLane, keys: '[MouseLeft]' });
      expect(events()).toHaveLength(before + 1);

      await user.click(screen.getByRole('button', { name: 'Undo' }));

      expect(events()).toHaveLength(before);
    });

    it('undoes with the keyboard shortcut', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const target = events()[0];

      await user.pointer({ target: noteEl(target.id), keys: '[MouseLeft]' });
      await user.keyboard('{Delete}');
      expect(events().find((e) => e.id === target.id)).toBeUndefined();

      await user.keyboard('{Control>}z{/Control}');

      expect(events().find((e) => e.id === target.id)).toBeDefined();
    });

    it('disables the buttons when there is nothing to undo or redo', () => {
      render(<Timeline />);
      expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
    });
  });

  describe('multi-select', () => {
    it('shift-clicking adds a note to the selection', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const [first, second] = events();

      await user.pointer({ target: noteEl(first.id), keys: '[MouseLeft]' });
      await user.keyboard('{Shift>}');
      await user.pointer({ target: noteEl(second.id), keys: '[MouseLeft]' });
      await user.keyboard('{/Shift}');

      expect(getSelectedIds()).toHaveLength(2);
    });

    it('shift-clicking a selected note removes it again', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const [first, second] = events();

      await user.pointer({ target: noteEl(first.id), keys: '[MouseLeft]' });
      await user.keyboard('{Shift>}');
      await user.pointer({ target: noteEl(second.id), keys: '[MouseLeft]' });
      await user.pointer({ target: noteEl(second.id), keys: '[MouseLeft]' });
      await user.keyboard('{/Shift}');

      expect(getSelectedIds()).toEqual([first.id]);
    });

    it('deletes the whole selection at once', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const [first, second] = events();

      await user.pointer({ target: noteEl(first.id), keys: '[MouseLeft]' });
      await user.keyboard('{Shift>}');
      await user.pointer({ target: noteEl(second.id), keys: '[MouseLeft]' });
      await user.keyboard('{/Shift}');
      await user.keyboard('{Delete}');

      expect(events()).toHaveLength(0);
    });

    it('clicking empty space clears a multi-selection instead of stamping', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const [first, second] = events();
      const count = events().length;

      await user.pointer({ target: noteEl(first.id), keys: '[MouseLeft]' });
      await user.keyboard('{Shift>}');
      await user.pointer({ target: noteEl(second.id), keys: '[MouseLeft]' });
      await user.keyboard('{/Shift}');

      const emptyLane = document.querySelector<HTMLElement>('[data-lane="E"]')!;
      await user.pointer({ target: emptyLane, keys: '[MouseLeft]' });

      expect(getSelectedIds()).toEqual([]);
      expect(events()).toHaveLength(count); // nothing stamped
    });

    // ⚠ The marquee's own hit-testing can't be covered here: it reads
    // getBoundingClientRect, and jsdom reports every element as 0x0 at the
    // origin. These two cover the gesture (band shown, no accidental stamp);
    // which notes a band actually catches needs a real layout engine.
    it('shows a selection band while dragging across empty space', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const lane = document.querySelector<HTMLElement>('[data-lane="E"]')!;

      await user.pointer([
        { target: lane, keys: '[MouseLeft>]', coords: { clientX: 10, clientY: 10 } },
        { target: lane, coords: { clientX: 120, clientY: 90 } },
      ]);

      expect(screen.getByTestId('marquee')).toBeInTheDocument();

      await user.pointer({ keys: '[/MouseLeft]' });
      expect(screen.queryByTestId('marquee')).not.toBeInTheDocument();
    });

    it('does not stamp a note when the drag was a marquee', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const lane = document.querySelector<HTMLElement>('[data-lane="E"]')!;
      const before = events().length;

      await user.pointer([
        { target: lane, keys: '[MouseLeft>]', coords: { clientX: 10, clientY: 10 } },
        { target: lane, coords: { clientX: 200, clientY: 100 } },
        { keys: '[/MouseLeft]' },
      ]);

      expect(events()).toHaveLength(before);
    });

    it('leaves nothing to undo — a marquee changes no notes', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const lane = document.querySelector<HTMLElement>('[data-lane="E"]')!;

      await user.pointer([
        { target: lane, keys: '[MouseLeft>]', coords: { clientX: 10, clientY: 10 } },
        { target: lane, coords: { clientX: 200, clientY: 100 } },
        { keys: '[/MouseLeft]' },
      ]);

      expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    });
  });

  describe('group drag', () => {
    it('moves every selected note by the grabbed note\'s delta', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const ids = events().map((e) => e.id);
      const before = events().map((e) => e.startTick);
      await selectBoth(user, ids);

      // Grab the *second* note — the one that doesn't start at tick 0 — so a
      // delta confused with an absolute tick can't accidentally look right.
      await user.pointer([
        { target: noteEl(ids[1]), keys: '[MouseLeft>]', coords: { clientX: BEAT_PX, clientY: 0 } },
        { coords: { clientX: BEAT_PX * 2, clientY: 0 } },
        { keys: '[/MouseLeft]' },
      ]);

      // Both shift by one beat — the group keeps its shape rather than collapsing
      // onto the grabbed note's tick.
      expect(events().map((e) => e.startTick)).toEqual(before.map((t) => t + PPQ));
    });

    it('carries the whole group across strings', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const ids = events().map((e) => e.id);
      const before = events().map((e) => e.stringIndex);
      await selectBoth(user, ids);

      // One row *down* the screen is one string *down* in pitch, i.e. index - 1.
      await user.pointer([
        { target: noteEl(ids[0]), keys: '[MouseLeft>]', coords: { clientX: 0, clientY: 0 } },
        { coords: { clientX: 0, clientY: ROW_PX } },
        { keys: '[/MouseLeft]' },
      ]);

      expect(events().map((e) => e.stringIndex)).toEqual(before.map((s) => s - 1));
    });

    it('collapses a group drag into one undo step', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const ids = events().map((e) => e.id);
      const before = events().map((e) => e.startTick);
      await selectBoth(user, ids);

      await user.pointer([
        { target: noteEl(ids[0]), keys: '[MouseLeft>]', coords: { clientX: 0, clientY: 0 } },
        { coords: { clientX: BEAT_PX / 2, clientY: 0 } },
        { coords: { clientX: BEAT_PX, clientY: 0 } },
        { coords: { clientX: BEAT_PX * 2, clientY: 0 } },
        { keys: '[/MouseLeft]' },
      ]);
      expect(events().map((e) => e.startTick)).not.toEqual(before);

      await user.click(screen.getByRole('button', { name: 'Undo' }));

      expect(events().map((e) => e.startTick)).toEqual(before);
      expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    });

    it('resizes every selected note by the same amount', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const ids = events().map((e) => e.id);
      await selectBoth(user, ids);

      // Drag the first note's right edge out to the two-beat mark: +1.5 beats.
      await user.pointer([
        { target: resizeEl(ids[0]), keys: '[MouseLeft>]', coords: { clientX: 24, clientY: 0 } },
        { coords: { clientX: BEAT_PX * 2, clientY: 0 } },
        { keys: '[/MouseLeft]' },
      ]);

      expect(events().map((e) => e.durationTicks)).toEqual([PPQ * 2, PPQ * 2]);
    });

    // The lib's own floor is a single tick, which would leave slivers behind.
    it('never shrinks a resized group below a sixteenth', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const ids = events().map((e) => e.id);
      await selectBoth(user, ids);

      // Drag the right edge far past the note's own start.
      await user.pointer([
        { target: resizeEl(ids[0]), keys: '[MouseLeft>]', coords: { clientX: 24, clientY: 0 } },
        { coords: { clientX: -400, clientY: 0 } },
        { keys: '[/MouseLeft]' },
      ]);

      expect(events().map((e) => e.durationTicks)).toEqual([PPQ / 4, PPQ / 4]);
    });

    it('toggles selection when the resize edge is shift-clicked', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const ids = events().map((e) => e.id);

      await user.pointer({ target: noteEl(ids[0]), keys: '[MouseLeft]' });
      await user.keyboard('{Shift>}');
      await user.pointer({ target: resizeEl(ids[1]), keys: '[MouseLeft]' });
      await user.keyboard('{/Shift}');

      expect(getSelectedIds()).toHaveLength(2);
    });
  });

  describe('grid resolution', () => {
    const setGrid = async (user: ReturnType<typeof userEvent.setup>, label: string) =>
      user.selectOptions(screen.getByRole('combobox', { name: 'Grid resolution' }), label);

    const stampAt = async (user: ReturnType<typeof userEvent.setup>, clientX: number) => {
      const lane = document.querySelector<HTMLElement>('[data-lane="E"]')!;
      await user.pointer({ target: lane, keys: '[MouseLeft]', coords: { clientX, clientY: 0 } });
      return events().find((e) => e.stringIndex === 0)!;
    };

    // jsdom gives every element a zero-origin rect, so clientX maps straight
    // onto ticks at the default 48px per beat: 48px === one quarter note.
    it('quantises a stamp to a sixteenth by default', async () => {
      const user = userEvent.setup();
      render(<Timeline />);

      const note = await stampAt(user, 20); // between the 1st and 2nd sixteenth

      expect(note.startTick % (PPQ / 4)).toBe(0);
    });

    it('quantises to a quarter when the grid is coarser', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      await setGrid(user, '1/4');

      const note = await stampAt(user, 60); // past the first beat

      expect(note.startTick).toBe(PPQ);
    });

    // The whole reason we don't use the lib's StepLength, which has no triplets.
    it('quantises to a triplet grid', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      await setGrid(user, '1/8T');

      const note = await stampAt(user, 20);

      expect(note.startTick % (PPQ / 3)).toBe(0);
    });

    it('places a note wherever you put it when the grid is off', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      await setGrid(user, 'Off');

      const note = await stampAt(user, 37); // deliberately off-grid

      expect(note.startTick % (PPQ / 4)).not.toBe(0);
    });

    // A stamped note fills one grid step, so the grid sets length as well.
    it('makes a stamped note one grid step long', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      await setGrid(user, '1/4');

      const note = await stampAt(user, 0);

      expect(note.durationTicks).toBe(PPQ);
    });
  });

  describe('keyboard fret entry', () => {
    const selectFirst = async (user: ReturnType<typeof userEvent.setup>) => {
      const target = events()[0];
      await user.pointer({ target: noteEl(target.id), keys: '[MouseLeft]' });
      return target.id;
    };

    it('sets the fret from a single typed digit', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const id = await selectFirst(user);

      await user.keyboard('7');

      expect(fretOf(id)).toBe(7);
    });

    it('accumulates two digits typed in quick succession', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const id = await selectFirst(user);

      await user.keyboard('12');

      expect(fretOf(id)).toBe(12);
    });

    // The whole point of the window: without it every fret above 9 would be
    // unreachable, and with no end to it consecutive frets would run together.
    it('starts a new number once the commit window has passed', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const id = await selectFirst(user);

      const before = fretOf(id);
      await user.keyboard('1');
      expect(fretOf(id)).toBe(1);

      // A real wait, not a fake clock: the timeline's playback engine keeps its
      // own timers running and stalls under a faked one. It is the only sleep in
      // the file, and only this behaviour needs one.
      await act(() => new Promise((resolve) => setTimeout(resolve, PAST_WINDOW_MS)));
      await user.keyboard('2');

      expect(fretOf(id)).toBe(2);

      // The other half of what the window is for: two numbers, two undo steps.
      await user.click(screen.getByRole('button', { name: 'Undo' }));
      expect(fretOf(id)).toBe(1);
      await user.click(screen.getByRole('button', { name: 'Undo' }));
      expect(fretOf(id)).toBe(before);
    });

    it('starts a fresh number once two digits complete one', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const id = await selectFirst(user);

      // "12" is a whole fret number, so the third digit can only be a new one —
      // no waiting out the window in between.
      await user.keyboard('123');

      expect(fretOf(id)).toBe(3);
    });

    it('clamps a typed fret to the top of the neck', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const id = await selectFirst(user);

      await user.keyboard('99');

      expect(fretOf(id)).toBe(24);
    });

    it('types the open string', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const id = await selectFirst(user);

      await user.keyboard('0');

      expect(fretOf(id)).toBe(0);
    });

    // Any non-digit closes the number, or a fret would go on accumulating
    // across the edits made between digits.
    it('ends a number in progress when another key is pressed', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const id = await selectFirst(user);
      const before = fretOf(id);

      await user.keyboard('1');
      await user.keyboard('{ArrowUp}'); // 1 → 2
      await user.keyboard('3');

      // 3, not 13: the arrow ended the number rather than being typed through.
      expect(fretOf(id)).toBe(3);

      // Three keystrokes, three undo steps — the nudge is not swallowed by the
      // gesture the first digit opened.
      const undoButton = screen.getByRole('button', { name: 'Undo' });
      await user.click(undoButton);
      expect(fretOf(id)).toBe(2);
      await user.click(undoButton);
      expect(fretOf(id)).toBe(1);
      await user.click(undoButton);
      expect(fretOf(id)).toBe(before);
    });

    // The lib returns the pattern untouched when an op changes nothing, which is
    // how the run tells a real edit from a retyped fret. Escape just ends the
    // number — nothing else handles it — so this needs no wait.
    it('records nothing when the typed fret is the one already there', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const id = await selectFirst(user);

      await user.keyboard(`${fretOf(id)}{Escape}`);

      expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    });

    it('records a step when the typed fret is a different one', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const id = await selectFirst(user);

      await user.keyboard(`${fretOf(id) + 1}{Escape}`);

      expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();
    });

    // A pointer edit landing inside the typing window used to begin a gesture
    // inside the typing one, and history keeps a single snapshot — so one of the
    // two edits disappeared from the undo stack.
    it('keeps a drag started mid-number as its own undo step', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const id = await selectFirst(user);
      const before = fretOf(id);
      const tick = events().find((e) => e.id === id)!.startTick;

      await user.keyboard('1');
      await user.pointer([
        { target: noteEl(id), keys: '[MouseLeft>]', coords: { clientX: 0, clientY: 0 } },
        { coords: { clientX: BEAT_PX, clientY: 0 } },
        { keys: '[/MouseLeft]' },
      ]);
      expect(events().find((e) => e.id === id)!.startTick).toBe(tick + PPQ);

      const undoButton = screen.getByRole('button', { name: 'Undo' });
      await user.click(undoButton);
      expect(events().find((e) => e.id === id)!.startTick).toBe(tick);
      expect(fretOf(id)).toBe(1);

      await user.click(undoButton);
      expect(fretOf(id)).toBe(before);
    });

    // The nastier half of the same bug: a number that changed nothing pushes no
    // snapshot of its own, so an edit made through the popup while it was open
    // went completely unrecorded.
    it('keeps a popup edit made mid-number as its own undo step', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const id = await selectFirst(user);
      const before = fretOf(id);

      await user.keyboard(`${before}`); // retyped: changes nothing
      await user.click(screen.getByRole('button', { name: 'Note options' }));
      await user.click(screen.getByRole('button', { name: 'Increase fret' }));
      expect(fretOf(id)).toBe(before + 1);

      await user.click(screen.getByRole('button', { name: 'Undo' }));
      expect(fretOf(id)).toBe(before);
    });

    it('does not carry digits across to a newly selected note', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const [first, second] = events();

      await user.pointer({ target: noteEl(first.id), keys: '[MouseLeft]' });
      await user.keyboard('1');
      await user.pointer({ target: noteEl(second.id), keys: '[MouseLeft]' });
      await user.keyboard('2');

      // 2, not 12 — and the first note keeps what was typed at it.
      expect(fretOf(second.id)).toBe(2);
      expect(fretOf(first.id)).toBe(1);
    });

    // The gesture a half-typed number holds open would otherwise outlive the
    // component, suppressing the undo snapshot of every later edit.
    it('closes a half-typed number when the timeline unmounts', async () => {
      const user = userEvent.setup();
      const { unmount } = render(<Timeline />);
      const id = await selectFirst(user);
      const before = fretOf(id);

      await user.keyboard('1');
      unmount();

      undo();
      expect(fretOf(id)).toBe(before);

      // ...and history still records, which it would not if the gesture were
      // still open.
      const count = events().length;
      stampNote({ stringIndex: 0, fret: 0, tick: 0 });
      expect(events()).toHaveLength(count + 1);
      undo();
      expect(events()).toHaveLength(count);
    });

    it('leaves the pattern alone when a digit arrives with nothing selected', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const before = events().map((e) => e.fret);

      await user.keyboard('7{ArrowUp}');

      expect(events().map((e) => e.fret)).toEqual(before);
      expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    });

    // ⚠ Same jsdom limit as the arrow test below: type-ahead is unobservable
    // here, so what's asserted is that the event was cancelled.
    it('cancels a digit so it can not reach the browser', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      await selectFirst(user);

      expect(fireEvent.keyDown(document.body, { key: '1' })).toBe(false);
    });

    it('types onto every note in a multi-selection', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const ids = events().map((e) => e.id);
      await selectBoth(user, ids);

      await user.keyboard('10');

      expect(events().map((e) => e.fret)).toEqual([10, 10]);
    });

    it('collapses a typed number into one undo step', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const ids = events().map((e) => e.id);
      const before = events().map((e) => e.fret);
      await selectBoth(user, ids);

      await user.keyboard('12');
      expect(events().map((e) => e.fret)).toEqual([12, 12]);

      // One click, not one per digit or one per selected note.
      await user.click(screen.getByRole('button', { name: 'Undo' }));

      expect(events().map((e) => e.fret)).toEqual(before);
      expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    });

    // Focus moving into a field is not a pointer press, so nothing else would
    // close the run — and while it is open every other edit's undo snapshot is
    // suppressed.
    it('ends a number when a keystroke goes into a field instead', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const id = await selectFirst(user);
      const before = fretOf(id);

      await user.keyboard('1');
      act(() => screen.getByRole('combobox', { name: 'Grid resolution' }).focus());
      await user.keyboard('{ArrowDown}');

      // Called directly: a click on the Undo button would close the run itself.
      undo();
      expect(fretOf(id)).toBe(before);
    });

    it('ignores digits typed into a field', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const id = await selectFirst(user);
      const before = fretOf(id);

      await user.click(screen.getByRole('combobox', { name: 'Grid resolution' }));
      await user.keyboard('7{ArrowUp}');

      expect(fretOf(id)).toBe(before);
    });
  });

  describe('arrow-key nudge', () => {
    it('moves the selected note a semitone', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const target = events()[0];
      await user.pointer({ target: noteEl(target.id), keys: '[MouseLeft]' });

      await user.keyboard('{ArrowUp}');
      expect(fretOf(target.id)).toBe(target.fret + 1);

      await user.keyboard('{ArrowDown}{ArrowDown}');
      expect(fretOf(target.id)).toBe(target.fret - 1);
    });

    it('moves an octave with shift held', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const ids = events().map((e) => e.id);
      const before = events().map((e) => e.fret);
      await selectBoth(user, ids);

      await user.keyboard('{Shift>}{ArrowUp}{/Shift}');

      expect(events().map((e) => e.fret)).toEqual(before.map((f) => f + 12));
    });

    it('nudges every note in a multi-selection', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const ids = events().map((e) => e.id);
      const before = events().map((e) => e.fret);
      await selectBoth(user, ids);

      await user.keyboard('{ArrowUp}');

      expect(events().map((e) => e.fret)).toEqual(before.map((f) => f + 1));
    });

    // The lib floors each note at 0 on its own, which would squash a spread
    // selection onto the nut. The group has to keep its shape.
    it('stops the whole selection at the nut without flattening it', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const ids = events().map((e) => e.id);
      await selectBoth(user, ids);

      // Seeded at frets 5 and 7, so an octave down is off the bottom.
      await user.keyboard('{Shift>}{ArrowDown}{/Shift}');

      expect(events().map((e) => e.fret)).toEqual([0, 2]);
    });

    // The mirror of the nut clamp. MAX_FRET is the app's rule, not the lib's —
    // the lib would happily push these to fret 29 and 31.
    it('stops the whole selection at the top of the neck without flattening it', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const ids = events().map((e) => e.id);
      await selectBoth(user, ids);

      // Seeded at 5 and 7: one octave up is 17 and 19, two is off the top.
      await user.keyboard('{Shift>}{ArrowUp}{ArrowUp}{/Shift}');

      expect(events().map((e) => e.fret)).toEqual([22, 24]);
    });

    it('collapses a nudge across a multi-selection into one undo step', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const ids = events().map((e) => e.id);
      const before = events().map((e) => e.fret);
      await selectBoth(user, ids);

      await user.keyboard('{ArrowUp}');
      await user.click(screen.getByRole('button', { name: 'Undo' }));

      expect(events().map((e) => e.fret)).toEqual(before);
      expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    });

    // ⚠ jsdom neither scrolls nor moves focus on an arrow key, so "the pane
    // didn't scroll" is unobservable here. Cancelling the event is what
    // prevents both in a real browser, so that is what's asserted —
    // `fireEvent` returns false when the handler called preventDefault.
    it('cancels the arrow key so it can not scroll the pane', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      await user.pointer({ target: noteEl(events()[0].id), keys: '[MouseLeft]' });

      expect(fireEvent.keyDown(document.body, { key: 'ArrowUp' })).toBe(false);
    });

    // Cmd/Ctrl+arrow is scroll-to-top and history navigation; nudging on it
    // would steal the shortcut *and* cancel it.
    it('leaves a modified arrow to the browser', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const target = events()[0];
      await user.pointer({ target: noteEl(target.id), keys: '[MouseLeft]' });

      expect(fireEvent.keyDown(document.body, { key: 'ArrowUp', ctrlKey: true })).toBe(true);
      expect(fretOf(target.id)).toBe(target.fret);
    });

    // The OS fires a keydown every few milliseconds while a key is held. One
    // undo step per repeat would bury the state the run started from.
    it('folds a held arrow key into a single undo step', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const target = events()[0];
      await user.pointer({ target: noteEl(target.id), keys: '[MouseLeft]' });

      // userEvent has no notion of auto-repeat, and `repeat` is exactly what
      // this collapses, so the run is dispatched directly.
      fireEvent.keyDown(document.body, { key: 'ArrowUp' });
      for (let i = 0; i < 4; i += 1) {
        fireEvent.keyDown(document.body, { key: 'ArrowUp', repeat: true });
      }
      fireEvent.keyUp(document.body, { key: 'ArrowUp' });
      expect(fretOf(target.id)).toBe(target.fret + 5);

      await user.click(screen.getByRole('button', { name: 'Undo' }));

      expect(fretOf(target.id)).toBe(target.fret);
      expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    });

    it('ignores arrows while a field has focus', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const target = events()[0];
      await user.pointer({ target: noteEl(target.id), keys: '[MouseLeft]' });

      await user.click(screen.getByRole('combobox', { name: 'Grid resolution' }));
      await user.keyboard('{ArrowUp}');

      expect(fretOf(target.id)).toBe(target.fret);
    });
  });

  /**
   * jsdom has no layout, so the auto-scroll has nothing to be near: every box is
   * 0x0 and `edgeScrollSpeed` correctly refuses to move. `rigScroller` hands the
   * loop a geometry instead — a 400px window onto 1200px of content — which is
   * enough to observe all of it: `scrollLeft` is a plain stored property here,
   * and the lanes' box is what `tickAt` measures against, so sliding that box
   * left by `scrollLeft` is precisely what a real scroll does to it.
   *
   * ⚠ Browser-only, and deliberately not faked: the real engine deciding those
   * numbers — actual layout, the browser's own scroll clamping, and native touch
   * panning (which `touch-none` on a note exists to prevent).
   */
  describe('drag-edge auto-scroll', () => {
    const tickOf = (id: string) => events().find((e) => e.id === id)!.startTick;
    /** Just inside the right-hand edge zone of the rigged well. */
    const AT_EDGE = WELL_W - 5;

    it('scrolls the view while the pointer holds the edge', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const rig = rigScroller();
      const id = events()[0].id;

      await user.pointer([
        { target: noteEl(id), keys: '[MouseLeft>]', coords: { clientX: 10, clientY: 0 } },
        { coords: { clientX: AT_EDGE, clientY: 0 } },
      ]);
      // The pointer never moves again: everything below is the loop's doing.
      rig.step(50);
      rig.step(50);

      expect(rig.scrollLeft()).toBeGreaterThan(0);

      await user.pointer({ keys: '[/MouseLeft]' });
    });

    it('keeps the dragged note under a pointer that is standing still', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const rig = rigScroller();
      const id = events()[0].id;

      await user.pointer([
        { target: noteEl(id), keys: '[MouseLeft>]', coords: { clientX: 10, clientY: 0 } },
        { coords: { clientX: AT_EDGE, clientY: 0 } },
      ]);
      const held = tickOf(id);
      rig.step(50);
      rig.step(50);

      // The drag re-derives itself from the pointer's position in *content*
      // space, so the lanes sliding underneath a stationary pointer is a later
      // tick. A delta-based drag would compute zero here and stick.
      expect(tickOf(id)).toBeGreaterThan(held);

      await user.pointer({ keys: '[/MouseLeft]' });
    });

    it('grows the marquee onto notes the view had not reached', async () => {
      const user = userEvent.setup();
      // Twelve beats in — 576px at the default zoom, well past the 400px well.
      stampNote({ stringIndex: 0, fret: 3, tick: PPQ * 12, durationTicks: PPQ / 2 });
      clearHistory();
      const far = events().find((e) => e.startTick === PPQ * 12)!.id;
      render(<Timeline />);
      const rig = rigScroller();
      const lane = document.querySelector<HTMLElement>('[data-lane="E"]')!;

      await user.pointer([
        { target: lane, keys: '[MouseLeft>]', coords: { clientX: 5, clientY: 10 } },
        { target: lane, coords: { clientX: AT_EDGE, clientY: 50 } },
      ]);
      expect(getSelectedIds()).not.toContain(far);

      for (let i = 0; i < 6; i += 1) rig.step(50);

      // The band is anchored in content space, so it keeps growing rather than
      // sliding along with the view — and it hit-tests what it has grown over.
      expect(rig.scrollLeft()).toBeGreaterThan(0);
      expect(getSelectedIds()).toContain(far);

      await user.pointer({ keys: '[/MouseLeft]' });
    });

    it('stops when the pointer comes back inside', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const rig = rigScroller();
      const id = events()[0].id;

      await user.pointer([
        { target: noteEl(id), keys: '[MouseLeft>]', coords: { clientX: 10, clientY: 0 } },
        { coords: { clientX: AT_EDGE, clientY: 0 } },
      ]);
      rig.step(50);
      await user.pointer({ coords: { clientX: 200, clientY: 0 } });

      const at = rig.scrollLeft();
      rig.step(50);
      rig.step(50);

      expect(at).toBeGreaterThan(0); // it really had been moving
      expect(rig.scrollLeft()).toBe(at);
      expect(rig.scheduled()).toBe(0); // and the loop isn't idling either

      await user.pointer({ keys: '[/MouseLeft]' });
    });

    it('stops when the pointer is released', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const rig = rigScroller();
      const id = events()[0].id;

      await user.pointer([
        { target: noteEl(id), keys: '[MouseLeft>]', coords: { clientX: 10, clientY: 0 } },
        { coords: { clientX: AT_EDGE, clientY: 0 } },
      ]);
      rig.step(50);
      await user.pointer({ keys: '[/MouseLeft]' });

      const at = rig.scrollLeft();
      rig.step(50);

      expect(rig.scheduled()).toBe(0);
      expect(rig.scrollLeft()).toBe(at);
    });

    // The browser can take the pointer away without ever sending pointerup — a
    // touch handed to a native scroll, an OS gesture — and the view would
    // otherwise keep travelling with nothing driving it.
    it('stops when the pointer is taken away', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const rig = rigScroller();
      const id = events()[0].id;

      await user.pointer([
        { target: noteEl(id), keys: '[MouseLeft>]', coords: { clientX: 10, clientY: 0 } },
        { coords: { clientX: AT_EDGE, clientY: 0 } },
      ]);
      rig.step(50);
      fireEvent(window, new Event('pointercancel'));

      const at = rig.scrollLeft();
      rig.step(50);

      expect(rig.scheduled()).toBe(0);
      expect(rig.scrollLeft()).toBe(at);
    });

    it('leaves the view alone for a press that never became a drag', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const rig = rigScroller();
      const id = events()[0].id;

      // Held inside the edge zone the whole time, but never moved past the slop.
      await user.pointer([
        { target: noteEl(id), keys: '[MouseLeft>]', coords: { clientX: AT_EDGE, clientY: 0 } },
        { coords: { clientX: AT_EDGE + 1, clientY: 0 } },
      ]);
      rig.step(50);
      rig.step(50);

      expect(rig.scrollLeft()).toBe(0);
      expect(rig.scheduled()).toBe(0);

      await user.pointer({ keys: '[/MouseLeft]' });
    });

    // A drag through the middle of the well pays a forced layout every frame for
    // a speed that is always zero, on top of whatever the drag itself costs.
    it('runs no loop at all while the pointer is clear of both edges', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const rig = rigScroller();
      const id = events()[0].id;

      await user.pointer([
        { target: noteEl(id), keys: '[MouseLeft>]', coords: { clientX: 100, clientY: 0 } },
        { coords: { clientX: 200, clientY: 0 } },
      ]);

      expect(rig.scheduled()).toBe(0);

      await user.pointer({ keys: '[/MouseLeft]' });
    });

    // Content ends where the pattern does — it is bar-rounded to fit its notes —
    // so a drag held at the edge runs to the last bar and settles there. Growing
    // the pattern by dragging past its end is a separate feature; see
    // docs/FOLLOW-UPS.md.
    it('comes to rest at the end of the content', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const rig = rigScroller();
      const id = events()[0].id;

      await user.pointer([
        { target: noteEl(id), keys: '[MouseLeft>]', coords: { clientX: 10, clientY: 0 } },
        { coords: { clientX: AT_EDGE, clientY: 0 } },
      ]);
      for (let i = 0; i < 30; i += 1) rig.step(50);

      expect(rig.scrollLeft()).toBe(MAX_SCROLL);
      // And no remainder piled up while it sat there, which would lurch the
      // moment the drag turned around.
      rig.step(50);
      expect(rig.scrollLeft()).toBe(MAX_SCROLL);

      await user.pointer({ keys: '[/MouseLeft]' });
    });

    // ⚠ The hook's own unmount cleanup can't be told apart from the gesture
    // teardown from out here: unmounting runs both, and either one alone stops
    // the loop. It is there for the case neither test nor browser can stage —
    // the component going away while the gesture's window listeners live on.
    it('stops its loop when the timeline unmounts mid-drag', async () => {
      const user = userEvent.setup();
      const { unmount } = render(<Timeline />);
      const rig = rigScroller();
      const id = events()[0].id;

      await user.pointer([
        { target: noteEl(id), keys: '[MouseLeft>]', coords: { clientX: 10, clientY: 0 } },
        { coords: { clientX: AT_EDGE, clientY: 0 } },
      ]);
      expect(rig.scheduled()).toBeGreaterThan(0);

      unmount();

      expect(rig.scheduled()).toBe(0);
    });
  });
});

/**
 * The whole decision — "given the pointer, the well and a threshold, how fast?"
 * — lives here precisely because jsdom can't observe the scrolling itself.
 *
 * A 400px-wide well at x=100..500 with a 50px edge zone, so the left zone is
 * 100..150 and the right one 450..500.
 */
describe('edgeScrollSpeed', () => {
  const WELL = { left: 100, right: 500 };
  const ZONE = 50;
  const speed = (x: number, box = WELL) => edgeScrollSpeed(x, box, ZONE);

  it('leaves the view alone while the pointer is clear of both edges', () => {
    expect(speed(300)).toBe(0);
    // The threshold itself is not yet inside the zone, at either end.
    expect(speed(150)).toBe(0);
    expect(speed(450)).toBe(0);
  });

  it('scrolls towards whichever edge the pointer is near', () => {
    expect(speed(140)).toBeLessThan(0);
    expect(speed(460)).toBeGreaterThan(0);
  });

  // A dead zone at the threshold would be indistinguishable from not scrolling
  // at all: at the bottom of the quadratic ramp the speed is 0.48px/s, which
  // takes two seconds to move a single pixel. The floor is what makes crossing
  // the threshold visible, so it's the floor that gets asserted.
  it('starts moving the moment the threshold is crossed', () => {
    expect(Math.abs(speed(149))).toBeGreaterThanOrEqual(MIN_SPEED);
    expect(stepFor(MIN_SPEED, 1 / 60, 0).step).toBeGreaterThanOrEqual(1);
  });

  // Every case above names its own zone; this is the one the app actually runs
  // with, so a change to the default doesn't slip through unnoticed.
  it('defaults to a 48px zone', () => {
    expect(edgeScrollSpeed(452, WELL)).toBe(0);
    expect(edgeScrollSpeed(453, WELL)).toBeGreaterThan(0);
  });

  it('accelerates the deeper into the zone the pointer goes', () => {
    const depths = [149, 140, 125, 110, 100].map((x) => Math.abs(speed(x)));
    for (let i = 1; i < depths.length; i += 1) {
      expect(depths[i]).toBeGreaterThan(depths[i - 1]);
    }
  });

  // Dragging to the edge of the *window* is already as fast as it goes; without
  // the clamp a pointer dragged outside it would accelerate without limit.
  it('tops out at the viewport edge rather than running away off-screen', () => {
    expect(speed(-900)).toBe(speed(100));
    expect(speed(5000)).toBe(speed(500));
  });

  it('treats the two edges as mirror images', () => {
    for (const depth of [1, 10, 49, 50, 200]) {
      expect(speed(150 - depth)).toBe(-speed(450 + depth));
    }
  });

  // Two 50px zones don't fit in a 60px well. Left half and right half, then —
  // rather than a pointer in the middle counting as "near" both at once.
  it('splits a well too narrow for two zones down the middle', () => {
    const narrow = { left: 100, right: 160 };
    expect(speed(130, narrow)).toBe(0);
    expect(speed(129, narrow)).toBeLessThan(0);
    expect(speed(131, narrow)).toBeGreaterThan(0);
  });

  // Which is exactly what jsdom reports for every element, so the hook's loop
  // spins harmlessly rather than dividing by a zero-width well.
  it('never scrolls a well that has no measured width', () => {
    expect(edgeScrollSpeed(0, { left: 0, right: 0 }, ZONE)).toBe(0);
    expect(edgeScrollSpeed(-50, { left: 0, right: 0 }, ZONE)).toBe(0);
  });

  // No production caller passes this, but the parameter is public and a zero
  // zone divides by zero — which reads as "infinitely deep", i.e. full speed
  // everywhere rather than nowhere.
  it('never scrolls when the zone has no depth', () => {
    expect(edgeScrollSpeed(300, WELL, 0)).toBe(0);
    expect(edgeScrollSpeed(100, WELL, 0)).toBe(0);
    expect(edgeScrollSpeed(-900, WELL, 0)).toBe(0);
  });
});

/**
 * The other half of the decision: a speed only becomes travel once a frame has
 * a length. Also pure, for the same reason — the loop that calls it can only be
 * watched in a browser.
 */
describe('stepFor', () => {
  const FRAME = 1 / 60;

  it('travels the distance the speed asks for', () => {
    expect(stepFor(1200, 0.05, 0).step).toBe(60);
    expect(stepFor(-1200, 0.05, 0).step).toBe(-60);
  });

  // scrollLeft is integral in some engines, so a fractional step rounds away to
  // nothing — and the slowest speeds would sit perfectly still forever.
  it('carries sub-pixel travel forward instead of dropping it', () => {
    const first = stepFor(30, FRAME, 0);
    expect(first.step).toBe(0);
    expect(first.carry).toBeCloseTo(0.5);

    const second = stepFor(30, FRAME, first.carry);
    expect(second.step).toBe(1);
    expect(Math.abs(second.carry)).toBeLessThan(1);
  });

  // A frame that took ten seconds means the tab was backgrounded, not that the
  // user dragged for ten seconds — coming back must not fling the view.
  it('clamps a frame that was really the tab being away', () => {
    expect(stepFor(1000, 10, 0).step).toBe(50);
    expect(stepFor(1000, 10, 0)).toEqual(stepFor(1000, 0.05, 0));
  });

  it('treats a frame that took no time — or negative time — as no travel', () => {
    expect(stepFor(1000, 0, 0)).toEqual({ step: 0, carry: 0 });
    expect(stepFor(1000, -1, 0)).toEqual({ step: 0, carry: 0 });
  });
});
