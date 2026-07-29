/**
 * The seam between the app and `@fretwork/lib`'s audio engine, mirroring
 * `patternService`'s role for the pattern store.
 *
 * Components call this, never `EventScheduler` / `Voice` / `useMetronome`
 * directly, because the engine is awkward in ways that shouldn't leak:
 *   - it is a graph of singletons (one AudioContext, one shared metronome, one
 *     master bus), so it can only ever be built once per page;
 *   - the metronome — not the scheduler — owns transport start/stop, which is
 *     the opposite of what the call sites read like;
 *   - head positions arrive on a requestAnimationFrame loop, and a naive
 *     `useState` would re-render every subscriber sixty times a second;
 *   - none of it exists under jsdom, so every audio call has to be survivable.
 *
 * Everything here is guarded: with no metronome mounted (tests, SSR, a browser
 * that refused the AudioContext) the hooks still work and the imperative calls
 * become no-ops rather than throwing into a click handler.
 */
import { useEffect, useSyncExternalStore } from 'react';
import {
  DEFAULT_TUNING_ID,
  EventScheduler,
  PatternSource,
  buildEffectiveVoice,
  getTuning,
  getTuningsForInstrument,
  startAudio,
  useMetronome,
  useMetronomeStore,
  usePlaybackStore,
  type Metronome,
  type Pattern,
  type VariantRef,
  type Voice,
} from '@fretwork/lib';
import { getEditingPattern, patternInstrumentId } from '../patterns/patternService';
import { readTransportTicks, wrapToDuration } from './transportClock';

/** No capo UI yet; the scheduler still needs a value. */
const CAPO = 0;

/**
 * LIB-GAP(6): the lib ships a second, unrelated audio path that arms itself.
 *
 * Its Practice-page `Playback` singleton subscribes to the *shared* metronome —
 * the one this service's transport runs — and plays a scale walk through its own
 * synth on every tick and subdivision. Its store defaults `enabled: true`, and
 * anything that calls `usePlayback()` builds it; `useFretboardModel` does, so
 * merely rendering a fretboard would layer an A-major run over the composer's
 * own playback.
 *
 * Disabled here, at module load, for two reasons: this file is the seam that
 * owns the lib's audio lifecycle, and `ensureSharedPlaybackWithMetronome` reads
 * this store for the singleton's *initial* state — so an effect would leave a
 * window in which the walk is armed. Note this only silences it: the singleton,
 * its `PluckSynthInstrument`, its `Voice` and its three metronome subscriptions
 * are still built on first render of any fretboard and are never released. No
 * audio graph comes with them — `PluckSynthInstrument` builds its synth lazily in
 * `_ensureSynth` on first `play`, and `Metronome`'s constructor deliberately
 * touches no AudioContext — so what leaks is objects and subscriptions, not nodes.
 * Delete when the lib's fretboard model stops reaching into Practice's playback.
 */
usePlaybackStore.getState().setEnabled(false);

// ------------------------------------------------------------------ store ---
// Head ticks land here ~60×/s. Components read slices through
// `useSyncExternalStore`, so React can bail out per-consumer on the slices that
// didn't move — a sweeping playhead doesn't re-render the transport button.

interface PlaybackSnapshot {
  isPlaying: boolean;
  headTick: number | null;
  activeIds: readonly string[];
}

/** Shared empty array so an idle `useActiveEventIds` keeps a stable identity. */
const NO_IDS: readonly string[] = [];
const IDLE: PlaybackSnapshot = { isPlaying: false, headTick: null, activeIds: NO_IDS };

let snapshot: PlaybackSnapshot = IDLE;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(patch: Partial<PlaybackSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => listener());
}

// Hoisted so their identity is stable across renders.
const getIsPlaying = () => snapshot.isPlaying;
const getHeadTick = () => snapshot.headTick;
const getActiveIds = () => snapshot.activeIds;

// ----------------------------------------------------------------- engine ---

interface Engine {
  metronome: Metronome;
  scheduler: EventScheduler;
  voice: Voice;
  /** What `voice` was built from — rebuilding it otherwise drops the tail. */
  voiceKey: string;
  unsubscribes: Array<() => void>;
}

let engine: Engine | null = null;

/**
 * The lib's shared metronome, published by `usePlaybackEngine`. The scheduler
 * takes it at construction and holds it for life, so the engine cannot exist
 * before a component has mounted the hook.
 */
let sharedMetronome: Metronome | null = null;

const voiceKeyOf = (pattern: Pattern) =>
  `${patternInstrumentId(pattern)}|${JSON.stringify(pattern.voiceRef ?? null)}`;

function buildVoice(pattern: Pattern): Voice {
  // `Pattern.voiceRef` is deliberately `unknown` in the lib so its pattern model
  // doesn't depend on the voices module — the lib documents casting at use.
  const voiceRef = (pattern.voiceRef ?? null) as VariantRef | null;
  return buildEffectiveVoice(patternInstrumentId(pattern), { voiceRef }).voice;
}

/**
 * The engine for the given pattern, built on first use. Returns null when there
 * is no transport to hang it on, which is the normal state under jsdom.
 */
function ensureEngine(pattern: Pattern): Engine | null {
  const metronome = sharedMetronome;
  if (!metronome) return null;

  try {
    const voiceKey = voiceKeyOf(pattern);

    if (engine) {
      if (engine.voiceKey !== voiceKey) {
        const voice = buildVoice(pattern);
        engine.scheduler.setInstrument(voice);
        engine.voice.dispose();
        engine.voice = voice;
        engine.voiceKey = voiceKey;
      }
      return engine;
    }

    // Tuning and capo are fixed until their UI slice lands.
    const tuning =
      getTuningsForInstrument(patternInstrumentId(pattern))[0] ?? getTuning(DEFAULT_TUNING_ID);
    if (!tuning) return null;

    const voice = buildVoice(pattern);
    const scheduler = new EventScheduler({
      metronome,
      instrument: voice,
      tuning,
      capo: CAPO,
      // 'primary' is what tracks the active-note set; a second primary would
      // fight this one for it. (It does NOT drive the playhead in this build —
      // see the head loop below.)
      role: 'primary',
    });

    engine = {
      metronome,
      scheduler,
      voice,
      voiceKey,
      unsubscribes: [
        // Only fires at transport start and stop in this build, so it seeds the
        // head rather than sweeping it. Guarded so the stop-time emit can't put
        // the playhead back on screen after `stop()` cleared it.
        scheduler.onHead((headTick) => {
          if (snapshot.isPlaying) emit({ headTick });
        }),
        scheduler.onActive((active) => {
          if (!snapshot.isPlaying) return;
          emit({ activeIds: active.length ? active.map((event) => event.id) : NO_IDS });
        }),
        scheduler.onComplete(stop),
      ],
    };
    return engine;
  } catch {
    // No audio graph available — playback stays silent rather than taking the
    // caller down with it.
    return null;
  }
}

// ------------------------------------------------------------- head loop ---
// LIB-GAP(3b): delete this loop and subscribe to `scheduler.onHead` once the
// scheduler starts its visual loop. See docs/FOLLOW-UPS.md.
//
// `EventScheduler.onHead` cannot drive a moving playhead in this build of the
// lib: it has a `_stopVisualLoop` but no matching start, so head positions are
// only emitted twice — once at transport start and once at stop. Reading the
// transport ourselves is what the lib's own docs point at ("the sync path
// should use getTransportTicks for the playhead").

let headRafId: number | null = null;

function startHeadLoop(): void {
  if (headRafId !== null) return;
  const frame = () => {
    if (!snapshot.isPlaying) {
      headRafId = null;
      return;
    }
    const duration = getEditingPattern()?.durationTicks ?? 0;
    emit({ headTick: wrapToDuration(readTransportTicks(), duration) });
    headRafId = requestAnimationFrame(frame);
  };
  headRafId = requestAnimationFrame(frame);
}

function stopHeadLoop(): void {
  if (headRafId === null) return;
  cancelAnimationFrame(headRafId);
  headRafId = null;
}

/** Teardown is best-effort — a half-built audio graph still has to let go. */
function attempt(fn: () => void): void {
  try {
    fn();
  } catch {
    // Nothing to do; the caller is already on its way out.
  }
}

function disposeEngine(): void {
  const current = engine;
  engine = null;
  if (!current) return;

  stopHeadLoop();
  current.unsubscribes.forEach((unsubscribe) => unsubscribe());
  // The metronome owns the transport and `scheduler.dispose()` only cancels the
  // scheduler's own events, so tearing down mid-playback without this leaves the
  // transport rolling and the click audible with nothing left holding the handle.
  attempt(() => current.metronome.stop());
  // Separate attempts: a throw from one step must not skip the next, or the
  // audio nodes outlive the page's only reference to them. The voice dispose is
  // belt-and-braces — the scheduler disposes whatever instrument it holds — and
  // `Voice.dispose` null-guards every node, so the second pass is a no-op.
  attempt(() => current.scheduler.dispose());
  attempt(() => current.voice.dispose());
  emit(IDLE);
}

// ------------------------------------------------------------------- API ----

/**
 * Mounts the engine's lifecycle. Call once — the scheduler is a singleton, and a
 * second caller would just re-publish the same metronome.
 *
 * Call it from a leaf that renders (next to) nothing, not from a heavy component:
 * `useMetronome` reads the beat counters out of the lib's metronome store, so its
 * caller re-renders on every beat and subdivision for as long as the transport
 * runs. The playhead below avoids that; this hook can't.
 */
export function usePlaybackEngine(): void {
  const { metronome } = useMetronome();

  useEffect(() => {
    sharedMetronome = metronome;
    // Tearing down on any metronome change, not just unmount: the scheduler
    // captured the old one at construction and can't be re-pointed.
    return () => {
      sharedMetronome = null;
      disposeEngine();
    };
  }, [metronome]);
}

/** Must be called from a user gesture — the AudioContext unlock demands one. */
export async function play(): Promise<void> {
  // Re-entrant play is worse than a no-op: `metronome.start()` ignores the
  // second call, but `setStream` below would clear the live schedule and wait
  // for a start that never comes — silent audio under a still-sweeping head.
  if (snapshot.isPlaying) return;

  const pattern = getEditingPattern();
  if (!pattern) return;

  try {
    await startAudio();

    const active = ensureEngine(pattern);
    if (!active) return;

    // LIB-GAP(3c): the engine should warm itself. Until it does, this ordering
    // is load-bearing — see the comment below.
    // Building the voice kicks off the sampler downloads and the cabinet IR
    // render; `metronome.start()` then awaits `Tone.loaded()`. Start the
    // transport first and the first note fires into an empty buffer — silently.
    active.voice.ensureBuilt();

    active.scheduler.setStream(new PatternSource(pattern));
    active.scheduler.setLoop(pattern.loop);
    emit({ isPlaying: true, headTick: 0, activeIds: NO_IDS });
    startHeadLoop();
    await active.metronome.start();
  } catch {
    // `metronome.start()` can reject after it has already claimed the
    // transport, so clearing the flags is not enough — go through `stop()` so
    // the transport is released too.
    stop();
  }
}

export function stop(): void {
  const current = engine;
  // Cleared first so any in-flight head frame is dropped by the guard above.
  emit(IDLE);
  stopHeadLoop();
  if (!current) return;

  try {
    current.metronome.stop();
  } catch {
    // Already stopped, or never really started.
  }
}

/** Click-to-audition a fretboard cell, independent of the transport. */
export function previewNote(stringIndex: number, fret: number): void {
  const pattern = getEditingPattern();
  if (!pattern) return;

  const active = ensureEngine(pattern);
  if (!active) return;

  try {
    active.voice.ensureBuilt();
    // No `startAudio()` here — `previewCell` awaits it internally before it
    // triggers, so the unlocking click is also the first audible one.
    active.scheduler.previewCell(stringIndex, fret);
  } catch {
    // Auditioning is best-effort; it must never break the click that asked.
  }
}

export function useIsPlaying(): boolean {
  return useSyncExternalStore(subscribe, getIsPlaying, getIsPlaying);
}

/** Playhead position in ticks, or null when stopped. */
export function useHeadTick(): number | null {
  return useSyncExternalStore(subscribe, getHeadTick, getHeadTick);
}

/** Ids of the events currently sounding — these match `PatternEvent.id`. */
export function useActiveEventIds(): readonly string[] {
  return useSyncExternalStore(subscribe, getActiveIds, getActiveIds);
}

/**
 * The metronome click, which is separate from the notes: it bypasses the master
 * bus entirely, so muting it silences the count without touching the music.
 */
export function useClickMuted(): boolean {
  return useMetronomeStore((s) => s.clickMuted);
}

/** The live transport tempo. Distinct from the pattern's stored preference. */
export function useTempo(): number {
  return useMetronomeStore((s) => s.bpm);
}

export function setTempo(bpm: number): void {
  useMetronomeStore.getState().setBpm(bpm);
}

export function toggleClick(): void {
  useMetronomeStore.getState().toggleClickMuted();
}
