import { auditionVoice, warmVoice } from '../audio/playbackService';

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
 */
export function AuditionButton() {
  const warm = () => void warmVoice();

  return (
    <button
      type="button"
      onPointerEnter={warm}
      onFocus={warm}
      onClick={() => void auditionVoice()}
      className="pressable control flex-none rounded-lg px-2 py-1 font-mono text-[9px] font-bold tracking-[0.06em] uppercase"
    >
      Audition
    </button>
  );
}
