import { useState } from 'react';
import {
  playComposition,
  stop,
  toggleClick,
  useClickMuted,
  useIsPlaying,
} from '../audio/playbackService';
import { setCompositionBpm, setCompositionLoop, useEditingComposition } from './compositionService';

/**
 * The lowest and highest tempo the arrows will walk to. The lib clamps nothing —
 * `setCompositionBpm` stores whatever it is given — so the range is the surface's,
 * and it is the same pair the pattern editor's transport uses. Restating it here
 * rather than importing `Timeline`'s is deliberate: it is four characters of
 * editorial judgement, not a shared rule, and importing the pattern editor into
 * the arranger to get it would be the wrong dependency by far.
 */
const BPM_RANGE = { min: 20, max: 300 } as const;

/**
 * Play, stop, loop, tempo and the click, for the arrangement.
 *
 * Every control here is a thin skin on a seam function that the agent's tools
 * reach through the same door — `playComposition`, `stop`, `setCompositionLoop`,
 * `setCompositionBpm`, `toggleClick`. Nothing about the transport is expressible
 * only as a press.
 *
 * The tempo shown is the COMPOSITION's, not the metronome's live BPM. Those are
 * the same number while this page is playing — `playComposition` pushes the
 * composition's tempo into the metronome on start, and `syncComposition` pushes
 * every later change in, which is what makes these arrows audible mid-playback —
 * and they are not otherwise, since the metronome carries whatever the pattern
 * page last left in it. A transport that displays a tempo belonging to a
 * document you can't see is the kind of wrong that reads as the app losing your
 * settings.
 */
export function TransportBar() {
  const composition = useEditingComposition();
  const isPlaying = useIsPlaying();
  const clickMuted = useClickMuted();
  /** Why the last press of Play did nothing. `playComposition` refuses rather
   *  than throwing, and an unreported refusal is a dead button. */
  const [refusal, setRefusal] = useState<string | null>(null);

  if (!composition) return null;

  const changeTempo = (delta: number) => {
    setCompositionBpm(
      Math.max(BPM_RANGE.min, Math.min(BPM_RANGE.max, composition.bpm + delta)),
    );
  };

  return (
    <div className="flex items-center gap-1.5" role="group" aria-label="Transport">
      <button
        type="button"
        aria-label={isPlaying ? 'Stop' : 'Play'}
        // `playComposition` needs the click itself as the user gesture that
        // unblocks the AudioContext, so it is called from here rather than from
        // an effect watching a piece of state.
        onClick={() => {
          if (isPlaying) {
            stop();
            setRefusal(null);
            return;
          }
          void playComposition().then((result) => {
            setRefusal(result.ok ? null : result.reason);
          });
        }}
        className={`pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold ${
          isPlaying ? 'control-accent' : ''
        }`}
      >
        {isPlaying ? '■' : '▶'}
      </button>
      <button
        type="button"
        aria-label={composition.loop ? 'Turn looping off' : 'Turn looping on'}
        aria-pressed={composition.loop}
        // Takes effect immediately, mid-playback included: the engine's
        // `setLoop` reaches every track's scheduler, and `useCompositionPlayback`
        // pushes the change in the moment the store write lands.
        onClick={() => setCompositionLoop(!composition.loop)}
        className={`pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold ${
          composition.loop ? 'control-accent' : ''
        }`}
      >
        ⟲ loop
      </button>

      <span className="mx-1 h-4 w-px bg-line" />

      <span className="font-mono text-[9px] tracking-[0.12em] text-ink-mut uppercase">bpm</span>
      <button
        type="button"
        aria-label="Decrease tempo"
        onClick={() => changeTempo(-1)}
        className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold"
      >
        –
      </button>
      <span
        data-testid="composition-tempo"
        className="min-w-7 text-center font-mono text-[11px] font-bold tabular-nums text-ink-hi"
      >
        {composition.bpm}
      </span>
      <button
        type="button"
        aria-label="Increase tempo"
        onClick={() => changeTempo(1)}
        className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold"
      >
        +
      </button>

      <span className="mx-1 h-4 w-px bg-line" />

      {/* The click bypasses the master bus entirely, so muting it silences the
          count without touching the mix — worth saying, because a mute button
          next to a transport reads as muting playback. */}
      <button
        type="button"
        aria-label={clickMuted ? 'Unmute metronome click' : 'Mute metronome click'}
        aria-pressed={!clickMuted}
        title="The click is separate from the tracks — muting it doesn't affect playback"
        onClick={toggleClick}
        className={`pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold ${
          clickMuted ? 'opacity-50' : 'control-accent'
        }`}
      >
        {clickMuted ? '🔇' : '🔊'} click
      </button>

      {refusal ? (
        <span role="alert" className="ml-1 font-mono text-[9px] text-ink-mut">
          {refusal}
        </span>
      ) : null}
    </div>
  );
}
