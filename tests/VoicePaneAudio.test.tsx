import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useFretworkStore, useVoiceStore } from '@fretwork/lib';
import { VoicePane, type WorkingVoice } from '../src/voice/VoicePane';
import type { SectionId } from '../src/voice/paramSchema';
import { openBlankPattern } from '../src/patterns/patternService';
import { applyVoicePreset, refreshVoice, warmVoice } from '../src/audio/playbackService';

/**
 * The pane → audio seam, which nothing else can hold.
 *
 * jsdom has no Web Audio, so every real call into `playbackService` finds no engine and
 * returns — meaning `VoicePane.test.tsx` passes whether the pane pushes its edits at the
 * engine or not. Delete `applyVoicePreset(next)` from `commit` and that whole file stays
 * green. These are module exports, though, so mocking the module turns "every knob edit
 * … calls the seam so it is audible on the next note" into an assertion.
 *
 * Split into its own file because `vi.mock` is hoisted above the imports and applies to
 * the whole module graph — the other file needs the real service.
 *
 * WHICH call is right is the part worth pinning, not merely that one happened. An edit
 * and a *selection* take different paths on purpose: pushing a newly resolved preset
 * through `applyVoicePreset` would pin it as an unsaved working copy and shadow the
 * store, so a later Save against the same shared variant would never reach the engine.
 */
vi.mock('../src/audio/playbackService', () => ({
  applyVoicePreset: vi.fn(),
  refreshVoice: vi.fn(),
  auditionVoice: vi.fn(() => Promise.resolve()),
  warmVoice: vi.fn(() => Promise.resolve()),
}));

function Host() {
  const [working, setWorking] = useState<WorkingVoice | null>(null);
  const [openSections, setOpenSections] = useState<readonly SectionId[]>(['amp', 'cabinet']);
  return (
    <VoicePane
      working={working}
      onWorkingChange={setWorking}
      openSections={openSections}
      onOpenSectionsChange={setOpenSections}
    />
  );
}

const applied = vi.mocked(applyVoicePreset);
const refreshed = vi.mocked(refreshVoice);
const warmed = vi.mocked(warmVoice);

beforeEach(() => {
  vi.clearAllMocks();
  useFretworkStore.getState().setInstrumentId('guitar');
  useVoiceStore.getState().reset();
  openBlankPattern('Voice audio test');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VoicePane → playbackService', () => {
  it('pushes every knob edit at the live voice', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Add Amp' }));

    // The branch creation is itself an edit and has to land.
    expect(applied).toHaveBeenCalledTimes(1);
    expect(applied.mock.calls[0][0]).toMatchObject({ effects: { amp: { preDrive: 0.3 } } });

    // Drive is a knob now, not a range input: `End` drives it to its declared max.
    fireEvent.keyDown(screen.getByLabelText('Drive'), { key: 'End' });
    expect(applied).toHaveBeenCalledTimes(2);
    expect(applied.mock.calls[1][0]).toMatchObject({ effects: { amp: { preDrive: 1 } } });
    // What is pushed is what the pane holds, never a round-trip through `voice.preset` —
    // see LIB-GAP(9b) on why the caller's copy is the only trustworthy one.
    expect(refreshed).not.toHaveBeenCalled();
  });

  it('removing a stage is an edit too, not a rebuild', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Add Amp' }));
    applied.mockClear();

    await userEvent.click(screen.getByRole('button', { name: 'Remove Amp' }));
    expect(applied).toHaveBeenCalledTimes(1);
    expect(applied.mock.calls[0][0]).not.toBeNull();
    expect(applied.mock.calls[0][0]?.effects?.amp).toBeUndefined();
  });

  it('refreshes rather than applies when the voice or instrument changes', async () => {
    render(<Host />);

    await userEvent.selectOptions(screen.getByLabelText('Voice'), 'default:electric-guitar');
    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(applied).not.toHaveBeenCalled();

    await userEvent.selectOptions(screen.getByLabelText('Instrument'), 'bass');
    expect(refreshed).toHaveBeenCalledTimes(2);
    expect(applied).not.toHaveBeenCalled();
  });

  it('retires the working copy from the engine on Save and on Save as…', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Save as…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    // The store now holds it, so the engine's tagged copy has to go — otherwise a later
    // Save against the same shared variant never reaches the engine.
    expect(applied).toHaveBeenLastCalledWith(null);

    await userEvent.click(screen.getByRole('button', { name: 'Add Amp' }));
    expect(applied).toHaveBeenLastCalledWith(expect.objectContaining({ effects: expect.anything() }));

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(applied).toHaveBeenLastCalledWith(null);
  });

  it('drops the engine’s copy too when the pane retires a stale one', async () => {
    // `playbackService`'s tagged copy self-clears only when something *consults* it, and
    // nothing in that effect does. Clearing only the pane's leaves the engine playing an
    // abandoned edit while the pane reports "Saved".
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Add Amp' }));
    applied.mockClear();

    act(() => openBlankPattern('Somewhere else'));

    expect(applied).toHaveBeenCalledWith(null);
  });

  it('deletes through the seam and re-resolves the voice', async () => {
    vi.stubGlobal('confirm', () => true);
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Save as…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    refreshed.mockClear();

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    // The ref is gone, so what plays now is whatever the instrument resolves to — which
    // only `refreshVoice` can make audible without pinning a working copy.
    expect(refreshed).toHaveBeenCalledTimes(1);
  });

  it('warms the voice on every hover, because the voice underneath changes', async () => {
    // LIB-GAP(3d): nothing can await the sampler, so hovering is the only pre-roll the
    // first audition gets. A once-per-mount guard makes every voice after the first
    // audition cold — the exact failure the warm exists to prevent.
    render(<Host />);
    const audition = screen.getByRole('button', { name: 'Audition' });

    await userEvent.hover(audition);
    expect(warmed).toHaveBeenCalledTimes(1);

    await userEvent.selectOptions(screen.getByLabelText('Voice'), 'default:electric-guitar');
    await userEvent.unhover(audition);
    await userEvent.hover(audition);
    expect(warmed).toHaveBeenCalledTimes(2);
  });
});
