import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PPQ } from '@fretwork/lib';

// jsdom has no Web Audio, so the engine is replaced wholesale — these tests
// assert the timeline's wiring to the contract, never that anything sounds.
vi.mock('../src/audio/playbackService', () => ({
  usePlaybackEngine: vi.fn(),
  play: vi.fn(() => Promise.resolve()),
  stop: vi.fn(),
  useIsPlaying: vi.fn(() => false),
  useHeadTick: vi.fn((): number | null => null),
  useActiveEventIds: vi.fn((): readonly string[] => []),
  useClickMuted: vi.fn(() => false),
  toggleClick: vi.fn(),
  useTempo: vi.fn(() => 80),
  setTempo: vi.fn(),
}));

// The follow-scroll loop's only observable act under jsdom is this read, so it
// is replaced with a countable one. Everything else in the lib is kept.
//
// Mocks the lib directly now: `getTransportTicks` stopped throwing without an
// AudioContext (LIB-GAP(3a)), so the local `readTransportTicks` wrapper that used to
// guard it is gone and callers read the lib.
vi.mock('@fretwork/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fretwork/lib')>()),
  getTransportTicks: vi.fn(() => 0),
}));

import { Timeline } from '../src/timeline/Timeline';
import { getTransportTicks } from '@fretwork/lib';
import { installFrameClock } from './frameClock';
import {
  play,
  stop,
  useActiveEventIds,
  useHeadTick,
  useIsPlaying,
  usePlaybackEngine,
  useClickMuted,
  toggleClick,
  setTempo,
} from '../src/audio/playbackService';
import {
  clearHistory,
  getEditingPattern,
  openBlankPattern,
  stampNote,
} from '../src/patterns/patternService';

function seedTwoNotes() {
  openBlankPattern('Transport');
  stampNote({ stringIndex: 4, fret: 5, tick: 0, durationTicks: PPQ / 2 });
  stampNote({ stringIndex: 2, fret: 7, tick: PPQ, durationTicks: PPQ / 2 });
  clearHistory(); // loading a pattern is not an undoable edit
}

const noteEl = (id: string) => document.querySelector<HTMLElement>(`[data-note="${id}"]`)!;
const events = () => getEditingPattern()!.events;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useIsPlaying).mockReturnValue(false);
  vi.mocked(useHeadTick).mockReturnValue(null);
  vi.mocked(useActiveEventIds).mockReturnValue([]);
  seedTwoNotes();
});

describe('Timeline transport', () => {
  it('reads Play when stopped and starts playback when clicked', async () => {
    const user = userEvent.setup();
    render(<Timeline />);

    await user.click(screen.getByRole('button', { name: 'Play' }));

    expect(play).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it('reads Stop while playing and halts playback when clicked', async () => {
    const user = userEvent.setup();
    vi.mocked(useIsPlaying).mockReturnValue(true);
    render(<Timeline />);

    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop' }));

    expect(stop).toHaveBeenCalledTimes(1);
    expect(play).not.toHaveBeenCalled();
  });

  it('takes its label from the engine rather than from the click', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Timeline />);

    // The button keeps no transport state of its own, so a stop that originates
    // in the engine — pattern end, a failed AudioContext — still flips it back.
    await user.click(screen.getByRole('button', { name: 'Play' }));
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();

    vi.mocked(useIsPlaying).mockReturnValue(true);
    rerender(<Timeline />);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();

    vi.mocked(useIsPlaying).mockReturnValue(false);
    rerender(<Timeline />);
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });

  it('mounts the engine lifecycle', () => {
    render(<Timeline />);
    // Nothing else in the app calls it; without this the seam never receives a
    // metronome and every play() is a silent no-op.
    expect(usePlaybackEngine).toHaveBeenCalled();
  });
});

describe('Timeline playhead', () => {
  it('renders no playhead while the head tick is null', () => {
    render(<Timeline />);
    expect(screen.queryByTestId('playhead')).not.toBeInTheDocument();
  });

  it('positions the playhead at the head tick, scaled by zoom', async () => {
    const user = userEvent.setup();
    vi.mocked(useIsPlaying).mockReturnValue(true);
    vi.mocked(useHeadTick).mockReturnValue(PPQ);
    render(<Timeline />);

    // default zoom is 48px per beat, so one beat in sits at 48px
    expect(screen.getByTestId('playhead').style.left).toBe('48px');

    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByTestId('playhead').style.left).toBe('96px');
  });

  it('shows the playhead at the left edge on tick zero', () => {
    vi.mocked(useIsPlaying).mockReturnValue(true);
    vi.mocked(useHeadTick).mockReturnValue(0);
    render(<Timeline />);

    // Tick 0 is a position, not "no playhead" — a truthiness check here would
    // blank the head for the whole first tick and read as a dropped frame.
    expect(screen.getByTestId('playhead').style.left).toBe('0px');
  });

  it('clears the playhead once the head goes null', () => {
    vi.mocked(useIsPlaying).mockReturnValue(true);
    vi.mocked(useHeadTick).mockReturnValue(PPQ);
    const { rerender } = render(<Timeline />);
    expect(screen.getByTestId('playhead')).toBeInTheDocument();

    vi.mocked(useIsPlaying).mockReturnValue(false);
    vi.mocked(useHeadTick).mockReturnValue(null);
    rerender(<Timeline />);

    expect(screen.queryByTestId('playhead')).not.toBeInTheDocument();
  });
});

describe('Timeline active notes', () => {
  it('marks only the notes that are currently sounding', () => {
    const [sounding, silent] = events();
    vi.mocked(useIsPlaying).mockReturnValue(true);
    vi.mocked(useActiveEventIds).mockReturnValue([sounding.id]);
    render(<Timeline />);

    expect(noteEl(sounding.id)).toHaveAttribute('data-active');
    expect(noteEl(silent.id)).not.toHaveAttribute('data-active');
  });

  it('moves the highlight as the sounding notes change', () => {
    const [first, second] = events();
    vi.mocked(useIsPlaying).mockReturnValue(true);
    vi.mocked(useActiveEventIds).mockReturnValue([first.id]);
    const { rerender } = render(<Timeline />);

    vi.mocked(useActiveEventIds).mockReturnValue([second.id]);
    rerender(<Timeline />);

    // The highlight has to be released as well as applied, or every note that
    // ever sounded stays lit for the rest of the take.
    expect(noteEl(first.id)).not.toHaveAttribute('data-active');
    expect(noteEl(second.id)).toHaveAttribute('data-active');
  });

  describe('metronome click', () => {
    it('offers to mute the click, which is separate from the notes', async () => {
      const user = userEvent.setup();
      render(<Timeline />);

      await user.click(screen.getByRole('button', { name: 'Mute metronome click' }));

      expect(toggleClick).toHaveBeenCalled();
    });

    it('flips its label once muted', () => {
      vi.mocked(useClickMuted).mockReturnValue(true);
      render(<Timeline />);

      expect(screen.getByRole('button', { name: 'Unmute metronome click' })).toBeInTheDocument();
    });
  });

  describe('tempo and looping', () => {
    it('shows the current tempo', () => {
      render(<Timeline />);
      expect(screen.getByText('80')).toBeInTheDocument();
    });

    // Tempo has two homes: the metronome plays it now, the pattern remembers it.
    it('writes a tempo change to both the transport and the pattern', async () => {
      const user = userEvent.setup();
      render(<Timeline />);

      await user.click(screen.getByRole('button', { name: 'Increase tempo' }));

      expect(setTempo).toHaveBeenCalledWith(81);
      expect(getEditingPattern()!.suggestedBpm).toBe(81);
    });

    it('toggles looping on the pattern', async () => {
      const user = userEvent.setup();
      render(<Timeline />);
      const before = getEditingPattern()!.loop;

      await user.click(
        screen.getByRole('button', { name: before ? 'Turn looping off' : 'Turn looping on' }),
      );

      expect(getEditingPattern()!.loop).toBe(!before);
    });
  });
});

/**
 * Two rAF loops want the same `scrollLeft`: the playhead follow and the drag's
 * edge auto-scroll. Left to fight, they trade the view back and forth every few
 * frames and the note lands wherever the tug-of-war left it — so the hand on the
 * pointer wins, for the whole gesture rather than only at the edges.
 *
 * The follow loop reads the transport once a frame and does nothing else that
 * jsdom can see (its writes go to a 0x0 element), so that read stands in for
 * "the loop is running".
 */
describe('Timeline follow-scroll versus a drag', () => {
  const reads = () => vi.mocked(getTransportTicks).mock.calls.length;

  it('hands the view to a drag and takes it back on release', async () => {
    const user = userEvent.setup();
    // Installed before the render that starts the loop: a frame armed by the
    // real rAF would fire on its own timer, outside the test's control.
    const frames = installFrameClock();
    vi.mocked(useIsPlaying).mockReturnValue(true);
    render(<Timeline />);
    const id = events()[0].id;

    frames.step();
    const following = reads();
    expect(following).toBeGreaterThan(0);

    await user.pointer([
      { target: noteEl(id), keys: '[MouseLeft>]', coords: { clientX: 10, clientY: 0 } },
      { coords: { clientX: 60, clientY: 0 } },
    ]);
    frames.step();
    frames.step();

    expect(reads()).toBe(following);

    await user.pointer({ keys: '[/MouseLeft]' });
    frames.step();

    // And it catches up rather than resuming where it left off — the follow
    // jumps whenever the head is behind the view.
    expect(reads()).toBeGreaterThan(following);
  });

  it('keeps following through a click that never became a drag', async () => {
    const user = userEvent.setup();
    const frames = installFrameClock();
    vi.mocked(useIsPlaying).mockReturnValue(true);
    render(<Timeline />);
    const id = events()[0].id;

    frames.step();
    const following = reads();

    // Selecting a note during playback is not a request to stop the view.
    await user.pointer({ target: noteEl(id), keys: '[MouseLeft]' });
    frames.step();

    expect(reads()).toBeGreaterThan(following);
  });
});
