/**
 * The Instrument & Amp pane — the UI over `voiceService`, `voiceDrafts` and
 * `paramSchema`.
 *
 * Every control in here is one row of `PARAM_SECTIONS`, addressed into the preset by
 * `presetPaths`. That is the whole design: the pane renders a table, so adding the
 * compressor or the EQs later is a change to the descriptors, not to this file.
 *
 * THE UNSAVED EDIT. Edits do not go into the voice store. They accumulate in
 * `voice/voiceDrafts`, keyed `pattern:<id>` — a module, not React state, for the two
 * reasons that module's header gives: `PaneStack` unmounts a collapsed pane's body and
 * would forget an edit held here, and every control has to be a way of CALLING a
 * capability the agent can call by kind, id and value. The engine reads the same store,
 * so there is exactly one copy of the edit in the app. Three consequences worth knowing
 * before changing anything:
 *
 *   - A voice is a SHARED asset. Save overwrites the variant for every pattern pointing
 *     at it, which is intended and was decided with the user. There is no per-pattern
 *     fork.
 *   - The fourteen built-in slots are readonly lib consts with no setter anywhere, so
 *     Save is *impossible* for them, not merely discouraged. The button is disabled and
 *     the pane says why — guitar-tutor's Sound Lab shipped exactly this wording.
 *   - A draft is tagged with the instrument and ref it is an edit OF, so switching
 *     voice or instrument retires it — here by the explicit `discard()` on every
 *     gesture that repoints the pattern, and for a repoint made behind this pane's back
 *     by the tag watch in `playbackService.usePlaybackEngine` (this pane cannot own
 *     that: `PaneStack` unmounts a collapsed pane's body). Switching PATTERN retires
 *     nothing: the key carries the pattern id, so each pattern keeps its own unsaved
 *     tone and a switch costs nothing and asks nothing.
 */
import { useState } from 'react';
import {
  detectSamplePack,
  getAmpModel,
  getCabinetIR,
  getSamplePack,
  prefetchSampleBanks,
  type FretInstrumentId,
  type Pattern,
  type VoicePreset,
} from '@fretwork/lib';
import {
  listInstruments,
  patternInstrumentId,
  setEditingPatternInstrument,
  useEditingPattern,
  type Result,
} from '../patterns/patternService';
import { refreshVoice } from '../audio/playbackService';
import {
  deleteVoice,
  parseVoiceKey,
  renameVoice,
  saveVoice,
  saveVoiceAs,
  selectVoice,
  useEditingVoiceRef,
  useSelectableVoices,
  voiceKey,
  type VoiceRefusal,
} from './voiceService';
import {
  PARAM_SECTIONS,
  PEDALS,
  branchParams,
  enabledParamOf,
  ownParams,
  sectionPresence,
  visibleParams,
  subBranchApplies,
  type EnumParam,
  type Param,
  type ParamSection,
  type ParamStage,
  type ParamSubBranch,
  type Pedal,
  type SectionId,
  type SliderParam,
  type SourceKindParam,
} from './paramSchema';
import {
  addVoicePedal,
  addVoiceSection,
  addVoiceSubBranch,
  discardVoiceDraft,
  removeVoicePedal,
  removeVoiceSection,
  removeVoiceSubBranch,
  setVoiceName,
  setVoiceParam,
  setVoiceSubBranchKind,
  useVoiceDirty,
  useVoiceWorkingPreset,
} from './voiceDrafts';
import { isSourceKind, withSourceKind } from './sourceDefaults';
import { getAtPath } from './presetPaths';
import { VoiceSection, type SectionStatus } from './VoiceSection';
import { ParamSlider } from './controls/ParamSlider';
import { ParamEnum } from './controls/ParamEnum';
import { ParamToggle } from './controls/ParamToggle';
import { ParamEncoder } from './controls/ParamEncoder';
import { Knob } from './controls/Knob';
import { SHARED_VOICE_REFUSAL_TEXT, useNameForm, voiceButtonClass, voiceLabelClass } from './voiceChrome';
import { DirtyPill } from './DirtyPill';
import { NameForm } from './NameForm';
import { AmpHead } from './rack/AmpHead';
import { CabinetGraphic } from './rack/CabinetGraphic';

const INSTRUMENTS = listInstruments();

/** Every refusal `voiceService` can return is a state this pane can be in, so each one
 *  needs a sentence. `built-in` is Sound Lab's shipped wording, kept verbatim. */
const REFUSAL_TEXT: Record<VoiceRefusal, string> = {
  ...SHARED_VOICE_REFUSAL_TEXT,
  // The three that cannot be shared with the rail. The seam's own `no-holder`
  // sentence has to cover both kinds and says "no such pattern is open"; this pane
  // only ever addresses the pattern that IS open, so it can say the shorter true
  // thing. ⚠ WHICH MEANS THE PANE HAS TWO WORDINGS FOR ONE STATE: a refused Save
  // renders this map, while a refused PICK renders `selectVoice`'s `Result`, which
  // carries the seam's prose rather than a code. Both are true sentences; the pick
  // path has no code to map because its answer is the composition seam's `Result`.
  'no-holder': 'No pattern is open.',
  'no-voice': 'This pattern has no voice of its own. Use Save as… to keep these tweaks.',
  'built-in': 'Defaults are read-only. Use Save as new variant to keep your tweaks.',
};

/** The two paths "Use suggested cab" spans. It is the one control in the pane that
 *  reads one section and writes another, so it is also the only thing left that
 *  addresses a path by hand — every other control is driven by its descriptor. */
const AMP_MODEL_PATH = 'effects.amp.modelId';
const CAB_URL_PATH = 'effects.cabIR.url';

/** `id` on an `<input>`, `htmlFor` on its label. Dots are legal in an id but awkward in
 *  a CSS selector, so they go. */
const domId = (path: string) => `voice-${path.replaceAll('.', '-')}`;

const selectClass = 'control pressable min-w-0 rounded-lg px-1.5 py-1 font-mono text-[10px]';

/**
 * Debounce in front of the lib's `prefetchSampleBanks`.
 *
 * The prefetch itself is the lib's — picking a pack does NOT download, because
 * `reconcile` won't build an audio graph on a page that has never made a sound, so
 * without a warm the first Play after a pack change stalls on the whole bank.
 *
 * The *rate* was ours because the lib's prefetch was unthrottled: a native `<select>`
 * fires `change` once per arrow key while closed, so a keyboard user stepping through
 * the eight packs passes through every one of them, and the Philharmonia pack alone is
 * ~45 MP3s. The window borrows `playbackService`'s rebuild window, so walking the list
 * warms only where it stops.
 *
 * ⚠ VESTIGIAL as of 2026-09-11 — kept for one task, not permanently. The lib's
 * `prefetchSampleBanks` now routes through the sample store's `warmUrls`, which has a
 * six-deep concurrency pool, 429 backoff, and dedupe against any in-flight load of the
 * same URL; a warm of an already-cached pack stops at PRESENCE and never reads a body.
 * So an unthrottled walk of the list is an unpooled but request-free fan-out of
 * `cache.match` calls rather than 45 requests per keypress — the pool wraps only the
 * network stage, so the presence checks themselves are still one per URL — and this
 * debounce is deletable. Its row in
 * `docs/FOLLOW-UPS.md` names the condition — it is not deleted here because the store's
 * behaviour has not been heard in a browser yet.
 *
 * No dedupe set here: `prefetchSampleBanks` is documented idempotent, and the store now
 * makes a repeat a Cache Storage presence check rather than a request.
 */
const WARM_COALESCE_MS = 120;
let pendingWarm: ReturnType<typeof setTimeout> | null = null;
let pendingBanks: ReadonlyArray<Readonly<Record<string, string>>> | null = null;

function warmSampleBanks(banks: ReadonlyArray<Readonly<Record<string, string>>>): void {
  pendingBanks = banks;
  if (pendingWarm !== null) clearTimeout(pendingWarm);
  pendingWarm = setTimeout(() => {
    pendingWarm = null;
    const target = pendingBanks;
    pendingBanks = null;
    if (target) prefetchSampleBanks(target);
  }, WARM_COALESCE_MS);
}

/**
 * Both moved to `paramSchema` when CP-14 gave the composition page a second
 * renderer of this same table: "which state is this stage in" is the schema's
 * rule, and a second copy of it is a lamp that disagrees with the ear.
 * `SectionStatus` and `SectionPresence` are the same three words by
 * construction, which the aliases below keep honest.
 */
const statusOf = (preset: VoicePreset, section: ParamSection): SectionStatus =>
  sectionPresence(preset, section);

export function VoicePane({
  openSections,
  onOpenSectionsChange,
}: {
  openSections: readonly SectionId[];
  onOpenSectionsChange: (open: readonly SectionId[]) => void;
}) {
  const pattern = useEditingPattern();

  // Split so the editor's hooks — which all need the pattern — run unconditionally
  // inside it, rather than behind an early return here.
  if (!pattern) {
    return (
      <div className="well flex items-center justify-center py-6">
        <span className="font-mono text-[10px] font-semibold tracking-[0.18em] text-ink-mut uppercase">
          No pattern open
        </span>
      </div>
    );
  }

  return (
    <VoiceEditor
      pattern={pattern}
      openSections={openSections}
      onOpenSectionsChange={onOpenSectionsChange}
    />
  );
}

function VoiceEditor({
  pattern,
  openSections,
  onOpenSectionsChange,
}: {
  pattern: Pattern;
  openSections: readonly SectionId[];
  onOpenSectionsChange: (open: readonly SectionId[]) => void;
}) {
  const instrumentId = patternInstrumentId(pattern);
  const ref = useEditingVoiceRef();
  const voices = useSelectableVoices(instrumentId);
  // The one copy of the unsaved edit, keyed by pattern — see the header. Tagged
  // with the instrument and ref, so a voice or instrument change stops it matching
  // without anything here having to watch for one; what DROPS it is the discard on
  // each of those gestures, and the engine's tag watch for the ones made elsewhere.
  const preset = useVoiceWorkingPreset('pattern', pattern.id);
  const dirty = useVoiceDirty('pattern', pattern.id);

  const [notice, setNotice] = useState<string | null>(null);
  // Transient, so it is allowed to live here: collapsing the pane mid-rename cancels the
  // rename, which is the same thing pressing Escape would do. The state that must
  // survive an unmount is the unsaved edit, and that is in `voiceDrafts`; the open
  // sections are in `App`. The hook is shared with the rail — see
  // `voiceChrome.useNameForm` for the focus-return it carries.
  const {
    form: nameForm,
    setForm: setNameForm,
    open: openNameForm,
    close: closeNameForm,
  } = useNameForm();

  if (!preset) return null; // Unreachable: a pattern is open, so the lib resolves a voice.

  const currentKey = ref ? voiceKey(ref) : '';
  const listed =
    ref !== null &&
    [...voices.builtIns, ...voices.userVariants].some((option) => option.key === currentKey);
  const isBuiltIn = ref === null || ref.kind === 'default';

  /**
   * Every write in this pane, and its refusal.
   *
   * ⚠ THE SEAM READS THE DRAFT FRESH INSIDE THE CALL, which is why this pane no
   * longer keeps a ref to the live preset. `Knob` and `CabinetGraphic` register their
   * drag listeners on `window` at pointerdown and never re-register, so the whole
   * gesture runs against the handler captured then: a handler that closed over the
   * RENDERED preset would compare a drag's last value against the preset as it was
   * when the gesture started, and dragging away from a value and back would be the one
   * edit silently dropped (`setAtPath` returns the same object for a write that changes
   * nothing). Nothing below may re-introduce that closure — pass a path and a value,
   * never a preset built from `preset`.
   *
   * A refusal is rendered rather than swallowed, and cleared on the next write that
   * lands: `notice` describes a write that was rejected, and once the user is turning
   * knobs again it describes nothing.
   */
  const report = (result: Result<unknown>) => {
    setNotice(result.ok ? null : result.reason);
  };

  const write = (path: string, value: unknown) =>
    report(setVoiceParam('pattern', pattern.id, path, value));

  /** Throw the unsaved edit away and tell the engine. The seam notifies even when the
   *  pane is unmounted, which is what makes the live voice go back to the store. */
  const discard = () => discardVoiceDraft('pattern', pattern.id);

  /** guitar-tutor's answer, kept: one `window.confirm` in front of every switch that
   *  would strand the unsaved edit. Routed through one function so replacing it with a
   *  real dialog is a single edit.
   *
   *  Switching PATTERN is deliberately not one of them any more — the draft is keyed by
   *  pattern, so nothing is stranded and there is nothing to ask about. */
  const confirmDiscard = () =>
    !dirty || window.confirm('Discard unsaved changes to this voice?');

  const chooseVoice = (key: string) => {
    const next = parseVoiceKey(key);
    if (!next || !confirmDiscard()) return;
    setNameForm(null);
    // 'pattern', always: the same seam writes a TRACK's ref under 'track', and the
    // kind is never inferred. Its refusals are unreachable from this pane — the
    // holder is the open pattern and a picker never sends null — but they are
    // reported rather than dropped, like every other write here.
    const result = selectVoice('pattern', pattern.id, next);
    report(result);
    // Before `discard()`, deliberately: the user consented to losing the edit in
    // exchange for a switch, so a refused switch must not take it anyway.
    if (!result.ok) return;
    discard();
    // A SELECTION must not go through the draft store: recording the newly resolved
    // preset there would pin it as an unsaved edit and shadow the store. `refreshVoice`
    // is also what retires an edit abandoned behind this pane's back, and it is the
    // PATTERN arm's obligation — the track arm's caller must not make this call.
    refreshVoice();
  };

  const chooseInstrument = (next: FretInstrumentId) => {
    if (next === instrumentId || !confirmDiscard()) return;
    setNotice(null);
    setNameForm(null);
    discard();
    setEditingPatternInstrument(next);
    // The pattern's ref may not be resolvable on the new instrument; the lib's resolver
    // falls through to that instrument's first default, and this is what makes the
    // engine follow.
    refreshVoice();
  };

  const save = () => {
    const result = saveVoice('pattern', pattern.id, preset);
    if (!result.ok) {
      setNotice(REFUSAL_TEXT[result.reason]);
      return;
    }
    setNotice(null);
    // The store now holds what the draft held, so the draft has to go — otherwise a
    // later Save or rename against the same shared variant would never reach the
    // engine.
    discard();
  };

  const submitName = () => {
    if (!nameForm) return;
    const trimmed = nameForm.value.trim();

    if (nameForm.mode === 'save-as') {
      const result = saveVoiceAs('pattern', pattern.id, trimmed, preset);
      if (!result.ok) {
        setNotice(REFUSAL_TEXT[result.reason]);
        return;
      }
      setNotice(null);
      closeNameForm();
      // `saveVoiceAs` has already repointed the pattern at the new variant, so the draft
      // has to go — it was an edit OF the voice this one was made from. `refreshVoice`
      // and not the discard alone: Save as… can be pressed with nothing unsaved, and the
      // repoint still has to reach the engine.
      discard();
      refreshVoice();
      return;
    }

    if (ref?.kind !== 'user') return;
    const result = renameVoice(ref.id, trimmed);
    if (!result.ok) {
      setNotice(REFUSAL_TEXT[result.reason]);
      return;
    }
    // The draft carries the old name, and `saveVoice` writes the record's name back from
    // `preset.name` — so without this the next Save silently undoes the rename. A no-op
    // when nothing is unsaved, which is why it is not guarded on `dirty` here.
    //
    // Reported like every other write in this pane. Its refusal is unreachable today
    // only because `renameVoice` above rejects an empty name first, which is an
    // ordering accident rather than a guarantee.
    report(setVoiceName('pattern', pattern.id, trimmed));
    closeNameForm();
  };

  const remove = () => {
    if (ref?.kind !== 'user') return;
    if (
      !window.confirm(
        `Delete “${preset.name}”? Any pattern using it falls back to a built-in voice.`,
      )
    ) {
      return;
    }
    const result = deleteVoice('pattern', pattern.id, ref.id);
    if (!result.ok) {
      setNotice(REFUSAL_TEXT[result.reason]);
      return;
    }
    setNotice(null);
    setNameForm(null);
    discard();
    refreshVoice();
  };

  const toggleSection = (id: SectionId) =>
    onOpenSectionsChange(
      openSections.includes(id) ? openSections.filter((open) => open !== id) : [...openSections, id],
    );

  /**
   * Take a section from absent to present, or throw its whole branch away.
   *
   * The SEEDING rule — every required param gets its `fallback`, the optional ones are
   * left out so "unspecified" does not become a value the user never chose — lives in
   * `voiceDrafts.addVoiceSection`, where the agent reaches it too. This is the button.
   */
  const addSection = (section: ParamSection) =>
    report(addVoiceSection('pattern', pattern.id, section.id));

  const removeSection = (section: ParamSection) =>
    report(removeVoiceSection('pattern', pattern.id, section.id));

  /**
   * A sub-branch is created in ONE write, from the seed on its descriptor —
   * unlike a section, which is built out of its rows' fallbacks.
   *
   * That difference is the whole reason `ParamSubBranch` exists: a `VoiceLayer`
   * contains a `VoiceSource`, and no row fallback can produce one. A layer seeded
   * the row-by-row way would be `{ gainDb, octaveOffset }` with no source at all,
   * which is what `Voice._buildLayer` would hand to `buildSynth`. The seam owns
   * both rules; these two are the buttons.
   */
  const addSubBranch = (sub: ParamSubBranch) =>
    report(addVoiceSubBranch('pattern', pattern.id, sub.id));

  /** Absent, not bypassed: a sub-branch has no `enabled` flag — you have one or
   *  you don't — so this throws the tuning away, and the Add beside it says so. */
  const removeSubBranch = (sub: ParamSubBranch) =>
    report(removeVoiceSubBranch('pattern', pattern.id, sub.id));

  /**
   * One row of the table.
   *
   * `nameScope` prefixes the ACCESSIBLE name (never the engraving, which has a
   * 74 px column to live in). Passed for a sub-branch's rows, because those are
   * the primary's own descriptors generated under a second branch: an FM voice
   * with an FM layer puts two "Harmonicity" spinbuttons, two "Env attack"
   * sliders and two "Carrier" selects in one pane. The enclosing `role="group"`
   * does NOT name them — a group's name is announced on entry, not folded into a
   * descendant's accessible name — so the override is the only thing that tells
   * them apart to a listener. `ParamToggle` already does exactly this for the
   * stages' identically named bypasses.
   */
  const renderParam = (section: ParamStage, param: Param, nameScope?: string) => {
    const raw = getAtPath(preset, param.path);
    const id = domId(param.path);
    const scoped = (label: string) => (nameScope ? `${nameScope} ${label}` : undefined);

    switch (param.kind) {
      case 'slider':
        return (
          <ParamSlider
            key={param.path}
            id={id}
            label={param.label}
            ariaLabel={scoped(param.label)}
            value={typeof raw === 'number' ? raw : param.fallback}
            min={param.min}
            max={param.max}
            step={param.step}
            unit={param.unit}
            precision={param.precision}
            onChange={(value) => write(param.path, value)}
          />
        );

      case 'toggle':
        return (
          <ParamToggle
            key={param.path}
            id={id}
            label={param.label}
            // Every stage's bypass is labelled "Enabled", and Amp and Cabinet are open
            // together by default — so two switches called "Enabled" are in the
            // accessibility tree at once. Same problem, same answer as the Add/Remove
            // buttons below: the name carries the stage, the visible label stays short
            // because the label column is 74px wide.
            ariaLabel={scoped(param.label) ?? `${section.label} ${param.label}`}
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
            onChange={(next) => write(param.path, next)}
          />
        );

      case 'encoder':
        return (
          <ParamEncoder
            key={param.path}
            label={param.label}
            ariaLabel={scoped(param.label)}
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
            // Not the default placeholder ("Not in the registry"): there is no registry
            // of source kinds to be missing from — an unrecognised discriminant is a
            // stored variant this build cannot play.
            placeholder="Unrecognised source"
            // The seam does the branch swap — the discriminant cannot move on its
            // own, see `sourceDefaults.withSourceKind`, which replaces the whole
            // branch and returns the same object when the kind is unchanged.
            onChange={(next) => {
              if (!isSourceKind(next)) return;
              // Computed here only to know what to WARM: a fresh sampler is a fresh
              // set of banks nothing has fetched, and `reconcile` will not build a
              // graph on a silent page — same reason the pack picker warms. The
              // write itself goes through the seam by path and value.
              const swapped = withSourceKind(preset, next);
              if (swapped.source.kind === 'sampler') warmSampleBanks(swapped.source.samples);
              write(param.path, next);
            }}
          />
        );

      case 'sample-pack': {
        // A preset stores note→URL maps, not a pack id, so the active entry is found by
        // deep shape. `null` for a hand-authored map that matches no registered pack.
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
            // The seam takes the PACK ID and resolves the maps itself, so a caller
            // with no pointer addresses a registry entry rather than authoring a
            // sample map. `getSamplePack` is consulted here for the warm.
            onChange={(packId) => {
              const pack = getSamplePack(packId);
              if (!pack) return;
              warmSampleBanks(pack.samples);
              write(param.path, packId);
            }}
          />
        );
      }
    }
  };

  /**
   * The sub-branch's source picker.
   *
   * NOT `renderParam`'s `source-kind` case, and the difference is the write: that
   * one routes through `setVoiceParam`, which resolves a `source-kind` row with
   * `withSourceKind` — a function that takes no path and always replaces the
   * PRIMARY source. `setVoiceSubBranchKind` is the branch-aware seam, and it is
   * why the layer's picker is declared on `ParamSubBranch.kindRow` rather than in
   * `section.params`.
   */
  const renderSubBranchKind = (row: SourceKindParam, sub: ParamSubBranch) => (
    <ParamEnum
      key={row.path}
      id={domId(row.path)}
      label={row.label}
      // "Source" is also the primary's picker's label, and both are in the Source
      // stage at once — see `renderParam`'s note on why the group does not name it.
      ariaLabel={`${sub.label} ${row.label}`}
      value={row.resolve(getAtPath(preset, row.path))}
      options={row.options}
      // A stored kind the picker does not offer resolves fine and simply has no
      // option — `ParamEnum` shows this instead of silently selecting the first
      // entry. See `LAYER_SUB_BRANCH` for which kinds a layer is offered and why.
      placeholder="Not offered here"
      onChange={(next) => report(setVoiceSubBranchKind('pattern', pattern.id, sub.id, next))}
    />
  );

  /**
   * An optional branch nested inside a stage — the second source, and the body
   * filter's cutoff envelope.
   *
   * Drawn INSIDE its section rather than as a section of its own, which is the
   * shape the user asked for and the shape the thing is: a layer is part of what
   * makes the sound and has no bypass, and an envelope is part of the filter it
   * sweeps. `role="group"` with the sub-branch's own name is what carries that
   * containment to a screen reader.
   *
   * ⚠ THE GROUP'S NAME IS NOT WHAT TELLS THE LAYER'S "HARMONICITY" FROM THE
   * PRIMARY'S — an earlier version of this comment claimed it was. A group's
   * accessible name is announced on ENTERING it and does not contribute to any
   * descendant's own name, so on an FM voice with an FM layer a listener reading
   * the controls hears "Harmonicity" twice with nothing between them. The rows
   * are therefore rendered with `sub.label` as their name scope; the group stays
   * for the containment it does express.
   */
  const renderSubBranch = (section: ParamSection) => {
    const sub = section.subBranch;
    if (!sub) return null;
    const present = subBranchApplies(preset, sub);
    const kind = sub.kindRow ? sub.kindRow.resolve(getAtPath(preset, sub.kindRow.path)) : null;
    const offered = sub.kindRow?.options.some((option) => option.value === kind) ?? true;

    return (
      <div role="group" aria-label={sub.label} className="tray flex flex-col gap-1 rounded-lg p-1.5">
        <div className="flex items-center gap-1.5">
          <span className={voiceLabelClass}>{sub.label}</span>
          <span className="flex-1" />
          <button
            type="button"
            // Two sub-branches can be on screen at once and both buttons say
            // "Add" — the name carries which, exactly as the stage buttons do.
            aria-label={`${present ? 'Remove' : 'Add'} ${sub.label}`}
            onClick={() => (present ? removeSubBranch(sub) : addSubBranch(sub))}
            className={voiceButtonClass}
          >
            {present ? 'Remove' : 'Add'}
          </button>
        </div>

        {present ? (
          <>
            {sub.kindRow ? renderSubBranchKind(sub.kindRow, sub) : null}
            {branchParams(preset, section).map((param) =>
              renderParam(section, param, sub.label),
            )}
            {sub.id === 'body-filter-envelope' ? (
              <p className="font-mono text-[9px] leading-snug text-ink-mut">
                While this is here the envelope drives the cutoff, so the stage’s static
                Cutoff is put away — its value is kept and comes back if you remove this.
              </p>
            ) : null}
            {kind !== null && !offered ? (
              <p className="font-mono text-[9px] leading-snug text-ink-mut">
                This second source is a kind the editor does not offer for a layer, so its own
                settings are not shown. Its mix and octave are still yours; picking a kind above
                replaces it.
              </p>
            ) : null}
          </>
        ) : (
          <p className="font-mono text-[9px] leading-snug text-ink-mut">
            {sub.id === 'layer'
              ? 'No second source. Adding one mixes a quiet synth under every note, which you can then tune, transpose or remove.'
              : 'No cutoff envelope — the filter sits at a fixed cutoff, which is a sound of its own. Adding one sweeps the cutoff per note instead.'}
          </p>
        )}
      </div>
    );
  };

  /**
   * The same `SliderParam`, drawn as a rotary instead of a row.
   *
   * Every number it needs still comes from the descriptor — min, max, step, the readout's
   * precision and unit, and `fallback` as the double-click reset. Nothing about an amp's
   * ranges is known to the rack components, which is what keeps `paramSchema` the source
   * of truth after the renderer swap.
   *
   * No `id`: `Knob` labels itself through `aria-labelledby`, so there is no `<label
   * htmlFor>` to point anywhere. Its accessible name is still the descriptor's label.
   */
  const renderKnob = (param: SliderParam) => {
    const raw = getAtPath(preset, param.path);
    return (
      <Knob
        key={param.path}
        label={param.label}
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
   * The amp, as an amp: knobs on the plate, bypass as the power switch, model name
   * engraved on the face.
   *
   * Split by `kind` rather than by name, so a slider added to the schema appears as a
   * knob and an enum as a row without touching this file — the descriptor table stays in
   * charge of what exists.
   */
  /**
   * Put a pedal on the board, in ONE write from its seed — the sub-branch rule,
   * not `addSection`'s row-by-row one, and for a sharper version of the same
   * reason. `Voice.buildChain` reads every field of a pedal's params straight
   * into a Tone constructor the moment the branch exists, so a stage assembled
   * field by field is a node built with `undefined`s rather than one waiting to
   * be finished.
   */
  const addPedal = (pedal: Pedal) => report(addVoicePedal('pattern', pattern.id, pedal.id));

  /** Absent, not bypassed — this throws the pedal's tuning away, and the switch
   *  beside it is the non-lossy way to take it out of the chain. */
  const removePedal = (pedal: Pedal) => report(removeVoicePedal('pattern', pattern.id, pedal.id));

  /**
   * The pedalboard: six stages inside one always-present section.
   *
   * ── WHY THIS IS NOT SIX SECTIONS ─────────────────────────────────────────────
   *
   * Each pedal is independently present, bypassable and removable, which is
   * exactly what a `ParamSection` describes — so six sections is the obvious
   * shape and it is the wrong one. It would put six more stage headers in a rack
   * whose whole design argument is that TWO TRACKS' settings are comparable at
   * once, and the pedalboard is one thing a guitarist points at, not six.
   *
   * So the section is the board and this renderer draws the pedals on it. Each is
   * a `.tray` in the section's body — the same furniture a sub-branch uses, and
   * the same depth language that separates two racks in the stack, because the
   * question a reader has here is identical: where does one unit end and the next
   * begin.
   *
   * ── THE ORDER IS THE SIGNAL'S, AND IT IS FIXED ───────────────────────────────
   *
   * Top to bottom is `Voice.wireChain`'s build order, which is the order the
   * signal travels in. Nothing here can change it: the chain reads no order off
   * the preset, so a drag gesture would move a card and not a sound. That is a
   * lib change and it is deliberately not in this slice — a board that LOOKS
   * rearrangeable and is not would be worse than one that plainly is not.
   */
  const renderPedalsSection = () => (
    <div className="flex flex-col gap-1.5">
      {PEDALS.map((pedal) => {
        const present = sectionPresence(preset, pedal) !== 'absent';

        return (
          <div
            key={pedal.id}
            role="group"
            aria-label={pedal.label}
            className="tray flex flex-col gap-1 rounded-lg p-1.5"
          >
            <div className="flex items-center gap-1.5">
              <span className={voiceLabelClass}>{pedal.label}</span>
              {/* No bypassed note here, unlike a stage header. A stage's note exists
                  because the body it describes may be folded away; a pedal card
                  cannot fold, so its own `Enabled` switch is on screen saying
                  "Bypassed" in as many words. A second copy in the header would be
                  the same fact twice, and two things to keep in step. */}
              <span className="flex-1" />
              <button
                type="button"
                // Six of these are on screen at once and every one of them says
                // "Add" or "Remove" — so the name carries the pedal, exactly as the
                // stage and sub-branch buttons do.
                aria-label={`${present ? 'Remove' : 'Add'} ${pedal.label}`}
                onClick={() => (present ? removePedal(pedal) : addPedal(pedal))}
                className={voiceButtonClass}
              >
                {present ? 'Remove' : 'Add'}
              </button>
            </div>

            {present ? (
              // The pedal is the stage here, not the section: `renderParam` names a
              // toggle after the stage it belongs to, and six switches called
              // "Enabled" under one section would otherwise all be announced
              // "Pedals Enabled". `nameScope` does the same for the rest — four of
              // these pedals have a row called "Mix" and two have one called
              // "Feedback".
              visibleParams(preset, pedal).map((param) =>
                renderParam(pedal, param, pedal.label),
              )
            ) : (
              <p className="font-mono text-[9px] leading-snug text-ink-mut">
                Not on this voice. Adding it puts the pedal in the chain with its
                maker&rsquo;s starting values, which you can then tune, bypass or remove.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );

  const renderAmpSection = (section: ParamSection) => {
    // `ownParams`, not `visibleParams`: the generic path below already switched,
    // and `renderSubBranch` now runs after EVERY stage body. A gear renderer that
    // still asked for all the visible rows would draw a sub-branch's rows twice
    // the day Amp or Cabinet gains one.
    const rows = ownParams(preset, section);
    const power = enabledParamOf(section);
    const enabled = power ? getAtPath(preset, power.path) !== false : true;
    const rawModel = getAtPath(preset, AMP_MODEL_PATH);

    return (
      <>
        <AmpHead
          // What the chain would really build. `getAmpModel` falls back to Plexi for a
          // missing or unknown id, and a faceplate naming something that isn't loaded
          // would be the one lie the picker already refuses to tell.
          model={getAmpModel(typeof rawModel === 'string' ? rawModel : undefined).name}
          enabled={enabled}
          power={
            power
              ? {
                  label: `${section.label} ${power.label}`,
                  onChange: (next) => write(power.path, next),
                }
              : undefined
          }
        >
          {rows
            .filter((param): param is SliderParam => param.kind === 'slider')
            .map(renderKnob)}
        </AmpHead>
        {rows
          .filter((param) => param.kind !== 'slider' && param !== power)
          .map((param) => renderParam(section, param))}
        {renderSuggestedCab()}
      </>
    );
  };

  /**
   * The cabinet, as a cabinet. The mic dot picks the IR; the schema's `<select>` stays
   * underneath as the text-level route to the same value — it is also the only place the
   * registry's description of a capture is readable, which no dot can carry.
   */
  const renderCabinetSection = (section: ParamSection) => {
    // `ownParams` for the reason `renderAmpSection` states.
    const rows = ownParams(preset, section);
    const cab = rows.find(
      (param): param is EnumParam => param.kind === 'enum' && param.path === CAB_URL_PATH,
    );

    return (
      <>
        <div className="flex flex-wrap items-start gap-2">
          {cab ? (
            <CabinetGraphic
              url={cab.resolve(getAtPath(preset, cab.path))}
              onChange={(url) => write(cab.path, url)}
              bypassed={statusOf(preset, section) === 'bypassed'}
            />
          ) : null}
          <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
            {rows
              .filter((param): param is SliderParam => param.kind === 'slider')
              .map(renderKnob)}
          </div>
        </div>
        {rows
          .filter((param) => param.kind !== 'slider')
          .map((param) => renderParam(section, param))}
      </>
    );
  };

  /**
   * "Use suggested cab" — ours entirely. Every amp model names a cab pairing and the
   * lib's own comment calls the suggestion *documentary*: nothing in the engine applies
   * it. Offered only when it would change something.
   *
   * Writes the URL and nothing else, so it creates a cabinet branch on a preset with no
   * cabinet (valid — `url` is `CabIRParams`' only required field) without un-bypassing
   * one the user switched off on purpose.
   *
   * It also unfolds Cabinet: the button lives in the Amp section but every visible
   * consequence of pressing it is in another one, so with Cabinet closed the only
   * feedback would be the button disappearing.
   */
  const renderSuggestedCab = () => {
    const modelId = getAtPath(preset, AMP_MODEL_PATH);
    const model = getAmpModel(typeof modelId === 'string' ? modelId : undefined);
    const suggested = model.defaultCabIrId ? getCabinetIR(model.defaultCabIrId) : undefined;
    if (!suggested || getAtPath(preset, CAB_URL_PATH) === suggested.url) return null;

    return (
      <button
        type="button"
        onClick={() => {
          write(CAB_URL_PATH, suggested.url);
          if (!openSections.includes('cabinet')) onOpenSectionsChange([...openSections, 'cabinet']);
        }}
        className={`${voiceButtonClass} self-start`}
      >
        Use suggested cab · {suggested.label}
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      {/* ---- header: what is being edited, and what can be done to it ---------- */}
      <div className="flex flex-none flex-wrap items-center gap-x-2 gap-y-1">
        <label htmlFor="voice-instrument" className={`flex-none ${voiceLabelClass}`}>
          Instrument
        </label>
        <select
          id="voice-instrument"
          value={instrumentId}
          onChange={(event) => chooseInstrument(event.currentTarget.value as FretInstrumentId)}
          className={selectClass}
        >
          {INSTRUMENTS.map((instrument) => (
            <option key={instrument.id} value={instrument.id}>
              {instrument.name}
            </option>
          ))}
        </select>

        <label htmlFor="voice-preset" className={`flex-none ${voiceLabelClass}`}>
          Voice
        </label>
        <select
          id="voice-preset"
          value={currentKey}
          onChange={(event) => chooseVoice(event.currentTarget.value)}
          className={`${selectClass} flex-1`}
        >
          {/* The pattern has no voice of its own: it plays whatever the instrument's
              global active voice resolves to. Disabled because there is no way back —
              `voiceService` deliberately exposes no "clear the ref" write, since the
              global map is shared by every pattern without one. */}
          {ref === null && (
            <option value="" disabled>
              Instrument default
            </option>
          )}
          {/* A ref can outlive the voice it named, or name a variant for another
              instrument. Shown rather than silently replaced by the first option. */}
          {ref !== null && !listed && (
            <option value={currentKey} disabled>
              Unavailable voice
            </option>
          )}
          <optgroup label="Presets">
            {voices.builtIns.map((option) => (
              <option key={option.key} value={option.key}>
                {option.name}
              </option>
            ))}
          </optgroup>
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
      </div>

      <div className="flex flex-none flex-wrap items-center gap-x-1.5 gap-y-1">
        <DirtyPill dirty={dirty} />
        <span className="flex-1" />
        <button type="button" onClick={save} disabled={!dirty || isBuiltIn} className={voiceButtonClass}>
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
          disabled={isBuiltIn}
          className={voiceButtonClass}
        >
          Rename
        </button>
        <button type="button" onClick={remove} disabled={isBuiltIn} className={voiceButtonClass}>
          Delete
        </button>
      </div>

      {/* Why Save is refused, stated where the refusal is — a disabled button with no
          reason is the thing this pane is most likely to be blamed for. */}
      {isBuiltIn && (
        <p className="flex-none font-mono text-[9px] leading-snug text-ink-mut">
          {ref === null ? REFUSAL_TEXT['no-voice'] : REFUSAL_TEXT['built-in']}
        </p>
      )}

      {nameForm && (
        <NameForm
          form={nameForm}
          inputId="voice-name"
          onChange={(value) => setNameForm({ ...nameForm, value })}
          onSubmit={submitName}
          onCancel={closeNameForm}
        />
      )}

      {/* Mounted always, `sr-only` when empty: a live region has to exist *before* its
          content changes to be announced, and sr-only costs no layout. */}
      <p
        role="status"
        className={
          notice ? 'flex-none font-mono text-[9px] leading-snug text-brass-hi' : 'sr-only'
        }
      >
        {notice}
      </p>

      {/* ---- the sections. Nothing scrolls here: the rack is as tall as it is, and
           the pane stack is what scrolls when the panes together outgrow it. ----- */}
      <div className="flex flex-col gap-1.5">
        {PARAM_SECTIONS.map((section) => {
          const status = statusOf(preset, section);
          const open = openSections.includes(section.id);

          return (
            <VoiceSection
              key={section.id}
              label={section.label}
              status={status}
              open={open}
              onToggle={() => toggleSection(section.id)}
              actions={
                section.removableBranch ? (
                  <button
                    type="button"
                    // Two sections can be removable at once, and "Remove, button" twice
                    // over is unusable — so the name carries the stage even though the
                    // label doesn't need to.
                    aria-label={`${status === 'absent' ? 'Add' : 'Remove'} ${section.label}`}
                    onClick={() =>
                      status === 'absent' ? addSection(section) : removeSection(section)
                    }
                    className={voiceButtonClass}
                  >
                    {status === 'absent' ? `Add ${section.label}` : 'Remove'}
                  </button>
                ) : null
              }
            >
              {status !== 'absent' ? (
                <>
                  {/* Amp and Cabinet are gear and are drawn as gear; Pedals is a
                      board of them and is drawn as one. Source, Body filter and Level
                      are not — a sample pack is a list and a fader is a fader — so
                      they keep the descriptor-driven rows. */}
                  {section.id === 'amp'
                    ? renderAmpSection(section)
                    : section.id === 'cabinet'
                      ? renderCabinetSection(section)
                      : section.id === 'pedals'
                        ? renderPedalsSection()
                        : ownParams(preset, section).map((param) => renderParam(section, param))}
                  {renderSubBranch(section)}
                </>
              ) : (
                /* Only a removable section can be absent: Source and Level both have a
                   null probe, so `sectionApplies` is true for them on every preset. */
                <p className="font-mono text-[9px] leading-snug text-ink-mut">
                  This preset has no {section.label.toLowerCase()} stage at all. Adding one seeds
                  it with neutral values you can then tune.
                </p>
              )}
            </VoiceSection>
          );
        })}
      </div>
    </div>
  );
}
