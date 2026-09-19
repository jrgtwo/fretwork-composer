/**
 * One track's voice, drawn as a rack across its lane — what a lane draws for a
 * track whose view is Voice. Per TRACK, not per page: since COMPS-TRACK-TABS
 * milestone 4 one of these can sit between two Pattern lanes.
 *
 * ⚠ THIS COMPONENT'S BOX IS WHAT THE LANE IS MEASURED FROM. `ArrangementGrid`
 * wraps the root div below in a deliberately unstyled element carrying
 * `data-voice-rack` and hands it to a `ResizeObserver`; the row's height is that
 * border box (floored at `TRACK_HEADER_HEIGHT`). So the root must stay
 * HEIGHT-LESS and OVERFLOW-LESS — give it an `h-full` or an `overflow-y-auto`
 * and it reports the row's height back to the thing that set it, which is a
 * loop, not a lane. Milestone 2's fixed-height viewport, which this scrolled
 * inside, is gone; the row follows this, never the other way round.
 *
 * ⚠ THE EDITOR ITSELF IS `voice/VoiceEditor`, which the pattern page renders
 * too. This file is the composition page's chrome around it: the rack's own
 * collapse, the power lamp, the voice's name in the strip, and the arguments
 * that make the shared editor address THIS track. Everything that draws a
 * `paramSchema` row — the knobs, the stages, the pedalboard, the sub-branches,
 * saving, picking, the notice line — is in that one component now, and the rule
 * that used to live here ("a section with a custom renderer needs one on both
 * sides") went with the second copy.
 *
 * ── Why the row and not a modal or the header ────────────────────────────────
 *
 * The rejected alternative was a modal per track: a modal can only show one
 * track at a time, and the whole point of per-track voices is comparing two.
 * The 200 px track header was the other, and CP-13 measured it — two `<select>`s
 * in that column leave each about six readable characters, which is why the
 * compact voice PICKER there stays behind a disclosure and stays a picker. A
 * row of the arrangement is the only surface with room for a whole chain, and
 * stacked down the page the rows are a 19" equipment rack, which is the design
 * language this project already chose.
 *
 * ── TWO LEVELS OF DISCLOSURE, and their names say which is which ─────────────
 *
 * "Voice rack for Lead" folds this whole rack away (its state is
 * `collapsedRacks` in `App`); "Amp stage for Lead" folds one stage of it
 * (`collapsedRackSections`, beside it, for the same reason). Both are reported
 * UP rather than kept here: this component is replaced on every mode switch and
 * unmounted on every visit to the pattern page, and a section that unfolds
 * itself behind your back is the same bug as a rack that does.
 *
 * ── What the rack passes that the pane does not ──────────────────────────────
 *
 *   - a `scope` — the track's name. Up to eight racks are on screen at once and
 *     the TRACK is what tells eight "Drive" knobs apart, for a screen reader and
 *     for the tests that scope their queries by landmark.
 *   - lane-width knobs. Eight amp knobs plus a cabinet and the IN/OUT bar have to
 *     fit one lane; the pane has a whole column. One rule, two values, named for
 *     the width that decides them.
 *   - refusal sentences that name a TRACK where the pane's name a pattern.
 *   - a selectable "Auto" option: clearing a track's ref puts it on the
 *     instrument's global active variant, which is the lib's documented meaning
 *     for a null ref. A pattern has no such write.
 *   - `onRepointed: null` — `playbackService` picks a track's ref change up from
 *     the composition store and swaps that one track's voice. `refreshVoice`
 *     would rebuild the EDITING PATTERN's, which a track write never touched.
 *   - `wheel: 'scroll'` — this rack is drawn INSIDE the arrangement's scroller,
 *     so a wheel over it is someone reaching for track five. The dials install
 *     no wheel listener at all and prevent no default, and the event chains to
 *     the scroller. The pane passes `'adjust'`: its page does not scroll under
 *     the cursor, so there a notch is a step.
 *
 * ── Refusals: ONE channel, and it is local ───────────────────────────────────
 *
 * Every refusal a rack can raise goes to the editor's own notice line, under its
 * header. There is no `onNotice` prop and the grid's single message strip is not
 * written to from here, deliberately: with up to eight racks on screen and
 * something saveable in each, "That voice is no longer in your library" at the
 * top of the page names none of them. The strip keeps what it is still the right
 * home for — `TrackHeader`'s and `TrackControls`' writes, which are about the
 * track rather than about its voice.
 *
 * ── ⚠ ONE of the two reverbs is here, and which one matters ──────────────────
 *
 * The VOICE's reverb is here, inside the Cabinet + room stage, and it is this
 * track's own: a `Tone.JCReverb` per voice, wired after the cabinet (lib
 * `Voice.wireChain`), so it is the room around THIS track's speaker. Eight racks
 * hold eight of them and turning one moves one track. That is new — it was out
 * of scope until 2026-09-16, when the lib moved it post-cab and `paramSchema`
 * declared it on `CABINET_SECTION` as the `effects.reverb` sub-branch.
 *
 * The OTHER reverb — `useVoiceStore.reverb` — is still absent from here and
 * still deliberately so. It is a single `Tone.Reverb` send on `MasterBus` that
 * every voice passes through, with one `setReverb` for the whole store, so a
 * per-track control for it would be eight controls that are secretly one.
 * Nothing in `src/` has ever called `setReverb`; if it is ever surfaced it wants
 * a name of its own and one place to live, not a row in a rack. Rowed in
 * `.claude/docs/tasks/DEFERRED.md` as "Two different things are both called
 * 'reverb'".
 */
import type { Track } from '@fretwork/lib';
import type { SectionId } from '../voice/paramSchema';
import { useVoiceWorkingPreset } from '../voice/voiceDrafts';
import {
  readTrackVoiceRef,
  useTrackVoiceStatus,
  type VoiceRefusal,
} from '../voice/voiceService';
import { LANE_KNOB_SCALE, SHARED_VOICE_REFUSAL_TEXT } from '../voice/voiceChrome';
import { VoiceEditor } from '../voice/VoiceEditor';
import { PowerLamp } from '../voice/rack/RackFace';
import { findTrack, trackInstrumentId } from './compositionService';

/**
 * Every refusal the write seam can hand back needs a sentence, since each is a
 * state this rack can legitimately be in. The three on top of the shared set are
 * the ones that NAME THE HOLDER, which is why they are stated here rather than
 * shared with `VoicePane`: its versions say "this pattern". `built-in` is Sound
 * Lab's shipped wording, kept.
 */
const REFUSAL_TEXT: Record<VoiceRefusal, string> = {
  ...SHARED_VOICE_REFUSAL_TEXT,
  'no-holder': 'That track is no longer in this composition.',
  'no-voice':
    'This track follows its instrument’s voice. Use Save as… to keep these tweaks as a voice of its own.',
  'built-in': 'Presets are read-only. Use Save as… to keep your tweaks.',
};

/** A track's ref-less state is a real CHOICE — the lib's documented fallback to
 *  the instrument's global active variant — where a pattern's is a statement of
 *  fact. Not "none": a track with no ref plays something. */
const FOLLOW_OPTION = { label: 'Auto — follows the instrument', selectable: true } as const;

export function TrackVoiceRack({
  track,
  audible,
  collapsed,
  onCollapsedChange,
  collapsedSections,
  onCollapsedSectionsChange,
}: {
  track: Track;
  /** Whether this track will actually be heard — mute, solo and every other
   *  track's solo state. Computed by the grid, because the answer depends on the
   *  whole stack; drawn here as the rack's power lamp, which is the one honest
   *  reading of a lamp on a mixer. */
  audible: boolean;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /**
   * Which of THIS track's stages are folded — the FOLDED set, so it cannot go
   * stale when `paramSchema` gains a section. `undefined` is "nobody has folded
   * this rack yet", which is NOT the same as an empty list: empty is a user who
   * has unfolded everything, and collapsing it back to `undefined` would re-fold
   * two stages under them. Passed straight through to `VoiceEditor`, which owns
   * the default.
   */
  collapsedSections?: readonly SectionId[];
  onCollapsedSectionsChange?: (collapsed: readonly SectionId[]) => void;
}) {
  // Addressed by kind and id, never by the `Track` itself — see `voiceDrafts`'
  // header. The prop stays because this strip reads the track's own fields for
  // chrome the draft store knows nothing about, and because the grid computes
  // `audible` from the whole stack.
  const preset = useVoiceWorkingPreset('track', track.id);
  const status = useTrackVoiceStatus(track);
  const ref = readTrackVoiceRef(track);

  // Unreachable: the grid only draws a rack for a track of the composition the
  // draft store resolves against.
  if (!preset) return null;

  return (
    // THE OBSERVED BOX (through the unstyled wrapper `ArrangementGrid` puts
    // around it). Normal flow, no height of its own and nothing clipped, so
    // what it lays out at IS what the row is set to — folding a stage shrinks
    // this, the observer fires, and the lane and everything under it move up.
    // See the header: an `h-full` or an inner scroller here breaks that.
    <div className="flex flex-col gap-1 p-1">
      <div className="flex flex-none items-center gap-1.5">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={`Voice rack for ${track.name}`}
          onClick={() => onCollapsedChange(!collapsed)}
          className="pressable control flex flex-none items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[8.5px] font-bold tracking-[0.1em] uppercase"
        >
          <span aria-hidden className="text-ink-mut">
            {collapsed ? '▸' : '▾'}
          </span>
          {track.name}
        </button>
        {/* `RackFace`'s own lamp, so the strip and the faceplates below it cannot
            drift apart. It says what will be HEARD, which on a mixer is the only
            honest reading of one: mute wins, and a solo elsewhere silences this. */}
        <PowerLamp lit={audible} />
        <span className="min-w-0 truncate font-mono text-[8.5px] tracking-[0.06em] text-ink-mut">
          {preset.name}
        </span>
      </div>

      <VoiceEditor
        kind="track"
        id={track.id}
        instrumentId={trackInstrumentId(track)}
        voiceRef={ref}
        // Re-read at COMMIT time rather than taken from the render that scheduled
        // the pick: the rail, the header's own compact picker and the agent all
        // write the same track, and the rendered value can be a window out of
        // date — which would write a pick the model has already taken, or skip
        // one it has not.
        readVoiceRef={() => {
          const live = findTrack(track.id);
          return live ? readTrackVoiceRef(live) : null;
        }}
        scope={track.name}
        scale={LANE_KNOB_SCALE}
        // ⚠ THIS RACK IS INSIDE THE ARRANGEMENT'S SCROLLER, so a wheel over it
        // is someone reaching for track five — not someone turning Drive. The
        // dials therefore install no wheel listener at all and prevent no
        // default, and the event chains to the scroller exactly as it would over
        // a block. Every other gesture is unchanged: drag, arrows, Page keys and
        // double-click still edit. jsdom has no scrolling, so what a test here
        // can see is the listener's ABSENCE, not the scroll that follows.
        wheel="scroll"
        refusals={REFUSAL_TEXT}
        follow={FOLLOW_OPTION}
        // A ref can name a variant that has been deleted, or one belonging to
        // another instrument; the two are different sentences and the seam
        // refuses a Save into either. Asked of the seam rather than derived from
        // the offer list, because `unknown-variant`'s shared wording would read as
        // a contradiction of the `<option>` right above it.
        unavailable={
          status === 'deleted'
            ? { option: 'Voice deleted', reason: REFUSAL_TEXT['unknown-variant'] }
            : status === 'wrong-instrument'
              ? {
                  option: 'Another instrument’s voice',
                  reason: 'That voice belongs to another instrument.',
                }
              : null
        }
        onRepointed={null}
        collapsed={collapsed}
        collapsedSections={collapsedSections}
        onCollapsedSectionsChange={onCollapsedSectionsChange}
      />
    </div>
  );
}
