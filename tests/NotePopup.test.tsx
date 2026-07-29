import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PPQ, mapImportToLibrary, type DynamicMark } from '@fretwork/lib';
import { NotePopup } from '../src/timeline/NotePopup';
import { Timeline } from '../src/timeline/Timeline';
import {
  clearHistory,
  getEditingPattern,
  openBlankPattern,
  redo,
  setArticulations,
  setNoteDynamic,
  stampNote,
  undo,
  DYNAMICS,
} from '../src/patterns/patternService';
import { readNotePitch } from '../src/patterns/articulations';

/**
 * The dynamic → velocity curve, spelled out a third time on purpose.
 *
 * The service's copy exists only to match the lib's private one (LIB-GAP(5)).
 * A test that read the service's constant would pass no matter what either of
 * them said; written out here, a change to the service fails the popup tests
 * and a change to the lib fails the drift test below.
 */
const CURVE: Record<DynamicMark, number> = {
  ppp: 0.08,
  pp: 0.18,
  p: 0.32,
  mp: 0.5,
  mf: 0.65,
  f: 0.8,
  ff: 0.92,
  fff: 1.0,
};

/** The 5th fret of stringIndex 4 — whatever the lib says it sounds. */
const TIMELINE_PITCH = 'E';

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

  // `dynamic` is display-only in the lib and `velocity` is what the engine
  // reads, so every one of these asserts on both fields — a label that doesn't
  // match what plays is the whole failure mode.
  describe('dynamics', () => {
    it.each(Object.entries(CURVE))('writes %s as velocity %d', async (mark, velocity) => {
      const { user } = show();

      await user.click(screen.getByRole('button', { name: mark }));

      expect(note().dynamic).toBe(mark);
      expect(note().velocity).toBe(velocity);
    });

    it('labels the mark it just wrote, and says so when there is none', async () => {
      const { user, refresh } = show();
      expect(screen.getByText(/unset — plays at full/)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'mf' }));
      refresh();

      expect(screen.getByText(/mezzo-forte/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'mf' })).toHaveAttribute('aria-pressed', 'true');
      const others = DYNAMICS.filter((m) => m !== 'mf');
      for (const mark of others) {
        expect(screen.getByRole('button', { name: mark })).toHaveAttribute('aria-pressed', 'false');
      }
    });

    // Nothing in the app writes velocity without a mark, but an imported or
    // persisted pattern carries one — and claiming "plays at full" would then
    // contradict both the timeline's bar and playback.
    it('reports a velocity that arrived without a mark', () => {
      setArticulations(note().id, { velocity: 0.42 });
      show();

      expect(screen.queryByText(/unset — plays at full/)).not.toBeInTheDocument();
      expect(screen.getByText(/42% — no mark/)).toBeInTheDocument();
    });

    it('swaps to another mark rather than stacking', async () => {
      const { user, refresh } = show();

      await user.click(screen.getByRole('button', { name: 'pp' }));
      refresh();
      await user.click(screen.getByRole('button', { name: 'ff' }));

      expect(note().dynamic).toBe('ff');
      expect(note().velocity).toBe(0.92);
    });

    it('clears both fields when the same mark is picked again', async () => {
      const { user, refresh } = show();

      await user.click(screen.getByRole('button', { name: 'ppp' }));
      refresh();
      await user.click(screen.getByRole('button', { name: 'ppp' }));

      expect(note().dynamic).toBeUndefined();
      expect(note().velocity).toBeUndefined();
    });

    it('survives undo', async () => {
      const { user } = show();
      await user.click(screen.getByRole('button', { name: 'f' }));

      undo();

      expect(note().dynamic).toBeUndefined();
      expect(note().velocity).toBeUndefined();

      redo();

      expect(note().dynamic).toBe('f');
      expect(note().velocity).toBe(0.8);
    });

    // The swap is where a stale capture would show: undo has to land on the
    // previous mark, not on nothing.
    it('undoes a swap back to the mark before it', async () => {
      const { user, refresh } = show();

      await user.click(screen.getByRole('button', { name: 'pp' }));
      refresh();
      await user.click(screen.getByRole('button', { name: 'ff' }));

      undo();

      expect(note().dynamic).toBe('pp');
      expect(note().velocity).toBe(0.18);
    });

    // Lives here rather than in Timeline.test.tsx because it's the other half of
    // the same story: what the popup writes has to show up on the note.
    it('shows on the note in the timeline, and only once set', async () => {
      const { user } = show();
      render(<Timeline />);
      expect(document.querySelector('[data-velocity]')).toBeNull();

      await user.click(screen.getByRole('button', { name: 'mf' }));

      const bar = document.querySelector<HTMLElement>('[data-velocity]');
      expect(bar).not.toBeNull();
      // jsdom has no layout, so the proportion is only assertable as the style
      // we asked for — not as a measured width.
      expect(bar!.style.width).toBe('65%');
      expect(screen.getByTitle(`Fret 5 · ${TIMELINE_PITCH} · mf`)).toBeInTheDocument();
    });

    // A tied follower is skipped at playback, so its dynamic never sounds. The
    // popup warns about the fields that vanish; this is one of them.
    it('warns that a tied note\'s dynamic will not sound', async () => {
      stampNote({ stringIndex: 4, fret: 5, tick: PPQ, durationTicks: PPQ });
      const follower = getEditingPattern()!.events.find((e) => e.startTick === PPQ)!;
      setNoteDynamic(follower.id, 'ppp');

      const { user, refresh } = show();
      await user.click(screen.getByRole('button', { name: '⌒ tie' }));
      refresh();

      expect(screen.getByText(/dynamic won't sound/)).toBeInTheDocument();
    });

    // LIB-GAP(5): DYNAMIC_VELOCITY is a copy of the importer's private
    // `dynamicToVelocity`. Nothing else would notice if the lib retuned it, so
    // this drives each mark through the public importer — the one path that does
    // call that function — and checks it still agrees with the table above.
    it('matches the curve the lib\'s own importer applies', () => {
      const marks = Object.keys(CURVE) as DynamicMark[];
      const { patterns } = mapImportToLibrary({
        ir: {
          meta: { sourceFormat: 'midi' },
          ticksPerQuarter: PPQ,
          totalTicks: PPQ * marks.length,
          tempos: [],
          timeSignatures: [],
          keySignatures: [],
          sections: [],
          tracks: [
            {
              id: 't1',
              name: 'Guitar',
              instrumentHint: 'guitar',
              events: marks.map((dynamic, i) => ({
                atTick: PPQ * i,
                durationTicks: PPQ,
                dynamic,
                notes: [{ string: 0, fret: i }],
              })),
            },
          ],
        },
        selectedTrackId: 't1',
        topology: 'single-pattern',
      });

      const imported = patterns[0].events;
      expect(imported).toHaveLength(marks.length);
      expect(imported.map((e) => [e.dynamic, e.velocity])).toEqual(Object.entries(CURVE));
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
