import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PPQ } from '@fretwork/lib';
import { Timeline } from '../src/timeline/Timeline';
import {
  clearHistory,
  getEditingPattern,
  getSelectedIds,
  openBlankPattern,
  stampNote,
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

async function selectBoth(user: ReturnType<typeof userEvent.setup>, ids: string[]) {
  await user.pointer({ target: noteEl(ids[0]), keys: '[MouseLeft]' });
  await user.keyboard('{Shift>}');
  await user.pointer({ target: noteEl(ids[1]), keys: '[MouseLeft]' });
  await user.keyboard('{/Shift}');
}

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
});
