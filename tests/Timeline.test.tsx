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
const events = () => getEditingPattern()!.events;

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
});
