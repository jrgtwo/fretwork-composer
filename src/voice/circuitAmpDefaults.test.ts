import { describe, it, expect } from 'vitest';
import { CIRCUIT_AMPS, getCircuitAmp } from '@fretwork/lib';
import { SEED_CIRCUIT_AMP, circuitAmpControlPath } from './circuitAmpDefaults';
import { CIRCUIT_AMP_SECTION, paramApplies, visibleParams } from './paramSchema';
import { getAtPath, setAtPath } from './presetPaths';

describe('SEED_CIRCUIT_AMP', () => {
  it('seeds a well-formed stage the lib can build', () => {
    expect(SEED_CIRCUIT_AMP.ampId).toBe('princeton-5f2a');
    expect(SEED_CIRCUIT_AMP.inputGainDb).toBe(0);
    const amp = getCircuitAmp(SEED_CIRCUIT_AMP.ampId);
    for (const control of amp.controls) {
      expect(SEED_CIRCUIT_AMP.controls[control.id]).toBe(control.default);
    }
  });

  it('seeds no key the amp does not declare', () => {
    const declared = new Set(getCircuitAmp(SEED_CIRCUIT_AMP.ampId).controls.map((c) => c.id));
    for (const key of Object.keys(SEED_CIRCUIT_AMP.controls)) {
      expect(declared.has(key)).toBe(true);
    }
  });
});

describe('CIRCUIT_AMP_SECTION', () => {
  it('declares a row for every control of every amp', () => {
    const paths = new Set(CIRCUIT_AMP_SECTION.params.map((p) => p.path));
    for (const amp of CIRCUIT_AMPS) {
      for (const control of amp.controls) {
        expect(paths.has(circuitAmpControlPath(amp.id, control.id))).toBe(true);
      }
    }
  });

  it('gates every control row on every amp that declares it', () => {
    // ⚠ ONE ROW PER CONTROL ID, NOT PER AMP. `circuitAmpControlPath` does not
    // namespace by amp, so a shared id — `tone`, on both amps today — is ONE
    // row gated on both. Asserting `oneOf: [amp.id]` here would demand the
    // duplicate-path shape that `PARAM_BY_PATH` silently collapses.
    for (const amp of CIRCUIT_AMPS) {
      for (const control of amp.controls) {
        const row = CIRCUIT_AMP_SECTION.params.find(
          (p) => p.path === circuitAmpControlPath(amp.id, control.id),
        );
        const declaring = CIRCUIT_AMPS.filter((a) =>
          a.controls.some((c) => c.id === control.id),
        ).map((a) => a.id);
        expect(row?.appliesWhen?.path).toBe('effects.circuitAmp.ampId');
        expect([...(row?.appliesWhen?.oneOf ?? [])].sort()).toEqual([...declaring].sort());
        expect(row?.appliesWhen?.oneOf).toContain(amp.id);
      }
    }
  });

  it("takes each row's range from the control that declares it, never from this file", () => {
    const amp = getCircuitAmp('princeton-5f2a');
    const volume = amp.controls.find((c) => c.id === 'volume')!;
    // Narrowed because `CircuitAmpControl` is a union — a switch has no range
    // to take, and this test is about where a POT's range comes from.
    if (volume.kind !== 'pot') throw new Error("the Princeton's Volume is a pot");
    const row = CIRCUIT_AMP_SECTION.params.find(
      (p) => p.path === circuitAmpControlPath(amp.id, 'volume'),
    );
    expect(row).toMatchObject({
      min: volume.min,
      max: volume.max,
      step: volume.step,
      fallback: volume.default,
      label: volume.label,
    });
  });

  it('carries the input gain as an ungated row, since every amp has one', () => {
    const row = CIRCUIT_AMP_SECTION.params.find(
      (p) => p.path === 'effects.circuitAmp.inputGainDb',
    );
    expect(row).toBeDefined();
    expect(row?.appliesWhen).toBeUndefined();
  });

  it('is removable, so the classic amp can be compared against it', () => {
    expect(CIRCUIT_AMP_SECTION.presenceProbe).toBe('effects.circuitAmp');
    expect(CIRCUIT_AMP_SECTION.removableBranch).toBe('effects.circuitAmp');
  });
});

/**
 * Adding the stage through the generic gesture.
 *
 * `addTrackVoiceSection` (and `VoicePane.addSection`, its twin) seeds a section
 * by writing each non-optional row's `fallback` in declaration order. For this
 * section that WORKS — but only because `ampId` is declared before the control
 * rows that are gated on it: the loop updates the preset as it goes, so by the
 * time it reaches Volume the gate is already satisfied and the `controls`
 * record gets built.
 *
 * That is a genuine ordering dependency, and it is the reason this section
 * needs no seam of its own. Reorder the rows so a control comes before `ampId`
 * and the gesture silently produces a stage with an EMPTY `controls` record —
 * a half-formed stage the lib would try to build. These tests fail first.
 */
describe('seeding the section the way the Add gesture does', () => {
  function seedByRowOrder(): Record<string, unknown> {
    let preset = {} as Record<string, unknown>;
    for (const param of CIRCUIT_AMP_SECTION.params) {
      if (param.optional) continue;
      if (!paramApplies(preset as never, param)) continue;
      if (param.kind === 'sample-pack' || param.kind === 'source-kind') continue;
      preset = setAtPath(preset as never, param.path, param.fallback) as never;
    }
    return preset;
  }

  it('declares the amp picker before any row gated on it', () => {
    const paths = CIRCUIT_AMP_SECTION.params.map((p) => p.path);
    const ampIdAt = paths.indexOf('effects.circuitAmp.ampId');
    expect(ampIdAt).toBeGreaterThanOrEqual(0);
    for (const param of CIRCUIT_AMP_SECTION.params) {
      if (param.appliesWhen?.path !== 'effects.circuitAmp.ampId') continue;
      expect(paths.indexOf(param.path), param.path).toBeGreaterThan(ampIdAt);
    }
  });

  it('builds a stage carrying every control of the seeded amp', () => {
    const seeded = seedByRowOrder();
    const amp = getCircuitAmp('princeton-5f2a');
    expect(getAtPath(seeded as never, 'effects.circuitAmp.ampId')).toBe(amp.id);
    for (const control of amp.controls) {
      expect(
        getAtPath(seeded as never, circuitAmpControlPath(amp.id, control.id)),
        control.id,
      ).toBe(control.default);
    }
  });

  it('agrees with SEED_CIRCUIT_AMP, so the two ways in cannot drift', () => {
    const seeded = getAtPath(seedByRowOrder() as never, 'effects.circuitAmp') as Record<
      string,
      unknown
    >;
    expect(seeded.ampId).toBe(SEED_CIRCUIT_AMP.ampId);
    expect(seeded.inputGainDb).toBe(SEED_CIRCUIT_AMP.inputGainDb);
    expect(seeded.controls).toEqual(SEED_CIRCUIT_AMP.controls);
  });
});

/**
 * The gate, exercised.
 *
 * Both surfaces render a section through `visibleParams`, so "a Princeton shows
 * a Princeton's knobs" is entirely carried by `appliesWhen`. With one amp
 * shipped, that claim is unfalsifiable from the registry alone — every row
 * belongs to the only amp there is. These drive the gate directly instead, so
 * the second amp does not arrive to find every amp's knobs on every face.
 */
describe('only the selected amp\'s knobs are visible', () => {
  function presetWithAmpId(ampId: string) {
    return {
      effects: {
        circuitAmp: { enabled: true, ampId, inputGainDb: 0, controls: {} },
      },
    } as never;
  }

  it('shows the three rows every amp has, whatever is selected', () => {
    const paths = visibleParams(presetWithAmpId('princeton-5f2a'), CIRCUIT_AMP_SECTION).map(
      (p) => p.path,
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        'effects.circuitAmp.enabled',
        'effects.circuitAmp.ampId',
        'effects.circuitAmp.inputGainDb',
      ]),
    );
  });

  it('shows a control row only while an amp that declares it is selected', () => {
    // A SHARED id stays visible across an amp switch, which is the point of
    // grouping the rows — the tone pot keeps its position. What must not happen
    // is one amp showing another's exclusive controls.
    for (const amp of CIRCUIT_AMPS) {
      const visible = new Set(
        visibleParams(presetWithAmpId(amp.id), CIRCUIT_AMP_SECTION).map((p) => p.path),
      );
      const declaresHere = new Set(amp.controls.map((c) => c.id));
      for (const other of CIRCUIT_AMPS) {
        for (const control of other.controls) {
          const path = circuitAmpControlPath(other.id, control.id);
          expect(visible.has(path), `${amp.id} showing ${other.id}.${control.id}`).toBe(
            declaresHere.has(control.id),
          );
        }
      }
    }
  });

  it('shows no control at all for an amp id the registry has never heard of', () => {
    // The chain still builds — `getCircuitAmp` falls back — but the PANE draws
    // nothing rather than a set of knobs belonging to some other circuit.
    const visible = visibleParams(presetWithAmpId('no-such-amp'), CIRCUIT_AMP_SECTION);
    expect(visible.some((p) => p.path.startsWith('effects.circuitAmp.controls.'))).toBe(false);
  });
});
