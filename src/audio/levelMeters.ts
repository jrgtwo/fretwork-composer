/**
 * Signal levels, read from the audio graph and delivered per frame.
 *
 * ── Why this is a module and not part of `playbackService`'s snapshot ────────
 *
 * A meter updates ~30 times a second and is worth nothing if it does not. Putting
 * it in the page's playback snapshot would re-render every lane, every block and
 * every rail at that rate to move a few pixels. So the values never enter React
 * state at all: {@link subscribeMeter} hands a number to a listener, and the
 * listener writes it straight onto a DOM node it already holds a ref to.
 *
 * ── Where the numbers come from ─────────────────────────────────────────────
 *
 * Nothing here creates a meter. The lib builds three taps on EVERY voice,
 * unconditionally — see `buildChain` in the lib's `Voice.ts` — and `MasterBus`
 * offers two of its own.
 *
 * **The master figure is the PRE-LIMITER tap** — what the master is being asked
 * to pass. It was `getOutputPeakDb()` until this fix, which taps after the
 * limiter AND after a WaveShaper that hard-clips at -0.5 dBFS: that reading is
 * bounded below -0.5 BY CONSTRUCTION, so it cannot report an overload however
 * hard the bus is driven. A signal arriving at +10 dBFS is squashed, chopped,
 * and reported as a tidy -0.5 — audible distortion, clean meter. It is the same
 * failure as the RMS-vs-peak bug one stage on: a meter placed where the answer
 * is already known.
 *
 * It is still not a headroom figure, and the difference matters when reading it.
 * The tap sits downstream of the bus compressor and of `MasterBus`'s own gain,
 * both of which CHANGE the level, so it says whether the output stage is being
 * overdriven — not how hot the mix itself is. Nothing in the app meters the bus
 * input, where that question would be answered.
 *
 * **Every reading is a SAMPLE PEAK.** It is worth knowing that they were RMS
 * until the peak-meter fix: `Tone.Meter` returns the RMS of its window, and on a
 * plucked note that sits 12-20 dB below the peak. So the app showed comfortable
 * numbers, the clip lamps never latched, and the audio clipped audibly the whole
 * time. Sample peak is still not TRUE peak — an intersample over of up to ~3 dB
 * can pass one of these readings and clip at the converter — see the lib's
 * `voices/peak-meter.ts`.
 *
 * The three per-voice taps are NOT the ends of the mixer strip, and the
 * difference matters when reading them:
 *
 *  - **in** taps at the voice's `inputGain`, the very front — before the body
 *    filter, the pedals, the graphic EQ and the amp. This is the instrument
 *    arriving, and it is the number that says whether a level problem starts
 *    upstream of every control.
 *  - **drive** taps the amp's `ampPreGain` output — after the pedals, the graphic
 *    EQ and `preGainDb`, immediately before the bass split and the saturators.
 *    This is what the amp's drive stage is actually being FED, and it was the
 *    gap between the other two until AF-01 closed it.
 *  - **out** taps the last node of the voice chain, after the amp, the cab, the
 *    final EQ and the voice's own volume. It is PRE-FADER: the track's gain,
 *    pan, mute and solo all live outside the voice, in the lib's
 *    `MultiTrackPlayback`. So a muted track still reads a level here, which is
 *    correct — it says the voice is producing signal, not that you can hear it.
 *
 * **Expect drive to read higher than the other two on a gain preset, and expect
 * out not to follow it.** Every amp curve is normalised at its ENDPOINT —
 * `tanh(x·k) / tanh(k)` — so a saturator hands back an ordinary-looking level
 * however hard it was hit. Metal's pre-stage has +22.8 dB of small-signal gain;
 * a -12 dBFS input leaves it at 0.998. That divergence is the thing these three
 * meters exist to show, not a fault in the tap.
 *
 * A voice with no amp stage reads `-Infinity` at the drive tap: the meter is
 * built but nothing is connected to it, and there is no drive stage to report.
 */
import { MasterBus, type Track, type Voice } from '@fretwork/lib';

/** Which point in the graph a meter is watching. */
export type MeterSource =
  | { readonly kind: 'track-in'; readonly trackId: string }
  | { readonly kind: 'track-drive'; readonly trackId: string }
  | { readonly kind: 'track-out'; readonly trackId: string }
  | { readonly kind: 'master' };

/** The reading when a source has nothing behind it — no engine, no voice for
 *  that track, or audio never started. Silence and absence are the same number
 *  on purpose: a meter with no signal and a meter with no source both draw
 *  empty, and neither is an error worth surfacing in a mixer strip. */
export const SILENCE_DB = -Infinity;

/**
 * How often the levels are read, in milliseconds.
 *
 * Driven by `requestAnimationFrame` and then throttled, rather than run at the
 * display's rate: the readings come from `AnalyserNode`s whose own smoothing
 * window is longer than a frame, so sampling at 60 Hz costs twice the work to
 * show the same numbers. 33 ms is fast enough that a peak-holding meter catches
 * a pluck.
 */
const SAMPLE_INTERVAL_MS = 33;

/** Every track voice the engine currently holds, by track id. */
const trackVoices = new Map<string, Voice>();

/**
 * Each track's fader position in dB, mute and solo already resolved.
 *
 * **Why the OUT reading needs this at all.** Both of a voice's meters are INSIDE
 * the voice, and a track's gain, pan, mute and solo are outside it, in the lib's
 * `MultiTrackPlayback`. So the voice's own output tap cannot see the fader, and a
 * mixer meter that does not move when you move the fader is simply wrong.
 *
 * Rather than a second measured tap — which would mean a lib change, a tag and a
 * dependency bump — the fader is applied in dB on top of the measured voice
 * output. That is not an approximation: the stage in between is one linear gain,
 * so adding its value in dB is exactly what it does to the level. Pan is the one
 * thing it does not model; an equal-power pot shifts a little level between the
 * channels, which a single-bar meter has nowhere to show anyway.
 */
const trackFaders = new Map<string, number>();

/**
 * A muted track's gain, in dB.
 *
 * The lib mutes to a FINITE `NEG_INF_GAIN = 0.0001` rather than to zero, and this
 * mirrors it deliberately instead of using `-Infinity`. A muted track really does
 * still pass -80 dB of signal, and a meter that draws it as absolute silence
 * would be telling a more comfortable story than the audio does. The number is
 * duplicated from the lib because it is not exported; if that ever changes, take
 * it from there instead.
 */
const MUTED_DB = -80;

interface Subscription {
  readonly source: MeterSource;
  readonly listener: (db: number) => void;
}

const subscriptions = new Set<Subscription>();

let frame: number | null = null;
let lastSampleMs = 0;

/** A stable string for one source, so several meters watching the same point
 *  read it once per tick instead of once each. */
function sourceKey(source: MeterSource): string {
  return source.kind === 'master' ? 'master' : `${source.kind}:${source.trackId}`;
}

function readSource(source: MeterSource): number {
  try {
    if (source.kind === 'master') return MasterBus.getPreLimiterPeakDb();
    const voice = trackVoices.get(source.trackId);
    if (!voice) return SILENCE_DB;
    if (source.kind === 'track-in') return voice.getInputLevelDb();
    // PRE-FADER and deliberately not adjusted: the drive tap is inside the amp,
    // and the track fader is two stages past the end of the voice. Adding it
    // here would report a number that exists nowhere in the graph.
    if (source.kind === 'track-drive') return voice.getDriveLevelDb();
    const out = voice.getOutputLevelDb();
    if (!Number.isFinite(out)) return SILENCE_DB;
    // POST-FADER, by construction — see `trackFaders`. A track whose fader we
    // have not been told about reads unaffected rather than silent: the meter
    // being slightly wrong beats it going dark for a bookkeeping miss.
    return out + (trackFaders.get(source.trackId) ?? 0);
  } catch {
    // A disposed voice or a torn-down bus. A meter is a diagnostic; it must
    // never be the thing that takes a page down.
    return SILENCE_DB;
  }
}

function tick(nowMs: number): void {
  frame = null;
  if (subscriptions.size === 0) return;
  if (nowMs - lastSampleMs >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = nowMs;
    // Read each distinct point once, then fan out — two meters on one track
    // (in and out are separate points, but two strips can show the same one)
    // must not cost two `getValue()` calls.
    const readings = new Map<string, number>();
    for (const subscription of subscriptions) {
      const key = sourceKey(subscription.source);
      let db = readings.get(key);
      if (db === undefined) {
        db = readSource(subscription.source);
        readings.set(key, db);
      }
      try {
        subscription.listener(db);
      } catch {
        // A throwing listener must not stop the other meters updating.
      }
    }
  }
  schedule();
}

function schedule(): void {
  if (frame !== null) return;
  if (subscriptions.size === 0) return;
  if (typeof requestAnimationFrame !== 'function') return;
  frame = requestAnimationFrame(tick);
}

/**
 * Watch one point in the graph. Returns the unsubscribe.
 *
 * The polling loop exists only while something is subscribed, so a page with no
 * meters on screen — the pattern page, or voice mode with the mixer hidden —
 * costs nothing at all. Unsubscribing the last listener stops it.
 */
export function subscribeMeter(source: MeterSource, listener: (db: number) => void): () => void {
  const subscription: Subscription = { source, listener };
  subscriptions.add(subscription);
  schedule();
  return () => {
    subscriptions.delete(subscription);
    if (subscriptions.size === 0 && frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
  };
}

/**
 * Record the voice a track is playing through.
 *
 * Called from `playbackService`'s track-voice factory, which is the ONE place a
 * track's voice is constructed — the lib's `MultiTrackPlayback` takes that
 * factory and calls it both when it builds the engine and when a track's voice
 * is swapped live, so registering here catches every case without the lib
 * needing to expose its voices.
 *
 * A rebuild overwrites the entry, which is what we want: the old voice is left
 * ringing out its tail and disposed a few seconds later, and metering the one
 * that just replaced it is the honest reading.
 */
export function registerTrackVoice(trackId: string, voice: Voice): void {
  trackVoices.set(trackId, voice);
}

/** Forget one track's voice — its meters fall back to silence. */
export function unregisterTrackVoice(trackId: string): void {
  trackVoices.delete(trackId);
}

/** Forget every voice. Called when the composition engine is torn down; without
 *  it the map would hold disposed voices and every read would take the catch. */
export function clearTrackVoices(): void {
  trackVoices.clear();
  trackFaders.clear();
}

/**
 * Push every track's fader, mute and solo, so the OUT meters read post-fader.
 *
 * Takes the whole track list rather than one track because **solo is not a
 * property of the track you are metering** — one track soloed silences all the
 * others, so the effective gain of any track depends on all of them. This
 * resolves it exactly as the lib's `applyTrackState` does.
 *
 * Called wherever the app hands the engine a composition, which is the same
 * moment the audio graph itself is updated.
 */
export function setTrackFaders(tracks: readonly Track[]): void {
  const anySoloed = tracks.some((track) => track.soloed);
  trackFaders.clear();
  for (const track of tracks) {
    const audible = !track.muted && (!anySoloed || track.soloed);
    trackFaders.set(track.id, audible ? (track.volumeDb ?? 0) : MUTED_DB);
  }
}
