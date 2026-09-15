/**
 * THE voice editor — one component, both pages.
 *
 * `paramSchema` is the editor as data and this is the only thing that renders it.
 * Until CP-18 there were two: `VoicePane` on the pattern page and
 * `TrackVoiceRack` on the composition page, drawing the same `PARAM_SECTIONS`
 * through twin `renderParam` / `renderKnob` / `renderAmp` / `renderCabinet` /
 * `renderPedals` / `renderSubBranch` functions. The rule that came with that —
 * "a section with a custom renderer needs one on both sides" — is what this file
 * deletes. There is now exactly one of each renderer.
 *
 * ── The rack is the base, and the pane is an instance of it ──────────────────
 *
 * Built from `TrackVoiceRack`'s body: its knob vocabulary (every `SliderParam`
 * is a `Knob`, and the labelled range row that drew them here is deleted), its
 * `RackFace`
 * stages, its terse absent-stage sentence, its silence-plus-lamp in place of the
 * pane's "Not on this preset", its holder-scoped DOM ids and its one button
 * skin. What the pattern page kept is what is not the voice: its instrument
 * `<select>` and its "no pattern open" state, both in `VoicePane`'s own chrome
 * above this.
 *
 * ── What the two surfaces still differ in, and how ───────────────────────────
 *
 * Every difference is a PROP, so a renderer never asks which page it is on:
 *
 *   `scope`        the accessible-name scope. Up to eight racks are on screen at
 *                  once and the TRACK is what tells eight "Drive" knobs apart;
 *                  the pattern page has one holder, so its scope is null and the
 *                  visible engraving names the control. Same prop, no branch.
 *   `scale`        knob diameters — see {@link KnobScale}. Decided by the WIDTH
 *                  the editor is given, not by the file it is in.
 *   `refusals`     the sentences. One state, two true wordings: this pane says
 *                  "No pattern is open", a rack says "That track is no longer in
 *                  this composition". Each wrapper declares a complete `Record`,
 *                  which is what makes a new refusal a compile error in both
 *                  rather than a missing sentence in one.
 *   `follow` /     what the picker says about a ref it cannot offer, and whether
 *   `unavailable`  "no voice of its own" is a CHOICE. It is for a track
 *                  (`selectVoice(… , null)` puts it back on the instrument's
 *                  active variant) and deliberately not for a pattern — the
 *                  global `activeVariants` map is shared by every pattern
 *                  without a ref, so there is no clear-the-ref write to offer.
 *   `onRepointed`  `playbackService.refreshVoice`, or null. The PATTERN arm of
 *                  `selectVoice` requires it and the TRACK arm must never make
 *                  it (`voiceService`'s header, point 3). A prop rather than a
 *                  branch, and required rather than optional, so a third holder
 *                  kind has to answer the question rather than inherit silence.
 *   `wheel`        what a wheel notch over a dial MEANS here — see
 *                  {@link WheelPolicy}. Decided by what the editor is mounted
 *                  INSIDE, which is why it cannot be read off `kind`: the pane
 *                  sits in a page that does not scroll under the cursor, a rack
 *                  sits in the arrangement's own scroller, and a wheel there is
 *                  someone reaching for track five. Required for `onRepointed`'s
 *                  reason — a third surface has to answer it.
 *
 * ⚠ THE ONE BRANCH ON `kind` IS THE LEVEL STAGE, and it is in `renderLevel`
 * alone — see the comment there. It is irreducible: it reads `track.inputGainDb`
 * and writes `setTrackInputGainDb`, a composition-seam call with no pattern
 * equivalent. That is also why this file, alone among `src/voice`'s components,
 * imports the composition seam.
 *
 * ── Where the edits go ───────────────────────────────────────────────────────
 *
 * Not into the voice store. They accumulate in `voiceDrafts`, keyed
 * `pattern:<id>` / `track:<id>`, which lives above every component because both
 * surfaces unmount (a collapsed pane's body, and every visit to the pattern
 * page) — and because a knob has to be a way of CALLING a capability the agent
 * can call by kind, id and value. Every write here is one seam call whose
 * refusal is rendered rather than swallowed.
 *
 * ⚠ THE SEAM READS THE DRAFT FRESH INSIDE THE CALL, and nothing here may
 * re-introduce a handler that closes over the rendered preset. `Knob` and
 * `CabinetGraphic` register their drag listeners on `window` at pointerdown and
 * run the whole gesture against what they captured then, so a handler built from
 * `preset` would drop the edit that drags away from a value and back
 * (`setAtPath` returns the same object for a write that changes nothing). Every
 * handler passes a PATH and a VALUE.
 *
 * ── Eight of everything ──────────────────────────────────────────────────────
 *
 * DOM ids, the name form's input id, both `window.confirm` questions, the live
 * region and the sample-bank warm are all keyed by holder: this code used to
 * render once on the pattern page and now renders up to eight times beside it.
 * The warm in particular was module-level singleton state, and two racks
 * touching their pack pickers dropped one of the two warms; it lives in
 * `sampleWarm.ts` now, keyed, with a reset the tests can call.
 */
import { useEffect, useRef, useState } from 'react';
import {
  detectSamplePack,
  getAmpModel,
  getCabinetIR,
  getSamplePack,
  type FretInstrumentId,
  type VariantRef,
} from '@fretwork/lib';
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
} from './paramSchema';
import { getAtPath } from './presetPaths';
import { warmSampleBanks, type Banks } from './sampleWarm';
import { isSourceKind, withSourceKind } from './sourceDefaults';
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
} from './voiceDrafts';
import {
  deleteVoice,
  parseVoiceKey,
  renameVoice,
  saveVoice,
  saveVoiceAs,
  selectVoice,
  useSelectableVoices,
  voiceKey,
  type HolderKind,
  type VoiceRefusal,
} from './voiceService';
import {
  SHARED_VOICE_REFUSAL_TEXT,
  useNameForm,
  voiceLabelClass,
  VOICE_COMMIT_MS,
  type KnobScale,
  type WheelPolicy,
} from './voiceChrome';
import { DirtyPill } from './DirtyPill';
import { NameForm } from './NameForm';
import { VoiceSection } from './VoiceSection';
import { AmpHead } from './rack/AmpHead';
import { CabinetGraphic } from './rack/CabinetGraphic';
import { Knob } from './controls/Knob';
import { ParamEnum } from './controls/ParamEnum';
import { ParamToggle } from './controls/ParamToggle';
import { ParamEncoder } from './controls/ParamEncoder';
// ⚠ The one import of the composition seam by a component in `src/voice`, and it
// is the Level stage's (see `renderLevel`). `voiceService` and `voiceDrafts`
// already depend on this module for the track arm of every write, so this adds a
// user rather than a direction.
import {
  setTrackInputGainDb,
  TRACK_INPUT_GAIN_RANGE_DB,
  useTracks,
  type Result,
} from '../composition/compositionService';

/** The cabinet's URL, which is the one path this file names by hand — the mic
 *  dot writes it, and the descriptor beside it is what resolves it. */
const CAB_URL_PATH = 'effects.cabIR.url';

/** The amp model, read by "Use suggested cab" — the other hand-named path, and
 *  for the same reason: it is the one control that reads one section and writes
 *  another. */
const AMP_MODEL_PATH = 'effects.amp.modelId';

/** `id` on an input, `htmlFor` on its label. Scoped by HOLDER as well as by
 *  path: eight racks would otherwise mint eight elements with the same `id`, and
 *  a `<label htmlFor>` resolves to whichever mounted first. */
const domId = (kind: HolderKind, id: string, path: string) =>
  `voice-${kind}-${id}-${path.replaceAll('.', '-')}`;

/** ONE button skin, and it is the rack's own: `voiceChrome`'s
 *  `voiceButtonClass` is a size up, because it was drawn for the 300 px rail the
 *  saving buttons came from. jsdom has no layout and cannot fail on a skin, so
 *  it is written down instead. */
const buttonClass =
  'pressable control flex-none rounded-md px-1.5 py-0.5 font-mono text-[8.5px] font-bold tracking-[0.06em] uppercase disabled:cursor-not-allowed disabled:opacity-40';

/**
 * What a holder nobody has folded yet shows: everything except
 * `DEFAULT_OPEN_SECTIONS`. DERIVED rather than listed, so a fifth `ParamSection`
 * starts folded without this file being edited.
 *
 * Module-level so the default prop keeps a stable identity across renders.
 */
const DEFAULT_COLLAPSED_SECTIONS: readonly SectionId[] = PARAM_SECTIONS.filter(
  (section) => !DEFAULT_OPEN_SECTIONS.includes(section.id),
).map((section) => section.id);

export function VoiceEditor({
  kind,
  id,
  instrumentId,
  voiceRef,
  readVoiceRef,
  scope,
  scale,
  wheel,
  refusals,
  follow,
  unavailable,
  onRepointed,
  collapsed = false,
  collapsedSections = DEFAULT_COLLAPSED_SECTIONS,
  onCollapsedSectionsChange,
}: {
  /** Which document holds the voice, and which one. Never the document itself:
   *  `CLAUDE.md`'s rule is that the agent must be able to act without a pointer,
   *  and every seam below is `(kind, id, …)` for that reason. */
  kind: HolderKind;
  id: string;
  /** The holder's instrument — what the picker may offer. Resolved by the
   *  wrapper, which is the half that knows whether a pattern or a track is being
   *  asked. */
  instrumentId: FretInstrumentId;
  /** The holder's stored ref, subscribed by the wrapper. */
  voiceRef: VariantRef | null;
  /**
   * The same ref as of NOW, for the commit that fires up to
   * {@link VOICE_COMMIT_MS} after the render that scheduled it. The rail, a
   * compact picker and the agent all write the same holder, so the rendered
   * value can be a window out of date — which would write a pick the model has
   * already taken, or skip one it has not.
   */
  readVoiceRef: () => VariantRef | null;
  /** What every accessible name here is scoped by — a track's name where eight
   *  racks share one page, null where the holder is the only one on screen and
   *  the visible engraving is name enough. */
  scope: string | null;
  scale: KnobScale;
  /** What a wheel notch over a dial means on this surface — see
   *  {@link WheelPolicy}. Decided by what this editor is mounted INSIDE rather
   *  than by the holder kind, and passed to every `Knob` and `ParamEncoder`
   *  below. */
  wheel: WheelPolicy;
  /** A complete sentence per refusal, in this surface's own wording. */
  refusals: Record<VoiceRefusal, string>;
  /** The option standing for "no voice of its own". `selectable` is what says
   *  whether it is a CHOICE or a statement of fact: clearing a track's ref puts
   *  it on the instrument's active variant, and there is deliberately no
   *  equivalent write for a pattern. */
  follow: { readonly label: string; readonly selectable: boolean };
  /** Set when the stored ref is one the picker cannot offer — the `<option>`
   *  that admits it, and the sentence under the disabled Save that explains it.
   *  Null when the ref is fine. */
  unavailable: { readonly option: string; readonly reason: string } | null;
  /** `playbackService.refreshVoice` on the pattern arm; null on the track arm,
   *  which must NOT make it — see the header. */
  onRepointed: (() => void) | null;
  /** The whole editor is folded away: the header still draws (it carries the
   *  state you fold eight racks down to compare), the stages do not. */
  collapsed?: boolean;
  /**
   * Which stages are folded. The FOLDED set rather than the open one so it
   * cannot go stale when `paramSchema` gains a section: a name nobody has heard
   * of is open, which is the safe way round for a control surface.
   *
   * `undefined` is "nobody has folded this holder yet" and opens on
   * {@link DEFAULT_COLLAPSED_SECTIONS} — NOT the same as an empty list, and the
   * caller must keep the two apart: empty is a user who has unfolded
   * everything, and collapsing it back to `undefined` would re-fold two stages
   * under them on the next render.
   */
  collapsedSections?: readonly SectionId[];
  onCollapsedSectionsChange?: (collapsed: readonly SectionId[]) => void;
}) {
  const preset = useVoiceWorkingPreset(kind, id);
  const dirty = useVoiceDirty(kind, id);
  const voices = useSelectableVoices(instrumentId);
  // For the Level stage alone — see `renderLevel`. Subscribed rather than read
  // through `findTrack` so the input knob follows a write made anywhere else,
  // including the agent's; resolves to undefined for a pattern holder, whose id
  // names no track.
  const track = useTracks().find((candidate) => candidate.id === id);

  /** THIS holder's messages, and no other's: a refusal about the fifth track is
   *  unattributable at the top of the page. */
  const [notice, setNotice] = useState<string | null>(null);

  // Transient by design, and per holder: the state that must survive an unmount
  // is the draft, and that is in `voiceDrafts`. The hook is shared for its
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
   * field) commits instead of racing it.
   */
  const [draftVoiceKey, setDraftVoiceKey] = useState<string | null>(null);
  const voiceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceFlush = useRef<((ask: boolean) => void) | null>(null);

  /**
   * Unmount is the one end with no gesture on it: a track removed, a pane
   * collapsed, or the page switched mid-window would otherwise drop the pick
   * with nothing to notice.
   *
   * ⚠ A `window.confirm` raised during TEARDOWN has no gesture behind it — after
   * "Remove track" it would ask about a track that is already gone, and then
   * answer itself with a refusal into a notice line nobody can read. So the
   * flush is told not to ask, and a commit that WOULD have asked drops the pick
   * instead: the pick is one keystroke and the draft is the work.
   *
   * ⚠ ONE TEARDOWN HERE *IS* A GESTURE and is still handled this way on purpose:
   * `PaneStack` unmounts a collapsed pane's body, so folding the pattern page's
   * Instrument & Amp pane within {@link VOICE_COMMIT_MS} of a pick, with an
   * unsaved edit standing, drops that pick. Accepted rather than special-cased —
   * asking would put a modal in front of a fold, and the alternative (flushing
   * without asking) is the one outcome nobody can undo: it throws the draft away.
   */
  useEffect(
    () => () => {
      voiceFlush.current?.(false);
    },
    [],
  );

  /**
   * The holder changed under this editor, or its instrument did — a pattern
   * switch behind the pane, or the pane's own instrument picker. EVERYTHING
   * TRANSIENT HERE IS ABOUT THE HOLDER IT WAS RENDERED FOR, so it goes with it:
   *
   *   - the pending pick, which would otherwise land up to
   *     {@link VOICE_COMMIT_MS} later on a holder it was not aimed at.
   *     `readVoiceRef` being re-read live does NOT catch this on its own — the
   *     new holder's ref legitimately differs from the picked key, so the
   *     already-on-it short-circuit misses and the write goes through. Pick a
   *     guitar variant, switch to bass inside the window, and the bass pattern is
   *     pointed at a voice it cannot resolve. CANCELLED rather than flushed: the
   *     gesture named a holder that is no longer on screen.
   *   - the notice, which is a sentence about the previous holder's voice, left
   *     standing in a live region under the new one.
   *   - an open name form, whose Create would write the NEW holder's working copy
   *     under the OLD one's suggested name.
   *
   * The DRAFT is deliberately not among them: it is keyed by holder in
   * `voiceDrafts` and each holder keeps its own.
   */
  useEffect(() => {
    if (voiceTimer.current !== null) clearTimeout(voiceTimer.current);
    voiceTimer.current = null;
    voiceFlush.current = null;
    setDraftVoiceKey(null);
    setNotice(null);
    setNameForm(null);
  }, [kind, id, instrumentId, setNameForm]);

  // Unreachable: a wrapper only draws an editor for a holder the draft store can
  // resolve against. Guarded rather than asserted because the alternative is a
  // non-null assertion on a store lookup, and every hook above has already run.
  if (!preset) return null;

  const holderKey = `${kind}:${id}`;

  /** The accessible-name scope, applied once: "Lead Amp Enabled" on a rack,
   *  "Amp Enabled" on the pane, from one expression. */
  const scoped = (...parts: readonly string[]) => [scope, ...parts].filter(Boolean).join(' ');

  /** The other shape a scoped name takes — a verb phrase that has to say which
   *  holder it acts on ("Add Chorus for Lead"). */
  const forScope = (text: string) => (scope ? `${text} for ${scope}` : text);

  /** Only where the visible label cannot carry the axis: with one holder on
   *  screen the engraving is the name, and an override would rename every button
   *  the pattern page's tests and users already know. */
  const named = (text: string) => (scope ? text : undefined);

  const toggleSection = (sectionId: SectionId) =>
    onCollapsedSectionsChange?.(
      collapsedSections.includes(sectionId)
        ? collapsedSections.filter((candidate) => candidate !== sectionId)
        : [...collapsedSections, sectionId],
    );

  // Generic in the payload: every seam here is called for its refusal, not its
  // value, but some of them CARRY one (the clamped level a fader was actually
  // given, say).
  //
  // Cleared on success as well as set on failure: one line says everything this
  // editor has to say, so a refusal left standing beside a control that has since
  // worked would read as a refusal of THAT write. The composition and draft seams
  // both answer in sentences, so they are shown as they are; only the voice WRITE
  // seam answers in codes, and those go through `refusals`.
  const report = (result: Result<unknown>) => setNotice(result.ok ? null : result.reason);

  const write = (path: string, value: unknown) => report(setVoiceParam(kind, id, path, value));

  const currentKey = voiceRef ? voiceKey(voiceRef) : '';
  const isBuiltIn = voiceRef === null || voiceRef.kind === 'default';

  /** One confirmation in front of every switch that would throw the working copy
   *  away — and a pick really does throw it away (see `discard` in
   *  `commitVoice`), so this is the last chance to keep it. Routed through one
   *  function so replacing it with a real dialog is one edit. */
  const confirmDiscard = () =>
    // Read from the store rather than from `dirty`, which is this RENDER's
    // answer: the question is asked up to {@link VOICE_COMMIT_MS} after the
    // render that scheduled it, and a Revert (or a Save) in between retires the
    // draft. Asking about an edit that no longer exists is the failure, and
    // answering Cancel to it would then drop a pick for nothing.
    !isVoiceDirty(kind, id) ||
    window.confirm(
      scope
        ? `Discard unsaved changes to ${scope}’s voice?`
        : 'Discard unsaved changes to this voice?',
    );

  /** Retire this holder's draft, and tell the engine. `discardVoiceDraft`
   *  notifies whenever it deletes one, which is what makes the live voice go
   *  back to what the store now holds. */
  const discard = () => discardVoiceDraft(kind, id);

  /**
   * Land a pick: report whatever came back, and RETIRE THE DRAFT — but only if
   * the write actually happened, since the user agreed to lose the edit on
   * condition of the switch and a refused switch has not earned it.
   *
   * ⚠ The discard is not redundant with the repoint. A new ref only makes the
   * draft's tag STOP MATCHING, which is not the same as retiring it:
   * `readVoiceDraft` self-clears on a mismatch, but `useVoiceDirty` /
   * `useVoiceWorkingPreset` compare the tag WITHOUT deleting (a store write
   * during render is a React error). Left standing, the entry resurrects the
   * moment the holder is pointed back at the voice it was taken from.
   */
  const commitVoice = (key: string, ask = true) => {
    if (voiceTimer.current !== null) clearTimeout(voiceTimer.current);
    voiceTimer.current = null;
    voiceFlush.current = null;
    // The teardown path, which cannot ask (see the cleanup effect above). Before
    // any `setState`, so an unmounting editor writes nothing at all.
    if (!ask && isVoiceDirty(kind, id)) return;

    /* ⚠ EVERY `setState` BELOW GOES THROUGH HERE, because `!ask` is the unmount
       path and the component is already gone by the time it runs. React 19
       no-ops those writes rather than warning, which is exactly why they would
       sit here unnoticed — and the notice in particular would be a sentence
       pushed into a live region that is no longer in the document. */
    const onScreen = (write: () => void) => {
      if (ask) write();
    };

    // Dropped whatever the seam says: on `ok` the store re-renders with the value
    // it took, and on a refusal — including a refused confirmation — the control
    // has to snap back to what the model actually holds.
    onScreen(() => setDraftVoiceKey(null));

    const live = readVoiceRef();
    const liveKey = live ? voiceKey(live) : '';

    // Already on it. The notice is cleared anyway: a refusal left standing beside
    // a choice the user just re-affirmed reads as a refusal of THAT pick.
    if (key === liveKey) {
      onScreen(() => setNotice(null));
      return;
    }
    // Asked once per COMMIT rather than once per `change`: the window exists
    // precisely because a keyboard walk fires one `change` per option, and a
    // confirmation per arrow key is the same fetch storm in dialogs.
    if (!confirmDiscard()) return;
    onScreen(() => setNameForm(null));

    // '' is the way back to the fallback where there is one — a real choice for a
    // track, and refused in words for a pattern, whose ref-less state is the
    // global `activeVariants` entry every other ref-less pattern shares.
    const next = key === '' ? null : parseVoiceKey(key);
    // Unreachable from these options — every value came from `voiceKey` — but the
    // seam refuses an unparseable ref and so must this, rather than writing null
    // and silently resetting the holder to the fallback.
    if (key !== '' && !next) {
      onScreen(() => setNotice(SHARED_VOICE_REFUSAL_TEXT['unknown-variant']));
      return;
    }
    const result = selectVoice(kind, id, next);
    onScreen(() => report(result));
    if (!result.ok) return;
    discard();
    // The pattern arm's obligation and the track arm's prohibition, as one prop —
    // see the header. Nothing makes a pattern's selection audible on its own.
    onRepointed?.();
  };

  const onVoiceChange = (key: string) => {
    setDraftVoiceKey(key);
    if (voiceTimer.current !== null) clearTimeout(voiceTimer.current);
    voiceFlush.current = (ask) => commitVoice(key, ask);
    voiceTimer.current = setTimeout(() => commitVoice(key), VOICE_COMMIT_MS);
  };

  const save = () => {
    const result = saveVoice(kind, id, preset);
    if (!result.ok) {
      setNotice(refusals[result.reason]);
      return;
    }
    setNotice(null);
    // The variant now holds what the draft held. Left standing, the draft would
    // keep the strip reading "Unsaved" against a voice that already matches it,
    // and would keep the engine building from a copy nothing can reach.
    discard();
  };

  const submitName = () => {
    if (!nameForm) return;
    const trimmed = nameForm.value.trim();

    if (nameForm.mode === 'save-as') {
      const result = saveVoiceAs(kind, id, trimmed, preset);
      if (!result.ok) {
        setNotice(refusals[result.reason]);
        return;
      }
      setNotice(null);
      closeNameForm();
      // `saveVoiceAs` has already repointed the holder, which retires the draft by
      // tag on its own; this is what tells the engine to go and rebuild from the
      // variant rather than from the copy it was made out of.
      discard();
      // Save as… can be pressed with nothing unsaved, and the repoint still has to
      // reach the engine on the pattern arm.
      onRepointed?.();
      return;
    }

    // Near-unreachable — Rename is disabled unless the holder is on a user
    // variant — but this is the one place here that could swallow a failure, and
    // a form that sits open saying nothing is what this editor would be blamed
    // for.
    if (voiceRef?.kind !== 'user') {
      setNotice(refusals['built-in']);
      return;
    }
    const renamed = renameVoice(voiceRef.id, trimmed);
    if (!renamed.ok) {
      setNotice(refusals[renamed.reason]);
      return;
    }
    // The draft carries the OLD name and `saveVoice` writes the record's name back
    // from `preset.name`, so without this the next Save would silently undo the
    // rename. A no-op when there is no draft.
    report(setVoiceName(kind, id, trimmed));
    closeNameForm();
  };

  const remove = () => {
    if (voiceRef?.kind !== 'user') return;
    // ONE dialog, not two. Deleting the variant also strands this holder's unsaved
    // edit — a pick asks about exactly that on the same screen, and asking twice in
    // a row is how people learn to click through confirmations — so the loss is
    // named in the sentence that is already being read.
    //
    // THE HOLDER IS NAMED TOO where there is more than one on screen: two tracks
    // can legitimately sit on one shared variant, and then the variant's name says
    // nothing about which of eight racks asked.
    const consequence = dirty
      ? 'Your unsaved edits to it go too, and any pattern or track using it falls back to a built-in voice.'
      : 'Any pattern or track using it falls back to a built-in voice.';
    if (
      !window.confirm(
        `Delete “${preset.name}”${scope ? `, ${scope}’s voice` : ''}? ${consequence}`,
      )
    ) {
      return;
    }

    // ONE seam call, because it is one act: the seam destroys the variant and
    // repairs THIS holder's dangling ref itself, which is what the kind buys —
    // under the wrong one the same call would fix the open pattern and leave a
    // track resolving silently to a built-in.
    const result = deleteVoice(kind, id, voiceRef.id);
    if (!result.ok) {
      setNotice(refusals[result.reason]);
      return;
    }
    setNameForm(null);
    setNotice(null);
    discard();
    onRepointed?.();
  };

  /**
   * The same `SliderParam`, drawn as a rotary instead of a row. Every number
   * still comes from the descriptor, including `fallback` as the double-click
   * reset, so nothing about an amp's ranges is known to this file.
   *
   * No `id`: `Knob` names itself through `aria-labelledby`, so there is no
   * `<label htmlFor>` to point anywhere.
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
        wheel={wheel}
        value={typeof raw === 'number' ? raw : param.fallback}
        min={param.min}
        max={param.max}
        step={param.step}
        defaultValue={param.fallback}
        formatValue={(v) => `${v.toFixed(param.precision)}${param.unit ? ` ${param.unit}` : ''}`}
        onChange={(value) => write(param.path, value)}
      />
    );
  };

  /**
   * One row of the table.
   *
   * `nameScope` prefixes the ACCESSIBLE name of a sub-branch's or a pedal's rows
   * — those are the primary's descriptors generated under a second branch, so
   * "Harmonicity" appears twice inside one stage and four pedals have a "Mix".
   * The enclosing `role="group"` does NOT contribute its name to a descendant's:
   * a group is announced on entry. The landmark handles the OTHER axis (which of
   * eight racks), and the scope is already folded into `nameScope` by its caller.
   */
  const renderParam = (section: ParamStage, param: Param, nameScope?: string) => {
    const raw = getAtPath(preset, param.path);
    const elementId = domId(kind, id, param.path);
    const branchName = (label: string) => (nameScope ? `${nameScope} ${label}` : undefined);

    switch (param.kind) {
      case 'toggle':
        return (
          <ParamToggle
            key={param.path}
            id={elementId}
            label={param.label}
            // Every stage's bypass is labelled "Enabled" and Amp and Cabinet are
            // open together by default, so the name carries the stage — and the
            // holder, where there are eight of them — while the visible label
            // stays inside a 74 px column.
            ariaLabel={branchName(param.label) ?? scoped(section.label, param.label)}
            value={typeof raw === 'boolean' ? raw : param.fallback}
            onChange={(value) => write(param.path, value)}
          />
        );

      case 'enum':
        return (
          <ParamEnum
            key={param.path}
            id={elementId}
            label={param.label}
            ariaLabel={branchName(param.label)}
            value={param.resolve(raw)}
            options={param.options}
            badgeOf={param.badgeOf}
            mod={param.mod}
            onChange={(value) => write(param.path, value)}
          />
        );

      case 'encoder':
        // No `id`, for `Knob`'s reason: `ParamEncoder` names itself through
        // `aria-labelledby`.
        return (
          <ParamEncoder
            key={param.path}
            label={param.label}
            ariaLabel={branchName(param.label)}
            size={scale.small}
            wheel={wheel}
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
            id={elementId}
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
            onChange={(value) => {
              // Computed here only to know what to WARM: a fresh sampler is a
              // fresh set of banks nothing has fetched, and `reconcile` will not
              // build a graph on a silent page. The write itself goes through the
              // seam by path and value.
              if (isSourceKind(value)) {
                const swapped = withSourceKind(preset, value);
                if (swapped.source.kind === 'sampler') {
                  warmSampleBanks(holderKey, swapped.source.samples);
                }
              }
              write(param.path, value);
            }}
          />
        );

      case 'sample-pack': {
        // A preset stores note→URL maps rather than a pack id, so the active
        // entry is found by deep shape; `null` is a hand-authored map matching no
        // registered pack, which the picker admits rather than papering over.
        const banks = Array.isArray(raw) ? (raw as Banks) : null;
        const active = banks ? detectSamplePack(banks) : null;
        return (
          <ParamEnum
            key={param.path}
            id={elementId}
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
            // map. `getSamplePack` is consulted here for the warm, and to refuse
            // early on an id the registry lost between render and change.
            onChange={(packId) => {
              const pack = getSamplePack(packId);
              if (!pack) {
                setNotice('That sample pack is no longer registered.');
                return;
              }
              warmSampleBanks(holderKey, pack.samples);
              write(param.path, packId);
            }}
          />
        );
      }

      case 'slider':
        // Every slider in this table is a knob: a 74 px label plus a 52 px
        // readout per row is a list, and this is a rack face.
        return renderKnob(param, scale.small, nameScope);
    }
  };

  /**
   * The Level stage — ⚠ THE ONE BRANCH ON HOLDER KIND IN THIS FILE, and it is
   * irreducible.
   *
   * `inputGainDb` exists in two places and they are NOT both shown. The preset
   * carries one, and it is the wrong one to put on a track: a preset is chosen
   * and swapped, so an input level stored there is thrown away every time the
   * user tries a different amp. The TRACK's value overrides it and survives the
   * swap, so a track shows the track's and hides the preset's rather than
   * offering two faders that fight over one job.
   *
   * A pattern has no track to hold one, so it shows the preset's — which is also
   * why this filters here rather than removing the param from `paramSchema`.
   * `setTrackInputGainDb` is a composition-seam call with no pattern equivalent;
   * there is no prop that makes it one.
   */
  const renderLevel = (section: ParamSection) => {
    const rows = ownParams(preset, section);
    if (kind !== 'track' || !track) {
      return (
        <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
          {rows.map((param) => renderParam(section, param))}
        </div>
      );
    }
    return (
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <Knob
          label="Input"
          // No override: "Input" is unique inside its stage, and the stage is a
          // landmark named for the track — which is the disambiguation the rest
          // of this file's names defer to as well.
          size={scale.small}
          // The one `Knob` in this file that does NOT go through `renderKnob`,
          // so it needs the policy passed by hand — see `wheel`.
          wheel={wheel}
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
        {rows
          .filter((param) => param.path !== 'inputGainDb')
          .map((param) => renderParam(section, param))}
      </div>
    );
  };

  /**
   * The pedalboard, as one stage holding six.
   *
   * ── WHY THIS IS NOT SIX SECTIONS ─────────────────────────────────────────
   *
   * Each pedal is independently present, bypassable and removable, which is
   * exactly what a `ParamSection` describes — so six sections is the obvious
   * shape and it is the wrong one. It would put six more stage headers in a rack
   * whose whole design argument is that TWO TRACKS' settings are comparable at
   * once, and the pedalboard is one thing a guitarist points at, not six.
   *
   * ── THE ORDER IS THE SIGNAL'S, AND IT IS FIXED ───────────────────────────
   *
   * Top to bottom is `Voice.wireChain`'s build order. Nothing here can change
   * it: the chain reads no order off the preset, so a drag gesture would move a
   * card and not a sound.
   */
  const renderPedals = () => (
    <div className="flex w-full flex-col gap-1">
      {PEDALS.map((pedal) => {
        const present = sectionPresence(preset, pedal) !== 'absent';

        return (
          <div
            key={pedal.id}
            role="group"
            // Holder first, for the reason the `RackFace` landmark states: that
            // is the axis a listener navigating eight racks is moving along.
            aria-label={scoped(pedal.label)}
            className="flex flex-wrap items-start gap-x-2 gap-y-1 border-t border-ink-mut/20 pt-1"
          >
            <div className="flex w-full items-center gap-1.5">
              <span className="font-mono text-[8px] tracking-[0.1em] text-ink-mut uppercase">
                {pedal.label}
              </span>
              {/* No bypassed note — a stage's note exists because the body it
                  describes may be folded away, and a pedal card cannot fold, so
                  its own `Enabled` switch is on screen saying it. */}
              <span className="flex-1" />
              <button
                type="button"
                // Six pedals × up to eight racks, every button saying "Add" — the
                // name carries the pedal, and the holder where there is more than
                // one.
                aria-label={forScope(`${present ? 'Remove' : 'Add'} ${pedal.label}`)}
                onClick={() =>
                  report(
                    present
                      ? removeVoicePedal(kind, id, pedal.id)
                      : addVoicePedal(kind, id, pedal.id),
                  )
                }
                className={buttonClass}
              >
                {present ? 'Remove' : 'Add'}
              </button>
            </div>
            {present
              ? visibleParams(preset, pedal).map((param) =>
                  renderParam(pedal, param, scoped(pedal.label)),
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
        // Two removable stages, × up to eight racks, so the name carries both.
        aria-label={forScope(`${present ? 'Remove' : 'Add'} ${section.label}`)}
        onClick={() =>
          report(
            present
              ? removeVoiceSection(kind, id, section.id)
              : addVoiceSection(kind, id, section.id),
          )
        }
        className={buttonClass}
      >
        {present ? 'Remove' : 'Add'}
      </button>
    ) : null;

  /**
   * "Use suggested cab" — ours entirely. Every amp model names a cab pairing and
   * the lib's own comment calls the suggestion *documentary*: nothing in the
   * engine applies it. Offered only when it would change something.
   *
   * Writes the URL and nothing else, so it creates a cabinet branch on a preset
   * with no cabinet (valid — `url` is `CabIRParams`' only required field)
   * without un-bypassing one the user switched off on purpose.
   *
   * It also UNFOLDS Cabinet: the button lives in the Amp stage but every visible
   * consequence of pressing it is in another one, so with Cabinet folded the
   * only feedback would be the button disappearing. That write is an
   * un-collapse now rather than an open — the list here is the FOLDED one.
   */
  const renderSuggestedCab = () => {
    const modelId = getAtPath(preset, AMP_MODEL_PATH);
    const model = getAmpModel(typeof modelId === 'string' ? modelId : undefined);
    const suggested = model.defaultCabIrId ? getCabinetIR(model.defaultCabIrId) : undefined;
    if (!suggested || getAtPath(preset, CAB_URL_PATH) === suggested.url) return null;

    return (
      <button
        type="button"
        // Built inside the guard rather than handed to `named`, which would
        // interpolate a null scope into a string it then throws away.
        aria-label={scope ? `Use suggested cab for ${scope} · ${suggested.label}` : undefined}
        onClick={() => {
          write(CAB_URL_PATH, suggested.url);
          if (collapsedSections.includes('cabinet')) {
            onCollapsedSectionsChange?.(
              collapsedSections.filter((candidate) => candidate !== 'cabinet'),
            );
          }
        }}
        className={`${buttonClass} self-start`}
      >
        Use suggested cab · {suggested.label}
      </button>
    );
  };

  /** The amp, as an amp: knobs on the plate, bypass as the power switch, the
   *  model the chain would really build engraved on the face. Split by `kind` of
   *  PARAM, so a slider the schema gains appears as a knob without touching
   *  this. */
  const renderAmp = (section: ParamSection) => {
    // `ownParams`, not `visibleParams`: `renderSubBranch` runs after every stage
    // body, so a renderer asking for all the visible rows would draw a
    // sub-branch's rows twice the day this stage gains one.
    const rows = ownParams(preset, section);
    const power = enabledParamOf(section);
    const enabled = power ? getAtPath(preset, power.path) !== false : true;
    const rawModel = getAtPath(preset, AMP_MODEL_PATH);
    return (
      <>
        <AmpHead
          // What the chain would really build. `getAmpModel` falls back to Plexi
          // for a missing or unknown id, and a faceplate naming something that
          // isn't loaded would be the one lie the picker already refuses to tell.
          model={getAmpModel(typeof rawModel === 'string' ? rawModel : undefined).name}
          enabled={enabled}
          power={
            power
              ? {
                  label: scoped(section.label, power.label),
                  onChange: (next) => write(power.path, next),
                }
              : undefined
          }
        >
          {rows
            .filter((param): param is SliderParam => param.kind === 'slider')
            .map((param) => renderKnob(param, scale.amp))}
        </AmpHead>
        {rows
          .filter((param) => param.kind !== 'slider' && param !== power)
          .map((param) => renderParam(section, param))}
        {renderSuggestedCab()}
      </>
    );
  };

  /** The cabinet, as a cabinet. The mic dot picks the IR; the schema's
   *  `<select>` stays as the text-level route to the same value and as the only
   *  place the registry's description of a capture is readable. */
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
            .map((param) => renderKnob(param, scale.small))}
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
   * that one routes through `setVoiceParam`, which resolves a `source-kind` row
   * with `withSourceKind` — a function that takes no path and always replaces
   * the PRIMARY source. `setVoiceSubBranchKind` is the branch-aware seam, and it
   * is why the layer's picker is declared on `ParamSubBranch.kindRow` rather
   * than in `section.params`.
   */
  const renderSubBranchKind = (row: SourceKindParam, sub: ParamSubBranch) => (
    <ParamEnum
      key={row.path}
      id={domId(kind, id, row.path)}
      label={row.label}
      // "Source" names the primary's picker too, and both live in this stage.
      ariaLabel={scoped(sub.label, row.label)}
      value={row.resolve(getAtPath(preset, row.path))}
      options={row.options}
      // A stored kind the picker does not offer resolves fine and simply has no
      // option — see `LAYER_SOURCE_KIND_OPTIONS` for which kinds and why.
      placeholder="Not offered here"
      onChange={(value) => report(setVoiceSubBranchKind(kind, id, sub.id, value))}
    />
  );

  /**
   * A stage's nested optional branch — the second source, the cutoff envelope.
   *
   * Rendered as a named group, which carries the CONTAINMENT; the rows' own
   * names carry which branch they belong to (`renderParam`'s `nameScope`),
   * because a group's accessible name is announced on entry and does not fold
   * into a descendant's.
   *
   * Add and Remove are drawn whether or not the branch is there, exactly as the
   * stage buttons are, so neither is a refusal waiting to happen.
   *
   * The notes here are the pattern pane's, kept where the rack said nothing: each
   * explains why a control the user can see the space for is NOT on screen, and
   * an unexplained absence is a defect rather than density. That includes the
   * ABSENT branch's, which says what Add would do to the sound — it comes off
   * `ParamSubBranch.absentNote` rather than off `sub.id`, so this renderer still
   * has no per-branch case in it.
   */
  const renderSubBranch = (section: ParamSection) => {
    const sub = section.subBranch;
    if (!sub) return null;
    const present = subBranchApplies(preset, sub);
    const branchKind = sub.kindRow
      ? sub.kindRow.resolve(getAtPath(preset, sub.kindRow.path))
      : null;
    const offered = sub.kindRow?.options.some((option) => option.value === branchKind) ?? true;
    return (
      <div
        role="group"
        aria-label={scoped(sub.label)}
        className="flex flex-wrap items-start gap-x-2 gap-y-1 border-t border-ink-mut/20 pt-1"
      >
        <div className="flex w-full items-center gap-1.5">
          <span className="font-mono text-[8px] tracking-[0.1em] text-ink-mut uppercase">
            {sub.label}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            // Two sub-branches × up to eight racks, and every button says "Add" —
            // the name carries the branch, and the holder where there is more
            // than one.
            aria-label={forScope(`${present ? 'Remove' : 'Add'} ${sub.label}`)}
            onClick={() =>
              report(
                present
                  ? removeVoiceSubBranch(kind, id, sub.id)
                  : addVoiceSubBranch(kind, id, sub.id),
              )
            }
            className={buttonClass}
          >
            {present ? 'Remove' : 'Add'}
          </button>
        </div>
        {!present && sub.absentNote ? (
          /* What Add would DO, which the button cannot say. The sentence is on
             the schema (`ParamSubBranch.absentNote`) rather than branched on
             `sub.id` here — one renderer, no per-branch special case. */
          <p className="w-full font-mono text-[8.5px] leading-snug text-ink-mut">
            {sub.absentNote}
          </p>
        ) : null}
        {present ? (
          <>
            {sub.kindRow ? renderSubBranchKind(sub.kindRow, sub) : null}
            {branchParams(preset, section).map((param) =>
              renderParam(section, param, scoped(sub.label)),
            )}
            {sub.id === 'body-filter-envelope' ? (
              <p className="w-full font-mono text-[8.5px] leading-snug text-ink-mut">
                While this is here the envelope drives the cutoff, so the stage’s static
                Cutoff is put away — its value is kept and comes back if you remove this.
              </p>
            ) : null}
            {branchKind !== null && !offered ? (
              <p className="w-full font-mono text-[8.5px] leading-snug text-ink-mut">
                This second source is a kind the editor does not offer for a layer, so its
                own settings are not shown. Its mix and octave are still yours; picking a
                kind above replaces it.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    );
  };

  const renderStage = (section: ParamSection) => {
    const presence = sectionPresence(preset, section);
    return (
      <VoiceSection
        key={section.id}
        label={section.label}
        // Deliberately NOT the landmark's name, and deliberately not the rack's
        // either: three things are foldable in voice mode and they have to be
        // tellable apart by name alone — "Voice rack for Lead" is the whole rack,
        // this is one stage of it, and the region it controls is "Lead Amp".
        // Undefined where there is one holder: `Section` then names the button
        // from its visible label, which is what it already said, and an
        // `aria-label` of "Source" would collide with the Source picker inside
        // it for anything querying by name.
        buttonLabel={scope ? `${section.label} stage for ${scope}` : undefined}
        // The landmark name is what disambiguates eight racks' identically named
        // controls. Holder first, because that is the axis a listener navigates.
        regionName={scope ? `${scope} ${section.label}` : `${section.label} stage`}
        status={presence}
        open={!collapsedSections.includes(section.id)}
        onToggle={() => toggleSection(section.id)}
        actions={stageActions(section, presence !== 'absent')}
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
      </VoiceSection>
    );
  };

  return (
    <div className="flex flex-col gap-1">
      {/* ---- what can be done to the voice this holder is on -------------------
          Beside the knobs, which is the whole of CP-18's fourth step: the rack
          used to name the right-hand rail here, in words, for the one button that
          keeps what you just did.

          NOT FOLDED WITH THE STAGES, deliberately: the disclosure hides the
          TUNING, and which voice a holder is on, whether it has an unsaved edit
          and what saving it would overwrite are exactly what you fold eight racks
          down to compare. The live region below also has to stay mounted to be
          announced at all. */}
      <div className="flex flex-none flex-wrap items-center gap-1">
        {/* ⚠ ADDRESSES THIS HOLDER, not the selected one. The rail's list picks
            for whichever track is SELECTED and this picks for the holder whose
            editor it is in; both are on screen at once in voice mode, which is why
            the rail's heading names its track and this one's label names its
            own. */}
        {/* A VISIBLE label where there is no scope, because there the picker sits
            in a pane column directly under a labelled Instrument row and two
            adjacent `<select>`s with one label between them is the rack's
            200 px-lane answer applied where it buys nothing. Scoped, the name has
            to carry the track and no engraving can, so it stays an override. */}
        {scope === null && (
          <label htmlFor={domId(kind, id, 'voice')} className={`flex-none ${voiceLabelClass}`}>
            Voice
          </label>
        )}
        <select
          id={domId(kind, id, 'voice')}
          aria-label={scope ? `${scope} voice` : undefined}
          value={draftVoiceKey ?? currentKey}
          onChange={(event) => onVoiceChange(event.target.value)}
          // Leaving the field ends the coalescing window early. Without it a pick
          // made with the keyboard and then tabbed away from would sit for
          // {@link VOICE_COMMIT_MS} looking committed and not being.
          onBlur={() => voiceFlush.current?.(true)}
          className="control min-w-0 max-w-[16rem] flex-1 rounded-md px-1 py-0.5 font-mono text-[8.5px] font-bold text-ink"
        >
          {/* Present at all so the control can say WHY it is showing a voice the
              list below does not contain, and disabled because it is a fact rather
              than a choice. */}
          {unavailable && (
            <option value={currentKey} disabled>
              {unavailable.option}
            </option>
          )}
          {/* Not "none": a ref-less holder plays something, it just isn't its own
              choice. Listed first so the way back is always in the same place —
              and drawn for a holder that cannot CHOOSE it only when it is what the
              holder is currently on, since a `<select>` whose value matches no
              option silently displays the first one. */}
          {(follow.selectable || voiceRef === null) && (
            <option value="" disabled={!follow.selectable}>
              {follow.label}
            </option>
          )}
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
        {/* The shared pill — brass marks unsaved, the way it marks every other
            live state here, and it is announced rather than only coloured because
            an edit that exists only as a colour is one a user cannot confirm they
            made. */}
        <DirtyPill dirty={dirty} />
        <span className="flex-1" />
        {/* Named for the holder where there are eight of them, because eight racks
            put eight buttons called "Save" on one page and the visible word cannot
            carry the axis. */}
        <button
          type="button"
          aria-label={named(`Save ${scope}’s voice`)}
          onClick={save}
          // The rail's guard, which is the stricter of the two that existed: a ref
          // can name a deleted variant or one belonging to another instrument, and
          // the seam refuses both rather than overwriting a voice the user cannot
          // see from where they are standing. The seam refuses independently of
          // this attribute — this is a mirror of the rule, not the rule.
          disabled={!dirty || isBuiltIn || unavailable !== null}
          className={buttonClass}
        >
          Save
        </button>
        <button
          type="button"
          aria-label={named(`Save ${scope}’s voice as a new voice`)}
          onClick={openNameForm('save-as', `${preset.name} copy`)}
          className={buttonClass}
        >
          Save as…
        </button>
        <button
          type="button"
          aria-label={named(`Rename ${scope}’s voice`)}
          onClick={openNameForm('rename', preset.name)}
          // Renaming WHILE DIRTY is fine: `voiceDrafts.setVoiceName` patches the
          // draft, so the next Save cannot silently undo the rename.
          disabled={isBuiltIn}
          className={buttonClass}
        >
          Rename
        </button>
        <button
          type="button"
          aria-label={named(`Delete ${scope}’s voice`)}
          onClick={remove}
          // Save's guard, for Save's reason and one of its own: `preset` has
          // already fallen back to a built-in when the ref names a variant that is
          // gone, so a live Delete here would ask about — and name — a voice that
          // is not the one the ref points at.
          disabled={isBuiltIn || unavailable !== null}
          className={buttonClass}
        >
          Delete
        </button>
        {dirty && (
          <button
            type="button"
            aria-label={scope ? `Discard voice changes for ${scope}` : 'Discard voice changes'}
            title="Put this back on its stored voice"
            onClick={() => report(discard())}
            className={buttonClass}
          >
            Revert
          </button>
        )}
      </div>

      {/* Said BEFORE the button is pressed, not after: a voice is a SHARED asset
          and Save retunes every holder of it. That is settled behaviour rather
          than a bug — there is deliberately no per-holder fork — and it travels
          with the button rather than being left behind in the rail.

          THE PARAGRAPH FOLDS, unlike the buttons: it is a permanent explanation
          rather than a state, and eight folded racks each carrying "This track
          follows its instrument's voice" is the density folding was meant to
          remove. It comes back for an UNSAVED EDIT whatever is folded, because
          that is the only state in which Save can do anything. */}
      {(!collapsed || dirty) && (
        <p className="flex-none font-mono text-[8.5px] leading-relaxed text-ink-mut">
          {/* Why Save is refused, stated where the refusal is — a disabled button
              with no reason is what this editor would be most blamed for. */}
          {isBuiltIn
            ? voiceRef === null
              ? refusals['no-voice']
              : refusals['built-in']
            : unavailable
              ? unavailable.reason
              : // The one case where there IS something to save into — and where
                // the consequence has to be said before the button is pressed.
                `Saving overwrites “${preset.name}” everywhere it is used — every pattern and every other track on it.`}
        </p>
      )}

      {nameForm && (
        <NameForm
          form={nameForm}
          // Per HOLDER, through the same helper every other id here goes through:
          // eight racks would otherwise mint eight inputs with one id, and a
          // `<label htmlFor>` resolves to whichever mounted first.
          inputId={domId(kind, id, 'name')}
          onChange={(value) => setNameForm({ ...nameForm, value })}
          onSubmit={submitName}
          onCancel={closeNameForm}
        />
      )}

      {/* Mounted always, `sr-only` when empty: a live region has to exist BEFORE
          its content changes to be announced, and sr-only costs no layout. Named
          for the holder, because eight live regions saying "That voice is no
          longer in your library" are eight statements about eight voices. */}
      <p
        role="status"
        aria-label={named(`${scope} voice messages`)}
        className={
          notice
            ? 'flex-none rounded-md border border-brass/50 px-2 py-1.5 font-mono text-[9px] leading-relaxed text-ink'
            : 'sr-only'
        }
      >
        {notice}
      </p>

      {!collapsed && (
        // Stacked, and nothing scrolls here: a rack is as tall as it is, and what
        // scrolls is the surface holding it.
        <div className="flex flex-col gap-1.5">{PARAM_SECTIONS.map(renderStage)}</div>
      )}
    </div>
  );
}
