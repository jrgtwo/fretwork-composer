import { describe, expect, it } from 'vitest';
import { getAtPath, hasBranchAtPath, hasPath, removeAtPath, setAtPath } from './presetPaths';

/** Shaped like the parts of a `VoicePreset` these functions actually walk, but a
 *  plain object — the module is deliberately lib-free, so the tests are too. */
const preset = {
  id: 'test',
  level: { volumeDb: 3, pan: 0 },
  source: { kind: 'sampler', samples: [{ A2: '/a2.mp3' }], release: 2.5 },
} as const;

describe('getAtPath', () => {
  it('reads a nested value', () => {
    expect(getAtPath(preset, 'level.volumeDb')).toBe(3);
    expect(getAtPath(preset, 'id')).toBe('test');
  });

  it('returns an array leaf whole rather than descending into it', () => {
    expect(getAtPath(preset, 'source.samples')).toBe(preset.source.samples);
    // The array is a leaf on the way DOWN too: indexing into it is not a path this
    // module honours, even though `samples[0].A2` exists.
    expect(getAtPath(preset, 'source.samples.0')).toBeUndefined();
    expect(getAtPath(preset, 'source.samples.0.A2')).toBeUndefined();
  });

  it('is undefined for a missing branch instead of throwing', () => {
    expect(getAtPath(preset, 'effects.amp.preDrive')).toBeUndefined();
  });

  it('is undefined when a segment resolves to a non-branch', () => {
    expect(getAtPath(preset, 'level.volumeDb.nope')).toBeUndefined();
    // `null` is the case the guard exists for — `typeof null === 'object'`, so
    // without the explicit null check this would throw rather than answer.
    expect(getAtPath({ a: null }, 'a.b')).toBeUndefined();
  });
});

describe('hasPath', () => {
  it('distinguishes present from absent', () => {
    expect(hasPath(preset, 'level.pan')).toBe(true);
    expect(hasPath(preset, 'effects')).toBe(false);
    expect(hasPath(preset, 'effects.amp')).toBe(false);
  });

  it('reports a key explicitly set to undefined as present', () => {
    // Key presence only. This is the shape the lib's own presets produce —
    // `cabIR: undefined` when the IR lookup misses — and it is exactly why section
    // presence is `hasBranchAtPath`'s job, not this one's.
    const withUndefined = { effects: { cabIR: undefined } };
    expect(hasPath(withUndefined, 'effects.cabIR')).toBe(true);
    expect(getAtPath(withUndefined, 'effects.cabIR')).toBeUndefined();
  });
});

describe('hasBranchAtPath', () => {
  it('is false for a key present with an undefined value, unlike hasPath', () => {
    // The whole reason this function exists. `effects: KARORYFER_GREEN_CAB ? {...} :
    // undefined` in the lib's presets means the section is absent while the key is
    // there; a section-presence check that said otherwise would render a Cabinet
    // section with no cabinet.
    const withUndefined = { effects: { cabIR: undefined } };
    expect(hasPath(withUndefined, 'effects.cabIR')).toBe(true);
    expect(hasBranchAtPath(withUndefined, 'effects.cabIR')).toBe(false);
    expect(hasBranchAtPath({ effects: undefined }, 'effects')).toBe(false);
  });

  it('is true for an object or an array, false for a scalar or a missing path', () => {
    expect(hasBranchAtPath(preset, 'level')).toBe(true);
    // `source.samples` is the one array a probe points at, so arrays must count.
    expect(hasBranchAtPath(preset, 'source.samples')).toBe(true);
    expect(hasBranchAtPath(preset, 'level.volumeDb')).toBe(false);
    expect(hasBranchAtPath(preset, 'effects.amp')).toBe(false);
    expect(hasBranchAtPath({ a: null }, 'a')).toBe(false);
  });
});

describe('setAtPath', () => {
  it('round-trips through getAtPath', () => {
    const next = setAtPath(preset, 'level.pan', -0.5);
    expect(getAtPath(next, 'level.pan')).toBe(-0.5);
  });

  it('does not mutate its input', () => {
    // `structuredClone` + `toStrictEqual` rather than `JSON.stringify`, which erases
    // keys whose value is `undefined` — precisely the shape this module handles
    // specially, so a stringify comparison would miss a mutation that added one.
    const snapshot = structuredClone(preset);
    setAtPath(preset, 'level.pan', -0.5);
    setAtPath(preset, 'effects.amp.preDrive', 0.4);
    setAtPath(preset, 'inputGainDb', undefined);
    expect(preset).toStrictEqual(snapshot);
  });

  it('leaves untouched siblings by reference', () => {
    const next = setAtPath(preset, 'level.pan', -0.5);
    expect(next.source).toBe(preset.source);
    expect(next.level).not.toBe(preset.level);
    expect(next.level.volumeDb).toBe(3);
  });

  it('creates every absent intermediate branch', () => {
    // Switching a section on is a write into a branch the preset does not have —
    // `ACOUSTIC_GUITAR_PRESET` ships with no `effects` object at all.
    const next = setAtPath(preset, 'effects.amp.preDrive', 0.4);
    expect(getAtPath(next, 'effects.amp.preDrive')).toBe(0.4);
    expect(getAtPath(next, 'level.volumeDb')).toBe(3);
  });

  it('returns the same reference when the value is unchanged', () => {
    expect(setAtPath(preset, 'level.volumeDb', 3)).toBe(preset);
    expect(setAtPath(preset, 'source.release', 2.5)).toBe(preset);
  });

  it('treats -0 as 0, so a fader crossing centre is not an edit', () => {
    expect(setAtPath(preset, 'level.pan', -0)).toBe(preset);
    const panned = setAtPath(preset, 'level.pan', 0.5);
    // And it normalises on the way in, so no preset ends up carrying -0.
    expect(Object.is(getAtPath(setAtPath(panned, 'level.pan', -0), 'level.pan'), 0)).toBe(true);
  });

  it('returns a new reference when writing a key that was absent, even as undefined', () => {
    const next = setAtPath(preset, 'inputGainDb', undefined);
    expect(next).not.toBe(preset);
    expect(hasPath(next, 'inputGainDb')).toBe(true);
  });

  it('replaces an array leaf wholesale rather than merging into it', () => {
    const banks = [{ A2: '/other.mp3' }];
    const next = setAtPath(preset, 'source.samples', banks);
    expect(getAtPath(next, 'source.samples')).toBe(banks);
  });

  it('refuses to descend into an array instead of silently flattening it', () => {
    // Spreading `[bank0, bank1]` into an object yields `{0: …}` and drops every
    // other round-robin bank — inaudible data loss. A path that tries it is wrong.
    const multiBank = { source: { samples: [{ A2: '/rr1.mp3' }, { A2: '/rr2.mp3' }] } };
    expect(() => setAtPath(multiBank, 'source.samples.0.A2', '/x.mp3')).toThrow(/array leaf/);
    expect(multiBank.source.samples).toHaveLength(2);
  });

  it('overwrites a non-branch standing in the way of a deeper write', () => {
    const next = setAtPath(preset, 'source.release.nested', 1);
    expect(getAtPath(next, 'source.release.nested')).toBe(1);
  });
});

describe('removeAtPath', () => {
  const withEffects = setAtPath(
    setAtPath(preset, 'effects.amp.preDrive', 0.4),
    'effects.cabIR.url',
    '/ir.wav',
  );

  it('takes a section back to absent', () => {
    const next = removeAtPath(withEffects, 'effects.amp');
    expect(hasPath(next, 'effects.amp')).toBe(false);
    expect(hasPath(next, 'effects.cabIR')).toBe(true);
  });

  it('prunes a parent branch left empty, so the preset returns to its original shape', () => {
    const onlyAmp = setAtPath(preset, 'effects.amp.preDrive', 0.4);
    const next = removeAtPath(onlyAmp, 'effects.amp');
    expect(hasPath(next, 'effects')).toBe(false);
    expect(next).toStrictEqual(preset);
  });

  it('prunes every ancestor the removal empties, not just the immediate parent', () => {
    // Removing the amp's last param has to leave the preset without `effects` at
    // all, or the pane reads a hollow `effects: { amp: {} }` as a bypassed amp.
    const onlyLeaf = setAtPath(preset, 'effects.amp.enabled', false);
    const next = removeAtPath(onlyLeaf, 'effects.amp.enabled');
    expect(hasPath(next, 'effects.amp')).toBe(false);
    expect(hasPath(next, 'effects')).toBe(false);
    expect(next).toStrictEqual(preset);
  });

  it('does not mutate its input', () => {
    const snapshot = structuredClone(withEffects);
    removeAtPath(withEffects, 'effects.amp');
    removeAtPath(withEffects, 'effects.cabIR.url');
    expect(withEffects).toStrictEqual(snapshot);
  });

  it('returns the same reference when the path was already absent', () => {
    expect(removeAtPath(preset, 'effects.amp')).toBe(preset);
    expect(removeAtPath(withEffects, 'effects.reverb')).toBe(withEffects);
  });

  it('leaves untouched siblings by reference', () => {
    const next = removeAtPath(withEffects, 'effects.amp');
    expect(next.source).toBe(preset.source);
    expect(next.level).toBe(preset.level);
  });

  it('removes a leaf without disturbing its siblings', () => {
    const next = removeAtPath(preset, 'source.release');
    expect(hasPath(next, 'source.release')).toBe(false);
    expect(getAtPath(next, 'source.samples')).toBe(preset.source.samples);
  });
});
