import { describe, expect, it } from 'vitest';
import {
  AMP_MODELS,
  CABINET_IRS,
  DEFAULT_AMP_MODEL_ID,
  SAMPLE_PACKS,
  VOICE_PRESETS,
  detectSamplePack,
  type AmpParams,
  type CabIRParams,
  type SamplePack,
  type VoiceLevel,
  type VoicePreset,
} from '@fretwork/lib';
import {
  PARAM_SECTIONS,
  sectionApplies,
  type Param,
  type ParamSection,
  type SectionId,
} from './paramSchema';
import { getAtPath, hasPath } from './presetPaths';

/**
 * This is the test the descriptor-table approach exists for: it walks every path
 * the schema declares against every preset the lib actually ships. A typo'd path,
 * a range that a real preset falls outside of, or a picker that cannot represent a
 * built-in's selection all fail here rather than as a dead control in the pane.
 *
 * If a real preset value falls outside a declared range, the RANGE is wrong.
 *
 * The built-ins alone are not enough, though: no shipped preset sets `enabled`,
 * `inputGainDb` or most other optional fields, so a typo in one of those paths is
 * invisible to a loop over `VOICE_PRESETS`. `FULLY_POPULATED` below closes that hole
 * — it is a `VoicePreset` literal with every in-scope field present, so `tsc` checks
 * its shape and the coverage test checks that every declared path lands on it.
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

function optionValues(param: Param): readonly string[] {
  if (param.kind === 'enum') return param.options.map((o) => o.value);
  if (param.kind === 'sample-pack') return param.options.map((o) => o.id);
  return [];
}

/** A registered pack, so the `sample-pack` check below can name the selection.
 *  Found rather than indexed because `detectSamplePack` matches by deep shape and
 *  an arbitrary map would not resolve to anything. */
const FIXTURE_PACK: SamplePack =
  SAMPLE_PACKS.find((pack) => pack.id === 'offset-p90') ?? SAMPLE_PACKS[0];

/**
 * Every in-scope path present at once — including the optional fields no built-in
 * carries. Type-annotated deliberately: `tsc` rejects a wrong field name or type
 * here, and the coverage test rejects a schema path that misses it.
 */
const FULLY_POPULATED: VoicePreset = {
  id: 'fully-populated-fixture',
  name: 'Fully populated fixture',
  instrumentId: 'guitar',
  family: 'electric',
  source: { kind: 'sampler', samples: FIXTURE_PACK.samples, release: 2.5 },
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

/** Every violation is reported as a string so a failure lists all of them at once
 *  instead of stopping at the first. */
function violationsFor(preset: VoicePreset, param: Param): readonly string[] {
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

    case 'toggle':
      return typeof value === 'boolean' ? [] : [`${at}: expected a boolean, got ${typeof value}`];

    case 'enum': {
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

describe('schema vs. every built-in VoicePreset', () => {
  it('covers presets from all three instruments', () => {
    // Guards against the loop below silently testing nothing if the lib's export
    // shape changes.
    expect(VOICE_PRESETS.length).toBeGreaterThanOrEqual(14);
    expect(new Set(VOICE_PRESETS.map((p) => p.instrumentId))).toEqual(
      new Set(['guitar', 'bass', 'ukulele']),
    );
  });

  for (const preset of VOICE_PRESETS) {
    it(`${preset.id}: every applicable path resolves and every value is in range`, () => {
      const violations = PARAM_SECTIONS.filter((section) => sectionApplies(preset, section))
        .flatMap((section) => section.params)
        .flatMap((param) => violationsFor(preset, param));

      expect(violations).toEqual([]);
    });
  }

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

describe('every declared path against a fully populated preset', () => {
  it('resolves every path, optional ones included', () => {
    // The assertion the built-in loop cannot make: no shipped preset sets `enabled`,
    // `modelId` or `inputGainDb`, so those four paths are only ever exercised here.
    // A typo in one of them fails this test (or `tsc`, on the literal above).
    const missing = ALL_PARAMS.filter((param) => !hasPath(FULLY_POPULATED, param.path)).map(
      (param) => param.path,
    );
    expect(missing).toEqual([]);
  });

  it('applies every section', () => {
    const inapplicable = PARAM_SECTIONS.filter(
      (section) => !sectionApplies(FULLY_POPULATED, section),
    ).map((section) => section.id);
    expect(inapplicable).toEqual([]);
  });

  it('accepts every value, reaching the type and range checks the built-ins skip', () => {
    // In particular the `toggle` branch of `violationsFor`, unreachable from the
    // built-ins because none of them sets an `enabled` field.
    expect(ALL_PARAMS.flatMap((param) => violationsFor(FULLY_POPULATED, param))).toEqual([]);
  });
});

describe('section presence', () => {
  it('reads a guarded-undefined branch as absent, not as present-and-bypassed', () => {
    // The lib builds `effects: KARORYFER_GREEN_CAB ? {...} : undefined` and
    // `cabIR: getCabinetIR(id) ? {...} : undefined`, so a key can exist with an
    // `undefined` value. Every shipped preset resolves its IR today, so no loop over
    // `VOICE_PRESETS` can pin this — and a `hasPath`-based probe would render a
    // Cabinet section with no cabinet the first time the IR registry moves.
    const noCab: VoicePreset = { ...FULLY_POPULATED, effects: { cabIR: undefined } };
    expect(hasPath(noCab, 'effects.cabIR')).toBe(true);
    expect(sectionApplies(noCab, sectionAt('cabinet'))).toBe(false);

    const noEffects: VoicePreset = { ...FULLY_POPULATED, effects: undefined };
    expect(hasPath(noEffects, 'effects')).toBe(true);
    expect(sectionApplies(noEffects, sectionAt('amp'))).toBe(false);
  });

  it('never calls a probe-less section absent', () => {
    // Level has no probe because `level` is required on every preset.
    expect(sectionAt('level').presenceProbe).toBeNull();
    for (const preset of VOICE_PRESETS) {
      expect(sectionApplies(preset, sectionAt('level')), preset.id).toBe(true);
    }
  });
});

describe('descriptor invariants', () => {
  it('declares each path exactly once', () => {
    const paths = ALL_PARAMS.map((p) => p.path);
    expect(paths).toHaveLength(new Set(paths).size);
  });

  it('declares every field of the lib types it addresses', () => {
    const leavesUnder = (prefix: string) =>
      ALL_PARAMS.filter((p) => p.path.startsWith(`${prefix}.`))
        .map((p) => p.path.slice(prefix.length + 1))
        .sort();
    expect(leavesUnder('effects.amp')).toEqual(Object.keys(AMP_LEAVES).sort());
    expect(leavesUnder('effects.cabIR')).toEqual(Object.keys(CAB_IR_LEAVES).sort());
    expect(leavesUnder('level')).toEqual(Object.keys(LEVEL_LEAVES).sort());
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

  it('renders each slider at enough precision to show its own step', () => {
    // `precision` drives the readout. A step of 0.01 shown at precision 0 renders
    // every drive value as "0" and the control looks broken while working fine.
    for (const param of ALL_PARAMS) {
      if (param.kind !== 'slider') continue;
      expect(Number(param.step.toFixed(param.precision)), param.path).toBe(param.step);
    }
  });

  it('gives every picker distinct options and a fallback among them', () => {
    for (const param of ALL_PARAMS) {
      if (param.kind !== 'enum' && param.kind !== 'sample-pack') continue;
      const values = optionValues(param);
      expect(values.length, param.path).toBeGreaterThan(0);
      expect(values, param.path).toHaveLength(new Set(values).size);
      if (param.kind === 'enum') expect(values).toContain(param.fallback);
    }
  });

  it('resolves each offered option back to itself', () => {
    // `resolve` is what the picker shows as chosen. An option it cannot round-trip is an
    // entry the user can select and then watch deselect itself.
    for (const param of ALL_PARAMS) {
      if (param.kind !== 'enum') continue;
      for (const option of param.options) {
        expect(param.resolve(option.value), `${param.path} → ${option.value}`).toBe(option.value);
      }
    }
  });

  it('resolves an unrecognised value the way the audio chain will', () => {
    // The two enums differ here, deliberately, and neither rule is generic — which is why
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
  });
});

describe('scope', () => {
  it('declares exactly this slice`s sections, in signal-chain order', () => {
    expect(PARAM_SECTIONS.map((s) => s.id)).toEqual(['samples', 'amp', 'cabinet', 'level']);
  });

  it('touches nothing that belongs to a later slice', () => {
    // The lib has ~95 tunable params. Anything reached from here that is not
    // Samples / Amp / Cabinet / Level is scope creep, and the pane cannot render it.
    const deferred = [
      'bodyFilter',
      'compressor',
      'layer',
      'source.params',
      'source.kind',
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
    // LIB-GAP(9a, 9b): `Voice.swapPreset` never rebuilds sampler banks, so a
    // `samples` or `release` change made through it is silently inaudible — those two
    // are the rebuild set, and nothing else in this slice is.
    const rebuilding = ALL_PARAMS.filter((p) => p.rebuildsVoice).map((p) => p.path);
    expect(rebuilding).toEqual(['source.samples', 'source.release']);
  });
});
