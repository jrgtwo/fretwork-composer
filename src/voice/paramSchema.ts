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
 * outside a documented range means the PRESET is stale, and it is reported as a
 * finding rather than allowed for. (It has happened once — the ten samplers'
 * `source.release` — and it was fixed in the lib; FOLLOW-UPS row 24.)
 *
 * SCOPE: Source (with its second source), Body filter, Amp, Cabinet, Level. The
 * lib exposes ~95 tunable params; the compressor, the pedals, the EQs and
 * per-voice reverb are a later slice and are deliberately NOT declared here.
 * Declaring a param the pane cannot honour is worse than omitting it.
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
 * from `{path, oneOf}` and cannot do from an opaque closure. It is also what made
 * the second source cost no new mechanism: its per-kind rows are the primary's
 * rows again, generated under `layer.source` and gated on `layer.source.kind`.
 *
 * PRESENCE IS THE SECOND CONDITION, and it is a different question. `appliesWhen`
 * asks "which arm of a union is this", which needs a discriminant to read; an
 * OPTIONAL BRANCH has none — `bodyFilter.envelope` is six numbers and no tag. So
 * `ParamCommon.requiresBranch` is the other clause of `paramApplies`: "this row
 * exists only while the branch at this path does". It is what stops a lone
 * `bodyFilter.envelope.attack` write from minting `{attack: 0.01}` — an object
 * matching no `BodyFilterEnvelope`, which `buildChain` would hand to Tone with
 * five `undefined`s. Both editors and BOTH seams route through `paramApplies`, so
 * declaring it is enough; nothing has to remember to check.
 *
 * SUB-BRANCHES — an optional branch INSIDE a section, which `ParamSection` cannot
 * express: a section has one probe and one removable branch. A second source is
 * part of what makes the sound (it is not a stage of the chain and has no bypass
 * of its own), and a cutoff envelope is part of the body filter, so neither is a
 * section. `ParamSection.subBranch` is that: a label, the branch, and the
 * well-formed value the Add gesture writes. Its ROWS stay in `section.params`,
 * gated by `requiresBranch`, because `trackVoiceDrafts.PARAM_BY_PATH` is built
 * from `section.params` and a row outside it is a control the composition page
 * cannot write at all.
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
  SEED_AUTO_WAH,
  SEED_CHORUS,
  SEED_COMPRESSOR,
  SEED_DELAY,
  SEED_DISTORTION,
  SEED_GRAPHIC_EQ,
} from './pedalDefaults';
import {
  SEED_BODY_FILTER,
  SEED_BODY_FILTER_ENVELOPE,
  SEED_LAYER,
  SOURCE_KIND_LABELS,
  seedLayerFor,
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
   * When set, this row exists only while a navigable branch stands at this path —
   * the presence half of `paramApplies`, for a row inside an OPTIONAL BRANCH that
   * carries no discriminant to write an `appliesWhen` against.
   *
   * Not merged into `ParamCondition`: "which arm of the union" and "is the branch
   * there at all" are different questions, and a condition type that answered both
   * would be answering neither clearly. A row under a sub-branch declares this;
   * a row under the same sub-branch that ALSO belongs to one source kind declares
   * `appliesWhen` instead, because a kind that matches proves the branch is there.
   */
  readonly requiresBranch?: string;
  /**
   * The complement: this row exists only while NO branch stands at this path.
   *
   * One row needs it, and it is a dead control without it. `Voice.buildChain`
   * connects the cutoff envelope to `bodyFilter.frequency`, and Tone marks a
   * Signal driven by another node `overridden` — every later write to it is
   * scheduled as 0 and discarded. `Voice.applyBodyFilter` knows this and skips
   * the static ramp entirely (`if (!p.envelope)`), so with an envelope present
   * the Cutoff encoder turns, marks the preset dirty, reaches the engine and
   * changes nothing audible. That is exactly the control this table refuses to
   * ship — the same reason `layer.source.params.detune` is not declared and a
   * sampler is not offered as a layer kind.
   *
   * Not folded into `requiresBranch` as a sign, and not into `ParamCondition`:
   * three presence questions with one field would be three rules a reader has to
   * disentangle at every row. The stored value is NOT deleted when the row goes —
   * removing the envelope rebuilds the chain from it, so the user's static cutoff
   * comes back exactly as they left it.
   */
  readonly absentBranch?: string;
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
  /**
   * Set when the field's SEMANTICS are integral, not merely its step.
   *
   * A step is a UI detent — every fader here has one and none of them means the
   * value between two detents is illegal, so the seams deliberately do not
   * range-check against `step`. `layer.octaveOffset` is the first row where the
   * in-between value is genuinely meaningless: `Voice.play` hands
   * `octaveOffset * 12` to `transposeNote`, and a third of an octave is 4
   * semitones of rounding nobody asked for. Enforced by `setTrackVoiceParam`,
   * because a pointer lands on a detent and a headless write does not.
   */
  readonly integral?: true;
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
  /**
   * A lower bound the SEAMS refuse below, for the rows where a small enough
   * number is not a setting but silence.
   *
   * ⚠ IT IS NOT A RANGE, and it is not rendered as one. An encoder exists
   * precisely because Tone publishes no `Min:`/`Max:` for the field, and the
   * control still has no end stop — a value the user turns to is on screen, in
   * the readout, and one turn back. A headless `setTrackVoiceParam` write is
   * neither: `bodyFilter.cutoff = 0` is a lowpass that passes nothing, and
   * `bodyFilter.envelope.baseFrequency = 0` pins the whole sweep at DC
   * (`0 · 2^octaves` is still 0), so one call yields a track that plays silence
   * with every control reading normally. Refusing it is the same service the
   * `slider` arm's range check performs for a caller with no pointer.
   *
   * Where the number comes from is stated at each row, and where it is the app's
   * rather than Tone's it says so — the treatment `layer.octaveOffset` already
   * sets for a bound this documentation rule cannot reach.
   */
  readonly floor?: number;
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

export type SectionId =
  | 'source'
  | 'body-filter'
  | 'pedals'
  | 'amp'
  | 'cabinet'
  | 'level';

/**
 * What a section and a pedal have in common: a label, the two branch paths that
 * decide presence, and rows.
 *
 * Extracted rather than duplicated because the three functions that read these
 * fields — {@link sectionApplies}, {@link enabledParamOf}, {@link sectionPresence}
 * — are the definition of "present", "bypassed" and "absent" for this app, and a
 * pedal that answered those questions with its own copy of the logic is a lamp
 * that can disagree with the ear. `sectionPresence` already carries that argument
 * for the two editors; a second stage type is the third caller it was written for.
 */
export interface ParamStage {
  readonly label: string;
  /**
   * Path that must resolve to an object or array for this stage to apply at all.
   * `null` means the stage reads always-present parts of the preset, so it is
   * never absent. Evaluate it with `sectionApplies` (below) — never with `hasPath`,
   * which answers key presence and would call a `cabIR: undefined` preset "has a
   * cabinet".
   */
  readonly presenceProbe: string | null;
  /**
   * Branch `removeAtPath` deletes to take the stage back to absent. `null` = the
   * stage cannot be removed. Every param in the stage lives under it when set,
   * because removing the branch has to remove the whole stage.
   */
  readonly removableBranch: string | null;
  readonly params: readonly Param[];
}

export interface ParamSection extends ParamStage {
  readonly id: SectionId;
  /**
   * One optional branch nested INSIDE this section, added and removed on its own.
   * See the header. Its rows are the members of `params` living under
   * `subBranch.branch`; read them with {@link branchParams} and the section's own
   * with {@link ownParams}, so neither editor has to know the prefix.
   */
  readonly subBranch?: ParamSubBranch;
}

/**
 * An optional branch inside a section — the second source, and the body filter's
 * cutoff envelope.
 *
 * Deliberately NOT a `ParamSection`, and not for layout reasons. `addSection`
 * (both copies of it — `VoicePane` and `trackVoiceDrafts`) creates a section by
 * writing each required row's `fallback`, and it SKIPS the `source-kind` and
 * `sample-pack` kinds because their value is not what `setAtPath(path, fallback)`
 * would write. A `VoiceLayer` contains a whole `VoiceSource`, so no amount of
 * row fallbacks can produce one: seeding it that way yields `{gainDb, octaveOffset}`
 * with no `source`, which is what `Voice._buildLayer` would then call
 * `buildSynth(undefined)` on. Hence `seed` — the entire well-formed value, written
 * in one `setAtPath`.
 */
export interface ParamSubBranch {
  readonly id: string;
  readonly label: string;
  /** Probe AND removal target. `hasBranchAtPath` here is "the user has one". */
  readonly branch: string;
  /**
   * The complete, well-formed starting value, built for the preset it is about to
   * join. Typed at its declaration in `sourceDefaults` (as a `VoiceLayer`, a
   * `BodyFilterEnvelope`), which is where `tsc` checks its shape — `object` here
   * only because a descriptor table has no one type for "a branch of a preset".
   *
   * A FUNCTION OF THE PRESET rather than a constant, and one branch genuinely
   * needs it: a layer's mix level is only meaningful relative to the primary it
   * sits under, and the primary's calibration trim differs by source kind — see
   * `sourceDefaults.seedLayerFor`, where the whole of that reasoning lives. The
   * envelope ignores its argument and says so at its declaration.
   */
  readonly seed: (preset: VoicePreset) => object;
  /**
   * The source-kind picker, when this branch contains a `VoiceSource`.
   *
   * ⚠ ON THE SUB-BRANCH RATHER THAN IN `section.params`, and this is a safety
   * property rather than tidiness. `trackVoiceDrafts.setTrackVoiceParam` handles
   * `kind: 'source-kind'` by calling `withSourceKind(preset, value)` — a function
   * that takes no path and always replaces `preset.source`. A `layer.source.kind`
   * row sitting in `PARAM_BY_PATH` would therefore let any caller (the agent
   * included) ask to re-kind the SECOND source and silently re-kind the primary
   * instead. Keeping it out of `section.params` keeps it out of that map, so the
   * seam refuses the path outright. `VoicePane` renders it through
   * `sourceDefaults.withLayerSourceKind`, which does take the branch.
   */
  readonly kindRow?: SourceKindParam;
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

/**
 * "…when the source at `kindPath` is this kind."
 *
 * Parameterised by the path rather than three constants, because there are now
 * two source branches — `source.kind` for the primary and `layer.source.kind` for
 * the second source — and the rows for each are generated by one function. The
 * condition is still the same two fields of data.
 */
const whenKind = (kindPath: string, kind: VoiceSourceKind): ParamCondition => ({
  path: kindPath,
  oneOf: [kind],
});

const WHEN_SAMPLER: ParamCondition = whenKind('source.kind', 'sampler');

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


/**
 * One source branch's per-kind rows — the two SYNTH kinds, generated so the
 * primary source and the second source cannot acquire different ranges.
 *
 * `branch` is `source` or `layer.source`; every path and every condition below is
 * derived from it, so `source.params.harmonicity` and
 * `layer.source.params.harmonicity` are two distinct declarations of one row
 * shape rather than two hand-copied rows. The bounds are a property of the NODE,
 * and `buildSynth` builds the same `Tone.PluckSynth` / `Tone.FMSynth` whichever
 * branch it is reading.
 *
 * THE SAMPLER ARM IS NOT HERE. It is hand-written in the Source section, because
 * it is the primary's alone — see the note there on why a layer is not offered
 * one.
 */
function synthSourceRows(
  branch: string,
  opts: { readonly omitFmDetune?: boolean } = {},
): readonly Param[] {
  const kindPath = `${branch}.kind`;
  const whenPluck = whenKind(kindPath, 'pluck-synth');
  const whenFm = whenKind(kindPath, 'fm-synth');

  return [
    // ---- pluck synth (Tone.PluckSynth) -------------------------------------
    {
      kind: 'slider',
      path: `${branch}.params.attackNoise`,
      label: 'Attack noise',
      appliesWhen: whenPluck,
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
      path: `${branch}.params.dampening`,
      label: 'Dampening',
      appliesWhen: whenPluck,
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
      path: `${branch}.params.resonance`,
      label: 'Resonance',
      appliesWhen: whenPluck,
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
      path: `${branch}.params.release`,
      label: 'Release',
      appliesWhen: whenPluck,
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
      path: `${branch}.params.harmonicity`,
      label: 'Harmonicity',
      appliesWhen: whenFm,
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
      path: `${branch}.params.modulationIndex`,
      label: 'Mod index',
      appliesWhen: whenFm,
      // `classes/FMSynth.html`: described, unbounded. Halves — the shipped values
      // run 1.5 to 10 and Tone's default is 10, so a finer step is only travel.
      step: 0.5,
      precision: 1,
      fallback: TONE_FM_DEFAULTS.modulationIndex,
    },
    ...(opts.omitFmDetune
      ? []
      : ([
          {
            kind: 'encoder',
            path: `${branch}.params.detune`,
            label: 'Detune',
            appliesWhen: whenFm,
            // `classes/FMSynth.html`: `Signal<"cents">`, no bound. One cent per
            // detent is the unit the value is expressed in; Shift is the coarse
            // gesture.
            step: 1,
            precision: 0,
            unit: 'ct',
            fallback: TONE_FM_DEFAULTS.detune,
          },
        ] as const)),
    {
      kind: 'enum',
      path: `${branch}.params.carrierWaveform`,
      label: 'Carrier',
      appliesWhen: whenFm,
      options: WAVEFORM_OPTIONS,
      fallback: TONE_FM_DEFAULTS.carrierWaveform,
      resolve: resolveWaveform,
    },
    {
      kind: 'enum',
      path: `${branch}.params.modulatorWaveform`,
      label: 'Modulator',
      appliesWhen: whenFm,
      options: WAVEFORM_OPTIONS,
      fallback: TONE_FM_DEFAULTS.modulatorWaveform,
      resolve: resolveWaveform,
    },
    // Tone's documented FMSynth defaults, per envelope — see `sourceDefaults`.
    // `TONE_FM_DEFAULTS` is the same numbers as a `VoiceSource`, so the two
    // cannot disagree without the test that compares them failing.
    ...envelopeRows(`${branch}.params.envelope`, 'Env', whenFm, TONE_FM_DEFAULTS.envelope),
    ...envelopeRows(
      `${branch}.params.modulationEnvelope`,
      'Mod',
      whenFm,
      TONE_FM_DEFAULTS.modulationEnvelope,
    ),
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
/**
 * The second source, as an add-and-remove unit inside Source.
 *
 * ── Which kinds it offers, and why it is not all three ───────────────────────
 *
 * `VoiceLayer.source` is the SAME union as the primary's and `buildSynth`
 * handles every arm of it, so `sampler` is representable. It is not offered, and
 * the reasons are two verified engine behaviours rather than a preference:
 *
 *   1. `Voice.updateLayer` rebuilds the layer only when the KIND changes (or the
 *      layer is added or removed); every other edit takes the retune path, which
 *      calls `applyPluckSynth` / `applyFMSynth` and nothing else. There is no
 *      branch that reloads a sampler's banks — so a Pack row on a layer would be
 *      a control that never reaches the graph, which is the dead control this
 *      table exists to prevent.
 *   2. That same retune path ramps the layer's gain to `dbToGain(next.gainDb)`
 *      while `_buildLayer` builds it at `dbToGain(gainDb + sourceTrimDb(source))`.
 *      `sourceTrimDb` is −17 dB for a sampler and 0 for both synths, and
 *      `swapPreset` calls `updateLayer` on EVERY preset push — so a sampled layer
 *      would jump 17 dB louder the first time the user touched anything at all.
 *      LIB-GAP(25): drop this filter when `updateLayer` folds `sourceTrimDb` into
 *      its ramp the way `_buildLayer` folds it into its constructor, and when a
 *      bank change rebuilds the layer.
 *
 * A layer that already holds a sampler is still READ correctly: `layer.gainDb`
 * and `layer.octaveOffset` are gated on the branch rather than on the kind, so
 * they show and edit, and the picker reports no selection rather than naming an
 * arm the layer is not. Nothing in this app can author one.
 */
const LAYER_SOURCE_KIND_OPTIONS: readonly EnumOption[] = SOURCE_KIND_OPTIONS.filter(
  (option) => option.value !== 'sampler',
);

/**
 * ⚠ THE PLUCKED SYNTH IS WITHDRAWN FROM THE PICKER, 2026-09-01 — unusable by ear.
 *
 * Every note comes out as two hits milliseconds apart, and the string barely
 * rings. What was established by measurement: one voice is built, each note
 * triggers once, the preset carries no second source, no filter and no effects,
 * the metronome is not the cause, and this app runs the same Tone version and
 * sample rate as guitar-tutor. Driven straight to the output with our chain
 * bypassed, the same synth rings at resonance 0.995 and tinks at 0.9. So the
 * synth, the audio context and the values all work.
 *
 * What was NOT established: why it doubles here and, specifically, whether it
 * doubles when driven straight to the output. That question is open.
 *
 * It stays offered on nothing and authorable by nothing, but a preset that
 * already holds it still READS: the rows are gated on `source.kind`, so
 * `ELECTRIC_GUITAR_PRESET` shows its four controls and edits them. Same shape as
 * the sampler's exclusion from a layer above — withdrawn from the offer, not
 * removed from the schema.
 *
 * Delete this filter when the doubling is understood. Do not delete it because
 * the rows look orphaned.
 */
const OFFERED_SOURCE_KIND_OPTIONS: readonly EnumOption[] = SOURCE_KIND_OPTIONS.filter(
  (option) => option.value !== 'pluck-synth',
);

const LAYER_SUB_BRANCH: ParamSubBranch = {
  id: 'layer',
  label: 'Second source',
  branch: 'layer',
  seed: seedLayerFor,
  kindRow: {
    kind: 'source-kind',
    path: 'layer.source.kind',
    label: 'Source',
    options: LAYER_SOURCE_KIND_OPTIONS,
    fallback: 'fm-synth',
    // Resolves any kind the union has an arm for, INCLUDING `sampler`, even
    // though the picker does not offer it: `resolve` answers "what is stored",
    // and reporting a stored sampler layer as unrecognised would be a lie about
    // the preset. `ParamEnum` shows its placeholder for a value it has no option
    // for, which is the honest rendering of "this exists and is not offered
    // here".
    resolve: (raw) => (isSourceKind(raw) ? raw : null),
    // The layer is disposed and rebuilt on a kind change, exactly as the primary
    // is — `Voice.updateLayer`'s first branch.
    rebuildsVoice: true,
  },
};

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
      // Not `SOURCE_KIND_OPTIONS` — see `OFFERED_SOURCE_KIND_OPTIONS`.
      options: OFFERED_SOURCE_KIND_OPTIONS,
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
      // than what this row used to declare (0.1–4, lifted from Sound Lab), and
      // narrower than what the ten shipped samplers used to store — the presets
      // were the thing out of date, and the lib has since retuned them to sit
      // inside this range (FOLLOW-UPS row 24).
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

    // ---- the two synth kinds, generated once per source branch -------------
    ...synthSourceRows('source'),

    // ---- the second source (`preset.layer`) --------------------------------
    // Its rows sit in the SOURCE section on purpose — a layer is part of what
    // makes the sound rather than a stage of the chain, it has no bypass of its
    // own, and `LAYER_SUB_BRANCH` below is how it is added and removed. Its
    // per-kind rows are the same generator again, one level down.
    {
      kind: 'encoder',
      path: 'layer.gainDb',
      label: 'Mix',
      requiresBranch: 'layer',
      // The node is the `Tone.Gain` `_buildLayer` constructs, and
      // `classes/Gain.html` publishes NO `Min:`/`Max:` for `gain` (nor for any
      // other property on that page) — so an encoder, by the same rule as
      // `source.params.resonance`. The lib's type comment says
      // "-infinity..+6 typical"; that is the lib's claim about the field it
      // stores, not Tone's about the node, and this table does not fence on it.
      // Half a decibel per detent is the step every other dB control here uses.
      step: 0.5,
      precision: 1,
      unit: 'dB',
      // `fallback` is only ever the double-click RESET here — `gainDb` is a
      // required field of a `VoiceLayer` and this row is gated on the branch, so
      // there is no preset on which it stands in for an absent value. It is the
      // NOMINAL mix level rather than the primary-relative one `seedLayerFor`
      // computes for the Add gesture: a reset is a deliberate gesture with the
      // number on screen, and a row's fallback is one constant with no preset in
      // hand to correct it against.
      fallback: SEED_LAYER.gainDb,
    },
    {
      kind: 'slider',
      path: 'layer.octaveOffset',
      label: 'Octave',
      requiresBranch: 'layer',
      // ⚠ THE ONE ROW IN THIS TABLE WITH NO NODE TO CITE, and it is a slider
      // anyway. `octaveOffset` is not a Tone property at all: `Voice.play`
      // transposes the layer's note by `octaveOffset * 12` semitones itself, in
      // JavaScript, before anything is triggered. So the documentation rule that
      // governs every other bound here simply does not reach this row, and the
      // choice is THE APP'S — stated, rather than dressed up as a citation.
      //
      // Bounded rather than endless because the value is five integers and a
      // fader lands any of them in one gesture where an encoder needs four
      // detents. ±2 is the app's fence: two octaves down from a bass's low E is
      // 10 Hz, below what a speaker reproduces and below what the ear hears as
      // pitch, and two up puts a guitar's top string past its own harmonics —
      // past either the layer stops being an offset and becomes silence. (The
      // lib's comment says "-2..+2 typical"; "typical" is not a bound, and this
      // is not citing it — it is agreeing with it for a reason of its own.)
      min: -2,
      max: 2,
      step: 1,
      // Integers only, and DECLARED rather than left to the step: `Voice.play`
      // hands `octaveOffset * 12` to `transposeNote`, so 0.3 is 3.6 semitones
      // and an arbitrary rounded note name. The fader snaps; a seam write does
      // not, which is what `SliderParam.integral` is for.
      integral: true,
      precision: 0,
      fallback: SEED_LAYER.octaveOffset,
    },
    {
      kind: 'encoder',
      path: 'layer.detuneCents',
      label: 'Detune',
      // FM ONLY, and that is the engine's behaviour rather than a preference:
      // `applyLayerDetune` writes `synth.detune.value` on a `Tone.FMSynth` and
      // silently ignores anything else, so on a plucked layer this control would
      // do nothing at all.
      appliesWhen: whenKind('layer.source.kind', 'fm-synth'),
      // `classes/FMSynth.html`: `detune` is a `Signal<"cents">` with no bound —
      // the same page and the same silence as `source.params.detune`. One cent
      // per detent, the unit the value is expressed in.
      step: 1,
      precision: 0,
      unit: 'ct',
      fallback: SEED_LAYER.detuneCents,
    },
    // ⚠ `layer.source.params.detune` IS DELIBERATELY NOT DECLARED, and
    // `synthSourceRows` takes the flag that drops it. Both would write the SAME
    // Tone property: `_buildLayer` builds the synth with `detune: p.detune` and
    // then calls `applyLayerDetune`, which overwrites it from `detuneCents` —
    // and `updateLayer`'s retune path does the same two writes in the same
    // order. So the layer's own `detuneCents` always wins, and declaring both
    // would be two knobs for one property with one of them silently inert.
    ...synthSourceRows('layer.source', { omitFmDetune: true }),
  ],
  subBranch: LAYER_SUB_BRANCH,
};

/**
 * Body filter — the lowpass the lib puts straight after the source's input gain,
 * before the compressor and everything downstream of it (`wireChain`).
 *
 * ITS OWN SECTION, and by the same test as Amp and Cabinet: it is a distinct
 * stage of the chain with its own bypass, absent on thirteen of the fourteen
 * built-ins and removable. `Voice.updateBodyFilter` rebuilds the chain when the
 * branch is added, removed, or has `enabled` flipped, so all three states are
 * live edits rather than something that waits for the next Play.
 *
 * ⚠ `type` AND `rolloff` ARE NOT DECLARED. `buildChain` hard-codes
 * `type: 'lowpass'` and passes no rolloff, and `BodyFilterParams` carries neither
 * field, so a row for either would be a control writing somewhere nothing reads —
 * whatever `classes/Filter.html` documents about the node in general.
 */
const BODY_FILTER_SECTION: ParamSection = {
  id: 'body-filter',
  label: 'Body filter',
  presenceProbe: 'bodyFilter',
  removableBranch: 'bodyFilter',
  params: [
    {
      kind: 'toggle',
      path: 'bodyFilter.enabled',
      label: 'Enabled',
      optional: true,
      fallback: true,
    },
    {
      kind: 'encoder',
      path: 'bodyFilter.cutoff',
      label: 'Cutoff',
      // ⚠ GONE WHILE THE ENVELOPE STANDS — see `absentBranch`. The envelope
      // drives `bodyFilter.frequency` and Tone discards every write to an
      // overridden Signal, so this control is inert exactly then. The stored
      // value is untouched and comes back with the envelope's removal.
      absentBranch: 'bodyFilter.envelope',
      // `classes/Filter.html` (15.1.22) publishes NO `Min:`/`Max:` for
      // `frequency` — nor for `Q`, `gain` or `detune`; the one bounded thing on
      // the page is `rolloff`, which "only accepts the values -12, -24, -48 and
      // -96" and which the lib does not expose. So an encoder, by the same rule
      // that made `source.params.resonance` one. 50 Hz per detent covers 20 Hz to
      // 20 kHz in a turn and a half of the coarse gesture.
      step: 50,
      precision: 0,
      unit: 'Hz',
      // THE APP'S FLOOR, not Tone's, stated as such — the same honesty
      // `layer.octaveOffset` uses for the same absence of a citation. 20 Hz is
      // the bottom of the audible band; a lowpass below it passes nothing a
      // speaker reproduces, and at 0 it passes nothing at all. Only the seams
      // enforce it; the encoder still has no end stop. See `EncoderParam.floor`.
      floor: 20,
      fallback: SEED_BODY_FILTER.cutoff,
    },
    {
      kind: 'encoder',
      path: 'bodyFilter.q',
      label: 'Resonance',
      // Same page, same silence. The lib's type comment claims `0.1..18`; that is
      // the lib's claim about the field it stores, not Tone's about
      // `Tone.Filter.Q`, and this table does not fence on it — the identical
      // situation, and the identical treatment, as `source.params.resonance` and
      // the two envelope sustains.
      step: 0.1,
      precision: 1,
      // The one floor here that IS Tone's: the same page declares `Q` a
      // `Signal<"positive">`, a type-level statement about the node even where
      // the page publishes no `Min:` line. Zero is a legal, unresonant filter;
      // negative is not a value the signal accepts.
      floor: 0,
      fallback: SEED_BODY_FILTER.q,
    },

    // ---- the cutoff envelope (`bodyFilter.envelope`) -----------------------
    // Gated on the BRANCH rather than on a discriminant: an envelope is six
    // numbers and no tag, so there is nothing for an `appliesWhen` to read. See
    // `requiresBranch`. While it is present the static `cutoff` above is ignored
    // by the chain — the envelope drives the frequency instead.
    //
    // The node is `Tone.FrequencyEnvelope`, NOT the `Tone.Envelope` that
    // `envelopeRows` cites, which is why these six are written out rather than
    // generated by it. The three bounds happen to be identical; the page they
    // come from is not, and one generator would let a reader think a single
    // citation covered both nodes.
    {
      kind: 'slider',
      path: 'bodyFilter.envelope.attack',
      label: 'Env attack',
      requiresBranch: 'bodyFilter.envelope',
      // `classes/FrequencyEnvelope.html`: `Min: 0` / `Max: 2`.
      min: 0,
      max: 2,
      step: 0.001,
      unit: 's',
      precision: 3,
      fallback: SEED_BODY_FILTER_ENVELOPE.attack,
    },
    {
      kind: 'slider',
      path: 'bodyFilter.envelope.decay',
      label: 'Env decay',
      requiresBranch: 'bodyFilter.envelope',
      // `classes/FrequencyEnvelope.html`: `Min: 0` / `Max: 2`.
      min: 0,
      max: 2,
      step: 0.01,
      unit: 's',
      precision: 2,
      fallback: SEED_BODY_FILTER_ENVELOPE.decay,
    },
    {
      kind: 'encoder',
      path: 'bodyFilter.envelope.sustain',
      label: 'Env sustain',
      requiresBranch: 'bodyFilter.envelope',
      // `classes/FrequencyEnvelope.html` publishes `Min:`/`Max:` for attack,
      // decay and release and NOTHING for `sustain` — the same shape of silence
      // as `classes/Envelope.html`, and the same answer. The lib calls it `0..1`;
      // that is the lib's claim about the field, and this table does not fence on
      // it. Not rendered as a percentage: the value is the share of the octave
      // sweep the cutoff settles at, not a level.
      step: 0.01,
      precision: 2,
      fallback: SEED_BODY_FILTER_ENVELOPE.sustain,
    },
    {
      kind: 'slider',
      path: 'bodyFilter.envelope.release',
      label: 'Env release',
      requiresBranch: 'bodyFilter.envelope',
      // `classes/FrequencyEnvelope.html`: `Min: 0` / `Max: 5`.
      min: 0,
      max: 5,
      step: 0.05,
      unit: 's',
      precision: 2,
      fallback: SEED_BODY_FILTER_ENVELOPE.release,
    },
    {
      kind: 'encoder',
      path: 'bodyFilter.envelope.baseFrequency',
      label: 'Env base',
      requiresBranch: 'bodyFilter.envelope',
      // `classes/FrequencyEnvelope.html`: no bound, on the page that bounds its
      // three neighbours. The same 50 Hz detent as the cutoff it replaces, so the
      // two turn alike.
      step: 50,
      precision: 0,
      unit: 'Hz',
      // The app's floor again, and here it is the whole sweep rather than one
      // end of it: the envelope runs `baseFrequency` up to
      // `baseFrequency * 2^octaves`, so at 0 Hz every point of the sweep is
      // 0 Hz. Same 20 Hz as the cutoff it stands in for.
      floor: 20,
      fallback: SEED_BODY_FILTER_ENVELOPE.baseFrequency,
    },
    {
      kind: 'encoder',
      path: 'bodyFilter.envelope.octaves',
      label: 'Env octaves',
      requiresBranch: 'bodyFilter.envelope',
      // `classes/FrequencyEnvelope.html`: no bound. Tenths, because the shipped
      // Electric Guitar sits at 1.5 and whole octaves are a coarse sweep.
      step: 0.1,
      precision: 1,
      fallback: SEED_BODY_FILTER_ENVELOPE.octaves,
    },
  ],
  subBranch: {
    id: 'body-filter-envelope',
    label: 'Cutoff envelope',
    branch: 'bodyFilter.envelope',
    // The whole envelope in one write. It could in principle be seeded from the
    // six `fallback`s the way `addSection` seeds a section — every field is a
    // plain number — but then the pane would have two ways of creating a branch
    // and only one of them could ever create a `layer`. One gesture, one seed.
    //
    // The preset argument is ignored: unlike a layer's mix level, an envelope's
    // numbers are relationships inside the filter itself (its peak is pinned to
    // `SEED_BODY_FILTER.cutoff`) and nothing outside the branch changes them.
    seed: () => SEED_BODY_FILTER_ENVELOPE,
  },
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

// ------------------------------------------------------------------ pedals ---

/**
 * The pedalboard — six stages between the body filter and the amp.
 *
 * ── WHY A SECOND TABLE AND NOT SIX MORE SECTIONS ─────────────────────────────
 *
 * Every pedal is independently present, bypassable and removable, and a
 * `ParamSection` carries exactly one `presenceProbe` and one `removableBranch`.
 * Six sections would express that and would put six more stages in a rack the
 * composition page already argues should show TWO TRACKS at once. So the
 * pedalboard is ONE section whose body is a list, and this is the list.
 *
 * ── WHAT A PEDAL IS, AND WHAT IT BORROWS ─────────────────────────────────────
 *
 * Structurally a pedal is a `ParamSection` minus the sub-branch and plus a seed
 * — which is why both share {@link ParamStage} rather than each declaring its
 * own presence fields. `sectionApplies`, `enabledParamOf` and `sectionPresence`
 * all take a stage, so a pedal's lamp is lit by the same function that lights
 * the amp's. Two definitions of "bypassed" is a rack whose lamp disagrees with
 * the ear, and that reasoning is already written on `sectionPresence`.
 *
 * The seed is `ParamSubBranch.seed`'s argument, not `addSection`'s: a pedal
 * arrives as one branch in one write, so it has to be well-formed the instant it
 * lands. It lives in `pedalDefaults.ts`, cited to Tone's own `getDefaults()`.
 *
 * ── THE ORDER IS THE LIB'S, AND IT IS NOT EDITABLE HERE ──────────────────────
 *
 * Declaration order below is `Voice.wireChain`'s fixed sequence — compressor,
 * distortion, chorus, delay, auto-wah, graphic EQ. Nothing reads an order off
 * the preset, so this table cannot reorder anything and does not pretend to; a
 * board the user can rearrange is a lib change (`wireChain` reading an order,
 * `sameEffectsShape` comparing it) and is deliberately not in this slice.
 *
 * ── WHERE THE RANGES COME FROM, AND WHY SO MANY ARE ENCODERS ─────────────────
 *
 * The header's rule, applied to Tone 15.1.22 as installed. It produces a lopsided
 * answer and the lopsidedness is real rather than an oversight:
 *
 *   - `component/dynamics/Compressor.d.ts` carries genuine `@min` / `@max` on all
 *     five of its fields. Every compressor row is therefore a slider, and it is
 *     the only pedal that is fully bounded.
 *   - `core/type/Units.d.ts` documents `NormalRange` as "A number that is between
 *     [0, 1]" — a two-sided, type-level bound. Every `wet`, `depth` and
 *     `feedback` row is a slider on that citation, which is the same kind of
 *     evidence `bodyFilter.q`'s floor already rests on (`Positive`, "greater than
 *     or equal to 0"), used at both ends because this unit bounds both ends.
 *   - Everything else is an encoder. `Distortion.distortion` says "nominal range
 *     is between 0 and 1" in PROSE and carries no `@min`/`@max`; so does
 *     `Chorus.delayTime` ("between 2 and 20ms") and `AutoWah`'s sensitivity
 *     ("normal range of -40 to 0"). Prose is not a bound — a fader drawn to a
 *     nominal range is indistinguishable from one drawn to a real one, and the
 *     user would tune against a fence that is not there. `Tone.Filter` publishes
 *     no bound for `gain` at all, which is what makes the whole graphic EQ eight
 *     endless encoders despite the lib's comment suggesting ±15 dB.
 */
export type PedalId =
  | 'compressor'
  | 'distortion'
  | 'chorus'
  | 'delay'
  | 'auto-wah'
  | 'graphic-eq';

export interface Pedal extends ParamStage {
  readonly id: PedalId;
  /**
   * The one branch this pedal owns — its presence probe, its removal target, and
   * the `requiresBranch` every one of its rows is gated on.
   *
   * Stated once and spread into the two `ParamStage` fields by {@link definePedal},
   * because a pedal whose probe and removable branch disagreed would be a stage
   * the pane can see and cannot delete. A section may legitimately have one
   * without the other — Level has neither, Source has no removable branch — so
   * the collapse belongs here rather than on `ParamStage`.
   */
  readonly branch: string;
  /**
   * The complete, well-formed value the Add gesture writes, in one `setAtPath`.
   * `object` for the reason {@link ParamSubBranch.seed} is: a descriptor table has
   * no one type for "a branch of a preset". Each is typed as the lib's own params
   * interface at its declaration in `pedalDefaults.ts`, which is where `tsc`
   * checks it.
   *
   * A constant rather than a function of the preset, unlike a sub-branch's: a
   * layer's mix level is only meaningful relative to the primary it sits under,
   * and a pedal's settings are meaningful on their own.
   */
  readonly seed: object;
}

/**
 * Build a pedal from its one branch, so the branch is written once and the three
 * places that need it cannot drift apart.
 */
const definePedal = (pedal: {
  id: PedalId;
  label: string;
  branch: string;
  seed: object;
  params: readonly Param[];
}): Pedal => ({
  ...pedal,
  presenceProbe: pedal.branch,
  removableBranch: pedal.branch,
});

/**
 * ⚠ EVERY PEDAL ROW IS GATED ON ITS OWN BRANCH, and this is the mechanism that
 * makes one always-present section hold six independently-absent stages.
 *
 * A `ParamSection` normally answers "is this stage here?" once, with
 * `presenceProbe`, and the pane skips the whole body when it says no. The
 * pedalboard's probe is `null` — the board is always there — so without a
 * per-row condition all thirty-two rows would claim to apply to a preset
 * carrying no pedals at all, which is a control writing into a branch that does
 * not exist and a schema test asserting a range on `undefined`.
 *
 * `requiresBranch` is exactly that condition and it already exists: it is what
 * stops a lone `bodyFilter.envelope.attack` write from minting an object
 * matching no type. Both editors and both seams route through `paramApplies`, so
 * declaring it here is the whole of the work — nothing has to remember to check.
 */
const pedalBypass = (branch: string): ToggleParam => ({
  kind: 'toggle',
  path: `${branch}.enabled`,
  label: 'Enabled',
  requiresBranch: branch,
  optional: true,
  fallback: true,
});

/** A `wet` / `depth` / `feedback` row: `core/type/Units.d.ts` types these
 *  `NormalRange`, "A number that is between [0, 1]". */
const normalRangeSlider = (
  branch: string,
  path: string,
  label: string,
  fallback: number,
): SliderParam => ({
  kind: 'slider',
  path,
  label,
  requiresBranch: branch,
  min: 0,
  max: 1,
  step: 0.01,
  precision: 2,
  fallback,
});

/**
 * A graphic-EQ band. Seven of them, differing only in path, label and centre
 * frequency, so writing them out longhand would be seven chances to mistype a
 * bound that is identical by construction.
 *
 * An encoder because `Tone.Filter` publishes no `Min:`/`Max:` for `gain` — the
 * same silence the body filter's cutoff and resonance already answer this way.
 * The lib's type comment says "typical range ±15", which is a description of
 * how the control is usually used and not a statement about what the node
 * accepts.
 */
const eqBand = (path: string, label: string): EncoderParam => ({
  kind: 'encoder',
  path,
  label,
  requiresBranch: 'effects.graphicEq',
  // 0.5 dB per detent is the increment, not a claim about what the filter takes.
  step: 0.5,
  precision: 1,
  unit: 'dB',
  fallback: 0,
});

const COMPRESSOR_PEDAL: Pedal = definePedal({
  id: 'compressor',
  label: 'Compressor',
  // ⚠ THE ONE PEDAL AT THE ROOT OF THE PRESET. `VoicePreset.compressor` is a
  // top-level field; the other five live under `effects`. That is the lib's
  // shape and this table follows it rather than inventing a tidier one.
  branch: 'compressor',
  seed: SEED_COMPRESSOR,
  params: [
    pedalBypass('compressor'),
    {
      kind: 'slider',
      path: 'compressor.threshold',
      label: 'Threshold',
      requiresBranch: 'compressor',
      // Every bound in this stage is a real `@min` / `@max` in
      // `tone/build/esm/component/dynamics/Compressor.d.ts` (15.1.22).
      min: -100,
      max: 0,
      step: 1,
      unit: 'dB',
      precision: 0,
      fallback: SEED_COMPRESSOR.threshold,
    },
    {
      kind: 'slider',
      path: 'compressor.ratio',
      label: 'Ratio',
      requiresBranch: 'compressor',
      min: 1,
      max: 20,
      step: 0.1,
      precision: 1,
      fallback: SEED_COMPRESSOR.ratio,
    },
    {
      kind: 'slider',
      path: 'compressor.attack',
      label: 'Attack',
      requiresBranch: 'compressor',
      min: 0,
      max: 1,
      // Tone's own default is 0.003 s, so a coarser detent could not express it.
      step: 0.001,
      unit: 's',
      precision: 3,
      fallback: SEED_COMPRESSOR.attack,
    },
    {
      kind: 'slider',
      path: 'compressor.release',
      label: 'Release',
      requiresBranch: 'compressor',
      min: 0,
      max: 1,
      step: 0.01,
      unit: 's',
      precision: 2,
      fallback: SEED_COMPRESSOR.release,
    },
    {
      kind: 'slider',
      path: 'compressor.knee',
      label: 'Knee',
      requiresBranch: 'compressor',
      min: 0,
      max: 40,
      step: 1,
      unit: 'dB',
      precision: 0,
      fallback: SEED_COMPRESSOR.knee,
    },
  ],
});

const DISTORTION_PEDAL: Pedal = definePedal({
  id: 'distortion',
  label: 'Distortion',
  branch: 'effects.distortion',
  seed: SEED_DISTORTION,
  params: [
    pedalBypass('effects.distortion'),
    {
      kind: 'encoder',
      path: 'effects.distortion.drive',
      label: 'Drive',
      requiresBranch: 'effects.distortion',
      // `tone/build/esm/effect/Distortion.d.ts` (15.1.22) says "Nominal range is
      // between 0 and 1" in prose and publishes no `@min`/`@max`. Prose is not a
      // bound — see the table header.
      step: 0.01,
      precision: 2,
      // Tone builds the curve from this value; a negative one is not a setting.
      floor: 0,
      fallback: SEED_DISTORTION.drive,
    },
    normalRangeSlider('effects.distortion', 'effects.distortion.wet', 'Mix', SEED_DISTORTION.wet),
    {
      kind: 'enum',
      path: 'effects.distortion.oversample',
      label: 'Oversample',
      requiresBranch: 'effects.distortion',
      // The complete `OverSampleType` union, which is what the rule about
      // offering every option the API has means here.
      options: [
        { value: 'none', label: 'None', description: 'Cheapest, and audibly cruder.' },
        { value: '2x', label: '2×', description: 'A balance of cost and aliasing.' },
        { value: '4x', label: '4×', description: 'Cleanest, and the most CPU.' },
      ],
      fallback: SEED_DISTORTION.oversample,
      resolve: (raw) =>
        raw === 'none' || raw === '2x' || raw === '4x' ? raw : null,
    },
  ],
});

const CHORUS_PEDAL: Pedal = definePedal({
  id: 'chorus',
  label: 'Chorus',
  branch: 'effects.chorus',
  seed: SEED_CHORUS,
  params: [
    pedalBypass('effects.chorus'),
    {
      kind: 'encoder',
      path: 'effects.chorus.frequency',
      label: 'Rate',
      requiresBranch: 'effects.chorus',
      // `Chorus.d.ts` types this `Frequency` and publishes no bound, the same
      // silence `Tone.Filter.frequency` keeps.
      step: 0.1,
      precision: 2,
      unit: 'Hz',
      // An LFO at or below 0 Hz does not sweep; the seams refuse it for the same
      // reason they refuse a cutoff of 0.
      floor: 0,
      fallback: SEED_CHORUS.frequency,
    },
    normalRangeSlider('effects.chorus', 'effects.chorus.depth', 'Depth', SEED_CHORUS.depth),
    normalRangeSlider('effects.chorus', 'effects.chorus.wet', 'Mix', SEED_CHORUS.wet),
    normalRangeSlider('effects.chorus', 'effects.chorus.feedback', 'Feedback', SEED_CHORUS.feedback),
    {
      kind: 'encoder',
      path: 'effects.chorus.delayTime',
      label: 'Delay',
      requiresBranch: 'effects.chorus',
      // ⚠ MILLISECONDS. Tone types it `Milliseconds` and defaults it to 3.5; the
      // lib's `ChorusParams.delayTime` comment says "Seconds" and is wrong about
      // its own field — the value reaches `Tone.Chorus.delayTime` unconverted.
      // The unit here is the node's. "Nominal range 2 to 20ms" is prose, so this
      // is an encoder like every other prose range.
      step: 0.1,
      precision: 1,
      unit: 'ms',
      floor: 0,
      fallback: SEED_CHORUS.delayTime,
    },
    {
      kind: 'encoder',
      path: 'effects.chorus.spread',
      label: 'Spread',
      requiresBranch: 'effects.chorus',
      // `Degrees`, described as 0 (centred) to 180 (hard left/right) in prose
      // only. Same treatment as every other prose range.
      step: 1,
      precision: 0,
      unit: '°',
      floor: 0,
      fallback: SEED_CHORUS.spread,
    },
    {
      kind: 'enum',
      path: 'effects.chorus.type',
      label: 'LFO wave',
      requiresBranch: 'effects.chorus',
      // The lib narrows Tone's `ToneOscillatorType` to these four in
      // `ChorusType`, so these four are every option this path accepts.
      options: [
        { value: 'sine', label: 'Sine' },
        { value: 'square', label: 'Square' },
        { value: 'sawtooth', label: 'Sawtooth' },
        { value: 'triangle', label: 'Triangle' },
      ],
      fallback: SEED_CHORUS.type,
      resolve: (raw) =>
        raw === 'sine' || raw === 'square' || raw === 'sawtooth' || raw === 'triangle'
          ? raw
          : null,
    },
  ],
});

const DELAY_PEDAL: Pedal = definePedal({
  id: 'delay',
  label: 'Delay',
  branch: 'effects.delay',
  seed: SEED_DELAY,
  params: [
    pedalBypass('effects.delay'),
    {
      kind: 'encoder',
      path: 'effects.delay.delayTime',
      label: 'Time',
      requiresBranch: 'effects.delay',
      // SECONDS here, unlike the chorus's: `FeedbackDelay` types this one `Time`
      // and defaults it to 0.25. The two rows differ in unit because the two
      // nodes do.
      step: 0.01,
      precision: 2,
      unit: 's',
      floor: 0,
      fallback: SEED_DELAY.delayTime,
    },
    normalRangeSlider('effects.delay', 'effects.delay.feedback', 'Feedback', SEED_DELAY.feedback),
    normalRangeSlider('effects.delay', 'effects.delay.wet', 'Mix', SEED_DELAY.wet),
  ],
});

const AUTO_WAH_PEDAL: Pedal = definePedal({
  id: 'auto-wah',
  label: 'Auto-wah',
  branch: 'effects.autoWah',
  seed: SEED_AUTO_WAH,
  params: [
    pedalBypass('effects.autoWah'),
    {
      kind: 'encoder',
      path: 'effects.autoWah.baseFrequency',
      label: 'Base freq',
      requiresBranch: 'effects.autoWah',
      // `Frequency`, no published bound.
      step: 10,
      precision: 0,
      unit: 'Hz',
      // THE APP'S FLOOR, stated as such, and the same 20 Hz the body filter's
      // cutoff uses for the same reason: below the audible band the sweep starts
      // from nothing a speaker reproduces, and at 0 the whole sweep pins at DC
      // because `0 × 2^octaves` is still 0.
      floor: 20,
      fallback: SEED_AUTO_WAH.baseFrequency,
    },
    {
      kind: 'encoder',
      path: 'effects.autoWah.octaves',
      label: 'Octaves',
      requiresBranch: 'effects.autoWah',
      step: 0.5,
      precision: 1,
      // Tone multiplies the base frequency by `2^octaves` to find the top of the
      // sweep; a negative count sweeps downward past the base, which is not what
      // the control says it does.
      floor: 0,
      fallback: SEED_AUTO_WAH.octaves,
    },
    {
      kind: 'encoder',
      path: 'effects.autoWah.sensitivity',
      label: 'Sensitivity',
      requiresBranch: 'effects.autoWah',
      // "Normal range of -40 to 0" is prose in `AutoWah.d.ts`, not a bound. No
      // floor: a sensitivity is a dB threshold and negative IS the working end.
      step: 1,
      precision: 0,
      unit: 'dB',
      fallback: SEED_AUTO_WAH.sensitivity,
    },
    {
      kind: 'encoder',
      path: 'effects.autoWah.q',
      label: 'Resonance',
      requiresBranch: 'effects.autoWah',
      step: 0.1,
      precision: 1,
      // Tone's own: the node declares `Q` a `Signal<"positive">`, and
      // `core/type/Units.d.ts` defines `Positive` as "greater than or equal to
      // 0". The identical citation `bodyFilter.q` rests on.
      floor: 0,
      fallback: SEED_AUTO_WAH.q,
    },
    {
      kind: 'encoder',
      path: 'effects.autoWah.gain',
      label: 'Gain',
      requiresBranch: 'effects.autoWah',
      // `Signal<"decibels">` — a unit, not a range, and the page publishes no
      // bound. Negative is legal and useful, so no floor.
      step: 0.5,
      precision: 1,
      unit: 'dB',
      fallback: SEED_AUTO_WAH.gain,
    },
    normalRangeSlider('effects.autoWah', 'effects.autoWah.wet', 'Mix', SEED_AUTO_WAH.wet),
  ],
});

const GRAPHIC_EQ_PEDAL: Pedal = definePedal({
  id: 'graphic-eq',
  label: 'Graphic EQ',
  branch: 'effects.graphicEq',
  seed: SEED_GRAPHIC_EQ,
  params: [
    pedalBypass('effects.graphicEq'),
    eqBand('effects.graphicEq.band100Hz', '100 Hz'),
    eqBand('effects.graphicEq.band200Hz', '200 Hz'),
    eqBand('effects.graphicEq.band400Hz', '400 Hz'),
    eqBand('effects.graphicEq.band800Hz', '800 Hz'),
    eqBand('effects.graphicEq.band1_6kHz', '1.6 kHz'),
    eqBand('effects.graphicEq.band3_2kHz', '3.2 kHz'),
    eqBand('effects.graphicEq.band6_4kHz', '6.4 kHz'),
    {
      kind: 'encoder',
      path: 'effects.graphicEq.levelDb',
      label: 'Level',
      requiresBranch: 'effects.graphicEq',
      // The lib builds this one as a `Tone.Gain` set from dB. `Gain` publishes no
      // bound either, and a trim that cuts is the whole point, so no floor.
      step: 0.5,
      precision: 1,
      unit: 'dB',
      fallback: SEED_GRAPHIC_EQ.levelDb,
    },
  ],
});

/** `Voice.wireChain`'s order, which is the order the signal travels in. */
export const PEDALS: readonly Pedal[] = [
  COMPRESSOR_PEDAL,
  DISTORTION_PEDAL,
  CHORUS_PEDAL,
  DELAY_PEDAL,
  AUTO_WAH_PEDAL,
  GRAPHIC_EQ_PEDAL,
];

/**
 * The pedalboard as a section of the rack.
 *
 * `presenceProbe: null` — the board is always there; an empty one simply has no
 * pedals on it. Absence is a property of each pedal, not of the board, so this
 * section never renders the "not on this preset" body and carries no Add/Remove
 * of its own.
 *
 * ⚠ `params` IS THE FLATTENED PEDAL ROWS, and that is load-bearing rather than
 * convenient. `trackVoiceDrafts.PARAM_BY_PATH` is built from
 * `PARAM_SECTIONS.flatMap(s => s.params)`, and `paramSchema.test.ts` walks the
 * same list. A pedal row outside it is a control the composition page cannot
 * write, the agent cannot reach, and no test checks the range of. The pane
 * groups them back into pedals through {@link PEDALS}; nothing else has to.
 */
const PEDALS_SECTION: ParamSection = {
  id: 'pedals',
  label: 'Pedals',
  presenceProbe: null,
  removableBranch: null,
  params: PEDALS.flatMap((pedal) => pedal.params),
};

/** Signal-chain order: source → body filter → pedals → amp → cabinet → output. */
export const PARAM_SECTIONS: readonly ParamSection[] = [
  SOURCE_SECTION,
  BODY_FILTER_SECTION,
  PEDALS_SECTION,
  AMP_SECTION,
  CABINET_SECTION,
  LEVEL_SECTION,
];

/**
 * Signal-chain order: source → body filter → amp → cabinet → output.
 *
 * The body filter sits where `Voice.wireChain` puts it — immediately after the
 * input gain and before the compressor, so ahead of the amp and everything the
 * pedalboard does. Listing it anywhere else would be a rack whose order is not
 * the order the signal travels in.
 */
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
 * that two tracks' amps have to be comparable at once. The second source has since
 * doubled that count on the three built-ins that carry one, which only sharpens it.
 *
 * `body-filter` is not in the list either, and for the plainer reason: it is
 * absent on thirteen of the fourteen built-ins, so opening it by default would
 * open a stage that says "not on this preset" almost every time.
 *
 * `pedals` is not in it for the strongest version of the same argument. It is one
 * stage holding six, so unfolding it costs six cards rather than one stage's
 * rows — and it is the section most likely to be entirely empty, since a pedal is
 * added rather than tuned. Six "not on this voice" cards in every rack is the
 * exact opposite of two tracks being comparable at once.
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
  if (param.requiresBranch && !hasBranchAtPath(preset, param.requiresBranch)) return false;
  if (param.absentBranch && hasBranchAtPath(preset, param.absentBranch)) return false;
  const when = param.appliesWhen;
  if (!when) return true;
  const value = getAtPath(preset, when.path);
  return typeof value === 'string' && when.oneOf.includes(value);
}

/** The rows of `section` that `preset` actually has, in declaration order. */
export function visibleParams(preset: VoicePreset, section: ParamStage): readonly Param[] {
  return section.params.filter((param) => paramApplies(preset, param));
}

/** Whether `preset` carries `sub` at all — the sub-branch counterpart of
 *  {@link sectionApplies}, and the one evaluator of `ParamSubBranch.branch`. */
export function subBranchApplies(preset: VoicePreset, sub: ParamSubBranch): boolean {
  return hasBranchAtPath(preset, sub.branch);
}

/**
 * The visible rows of `section` that belong to the section ITSELF — everything
 * outside its sub-branch.
 *
 * Split by path prefix rather than by a second list, so a row cannot be declared
 * in one place and rendered from another: `section.params` stays the single
 * declaration, which is what keeps `trackVoiceDrafts`' path map complete.
 */
export function ownParams(preset: VoicePreset, section: ParamSection): readonly Param[] {
  const sub = section.subBranch;
  if (!sub) return visibleParams(preset, section);
  return visibleParams(preset, section).filter((param) => !underBranch(param, sub));
}

/** The visible rows of `section` that belong to its sub-branch. Empty when the
 *  sub-branch is absent, because every one of them is gated on it. */
export function branchParams(preset: VoicePreset, section: ParamSection): readonly Param[] {
  const sub = section.subBranch;
  if (!sub) return [];
  return visibleParams(preset, section).filter((param) => underBranch(param, sub));
}

const underBranch = (param: Param, sub: ParamSubBranch): boolean =>
  param.path.startsWith(`${sub.branch}.`);

/**
 * Whether `section` has anything to edit on `preset` — i.e. its branch is really
 * there, as opposed to bypassed (`enabled: false`) or removable-but-removed. The one
 * evaluator for `presenceProbe`, so the pane and the schema test cannot drift into
 * two different definitions of "present".
 */
export function sectionApplies(preset: VoicePreset, section: ParamStage): boolean {
  return section.presenceProbe === null || hasBranchAtPath(preset, section.presenceProbe);
}

/**
 * The stage's `enabled` param, if it has one — bypass is a param, not a section
 * flag, which is why it is found in the table rather than declared beside it.
 */
export function enabledParamOf(section: ParamStage): ToggleParam | undefined {
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
  section: ParamStage,
): SectionPresence {
  if (!sectionApplies(preset, section)) return 'absent';
  const toggle = enabledParamOf(section);
  return toggle && getAtPath(preset, toggle.path) === false ? 'bypassed' : 'active';
}
