import { useState, type ReactNode } from 'react';
import type { Track } from '@fretwork/lib';
import { trackInstrumentId, useSelectedTrackId, useTracks } from './compositionService';
import {
  parseVoiceKey,
  readTrackVoiceRef,
  selectVoice,
  useSelectableVoices,
  useTrackVoiceStatus,
  voiceKey,
  type VoiceOption,
} from '../voice/voiceService';
import { discardVoiceDraft, useVoiceDirty, useVoiceWorkingPreset } from '../voice/voiceDrafts';
import { SHARED_VOICE_REFUSAL_TEXT } from '../voice/voiceChrome';

/**
 * The voice LIBRARY, in the composition page's right rail — voice mode's
 * counterpart of `PatternLibraryRail` and `NoteInspectorRail`.
 *
 * ── What this is, now that saving has left ───────────────────────────────────
 *
 * A list, and the picking that goes with it. Save / Save as… / Rename / Delete,
 * the unsaved pill and the name form were HERE, and the rack's strip carried a
 * line of text pointing at this rail — which showed you the knobs and then told
 * you the button was in another part of the screen. They are in
 * `TrackVoiceRack`'s own header now,
 * beside the knobs that made the edit, with the shared-asset warning that travels
 * with them. What is left here is the one thing a 300 px rail is better at than a
 * lane: the whole library at once, grouped and counted, with the empty states that
 * say which kind of empty it is.
 *
 * So PICKING now exists three times on this page — this list, each rack's header
 * `<select>`, and `TrackControls`' compact picker — and ⚠ THEY DO NOT ALL ADDRESS
 * THE SAME TRACK. This one follows the SELECTION; a rack header addresses the
 * track whose rack it is. That is correct and it has to be VISIBLE, which is why
 * the heading below names the track this rail is acting on. Without it, two
 * pickers showing different voices on one screen reads as a bug.
 *
 * ⚠ WHICH SELECTION. This follows `compositionService.useSelectedTrackId()` — the
 * TRACK selection. There are three live at once on this page and they are
 * different things: `patternService.useSelectedIds()` is the NOTE selection (what
 * `NoteInspectorRail` follows) and `compositionService.useSelectedPlacementIds()`
 * is the PLACEMENT selection (what pattern mode's blocks answer to). A voice
 * belongs to a track, so this rail follows tracks; the note or block that happens
 * to be selected is not its business.
 *
 * ⚠ `'pattern'` IS THE ARGUMENT THAT LOOKS RIGHT AND IS WRONG here. The one write
 * left in this file goes through the same seam as the pattern page's and differs
 * from it only in the `kind` passed first: under `'pattern'` `selectVoice` resolves
 * its target through the EDITING PATTERN, so from this rail it would retune
 * whatever pattern is open and change no track at all — which, with one track on
 * the fallback, can even look like it worked. The kind is `'track'` at every call
 * site here and is never inferred.
 *
 * ── Two rules inherited from the rails that came first ───────────────────────
 *
 *  - ALWAYS MOUNTED, empty state included. A rail that appeared and vanished with
 *    the selection would move the grid beside it on every click.
 *  - AN EMPTY RAIL SAYS WHICH KIND OF EMPTY IT IS. "No composition open", "no
 *    track selected" and "no variants of your own yet" are three different
 *    sentences and only one of them is about the user having done nothing wrong.
 *    Silence reads as broken.
 *
 * ── Why a list of buttons and not a `<select>` ───────────────────────────────
 *
 * Both `<select>` pickers on this page debounce their writes by `VOICE_COMMIT_MS`,
 * because a native `<select>` fires `change` once per arrow key while closed and
 * ten of the eleven guitar voices are sampler-sourced — one keyboard walk down
 * the list is a fetch storm. THIS SURFACE NEEDS NO SUCH WINDOW, and the reason is
 * the control rather than the rail: arrowing through a list of buttons moves
 * focus and commits nothing, so a pick costs exactly one write whether it was
 * made with a pointer or with a keyboard. The rail also has the full 300 px, so
 * the option names are readable — which is the measured reason the rack header's
 * and the track strip's pickers stay `<select>`s.
 *
 * ── No dirty pill, no Revert, no Save ────────────────────────────────────────
 *
 * All three live on the rack, and for one reason: that is where the edit is made.
 * A draft belongs to a track, the rack is a track's own surface, and a rail that
 * follows the selection can only ever speak about one of the eight racks on
 * screen. The dirty state is still READ here — a pick that would strand an unsaved
 * edit asks first, and it has to know there is one — but it is not DRAWN here.
 */
export function VoiceRail() {
  const tracks = useTracks();
  const selectedTrackId = useSelectedTrackId();
  const track = tracks.find((candidate) => candidate.id === selectedTrackId);

  if (!track) {
    return (
      <Empty
        title={tracks.length === 0 ? 'No composition open' : 'No track selected'}
        body={
          tracks.length === 0
            ? 'A voice belongs to a track, and there are none to pick one for yet.'
            : 'Click a track’s name in the header column to pick its voice. Tuning and saving are on the track’s own rack.'
        }
      />
    );
  }

  // Keyed by track, so a standing refusal belongs to the track it was made
  // against. Without it, a refused pick on one track would still be on screen
  // after clicking another.
  return <TrackVoicePicker key={track.id} track={track} />;
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-4 text-center">
      <p className="font-mono text-[10px] tracking-[0.14em] text-ink uppercase">{title}</p>
      <p className="max-w-[28ch] font-mono text-[9px] leading-relaxed text-ink-mut">{body}</p>
    </div>
  );
}

function TrackVoicePicker({ track }: { track: Track }) {
  const instrumentId = trackInstrumentId(track);
  const voices = useSelectableVoices(instrumentId);
  const status = useTrackVoiceStatus(track);
  // What the rack is showing and the engine is building: the unsaved edit when
  // there is one, the resolved variant otherwise. Read for the NAME in the heading
  // and for the dirty check under a pick — the rack is what edits and saves it.
  //
  // BY ID, so the composition store is the authority for the preset and the `track`
  // prop is chrome only (its name, and the rail's own status row). The two cannot
  // disagree about the voice even for a render, which is the point of addressing the
  // seam rather than reading the document it was handed.
  const preset = useVoiceWorkingPreset('track', track.id);
  // Read but not drawn — see the header. A pick that would strand an unsaved edit
  // asks first, and this is how it knows there is one.
  const dirty = useVoiceDirty('track', track.id);

  const [notice, setNotice] = useState<string | null>(null);

  // Unreachable: this component is only rendered for a track this rail found in
  // `useTracks`, which is the same list the draft store resolves against.
  // Guarded rather than asserted, and after every hook above has run.
  if (!preset) return null;

  const ref = readTrackVoiceRef(track);
  const currentKey = ref ? voiceKey(ref) : '';

  /** guitar-tutor's answer, kept and matched to the rack's: one confirmation in
   *  front of every switch that would throw the working copy away — and `choose`
   *  really does throw it away (see the `discard()` there), so this is the last
   *  chance to keep it. Routed through one function so replacing it with a real
   *  dialog is a single edit. */
  const confirmDiscard = () =>
    !dirty || window.confirm(`Discard unsaved changes to ${track.name}’s voice?`);

  /** Every refusal in this rail is rendered, never swallowed — the composition
   *  seam's are already sentences, so they are shown as they are. */
  const report = (result: { ok: true } | { ok: false; reason: string }) =>
    setNotice(result.ok ? null : result.reason);

  /** Retire this track's draft, and tell the engine. `discardVoiceDraft` notifies
   *  whenever it deletes one, which is what makes the live voice go back to what
   *  the store now holds. */
  const discard = () => discardVoiceDraft('track', track.id);

  /**
   * Land a pick: report whatever came back, and RETIRE THE DRAFT — but only if the
   * write actually happened, since the user agreed to lose the edit on condition of
   * the switch and a refused switch has not earned it.
   *
   * ⚠ The discard is not redundant with the repoint. A new ref only makes the
   * draft's tag STOP MATCHING, which is not the same as retiring it:
   * `readVoiceDraft` self-clears on a mismatch, but the only readers a page
   * that has never pressed Play has are `useVoiceDirty` /
   * `useVoiceWorkingPreset`, and those compare the tag WITHOUT deleting (a
   * store write during render is a React error). Left standing, the entry
   * resurrects the moment the track is pointed back at the voice it was taken
   * from — and the user is then playing an edit they threw away.
   */
  const commitPick = (result: { ok: true } | { ok: false; reason: string }) => {
    report(result);
    if (result.ok) discard();
  };

  const choose = (key: string) => {
    // Already on it. The notice is cleared anyway: a refusal left standing beside
    // a row the user just re-affirmed reads as a refusal of THAT click.
    if (key === currentKey) {
      setNotice(null);
      return;
    }
    if (!confirmDiscard()) return;
    // '' is the way back to the fallback, and it is a real choice rather than an
    // absence: a null ref puts the track on the instrument's global active voice,
    // which is the lib's documented meaning for one.
    if (key === '') {
      commitPick(selectVoice('track', track.id, null));
      return;
    }
    const next = parseVoiceKey(key);
    // Unreachable from these rows — every key came from `voiceKey` — but the seam
    // refuses an unparseable ref and so must this, rather than writing null and
    // silently resetting the track to the fallback.
    if (!next) {
      setNotice(SHARED_VOICE_REFUSAL_TEXT['unknown-variant']);
      return;
    }
    commitPick(selectVoice('track', track.id, next));
  };

  const row = (option: VoiceOption) => (
    <li key={option.key}>
      <button
        type="button"
        aria-pressed={option.key === currentKey}
        onClick={() => choose(option.key)}
        className={`pressable flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left ${
          option.key === currentKey ? 'control-accent' : 'control'
        }`}
      >
        <span className="max-w-full truncate font-mono text-[10.5px] font-bold text-ink">
          {option.name}
        </span>
      </button>
    </li>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ---- WHICH TRACK this list is picking for --------------------------
          The load-bearing line of the rail now that every rack has a picker of
          its own: this one follows the SELECTION and a rack's follows its own
          track, so two pickers can legitimately show two different voices. The
          track's name is what makes that readable instead of wrong. */}
      <div className="flex flex-none items-center gap-2 border-b border-rim-dark px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[8px] tracking-[0.14em] text-ink-mut uppercase">
            Voice for
          </span>
          <span className="block truncate font-display text-[14px] text-ink-hi">{track.name}</span>
          <span className="block truncate font-mono text-[8.5px] tracking-[0.12em] text-ink-mut uppercase">
            {instrumentId} · {preset.name}
          </span>
        </span>
      </div>

      {/* Mounted always, `sr-only` when empty: a live region has to exist BEFORE
          its content changes to be announced, and sr-only costs no layout. */}
      <p
        role="status"
        // Named, because every rack now has a live region of its own and an
        // unnamed ninth one on the same page is the one nobody can place.
        aria-label="Voice list message"
        className={
          notice
            ? 'mx-3 mb-1.5 flex-none rounded-md border border-brass/50 px-2 py-1.5 font-mono text-[9px] leading-relaxed text-ink'
            : 'sr-only'
        }
      >
        {notice}
      </p>

      {/* ---- the list ------------------------------------------------------- */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {/* A ref can outlive the voice it named, or name a variant for another
            instrument. Shown rather than silently replaced by the first row: the
            two failures are different sentences and only one reads as a deletion. */}
        {(status === 'deleted' || status === 'wrong-instrument') && (
          <p className="px-1 py-1.5 font-mono text-[9px] leading-relaxed text-brass-hi">
            {status === 'deleted'
              ? 'This track’s voice has been deleted; it is playing a built-in until you pick another.'
              : 'This track’s voice belongs to another instrument; it is playing a built-in until you pick another.'}
          </p>
        )}

        <div role="group" aria-label="Instrument default" className="pt-1">
          <ul>
            <li>
              <button
                type="button"
                aria-pressed={ref === null}
                onClick={() => choose('')}
                className={`pressable flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left ${
                  ref === null ? 'control-accent' : 'control'
                }`}
              >
                <span className="font-mono text-[10.5px] font-bold text-ink">Auto</span>
                <span className="font-mono text-[8.5px] tracking-[0.1em] text-ink-mut uppercase">
                  Follows the instrument
                </span>
              </button>
            </li>
          </ul>
        </div>

        <Group label="Presets" count={voices.builtIns.length}>
          {voices.builtIns.length === 0 ? (
            <p className="px-1 py-1.5 font-mono text-[9px] leading-relaxed text-ink-mut">
              The lib ships no voices for {instrumentId}.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">{voices.builtIns.map(row)}</ul>
          )}
        </Group>

        <Group label="My tones" count={voices.userVariants.length}>
          {voices.userVariants.length === 0 ? (
            // The OTHER kind of empty, and it says which: nothing is wrong and
            // nothing is missing — this instrument simply has no variants of the
            // user's yet, and the way to make one is named.
            <p className="px-1 py-1.5 font-mono text-[9px] leading-relaxed text-ink-mut">
              No voices of your own for {instrumentId} yet. Tune this track on its rack, then Save
              as… to keep it.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">{voices.userVariants.map(row)}</ul>
          )}
        </Group>
      </div>
    </div>
  );
}

/** The two groups are labelled landmarks rather than headings alone: the
 *  distinction between them is load-bearing — only one of them can ever be saved
 *  to — and a group is what lets a screen reader (and a test) scope to one. */
function Group({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="pt-2">
      <div className="flex items-baseline justify-between gap-2 px-1 pb-1">
        <span className="font-mono text-[9px] font-semibold tracking-[0.16em] text-ink-mut uppercase">
          {label}
        </span>
        <span className="font-mono text-[8.5px] text-ink-mut/70">{count}</span>
      </div>
      {children}
    </div>
  );
}
