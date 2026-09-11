/**
 * The MOD chip, on the one control that renders it.
 *
 * Both the pattern page's `VoicePane` and the composition page's
 * `TrackVoiceRack` render `ParamEnum`, so the marker lives here rather than in
 * either of them — a marker on one surface only would be a modded control
 * reading as stock on the other. `tests/VoiceMode.test.tsx` and the rack's own
 * tests cover that both surfaces reach this component.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ParamEnum } from './ParamEnum';

const OPTIONS = [
  { value: 'split', label: 'Split', description: 'The legs differ.' },
  { value: 'composed', label: 'Composed', description: 'The legs match.' },
];

function renderEnum(mod?: true) {
  render(
    <ParamEnum
      id="inverter"
      label="Inverter"
      value="split"
      options={OPTIONS}
      onChange={() => {}}
      {...(mod ? { mod } : {})}
    />,
  );
}

describe('ParamEnum — the mod chip', () => {
  it('marks a modded control', () => {
    renderEnum(true);
    const chip = document.querySelector('[data-mod-chip]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe('MOD');
    // The two letters say THAT it is a mod and nothing about what that means,
    // so the explanation has to be reachable.
    expect(chip?.getAttribute('title')).toMatch(/not a stock control/i);
  });

  it('marks nothing on a stock control', () => {
    renderEnum();
    expect(document.querySelector('[data-mod-chip]')).toBeNull();
  });

  it('leaves the control itself unchanged either way', () => {
    // The chip is a marker, not a state: it must not reach the accessible name,
    // which is what a screen reader announces when the select takes focus.
    renderEnum(true);
    expect(screen.getByLabelText('Inverter')).toBeInstanceOf(HTMLSelectElement);
  });
});
