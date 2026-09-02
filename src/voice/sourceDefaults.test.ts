import { describe, expect, it } from 'vitest';
import {
  ACOUSTIC_GUITAR_PRESET,
  SAMPLE_PACKS,
  VOICE_PRESETS,
  detectSamplePack,
  sourceTrimDb,
  type VoicePreset,
} from '@fretwork/lib';
import {
  DEFAULT_SAMPLE_PACK_ID,
  SEED_BODY_FILTER,
  SEED_BODY_FILTER_ENVELOPE,
  SEED_LAYER,
  SOURCE_KINDS,
  TONE_FM_DEFAULTS,
  TONE_PLUCK_DEFAULTS,
  defaultSampleBanks,
  defaultSourceFor,
  isSourceKind,
  seedLayerFor,
  withLayerSourceKind,
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

  // ─── the second source ─────────────────────────────────────────────────────

  it('re-kinds the LAYER and leaves the primary source where it was', () => {
    // The whole reason this is a second function rather than a `branch` argument
    // on `withSourceKind`: `trackVoiceDrafts` calls that one with no path, so any
    // second `source-kind` row in the table would swap the primary while the
    // caller pointed at the layer. Asserted on both branches at once.
    const layered: VoicePreset = { ...START, layer: SEED_LAYER };
    const swapped = withLayerSourceKind(layered, 'pluck-synth');

    expect(swapped.layer?.source.kind).toBe('pluck-synth');
    expect(swapped.layer?.source).toHaveProperty('params.attackNoise');
    // Nothing of the FM arm survived beside the pluck tag.
    expect(swapped.layer?.source).not.toHaveProperty('params.harmonicity');
    // …and the primary is the object it always was.
    expect(swapped.source).toBe(START.source);
  });

  it('carries the layer`s mix settings across a kind change', () => {
    // Only `source` is replaced. `gainDb` and `octaveOffset` are the user's tuning
    // of how the layer SITS, and they have nothing to do with what it is made of.
    const tuned: VoicePreset = {
      ...START,
      layer: { ...SEED_LAYER, gainDb: -4, octaveOffset: -1, detuneCents: 12 },
    };
    const swapped = withLayerSourceKind(tuned, 'pluck-synth');
    expect(swapped.layer?.gainDb).toBe(-4);
    expect(swapped.layer?.octaveOffset).toBe(-1);
    expect(swapped.layer?.detuneCents).toBe(12);
  });

  it('hands back the SAME object when the layer`s kind has not moved, or is not there', () => {
    const layered: VoicePreset = { ...START, layer: SEED_LAYER };
    expect(withLayerSourceKind(layered, 'fm-synth')).toBe(layered);
    // A preset with no layer is untouched: re-kinding something absent is not an
    // operation, and creating one here would hide the Add gesture inside a picker.
    expect(START.layer).toBeUndefined();
    expect(withLayerSourceKind(START, 'pluck-synth')).toBe(START);
  });

  it('seeds a layer the engine can build, of a kind that honours its own detune', () => {
    // `Voice._buildLayer` calls `buildSynth(layer.source)`; a seed missing `params`
    // is a TypeError there, not a mistuning. FM because `applyLayerDetune` writes
    // `synth.detune.value` on an FMSynth and silently ignores a PluckSynth — so a
    // plucked seed would ship a Detune row that does nothing.
    expect(SEED_LAYER.source.kind).toBe('fm-synth');
    expect(SEED_LAYER.source).toHaveProperty('params.harmonicity');
    expect(SEED_LAYER.detuneCents).toBe(0);
    expect(SEED_LAYER.octaveOffset).toBe(0);
  });

  it('lands the added layer under the primary AT THE MIXER, whichever family it is', () => {
    // ⚠ THE ASSERTION THAT HAS TO MODEL THE ENGINE, not the arithmetic. A flat
    // `gainDb` is NOT a level relative to the primary: `Voice._ensureBuilt` puts
    // the primary through a `_sourceTrim` of `sourceTrimDb(preset.source)` and
    // `_buildLayer` bypasses that node, folding in only the LAYER's own trim. So
    // the delta at the mixer is `layer.gainDb + trim(layer) − trim(primary)`, and
    // a check that omits `sourceTrimDb` passes for every value of the one thing
    // that can be wrong — which is exactly how a flat −12 shipped at roughly
    // +5 dB over a sampled primary.
    const deltaDb = (preset: VoicePreset) => {
      const layer = seedLayerFor(preset).gainDb;
      return layer + sourceTrimDb(seedLayerFor(preset).source) - sourceTrimDb(preset.source);
    };

    const sampled: VoicePreset = { ...START, source: defaultSourceFor('sampler') };
    const synthed: VoicePreset = { ...START, source: defaultSourceFor('fm-synth') };
    // The two families the fourteen built-ins fall into, and the trims that make
    // them differ — a sampler is calibrated 17 dB down, a synth passes at unity.
    expect(sourceTrimDb(sampled.source)).toBeLessThan(-10);
    expect(sourceTrimDb(synthed.source)).toBe(0);
    // Both land at the SAME place relative to the primary, which is the point.
    expect(deltaDb(sampled)).toBeCloseTo(deltaDb(synthed), 6);
    // And that place is quiet enough not to be a level jump: summed coherently,
    // a layer `d` dB under the primary raises the peak by 20·log10(1 + 10^(d/20)),
    // and two equal sources would be +6 dB.
    for (const preset of [sampled, synthed]) {
      expect(deltaDb(preset), preset.source.kind).toBeLessThanOrEqual(-6);
      const riseDb = 20 * Math.log10(1 + 10 ** (deltaDb(preset) / 20));
      expect(riseDb, preset.source.kind).toBeLessThan(3);
    }
    // The correction is real and not a rounding: the sampled primary's seed is
    // audibly quieter than the synth one's, and it is quieter by the trim.
    expect(seedLayerFor(sampled).gainDb).toBeCloseTo(
      seedLayerFor(synthed).gainDb + sourceTrimDb(sampled.source),
      6,
    );
    // Everything else about the seed comes through untouched.
    expect(seedLayerFor(sampled).source).toEqual(SEED_LAYER.source);
    expect(seedLayerFor(sampled).octaveOffset).toBe(SEED_LAYER.octaveOffset);
  });

  it('leaves every shipped layer alone — the seed is for a layer being ADDED', () => {
    // The three built-ins that carry one were mixed by ear against their own
    // primaries; nothing here may re-level them.
    const layered = VOICE_PRESETS.filter((preset) => preset.layer);
    expect(layered.length).toBeGreaterThanOrEqual(3);
    for (const preset of layered) {
      expect(preset.layer?.gainDb, preset.id).not.toBe(seedLayerFor(preset).gainDb);
    }
  });

  // ─── the body filter ───────────────────────────────────────────────────────

  it('seeds a body filter that arrives near-transparent, not at Tone`s 350 Hz', () => {
    // A section seed is NEUTRAL, not Tone's default — the rule Amp and Cabinet
    // already follow, and the one the pane's own copy states ("seeds it with
    // neutral values you can then tune"). Tone's 13.8.25 Filter DEFAULTS are
    // `frequency: 350, Q: 1`, and a 350 Hz lowpass would darken every voice it was
    // added to before the user had touched anything.
    expect(SEED_BODY_FILTER.cutoff).toBeGreaterThanOrEqual(6000);
    // 1/√2 — the maximally-flat (Butterworth) response, i.e. no resonant peak.
    expect(SEED_BODY_FILTER.q).toBeCloseTo(Math.SQRT1_2, 1);
    // `enabled` and `envelope` are both left unwritten: the lib documents an
    // absent `enabled` as implicit-on, and a static cutoff is a real sound.
    expect(Object.hasOwn(SEED_BODY_FILTER, 'enabled')).toBe(false);
    expect(SEED_BODY_FILTER.envelope).toBeUndefined();
  });

  it('seeds an envelope whose peak is exactly the static cutoff it replaces', () => {
    // ⚠ THE ONE NUMBER THAT IS NOT FREE. While an envelope is present the lib
    // IGNORES `cutoff` and drives the frequency from `baseFrequency` upward by
    // `octaves`. Pinning the peak to the static cutoff is what makes adding an
    // envelope a change to the body of a note and not to its attack — and it is a
    // relationship between two constants, so nothing but this would catch one of
    // them moving.
    expect(
      SEED_BODY_FILTER_ENVELOPE.baseFrequency * 2 ** SEED_BODY_FILTER_ENVELOPE.octaves,
    ).toBe(SEED_BODY_FILTER.cutoff);
    // It has to actually sweep, or the envelope is a fixed cutoff wearing an ADSR.
    expect(SEED_BODY_FILTER_ENVELOPE.octaves).toBeGreaterThan(0);
    expect(SEED_BODY_FILTER_ENVELOPE.baseFrequency).toBeGreaterThan(0);
    // Every field `buildChain` reads off it is present — a partial envelope is
    // five `undefined`s handed to `Tone.FrequencyEnvelope`.
    expect(Object.keys(SEED_BODY_FILTER_ENVELOPE).sort()).toEqual([
      'attack',
      'baseFrequency',
      'decay',
      'octaves',
      'release',
      'sustain',
    ]);
  });
});
