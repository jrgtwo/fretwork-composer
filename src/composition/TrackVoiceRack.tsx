/**
 * One track's voice, drawn as a rack down its whole row — voice mode's answer to
 * "what does a lane draw".
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
 * ── ⚠ THE STAGES STACK. CP-16 corrected CP-14 here ───────────────────────────
 *
 * They ran left to right, in a flex row with its own horizontal scrollbar. That
 * came out of a brief that said "a rack spanning the full lane width", and it
 * was wrong twice over: it is not what a rack looks like, and it forced the row
 * to a FIXED height that no function could keep in step with what the sections
 * inside it were showing. They are now `flex flex-col`, exactly as `VoicePane`
 * arranges the same four stages on the pattern page.
 *
 * The design argument for racks-over-modals survives intact, because it was
 * never about this axis: what has to be visible at once is TWO TRACKS' settings,
 * and stacking the sections within one track does not touch that.
 *
 * TWO LEVELS OF DISCLOSURE now, and their accessible names have to say which is
 * which — "Voice rack for Lead" folds this whole rack away (its state is
 * `collapsedRacks` in `App`), "Amp stage for Lead" folds one section of it
 * (`collapsedRackSections`, beside it, for the same reason).
 *
 * BOTH DISCLOSURES ARE `shell/Section`, which is the shared one — this file used
 * to hand-roll the stage's, and the note here used to explain why. That reason
 * is gone: it was that `VoiceSection` hard-codes its landmark as `${label} stage`
 * and carries the pane's status vocabulary ("Not on this preset", where a rack
 * says nothing and goes dark). `VoiceSection` no longer owns the disclosure at
 * all. `Section` builds the button and the region, a `chassis` render prop
 * decides what they are bolted to — `RackFace`, here as there — and `buttonLabel`
 * is the track-scoped name. Both of the old blockers are things this file now
 * simply passes in. What stays local is what was always particular: the
 * `regionName`, because up to eight racks are on screen at once and the TRACK is
 * what tells eight "Drive" sliders apart (see the banner below).
 *
 * ── This is chrome. The table is `paramSchema` ───────────────────────────────
 *
 * Every control here is one row of `PARAM_SECTIONS`, addressed into the preset
 * by `presetPaths` — the same table `VoicePane` renders on the pattern page.
 * Nothing in this file knows that an amp has a "Bass" or what its range is, so
 * adding a parameter is a change to the descriptors and not to this component.
 * The four stages are four `RackFace`s for the same reason `VoiceSection` is
 * one: `RackFace` is the chassis, and its `regionName` is what makes eight
 * racks' worth of identically-named controls navigable — see the note on
 * accessible names below.
 *
 * ── Where the edits go ───────────────────────────────────────────────────────
 *
 * Not into the voice store. They accumulate in `voiceDrafts`, which lives
 * above every component in the app because this one unmounts twice over (leaving
 * voice mode, and every visit to the pattern page) — and because a knob has to
 * be a way of CALLING a capability the agent can call by kind, id and value. Every
 * write here is one seam call whose refusal is rendered rather than swallowed.
 *
 * SAVING IS HERE TOO, in this rack's own header, and it did not used to be: the
 * strip pointed at the right-hand rail, in words, for the one button that keeps
 * what the knobs just did. A voice is still a SHARED
 * asset — writing one back retunes every pattern and every other track pointing at
 * it — so the consequence is SAID, in the sentence under the buttons, rather than
 * answered by putting the button somewhere else. `VoiceRail` keeps the library
 * list and the picking that goes with it.
 *
 * ── Refusals: ONE channel, and it is local ───────────────────────────────────
 *
 * Every refusal this rack can raise — a param write, a sample pack the registry
 * lost, a pick, a Save — goes to the notice line under this rack's header. There
 * is no `onNotice` prop any more and the grid's single message strip is no longer
 * written to from here, deliberately: with up to eight racks on screen and
 * something saveable in each, "That voice is no longer in your library" at the top
 * of the page names none of them. The strip keeps what it is still the right home
 * for — `TrackHeader`'s and `TrackControls`' writes, which are about the track
 * rather than about its voice.
 *
 * ── Eight of everything ──────────────────────────────────────────────────────
 *
 * The header mints DOM ids (`domId`, track-scoped), an accessible name per
 * control, a `window.confirm` question, a name form and a live region — all of
 * which have only ever rendered once before. Every one of them carries the track,
 * by the convention this file already had for its landmarks: the track comes
 * first, because that is the axis a listener is navigating.
 *
 * ── Why the header's picker debounces and the rail's does not ────────────────
 *
 * It is a `<select>`, and a `<select>` fires `change` once per arrow key while
 * closed — see `VOICE_COMMIT_MS` in `voiceChrome`, which is the window every such
 * picker collects its writes in. The rail needs none because a list of buttons
 * commits nothing on arrow.
 *
 * ── ⚠ Accessible names, and what is accepted here ────────────────────────────
 *
 * `Knob`, `ParamEnum` and `CabinetGraphic` name their controls from the
 * descriptor's label alone, and none of them takes an override. With eight racks
 * open there are therefore eight sliders called "Drive". They are NOT modified
 * to take one — they are shared with the pattern page and were checked as
 * multi-instance safe as they stand — so the disambiguation is the one `RackFace`
 * documents for exactly this: every stage is a landmark region named for its
 * track ("Rhythm amp"), which is how a screen reader tells two apart and how the
 * tests scope their queries. A per-control override across four shared
 * components is the better answer and is a change to those components, not to
 * this one.
 *
 * ── A sub-branch is added, removed and re-kinded here too ────────────────────
 *
 * `paramSchema` carries two optional branches nested inside stages — the second
 * source, in Source, and the body filter's cutoff envelope. Their ROWS work here
 * like every other row, because they are declared in `section.params` and so are
 * in `voiceDrafts`' path map.
 *
 * The BRANCH itself needs three seams of its own, because `addVoiceSection`
 * / `removeVoiceSection` are keyed by `SectionId` and a sub-branch is not a
 * section, and because `setVoiceParam` resolves a `source-kind` row through
 * `withSourceKind`, which takes no path and always replaces the PRIMARY source —
 * which is exactly why the layer's picker is declared on `ParamSubBranch.kindRow`
 * and kept out of `section.params` in the first place. They are
 * `addVoiceSubBranch`, `removeVoiceSubBranch` and
 * `setVoiceSubBranchKind` in `voice/voiceDrafts.ts`, and this surface
 * draws all three — so a track with no second source can gain one from here or
 * from an agent's call, which is the same test every other capability on this
 * page passes.
 *
 * ── ⚠ There is no reverb here, and that is deliberate ────────────────────────
 *
 * A `VoicePreset` has its own reverb and `paramSchema` does not declare it, so it
 * is out of scope. The OTHER reverb — `useVoiceStore.reverb` — is a single
 * `Tone.Reverb` send on `MasterBus` that every voice passes through, with one
 * `setReverb` for the whole store. A per-track rack showing "reverb" would show
 * eight controls that are secretly one, so it shows none.
 */
import { useEffect, useRef, useState } from 'react';
import { getAmpModel, getSamplePack, detectSamplePack, type Track } from '@fretwork/lib';
import {
  DEFAULT_OPEN_SECTIONS,
  PARAM_SECTIONS,
  PEDALS,
  branchParams,
  enabledParamOf,
  ownParams,
  sectionPresence,
  subBranchApplies,
  visibleParams,
  type EnumParam,
  type Param,
  type ParamSection,
  type ParamStage,
  type ParamSubBranch,
  type SectionId,
  type SliderParam,
  type SourceKindParam,
} from '../voice/paramSchema';
import { getAtPath } from '../voice/presetPaths';
import {
  addVoicePedal,
  addVoiceSection,
  addVoiceSubBranch,
  discardVoiceDraft,
  isVoiceDirty,
  removeVoicePedal,
  removeVoiceSection,
  removeVoiceSubBranch,
  setVoiceName,
  setVoiceParam,
  setVoiceSubBranchKind,
  useVoiceDirty,
  useVoiceWorkingPreset,
} from '../voice/voiceDrafts';
import {
  deleteVoice,
  parseVoiceKey,
  readTrackVoiceRef,
  renameVoice,
  saveVoice,
  saveVoiceAs,
  selectVoice,
  useSelectableVoices,
  useTrackVoiceStatus,
  voiceKey,
  type VoiceRefusal,
} from '../voice/voiceService';
import {
  SHARED_VOICE_REFUSAL_TEXT,
  useNameForm,
  VOICE_COMMIT_MS,
} from '../voice/voiceChrome';
import { DirtyPill } from '../voice/DirtyPill';
import { NameForm } from '../voice/NameForm';
import { PowerLamp, RackFace } from '../voice/rack/RackFace';
import { Section } from '../shell/Section';
import { AmpHead } from '../voice/rack/AmpHead';
import { CabinetGraphic } from '../voice/rack/CabinetGraphic';
import { Knob } from '../voice/controls/Knob';
import { ParamEnum } from '../voice/controls/ParamEnum';
import { ParamToggle } from '../voice/controls/ParamToggle';
import { ParamEncoder } from '../voice/controls/ParamEncoder';
import {
  findTrack,
  setTrackInputGainDb,
  trackInstrumentId,
  TRACK_INPUT_GAIN_RANGE_DB,
  type Result,
} from './compositionService';

/** Smaller than the pattern pane's 56 px default: eight amp knobs plus a cabinet
 *  and a level stage have to fit one lane's width, and `Knob` scales its own
 *  type off this so the labels stay proportionate rather than overflowing. */
const AMP_KNOB_PX = 42;
const SMALL_KNOB_PX = 38;

/** The cabinet's URL, which is the one path this file names by hand — the mic
 *  dot writes it, and the descriptor beside it is what resolves it. */
const CAB_URL_PATH = 'effects.cabIR.url';

/** `id` on an input, `htmlFor` on its label. Scoped by TRACK as well as by path:
 *  eight racks would otherwise mint eight elements with the same `id`, and a
 *  `<label htmlFor>` resolves to whichever mounted first. */
const domId = (trackId: string, path: string) =>
  `track-voice-${trackId}-${path.replaceAll('.', '-')}`;

/** ONE button skin in this rack, and it is the rack's own. `voiceChrome`'s
 *  `voiceButtonClass` — which the four saving buttons arrived wearing — is a size
 *  up, because it was drawn for the 300 px rail they came from; two skins one row
 *  apart in the same header is the seam showing. jsdom has no layout and cannot
 *  fail on it, so it is written down instead. `disabled:cursor-not-allowed` came
 *  across with them. */
const buttonClass =
  'pressable control flex-none rounded-md px-1.5 py-0.5 font-mono text-[8.5px] font-bold tracking-[0.06em] uppercase disabled:cursor-not-allowed disabled:opacity-40';

/**
 * Every refusal the write seam can hand back needs a sentence, since each is a
 * state this rack can legitimately be in. Moved here with the buttons it explains,
 * from `VoiceRail`.
 *
 * The three on top of the shared set are the ones that NAME THE HOLDER, which is
 * why they are stated here rather than shared with `VoicePane`: its versions say
 * "this pattern". `built-in` is Sound Lab's shipped wording, kept.
 */
const REFUSAL_TEXT: Record<VoiceRefusal, string> = {
  ...SHARED_VOICE_REFUSAL_TEXT,
  'no-holder': 'That track is no longer in this composition.',
  'no-voice':
    'This track follows its instrument’s voice. Use Save as… to keep these tweaks as a voice of its own.',
  'built-in': 'Presets are read-only. Use Save as… to keep your tweaks.',
};

/**
 * What a rack nobody has folded yet shows: everything except
 * `DEFAULT_OPEN_SECTIONS`, which is the pattern page's default and now the
 * schema's. DERIVED rather than listed, so a fifth `ParamSection` starts folded
 * here without this file being edited — and so the two editors cannot open on
 * different stages, which is what CP-14 shipped.
 *
 * Module-level so the default prop keeps a stable identity across renders.
 */
const DEFAULT_COLLAPSED_SECTIONS: readonly SectionId[] = PARAM_SECTIONS.filter(
  (section) => !DEFAULT_OPEN_SECTIONS.includes(section.id),
).map((section) => section.id);

export function TrackVoiceRack({
  track,
  audible,
  collapsed,
  onCollapsedChange,
  collapsedSections = DEFAULT_COLLAPSED_SECTIONS,
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
   * Which of THIS track's stages are folded. The FOLDED set rather than the open
   * one so it cannot go stale when `paramSchema` gains a section: a name nobody
   * has heard of is open, which is the safe way round for a control surface.
   *
   * `undefined` is "nobody has folded this rack yet" and opens on
   * `DEFAULT_COLLAPSED_SECTIONS` — which is NOT the same as an empty list, and
   * the caller must keep the two apart: an empty list is a user who has unfolded
   * everything, and collapsing it back to `undefined` would re-fold two stages
   * under them on the next render.
   *
   * Reported up rather than kept here for the reason `collapsed` is: this
   * component is replaced on every mode switch and unmounted on every visit to
   * the pattern page, and a section that unfolds itself behind your back is the
   * same bug as a rack that does. It lives in `App`, beside `collapsedRacks`.
   */
  collapsedSections?: readonly SectionId[];
  onCollapsedSectionsChange?: (collapsed: readonly SectionId[]) => void;
}) {
  // Addressed by kind and id, never by the `Track` itself — see `voiceDrafts`'
  // header. The prop stays because this file reads the track's own fields
  // (`name`, `inputGainDb`) for chrome the draft store knows nothing about — and
  // those are the only things it is the authority for. The PRESET is resolved from
  // the composition store by id, so a prop a render behind the store cannot make
  // this rack draw a voice that is not the one playing.
  const preset = useVoiceWorkingPreset('track', track.id);
  const dirty = useVoiceDirty('track', track.id);
  const instrumentId = trackInstrumentId(track);
  const voices = useSelectableVoices(instrumentId);
  // A ref can name a variant that has been deleted, or one belonging to another
  // instrument; the seam refuses a Save into either rather than overwriting a voice
  // the user cannot see from where they are standing. Asked of the seam rather than
  // derived from `voices`, because the two failures are not the same sentence.
  const status = useTrackVoiceStatus(track);

  /** THIS rack's messages, and no other rack's. See the header: one channel, and
   *  it is local, because a refusal about the fifth track is unattributable at the
   *  top of the page. */
  const [notice, setNotice] = useState<string | null>(null);

  // Transient by design, and per rack: the state that must survive an unmount is
  // the draft, and that is in `voiceDrafts`. The hook is the shared one for its
  // focus-return, which is the half two copies would eventually disagree about.
  const {
    form: nameForm,
    setForm: setNameForm,
    open: openNameForm,
    close: closeNameForm,
  } = useNameForm();

  /**
   * The one mirror in this component, and it is a rate limiter rather than a
   * mirror of state — see {@link VOICE_COMMIT_MS}. `flush` holds the write the
   * timer is going to make, so a gesture that ends the window early (leaving the
   * field) commits instead of racing it. Modelled on `TrackControls`' picker,
   * which solved exactly this for exactly this control.
   */
  const [draftVoiceKey, setDraftVoiceKey] = useState<string | null>(null);
  const voiceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceFlush = useRef<((ask: boolean) => void) | null>(null);

  /**
   * Unmount is the one end with no gesture on it: a track removed, or the mode
   * switched, mid-window would otherwise drop the pick with nothing to notice.
   *
   * ⚠ THIS IS WHERE THIS RACK DIVERGES FROM `TrackControls`, which it is otherwise
   * modelled on. That picker's commit is confirm-free; this one asks before it
   * strands an unsaved edit, and a `window.confirm` raised during TEARDOWN has no
   * gesture behind it — after "Remove track" it would ask about a track that is
   * already gone, and then answer itself with a refusal into a notice line nobody
   * can read. So the flush is told not to ask (`false`), and a commit that WOULD
   * have asked drops the pick instead: the pick is one keystroke and the draft is
   * the work.
   */
  useEffect(
    () => () => {
      voiceFlush.current?.(false);
    },
    [],
  );

  // Unreachable: the grid only draws a rack for a track of the composition the
  // draft store resolves against. Guarded rather than asserted because the
  // alternative is a non-null assertion on a store lookup, and every hook above
  // has already run.
  if (!preset) return null;

  const toggleSection = (id: SectionId) =>
    onCollapsedSectionsChange?.(
      collapsedSections.includes(id)
        ? collapsedSections.filter((candidate) => candidate !== id)
        : [...collapsedSections, id],
    );

  // Generic in the payload: every seam here is called for its refusal, not its
  // value, but some of them CARRY one (the clamped level a fader was actually
  // given, say). Narrowing to `Result<void>` would refuse those at the type
  // level for a value this surface never reads.
  //
  // Cleared on success as well as set on failure: one line says everything this
  // rack has to say, so a refusal left standing beside a control that has since
  // worked would read as a refusal of THAT write. The composition and draft seams
  // both answer in sentences, so they are shown as they are; only the voice
  // WRITE seam answers in codes, and those go through `REFUSAL_TEXT` below.
  const report = (result: Result<unknown>) => setNotice(result.ok ? null : result.reason);

  const write = (path: string, value: unknown) =>
    report(setVoiceParam('track', track.id, path, value));

  const ref = readTrackVoiceRef(track);
  const currentKey = ref ? voiceKey(ref) : '';
  const isBuiltIn = ref === null || ref.kind === 'default';

  /** One confirmation in front of every switch that would throw the working copy
   *  away — and a pick really does throw it away (see `discard` in `commitVoice`),
   *  so this is the last chance to keep it. Named for the TRACK, because up to
   *  eight racks can ask and a bare "Discard unsaved changes?" would not say which.
   *  Routed through one function so replacing it with a real dialog is one edit. */
  const confirmDiscard = () =>
    // Read from the store rather than from `dirty`, which is this RENDER's answer:
    // the question is asked up to {@link VOICE_COMMIT_MS} after the render that
    // scheduled it, and Revert (or a Save) in between retires the draft. Asking
    // about an edit that no longer exists is the failure, and answering Cancel to
    // it would then drop a pick for nothing.
    !isVoiceDirty('track', track.id) ||
    window.confirm(`Discard unsaved changes to ${track.name}’s voice?`);

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
   * draft's tag STOP MATCHING, which is not the same as retiring it: `readVoiceDraft`
   * self-clears on a mismatch, but `useVoiceDirty` / `useVoiceWorkingPreset` compare
   * the tag WITHOUT deleting (a store write during render is a React error). Left
   * standing, the entry resurrects the moment the track is pointed back at the voice
   * it was taken from — and the user is then playing an edit they threw away.
   */
  const commitVoice = (key: string, ask = true) => {
    if (voiceTimer.current !== null) clearTimeout(voiceTimer.current);
    voiceTimer.current = null;
    voiceFlush.current = null;
    // The teardown path, which cannot ask (see the cleanup effect above). Before
    // any `setState`, so an unmounting rack writes nothing at all.
    if (!ask && isVoiceDirty('track', track.id)) return;
    // Dropped whatever the seam says: on `ok` the store re-renders this rack with
    // the value it took, and on a refusal — including a refused confirmation — the
    // control has to snap back to what the model actually holds.
    setDraftVoiceKey(null);

    // Re-read rather than taken from the render that scheduled this: the rail, the
    // header's own compact picker and the agent all write the same track, and
    // `currentKey` closed over above can be a window out of date — which would
    // write a pick the model has already taken, or skip one it has not.
    const live = findTrack(track.id);
    const liveRef = live ? readTrackVoiceRef(live) : null;
    const liveKey = liveRef ? voiceKey(liveRef) : '';

    // Already on it. The notice is cleared anyway: a refusal left standing beside a
    // choice the user just re-affirmed reads as a refusal of THAT pick.
    if (key === liveKey) {
      setNotice(null);
      return;
    }
    // Asked once per COMMIT rather than once per `change`: the window exists
    // precisely because a keyboard walk fires one `change` per option, and a
    // confirmation per arrow key is the same fetch storm in dialogs.
    if (!confirmDiscard()) return;
    setNameForm(null);

    // '' is the way back to the fallback, and it is a real choice rather than an
    // absence: a null ref puts the track on the instrument's global active voice,
    // which is the lib's documented meaning for one.
    if (key === '') {
      const result = selectVoice('track', track.id, null);
      report(result);
      if (result.ok) discard();
      return;
    }
    const next = parseVoiceKey(key);
    // Unreachable from these options — every value came from `voiceKey` — but the
    // seam refuses an unparseable ref and so must this, rather than writing null and
    // silently resetting the track to the fallback.
    if (!next) {
      setNotice(SHARED_VOICE_REFUSAL_TEXT['unknown-variant']);
      return;
    }
    const result = selectVoice('track', track.id, next);
    report(result);
    if (result.ok) discard();
  };

  const onVoiceChange = (key: string) => {
    setDraftVoiceKey(key);
    if (voiceTimer.current !== null) clearTimeout(voiceTimer.current);
    voiceFlush.current = (ask) => commitVoice(key, ask);
    voiceTimer.current = setTimeout(() => commitVoice(key), VOICE_COMMIT_MS);
  };

  const save = () => {
    const result = saveVoice('track', track.id, preset);
    if (!result.ok) {
      setNotice(REFUSAL_TEXT[result.reason]);
      return;
    }
    setNotice(null);
    // The variant now holds what the draft held. Left standing, the draft would keep
    // this strip reading "Unsaved" against a voice that already matches it, and would
    // keep the engine building from a copy nothing can reach.
    discard();
  };

  const submitName = () => {
    if (!nameForm) return;
    const trimmed = nameForm.value.trim();

    if (nameForm.mode === 'save-as') {
      const result = saveVoiceAs('track', track.id, trimmed, preset);
      if (!result.ok) {
        setNotice(REFUSAL_TEXT[result.reason]);
        return;
      }
      setNotice(null);
      closeNameForm();
      // `saveVoiceAs` has already repointed the track, which retires the draft by tag
      // on its own; this is what tells the engine to go and rebuild from the variant
      // rather than from the copy it was made out of.
      discard();
      return;
    }

    // Near-unreachable — Rename is disabled unless the track is on a user variant —
    // but this is the one place here that could swallow a failure, and a form that
    // sits open saying nothing is the thing this rack would be blamed for.
    if (ref?.kind !== 'user') {
      setNotice(REFUSAL_TEXT['built-in']);
      return;
    }
    const renamed = renameVoice(ref.id, trimmed);
    if (!renamed.ok) {
      setNotice(REFUSAL_TEXT[renamed.reason]);
      return;
    }
    // The draft carries the OLD name and `saveVoice` writes the record's name back
    // from `preset.name`, so without this the next Save would silently undo the
    // rename. A no-op when there is no draft.
    report(setVoiceName('track', track.id, trimmed));
    closeNameForm();
  };

  const remove = () => {
    if (ref?.kind !== 'user') return;
    // ONE dialog, not two. Deleting the variant also strands this track's unsaved
    // edit — a pick asks about exactly that on the same screen, and asking twice in a
    // row is how people learn to click through confirmations — so the loss is named
    // in the sentence that is already being read.
    //
    // THE TRACK IS NAMED TOO, and the variant's name is not enough on its own: two
    // tracks can legitimately sit on one shared variant, which is exactly the case
    // this file insists elsewhere is normal, and then the name says nothing about
    // which of eight racks asked.
    const consequence = dirty
      ? 'Your unsaved edits to it go too, and any pattern or track using it falls back to a built-in voice.'
      : 'Any pattern or track using it falls back to a built-in voice.';
    if (!window.confirm(`Delete “${preset.name}”, ${track.name}’s voice? ${consequence}`)) return;

    // ONE seam call, because it is one act: the seam destroys the variant and repairs
    // this track's dangling ref itself, which is what `'track'` buys — under
    // `'pattern'` the same call would fix the open pattern and leave this track
    // resolving silently to a built-in. The button must not do more than the function.
    const result = deleteVoice('track', track.id, ref.id);
    if (!result.ok) {
      setNotice(REFUSAL_TEXT[result.reason]);
      return;
    }
    setNameForm(null);
    setNotice(null);
    discard();
  };

  /**
   * The same `SliderParam`, drawn as a rotary instead of a row — `VoicePane`'s
   * `renderKnob`, unchanged in substance. Every number still comes from the
   * descriptor, including `fallback` as the double-click reset, so nothing about
   * an amp's ranges is known to this file.
   */
  const renderKnob = (param: SliderParam, size: number, nameScope?: string) => {
    const raw = getAtPath(preset, param.path);
    return (
      <Knob
        key={param.path}
        label={param.label}
        // See `renderParam`: a sub-branch's rows share their labels with the
        // primary's, and the group around them does not name them.
        ariaLabel={nameScope ? `${nameScope} ${param.label}` : undefined}
        size={size}
        value={typeof raw === 'number' ? raw : param.fallback}
        min={param.min}
        max={param.max}
        step={param.step}
        defaultValue={param.fallback}
        formatValue={(v) =>
          `${v.toFixed(param.precision)}${param.unit ? ` ${param.unit}` : ''}`
        }
        onChange={(value) => write(param.path, value)}
      />
    );
  };

  /**
   * One row of the table. `nameScope` prefixes the ACCESSIBLE name of a
   * sub-branch's rows — the same override, for the same reason, that
   * `VoicePane.renderParam` documents: the layer's rows are the primary's
   * descriptors generated under a second branch, so "Harmonicity" appears twice
   * inside one stage, and the enclosing `role="group"` does not contribute its
   * name to a descendant's. The landmark name handles the OTHER axis (which of
   * eight racks); this one handles which branch inside a stage.
   */
  const renderParam = (section: ParamStage, param: Param, nameScope?: string) => {
    const raw = getAtPath(preset, param.path);
    const id = domId(track.id, param.path);
    const scoped = (label: string) => (nameScope ? `${nameScope} ${label}` : undefined);

    switch (param.kind) {
      case 'toggle':
        return (
          <ParamToggle
            key={param.path}
            id={id}
            label={param.label}
            // Every stage's bypass is labelled "Enabled" and there are up to
            // eight racks of them, so the name carries the track and the stage
            // while the visible label stays inside a 74 px column.
            ariaLabel={scoped(param.label) ?? `${track.name} ${section.label} ${param.label}`}
            value={typeof raw === 'boolean' ? raw : param.fallback}
            onChange={(value) => write(param.path, value)}
          />
        );

      case 'enum':
        return (
          <ParamEnum
            key={param.path}
            id={id}
            label={param.label}
            ariaLabel={scoped(param.label)}
            value={param.resolve(raw)}
            options={param.options}
            badgeOf={param.badgeOf}
            mod={param.mod}
            onChange={(value) => write(param.path, value)}
          />
        );

      case 'encoder':
        // No `id` for the same reason `Knob` has none: `ParamEncoder` names
        // itself through `aria-labelledby`, so there is no `<label htmlFor>`.
        return (
          <ParamEncoder
            key={param.path}
            label={param.label}
            ariaLabel={scoped(param.label)}
            size={SMALL_KNOB_PX}
            value={typeof raw === 'number' ? raw : param.fallback}
            step={param.step}
            precision={param.precision}
            unit={param.unit}
            fallback={param.fallback}
            onChange={(value) => write(param.path, value)}
          />
        );

      case 'source-kind':
        return (
          <ParamEnum
            key={param.path}
            id={id}
            label={param.label}
            value={param.resolve(raw)}
            options={param.options}
            // Not the default placeholder ("Not in the registry"): there is no
            // registry of source kinds to be missing from — an unrecognised
            // discriminant is a stored variant this build cannot play.
            placeholder="Unrecognised source"
            // The seam does the branch swap — writing the discriminant alone
            // would leave a sampler's banks beside an FM tag. See
            // `sourceDefaults.withSourceKind`.
            //
            // NO PREFETCH HERE, unlike `VoicePane`, and it is the rack's existing
            // policy rather than an oversight: the pack picker two rows down does
            // not warm either, and neither does the voice picker this file's own
            // header now draws. The pattern page's `warmSampleBanks` is a rate
            // adapter for a `<select>` that fires per arrow key
            // (`docs/FOLLOW-UPS.md`, permanent-adapter table); the composition
            // path's equivalent is `VOICE_COMMIT_MS` in `voiceChrome`, and a
            // source change goes through `scheduleTrackVoiceRebuild`, which is
            // where a warm would belong so both writes get one. Cost: the first
            // Play after switching a track to samples waits on the banks.
            onChange={(value) => write(param.path, value)}
          />
        );

      case 'sample-pack': {
        // A preset stores note→URL maps rather than a pack id, so the active
        // entry is found by deep shape; `null` is a hand-authored map matching
        // no registered pack, which the picker admits rather than papering over.
        const banks = Array.isArray(raw)
          ? (raw as ReadonlyArray<Readonly<Record<string, string>>>)
          : null;
        const active = banks ? detectSamplePack(banks) : null;
        return (
          <ParamEnum
            key={param.path}
            id={id}
            label={param.label}
            value={active?.id ?? null}
            placeholder="Custom sample map"
            options={param.options.map((option) => ({
              value: option.id,
              label: option.label,
              description: option.description,
            }))}
            // The seam takes the PACK ID and resolves the maps itself, so the
            // agent addresses a registry entry rather than authoring a sample
            // map. `getSamplePack` is consulted here only to refuse early on an
            // id the registry lost between render and change.
            onChange={(packId) =>
              getSamplePack(packId)
                ? write(param.path, packId)
                : setNotice('That sample pack is no longer registered.')
            }
          />
        );
      }

      case 'slider':
        // Every slider in this table is drawn as a knob here — the lane is a
        // rack face, and a 74 px label plus a 52 px readout per row is the pane
        // layout, not the rack one.
        return renderKnob(param, SMALL_KNOB_PX, nameScope);
    }
  };

  /**
   * The Level stage, where the track's own input gain replaces the preset's.
   *
   * `inputGainDb` exists in two places and they are NOT both shown here. The
   * preset carries one, and it is the wrong one to put on a track: a preset is
   * chosen and swapped, so an input level stored there is thrown away every time
   * the user auditions a different amp — which is the complaint this whole
   * ticket came from. The TRACK's value overrides it and survives the swap, so
   * this surface shows the track's and hides the preset's rather than offering
   * two sliders that fight over one job.
   *
   * The pattern page still shows the preset's, because a pattern has no track to
   * hold one. Same schema, different surface — which is why this filters here
   * rather than removing the param from `paramSchema`.
   */
  const renderLevel = (section: ParamSection) => (
    <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
      <Knob
        label="Input"
        size={SMALL_KNOB_PX}
        // `?? 0` reads an untouched track as unity. Note the STORED value stays
        // undefined until the knob is turned — see `Track.inputGainDb`, where
        // undefined means "the preset decides" and 0 means "unity regardless".
        value={track.inputGainDb ?? 0}
        min={TRACK_INPUT_GAIN_RANGE_DB.min}
        max={TRACK_INPUT_GAIN_RANGE_DB.max}
        step={0.5}
        defaultValue={0}
        formatValue={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`}
        onChange={(value) => report(setTrackInputGainDb(track.id, value))}
      />
      {/* `ownParams` for the reason `renderAmp` states. */}
      {ownParams(preset, section)
        .filter((param) => param.path !== 'inputGainDb')
        .map((param) => renderParam(section, param))}
    </div>
  );

  /**
   * The pedalboard, as one stage holding six.
   *
   * The composition page's counterpart of `VoicePane.renderPedalsSection`, and it
   * exists for the reason every other renderer here has a twin: BOTH surfaces
   * draw `PARAM_SECTIONS`, so a section without a renderer on this side falls
   * into the generic branch and dumps all thirty-eight pedal rows flat, with no
   * way to tell which pedal a "Mix" belongs to and no way to add or remove one.
   * That is the exact drift `DEFAULT_OPEN_SECTIONS` was hoisted out of the two
   * panes to prevent.
   *
   * Tighter than the pattern pane's — a hairline rule and a name rather than a
   * tray, matching this file's sub-branch — because up to eight of these are on
   * screen at once and the rack's chrome is already doing the separating.
   */
  const renderPedals = () => (
    <div className="flex w-full flex-col gap-1">
      {PEDALS.map((pedal) => {
        const present = sectionPresence(preset, pedal) !== 'absent';

        return (
          <div
            key={pedal.id}
            role="group"
            // Track first, for the reason the `RackFace` landmark states: that is
            // the axis a listener navigating eight racks is moving along.
            aria-label={`${track.name} ${pedal.label}`}
            className="flex flex-wrap items-start gap-x-2 gap-y-1 border-t border-ink-mut/20 pt-1"
          >
            <div className="flex w-full items-center gap-1.5">
              <span className="font-mono text-[8px] tracking-[0.1em] text-ink-mut uppercase">
                {pedal.label}
              </span>
              {/* No bypassed note — the pedal's own `Enabled` switch says it, and a
                  pedal card does not fold. See `VoicePane.renderPedalsSection`. */}
              <span className="flex-1" />
              <button
                type="button"
                // Eight racks × six pedals, every button saying "Add" — the name
                // carries the track and the pedal, as the stage's and the
                // sub-branch's do.
                aria-label={`${present ? 'Remove' : 'Add'} ${pedal.label} for ${track.name}`}
                onClick={() =>
                  report(
                    present
                      ? removeVoicePedal('track', track.id, pedal.id)
                      : addVoicePedal('track', track.id, pedal.id),
                  )
                }
                className={buttonClass}
              >
                {present ? 'Remove' : 'Add'}
              </button>
            </div>
            {present
              ? visibleParams(preset, pedal).map((param) =>
                  renderParam(pedal, param, `${track.name} ${pedal.label}`),
                )
              : null}
          </div>
        );
      })}
    </div>
  );

  const stageActions = (section: ParamSection, present: boolean) =>
    section.removableBranch ? (
      <button
        type="button"
        // Up to eight racks × two removable stages, so the name carries both.
        aria-label={`${present ? 'Remove' : 'Add'} ${section.label} for ${track.name}`}
        onClick={() =>
          report(
            present
              ? removeVoiceSection('track', track.id, section.id)
              : addVoiceSection('track', track.id, section.id),
          )
        }
        className={buttonClass}
      >
        {present ? 'Remove' : 'Add'}
      </button>
    ) : null;

  /** The amp, as an amp: knobs on the plate, bypass as the power switch, the
   *  model the chain would really build engraved on the face. Split by `kind`,
   *  so a slider the schema gains appears as a knob without touching this. */
  const renderAmp = (section: ParamSection) => {
    // `ownParams`, not `visibleParams`: `renderSubBranch` runs after every stage
    // body, so a renderer asking for all the visible rows would draw a sub-branch's
    // rows twice the day this stage gains one.
    const rows = ownParams(preset, section);
    const power = enabledParamOf(section);
    const enabled = power ? getAtPath(preset, power.path) !== false : true;
    const rawModel = getAtPath(preset, 'effects.amp.modelId');
    return (
      <>
        <AmpHead
          model={getAmpModel(typeof rawModel === 'string' ? rawModel : undefined).name}
          enabled={enabled}
          power={
            power
              ? {
                  label: `${track.name} ${section.label} ${power.label}`,
                  onChange: (next) => write(power.path, next),
                }
              : undefined
          }
        >
          {rows
            .filter((param): param is SliderParam => param.kind === 'slider')
            .map((param) => renderKnob(param, AMP_KNOB_PX))}
        </AmpHead>
        {rows
          .filter((param) => param.kind !== 'slider' && param !== power)
          .map((param) => renderParam(section, param))}
      </>
    );
  };

  /** The cabinet, as a cabinet. The mic dot picks the IR; the schema's `<select>`
   *  stays as the text-level route to the same value and as the only place the
   *  registry's description of a capture is readable.
   *
   *  BESIDE THE GRAPHIC, NOT UNDER IT — still, though the reason has changed.
   *  CP-14 needed it because a fixed lane height had no room for another ~50 px
   *  and the IR picker fell below the fold; CP-16 deleted that height, so the
   *  row would simply grow. It stays because the column beside a 200 px square
   *  is otherwise empty, and a stage that is as tall as its own graphic reads as
   *  one piece of gear rather than as a picture with a form under it. */
  const renderCabinet = (section: ParamSection) => {
    // `ownParams` for the reason `renderAmp` states.
    const rows = ownParams(preset, section);
    const cab = rows.find(
      (param): param is EnumParam => param.kind === 'enum' && param.path === CAB_URL_PATH,
    );
    return (
      <div className="flex flex-wrap items-start gap-1.5">
        {cab ? (
          <CabinetGraphic
            url={cab.resolve(getAtPath(preset, cab.path))}
            onChange={(url) => write(cab.path, url)}
            bypassed={sectionPresence(preset, section) === 'bypassed'}
          />
        ) : null}
        <div className="flex min-w-[190px] flex-1 flex-col gap-1">
          {rows
            .filter((param): param is SliderParam => param.kind === 'slider')
            .map((param) => renderKnob(param, SMALL_KNOB_PX))}
          {/* The cabinet `<select>` is deliberately still here alongside the
              dot: it is the text-level route to the same value and the only
              place the registry's description of a capture can be read. */}
          {rows
            .filter((param) => param.kind !== 'slider')
            .map((param) => renderParam(section, param))}
        </div>
      </div>
    );
  };

  /**
   * The sub-branch's source picker — the second source's kind.
   *
   * NOT `renderParam`'s `source-kind` case, and the difference is the write:
   * that one routes through `setVoiceParam`, which resolves a `source-kind`
   * row with `withSourceKind` — a function that takes no path and always
   * replaces the PRIMARY source. `setVoiceSubBranchKind` is the
   * branch-aware seam, and it is why the layer's picker is declared on
   * `ParamSubBranch.kindRow` rather than in `section.params`.
   */
  const renderSubBranchKind = (row: SourceKindParam, sub: ParamSubBranch) => (
    <ParamEnum
      key={row.path}
      id={domId(track.id, row.path)}
      label={row.label}
      // "Source" names the primary's picker too, and both live in this stage.
      ariaLabel={`${track.name} ${sub.label} ${row.label}`}
      value={row.resolve(getAtPath(preset, row.path))}
      options={row.options}
      // A stored kind the picker does not offer resolves fine and simply has no
      // option — see `LAYER_SOURCE_KIND_OPTIONS` for which kinds and why.
      placeholder="Not offered here"
      onChange={(value) => report(setVoiceSubBranchKind('track', track.id, sub.id, value))}
    />
  );

  /**
   * A stage's nested optional branch — the second source, the cutoff envelope.
   *
   * Rendered as a named group, which carries the CONTAINMENT; the rows' own
   * names carry which branch they belong to (`renderParam`'s `nameScope`),
   * because a group's accessible name is announced on entry and does not fold
   * into a descendant's. Here the group also nests inside the `RackFace`
   * landmark, so a listener gets the track, the stage, then the group.
   *
   * Add and Remove are drawn whether or not the branch is there, exactly as the
   * stage buttons are: `addVoiceSubBranch` / `removeVoiceSubBranch`
   * are the seams for it, so neither button is a refusal waiting to happen.
   */
  const renderSubBranch = (section: ParamSection) => {
    const sub = section.subBranch;
    if (!sub) return null;
    const present = subBranchApplies(preset, sub);
    return (
      <div
        role="group"
        aria-label={`${track.name} ${sub.label}`}
        className="flex flex-wrap items-start gap-x-2 gap-y-1 border-t border-ink-mut/20 pt-1"
      >
        <div className="flex w-full items-center gap-1.5">
          <span className="font-mono text-[8px] tracking-[0.1em] text-ink-mut uppercase">
            {sub.label}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            // Up to eight racks, two sub-branches, and every button says "Add" —
            // the name carries the track and the branch, as the stage's does.
            aria-label={`${present ? 'Remove' : 'Add'} ${sub.label} for ${track.name}`}
            onClick={() =>
              report(
                present
                  ? removeVoiceSubBranch('track', track.id, sub.id)
                  : addVoiceSubBranch('track', track.id, sub.id),
              )
            }
            className={buttonClass}
          >
            {present ? 'Remove' : 'Add'}
          </button>
        </div>
        {present ? (
          <>
            {sub.kindRow ? renderSubBranchKind(sub.kindRow, sub) : null}
            {branchParams(preset, section).map((param) =>
              renderParam(section, param, `${track.name} ${sub.label}`),
            )}
          </>
        ) : null}
      </div>
    );
  };

  const renderStage = (section: ParamSection) => {
    const presence = sectionPresence(preset, section);
    const open = !collapsedSections.includes(section.id);
    return (
      <Section
        key={section.id}
        label={section.label}
        // Deliberately NOT the landmark's name, and deliberately not the rack's
        // either: three things are foldable on this page and they have to be
        // tellable apart by name alone — "Voice rack for Lead" is the whole
        // rack, this is one stage of it, and the region it controls is
        // "Lead Amp".
        buttonLabel={`${section.label} stage for ${track.name}`}
        open={open}
        onToggle={() => toggleSection(section.id)}
        actions={stageActions(section, presence !== 'absent')}
        bodyClassName="flex flex-col gap-1 px-1.5 py-1"
        chassis={(parts) => (
          <RackFace
            // The landmark name is what disambiguates eight racks' identically
            // named controls — see the banner. Track first, because that is the
            // axis a listener is navigating.
            regionName={`${track.name} ${section.label}`}
            // The chassis owns the material, and this one's engraved names are
            // muted where the pattern pane's are not.
            name={<span className="text-ink-mut">{parts.name}</span>}
            note={presence === 'bypassed' ? 'Bypassed' : null}
            lit={presence === 'active'}
            actions={parts.actions}
          >
            {parts.region}
          </RackFace>
        )}
      >
        {presence === 'absent' ? (
          /* Only a removable stage can be absent: Source and Level both have a
             null probe, so they apply to every preset there is. */
          <p className="max-w-[26ch] font-mono text-[8.5px] leading-snug text-ink-mut">
            {`No ${section.label.toLowerCase()} stage on this voice.`}
          </p>
        ) : section.id === 'amp' ? (
          renderAmp(section)
        ) : section.id === 'cabinet' ? (
          renderCabinet(section)
        ) : section.id === 'level' ? (
          renderLevel(section)
        ) : section.id === 'pedals' ? (
          renderPedals()
        ) : (
          <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
            {ownParams(preset, section).map((param) => renderParam(section, param))}
          </div>
        )}
        {presence !== 'absent' ? renderSubBranch(section) : null}
      </Section>
    );
  };

  return (
    // Normal flow, no height of its own: the ROW is as tall as this is (CP-16),
    // rather than this being clipped or scrolled inside a computed lane.
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
        {/* `RackFace`'s own lamp, so the strip and the four faceplates below it
            cannot drift apart. It says what will be HEARD, which on a mixer is
            the only honest reading of one: mute wins, and a solo elsewhere
            silences this. */}
        <PowerLamp lit={audible} />
        <span className="min-w-0 truncate font-mono text-[8.5px] tracking-[0.06em] text-ink-mut">
          {preset.name}
        </span>
        {/* The shared pill, which is the one the pattern page also draws — brass
            marks unsaved, the way it marks every other live state here, and it is
            announced rather than only coloured because an edit that exists only as
            a colour is one a user cannot confirm they made. */}
        <DirtyPill dirty={dirty} />
        <span className="flex-1" />
        {dirty && (
          <button
            type="button"
            aria-label={`Discard voice changes for ${track.name}`}
            title="Put this track back on its stored voice"
            onClick={() => report(discardVoiceDraft('track', track.id))}
            className={buttonClass}
          >
            Revert
          </button>
        )}
      </div>

      {/* ---- what can be done to the voice this track is on ------------------
          Beside the knobs, which is the whole of this step: the strip used to name
          the right-hand rail here and send you to another part of the screen for
          the one button that keeps what you just did. Revert stays above, where it
          always was — the discard belongs with the edit, and so, now, does the
          save.

          NOT FOLDED WITH THE STAGES, deliberately: the disclosure hides the
          TUNING, and which voice a track is on, whether it has an unsaved edit and
          what saving it would overwrite are exactly what you fold eight racks down
          to compare. The live region below also has to stay mounted to be
          announced at all.

          THE ONE EXCEPTION IS THE PARAGRAPH, which folds — it is a permanent
          explanation rather than a state, and eight folded racks each carrying
          "This track follows its instrument's voice" is the density folding was
          meant to remove. It comes back for a rack with an UNSAVED EDIT whatever
          is folded, because that is the only state in which Save can do anything
          and the overwrite sentence has to travel with a usable button. */}
      <div className="flex flex-none flex-wrap items-center gap-1">
        {/* ⚠ ADDRESSES THIS TRACK, not the selected one. The rail's list picks for
            whichever track is SELECTED and this picks for the track whose rack it
            is in; both are on screen at once, which is why the rail's heading names
            its track and this one's label names its own.

            `'track'` at every call: under `'pattern'` the same seam would retune
            whatever pattern is open and change no track at all — which, with one
            track on the fallback, can even look like it worked. */}
        <select
          aria-label={`${track.name} voice`}
          // Distinct from `TrackControls`' picker for the same track, whose name is
          // "Voice for <track>": both can be on screen in voice mode, and two
          // comboboxes with one name is a query — a user's or a test's — that
          // cannot say which it reached.
          value={draftVoiceKey ?? currentKey}
          onChange={(event) => onVoiceChange(event.target.value)}
          // Leaving the field ends the coalescing window early. Without it a pick
          // made with the keyboard and then tabbed away from would sit for
          // {@link VOICE_COMMIT_MS} looking committed and not being.
          onBlur={() => voiceFlush.current?.(true)}
          className="control min-w-0 max-w-[16rem] flex-1 rounded-md px-1 py-0.5 font-mono text-[8.5px] font-bold text-ink"
        >
          {/* Disabled, because it is a fact rather than a choice — and present at
              all so the control can say WHY it is showing a voice the list below
              does not contain. The two failures are named apart: one is a variant
              that is gone, the other one that exists and is for another neck. */}
          {status === 'deleted' && (
            <option value={currentKey} disabled>
              Voice deleted
            </option>
          )}
          {status === 'wrong-instrument' && (
            <option value={currentKey} disabled>
              Another instrument’s voice
            </option>
          )}
          {/* Not "none": a null ref plays something, it just isn't this track's
              choice. Listed first so the way back is always in the same place. */}
          <option value="">Auto — follows the instrument</option>
          {/* Guarded rather than always drawn: an instrument the lib ships no
              voices for would otherwise get an empty group with a heading. */}
          {voices.builtIns.length > 0 && (
            <optgroup label="Presets">
              {voices.builtIns.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.name}
                </option>
              ))}
            </optgroup>
          )}
          {voices.userVariants.length > 0 && (
            <optgroup label="My tones">
              {voices.userVariants.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <span className="flex-1" />
        {/* Named for the track, because eight racks put eight buttons called
            "Save" on one page and the visible word cannot carry the axis. */}
        <button
          type="button"
          aria-label={`Save ${track.name}’s voice`}
          onClick={save}
          // The rail's guard, which is the stricter of the two that existed: a ref
          // can name a deleted variant or one belonging to another instrument, and
          // the seam refuses both rather than overwriting a voice the user cannot
          // see from where they are standing. The seam refuses independently of
          // this attribute, in all three cases — this is a mirror of the rule, not
          // the rule.
          disabled={!dirty || isBuiltIn || status !== 'ok'}
          className={buttonClass}
        >
          Save
        </button>
        <button
          type="button"
          aria-label={`Save ${track.name}’s voice as a new voice`}
          onClick={openNameForm('save-as', `${preset.name} copy`)}
          className={buttonClass}
        >
          Save as…
        </button>
        <button
          type="button"
          aria-label={`Rename ${track.name}’s voice`}
          onClick={openNameForm('rename', preset.name)}
          // Renaming WHILE DIRTY is fine: the draft carries the old name and
          // `saveVoice` writes the record's name back from `preset.name`, so a
          // rename used to be silently undone by the next Save.
          // `voiceDrafts.setVoiceName` patches the draft, which is the write that
          // made this button safe to leave enabled.
          disabled={isBuiltIn}
          className={buttonClass}
        >
          Rename
        </button>
        <button
          type="button"
          aria-label={`Delete ${track.name}’s voice`}
          onClick={remove}
          // Save's guard, for Save's reason and one of its own: `preset` has already
          // fallen back to a built-in when the ref names a variant that is gone, so
          // a live Delete here would ask about — and name — a voice that is not the
          // one the ref points at. The sentence under the buttons says why.
          disabled={isBuiltIn || status !== 'ok'}
          className={buttonClass}
        >
          Delete
        </button>
      </div>

      {/* Said BEFORE the button is pressed, not after: a voice is a SHARED asset
          and Save retunes every holder of it. That is settled behaviour rather
          than a bug — there is deliberately no per-track fork — and it travels
          with the button rather than being left behind in the rail, which is why
          it can now appear eight times on one screen. Accepted: the sentence is
          the price of the button being where the knobs are. */}
      {(!collapsed || dirty) && (
        <p className="flex-none font-mono text-[8.5px] leading-relaxed text-ink-mut">
          {/* Why Save is refused, stated where the refusal is — a disabled button
              with no reason is what this rack would be most blamed for. */}
          {isBuiltIn
            ? ref === null
              ? REFUSAL_TEXT['no-voice']
              : REFUSAL_TEXT['built-in']
            : status === 'wrong-instrument'
              ? // NOT the shared `unknown-variant` sentence, which the seam collapses
                // this into and which would read as a contradiction of the `<option>`
                // right above it ("Another instrument's voice"). The seam's code is
                // one; what a reader has to be told is two different things.
                'That voice belongs to another instrument.'
              : status !== 'ok'
                ? REFUSAL_TEXT['unknown-variant']
                : // The one case where there IS something to save into — and where the
                  // consequence has to be said before the button is pressed.
                  `Saving overwrites “${preset.name}” everywhere it is used — every pattern and every other track on it.`}
        </p>
      )}

      {nameForm && (
        <NameForm
          form={nameForm}
          // Per TRACK, through the same helper every other id here goes through:
          // eight racks would otherwise mint eight inputs with one id, and a
          // `<label htmlFor>` resolves to whichever mounted first.
          inputId={domId(track.id, 'name')}
          onChange={(value) => setNameForm({ ...nameForm, value })}
          onSubmit={submitName}
          onCancel={closeNameForm}
        />
      )}

      {/* Mounted always, `sr-only` when empty: a live region has to exist BEFORE
          its content changes to be announced, and sr-only costs no layout. Named
          for the track, because eight live regions saying "That voice is no longer
          in your library" are eight statements about eight different voices. */}
      <p
        role="status"
        aria-label={`${track.name} voice messages`}
        className={
          notice
            ? 'flex-none rounded-md border border-brass/50 px-2 py-1.5 font-mono text-[9px] leading-relaxed text-ink'
            : 'sr-only'
        }
      >
        {notice}
      </p>

      {!collapsed && (
        // Stacked, and nothing scrolls here: `VoicePane.tsx`'s arrangement of
        // the same four stages, for the same reason it gives — a rack is as tall
        // as it is, and what scrolls is the surface holding the racks.
        <div className="flex flex-col gap-1.5">{PARAM_SECTIONS.map(renderStage)}</div>
      )}
    </div>
  );
}
