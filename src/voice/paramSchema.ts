/**
 * The voice editor as data.
 *
 * Every control in the voice pane is one row of this table, addressed into the
 * `VoicePreset` by the dotted paths `presetPaths.ts` understands. guitar-tutor's
 * Sound Lab hand-wrote a JSX block per parameter across 2,000 lines; the numbers
 * below are lifted from it, the structure deliberately is not — a table is what
 * lets `paramSchema.test.ts` assert every path and range against every built-in
 * preset, which hand-written JSX can never do.
 *
 * SCOPE: Samples, Amp, Cabinet, Level. The lib exposes ~95 tunable params; body
 * filter, compressor, the pedals, the EQs, per-voice reverb, synth source params,
 * ADSR and the sub-body layer are a later slice and are deliberately NOT declared
 * here. Declaring a param the pane cannot honour is worse than omitting it.
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
  type VoicePreset,
} from '@fretwork/lib';
import { getAtPath, hasBranchAtPath } from './presetPaths';

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

interface ParamCommon {
  /** Dotted path into the preset, for `presetPaths`. */
  readonly path: string;
  readonly label: string;
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

export type Param = SliderParam | EnumParam | ToggleParam | SamplePackParam;

export type SectionId = 'samples' | 'amp' | 'cabinet' | 'level';

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

// --------------------------------------------------------------- the table ---

/**
 * Samples. The probe is `source.samples` rather than `source` because a source is
 * always present — what decides whether this section applies is whether the source
 * is sampler-kind, and `source.samples` exists exactly then. Not removable:
 * changing the source kind is a later slice.
 */
const SAMPLES_SECTION: ParamSection = {
  id: 'samples',
  label: 'Samples',
  presenceProbe: 'source.samples',
  removableBranch: null,
  params: [
    {
      kind: 'sample-pack',
      path: 'source.samples',
      label: 'Pack',
      options: SAMPLE_PACK_OPTIONS,
      rebuildsVoice: true,
    },
    {
      kind: 'slider',
      path: 'source.release',
      label: 'Release',
      optional: true,
      min: 0.1,
      max: 4,
      step: 0.1,
      unit: 's',
      precision: 1,
      // Sound Lab renders `release ?? 1`; the lib's own sampler default is not
      // exported, so 1 s is the value the shipped editor already agreed on.
      fallback: 1,
      rebuildsVoice: true,
    },
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
  SAMPLES_SECTION,
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
 */
export const DEFAULT_OPEN_SECTIONS: readonly SectionId[] = ['amp', 'cabinet'];

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
