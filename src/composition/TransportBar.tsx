import { LevelMeter } from './LevelMeter';
import { useState } from 'react';
import type { SubdivisionId } from '@fretwork/lib';
import {
  playComposition,
  setClickSubdivision,
  setClickTimeSignature,
  stop,
  toggleClick,
  useClickMuted,
  useIsPlaying,
} from '../audio/playbackService';
import {
  SUBDIVISION_OPTIONS,
  TIME_SIGNATURE_OPTIONS,
  setCompositionBpm,
  setCompositionLoop,
  setCompositionSubdivision,
  setCompositionTimeSignature,
  useEditingComposition,
} from './compositionService';

/** How each subdivision reads in the picker. The ids are the lib's and are not
 *  all self-explanatory in a control this small. */
const SUBDIVISION_LABEL: Record<SubdivisionId, string> = {
  off: 'off',
  '8ths': '8ths',
  triplets: 'trips',
  '16ths': '16ths',
  sextuplets: 'sext',
};

const SELECT_CLASS =
  'control pressable rounded-lg px-1.5 py-1 font-mono text-[9px] font-bold tracking-[0.08em] uppercase';

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

  /**
   * TWO WRITES, and they are not a duplicate of each other.
   *
   * The meter belongs to the DOCUMENT: it draws the arrangement's bars, its
   * width and its ruler, and it has to survive a reload and travel with the
   * composition. The click is TRANSPORT state, shared with the pattern page and
   * saved with nothing. `playComposition` and `syncComposition` already push the
   * document's settings into the metronome, so the second call is what makes the
   * change audible NOW rather than at the next press of Play — exactly what the
   * tempo arrows above do, and for the same reason.
   *
   * The seam is asked first and the click follows only if it agreed: a meter the
   * catalog has not got is refused there, and a click in a meter the document
   * does not have would be the worse of the two failures.
   */
  const chooseTimeSignature = (id: string) => {
    const option = TIME_SIGNATURE_OPTIONS.find((candidate) => candidate.id === id);
    if (!option) return;
    const saved = setCompositionTimeSignature({
      numerator: option.numerator,
      denominator: option.denominator,
    });
    if (saved.ok) setClickTimeSignature(id);
  };

  const chooseSubdivision = (subdivision: SubdivisionId) => {
    if (setCompositionSubdivision(subdivision).ok) setClickSubdivision(subdivision);
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

      {/* The DOCUMENT's meter, not the metronome's — see `chooseTimeSignature`.
          A native select: eight fixed options in a dense strip, where a custom
          popover would be a bigger control for a smaller job. */}
      <select
        aria-label="Time signature"
        value={`${composition.timeSignature.numerator}/${composition.timeSignature.denominator}`}
        onChange={(e) => chooseTimeSignature(e.target.value)}
        className={SELECT_CLASS}
      >
        {TIME_SIGNATURE_OPTIONS.map((option) => (
          <option key={option.id} value={option.id}>
            {option.id}
          </option>
        ))}
      </select>

      {/* `?? 'off'`: the lib documents a null subdivision as "use the
          metronome's current value at play time", which is what an untouched
          composition carries. The picker offers no such option — `off` already
          means no sub-clicks — so null is shown, and played, as off. */}
      <select
        aria-label="Click subdivision"
        value={composition.subdivision ?? 'off'}
        onChange={(e) => chooseSubdivision(e.target.value as SubdivisionId)}
        className={SELECT_CLASS}
      >
        {SUBDIVISION_OPTIONS.map((option) => (
          <option key={option} value={option}>
            {SUBDIVISION_LABEL[option]}
          </option>
        ))}
      </select>

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

      <span className="mx-1 h-4 w-px bg-line" />

      {/* Master output (AU-04). This is the LAST thing before the sound card —
          `MasterBus` taps it after the limiter and the safety clip — so it is
          what actually leaves, not what the mix asked for.

          Which is why it is the least useful of the three meters for finding a
          level problem, and worth having anyway: it stays comfortable while a
          voice upstream is being destroyed, because the amp's saturators hand
          back a normalised level however hard they were hit and the limiter
          catches whatever is left. When this reads fine and it still sounds
          wrong, the track meters are where the answer is.

          Fixed width: `LevelMeter`'s bar is `flex-1`, and in a transport row
          that would take every pixel the controls left behind. */}
      <div className="w-[150px] flex-none">
        <LevelMeter source={{ kind: 'master' }} label="MSTR" title="Master output level" />
      </div>

      {refusal ? (
        <span role="alert" className="ml-1 font-mono text-[9px] text-ink-mut">
          {refusal}
        </span>
      ) : null}
    </div>
  );
}
