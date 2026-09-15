/**
 * The Instrument & Amp pane — the pattern page's frame around `VoiceEditor`.
 *
 * ⚠ EVERYTHING ABOUT THE VOICE IS IN `VoiceEditor` NOW, which the composition
 * page's racks render too. This file is the pattern page's chrome and nothing
 * else: the empty state, the instrument picker, and the four arguments that make
 * the shared editor address the open PATTERN — see `VoiceEditor`'s header for
 * what each of them is answering.
 *
 * ── Why the instrument picker stays here ─────────────────────────────────────
 *
 * An instrument is a property of the HOLDER, not of the voice, and changing a
 * track's is destructive — it can strand placed blocks, which is why
 * `TrackControls` owns a two-stage confirmation for it. A copy in eight rack
 * headers would duplicate that flow or skip it, so the shared editor has no
 * instrument control at all and this one keeps its own, above the editor, with
 * the confirm-before-discard it has always had.
 *
 * ── The unsaved edit is not here either ──────────────────────────────────────
 *
 * Edits accumulate in `voice/voiceDrafts`, keyed `pattern:<id>` — a module, not
 * React state, because `PaneStack` unmounts a collapsed pane's body and would
 * forget an edit held here, and because every control has to be a way of CALLING
 * a capability the agent can call by kind, id and value. Three consequences
 * worth knowing:
 *
 *   - A voice is a SHARED asset. Save overwrites the variant for every pattern
 *     AND every track pointing at it, which is intended and was decided with the
 *     user. There is no per-holder fork.
 *   - The fourteen built-in slots are readonly lib consts with no setter, so
 *     Save is *impossible* for them, not merely discouraged.
 *   - A draft is tagged with the instrument and ref it is an edit OF, so
 *     switching voice or instrument retires it — here by the explicit discard on
 *     the instrument gesture, in the editor for a voice pick, and by the engine's
 *     tag watch for a repoint made behind this pane's back. Switching PATTERN
 *     retires nothing: the key carries the pattern id, so each pattern keeps its
 *     own unsaved tone.
 */
import type { FretInstrumentId } from '@fretwork/lib';
import {
  listInstruments,
  patternInstrumentId,
  getEditingPattern,
  setEditingPatternInstrument,
  useEditingPattern,
} from '../patterns/patternService';
import { refreshVoice } from '../audio/playbackService';
import {
  readVoiceRef as readPatternVoiceRef,
  useEditingVoiceRef,
  useSelectableVoices,
  voiceKey,
  type VoiceRefusal,
} from './voiceService';
import { discardVoiceDraft, isVoiceDirty } from './voiceDrafts';
import type { SectionId } from './paramSchema';
import { VoiceEditor } from './VoiceEditor';
import { PANE_KNOB_SCALE, SHARED_VOICE_REFUSAL_TEXT, voiceLabelClass } from './voiceChrome';

const INSTRUMENTS = listInstruments();

/**
 * Every refusal `voiceService` can return is a state this pane can be in, so each
 * one needs a sentence, and the three that name the holder cannot be shared with
 * a rack's — its versions say "this track". `built-in` is Sound Lab's shipped
 * wording, kept verbatim. Declared as a complete `Record` so a new refusal is a
 * compile error here rather than a missing sentence.
 */
const REFUSAL_TEXT: Record<VoiceRefusal, string> = {
  ...SHARED_VOICE_REFUSAL_TEXT,
  'no-holder': 'No pattern is open.',
  'no-voice': 'This pattern has no voice of its own. Use Save as… to keep these tweaks.',
  'built-in': 'Defaults are read-only. Use Save as new variant to keep your tweaks.',
};

/** The pattern's ref-less state, worded as the fact it is rather than as an
 *  offer: `voiceService` deliberately exposes no clear-the-ref write for a
 *  pattern, because the global `activeVariants` map is shared by every pattern
 *  without one. A track's equivalent option IS selectable. */
const FOLLOW_OPTION = { label: 'Instrument default', selectable: false } as const;

const selectClass = 'control pressable min-w-0 rounded-lg px-1.5 py-1 font-mono text-[10px]';

export function VoicePane({
  collapsedSections,
  onCollapsedSectionsChange,
}: {
  /**
   * Which stages are folded — the FOLDED set, as the racks hold, so a section
   * `paramSchema` gains is open rather than hidden by a list that never heard of
   * it. `undefined` is "nobody has folded this yet" and is NOT the same as an
   * empty list; `App` keeps the two apart.
   */
  collapsedSections?: readonly SectionId[];
  onCollapsedSectionsChange: (collapsed: readonly SectionId[]) => void;
}) {
  const pattern = useEditingPattern();
  const ref = useEditingVoiceRef();
  const instrumentId = pattern ? patternInstrumentId(pattern) : INSTRUMENTS[0].id;
  const voices = useSelectableVoices(instrumentId);

  // Split so the editor's own hooks run inside it rather than behind an early
  // return here; every hook above this line runs for every render of the pane.
  if (!pattern) {
    return (
      <div className="well flex items-center justify-center py-6">
        <span className="font-mono text-[10px] font-semibold tracking-[0.18em] text-ink-mut uppercase">
          No pattern open
        </span>
      </div>
    );
  }

  const currentKey = ref ? voiceKey(ref) : '';
  const listed = [...voices.builtIns, ...voices.userVariants].some(
    (option) => option.key === currentKey,
  );

  /** guitar-tutor's answer, kept: one `window.confirm` in front of a switch that
   *  would strand the unsaved edit. The voice picker's copy of this lives in the
   *  shared editor; this is the instrument's, which is the gesture this pane
   *  still owns. */
  const chooseInstrument = (next: FretInstrumentId) => {
    if (next === instrumentId) return;
    if (isVoiceDirty('pattern', pattern.id) && !window.confirm('Discard unsaved changes to this voice?')) {
      return;
    }
    discardVoiceDraft('pattern', pattern.id);
    setEditingPatternInstrument(next);
    // The pattern's ref may not be resolvable on the new instrument; the lib's
    // resolver falls through to that instrument's first default, and this is what
    // makes the engine follow.
    refreshVoice();
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-none flex-wrap items-center gap-x-2 gap-y-1">
        <label htmlFor="voice-instrument" className={`flex-none ${voiceLabelClass}`}>
          Instrument
        </label>
        <select
          id="voice-instrument"
          value={instrumentId}
          onChange={(event) => chooseInstrument(event.currentTarget.value as FretInstrumentId)}
          className={`${selectClass} flex-1`}
        >
          {INSTRUMENTS.map((instrument) => (
            <option key={instrument.id} value={instrument.id}>
              {instrument.name}
            </option>
          ))}
        </select>
      </div>

      <VoiceEditor
        kind="pattern"
        id={pattern.id}
        instrumentId={instrumentId}
        voiceRef={ref}
        // Re-read at COMMIT time, up to `VOICE_COMMIT_MS` after the render that
        // scheduled the pick — an undo restoring a snapshot with another
        // `voiceRef`, or the agent, can move it inside that window.
        readVoiceRef={() => {
          const open = getEditingPattern();
          return open ? readPatternVoiceRef(open) : null;
        }}
        // One holder on this page, so the engraved label is the whole accessible
        // name — no track to carry, and the same prop a rack passes its track's
        // name in.
        scope={null}
        // A whole pane column's worth of width, against a rack lane's.
        scale={PANE_KNOB_SCALE}
        // The dials' own gesture, unchanged: this pane is not inside a scroller
        // the wheel belongs to, so a notch over a knob is a step and the dial
        // keeps its `preventDefault`. A rack passes `'scroll'` — see its comment
        // there for what that costs and why the arrangement needs it.
        wheel="adjust"
        refusals={REFUSAL_TEXT}
        follow={FOLLOW_OPTION}
        // A ref can outlive the voice it named, or name a variant for another
        // instrument. Admitted rather than silently replaced by the first option
        // — a `<select>` whose value matches no option displays the first one.
        // The two failures are one word here, where a rack tells them apart: this
        // pane cannot ask the seam which it is without a track.
        unavailable={
          ref !== null && !listed
            ? {
                option: 'Unavailable voice',
                reason: SHARED_VOICE_REFUSAL_TEXT['unknown-variant'],
              }
            : null
        }
        // The PATTERN arm's obligation: nothing makes a pattern's selection
        // audible on its own, and this is also what retires an edit abandoned
        // behind this pane's back. A rack passes null — `playbackService` follows
        // the composition store for a track, and `refreshVoice` would rebuild the
        // editing pattern's voice instead.
        onRepointed={refreshVoice}
        collapsedSections={collapsedSections}
        onCollapsedSectionsChange={onCollapsedSectionsChange}
      />
    </div>
  );
}
