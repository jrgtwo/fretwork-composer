import { useState, type ReactNode } from 'react';
import type { Track } from '@fretwork/lib';
import { trackInstrumentId, useSelectedTrackId, useTracks } from './compositionService';
import {
  deleteTrackVoice,
  parseVoiceKey,
  readTrackVoiceRef,
  renameVoice,
  saveTrackVoice,
  saveTrackVoiceAs,
  setTrackVoice,
  useSelectableVoices,
  useTrackVoiceStatus,
  voiceKey,
  type TrackVoiceRefusal,
  type VoiceOption,
} from '../voice/voiceService';
import {
  discardTrackVoiceDraft,
  useTrackVoiceDirty,
  useTrackVoiceWorkingPreset,
} from '../voice/trackVoiceDrafts';
import { AuditionButton } from '../voice/AuditionButton';
import { SHARED_VOICE_REFUSAL_TEXT, useNameForm, voiceButtonClass } from '../voice/voiceChrome';
import { DirtyPill } from '../voice/DirtyPill';
import { NameForm } from '../voice/NameForm';

/**
 * The voice list, in the composition page's right rail — voice mode's counterpart
 * of `PatternLibraryRail` and `NoteInspectorRail`, and the last piece of this page.
 *
 * The lane RACK (CP-14) tunes a voice; this picks and persists one. That split is
 * why the rack's strip has always said "Unsaved" with no Save beside it: a voice
 * is a SHARED asset, so writing one back retunes every pattern and every other
 * track pointing at it, and that belongs to a deliberate control rather than to
 * the act of turning a knob.
 *
 * ⚠ WHICH SELECTION. This follows `compositionService.useSelectedTrackId()` — the
 * TRACK selection. There are three live at once on this page and they are
 * different things: `patternService.useSelectedIds()` is the NOTE selection (what
 * `NoteInspectorRail` follows) and `compositionService.useSelectedPlacementIds()`
 * is the PLACEMENT selection (what pattern mode's blocks answer to). A voice
 * belongs to a track, so this rail follows tracks; the note or block that happens
 * to be selected is not its business.
 *
 * ⚠ `voiceService.selectVoice` IS THE FUNCTION THAT LOOKS RIGHT AND IS WRONG here,
 * and so are `saveVoice` / `saveVoiceAs`. All three resolve their target through
 * the EDITING PATTERN, so from this rail they would retune whatever pattern is
 * open and change no track at all — which, with one track on the fallback, can
 * even look like it worked. `setTrackVoice`, `saveTrackVoice` and
 * `saveTrackVoiceAs` are the track path. `renameVoice` is shared with the pattern
 * page deliberately: it addresses a variant by id, and a variant has no per-holder
 * identity to disagree about. Deleting is the same act with a dangling ref left
 * behind it, and the holder to repair differs — hence `deleteTrackVoice`.
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
 * `TrackControls`' compact picker debounces its writes by `VOICE_COMMIT_MS`,
 * because a native `<select>` fires `change` once per arrow key while closed and
 * ten of the eleven guitar voices are sampler-sourced — one keyboard walk down
 * the list is a fetch storm. THIS SURFACE NEEDS NO SUCH WINDOW, and the reason is
 * the control rather than the rail: arrowing through a list of buttons moves
 * focus and commits nothing, so a pick costs exactly one write whether it was
 * made with a pointer or with a keyboard. The rail also has the full 300 px, so
 * the option names are readable — which is the measured reason the header's
 * picker had to stay a `<select>` behind a disclosure in the first place.
 *
 * ── The dirty indicator, and who owns Revert ─────────────────────────────────
 *
 * The indicator here reflects the SELECTED track's draft and nothing else, so
 * switching tracks switches what it says without either draft being touched —
 * `trackVoiceDrafts` holds up to eight of them above every unmount.
 *
 * There is deliberately NO Revert button in this rail. The rack's strip already
 * has one and it is CANONICAL: an edit was made on the rack, so the way to throw
 * it away is beside the knobs that made it, where the tone you are about to lose
 * is on screen. Two discard buttons for one draft is two places to explain what
 * "revert" means.
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
            : 'Click a track’s name in the header column to pick and save its voice.'
        }
      />
    );
  }

  // Keyed by track, so a half-typed name and a standing refusal belong to the
  // track they were made against. Without it, opening Rename on one track and
  // clicking another would apply the first track's form to the second.
  return <TrackVoicePicker key={track.id} track={track} />;
}

/** Every refusal the track write path can hand back needs a sentence, since each
 *  is a state this rail can legitimately be in. `no-pattern` is unreachable from
 *  here and is carried because `renameVoice` is shared with the pattern page and
 *  typed on its wider union. `built-in` is Sound Lab's
 *  shipped wording, kept. */
const REFUSAL_TEXT: Record<TrackVoiceRefusal, string> = {
  ...SHARED_VOICE_REFUSAL_TEXT,
  'no-track': 'That track is no longer in this composition.',
  // The two that name the holder, which is why they are stated here rather than
  // shared with `VoicePane`: its versions say "this pattern".
  'no-voice':
    'This track follows its instrument’s voice. Use Save as… to keep these tweaks as a voice of its own.',
  'built-in': 'Presets are read-only. Use Save as… to keep your tweaks.',
};

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
  // there is one, the resolved variant otherwise. The SAME call the audition
  // resolves through, so Save writes exactly what Audition just played.
  const preset = useTrackVoiceWorkingPreset(track);
  const dirty = useTrackVoiceDirty(track);

  const [notice, setNotice] = useState<string | null>(null);
  // Transient by design: switching track discards a half-typed name, which is
  // what pressing Escape would do anyway. The state that must survive an unmount
  // is the draft, and that is in `trackVoiceDrafts`. The hook is `VoicePane`'s —
  // the focus-return it carries is the half two copies would eventually disagree
  // about, and it is invisible in a screenshot.
  const {
    form: nameForm,
    setForm: setNameForm,
    open: openNameForm,
    close: closeNameForm,
  } = useNameForm();

  const ref = readTrackVoiceRef(track);
  const currentKey = ref ? voiceKey(ref) : '';
  const isBuiltIn = ref === null || ref.kind === 'default';

  /** guitar-tutor's answer, kept and matched to `VoicePane`: one confirmation in
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

  /** Retire this track's draft, and tell the engine. `discardTrackVoiceDraft`
   *  notifies even when it deletes nothing to delete, which is what makes the
   *  live voice go back to what the store now holds. */
  const discard = () => discardTrackVoiceDraft(track.id);

  /**
   * Land a pick: report whatever came back, and RETIRE THE DRAFT — but only if the
   * write actually happened, since the user agreed to lose the edit on condition of
   * the switch and a refused switch has not earned it.
   *
   * ⚠ The discard is not redundant with the repoint. A new ref only makes the
   * draft's tag STOP MATCHING, which is not the same as retiring it:
   * `readTrackVoiceDraft` self-clears on a mismatch, but the only readers a page
   * that has never pressed Play has are `useTrackVoiceDirty` /
   * `useTrackVoiceWorkingPreset`, and those compare the tag WITHOUT deleting (a
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
    setNameForm(null);
    // '' is the way back to the fallback, and it is a real choice rather than an
    // absence: a null ref puts the track on the instrument's global active voice,
    // which is the lib's documented meaning for one.
    if (key === '') {
      commitPick(setTrackVoice(track.id, null));
      return;
    }
    const next = parseVoiceKey(key);
    // Unreachable from these rows — every key came from `voiceKey` — but the seam
    // refuses an unparseable ref and so must this, rather than writing null and
    // silently resetting the track to the fallback.
    if (!next) {
      setNotice(REFUSAL_TEXT['unknown-variant']);
      return;
    }
    commitPick(setTrackVoice(track.id, next));
  };

  const save = () => {
    const result = saveTrackVoice(track.id, preset);
    if (!result.ok) {
      setNotice(REFUSAL_TEXT[result.reason]);
      return;
    }
    setNotice(null);
    // The variant now holds what the draft held. Left standing, the draft would
    // keep the rack reading "Unsaved" against a voice that already matches it,
    // and would keep the engine building from a copy nothing can reach.
    discard();
  };

  const submitName = () => {
    if (!nameForm) return;
    const trimmed = nameForm.value.trim();

    if (nameForm.mode === 'save-as') {
      const result = saveTrackVoiceAs(track.id, trimmed, preset);
      if (!result.ok) {
        setNotice(REFUSAL_TEXT[result.reason]);
        return;
      }
      setNotice(null);
      closeNameForm();
      // `saveTrackVoiceAs` has already repointed the track, which retires the
      // draft by tag on its own; this is what tells the engine to go and rebuild
      // from the variant rather than from the copy it was made out of.
      discard();
      return;
    }

    // Near-unreachable — Rename is disabled unless the track is on a user variant
    // — but this is the one place in the file that could swallow a failure, and a
    // form that sits open saying nothing is the thing this rail would be blamed for.
    if (ref?.kind !== 'user') {
      setNotice(REFUSAL_TEXT['built-in']);
      return;
    }
    const result = renameVoice(ref.id, trimmed);
    if (!result.ok) {
      setNotice(REFUSAL_TEXT[result.reason]);
      return;
    }
    setNotice(null);
    closeNameForm();
  };

  const remove = () => {
    if (ref?.kind !== 'user') return;
    // ONE dialog, not two. Deleting the variant also strands this track's unsaved
    // edit — `choose` asks about exactly that on the same screen, and asking twice
    // in a row is how people learn to click through confirmations — so the loss is
    // named in the sentence that is already being read.
    const consequence = dirty
      ? 'Your unsaved edits to it go too, and any pattern or track using it falls back to a built-in voice.'
      : 'Any pattern or track using it falls back to a built-in voice.';
    if (!window.confirm(`Delete “${preset.name}”? ${consequence}`)) return;

    // ONE seam call, because it is one act: `deleteVoice` repairs the editing
    // PATTERN's ref and knows nothing about tracks, so a caller with no pointer
    // would get the pattern fixed and this track left dangling — resolving
    // silently to a built-in while the rail showed nothing selected. The button
    // must not do more than the function.
    const result = deleteTrackVoice(track.id, ref.id);
    if (!result.ok) {
      setNotice(REFUSAL_TEXT[result.reason]);
      return;
    }
    setNameForm(null);
    setNotice(null);
    discard();
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
      {/* ---- what is being voiced, and one note of it ------------------------ */}
      <div className="flex flex-none items-center gap-2 border-b border-rim-dark px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-display text-[14px] text-ink-hi">{track.name}</span>
          <span className="block truncate font-mono text-[8.5px] tracking-[0.12em] text-ink-mut uppercase">
            {instrumentId} · {preset.name}
          </span>
        </span>
        <AuditionButton track={track} />
      </div>

      {/* ---- what can be done to the voice it is on ------------------------- */}
      <div className="flex flex-none flex-wrap items-center gap-1 px-3 py-1.5">
        <DirtyPill dirty={dirty} />
        <span className="flex-1" />
        {/* `status !== 'ok'` is the third refusal and it is the seam's too: a ref
            can name a variant that has been deleted, or one belonging to another
            instrument, and `writeVariant` refuses both rather than overwriting a
            voice the user cannot see from where they are standing. */}
        <button
          type="button"
          onClick={save}
          disabled={!dirty || isBuiltIn || status !== 'ok'}
          className={voiceButtonClass}
        >
          Save
        </button>
        <button
          type="button"
          onClick={openNameForm('save-as', `${preset.name} copy`)}
          className={voiceButtonClass}
        >
          Save as…
        </button>
        <button
          type="button"
          onClick={openNameForm('rename', preset.name)}
          // ⚠ DISABLED WHILE DIRTY, and not merely to keep things tidy: the draft
          // carries the OLD name, and `saveTrackVoice` writes the record's name
          // back from `preset.name` — so a rename made now would be silently
          // undone by the next Save. `VoicePane` patches its working copy instead,
          // which this surface cannot do: `trackVoiceDrafts` exposes writes for
          // schema params only, by design. A name write there is the better answer
          // and is a change to that module, not to this one.
          disabled={isBuiltIn || dirty}
          title={
            dirty && !isBuiltIn
              ? 'Save or revert this track’s edits first — a rename would be undone by the next Save'
              : undefined
          }
          className={voiceButtonClass}
        >
          Rename
        </button>
        <button type="button" onClick={remove} disabled={isBuiltIn} className={voiceButtonClass}>
          Delete
        </button>
      </div>

      {/* Said BEFORE the button is pressed, not after: a voice is a shared asset
          and Save retunes every holder of it. That is settled behaviour rather
          than a bug — there is deliberately no per-track fork — but it is
          surprising the first time, and the rail is where it can be said. */}
      <p className="flex-none px-3 pb-1.5 font-mono text-[8.5px] leading-relaxed text-ink-mut">
        {/* Why Save is refused, stated where the refusal is — a disabled button
            with no reason is the thing this rail would be most blamed for. The
            seam refuses independently of the disabled attribute, in all three
            cases. */}
        {isBuiltIn
          ? ref === null
            ? REFUSAL_TEXT['no-voice']
            : REFUSAL_TEXT['built-in']
          : status !== 'ok'
            ? REFUSAL_TEXT['unknown-variant']
            : // The one case where there IS something to save into — and where the
              // consequence has to be said before the button is pressed.
              `Saving overwrites “${preset.name}” everywhere it is used — every pattern and every other track on it.`}
      </p>

      {nameForm && (
        <NameForm
          form={nameForm}
          // Distinct from `VoicePane`'s "voice-name": both surfaces can be mounted
          // at once behind a route change, and two inputs sharing an id is a label
          // pointing at whichever came first.
          inputId="track-voice-name"
          className="px-3 pb-1.5"
          onChange={(value) => setNameForm({ ...nameForm, value })}
          onSubmit={submitName}
          onCancel={closeNameForm}
        />
      )}

      {/* Mounted always, `sr-only` when empty: a live region has to exist BEFORE
          its content changes to be announced, and sr-only costs no layout. */}
      <p
        role="status"
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
