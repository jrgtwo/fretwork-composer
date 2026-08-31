/**
 * The voice editor as data.
 *
 * Every control in the voice pane is one row of this table, addressed into the
 * `VoicePreset` by the dotted paths `presetPaths.ts` understands. guitar-tutor's
 * Sound Lab hand-wrote a JSX block per parameter across 2,000 lines; the
 * structure here deliberately is not — a table is what lets `paramSchema.test.ts`
 * assert every path and range against every built-in preset, which hand-written
 * JSX can never do.
 *
 * ⚠ THE NUMBERS ARE NOT SOUND LAB'S. Every bound below is either the range Tone
 * publishes on `https://tonejs.github.io/` for the node the lib builds, cited by
 * page beside it, or — where that page gives a `Min:`/`Max:` for a property's
 * neighbours and deliberately gives none for this one — no bound at all, in which
 * case the row is an `encoder` rather than a `slider`. Sound Lab's ranges were
 * lifted wholesale by an earlier attempt and were wrong in both directions (its
 * attack-noise fader stops at 1 where Tone documents 20; its dampening runs to
 * 8000 where Tone documents 7000). They are not a source. Neither is a shipped
 * preset: the fourteen are preselected settings, so a value of theirs falling
 * outside a documented range means the PRESET is stale — see `STALE_PRESET_VALUES`
 * in the test.
 *
 * SCOPE: Source, Amp, Cabinet, Level. The lib exposes ~95 tunable params; body
 * filter, compressor, the pedals, the EQs, per-voice reverb and the sub-body
 * layer are a later slice and are deliberately NOT declared here. Declaring a
 * param the pane cannot honour is worse than omitting it.
 *
 * CONDITIONAL ROWS — the mechanism the Source section needed. A section's
 * presence is one probe for the whole section (`presenceProbe`), which cannot say
 * "this row only when the source is an FM synth": the Source section is present
 * on every preset and it is the ROWS that differ, thirteen of them for `fm-synth`
 * against two for `sampler`. So `ParamCommon.appliesWhen` is a per-row condition,
 * evaluated by `paramApplies`.
 *
 * It is DATA (a path and a set of accepted values), not a predicate function, and
 * that is the whole design decision. A `(preset) => boolean` would be shorter to
 * write and unfalsifiable to test: the schema test walks rows exhaustively and has
 * to be able to build — or pick — a preset each row applies to, which it can do
 * from `{path, oneOf}` and cannot do from an opaque closure. It is also the reason
 * the deferred `layer` slice gets this for free: a second source's rows are the
 * same rows under `layer.source.kind`.
 *
 * ABSENT vs BYPASSED. Both states are reachable from a stock built-in and they are
 * not the same: `ACOUSTIC_GUITAR_PRESET` has no `effects` object at all, while a
 * preset with `effects.amp.enabled === false` keeps a fully tuned amp out of the
 * chain. `ParamSection.presenceProbe` is what the pane tests for absence; the
 * `enabled` toggle inside a section's params is bypass. `removableBranch` is
 * separate again — a section can be absent-able without being removable (you
 * cannot delete a preset's source).
 */

import {
  AMP_MODELS,
  CABINET_IRS,
  DEFAULT_AMP_MODEL_ID,
  SAMPLE_PACKS,
  detectCabinetIR,
  getAmpModel,
  type OscillatorType,
  type VoicePreset,
} from '@fretwork/lib';
import { getAtPath, hasBranchAtPath } from './presetPaths';
import {
  SOURCE_KIND_LABELS,
  TONE_FM_DEFAULTS,
  TONE_PLUCK_DEFAULTS,
  isSourceKind,
  type VoiceSourceKind,
} from './sourceDefaults';

// ------------------------------------------------------------- descriptors ---

/** Option for an `enum` param. `value` is written to the preset verbatim. */
export interface EnumOption {
  readonly value: string;
  readonly label: string;
  /** Shown under the picker, the way Sound Lab describes the selected amp. */
  readonly description?: string;
}

/**
 * Option for the `sample-pack` param. `id` names a lib `SamplePack`; what gets
 * written to the preset is that pack's `samples` array, because the preset stores
 * note→URL maps and not a pack id. Reading back the current selection therefore
 * needs the lib's `detectSamplePack`, not an equality check on the path value.
 */
export interface SamplePackOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

/**
 * "Only when the value at `path` is one of `oneOf`."
 *
 * Deliberately a string comparison and nothing else: every condition this editor
 * needs is on a union discriminant (`source.kind`, and `layer.source.kind` when
 * that slice lands), and a richer predicate language would be a small query
 * engine nobody asked for. See the header for why it is data rather than a
 * function.
 */
export interface ParamCondition {
  readonly path: string;
  readonly oneOf: readonly string[];
}

interface ParamCommon {
  /** Dotted path into the preset, for `presetPaths`. */
  readonly path: string;
  readonly label: string;
  /**
   * When set, this row exists only on presets satisfying it — absent from the
   * pane, refused by the seams, and skipped by the schema test's range walk on
   * any preset it does not apply to. Evaluate with `paramApplies` (below), never
   * by reading the condition at a call site, so the pane and the test cannot
   * drift into two definitions of "this control is here".
   */
  readonly appliesWhen?: ParamCondition;
  /**
   * Set when the lib's type declares this field optional, so a preset whose section
   * is present may still not carry it and `fallback` stands in. Without it, the
   * pane cannot tell "omitted, use the default" from "the path is wrong", and the
   * schema test could not insist that required paths actually resolve.
   */
  readonly optional?: true;
  /**
   * Set when applying this edit forces the `Voice` to rebuild its source rather than
   * retune in place.
   *
   * This used to mark a correctness hazard — `swapPreset` disposed without rebuilding
   * on a kind change (gap 9a) and never reconstructed sampler banks (gap 9b), so these
   * edits had to bypass it entirely. Both are fixed upstream.
   *
   * It now marks *cost*: rebuilding a sampler constructs one `Tone.Sampler` per bank
   * and starts an HTTP load each. A pane can use this to hold such a control until
   * pointer-up rather than firing per pointermove — an optimisation on top of
   * `playbackService`'s coalescing, not the thing that makes the edit work.
   */
  readonly rebuildsVoice?: true;
}

export interface SliderParam extends ParamCommon {
  readonly kind: 'slider';
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit?: string;
  /** Decimal places when rendering the value. */
  readonly precision: number;
  /**
   * The value to use when `path` is absent. Two cases, and they want the same
   * number: an optional lib field the preset simply omits (`inputGainDb`,
   * `makeupDb`, sampler `release`), and a field that is REQUIRED inside an
   * optional branch — where absent means the whole section is absent, so this is
   * what the pane seeds when it creates the branch. That second case is why some
   * fallbacks here are not zero.
   */
  readonly fallback: number;
}

export interface EnumParam extends ParamCommon {
  readonly kind: 'enum';
  readonly options: readonly EnumOption[];
  /** Same dual role as `SliderParam.fallback`. Always one of `options`. */
  readonly fallback: string;
  /**
   * Which option a stored value selects, or `null` for "the registry has never
   * heard of this" — which the picker then admits rather than papering over.
   *
   * On the descriptor rather than in the pane because the two enums resolve
   * *differently* and neither rule is generic: an amp id goes through the lib's
   * own fallback, a cabinet is stored as a URL and has to be recognised by
   * `detectCabinetIR`. A pane-side `if (path === …)` chain would silently run the
   * next enum the schema declares through the wrong one.
   */
  readonly resolve: (raw: unknown) => string | null;
  /** Extra word after an option's label in the picker — the amp model's category.
   *  Here for the same reason as `resolve`: it is per-registry, not per-pane. */
  readonly badgeOf?: (value: string) => string | undefined;
}

export interface ToggleParam extends ParamCommon {
  readonly kind: 'toggle';
  /** Every `enabled` field in the lib's params types documents `undefined` as
   *  implicit-on, for back-compat with variants stored before the field existed. */
  readonly fallback: boolean;
}

export interface SamplePackParam extends ParamCommon {
  readonly kind: 'sample-pack';
  readonly options: readonly SamplePackOption[];
}

/**
 * A value Tone publishes NO bound for, on a page that publishes bounds for its
 * neighbours. Rendered by `controls/ParamEncoder` — an endless rotary with no end
 * stops — because a `slider` cannot exist without a `min` and a `max`, and an
 * invented one is indistinguishable in the UI from a documented one. The user
 * would then tune against a fence that is not there.
 *
 * `step` and `precision` are the increment and the readout, and they are UI
 * choices about what is comfortable to turn — NOT claims about what the synth
 * accepts. Each is commented as such at its row.
 */
export interface EncoderParam extends ParamCommon {
  readonly kind: 'encoder';
  readonly step: number;
  readonly precision: number;
  readonly unit?: string;
  /** Same dual role as `SliderParam.fallback`, and additionally the encoder's
   *  double-click reset target. */
  readonly fallback: number;
}

/**
 * The one row that does not write its own path.
 *
 * `path` is `source.kind` because that is where the value is READ from, and it
 * has to be a real path so the schema test can walk it like any other. The WRITE
 * is `sourceDefaults.withSourceKind`, which replaces the whole `source` branch:
 * setting the discriminant alone would leave a sampler's `samples` array beside
 * an `fm-synth` tag, an object matching no arm of `VoiceSource`. That asymmetry
 * is why this is its own `kind` rather than an `enum` — a distinct discriminant
 * means every `switch (param.kind)` in the app has to decide what to do about it
 * instead of silently falling into the generic `setAtPath`.
 */
export interface SourceKindParam extends ParamCommon {
  readonly kind: 'source-kind';
  readonly options: readonly EnumOption[];
  readonly fallback: VoiceSourceKind;
  readonly resolve: (raw: unknown) => string | null;
}

export type Param =
  | SliderParam
  | EnumParam
  | ToggleParam
  | SamplePackParam
  | EncoderParam
  | SourceKindParam;

export type SectionId = 'source' | 'amp' | 'cabinet' | 'level';

export interface ParamSection {
  readonly id: SectionId;
  readonly label: string;
  /**
   * Path that must resolve to an object or array for this section to apply at all.
   * `null` means the section reads always-present parts of the preset, so it is
   * never absent. Evaluate it with `sectionApplies` (below) — never with `hasPath`,
   * which answers key presence and would call a `cabIR: undefined` preset "has a
   * cabinet".
   */
  readonly presenceProbe: string | null;
  /**
   * Branch `removeAtPath` deletes to take the section back to absent. `null` = the
   * section cannot be removed. Every param in the section lives under it when set,
   * because removing the branch has to remove the whole section.
   */
  readonly removableBranch: string | null;
  readonly params: readonly Param[];
}

// ------------------------------------------------------------ option lists ---

const AMP_MODEL_OPTIONS: readonly EnumOption[] = AMP_MODELS.map((model) => ({
  value: model.id,
  label: model.name,
  description: model.description,
}));

/**
 * The preset stores the IR's URL, not its id, so the URL is the option value and a
 * plain equality check highlights the active cab.
 *
 * KNOWN LOSS vs. Sound Lab, accepted: it keys the select on the IR id via
 * `detectCabinetIR(url)` and renders a `Custom URL (…)` option when nothing matches,
 * so an unregistered URL stays selectable. Here it renders as nothing-selected. The
 * same applies to `effects.amp.modelId`, where an unknown id shows nothing selected
 * while `getAmpModel` silently builds Plexi. Nothing in this slice can author an
 * unlisted value (custom IRs and custom sample JSON are both deferred), so the only
 * way to reach it is a variant Sound Lab wrote. Closing it means an `allowUnlisted`
 * affordance on `EnumParam`, which belongs with the slice that can create one.
 */
const CABINET_OPTIONS: readonly EnumOption[] = CABINET_IRS.map((ir) => ({
  value: ir.url,
  label: ir.label,
  description: ir.description,
}));

/** Every registered pack, unfiltered — deliberate parity with Sound Lab, which also
 *  offers `empty` and the two piano demos on a guitar. A descriptor has no
 *  instrument in hand to filter on; narrowing the offered set belongs to the pane,
 *  which knows the preset's `instrumentId`. */
const SAMPLE_PACK_OPTIONS: readonly SamplePackOption[] = SAMPLE_PACKS.map((pack) => ({
  id: pack.id,
  label: pack.label,
  description: pack.description,
}));

/**
 * What a voice can be made from. Derived from `SOURCE_KIND_LABELS`, which is a
 * `Record` keyed by the lib's own union, so a fourth source kind is a `tsc`
 * failure there rather than an option missing here.
 */
const SOURCE_KIND_OPTIONS: readonly EnumOption[] = (
  Object.entries(SOURCE_KIND_LABELS) as ReadonlyArray<[VoiceSourceKind, string]>
).map(([value, label]) => ({ value, label }));

/**
 * Oscillator shapes. Same trick and same reason: a `Record<OscillatorType, …>`
 * cannot omit a member or invent one, so this list is the lib's type made
 * enumerable rather than a second copy of it that can rot.
 *
 * No `description` — the four are named after their own waveforms, and Tone
 * documents nothing further about them (`classes/FMSynth.html`).
 */
const WAVEFORM_LABELS: Record<OscillatorType, string> = {
  sine: 'Sine',
  square: 'Square',
  sawtooth: 'Sawtooth',
  triangle: 'Triangle',
};

const WAVEFORM_OPTIONS: readonly EnumOption[] = (
  Object.entries(WAVEFORM_LABELS) as ReadonlyArray<[OscillatorType, string]>
).map(([value, label]) => ({ value, label }));

/** `Object.hasOwn`, not `in` — see `sourceDefaults.isSourceKind` for the
 *  prototype-chain hole `in` leaves open. */
const resolveWaveform = (raw: unknown): string | null =>
  typeof raw === 'string' && Object.hasOwn(WAVEFORM_LABELS, raw) ? raw : null;

/** `source.kind` on an FM synth, spelled once — every FM row carries it. */
const WHEN_FM: ParamCondition = { path: 'source.kind', oneOf: ['fm-synth'] };
const WHEN_PLUCK: ParamCondition = { path: 'source.kind', oneOf: ['pluck-synth'] };
const WHEN_SAMPLER: ParamCondition = { path: 'source.kind', oneOf: ['sampler'] };

/**
 * One envelope's four rows, twice over: `FMSynthParams` carries an amplitude
 * `envelope` and a `modulationEnvelope`, both `ADSREnvelope`, both driving a
 * `Tone.Envelope`. Generated rather than written out so the two cannot acquire
 * different ranges — the bounds are a property of the NODE, and there is one
 * node type here.
 *
 * Ranges: `classes/Envelope.html` publishes `Min: 0 / Max: 2` on `attack`, the
 * same on `decay`, `Min: 0 / Max: 5` on `release`, and NOTHING on `sustain` —
 * which is why sustain is the encoder of the four. `steps` and `precision` are
 * readout choices; each is fine enough to land every value the lib's own FM
 * presets carry on the grid.
 *
 * ⚠ TWO ROWS CARRY THE SAME DOCUMENTED CONFLICT, and they are resolved the same
 * way. `classes/Envelope.html` publishes `Min: 0` for `decay` (`Max: 2`) and
 * `Min: 0` for `release` (`Max: 5`), while the SAME page's prose says of BOTH
 * that the "Value must be greater than 0". Two documented statements that
 * disagree; the published `Min:` is what this table reports for each, because
 * inventing 0.01 as a floor would be exactly the fabricated fence this schema
 * refuses elsewhere — and floor either one and the other has to move with it, or
 * two identical situations get two answers. `sourceDefaults` resolves the
 * conflict the other way for the SEED value, where a graph that fails to build is
 * not a source that plays. Both zeroes are on the by-ear list.
 */
function envelopeRows(
  branch: string,
  prefix: string,
  when: ParamCondition,
  /** Tone's documented defaults for THIS envelope — the two differ, and this is
   *  the double-click reset, so they are passed in rather than shared. */
  defaults: { attack: number; decay: number; sustain: number; release: number },
): readonly Param[] {
  return [
    {
      kind: 'slider',
      path: `${branch}.attack`,
      label: `${prefix} attack`,
      appliesWhen: when,
      min: 0,
      max: 2,
      step: 0.001,
      unit: 's',
      precision: 3,
      fallback: defaults.attack,
    },
    {
      kind: 'slider',
      path: `${branch}.decay`,
      label: `${prefix} decay`,
      appliesWhen: when,
      min: 0,
      max: 2,
      step: 0.01,
      unit: 's',
      precision: 2,
      fallback: defaults.decay,
    },
    {
      kind: 'encoder',
      path: `${branch}.sustain`,
      label: `${prefix} sustain`,
      appliesWhen: when,
      // A fraction of peak, so hundredths; no unit, because the docs describe it
      // as "the percent of the maximum value" and rendering 1.00 as "100 %" would
      // be a second scale the preset does not store.
      //
      // ⚠ Encoder because `classes/Envelope.html` publishes `Min:`/`Max:` for the
      // other three fields of this envelope and NONE for this one — the same rule
      // as `source.params.resonance`, and the same caveat: the lib's own type
      // comments call it `0..1`. That is the lib's claim about the field it
      // stores, not Tone's about the node, so this table does not fence on it, and
      // an amplitude sustain spun past 1 is a by-ear check rather than a refusal.
      step: 0.01,
      precision: 2,
      fallback: defaults.sustain,
    },
    {
      kind: 'slider',
      path: `${branch}.release`,
      label: `${prefix} release`,
      appliesWhen: when,
      min: 0,
      max: 5,
      step: 0.05,
      unit: 's',
      precision: 2,
      fallback: defaults.release,
    },
  ];
}

// --------------------------------------------------------------- the table ---

/**
 * Source — what the voice is made from, and that thing's settings.
 *
 * NO PROBE (`presenceProbe: null`): every preset has a source, so this section is
 * never absent. It used to be `Samples` with a `source.samples` probe, which made
 * it vanish entirely on the four synth-sourced built-ins — the defect this
 * section replaces. What varies now is the ROWS, via `appliesWhen`.
 *
 * NOT REMOVABLE, and that is unchanged and permanent: a voice with no source is
 * not a voice. Switching kinds is the operation, and `source.kind` is the row
 * that does it.
 */
const SOURCE_SECTION: ParamSection = {
  id: 'source',
  label: 'Source',
  presenceProbe: null,
  removableBranch: null,
  params: [
    {
      kind: 'source-kind',
      path: 'source.kind',
      label: 'Source',
      options: SOURCE_KIND_OPTIONS,
      fallback: 'sampler',
      // No lib-side fallback to defer to, unlike the amp's model id: an
      // unrecognised discriminant is a preset this build cannot play at all, so
      // the picker shows nothing selected rather than naming an arm it isn't.
      resolve: (raw) => (isSourceKind(raw) ? raw : null),
      // A kind change is the one edit that cannot retune in place: `swapPreset`
      // disposes and rebuilds the whole graph when `sameSource` sees a different
      // discriminant.
      rebuildsVoice: true,
    },

    // ---- sampler ----------------------------------------------------------
    {
      kind: 'sample-pack',
      path: 'source.samples',
      label: 'Pack',
      appliesWhen: WHEN_SAMPLER,
      options: SAMPLE_PACK_OPTIONS,
      rebuildsVoice: true,
    },
    {
      kind: 'slider',
      path: 'source.release',
      label: 'Release',
      appliesWhen: WHEN_SAMPLER,
      optional: true,
      // `classes/Sampler.html`: `release` carries `Min: 0` / `Max: 1`. Narrower
      // than what this row used to declare (0.1–4, lifted from Sound Lab) and
      // narrower than what nine of the ten shipped samplers store — see
      // `STALE_PRESET_VALUES` in the test. The presets are what is out of date.
      min: 0,
      max: 1,
      step: 0.05,
      unit: 's',
      precision: 2,
      // `Voice` builds `release: source.release ?? 1`, so an omitted release IS
      // one second in the chain — the fallback states what is already happening
      // rather than proposing a value. It sits exactly on Tone's documented max.
      fallback: 1,
      rebuildsVoice: true,
    },

    // ---- pluck synth (Tone.PluckSynth) -------------------------------------
    {
      kind: 'slider',
      path: 'source.params.attackNoise',
      label: 'Attack noise',
      appliesWhen: WHEN_PLUCK,
      // `classes/PluckSynth.html`: "Nominal range of [0.1, 20]", `Min: 0.1`,
      // `Max: 20`. Sound Lab's fader stopped at 1 and clipped the one shipped
      // preset that uses this synth.
      min: 0.1,
      max: 20,
      step: 0.1,
      precision: 1,
      fallback: TONE_PLUCK_DEFAULTS.attackNoise,
    },
    {
      kind: 'slider',
      path: 'source.params.dampening',
      label: 'Dampening',
      appliesWhen: WHEN_PLUCK,
      // `classes/PluckSynth.html`: `Min: 0` / `Max: 7000`. Sound Lab ran to 8000,
      // a thousand cycles past what the node accepts.
      min: 0,
      max: 7000,
      step: 50,
      unit: 'Hz',
      precision: 0,
      fallback: TONE_PLUCK_DEFAULTS.dampening,
    },
    {
      kind: 'encoder',
      path: 'source.params.resonance',
      label: 'Resonance',
      appliesWhen: WHEN_PLUCK,
      // `classes/PluckSynth.html` documents `Min:`/`Max:` for `attackNoise` and
      // `dampening` on this very page and NONE for `resonance`. The lib's own
      // type comment claims 0..1; that is the lib's claim, not Tone's, and this
      // table only reports Tone's. Hundredths because the shipped values live
      // between 0.7 and 0.85.
      step: 0.01,
      precision: 2,
      fallback: TONE_PLUCK_DEFAULTS.resonance,
    },
    {
      kind: 'encoder',
      path: 'source.params.release',
      label: 'Release',
      appliesWhen: WHEN_PLUCK,
      // Same page, same silence — and here Tone documents no default either, so
      // the seed in `sourceDefaults` is explicitly ours. Twentieths of a second
      // is a comfortable turn over a tail measured in whole seconds.
      step: 0.05,
      precision: 2,
      unit: 's',
      fallback: TONE_PLUCK_DEFAULTS.release,
    },

    // ---- FM synth (Tone.FMSynth) -------------------------------------------
    {
      kind: 'encoder',
      path: 'source.params.harmonicity',
      label: 'Harmonicity',
      appliesWhen: WHEN_FM,
      // `classes/FMSynth.html` gives this a description ("the ratio between the
      // two voices … harmonicity = 2 means a change of an octave") and no bound
      // at all. Twentieths, so the musically interesting whole and half ratios
      // are reachable in a few detents.
      step: 0.05,
      precision: 2,
      fallback: TONE_FM_DEFAULTS.harmonicity,
    },
    {
      kind: 'encoder',
      path: 'source.params.modulationIndex',
      label: 'Mod index',
      appliesWhen: WHEN_FM,
      // `classes/FMSynth.html`: described, unbounded. Halves — the shipped values
      // run 1.5 to 10 and Tone's default is 10, so a finer step is only travel.
      step: 0.5,
      precision: 1,
      fallback: TONE_FM_DEFAULTS.modulationIndex,
    },
    {
      kind: 'encoder',
      path: 'source.params.detune',
      label: 'Detune',
      appliesWhen: WHEN_FM,
      // `classes/FMSynth.html`: `Signal<"cents">`, no bound. One cent per detent
      // is the unit the value is expressed in; Shift is the coarse gesture.
      step: 1,
      precision: 0,
      unit: 'ct',
      fallback: TONE_FM_DEFAULTS.detune,
    },
    {
      kind: 'enum',
      path: 'source.params.carrierWaveform',
      label: 'Carrier',
      appliesWhen: WHEN_FM,
      options: WAVEFORM_OPTIONS,
      fallback: TONE_FM_DEFAULTS.carrierWaveform,
      resolve: resolveWaveform,
    },
    {
      kind: 'enum',
      path: 'source.params.modulatorWaveform',
      label: 'Modulator',
      appliesWhen: WHEN_FM,
      options: WAVEFORM_OPTIONS,
      fallback: TONE_FM_DEFAULTS.modulatorWaveform,
      resolve: resolveWaveform,
    },
    // Tone's documented FMSynth defaults, per envelope — see `sourceDefaults`.
    // `TONE_FM_DEFAULTS` is the same numbers as a `VoiceSource`, so the two
    // cannot disagree without the test that compares them failing.
    ...envelopeRows('source.params.envelope', 'Env', WHEN_FM, TONE_FM_DEFAULTS.envelope),
    ...envelopeRows(
      'source.params.modulationEnvelope',
      'Mod',
      WHEN_FM,
      TONE_FM_DEFAULTS.modulationEnvelope,
    ),
  ],
};

const AMP_SECTION: ParamSection = {
  id: 'amp',
  label: 'Amp',
  presenceProbe: 'effects.amp',
  removableBranch: 'effects.amp',
  params: [
    {
      kind: 'toggle',
      path: 'effects.amp.enabled',
      label: 'Enabled',
      optional: true,
      fallback: true,
    },
    {
      kind: 'enum',
      path: 'effects.amp.modelId',
      label: 'Model',
      optional: true,
      options: AMP_MODEL_OPTIONS,
      // The lib falls back to Plexi for a missing or unknown id, so the picker has
      // to show the same thing the chain will actually build. `getAmpModel` rather
      // than a lookup table for exactly that reason — it *is* the fallback.
      fallback: DEFAULT_AMP_MODEL_ID,
      resolve: (raw) => getAmpModel(typeof raw === 'string' ? raw : undefined).id,
      badgeOf: (id) => getAmpModel(id).category,
    },
    {
      kind: 'slider',
      path: 'effects.amp.preGainDb',
      label: 'Pre gain',
      // -12 is Sound Lab's floor and also exactly `CLEAN_AMP_PRESET.preGainDb`, so
      // that one built-in sits on the boundary. Kept: the lib documents no bound for
      // this field, and anything quieter belongs on `inputGainDb` (-80 dB), which is
      // earlier in the chain and is the control for taming a hot source.
      min: -12,
      max: 24,
      step: 0.5,
      unit: 'dB',
      precision: 1,
      fallback: 0,
    },
    {
      kind: 'slider',
      path: 'effects.amp.preDrive',
      label: 'Drive',
      min: 0,
      max: 1,
      step: 0.01,
      precision: 2,
      fallback: 0.3,
    },
    // Tone stack. Sound Lab's three knobs are cut-only (-12..0); the lib documents
    // "typical range -12..+12" and the stage is a `Tone.EQ3`, which takes boost as
    // readily as cut, so the ceiling is opened up here. Every bundled preset sits
    // in [-9, 0], so widening costs nothing and losing boost would.
    {
      kind: 'slider',
      path: 'effects.amp.bass',
      label: 'Bass',
      min: -12,
      max: 12,
      step: 0.5,
      unit: 'dB',
      precision: 1,
      fallback: 0,
    },
    {
      kind: 'slider',
      path: 'effects.amp.mid',
      label: 'Mid',
      min: -12,
      max: 12,
      step: 0.5,
      unit: 'dB',
      precision: 1,
      fallback: 0,
    },
    {
      kind: 'slider',
      path: 'effects.amp.treble',
      label: 'Treble',
      min: -12,
      max: 12,
      step: 0.5,
      unit: 'dB',
      precision: 1,
      fallback: 0,
    },
    {
      kind: 'slider',
      path: 'effects.amp.presence',
      label: 'Presence',
      min: -12,
      max: 12,
      step: 0.5,
      unit: 'dB',
      precision: 1,
      fallback: 0,
    },
    {
      kind: 'slider',
      path: 'effects.amp.powerDrive',
      label: 'Power',
      min: 0,
      max: 1,
      step: 0.01,
      precision: 2,
      fallback: 0.1,
    },
    {
      kind: 'slider',
      path: 'effects.amp.outputDb',
      label: 'Output',
      min: -12,
      max: 12,
      step: 0.5,
      unit: 'dB',
      precision: 1,
      fallback: 0,
    },
  ],
};

const CABINET_SECTION: ParamSection = {
  id: 'cabinet',
  label: 'Cabinet',
  presenceProbe: 'effects.cabIR',
  removableBranch: 'effects.cabIR',
  params: [
    {
      kind: 'toggle',
      path: 'effects.cabIR.enabled',
      label: 'Enabled',
      optional: true,
      fallback: true,
    },
    {
      kind: 'enum',
      path: 'effects.cabIR.url',
      label: 'Cabinet',
      options: CABINET_OPTIONS,
      // `url` is required inside `CabIRParams`, so the only way this is reached is
      // the pane creating the branch — and a cabinet section with no cabinet is not
      // a state worth having. First registered IR it is.
      fallback: CABINET_IRS[0].url,
      // No fallback here, deliberately, even though `fallback` above exists: that one
      // is what `addSection` *writes* when it creates the branch. Resolving an absent
      // or unregistered URL to it instead would show "Twin clean" selected over a
      // preset that holds something else — the one thing `ParamEnum` promises not to do.
      resolve: (raw) => (typeof raw === 'string' && detectCabinetIR(raw) ? raw : null),
    },
    {
      kind: 'slider',
      path: 'effects.cabIR.makeupDb',
      label: 'Makeup',
      optional: true,
      min: -24,
      max: 24,
      step: 0.5,
      unit: 'dB',
      precision: 1,
      // The lib runs the convolver with `normalize: false` and documents 0 dB as
      // the default, so an absent makeup is unity.
      fallback: 0,
    },
  ],
};

/**
 * Level. No probe and no removable branch — `level` is required on every preset and
 * `inputGainDb` lives at the root, so this section is always present.
 */
const LEVEL_SECTION: ParamSection = {
  id: 'level',
  label: 'Level',
  presenceProbe: null,
  removableBranch: null,
  params: [
    {
      kind: 'slider',
      path: 'inputGainDb',
      label: 'Input gain',
      optional: true,
      // The lib's own doc comment names these bounds: -80 dB grounds the signal,
      // +24 dB is hot boost into the saturators.
      min: -80,
      max: 24,
      step: 0.5,
      unit: 'dB',
      precision: 1,
      fallback: 0,
    },
    {
      kind: 'slider',
      path: 'level.volumeDb',
      label: 'Volume',
      // Wider than the lib's "-24..+12 is sensible" so the floor mutes the voice,
      // matching Sound Lab's shipped fader.
      min: -80,
      max: 12,
      step: 0.5,
      unit: 'dB',
      precision: 1,
      fallback: 0,
    },
    {
      kind: 'slider',
      path: 'level.pan',
      label: 'Pan',
      min: -1,
      max: 1,
      step: 0.05,
      precision: 2,
      fallback: 0,
    },
  ],
};

/** Signal-chain order: source → amp → cabinet → output. */
export const PARAM_SECTIONS: readonly ParamSection[] = [
  SOURCE_SECTION,
  AMP_SECTION,
  CABINET_SECTION,
  LEVEL_SECTION,
];

/**
 * Which stages a voice editor opens on: Amp and Cabinet — the two you actually
 * turn. The source and the output trim are tuned once and left, so they start
 * folded.
 *
 * Here rather than in either editor because BOTH render `PARAM_SECTIONS` and the
 * two must not drift: the pattern page's `VoicePane` shipped with this default,
 * CP-14's track rack shipped with all four open, and the result was one surface
 * showing a stage folded that the other showed open. It also makes the composition
 * page's own design argument true again — racks beat a modal because TWO TRACKS'
 * settings are visible at once, which four open stages per rack denies.
 *
 * The OPEN set rather than the folded one, because that is the smaller list and
 * the one a reader can check against the chain above. Each editor derives what it
 * needs from it and `PARAM_SECTIONS`, so a new section is folded by default
 * without either of them being edited.
 *
 * `source` is NOT in the list — it was not here as `samples` either, and the
 * rename is checked by `tsc` rather than left to a string that would silently
 * stop matching. Deliberate, even though the section now carries thirteen rows on
 * an FM voice: those thirteen are precisely the ones that make an unfolded Source
 * stage push Amp and Cabinet off the screen, and the reason this default exists is
 * that two tracks' amps have to be comparable at once.
 */
export const DEFAULT_OPEN_SECTIONS: readonly SectionId[] = ['amp', 'cabinet'];

/**
 * Whether `param` is a row of `preset` at all — the per-row counterpart of
 * {@link sectionApplies}, and the only evaluator of `appliesWhen`.
 *
 * A row with no condition applies everywhere, which is every row outside the
 * Source section. `getAtPath` returns `undefined` for a path that cannot be
 * walked, and `undefined` is in no `oneOf`, so a malformed preset hides the rows
 * it cannot support rather than rendering controls over nothing.
 */
export function paramApplies(preset: VoicePreset, param: Param): boolean {
  const when = param.appliesWhen;
  if (!when) return true;
  const value = getAtPath(preset, when.path);
  return typeof value === 'string' && when.oneOf.includes(value);
}

/** The rows of `section` that `preset` actually has, in declaration order. */
export function visibleParams(preset: VoicePreset, section: ParamSection): readonly Param[] {
  return section.params.filter((param) => paramApplies(preset, param));
}

/**
 * Whether `section` has anything to edit on `preset` — i.e. its branch is really
 * there, as opposed to bypassed (`enabled: false`) or removable-but-removed. The one
 * evaluator for `presenceProbe`, so the pane and the schema test cannot drift into
 * two different definitions of "present".
 */
export function sectionApplies(preset: VoicePreset, section: ParamSection): boolean {
  return section.presenceProbe === null || hasBranchAtPath(preset, section.presenceProbe);
}

/**
 * The stage's `enabled` param, if it has one — bypass is a param, not a section
 * flag, which is why it is found in the table rather than declared beside it.
 */
export function enabledParamOf(section: ParamSection): ToggleParam | undefined {
  return section.params.find(
    (param): param is ToggleParam =>
      param.kind === 'toggle' && param.path.endsWith('.enabled'),
  );
}

/**
 * Which of the three states a section is in on a given preset.
 *
 * Here rather than in a pane because TWO surfaces render this table now — the
 * pattern page's `VoicePane` and the composition page's per-track racks — and a
 * second definition of "bypassed" is a rack whose lamp disagrees with the ear.
 * `absent` beats `bypassed`: a preset with no `effects` branch at all has no
 * `enabled` flag to be false.
 */
export type SectionPresence = 'active' | 'bypassed' | 'absent';

export function sectionPresence(
  preset: VoicePreset,
  section: ParamSection,
): SectionPresence {
  if (!sectionApplies(preset, section)) return 'absent';
  const toggle = enabledParamOf(section);
  return toggle && getAtPath(preset, toggle.path) === false ? 'bypassed' : 'active';
}
