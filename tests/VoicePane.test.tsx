import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ACOUSTIC_GUITAR_PRESET,
  CABINET_IRS,
  detectSamplePack,
  sourceTrimDb,
  useFretworkStore,
  useVoiceStore,
  type CabIRParams,
  type VoicePreset,
} from '@fretwork/lib';
import { VoicePane, type WorkingVoice } from '../src/voice/VoicePane';
import type { SectionId } from '../src/voice/paramSchema';
import { getAtPath } from '../src/voice/presetPaths';
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
    for (const name of ['Source', 'Body filter', 'Pedals', 'Amp', 'Cabinet', 'Level']) {
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
    const samples = section('Source');
    expect(samples).toHaveAttribute(
      'aria-controls',
      // the region the button claims to control is the one holding the controls
      pack.closest('[id$="-region"]')!.id,
    );
    expect(pack).not.toBeVisible();
    await userEvent.click(samples);
    expect(pack).toBeVisible();
  });

  it('adds a circuit amp and shows only the selected amp\'s knobs', async () => {
    // The whole point of the circuit-amp section: the pane has no per-amp code.
    // A Princeton declares Volume and Tone in the lib, and those are the two
    // knobs that appear — a Deluxe with tremolo will get its own set from its
    // own definition with nothing changed here.
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Add Amp (circuit)' }));

    // Scoped to the section's own region: 'Volume' is also a Level row, and a
    // bare query would pass on the wrong control.
    const stageRegion = screen.getByRole('region', { name: 'Amp (circuit) stage' });
    expect(within(stageRegion).getByLabelText('Amp')).toBeInTheDocument();
    expect(within(stageRegion).getByLabelText('Volume')).toBeInTheDocument();
    expect(within(stageRegion).getByLabelText('Tone')).toBeInTheDocument();
    // Input gain is the universal row — before the circuit, not the amp's own
    // Volume, which sits inside it. Both are present and they are not the same
    // control.
    expect(within(stageRegion).getByLabelText('Input gain')).toBeInTheDocument();
    // And no knob from an amp this one does not declare.
    expect(within(stageRegion).queryByLabelText('Presence')).not.toBeInTheDocument();

    // And nothing from the classic amp leaks in: that stage has its own section
    // and `wireChain` builds one or the other.
    const stage = workingPreset().effects?.circuitAmp;
    expect(stage?.ampId).toBe('princeton-5f2a');
    expect(stage?.controls).toEqual({ volume: 0.5, tone: 0.5 });
  });

  it('reads absent and bypassed as different states', async () => {
    // Not a hypothetical: the stock acoustic guitar ships with no `effects` object at
    // all, so amp, circuit amp and cabinet all start absent — and no `bodyFilter`
    // either, which is the state thirteen of the fourteen built-ins are in.
    expect(ACOUSTIC_GUITAR_PRESET.effects).toBeUndefined();
    expect(ACOUSTIC_GUITAR_PRESET.bodyFilter).toBeUndefined();
    render(<Host />);
    // Four, not three: the experimental circuit amp is a section of its own and no
    // shipped preset carries one, by design — `wireChain` builds one amp or the
    // other, so a built-in voiced on the classic amp must not also carry a circuit.
    expect(screen.getAllByText('Not on this preset')).toHaveLength(4);

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
    await userEvent.click(section('Source'));
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
    await userEvent.click(section('Source'));
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
    await pickVoice('default:karoryfer-green-guitar');

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
    await pickVoice('default:karoryfer-green-guitar');

    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(screen.queryByLabelText('Drive')).not.toBeInTheDocument();
    expect((screen.getByLabelText('Voice') as HTMLSelectElement).value).toBe(
      'default:karoryfer-green-guitar',
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

  /**
   * ── The Source panel ───────────────────────────────────────────────────────
   *
   * These four replace "renders a synth source read-only", which asserted the
   * old behaviour: the section probed `source.samples`, so on the four
   * synth-sourced built-ins it was absent and the pane printed a read-only dump
   * of the params instead. Every one of them asserts against the WORKING PRESET
   * — the object handed to `onWorkingChange` and, in the same `commit`, to
   * `applyVoicePreset`. A control that renders and writes nothing is invisible
   * from the row's side and obvious from the preset's.
   */
  it('switches the source and hands over a well-formed one', async () => {
    render(<Host />);
    await userEvent.click(section('Source'));
    expect(ACOUSTIC_GUITAR_PRESET.source.kind).toBe('sampler');

    await userEvent.selectOptions(screen.getByLabelText('Source'), 'fm-synth');

    // The WHOLE branch was replaced. `source.kind = 'fm-synth'` on its own would
    // leave `samples` beside it — an object matching no arm of `VoiceSource`,
    // which `Voice` reads `params` off and gets `undefined` from.
    const source = workingPreset().source;
    expect(source.kind).toBe('fm-synth');
    expect(Object.keys(source).sort()).toEqual(['kind', 'params']);
    expect('samples' in source).toBe(false);

    // …and the rows followed the value, in both directions.
    expect(screen.getByRole('spinbutton', { name: 'Harmonicity' })).toBeInTheDocument();
    expect(screen.getByLabelText('Carrier')).toBeInTheDocument();
    expect(screen.getByLabelText('Env attack')).toBeInTheDocument();
    expect(screen.queryByLabelText('Pack')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Attack noise')).not.toBeInTheDocument();
  });

  it('switches back to samples and lands on a pack that has samples in it', async () => {
    // `SAMPLE_PACKS[0]` is `empty`, whose one bank is `{}` — the switch has to
    // land on something audible, not merely on something well-typed.
    const fetched = vi.fn(() => Promise.resolve());
    vi.stubGlobal('fetch', fetched);
    render(<Host />);
    await userEvent.click(section('Source'));

    await userEvent.selectOptions(screen.getByLabelText('Source'), 'fm-synth');
    await userEvent.selectOptions(screen.getByLabelText('Source'), 'sampler');

    const source = workingPreset().source;
    expect(source.kind).toBe('sampler');
    if (source.kind !== 'sampler') throw new Error('unreachable');
    expect(detectSamplePack(source.samples)?.id).toBe('philharmonia-classical');
    expect((screen.getByLabelText('Pack') as HTMLSelectElement).value).toBe(
      'philharmonia-classical',
    );

    // …and the banks were put in flight. Without this the `warmSampleBanks` call in
    // the kind picker's handler could be deleted and this test would still pass —
    // stubbing `fetch` is not the same as asserting it was used. A fresh sampler's
    // banks are ones nothing has fetched, and `reconcile` will not build a graph on
    // a silent page, so the prefetch is the only thing standing between the switch
    // and a first Play that stalls on the whole pack.
    await waitFor(() => expect(fetched).toHaveBeenCalled());
  });

  it('writes an encoder turn into the preset the engine is handed', async () => {
    // The silent-failure guard. An encoder is a `<div role="spinbutton">` with no
    // form value, so "the control is on screen" says nothing about whether its
    // `onChange` reaches the preset. Only the working copy can.
    render(<Host />);
    await userEvent.click(section('Source'));
    await userEvent.selectOptions(screen.getByLabelText('Source'), 'fm-synth');

    const harmonicity = screen.getByRole('spinbutton', { name: 'Harmonicity' });
    const start = Number(harmonicity.getAttribute('aria-valuenow'));
    fireEvent.keyDown(harmonicity, { key: 'ArrowUp' });

    // The descriptor's step is 0.05, and an encoder is relative: start + one step.
    expect(getAtPath(workingPreset(), 'source.params.harmonicity')).toBeCloseTo(start + 0.05, 6);
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

  // ─── the second source (`preset.layer`) ────────────────────────────────────
  //
  // Every assertion here reads the preset the pane hands `applyVoicePreset`, not
  // the DOM. That is the point: a layer is a branch nothing on screen renders
  // whole, and "a control exists" is exactly the check that would still pass with
  // the write deleted.

  /** Open Source and hand back the second source's group. Folded sections stay
   *  mounted but `hidden`, and a hidden subtree is out of the a11y tree. */
  const openSecondSource = async () => {
    await userEvent.click(section('Source'));
    return within(screen.getByRole('group', { name: 'Second source' }));
  };

  it('adds a second source as a whole VoiceLayer, not a half of one', async () => {
    // `Voice._buildLayer` calls `buildSynth(layer.source)` and reads `.kind` off
    // it, so a layer seeded field-by-field from row fallbacks — which is what
    // `addSection` would produce, since it skips `source-kind` rows — is a
    // TypeError in the audio engine rather than a quiet mistuning.
    expect(ACOUSTIC_GUITAR_PRESET.layer).toBeUndefined();
    render(<Host />);
    const layer = await openSecondSource();
    await userEvent.click(layer.getByRole('button', { name: 'Add Second source' }));

    const added = workingPreset().layer;
    expect(added).toBeDefined();
    expect(added!.source.kind).toBe('fm-synth');
    // The whole arm, not just the discriminant.
    expect(added!.source).toHaveProperty('params.harmonicity');
    expect(added!.source).toHaveProperty('params.envelope.attack');
    // Quiet and at unison — a stage that arrives must not be a level or pitch jump.
    expect(added!.octaveOffset).toBe(0);
    expect(added!.detuneCents).toBe(0);
    // ⚠ AGAINST THE PRIMARY, NOT AGAINST FULL SCALE. `_buildLayer` bypasses the
    // primary's `_sourceTrim` node and folds in only the layer's own, so the delta
    // that is audible is `gainDb + trim(layer) − trim(primary)` — and the Acoustic
    // Guitar this renders is a SAMPLER, trimmed 17 dB down. A bare
    // `gainDb <= -6` passes for every value of the thing that can be wrong here.
    const preset = workingPreset();
    const deltaDb = added!.gainDb + sourceTrimDb(added!.source) - sourceTrimDb(preset.source);
    expect(preset.source.kind).toBe('sampler');
    expect(deltaDb).toBeLessThanOrEqual(-6);
  });

  it('removes a second source branch and all of it', async () => {
    render(<Host />);
    const layer = await openSecondSource();
    await userEvent.click(layer.getByRole('button', { name: 'Add Second source' }));
    expect(workingPreset().layer).toBeDefined();

    await userEvent.click(
      within(screen.getByRole('group', { name: 'Second source' })).getByRole('button', {
        name: 'Remove Second source',
      }),
    );
    // Absent, not `{}` — `removeAtPath` prunes, and a hollow branch reads as
    // present to `hasBranchAtPath` and so would keep the rows on screen.
    expect(workingPreset().layer).toBeUndefined();
    expect(Object.hasOwn(workingPreset(), 'layer')).toBe(false);
  });

  it('shows a built-in`s real second source rather than the schema fallbacks', async () => {
    render(<Host />);
    await userEvent.selectOptions(screen.getByLabelText('Instrument'), 'bass');
    await pickVoice('default:acoustic-bass');
    const layer = await openSecondSource();

    // Acoustic Bass ships `gainDb: -8`, `octaveOffset: -1`, an FM sub-body at
    // `harmonicity: 0.5`. The seed is -12 / 0 / 3, so a row rendering its fallback
    // rather than the stored value fails every one of these.
    expect(layer.getByRole('spinbutton', { name: 'Second source Mix' })).toHaveAttribute(
      'aria-valuenow',
      '-8',
    );
    expect(layer.getByLabelText('Second source Octave')).toHaveValue('-1');
    expect(
      layer.getByRole('spinbutton', { name: 'Second source Harmonicity' }),
    ).toHaveAttribute('aria-valuenow', '0.5');

    // ⚠ AND THE TWO ARE TELLABLE APART BY NAME. The layer's rows are the
    // primary's descriptors generated under a second branch, so both stages of
    // this one section engrave "Harmonicity". The enclosing `role="group"` does
    // NOT name its descendants — a group is announced on entry — so without the
    // rows' own name scope a listener hears "Harmonicity" twice with nothing
    // between them. Exactly one of each name, and they are different elements.
    const primary = screen.getByRole('spinbutton', { name: 'Harmonicity' });
    const second = screen.getByRole('spinbutton', { name: 'Second source Harmonicity' });
    expect(primary).not.toBe(second);
    expect(primary).toHaveAttribute('aria-valuenow', '1');
  });

  it('writes a second source edit to `layer`, leaving the primary source alone', async () => {
    render(<Host />);
    await userEvent.selectOptions(screen.getByLabelText('Instrument'), 'bass');
    await pickVoice('default:acoustic-bass');
    const layer = await openSecondSource();

    const mix = layer.getByRole('spinbutton', { name: 'Second source Mix' });
    fireEvent.keyDown(mix, { key: 'ArrowUp' });
    // The descriptor's step is 0.5 dB, and an encoder is relative.
    expect(getAtPath(workingPreset(), 'layer.gainDb')).toBeCloseTo(-7.5, 6);

    // The primary's own harmonicity, read BEFORE the layer's is turned. The two
    // rows are one descriptor generated under two branches; if the generator ever
    // stopped substituting the prefix they would share a path, and nothing on
    // screen would say so.
    const primaryHarmonicity = getAtPath(workingPreset(), 'source.params.harmonicity');
    const harmonicity = layer.getByRole('spinbutton', { name: 'Second source Harmonicity' });
    fireEvent.keyDown(harmonicity, { key: 'ArrowUp' });
    expect(getAtPath(workingPreset(), 'layer.source.params.harmonicity')).toBeCloseTo(0.55, 6);
    expect(getAtPath(workingPreset(), 'source.params.harmonicity')).toBe(primaryHarmonicity);
  });

  it('changes the second source`s kind both ways, and never the primary`s', async () => {
    // ⚠ THE MIS-ROUTE GUARD. `trackVoiceDrafts` resolves any `source-kind` row
    // through `withSourceKind`, which always replaces `preset.source` — so a layer
    // picker wired the obvious way re-kinds the PRIMARY and looks, on screen, like
    // it worked. Asserted on both branches of the preset, in both directions.
    render(<Host />);
    await userEvent.selectOptions(screen.getByLabelText('Instrument'), 'bass');
    await pickVoice('default:acoustic-bass');
    const layer = await openSecondSource();

    await userEvent.selectOptions(layer.getByLabelText('Second source Source'), 'pluck-synth');
    let preset = workingPreset();
    expect(preset.layer?.source.kind).toBe('pluck-synth');
    // The whole arm was replaced, so the FM params are gone rather than sitting
    // beside a pluck tag — the malformed union `withLayerSourceKind` prevents.
    expect(preset.layer?.source).toHaveProperty('params.attackNoise');
    expect(preset.layer?.source).not.toHaveProperty('params.harmonicity');
    expect(preset.source.kind).toBe('fm-synth');
    expect(preset.source).toHaveProperty('params.harmonicity');

    await userEvent.selectOptions(
      within(screen.getByRole('group', { name: 'Second source' })).getByLabelText(
        'Second source Source',
      ),
      'fm-synth',
    );
    preset = workingPreset();
    expect(preset.layer?.source.kind).toBe('fm-synth');
    expect(preset.layer?.source).toHaveProperty('params.harmonicity');
    expect(preset.source.kind).toBe('fm-synth');
  });

  it('offers the layer no Detune of its own on a plucked source', async () => {
    // `applyLayerDetune` writes `synth.detune.value` on an FMSynth and silently
    // ignores a PluckSynth, so the control would do nothing there.
    render(<Host />);
    const layer = await openSecondSource();
    await userEvent.click(layer.getByRole('button', { name: 'Add Second source' }));

    const group = () => within(screen.getByRole('group', { name: 'Second source' }));
    expect(
      group().getByRole('spinbutton', { name: 'Second source Detune' }),
    ).toBeInTheDocument();
    await userEvent.selectOptions(group().getByLabelText('Second source Source'), 'pluck-synth');
    expect(
      group().queryByRole('spinbutton', { name: 'Second source Detune' }),
    ).not.toBeInTheDocument();
  });

  // ─── the body filter ───────────────────────────────────────────────────────

  const bodyFilter = () => within(screen.getByRole('region', { name: 'Body filter stage' }));

  it('adds a body filter as a static one, and its envelope as a separate gesture', async () => {
    // Two branches, two gestures, on purpose: a filter with no envelope is a fixed
    // cutoff, which is a sound of its own and not a half-built one.
    render(<Host />);
    await userEvent.click(section('Body filter'));
    await userEvent.click(bodyFilter().getByRole('button', { name: 'Add Body filter' }));

    let filter = workingPreset().bodyFilter;
    expect(filter).toBeDefined();
    expect(filter!.envelope).toBeUndefined();
    // Near-transparent rather than Tone's 350 Hz default — adding a stage must not
    // darken the voice. And `enabled` stays unwritten: the lib documents an absent
    // flag as implicit-on, so seeding `true` would state a choice nobody made.
    expect(filter!.cutoff).toBeGreaterThanOrEqual(6000);
    expect(Object.hasOwn(filter!, 'enabled')).toBe(false);

    await userEvent.click(bodyFilter().getByRole('button', { name: 'Add Cutoff envelope' }));
    filter = workingPreset().bodyFilter;
    // The WHOLE envelope. `buildChain` reads all six off it; five `undefined`s is
    // what a row-by-row seeding would have produced.
    expect(Object.keys(filter!.envelope!).sort()).toEqual([
      'attack',
      'baseFrequency',
      'decay',
      'octaves',
      'release',
      'sustain',
    ]);
    // Its peak lands on the static cutoff it replaces, so the attack is unchanged.
    expect(filter!.envelope!.baseFrequency * 2 ** filter!.envelope!.octaves).toBe(filter!.cutoff);
  });

  it('removes the envelope without removing the filter, and the filter with it', async () => {
    render(<Host />);
    await userEvent.click(section('Body filter'));
    await userEvent.click(bodyFilter().getByRole('button', { name: 'Add Body filter' }));
    await userEvent.click(bodyFilter().getByRole('button', { name: 'Add Cutoff envelope' }));
    expect(workingPreset().bodyFilter?.envelope).toBeDefined();

    await userEvent.click(bodyFilter().getByRole('button', { name: 'Remove Cutoff envelope' }));
    // `removeAtPath` prunes an emptied parent — `bodyFilter` still holds cutoff and
    // q, so it must survive rather than be pruned along with its envelope.
    expect(workingPreset().bodyFilter).toBeDefined();
    expect(workingPreset().bodyFilter?.envelope).toBeUndefined();

    await userEvent.click(bodyFilter().getByRole('button', { name: 'Remove Body filter' }));
    expect(workingPreset().bodyFilter).toBeUndefined();
  });

  // ---------------------------------------------------------- the pedalboard ---

  /** One pedal's card. Every pedal is a named group inside the one Pedals stage,
   *  which is what makes six identically-shaped units addressable at all. */
  const pedal = (name: string) => within(screen.getByRole('group', { name }));

  it('draws six pedals on one board, in the order the signal travels', async () => {
    render(<Host />);
    await userEvent.click(section('Pedals'));
    // ONE stage disclosure, not six — the design decision this renderer exists for.
    const board = screen.getByRole('region', { name: 'Pedals stage' });
    const names = within(board)
      .getAllByRole('group')
      .map((group) => group.getAttribute('aria-label'));
    expect(names).toEqual([
      'Compressor',
      'Distortion',
      'Chorus',
      'Delay',
      'Auto-wah',
      'Graphic EQ',
    ]);
  });

  it('adds a pedal with its maker`s values, then removes it', async () => {
    render(<Host />);
    await userEvent.click(section('Pedals'));
    // The stock acoustic guitar has no `effects` object at all, so every pedal
    // starts absent and the branch has to be created by the gesture.
    // All six — the board is present and empty, which is a state of its own.
    expect(screen.getAllByText(/Not on this voice/)).toHaveLength(6);

    await userEvent.click(pedal('Chorus').getByRole('button', { name: 'Add Chorus' }));
    // Tone's own defaults, complete — not a subset assembled from row fallbacks.
    expect(workingPreset().effects?.chorus).toEqual({
      frequency: 1.5,
      depth: 0.7,
      wet: 0.5,
      type: 'sine',
      feedback: 0,
      delayTime: 3.5,
      spread: 180,
    });
    // …and its controls are now on screen, named by the pedal so the four "Mix"
    // rows across this board can be told apart.
    expect(pedal('Chorus').getByLabelText('Chorus Mix')).toBeInTheDocument();
    expect(pedal('Chorus').getByLabelText('Chorus Depth')).toBeInTheDocument();

    await userEvent.click(pedal('Chorus').getByRole('button', { name: 'Remove Chorus' }));
    expect(workingPreset().effects?.chorus).toBeUndefined();
  });

  it('keeps a bypassed pedal on the board with its tuning', async () => {
    // Bypassed is not absent, and the pane has to show the difference: the tuning
    // is still there, the Remove button is still the lossy one, and the card says
    // which state it is in — the same three-state rule the stages follow.
    render(<Host />);
    await userEvent.click(section('Pedals'));
    await userEvent.click(pedal('Delay').getByRole('button', { name: 'Add Delay' }));

    const feedback = pedal('Delay').getByLabelText('Delay Feedback');
    fireEvent.change(feedback, { target: { value: '0.6' } });
    expect(workingPreset().effects?.delay?.feedback).toBe(0.6);

    await userEvent.click(pedal('Delay').getByRole('switch', { name: 'Delay Enabled' }));
    expect(workingPreset().effects?.delay?.enabled).toBe(false);
    // Still on the board, still tuned, and saying so.
    expect(workingPreset().effects?.delay?.feedback).toBe(0.6);
    // The switch itself is what says so — a pedal card cannot fold, so there is no
    // second note in its header to fall out of step with it.
    expect(pedal('Delay').getByRole('switch', { name: 'Delay Enabled' })).toHaveTextContent(
      'Bypassed',
    );
    expect(pedal('Delay').getByRole('button', { name: 'Remove Delay' })).toBeInTheDocument();
  });

  it('puts the compressor at the root of the preset, not under effects', async () => {
    // The one pedal whose branch is not `effects.<name>`. A renderer assembling
    // the path from the id would work for the other five and silently write
    // `effects.compressor`, which the engine reads nothing from.
    render(<Host />);
    await userEvent.click(section('Pedals'));
    await userEvent.click(pedal('Compressor').getByRole('button', { name: 'Add Compressor' }));
    expect(workingPreset().compressor?.ratio).toBe(12);
    expect(getAtPath(workingPreset(), 'effects.compressor')).toBeUndefined();
  });

  it('gives the graphic EQ seven bands and a level, all of them endless', async () => {
    // `Tone.Filter` publishes no bound for `gain`, so every one of these is an
    // encoder rather than a slider — a spinbutton with no `aria-valuemin`. The
    // lib's "typical ±15" is a description of use, and drawing a fader to it would
    // be indistinguishable from drawing one to a real limit.
    render(<Host />);
    await userEvent.click(section('Pedals'));
    await userEvent.click(pedal('Graphic EQ').getByRole('button', { name: 'Add Graphic EQ' }));

    for (const band of ['100 Hz', '200 Hz', '400 Hz', '800 Hz', '1.6 kHz', '3.2 kHz', '6.4 kHz']) {
      const control = pedal('Graphic EQ').getByRole('spinbutton', {
        name: `Graphic EQ ${band}`,
      });
      expect(control).not.toHaveAttribute('aria-valuemin');
      expect(control).not.toHaveAttribute('aria-valuemax');
    }
    expect(
      pedal('Graphic EQ').getByRole('spinbutton', { name: 'Graphic EQ Level' }),
    ).toBeInTheDocument();
  });

  it('gives the compressor real faders, because Tone documents its bounds', async () => {
    // The mirror of the test above, and the reason both are worth having: the
    // slider/encoder split is not a style choice per pedal, it is whether Tone
    // published a `@min`/`@max`. `Compressor.d.ts` does, on all five.
    render(<Host />);
    await userEvent.click(section('Pedals'));
    await userEvent.click(pedal('Compressor').getByRole('button', { name: 'Add Compressor' }));

    const threshold = pedal('Compressor').getByLabelText('Compressor Threshold');
    expect(threshold).toHaveAttribute('min', '-100');
    expect(threshold).toHaveAttribute('max', '0');
    const ratio = pedal('Compressor').getByLabelText('Compressor Ratio');
    expect(ratio).toHaveAttribute('min', '1');
    expect(ratio).toHaveAttribute('max', '20');
  });

});
