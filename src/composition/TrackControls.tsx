import { useState } from 'react';
import type { FretInstrumentId, Track } from '@fretwork/lib';
import {
  VOLUME_RANGE_DB,
  findTrack,
  listTrackInstruments,
  mismatchedPlacements,
  moveTrack,
  removeTrack,
  setTrackInstrument,
  setTrackMuted,
  setTrackSoloed,
  setTrackVolumeDb,
  strandedByInstrument,
  trackInstrumentId,
  type Result,
} from './compositionService';

/**
 * One track's mixer strip and its structural controls: instrument, position in
 * the stack, removal, mute, solo and the fader.
 *
 * Split out of `TrackHeader` because the header is IDENTITY — the name plate,
 * the selection, the audibility state — and this is everything that WRITES.
 * They are two different rates of change: the plate is settled, this row is
 * where CP-13's per-track voice picker lands next.
 *
 * Every write goes through `compositionService`, and every refusal is handed up
 * to `onNotice` rather than swallowed. There is deliberately no local mirror of
 * any track field: the strip renders the `track` it is given and the next store
 * write re-renders it, so a control can never show a value the model rejected.
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
 *  - CHANGING THE INSTRUMENT asks only when it would STRAND notes — a six-string
 *    riff moved onto a four-string bass leaves two strings the bass has not got
 *    (`strandedByInstrument`). A change that strands nothing applies
 *    immediately; the mismatch it may still leave is reported by the badge in
 *    `TrackHeader` instead, which is a standing fact rather than a decision.
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
    | { kind: 'instrument'; instrumentId: FretInstrumentId; stranded: number }
    | null
  >(null);

  const report = (result: Result<unknown>) => {
    if (!result.ok) onNotice(result.reason);
  };

  const instrumentId = trackInstrumentId(track);
  const isLast = trackCount === 1;

  const instrumentName = (id: FretInstrumentId) =>
    listTrackInstruments().find((instrument) => instrument.id === id)?.name ?? id;

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
    if (stranded > 0) {
      setPending({ kind: 'instrument', instrumentId: next, stranded });
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

  const tiny =
    'pressable control rounded-md px-1 py-0.5 font-mono text-[8.5px] font-bold leading-none disabled:opacity-30';

  return (
    <>
      <div className="flex items-center gap-1">
        {/* TODO(CP-13): the per-track VOICE picker belongs beside this one.
            Until it exists a track plays the global active variant for its
            instrument, which is the lib's documented fallback for a null
            `voiceRef` — `setTrackVoiceRef` is deliberately not wired to any
            control here. */}
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
                   question about nothing on screen. STRINGS, not audibility —
                   LIB-GAP(15). */
                `${instrumentName(pending.instrumentId)} has no string for ${pending.stranded} ${
                  pending.stranded === 1 ? 'note' : 'notes'
                }?`}
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
      ) : (
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
      )}
    </>
  );
}
