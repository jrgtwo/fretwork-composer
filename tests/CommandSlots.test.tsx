import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_PATTERNS_STATE, usePatternsStore } from '@fretwork/lib';
import { SlotFields } from '../src/ai/commandSlots';
import type { Command, SlotValue } from '../src/ai/commandTypes';
import { defaultValues } from '../src/ai/slotSources';

/**
 * AG-07 — the half of a command panel that BOTH pages share.
 *
 * It was extracted from `CommandPanel` rather than written, and an extraction
 * with no tests of its own is a shared component whose only exercise is being
 * rendered incidentally by whichever panel a test happened to open. So this file
 * drives it directly, with commands authored HERE rather than taken from the
 * catalog: the claim is about the control a `slot.kind` implies, and pinning it
 * to a real command would make it fail the day that command's slots change for
 * reasons of its own.
 *
 * There is no run anywhere in here, and no seam beyond the ones `slotOptions`
 * reads for a choice source — that is the point of the split. See the module's
 * header for why the RUN halves are deliberately not shared.
 */

const numberCommand = (
  overrides: Partial<Extract<Command['slots'][number], { kind: 'number' }>> = {},
): Command => ({
  id: 'test-number',
  page: 'pattern',
  label: 'A number',
  summary: 'Test.',
  slots: [
    {
      kind: 'number',
      id: 'tempo',
      label: 'Tempo',
      min: 60,
      max: 70,
      step: 5,
      unit: 'bpm',
      fallback: 65,
      ...overrides,
    },
  ],
  tools: [],
  template: 'Set it to {tempo}.',
});

const ENUM_COMMAND: Command = {
  id: 'test-enum',
  page: 'pattern',
  label: 'An enum',
  summary: 'Test.',
  slots: [
    {
      kind: 'enum',
      id: 'direction',
      label: 'Direction',
      options: [
        { value: 'busier', label: 'Busier' },
        { value: 'sparser', label: 'Sparser', hint: 'fewer notes' },
      ],
      fallback: 'busier',
      help: 'Which way to take it.',
    },
  ],
  tools: [],
  template: 'Make it {direction}.',
};

/** A choice slot whose SOURCE is empty in a bare store — no patterns in the
 *  library means nothing to offer, which is a state and not an empty picker. */
const PATTERN_CHOICE: Command = {
  id: 'test-choice',
  page: 'composition',
  label: 'A choice',
  summary: 'Test.',
  slots: [{ kind: 'choice', id: 'pattern', source: 'pattern', label: 'Pattern' }],
  tools: [],
  template: 'Use {pattern}.',
};

/** The panels' own wiring, in miniature: seed once from live state, then hold
 *  what the user picked. Re-seeding on every render is the defect this shape
 *  exists to avoid, and it would make every assertion below vacuous. */
function Harness({ command }: { command: Command }) {
  const [values, setValues] = useState<Readonly<Record<string, SlotValue>>>(() =>
    defaultValues(command),
  );
  return (
    <SlotFields
      command={command}
      values={values}
      onChange={(id, value) => setValues((was) => ({ ...was, [id]: value }))}
    />
  );
}

beforeEach(() => {
  sessionStorage.clear();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
});

describe('a number slot', () => {
  it('names its readout, so the label points at something', () => {
    render(<Harness command={numberCommand()} />);

    // A GROUP rather than a labelled control: there is no input by design, and
    // a `<label htmlFor>` aimed at a `<span>` names it for nobody.
    expect(screen.getByRole('group', { name: 'Tempo' })).toHaveTextContent('65');
  });

  it('steps by the catalog’s stride, not by one', async () => {
    render(<Harness command={numberCommand()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Increase Tempo' }));
    expect(screen.getByRole('group', { name: 'Tempo' })).toHaveTextContent('70');
  });

  it('clamps at the top rather than wrapping', async () => {
    render(<Harness command={numberCommand()} />);

    const up = screen.getByRole('button', { name: 'Increase Tempo' });
    await userEvent.click(up);
    await userEvent.click(up);
    await userEvent.click(up);

    // 65 → 70 → 70. A stride that overshoots the ceiling stops AT it; wrapping
    // to the floor would hand `fillCommand` a value the user did not choose.
    expect(screen.getByRole('group', { name: 'Tempo' })).toHaveTextContent('70');
  });

  it('clamps at the bottom for the same reason', async () => {
    render(<Harness command={numberCommand()} />);

    const down = screen.getByRole('button', { name: 'Decrease Tempo' });
    await userEvent.click(down);
    await userEvent.click(down);
    await userEvent.click(down);

    expect(screen.getByRole('group', { name: 'Tempo' })).toHaveTextContent('60');
  });

  it('shows the unit beside the value', () => {
    render(<Harness command={numberCommand()} />);
    expect(screen.getByText('bpm')).toBeInTheDocument();
  });
});

describe('an enum slot', () => {
  it('is a picker of its authored options, opening on the fallback', () => {
    render(<Harness command={ENUM_COMMAND} />);

    const select = screen.getByLabelText('Direction');
    expect(select).toHaveValue('busier');
    // The hint is shown WITH the label rather than instead of it.
    expect(screen.getByRole('option', { name: 'Sparser — fewer notes' })).toBeInTheDocument();
  });

  it('carries the slot’s help text', () => {
    render(<Harness command={ENUM_COMMAND} />);
    expect(screen.getByText('Which way to take it.')).toBeInTheDocument();
  });

  it('keeps what the user picked', async () => {
    render(<Harness command={ENUM_COMMAND} />);

    await userEvent.selectOptions(screen.getByLabelText('Direction'), 'sparser');
    expect(screen.getByLabelText('Direction')).toHaveValue('sparser');
  });
});

describe('a choice slot with nothing to offer', () => {
  /**
   * A STATE the panel says out loud, not an empty `<select>` that opens onto
   * nothing. `fillForNow` refuses such a command anyway, so the alternative is a
   * control the user can operate and a refusal they cannot explain.
   */
  it('says so instead of rendering an empty picker', () => {
    render(<Harness command={PATTERN_CHOICE} />);

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    // The seam's own sentence, whatever it is — pinned by shape, not by
    // wording, because `slotSources` owns the copy.
    expect(screen.getByText(/The pattern library is empty/)).toBeInTheDocument();
  });
});
