import type { Track } from '@fretwork/lib';
import {
  auditionTrackVoice,
  auditionVoice,
  warmTrackVoice,
  warmVoice,
} from '../audio/playbackService';

/**
 * Play one note through the voice being edited, with the transport stopped.
 *
 * Every knob in this pane is inaudible until something makes a sound, and starting
 * playback to hear a treble tweak means listening to the whole pattern. So: one note,
 * scheduled straight onto the audio clock by `auditionVoice` — not through the
 * metronome, which owns start/stop and would *be* starting playback.
 *
 * The audition itself is synchronous — it has to fire on the click that asked for it —
 * so it cannot await the sampler. `warmVoice()` is fired on every hover or focus
 * instead, which buys the download the time it takes to move a mouse to the button;
 * otherwise the first audition after a cold load triggers an unloaded `Sampler` and is
 * silent. (`warmVoice` awaits `Voice.ready()`, so the wait happens there, off the
 * click path.)
 *
 * Every hover, not once per mount, and that is the point: this button outlives the voice
 * under it. Pick another slot, change the sample pack or switch instrument and the engine
 * has a different (or newly rebuilt) `Voice`, which is exactly the cold state warming
 * exists for. A once-per-mount guard made every voice after the first audition cold —
 * the failure it was meant to prevent. Repeating costs nothing: `startAudio`,
 * `MasterBus.warmup` and `ensureBuilt` are each idempotent and return immediately once
 * their work is done.
 *
 * ── ⚠ WITH A TRACK, IT IS A DIFFERENT VOICE (CP-15) ──────────────────────────
 *
 * `auditionVoice` resolves through `getEditingPattern()`. In the composition
 * page's voice rail that would play whichever pattern or placement happens to be
 * open rather than the track whose voice is being picked — silently wrong, and
 * indistinguishable from the picker not working. `track` switches BOTH calls to
 * the track path, which resolves through the same draft `buildTrackVoice` reads,
 * so an audition matches what playback will do including unsaved edits.
 *
 * Optional rather than a second component: everything else here — the warm on
 * hover and focus, the press-down chrome, the accessible name — is identical,
 * and two copies of the warming rule is how one of them ends up without it.
 */
export function AuditionButton({ track }: { track?: Track }) {
  const warm = () => void (track ? warmTrackVoice(track.id) : warmVoice());
  const audition = () => void (track ? auditionTrackVoice(track.id) : auditionVoice());

  return (
    <button
      type="button"
      // The name stays "Audition" in both surfaces: each renders exactly one of
      // these, so the track's name would disambiguate nothing and would make
      // the one control whose label is a verb read as a track list entry.
      title={track ? `Play one note through ${track.name}’s voice` : undefined}
      onPointerEnter={warm}
      onFocus={warm}
      onClick={audition}
      className="pressable control flex-none rounded-lg px-2 py-1 font-mono text-[9px] font-bold tracking-[0.06em] uppercase"
    >
      Audition
    </button>
  );
}
