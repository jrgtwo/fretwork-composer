import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ACOUSTIC_GUITAR_PRESET,
  CABINET_IRS,
  useFretworkStore,
  useVoiceStore,
  type CabIRParams,
  type VoicePreset,
} from '@fretwork/lib';
import { VoicePane, type WorkingVoice } from '../src/voice/VoicePane';
import type { SectionId } from '../src/voice/paramSchema';
import { openBlankPattern } from '../src/patterns/patternService';

/**
 * What jsdom cannot tell us here, so nobody wastes time writing it:
 *
 *   - **No Web Audio.** Every `applyVoicePreset` / `auditionVoice` call runs, finds no
 *     engine and returns; that the amp knob is *audible* is a by-ear check
 *     (`docs/FOLLOW-UPS.md` §3), not an assertion. That the pane *calls* the seam at all
 *     is assertable, and lives in `VoicePaneAudio.test.tsx` — it needs the module mocked,
 *     which has to happen before the import, so it cannot share this file.
 *   - **No range-input keyboard behaviour.** jsdom implements none, so arrows on a
 *     slider can only be verified in a browser. What is checkable is that the input is
 *     focusable and that its change reaches the working copy.
 *   - **No CSS.** A folded section's `hidden` *attribute* is assertable (`toBeVisible`
 *     reads it); the `hidden` utility *class* — which is the half that actually wins
 *     against `flex` in a browser — is not. So the disclosure test below protects the
 *     semantics and not the hiding: drop the class and it still passes.
 *   - **`commit`'s identity guard** (`next === preset`) cannot be reached from the DOM.
 *     React's own value tracker discards a `change` event whose value did not move, so
 *     the guard never sees one. It still covers the programmatic callers — `addSection`,
 *     `removeSection`, "Use suggested cab" — which is why it is not dead code.
 *
 * `working` and `openSections` are hoisted into a host component because that is where
 * they live in the real app — `App`, above `PaneStack`, which unmounts a collapsed
 * pane's body. A pane that owned them would pass these tests and still lose the user's
 * unsaved tone on a collapse.
 */
let lastWorking: WorkingVoice | null = null;

function Host() {
  const [working, setWorking] = useState<WorkingVoice | null>(null);
  const [openSections, setOpenSections] = useState<readonly SectionId[]>(['amp', 'cabinet']);
  return (
    <VoicePane
      working={working}
      onWorkingChange={(next) => {
        lastWorking = next;
        setWorking(next);
      }}
      openSections={openSections}
      onOpenSectionsChange={setOpenSections}
    />
  );
}

/** The unsaved preset the pane is holding — the only way to see fields the controls
 *  render identically whether they are set or absent (an omitted `enabled` and an
 *  `enabled: true` both draw "In chain"). */
const workingPreset = (): VoicePreset => {
  if (!lastWorking) throw new Error('no working copy — the pane reported no edit');
  return lastWorking.preset;
};

const pickVoice = (key: string) => userEvent.selectOptions(screen.getByLabelText('Voice'), key);
const section = (name: string) => screen.getByRole('button', { name });

/** Both `window.confirm` sites — discard-on-switch and delete — are stubbed rather than
 *  left to jsdom's "not implemented" throw. Returns the messages asked, so a test can
 *  assert the user was warned at all. */
function stubConfirm(answer: boolean): string[] {
  const asked: string[] = [];
  vi.stubGlobal('confirm', (message?: string) => {
    asked.push(String(message));
    return answer;
  });
  return asked;
}

beforeEach(() => {
  lastWorking = null;
  // Both stores are module singletons: the pattern's instrument comes from the lib's
  // global store at creation time, and variants persist to sessionStorage.
  useFretworkStore.getState().setInstrumentId('guitar');
  useVoiceStore.getState().reset();
  openBlankPattern('Voice test');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VoicePane', () => {
  it('labels every control it renders', async () => {
    render(<Host />);
    expect(screen.getByLabelText('Instrument')).toBeInTheDocument();
    expect(screen.getByLabelText('Voice')).toBeInTheDocument();

    // Section disclosures carry the label alone — no status text folded into the
    // accessible name, which is why the status note sits outside the button.
    for (const name of ['Samples', 'Amp', 'Cabinet', 'Level']) {
      expect(section(name)).toBeInTheDocument();
    }

    const level = section('Level');
    expect(level).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(level);
    expect(level).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Input gain')).toBeInTheDocument();
    expect(screen.getByLabelText('Volume')).toBeInTheDocument();
    expect(screen.getByLabelText('Pan')).toBeInTheDocument();
  });

  it('folds a section without unmounting it — aria-controls needs the region to exist', async () => {
    render(<Host />);
    const pack = screen.getByLabelText('Pack');
    const samples = section('Samples');
    expect(samples).toHaveAttribute(
      'aria-controls',
      // the region the button claims to control is the one holding the controls
      pack.closest('[id$="-region"]')!.id,
    );
    expect(pack).not.toBeVisible();
    await userEvent.click(samples);
    expect(pack).toBeVisible();
  });

  it('reads absent and bypassed as different states', async () => {
    // Not a hypothetical: the stock acoustic guitar ships with no `effects` object at
    // all, so both amp and cabinet start absent.
    expect(ACOUSTIC_GUITAR_PRESET.effects).toBeUndefined();
    render(<Host />);
    expect(screen.getAllByText('Not on this preset')).toHaveLength(2);

    await userEvent.click(screen.getByRole('button', { name: 'Add Cabinet' }));
    const toggle = screen.getByRole('switch', { name: 'Cabinet Enabled' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(toggle);
    expect(screen.getByRole('switch', { name: 'Cabinet Enabled' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    // Bypassed keeps the tuning — the cabinet picker is still there. Three times: the
    // section header, the switch, and the cab graphic's own state line, which is what
    // stops a bypassed cabinet being drawn identically to a live one.
    expect(screen.getAllByText('Bypassed')).toHaveLength(3);
    expect(screen.getByLabelText('Cabinet')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove Cabinet' }));
    expect(screen.queryByLabelText('Cabinet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Cabinet' })).toBeInTheDocument();
  });

  it('names every bypass switch after its own stage', async () => {
    // Amp and Cabinet open together by default, so both switches are in the tree at
    // once. "Enabled, switch" twice over is the same defect the Add/Remove buttons
    // already solve, and a test that adds only one section cannot see it.
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Add Amp' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add Cabinet' }));

    expect(screen.getByRole('switch', { name: 'Amp Enabled' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Cabinet Enabled' })).toBeInTheDocument();
    expect(screen.getAllByRole('switch')).toHaveLength(2);
  });

  it('seeds an added branch from the schema fallbacks', async () => {
    render(<Host />);
    expect(screen.getByText('Saved')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add Amp' }));
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
    // The amp's params are knobs, not range inputs, so the value is on `aria-valuenow`
    // rather than on `.value` — which is also the only place a screen reader reads it.
    expect(screen.getByLabelText('Drive')).toHaveAttribute('aria-valuenow', '0.3');
    expect(screen.getByLabelText('Power')).toHaveAttribute('aria-valuenow', '0.1');
    // An absent modelId resolves through `getAmpModel`, so the picker names the model
    // the chain would really build rather than showing nothing.
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('marshall-plexi');
  });

  it('leaves the optional params of an added branch unwritten', async () => {
    // Not visible in the DOM: an omitted `enabled` and `enabled: true` both render "In
    // chain", and an omitted `modelId` renders as Plexi either way. So the assertion has
    // to be on the preset. Writing our guess would turn "the lib's default" into a value
    // the user never chose, and would be saved as such.
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Add Amp' }));

    const amp = workingPreset().effects?.amp;
    expect(amp?.preDrive).toBe(0.3); // required — seeded
    expect(amp?.enabled).toBeUndefined();
    expect(amp?.modelId).toBeUndefined();
    expect(workingPreset().effects?.cabIR).toBeUndefined();
  });

  it('offers the amp model’s suggested cab — nothing in the lib applies it', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Add Amp' }));
    // Folded first: the button lives in Amp and writes into Cabinet, so with Cabinet
    // closed the only feedback would be the button vanishing.
    await userEvent.click(section('Cabinet'));
    expect(section('Cabinet')).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(screen.getByRole('button', { name: /Use suggested cab/ }));

    // Creates the cabinet branch from the pairing, unfolds the section it landed in,
    // and the offer retires.
    expect(section('Cabinet')).toHaveAttribute('aria-expanded', 'true');
    expect((screen.getByLabelText('Cabinet') as HTMLSelectElement).value).toMatch(/^https?:/);
    expect(screen.queryByRole('button', { name: /Use suggested cab/ })).not.toBeInTheDocument();
  });

  it('writes a slider edit into the working copy', async () => {
    render(<Host />);
    await userEvent.click(section('Level'));
    const volume = screen.getByLabelText('Volume') as HTMLInputElement;

    volume.focus();
    expect(document.activeElement).toBe(volume);

    fireEvent.change(volume, { target: { value: '-6' } });
    expect((screen.getByLabelText('Volume') as HTMLInputElement).value).toBe('-6');
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
  });

  it('highlights the active sample pack by shape, not by id', async () => {
    render(<Host />);
    await userEvent.click(section('Samples'));
    // The preset stores note→URL maps; `detectSamplePack` is what recognises them.
    expect((screen.getByLabelText('Pack') as HTMLSelectElement).value).toBe(
      'philharmonia-classical',
    );
  });

  it('writes a pack change as banks and gets them in flight', async () => {
    // The one edit class the whole LIB-GAP(9a/9b) rebuild machinery exists for, and the
    // one that reaches the network: `fetch` is stubbed both to keep jsdom off the wire
    // and because the calls *are* the assertion that LIB-GAP(10)'s prefetch ran.
    const fetched = vi.fn((url: string) => Promise.resolve(url));
    vi.stubGlobal('fetch', fetched);

    render(<Host />);
    await userEvent.click(section('Samples'));
    await userEvent.selectOptions(screen.getByLabelText('Pack'), 'casio-piano-demo');

    // The preset holds the pack's banks, not its id — which is why reading the
    // selection back needs `detectSamplePack`.
    expect((screen.getByLabelText('Pack') as HTMLSelectElement).value).toBe('casio-piano-demo');
    expect(workingPreset().source).toMatchObject({ kind: 'sampler' });

    // Trailing-coalesced, so it lands after the change rather than during it.
    await waitFor(() => expect(fetched).toHaveBeenCalled());
    const urls = fetched.mock.calls.map(([url]) => url);
    expect(urls.length).toBe(new Set(urls).size);
  });

  /** A stored variant, so the pane can be pointed at a preset this slice cannot author.
   *  Both cabinet cases below are only reachable from one — guitar-tutor's Sound Lab can
   *  write a custom IR URL, and hand-edited storage can drop the URL entirely. */
  const storeVariant = (preset: VoicePreset) =>
    useVoiceStore.getState().addVariant({
      name: 'Fixture',
      instrumentId: 'guitar',
      family: ACOUSTIC_GUITAR_PRESET.family,
      collectionId: null,
      preset,
    });

  it('admits an unregistered cabinet URL rather than naming one it isn’t', async () => {
    const id = storeVariant({
      ...ACOUSTIC_GUITAR_PRESET,
      effects: { cabIR: { url: 'https://example.invalid/not-a-registered-ir.wav' } },
    });

    render(<Host />);
    await pickVoice(`user:${id}`);

    const picker = screen.getByLabelText('Cabinet') as HTMLSelectElement;
    expect(picker.value).toBe('');
    expect(within(picker).getByRole('option', { name: 'Not in the registry' })).toBeDisabled();
    // The registry's first entry is offered but not chosen — the failure mode being
    // guarded against is a select that silently reports the wrong cabinet.
    expect(within(picker).getByRole('option', { name: CABINET_IRS[0].label })).toBeInTheDocument();
  });

  it('does not fill a missing cabinet URL in with the schema fallback', async () => {
    // The schema's `fallback` is what `addSection` *writes* when it creates the branch.
    // Reading an absent URL back through it instead would show the first registered
    // cabinet selected over a preset that holds none — the one case where this select
    // lies rather than admits. `url` is required by `CabIRParams`, hence the cast: the
    // point is that a persisted preset can still arrive without it.
    const id = storeVariant({
      ...ACOUSTIC_GUITAR_PRESET,
      effects: { cabIR: { enabled: true } as CabIRParams },
    });

    render(<Host />);
    await pickVoice(`user:${id}`);

    const picker = screen.getByLabelText('Cabinet') as HTMLSelectElement;
    expect(picker.value).toBe('');
    expect(within(picker).getByRole('option', { name: 'Not in the registry' })).toBeDisabled();
  });

  it('refuses Save on a built-in and says why', async () => {
    render(<Host />);
    await pickVoice('default:acoustic-guitar');
    await userEvent.click(screen.getByRole('button', { name: 'Add Amp' }));

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText(/Defaults are read-only/)).toBeInTheDocument();
    // Rename and Delete are refused for the same reason — there is no record to patch.
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('Save as… creates a variant, repoints the pattern and clears the working copy', async () => {
    render(<Host />);
    await pickVoice('default:acoustic-guitar');
    await userEvent.click(screen.getByRole('button', { name: 'Add Amp' }));

    await userEvent.click(screen.getByRole('button', { name: 'Save as…' }));
    const field = screen.getByLabelText('New name');
    await userEvent.clear(field);
    await userEvent.type(field, 'My tone');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    const variants = useVoiceStore.getState().variants;
    expect(variants.map((variant) => variant.name)).toEqual(['My tone']);
    // The record and its payload have to agree, or the picker offers a name the engine
    // doesn't build.
    expect(variants[0].preset.name).toBe('My tone');
    expect(variants[0].preset.effects?.amp).toBeDefined();

    expect(screen.getByText('Saved')).toBeInTheDocument();
    const picker = screen.getByLabelText('Voice') as HTMLSelectElement;
    expect(picker.value).toBe(`user:${variants[0].id}`);
    expect(within(picker).getByRole('group', { name: 'My tones' })).toBeInTheDocument();
    // A user variant can be saved to, so the read-only hint is gone.
    expect(screen.queryByText(/Defaults are read-only/)).not.toBeInTheDocument();
  });

  it('Save overwrites the variant every pattern pointing at it shares', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Save as…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await userEvent.click(screen.getByRole('button', { name: 'Add Amp' }));
    // `End` = the knob's max, which is the one edit whose result is a stated number
    // rather than a step count.
    fireEvent.keyDown(screen.getByLabelText('Drive'), { key: 'End' });
    expect(screen.getByText('Unsaved')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(useVoiceStore.getState().variants[0].preset.effects?.amp?.preDrive).toBe(1);
  });

  it('a rename while dirty reaches the working copy, so the next Save keeps it', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Save as…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add Amp' }));

    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const field = screen.getByLabelText('Rename');
    await userEvent.clear(field);
    await userEvent.type(field, 'Renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));

    // `saveVoice` writes the record's name back from `preset.name`, so a rename that
    // stopped at the store would be silently reverted here.
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(useVoiceStore.getState().variants[0].name).toBe('Renamed');
    expect(useVoiceStore.getState().variants[0].preset.name).toBe('Renamed');
  });

  it('confirms before a switch would strand unsaved work', async () => {
    const asked = stubConfirm(false);
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Add Amp' }));
    await pickVoice('default:electric-guitar');

    expect(asked).toHaveLength(1);
    // Refused, so the edit survives and the voice hasn't moved.
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
    expect(screen.getByLabelText('Drive')).toBeInTheDocument();
  });

  it('discards the working copy when the confirm is accepted', async () => {
    // The other half of the branch above, and the half that actually loses work: a
    // `chooseVoice` that forgot to clear the copy would leave the pane showing the old
    // preset's edits over the new voice.
    stubConfirm(true);
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Add Amp' }));
    await pickVoice('default:electric-guitar');

    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(screen.queryByLabelText('Drive')).not.toBeInTheDocument();
    expect((screen.getByLabelText('Voice') as HTMLSelectElement).value).toBe(
      'default:electric-guitar',
    );
  });

  it('confirms an instrument switch too, and moves the pattern when accepted', async () => {
    // `chooseInstrument`'s `next === instrumentId` guard is not asserted here and cannot
    // be: React's value tracker drops a `change` whose value did not move, so re-picking
    // the current instrument never reaches the handler at all.
    const asked = stubConfirm(true);
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Add Amp' }));
    await userEvent.selectOptions(screen.getByLabelText('Instrument'), 'bass');

    expect(asked).toHaveLength(1);
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect((screen.getByLabelText('Instrument') as HTMLSelectElement).value).toBe('bass');
    // Bass slots only — the voice list has to follow the pattern, or the picker offers a
    // voice that plays on another neck.
    expect(screen.queryByRole('option', { name: 'Acoustic Bass' })).toBeInTheDocument();
  });

  it('clears a refusal once the user is editing again', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Save as…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add Amp' }));

    // Pulled out from under the pane — a second tab, or another holder of the same
    // shared variant. The ref survives, so Save is still offered and still refused.
    const id = useVoiceStore.getState().variants[0].id;
    act(() => useVoiceStore.getState().deleteVariant(id));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText(/no longer in your library/)).toBeInTheDocument();

    // A notice describes a write that was rejected. Once knobs are moving again it
    // describes nothing, and it sits directly above the controls.
    fireEvent.keyDown(screen.getByLabelText('Drive'), { key: 'ArrowUp' });
    expect(screen.queryByText(/no longer in your library/)).not.toBeInTheDocument();
  });

  it('shows a ref the current instrument cannot play as unavailable', async () => {
    // A `<select>` whose value matches no option silently displays the first one, so
    // without this branch the picker would name a voice the pattern does not play.
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Save as…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await userEvent.selectOptions(screen.getByLabelText('Instrument'), 'bass');

    const picker = screen.getByLabelText('Voice') as HTMLSelectElement;
    const unavailable = within(picker).getByRole('option', { name: 'Unavailable voice' });
    expect(unavailable).toBeDisabled();
    expect(picker.value).toBe((unavailable as HTMLOptionElement).value);
  });

  it('stops showing a working copy whose pattern is no longer the one open', async () => {
    // The switch made behind the pane's back — an undo restoring a snapshot with another
    // `voiceRef`, or a second pattern opened from anywhere else. This half falls out of
    // the working key alone; that the *engine's* copy is retired with it is the part the
    // effect at VoicePane.tsx exists for, and it is pinned in `VoicePaneAudio.test.tsx`.
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Add Amp' }));
    expect(screen.getByText('Unsaved')).toBeInTheDocument();

    act(() => openBlankPattern('Somewhere else'));

    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(screen.queryByLabelText('Drive')).not.toBeInTheDocument();
  });

  it('hands focus back to the button that opened the name form', async () => {
    render(<Host />);
    const saveAs = screen.getByRole('button', { name: 'Save as…' });

    await userEvent.click(saveAs);
    expect(document.activeElement).toBe(screen.getByLabelText('New name'));

    // The form deletes itself, so without a hand-back the user lands on <body>.
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(saveAs);

    await userEvent.click(saveAs);
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(document.activeElement).toBe(saveAs);
  });

  it('Delete removes the variant and repoints the pattern', async () => {
    stubConfirm(true);
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Save as…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(useVoiceStore.getState().variants).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(useVoiceStore.getState().variants).toHaveLength(0);
    // The ref is cleared rather than left dangling, so the picker doesn't show a
    // selection that resolves to something else.
    expect((screen.getByLabelText('Voice') as HTMLSelectElement).value).toBe('');
    expect(screen.getByText(/no voice of its own/)).toBeInTheDocument();
  });

  it('renders a synth source read-only rather than pretending to edit it', async () => {
    render(<Host />);
    // `electric-guitar` is the one guitar slot that isn't sampler-sourced.
    await pickVoice('default:electric-guitar');
    await userEvent.click(section('Samples'));

    expect(screen.getByText(/synth editing lands in a later slice/)).toBeInTheDocument();
    expect(screen.getByText('dampening')).toBeInTheDocument();
    expect(screen.queryByLabelText('Pack')).not.toBeInTheDocument();
  });

  it('changing instrument re-offers that instrument’s voices', async () => {
    render(<Host />);
    await userEvent.selectOptions(screen.getByLabelText('Instrument'), 'bass');

    const picker = screen.getByLabelText('Voice') as HTMLSelectElement;
    const offered = within(picker)
      .getAllByRole('option')
      .map((option) => option.textContent);
    // Bass has two slots and none of the guitar amps.
    expect(offered).toEqual(['Instrument default', 'Acoustic Bass', 'Electric Bass']);
  });
});
