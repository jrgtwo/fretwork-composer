import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PPQ } from '@fretwork/lib';
import { NotePopup } from '../src/timeline/NotePopup';
import {
  clearHistory,
  getEditingPattern,
  openBlankPattern,
  stampNote,
} from '../src/patterns/patternService';
import { readPitchSpec } from '../src/patterns/articulations';

const note = () => getEditingPattern()!.events[0];
const show = () => {
  const user = userEvent.setup();
  const result = render(<NotePopup event={note()} pitchName="D" onClose={() => {}} />);
  // The popup takes the event as a prop, so re-render after each edit.
  const refresh = () =>
    result.rerender(<NotePopup event={note()} pitchName="D" onClose={() => {}} />);
  return { user, refresh };
};

beforeEach(() => {
  openBlankPattern('Test');
  stampNote({ stringIndex: 4, fret: 5, tick: 0, durationTicks: PPQ });
  clearHistory();
});

describe('NotePopup', () => {
  it('changes the fret', async () => {
    const { user } = show();

    await user.click(screen.getByRole('button', { name: 'Increase Fret' }));

    expect(note().fret).toBe(6);
  });

  // Articulations are independent fields in the lib — several can be on at once.
  it('turns on several techniques together', async () => {
    const { user, refresh } = show();

    await user.click(screen.getByRole('button', { name: 'P.Mute' }));
    refresh();
    await user.click(screen.getByRole('button', { name: 'Ghost' }));
    refresh();

    expect(note().palmMute).toBe(true);
    expect(note().ghost).toBe(true);
  });

  it('toggles a technique back off', async () => {
    const { user, refresh } = show();

    await user.click(screen.getByRole('button', { name: 'Tap' }));
    refresh();
    expect(note().tap).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Tap' }));
    expect(note().tap).toBeUndefined();
  });

  it('sets vibrato and swaps intensity', async () => {
    const { user, refresh } = show();

    await user.click(screen.getByRole('button', { name: 'slight' }));
    refresh();
    expect(note().vibrato).toBe('slight');

    await user.click(screen.getByRole('button', { name: 'wide' }));
    expect(note().vibrato).toBe('wide');
  });

  describe('pitch movement', () => {
    it('adds a slide into the note', async () => {
      const { user } = show();

      await user.click(screen.getByRole('button', { name: 'Slide in' }));

      expect(readPitchSpec(note()).in).toEqual({ semitones: -2, at: 0.15 });
    });

    it('controls which side the movement is on — in and out together', async () => {
      const { user, refresh } = show();

      await user.click(screen.getByRole('button', { name: 'Slide in' }));
      refresh();
      await user.click(screen.getByRole('button', { name: 'Slide out' }));

      const pitch = readPitchSpec(note());
      expect(pitch.in).toBeDefined();
      expect(pitch.out).toBeDefined();
    });

    it('resizes how long the slide takes', async () => {
      const { user, refresh } = show();
      await user.click(screen.getByRole('button', { name: 'Slide in' }));
      refresh();

      await user.click(screen.getByRole('button', { name: 'Increase len' }));

      expect(readPitchSpec(note()).in!.at).toBeCloseTo(0.2);
    });

    it('positions a bend within the note', async () => {
      const { user, refresh } = show();
      await user.click(screen.getByRole('button', { name: 'Bend' }));
      refresh();

      await user.click(screen.getByRole('button', { name: 'Increase start' }));

      const bend = readPitchSpec(note()).bend!;
      expect(bend.start).toBeCloseTo(0.15);
    });

    it('releases a bend back to pitch', async () => {
      const { user, refresh } = show();
      await user.click(screen.getByRole('button', { name: 'Bend' }));
      refresh();

      await user.click(screen.getByRole('button', { name: 'Release' }));

      expect(readPitchSpec(note()).bend!.release).toBe(true);
    });

    it('clears all pitch movement', async () => {
      const { user, refresh } = show();
      await user.click(screen.getByRole('button', { name: 'Slide in' }));
      refresh();

      await user.click(screen.getByRole('button', { name: 'Clear pitch' }));

      expect(readPitchSpec(note())).toEqual({
        in: undefined,
        out: undefined,
        bend: undefined,
      });
    });

    it('warns that a bend and a slide share one pitch line', async () => {
      const { user, refresh } = show();
      await user.click(screen.getByRole('button', { name: 'Slide in' }));
      refresh();
      await user.click(screen.getByRole('button', { name: 'Bend' }));
      refresh();

      expect(screen.getByText(/share one pitch line/)).toBeInTheDocument();
    });
  });
});
