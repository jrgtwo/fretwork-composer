import { describe, expect, it } from 'vitest';
import {
  ACOUSTIC_GUITAR_PRESET,
  SAMPLE_PACKS,
  VOICE_PRESETS,
  detectSamplePack,
  type VoicePreset,
} from '@fretwork/lib';
import {
  DEFAULT_SAMPLE_PACK_ID,
  SOURCE_KINDS,
  TONE_FM_DEFAULTS,
  TONE_PLUCK_DEFAULTS,
  defaultSampleBanks,
  defaultSourceFor,
  isSourceKind,
  withSourceKind,
} from './sourceDefaults';
import { PARAM_SECTIONS, paramApplies } from './paramSchema';
import { getAtPath, hasPath } from './presetPaths';

/**
 * What this file is really guarding: **switching source lands on something that
 * plays.** Not "the type-checker is happy" — `setAtPath(preset, 'source.kind', …)`
 * type-checks perfectly and produces an object matching no arm of `VoiceSource`,
 * which is the bug this module exists to make unrepresentable.
 *
 * jsdom has no Web Audio, so nothing here can prove a note sounds. Two things
 * stand in, and they are the two the store can actually see: the resulting source
 * carries every field the lib's own builder reads for its kind (asserted against
 * `paramSchema`, which is derived from those types), and it carries NOTHING from
 * the kind it replaced. The audible half is a by-ear check.
 */

const sourceSection = PARAM_SECTIONS.find((section) => section.id === 'source')!;

/** A minimal real preset to switch around, so the assertions are about the
 *  source and not about a fixture's own shape. */
const START: VoicePreset = ACOUSTIC_GUITAR_PRESET;

describe('the source kinds', () => {
  it('is every kind the lib ships a preset for, and nothing else', () => {
    expect(SOURCE_KINDS).toEqual(['sampler', 'pluck-synth', 'fm-synth']);
    for (const preset of VOICE_PRESETS) {
      expect(SOURCE_KINDS as readonly string[], preset.id).toContain(preset.source.kind);
    }
  });

  it('recognises exactly those, and refuses anything else', () => {
    for (const kind of SOURCE_KINDS) expect(isSourceKind(kind)).toBe(true);
    expect(isSourceKind('wavetable')).toBe(false);
    expect(isSourceKind(undefined)).toBe(false);
    // `in` on a plain object would say yes to this; the guard must not.
    expect(isSourceKind('toString')).toBe(false);
  });
});

describe('the starting values', () => {
  it('holds Tone`s documented PluckSynth defaults', () => {
    // https://tonejs.github.io/docs/13.8.25/PluckSynth — `DEFAULTS { attackNoise:
    // 1, dampening: 4000, resonance: 0.7 }`. Pinned so a later "that sounds
    // better to me" edit is a deliberate one with a comment, not a silent drift
    // away from the documented starting point.
    expect(TONE_PLUCK_DEFAULTS.attackNoise).toBe(1);
    expect(TONE_PLUCK_DEFAULTS.dampening).toBe(4000);
    expect(TONE_PLUCK_DEFAULTS.resonance).toBe(0.7);
    // `release` post-dates that page and 15.1.22 documents neither a default nor a
    // bound for it, so this one number is stated by the module rather than cited.
    // Pinned all the same: it is the encoder's double-click reset target.
    expect(TONE_PLUCK_DEFAULTS.release).toBe(1);
  });

  it('holds Tone`s documented FMSynth defaults', () => {
    // https://tonejs.github.io/docs/13.8.25/FMSynth — `harmonicity: 3,
    // modulationIndex: 10, detune: 0, oscillator.type: sine, modulation.type:
    // square, envelope {0.01, 0.01, 1, 0.5}, modulationEnvelope {0.5, 0, 1, 0.5}`.
    expect(TONE_FM_DEFAULTS.harmonicity).toBe(3);
    expect(TONE_FM_DEFAULTS.modulationIndex).toBe(10);
    expect(TONE_FM_DEFAULTS.detune).toBe(0);
    expect(TONE_FM_DEFAULTS.carrierWaveform).toBe('sine');
    expect(TONE_FM_DEFAULTS.modulatorWaveform).toBe('square');
    expect(TONE_FM_DEFAULTS.envelope).toEqual({
      attack: 0.01,
      decay: 0.01,
      sustain: 1,
      release: 0.5,
    });
    // ⚠ The one deviation, and the module names it: Tone's default
    // `modulationEnvelope.decay` is 0, while `classes/Envelope.html` documents
    // decay as "Value must be greater than 0". A graph that will not build is not
    // a source that plays, so the seed is non-zero.
    expect(TONE_FM_DEFAULTS.modulationEnvelope.decay).toBeGreaterThan(0);
    expect(TONE_FM_DEFAULTS.modulationEnvelope).toEqual({
      attack: 0.5,
      decay: 0.01,
      sustain: 1,
      release: 0.5,
    });
  });

  it('starts a sampler on a pack that has samples in it', () => {
    // The trap: `SAMPLE_PACKS[0]` is `empty`, whose one bank is `{}` and whose own
    // label says it "falls back to PluckSynth". Landing there would type-check and
    // silently not be a sampler at all.
    const banks = defaultSampleBanks();
    expect(banks.length).toBeGreaterThan(0);
    expect(banks.some((bank) => Object.keys(bank).length > 0)).toBe(true);

    const pack = detectSamplePack(banks);
    expect(pack?.id).toBe(DEFAULT_SAMPLE_PACK_ID);
    // And the id it names is really registered, so the guard is a guard and not
    // the thing doing the work.
    expect(SAMPLE_PACKS.map((p) => p.id)).toContain(DEFAULT_SAMPLE_PACK_ID);
  });

  it('leaves the sampler`s optional release unwritten', () => {
    // Same rule the editor follows for every optional field: `Voice` builds
    // `release: source.release ?? 1`, so omitting it means the lib's own default
    // applies rather than a number nobody chose.
    const source = defaultSourceFor('sampler');
    expect(source.kind).toBe('sampler');
    expect(hasPath({ source }, 'source.release')).toBe(false);
  });
});

describe('switching source', () => {
  it('replaces the whole branch, leaving nothing of the old kind behind', () => {
    // The defect the module exists for. `setAtPath(preset, 'source.kind', 'fm-synth')`
    // would keep `samples` beside an `fm-synth` tag — an object matching no arm of
    // the union, which `Voice` then reads `params` off and gets `undefined`.
    expect(START.source.kind).toBe('sampler');
    const fm = withSourceKind(START, 'fm-synth');
    expect(Object.keys(fm.source).sort()).toEqual(['kind', 'params']);
    expect(getAtPath(fm, 'source.samples')).toBeUndefined();

    const back = withSourceKind(fm, 'sampler');
    expect(Object.keys(back.source).sort()).toEqual(['kind', 'samples']);
    expect(getAtPath(back, 'source.params')).toBeUndefined();
  });

  it('works in every direction, six ways', () => {
    for (const from of SOURCE_KINDS) {
      for (const to of SOURCE_KINDS) {
        if (from === to) continue;
        const start = withSourceKind(START, from);
        const next = withSourceKind(start, to);
        expect(next.source.kind, `${from} → ${to}`).toBe(to);
        // Everything that is not the source is carried across untouched — the
        // amp, the cabinet and the level are not a property of what makes the
        // sound.
        expect(next.level, `${from} → ${to}`).toBe(START.level);
        expect(next.effects, `${from} → ${to}`).toBe(START.effects);
        expect(next.id, `${from} → ${to}`).toBe(START.id);
      }
    }
  });

  it('lands on a source the whole schema can render and the lib can build', () => {
    // The store-side stand-in for "it plays": for each kind, every row the Source
    // section shows for it resolves to a value of the right shape. Those rows are
    // one-for-one with the fields `Voice` reads when it constructs the node, which
    // is what the `Record<keyof …>` guards in `paramSchema.test.ts` enforce.
    for (const kind of SOURCE_KINDS) {
      const preset = withSourceKind(START, kind);
      const missing = sourceSection.params
        .filter((param) => paramApplies(preset, param) && !param.optional)
        .filter((param) => getAtPath(preset, param.path) === undefined)
        .map((param) => param.path);
      expect(missing, kind).toEqual([]);
    }
  });

  it('hands back the SAME object when the kind has not moved', () => {
    // Not an optimisation. The editor's dirty check is reference-based
    // (`presetPaths` guarantees an unchanged write returns the same object), so a
    // picker reporting its current value must not mark the preset dirty — and
    // re-selecting the current kind must not reseed Tone's defaults over a tuning
    // the user has already done.
    expect(withSourceKind(START, 'sampler')).toBe(START);

    const tuned = withSourceKind(START, 'pluck-synth');
    const retuned: VoicePreset = {
      ...tuned,
      source: { kind: 'pluck-synth', params: { ...TONE_PLUCK_DEFAULTS, dampening: 1234 } },
    };
    expect(withSourceKind(retuned, 'pluck-synth')).toBe(retuned);
    expect(getAtPath(withSourceKind(retuned, 'pluck-synth'), 'source.params.dampening')).toBe(1234);
  });
});
