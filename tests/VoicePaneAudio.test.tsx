import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useFretworkStore, useVoiceStore } from '@fretwork/lib';
import { VoicePane, type WorkingVoice } from '../src/voice/VoicePane';
import type { SectionId } from '../src/voice/paramSchema';
import { openBlankPattern } from '../src/patterns/patternService';
import { applyVoicePreset, refreshVoice } from '../src/audio/playbackService';

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

  // REMOVED 2026-09-01, see docs/HANDOFF.md — picked a shipped voice by id to test
  // something unrelated to which voice it was.

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

  it('hands the swapped source to the engine, not just to the working copy', async () => {
    // The brief's own requirement, and the one `VoicePane.test.tsx` structurally cannot
    // meet: it asserts the object given to `onWorkingChange`. Those are the same object
    // in today's `commit`, but nothing pins that — delete `applyVoicePreset(next)` from
    // `commit` and the whole Source panel goes silent while every assertion over there
    // still passes. A control that writes a value nothing listens to is invisible from
    // the store's side.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve()));
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Source' }));

    await userEvent.selectOptions(screen.getByLabelText('Source'), 'fm-synth');

    expect(applied).toHaveBeenCalledTimes(1);
    const pushed = applied.mock.calls[0][0];
    // The WHOLE branch, not the discriminant: `source.kind = 'fm-synth'` beside a
    // sampler's `samples` matches no arm of `VoiceSource`, and it is `Voice` — reached
    // only through this seam — that would read `params` off it and get `undefined`.
    expect(pushed?.source.kind).toBe('fm-synth');
    expect(Object.keys(pushed?.source ?? {}).sort()).toEqual(['kind', 'params']);

    // And an ordinary row inside the new source travels the same way.
    fireEvent.keyDown(screen.getByRole('spinbutton', { name: 'Harmonicity' }), { key: 'ArrowUp' });
    expect(applied).toHaveBeenCalledTimes(2);
    const turned = applied.mock.calls[1][0];
    expect(turned?.source.kind).toBe('fm-synth');
    if (turned?.source.kind !== 'fm-synth') throw new Error('unreachable');
    expect(turned.source.params.harmonicity).toBeCloseTo(3.05, 6);
  });

  it('hands an added, re-kinded and removed second source to the engine', async () => {
    // ⚠ THREE MORE WRITES THAT ARE NOT `setAtPath`, on the same footing as the
    // source swap above: `addSubBranch` writes `sub.seed(preset)`,
    // `removeSubBranch` calls `removeAtPath`, and the layer's picker routes
    // through `withLayerSourceKind`. All three go through `commit` today, and
    // nothing but this pins that — delete `applyVoicePreset(next)` and the second
    // source becomes a panel that edits a preset the engine never hears, with
    // every assertion in `VoicePane.test.tsx` still green.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve()));
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Source' }));

    await userEvent.click(screen.getByRole('button', { name: 'Add Second source' }));
    expect(applied).toHaveBeenCalledTimes(1);
    const seeded = applied.mock.calls[0][0];
    // The whole `VoiceLayer`, because `Voice.updateLayer` builds from it directly.
    expect(seeded?.layer?.source.kind).toBe('fm-synth');
    expect(seeded?.layer?.source).toHaveProperty('params.harmonicity');
    expect(typeof seeded?.layer?.gainDb).toBe('number');

    await userEvent.selectOptions(
      screen.getByLabelText('Second source Source'),
      'pluck-synth',
    );
    expect(applied).toHaveBeenCalledTimes(2);
    const rekinded = applied.mock.calls[1][0];
    expect(rekinded?.layer?.source.kind).toBe('pluck-synth');
    // The whole arm was replaced, and the PRIMARY is untouched — the mis-route
    // this picker's own write exists to prevent, asserted on what the engine gets.
    expect(rekinded?.layer?.source).toHaveProperty('params.attackNoise');
    expect(rekinded?.source.kind).toBe('sampler');

    await userEvent.click(screen.getByRole('button', { name: 'Remove Second source' }));
    expect(applied).toHaveBeenCalledTimes(3);
    const stripped = applied.mock.calls[2][0];
    // Absent, not hollow: `Voice.updateLayer` disposes the layer only when the
    // branch is really gone, and `{}` would have it build from `undefined`.
    expect(stripped?.layer).toBeUndefined();
    expect(Object.hasOwn(stripped ?? {}, 'layer')).toBe(false);
  });

  it('hands an added and removed body filter envelope to the engine', async () => {
    // `Voice.updateBodyFilter` rebuilds the chain when the envelope appears or
    // goes — the node enters and leaves the signal path — so both gestures have to
    // reach the seam, not merely the working copy.
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Body filter' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add Body filter' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add Cutoff envelope' }));

    expect(applied).toHaveBeenCalledTimes(2);
    const withEnvelope = applied.mock.calls[1][0];
    // All six fields, because `buildChain` reads every one off it.
    expect(Object.keys(withEnvelope?.bodyFilter?.envelope ?? {}).sort()).toEqual([
      'attack',
      'baseFrequency',
      'decay',
      'octaves',
      'release',
      'sustain',
    ]);

    await userEvent.click(screen.getByRole('button', { name: 'Remove Cutoff envelope' }));
    expect(applied).toHaveBeenCalledTimes(3);
    const stripped = applied.mock.calls[2][0];
    expect(stripped?.bodyFilter?.envelope).toBeUndefined();
    // The filter itself survives its envelope — `removeAtPath` prunes an emptied
    // parent, and this one still holds a cutoff and a q.
    expect(stripped?.bodyFilter?.cutoff).toBeGreaterThan(0);
  });

  // REMOVED 2026-09-01, see docs/HANDOFF.md — same reason: it switched to a shipped
  // voice by id purely to make the voice underneath change.
});
