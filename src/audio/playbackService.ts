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
 *
 * TWO PATHS, ONE GRAPH (CP-08). The pattern page plays one `EventScheduler`
 * through one `Voice`; the composition page plays a `MultiTrackPlayback`, which
 * is one of each PER TRACK. They share the metronome, the AudioContext and the
 * `MasterBus` — deliberately, and it is the sharpest edge in this module. See
 * the composition section below before touching either of them.
 */
import { useEffect, useSyncExternalStore } from 'react';
import {
  DEFAULT_TUNING_ID,
  EventScheduler,
  MasterBus,
  MultiTrackPlayback,
  PPQ,
  PatternSource,
  Voice,
  audioNow,
  buildEffectiveVoice,
  getTuning,
  getTuningsForInstrument,
  placementEndTick,
  resolveEffectivePlayback,
  startAudio,
  totalDurationTicks as libTotalDurationTicks,
  useMetronome,
  useMetronomeStore,
  type Composition,
  type Metronome,
  type Pattern,
  type Placement,
  type ScheduledEvent,
  type Track,
  type TuningDef,
  type VoicePreset,
  type VoiceSource,
} from '@fretwork/lib';
import { getEditingPattern, patternInstrumentId } from '../patterns/patternService';
import {
  findTrack,
  getEditingComposition,
  trackInstrumentId,
  useEditingComposition,
  type Result,
} from '../composition/compositionService';
import { readTrackVoiceRef, readVoiceRef, resolveVoicePreset } from '../voice/voiceService';
import {
  readTrackVoiceDraft,
  subscribeTrackVoiceDrafts,
  trackVoicePreset,
} from '../voice/trackVoiceDrafts';
import { audibleTransportTicks, wrapToDuration } from './transportClock';

/** No capo UI yet; the scheduler still needs a value. */
const CAPO = 0;

/** Same shape the composition seam refuses with — see its `Result` docblock. */
const ok = (): Result => ({ ok: true, value: undefined });
const refuse = (reason: string): Result => ({ ok: false, reason });

// ------------------------------------------------------------------ store ---
// Head ticks land here ~60×/s. Components read slices through
// `useSyncExternalStore`, so React can bail out per-consumer on the slices that
// didn't move — a sweeping playhead doesn't re-render the transport button.

interface PlaybackSnapshot {
  isPlaying: boolean;
  headTick: number | null;
  activeIds: readonly string[];
  /**
   * Ids of the placements the head is inside. Composition path only — the
   * pattern page has no placements — and deliberately a slice of its own rather
   * than something derived per render: it changes at placement boundaries, not
   * at frame rate, so a grid that subscribes to it re-renders a handful of times
   * a bar instead of sixty times a second.
   */
  activePlacementIds: readonly string[];
  /**
   * The tick composition playback wraps at, or 0 when nothing is playing.
   *
   * Published because it is NOT a number the arrangement can work out for
   * itself — see `loopBoundaryOf` for why it is the lib's over-long duration
   * rather than the corrected one the ruler is drawn from.
   */
  loopBoundaryTicks: number;
}

/** Shared empty array so an idle `useActiveEventIds` keeps a stable identity. */
const NO_IDS: readonly string[] = [];
const IDLE: PlaybackSnapshot = {
  isPlaying: false,
  headTick: null,
  activeIds: NO_IDS,
  activePlacementIds: NO_IDS,
  loopBoundaryTicks: 0,
};

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
const getActivePlacementIds = () => snapshot.activePlacementIds;
const getLoopBoundaryTicks = () => snapshot.loopBoundaryTicks;

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
        // Sweeps during playback: the scheduler emits the head from the same poll
        // that computes the highlights, already folded into the loop region — so the
        // playhead and the lit notes can never disagree. Still guarded, because the
        // stop-time emit must not put the playhead back on screen after `stop()`
        // cleared it.
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
      // Both paths, always. They hold the SAME metronome — the lib's singleton —
      // so a composition engine left standing after this would be holding a
      // handle nothing on screen can reach, exactly the way the pattern engine
      // used to.
      disposeCompositionEngine();
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

    active.scheduler.setStream(new PatternSource(pattern));
    active.scheduler.setLoop(pattern.loop);
    emit({ isPlaying: true, headTick: 0, activeIds: NO_IDS });
    await active.metronome.start();
  } catch {
    // `metronome.start()` can reject after it has already claimed the
    // transport, so clearing the flags is not enough — go through `stop()` so
    // the transport is released too.
    stop();
  }
}

/**
 * Stop whichever path is playing.
 *
 * ONE function for both, because there is one transport: the metronome is the
 * lib's singleton and both engines hold the same instance, so `metronome.stop()`
 * is the same call whichever of them started it. Making the caller pick would
 * mean `App.tsx`'s page-change effect had to know which page it was leaving —
 * and the one it forgot would keep the transport rolling behind a hidden
 * document, which is the bug this exists to prevent.
 */
export function stop(): void {
  const composition = compositionEngine;
  // Cleared first so any in-flight head frame — the scheduler's or the
  // composition path's rAF — is dropped by the guard in each loop.
  emit(IDLE);
  if (composition) stopHeadLoop(composition);

  const metronome = engine?.metronome ?? composition?.metronome;
  if (!metronome) return;

  try {
    metronome.stop();
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
      // A pack change made mid-playback has to fetch now — the metronome's pre-start
      // warm only runs at start, and we are already playing.
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
 * Get the current voice's samples loaded, before anything asks to hear them.
 *
 * Ten of the eleven guitar slots are sampler-sourced, so on a cold page the first
 * audition click would otherwise be the click that starts the download — and the 50 ms
 * pre-roll does not cover a network round trip, so the note fires into an unloaded
 * `Sampler` and plays silently.
 *
 * `Voice.ready()` is what makes this waitable: it builds the graph and resolves once
 * the buffers are decoded. The pane calls this when it opens or expands, the way
 * guitar-tutor's Sound Lab warms its voice in a mount effect. Still best-effort — it
 * makes the first audition audible, it is not a precondition for one.
 */
export async function warmVoice(): Promise<void> {
  const pattern = getEditingPattern();
  if (!pattern) return;

  try {
    await startAudio();
    await MasterBus.warmup();
    await ensureEngine(pattern)?.voice.ready();
  } catch {
    // No audio graph available; the audition path degrades the same way.
  }
}

/**
 * Play one note through the current voice with the transport stopped — what the
 * voice editor auditions a tweak with.
 *
 * Call `warmVoice` first if the samples may not be loaded.
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

    // Synchronous: an audition must fire on the click that asked for it. `warmVoice`
    // is what awaits the load — this only guarantees the graph exists.
    active.voice.ensureBuilt();
    active.voice.play(note, '4n', audioNow() + AUDITION_PREROLL_SEC);
  } catch {
    // Auditioning is best-effort; it must never break the click that asked.
  }
}

// ------------------------------------------------- track audition (CP-15) ---
/**
 * ⚠ WHY THIS IS NOT `auditionVoice`.
 *
 * That one resolves its voice through `getEditingPattern()`. Called from the
 * composition page's voice rail it would play whichever pattern or placement
 * happens to be open rather than the track whose voice is being picked —
 * silently wrong, and it reads as the picker not working.
 *
 * The track's voice is resolved through `trackVoicePreset`, which is the SAME
 * call `buildTrackVoice` reaches through `readTrackVoiceDraft`: the unsaved
 * draft when there is one, the stored ref otherwise. So the audition is of what
 * playback will actually do, including edits no variant holds yet — which is the
 * only version of this worth having, since the rack is where the tweaking
 * happens.
 *
 * ── Its own `Voice`, and why it cannot borrow the engine's ───────────────────
 *
 * `MultiTrackPlayback` keeps its per-track `Voice` objects private and exposes
 * only `setTrackVoice(trackId)` (the same enclosure LIB-GAP(19) is about), so
 * there is nothing to reach for. The pattern path can borrow `engine.voice`;
 * this one cannot, and building a rig of its own is the alternative rather than
 * a preference.
 *
 * ONE rig, not one per track: it is a preview, only ever sounding one note at a
 * time, and eight idle `Tone.Sampler` sets would be eight bank loads for a
 * button most users press once. Re-pointing it at another track's preset is a
 * `swapPreset` while the SOURCE is unchanged — the whole point of that call — and
 * a rebuild only when the source itself differs, which is the same
 * `sourceFingerprint` classification the pattern engine uses.
 *
 * ⚠ It connects to `MasterBus` (the constructor's default), which is the
 * opposite of `buildTrackVoice`'s `autoConnectToMaster: false` — deliberately.
 * There is no per-track gain to insert here, so a voice that did not connect
 * would be inaudible. The consequence is that an audition ignores the track's
 * fader, mute and solo: it is an audition of the VOICE, not a preview of the
 * mix, and a muted track still has to be tunable.
 */
let auditionRig: { fingerprint: string; preset: VoicePreset; voice: Voice } | null = null;

function disposeAuditionRig(): void {
  const rig = auditionRig;
  auditionRig = null;
  if (rig) attempt(() => rig.voice.dispose());
}

function auditionRigFor(preset: VoicePreset): Voice {
  const fingerprint = sourceFingerprint(preset.source);
  const current = auditionRig;
  if (current && current.fingerprint === fingerprint) {
    // Identity, not deep equality: every edit mints a new preset object
    // (`setAtPath`), and one that is the same object is the same tone.
    if (current.preset !== preset) {
      current.voice.swapPreset(preset);
      current.preset = preset;
    }
    return current.voice;
  }
  disposeAuditionRig();
  const voice = new Voice(preset);
  auditionRig = { fingerprint, preset, voice };
  return voice;
}

/** What the rig should be holding for this track, or null when the track is
 *  gone — which is reachable by id from the agent, and by an undo that retracts
 *  a track between the hover and the click. */
function trackAuditionPreset(trackId: string): VoicePreset | null {
  const track = findTrack(trackId);
  return track ? trackVoicePreset(track) : null;
}

/**
 * Get one track's voice loaded before anything asks to hear it —
 * {@link warmVoice} for the track path, and needed for the same reason: ten of
 * the eleven guitar slots are sampler-sourced, so on a cold page the first
 * audition click would otherwise be the click that starts the download.
 */
export async function warmTrackVoice(trackId: string): Promise<void> {
  const preset = trackAuditionPreset(trackId);
  if (!preset) return;

  try {
    await startAudio();
    await MasterBus.warmup();
    await auditionRigFor(preset).ready();
  } catch {
    // No audio graph available; the audition path degrades the same way.
  }
}

/** Play one note through ONE TRACK's voice with the transport stopped. Call
 *  {@link warmTrackVoice} first if the samples may not be loaded. */
export async function auditionTrackVoice(
  trackId: string,
  note: string = AUDITION_NOTE,
): Promise<void> {
  const preset = trackAuditionPreset(trackId);
  if (!preset) return;

  try {
    await startAudio();
    // The master bus renders its reverb impulse response lazily and every voice
    // outputs through it; auditioning before it is ready is how the first note
    // after a cold load comes out dry.
    await MasterBus.warmup();

    const voice = auditionRigFor(preset);
    // Synchronous from here: an audition must fire on the click that asked for
    // it. `warmTrackVoice` is what awaits the load.
    voice.ensureBuilt();
    voice.play(note, '4n', audioNow() + AUDITION_PREROLL_SEC);
  } catch {
    // Auditioning is best-effort; it must never break the click that asked.
  }
}

// ------------------------------------------------- composition playback ---
// The second engine. `MultiTrackPlayback` builds one (Voice → per-track Gain →
// master Gain) chain and one `EventScheduler` per track and drives them all from
// the SAME metronome and the SAME `MasterBus` as the pattern path above.
//
// ⚠ THE SHARED GRAPH IS THE WHOLE RISK HERE. `tone` is a peer dependency
// precisely so there is one AudioContext; two copies would be two contexts and
// nothing would play in time with anything. `MasterBus` is a module singleton on
// the lib side and NOTHING in this app may dispose it — `NotesBus` caches its
// gain and short-circuits forever, so a torn-down bus leaves every voice feeding
// a disposed graph while the metronome click, which bypasses the bus, keeps
// sounding. SILENT NOTES WITH AN AUDIBLE CLICK MEANS A DISPOSED BUS, not a
// scheduling bug. `MultiTrackPlayback.dispose` only disconnects its own master
// gain (`MasterBus.disconnectVoice`), which is why building and tearing this
// path down repeatedly is safe.

interface CompositionEngine {
  metronome: Metronome;
  playback: MultiTrackPlayback;
  /** Which document it was built for — a switch is a rebuild, not an update. */
  compositionId: string;
  /** The snapshot the engine currently holds, kept in step by `syncComposition`. */
  composition: Composition;
  /**
   * The tuning every scheduler currently holds. Kept because the engine takes
   * one at construction and never recomputes it — see {@link compositionTuning}
   * and `syncComposition`, where a track's instrument change has to push a new
   * one in or events on the strings the old tuning lacks are silently dropped.
   */
  tuningId: string;
  /** Where playback wraps. See {@link loopBoundaryOf}. */
  loopTicks: number;
  loop: boolean;
  /** The head rAF, or null when it isn't running. */
  headFrame: number | null;
  /** Dedup keys, so an unchanged set keeps its array identity across frames. */
  placementKey: string;
  activeKey: string;
  /** Active event ids per track, merged into one published set. */
  trackActive: Map<string, readonly string[]>;
  unsubscribes: Array<() => void>;
}

let compositionEngine: CompositionEngine | null = null;

/**
 * The tuning every track is played through.
 *
 * LIB-GAP(15): `MultiTrackPlaybackOpts` takes ONE `tuning` and ONE `capo` and
 * hands the same pair to every per-track `EventScheduler`, so a track's
 * `instrumentId` selects its VOICE and nothing else. Something has to be chosen,
 * and the two failure modes are not symmetric: a tuning with FEWER strings than
 * a track's part silently DROPS every event above its last string, where a
 * tuning with more strings only mis-pitches — a bass part at guitar pitch is
 * wrong and obvious, a bass part with its top string missing is wrong and
 * invisible. So the widest tuning among the tracks' instruments wins.
 *
 * Delete when `MultiTrackPlayback` derives a tuning per track from that track's
 * own instrument. See docs/FOLLOW-UPS.md.
 */
function compositionTuning(composition: Composition): TuningDef | null {
  let widest: TuningDef | null = null;
  for (const track of composition.tracks) {
    const candidate = getTuningsForInstrument(trackInstrumentId(track))[0];
    if (!candidate) continue;
    if (!widest || candidate.strings.length > widest.strings.length) widest = candidate;
  }
  return widest ?? getTuning(DEFAULT_TUNING_ID) ?? null;
}

/**
 * Where composition playback wraps.
 *
 * LIB-GAP(11) is deliberately NOT corrected here, which is the opposite of what
 * `compositionService.compositionEndTick` and `arrangementMath.contentEndTick` do —
 * and the difference is the point. Those two answer "how wide is the
 * arrangement", which the ruler and the blocks are drawn from, so they have to
 * measure a truncated placement by its `lengthTicks`. This one answers "where
 * does the audio come back round", and `MultiTrackPlayback` computes that with
 * the lib's own (over-long) `totalDurationTicks` for every one of its
 * `CompositionTrackSource`s. Correcting it here would put the playhead back at
 * bar 1 while the tracks were still running out the extra bars — a playhead that
 * disagrees with the ear is worse than one that agrees with a bug.
 *
 * Delete the alias, not the call, when the lib's `totalDurationTicks` routes
 * through `placementEndTick`: at that point both numbers are the same number.
 */
const loopBoundaryOf = (composition: Composition): number =>
  libTotalDurationTicks(composition);

/**
 * The voice a track plays through.
 *
 * `autoConnectToMaster: false` is REQUIRED, not a preference:
 * `MultiTrackPlayback` inserts a per-track `Tone.Gain` between the voice and the
 * master, and it can only do that if the voice has not already wired its own
 * output to `MasterBus`. A voice that connected itself would still be audible —
 * and would ignore its track's fader, mute and solo entirely.
 *
 * The track's OWN ref (CP-13), read through the voice seam so the `unknown` cast
 * and its validation stay in the one module that owns them. A null ref is not a
 * missing value: it is the lib's documented fallback to the instrument's global
 * active variant, and `resolveActiveVoice` treats it as exactly that — so a
 * track nobody has picked a voice for still sounds like the rest of the app.
 *
 * `sourceFingerprint` is deliberately NOT consulted here, and this is the one
 * place that could look like an omission: `Voice.swapPreset` is never called on
 * this path at all. `MultiTrackPlayback.setTrackVoice` constructs a whole new
 * `Voice` through this factory and disposes the old one after a release tail, so
 * the rebuild-versus-retune classification the pattern path needs simply does not
 * arise for a track — there is nothing live to retune.
 *
 * CP-14: a track's rack edits go through `trackVoiceDrafts`, which holds a
 * preset no variant has yet — so nothing the lib resolves can see it and the
 * draft has to be built directly, exactly as `buildVoice` does for the pattern
 * page's working copy. `new Voice(…, { autoConnectToMaster: false })` is the
 * same opt-out `buildEffectiveVoice` is passed, and it is REQUIRED rather than
 * preferred: a voice that wired itself to `MasterBus` would ignore its track's
 * fader, mute and solo entirely. `readTrackVoiceDraft` is also what retires a
 * draft whose voice choice has moved on, so this is the call that makes a
 * changed ref win over a stale edit.
 */
function buildTrackVoice(track: Track): Voice {
  const draft = readTrackVoiceDraft(track);
  if (draft) return new Voice(draft, { autoConnectToMaster: false });
  return buildEffectiveVoice(trackInstrumentId(track), {
    autoConnectToMaster: false,
    voiceRef: readTrackVoiceRef(track),
  }).voice;
}

/** One trailing timer PER TRACK — see {@link scheduleTrackVoiceRebuild} for why
 *  this is a map and not a single handle. */
const pendingTrackRebuilds = new Map<string, ReturnType<typeof setTimeout>>();

function cancelPendingTrackRebuilds(): void {
  pendingTrackRebuilds.forEach((timer) => clearTimeout(timer));
  pendingTrackRebuilds.clear();
}

/**
 * Make one track's unsaved voice edit audible.
 *
 * LIB-GAP(19): this is a full voice REBUILD for what is a knob turn. The pattern
 * page retunes in place — `Voice.swapPreset` mutates the live chain, which is
 * what makes dragging a slider on a live voice viable at all — but
 * `MultiTrackPlayback` keeps its per-track `Voice` objects private and exposes
 * only `setTrackVoice(trackId)`, which rebuilds through the `buildVoice` factory
 * and disposes the outgoing voice after a release tail. So an amp knob costs one
 * `Tone.Sampler` per bank and an HTTP load each, where the same knob on the
 * pattern page costs a parameter write. Delete when `MultiTrackPlayback` exposes
 * the track's voice (or a `setTrackPreset(trackId, preset)`); see
 * docs/FOLLOW-UPS.md.
 *
 * Coalesced on {@link REBUILD_COALESCE_MS} — the SAME window the pattern path's
 * rebuild uses, and for the same reason rather than a second policy: a knob is a
 * drag, and an unthrottled path turns one gesture into sixty rebuilds. Keyed by
 * track, because two racks can be edited in one window and one rebuild must not
 * swallow the other's. Trailing, so a continuous drag collapses into exactly one
 * build, of the last value.
 *
 * Deliberately NOT gated on `snapshot.isPlaying`: with the transport stopped the
 * swap is what keeps the engine current, so the next press of Play sounds the
 * edit rather than the variant it was taken from.
 */
function scheduleTrackVoiceRebuild(trackId: string): void {
  const pending = pendingTrackRebuilds.get(trackId);
  if (pending !== undefined) clearTimeout(pending);
  pendingTrackRebuilds.set(
    trackId,
    setTimeout(() => {
      pendingTrackRebuilds.delete(trackId);
      // Re-read rather than close over the engine: it can have been disposed
      // (a document switch, a track added) inside the window, and whatever is
      // live NOW is what should be rebuilt.
      const active = compositionEngine;
      if (!active) return;
      // Attempted, not trusted: a preset the audio graph refuses must not take
      // the edit down with it — the draft is already recorded and the next play
      // builds from it.
      attempt(() => active.playback.setTrackVoice(trackId));
    }, REBUILD_COALESCE_MS),
  );
}

/**
 * CP-14's live retune, subscribed HERE rather than from a component's effect.
 *
 * Module scope because that is the ENGINE's scope: `compositionEngine` is a
 * module binding, and a listener whose job is "rebuild that engine's voice"
 * should live and die with it rather than with whichever component happened to
 * mount. `setTrackVoiceParam` is documented as reachable by id and value with no
 * pointer, so nothing about it should depend on a render tree existing.
 *
 * Never torn down, and nothing leaks by it: `scheduleTrackVoiceRebuild` no-ops
 * while `compositionEngine` is null (which is exactly the state the composition
 * page's unmount leaves behind — it stops playback and disposes both engines),
 * and `disposeCompositionEngine` cancels whatever is already in flight. A draft
 * written with no engine standing is not lost either: `buildTrackVoice` reads
 * the drafts store, so the next engine is built from it.
 */
subscribeTrackVoiceDrafts(scheduleTrackVoiceRebuild);

/**
 * Tracks whose voice change the ENGINE'S OWN DIFF will miss.
 *
 * The ordinary case needs nothing from us: `diffTracks` classifies a `voiceRef`
 * change as `'voice'` and `updateComposition` calls `setTrackVoice(trackId)`
 * itself, which builds the new voice, hands it to that track's scheduler and
 * disposes the old one after a 4 s tail — a click-free swap mid-playback, for one
 * track and no other.
 *
 * LIB-GAP(18): that diff picks ONE action per track by priority, and `restream`
 * outranks `voice`. So an update in which a track's placements AND its voiceRef
 * both moved reschedules the notes and keeps the OLD voice — silently, and until
 * something else happens to rebuild. Two seam writes landing in one React tick is
 * all it takes, which is a normal shape for the agent's tools and reachable by
 * hand through undo. Named here and swapped explicitly rather than blanket-calling
 * `setTrackVoice` on every voiceRef change, which would double-build the voice
 * (one `Tone.Sampler` and an HTTP load per bank) for the case the lib gets right.
 *
 * Delete when `diffTracks` reports the voice swap alongside the restream. See
 * docs/FOLLOW-UPS.md.
 */
function voiceSwapsMissedByDiff(previous: Composition, next: Composition): string[] {
  const missed: string[] = [];
  next.tracks.forEach((track, index) => {
    // Index-matched because that is how `diffTracks` pairs them; a shape change
    // never reaches here (`updateComposition` returns true and the engine goes).
    const before = previous.tracks[index];
    if (!before || before.id !== track.id) return;
    if (track.placements === before.placements) return;
    if (track.voiceRef === before.voiceRef && track.instrumentId === before.instrumentId) {
      return;
    }
    missed.push(track.id);
  });
  return missed;
}

/**
 * The composition engine, built on first use. Null when there is no transport to
 * hang it on, which is the normal state under jsdom.
 */
function ensureCompositionEngine(composition: Composition): CompositionEngine | null {
  const metronome = sharedMetronome;
  if (!metronome) return null;

  const current = compositionEngine;
  if (current && current.compositionId === composition.id) return current;
  // A different document: nothing about the old engine's tracks, voices or
  // schedulers transfers, so it goes rather than being updated into place.
  if (current) disposeCompositionEngine();

  let playback: MultiTrackPlayback;
  let tuningId: string;
  try {
    const tuning = compositionTuning(composition);
    if (!tuning) return null;
    tuningId = tuning.id;

    playback = new MultiTrackPlayback({
      composition,
      metronome,
      tuning,
      capo: CAPO,
      buildVoice: buildTrackVoice,
    });
  } catch {
    // No audio graph available — the page stays silent rather than taking the
    // click that asked down with it.
    return null;
  }

  // Its own try, because the constructor has ALREADY connected a master gain to
  // the shared `MasterBus` and built a voice per track: a throw past this point
  // with a bare `return null` would strand all of that with no handle left to
  // dispose it.
  try {
    const engineForComposition: CompositionEngine = {
      metronome,
      playback,
      compositionId: composition.id,
      composition,
      tuningId,
      loopTicks: loopBoundaryOf(composition),
      loop: composition.loop,
      headFrame: null,
      placementKey: '',
      activeKey: '',
      trackActive: new Map(),
      unsubscribes: [],
    };

    for (const track of composition.tracks) {
      engineForComposition.unsubscribes.push(
        playback.onTrackActive(track.id, (events) =>
          onTrackActive(engineForComposition, track.id, events),
        ),
      );
    }

    // With looping off the audio simply ends, and nothing else would notice: the
    // transport keeps rolling, the button keeps reading Stop and the head keeps
    // climbing unwrapped, so the playhead sweeps off the grid and follow-scroll
    // pages after it into empty space. Every scheduler is built from the same
    // composition-wide boundary and so completes on the same tick; `stop()` is
    // idempotent, so subscribing all of them costs nothing.
    for (const scheduler of playback.schedulers) {
      engineForComposition.unsubscribes.push(scheduler.onComplete(stop));
    }

    compositionEngine = engineForComposition;
    return engineForComposition;
  } catch {
    attempt(() => playback.dispose());
    return null;
  }
}

function disposeCompositionEngine(): void {
  const current = compositionEngine;
  compositionEngine = null;

  // ⚠ ABOVE THE EARLY RETURN, and that is the whole point of where it sits. The
  // audition rig's lifetime is this PAGE's, not this ENGINE's: `warmTrackVoice`
  // and `auditionTrackVoice` build it without ever calling
  // `ensureCompositionEngine`, so the ordinary flow — open voice mode, audition a
  // few voices, never press Play — leaves a rig standing while
  // `compositionEngine` is still null. Below the guard this would never run in
  // exactly that case, stranding a voice on the shared `MasterBus` with no handle
  // left to dispose it.
  disposeAuditionRig();

  if (!current) return;

  stopHeadLoop(current);
  // Before the teardown: a rebuild that fired after this would build a voice for
  // an engine nothing on screen can reach, and connect it to the shared
  // `MasterBus` with no handle left to dispose it.
  cancelPendingTrackRebuilds();
  current.unsubscribes.forEach((unsubscribe) => unsubscribe());
  // The metronome owns the transport and `MultiTrackPlayback.dispose()` only
  // tears down its own schedulers, voices and gains — tearing this down
  // mid-playback without stopping first leaves the transport rolling and the
  // click audible with nothing left holding the handle. Same order, and the same
  // reason, as `disposeEngine` above.
  attempt(() => current.metronome.stop());
  attempt(() => current.playback.dispose());
  emit(IDLE);
}

/**
 * Note-level highlighting, per track.
 *
 * LIB-GAP(16): this delivers nothing during playback in this build, and is wired
 * anyway. `MultiTrackPlayback` constructs EVERY one of its schedulers with
 * `role: 'follower'`, and `EventScheduler` starts the poll that emits `onActive`
 * (and `onHead`) only when `role === 'primary'` — so the callbacks
 * `onTrackActive` is documented for ("the arranger UI that wants per-lane
 * highlighting") fire exactly twice: an empty set on start and an empty set on
 * stop. The block highlight the arrangement actually draws is derived from the
 * head instead, in {@link pollHead} — which is also why the head is read from
 * the transport here rather than subscribed to.
 *
 * Delete both workarounds when `MultiTrackPlayback` promotes the scheduler for
 * `_primaryTrackId` to `role: 'primary'` — it already tracks which track that
 * is. See docs/FOLLOW-UPS.md.
 */
function onTrackActive(
  active: CompositionEngine,
  trackId: string,
  events: readonly ScheduledEvent[],
): void {
  if (!snapshot.isPlaying) return;
  active.trackActive.set(
    trackId,
    events.length ? events.map((event) => event.id) : NO_IDS,
  );
  const merged: string[] = [];
  for (const ids of active.trackActive.values()) merged.push(...ids);
  const key = merged.join(',');
  if (key === active.activeKey) return;
  active.activeKey = key;
  emit({ activeIds: merged.length ? merged : NO_IDS });
}

/**
 * One frame of the head: where the transport is, and what it is inside.
 *
 * Read from the transport rather than subscribed to, for LIB-GAP(16)'s reason —
 * no scheduler in this path is a primary, so nothing emits a head at all. The
 * read is folded back into the loop boundary here, because the schedulers
 * reschedule each iteration at ever-increasing absolute ticks and an unwrapped
 * head simply runs off the end of the grid.
 *
 * Through `audibleTransportTicks`, never `getTransportTicks` — the lib's read is
 * one lookAhead window (0.1 s, ~96 ticks at 120bpm) ahead of what has been
 * rendered, so a head drawn from it leads the ear. Compensate BEFORE wrapping:
 * just after a loop point the audible position is still in the tail of the
 * previous pass, which is where the wrap should put it.
 *
 * The placement set is computed from the same tick in the same frame, so the lit
 * blocks and the playhead can never disagree about where playback is — the
 * property the lib gets for free on the pattern page by emitting both from one
 * poll. It is emitted only when the SET changes, so a subscriber re-renders at
 * placement boundaries rather than at 60 Hz.
 */
function pollHead(active: CompositionEngine): void {
  // Not merely an optimisation: `stop()` clears the snapshot before it stops the
  // transport, so without this a frame in flight would put the playhead back on
  // screen after it had been cleared. That is how a highlight gets stuck lit for
  // a session.
  if (!snapshot.isPlaying) return;

  const audible = audibleTransportTicks(PPQ);
  if (!Number.isFinite(audible)) return;
  const headTick = active.loop ? wrapToDuration(audible, active.loopTicks) : audible;

  const ids: string[] = [];
  for (const track of active.composition.tracks) {
    for (const placement of track.placements) {
      if (placement.startTick <= headTick && headTick < placementEndTick(placement)) {
        ids.push(placement.id);
      }
    }
  }
  const key = ids.join(',');
  if (key === active.placementKey) {
    emit({ headTick });
    return;
  }
  active.placementKey = key;
  emit({ headTick, activePlacementIds: ids.length ? ids : NO_IDS });
}

function startHeadLoop(active: CompositionEngine): void {
  if (active.headFrame !== null) return;
  if (typeof requestAnimationFrame === 'undefined') return;
  const frame = () => {
    // Re-armed first so a throw inside the body cannot silently end the sweep.
    active.headFrame = requestAnimationFrame(frame);
    pollHead(active);
  };
  active.headFrame = requestAnimationFrame(frame);
}

function stopHeadLoop(active: CompositionEngine): void {
  if (active.headFrame === null) return;
  cancelAnimationFrame(active.headFrame);
  active.headFrame = null;
}

/**
 * Bring the live engine in line with the store.
 *
 * `updateComposition`, NOT `applyTrackState` — although the fader, mute and solo
 * are exactly what this is for. `applyTrackState` reads the engine's OWN
 * `_composition` snapshot, which nothing but `updateComposition` ever replaces,
 * so calling it alone after a store write re-applies the values the engine
 * already had. `updateComposition` swaps the snapshot, diffs the tracks,
 * restreams only the ones whose content moved and calls `applyTrackState` itself
 * — which is why a volume drag mid-playback does not cancel the schedule.
 *
 * A `true` return means the track SHAPE changed — one added, removed or
 * reordered — and the engine's per-track entries were built at construction, so
 * that is a rebuild. A scheduler built while the transport is already running
 * never gets its `start` event and so schedules nothing, so the honest answer
 * mid-playback is to stop: the alternative is a track that is silently absent
 * from the mix until the next press of play.
 *
 * This runs on EVERY composition write once an engine exists — including the
 * dozens a drag fires — which the lib intends ("cheap; safe to call on every
 * store change") and which is what keeps a stopped engine current so the next
 * press of play doesn't sound the arrangement as it was. It costs one
 * `CompositionTrackSource` per track whose placements moved; with the transport
 * stopped `restream` clears and returns without rescheduling.
 *
 * Four things `updateComposition` does NOT do, and this therefore has to: push
 * the composition's tempo into the metronome, recompute the tuning when a
 * track's instrument changed, restream when the loop boundary moved, and swap
 * the voice for a track whose placements moved in the same update as its
 * `voiceRef` ({@link voiceSwapsMissedByDiff}). Each of them is silent when
 * missed — see the comments on the calls.
 */
function syncComposition(composition: Composition | null): void {
  const active = compositionEngine;
  if (!active) return;
  if (!composition || composition.id !== active.compositionId) {
    disposeCompositionEngine();
    return;
  }

  try {
    // Computed against the mirror BEFORE the update, because `updateComposition`
    // replaces the engine's snapshot as its first act and the comparison would
    // then be against itself.
    const missedVoices = voiceSwapsMissedByDiff(active.composition, composition);

    if (active.playback.updateComposition(composition)) {
      stop();
      disposeCompositionEngine();
      return;
    }

    // The mirror is written as soon as the engine has ACCEPTED the update, and
    // BEFORE anything else here — `updateComposition` replaces the engine's own
    // snapshot as its first act, so from this line on the engine holds
    // `composition` and a mirror still holding the previous one is simply wrong.
    // Everything below can throw (`setTrackVoice` builds a voice; Tone is on the
    // other side of it), and the `catch` swallows it, so leaving the mirror until
    // last would strand `pollHead` on a document the audio no longer has and make
    // the NEXT `voiceSwapsMissedByDiff` diff against it.
    const nextLoopTicks = loopBoundaryOf(composition);
    const boundaryMoved = nextLoopTicks !== active.loopTicks;
    active.composition = composition;
    active.loop = composition.loop;
    active.loopTicks = nextLoopTicks;

    // After the update, never before: `setTrackVoice` reads the engine's own
    // snapshot to find the track, so called first it would rebuild the voice from
    // the ref that is being replaced — a wasted sampler load AND the wrong voice.
    // Separately attempted, because one track whose preset the audio graph refuses
    // must not cost the others their swap.
    for (const trackId of missedVoices) {
      attempt(() => active.playback.setTrackVoice(trackId));
    }

    active.playback.setLoop(composition.loop);

    // `updateComposition` classifies an instrumentId change as a VOICE change
    // and swaps the voice only — the tuning it was constructed with is never
    // recomputed, and a tuning with fewer strings than the new part silently
    // drops every event above its last string (LIB-GAP(15)).
    const nextTuning = compositionTuning(composition);
    const tuningMoved = nextTuning !== null && nextTuning.id !== active.tuningId;
    if (nextTuning && tuningMoved) {
      active.tuningId = nextTuning.id;
      active.playback.setTuning(nextTuning, CAPO);
    }

    if (snapshot.isPlaying) {
      emit({ loopBoundaryTicks: active.loopTicks });
      // The metronome carries whatever the pattern page last left in it, and
      // nothing else pushes the composition's tempo in once playback has
      // started — so without this the readout changes and the tempo does not.
      // Here rather than in `TransportBar` so the agent's `setCompositionBpm`
      // gets the same behaviour as the button. No re-entry: `setTempo` writes
      // the METRONOME store, not the patterns store this is subscribed to.
      const bpm = compositionTempo(composition);
      if (bpm !== useMetronomeStore.getState().bpm) setTempo(bpm);
      // `EventScheduler.setTuning` only writes the field, and `updateComposition`
      // restreams only the tracks whose placements moved — so unchanged tracks
      // keep a `CompositionTrackSource` built with the OLD boundary and would
      // loop at it, drifting further apart on every pass.
      if (tuningMoved || boundaryMoved) active.playback.restreamAll();
    }
  } catch {
    // An engine that refuses an update must not take the edit down with it; the
    // arrangement is already written and the next play rebuilds from it.
  }
}

/**
 * Mounts the composition page's audio lifecycle. Call once, from the page.
 *
 * `usePlaybackEngine` is called through rather than duplicated: the metronome it
 * publishes is the lib's singleton and both engines need it. The pattern page's
 * `Timeline` and this page are never mounted together — `App` swaps one whole
 * tree for the other — so the two callers cannot fight over it.
 *
 * The composition subscription is what makes a mute, a solo or a fader audible
 * DURING playback: the lib's engine deliberately does not read the store, and
 * documents that its host is to push changes in.
 *
 * LEAVING THE PAGE STOPS PLAYBACK, and this is where that happens — no separate
 * unmount hook, because `usePlaybackEngine`'s teardown already stops the
 * transport before it disposes either engine. `App.tsx` covers the other
 * direction (it calls `stop()` when the page is no longer 'pattern'); together
 * they are the round trip that must not leave a transport running behind a
 * hidden document, or leave the pattern page playing into a torn-down graph.
 */
export function useCompositionPlayback(): void {
  usePlaybackEngine();
  const composition = useEditingComposition();

  useEffect(() => {
    syncComposition(composition);
  }, [composition]);

  // CP-14's live retune is NOT wired here — see the module-scope
  // `subscribeTrackVoiceDrafts` call. A rack edit writes a preset no variant
  // holds, so the composition store does not move and `syncComposition` above
  // never runs; that subscription is the only path from a turned knob to a
  // sounding one, and it belongs to the engine's lifetime, not to this hook's.
}

/**
 * Start the arrangement. Must be called from a user gesture — the AudioContext
 * unlock demands one.
 *
 * The tempo is pushed into the metronome rather than read from it: the
 * composition owns its BPM, and the metronome is carrying whatever the pattern
 * page last left there.
 *
 * Refusals are RETURNED, not thrown and not swallowed: a Play button that does
 * nothing and says nothing is indistinguishable from a broken one, and the
 * agent's transport tool needs the same answer the surface gets.
 */
export async function playComposition(): Promise<Result> {
  // Re-entrant play is worse than a no-op for the reason `play()` gives, and the
  // flag is shared between the two paths — which is also what stops the pattern
  // page and this one from both claiming the transport. Not a refusal: the state
  // the caller asked for already holds.
  if (snapshot.isPlaying) return ok();

  const composition = getEditingComposition();
  if (!composition) return refuse('No composition is open.');
  // A zero-length arrangement gives every scheduler a zero-length region, whose
  // boundary chain reschedules at a tick BEFORE the one it started from and so
  // never advances. The transport would run for nothing.
  if (loopBoundaryOf(composition) <= 0) {
    return refuse('Nothing to play yet — drag a pattern into a track first.');
  }

  try {
    await startAudio();

    let active = ensureCompositionEngine(composition);
    // Catch a reused engine up on anything written since React last ran the sync
    // effect — a press in the same tick as an edit, most plausibly. Normally a
    // no-op; when it isn't and the track SHAPE moved, the sync drops the engine,
    // so it is rebuilt here rather than costing the user a second press.
    if (active && active.composition !== composition) {
      syncComposition(composition);
      active = compositionEngine ?? ensureCompositionEngine(composition);
    }
    if (!active) return refuse('Audio is unavailable in this browser.');

    setTempo(compositionTempo(composition));
    active.playback.setLoop(composition.loop);
    active.loop = composition.loop;
    active.loopTicks = loopBoundaryOf(composition);
    active.placementKey = '';
    active.activeKey = '';
    active.trackActive.clear();

    emit({
      isPlaying: true,
      headTick: 0,
      activeIds: NO_IDS,
      activePlacementIds: NO_IDS,
      loopBoundaryTicks: active.loopTicks,
    });
    startHeadLoop(active);
    // Last, and by the metronome: it owns transport start/stop, and every
    // scheduler in the engine is waiting on its `start` event. It also awaits
    // `MasterBus.warmup()` on the way, which is why nothing here does — the
    // reverb IR is rendered before the first note is due.
    await active.metronome.start();
    return ok();
  } catch {
    // `metronome.start()` can reject after it has already claimed the transport,
    // so clearing the flags is not enough — go through `stop()`.
    stop();
    return refuse('Playback could not start.');
  }
}

/**
 * The tempo the arrangement starts at.
 *
 * Through the lib's resolver rather than reading `composition.bpm`, because
 * `tempoMode: 'inherit'` means the first placement's own `suggestedBpm` wins and
 * the composition's is only the fallback. Asked of the EARLIEST placement, which
 * is the one that sounds first; later boundaries are the scheduler's to handle.
 * A composition with nothing placed has no placement to resolve against and
 * falls back to its own tempo.
 */
function compositionTempo(composition: Composition): number {
  let first: Placement | null = null;
  for (const track of composition.tracks) {
    for (const placement of track.placements) {
      if (!first || placement.startTick < first.startTick) first = placement;
    }
  }
  return first ? resolveEffectivePlayback(composition, first).bpm : composition.bpm;
}

/** Ids of the placements the head is inside. Empty when stopped. */
export function useActivePlacementIds(): readonly string[] {
  return useSyncExternalStore(subscribe, getActivePlacementIds, getActivePlacementIds);
}

/** The tick composition playback wraps at — see {@link loopBoundaryOf} for why
 *  this is not the arrangement's drawn width. 0 when nothing is playing. */
export function useLoopBoundaryTicks(): number {
  return useSyncExternalStore(subscribe, getLoopBoundaryTicks, getLoopBoundaryTicks);
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
