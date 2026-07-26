import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PPQ } from '@fretwork/lib';
import { NotePopup } from '../src/timeline/NotePopup';
import {
  clearHistory,
  getEditingPattern,
  openBlankPattern,
  setArticulations,
  stampNote,
} from '../src/patterns/patternService';
import { readNotePitch } from '../src/patterns/articulations';

const note = () => getEditingPattern()!.events[0];
const pitch = () => readNotePitch(note());

const show = () => {
  const user = userEvent.setup();
  const props = () => ({
    event: note(),
    events: getEditingPattern()!.events,
    pitchName: 'D',
    onClose: () => {},
  });
  const result = render(<NotePopup {...props()} />);
  // The popup takes the event as a prop, so re-render after each edit.
  const refresh = () => result.rerender(<NotePopup {...props()} />);
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
    await user.click(screen.getByRole('button', { name: 'Increase fret' }));
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

  describe('slides', () => {
    it('slides into the note from below', async () => {
      const { user } = show();
      await user.click(screen.getByRole('button', { name: '↗ below' }));
      expect(pitch().slideIn).toBe('below');
    });

    it('slides out of the note downward', async () => {
      const { user } = show();
      await user.click(screen.getByRole('button', { name: 'out ↘' }));
      expect(pitch().slideOut).toBe('down');
    });

    it('keeps slide in and slide out independent', async () => {
      const { user, refresh } = show();

      await user.click(screen.getByRole('button', { name: '↗ below' }));
      refresh();
      await user.click(screen.getByRole('button', { name: 'out ↗' }));

      expect(pitch()).toMatchObject({ slideIn: 'below', slideOut: 'up' });
    });

    it('swaps direction rather than stacking', async () => {
      const { user, refresh } = show();

      await user.click(screen.getByRole('button', { name: '↗ below' }));
      refresh();
      await user.click(screen.getByRole('button', { name: '↘ above' }));

      expect(pitch().slideIn).toBe('above');
    });

    it('turns a slide off by picking it again', async () => {
      const { user, refresh } = show();

      await user.click(screen.getByRole('button', { name: '↗ below' }));
      refresh();
      await user.click(screen.getByRole('button', { name: '↗ below' }));

      expect(pitch().slideIn).toBeUndefined();
    });
  });

  describe('bends', () => {
    it('bends the note, defaulting to a full step', async () => {
      const { user } = show();
      await user.click(screen.getByRole('button', { name: '⤴ bend' }));
      expect(pitch().bend).toEqual({ kind: 'bend', semitones: 2 });
    });

    it('changes the bend depth in musical steps', async () => {
      const { user, refresh } = show();
      await user.click(screen.getByRole('button', { name: '⤴ bend' }));
      refresh();

      await user.click(screen.getByRole('button', { name: '1½' }));

      expect(pitch().bend!.semitones).toBe(3);
    });

    it('bends and releases', async () => {
      const { user } = show();
      await user.click(screen.getByRole('button', { name: '⤴⤵ release' }));
      expect(pitch().bend!.kind).toBe('bend-release');
    });

    it('only offers depth once a bend is on', async () => {
      const { refresh } = show();
      expect(screen.queryByRole('button', { name: '1½' })).not.toBeInTheDocument();
      refresh();
    });

    it('warns when a bend and a slide would blend', async () => {
      const { user, refresh } = show();
      await user.click(screen.getByRole('button', { name: '↗ below' }));
      refresh();
      await user.click(screen.getByRole('button', { name: '⤴ bend' }));
      refresh();

      expect(screen.getByText(/share one pitch line/)).toBeInTheDocument();
    });

    // A bend plus a slide can't be stored in the typed fields — it falls back
    // to an explicit curve, and has to survive the round trip.
    it('keeps both when a bend and a slide are combined', async () => {
      const { user, refresh } = show();
      await user.click(screen.getByRole('button', { name: '↗ below' }));
      refresh();
      await user.click(screen.getByRole('button', { name: '⤴ bend' }));

      expect(pitch()).toMatchObject({ slideIn: 'below', bend: { kind: 'bend' } });
    });
  });

  describe('ties', () => {
    // The lib only merges a tie when the next note is adjacent, same string,
    // same fret. Offering it otherwise would look like it worked and do nothing.
    it('is unavailable with no adjacent note to tie to', () => {
      show();
      expect(screen.getByRole('button', { name: '⌒ tie' })).toBeDisabled();
      expect(screen.getByText('no adjacent note')).toBeInTheDocument();
    });

    it('is available once a note starts exactly where this one ends', () => {
      stampNote({ stringIndex: 4, fret: 5, tick: PPQ, durationTicks: PPQ });
      show();
      expect(screen.getByRole('button', { name: '⌒ tie' })).toBeEnabled();
    });

    it('stays unavailable when the next note is a different fret', () => {
      stampNote({ stringIndex: 4, fret: 7, tick: PPQ, durationTicks: PPQ });
      show();
      expect(screen.getByRole('button', { name: '⌒ tie' })).toBeDisabled();
    });

    it('ties to the next note', async () => {
      stampNote({ stringIndex: 4, fret: 5, tick: PPQ, durationTicks: PPQ });
      const { user } = show();

      await user.click(screen.getByRole('button', { name: '⌒ tie' }));

      expect(note().tieToNext).toBe(true);
    });

    // Tied notes merge into one, so anything expressive on the follower is
    // dropped — including the "tie a note on to add vibrato" idea.
    it('warns that the tied note\'s articulations will not sound', async () => {
      stampNote({ stringIndex: 4, fret: 5, tick: PPQ, durationTicks: PPQ });
      const follower = getEditingPattern()!.events.find((e) => e.startTick === PPQ)!;
      setArticulations(follower.id, { vibrato: 'wide' });

      const { user, refresh } = show();
      await user.click(screen.getByRole('button', { name: '⌒ tie' }));
      refresh();

      expect(screen.getByText(/won't sound/)).toBeInTheDocument();
    });
  });

  it('clears all pitch movement', async () => {
    const { user, refresh } = show();
    await user.click(screen.getByRole('button', { name: '↗ below' }));
    refresh();

    await user.click(screen.getByRole('button', { name: 'Clear pitch' }));

    expect(pitch()).toEqual({});
  });
});
