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
  type VoiceSource,
} from '@fretwork/lib';
import {
  PARAM_SECTIONS,
  PEDALS,
  branchParams,
  ownParams,
  paramApplies,
  sectionApplies,
  sectionPresence,
  subBranchApplies,
  visibleParams,
  type Param,
  type ParamSection,
  type ParamSubBranch,
  type SectionId,
} from './paramSchema';
import {
  SEED_BODY_FILTER,
  SEED_BODY_FILTER_ENVELOPE,
  SEED_LAYER,
  SOURCE_KINDS,
} from './sourceDefaults';
import { getAtPath, hasPath, removeAtPath, setAtPath } from './presetPaths';

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

const ALL_PARAMS: readonly Param[] = PARAM_SECTIONS.flatMap((section) => section.params);

/**
 * The pedalboard's rows, reached through {@link PEDALS} rather than through the
 * section.
 *
 * Both routes must reach the same rows and the assertion below pins that: the
 * section's `params` is the flattened pedal rows precisely so
 * `trackVoiceDrafts.PARAM_BY_PATH` and this file's walks pick them up with no
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
      delayTime: 4,
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

const ALL_FIXTURES: readonly VoicePreset[] = [...FIXTURES, PLUCK_LAYERED, STATIC_FILTERED];

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
const LEVEL_LEAVES: Record<keyof VoiceLevel, true> = { volumeDb: true, pan: true };

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
    expect(only(setAtPath(FULLY_POPULATED_SAMPLER, 'level.pan', 'centre'), 'level.pan')).toContain(
      'expected a number',
    );
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
      const violations = PARAM_SECTIONS.filter((section) => sectionApplies(preset, section))
        .flatMap((section) => section.params)
        .flatMap((param) => violationsFor(preset, param));

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
    const withCab = VOICE_PRESETS.filter((p) => sectionApplies(p, sectionAt('cabinet')));
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
    // Level has no probe because `level` is required on every preset; Source has
    // none because a voice always has one.
    expect(sectionAt('level').presenceProbe).toBeNull();
    expect(sectionAt('source').presenceProbe).toBeNull();
    for (const preset of VOICE_PRESETS) {
      expect(sectionApplies(preset, sectionAt('level')), preset.id).toBe(true);
      expect(sectionApplies(preset, sectionAt('source')), preset.id).toBe(true);
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
 * conditional. Amp, Cabinet, Level and the body filter's own three rows are not.
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

const CONDITIONAL_ROW_COUNT =
  sectionAt('source').params.length -
  1 +
  branchParams(FULLY_POPULATED_FM, sectionAt('body-filter')).length +
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
  CIRCUIT_AMP_CONTROL_PARAMS.length;


/**
 * Every branch some gesture in this app can actually create — a section's
 * sub-branch, or a pedal — and therefore the only branches a `requiresBranch` or
 * an `absentBranch` may name.
 *
 * The test that reads this explains why "some row lives under it" is the wrong
 * check; what makes a gate legitimate is that something can OPEN it. A pedal
 * qualifies for exactly the reason a sub-branch does: it carries a seed and the
 * seams add and remove it by id.
 */
const creatableBranches = [
  ...SUB_BRANCHES.map(({ sub }) => sub.branch),
  ...PEDALS.map((pedal) => pedal.branch),
];

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
        expect(creatableBranches, param.path).toContain(param.requiresBranch);
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
    // Amp, Cabinet and Level are governed by their section probe, and a row-level
    // condition there would be a second, quieter presence rule. What may carry one:
    // the Source section (whose rows differ by source kind, and which holds the
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
    ]);
    // `[].every(…)` is `true`, so the count comes first here too.
    expect(conditional).toHaveLength(CONDITIONAL_ROW_COUNT);
    expect(conditional.every((path) => allowed.has(path))).toBe(true);
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
      const missing = rows.filter((row) => !hasPath(seeded, row.path)).map((row) => row.path);
      expect(missing, sub.id).toEqual([]);
      expect(rows.flatMap((row) => violationsFor(seeded, row)), sub.id).toEqual([]);
    }
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
    // ⚠ THE SAFETY PROPERTY. `trackVoiceDrafts.setTrackVoiceParam` resolves a
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

  it('keeps every section param under its removable branch', () => {
    // Removing the branch has to remove the whole section; a param declared outside
    // it would survive the removal as an orphan.
    for (const section of PARAM_SECTIONS) {
      if (section.removableBranch === null) continue;
      for (const param of section.params) {
        expect(param.path.startsWith(`${section.removableBranch}.`)).toBe(true);
      }
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
      'level',
    ]);
  });

  it('touches nothing that belongs to a later slice', () => {
    // The lib has ~95 tunable params. Anything reached from here that is not
    // Source / Amp / Cabinet / Level is scope creep, and the pane cannot render it.
    //
    // `source.kind` and `source.params` came OFF this list with the Source panel;
    // `layer` and `bodyFilter` came off with this one; and the whole pedalboard —
    // `compressor` and the five under `effects` — came off with the Pedals section.
    //
    // What is left is the post-fx slice, and both of them are genuinely deferred
    // rather than forgotten: the per-voice reverb is wired between the amp and the
    // cab rather than after it, so where it belongs in the pane is a decision the
    // plan has not made yet, and the final EQ sits after the cab.
    const deferred = ['effects.reverb', 'effects.finalEq'];
    for (const param of ALL_PARAMS) {
      for (const prefix of deferred) {
        expect(param.path.startsWith(prefix), `${param.path} reaches deferred ${prefix}`).toBe(
          false,
        );
      }
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
    // ⚠ THE LOAD-BEARING ONE. `trackVoiceDrafts.PARAM_BY_PATH` is built from
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
