import { describe, expect, it } from 'vitest';
import {
  AMP_MODELS,
  CABINET_IRS,
  DEFAULT_AMP_MODEL_ID,
  SAMPLE_PACKS,
  VOICE_PRESETS,
  detectSamplePack,
  type ADSREnvelope,
  type AmpParams,
  type CabIRParams,
  type FMSynthParams,
  type PluckSynthParams,
  type SamplePack,
  type VoiceLevel,
  type VoicePreset,
  type VoiceSource,
} from '@fretwork/lib';
import {
  PARAM_SECTIONS,
  paramApplies,
  sectionApplies,
  visibleParams,
  type Param,
  type ParamSection,
  type SectionId,
} from './paramSchema';
import { SOURCE_KINDS } from './sourceDefaults';
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
const POPULATED_CHASSIS: Omit<VoicePreset, 'id' | 'name' | 'source'> = {
  instrumentId: 'guitar',
  family: 'electric',
  inputGainDb: -3,
  level: { volumeDb: -1.5, pan: 0.25 },
  effects: {
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

  it('leaves the seven undocumented values unbounded, as encoders', () => {
    // The other half of the same rule, and the one a well-meaning "let`s give this a
    // sensible range" edit would break: these are encoders BECAUSE their own pages
    // publish Min:/Max: for their neighbours and nothing for them. Turning one into a
    // slider means inventing the fence. (Re-verified against the three pages above and
    // classes/FMSynth.html, which documents no bound for harmonicity, modulationIndex
    // or detune.)
    const unbounded = [
      'source.params.resonance',
      'source.params.release',
      'source.params.harmonicity',
      'source.params.modulationIndex',
      'source.params.detune',
      'source.params.envelope.sustain',
      'source.params.modulationEnvelope.sustain',
    ];
    expect(unbounded.map((path) => paramAt(path).kind)).toEqual(unbounded.map(() => 'encoder'));
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

  for (const preset of VOICE_PRESETS) {
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
    for (const preset of VOICE_PRESETS) {
      const shown = visibleParams(preset, sectionAt('source'));
      for (const param of shown) {
        if (!param.appliesWhen) continue;
        expect(param.appliesWhen.oneOf, `${preset.id} @ ${param.path}`).toContain(
          preset.source.kind,
        );
      }
      // And the converse: nothing belonging to another kind slipped through.
      const hidden = sectionAt('source').params.filter((param) => !shown.includes(param));
      for (const param of hidden) {
        expect(param.appliesWhen?.oneOf ?? [], `${preset.id} @ ${param.path}`).not.toContain(
          preset.source.kind,
        );
      }
    }
  });

  it('finds at least one preset exercising each section, so no section is untested', () => {
    for (const section of PARAM_SECTIONS) {
      const exercising = VOICE_PRESETS.filter((preset) => sectionApplies(preset, section));
      expect(exercising.length, `no built-in preset has section ${section.id}`).toBeGreaterThan(0);
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
  it('gives every source kind a fixture', () => {
    expect(FIXTURES.map((f) => f.source.kind)).toEqual(SOURCE_KINDS);
  });

  it('applies every declared row to at least one fixture', () => {
    // The coverage assertion the single `FULLY_POPULATED` could no longer make: a
    // row whose condition matches nothing is a control nobody can ever see, and it
    // would otherwise be silently skipped by every check in this file.
    const unreachable = ALL_PARAMS.filter(
      (param) => !FIXTURES.some((fixture) => paramApplies(fixture, param)),
    ).map((param) => param.path);
    expect(unreachable).toEqual([]);
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.source.kind}: resolves every applicable path, optional ones included`, () => {
      // The assertion the built-in loop cannot make: no shipped preset sets
      // `enabled`, `modelId` or `inputGainDb`, so those paths are only ever
      // exercised here. A typo in one fails this test (or `tsc`, on the literal).
      const missing = ALL_PARAMS.filter(
        (param) => paramApplies(fixture, param) && !hasPath(fixture, param.path),
      ).map((param) => param.path);
      expect(missing).toEqual([]);
    });

    it(`${fixture.source.kind}: applies every section`, () => {
      const inapplicable = PARAM_SECTIONS.filter(
        (section) => !sectionApplies(fixture, section),
      ).map((section) => section.id);
      expect(inapplicable).toEqual([]);
    });

    it(`${fixture.source.kind}: accepts every value, reaching the checks the built-ins skip`, () => {
      // In particular the `toggle` branch of `violationsFor`, unreachable from the
      // built-ins because none of them sets an `enabled` field — and, for the
      // sampler fixture, an in-range `source.release`, which no built-in has.
      expect(ALL_PARAMS.flatMap((param) => violationsFor(fixture, param))).toEqual([]);
    });
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
 * Every Source row except the kind picker is conditional — the picker is how you
 * leave a kind, so it applies always, and nothing outside Source is conditional at
 * all (asserted below). Derived rather than written as a literal so adding a row is
 * not a failing test, while DROPPING a condition is.
 */
const CONDITIONAL_ROW_COUNT = sectionAt('source').params.length - 1;

describe('row conditions', () => {
  it('conditions only on a path the table itself declares', () => {
    // A condition on an undeclared path is a row gated by something no control can
    // change — invisible for good, with nothing to say so.
    const declared = new Set(ALL_PARAMS.map((p) => p.path));
    // Counted first, because every assertion in this block sits inside a filter: strip
    // `appliesWhen` from every FM row and a loop over nothing would pass.
    expect(ALL_PARAMS.filter((p) => p.appliesWhen)).toHaveLength(CONDITIONAL_ROW_COUNT);
    for (const param of ALL_PARAMS) {
      if (!param.appliesWhen) continue;
      expect(declared.has(param.appliesWhen.path), param.path).toBe(true);
    }
  });

  it('accepts only values that path can actually hold', () => {
    // Every condition in this slice is on the source discriminant, so a typo'd
    // `'fm_synth'` is a row that never appears and never fails anything else.
    for (const param of ALL_PARAMS) {
      const when = param.appliesWhen;
      if (!when) continue;
      expect(when.path, param.path).toBe('source.kind');
      expect(when.oneOf.length, param.path).toBeGreaterThan(0);
      for (const value of when.oneOf) {
        expect(SOURCE_KINDS as readonly string[], param.path).toContain(value);
      }
    }
  });

  it('leaves every row outside the Source section unconditional', () => {
    // Amp, Cabinet and Level are governed by their section probe, and a row-level
    // condition there would be a second, quieter presence rule.
    const conditional = ALL_PARAMS.filter((p) => p.appliesWhen).map((p) => p.path);
    const sourceRows = sectionAt('source').params.map((p) => p.path);
    // `[].every(…)` is `true`, so the count comes first here too.
    expect(conditional).toHaveLength(CONDITIONAL_ROW_COUNT);
    expect(conditional.every((path) => sourceRows.includes(path))).toBe(true);
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
    const expectedFm = Object.keys(FM_LEAVES)
      .flatMap((key) =>
        key === 'envelope' || key === 'modulationEnvelope'
          ? envelopeFields.map((field) => `${key}.${field}`)
          : [key],
      )
      .sort();
    expect(leavesUnder(sourceRows(FULLY_POPULATED_FM), 'source.params')).toEqual(expectedFm);
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
    expect(optionValues(paramAt('source.kind'))).toEqual(SOURCE_KINDS);
    const waveforms = ['sine', 'square', 'sawtooth', 'triangle'];
    expect(optionValues(paramAt('source.params.carrierWaveform'))).toEqual(waveforms);
    expect(optionValues(paramAt('source.params.modulatorWaveform'))).toEqual(waveforms);
  });
});

describe('scope', () => {
  it('declares exactly this slice`s sections, in signal-chain order', () => {
    expect(PARAM_SECTIONS.map((s) => s.id)).toEqual(['source', 'amp', 'cabinet', 'level']);
  });

  it('touches nothing that belongs to a later slice', () => {
    // The lib has ~95 tunable params. Anything reached from here that is not
    // Source / Amp / Cabinet / Level is scope creep, and the pane cannot render it.
    //
    // `source.kind` and `source.params` came OFF this list with the Source panel —
    // they are the whole subject of it now. `layer` stays: a second source is the
    // next slice, and it is the one that will reuse `appliesWhen` on
    // `layer.source.kind`.
    const deferred = [
      'bodyFilter',
      'compressor',
      'layer',
      'effects.distortion',
      'effects.chorus',
      'effects.delay',
      'effects.autoWah',
      'effects.graphicEq',
      'effects.reverb',
      'effects.finalEq',
    ];
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
  });
});
