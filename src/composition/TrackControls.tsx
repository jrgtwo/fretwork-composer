import { useEffect, useRef, useState } from 'react';
import type { FretInstrumentId, Track } from '@fretwork/lib';
import {
  PAN_RANGE,
  VOLUME_RANGE_DB,
  findTrack,
  listTrackInstruments,
  mismatchedPlacements,
  moveTrack,
  removeTrack,
  setTrackInstrument,
  setTrackMuted,
  setTrackPan,
  setTrackSoloed,
  setTrackVolumeDb,
  strandedByInstrument,
  trackInstrumentId,
  type Result,
} from './compositionService';
import {
  parseVoiceKey,
  readTrackVoiceRef,
  setTrackVoice,
  useSelectableVoices,
  useTrackVoicePreset,
  useTrackVoiceStatus,
  voiceKey,
} from '../voice/voiceService';

/**
 * How long a voice pick waits before it is written.
 *
 * The same window, and the same reason, as `playbackService`'s
 * `REBUILD_COALESCE_MS` and `VoicePane`'s `WARM_COALESCE_MS`: a native `<select>`
 * fires `change` once per arrow key while closed, so a keyboard user stepping the
 * eleven guitar voices passes through all of them. Ten of those slots are
 * sampler-sourced, and once the page has played, every one of those writes reaches
 * `MultiTrackPlayback.setTrackVoice` — a whole new `Voice`, one `Tone.Sampler` and
 * an HTTP load per bank, with the outgoing one held alive on a 4 s release tail.
 * One arrow-key walk is a fetch storm.
 *
 * PERMANENT ADAPTER, not a masked lib gap: the lib cannot know it is behind a
 * `<select>`, which is exactly the argument the prefetch-rate row in
 * docs/FOLLOW-UPS.md already makes. It lives in the GESTURE and not in the seam —
 * `voiceService.setTrackVoice` writes on the call, so the agent is never
 * debounced, and one command stays one undo step.
 */
/**
 * How close to centre counts as centre.
 *
 * A pan pot has a physical detent and a range input has none, so the snap is
 * the software half of that: anything inside this lands on exactly 0, which is
 * what makes "put it back in the middle" a drag rather than a fiddle.
 *
 * Sized to swallow exactly one step. That does cost the ±0.05 positions — a 5%
 * offset, which is below what the ear resolves in a mix and well worth a centre
 * you can actually hit. Widening it further would start eating audible ones.
 */
const PAN_DETENT = 0.05;

const withDetent = (pan: number) => (Math.abs(pan) <= PAN_DETENT ? 0 : pan);

/**
 * A pan position said the way a mixer says it: `C`, or a side and how far.
 *
 * Percent rather than the stored -1..+1, because "L35" is how the number is
 * spoken and reading `-0.35` off a strip means converting it every time. Used
 * as `aria-valuetext` too — a range announcing "minus zero point three five"
 * is technically the value and practically noise.
 */
function panLabel(pan: number): string {
  const percent = Math.round(Math.abs(pan) * 100);
  if (percent === 0) return 'C';
  return `${pan < 0 ? 'L' : 'R'}${percent}`;
}

const VOICE_COMMIT_MS = 120;

/**
 * One track's mixer strip and its structural controls: instrument, position in
 * the stack, removal, mute, solo and the fader.
 *
 * Split out of `TrackHeader` because the header is IDENTITY — the name plate,
 * the selection, the audibility state — and this is everything that WRITES.
 * They are two different rates of change: the plate is settled, this is the row
 * that grows.
 *
 * Every write goes through a seam, and every refusal is handed up to `onNotice`
 * rather than swallowed. There is deliberately no local mirror of any track
 * field — the strip renders the `track` it is given and the next store write
 * re-renders it, so a control can never show a value the model rejected — with
 * ONE exception, the voice pick, whose draft exists only for the length of
 * {@link VOICE_COMMIT_MS} and is dropped on a refusal so the control still snaps
 * back to what the model took.
 *
 * ── The second row holds one of three things ─────────────────────────────────
 *
 * The header has ~88 px for its rows and a 200 px column to fit them in, so the
 * strip has exactly two rows and the second one is a slot. A confirmation wins
 * it (it is a question, and it has replaced the control that asked); the voice
 * panel takes it next; otherwise it is the mixer.
 *
 * ⚠ THE VOICE PICKER IS BEHIND A BUTTON FOR A MEASURED REASON. Two `<select>`s
 * plus ▲▼✕ in a 200 px column leave each picker about 60 px, of which a native
 * dropdown arrow and the padding take half — six or seven characters at
 * `text-[8.5px]`, which renders "Karoryfer Green Guitar" and "Karoryfer Black
 * Guitar" identically. jsdom has no layout and cannot fail on that, so it is
 * written down instead: a full-width row is what makes the option names
 * readable. That same argument is why CP-14's rack did NOT open into this slot —
 * it takes the track's whole lane in voice mode (`TrackVoiceRack`). This strip
 * chooses the voice; the rack tunes it.
 *
 * ── The two confirmations ────────────────────────────────────────────────────
 *
 * Both destructive actions ask first, and both ask IN THIS STRIP rather than in
 * a dialog, because the thing being destroyed is this track and a modal would
 * make you take your eyes off it. One `pending` slot holds either, so the layout
 * has one confirm row rather than two that could both appear.
 *
 *  - REMOVE takes the track's placements with it. It asks only when there are
 *    placements to lose: an empty track destroys nothing, and a confirmation for
 *    a free action is how people learn to click through confirmations.
 *  - CHANGING THE INSTRUMENT asks when it would STRAND notes — a six-string
 *    riff moved onto a four-string bass leaves two strings the bass has not got
 *    (`strandedByInstrument`) — OR when it would throw away the track's VOICE.
 *    A change that costs neither applies immediately; the mismatch it may still
 *    leave is reported by the badge in `TrackHeader` instead, which is a
 *    standing fact rather than a decision.
 *
 * ⚠ THE VOICE HALF IS THE IRRECOVERABLE ONE, and it is why this confirmation now
 * fires with nothing stranded at all. The lib clears `Track.voiceRef` as part of
 * the instrument write, that write pushes no undo step, and
 * `mergeSettingsForward` carries the CLEARED ref forward over any snapshot undo
 * restores — so A → B → A does not bring the voice back and neither does ↶. The
 * full reasoning, and why making that one write undoable was rejected instead,
 * is on `compositionService.setTrackInstrument`. Asking is the whole remedy, so
 * a change that only costs the voice still has to ask.
 *
 * Both confirmations state their SUBJECT, not just their cost: the `<select>` is
 * controlled on the stored instrument, so it snaps back to the old one the
 * instant a choice is pending, and "2 notes have no string?" next to a picker
 * reading "Guitar" names nothing the user can check.
 *
 * ⚠ The instrument confirmation talks about STRINGS and never about audibility.
 * See LIB-GAP(15) on `compositionService.mismatchedPlacements`: a track's
 * instrument selects its voice and not its tuning, so this surface cannot honestly
 * promise which notes the engine will drop.
 */
export function TrackControls({
  track,
  index,
  trackCount,
  onNotice,
}: {
  track: Track;
  index: number;
  trackCount: number;
  /** Where a refusal — or a fact worth stating after the fact — is reported.
   *  The grid owns the one message strip; a per-header message would have to
   *  fit in 200 px next to the control that caused it. */
  onNotice: (message: string) => void;
}) {
  const [pending, setPending] = useState<
    | { kind: 'remove'; placements: number }
    | {
        kind: 'instrument';
        instrumentId: FretInstrumentId;
        stranded: number;
        /** Whether the write will destroy a voice override — see the banner. */
        losesVoice: boolean;
      }
    | null
  >(null);
  const [voiceOpen, setVoiceOpen] = useState(false);

  const report = (result: Result<unknown>) => {
    if (!result.ok) onNotice(result.reason);
  };

  const instrumentId = trackInstrumentId(track);
  const isLast = trackCount === 1;

  // All three through the VOICE seam: `Track.voiceRef` is `unknown` on the model
  // and exactly one module is allowed to cast it, which is not this one.
  const voiceRef = readTrackVoiceRef(track);
  const voices = useSelectableVoices(instrumentId);
  const voicePreset = useTrackVoicePreset(track);
  // A ref can outlive its variant, or outlive the instrument it made sense for:
  // `voiceService.deleteVoice` repairs the editing PATTERN and deliberately
  // leaves every other holder to the lib's clean fallback, so deleting a variant
  // in the voice pane leaves any track pointing at it dangling. Asked of the seam
  // rather than derived from `voices` here, because "gone" and "for another
  // instrument" are indistinguishable from a membership test and are not the same
  // sentence — nor the same answer to whether an instrument change costs anything.
  const voiceStatus = useTrackVoiceStatus(track);

  const voiceRefKey = voiceRef ? voiceKey(voiceRef) : '';

  const instrumentName = (id: FretInstrumentId) =>
    listTrackInstruments().find((instrument) => instrument.id === id)?.name ?? id;

  /**
   * The one draft in this component, and it is a rate limiter rather than a
   * mirror — see {@link VOICE_COMMIT_MS}. `flush` holds the write the timer is
   * going to make, so a gesture that ends the window early (leaving the field,
   * closing the panel) commits instead of racing it.
   */
  const [draftVoiceKey, setDraftVoiceKey] = useState<string | null>(null);
  const voiceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceFlush = useRef<(() => void) | null>(null);

  // Unmount is the one end with no gesture on it: a track removed, or the page
  // swapped, mid-window would otherwise drop the pick with nothing to notice.
  useEffect(
    () => () => {
      voiceFlush.current?.();
    },
    [],
  );

  const commitVoice = (key: string) => {
    if (voiceTimer.current !== null) clearTimeout(voiceTimer.current);
    voiceTimer.current = null;
    voiceFlush.current = null;
    // Dropped whatever the seam says: on `ok` the store re-renders this strip
    // with the value it took, and on a refusal the control has to snap back to
    // what the model actually holds rather than keep showing the rejected pick.
    setDraftVoiceKey(null);

    // '' is the fallback option, and clearing is a real choice rather than an
    // absence — it puts the track back on the instrument's global active voice,
    // which is the lib's documented meaning for a null ref.
    if (key === '') {
      report(setTrackVoice(track.id, null));
      return;
    }
    const ref = parseVoiceKey(key);
    // Unreachable from this picker — every option's value came from `voiceKey` —
    // but the seam refuses an unparseable ref and so must this, rather than
    // writing null and silently resetting the track to the fallback.
    if (!ref) {
      onNotice('That voice is no longer in your library.');
      return;
    }
    report(setTrackVoice(track.id, ref));
  };

  const onVoiceChange = (key: string) => {
    setDraftVoiceKey(key);
    if (voiceTimer.current !== null) clearTimeout(voiceTimer.current);
    voiceFlush.current = () => commitVoice(key);
    voiceTimer.current = setTimeout(() => commitVoice(key), VOICE_COMMIT_MS);
  };

  const closeVoice = () => {
    voiceFlush.current?.();
    setVoiceOpen(false);
  };

  const applyInstrument = (next: FretInstrumentId) => {
    setPending(null);
    const result = setTrackInstrument(track.id, next);
    if (!result.ok) {
      onNotice(result.reason);
      return;
    }
    // Said once, after the fact, because it is not a refusal and not a warning:
    // the blocks on this track were written for another instrument. The header
    // keeps a standing badge; this is the moment it became true. No claim about
    // what will be HEARD — LIB-GAP(15), the track carries no tuning of its own.
    //
    // Re-read rather than measured against the `track` prop: that one still
    // carries the OLD instrument id until the store's write re-renders us, and
    // comparing snapshots against it would count the wrong blocks.
    const written = findTrack(track.id);
    const mismatched = written ? mismatchedPlacements(written) : 0;
    if (mismatched > 0) {
      onNotice(
        `${track.name} is on ${instrumentName(next)}: ${mismatched} ${mismatched === 1 ? 'block was' : 'blocks were'} written for another instrument.`,
      );
    }
  };

  const onInstrumentChange = (next: FretInstrumentId) => {
    const stranded = strandedByInstrument(track, next);
    // The voice is gone the moment this write lands and no undo brings it back,
    // so a track with an override asks even when nothing would be stranded.
    //
    // `=== 'ok'` and not "has a ref": a dangling ref (its variant deleted, or one
    // for another instrument) is non-null and costs NOTHING to destroy — the
    // track fell back to the instrument's voice the moment it went. Asking "drops
    // this track's voice for good?" about a voice that is already gone, while the
    // picker beside it says so, is a confirmation with no subject.
    const losesVoice = voiceStatus === 'ok';
    if (stranded > 0 || losesVoice) {
      // The panel is a control that opens, and this replaces the row it opened
      // into. Left open it would come back after the answer showing a picker for
      // a voice the confirmed write has just cleared.
      closeVoice();
      setPending({ kind: 'instrument', instrumentId: next, stranded, losesVoice });
      return;
    }
    applyInstrument(next);
  };

  const onRemove = () => {
    // The last track goes STRAIGHT to the seam, which refuses it and says why.
    // Asking "delete 4 blocks?" first would be a question with only one honest
    // answer, and re-authoring the reason here would be a second copy of the
    // sentence the agent gets.
    const placements = track.placements.length;
    if (placements > 0 && !isLast) {
      setPending({ kind: 'remove', placements });
      return;
    }
    report(removeTrack(track.id));
  };

  const confirmPending = () => {
    if (!pending) return;
    if (pending.kind === 'remove') {
      setPending(null);
      report(removeTrack(track.id));
      return;
    }
    applyInstrument(pending.instrumentId);
  };

  /**
   * The instrument question, in one line of a 200 px header.
   *
   * Three shapes rather than two sentences stacked, because the confirm row
   * replaces the mixer strip and cannot grow: the strings clause is the one
   * that carries a count, the voice clause is the one that carries the word
   * "for good" — which is the only honest way to say "undo will not help".
   * STRINGS, never audibility (LIB-GAP(15)).
   */
  const instrumentQuestion = (choice: {
    instrumentId: FretInstrumentId;
    stranded: number;
    losesVoice: boolean;
  }) => {
    const name = instrumentName(choice.instrumentId);
    const notes = `${choice.stranded} ${choice.stranded === 1 ? 'note' : 'notes'}`;
    if (choice.stranded > 0 && choice.losesVoice) {
      return `${name} has no string for ${notes}, and drops this voice for good?`;
    }
    if (choice.stranded > 0) return `${name} has no string for ${notes}?`;
    return `${name} drops this track's voice for good?`;
  };

  const tiny =
    'pressable control rounded-md px-1 py-0.5 font-mono text-[8.5px] font-bold leading-none disabled:opacity-30';

  return (
    <>
      <div className="flex items-center gap-1">
        {/* The picker shows the RESOLVED instrument, not the raw string: a track
            whose `instrumentId` is not in the catalog plays as guitar, and the
            control has to name what will be heard. */}
        <select
          aria-label={`Instrument for ${track.name}`}
          value={instrumentId}
          onChange={(e) => onInstrumentChange(e.target.value as FretInstrumentId)}
          className="control min-w-0 flex-1 rounded-md px-1 py-0.5 font-mono text-[8.5px] font-bold text-ink"
        >
          {listTrackInstruments().map((instrument) => (
            <option key={instrument.id} value={instrument.id}>
              {instrument.name}
            </option>
          ))}
        </select>

        {/* CP-13 — the per-track VOICE, opened rather than crammed in beside the
            instrument. See the width argument on the component: two `<select>`s
            in this row leave each of them about six readable characters.

            The button carries the ANSWER even while closed — the resolved preset
            is in its title and the override shows as the accent — because a
            control that opens is a control whose state has to be visible from the
            outside, and "which voice is this track on" is the question the strip
            exists to answer.

            ⚠ CP-14 did NOT open here, and the TODO that said it would was
            wrong. A rack does not fit a 200 px column — that is the same width
            argument that put this picker behind a button in the first place — so
            voice mode gives each track's whole LANE to its rack instead
            (`TrackVoiceRack`), which is also the only layout where two tracks'
            settings are readable at once. This picker stays, in every mode: it
            is what CHOOSES the voice, where the rack TUNES it. */}
        <button
          type="button"
          aria-label={`Voice for ${track.name}`}
          aria-expanded={voiceOpen}
          title={
            voiceStatus === 'deleted'
              ? `${track.name}'s voice has left your library — it plays ${voicePreset.name}`
              : voiceStatus === 'wrong-instrument'
                ? `${track.name}'s voice is for another instrument — it plays ${voicePreset.name}`
                : voiceStatus === 'ok'
                  ? `${track.name} plays through ${voicePreset.name}`
                  : `${track.name} follows this instrument's voice (${voicePreset.name})`
          }
          onClick={() => (voiceOpen ? closeVoice() : setVoiceOpen(true))}
          className={`pressable rounded-md px-1 py-0.5 font-mono text-[8.5px] font-bold leading-none ${
            voiceStatus === 'ok' ? 'control-accent' : 'control'
          }`}
        >
          ♪
        </button>

        {/* Reorder is a pair of buttons and not a drag, and that is the point:
            `moveTrack` takes an id and an index, so the agent reaches the same
            capability. A drag would be an additional way in, never the only
            one. Disabled at the ends — unlike the track cap, "the top track
            cannot move up" needs no explaining, it is visible. */}
        <button
          type="button"
          aria-label={`Move ${track.name} up`}
          title="Move up"
          disabled={index === 0}
          onClick={() => report(moveTrack(track.id, index - 1))}
          className={tiny}
        >
          ▲
        </button>
        <button
          type="button"
          aria-label={`Move ${track.name} down`}
          title="Move down"
          disabled={index === trackCount - 1}
          onClick={() => report(moveTrack(track.id, index + 1))}
          className={tiny}
        >
          ▼
        </button>
        <button
          type="button"
          aria-label={`Remove ${track.name}`}
          // The seam refuses the last track independently; this says why before
          // the press rather than after it.
          title={isLast ? "A composition can't have zero tracks" : 'Remove track'}
          aria-disabled={isLast || undefined}
          onClick={onRemove}
          className={`${tiny} ${isLast ? 'opacity-30' : ''}`}
        >
          ✕
        </button>
      </div>

      {pending ? (
        <div className="flex items-center gap-1">
          {/* Announced, not merely drawn: opening this row REPLACES the mix
              strip for this track, and a control disappearing under you is the
              one change that has to say something. `aria-live` rather than
              `role="alert"` — it is a question, and the grid's two alert strips
              are for things that already happened. */}
          <span
            aria-live="polite"
            className="min-w-0 flex-1 truncate font-mono text-[8.5px] text-ink"
          >
            {pending.kind === 'remove'
              ? `Delete ${pending.placements} ${pending.placements === 1 ? 'block' : 'blocks'}?`
              : /* Names the instrument being confirmed: the picker has already
                   snapped back to the stored one, so the count alone would be a
                   question about nothing on screen. */
                instrumentQuestion(pending)}
          </span>
          <button
            type="button"
            aria-label={
              pending.kind === 'remove'
                ? `Confirm removing ${track.name}`
                : `Confirm instrument change for ${track.name}`
            }
            title={
              pending.kind === 'remove'
                ? 'Removing the track deletes its blocks — undoable with ↶'
                : pending.losesVoice
                  ? // The one confirmation on this page whose cost ↶ cannot
                    // reverse, so the tooltip says which half is which.
                    "The track's own voice is cleared and ↶ will not bring it back; stranded notes stay in the block"
                  : "Those notes sit on strings the new instrument hasn't got, and stay in the block"
            }
            onClick={confirmPending}
            className="pressable control-accent rounded-md px-1.5 py-0.5 font-mono text-[8.5px] font-bold leading-none"
          >
            ✓
          </button>
          <button
            type="button"
            aria-label={`Cancel, keep ${track.name} as it is`}
            onClick={() => setPending(null)}
            className={tiny}
          >
            ✕
          </button>
        </div>
      ) : voiceOpen ? (
        <div className="flex items-center gap-1">
          {/* ⚠ NOT `voiceService.selectVoice`, which writes the editing PATTERN's
              ref and would change no track at all. `setTrackVoice` writes this
              track's `Track.voiceRef` and nothing else — the whole point being
              that two guitar tracks can sound different.

              A voice is a SHARED asset: picking a user variant here points at the
              same variant the pattern page edits, so a later Save retunes both.
              That is intended and deliberately not forked per track.

              The TUNING is voice mode's rack (CP-14); the variant list and
              Save / Save-as / Rename are TODO(CP-15). This is a plain picker,
              and staying one is the point. */}
          <select
            aria-label={`Voice for ${track.name}`}
            // The resolved preset, which is the only place the fallback's
            // identity is visible — the option labels name the CHOICE.
            title={
              voiceRef
                ? `${track.name} plays through ${voicePreset.name}`
                : `${track.name} follows this instrument's voice (${voicePreset.name})`
            }
            autoFocus
            value={draftVoiceKey ?? voiceRefKey}
            onChange={(e) => onVoiceChange(e.target.value)}
            // Leaving the field ends the coalescing window early. Without it a
            // pick made with the keyboard and then tabbed away from would sit for
            // {@link VOICE_COMMIT_MS} looking committed and not being.
            onBlur={() => voiceFlush.current?.()}
            className="control min-w-0 flex-1 rounded-md px-1 py-0.5 font-mono text-[8.5px] font-bold text-ink"
          >
            {/* Disabled, because it is a fact rather than a choice — and present
                at all so the control can say WHY it is showing a voice the list
                below does not contain. The two failures are named apart: one is
                a variant that is gone, the other is one that exists and is for
                another neck, and only the first reads as a deletion. */}
            {voiceStatus === 'deleted' && (
              <option value={voiceRefKey} disabled>
                Voice deleted
              </option>
            )}
            {voiceStatus === 'wrong-instrument' && (
              <option value={voiceRefKey} disabled>
                Another instrument’s voice
              </option>
            )}
            {/* Not "none": a null ref plays something, it just isn't this track's
                choice. Listed first so the way back is always in the same place. */}
            <option value="">Auto</option>
            {/* Grouped because the distinction is load-bearing rather than
                cosmetic — only one of the two can ever be saved to (CP-15). */}
            <optgroup label="Built-in">
              {voices.builtIns.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.name}
                </option>
              ))}
            </optgroup>
            {voices.userVariants.length > 0 && (
              <optgroup label="Yours">
                {voices.userVariants.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button
            type="button"
            aria-label={`Close the voice picker for ${track.name}`}
            title="Back to the mixer"
            onClick={closeVoice}
            className={tiny}
          >
            ✕
          </button>
        </div>
      ) : (
        <>
        <div className="flex items-center gap-1">
          {/* `aria-pressed` rather than a checkbox: these are latching switches
              on a mixer, and their state is the whole message. What they MEAN
              together — mute wins, solo silences the un-soloed — is
              `isTrackAudible`, and the header states the outcome so the two
              buttons never have to be read as a puzzle. */}
          <button
            type="button"
            aria-label={`Mute ${track.name}`}
            title="Mute this track (wins over solo)"
            aria-pressed={track.muted}
            onClick={() => report(setTrackMuted(track.id, !track.muted))}
            className={`pressable rounded-md px-1.5 py-0.5 font-mono text-[8.5px] font-bold leading-none ${
              track.muted ? 'control-accent' : 'control'
            }`}
          >
            M
          </button>
          <button
            type="button"
            aria-label={`Solo ${track.name}`}
            title="Solo — every un-soloed track goes quiet"
            aria-pressed={track.soloed}
            onClick={() => report(setTrackSoloed(track.id, !track.soloed))}
            className={`pressable rounded-md px-1.5 py-0.5 font-mono text-[8.5px] font-bold leading-none ${
              track.soloed ? 'control-accent' : 'control'
            }`}
          >
            S
          </button>
          {/* A native range: already keyboard-operable and already announcing
              its value, exactly as `ParamSlider` argues at length. dB straight
              through — no 0–100 conversion, because the model, the clamp and
              the gain node are all dB and a percentage would only be a second
              unit to get wrong.

              NOT `ParamSlider` itself, and the reason is layout rather than
              taste: it requires an `id` and spends a fixed 74 px + 52 px on a
              visible `<label>` and readout, which is more than half of this
              header's 200 px. `aria-label` and a 30 px readout is what fits.

              `?? 0` because the field is optional on the model and
              `migrateCompositionToTracks` returns an already-populated
              composition UNCHANGED — a track persisted under an older schema
              reaches this fader with no `volumeDb`, and `value={undefined}`
              silently turns a controlled range uncontrolled. The lib guards
              every read of it the same way. */}
          <input
            type="range"
            aria-label={`Volume for ${track.name} in decibels`}
            min={VOLUME_RANGE_DB.min}
            max={VOLUME_RANGE_DB.max}
            step={0.5}
            value={track.volumeDb ?? 0}
            onChange={(e) => report(setTrackVolumeDb(track.id, e.currentTarget.valueAsNumber))}
            className="h-1 min-w-0 flex-1 cursor-pointer accent-brass"
          />
          {/* `aria-hidden`: the range already reports this number, and read out
              twice it becomes "volume for Rhythm minus six minus six".
              `toFixed(1)`, as `ParamSlider` does: the step is 0.5, and rounding
              would print −0.5 as "0" — indistinguishable from unity. */}
          <span
            aria-hidden
            className="w-[30px] flex-none text-right font-mono text-[8.5px] tabular-nums text-ink-mut"
          >
            {(track.volumeDb ?? 0) > 0 ? '+' : ''}
            {(track.volumeDb ?? 0).toFixed(1)}
          </span>
        </div>
        {/* Pan gets a ROW rather than a place beside the fader (CP-19). The
            strip's height was raised to hold it, deliberately: a pan pot needs
            a centre you can land on, and a control squeezed in next to the
            fader is one nobody can hit.

            A second native range, for every reason the fader's comment gives —
            already keyboard-operable, already announcing itself, no second unit
            invented for it. `?? 0` for the same reason too, one field newer:
            `pan` is OPTIONAL on the model, so a track saved before this existed
            arrives with none at all and `value={undefined}` would quietly turn
            a controlled range uncontrolled. */}
        <div className="flex items-center gap-1">
          <span
            aria-hidden
            className="w-[26px] flex-none font-mono text-[8.5px] font-bold leading-none text-ink-mut"
          >
            PAN
          </span>
          <input
            type="range"
            aria-label={`Pan for ${track.name}`}
            // The raw value is -1..+1 and nobody speaks it: a reader announcing
            // "minus zero point three five" has said the number and told you
            // nothing. This is the same string the readout shows.
            aria-valuetext={panLabel(track.pan ?? 0)}
            min={PAN_RANGE.min}
            max={PAN_RANGE.max}
            step={0.05}
            value={track.pan ?? 0}
            onChange={(e) => report(setTrackPan(track.id, withDetent(e.currentTarget.valueAsNumber)))}
            // Double-click re-centres. The detent makes centre reachable by
            // drag; this makes it reachable without one, which is what a
            // keyboard-free hand reaches for after moving a part too far.
            onDoubleClick={() => report(setTrackPan(track.id, 0))}
            className="h-1 min-w-0 flex-1 cursor-pointer accent-brass"
          />
          {/* `aria-hidden` for the fader's reason — `aria-valuetext` above
              already says this, and read twice it becomes "pan for Rhythm L35
              L35". */}
          <span
            aria-hidden
            className="w-[30px] flex-none text-right font-mono text-[8.5px] tabular-nums text-ink-mut"
          >
            {panLabel(track.pan ?? 0)}
          </span>
        </div>
        </>
      )}
    </>
  );
}
