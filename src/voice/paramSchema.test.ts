import { describe, expect, it } from 'vitest';
import {
  AMP_MODELS,
  CABINET_IRS,
  DEFAULT_AMP_MODEL_ID,
  DEFAULT_CIRCUIT_AMP_ID,
  CIRCUIT_AMPS,
  SAMPLE_PACKS,
  VOICE_PRESETS,
  detectSamplePack,
  type ADSREnvelope,
  type AmpParams,
  type AutoWahParams,
  type ChorusParams,
  type CompressorParams,
  type DelayParams,
  type DistortionParams,
  type EQParams,
  type EffectsConfig,
  type GraphicEqParams,
  type BodyFilterEnvelope,
  type BodyFilterParams,
  type CabIRParams,
  type FMSynthParams,
  type PluckSynthParams,
  type SamplePack,
  type VoiceLayer,
  type VoiceLevel,
  type VoicePreset,
  type VoiceReverbParams,
  type VoiceSource,
} from '@fretwork/lib';
import {
  LEVEL_BAR_PARAMS,
  PARAM_SECTIONS,
  PEDALS,
  branchParams,
  enabledParamIn,
  enabledParamOf,
  ownParams,
  paramApplies,
  probePaths,
  removableBranchPresent,
  sectionApplies,
  sectionPresence,
  stageBypassed,
  subBranchApplies,
  visibleParams,
  type Param,
  type ParamSection,
  type ParamStage,
  type ParamSubBranch,
  type SectionId,
  type SectionPresence,
} from './paramSchema';
import {
  SEED_BODY_FILTER,
  SEED_BODY_FILTER_ENVELOPE,
  SEED_LAYER,
  SOURCE_KINDS,
} from './sourceDefaults';
import { SEED_VOICE_REVERB } from './pedalDefaults';
import { circuitAmpControlPath } from './circuitAmpDefaults';
import { getAtPath, hasBranchAtPath, hasPath, removeAtPath, setAtPath } from './presetPaths';

/**
 * This is the test the descriptor-table approach exists for: it walks every path
 * the schema declares against every preset the lib actually ships. A typo'd path,
 * a range that a real preset falls outside of, or a picker that cannot represent a
 * built-in's selection all fail here rather than as a dead control in the pane.
 *
 * ── ⚠ TWO RULES THAT LOOK ALIKE AND ARE OPPOSITE ─────────────────────────────
 *
 * 1. A row is checked ONLY against a preset that actually has it. `paramApplies`
 *    is the gate, and it is the fix for a real hole: this file used to run every
 *    param against every preset of a present section, so an FM row would have
 *    been "absent" on a sampler and either failed spuriously or, if marked
 *    optional, passed without ever being checked at all. One `FULLY_POPULATED`
 *    fixture can no longer cover the table — a preset has exactly one source
 *    kind — so there are three, one per kind, and `FIXTURES` is what the coverage
 *    assertions walk.
 *
 * 2. When a preset value falls outside a declared range, the RANGE used to be
 *    what was wrong. It is not any more. Every bound in `paramSchema` is cited to
 *    a page on Tone's documentation site, so an out-of-range preset is the PRESET
 *    being wrong and gets retuned in the lib. Widening a range to admit one is the
 *    specific mistake to avoid. Ten sampler presets were retuned on 2026-08-31 for
 *    exactly this reason; the allow-list that carried them in the meantime is gone.
 *
 * The built-ins alone are not enough either: no shipped preset sets `enabled`,
 * `inputGainDb` or most other optional fields, so a typo in one of those paths is
 * invisible to a loop over `VOICE_PRESETS`. The fixtures below close that hole —
 * each is a `VoicePreset` literal with every in-scope field present for its source
 * kind, so `tsc` checks the shape and the coverage test checks that every declared
 * path lands on one of them.
 */

/**
 * Every row the table declares — the sections' AND the IN/OUT bar's.
 *
 * ⚠ THE BAR'S TWO ROWS ARE NOT IN ANY SECTION and they are still rows: the bar is
 * not a foldable stage, so `PARAM_SECTIONS` does not carry them, and everything
 * this file checks about a row (its path resolves on a fixture, its range holds,
 * its value type is guarded, nothing declares it twice) has to reach them anyway.
 * `voiceDrafts.PARAM_BY_PATH` unions them in for the same reason.
 */
const ALL_PARAMS: readonly Param[] = [
  ...PARAM_SECTIONS.flatMap((section) => section.params),
  ...LEVEL_BAR_PARAMS,
];

/**
 * The pedalboard's rows, reached through {@link PEDALS} rather than through the
 * section.
 *
 * Both routes must reach the same rows and the assertion below pins that: the
 * section's `params` is the flattened pedal rows precisely so
 * `voiceDrafts.PARAM_BY_PATH` and this file's walks pick them up with no
 * special case, and a pedal whose rows were declared only on the pedal would be
 * a control the composition page cannot write.
 */
const ALL_PEDAL_PARAMS: readonly Param[] = PEDALS.flatMap((pedal) => pedal.params);

/** Every sub-branch the table declares, with the section it hangs off. */
const SUB_BRANCHES: readonly { section: ParamSection; sub: ParamSubBranch }[] = PARAM_SECTIONS.flatMap(
  (section) => (section.subBranch ? [{ section, sub: section.subBranch }] : []),
);

function subBranchAt(id: string): { section: ParamSection; sub: ParamSubBranch } {
  const found = SUB_BRANCHES.find((entry) => entry.sub.id === id);
  if (!found) throw new Error(`no section declares sub-branch ${id}`);
  return found;
}

/** `preset` with `sub` present, seeded exactly as the pane's Add would seed it. */
const withSeeded = (preset: VoicePreset, sub: ParamSubBranch): VoicePreset =>
  setAtPath(preset, sub.branch, sub.seed(preset));

/** Looked up rather than indexed, so a renamed or dropped descriptor fails loudly
 *  here instead of retargeting an assertion at whatever moved into its slot. */
function paramAt(path: string): Param {
  const param = ALL_PARAMS.find((p) => p.path === path);
  if (!param) throw new Error(`no descriptor declares ${path}`);
  return param;
}

function sectionAt(id: SectionId): ParamSection {
  const section = PARAM_SECTIONS.find((s) => s.id === id);
  if (!section) throw new Error(`no section declares ${id}`);
  return section;
}

/** Every descriptor that offers a fixed list of values. `source-kind` is one of
 *  them for every purpose except the write, so the picker invariants below cover
 *  it rather than three of the four kinds. */
function isPicker(param: Param): param is Extract<Param, { options: readonly unknown[] }> {
  return param.kind === 'enum' || param.kind === 'sample-pack' || param.kind === 'source-kind';
}

function optionValues(param: Param): readonly string[] {
  if (param.kind === 'enum' || param.kind === 'source-kind') {
    return param.options.map((o) => o.value);
  }
  if (param.kind === 'sample-pack') return param.options.map((o) => o.id);
  return [];
}

/** A registered pack, so the `sample-pack` check below can name the selection.
 *  Found rather than indexed because `detectSamplePack` matches by deep shape and
 *  an arbitrary map would not resolve to anything. */
const FIXTURE_PACK: SamplePack =
  SAMPLE_PACKS.find((pack) => pack.id === 'offset-p90') ?? SAMPLE_PACKS[0];

/**
 * Everything a fully-populated preset carries that is NOT its identity or its
 * source — the part the three fixtures genuinely share.
 *
 * ⚠ ANNOTATED WITH `Omit<VoicePreset, …>`, and that annotation is load-bearing
 * rather than tidiness. A bare object (or an `as const`) spread into the fixtures
 * would lose excess-property checking on its own fields, so `effects.amp.trebble`
 * would compile clean and the schema's coverage assertion would be the only thing
 * left standing between a typo and a silently missing control. The annotation puts
 * the freshness check back on the base itself.
 */
/**
 * A second source with an FM synth in it — the shape all three built-ins that
 * carry one use. `detuneCents` is deliberately NON-ZERO: it is honoured only on
 * an FM layer, so a fixture holding 0 could not tell "applies and is zero" from
 * "does not apply".
 */
const FM_LAYER: VoiceLayer = {
  source: {
    kind: 'fm-synth',
    params: {
      harmonicity: 0.5,
      modulationIndex: 2,
      detune: 0,
      carrierWaveform: 'sine',
      modulatorWaveform: 'sine',
      envelope: { attack: 0.01, decay: 0.6, sustain: 0.4, release: 1.4 },
      modulationEnvelope: { attack: 0.01, decay: 0.6, sustain: 0.3, release: 1.2 },
    },
  },
  gainDb: -8,
  octaveOffset: -1,
  detuneCents: 7,
};

/** The other kind a layer may hold. No built-in ships one, so the four
 *  `layer.source.params.*` pluck rows are exercised only from here. */
const PLUCK_LAYER: VoiceLayer = {
  source: {
    kind: 'pluck-synth',
    params: { attackNoise: 0.8, dampening: 3000, resonance: 0.8, release: 0.9 },
  },
  gainDb: -10,
  octaveOffset: 1,
  detuneCents: 0,
};

const POPULATED_CHASSIS: Omit<VoicePreset, 'id' | 'name' | 'source'> = {
  instrumentId: 'guitar',
  family: 'electric',
  inputGainDb: -3,
  level: { volumeDb: -1.5, pan: 0.25 },
  layer: FM_LAYER,
  bodyFilter: {
    enabled: false,
    cutoff: 5500,
    q: 0.9,
    envelope: {
      attack: 0.003,
      decay: 0.2,
      sustain: 0.5,
      release: 0.8,
      baseFrequency: 2000,
      octaves: 1.5,
    },
  },
  // ⚠ EVERY PEDAL, on every fixture. The pedalboard section's probe is `null`,
  // so a pedal's presence is a per-ROW `requiresBranch` and nothing else — which
  // means a pedal absent from the fixtures is thirty-eight rows this file walks
  // over and silently skips. `applies every declared row to at least one fixture`
  // is the assertion that says so, and this block is what answers it.
  //
  // Values are inside the declared ranges on purpose, and deliberately NOT Tone's
  // defaults: a fixture equal to the seed cannot tell "the row reads the preset"
  // from "the row fell back".
  compressor: { enabled: false, threshold: -18, ratio: 4, attack: 0.01, release: 0.2, knee: 6 },
  effects: {
    distortion: { enabled: false, drive: 0.25, wet: 0.4, oversample: '2x' },
    chorus: {
      enabled: false,
      frequency: 1.2,
      depth: 0.4,
      wet: 0.3,
      type: 'triangle',
      feedback: 0.1,
      // SECONDS, like the field it stands in for — 4 ms.
      delayTime: 0.004,
      spread: 120,
    },
    delay: { enabled: false, delayTime: 0.3, feedback: 0.2, wet: 0.15 },
    autoWah: {
      enabled: false,
      baseFrequency: 120,
      octaves: 4,
      sensitivity: -20,
      q: 1.5,
      gain: 3,
      wet: 0.6,
    },
    graphicEq: {
      enabled: false,
      band100Hz: 2,
      band200Hz: -1,
      band400Hz: 0,
      band800Hz: 1.5,
      band1_6kHz: -2.5,
      band3_2kHz: 3,
      band6_4kHz: -0.5,
      levelDb: -1,
    },
    amp: {
      enabled: false,
      modelId: DEFAULT_AMP_MODEL_ID,
      preGainDb: 0,
      preDrive: 0.3,
      bass: 0,
      mid: 0,
      treble: 0,
      presence: 0,
      powerDrive: 0.1,
      outputDb: 0,
    },
    cabIR: { enabled: false, url: CABINET_IRS[0].url, makeupDb: 1.5 },
    // The room the cabinet stands in. On every fixture for the reason the pedals
    // are: its three rows are gated on `effects.reverb` and nothing else, so a
    // fixture without the branch is three rows this file walks over and skips.
    // Values deliberately off `SEED_VOICE_REVERB` — a fixture equal to the seed
    // cannot tell "the row reads the preset" from "the row fell back".
    reverb: { enabled: false, roomSize: 0.72, wet: 0.33 },
    // The last stage of the chain. On every fixture for the reason the room and
    // the pedals are: its six rows are gated on `effects.finalEq` and nothing
    // else, so a fixture without the branch is six rows this file walks over and
    // skips. Values deliberately off `SEED_FINAL_EQ`, which is flat at Tone's own
    // crossovers — a fixture equal to the seed cannot tell "the row reads the
    // preset" from "the row fell back".
    finalEq: { enabled: false, low: 2, mid: -1.5, high: 3, lowFrequency: 320, highFrequency: 3200 },
    // The experimental circuit amp, on every fixture for the same reason the
    // pedals are: no SHIPPED preset carries one and none is meant to, so a
    // fixture is the only thing that walks its rows. `enabled: false` because
    // `wireChain` builds one amp or the other and the classic `amp` above is
    // the one these fixtures are about — presence, not engagement, is what the
    // schema checks need.
    //
    // Values deliberately off the seed: a fixture equal to the seed cannot
    // tell "the row reads the preset" from "the row fell back".
    circuitAmp: {
      enabled: false,
      ampId: DEFAULT_CIRCUIT_AMP_ID,
      inputGainDb: 2.5,
      controls: { volume: 0.62, tone: 0.38 },
    },
  },
};

/**
 * One fixture per source kind. The `source` literal of each is written inline, so
 * it is checked against its arm of `VoiceSource` — a misspelt `attackNoize` or a
 * string where a number belongs fails `tsc` here.
 *
 * Their VALUES are inside the declared ranges on purpose: these fixtures exist to
 * exercise the checks, not to demonstrate a violation. `source.release` is 0.8 s
 * rather than a shipped sampler's 2.5 for exactly that reason.
 */
const FULLY_POPULATED_SAMPLER: VoicePreset = {
  id: 'fully-populated-sampler',
  name: 'Fully populated sampler',
  ...POPULATED_CHASSIS,
  source: { kind: 'sampler', samples: FIXTURE_PACK.samples, release: 0.8 },
};

const FULLY_POPULATED_PLUCK: VoicePreset = {
  id: 'fully-populated-pluck',
  name: 'Fully populated pluck',
  ...POPULATED_CHASSIS,
  source: {
    kind: 'pluck-synth',
    params: { attackNoise: 1.5, dampening: 6000, resonance: 0.85, release: 1 },
  },
};

const FULLY_POPULATED_FM: VoicePreset = {
  id: 'fully-populated-fm',
  name: 'Fully populated FM',
  ...POPULATED_CHASSIS,
  source: {
    kind: 'fm-synth',
    params: {
      harmonicity: 3,
      modulationIndex: 10,
      detune: 0,
      carrierWaveform: 'sawtooth',
      modulatorWaveform: 'square',
      envelope: { attack: 0.01, decay: 0.4, sustain: 0.5, release: 1.2 },
      modulationEnvelope: { attack: 0.5, decay: 0.01, sustain: 1, release: 0.5 },
    },
  },
};

const FIXTURES: readonly VoicePreset[] = [
  FULLY_POPULATED_SAMPLER,
  FULLY_POPULATED_PLUCK,
  FULLY_POPULATED_FM,
];

/**
 * A fourth fixture, off the per-kind axis on purpose.
 *
 * `FIXTURES` is one preset per PRIMARY source kind and the assertion below pins
 * it to `SOURCE_KINDS`, so it cannot also carry the second axis the layer added:
 * a layer has a source kind of its own, and the four `layer.source.params.*`
 * pluck rows are reachable from no built-in and from none of the three above.
 * Every walk over "each declared row is reachable" therefore uses
 * `ALL_FIXTURES`, and only the per-kind coverage assertions use `FIXTURES`.
 */
const PLUCK_LAYERED: VoicePreset = {
  ...FULLY_POPULATED_SAMPLER,
  id: 'pluck-layered-sampler',
  name: 'Sampler with a plucked second source',
  layer: PLUCK_LAYER,
};

/**
 * A fifth fixture, on a third axis: a body filter with NO cutoff envelope.
 *
 * `POPULATED_CHASSIS` gives every fixture above an envelope, and
 * `bodyFilter.cutoff` declares `absentBranch: 'bodyFilter.envelope'` — the
 * envelope drives the filter's frequency and Tone discards writes to an
 * overridden Signal, so the static Cutoff row is deliberately not a row of a
 * preset that has one. Without this fixture that row is reachable from nothing
 * and the coverage assertion below says so, which is the assertion working.
 * A static cutoff is also a real shipped shape, not a degenerate one.
 */
const STATIC_FILTERED: VoicePreset = {
  ...FULLY_POPULATED_FM,
  id: 'static-body-filter',
  name: 'Body filter with no envelope',
  bodyFilter: { enabled: true, cutoff: 5500, q: 0.9 },
};

/**
 * A fixture with the SECOND circuit amp selected.
 *
 * `POPULATED_CHASSIS` selects the Princeton, so without this every 5E3-only
 * row — its two channel volumes and its four switches — is a control no fixture
 * can reach, and `applies every declared row to at least one fixture` is the
 * assertion that says so. `tone` is deliberately present on both: it is the one
 * control id the two amps share, and it must resolve under either.
 *
 * Values off the seed, for the same reason the chassis' are.
 */
const DELUXE_CIRCUIT_AMP: VoicePreset = {
  ...FULLY_POPULATED_FM,
  id: 'deluxe-circuit-amp',
  name: 'Circuit amp on the 5E3',
  effects: {
    ...FULLY_POPULATED_FM.effects!,
    circuitAmp: {
      enabled: false,
      ampId: 'deluxe-5e3',
      inputGainDb: 2.5,
      controls: {
        input: 'lo',
        bright: 'on',
        jumpered: 'on',
        volumeNormal: 0.62,
        volumeBright: 0.38,
        tone: 0.44,
        inverter: 'composed',
      },
    },
  },
};

const ALL_FIXTURES: readonly VoicePreset[] = [
  ...FIXTURES,
  PLUCK_LAYERED,
  STATIC_FILTERED,
  DELUXE_CIRCUIT_AMP,
];

/**
 * Compile-time coverage of the lib types this slice addresses. `Record<keyof X, true>`
 * means `tsc` fails if the lib adds a field and the schema does not declare it; the
 * runtime assertion below fails if a declared path is dropped. Without this, deleting
 * `effects.amp.treble` passes every other test in the file and the pane builds a
 * `Tone.EQ3` with `high: undefined`.
 */
const AMP_LEAVES: Record<keyof AmpParams, true> = {
  enabled: true,
  modelId: true,
  preGainDb: true,
  preDrive: true,
  bass: true,
  mid: true,
  treble: true,
  presence: true,
  powerDrive: true,
  outputDb: true,
};
const CAB_IR_LEAVES: Record<keyof CabIRParams, true> = { enabled: true, url: true, makeupDb: true };
/** The room, which hangs off the Cabinet section as a sub-branch rather than
 *  under `effects.cabIR` — hence its own table and its own assertion. */
const VOICE_REVERB_LEAVES: Record<keyof VoiceReverbParams, true> = {
  enabled: true,
  roomSize: true,
  wet: true,
};

/**
 * The pedals, same trick and the same reason. `Tone.Compressor` and the five
 * effects each have a params interface in the lib, and a field added to one that
 * the table does not declare is a knob the pane will never show — which no other
 * assertion in this file can see, because an undeclared path is simply never
 * walked.
 */
const COMPRESSOR_LEAVES: Record<keyof CompressorParams, true> = {
  enabled: true,
  threshold: true,
  ratio: true,
  attack: true,
  release: true,
  knee: true,
};
const DISTORTION_LEAVES: Record<keyof DistortionParams, true> = {
  enabled: true,
  drive: true,
  wet: true,
  oversample: true,
};
const CHORUS_LEAVES: Record<keyof ChorusParams, true> = {
  enabled: true,
  frequency: true,
  depth: true,
  wet: true,
  type: true,
  feedback: true,
  delayTime: true,
  spread: true,
};
const DELAY_LEAVES: Record<keyof DelayParams, true> = {
  enabled: true,
  delayTime: true,
  feedback: true,
  wet: true,
};
const AUTO_WAH_LEAVES: Record<keyof AutoWahParams, true> = {
  enabled: true,
  baseFrequency: true,
  octaves: true,
  sensitivity: true,
  q: true,
  gain: true,
  wet: true,
};
/** The final EQ — a section of its own, after the cabinet and the room. Its own
 *  table for the same reason the room has one: it hangs off no other stage. */
const FINAL_EQ_LEAVES: Record<keyof EQParams, true> = {
  enabled: true,
  low: true,
  mid: true,
  high: true,
  lowFrequency: true,
  highFrequency: true,
};
const GRAPHIC_EQ_LEAVES: Record<keyof GraphicEqParams, true> = {
  enabled: true,
  band100Hz: true,
  band200Hz: true,
  band400Hz: true,
  band800Hz: true,
  band1_6kHz: true,
  band3_2kHz: true,
  band6_4kHz: true,
  levelDb: true,
};
/**
 * ⚠ `pan` IS DELETED RATHER THAN DEFERRED, which is why this is an `Omit` and not
 * a full `Record`. The voice's pan went with the Level section on 2026-09-18:
 * panning is the TRACK's, in the track header, and two pans in series was the
 * duplication the IN/OUT bar exists to untangle. The `Omit` still bites the way
 * every other one here does — a lib rename makes it a no-op and the `Record` then
 * demands the new field.
 */
const LEVEL_LEAVES: Record<keyof Omit<VoiceLevel, 'pan'>, true> = { volumeDb: true };

/**
 * The source arms, same trick. The `Omit`s name what is DEFERRED rather than
 * omitted-by-accident, and they still bite: a lib rename makes the `Omit` a no-op
 * and the `Record` then demands the new field.
 *
 * Deferred here: the sampler's `attack`/`curve` and the envelopes' three curve
 * fields (both are shape-of-the-ramp controls that belong with the slice that
 * draws a ramp), and FM `portamento` (a glide, which is a performance control
 * rather than a source setting and has no bound documented anywhere).
 */
type SamplerSource = Extract<VoiceSource, { kind: 'sampler' }>;
const SAMPLER_LEAVES: Record<keyof Omit<SamplerSource, 'attack' | 'curve'>, true> = {
  kind: true,
  samples: true,
  release: true,
};
const PLUCK_LEAVES: Record<keyof PluckSynthParams, true> = {
  attackNoise: true,
  dampening: true,
  resonance: true,
  release: true,
};
const FM_LEAVES: Record<keyof Omit<FMSynthParams, 'portamento'>, true> = {
  harmonicity: true,
  modulationIndex: true,
  detune: true,
  carrierWaveform: true,
  modulatorWaveform: true,
  envelope: true,
  modulationEnvelope: true,
};
const ADSR_LEAVES: Record<
  keyof Omit<ADSREnvelope, 'attackCurve' | 'decayCurve' | 'releaseCurve'>,
  true
> = { attack: true, decay: true, sustain: true, release: true };

/** The layer's own fields. `source` is omitted because it is not a leaf — it is a
 *  whole `VoiceSource`, covered by the `layer.source.*` rows and by the
 *  sub-branch's `kindRow`, both asserted separately below. */
const LAYER_LEAVES: Record<keyof Omit<VoiceLayer, 'source'>, true> = {
  gainDb: true,
  octaveOffset: true,
  detuneCents: true,
};

const BODY_FILTER_LEAVES: Record<keyof BodyFilterParams, true> = {
  enabled: true,
  cutoff: true,
  q: true,
  envelope: true,
};

const FREQUENCY_ENVELOPE_LEAVES: Record<keyof BodyFilterEnvelope, true> = {
  attack: true,
  decay: true,
  sustain: true,
  release: true,
  baseFrequency: true,
  octaves: true,
};

/** Every violation is reported as a string so a failure lists all of them at once
 *  instead of stopping at the first. */
function violationsFor(preset: VoicePreset, param: Param): readonly string[] {
  // A row this preset does not have is not a row this preset can violate. The
  // gate, not a convenience: without it every FM range below would be asserted
  // against a sampler and quietly pass on an absent path.
  if (!paramApplies(preset, param)) return [];

  const at = `${preset.id} @ ${param.path}`;
  const present = hasPath(preset, param.path);
  const value = getAtPath(preset, param.path);

  if (!present || value === undefined) {
    return param.optional ? [] : [`${at}: declared non-optional but absent`];
  }

  switch (param.kind) {
    case 'slider':
      if (typeof value !== 'number') return [`${at}: expected a number, got ${typeof value}`];
      if (value < param.min || value > param.max) {
        return [`${at}: ${value} is outside the declared range ${param.min}..${param.max}`];
      }
      return [];

    case 'encoder':
      // No range assertion, deliberately — an encoder exists precisely because
      // Tone publishes no bound for the field. Only that it is a real number.
      return typeof value === 'number' && Number.isFinite(value)
        ? []
        : [`${at}: expected a finite number, got ${String(value)}`];

    case 'toggle':
      return typeof value === 'boolean' ? [] : [`${at}: expected a boolean, got ${typeof value}`];

    case 'enum':
    case 'source-kind': {
      if (typeof value !== 'string') return [`${at}: expected a string, got ${typeof value}`];
      return optionValues(param).includes(value)
        ? []
        : [`${at}: ${JSON.stringify(value)} is not one of the declared options`];
    }

    case 'sample-pack': {
      if (!Array.isArray(value)) return [`${at}: expected an array of sample banks`];
      // The preset stores note→URL maps, so the only way to name the selection is
      // the lib's shape matcher.
      const pack = detectSamplePack(value as ReadonlyArray<Record<string, string>>);
      if (!pack) return [`${at}: no registered SamplePack matches these banks`];
      return optionValues(param).includes(pack.id)
        ? []
        : [`${at}: matched pack ${pack.id} is not among the declared options`];
    }
  }
}

/**
 * ⚠ `violationsFor` IS THE FILE'S ONE CHECK, and every other block asserts it returns
 * `[]`. Nothing above can tell "no violation" from "the check never ran": gut the
 * `slider` case to `return []`, or delete the range comparison, or the `typeof` guards,
 * and every one of those blocks still passes — including `stale built-in values`, which
 * recomputes the comparison independently rather than going through here.
 *
 * So these are the negatives. Each mutates one field of a fixture that is otherwise
 * valid, and asserts exactly one violation naming that path — the count matters, because
 * a check that fires on everything is as useless as one that fires on nothing.
 */
describe('violationsFor itself', () => {
  const only = (preset: VoicePreset, path: string): string => {
    const found = violationsFor(preset, paramAt(path));
    expect(found, path).toHaveLength(1);
    expect(found[0], path).toContain(path);
    return found[0];
  };

  it('catches a slider one step past its declared max', () => {
    const volume = paramAt('level.volumeDb');
    if (volume.kind !== 'slider') throw new Error('level.volumeDb is no longer a slider');
    const over = setAtPath(FULLY_POPULATED_SAMPLER, 'level.volumeDb', volume.max + volume.step);
    expect(only(over, 'level.volumeDb')).toContain('outside the declared range');

    // …and the boundary itself is legal, so the comparison is `>` and not `>=`.
    expect(
      violationsFor(setAtPath(FULLY_POPULATED_SAMPLER, 'level.volumeDb', volume.max), volume),
    ).toEqual([]);
  });

  it('catches the wrong type in each numeric row', () => {
    // `level.volumeDb` stands in for what `level.pan` used to check here: pan is
    // no longer a declared row, so nothing can hand `violationsFor` a descriptor
    // for it.
    expect(
      only(setAtPath(FULLY_POPULATED_SAMPLER, 'level.volumeDb', 'loud'), 'level.volumeDb'),
    ).toContain('expected a number');
    // An encoder has no range to fail, so its type guard is the only check it has.
    const nan = setAtPath(FULLY_POPULATED_FM, 'source.params.harmonicity', Number.NaN);
    expect(only(nan, 'source.params.harmonicity')).toContain('expected a finite number');
    const flag = setAtPath(FULLY_POPULATED_SAMPLER, 'effects.amp.enabled', 'yes');
    expect(only(flag, 'effects.amp.enabled')).toContain('expected a boolean');
  });

  it('catches a required path that is simply absent', () => {
    const gone = removeAtPath(FULLY_POPULATED_SAMPLER, 'level.volumeDb');
    expect(only(gone, 'level.volumeDb')).toContain('declared non-optional but absent');
    // The optional ones are the contrast: absent is their normal state.
    expect(
      violationsFor(removeAtPath(FULLY_POPULATED_SAMPLER, 'inputGainDb'), paramAt('inputGainDb')),
    ).toEqual([]);
  });

  it('catches a value no picker offers', () => {
    const waveform = setAtPath(FULLY_POPULATED_FM, 'source.params.carrierWaveform', 'supersaw');
    expect(only(waveform, 'source.params.carrierWaveform')).toContain('not one of the declared');

    // A source kind the union has no arm for. Cast because that is the point: the type
    // cannot express it, and a hand-edited stored variant can.
    const unknownKind = {
      ...FULLY_POPULATED_SAMPLER,
      source: { ...FULLY_POPULATED_SAMPLER.source, kind: 'wavetable' },
    } as unknown as VoicePreset;
    expect(only(unknownKind, 'source.kind')).toContain('not one of the declared');
  });

  it('catches sample banks that match no registered pack', () => {
    const banks = setAtPath(FULLY_POPULATED_SAMPLER, 'source.samples', [
      { C4: 'https://example.invalid/not-a-pack.mp3' },
    ]);
    expect(only(banks, 'source.samples')).toContain('no registered SamplePack');
    expect(only(setAtPath(FULLY_POPULATED_SAMPLER, 'source.samples', 'a-pack-id'), 'source.samples')).toContain(
      'expected an array',
    );
  });

  it('skips a row the preset does not have — and that is not the same as passing it', () => {
    // The gate, stated as an assertion rather than assumed. `harmonicity` is absent from
    // a sampler AND non-optional, so without `paramApplies` this would report
    // "declared non-optional but absent" on ten of the fourteen built-ins.
    const harmonicity = paramAt('source.params.harmonicity');
    expect(paramApplies(FULLY_POPULATED_SAMPLER, harmonicity)).toBe(false);
    expect(violationsFor(FULLY_POPULATED_SAMPLER, harmonicity)).toEqual([]);
    expect(hasPath(FULLY_POPULATED_SAMPLER, harmonicity.path)).toBe(false);
    expect(harmonicity.optional).toBeUndefined();
  });

});

/**
 * ⚠ THE NUMBERS THIS SLICE EXISTS TO CORRECT, pinned individually.
 *
 * The previous attempt at the Source panel lifted every range from guitar-tutor's Sound
 * Lab, and nothing above would notice it happening again: the shipped pluck preset's
 * 1.5 / 6000 sit inside Sound Lab's ranges AND inside Tone's, so reverting `attackNoise`
 * to 0–1 or `dampening` to 0–8000 leaves every other test in this file green. Each
 * assertion below carries the page it came from — the documentation site, which is the
 * only source these are allowed to have.
 */
describe('documented bounds', () => {
  const bounds = (path: string): { min: number; max: number } => {
    const param = paramAt(path);
    if (param.kind !== 'slider') throw new Error(`${path} is not a bounded row`);
    return { min: param.min, max: param.max };
  };

  it('takes the sampler`s release from classes/Sampler.html', () => {
    // https://tonejs.github.io/docs/15.1.22/classes/Sampler.html — `release` Min: 0,
    // Max: 1. The ten sampler presets were retuned to 1.0 to fit this rather than
    // the range being widened to fit them.
    expect(bounds('source.release')).toEqual({ min: 0, max: 1 });
  });

  it('takes the pluck synth`s two bounded rows from classes/PluckSynth.html', () => {
    // https://tonejs.github.io/docs/15.1.22/classes/PluckSynth.html — `attackNoise`
    // Min: 0.1 / Max: 20 ("Nominal range of [0.1, 20]"), `dampening` Min: 0 / Max: 7000.
    // Sound Lab had 0–1 and 0–8000 respectively; both are wrong.
    expect(bounds('source.params.attackNoise')).toEqual({ min: 0.1, max: 20 });
    expect(bounds('source.params.dampening')).toEqual({ min: 0, max: 7000 });
  });

  it('takes both envelopes` bounded rows from classes/Envelope.html', () => {
    // https://tonejs.github.io/docs/15.1.22/classes/Envelope.html — `attack` and `decay`
    // Min: 0 / Max: 2, `release` Min: 0 / Max: 5. Both envelopes are generated from one
    // function precisely so they cannot acquire different bounds; asserted on both
    // anyway, because that generator is one edit away from taking a range argument.
    for (const branch of ['source.params.envelope', 'source.params.modulationEnvelope']) {
      expect(bounds(`${branch}.attack`), branch).toEqual({ min: 0, max: 2 });
      expect(bounds(`${branch}.decay`), branch).toEqual({ min: 0, max: 2 });
      expect(bounds(`${branch}.release`), branch).toEqual({ min: 0, max: 5 });
    }
  });

  it('takes the cutoff envelope`s three bounded rows from classes/FrequencyEnvelope.html', () => {
    // https://tonejs.github.io/docs/15.1.22/classes/FrequencyEnvelope.html —
    // `attack` and `decay` Min: 0 / Max: 2, `release` Min: 0 / Max: 5. The SAME
    // three numbers `classes/Envelope.html` publishes for the amplitude envelope,
    // and a DIFFERENT node: `buildChain` builds a `Tone.FrequencyEnvelope` here
    // and Tone.js builds a `Tone.Envelope` inside the FM synth. Asserted against
    // its own page rather than shared with `envelopeRows`, so the two cannot come
    // to rest on one citation that only covers one of them.
    expect(bounds('bodyFilter.envelope.attack')).toEqual({ min: 0, max: 2 });
    expect(bounds('bodyFilter.envelope.decay')).toEqual({ min: 0, max: 2 });
    expect(bounds('bodyFilter.envelope.release')).toEqual({ min: 0, max: 5 });
  });

  it('owns `layer.octaveOffset` outright, because there is no node to cite', () => {
    // ⚠ THE ONE BOUNDED ROW IN THE TABLE WITH NO DOCUMENTATION BEHIND IT, and it
    // is pinned here so that stays deliberate. `octaveOffset` is not a Tone
    // property: `Voice.play` transposes the layer's note by `octaveOffset * 12`
    // semitones in JavaScript before triggering it, so no page on tonejs.github.io
    // has anything to say about it and the rule the rest of this block enforces
    // does not reach it. ±2 is the APP's fence — see the row's own comment. The
    // lib's "-2..+2 typical" is not the source; it is a second opinion that agrees.
    expect(bounds('layer.octaveOffset')).toEqual({ min: -2, max: 2 });
    const octave = paramAt('layer.octaveOffset');
    if (octave.kind !== 'slider') throw new Error('layer.octaveOffset is no longer a slider');
    // Integers only. A third of an octave is not a thing `transposeNote` can be
    // given — `octaveOffset * 12` has to land on a semitone.
    expect(octave.step).toBe(1);
    expect(octave.precision).toBe(0);
  });

  it('leaves the undocumented values unbounded, as encoders', () => {
    // The other half of the same rule, and the one a well-meaning "let`s give this a
    // sensible range" edit would break: these are encoders BECAUSE their own pages
    // publish Min:/Max: for their neighbours and nothing for them. Turning one into a
    // slider means inventing the fence. (Re-verified against the three pages above and
    // classes/FMSynth.html, which documents no bound for harmonicity, modulationIndex
    // or detune.)
    //
    // The body filter's two and the frequency envelope's three are the same rule
    // read off two more pages: classes/Filter.html publishes NO Min:/Max: for
    // `frequency`, `Q`, `gain` or `detune` (its only bounded statement is that
    // `rolloff` accepts -12, -24, -48 and -96, and the lib exposes no rolloff), and
    // classes/FrequencyEnvelope.html publishes none for `sustain`, `baseFrequency`
    // or `octaves` on the page that bounds its other three. `layer.gainDb` is
    // classes/Gain.html, which publishes no bound for `gain` or for anything else.
    const unbounded = [
      'source.params.resonance',
      'source.params.release',
      'source.params.harmonicity',
      'source.params.modulationIndex',
      'source.params.detune',
      'source.params.envelope.sustain',
      'source.params.modulationEnvelope.sustain',
      'layer.gainDb',
      'layer.detuneCents',
      'layer.source.params.resonance',
      'layer.source.params.release',
      'layer.source.params.harmonicity',
      'layer.source.params.modulationIndex',
      'layer.source.params.envelope.sustain',
      'layer.source.params.modulationEnvelope.sustain',
      'bodyFilter.cutoff',
      'bodyFilter.q',
      'bodyFilter.envelope.sustain',
      'bodyFilter.envelope.baseFrequency',
      'bodyFilter.envelope.octaves',
      // The final EQ's five, off `component/filter/EQ3.d.ts` (15.1.22) and the
      // `component/channel/MultibandSplit.d.ts` it splits with: `low`/`mid`/`high`
      // are `Param<"decibels">` and the two crossovers `Signal<"frequency">`, and
      // neither file carries a `@min` or a `@max` for any of them. Listed here
      // because the lib's own "Range typically -12..+12" comment is exactly the
      // invitation this test exists to refuse — turning one of these into a
      // `slider` fenced at ±12 otherwise breaks nothing in this file.
      'effects.finalEq.low',
      'effects.finalEq.mid',
      'effects.finalEq.high',
      'effects.finalEq.lowFrequency',
      'effects.finalEq.highFrequency',
    ];
    expect(unbounded.map((path) => paramAt(path).kind)).toEqual(unbounded.map(() => 'encoder'));
  });

  it('gives the second source the primary`s ranges, because it is the same node', () => {
    // The point of generating both branches from one function: a bound is a fact
    // about `Tone.PluckSynth` / `Tone.FMSynth`, and `buildSynth` builds the same
    // two whichever branch it reads. Compared field by field rather than trusting
    // the generator, because "generated" is one refactor away from "was generated".
    for (const leaf of [
      'params.attackNoise',
      'params.dampening',
      'params.envelope.attack',
      'params.envelope.decay',
      'params.envelope.release',
      'params.modulationEnvelope.attack',
      'params.modulationEnvelope.decay',
      'params.modulationEnvelope.release',
    ]) {
      expect(bounds(`layer.source.${leaf}`), leaf).toEqual(bounds(`source.${leaf}`));
    }
  });

  it('declares no `detune` on the layer`s FM source, because the engine overwrites it', () => {
    // `_buildLayer` constructs the synth with `detune: p.detune` and then calls
    // `applyLayerDetune`, which writes `synth.detune.value = layer.detuneCents` —
    // and `updateLayer`'s retune path does the same two writes in the same order.
    // So `layer.source.params.detune` can never be heard, and a row for it would
    // be a second knob for one property with this one always losing.
    expect(ALL_PARAMS.map((p) => p.path)).toContain('source.params.detune');
    expect(ALL_PARAMS.map((p) => p.path)).not.toContain('layer.source.params.detune');
    expect(ALL_PARAMS.map((p) => p.path)).toContain('layer.detuneCents');
  });
});

describe('schema vs. every built-in VoicePreset', () => {
  it('covers presets from all three instruments', () => {
    // Guards against the loop below silently testing nothing if the lib's export
    // shape changes.
    expect(VOICE_PRESETS.length).toBeGreaterThanOrEqual(14);
    expect(new Set(VOICE_PRESETS.map((p) => p.instrumentId))).toEqual(
      new Set(['guitar', 'bass', 'ukulele']),
    );
  });

  it('ships a built-in of every source kind, so no arm of the table is untested', () => {
    // Ten samplers, one pluck synth, three FM. If the lib ever drops one of the
    // three, the rows for it are exercised only by a fixture and this says so.
    expect(new Set(VOICE_PRESETS.map((p) => p.source.kind))).toEqual(new Set(SOURCE_KINDS));
  });

  // `electric-guitar` is skipped: it is the one shipped voice the app withdrew from
  // the picker (2026-09-01), so its `source.kind` is deliberately not an option any
  // more. Every other shipped voice is still walked.
  for (const preset of VOICE_PRESETS.filter((p) => p.id !== 'electric-guitar')) {
    it(`${preset.id}: every applicable path resolves and every value is in range`, () => {
      // `LEVEL_BAR_PARAMS` is appended by hand, and it has to be: the two bar rows
      // left `PARAM_SECTIONS` when the Level section was deleted, and a walk built
      // from the sections alone stopped range-checking them against a shipped
      // preset without failing — which is exactly the silence this loop exists to
      // break. They apply to every preset, as the old section's null probe did.
      const rows = [
        ...PARAM_SECTIONS.filter((section) => sectionApplies(preset, section)).flatMap(
          (section) => section.params,
        ),
        ...LEVEL_BAR_PARAMS,
      ];
      const violations = rows.flatMap((param) => violationsFor(preset, param));

      expect(violations).toEqual([]);
    });
  }

  it('shows the Source section on every one of the fourteen, never absent', () => {
    // The whole point of the rename: `Samples` probed `source.samples` and so was
    // ABSENT on the four synth-sourced built-ins. A source is not optional.
    const source = sectionAt('source');
    expect(source.presenceProbe).toBeNull();
    for (const preset of VOICE_PRESETS) {
      expect(sectionApplies(preset, source), preset.id).toBe(true);
      // …and it is never empty either: the kind row applies unconditionally, so
      // the section always has at least the picker plus that kind's own settings.
      expect(visibleParams(preset, source).length, preset.id).toBeGreaterThan(1);
    }
  });

  it('shows only the current source kind`s rows', () => {
    // Scoped to the rows conditioned on the PRIMARY discriminant: the same
    // section now also carries the second source's rows, which answer to
    // `layer.source.kind` and are checked by their own test below.
    const primaryRows = sectionAt('source').params.filter(
      (param) => param.appliesWhen?.path === 'source.kind',
    );
    expect(primaryRows.length).toBeGreaterThan(0);

    for (const preset of VOICE_PRESETS) {
      const shown = ownParams(preset, sectionAt('source'));
      for (const param of shown) {
        if (param.appliesWhen?.path !== 'source.kind') continue;
        expect(param.appliesWhen.oneOf, `${preset.id} @ ${param.path}`).toContain(
          preset.source.kind,
        );
      }
      // And the converse: nothing belonging to another kind slipped through.
      for (const param of primaryRows) {
        if (shown.includes(param)) continue;
        expect(param.appliesWhen?.oneOf ?? [], `${preset.id} @ ${param.path}`).not.toContain(
          preset.source.kind,
        );
      }
    }
  });

  it('shows the second source`s rows on exactly the three built-ins that carry one', () => {
    // Acoustic Bass, Electric Bass and Acoustic Ukulele — all FM layers. The
    // count is asserted so this cannot quietly become "on none of them", which is
    // the shape the bug would take if `requiresBranch` stopped being evaluated.
    const withLayer = VOICE_PRESETS.filter((preset) => preset.layer !== undefined);
    expect(withLayer.map((p) => p.id).sort()).toEqual([
      'acoustic-bass',
      'acoustic-ukulele',
      'electric-bass',
    ]);

    const source = sectionAt('source');
    const { sub } = subBranchAt('layer');
    for (const preset of VOICE_PRESETS) {
      const has = preset.layer !== undefined;
      expect(subBranchApplies(preset, sub), preset.id).toBe(has);
      // Its mix rows appear exactly when it does…
      const branchPaths = branchParams(preset, source).map((p) => p.path);
      expect(branchPaths.includes('layer.gainDb'), preset.id).toBe(has);
      expect(branchPaths.includes('layer.octaveOffset'), preset.id).toBe(has);
      // …and never leak into the section's own rows.
      expect(
        ownParams(preset, source).some((p) => p.path.startsWith('layer.')),
        preset.id,
      ).toBe(false);
    }
  });

  it('shows the body filter on exactly the one built-in that carries one', () => {
    const withFilter = VOICE_PRESETS.filter((preset) =>
      sectionApplies(preset, sectionAt('body-filter')),
    );
    expect(withFilter.map((p) => p.id)).toEqual(['electric-guitar']);
    // …and its real values reach the rows, rather than the rows falling back.
    expect(getAtPath(withFilter[0], 'bodyFilter.cutoff')).toBe(5500);
    expect(getAtPath(withFilter[0], 'bodyFilter.envelope.octaves')).toBe(1.5);
    expect(branchParams(withFilter[0], sectionAt('body-filter')).map((p) => p.path)).toEqual([
      'bodyFilter.envelope.attack',
      'bodyFilter.envelope.decay',
      'bodyFilter.envelope.sustain',
      'bodyFilter.envelope.release',
      'bodyFilter.envelope.baseFrequency',
      'bodyFilter.envelope.octaves',
    ]);
  });

  /**
   * Sections no shipped preset carries, and is not meant to.
   *
   * `circuit-amp` is the experimental amp engine. It was added BESIDE the five
   * models in `amp-models.ts` precisely so that no existing preset changes
   * behaviour, and putting one on a built-in would undo that — `wireChain`
   * builds one amp or the other, so a shipped preset carrying a circuit amp
   * would silently stop using the amp it was voiced with.
   *
   * Its rows are covered by the fixtures instead (`POPULATED_CHASSIS`), which
   * is where every `enabled` / `modelId` / `inputGainDb` path is already
   * exercised. Delete this exemption if the engine ever stops being
   * experimental and a built-in is voiced on it.
   */
  const SECTIONS_NO_BUILTIN_CARRIES: readonly SectionId[] = ['circuit-amp'];

  it('finds at least one preset exercising each section, so no section is untested', () => {
    for (const section of PARAM_SECTIONS) {
      if (SECTIONS_NO_BUILTIN_CARRIES.includes(section.id)) continue;
      const exercising = VOICE_PRESETS.filter((preset) => sectionApplies(preset, section));
      expect(exercising.length, `no built-in preset has section ${section.id}`).toBeGreaterThan(0);
    }
  });

  it('covers every exempted section with a fixture instead', () => {
    // The exemption above must not become a way to smuggle in an untested
    // section: what a built-in does not cover, a fixture has to.
    for (const id of SECTIONS_NO_BUILTIN_CARRIES) {
      const section = sectionAt(id);
      expect(
        ALL_FIXTURES.some((fixture) => sectionApplies(fixture, section)),
        `no fixture has exempted section ${id}`,
      ).toBe(true);
    }
  });

  it('finds a built-in with each optional key both present and absent where that matters', () => {
    // `makeupDb` present on exactly one built-in and absent on the rest is what
    // makes the absent-vs-bypassed distinction load-bearing rather than theoretical.
    const makeupDb = paramAt('effects.cabIR.makeupDb').path;
    // The SPEAKER's branch, not `sectionApplies`: the Cabinet pane applies to a
    // voice carrying only a room, and a room has no makeup gain to have set or
    // left unset. Asking the pane would put a preset in this set that cannot
    // witness either half of the assertion.
    const withCab = VOICE_PRESETS.filter((p) => hasBranchAtPath(p, 'effects.cabIR'));
    expect(withCab.some((p) => hasPath(p, makeupDb))).toBe(true);
    expect(withCab.some((p) => !hasPath(p, makeupDb))).toBe(true);
  });
});

describe('every declared path against the per-kind fixtures', () => {
  it('gives every source kind a fixture — the primary`s and the layer`s', () => {
    expect(FIXTURES.map((f) => f.source.kind)).toEqual(SOURCE_KINDS);
    // The second axis. `sampler` is deliberately absent: the picker does not
    // offer it and no `layer.source.*` sampler row is declared, so there is
    // nothing for a fixture to cover — see `LAYER_SUB_BRANCH`.
    expect(
      ALL_FIXTURES.flatMap((f) => (f.layer ? [f.layer.source.kind] : [])),
    ).toEqual(expect.arrayContaining(['fm-synth', 'pluck-synth']));
  });

  it('applies every declared row to at least one fixture', () => {
    // The coverage assertion the single `FULLY_POPULATED` could no longer make: a
    // row whose condition matches nothing is a control nobody can ever see, and it
    // would otherwise be silently skipped by every check in this file.
    const unreachable = ALL_PARAMS.filter(
      (param) => !ALL_FIXTURES.some((fixture) => paramApplies(fixture, param)),
    ).map((param) => param.path);
    expect(unreachable).toEqual([]);
  });

  for (const fixture of ALL_FIXTURES) {
    it(`${fixture.id}: resolves every applicable path, optional ones included`, () => {
      // The assertion the built-in loop cannot make: no shipped preset sets
      // `enabled`, `modelId` or `inputGainDb`, so those paths are only ever
      // exercised here. A typo in one fails this test (or `tsc`, on the literal).
      const missing = ALL_PARAMS.filter(
        (param) => paramApplies(fixture, param) && !hasPath(fixture, param.path),
      ).map((param) => param.path);
      expect(missing).toEqual([]);
    });

    it(`${fixture.id}: applies every section`, () => {
      const inapplicable = PARAM_SECTIONS.filter(
        (section) => !sectionApplies(fixture, section),
      ).map((section) => section.id);
      expect(inapplicable).toEqual([]);
    });

    it.skipIf(fixture.source.kind === 'pluck-synth')(
      `${fixture.id}: accepts every value, reaching the checks the built-ins skip`,
      () => {
        // In particular the `toggle` branch of `violationsFor`, unreachable from the
        // built-ins because none of them sets an `enabled` field — and, for the
        // sampler fixture, an in-range `source.release`, which no built-in has.
        // Skipped for the pluck fixture: that kind was withdrawn from the picker on
        // 2026-09-01, so its `source.kind` is no longer a declared option. The
        // fixture itself stays — three other assertions still need it.
        expect(ALL_PARAMS.flatMap((param) => violationsFor(fixture, param))).toEqual([]);
      },
    );
  }
});

describe('section presence', () => {
  it('reads a guarded-undefined branch as absent, not as present-and-bypassed', () => {
    // The lib builds `effects: KARORYFER_GREEN_CAB ? {...} : undefined` and
    // `cabIR: getCabinetIR(id) ? {...} : undefined`, so a key can exist with an
    // `undefined` value. Every shipped preset resolves its IR today, so no loop over
    // `VOICE_PRESETS` can pin this — and a `hasPath`-based probe would render a
    // Cabinet section with no cabinet the first time the IR registry moves.
    const noCab: VoicePreset = { ...FULLY_POPULATED_SAMPLER, effects: { cabIR: undefined } };
    expect(hasPath(noCab, 'effects.cabIR')).toBe(true);
    expect(sectionApplies(noCab, sectionAt('cabinet'))).toBe(false);

    const noEffects: VoicePreset = { ...FULLY_POPULATED_SAMPLER, effects: undefined };
    expect(hasPath(noEffects, 'effects')).toBe(true);
    expect(sectionApplies(noEffects, sectionAt('amp'))).toBe(false);
  });

  it('never calls a probe-less section absent', () => {
    // Source has no probe because a voice always has one, and the pedalboard has
    // none because the stage is always there — it is the six pedals inside it that
    // come and go. Level was the third and is not a section any more: its two rows
    // are the IN/OUT bar, which nothing can fold or remove.
    expect(PARAM_SECTIONS.filter((section) => section.presenceProbe === null).map((s) => s.id)).toEqual(
      ['source', 'pedals'],
    );
    for (const preset of VOICE_PRESETS) {
      expect(sectionApplies(preset, sectionAt('source')), preset.id).toBe(true);
      expect(sectionApplies(preset, sectionAt('pedals')), preset.id).toBe(true);
    }
  });

  it('gives every removable section a row `addVoiceSection` can actually seed', () => {
    // `addVoiceSection` writes the branch in EMPTY and then fills it from its rows'
    // `fallback`s. A section whose rows were all optional, all of a kind the seed
    // loop skips, or all gated on something the loop has not written yet would
    // commit `effects.<x> = {}` — and the lib reads a present-but-empty branch as
    // an ENABLED stage (`isStageEnabled`), handing a convolver a URL of
    // `undefined`. Today every removable section has at least one such row; the
    // failure is silent at the seam and audible much later, which is why it is
    // pinned here rather than left to the four that happen to be fine.
    for (const section of PARAM_SECTIONS) {
      const branch = section.removableBranch;
      if (branch === null) continue;
      const seedable = section.params.filter(
        (param) =>
          param.path.startsWith(`${branch}.`) &&
          !param.optional &&
          // The two kinds the seed loop deliberately writes nothing for.
          param.kind !== 'sample-pack' &&
          param.kind !== 'source-kind' &&
          param.appliesWhen === undefined &&
          param.absentBranch === undefined &&
          // A gate naming the section's OWN branch is satisfied by the time the
          // loop reaches the row — that branch went in first. A gate naming
          // anything else is not, and would seed nothing.
          (param.requiresBranch === undefined || param.requiresBranch === branch),
      );
      expect(seedable.map((p) => p.path), section.id).not.toHaveLength(0);
    }
  });

  it('seeds a COMPLETE `EQParams` when the final EQ is added', () => {
    // The test above asks every removable section for at least one seedable row.
    // This stage needs all five: `EQParams` has no optional value field, and
    // `buildChain` passes whatever the branch holds straight into `new Tone.EQ3`,
    // where a missing one is an `undefined` on a `Param`. A row that quietly
    // acquired `optional: true` — or a field the lib adds that this table does not
    // declare — would leave the Add writing a partial branch that reads as a live
    // stage, which no other assertion here can see.
    const seeded = FINAL_EQ_OWN_PARAMS.filter((param) => !param.optional).map((param) =>
      param.path.slice('effects.finalEq.'.length),
    );
    const required = Object.keys(FINAL_EQ_LEAVES).filter((leaf) => leaf !== 'enabled');
    expect([...seeded].sort()).toEqual([...required].sort());
  });

  it('agrees with itself about the final EQ — the seed and the rows` fallbacks', () => {
    // The same check the room gets above, and for the same reason: `SEED_FINAL_EQ`
    // is what the rows read their `fallback`s from, so pinning the fallbacks pins
    // the seed — and an Add writes the fallbacks, so these five numbers ARE the
    // stage a user gets.
    //
    // They are Tone's own: `EQ3.getDefaults()` (15.1.22) returns `low`/`mid`/`high`
    // 0 and `lowFrequency`/`highFrequency` 400/2500. Flat at Tone's crossovers is
    // the only starting point that cannot change a voice at the moment the stage
    // is added, and nothing else here would notice if one drifted — an encoder
    // has no range for a fallback to violate.
    const flat = { low: 0, mid: 0, high: 0, lowFrequency: 400, highFrequency: 2500 };
    for (const [leaf, value] of Object.entries(flat)) {
      const row = paramAt(`effects.finalEq.${leaf}`);
      expect(row.kind === 'encoder' && row.fallback, leaf).toBe(value);
    }
    // `enabled` is deliberately outside that list: it is optional, `addVoiceSection`
    // skips it, and `undefined` means "in the chain" — which is what the row's
    // `fallback: true` says too.
    const enabled = paramAt('effects.finalEq.enabled');
    expect(enabled.optional).toBe(true);
    expect(enabled.kind === 'toggle' && enabled.fallback).toBe(true);
  });

  it('lists two probes on the Cabinet and one everywhere else', () => {
    // ⚠ THE PIN ON THE WIDENING. `presenceProbe` accepts a list so that ONE pane
    // can hold two stages a user has separately — the speaker and the room. It is
    // not a general shape: a second listed section would silently acquire a pane
    // that stays on screen over branches its rows are not gated on, which is the
    // exact failure the Cabinet's `requiresBranch` rows exist to prevent. So the
    // array is named here, and everything else is asserted to be a plain string.
    expect(sectionAt('cabinet').presenceProbe).toEqual(['effects.cabIR', 'effects.reverb']);
    // Both halves are real branches of this section: its own removable one, and
    // its sub-branch's. A listed path nothing creates would be a pane that never
    // opens for it.
    expect(probePaths(sectionAt('cabinet'))).toContain(sectionAt('cabinet').removableBranch);
    expect(probePaths(sectionAt('cabinet'))).toContain(sectionAt('cabinet').subBranch?.branch);

    for (const section of PARAM_SECTIONS) {
      if (section.id === 'cabinet') continue;
      expect(
        section.presenceProbe === null || typeof section.presenceProbe === 'string',
        section.id,
      ).toBe(true);
    }
    for (const pedal of PEDALS) {
      expect(typeof pedal.presenceProbe, pedal.id).toBe('string');
    }
  });

  it('marks exactly one sub-branch independent, and gives it a listed probe', () => {
    // The room stands outside its section's removable branch; the other two nest
    // inside theirs and go absent with the section, which is what makes an
    // envelope-with-no-filter unreachable rather than merely unlikely.
    const independent = SUB_BRANCHES.filter(({ sub }) => sub.independent);
    expect(independent.map(({ sub }) => sub.id)).toEqual(['cabinet-room']);

    for (const { section, sub } of SUB_BRANCHES) {
      const owner = section.removableBranch;
      const nested = owner !== null && sub.branch.startsWith(`${owner}.`);
      // The flag answers "does this survive the section's Remove", so it is set
      // exactly when there IS a Remove and the branch sits outside what it
      // deletes. The two must not drift: a nested branch declared independent
      // would have its Add offered under a section that cannot hold it, and an
      // outside branch left dependent is a stage the pane loses track of the
      // moment the section goes. A section with no removable branch has no
      // gesture to survive — the Source section's layer — so the flag stays off.
      expect(sub.independent === true, sub.id).toBe(owner !== null && !nested);
      // An independent branch has to be REACHABLE with the section's own branch
      // gone, which is what listing it in the probe buys.
      if (sub.independent) expect(probePaths(section), sub.id).toContain(sub.branch);
    }
  });
});

/**
 * A row is conditional if EITHER clause of `paramApplies` gates it: `appliesWhen`
 * (which arm of a union) or `requiresBranch` (is the optional branch there).
 * Counted rather than listed, so adding a row is not a failing test while
 * dropping a condition is.
 *
 * Every Source row except the primary's kind picker is conditional — the picker
 * is how you leave a kind, so it applies always. Everything under a sub-branch is
 * conditional. Amp, Cabinet, the bar's two rows and the body filter's own three
 * are not.
 */
const isConditional = (param: Param): boolean =>
  param.appliesWhen !== undefined ||
  param.requiresBranch !== undefined ||
  param.absentBranch !== undefined;

/** The per-amp knob rows: everything in the section except the three every amp
 *  carries. Derived, so a new amp's controls are counted without editing this
 *  file — and so a row that loses its gate still fails the count. */
const CIRCUIT_AMP_CONTROL_PARAMS = sectionAt('circuit-amp').params.filter(
  (p) => p.path.startsWith('effects.circuitAmp.controls.'),
);

/**
 * The Cabinet's own rows — the speaker's, as opposed to the room's.
 *
 * By PATH PREFIX rather than through `ownParams`, deliberately: `ownParams`
 * filters by `paramApplies`, which is the very gate the rules below are checking,
 * so deriving the allowed set from it would permit whatever gate a future cab row
 * happened to carry. The branch is what makes a row the speaker's; the GATE is
 * asserted, not assumed.
 */
const CAB_OWN_PARAMS = sectionAt('cabinet').params.filter((p) =>
  p.path.startsWith('effects.cabIR.'),
);

/**
 * The final EQ's rows — all six of them, the stage's bypass included.
 *
 * By PATH PREFIX for the reason `CAB_OWN_PARAMS` is: the gate is what the rules
 * below are checking, so deriving the set from anything that already reads the
 * gate would permit whatever a future row happened to carry.
 */
const FINAL_EQ_OWN_PARAMS = sectionAt('final-eq').params.filter((p) =>
  p.path.startsWith('effects.finalEq.'),
);

const CONDITIONAL_ROW_COUNT =
  sectionAt('source').params.length -
  1 +
  branchParams(FULLY_POPULATED_FM, sectionAt('body-filter')).length +
  // The room, the second sub-branch whose rows are gated on their own branch.
  // Derived the same way, off a fixture that carries `effects.reverb`, so a row
  // added to the room is counted without editing this file and a row that loses
  // its `requiresBranch` fails here.
  branchParams(FULLY_POPULATED_FM, sectionAt('cabinet')).length +
  // The Cabinet's OWN rows, which are gated too, and alone among the sections'
  // own rows. Its probe LISTS two branches — the speaker and the room — so it
  // answers "is this pane on screen" and no longer "is there a speaker"; each
  // cab row has to carry the gate the probe stopped supplying, or it would
  // render and be writable on a voice that has only the room.
  CAB_OWN_PARAMS.length +
  // `bodyFilter.cutoff`, the one row gated the other way round: it exists only
  // while the envelope does NOT, because the envelope overrides the Signal it
  // writes to. Counted separately because it is not under the sub-branch.
  1 +
  // EVERY pedal row, without exception. The pedalboard section is always present,
  // so a pedal's absence has nowhere to live but the row — see `pedalBypass`'s
  // note in `paramSchema`. A pedal row that lost its gate would drop this count
  // and fail here rather than becoming a control writing into a missing branch.
  ALL_PEDAL_PARAMS.length +
  // Every circuit-amp CONTROL row. The section's probe answers "is there a
  // circuit amp", never "which one", and different amps declare different
  // knobs — a Princeton has Volume and Tone where a Deluxe will have tremolo —
  // so the row is the only place "this control belongs to that amp" can live.
  // The section's own three rows (enabled / ampId / inputGainDb) are ungated,
  // because every circuit amp has them whatever its topology.
  CIRCUIT_AMP_CONTROL_PARAMS.length +
  // Every final-EQ row. Its probe is a single path and answers presence for the
  // pane, so the gate here is the seam's rather than the pane's — the section's
  // own comment in `paramSchema` carries the argument, and the rule below names
  // it as the sixth case.
  FINAL_EQ_OWN_PARAMS.length;


/**
 * Every branch some gesture in this app can actually create — a section's own
 * removable branch, a sub-branch, or a pedal — and therefore the only branches a
 * `requiresBranch` or an `absentBranch` may name.
 *
 * The test that reads this explains why "some row lives under it" is the wrong
 * check; what makes a gate legitimate is that something can OPEN it. A pedal
 * qualifies for exactly the reason a sub-branch does: it carries a seed and the
 * seams add and remove it by id.
 *
 * `removableBranch` joined the list with the Cabinet's own rows, and it is the
 * same rule rather than a relaxation of it: `voiceDrafts.addVoiceSection` creates
 * exactly that branch, by id, from the section's row fallbacks.
 *
 * ⚠ IT DOES COST THE LIST ONE THING, and the test below buys it back rather than
 * living without it. `bodyFilter` is now creatable, so membership alone would let
 * `bodyFilter.envelope.attack` be gated on `bodyFilter` — the gate one level too
 * loose that the old comment named as the mistake worth catching. The check is
 * therefore the INNERMOST creatable branch the row sits in, not any of them.
 */
const creatableBranches = [
  ...PARAM_SECTIONS.flatMap((section) =>
    section.removableBranch === null ? [] : [section.removableBranch],
  ),
  ...SUB_BRANCHES.map(({ sub }) => sub.branch),
  ...PEDALS.map((pedal) => pedal.branch),
];

/** The deepest creatable branch `path` sits inside, or `undefined` for a row in
 *  no optional branch at all. */
const innermostBranchOf = (path: string): string | undefined =>
  creatableBranches
    .filter((branch) => path.startsWith(`${branch}.`))
    .sort((a, b) => b.length - a.length)[0];

describe('row conditions', () => {
  it('conditions only on a path the table itself declares', () => {
    // A condition on an undeclared path is a row gated by something no control can
    // change — invisible for good, with nothing to say so. A sub-branch's `kindRow`
    // counts as declared: it is a real descriptor with a real control, kept out of
    // `section.params` for the reason `ParamSubBranch.kindRow` documents.
    const declared = new Set([
      ...ALL_PARAMS.map((p) => p.path),
      ...SUB_BRANCHES.flatMap(({ sub }) => (sub.kindRow ? [sub.kindRow.path] : [])),
    ]);
    // Counted first, because every assertion in this block sits inside a filter: strip
    // `appliesWhen` from every FM row and a loop over nothing would pass.
    expect(ALL_PARAMS.filter(isConditional)).toHaveLength(CONDITIONAL_ROW_COUNT);
    for (const param of ALL_PARAMS) {
      if (param.appliesWhen) expect(declared.has(param.appliesWhen.path), param.path).toBe(true);
      // A `requiresBranch` names a BRANCH, which is never a row's own path.
      //
      // ⚠ AND IT MUST BE A BRANCH SOMETHING CAN CREATE — the assertion that has
      // to be made, rather than "some row lives under it". Every `requiresBranch`
      // here is a prefix of its own row's path, so `ALL_PARAMS.some(startsWith)`
      // lets `bodyFilter.envelope.attack` witness its own gate, and even
      // excluding the row itself `requiresBranch: 'bodyFilter'` still passes on
      // the strength of `bodyFilter.cutoff` — a gate one level too loose, which
      // is exactly the mistake worth catching. A declared `subBranch` is the one
      // thing that makes a branch addable and removable, so that is the check: a
      // row gated on a branch no gesture can create is invisible for good.
      if (param.requiresBranch) {
        // The INNERMOST creatable branch the row lives in — see
        // `creatableBranches`. `bodyFilter` and `bodyFilter.envelope` are both
        // creatable and both prefixes of `bodyFilter.envelope.attack`; only the
        // second is that row's gate, and the first would leave the row rendering
        // over a filter with no envelope.
        expect(innermostBranchOf(param.path), param.path).toBe(param.requiresBranch);
      }
      // The complement, and here the row is never under the branch at all — a row
      // inside a branch cannot be gated on that branch's absence.
      if (param.absentBranch) {
        expect(param.path.startsWith(`${param.absentBranch}.`), param.path).toBe(false);
        expect(creatableBranches, param.path).toContain(param.absentBranch);
      }
    }
  });

  it('accepts only values that path can actually hold', () => {
    // Every condition in this table is on a source discriminant — the primary's or
    // the layer's — so a typo'd `'fm_synth'` is a row that never appears and never
    // fails anything else.
    // Two discriminants carry conditions, and each has its own legal vocabulary.
    // Checking the path without checking the values against THAT path's registry
    // is what lets a typo'd `'fm_synth'` or `'princeton-5f2'` become a row that
    // never appears and never fails anything else.
    const CONDITION_VOCABULARY: Readonly<Record<string, readonly string[]>> = {
      'source.kind': SOURCE_KINDS,
      'layer.source.kind': SOURCE_KINDS,
      'effects.circuitAmp.ampId': CIRCUIT_AMPS.map((amp) => amp.id),
    };
    for (const param of ALL_PARAMS) {
      const when = param.appliesWhen;
      if (!when) continue;
      const vocabulary = CONDITION_VOCABULARY[when.path];
      expect(Object.keys(CONDITION_VOCABULARY), param.path).toContain(when.path);
      expect(when.oneOf.length, param.path).toBeGreaterThan(0);
      for (const value of when.oneOf) {
        expect(vocabulary, `${param.path} -> ${when.path}`).toContain(value);
      }
    }
  });

  it('conditions a row only where a branch it lives under is optional', () => {
    // Amp and Cabinet are governed by their section probe, and a row-level
    // condition there would be a second, quieter presence rule — and the bar's two
    // rows apply to every preset there is. What may carry one: the
    // Source section (whose rows differ by source kind, and which holds the
    // layer) and a sub-branch's rows.
    const conditional = ALL_PARAMS.filter(isConditional).map((p) => p.path);
    const allowed = new Set([
      ...sectionAt('source').params.map((p) => p.path),
      ...SUB_BRANCHES.flatMap(({ section, sub }) =>
        section.params.filter((p) => p.path.startsWith(`${sub.branch}.`)).map((p) => p.path),
      ),
      // The one row conditioned on a sub-branch it does NOT live under: the
      // static cutoff, which the envelope takes over. Named rather than derived,
      // so a second `absentBranch` has to be argued for here.
      'bodyFilter.cutoff',
      // Every pedal row. The pedalboard is the third thing that may carry a
      // row-level condition, and it is the case this rule was written against
      // rather than an exception to it: a section whose probe answers presence
      // must not ALSO gate rows, and the pedalboard's probe deliberately answers
      // nothing, because six stages come and go inside one always-present board.
      ...ALL_PEDAL_PARAMS.map((p) => p.path),
      // Every circuit-amp control row — the fourth case, and the same shape as
      // the pedals': the section's probe answers presence and stops there,
      // because WHICH amp decides which knobs exist. A Princeton declares
      // Volume and Tone; the section cannot know that, and the row can.
      ...CIRCUIT_AMP_CONTROL_PARAMS.map((p) => p.path),
      // The Cabinet's own rows — the fifth case, and the reason this rule is
      // stated as "a section whose probe ANSWERS presence must not also gate
      // rows" rather than "a section must not". The Cabinet's probe lists the
      // speaker and the room, so it answers presence for the PANE and for
      // neither stage in it; the cab rows carry what it cannot say. A section
      // joins this list by ARGUING for it — at the section and here — and the
      // final EQ is the one that has, on entirely different grounds.
      ...CAB_OWN_PARAMS.map((p) => p.path),
      // The final EQ's six — the sixth case, and the first whose probe is a
      // single path that answers presence perfectly well. The gate is not the
      // pane's, it is the SEAM's: every value field of `EQParams` is required and
      // `setVoiceParam` writes one path at a time, so an ungated row is a path
      // the seam would accept on a voice with no EQ, minting a partial `EQParams`
      // that `isStageEnabled` reads as live and `buildChain` hands to `Tone.EQ3`
      // with `undefined`s. `AmpParams` has the identical hole and keeps it; the
      // section's comment says so rather than claiming a distinction.
      ...FINAL_EQ_OWN_PARAMS.map((p) => p.path),
    ]);
    // `[].every(…)` is `true`, so the count comes first here too.
    expect(conditional).toHaveLength(CONDITIONAL_ROW_COUNT);
    expect(conditional.every((path) => allowed.has(path))).toBe(true);

    // ⚠ AND THE CAB ROWS' EXEMPTION IS NARROWER THAN THE OTHERS'. Every row above
    // is allowed to carry any row-level condition; these three are allowed exactly
    // ONE — `requiresBranch` naming the speaker. An `appliesWhen` here would be
    // the second quiet presence rule this test is named after, deciding whether a
    // speaker control exists from something other than whether the speaker does.
    expect(CAB_OWN_PARAMS).toHaveLength(3);
    for (const param of CAB_OWN_PARAMS) {
      expect(param.requiresBranch, param.path).toBe('effects.cabIR');
      expect(param.appliesWhen, param.path).toBeUndefined();
      expect(param.absentBranch, param.path).toBeUndefined();
    }

    // The final EQ's exemption is the same narrow one, and narrow for a sharper
    // reason: its rows are gated to keep a HALF-BUILT branch unreachable, so a
    // gate on anything but its own branch would not do that job — and an
    // `appliesWhen` would be the quiet presence rule this test is named after.
    expect(FINAL_EQ_OWN_PARAMS).toHaveLength(6);
    for (const param of FINAL_EQ_OWN_PARAMS) {
      expect(param.requiresBranch, param.path).toBe('effects.finalEq');
      expect(param.appliesWhen, param.path).toBeUndefined();
      expect(param.absentBranch, param.path).toBeUndefined();
    }
  });

  it('gates every sub-branch row on its own branch, one way or the other', () => {
    // The load-bearing one. A row under an optional branch with NO condition is a
    // control the pane would render over nothing and — worse — a path the seams
    // would accept, minting `{ attack: 0.01 }` where a whole `BodyFilterEnvelope`
    // belongs. Both clauses count: a row gated on `layer.source.kind` is gated on
    // the layer, because an absent layer has no kind to match.
    for (const { section, sub } of SUB_BRANCHES) {
      const rows = section.params.filter((p) => p.path.startsWith(`${sub.branch}.`));
      expect(rows.length, sub.id).toBeGreaterThan(0);
      for (const row of rows) {
        const gated =
          row.requiresBranch === sub.branch ||
          row.appliesWhen?.path.startsWith(`${sub.branch}.`) === true;
        expect(gated, `${sub.id} @ ${row.path}`).toBe(true);
      }
    }
  });

  it('hides every sub-branch row on a preset without the branch', () => {
    // The behaviour the rule above exists for, asserted rather than inferred:
    // strip the branch and not one of its rows survives `paramApplies`.
    for (const { section, sub } of SUB_BRANCHES) {
      const seeded = withSeeded(FULLY_POPULATED_FM, sub);
      const stripped = removeAtPath(seeded, sub.branch);
      expect(subBranchApplies(stripped, sub), sub.id).toBe(false);
      expect(branchParams(stripped, section).map((p) => p.path), sub.id).toEqual([]);
      expect(branchParams(seeded, section).length, sub.id).toBeGreaterThan(0);
    }
  });

  it('gates a row on the preset in hand, not on the section', () => {
    const harmonicity = paramAt('source.params.harmonicity');
    expect(paramApplies(FULLY_POPULATED_FM, harmonicity)).toBe(true);
    expect(paramApplies(FULLY_POPULATED_PLUCK, harmonicity)).toBe(false);
    expect(paramApplies(FULLY_POPULATED_SAMPLER, harmonicity)).toBe(false);
    // The kind picker itself is unconditional — it is how you leave.
    expect(paramAt('source.kind').appliesWhen).toBeUndefined();
  });
});

describe('circuit-amp control rows', () => {
  // The lib's control union reaches the schema as two different row kinds. A
  // switch emitted as a slider would write a number into a field the renderer
  // reads as a string, and `VoiceEditor` would draw a knob for a three-way
  // switch.
  it('emits an enum row for every declared switch and a slider for every pot', () => {
    for (const amp of CIRCUIT_AMPS) {
      for (const control of amp.controls) {
        const row = paramAt(circuitAmpControlPath(amp.id, control.id));
        expect(row.kind).toBe(control.kind === 'switch' ? 'enum' : 'slider');
      }
    }
  });

  // A mod is a control that is real but not original. The declaration lives on
  // the amp — which controls it really has is the amp's business — and this
  // asserts the schema CARRIES it rather than deciding it.
  it('carries a control\u2019s mod flag onto its row, and marks nothing else', () => {
    const modRows = ALL_PARAMS.filter((p) => p.mod).map((p) => p.path);
    expect(modRows).toEqual(['effects.circuitAmp.controls.inverter']);
    for (const amp of CIRCUIT_AMPS) {
      for (const control of amp.controls) {
        const row = paramAt(circuitAmpControlPath(amp.id, control.id));
        expect(row.mod ?? false).toBe(control.mod ?? false);
      }
    }
  });

  // ⚠ THE COLLISION GUARD. `circuitAmpControlPath` ignores its `ampId`, so two
  // amps declaring `tone` would emit ONE path twice — and `PARAM_BY_PATH` is a
  // Map, so the second would silently win and `setVoiceParam` would then
  // refuse every write to the first amp's Tone. A live regression, not just a
  // red test. The fix is one row per control id gated on every amp declaring
  // it, which is what this asserts. It holds with one amp and keeps holding
  // when the second lands.
  it('gives each control id exactly one row, gated on every amp that declares it', () => {
    const declaringAmps = new Map<string, string[]>();
    for (const amp of CIRCUIT_AMPS) {
      for (const control of amp.controls) {
        declaringAmps.set(control.id, [...(declaringAmps.get(control.id) ?? []), amp.id]);
      }
    }
    for (const [controlId, ampIds] of declaringAmps) {
      const path = `effects.circuitAmp.controls.${controlId}`;
      expect(ALL_PARAMS.filter((p) => p.path === path)).toHaveLength(1);
      const row = paramAt(path);
      expect(row.appliesWhen?.path).toBe('effects.circuitAmp.ampId');
      expect([...(row.appliesWhen!.oneOf as readonly string[])].sort()).toEqual(
        [...ampIds].sort(),
      );
    }
  });
});

describe('descriptor invariants', () => {
  it('declares each path exactly once', () => {
    const paths = ALL_PARAMS.map((p) => p.path);
    expect(paths).toHaveLength(new Set(paths).size);
  });

  it('declares every field of the lib types it addresses', () => {
    const leavesUnder = (params: readonly Param[], prefix: string) =>
      params
        .filter((p) => p.path.startsWith(`${prefix}.`))
        .map((p) => p.path.slice(prefix.length + 1))
        .sort();

    expect(leavesUnder(ALL_PARAMS, 'effects.amp')).toEqual(Object.keys(AMP_LEAVES).sort());
    expect(leavesUnder(ALL_PARAMS, 'effects.cabIR')).toEqual(Object.keys(CAB_IR_LEAVES).sort());
    expect(leavesUnder(ALL_PARAMS, 'effects.reverb')).toEqual(
      Object.keys(VOICE_REVERB_LEAVES).sort(),
    );
    expect(leavesUnder(ALL_PARAMS, 'effects.finalEq')).toEqual(
      Object.keys(FINAL_EQ_LEAVES).sort(),
    );
    // The pedals, each against its own lib interface. Reached through `PEDALS` so
    // a pedal dropped from the section's flattened `params` fails here too.
    expect(leavesUnder(ALL_PEDAL_PARAMS, 'compressor')).toEqual(
      Object.keys(COMPRESSOR_LEAVES).sort(),
    );
    expect(leavesUnder(ALL_PEDAL_PARAMS, 'effects.distortion')).toEqual(
      Object.keys(DISTORTION_LEAVES).sort(),
    );
    expect(leavesUnder(ALL_PEDAL_PARAMS, 'effects.chorus')).toEqual(
      Object.keys(CHORUS_LEAVES).sort(),
    );
    expect(leavesUnder(ALL_PEDAL_PARAMS, 'effects.delay')).toEqual(
      Object.keys(DELAY_LEAVES).sort(),
    );
    expect(leavesUnder(ALL_PEDAL_PARAMS, 'effects.autoWah')).toEqual(
      Object.keys(AUTO_WAH_LEAVES).sort(),
    );
    expect(leavesUnder(ALL_PEDAL_PARAMS, 'effects.graphicEq')).toEqual(
      Object.keys(GRAPHIC_EQ_LEAVES).sort(),
    );
    expect(leavesUnder(ALL_PARAMS, 'level')).toEqual(Object.keys(LEVEL_LEAVES).sort());

    // Per source kind, because the rows are per source kind. `visibleParams` is
    // the same filter the pane uses, so "declared" here means "actually rendered".
    const sourceRows = (fixture: VoicePreset) => visibleParams(fixture, sectionAt('source'));

    expect(leavesUnder(sourceRows(FULLY_POPULATED_SAMPLER), 'source')).toEqual(
      Object.keys(SAMPLER_LEAVES).sort(),
    );
    expect(leavesUnder(sourceRows(FULLY_POPULATED_PLUCK), 'source.params')).toEqual(
      Object.keys(PLUCK_LEAVES).sort(),
    );

    const envelopeFields = Object.keys(ADSR_LEAVES);
    const expandFm = (keys: readonly string[]) =>
      keys
        .flatMap((key) =>
          key === 'envelope' || key === 'modulationEnvelope'
            ? envelopeFields.map((field) => `${key}.${field}`)
            : [key],
        )
        .sort();
    expect(leavesUnder(sourceRows(FULLY_POPULATED_FM), 'source.params')).toEqual(
      expandFm(Object.keys(FM_LEAVES)),
    );

    // ---- the second source -------------------------------------------------
    // Its own three fields. `layer.source.*` is filtered out because `source` is
    // not a leaf of `VoiceLayer` — it is a whole union, covered on the next lines.
    expect(
      leavesUnder(ALL_PARAMS, 'layer').filter((leaf) => !leaf.startsWith('source.')),
    ).toEqual(Object.keys(LAYER_LEAVES).sort());
    // The kind itself, which lives on the sub-branch rather than in `params`.
    expect(subBranchAt('layer').sub.kindRow?.path).toBe('layer.source.kind');
    // Per layer kind, exactly as for the primary — MINUS `detune`, which the
    // engine overwrites from `layer.detuneCents` (its own test above).
    const layerRows = (fixture: VoicePreset) => branchParams(fixture, sectionAt('source'));
    expect(leavesUnder(layerRows(PLUCK_LAYERED), 'layer.source.params')).toEqual(
      Object.keys(PLUCK_LEAVES).sort(),
    );
    expect(leavesUnder(layerRows(FULLY_POPULATED_FM), 'layer.source.params')).toEqual(
      expandFm(Object.keys(FM_LEAVES).filter((key) => key !== 'detune')),
    );

    // ---- the body filter ---------------------------------------------------
    const frequencyEnvelopeFields = Object.keys(FREQUENCY_ENVELOPE_LEAVES);
    expect(leavesUnder(ALL_PARAMS, 'bodyFilter')).toEqual(
      Object.keys(BODY_FILTER_LEAVES)
        .flatMap((key) =>
          key === 'envelope' ? frequencyEnvelopeFields.map((field) => `envelope.${field}`) : [key],
        )
        .sort(),
    );
  });

  it('seeds every sub-branch with a value its own rows accept', () => {
    // The seed is the ONE thing an Add writes, so a seed missing a field is a
    // half-built branch the engine reads `undefined` out of — and nothing else in
    // this file would notice, because the built-ins all carry complete ones.
    for (const { section, sub } of SUB_BRANCHES) {
      const seeded = withSeeded(FULLY_POPULATED_FM, sub);
      expect(subBranchApplies(seeded, sub), sub.id).toBe(true);
      const rows = branchParams(seeded, section);
      expect(rows.length, sub.id).toBeGreaterThan(0);
      // Every row the seed brings into view resolves, and holds a legal value.
      //
      // OPTIONAL rows excepted, and for the reason `addVoiceSection` skips them:
      // the lib documents its own default for each, so writing our guess turns
      // "unspecified" into a value the user never chose. The room's `enabled` is
      // the first sub-branch row this applies to — `undefined` there means "in
      // the chain", which is what an Add should mean.
      const missing = rows
        .filter((row) => !row.optional && !hasPath(seeded, row.path))
        .map((row) => row.path);
      expect(missing, sub.id).toEqual([]);
      expect(rows.flatMap((row) => violationsFor(seeded, row)), sub.id).toEqual([]);
    }
  });

  it('agrees with itself about the room — the seed and the rows` fallbacks', () => {
    // Two declarations of the same numbers, in two files: `SEED_VOICE_REVERB` is
    // what Add writes, and each row's `fallback` is what the control reads back
    // when the value is absent. Drift and a freshly added room shows one number
    // while holding another, with nothing failing — the same disagreement the
    // layer's `kindRow.fallback` check exists to catch.
    const roomSize = paramAt('effects.reverb.roomSize');
    const wet = paramAt('effects.reverb.wet');
    expect(roomSize.kind === 'slider' && roomSize.fallback).toBe(SEED_VOICE_REVERB.roomSize);
    expect(wet.kind === 'slider' && wet.fallback).toBe(SEED_VOICE_REVERB.wet);
    // `enabled` is the third row and is deliberately NOT in the seed: it is
    // optional, and `undefined` means "in the chain" — which is what the row's
    // `fallback: true` says too.
    expect(SEED_VOICE_REVERB).not.toHaveProperty('enabled');
    const enabled = paramAt('effects.reverb.enabled');
    expect(enabled.kind === 'toggle' && enabled.fallback).toBe(true);
  });

  it('seeds a layer that is a whole VoiceSource, which no row fallback could be', () => {
    // Why `ParamSubBranch.seed` exists at all: `addSection` builds a branch from
    // its rows' `fallback`s and SKIPS the `source-kind` kind, so the layer it would
    // produce has no `source` and `Voice._buildLayer` would call
    // `buildSynth(undefined)`. Pinned as a property of the seed rather than as a
    // comment, because "the seed is complete" is the whole contract.
    const seeded = withSeeded(FULLY_POPULATED_SAMPLER, subBranchAt('layer').sub);
    expect(seeded.layer?.source.kind).toBe('fm-synth');
    expect(seeded.layer?.source).toHaveProperty('params');
    // …and no pitch surprise.
    expect(seeded.layer?.octaveOffset).toBe(0);
    expect(seeded.layer?.detuneCents).toBe(0);
    // The LEVEL is `sourceDefaults.test.ts`'s subject, because it depends on the
    // primary — this fixture is a sampler, so the seed is not the bare
    // `SEED_LAYER.gainDb`, and asserting that here would re-encode the wrong
    // model in a second place.
    expect(seeded.layer?.gainDb).not.toBe(SEED_LAYER.gainDb);
  });

  it('adds a body filter that is near-transparent, and an envelope that peaks where it sat', () => {
    // Adding a stage must not change the sound. The static seed is a lowpass above
    // the register these instruments carry, and the envelope's PEAK is
    // `baseFrequency * 2^octaves` — pinned equal to that static cutoff, so adding
    // the envelope leaves a note's attack alone and only darkens the body.
    expect(SEED_BODY_FILTER.cutoff).toBeGreaterThanOrEqual(6000);
    expect(
      SEED_BODY_FILTER_ENVELOPE.baseFrequency * 2 ** SEED_BODY_FILTER_ENVELOPE.octaves,
    ).toBe(SEED_BODY_FILTER.cutoff);
    // 1/√2 to one decimal: the maximally-flat response, i.e. no resonant peak.
    expect(SEED_BODY_FILTER.q).toBeCloseTo(Math.SQRT1_2, 1);
  });

  it('gives a sub-branch a kind picker only where the pane has a branch-aware swap', () => {
    // ⚠ THE SAFETY PROPERTY. `voiceDrafts.setVoiceParam` resolves a
    // `source-kind` row through `withSourceKind`, which takes no path and always
    // replaces `preset.source` — so a second one of those in `section.params`
    // would let a caller re-kind the LAYER and silently re-kind the PRIMARY. Two
    // halves, both asserted: no sub-branch row is a `source-kind` row, and the one
    // `kindRow` that exists is the layer's, which `VoicePane` routes through
    // `withLayerSourceKind`. A second `kindRow` needs its own swap and fails here
    // until it has one.
    expect(ALL_PARAMS.filter((p) => p.kind === 'source-kind').map((p) => p.path)).toEqual([
      'source.kind',
    ]);
    expect(SUB_BRANCHES.filter(({ sub }) => sub.kindRow).map(({ sub }) => sub.id)).toEqual([
      'layer',
    ]);
  });

  it('offers the layer only the kinds the engine can retune, and still reads the others', () => {
    const kindRow = subBranchAt('layer').sub.kindRow;
    if (!kindRow) throw new Error('the layer no longer has a kind picker');
    // `sampler` is withheld: `updateLayer` never reloads a layer's banks, and its
    // retune path drops `sourceTrimDb` (−17 dB for a sampler, 0 for both synths),
    // so a sampled layer would jump 17 dB on the next edit of anything. LIB-GAP(25).
    expect(kindRow.options.map((option) => option.value)).toEqual(['pluck-synth', 'fm-synth']);
    // …but a stored one is still named honestly rather than reported unrecognised,
    // which is what keeps the panel from reading as empty.
    expect(kindRow.resolve('sampler')).toBe('sampler');
    expect(kindRow.resolve('wavetable')).toBeNull();
    // The picker's reset target and the Add gesture's seed must name the SAME
    // kind. They are declared apart — one on the row, one in `sourceDefaults` —
    // and if they drift, Add creates one kind while the picker claims another,
    // which is a panel disagreeing with itself and nothing failing.
    expect(kindRow.fallback).toBe(SEED_LAYER.source.kind);
    expect(kindRow.options.some((option) => option.value === kindRow.fallback)).toBe(true);
  });

  it('keeps every section param under the branch that owns it', () => {
    // Removing a branch has to remove the rows that live on it; a param declared
    // outside every branch of its section would survive the removal as an orphan.
    //
    // ⚠ TWO BRANCHES, not one, and the Cabinet section is why. Its rows split
    // between `effects.cabIR` (the speaker) and the `effects.reverb` sub-branch
    // (the room), which is the whole point of a sub-branch: one section, two
    // things the user adds and removes independently. Every other sub-branch
    // happens to sit UNDER its section's removable branch
    // (`bodyFilter.envelope`), so this rule read as one branch until the room.
    //
    // Two owners is safe because each list of rows goes with the gesture that
    // removes ITS branch, not because one gesture takes both. Removing the
    // cabinet deletes `effects.cabIR` and the three rows gated on it; the room's
    // three go when the room does. What makes the survivor visible rather than
    // orphaned is the section's listed probe — `tests/VoicePane.test.tsx` pins
    // that ("leaves the room standing when the cabinet is removed"). A row under
    // NEITHER branch would be the real orphan, and that is what this forbids.
    for (const section of PARAM_SECTIONS) {
      // A section with no removable branch is exempt exactly as before — there is
      // no removal for a row to be orphaned by.
      if (section.removableBranch === null) continue;
      const owners = [section.removableBranch, section.subBranch?.branch].filter(
        (branch): branch is string => typeof branch === 'string',
      );
      for (const param of section.params) {
        expect(
          owners.some((branch) => param.path.startsWith(`${branch}.`)),
          `${param.path} is under none of ${owners.join(', ')}`,
        ).toBe(true);
      }
    }
  });

  it('finds a section`s own bypass in the section, never in its sub-branch', () => {
    // `enabledParamOf` returns the FIRST `toggle` whose path ends `.enabled`, and
    // is documented as "the stage's OWN switch" — which, for a section holding a
    // sub-branch with an `.enabled` of its own, is only true while the
    // sub-branch's rows come last. This is the pin on that contract, and the
    // Cabinet is named outright because it is the only section today whose
    // sub-branch carries an `.enabled` at all. Nothing else in this file catches a
    // reorder: it is invisible to every range, path and containment rule, being
    // the same rows in a different order.
    //
    // ⚠ WHAT THIS DOES NOT GUARD ANY MORE, and the reason is worth having in
    // writing: NO caller that draws the pane depends on the order. Both readers
    // split these rows by BRANCH PREFIX and ask each stage with its own rows —
    // `sectionPresence` through `underBranch` (the two tests below), the cab
    // graphic through `ownParams` + `stageBypassed`. Reorder these rows and the
    // lamp and the graphic keep answering about the stage they mean. What the pin
    // buys is that `enabledParamOf` stays honest for the caller that eventually
    // asks it about a section with a sub-branch; the `sectionPresence` tests below
    // are what stand behind the pane.
    expect(enabledParamOf(sectionAt('cabinet'))?.path).toBe('effects.cabIR.enabled');

    for (const { section, sub } of SUB_BRANCHES) {
      const power = enabledParamOf(section);
      if (!power) continue;
      expect(power.path.startsWith(`${sub.branch}.`), `${section.id} / ${sub.id}`).toBe(false);
    }
  });

  it('gives every slider a usable range, step and in-range fallback', () => {
    for (const param of ALL_PARAMS) {
      if (param.kind !== 'slider') continue;
      expect(param.min, param.path).toBeLessThan(param.max);
      expect(param.step, param.path).toBeGreaterThan(0);
      expect(param.step, param.path).toBeLessThanOrEqual(param.max - param.min);
      expect(param.precision, param.path).toBeGreaterThanOrEqual(0);
      expect(param.fallback, param.path).toBeGreaterThanOrEqual(param.min);
      expect(param.fallback, param.path).toBeLessThanOrEqual(param.max);
    }
  });

  it('gives every encoder a step and a finite reset target, and no range at all', () => {
    // The absence is the assertion: an encoder that acquired a `min`/`max` should
    // have become a `slider`, because a bound the app can state is a bound it can
    // draw a fader against.
    for (const param of ALL_PARAMS) {
      if (param.kind !== 'encoder') continue;
      expect(param.step, param.path).toBeGreaterThan(0);
      expect(param.precision, param.path).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(param.fallback), param.path).toBe(true);
      expect(param, param.path).not.toHaveProperty('min');
      expect(param, param.path).not.toHaveProperty('max');
    }
  });

  it('renders each stepped control at enough precision to show its own step', () => {
    // `precision` drives the readout. A step of 0.01 shown at precision 0 renders
    // every drive value as "0" and the control looks broken while working fine.
    for (const param of ALL_PARAMS) {
      if (param.kind !== 'slider' && param.kind !== 'encoder') continue;
      expect(Number(param.step.toFixed(param.precision)), param.path).toBe(param.step);
    }
  });

  it('gives every picker distinct options and a fallback among them', () => {
    for (const param of ALL_PARAMS) {
      if (!isPicker(param)) continue;
      const values = optionValues(param);
      expect(values.length, param.path).toBeGreaterThan(0);
      expect(values, param.path).toHaveLength(new Set(values).size);
      if (param.kind !== 'sample-pack') expect(values, param.path).toContain(param.fallback);
    }
  });

  it('resolves each offered option back to itself', () => {
    // `resolve` is what the picker shows as chosen. An option it cannot round-trip is an
    // entry the user can select and then watch deselect itself.
    for (const param of ALL_PARAMS) {
      if (param.kind !== 'enum' && param.kind !== 'source-kind') continue;
      for (const option of param.options) {
        expect(param.resolve(option.value), `${param.path} → ${option.value}`).toBe(option.value);
      }
    }
  });

  it('resolves an unrecognised value the way the audio chain will', () => {
    // The enums differ here, deliberately, and no rule is generic — which is why
    // `resolve` sits on the descriptor rather than in a path check inside the pane.
    // The amp id has a real fallback in the lib: `getAmpModel` builds Plexi for anything
    // unknown, so naming Plexi is the truth.
    const model = paramAt('effects.amp.modelId');
    expect(model.kind).toBe('enum');
    if (model.kind === 'enum') {
      expect(model.resolve('no-such-amp')).toBe(DEFAULT_AMP_MODEL_ID);
      expect(model.resolve(undefined)).toBe(DEFAULT_AMP_MODEL_ID);
    }
    // A cabinet has none: an unregistered URL is a real IR this editor cannot name, and
    // an absent one is a cabinet branch with no cabinet. Both must read as no-selection
    // rather than as the first registered entry.
    const cab = paramAt('effects.cabIR.url');
    expect(cab.kind).toBe('enum');
    if (cab.kind === 'enum') {
      expect(cab.resolve('https://example.invalid/custom.wav')).toBeNull();
      expect(cab.resolve(undefined)).toBeNull();
    }
    // Nor does the source kind: an unrecognised discriminant is a preset this
    // build cannot play, and naming an arm it is not would be worse than blank.
    const kind = paramAt('source.kind');
    expect(kind.kind).toBe('source-kind');
    if (kind.kind === 'source-kind') {
      expect(kind.resolve('wavetable')).toBeNull();
      expect(kind.resolve(undefined)).toBeNull();
    }
    const carrier = paramAt('source.params.carrierWaveform');
    expect(carrier.kind).toBe('enum');
    if (carrier.kind === 'enum') {
      expect(carrier.resolve('supersaw')).toBeNull();
      // `in` would answer yes here, through the prototype chain.
      expect(carrier.resolve('toString')).toBeNull();
    }
  });

  it('treats an absent toggle as on, matching the lib`s implicit-on contract', () => {
    for (const param of ALL_PARAMS) {
      if (param.kind !== 'toggle') continue;
      expect(param.optional, param.path).toBe(true);
      expect(param.fallback, param.path).toBe(true);
    }
  });

  it('offers exactly the lib registries, in registry order', () => {
    // The mapping rather than a count: a legitimate lib addition should show up as a
    // new option, not as a failure — but dropping or reordering the mapping should.
    expect(optionValues(paramAt('effects.amp.modelId'))).toEqual(AMP_MODELS.map((m) => m.id));
    expect(optionValues(paramAt('effects.cabIR.url'))).toEqual(CABINET_IRS.map((ir) => ir.url));
    // Unfiltered by instrument on purpose — see the comment on SAMPLE_PACK_OPTIONS.
    expect(optionValues(paramAt('source.samples'))).toEqual(SAMPLE_PACKS.map((p) => p.id));
    // The union has no runtime registry, so these two are the type made
    // enumerable. `OscillatorType` is what the lib's own field accepts.
    // Minus `pluck-synth`, withdrawn from the offer 2026-09-01 — see
    // `OFFERED_SOURCE_KIND_OPTIONS`. Still a list rather than a count, so
    // dropping another kind by accident still fails here.
    expect(optionValues(paramAt('source.kind'))).toEqual(
      SOURCE_KINDS.filter((kind) => kind !== 'pluck-synth'),
    );
    const waveforms = ['sine', 'square', 'sawtooth', 'triangle'];
    expect(optionValues(paramAt('source.params.carrierWaveform'))).toEqual(waveforms);
    expect(optionValues(paramAt('source.params.modulatorWaveform'))).toEqual(waveforms);
  });
});

describe('scope', () => {
  it('declares exactly this slice`s sections, in signal-chain order', () => {
    // `body-filter` sits where `Voice.wireChain` puts the node: after the input
    // gain, before the compressor and everything the pedalboard does.
    expect(PARAM_SECTIONS.map((s) => s.id)).toEqual([
      'source',
      'body-filter',
      'pedals',
      'amp',
      'circuit-amp',
      'cabinet',
      'final-eq',
    ]);
  });

  it('keeps the bar’s two rows declared, and outside every section', () => {
    // ⚠ WHAT THE LEVEL SECTION BECAME. The rows are still the schema's — the bar
    // reads its ranges, its steps and its labels from here, and `voiceDrafts`
    // refuses a path nothing declares, so a row outside this list is a control
    // neither a knob nor the agent can write. What they are not is a STAGE: the
    // bar never folds, and `SectionId` has no `'level'` for anything to name.
    expect(LEVEL_BAR_PARAMS.map((p) => p.path)).toEqual(['inputGainDb', 'level.volumeDb']);
    const sectionPaths = PARAM_SECTIONS.flatMap((s) => s.params.map((p) => p.path));
    for (const param of LEVEL_BAR_PARAMS) {
      expect(sectionPaths, param.path).not.toContain(param.path);
    }

    // The deletion, pinned: `level.pan` is reachable from nothing here. Panning is
    // the track's, in the track header — see `LEVEL_LEAVES`.
    expect(ALL_PARAMS.map((p) => p.path)).not.toContain('level.pan');
  });

  it('touches nothing that belongs to a later slice', () => {
    // The lib has ~95 tunable params. Anything reached from here that is not a
    // declared stage or one of the bar's two rows is scope creep, and the pane
    // cannot render it.
    //
    // `source.kind` and `source.params` came OFF this list with the Source panel;
    // `layer` and `bodyFilter` came off with this one; and the whole pedalboard —
    // `compressor` and the five under `effects` — came off with the Pedals section.
    //
    // `effects.reverb` came OFF this list on 2026-09-16, with the lib change that
    // moved it after the cab. What deferred it was that a stage between the amp
    // and the cab had no obvious home in the pane; post-cab it has one — it is the
    // room the cabinet stands in, and it is declared on the Cabinet section.
    //
    // `effects.finalEq` came off on 2026-09-18 with the Final EQ section, and the
    // list is now EMPTY.
    //
    // ⚠ SO THE WALK GOES THE OTHER WAY ROUND, off the lib's type. An empty
    // allowlist checked row by row asserts NOTHING — the loop body never runs, and
    // the "tripwire for the next one" it claimed to be would have tripped only if
    // the person adding a stage also remembered to list it, which is the thing it
    // was meant to detect. `EFFECTS_STAGES` is a `Record` over
    // `keyof EffectsConfig`, so a stage the LIB adds fails to compile here; the
    // assertion then says each one is either reached by a declared row or named on
    // `deferred` as deliberately not yet honoured.
    const EFFECTS_STAGES: Record<keyof EffectsConfig, true> = {
      distortion: true,
      chorus: true,
      delay: true,
      autoWah: true,
      graphicEq: true,
      amp: true,
      circuitAmp: true,
      cabIR: true,
      reverb: true,
      finalEq: true,
    };
    const deferred: readonly (keyof EffectsConfig)[] = [];
    const paths = [...ALL_PARAMS, ...ALL_PEDAL_PARAMS].map((p) => p.path);
    for (const stage of Object.keys(EFFECTS_STAGES) as (keyof EffectsConfig)[]) {
      const reached = paths.some((path) => path.startsWith(`effects.${stage}.`));
      expect(reached, `effects.${stage}`).toBe(!deferred.includes(stage));
    }

    // The other half of the same rule, and the half the old walk was actually
    // written for: nothing declared here reaches OUTSIDE the preset's known
    // branches. `source.kind` and `source.params` came off with the Source panel,
    // `layer` and `bodyFilter` with this one, `compressor` with the Pedals section.
    const known = [
      'source.',
      'layer.',
      'bodyFilter.',
      'compressor.',
      'effects.',
      'level.',
      'inputGainDb',
    ];
    for (const path of paths) {
      expect(
        known.some((prefix) => path.startsWith(prefix)),
        `${path} reaches outside the declared branches`,
      ).toBe(true);
    }
  });

  it('marks exactly the source-identity edits as needing a Voice rebuild', () => {
    // `swapPreset` retunes a synth in place (`updateSynthParams`) but disposes and
    // rebuilds when the source IDENTITY moves — a different kind, different banks,
    // a different sampler release. Those three, and nothing else in this slice.
    const rebuilding = ALL_PARAMS.filter((p) => p.rebuildsVoice).map((p) => p.path);
    expect(rebuilding).toEqual(['source.kind', 'source.samples', 'source.release']);
    // A sub-branch's `kindRow` is not in `ALL_PARAMS` — it is deliberately outside
    // `section.params`, so this walk cannot see it — and it is the fourth such
    // edit: `Voice.updateLayer` disposes and rebuilds the layer on a kind change,
    // exactly as `swapPreset` does for the primary. Asserted here so the flag is a
    // pinned claim rather than a comment nothing reads.
    for (const { sub } of SUB_BRANCHES) {
      if (sub.kindRow) expect(sub.kindRow.rebuildsVoice, sub.id).toBe(true);
    }
  });
});

/**
 * The pedalboard.
 *
 * Six stages inside ONE always-present section, which is a shape nothing else in
 * this table has. The assertions here are the ones that shape depends on: that
 * both routes to a pedal's rows reach the same rows, that a pedal's absence is
 * carried by every one of its rows, and that the value the Add gesture writes is
 * complete enough to render.
 */
describe('the pedalboard', () => {
  /** A preset with no pedalboard at all — the state every pedal starts absent in.
   *  Not a degenerate fixture: an `effects` object with an amp and no pedals is a
   *  perfectly ordinary voice. */
  const NO_PEDALS: VoicePreset = PEDALS.reduce(
    (preset, pedal) => removeAtPath(preset, pedal.branch),
    FULLY_POPULATED_SAMPLER,
  );

  it('is one section, and it is never absent', () => {
    // The board is always there; an empty one has no pedals on it. If this ever
    // gained a probe, every pedal's `requiresBranch` would become a second and
    // quieter presence rule underneath it.
    const section = sectionAt('pedals');
    expect(section.presenceProbe).toBeNull();
    expect(section.removableBranch).toBeNull();
    expect(sectionApplies(NO_PEDALS, section)).toBe(true);
  });

  it('declares the same rows on the section as on the pedals, in chain order', () => {
    // ⚠ THE LOAD-BEARING ONE. `voiceDrafts.PARAM_BY_PATH` is built from
    // `PARAM_SECTIONS.flatMap(s => s.params)`, so a row declared on a pedal and
    // not reachable there is a control the composition page cannot write and the
    // agent cannot call — the failure `agent-reachable` exists to catch, and one
    // no other test in this file would see.
    expect(sectionAt('pedals').params).toEqual(ALL_PEDAL_PARAMS);
  });

  it('lists the pedals in the order `Voice.wireChain` builds them', () => {
    // Named rather than derived: the lib's order is not readable from here, so
    // this is a pinned claim about `wireChain`, and reordering the table without
    // reordering the chain would put the pane's board out of step with the sound.
    expect(PEDALS.map((pedal) => pedal.id)).toEqual([
      'compressor',
      'distortion',
      'chorus',
      'delay',
      'auto-wah',
      'graphic-eq',
    ]);
  });

  it('owns one branch per pedal, and gates every one of its rows on it', () => {
    for (const pedal of PEDALS) {
      expect(pedal.presenceProbe, pedal.id).toBe(pedal.branch);
      expect(pedal.removableBranch, pedal.id).toBe(pedal.branch);
      for (const param of pedal.params) {
        // Under the branch AND gated on it. The first alone would let a row sit
        // in a missing branch; the second alone would let a row of one pedal be
        // gated on another's.
        expect(param.path.startsWith(`${pedal.branch}.`), param.path).toBe(true);
        expect(param.requiresBranch, param.path).toBe(pedal.branch);
      }
    }
  });

  it('hides every pedal row while its branch is absent', () => {
    // The consequence of the gate, stated against a preset rather than against the
    // descriptors — this is what stops the pane drawing thirty-eight controls over
    // nothing on a voice with no pedals.
    for (const param of ALL_PEDAL_PARAMS) {
      expect(paramApplies(NO_PEDALS, param), param.path).toBe(false);
    }
    expect(visibleParams(NO_PEDALS, sectionAt('pedals'))).toEqual([]);
  });

  it('seeds a pedal into something every one of its rows can render', () => {
    // The mutation-worthy assertion in this block: a seed missing one required
    // field yields a pedal the engine builds with an `undefined` where a number
    // belongs, and every other test here still passes. Adding the branch has to
    // produce a stage that is complete, in range, and visible.
    for (const pedal of PEDALS) {
      const seeded = setAtPath(NO_PEDALS, pedal.branch, pedal.seed);
      const visible = visibleParams(seeded, sectionAt('pedals')).map((p) => p.path);
      expect(visible, pedal.id).toEqual(pedal.params.map((p) => p.path));
      for (const param of pedal.params) {
        expect(violationsFor(seeded, param)).toEqual([]);
      }
    }
  });

  it('seeds every pedal active rather than bypassed', () => {
    // A pedal added switched-off is a stage the user has to find a second control
    // to hear, and the lamp would be dark on something they just chose to add.
    // `enabled` is `optional` everywhere — the lib documents `undefined` as
    // implicit-on — so this asserts the seed does not go out of its way to say
    // false, which is what a copy-paste from a fixture would do.
    for (const pedal of PEDALS) {
      const seeded = setAtPath(NO_PEDALS, pedal.branch, pedal.seed);
      expect(sectionPresence(seeded, pedal), pedal.id).toBe('active');
    }
  });

  it('reads a bypassed pedal as bypassed, not absent', () => {
    // Three states per pedal, from the same function that lights the amp's lamp —
    // which is the whole reason `ParamStage` exists rather than a second copy of
    // this logic for pedals.
    for (const pedal of PEDALS) {
      const seeded = setAtPath(NO_PEDALS, pedal.branch, pedal.seed);
      const off = setAtPath(seeded, `${pedal.branch}.enabled`, false);
      expect(sectionPresence(off, pedal), pedal.id).toBe('bypassed');
      expect(sectionPresence(NO_PEDALS, pedal), pedal.id).toBe('absent');
    }
  });
});

/**
 * THE CABINET IS ONE PANE OVER TWO STAGES — a speaker and the room it is standing
 * in — and either one can be there without the other.
 *
 * ⚠ WHY THIS BLOCK EXISTS. Every state below was reachable in the preset before
 * it was reachable on screen: `effects.cabIR` and `effects.reverb` are two
 * independent optional branches in the lib and nothing in the chain couples them.
 * What coupled them was the pane — one `presenceProbe`, so removing the speaker
 * took the whole section off screen and left the room wired, audible and with no
 * control anywhere to reach it. The shipped workaround deleted the room along
 * with the speaker, which threw the user's tuning away to hide a state they were
 * allowed to be in. These four assertions are what replaced it.
 */
describe('the cabinet and the room, as two stages of one pane', () => {
  const cabinet = sectionAt('cabinet');
  const CAB = 'effects.cabIR';
  const ROOM = 'effects.reverb';

  /** The four states, built by removal from a fixture that carries both, so a
   *  branch that stops being optional in the lib fails the first assertion here
   *  rather than quietly making three of these the same preset. */
  // Switched ON explicitly: the fixture writes `enabled: false` on every stage it
  // populates (that is what makes it reach the bypassed arm elsewhere in this
  // file), and these assertions need a starting point where both stages are in
  // the chain.
  const BOTH = setAtPath(
    setAtPath(FULLY_POPULATED_FM, `${CAB}.enabled`, true),
    `${ROOM}.enabled`,
    true,
  );
  const SPEAKER_ONLY = removeAtPath(BOTH, ROOM);
  const ROOM_ONLY = removeAtPath(BOTH, CAB);
  const NEITHER = removeAtPath(SPEAKER_ONLY, CAB);

  it('builds four genuinely different presets to ask about', () => {
    expect([hasBranchAtPath(BOTH, CAB), hasBranchAtPath(BOTH, ROOM)]).toEqual([true, true]);
    expect([hasBranchAtPath(SPEAKER_ONLY, CAB), hasBranchAtPath(SPEAKER_ONLY, ROOM)]).toEqual([
      true,
      false,
    ]);
    expect([hasBranchAtPath(ROOM_ONLY, CAB), hasBranchAtPath(ROOM_ONLY, ROOM)]).toEqual([
      false,
      true,
    ]);
    expect([hasBranchAtPath(NEITHER, CAB), hasBranchAtPath(NEITHER, ROOM)]).toEqual([false, false]);
  });

  it('keeps the pane on screen for either branch, and takes it away only for neither', () => {
    // The whole change in one assertion. `ROOM_ONLY` used to answer false here,
    // which is what made a room with no speaker unreachable.
    expect(sectionApplies(BOTH, cabinet)).toBe(true);
    expect(sectionApplies(SPEAKER_ONLY, cabinet)).toBe(true);
    expect(sectionApplies(ROOM_ONLY, cabinet)).toBe(true);
    expect(sectionApplies(NEITHER, cabinet)).toBe(false);
  });

  it('shows each stage`s rows only on a voice that has that stage', () => {
    // The gate that a two-path probe makes mandatory: with the pane on screen for
    // the room, the cabinet's own rows would otherwise render — and be writable —
    // over a branch that is not there.
    const own = (preset: VoicePreset) => ownParams(preset, cabinet).map((p) => p.path);
    const room = (preset: VoicePreset) => branchParams(preset, cabinet).map((p) => p.path);

    expect(own(BOTH)).toEqual(['effects.cabIR.enabled', 'effects.cabIR.url', 'effects.cabIR.makeupDb']);
    expect(room(BOTH)).toEqual([
      'effects.reverb.enabled',
      'effects.reverb.roomSize',
      'effects.reverb.wet',
    ]);
    expect(own(ROOM_ONLY)).toEqual([]);
    expect(room(ROOM_ONLY)).toEqual(room(BOTH));
    expect(own(SPEAKER_ONLY)).toEqual(own(BOTH));
    expect(room(SPEAKER_ONLY)).toEqual([]);
    expect([...own(NEITHER), ...room(NEITHER)]).toEqual([]);
  });

  it('refuses every cabinet row on a voice that has only the room', () => {
    // `paramApplies` is the seam's gate as well as the pane's
    // (`voiceDrafts.setVoiceParam`), so this is also the statement that a headless
    // caller cannot write `effects.cabIR.makeupDb` into a missing cabinet and mint
    // a `CabIRParams` with no `url`.
    for (const param of cabinet.params) {
      if (!param.path.startsWith(`${CAB}.`)) continue;
      expect(paramApplies(ROOM_ONLY, param), param.path).toBe(false);
      expect(paramApplies(NEITHER, param), param.path).toBe(false);
      expect(paramApplies(BOTH, param), param.path).toBe(true);
    }
  });

  /** One stage switched out, by path — `enabled` is optional everywhere, so
   *  writing `false` is the only way to say bypassed. */
  const bypass = (preset: VoicePreset, branch: string): VoicePreset =>
    setAtPath(preset, `${branch}.enabled`, false);

  it('reads the lamp from every stage the voice actually has', () => {
    // ⚠ THE UNDER-REPORT THIS REPLACES: the lamp used to come off the FIRST
    // `.enabled` row alone, so a switched-out cabinet printed "Bypassed" over a
    // room that was plainly audible. Bypassed now means every stage that is there
    // is switched out.
    expect(sectionPresence(BOTH, cabinet)).toBe('active');
    expect(sectionPresence(bypass(BOTH, CAB), cabinet)).toBe('active');
    expect(sectionPresence(bypass(BOTH, ROOM), cabinet)).toBe('active');
    expect(sectionPresence(bypass(bypass(BOTH, CAB), ROOM), cabinet)).toBe('bypassed');

    // One stage present: the pane says what that stage says, which is the same
    // answer a single-probe section gives.
    expect(sectionPresence(SPEAKER_ONLY, cabinet)).toBe('active');
    expect(sectionPresence(bypass(SPEAKER_ONLY, CAB), cabinet)).toBe('bypassed');
    expect(sectionPresence(ROOM_ONLY, cabinet)).toBe('active');
    expect(sectionPresence(bypass(ROOM_ONLY, ROOM), cabinet)).toBe('bypassed');

    // Absent beats bypassed, and a stored `enabled: false` under a branch that is
    // gone says nothing at all.
    expect(sectionPresence(NEITHER, cabinet)).toBe('absent');
  });

  it('asks the speaker`s Add/Remove about the speaker, never about the pane', () => {
    // `removableBranchPresent` is the one evaluator behind `VoiceEditor`'s stage
    // header button AND `voiceDrafts.addVoiceSection`'s "already there" check.
    // Reading `sectionApplies` instead — which is what both used to do — offers
    // "Remove Cabinet" on a room-only voice for a cabinet that is already gone,
    // and makes Add Cabinet a silent no-op on the one voice it is for.
    expect(removableBranchPresent(BOTH, cabinet)).toBe(true);
    expect(removableBranchPresent(SPEAKER_ONLY, cabinet)).toBe(true);
    expect(removableBranchPresent(ROOM_ONLY, cabinet)).toBe(false);
    expect(removableBranchPresent(NEITHER, cabinet)).toBe(false);
    // The disagreement, stated: the pane applies and the speaker is not there.
    expect(sectionApplies(ROOM_ONLY, cabinet)).toBe(true);

    // `hasBranchAtPath`, never `hasPath`. The lib builds
    // `cabIR: getCabinetIR(id) ? {…} : undefined`, so the KEY can be present with
    // nothing under it; the button has to read "Add" and the seed has to run.
    const guarded: VoicePreset = { ...FULLY_POPULATED_FM, effects: { cabIR: undefined } };
    expect(hasPath(guarded, 'effects.cabIR')).toBe(true);
    expect(removableBranchPresent(guarded, cabinet)).toBe(false);

    // A stage that cannot be removed has no branch to be present, so the header
    // draws no button at all rather than an "Add" for nothing.
    expect(removableBranchPresent(BOTH, sectionAt('source'))).toBe(false);
  });

  it('greys the speaker graphic from the speaker`s own switch, not from the lamp', () => {
    // What `VoiceEditor.renderCabinet` asks, through the same evaluator the lamp
    // uses — `stageBypassed`, given the rows of the stage it means. The graphic IS
    // the speaker: a cabinet switched out inside a live room leaves the PANE
    // active (above) and still has to go grey.
    const cabOff = bypass(BOTH, CAB);
    expect(sectionPresence(cabOff, cabinet)).toBe('active');
    expect(stageBypassed(cabOff, ownParams(cabOff, cabinet))).toBe(true);
    expect(stageBypassed(cabOff, branchParams(cabOff, cabinet))).toBe(false);

    // And the other way: a bypassed ROOM must not grey the speaker.
    const roomOff = bypass(BOTH, ROOM);
    expect(stageBypassed(roomOff, ownParams(roomOff, cabinet))).toBe(false);
    expect(stageBypassed(roomOff, branchParams(roomOff, cabinet))).toBe(true);

    // No `.enabled` row among the rows asked about — which is what a room-only
    // voice hands the graphic — is "this stage has no bypass", not "bypassed".
    expect(ownParams(ROOM_ONLY, cabinet)).toEqual([]);
    expect(stageBypassed(ROOM_ONLY, ownParams(ROOM_ONLY, cabinet))).toBe(false);
  });

  it('leaves the lamp of every other stage exactly as it was', () => {
    // ⚠ THE REGRESSION PIN FOR THE WIDENING. `sectionPresence` gained a second
    // path; every stage without an `independent` sub-branch has to keep taking the
    // first, and "has to" is not a comment. The old definition is restated here in
    // full and the two are compared over every preset this file has — including
    // the pedalboard, whose six `.enabled` rows would be read very differently by
    // a rule that looked at all the applicable toggles instead of the first.
    const legacy = (preset: VoicePreset, stage: ParamStage): SectionPresence => {
      if (!sectionApplies(preset, stage)) return 'absent';
      const toggle = enabledParamIn(stage.params);
      return toggle && getAtPath(preset, toggle.path) === false ? 'bypassed' : 'active';
    };

    const stages: readonly ParamStage[] = [
      ...PARAM_SECTIONS.filter((section) => section.subBranch?.independent !== true),
      ...PEDALS,
    ];
    // The Cabinet is the one stage left out, and nothing else may be: a second
    // independent sub-branch has to come here and argue for itself.
    expect(
      PARAM_SECTIONS.filter((section) => !stages.includes(section)).map((s) => s.id),
    ).toEqual(['cabinet']);

    // Every preset in the file, plus one variant per stage with its own switch
    // off — no built-in writes `enabled`, so without those the comparison would
    // never reach the bypassed arm at all.
    const corpus: readonly VoicePreset[] = [...VOICE_PRESETS, ...ALL_FIXTURES];
    for (const stage of stages) {
      const toggle = enabledParamIn(stage.params);
      const presets = corpus.flatMap((preset) =>
        toggle ? [preset, setAtPath(preset, toggle.path, false)] : [preset],
      );
      for (const preset of presets) {
        expect(sectionPresence(preset, stage), `${stage.label} / ${preset.id}`).toBe(
          legacy(preset, stage),
        );
      }
    }
  });
});
