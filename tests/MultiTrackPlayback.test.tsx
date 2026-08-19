import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import {
  DEFAULT_PATTERNS_STATE,
  PPQ,
  totalDurationTicks,
  useMetronomeStore,
  usePatternsStore,
  type Composition,
} from '@fretwork/lib';
import {
  addPlacement,
  addTrack,
  getEditingComposition,
  getTracks,
  openBlankComposition,
  resizePlacement,
  selectPlacements,
  selectTrack,
  setCompositionBpm,
  setCompositionLoop,
  setCompositionSubdivision,
  setCompositionTimeSignature,
  setTrackInstrument,
  setTrackMuted,
  setTrackSoloed,
  setTrackVolumeDb,
  type Result,
} from '../src/composition/compositionService';
import { contentEndTick } from '../src/composition/arrangementMath';
import { getEditingPattern, openBlankPattern, stampNote } from '../src/patterns/patternService';
import {
  play,
  playComposition,
  stop,
  useActiveEventIds,
  useActivePlacementIds,
  useCompositionPlayback,
  useHeadTick,
  useIsPlaying,
  useLoopBoundaryTicks,
  usePlaybackEngine,
} from '../src/audio/playbackService';
import { installFrameClock } from './frameClock';

/**
 * CP-08 — multi-track playback, as far as this environment can see it.
 *
 * jsdom has NO WEB AUDIO. Nothing here may construct a real `Voice`,
 * `EventScheduler`, `Metronome` or `MultiTrackPlayback`, and nothing here can
 * assert that three instruments sound together in time — that is the ticket's
 * by-ear acceptance and there is no substitute for it at any price short of the
 * browser-mode `Tone.Offline()` project, which is deferred by decision
 * (tickets/INDEX.md). What IS asserted is everything on this side of the engine
 * boundary: that the seam builds the composition path from the right
 * composition, with voices wired the way the engine requires; that the head and
 * the block highlights come from one read and clear together on stop; that a
 * mix change reaches the engine while it is running; and that the page round
 * trip leaves the pattern path able to play again.
 *
 * The fake `MultiTrackPlayback` mirrors two documented behaviours of the real
 * one rather than being inert, because both are load-bearing for what is being
 * tested: `updateComposition` returns true when the TRACK SHAPE changed, and
 * calls `applyTrackState` itself when it did not. Everything else is a spy.
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

  /** What the transport reports. Written by the tests; read by the head loop. */
  let transportTicks = 0;
  const getTransportTicks = vi.fn(() => transportTicks);

  type BuiltVoice = {
    instrumentId: string;
    autoConnectToMaster: boolean | undefined;
    dispose: ReturnType<typeof vi.fn>;
    ensureBuilt: ReturnType<typeof vi.fn>;
    setRoutingTarget: ReturnType<typeof vi.fn>;
  };
  const voices: BuiltVoice[] = [];
  const buildEffectiveVoice = vi.fn(
    (instrumentId: string, options?: { autoConnectToMaster?: boolean }) => {
      const voice: BuiltVoice = {
        instrumentId,
        autoConnectToMaster: options?.autoConnectToMaster,
        dispose: vi.fn(),
        ensureBuilt: vi.fn(),
        setRoutingTarget: vi.fn(),
      };
      voices.push(voice);
      return { voice, preset: {} };
    },
  );

  type ActiveListener = (events: ReadonlyArray<{ id: string }>) => void;
  type Opts = {
    composition: { id: string; tracks: ReadonlyArray<{ id: string }> };
    tuning: { id: string; strings: readonly string[] };
    capo: number;
    buildVoice: (track: unknown) => unknown;
  };

  /** One per track, the way the real engine builds them. Only `onComplete` is
   *  reached from this side, and it is what ends a non-looping pass. */
  class FakeTrackScheduler {
    readonly completeListeners = new Set<() => void>();
    onComplete(listener: () => void) {
      this.completeListeners.add(listener);
      return () => {
        this.completeListeners.delete(listener);
      };
    }
  }

  class FakeMultiTrackPlayback {
    static instances: FakeMultiTrackPlayback[] = [];

    readonly opts: Opts;
    /** The snapshot the engine holds — only `updateComposition` replaces it. */
    held: Opts['composition'];
    readonly listeners = new Map<string, Set<ActiveListener>>();
    readonly schedulers: FakeTrackScheduler[] = [];
    disposed = false;

    applyTrackState = vi.fn(() => {
      order.push('applyTrackState');
    });
    setLoop = vi.fn();
    setLoopRegion = vi.fn();
    setTuning = vi.fn();
    setTrackVoice = vi.fn();
    restreamAll = vi.fn();

    updateComposition = vi.fn((next: Opts['composition']) => {
      const previous = this.held;
      this.held = next;
      const sameTracks =
        next.tracks.length === previous.tracks.length &&
        next.tracks.every((track, i) => track.id === previous.tracks[i]?.id);
      // Exactly what the real one does: a same-shape update pushes the mix
      // through `applyTrackState`, and only a shape change asks for a rebuild.
      if (sameTracks) this.applyTrackState();
      return !sameTracks;
    });

    dispose = vi.fn(() => {
      this.disposed = true;
      order.push('playback.dispose');
    });

    constructor(opts: Opts) {
      this.opts = opts;
      this.held = opts.composition;
      // The real constructor builds one voice and one scheduler per track
      // through the factory, which is where `autoConnectToMaster` is asserted.
      for (const track of opts.composition.tracks) {
        opts.buildVoice(track);
        this.schedulers.push(new FakeTrackScheduler());
      }
      order.push('playback.construct');
      FakeMultiTrackPlayback.instances.push(this);
    }

    /** What the transport does at the end of a non-looping pass: every
     *  scheduler shares one boundary, so they all fire on the same tick. */
    emitComplete() {
      for (const scheduler of this.schedulers) {
        scheduler.completeListeners.forEach((listener) => listener());
      }
    }

    onTrackActive(trackId: string, listener: ActiveListener) {
      const set = this.listeners.get(trackId) ?? new Set<ActiveListener>();
      set.add(listener);
      this.listeners.set(trackId, set);
      return () => {
        set.delete(listener);
      };
    }

    emitActive(trackId: string, events: ReadonlyArray<{ id: string }>) {
      this.listeners.get(trackId)?.forEach((listener) => listener(events));
    }
  }

  // The pattern path's engine, so the page round trip can be exercised without
  // Web Audio: the point of that test is that the composition path's teardown
  // leaves the pattern path able to build and start again.
  class FakeScheduler {
    static instances: FakeScheduler[] = [];
    setStream = vi.fn();
    setLoop = vi.fn();
    setInstrument = vi.fn();
    previewCell = vi.fn();
    dispose = vi.fn();
    constructor() {
      FakeScheduler.instances.push(this);
    }
    onHead() {
      return () => {};
    }
    onActive() {
      return () => {};
    }
    onComplete() {
      return () => {};
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
    getTransportTicks,
    buildEffectiveVoice,
    FakeMultiTrackPlayback,
    FakeScheduler,
    FakePatternSource,
    setTransportTicks(ticks: number) {
      transportTicks = ticks;
    },
    reset() {
      order.length = 0;
      voices.length = 0;
      transportTicks = 0;
      FakeMultiTrackPlayback.instances.length = 0;
      FakeScheduler.instances.length = 0;
      vi.clearAllMocks();
    },
  };
});

// Only the audio surface is replaced. The composition store, `composition-ops`,
// `totalDurationTicks`, `placementEndTick` and `resolveEffectivePlayback` all
// stay real, so these tests run the same path from arrangement to engine that
// the app does.
vi.mock('@fretwork/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fretwork/lib')>();
  return {
    ...actual,
    startAudio: lib.startAudio,
    useMetronome: () => ({ metronome: lib.metronome }),
    getTransportTicks: lib.getTransportTicks,
    buildEffectiveVoice: lib.buildEffectiveVoice,
    MultiTrackPlayback: lib.FakeMultiTrackPlayback,
    EventScheduler: lib.FakeScheduler,
    PatternSource: lib.FakePatternSource,
  };
});

// --------------------------------------------------------------- the probes ---
// One leaf per slice, so a render count means something: the head sweeps sixty
// times a second and must not re-render the blocks or the transport with it.

const renders = { playing: 0, head: 0, blocks: 0 };

function PlayingProbe() {
  renders.playing += 1;
  return createElement(
    'output',
    { role: 'status', 'aria-label': 'playing' },
    String(useIsPlaying()),
  );
}

function HeadProbe() {
  renders.head += 1;
  return createElement(
    'output',
    { role: 'status', 'aria-label': 'head' },
    String(useHeadTick()),
  );
}

function BlocksProbe() {
  renders.blocks += 1;
  return createElement(
    'output',
    { role: 'status', 'aria-label': 'blocks' },
    useActivePlacementIds().join(' '),
  );
}

function NotesProbe() {
  return createElement(
    'output',
    { role: 'status', 'aria-label': 'notes' },
    useActiveEventIds().join(' '),
  );
}

function BoundaryProbe() {
  return createElement(
    'output',
    { role: 'status', 'aria-label': 'boundary' },
    String(useLoopBoundaryTicks()),
  );
}

/** The composition page's audio lifecycle, and nothing else. */
function CompositionProbe() {
  useCompositionPlayback();
  return createElement(
    'div',
    null,
    createElement(PlayingProbe),
    createElement(HeadProbe),
    createElement(BlocksProbe),
    createElement(NotesProbe),
    createElement(BoundaryProbe),
  );
}

const mount = () => render(createElement(CompositionProbe));
const engine = () => lib.FakeMultiTrackPlayback.instances.at(-1)!;
const read = (name: string) => screen.getByRole('status', { name }).textContent;

/** Press play, and hand back what the seam answered — refusals are RETURNED
 *  here, so a test that ignores the result is not reading the whole answer. */
async function start(): Promise<Result> {
  let result: Result = { ok: false, reason: 'playComposition never resolved' };
  await act(async () => {
    result = await playComposition();
  });
  return result;
}

// ------------------------------------------------------------------ fixtures ---

const BAR = 4 * PPQ;

/** A library pattern one bar long. A pattern with no events has no duration, and
 *  a zero-length placement is not something the head can ever be inside. */
function seedPattern(name: string): string {
  openBlankPattern(name);
  const pattern = getEditingPattern();
  if (!pattern) throw new Error('pattern seam did not open a pattern');
  stampNote({ stringIndex: 0, fret: 3, tick: 0, durationTicks: BAR });
  return pattern.id;
}

function place(patternId: string, trackId: string, atTick = 0): string {
  const result = addPlacement(patternId, trackId, atTick);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

function composition(): Composition {
  const open = getEditingComposition();
  if (!open) throw new Error('no composition open');
  return open;
}

beforeEach(() => {
  sessionStorage.clear();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  useMetronomeStore.setState({ bpm: 90 });
  selectPlacements([]);
  selectTrack(null);
  lib.reset();
  renders.playing = 0;
  renders.head = 0;
  renders.blocks = 0;
});

/** One composition, two tracks, a block on each. The default composition tempo
 *  is the lib's, so a test that cares sets it explicitly. */
function seedArrangement(): { patternId: string; placements: string[] } {
  const patternId = seedPattern('Riff');
  // Idempotent, as the `ensureComposition` this replaced was: a helper that
  // CREATES unconditionally would switch away from a composition the test had
  // already opened, and the switch is silent.
  if (!getEditingComposition()) openBlankComposition('Song');
  addTrack('Rhythm');
  const tracks = getTracks();
  return {
    patternId,
    placements: [place(patternId, tracks[0].id, 0), place(patternId, tracks[1].id, BAR)],
  };
}

// --------------------------------------------------------------------- build ---

describe('building the composition path', () => {
  it('unlocks audio and builds the engine before starting the transport', async () => {
    seedArrangement();
    mount();

    await start();

    // The metronome owns transport start/stop and every per-track scheduler is
    // waiting on its `start` event, so it has to be last.
    expect(lib.order).toEqual(['startAudio', 'playback.construct', 'metronome.start']);
  });

  it('builds it from the composition being arranged', async () => {
    seedArrangement();
    mount();

    await start();

    expect(engine().opts.composition).toBe(composition());
    expect(engine().opts.capo).toBe(0);
  });

  it('builds one voice per track, wired for the engine to insert its gain', async () => {
    seedArrangement();
    mount();

    await start();

    expect(lib.voices).toHaveLength(getTracks().length);
    // A voice that connected itself to the master bus would still be audible —
    // and would ignore its track's fader, mute and solo entirely.
    expect(lib.voices.every((voice) => voice.autoConnectToMaster === false)).toBe(true);
  });

  it('plays every track through the widest tuning any of them needs', async () => {
    seedArrangement();
    const tracks = getTracks();
    setTrackInstrument(tracks[0].id, 'bass');
    setTrackInstrument(tracks[1].id, 'guitar');
    mount();

    await start();

    // LIB-GAP(15): one tuning serves every track. A four-string tuning would
    // DROP every event on strings 4 and 5 of the guitar track — silently — where
    // the six-string one only mis-pitches the bass.
    expect(engine().opts.tuning.strings.length).toBe(6);
  });

  it('pushes the composition tempo into the metronome', async () => {
    seedArrangement();
    setCompositionBpm(137);
    mount();

    await start();

    // Not read FROM the metronome: it is carrying whatever the pattern page last
    // left in it (90, from the fixture).
    expect(useMetronomeStore.getState().bpm).toBe(137);
  });

  it('refuses, in words, when no composition is open', async () => {
    usePatternsStore.setState({ editingCompositionId: null });
    mount();

    const result = await start();

    // A silent bail-out is indistinguishable from a broken button, and the
    // agent's transport tool reads the same answer the surface does.
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('No composition') });
    expect(lib.startAudio).not.toHaveBeenCalled();
    expect(lib.FakeMultiTrackPlayback.instances).toHaveLength(0);
    expect(read('playing')).toBe('false');
  });

  it('refuses to run the transport for an empty arrangement', async () => {
    seedPattern('Riff');
    openBlankComposition('Song');
    mount();

    const result = await start();

    // Nothing placed means a zero-length region, whose boundary chain
    // reschedules BEFORE the tick it started from and never advances — the
    // transport would run for nothing at all.
    expect(result.ok).toBe(false);
    expect(lib.FakeMultiTrackPlayback.instances).toHaveLength(0);
    expect(read('playing')).toBe('false');
  });

  it('ignores a second call while already playing', async () => {
    seedArrangement();
    mount();
    await start();

    await start();

    expect(lib.FakeMultiTrackPlayback.instances).toHaveLength(1);
    expect(lib.metronome.start).toHaveBeenCalledTimes(1);
  });

  it('is inert rather than throwing with no engine mounted', async () => {
    seedArrangement();

    await expect(playComposition()).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('Audio is unavailable'),
    });
    expect(() => stop()).not.toThrow();
    expect(lib.FakeMultiTrackPlayback.instances).toHaveLength(0);
  });

  it('releases the transport when the metronome fails to start', async () => {
    seedArrangement();
    lib.metronome.start.mockRejectedValueOnce(new Error('no audio context'));
    mount();

    const result = await start();

    expect(result.ok).toBe(false);
    expect(lib.metronome.stop).toHaveBeenCalled();
    expect(read('playing')).toBe('false');
    expect(read('head')).toBe('null');
  });

  it('answers ok when it actually started', async () => {
    seedArrangement();
    mount();

    await expect(start()).resolves.toEqual({ ok: true, value: undefined });
  });
});

// ---------------------------------------------------------------------- loop ---

describe('the click follows the composition (CP-18)', () => {
  it('sets the metronome to the arrangement\'s meter and subdivision on play', async () => {
    seedArrangement();
    setCompositionTimeSignature({ numerator: 3, denominator: 4 });
    setCompositionSubdivision('8ths');
    // Whatever the pattern page left in the shared metronome.
    useMetronomeStore.setState({ timeSignatureId: '4/4', subdivision: 'off' });
    mount();

    await start();

    expect(useMetronomeStore.getState().timeSignatureId).toBe('3/4');
    expect(useMetronomeStore.getState().subdivision).toBe('8ths');
  });

  it('follows a change made WHILE it is playing', async () => {
    // Stored and not heard until the next press of Play would make the control
    // look broken — the tempo stepper beside it already works this way.
    seedArrangement();
    mount();
    await start();

    await act(async () => {
      setCompositionTimeSignature({ numerator: 6, denominator: 8 });
      setCompositionSubdivision('triplets');
    });

    expect(useMetronomeStore.getState().timeSignatureId).toBe('6/8');
    expect(useMetronomeStore.getState().subdivision).toBe('triplets');
  });
});

describe('looping', () => {
  it('pushes the composition loop flag into every scheduler', async () => {
    seedArrangement();
    setCompositionLoop(true);
    mount();

    await start();

    expect(engine().setLoop).toHaveBeenCalledWith(true);
  });

  it('publishes the boundary the ENGINE loops at, not the drawn width', async () => {
    const { placements } = seedArrangement();
    setCompositionLoop(true);
    // The two numbers are only DIFFERENT for a truncated placement, and it has
    // to be the LAST one — truncating any other leaves the arrangement's end
    // where it was and the test could not fail. Without this the drawn width
    // and the lib's duration agree and either would pass.
    resizePlacement(placements[1], BAR / 2);
    const drawn = contentEndTick(composition().tracks);
    const engineBoundary = totalDurationTicks(composition());
    expect(drawn).not.toBe(engineBoundary);
    mount();

    await start();

    // LIB-GAP(11): `MultiTrackPlayback` builds every `CompositionTrackSource`
    // with the lib's own `totalDurationTicks`, so that is where the audio comes
    // back round — and the playhead has to agree with the ear, not with the
    // ruler. Compared against a fresh call rather than a number copied here.
    expect(read('boundary')).toBe(String(engineBoundary));
  });

  it('wraps the head back into the loop', async () => {
    seedArrangement();
    setCompositionLoop(true);
    const clock = installFrameClock();
    mount();
    await start();
    const boundary = totalDurationTicks(composition());

    // The transport climbs forever — each iteration is rescheduled at increasing
    // absolute ticks — so an unwrapped head runs straight off the end of the grid.
    lib.setTransportTicks(boundary + PPQ);
    clock.step();

    expect(read('head')).toBe(String(PPQ));
  });

  it('stops when a non-looping pass reaches the end of the arrangement', async () => {
    seedArrangement();
    const clock = installFrameClock();
    mount();
    await start();
    lib.setTransportTicks(PPQ);
    clock.step();
    expect(read('playing')).toBe('true');

    // What `EventScheduler` does at the end of a non-looping iteration. Without
    // this wired, the audio ends and nothing else does: the transport keeps
    // rolling, the button still reads Stop and the head climbs off the grid
    // forever with follow-scroll chasing it into empty space.
    act(() => engine().emitComplete());

    expect(read('playing')).toBe('false');
    expect(read('head')).toBe('null');
    expect(lib.metronome.stop).toHaveBeenCalled();
    expect(clock.scheduled()).toBe(0);
  });

  it('leaves the head unwrapped when looping is off', async () => {
    seedArrangement();
    const clock = installFrameClock();
    mount();
    await start();
    const boundary = totalDurationTicks(composition());

    lib.setTransportTicks(boundary + PPQ);
    clock.step();

    expect(read('head')).toBe(String(boundary + PPQ));
  });
});

// ------------------------------------------------------------------ the head ---

describe('the head and the block highlights', () => {
  it('sweeps from the transport rather than from a scheduler callback', async () => {
    seedArrangement();
    const clock = installFrameClock();
    mount();
    await start();
    expect(read('head')).toBe('0');

    lib.setTransportTicks(PPQ);
    clock.step();

    // LIB-GAP(16): every scheduler `MultiTrackPlayback` builds is a FOLLOWER, and
    // only a primary runs the poll that emits `onHead` — so there is no head to
    // subscribe to on this path at all.
    expect(lib.getTransportTicks).toHaveBeenCalled();
    expect(read('head')).toBe(String(PPQ));
  });

  it('lights the block the head is inside, from the same frame', async () => {
    const { placements } = seedArrangement();
    const clock = installFrameClock();
    mount();
    await start();

    lib.setTransportTicks(PPQ);
    clock.step();
    expect(read('blocks')).toBe(placements[0]);

    // Second bar: the second track's block starts there and the first has ended.
    lib.setTransportTicks(BAR + PPQ);
    clock.step();
    expect(read('blocks')).toBe(placements[1]);
  });

  it('keeps a sweeping head away from the blocks and the transport', async () => {
    seedArrangement();
    const clock = installFrameClock();
    mount();
    await start();
    lib.setTransportTicks(PPQ);
    clock.step();
    const before = { ...renders };

    // Three frames inside the same block: the head moves, the highlight doesn't.
    lib.setTransportTicks(PPQ + 1);
    clock.step();
    lib.setTransportTicks(PPQ + 2);
    clock.step();
    lib.setTransportTicks(PPQ + 3);
    clock.step();

    expect(renders.head).toBe(before.head + 3);
    expect(renders.blocks).toBe(before.blocks);
    expect(renders.playing).toBe(before.playing);
  });

  it('survives a transport that reports nothing', async () => {
    seedArrangement();
    const clock = installFrameClock();
    mount();
    await start();

    // Insurance, and labelled as such: the lib's `getTransportTicks` already
    // ends `Number.isFinite(ticks) ? ticks : 0` inside a try/catch, so it cannot
    // produce this today and the mock has to be forced to. The guard stays
    // because a head "at NaN" draws at NaN px and disappears with no error.
    lib.getTransportTicks.mockReturnValueOnce(Number.NaN);
    clock.step();

    expect(read('head')).toBe('0');
  });

  it('publishes active note ids from the engine', async () => {
    seedArrangement();
    mount();
    await start();

    act(() => engine().emitActive(getTracks()[0].id, [{ id: 'one' }, { id: 'two' }]));

    // LIB-GAP(16) again: this path is wired and delivers nothing during playback
    // in this build, because a follower never polls. What is pinned here is that
    // the wiring is correct for when it does.
    expect(read('notes')).toBe('one two');
  });
});

// ------------------------------------------------------------------ stopping ---

describe('stop', () => {
  it('stops the transport and clears the head and every highlight', async () => {
    seedArrangement();
    const clock = installFrameClock();
    mount();
    await start();
    lib.setTransportTicks(PPQ);
    clock.step();
    act(() => engine().emitActive(getTracks()[0].id, [{ id: 'one' }]));
    expect(read('blocks')).not.toBe('');

    act(() => stop());

    expect(lib.metronome.stop).toHaveBeenCalled();
    expect(read('playing')).toBe('false');
    expect(read('head')).toBe('null');
    // The scheduler once never emitted a null placement on stop, leaving a
    // highlight lit for the rest of the session.
    expect(read('blocks')).toBe('');
    expect(read('notes')).toBe('');
  });

  it('ends the head loop and ignores any frame still in flight', async () => {
    seedArrangement();
    const clock = installFrameClock();
    mount();
    await start();
    expect(clock.scheduled()).toBe(1);

    act(() => stop());

    expect(clock.scheduled()).toBe(0);
    lib.setTransportTicks(BAR);
    clock.step();
    expect(read('head')).toBe('null');
  });

  it('can be restarted after stopping, reusing the engine', async () => {
    seedArrangement();
    mount();
    await start();

    act(() => stop());
    await start();

    // Rebuilding would mean re-downloading every track's sample bank.
    expect(lib.FakeMultiTrackPlayback.instances).toHaveLength(1);
    expect(read('playing')).toBe('true');
  });
});

// ---------------------------------------------------------------------- mix ---

describe('the mix, live', () => {
  it('pushes a mute through to the engine mid-playback', async () => {
    seedArrangement();
    mount();
    await start();
    lib.order.length = 0;

    await act(async () => {
      setTrackMuted(getTracks()[1].id, true);
    });

    const update = engine().updateComposition.mock.calls.at(-1)?.[0] as Composition;
    expect(update.tracks[1].muted).toBe(true);
    // `applyTrackState` alone would re-apply the values the engine ALREADY had —
    // it reads the engine's own snapshot, and only `updateComposition` replaces
    // that. Reaching it through the update is the whole point.
    expect(lib.order).toContain('applyTrackState');
    expect(engine().disposed).toBe(false);
  });

  it('pushes a solo and a fader through the same way', async () => {
    seedArrangement();
    mount();
    await start();

    await act(async () => {
      setTrackSoloed(getTracks()[0].id, true);
    });
    await act(async () => {
      setTrackVolumeDb(getTracks()[1].id, -12);
    });

    const update = engine().updateComposition.mock.calls.at(-1)?.[0] as Composition;
    expect(update.tracks[0].soloed).toBe(true);
    expect(update.tracks[1].volumeDb).toBe(-12);
    expect(read('playing')).toBe('true');
  });

  it('takes a loop toggle mid-playback', async () => {
    seedArrangement();
    mount();
    await start();

    await act(async () => {
      setCompositionLoop(true);
    });

    expect(engine().setLoop).toHaveBeenLastCalledWith(true);
  });

  it('makes a tempo change audible rather than only visible', async () => {
    seedArrangement();
    setCompositionBpm(120);
    mount();
    await start();
    expect(useMetronomeStore.getState().bpm).toBe(120);

    await act(async () => {
      setCompositionBpm(150);
    });

    // Nothing else pushes the composition's tempo in once playback has started
    // — without this the readout changes and the tempo does not, which is the
    // opposite of what the same control does on the pattern page.
    expect(useMetronomeStore.getState().bpm).toBe(150);
    expect(read('playing')).toBe('true');
  });

  it('re-tunes when a track changes instrument mid-playback', async () => {
    seedArrangement();
    const tracks = getTracks();
    setTrackInstrument(tracks[0].id, 'bass');
    setTrackInstrument(tracks[1].id, 'bass');
    mount();
    await start();
    expect(engine().opts.tuning.strings.length).toBe(4);

    await act(async () => {
      setTrackInstrument(tracks[1].id, 'guitar');
    });

    // `updateComposition` calls an instrument change a VOICE change and swaps
    // the voice only — the tuning it was built with never moves. A four-string
    // tuning DROPS every event on strings 4 and 5 of the new guitar part, with
    // no error and no gap in the arrangement to see it by.
    const [tuning, capo] = engine().setTuning.mock.calls.at(-1) ?? [];
    expect(tuning?.strings.length).toBe(6);
    expect(capo).toBe(0);
    // `EventScheduler.setTuning` only writes the field, so notes already
    // scheduled keep the old pitch until the stream is rebuilt.
    expect(engine().restreamAll).toHaveBeenCalled();
  });

  it('leaves the tuning alone when the widest instrument has not changed', async () => {
    seedArrangement();
    const tracks = getTracks();
    mount();
    await start();

    await act(async () => {
      setTrackInstrument(tracks[0].id, 'bass');
    });

    // The guitar track still needs six strings, so nothing moved — and a
    // needless restream cancels and reschedules every track mid-bar.
    expect(engine().setTuning).not.toHaveBeenCalled();
    expect(engine().restreamAll).not.toHaveBeenCalled();
  });

  it('restreams when an edit moves the loop boundary mid-playback', async () => {
    const { patternId } = seedArrangement();
    setCompositionLoop(true);
    mount();
    await start();
    const before = Number(read('boundary'));

    await act(async () => {
      place(patternId, getTracks()[0].id, 4 * BAR);
    });

    // `updateComposition` restreams only the tracks whose placements moved, and
    // every other track keeps a `CompositionTrackSource` built with the OLD
    // boundary — so they would loop at different points and drift apart on
    // every pass, with the playhead agreeing with none of them.
    expect(Number(read('boundary'))).toBeGreaterThan(before);
    expect(engine().restreamAll).toHaveBeenCalled();
  });

  it('does not restream for a mix change that leaves the boundary alone', async () => {
    seedArrangement();
    mount();
    await start();

    await act(async () => {
      setTrackVolumeDb(getTracks()[0].id, -6);
    });

    // A fader drag fires dozens of these; restreaming on each would cancel and
    // reschedule the whole arrangement sixty times a second.
    expect(engine().restreamAll).not.toHaveBeenCalled();
  });

  it('stops and rebuilds when a track is added mid-playback', async () => {
    seedArrangement();
    mount();
    await start();
    const first = engine();

    await act(async () => {
      addTrack('Lead');
    });

    // A scheduler constructed while the transport is already running never gets
    // its `start` event and so schedules nothing: the new track would be
    // silently absent until the next press of play. Stopping says so.
    expect(first.disposed).toBe(true);
    expect(read('playing')).toBe('false');

    await start();
    expect(lib.FakeMultiTrackPlayback.instances).toHaveLength(2);
    expect(lib.voices.filter((voice) => voice.autoConnectToMaster === false)).toHaveLength(
      2 + 3,
    );
  });
});

// ---------------------------------------------------------- the page round trip ---

describe('leaving the page', () => {
  it('stops playback and disposes the engine on unmount', async () => {
    seedArrangement();
    const view = mount();
    await start();
    const built = engine();

    view.unmount();

    expect(built.disposed).toBe(true);
    expect(lib.metronome.stop).toHaveBeenCalled();
    // The metronome owns the transport; disposing the engine alone would leave
    // it rolling behind a page nobody can see.
    expect(lib.order.indexOf('metronome.stop')).toBeLessThan(
      lib.order.indexOf('playback.dispose'),
    );
  });

  it('drops its active subscriptions', async () => {
    seedArrangement();
    const view = mount();
    await start();
    const built = engine();
    expect(built.listeners.get(getTracks()[0].id)?.size).toBe(1);

    view.unmount();

    expect(built.listeners.get(getTracks()[0].id)?.size).toBe(0);
  });

  it('leaves the pattern path able to play again', async () => {
    seedArrangement();
    const view = mount();
    await start();
    view.unmount();

    // The pattern page's leaf, mounted the way `App` mounts it after the swap:
    // `Timeline` calls `usePlaybackEngine`, and nothing on that page subscribes
    // the composition store or runs `syncComposition`.
    const pattern = render(
      createElement(function PatternProbe() {
        usePlaybackEngine();
        return null;
      }),
    );
    await act(async () => void (await play()));

    // This is the two-AudioContext / disposed-bus trap: both paths share one
    // context and one `MasterBus`, and nothing in either teardown may dispose
    // it. A failure here is silent notes with an audible click.
    expect(lib.FakeScheduler.instances).toHaveLength(1);
    expect(lib.metronome.start).toHaveBeenCalledTimes(2);
    pattern.unmount();
  });

  it('drops the engine when the open composition changes', async () => {
    seedArrangement();
    mount();
    await start();
    const built = engine();

    await act(async () => {
      usePatternsStore.getState().createComposition('Another');
    });

    expect(built.disposed).toBe(true);
    expect(read('playing')).toBe('false');
  });
});
