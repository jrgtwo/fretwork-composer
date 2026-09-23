import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useFretworkStore, useVoiceStore, type VoicePreset } from '@fretwork/lib';
import { VoicePane } from '../src/voice/VoicePane';
import type { SectionId } from '../src/voice/paramSchema';
import { getEditingPattern, openBlankPattern } from '../src/patterns/patternService';
import { refreshVoice } from '../src/audio/playbackService';
import {
  clearVoiceDrafts,
  readVoiceDraft,
  subscribeVoiceDrafts,
} from '../src/voice/voiceDrafts';
import type { HolderKind } from '../src/voice/voiceService';

/**
 * The pane → engine seam, which nothing else can hold.
 *
 * ⚠ THE SEAM MOVED, and this file is the record of it. The pane used to push each edit
 * at `playbackService`, which kept its own tagged mirror of it; now the edit
 * goes into `voice/voiceDrafts` and the DRAFT STORE notifies the engine — one copy, and
 * `playbackService` subscribes to it at module scope. So what has to be pinned is the
 * NOTIFICATION: an edit that reaches the store without notifying is a control the engine
 * never hears, and jsdom has no Web Audio to catch it.
 *
 * Every real call into `playbackService` finds no engine and returns, which means
 * `VoicePane.test.tsx` passes whether or not a write ever reaches the engine. Here the
 * store's own listener is the instrument: it records the preset the store held at the
 * moment it told the engine, which is exactly what `playbackService` reads.
 *
 * Split into its own file because `vi.mock` is hoisted above the imports and applies to
 * the whole module graph — the other file needs the real service.
 *
 * WHICH call is right is still the part worth pinning, not merely that one happened. An
 * edit and a *selection* take different paths on purpose: recording a newly resolved
 * preset as a draft would shadow the store, so a later Save against the same shared
 * variant would never reach the engine. A selection therefore notifies nothing and calls
 * `refreshVoice`.
 */
vi.mock('../src/audio/playbackService', () => ({
  refreshVoice: vi.fn(),
}));

function Host() {
  // `undefined` rather than a list: nobody has folded anything yet, which is the
  // state `App` starts in and is NOT the same as an empty list (every stage open,
  // and the user said so). The pane opens on the schema's default either way.
  const [collapsed, setCollapsed] = useState<readonly SectionId[] | undefined>(undefined);
  return <VoicePane collapsedSections={collapsed} onCollapsedSectionsChange={setCollapsed} />;
}

const refreshed = vi.mocked(refreshVoice);

/** Every notification the draft store made, with the preset it was holding when it made
 *  it — `null` for a discard, which is what puts the live voice back on the store. */
const notified: Array<{ kind: HolderKind; id: string; preset: VoicePreset | null }> = [];
let unsubscribe: () => void = () => {};

/** Just the presets, in order — the shape the engine's subscriber sees. */
const pushed = () => notified.map((entry) => entry.preset);

beforeEach(() => {
  vi.clearAllMocks();
  notified.length = 0;
  clearVoiceDrafts();
  unsubscribe = subscribeVoiceDrafts((kind, id) => {
    notified.push({ kind, id, preset: readVoiceDraft(kind, id) });
  });
  useFretworkStore.getState().setInstrumentId('guitar');
  useVoiceStore.getState().reset();
  openBlankPattern('Voice audio test');
});

afterEach(() => {
  unsubscribe();
  vi.unstubAllGlobals();
});


describe('VoicePane → the draft store → playbackService', () => {
  it('pushes every knob edit at the live voice', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Add Amp (circuit)' }));

    // The branch creation is itself an edit and has to land.
    expect(pushed()).toHaveLength(1);
    expect(pushed()[0]).toMatchObject({
      effects: { circuitAmp: { controls: { tone: 0.5 } } },
    });

    // Tone is a knob, not a range input: `End` drives it to its declared max.
    // Scoped to the stage, because the amp's Volume and the IN/OUT bar's share a name.
    // "Amp (circuit) Tone", not "Tone": the plate scopes its knobs by the stage
    // (`renderAmp`'s `nameScope`), because the amp's own Volume and Input gain are
    // word-for-word the IN/OUT bar's two.
    fireEvent.keyDown(screen.getByLabelText('Amp (circuit) Tone'), { key: 'End' });
    expect(pushed()).toHaveLength(2);
    expect(pushed()[1]).toMatchObject({ effects: { circuitAmp: { controls: { tone: 1 } } } });
    // What is pushed is what the pane holds, never a round-trip through `voice.preset` —
    // see LIB-GAP(9b) on why the caller's copy is the only trustworthy one.
    expect(refreshed).not.toHaveBeenCalled();
  });

  it('removing a stage is an edit too, not a rebuild', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Add Amp (circuit)' }));
    notified.length = 0;

    await userEvent.click(screen.getByRole('button', { name: 'Remove Amp (circuit)' }));
    expect(pushed()).toHaveLength(1);
    expect(pushed()[0]).not.toBeNull();
    expect(pushed()[0]?.effects?.circuitAmp).toBeUndefined();
  });

  // REMOVED 2026-09-01, see docs/HANDOFF.md — picked a shipped voice by id to test
  // something unrelated to which voice it was.

  it('retires the draft on Save and on Save as…, and re-resolves after the repoint', async () => {
    render(<Host />);
    // Save as… can be pressed with nothing unsaved, and it still REPOINTS the pattern at
    // the new variant — so the engine has to be told even when there is no draft to
    // retire. That is `refreshVoice`, the selection path.
    await userEvent.click(screen.getByRole('button', { name: 'Save as…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(pushed()).toHaveLength(0);
    expect(refreshed).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Add Amp (circuit)' }));
    expect(pushed().at(-1)).toEqual(expect.objectContaining({ effects: expect.anything() }));

    // The store now holds it, so the draft has to go — otherwise a later Save against
    // the same shared variant never reaches the engine, and the rack reads "Unsaved"
    // against a voice that already matches it. `null` is the discard.
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(pushed().at(-1)).toBeNull();

    // And once more with an edit standing when Save as… is pressed.
    await userEvent.click(screen.getByRole('button', { name: 'Remove Amp (circuit)' }));
    refreshed.mockClear();
    await userEvent.click(screen.getByRole('button', { name: 'Save as…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(pushed().at(-1)).toBeNull();
    expect(refreshed).toHaveBeenCalledTimes(1);
  });

  it('strands nothing — and tells the engine nothing — when another pattern opens', async () => {
    // THE BEHAVIOUR CHANGE, pinned from the engine's side. There used to be one working
    // copy for whatever pattern was open, so a switch had to retire it and tell the
    // engine to go back — hence a confirmation in front of every switch. The draft is
    // keyed `pattern:<id>` now, so a switch strands nothing: there is nothing to discard
    // and nothing to push, and the first pattern's tone is still there on the way back.
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Add Amp (circuit)' }));
    const first = getEditingPattern()?.id;
    notified.length = 0;

    act(() => {
      openBlankPattern('Somewhere else');
    });

    expect(notified).toHaveLength(0);
    expect(readVoiceDraft('pattern', first ?? '')?.effects?.circuitAmp).toBeDefined();
    // …and the pattern that just opened is on its stored voice, not the other's edit.
    expect(readVoiceDraft('pattern', getEditingPattern()?.id ?? '')).toBeNull();
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
    // in today's write path, but nothing pins that — stop notifying from the store and
    // the whole Source panel goes silent while every assertion over there still passes. A control that writes a value nothing listens to is invisible from
    // the store's side.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve()));
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Source' }));

    await userEvent.selectOptions(screen.getByLabelText('Source'), 'fm-synth');

    expect(pushed()).toHaveLength(1);
    const swapped = pushed()[0];
    // The WHOLE branch, not the discriminant: `source.kind = 'fm-synth'` beside a
    // sampler's `samples` matches no arm of `VoiceSource`, and it is `Voice` — reached
    // only through this seam — that would read `params` off it and get `undefined`.
    expect(swapped?.source.kind).toBe('fm-synth');
    expect(Object.keys(swapped?.source ?? {}).sort()).toEqual(['kind', 'params']);

    // And an ordinary row inside the new source travels the same way.
    fireEvent.keyDown(screen.getByRole('spinbutton', { name: 'Harmonicity' }), { key: 'ArrowUp' });
    expect(pushed()).toHaveLength(2);
    const turned = pushed()[1];
    expect(turned?.source.kind).toBe('fm-synth');
    if (turned?.source.kind !== 'fm-synth') throw new Error('unreachable');
    expect(turned.source.params.harmonicity).toBeCloseTo(3.05, 6);
  });

  it('hands an added, re-kinded and removed second source to the engine', async () => {
    // ⚠ THREE MORE WRITES THAT ARE NOT `setAtPath`, on the same footing as the
    // source swap above: `addSubBranch` writes `sub.seed(preset)`,
    // `removeSubBranch` calls `removeAtPath`, and the layer's picker routes
    // through `withLayerSourceKind`. All three go through the draft store's own
    // `commit` today, and nothing but this pins that — stop notifying and the second
    // source becomes a panel that edits a preset the engine never hears, with
    // every assertion in `VoicePane.test.tsx` still green.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve()));
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Source' }));

    await userEvent.click(screen.getByRole('button', { name: 'Add Second source' }));
    expect(pushed()).toHaveLength(1);
    const seeded = pushed()[0];
    // The whole `VoiceLayer`, because `Voice.updateLayer` builds from it directly.
    expect(seeded?.layer?.source.kind).toBe('fm-synth');
    expect(seeded?.layer?.source).toHaveProperty('params.harmonicity');
    expect(typeof seeded?.layer?.gainDb).toBe('number');

    await userEvent.selectOptions(
      screen.getByLabelText('Second source Source'),
      'pluck-synth',
    );
    expect(pushed()).toHaveLength(2);
    const rekinded = pushed()[1];
    expect(rekinded?.layer?.source.kind).toBe('pluck-synth');
    // The whole arm was replaced, and the PRIMARY is untouched — the mis-route
    // this picker's own write exists to prevent, asserted on what the engine gets.
    expect(rekinded?.layer?.source).toHaveProperty('params.attackNoise');
    expect(rekinded?.source.kind).toBe('sampler');

    await userEvent.click(screen.getByRole('button', { name: 'Remove Second source' }));
    expect(pushed()).toHaveLength(3);
    const stripped = pushed()[2];
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

    expect(pushed()).toHaveLength(2);
    const withEnvelope = pushed()[1];
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
    expect(pushed()).toHaveLength(3);
    const stripped = pushed()[2];
    expect(stripped?.bodyFilter?.envelope).toBeUndefined();
    // The filter itself survives its envelope — `removeAtPath` prunes an emptied
    // parent, and this one still holds a cutoff and a q.
    expect(stripped?.bodyFilter?.cutoff).toBeGreaterThan(0);
  });

  // REMOVED 2026-09-01, see docs/HANDOFF.md — same reason: it switched to a shipped
  // voice by id purely to make the voice underneath change.
  it('pushes a pedal at the engine the moment it is added or removed', async () => {
    // A pedal is a CHAIN-SHAPE change, not a value change — `Voice.updateEffects`
    // compares `sameEffectsShape` and rebuilds the graph rather than retuning a
    // node — so an add that never reaches the seam is a board with a pedal drawn
    // on it and nothing in the signal path. jsdom cannot hear that, and no
    // assertion in `VoicePane.test.tsx` would notice.
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Pedals' }));

    await userEvent.click(screen.getByRole('button', { name: 'Add Distortion' }));
    expect(pushed()).toHaveLength(1);
    expect(pushed()[0]?.effects?.distortion?.drive).toBe(0.4);

    await userEvent.click(screen.getByRole('button', { name: 'Remove Distortion' }));
    expect(pushed()).toHaveLength(2);
    expect(pushed()[1]?.effects?.distortion).toBeUndefined();
  });

});
