/**
 * The seed for the circuit-amp stage, and the path shape its knobs live at.
 *
 * A control's value is keyed by the id the amp's OWN definition declares, so
 * the preset shape does not change when an amp is added. That is what lets the
 * pane render a Princeton's two knobs today and a Deluxe's tremolo later with
 * no per-amp UI code — adding an amp is a definition in the lib plus a build
 * function, and nothing here moves.
 */
import { getCircuitAmp, DEFAULT_CIRCUIT_AMP_ID } from '@fretwork/lib';
import type { CircuitAmpParams } from '@fretwork/lib';

/**
 * Where one amp's knob lives in the preset.
 *
 * `ampId` is taken and deliberately unused: control ids are NOT namespaced by
 * amp today, because they need to be only if two amps ever declare the same id
 * with different ranges. Taking the parameter means that decision is one edit
 * here rather than a rewrite of every call site.
 */
export function circuitAmpControlPath(_ampId: string, controlId: string): string {
  return `effects.circuitAmp.controls.${controlId}`;
}

function seedControls(ampId: string): Record<string, number> {
  const seeded: Record<string, number> = {};
  for (const control of getCircuitAmp(ampId).controls) {
    seeded[control.id] = control.default;
  }
  return seeded;
}

/**
 * Written in ONE `setAtPath` when the stage is added.
 *
 * Not seeded row by row, for the reason `ParamSubBranch` documents: a stage
 * built from per-row fallbacks exists in a half-formed state — here, a
 * `controls` record with no keys — and the lib would try to build it.
 */
export const SEED_CIRCUIT_AMP: CircuitAmpParams = {
  enabled: true,
  ampId: DEFAULT_CIRCUIT_AMP_ID,
  inputGainDb: 0,
  controls: seedControls(DEFAULT_CIRCUIT_AMP_ID),
};
