import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { PPQ, usePatternsStore } from '@fretwork/lib';
import { getEditingPattern, openBlankPattern, stampNote } from '../src/patterns/patternService';
import {
  play,
  previewNote,
  stop,
  useActiveEventIds,
  useHeadTick,
  useIsPlaying,
  usePlaybackEngine,
} from '../src/audio/playbackService';

/**
 * jsdom has no Web Audio, so nothing here may construct a real `Voice`,
 * `EventScheduler` or `Metronome`. The fakes below stand in for exactly the
 * slice of the lib the service touches, and record a shared call `order` —
 * ordering is the point of most of these tests, not the calls themselves.
 *
 * `vi.hoisted` because `vi.mock`'s factory is hoisted above the imports.
 */
const lib = vi.hoisted(() => {
  const order: string[] = [];

  const startAudio = vi.fn(async () => {
    order.push('startAudio');
  });

  const metronome = {
    start: vi.fn(async () => {
      order.push('metronome.start');
    }),
    stop: vi.fn(() => {
      order.push('metronome.stop');
    }),
  };

  const voices: Array<{ ensureBuilt: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> =
    [];
  const buildEffectiveVoice = vi.fn(() => {
    const voice = {
      ensureBuilt: vi.fn(() => {
        order.push('ensureBuilt');
      }),
      dispose: vi.fn(),
    };
    voices.push(voice);
    return { voice, preset: {} };
  });

  type HeadListener = (headTick: number) => void;
  type ActiveListener = (active: ReadonlyArray<{ id: string }>) => void;

  class FakeScheduler {
    static instances: FakeScheduler[] = [];

    readonly opts: unknown;
    readonly heads = new Set<HeadListener>();
    readonly actives = new Set<ActiveListener>();
    readonly completes = new Set<() => void>();
    stream: unknown = null;

    setStream = vi.fn((stream: unknown) => {
      order.push('setStream');
      this.stream = stream;
    });
    setLoop = vi.fn();
    setInstrument = vi.fn();
    previewCell = vi.fn(() => {
      order.push('previewCell');
    });
    dispose = vi.fn(() => {
      order.push('scheduler.dispose');
    });

    constructor(opts: unknown) {
      this.opts = opts;
      FakeScheduler.instances.push(this);
    }

    onHead(listener: HeadListener) {
      this.heads.add(listener);
      return () => {
        this.heads.delete(listener);
      };
    }

    onActive(listener: ActiveListener) {
      this.actives.add(listener);
      return () => {
        this.actives.delete(listener);
      };
    }

    onComplete(listener: () => void) {
      this.completes.add(listener);
      return () => {
        this.completes.delete(listener);
      };
    }

    emitHead(headTick: number) {
      this.heads.forEach((listener) => listener(headTick));
    }

    emitActive(active: ReadonlyArray<{ id: string }>) {
      this.actives.forEach((listener) => listener(active));
    }

    emitComplete() {
      this.completes.forEach((listener) => listener());
    }
  }

  class FakePatternSource {
    constructor(readonly pattern: unknown) {}
  }

  return {
    order,
    voices,
    startAudio,
    metronome,
    buildEffectiveVoice,
    FakeScheduler,
    FakePatternSource,
    reset() {
      order.length = 0;
      voices.length = 0;
      FakeScheduler.instances.length = 0;
      vi.clearAllMocks();
    },
  };
});

// Only the audio surface is replaced — the pattern store stays real, so these
// tests exercise the same path from editing pattern to stream that the app does.
vi.mock('@fretwork/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fretwork/lib')>();
  return {
    ...actual,
    startAudio: lib.startAudio,
    useMetronome: () => ({ metronome: lib.metronome }),
    buildEffectiveVoice: lib.buildEffectiveVoice,
    EventScheduler: lib.FakeScheduler,
    PatternSource: lib.FakePatternSource,
  };
});

/**
 * Each slice gets its own leaf so a render count means something: the service
 * promises a 60 Hz head tick doesn't re-render the transport button, and that
 * is only observable per-consumer.
 */
const renders = { playing: 0, head: 0, active: 0 };

function PlayingProbe() {
  const isPlaying = useIsPlaying();
  renders.playing += 1;
  return createElement('output', { role: 'status', 'aria-label': 'playing' }, String(isPlaying));
}

function HeadProbe() {
  const headTick = useHeadTick();
  renders.head += 1;
  return createElement('output', { role: 'status', 'aria-label': 'head' }, String(headTick));
}

function ActiveProbe() {
  const activeIds = useActiveEventIds();
  renders.active += 1;
  return createElement('output', { role: 'status', 'aria-label': 'active' }, activeIds.join(' '));
}

function Probe() {
  usePlaybackEngine();
  return createElement(
    'div',
    null,
    createElement(PlayingProbe),
    createElement(HeadProbe),
    createElement(ActiveProbe),
  );
}

const mount = () => render(createElement(Probe));
const scheduler = () => lib.FakeScheduler.instances.at(-1)!;
const read = (name: string) => screen.getByRole('status', { name }).textContent;
const start = () => act(async () => void (await play()));

beforeEach(() => {
  lib.reset();
  renders.playing = 0;
  renders.head = 0;
  renders.active = 0;
  openBlankPattern('Playback test');
  stampNote({ stringIndex: 4, fret: 5, tick: 0, durationTicks: PPQ / 2 });
});

// Removed with the LIB-GAP(6) workaround: this pinned a module-load side effect that
// disarmed the lib's Practice-page walk playback, because `useFretboardModel` used to
// construct that singleton merely by rendering a fretboard. It no longer does — the
// model takes an injected `playback` — so there is nothing to disarm and nothing for
// this to assert. The lib now covers it: rendering the model must not build the
// singleton (tests/fretboard.test.ts in ../fretwork-lib).

describe('play', () => {
  it('unlocks audio and streams the pattern before starting the transport', async () => {
    mount();

    await start();

    // No `ensureBuilt` here any more, and that is the fix rather than a regression:
    // warming the instrument moved into `EventScheduler`, which registers on the
    // metronome's pre-start hook so the load is in flight before it awaits
    // `Tone.loaded()`. The lib owns that ordering now and tests it there
    // ("EventScheduler — instrument warm-up"); this asserts only what this seam still
    // sequences. It used to be the caller's job, and getting it wrong was a silent
    // first note.
    expect(lib.order).toEqual(['startAudio', 'setStream', 'metronome.start']);
  });

  it('streams the pattern currently being edited', async () => {
    mount();

    await start();

    const stream = scheduler().stream;
    expect(stream).toBeInstanceOf(lib.FakePatternSource);
    expect((stream as InstanceType<typeof lib.FakePatternSource>).pattern).toBe(
      getEditingPattern(),
    );
  });

  it('reports playing and puts the head at the start', async () => {
    mount();
    expect(read('playing')).toBe('false');
    expect(read('head')).toBe('null');

    await start();

    expect(read('playing')).toBe('true');
    expect(read('head')).toBe('0');
  });

  it('reuses the voice when neither instrument nor voiceRef changed', async () => {
    mount();

    await start();
    stop();
    await start();

    expect(lib.buildEffectiveVoice).toHaveBeenCalledTimes(1);
    expect(lib.FakeScheduler.instances).toHaveLength(1);
  });

  it('does nothing when there is no pattern open', async () => {
    usePatternsStore.getState().openPatternForEditing(null);
    mount();

    await start();

    expect(lib.startAudio).not.toHaveBeenCalled();
    expect(lib.FakeScheduler.instances).toHaveLength(0);
    expect(read('playing')).toBe('false');
  });

  it('ignores a second call while already playing', async () => {
    mount();
    await start();
    act(() => scheduler().emitHead(240));

    await start();

    // Re-streaming a running scheduler drops the live schedule and waits for a
    // start that never comes — the head keeps sweeping over silence.
    expect(scheduler().setStream).toHaveBeenCalledTimes(1);
    expect(lib.metronome.start).toHaveBeenCalledTimes(1);
    expect(read('head')).toBe('240');
  });

  it('releases the transport when the metronome fails to start', async () => {
    lib.metronome.start.mockRejectedValueOnce(new Error('no audio context'));
    mount();

    await start();

    expect(lib.metronome.stop).toHaveBeenCalled();
    expect(read('playing')).toBe('false');
    expect(read('head')).toBe('null');
  });
});

describe('stop', () => {
  it('stops the transport and clears the head', async () => {
    mount();
    await start();
    act(() => scheduler().emitHead(480));
    expect(read('head')).toBe('480');

    act(() => stop());

    expect(lib.metronome.stop).toHaveBeenCalled();
    expect(read('head')).toBe('null');
    expect(read('playing')).toBe('false');
  });

  it('ignores head frames that land after it', async () => {
    mount();
    await start();
    act(() => stop());

    act(() => scheduler().emitHead(960));

    expect(read('head')).toBe('null');
  });

  it('runs when the stream reaches its end without looping', async () => {
    mount();
    await start();

    act(() => scheduler().emitComplete());

    expect(lib.metronome.stop).toHaveBeenCalled();
    expect(read('playing')).toBe('false');
  });
});

describe('subscriptions', () => {
  it('feeds head ticks and active ids to the hooks', async () => {
    mount();
    await start();

    act(() => scheduler().emitHead(240));
    act(() => scheduler().emitActive([{ id: 'one' }, { id: 'two' }]));

    expect(read('head')).toBe('240');
    expect(read('active')).toBe('one two');
  });

  it('keeps a head tick away from the other consumers', async () => {
    mount();
    await start();
    act(() => scheduler().emitActive([{ id: 'one' }]));
    const before = { ...renders };

    act(() => scheduler().emitHead(120));
    act(() => scheduler().emitHead(180));

    expect(renders.head).toBe(before.head + 2);
    // The point of the per-slice getters: a sweeping playhead must not re-render
    // the transport button or the note highlights sixty times a second.
    expect(renders.playing).toBe(before.playing);
    expect(renders.active).toBe(before.active);
  });

  it('holds the same array identity while no note is sounding', async () => {
    mount();
    await start();
    act(() => scheduler().emitActive([{ id: 'one' }]));

    act(() => scheduler().emitActive([]));
    const afterFirstIdle = renders.active;
    act(() => scheduler().emitActive([]));

    expect(read('active')).toBe('');
    // A fresh `[]` per emit would fail `Object.is` and re-render every consumer
    // on every silent frame.
    expect(renders.active).toBe(afterFirstIdle);
  });

  it('drops its subscriptions and disposes the engine on unmount', async () => {
    const view = mount();
    await start();
    const engine = scheduler();
    expect(engine.heads.size).toBe(1);

    view.unmount();

    expect(engine.heads.size).toBe(0);
    expect(engine.actives.size).toBe(0);
    expect(engine.dispose).toHaveBeenCalled();
    expect(lib.voices[0].dispose).toHaveBeenCalled();
  });

  it('stops the transport when unmounted mid-playback', async () => {
    const view = mount();
    await start();

    view.unmount();

    // The metronome owns the transport; disposing the scheduler alone would
    // leave it running with nothing left holding a reference to stop it.
    expect(lib.metronome.stop).toHaveBeenCalled();
    expect(lib.order.indexOf('metronome.stop')).toBeLessThan(
      lib.order.indexOf('scheduler.dispose'),
    );
  });
});

describe('previewNote', () => {
  it('delegates to the scheduler without touching the transport', () => {
    mount();

    act(() => previewNote(2, 5));

    expect(scheduler().previewCell).toHaveBeenCalledWith(2, 5);
    expect(lib.metronome.start).not.toHaveBeenCalled();
  });

  it('builds the voice before auditioning so the first note is not silent', () => {
    mount();

    act(() => previewNote(2, 5));

    expect(lib.order).toEqual(['ensureBuilt', 'previewCell']);
  });

  it('does not disturb a running playhead', async () => {
    mount();
    await start();
    act(() => scheduler().emitHead(360));

    act(() => previewNote(2, 5));

    expect(read('playing')).toBe('true');
    expect(read('head')).toBe('360');
    expect(scheduler().setStream).toHaveBeenCalledTimes(1);
  });
});

describe('without an engine mounted', () => {
  it('is inert rather than throwing', async () => {
    await expect(play()).resolves.toBeUndefined();
    expect(() => stop()).not.toThrow();
    expect(() => previewNote(0, 0)).not.toThrow();

    expect(lib.metronome.start).not.toHaveBeenCalled();
    expect(lib.FakeScheduler.instances).toHaveLength(0);
  });
});
