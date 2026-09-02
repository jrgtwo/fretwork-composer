import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import {
  CABINET_IRS,
  SAMPLE_PACKS,
  audioNow,
  detectSamplePack,
  getDefaultPresetForSlot,
  usePatternsStore,
  useVoiceStore,
  type SamplePack,
  type VoicePreset,
} from '@fretwork/lib';
import { getEditingPattern, openBlankPattern } from '../patterns/patternService';
import {
  deleteVoice,
  getEditingVoicePreset,
  listSelectableVoices,
  parseVoiceKey,
  readVoiceRef,
  renameVoice,
  saveVoice,
  saveVoiceAs,
  selectVoice,
  useEditingVoicePreset,
  useEditingVoiceRef,
  useSelectableVoices,
  voiceKey,
} from './voiceService';
import {
  applyVoicePreset,
  auditionVoice,
  previewNote,
  refreshVoice,
  usePlaybackEngine,
  warmVoice,
} from '../audio/playbackService';

/**
 * Two seams in one file, because the second is only meaningful about the first:
 * `voiceService` decides *which* preset a pattern plays, and `playbackService`'s edit
 * classification decides whether a change to that preset can be pushed onto a live
 * `Voice` or needs a new one. A mistake in the classification is silent — no error, no
 * warning, just an inaudible edit or a disposed voice still wired to the scheduler —
 * so it is pinned here rather than left to the ear.
 *
 * `useVoiceStore` is the REAL store, not a stand-in. It is a plain zustand store with
 * a `reset()` action and a sessionStorage cache, so it works under jsdom — and using
 * it means `resolveActiveVoice` resolves for real, which a mock could not achieve
 * anyway: it reaches the store through its own module import, not through ours. Where
 * a test has to prove an action was *not* taken, it spies on the live action instead
 * of replacing the store wholesale.
 *
 * The audio surface is the part that cannot be real: jsdom has no Web Audio. The fakes
 * below stand in for exactly the slice `playbackService` touches, and each records the
 * preset it was constructed with — which is how "rebuilt" is told from "retuned".
 */
const audio = vi.hoisted(() => {
  class FakeVoice {
    static instances: FakeVoice[] = [];
    readonly ensureBuilt = vi.fn();
    /** Mirrors `Voice.ready()` — builds, then resolves once the buffers are decoded. */
    readonly ready = vi.fn(async () => {
      this.ensureBuilt();
    });
    readonly dispose = vi.fn();
    readonly swapPreset = vi.fn();
    readonly play = vi.fn();
    constructor(readonly preset: unknown) {
      FakeVoice.instances.push(this);
    }
  }

  class FakeScheduler {
    static instances: FakeScheduler[] = [];
    readonly setInstrument = vi.fn();
    readonly setStream = vi.fn();
    readonly setLoop = vi.fn();
    readonly previewCell = vi.fn();
    readonly dispose = vi.fn();
    constructor(readonly opts: unknown) {
      FakeScheduler.instances.push(this);
    }
    onHead() {
      return () => {};
    }
    onActive() {
      return () => {};
    }
    onComplete() {
      return () => {};
    }
  }

  return {
    FakeVoice,
    FakeScheduler,
    metronome: { start: vi.fn(async () => {}), stop: vi.fn() },
    startAudio: vi.fn(async () => {}),
    warmup: vi.fn(async () => {}),
    reset() {
      FakeVoice.instances.length = 0;
      FakeScheduler.instances.length = 0;
      vi.clearAllMocks();
    },
  };
});

vi.mock('@fretwork/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fretwork/lib')>();
  return {
    ...actual,
    startAudio: audio.startAudio,
    useMetronome: () => ({ metronome: audio.metronome }),
    EventScheduler: audio.FakeScheduler,
    Voice: audio.FakeVoice,
    // Faithful rather than stubbed to a constant: `voiceKeyOf` fingerprints the
    // *resolved* preset's source, so the real resolver has to run or the rebuild tests
    // would be asserting against a preset shape nobody ships.
    buildEffectiveVoice: (
      instrumentId: Parameters<typeof actual.buildEffectiveVoice>[0],
      options?: Parameters<typeof actual.buildEffectiveVoice>[1],
    ) => {
      const preset = actual.resolveActiveVoice(instrumentId, options?.voiceRef ?? null);
      return { voice: new audio.FakeVoice(preset), preset };
    },
    PatternSource: class {
      constructor(readonly pattern: unknown) {}
    },
    // Only `warmup` is reached, and only from the audition path.
    MasterBus: { warmup: audio.warmup },
  };
});

type FakeVoiceInstance = InstanceType<typeof audio.FakeVoice>;
type FakeSchedulerInstance = InstanceType<typeof audio.FakeScheduler>;

function EngineProbe() {
  usePlaybackEngine();
  return null;
}

const builtVoices = () => audio.FakeVoice.instances;
const lastVoice = () => builtVoices().at(-1)!;

/**
 * Bring an engine up and hand back what it built.
 *
 * An engine exists only once something has asked for a sound; `previewNote` is the
 * cheapest such ask and doesn't touch the transport. The instance list is then emptied
 * so every `builtVoices()` assertion afterwards counts voices built by the edit under
 * test, not by the setup.
 */
function startEngine(): { voice: FakeVoiceInstance; scheduler: FakeSchedulerInstance } {
  render(createElement(EngineProbe));
  act(() => previewNote(0, 0));
  const voice = lastVoice();
  const scheduler = audio.FakeScheduler.instances.at(-1)!;
  builtVoices().length = 0;
  return { voice, scheduler };
}

const editingPreset = (): VoicePreset => {
  const preset = getEditingVoicePreset();
  if (!preset) throw new Error('no editing pattern');
  return preset;
};

/** A registered pack the preset is not already using, so a pack-change test cannot
 *  quietly assert a no-op. `empty` is skipped: its bank is `{}`, which is a legitimate
 *  choice in the lab but a poor stand-in for "a different pack". */
function otherSamplePack(preset: VoicePreset): SamplePack {
  if (preset.source.kind !== 'sampler') throw new Error('expected a sampler preset');
  const current = detectSamplePack(preset.source.samples);
  const pack = SAMPLE_PACKS.find(
    (candidate) => candidate.id !== current?.id && candidate.id !== 'empty',
  );
  if (!pack) throw new Error('need a second registered sample pack');
  return pack;
}

/**
 * A rebuild is coalesced (`REBUILD_COALESCE_MS` in `playbackService`), so every rebuild
 * assertion has to run the timer. In-place edits stay synchronous, which is itself part
 * of the contract — a knob has to reach the audio graph while the finger is still down.
 */
const flushRebuild = () =>
  act(() => {
    vi.runAllTimers();
  });

beforeEach(() => {
  // Fake for the whole file so nothing accidentally depends on real-time coalescing.
  // Safe alongside the async audition tests: those await promises, not timers.
  vi.useFakeTimers();
  audio.reset();
  useVoiceStore.getState().reset();
  sessionStorage.clear();
  openBlankPattern('Voice test');
  // `playbackService` holds the editor's working preset at module scope, so it would
  // otherwise survive between tests. Discarding it is a first-class action — the
  // editor closing does exactly this — so no test-only reset is needed.
  applyVoicePreset(null);
});

afterEach(() => {
  useVoiceStore.getState().reset();
  vi.useRealTimers();
});

// ------------------------------------------------------------------ listing ---

describe('listSelectableVoices', () => {
  // REMOVED 2026-09-01, see docs/HANDOFF.md — two tests that asserted the picker's
  // offer against the lib's slot registry by count and by exact list. Withdrawing
  // one voice broke both for a reason that was not a defect.

  it('filters user variants to the instrument they were saved for', () => {
    saveVoiceAs('Guitar variant', editingPreset());
    // Written straight to the store: `saveVoiceAs` cannot create a bass variant while a
    // guitar pattern is open, which is exactly the behaviour being relied on.
    useVoiceStore.getState().addVariant({
      name: 'Bass variant',
      instrumentId: 'bass',
      family: 'electric',
      collectionId: null,
      preset: getDefaultPresetForSlot('electric-bass'),
    });

    expect(listSelectableVoices('guitar').userVariants.map((o) => o.name)).toEqual([
      'Guitar variant',
    ]);
    expect(listSelectableVoices('bass').userVariants.map((o) => o.name)).toEqual(['Bass variant']);
    expect(listSelectableVoices('ukulele').userVariants).toEqual([]);
  });

  it('flags user variants as not built-in, so a pane can tell what Save applies to', () => {
    saveVoiceAs('Mine', editingPreset());
    expect(listSelectableVoices('guitar').userVariants[0].builtIn).toBe(false);
  });
});

describe('voiceKey', () => {
  it('round-trips every offered option', () => {
    const options = (['guitar', 'bass', 'ukulele'] as const).flatMap(
      (instrument) => listSelectableVoices(instrument).builtIns,
    );
    for (const option of options) {
      expect(parseVoiceKey(option.key)).toEqual(option.ref);
    }
    expect(parseVoiceKey(voiceKey({ kind: 'user', id: 'abc' }))).toEqual({
      kind: 'user',
      id: 'abc',
    });
  });

  it('rejects a slot the lib does not know', () => {
    // An unknown slot id resolves to the instrument's first default, so accepting one
    // would leave the picker showing a selection that plays something else entirely.
    // `test-clean-amp` is a real renamed id — the lib ships a migration map for it.
    expect(parseVoiceKey('default:test-clean-amp')).toBeNull();
    expect(parseVoiceKey('default:')).toBeNull();
    expect(parseVoiceKey('acoustic-guitar')).toBeNull();
    expect(parseVoiceKey('other:acoustic-guitar')).toBeNull();
  });

  it('keeps a colon inside a variant id', () => {
    expect(parseVoiceKey('user:a:b')).toEqual({ kind: 'user', id: 'a:b' });
  });
});

// ------------------------------------------------------------------- hooks ---
// The reactive reads, which can only fail at render time. `useEditingVoicePreset` is the
// one with teeth: it hand-rolls a `useVoiceStore` selector that ignores its state
// argument, so it is correct only while every resolution returns a reference-stable
// object (a `VOICE_PRESETS` const, or the stored `variant.preset`). Should either ever
// start spreading, zustand's `getSnapshot` yields a fresh object per render and the pane
// render-loops — which no non-rendering test would notice.

describe('the reactive reads', () => {
  it('report the editing pattern voice choice and follow a selection', () => {
    const { result, rerender } = renderHook(() => useEditingVoiceRef());
    expect(result.current).toBeNull();

    act(() => selectVoice({ kind: 'default', slotId: 'surf-amp' }));
    rerender();

    expect(result.current).toEqual({ kind: 'default', slotId: 'surf-amp' });
  });

  it('resolve a preset stably across renders, and re-resolve when the store changes', () => {
    const saved = saveVoiceAs('Mine', getDefaultPresetForSlot('surf-amp'));
    if (!saved.ok) throw new Error(saved.reason);

    const { result, rerender } = renderHook(() => useEditingVoicePreset());
    const first = result.current;
    expect(first).toBe(useVoiceStore.getState().variants[0].preset);

    // Identity, not equality: an unstable snapshot is a render loop, not a failed
    // assertion, so this is the property worth pinning.
    rerender();
    expect(result.current).toBe(first);

    const edited = { ...first!, level: { volumeDb: -15, pan: 0 } };
    act(() => {
      saveVoice(edited);
    });

    // `resolveActiveVoice` is a plain function over the store, so subscribing through
    // `useVoiceStore` is the only thing that makes an edit reach a pane at all.
    expect(result.current).toBe(edited);
  });

  it('list what can be picked, memoised, and follow a new variant', () => {
    const { result, rerender } = renderHook(() => useSelectableVoices('guitar'));
    expect(result.current.builtIns).toEqual(listSelectableVoices('guitar').builtIns);
    expect(result.current.userVariants).toEqual([]);

    const first = result.current;
    rerender();
    expect(result.current).toBe(first);

    act(() => {
      saveVoiceAs('Mine', getDefaultPresetForSlot('surf-amp'));
    });

    expect(result.current.userVariants.map((option) => option.name)).toEqual(['Mine']);
  });
});

// --------------------------------------------------------------- resolution ---

describe('readVoiceRef', () => {
  it('reads a valid ref back as the stored object', () => {
    selectVoice({ kind: 'default', slotId: 'metal-amp' });
    const pattern = getEditingPattern()!;

    // Identity, not equality: callers memoise on this, and a fresh object per call
    // would invalidate every one of them on every render.
    expect(readVoiceRef(pattern)).toBe(pattern.voiceRef);
  });

  it('reads anything malformed as no choice at all', () => {
    const pattern = getEditingPattern()!;
    const withRef = (voiceRef: unknown) => ({ ...pattern, voiceRef });

    expect(readVoiceRef(withRef(null))).toBeNull();
    expect(readVoiceRef(withRef('acoustic-guitar'))).toBeNull();
    expect(readVoiceRef(withRef({ kind: 'user' }))).toBeNull();
    expect(readVoiceRef(withRef({ kind: 'user', id: '' }))).toBeNull();
    expect(readVoiceRef(withRef({ kind: 'default' }))).toBeNull();
    expect(readVoiceRef(withRef({ kind: 'default', slotId: 'test-clean-amp' }))).toBeNull();
  });
});

describe('resolution', () => {
  it("falls back to the instrument's active voice when the pattern has none", () => {
    expect(getEditingPattern()!.voiceRef ?? null).toBeNull();
    expect(editingPreset()).toBe(getDefaultPresetForSlot('acoustic-guitar'));
  });

  it("honours the pattern's own choice over the instrument default", () => {
    selectVoice({ kind: 'default', slotId: 'metal-amp' });
    expect(editingPreset()).toBe(getDefaultPresetForSlot('metal-amp'));
  });

  it("resolves a user ref to that variant's preset", () => {
    expect(saveVoiceAs('Mine', getDefaultPresetForSlot('surf-amp')).ok).toBe(true);
    expect(editingPreset()).toBe(useVoiceStore.getState().variants[0].preset);
  });

  it('falls through cleanly when the ref names a variant that is gone', () => {
    selectVoice({ kind: 'user', id: 'never-existed' });
    // The lib's own fall-through, deliberately not reimplemented on this side.
    expect(editingPreset()).toBe(getDefaultPresetForSlot('acoustic-guitar'));
  });
});

describe('selectVoice', () => {
  it("writes the pattern's ref and leaves the global default alone", () => {
    const before = useVoiceStore.getState().activeVariants;

    selectVoice({ kind: 'default', slotId: 'blues-amp' });

    expect(getEditingPattern()!.voiceRef).toEqual({ kind: 'default', slotId: 'blues-amp' });
    // `activeVariants` is the instrument-wide default shared by every pattern with no
    // explicit ref. Writing it from here would retune all of them.
    expect(useVoiceStore.getState().activeVariants).toBe(before);
  });
});

// ------------------------------------------------------------------ writing ---

describe('saveVoice', () => {
  it('refuses a built-in slot, and does not reach the store to do it', () => {
    selectVoice({ kind: 'default', slotId: 'crunch-amp' });
    // The guard has to be real rather than a disabled button: the fourteen slot presets
    // are readonly consts and `useVoiceStore` has no setter for them at all, so an
    // edit that got this far would look saved and be gone on the next reload.
    const updateVariant = vi.spyOn(useVoiceStore.getState(), 'updateVariant');

    const result = saveVoice({ ...getDefaultPresetForSlot('crunch-amp'), name: 'Hijacked' });

    expect(result).toEqual({ ok: false, reason: 'built-in' });
    expect(updateVariant).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().variants).toEqual([]);
    updateVariant.mockRestore();
  });

  it('refuses when the pattern has no explicit voice', () => {
    // It is playing the instrument's active voice — nothing addressable to write back
    // to, so this is Save-as territory.
    expect(saveVoice(editingPreset())).toEqual({ ok: false, reason: 'no-voice' });
  });

  it('refuses a ref whose variant is gone', () => {
    selectVoice({ kind: 'user', id: 'never-existed' });
    expect(saveVoice(editingPreset())).toEqual({ ok: false, reason: 'unknown-variant' });
  });

  it("writes the preset and keeps the record's name in step with it", () => {
    const saved = saveVoiceAs('Mine', editingPreset());
    if (!saved.ok) throw new Error(saved.reason);

    const edited: VoicePreset = {
      ...editingPreset(),
      name: 'Renamed in place',
      // The saved copy came from `acoustic-guitar`, so this is a real change of family —
      // the record has to follow it or the picker groups the voice under the old one.
      family: 'electric',
      level: { volumeDb: -6, pan: 0.5 },
    };
    expect(saveVoice(edited)).toEqual({ ok: true, id: saved.id });

    const [variant] = useVoiceStore.getState().variants;
    expect(variant.preset).toBe(edited);
    expect(variant.name).toBe('Renamed in place');
    // `family` too: the picker reads the record, Save-as reads the payload, and the two
    // disagreeing is the same bug as a name that doesn't match.
    expect(variant.family).toBe(edited.family);
  });

  it('changes the voice for every pattern pointing at it', () => {
    const saved = saveVoiceAs('Shared', editingPreset());
    if (!saved.ok) throw new Error(saved.reason);
    const ref = { kind: 'user', id: saved.id } as const;

    openBlankPattern('Second pattern');
    selectVoice(ref);
    saveVoice({ ...editingPreset(), level: { volumeDb: -12, pan: 0 } });

    // A voice is a shared asset — `pattern.voiceRef` is a reference, and editing the
    // variant is meant to reach every holder. Auto-forking a private copy per pattern
    // was considered and rejected.
    openBlankPattern('Third pattern');
    selectVoice(ref);
    expect(editingPreset().level.volumeDb).toBe(-12);
  });
});

describe('saveVoiceAs', () => {
  it("creates a root-level variant for the pattern's instrument", () => {
    const result = saveVoiceAs('  My tone  ', getDefaultPresetForSlot('lead-amp'));
    if (!result.ok) throw new Error(result.reason);

    const [variant] = useVoiceStore.getState().variants;
    expect(variant).toMatchObject({
      id: result.id,
      name: 'My tone',
      instrumentId: 'guitar',
      family: 'electric',
      // Folders are a later slice.
      collectionId: null,
    });
    // The record and its payload have to agree on both, or the picker offers a voice
    // that plays on another instrument's neck under a name nobody chose.
    expect(variant.preset.name).toBe('My tone');
    expect(variant.preset.instrumentId).toBe('guitar');
  });

  it('repoints the pattern at the copy', () => {
    const result = saveVoiceAs('My tone', getDefaultPresetForSlot('lead-amp'));
    if (!result.ok) throw new Error(result.reason);

    // Without this the pattern keeps playing the built-in it was taken from and the
    // saved variant sits unused — Save-as would appear to do nothing.
    expect(getEditingPattern()!.voiceRef).toEqual({ kind: 'user', id: result.id });
    expect(editingPreset()).toBe(useVoiceStore.getState().variants[0].preset);
  });

  it('leaves the built-in it was copied from untouched', () => {
    saveVoiceAs('My tone', getDefaultPresetForSlot('lead-amp'));
    saveVoice({ ...editingPreset(), level: { volumeDb: -20, pan: 0 } });

    expect(getDefaultPresetForSlot('lead-amp').level.volumeDb).not.toBe(-20);
  });

  it('refuses a blank name and creates nothing', () => {
    expect(saveVoiceAs('   ', editingPreset())).toEqual({ ok: false, reason: 'empty-name' });
    expect(useVoiceStore.getState().variants).toEqual([]);
    expect(getEditingPattern()!.voiceRef ?? null).toBeNull();
  });

  it("reports the tier cap and leaves the pattern's ref alone", () => {
    // `addVariant` returns '' when the lib's tier gate refuses (it has already opened its
    // own upgrade prompt). Repointing at `{kind:'user', id:''}` would read back through
    // `readVoiceRef` as *no choice at all* — a save the user was told happened, on a
    // pattern silently reverted to the instrument default.
    const addVariant = vi.spyOn(useVoiceStore.getState(), 'addVariant').mockReturnValue('');

    expect(saveVoiceAs('Capped', editingPreset())).toEqual({ ok: false, reason: 'capped' });
    expect(getEditingPattern()!.voiceRef ?? null).toBeNull();
    addVariant.mockRestore();
  });
});

describe('writing with nothing open', () => {
  it('refuses rather than throwing', () => {
    // A pane can be mid-unmount while the pattern is already closed; every one of these
    // has to be a refusal the caller can render, not an exception in a click handler.
    const preset = editingPreset();
    usePatternsStore.getState().openPatternForEditing(null);

    expect(saveVoice(preset)).toEqual({ ok: false, reason: 'no-pattern' });
    expect(saveVoiceAs('Mine', preset)).toEqual({ ok: false, reason: 'no-pattern' });
    expect(useVoiceStore.getState().variants).toEqual([]);
  });

  it("refuses a Save aimed at another instrument's variant", () => {
    // Reachable from persisted or hand-edited storage, and from any future
    // multi-instrument flow. The picker doesn't offer this variant here, so a Save that
    // landed would overwrite a voice the user cannot see from where they are standing.
    const id = useVoiceStore.getState().addVariant({
      name: 'Bass variant',
      instrumentId: 'bass',
      family: 'electric',
      collectionId: null,
      preset: getDefaultPresetForSlot('electric-bass'),
    });
    selectVoice({ kind: 'user', id });

    expect(saveVoice(getDefaultPresetForSlot('lead-amp'))).toEqual({
      ok: false,
      reason: 'unknown-variant',
    });
    expect(useVoiceStore.getState().variants[0].preset).toBe(
      getDefaultPresetForSlot('electric-bass'),
    );
  });
});

describe('renameVoice', () => {
  it('renames the record and its payload together', () => {
    const saved = saveVoiceAs('First', editingPreset());
    if (!saved.ok) throw new Error(saved.reason);

    expect(renameVoice(saved.id, '  Second  ')).toEqual({ ok: true, id: saved.id });

    const [variant] = useVoiceStore.getState().variants;
    expect(variant.name).toBe('Second');
    expect(variant.preset.name).toBe('Second');
  });

  it('survives the next Save', () => {
    const saved = saveVoiceAs('First', editingPreset());
    if (!saved.ok) throw new Error(saved.reason);
    renameVoice(saved.id, 'Second');

    // This is why the rename writes the payload too, instead of using the lib's
    // `renameVariant`: `saveVoice` writes the record's name back from `preset.name`,
    // so a record-only rename is reverted the moment the user touches a slider.
    saveVoice(editingPreset());

    expect(useVoiceStore.getState().variants[0].name).toBe('Second');
  });

  it('refuses a blank name or an unknown id', () => {
    const saved = saveVoiceAs('First', editingPreset());
    if (!saved.ok) throw new Error(saved.reason);

    expect(renameVoice(saved.id, '  ')).toEqual({ ok: false, reason: 'empty-name' });
    expect(renameVoice('never-existed', 'Whatever')).toEqual({
      ok: false,
      reason: 'unknown-variant',
    });
    expect(useVoiceStore.getState().variants[0].name).toBe('First');
  });
});

describe('deleteVoice', () => {
  it('removes the variant and clears the ref that pointed at it', () => {
    const saved = saveVoiceAs('Doomed', editingPreset());
    if (!saved.ok) throw new Error(saved.reason);

    expect(deleteVoice(saved.id)).toEqual({ ok: true, id: saved.id });

    expect(useVoiceStore.getState().variants).toEqual([]);
    // Left dangling, the ref would still resolve — silently, to the instrument's first
    // built-in — while the pane showed nothing selected.
    expect(getEditingPattern()!.voiceRef ?? null).toBeNull();
    expect(editingPreset()).toBe(getDefaultPresetForSlot('acoustic-guitar'));
  });

  it('leaves a ref that points somewhere else alone', () => {
    const keep = saveVoiceAs('Keep', editingPreset());
    const drop = saveVoiceAs('Drop', editingPreset());
    if (!keep.ok || !drop.ok) throw new Error('setup failed');
    selectVoice({ kind: 'user', id: keep.id });

    deleteVoice(drop.id);

    expect(getEditingPattern()!.voiceRef).toEqual({ kind: 'user', id: keep.id });
  });

  it('refuses an unknown id', () => {
    expect(deleteVoice('never-existed')).toEqual({ ok: false, reason: 'unknown-variant' });
  });
});

// ----------------------------------------------------- edit classification ---
// `Voice.swapPreset` retunes in place, except that it disposes itself on a source-KIND
// change (gap 9a) and never reconstructed sampler banks (gap 9b) — both fixed upstream,
// but the classification still routes rebuild-class edits so they can be coalesced. Source
// identity has to rebuild and everything else must not — and neither failure announces
// itself.

describe('applyVoicePreset', () => {
  it('retunes the live voice in place for a level or effects edit', () => {
    const { voice } = startEngine();
    const edited: VoicePreset = { ...editingPreset(), level: { volumeDb: -6, pan: 0.25 } };

    act(() => applyVoicePreset(edited));

    expect(voice.swapPreset).toHaveBeenCalledWith(edited);
    // No teardown and no sampler re-download — the only reason dragging a slider on a
    // live voice is viable at all.
    expect(builtVoices()).toHaveLength(0);
    expect(voice.dispose).not.toHaveBeenCalled();
    // Nor later: an in-place edit must not have queued a rebuild behind itself.
    flushRebuild();
    expect(builtVoices()).toHaveLength(0);
  });

  it('retunes the live voice in place for an amp or cabinet edit', () => {
    // This slice's headline controls. If the key ever hashed the whole preset instead of
    // the source, every amp knob would re-download the sampler — and nothing about that
    // failure is audible except the silence while it downloads.
    selectVoice({ kind: 'default', slotId: 'clean-amp' });
    const { voice } = startEngine();
    const base = editingPreset();
    const { amp } = base.effects ?? {};
    if (!amp) throw new Error('expected clean-amp to ship an amp');

    const edited: VoicePreset = {
      ...base,
      effects: {
        ...base.effects,
        amp: { ...amp, preDrive: amp.preDrive + 0.2 },
        // Adding a stage, not just retuning one: `clean-amp` ships no cabinet, and
        // `swapPreset` handles a chain-shape change itself (`_rebuildChain` keeps the
        // synth). Only the *source* needs a new `Voice`.
        cabIR: { enabled: true, url: CABINET_IRS[0].url },
      },
    };
    act(() => applyVoicePreset(edited));

    expect(voice.swapPreset).toHaveBeenCalledWith(edited);
    flushRebuild();
    expect(builtVoices()).toHaveLength(0);
    expect(voice.dispose).not.toHaveBeenCalled();
  });

  it('rebuilds the voice for a sample-pack change', () => {
    const { voice, scheduler } = startEngine();
    const base = editingPreset();
    if (base.source.kind !== 'sampler') throw new Error('expected a sampler preset');
    const pack = otherSamplePack(base);
    // Everything but the banks held constant, so this cannot pass on the back of an
    // incidental `release` difference — the banks have to be in the fingerprint.
    const edited: VoicePreset = { ...base, source: { ...base.source, samples: pack.samples } };

    act(() => applyVoicePreset(edited));
    flushRebuild();

    // `swapPreset` would have accepted this and changed nothing audible: the banks are
    // only ever constructed in `_ensureBuilt`.
    expect(voice.swapPreset).not.toHaveBeenCalled();
    expect(builtVoices()).toHaveLength(1);
    expect(lastVoice().preset).toBe(edited);
    expect(voice.dispose).toHaveBeenCalled();
    expect(scheduler.setInstrument).toHaveBeenCalledWith(lastVoice());
    // Without this the new banks download only at the next `play()`.
    expect(lastVoice().ensureBuilt).toHaveBeenCalled();
  });

  it('rebuilds the voice for a sampler release change', () => {
    const { voice } = startEngine();
    const base = editingPreset();
    const { source } = base;
    if (source.kind !== 'sampler') throw new Error('expected a sampler preset');

    act(() => applyVoicePreset({ ...base, source: { ...source, release: 3.5 } }));
    flushRebuild();

    // `release` is only read where the banks are built, so it is source identity too.
    expect(voice.swapPreset).not.toHaveBeenCalled();
    expect(builtVoices()).toHaveLength(1);
  });

  it('collapses a drag over a rebuild-class param into one build, of the last value', () => {
    // `source.release` is a *slider* with `rebuildsVoice: true`, so without coalescing one
    // drag is one `Tone.Sampler` per bank per pointermove — with the outgoing voice
    // disposed while its own loads are still in flight.
    const { voice } = startEngine();
    const base = editingPreset();
    const { source } = base;
    if (source.kind !== 'sampler') throw new Error('expected a sampler preset');

    for (const release of [1.5, 2, 2.5, 3]) {
      act(() => applyVoicePreset({ ...base, source: { ...source, release } }));
    }
    expect(builtVoices()).toHaveLength(0);

    flushRebuild();

    expect(builtVoices()).toHaveLength(1);
    expect(lastVoice().preset).toMatchObject({ source: { release: 3 } });
    expect(voice.dispose).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the voice for a source-kind change', () => {
    const { voice } = startEngine();
    const edited: VoicePreset = {
      ...editingPreset(),
      source: {
        kind: 'pluck-synth',
        params: { attackNoise: 0.5, dampening: 4000, resonance: 0.85, release: 0.5 },
      },
    };

    act(() => applyVoicePreset(edited));
    flushRebuild();

    // `swapPreset` calls `this.dispose()` and returns on a kind change, leaving the
    // scheduler holding a corpse.
    expect(voice.swapPreset).not.toHaveBeenCalled();
    expect(builtVoices()).toHaveLength(1);
    expect(lastVoice().preset).toBe(edited);
  });

  it('does not build an audio graph when nothing has asked for a sound', () => {
    // The probe is mounted first *on purpose*: a metronome is available, so the only
    // thing stopping a build is the deliberate `engine`-not-`ensureEngine` read. Without
    // the probe this test passes no matter what the code does.
    render(createElement(EngineProbe));

    applyVoicePreset({ ...editingPreset(), level: { volumeDb: -3, pan: 0 } });
    flushRebuild();

    expect(builtVoices()).toHaveLength(0);
    expect(audio.FakeScheduler.instances).toHaveLength(0);
  });

  it('builds the next voice from the working copy, not from the stored variant', () => {
    const edited: VoicePreset = { ...editingPreset(), level: { volumeDb: -3, pan: 0 } };
    applyVoicePreset(edited);

    render(createElement(EngineProbe));
    act(() => previewNote(0, 0));

    // The working copy is not in the store, so nothing the lib resolves can see it.
    expect(lastVoice().preset).toBe(edited);
  });

  it('drops the working copy once the pattern points at a different voice', () => {
    applyVoicePreset({ ...editingPreset(), level: { volumeDb: -3, pan: 0 } });
    selectVoice({ kind: 'default', slotId: 'metal-amp' });

    render(createElement(EngineProbe));
    act(() => previewNote(0, 0));

    // Tagged with the ref it belongs to, so an abandoned edit cannot follow the user
    // onto the voice they switched to.
    expect(lastVoice().preset).toBe(getDefaultPresetForSlot('metal-amp'));
  });

  it('never resurrects an abandoned edit when the pattern points back at its voice', () => {
    selectVoice({ kind: 'default', slotId: 'acoustic-guitar' });
    const stored = editingPreset();
    applyVoicePreset({ ...stored, level: { volumeDb: -30, pan: 0 } });

    // Away and back to the *same* ref. The pane reset its own working copy on the way
    // out, so a copy still tagged for this ref would be an engine playing something no
    // UI shows — and a tag that only stops matching is not enough to prevent that, since
    // it starts matching again on the way back. The `refreshVoice` a selection goes
    // through is what retires it.
    selectVoice({ kind: 'default', slotId: 'metal-amp' });
    refreshVoice();
    selectVoice({ kind: 'default', slotId: 'acoustic-guitar' });
    refreshVoice();

    render(createElement(EngineProbe));
    act(() => previewNote(0, 0));

    expect(lastVoice().preset).toBe(stored);
  });

  it('does not carry an unsaved edit onto another pattern sharing the same voice', () => {
    const stored = editingPreset();
    applyVoicePreset({ ...stored, level: { volumeDb: -30, pan: 0 } });

    // Same instrument, same (absent) ref — so the ref alone cannot tell them apart, and
    // the tag has to carry the pattern id.
    openBlankPattern('Second pattern');
    render(createElement(EngineProbe));
    act(() => previewNote(0, 0));

    expect(lastVoice().preset).toBe(stored);
  });

  it('restores the stored preset when the editor discards', () => {
    const { voice } = startEngine();
    const stored = editingPreset();
    applyVoicePreset({ ...stored, level: { volumeDb: -30, pan: 0 } });

    act(() => applyVoicePreset(null));

    expect(voice.swapPreset).toHaveBeenLastCalledWith(stored);
  });

  it('discards even when the pattern was closed first', () => {
    const stored = editingPreset();
    applyVoicePreset({ ...stored, level: { volumeDb: -30, pan: 0 } });

    // The order a pane unmounts in is not ours to choose: closing the pattern can precede
    // the editor's own teardown, and a discard that no-ops then leaves the abandoned edit
    // as what plays the next time the pattern is opened.
    const pattern = getEditingPattern()!;
    usePatternsStore.getState().openPatternForEditing(null);
    applyVoicePreset(null);
    usePatternsStore.getState().openPatternForEditing(pattern.id);

    render(createElement(EngineProbe));
    act(() => previewNote(0, 0));

    expect(lastVoice().preset).toBe(stored);
  });

  it("never writes the live voice's preset back into the store", () => {
    const saved = saveVoiceAs('Mine', editingPreset());
    if (!saved.ok) throw new Error(saved.reason);
    const stored = useVoiceStore.getState().variants[0].preset;
    startEngine();

    act(() => applyVoicePreset({ ...stored, level: { volumeDb: -9, pan: 0 } }));

    // `swapPreset` reassigns the voice's own copy of the preset from what it managed to
    // apply, and for a sampler the banks in it are not the ones sounding — so the voice
    // is never a source of truth. Only an explicit `saveVoice` may touch the store.
    expect(useVoiceStore.getState().variants[0].preset).toBe(stored);
  });
});

describe('refreshVoice', () => {
  it('makes a selection audible without pinning it as an unsaved edit', () => {
    const saved = saveVoiceAs('Mine', getDefaultPresetForSlot('clean-amp'));
    if (!saved.ok) throw new Error(saved.reason);
    startEngine();

    // A selection has to reach a *running* engine somehow — nothing else calls
    // `ensureEngine` mid-playback.
    selectVoice({ kind: 'default', slotId: 'metal-amp' });
    act(() => refreshVoice());
    flushRebuild();
    expect(lastVoice().preset).toBe(getDefaultPresetForSlot('metal-amp'));

    // And it must not have left a working copy behind: a variant is shared, so a Save
    // from anywhere against the ref the engine holds still has to reach the engine.
    selectVoice({ kind: 'user', id: saved.id });
    act(() => refreshVoice());
    flushRebuild();
    const edited = { ...getDefaultPresetForSlot('clean-amp'), level: { volumeDb: -21, pan: 0 } };
    saveVoice(edited);
    act(() => refreshVoice());

    expect(lastVoice().swapPreset).toHaveBeenLastCalledWith(edited);
  });

  it('is inert with no pattern open rather than throwing', () => {
    usePatternsStore.getState().openPatternForEditing(null);
    expect(() => refreshVoice()).not.toThrow();
  });
});

describe('auditionVoice', () => {
  it('plays a note through the working voice without starting the transport', async () => {
    const edited: VoicePreset = { ...editingPreset(), level: { volumeDb: -3, pan: 0 } };
    applyVoicePreset(edited);
    render(createElement(EngineProbe));

    const before = audioNow();
    await act(async () => {
      await auditionVoice('C4');
    });

    // The metronome owns transport start/stop, so auditioning through it would *be*
    // starting playback — the whole point is to hear a tweak while nothing is playing.
    expect(audio.metronome.start).not.toHaveBeenCalled();
    expect(lastVoice().preset).toBe(edited);
    expect(lastVoice().ensureBuilt).toHaveBeenCalled();
    const [note, duration, at] = lastVoice().play.mock.calls[0];
    expect(note).toBe('C4');
    expect(duration).toBe('4n');
    // Scheduled ahead of the audio clock: exactly at it, right after the context
    // resumes, lands in the past and the note is dropped without a word. Measured
    // against `audioNow()` rather than zero — `Tone.now()` already includes a default
    // 0.1 s lookAhead, so `> 0` holds with no pre-roll at all.
    expect(at).toBeGreaterThan(before);
  });

  it('is inert with no pattern open rather than throwing', async () => {
    usePatternsStore.getState().openPatternForEditing(null);
    render(createElement(EngineProbe));

    await expect(auditionVoice()).resolves.toBeUndefined();
    expect(builtVoices()).toHaveLength(0);
  });
});

describe('warmVoice', () => {
  it('gets the samples in flight before anything asks to hear them', async () => {
    render(createElement(EngineProbe));

    await act(async () => {
      await warmVoice();
    });

    // `auditionVoice` is synchronous, so the first audition on a cold page is silent
    // unless the build already happened — which is what `warmVoice` is for. Nothing is
    // played here; this only builds and awaits the load.
    expect(builtVoices()).toHaveLength(1);
    expect(lastVoice().ready).toHaveBeenCalled();
    expect(lastVoice().play).not.toHaveBeenCalled();
    expect(audio.metronome.start).not.toHaveBeenCalled();
  });

  it('is inert with no pattern open rather than throwing', async () => {
    usePatternsStore.getState().openPatternForEditing(null);
    render(createElement(EngineProbe));

    await expect(warmVoice()).resolves.toBeUndefined();
    expect(builtVoices()).toHaveLength(0);
  });
});

describe('the voice key', () => {
  it('reuses the voice while the pattern and its preset are unchanged', () => {
    const { voice } = startEngine();

    act(() => previewNote(1, 3));

    expect(builtVoices()).toHaveLength(0);
    expect(voice.dispose).not.toHaveBeenCalled();
  });

  it("rebuilds when the pattern's voice choice changes", () => {
    const { voice } = startEngine();

    selectVoice({ kind: 'default', slotId: 'metal-amp' });
    act(() => previewNote(0, 0));

    expect(builtVoices()).toHaveLength(1);
    expect(voice.dispose).toHaveBeenCalled();
    expect(lastVoice().preset).toBe(getDefaultPresetForSlot('metal-amp'));
  });

  it('rebuilds on a choice change even when the two voices share a source', () => {
    // `clean-amp` and `surf-amp` ship the same `offset-p90` banks at the same release, so
    // their source fingerprints are identical and only the *ref* half of the key can tell
    // them apart. `ensureEngine` never calls `swapPreset`, so without it the user picks
    // Surf and keeps hearing Clean — with the picker showing the new choice.
    selectVoice({ kind: 'default', slotId: 'clean-amp' });
    const { voice } = startEngine();

    selectVoice({ kind: 'default', slotId: 'surf-amp' });
    act(() => previewNote(0, 0));

    expect(builtVoices()).toHaveLength(1);
    expect(voice.dispose).toHaveBeenCalled();
    expect(lastVoice().preset).toBe(getDefaultPresetForSlot('surf-amp'));
  });

  it('rebuilds when a saved edit changes the source under an unchanged ref', () => {
    // The ref alone cannot carry this: Save writes a new preset under the SAME ref, so
    // the key has to see the preset's source or a pack change saved from the editor
    // would never reach the engine.
    const saved = saveVoiceAs('Mine', editingPreset());
    if (!saved.ok) throw new Error(saved.reason);
    const { voice } = startEngine();
    const pack = otherSamplePack(editingPreset());

    saveVoice({ ...editingPreset(), source: { kind: 'sampler', samples: pack.samples } });
    act(() => previewNote(0, 0));

    expect(builtVoices()).toHaveLength(1);
    expect(voice.dispose).toHaveBeenCalled();
  });
});

/**
 * NOT asserted here, and not assertable: that a rebuilt sampler really re-downloads its
 * banks, that `swapPreset` retunes without an audible click, and that the audition note
 * sounds with the transport stopped. jsdom has no Web Audio at all, so each of those is
 * a listening test. What is pinned above is the decision that routes to them, which is
 * the part that fails in silence.
 */
