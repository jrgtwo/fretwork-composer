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
  MasterBus,
  PPQ,
  PatternSource,
  Voice,
  audioNow,
  buildEffectiveVoice,
  getTuning,
  getTransportTicks,
  getTuningsForInstrument,
  startAudio,
  useMetronome,
  useMetronomeStore,
  usePlaybackStore,
  type Metronome,
  type Pattern,
  type VoicePreset,
  type VoiceSource,
} from '@fretwork/lib';
import { getEditingPattern, patternInstrumentId } from '../patterns/patternService';
import { readVoiceRef, resolveVoicePreset } from '../voice/voiceService';
import { wrapToDuration } from './transportClock';

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

// ------------------------------------------------------------------ voice ---
// Which preset the engine builds from, and the classification that decides whether
// an edit can be pushed onto a live voice or needs a new one. A mistake in that
// classification is SILENT — see `sourceFingerprint`.

/**
 * The voice editor's unsaved working preset, tagged with the voice it belongs to.
 *
 * While the editor is open its working copy is the source of truth: it is not in the
 * voice store, so nothing the lib resolves can see it. Tagged rather than held bare
 * so it cannot outlive its subject — pick a different voice, change instrument or
 * open another pattern and the tag stops matching, and the stored preset takes over.
 *
 * Never written back from `voice.preset`. `swapPreset` reassigns the voice's own copy
 * from what it managed to apply — which was outright wrong for a sampler before gap 9b
 * was fixed upstream, and is still the wrong direction of travel: the working copy is
 * what the user is editing, and the voice is downstream of it.
 */
let workingPreset: { tag: string; preset: VoicePreset } | null = null;

/**
 * Identity of the *choice* — instrument plus ref, with no preset content in it.
 *
 * Built from the ref's discriminant rather than `JSON.stringify`, which would make
 * property order load-bearing: a ref rehydrated from storage as `{id, kind}` must key
 * the same as the `{kind, id}` literal a picker writes, or every reload spuriously
 * rebuilds the voice.
 */
function refKeyOf(pattern: Pattern): string {
  const ref = readVoiceRef(pattern);
  const key = ref === null ? 'none' : ref.kind === 'user' ? `u:${ref.id}` : `d:${ref.slotId}`;
  return `${patternInstrumentId(pattern)}|${key}`;
}

/**
 * What the working copy is tagged with. The pattern id is in it but deliberately NOT in
 * `refKeyOf`: two patterns can legitimately share a voice and must share the built
 * voice too, but an *unsaved* edit belongs to the pattern whose editor is open — without
 * the id it would follow the user onto the next pattern with the same instrument and ref.
 */
const workingTagOf = (pattern: Pattern) => `${pattern.id}|${refKeyOf(pattern)}`;

/**
 * Self-clearing: a tag that has stopped matching can never matter again, and leaving it
 * live means an abandoned edit resurrects the moment the pattern points back at the ref
 * it was taken from — the pane's own working copy having long since been reset.
 */
function workingPresetFor(pattern: Pattern): VoicePreset | null {
  if (workingPreset === null) return null;
  if (workingPreset.tag === workingTagOf(pattern)) return workingPreset.preset;
  workingPreset = null;
  return null;
}

/** What the engine should build for this pattern: the editor's working copy when one
 *  is in flight, otherwise whatever the lib resolves the pattern's ref to. */
const presetFor = (pattern: Pattern): VoicePreset =>
  workingPresetFor(pattern) ?? resolveVoicePreset(pattern);

/**
 * Everything about a preset that a live `Voice` has to be REBUILT for, as a string.
 *
 * This was gaps 9a and 9b — `swapPreset` used to dispose without
 * rebuilding on a source-kind change, and never reconstructed a sampler's banks. Both
 * are fixed upstream, so it is no longer here for correctness: `swapPreset` would now
 * handle a source change on its own.
 *
 * It stays because a rebuild is *expensive*, and that is ours to manage. Reconstructing
 * a sampler means one `Tone.Sampler` per bank and an HTTP load each, and `release` is a
 * **slider** — so an unthrottled path turns one drag into sixty fetch storms. Knowing
 * which edits are rebuild-class is what lets `reconcile` coalesce them (see
 * `REBUILD_COALESCE_MS`) while retuning everything else immediately. Rate limiting a
 * network-touching rebuild is permanent adapter work, not a masked gap.
 *
 * Everything outside this key — level, input gain, body filter, compressor, and all of
 * `effects` including amp, cabinet and EQs — is retuned in place; `_rebuildChain` keeps
 * the synth, so even adding or removing a chain stage is in-place-safe. Synth `params`
 * are deliberately absent: `updateSynthParams` handles pluck and FM correctly, and only
 * the kind decides which synth exists.
 *
 * The whole bank array is stringified, not just bank 0 — `detectSamplePack`'s bank-0
 * shortcut is sound for *recognising a registered pack* but not for telling two
 * arbitrary maps apart, and a collision here is an inaudible edit. Sample maps are a
 * few KB, which is cheap enough to recompute while a slider is moving.
 * `detectSamplePack` itself is the wrong tool: it returns null for anything
 * unregistered, collapsing every custom map onto one key.
 */
function sourceFingerprint(source: VoiceSource): string {
  if (source.kind !== 'sampler') return source.kind;
  return `sampler|${source.release ?? ''}|${JSON.stringify(source.samples)}`;
}

/** The identity of the built voice. Anything outside it is an in-place edit. */
const voiceKeyOf = (pattern: Pattern) =>
  `${refKeyOf(pattern)}|${sourceFingerprint(presetFor(pattern).source)}`;

function buildVoice(pattern: Pattern): Voice {
  const working = workingPresetFor(pattern);
  // Two paths, one operation — `buildEffectiveVoice` is exactly
  // `new Voice(resolveActiveVoice(instrumentId, ref))`, and it reads none of the options
  // we pass. The lib's builder stays the path for a stored voice so the resolution order
  // remains the lib's and stays the seam the audio tests mock; a working copy has no ref
  // to resolve, so it is constructed directly. Both go through `workingPresetFor`, so the
  // voice cannot disagree with the key `voiceKeyOf` computed from the same pattern.
  if (working) return new Voice(working);
  return buildEffectiveVoice(patternInstrumentId(pattern), { voiceRef: readVoiceRef(pattern) })
    .voice;
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
    emit({ headTick: wrapToDuration(getTransportTicks(PPQ), duration) });
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
  cancelPendingRebuild();
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

/**
 * Push the voice editor's working preset onto the live voice.
 *
 * The classification is the heart of this function and a mistake in it is SILENT:
 *
 *   - **source identity** — the source `kind`, or a sampler's banks and `release` —
 *     rebuilds the voice's source. `swapPreset` now does that itself (gaps 9a and 9b,
 *     fixed upstream), so this is no longer about correctness — it is about cost: a
 *     rebuild constructs one `Tone.Sampler` per bank and starts an HTTP load each, and
 *     `release` is a slider. Knowing which edits are rebuild-class is what lets them be
 *     coalesced.
 *   - **everything else** — level, input gain, body filter, compressor, and the whole
 *     effects chain including the amp, cabinet and EQs — is retuned in place, with no
 *     teardown and no sampler re-download. That is what makes dragging a slider on a
 *     live voice viable at all.
 *
 * The rebuild is not a second mechanism: `voiceKeyOf` fingerprints the source, so a
 * source-identity change simply makes the key differ and `ensureEngine`'s existing
 * branch disposes the old voice and re-points the scheduler. It is coalesced — see
 * `REBUILD_COALESCE_MS`.
 *
 * Pass `null` when the editor closes or the user discards: the working copy is
 * dropped and the live voice goes back to whatever the pattern's ref resolves to.
 *
 * For a voice *selection* rather than an edit, call `refreshVoice` — pushing the newly
 * resolved preset through here would pin it as a working copy and shadow the store.
 */
export function applyVoicePreset(preset: VoicePreset | null): void {
  // Before the pattern guard: a discard has to land even if the pattern was closed
  // first, or the abandoned edit is still what plays when it is reopened.
  if (preset === null) {
    workingPreset = null;
    cancelPendingRebuild();
  }

  const pattern = getEditingPattern();
  if (!pattern) return;

  // Recorded even with no engine up, so the next play or audition builds from the
  // working copy rather than from the stored variant it was taken from.
  if (preset !== null) workingPreset = { tag: workingTagOf(pattern), preset };

  reconcile(pattern);
}

/**
 * Bring the live voice back in line with `presetFor` — without touching the working
 * copy.
 *
 * This is how a *selection* becomes audible mid-playback. `applyVoicePreset` cannot do
 * that job: pushing the newly resolved preset through it would pin it as a working copy,
 * and from then on a `saveVoice` or `renameVoice` against the same shared variant —
 * from this pane or any other holder of the ref — would never reach the engine.
 */
export function refreshVoice(): void {
  const pattern = getEditingPattern();
  if (pattern) reconcile(pattern);
}

function reconcile(pattern: Pattern): void {
  try {
    // Computed before the engine check, and unconditionally: reading the working copy is
    // also what *drops* one whose tag has stopped matching, and that has to happen
    // whether or not there is an engine to retune. This is why a selection goes through
    // `refreshVoice` — that call is what retires the edit the user walked away from, so
    // it cannot come back when they return to the voice it was taken from.
    const key = voiceKeyOf(pattern);

    const active = engine;
    // Deliberately not `ensureEngine`: dragging a slider must not construct an audio
    // graph on a page that has never been asked to make a sound.
    if (!active) return;

    if (key !== active.voiceKey) {
      scheduleRebuild();
      return;
    }
    // `presetFor`, not an argument: on a discard there is nothing to push, and the
    // abandoned edit must not be left sounding.
    active.voice.swapPreset(presetFor(pattern));
  } catch {
    // A preset the audio graph refuses must not take the editor down with it.
  }
}

/**
 * How long a source-identity change waits before the voice is rebuilt.
 *
 * A rebuild is not a cheap operation to repeat: it constructs a `Tone.Sampler` per bank
 * and starts their HTTP loads, and `scheduler.setInstrument` disposes the outgoing voice
 * while its own loads are still in flight. `source.release` is a *slider*, so a naive
 * per-change rebuild turns one drag into sixty fetch storms. Trailing rather than
 * leading, so a continuous drag collapses into exactly one build, of the last value.
 *
 * A pane may still prefer to hold rebuild-class controls until pointer-up
 * (`rebuildsVoice` in `voice/paramSchema.ts` marks them); this makes that an
 * optimisation rather than the only thing standing between a slider and the network.
 */
const REBUILD_COALESCE_MS = 120;

let pendingRebuild: ReturnType<typeof setTimeout> | null = null;

function cancelPendingRebuild(): void {
  if (pendingRebuild === null) return;
  clearTimeout(pendingRebuild);
  pendingRebuild = null;
}

function scheduleRebuild(): void {
  cancelPendingRebuild();
  pendingRebuild = setTimeout(() => {
    pendingRebuild = null;
    const pattern = getEditingPattern();
    // Re-read rather than close over anything: whatever the working copy says *now* is
    // what should be built, which is what makes the coalescing correct rather than just
    // cheaper. A key that matches again (the user dragged back, or a `play()` already
    // rebuilt) means there is nothing left to do.
    if (!pattern || !engine || voiceKeyOf(pattern) === engine.voiceKey) return;
    try {
      // LIB-GAP(3c) again: sampler banks are only fetched by `ensureBuilt`, so a pack
      // change made mid-playback would otherwise run silent until the next `play()`.
      ensureEngine(pattern)?.voice.ensureBuilt();
    } catch {
      // As above — a preset the audio graph refuses stays inaudible, not fatal.
    }
  }, REBUILD_COALESCE_MS);
}

/** Sound Lab's default audition note — mid-neck on a guitar, still audible on a
 *  bass, so it needs no per-instrument table. */
const AUDITION_NOTE = 'A3';

/** ~50 ms. `audioNow()` is the AudioContext clock, and scheduling exactly at it
 *  immediately after the context resumes lands in the past, where the note is
 *  dropped without a word. */
const AUDITION_PREROLL_SEC = 0.05;

/**
 * Get the current voice's samples in flight, before anything asks to hear them.
 *
 * LIB-GAP(3d): `Voice` exposes no load-completion promise — only `Metronome.start()`
 * awaits `Tone.loaded()`, which is why `play()` is safe and `auditionVoice()` is not.
 * Ten of the eleven guitar slots are sampler-sourced, so on a cold page the *first*
 * audition click is otherwise the click that starts the download, and a 50 ms pre-roll
 * does not cover a network round trip: the note fires into an unloaded `Sampler` and
 * plays silently, with nothing to await and no error.
 *
 * So the pane calls this when it opens or expands, the way guitar-tutor's Sound Lab
 * warms its voice in a mount effect. Best-effort by design — it makes the first
 * audition audible, it is not a precondition for one.
 */
export async function warmVoice(): Promise<void> {
  const pattern = getEditingPattern();
  if (!pattern) return;

  try {
    await startAudio();
    await MasterBus.warmup();
    ensureEngine(pattern)?.voice.ensureBuilt();
  } catch {
    // No audio graph available; the audition path degrades the same way.
  }
}

/**
 * Play one note through the current voice with the transport stopped — what the
 * voice editor auditions a tweak with.
 *
 * Call `warmVoice` first if the samples may not be loaded — see LIB-GAP(3d) there.
 *
 * Scheduled straight onto the audio clock rather than through the metronome (which
 * owns start/stop, so using it would *be* starting playback) or through
 * `scheduler.previewCell`, which resolves a string/fret cell against a tuning and
 * capo that still have no owner (FOLLOW-UPS §3). A note name sidesteps both.
 */
export async function auditionVoice(note: string = AUDITION_NOTE): Promise<void> {
  const pattern = getEditingPattern();
  if (!pattern) return;

  try {
    await startAudio();
    // The master bus renders its reverb impulse response lazily and every voice
    // outputs through it; auditioning before it is ready is how the first note after
    // a cold load comes out dry.
    await MasterBus.warmup();

    const active = ensureEngine(pattern);
    if (!active) return;

    // LIB-GAP(3c), as in `play()`: the sampler downloads and the cabinet IR render
    // start here, not in the constructor.
    active.voice.ensureBuilt();
    active.voice.play(note, '4n', audioNow() + AUDITION_PREROLL_SEC);
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
