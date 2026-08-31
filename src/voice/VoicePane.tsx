/**
 * The Instrument & Amp pane — the UI over `voiceService` and `paramSchema`.
 *
 * Every control in here is one row of `PARAM_SECTIONS`, addressed into the preset by
 * `presetPaths`. That is the whole design: the pane renders a table, so adding the
 * compressor or the EQs later is a change to the descriptors, not to this file.
 *
 * THE WORKING COPY. Edits do not go into the voice store. They accumulate in a working
 * preset held by `App` (not here — `PaneStack` unmounts a collapsed pane's body and
 * would forget it), pushed at the engine on every change so the next note sounds like
 * the pane looks, and written to the store only by Save / Save as…. Three consequences
 * worth knowing before changing anything:
 *
 *   - A voice is a SHARED asset. Save overwrites the variant for every pattern pointing
 *     at it, which is intended and was decided with the user. There is no per-pattern
 *     fork.
 *   - The fourteen built-in slots are readonly lib consts with no setter anywhere, so
 *     Save is *impossible* for them, not merely discouraged. The button is disabled and
 *     the pane says why — guitar-tutor's Sound Lab shipped exactly this wording.
 *   - The working copy is keyed (see `workingKey`). Switch voice, instrument or pattern
 *     and it stops applying — which is why every switch confirms first.
 */
import { useEffect, useRef, useState } from 'react';
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
} from '../patterns/patternService';
import { applyVoicePreset, refreshVoice } from '../audio/playbackService';
import {
  deleteVoice,
  parseVoiceKey,
  renameVoice,
  saveVoice,
  saveVoiceAs,
  selectVoice,
  useEditingVoicePreset,
  useEditingVoiceRef,
  useSelectableVoices,
  voiceKey,
  type VoiceRefusal,
} from './voiceService';
import {
  PARAM_SECTIONS,
  enabledParamOf,
  paramApplies,
  sectionPresence,
  visibleParams,
  type EnumParam,
  type Param,
  type ParamSection,
  type SectionId,
  type SliderParam,
} from './paramSchema';
import { isSourceKind, withSourceKind } from './sourceDefaults';
import { getAtPath, removeAtPath, setAtPath } from './presetPaths';
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
import { AuditionButton } from './AuditionButton';

/** An unsaved edit, tagged with the voice it belongs to. Lives in `App`. */
export interface WorkingVoice {
  readonly key: string;
  readonly preset: VoicePreset;
}

const INSTRUMENTS = listInstruments();

/** Every refusal `voiceService` can return is a state this pane can be in, so each one
 *  needs a sentence. `built-in` is Sound Lab's shipped wording, kept verbatim. */
const REFUSAL_TEXT: Record<VoiceRefusal, string> = {
  ...SHARED_VOICE_REFUSAL_TEXT,
  // The two that name the holder, and so cannot be shared with the rail.
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
 * What stays ours is the *rate*, and it is ours permanently rather than a masked gap: a
 * native `<select>` fires `change` once per arrow key while closed, so a keyboard user
 * stepping through the eight packs passes through every one of them, and the
 * Philharmonia pack alone is ~45 MP3s. The lib has no idea it is behind a `<select>`.
 * The window borrows `playbackService`'s rebuild window, so walking the list warms only
 * where it stops.
 *
 * No dedupe set here: `prefetchSampleBanks` is documented idempotent and the browser's
 * HTTP cache absorbs a repeat, so re-selecting a pack costs a cache hit, not a download.
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
  working,
  onWorkingChange,
  openSections,
  onOpenSectionsChange,
}: {
  working: WorkingVoice | null;
  onWorkingChange: (working: WorkingVoice | null) => void;
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
      working={working}
      onWorkingChange={onWorkingChange}
      openSections={openSections}
      onOpenSectionsChange={onOpenSectionsChange}
    />
  );
}

function VoiceEditor({
  pattern,
  working,
  onWorkingChange,
  openSections,
  onOpenSectionsChange,
}: {
  pattern: Pattern;
  working: WorkingVoice | null;
  onWorkingChange: (working: WorkingVoice | null) => void;
  openSections: readonly SectionId[];
  onOpenSectionsChange: (open: readonly SectionId[]) => void;
}) {
  const instrumentId = patternInstrumentId(pattern);
  const ref = useEditingVoiceRef();
  const stored = useEditingVoicePreset();
  const voices = useSelectableVoices(instrumentId);

  const [notice, setNotice] = useState<string | null>(null);
  // Transient, so it is allowed to live here: collapsing the pane mid-rename cancels the
  // rename, which is the same thing pressing Escape would do. The working copy and the
  // open sections are the state that must survive, and they are in `App`. The hook is
  // shared with the rail — see `voiceChrome.useNameForm` for the focus-return it carries.
  const {
    form: nameForm,
    setForm: setNameForm,
    open: openNameForm,
    close: closeNameForm,
  } = useNameForm();

  // Mirrors `playbackService`'s `workingTagOf`: pattern + instrument + ref. The pattern id
  // is in it because an unsaved edit belongs to the editor that is open, while two
  // patterns sharing a voice legitimately share the *saved* one.
  const workingKey = `${pattern.id}|${instrumentId}|${ref ? voiceKey(ref) : 'none'}`;
  const dirty = working !== null && working.key === workingKey;
  const preset = dirty ? working.preset : stored;

  // Retire a copy whose key has stopped matching. Every switch made *through this pane*
  // already clears it; this catches the ones made behind its back — an undo that restores
  // a `Pattern` snapshot carrying a different `voiceRef`, say.
  //
  // `applyVoicePreset(null)` and not merely `onWorkingChange(null)`: the engine keeps its
  // own tagged copy, and that one self-clears only when something *consults* it. Nothing
  // here does. Drop only the pane's and a redo back to the original ref makes the tag
  // match again, so the abandoned edit is what plays while the pane says "Saved".
  useEffect(() => {
    if (working === null || working.key === workingKey) return;
    onWorkingChange(null);
    applyVoicePreset(null);
  }, [working, workingKey, onWorkingChange]);

  /**
   * The live preset, for `commit`'s identity guard. See the comment there — a drag
   * transport calls the `onChange` it captured at pointerdown, so `commit` would
   * otherwise be comparing against the preset as it was when the gesture started.
   */
  const presetRef = useRef<VoicePreset | null>(null);
  useEffect(() => {
    presetRef.current = preset ?? null;
  });

  if (!preset) return null; // Unreachable: a pattern is open, so the lib resolves a voice.

  const currentKey = ref ? voiceKey(ref) : '';
  const listed =
    ref !== null &&
    [...voices.builtIns, ...voices.userVariants].some((option) => option.key === currentKey);
  const isBuiltIn = ref === null || ref.kind === 'default';

  /**
   * Record an edit and make it audible.
   *
   * The identity check is not an optimisation: `setAtPath` returns the SAME object when
   * the write changes nothing, so a control reporting its current value must not mark the
   * preset dirty.
   *
   * AGAINST `presetRef`, NOT AGAINST `preset`. `Knob` and `CabinetGraphic` register their
   * drag listeners on `window` at pointerdown and never re-register, so the whole gesture
   * runs against the `onChange` — and so the `preset` — captured at pointerdown. Drag a
   * knob away from its starting value and back and `setAtPath(startPreset, path,
   * startValue)` returns `startPreset` itself, which is exactly what the captured `preset`
   * is: the edit that restores the original value would be the one edit silently dropped.
   * The ref holds the preset as it is *now*, which is what the guard means.
   *
   * A refusal is cleared here rather than left standing: `notice` describes a write that
   * was rejected, and once the user is turning knobs again it describes nothing.
   */
  const commit = (next: VoicePreset) => {
    if (next === (presetRef.current ?? preset)) return;
    setNotice(null);
    onWorkingChange({ key: workingKey, preset: next });
    applyVoicePreset(next);
  };

  /** guitar-tutor's answer, kept: one `window.confirm` in front of every switch that
   *  would strand the working copy. Routed through one function so replacing it with a
   *  real dialog is a single edit. */
  const confirmDiscard = () =>
    !dirty || window.confirm('Discard unsaved changes to this voice?');

  const chooseVoice = (key: string) => {
    const next = parseVoiceKey(key);
    if (!next || !confirmDiscard()) return;
    setNotice(null);
    setNameForm(null);
    onWorkingChange(null);
    selectVoice(next);
    // Not `applyVoicePreset`: pushing the newly resolved preset through it would pin it
    // as an unsaved working copy and shadow the store. `refreshVoice` is also what
    // retires the edit just abandoned.
    refreshVoice();
  };

  const chooseInstrument = (next: FretInstrumentId) => {
    if (next === instrumentId || !confirmDiscard()) return;
    setNotice(null);
    setNameForm(null);
    onWorkingChange(null);
    setEditingPatternInstrument(next);
    // The pattern's ref may not be resolvable on the new instrument; the lib's resolver
    // falls through to that instrument's first default, and this is what makes the
    // engine follow.
    refreshVoice();
  };

  const save = () => {
    const result = saveVoice(preset);
    if (!result.ok) {
      setNotice(REFUSAL_TEXT[result.reason]);
      return;
    }
    setNotice(null);
    onWorkingChange(null);
    // The store now holds what the working copy held, so the copy has to go — otherwise
    // a later Save or rename against the same shared variant would never reach the
    // engine.
    applyVoicePreset(null);
  };

  const submitName = () => {
    if (!nameForm) return;
    const trimmed = nameForm.value.trim();

    if (nameForm.mode === 'save-as') {
      const result = saveVoiceAs(trimmed, preset);
      if (!result.ok) {
        setNotice(REFUSAL_TEXT[result.reason]);
        return;
      }
      setNotice(null);
      closeNameForm();
      // `saveVoiceAs` has already repointed the pattern at the new variant.
      onWorkingChange(null);
      applyVoicePreset(null);
      return;
    }

    if (ref?.kind !== 'user') return;
    const result = renameVoice(ref.id, trimmed);
    if (!result.ok) {
      setNotice(REFUSAL_TEXT[result.reason]);
      return;
    }
    // The working copy carries the old name, and `saveVoice` writes the record's name
    // back from `preset.name` — so without this the next Save silently undoes the rename.
    if (dirty) onWorkingChange({ key: workingKey, preset: { ...preset, name: trimmed } });
    setNotice(null);
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
    const result = deleteVoice(ref.id);
    if (!result.ok) {
      setNotice(REFUSAL_TEXT[result.reason]);
      return;
    }
    setNotice(null);
    setNameForm(null);
    onWorkingChange(null);
    refreshVoice();
  };

  const toggleSection = (id: SectionId) =>
    onOpenSectionsChange(
      openSections.includes(id) ? openSections.filter((open) => open !== id) : [...openSections, id],
    );

  /**
   * Take a section from absent to present by seeding every REQUIRED param with its
   * `fallback` — which is why some fallbacks in the schema are not zero. The optional
   * ones are left out on purpose: the lib documents its own default for each, and writing
   * our guess would turn "unspecified" into a value the user never chose.
   */
  const addSection = (section: ParamSection) => {
    let next = preset;
    for (const param of section.params) {
      if (param.optional) continue;
      if (!paramApplies(next, param)) continue;
      // A `switch` rather than a list of kinds to skip, and the exhaustive `default` is
      // the point: `source-kind` and `sample-pack` are both rows whose value is NOT what
      // `setAtPath(path, fallback)` would write — a bare `source.kind: 'sampler'` leaves
      // `source.params` beside a sampler tag with no banks, the malformed union
      // `sourceDefaults` exists to make unrepresentable. Unreachable today (no section
      // holding one is removable, so nothing calls this for them), which is exactly why
      // it has to be a `tsc` failure rather than a silent write the day one is.
      switch (param.kind) {
        case 'slider':
        case 'encoder':
        case 'enum':
        case 'toggle':
          next = setAtPath(next, param.path, param.fallback);
          break;
        case 'sample-pack':
        case 'source-kind':
          break;
        default:
          param satisfies never;
      }
    }
    commit(next);
  };

  const removeSection = (section: ParamSection) => {
    if (!section.removableBranch) return;
    commit(removeAtPath(preset, section.removableBranch));
  };

  const renderParam = (section: ParamSection, param: Param) => {
    const raw = getAtPath(preset, param.path);
    const id = domId(param.path);

    switch (param.kind) {
      case 'slider':
        return (
          <ParamSlider
            key={param.path}
            id={id}
            label={param.label}
            value={typeof raw === 'number' ? raw : param.fallback}
            min={param.min}
            max={param.max}
            step={param.step}
            unit={param.unit}
            precision={param.precision}
            onChange={(value) => commit(setAtPath(preset, param.path, value))}
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
            ariaLabel={`${section.label} ${param.label}`}
            value={typeof raw === 'boolean' ? raw : param.fallback}
            onChange={(value) => commit(setAtPath(preset, param.path, value))}
          />
        );

      case 'enum':
        return (
          <ParamEnum
            key={param.path}
            id={id}
            label={param.label}
            value={param.resolve(raw)}
            options={param.options}
            badgeOf={param.badgeOf}
            onChange={(next) => commit(setAtPath(preset, param.path, next))}
          />
        );

      case 'encoder':
        return (
          <ParamEncoder
            key={param.path}
            label={param.label}
            value={typeof raw === 'number' ? raw : param.fallback}
            step={param.step}
            precision={param.precision}
            unit={param.unit}
            fallback={param.fallback}
            onChange={(value) => commit(setAtPath(preset, param.path, value))}
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
            // NOT `setAtPath(preset, param.path, …)`. The discriminant cannot move
            // on its own — see `sourceDefaults.withSourceKind`, which swaps the
            // whole branch and returns the same object when the kind is unchanged.
            onChange={(next) => {
              if (!isSourceKind(next)) return;
              const swapped = withSourceKind(preset, next);
              // A fresh sampler is a fresh set of banks nothing has fetched, and
              // `reconcile` will not build a graph on a silent page — same reason
              // the pack picker warms.
              if (swapped.source.kind === 'sampler') warmSampleBanks(swapped.source.samples);
              commit(swapped);
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
            onChange={(packId) => {
              const pack = getSamplePack(packId);
              if (!pack) return;
              warmSampleBanks(pack.samples);
              commit(setAtPath(preset, param.path, pack.samples));
            }}
          />
        );
      }
    }
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
        onChange={(value) => commit(setAtPath(preset, param.path, value))}
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
  const renderAmpSection = (section: ParamSection) => {
    const rows = visibleParams(preset, section);
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
                  onChange: (next) => commit(setAtPath(preset, power.path, next)),
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
    const rows = visibleParams(preset, section);
    const cab = rows.find(
      (param): param is EnumParam => param.kind === 'enum' && param.path === CAB_URL_PATH,
    );

    return (
      <>
        <div className="flex flex-wrap items-start gap-2">
          {cab ? (
            <CabinetGraphic
              url={cab.resolve(getAtPath(preset, cab.path))}
              onChange={(url) => commit(setAtPath(preset, cab.path, url))}
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
          commit(setAtPath(preset, CAB_URL_PATH, suggested.url));
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

        <AuditionButton />
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
                // Amp and Cabinet are gear and are drawn as gear. Source and Level are
                // not — a sample pack is a list and a fader is a fader — so they keep
                // the descriptor-driven rows.
                section.id === 'amp' ? (
                  renderAmpSection(section)
                ) : section.id === 'cabinet' ? (
                  renderCabinetSection(section)
                ) : (
                  <>
                    {visibleParams(preset, section).map((param) => renderParam(section, param))}
                  </>
                )
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
