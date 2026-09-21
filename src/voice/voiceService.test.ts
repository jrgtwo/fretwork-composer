import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import {
  CABINET_IRS,
  SAMPLE_PACKS,
  detectSamplePack,
  getDefaultPresetForSlot,
  usePatternsStore,
  useVoiceStore,
  type FretInstrumentId,
  type SamplePack,
  type SlotId,
  type VoicePreset,
} from '@fretwork/lib';
import { getEditingPattern, openBlankPattern } from '../patterns/patternService';
import {
  deleteVoice,
  describeVoiceRefusal,
  getEditingVoicePreset,
  listSelectableVoices,
  parseVoiceKey,
  variantIdFromKey,
  readVoiceRef,
  renameVoice,
  saveVoice,
  saveVoiceAs,
  selectVoice,
  useEditingVoiceRef,
  useHolderVoicePreset,
  useSelectableVoices,
  voiceKey,
  type UserVariantRef,
} from './voiceService';
import { previewNote, refreshVoice, usePlaybackEngine } from '../audio/playbackService';
import {
  clearVoiceDrafts,
  discardVoiceDraft,
  isVoiceDirty,
  setVoiceParam,
  voiceDraftKeys,
  voicePreset,
} from './voiceDrafts';

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

/**
 * The open pattern's id — the `(kind, id)` half of every pattern-arm write since
 * the seam merged.
 *
 * Read fresh on each call rather than captured, because several tests below open a
 * second pattern mid-test and the write has to follow the one that is open. It
 * throws rather than returning a sentinel so a test that meant to write to a
 * pattern cannot pass by being refused; the one test about writing with nothing
 * open captures the id first, on purpose.
 */
const openPatternId = (): string => {
  const pattern = getEditingPattern();
  if (!pattern) throw new Error('no editing pattern');
  return pattern.id;
};

/**
 * Write one voice parameter into the open pattern's unsaved draft.
 *
 * THE PATH AN EDIT TAKES NOW. It used to be a whole preset pushed at `playbackService`,
 * which then kept its own tagged mirror of it.
 * There is one copy now: the edit lands in `voice/voiceDrafts` keyed `pattern:<id>`,
 * the store notifies, and `playbackService` reconciles from the same object. Driving
 * these tests through the real write seam is also what keeps them honest about the
 * agent's route in, which is the only other caller.
 */
const edit = (path: string, value: unknown): void => {
  const result = setVoiceParam('pattern', openPatternId(), path, value);
  if (!result.ok) throw new Error(result.reason);
};

/**
 * A voice of the USER'S OWN, seeded into the store out of one of the lib's slot
 * presets — the ref plus the preset the store now holds under it.
 *
 * The app stopped modelling those presets as pickable voices (2026-09-20,
 * `docs/PLAN-remove-presets.md`): a holder points at a user variant or at nothing.
 * They are still the cheapest source of a real, complete `VoicePreset` to build a
 * variant OUT OF, and reaching for one as raw DATA is deliberately still allowed —
 * what is not allowed is a ref naming one, which no longer type-checks.
 *
 * Through `addVariant` rather than `saveVoiceAs` so the instrument is a parameter
 * and the OPEN pattern is left pointing wherever it was: `saveVoiceAs` repoints it,
 * which several tests below are about.
 *
 * The preset is read BACK out of the store rather than returned from the argument,
 * because the identity assertions here are the load-bearing ones — a resolution
 * that started spreading is a render loop, not a failed equality.
 */
function savedVoice(
  slotId: SlotId,
  name = `Saved ${slotId}`,
  instrumentId: FretInstrumentId = 'guitar',
): { readonly ref: UserVariantRef; readonly preset: VoicePreset } {
  const source = getDefaultPresetForSlot(slotId);
  // ⚠ THE NECKS HAVE TO AGREE. `slotId` and `instrumentId` are separate arguments,
  // so without this `savedVoice('metal-amp', 'Low', 'bass')` would seed a guitar
  // preset as a bass variant and the bass picker would offer it. Wrong-neck refs are
  // a state with its own refusal (`wrong-instrument`) and its own tests; reaching one
  // by accident here would make those tests pass for the wrong reason.
  if (source.instrumentId !== instrumentId) {
    throw new Error(`${slotId} is a ${source.instrumentId} preset, not a ${instrumentId} one`);
  }
  const id = useVoiceStore.getState().addVariant({
    name,
    instrumentId,
    family: source.family,
    collectionId: null,
    preset: { ...source, name },
  });
  const stored = useVoiceStore.getState().variants.find((variant) => variant.id === id);
  if (!stored) throw new Error(`could not seed a variant from ${slotId}`);
  return { ref: { kind: 'user', id }, preset: stored.preset };
}

/** What the engine will build for the open pattern: its draft, or the stored variant. */
const draftPreset = (): VoicePreset => {
  const preset = voicePreset('pattern', openPatternId());
  if (!preset) throw new Error('no editing pattern');
  return preset;
};

beforeEach(() => {
  // Fake for the whole file so nothing accidentally depends on real-time coalescing.
  // Safe alongside the async tests here: those await promises, not timers.
  vi.useFakeTimers();
  audio.reset();
  useVoiceStore.getState().reset();
  sessionStorage.clear();
  openBlankPattern('Voice test');
  // The draft store is a module that outlives every unmount, so an edit made by one
  // test would otherwise still be what the next one plays.
  clearVoiceDrafts();
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
    saveVoiceAs('pattern', openPatternId(), 'Guitar variant', editingPreset());
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
});

describe('voiceKey', () => {
  it('round-trips every offered option', () => {
    savedVoice('clean-amp', 'Mine');
    savedVoice('electric-bass', 'Low', 'bass');
    const options = (['guitar', 'bass', 'ukulele'] as const).flatMap(
      (instrument) => listSelectableVoices(instrument).userVariants,
    );
    // Or the loop below proves nothing — the offer set is the user's library now, so
    // an empty one is the DEFAULT state rather than an impossible one.
    expect(options).toHaveLength(2);
    for (const option of options) {
      expect(parseVoiceKey(option.key)).toEqual(option.ref);
    }
    expect(parseVoiceKey(voiceKey({ kind: 'user', id: 'abc' }))).toEqual({
      kind: 'user',
      id: 'abc',
    });
  });

  it("rejects anything that is not one of the user's own voices", () => {
    // `default:<slotId>` is the key this app handed out until 2026-09-20 and is still
    // what a stored ref can say. There is no such voice HERE any more, so it is not a
    // voice key — including for `clean-amp`, a slot the lib really does ship. Read as
    // null the holder falls through to the instrument's default, which is the whole
    // migration (`docs/PLAN-remove-presets.md`).
    expect(parseVoiceKey('default:clean-amp')).toBeNull();
    expect(parseVoiceKey('default:test-clean-amp')).toBeNull();
    expect(parseVoiceKey('default:')).toBeNull();
    expect(parseVoiceKey('acoustic-guitar')).toBeNull();
    expect(parseVoiceKey('other:acoustic-guitar')).toBeNull();
  });

  it('keeps a colon inside a variant id', () => {
    expect(parseVoiceKey('user:a:b')).toEqual({ kind: 'user', id: 'a:b' });
  });

  it('hands a key to a caller that wants an id, or refuses it in one code', () => {
    // ⚠ THE FUNCTION THE AGENT'S RENAME AND DELETE GO THROUGH, and the one place
    // where a wrong answer is nearly invisible: read a key's TAIL as a variant id and
    // both tools still refuse, because `unknown-variant` catches the phantom id
    // downstream. So the refusal is asserted HERE, at the parse, rather than only
    // through a tool that would have refused either way.
    const mine = savedVoice('clean-amp', 'Mine');
    expect(variantIdFromKey(voiceKey(mine.ref))).toEqual({ ok: true, id: mine.ref.id });
    for (const key of ['default:clean-amp', 'clean-amp', 'other:clean-amp', 'user:']) {
      expect(variantIdFromKey(key)).toEqual({ ok: false, reason: 'unknown-variant' });
    }
    // An id that parses and names nothing is the SAME code, and deliberately: the
    // caller's move is identical, and one sentence covers both (see `VoiceRefusal`).
    expect(variantIdFromKey('user:gone')).toEqual({ ok: true, id: 'gone' });
    expect(renameVoice('gone', 'Anything')).toEqual({ ok: false, reason: 'unknown-variant' });
  });
});

// ------------------------------------------------------------------- hooks ---
// The reactive reads, which can only fail at render time. `useHolderVoicePreset` is the
// one with teeth: it hand-rolls a `useVoiceStore` selector that ignores its state
// argument, so it is correct only while every resolution returns a reference-stable
// object (a `VOICE_PRESETS` const, or the stored `variant.preset`). Should either ever
// start spreading, zustand's `getSnapshot` yields a fresh object per render and the pane
// render-loops — which no non-rendering test would notice.

describe('the reactive reads', () => {
  it('report the editing pattern voice choice and follow a selection', () => {
    const { result, rerender } = renderHook(() => useEditingVoiceRef());
    expect(result.current).toBeNull();

    const mine = savedVoice('surf-amp');
    act(() => selectVoice('pattern', openPatternId(), mine.ref));
    rerender();

    expect(result.current).toEqual(mine.ref);
  });

  it('resolve a preset stably across renders, and re-resolve when the store changes', () => {
    const saved = saveVoiceAs('pattern', openPatternId(), 'Mine', getDefaultPresetForSlot('surf-amp'));
    if (!saved.ok) throw new Error(saved.reason);

    const { result, rerender } = renderHook(() =>
      useHolderVoicePreset('pattern', openPatternId()),
    );
    const first = result.current;
    expect(first).toBe(useVoiceStore.getState().variants[0].preset);

    // Identity, not equality: an unstable snapshot is a render loop, not a failed
    // assertion, so this is the property worth pinning.
    rerender();
    expect(result.current).toBe(first);

    const edited = { ...first!, level: { volumeDb: -15, pan: 0 } };
    act(() => {
      saveVoice('pattern', openPatternId(), edited);
    });

    // `resolveActiveVoice` is a plain function over the store, so subscribing through
    // `useVoiceStore` is the only thing that makes an edit reach a pane at all.
    expect(result.current).toBe(edited);
  });

  it('list what can be picked, memoised, and follow a new variant', () => {
    const { result, rerender } = renderHook(() => useSelectableVoices('guitar'));
    expect(result.current.userVariants).toEqual([]);

    const first = result.current;
    rerender();
    expect(result.current).toBe(first);

    act(() => {
      saveVoiceAs('pattern', openPatternId(), 'Mine', getDefaultPresetForSlot('surf-amp'));
    });

    expect(result.current.userVariants.map((option) => option.name)).toEqual(['Mine']);
  });
});

// --------------------------------------------------------------- resolution ---

describe('readVoiceRef', () => {
  it('reads a valid ref back as the stored object', () => {
    selectVoice('pattern', openPatternId(), savedVoice('metal-amp').ref);
    const pattern = getEditingPattern()!;

    // Identity, not equality: callers memoise on this, and a fresh object per call
    // would invalidate every one of them on every render.
    expect(readVoiceRef(pattern)).toBe(pattern.voiceRef);
  });

  it('reads anything that is not a user variant as no choice at all', () => {
    const pattern = getEditingPattern()!;
    const withRef = (voiceRef: unknown) => ({ ...pattern, voiceRef });

    expect(readVoiceRef(withRef(null))).toBeNull();
    expect(readVoiceRef(withRef('acoustic-guitar'))).toBeNull();
    expect(readVoiceRef(withRef({ kind: 'user' }))).toBeNull();
    expect(readVoiceRef(withRef({ kind: 'user', id: '' }))).toBeNull();
    expect(readVoiceRef(withRef({ kind: 'default' }))).toBeNull();
    expect(readVoiceRef(withRef({ kind: 'default', slotId: 'test-clean-amp' }))).toBeNull();
    // ⚠ A WELL-FORMED default ref, naming a slot the lib really does ship — and it
    // reads as null all the same. That is the agreed migration rather than an
    // oversight: the app has no built-in voices, so the holder falls through to the
    // instrument's default like any holder that never chose one.
    expect(readVoiceRef(withRef({ kind: 'default', slotId: 'clean-amp' }))).toBeNull();
  });
});

describe('resolution', () => {
  it("falls back to the instrument's active voice when the pattern has none", () => {
    expect(getEditingPattern()!.voiceRef ?? null).toBeNull();
    expect(editingPreset()).toBe(getDefaultPresetForSlot('acoustic-guitar'));
  });

  it("honours the pattern's own choice over the instrument default", () => {
    const mine = savedVoice('metal-amp');
    selectVoice('pattern', openPatternId(), mine.ref);
    expect(editingPreset()).toBe(mine.preset);
  });

  it("resolves a user ref to that variant's preset", () => {
    expect(saveVoiceAs('pattern', openPatternId(), 'Mine', getDefaultPresetForSlot('surf-amp')).ok).toBe(true);
    expect(editingPreset()).toBe(useVoiceStore.getState().variants[0].preset);
  });

  it('falls through cleanly when the ref names a variant that is gone', () => {
    selectVoice('pattern', openPatternId(), { kind: 'user', id: 'never-existed' });
    // The lib's own fall-through, deliberately not reimplemented on this side.
    expect(editingPreset()).toBe(getDefaultPresetForSlot('acoustic-guitar'));
  });
});

describe('selectVoice', () => {
  it("writes the pattern's ref and leaves the global default alone", () => {
    const mine = savedVoice('blues-amp');
    const before = useVoiceStore.getState().activeVariants;

    selectVoice('pattern', openPatternId(), mine.ref);

    expect(getEditingPattern()!.voiceRef).toEqual(mine.ref);
    // `activeVariants` is the instrument-wide default shared by every pattern with no
    // explicit ref. Writing it from here would retune all of them.
    expect(useVoiceStore.getState().activeVariants).toBe(before);
  });
});

// ------------------------------------------------------------------ writing ---

describe('saveVoice', () => {
  it('refuses when the pattern has no explicit voice', () => {
    // It is playing the instrument's active voice — nothing addressable to write back
    // to, so this is Save-as territory.
    expect(saveVoice('pattern', openPatternId(), editingPreset())).toEqual({ ok: false, reason: 'no-voice' });
  });

  it('refuses a ref whose variant is gone', () => {
    selectVoice('pattern', openPatternId(), { kind: 'user', id: 'never-existed' });
    expect(saveVoice('pattern', openPatternId(), editingPreset())).toEqual({ ok: false, reason: 'unknown-variant' });
  });

  it("writes the preset and keeps the record's name in step with it", () => {
    const saved = saveVoiceAs('pattern', openPatternId(), 'Mine', editingPreset());
    if (!saved.ok) throw new Error(saved.reason);

    const edited: VoicePreset = {
      ...editingPreset(),
      name: 'Renamed in place',
      // The saved copy came from `acoustic-guitar`, so this is a real change of family —
      // the record has to follow it or the picker groups the voice under the old one.
      family: 'electric',
      level: { volumeDb: -6, pan: 0.5 },
    };
    expect(saveVoice('pattern', openPatternId(), edited)).toEqual({ ok: true, id: saved.id });

    const [variant] = useVoiceStore.getState().variants;
    expect(variant.preset).toBe(edited);
    expect(variant.name).toBe('Renamed in place');
    // `family` too: the picker reads the record, Save-as reads the payload, and the two
    // disagreeing is the same bug as a name that doesn't match.
    expect(variant.family).toBe(edited.family);
  });

  it('changes the voice for every pattern pointing at it', () => {
    const saved = saveVoiceAs('pattern', openPatternId(), 'Shared', editingPreset());
    if (!saved.ok) throw new Error(saved.reason);
    const ref = { kind: 'user', id: saved.id } as const;

    openBlankPattern('Second pattern');
    selectVoice('pattern', openPatternId(), ref);
    saveVoice('pattern', openPatternId(), { ...editingPreset(), level: { volumeDb: -12, pan: 0 } });

    // A voice is a shared asset — `pattern.voiceRef` is a reference, and editing the
    // variant is meant to reach every holder. Auto-forking a private copy per pattern
    // was considered and rejected.
    openBlankPattern('Third pattern');
    selectVoice('pattern', openPatternId(), ref);
    expect(editingPreset().level.volumeDb).toBe(-12);
  });
});

describe('saveVoiceAs', () => {
  it("creates a root-level variant for the pattern's instrument", () => {
    const result = saveVoiceAs('pattern', openPatternId(), '  My tone  ', getDefaultPresetForSlot('lead-amp'));
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
    const result = saveVoiceAs('pattern', openPatternId(), 'My tone', getDefaultPresetForSlot('lead-amp'));
    if (!result.ok) throw new Error(result.reason);

    // Without this the pattern keeps playing what the copy was taken from — here the
    // instrument's default — and the saved variant sits unused, so Save-as would
    // appear to do nothing.
    expect(getEditingPattern()!.voiceRef).toEqual({ kind: 'user', id: result.id });
    expect(editingPreset()).toBe(useVoiceStore.getState().variants[0].preset);
  });

  it('leaves the lib preset it was copied from untouched', () => {
    saveVoiceAs('pattern', openPatternId(), 'My tone', getDefaultPresetForSlot('lead-amp'));
    saveVoice('pattern', openPatternId(), { ...editingPreset(), level: { volumeDb: -20, pan: 0 } });

    expect(getDefaultPresetForSlot('lead-amp').level.volumeDb).not.toBe(-20);
  });

  it('refuses a blank name and creates nothing', () => {
    expect(saveVoiceAs('pattern', openPatternId(), '   ', editingPreset())).toEqual({ ok: false, reason: 'empty-name' });
    expect(useVoiceStore.getState().variants).toEqual([]);
    expect(getEditingPattern()!.voiceRef ?? null).toBeNull();
  });

  it("reports the tier cap and leaves the pattern's ref alone", () => {
    // `addVariant` returns '' when the lib's tier gate refuses (it has already opened its
    // own upgrade prompt). Repointing at `{kind:'user', id:''}` would read back through
    // `readVoiceRef` as *no choice at all* — a save the user was told happened, on a
    // pattern silently reverted to the instrument default.
    const addVariant = vi.spyOn(useVoiceStore.getState(), 'addVariant').mockReturnValue('');

    expect(saveVoiceAs('pattern', openPatternId(), 'Capped', editingPreset())).toEqual({ ok: false, reason: 'capped' });
    expect(getEditingPattern()!.voiceRef ?? null).toBeNull();
    addVariant.mockRestore();
  });
});

describe('writing with nothing open', () => {
  it('refuses rather than throwing', () => {
    // A pane can be mid-unmount while the pattern is already closed; every one of these
    // has to be a refusal the caller can render, not an exception in a click handler.
    const preset = editingPreset();
    // Captured while it is still open: the seam takes `(kind, id)`, and the point
    // of the test is that the id no longer names anything writable.
    const id = openPatternId();
    usePatternsStore.getState().openPatternForEditing(null);

    expect(saveVoice('pattern', id, preset)).toEqual({ ok: false, reason: 'no-holder' });
    expect(saveVoiceAs('pattern', id, 'Mine', preset)).toEqual({ ok: false, reason: 'no-holder' });
    expect(deleteVoice('pattern', id, 'whatever')).toEqual({ ok: false, reason: 'no-holder' });
    expect(selectVoice('pattern', id, { kind: 'user', id: 'whatever' })).toEqual({
      ok: false,
      reason: 'No such pattern is open.',
    });
    // The whole case for `kind` being a parameter rather than a field on the
    // refusal is that ONE code has to become two sentences. Pinned from both ends,
    // or a branch that collapsed to the pattern wording would pass unnoticed —
    // the track branch is reached from the agent's tools, which no surface renders.
    expect(describeVoiceRefusal('track', 'no-holder')).toBe(
      'That track is no longer in this composition.',
    );
    expect(describeVoiceRefusal('pattern', 'no-holder')).toBe('No such pattern is open.');
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
    selectVoice('pattern', openPatternId(), { kind: 'user', id });

    expect(saveVoice('pattern', openPatternId(), getDefaultPresetForSlot('lead-amp'))).toEqual({
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
    const saved = saveVoiceAs('pattern', openPatternId(), 'First', editingPreset());
    if (!saved.ok) throw new Error(saved.reason);

    expect(renameVoice(saved.id, '  Second  ')).toEqual({ ok: true, id: saved.id });

    const [variant] = useVoiceStore.getState().variants;
    expect(variant.name).toBe('Second');
    expect(variant.preset.name).toBe('Second');
  });

  it('survives the next Save', () => {
    const saved = saveVoiceAs('pattern', openPatternId(), 'First', editingPreset());
    if (!saved.ok) throw new Error(saved.reason);
    renameVoice(saved.id, 'Second');

    // This is why the rename writes the payload too, instead of using the lib's
    // `renameVariant`: `saveVoice` writes the record's name back from `preset.name`,
    // so a record-only rename is reverted the moment the user touches a slider.
    saveVoice('pattern', openPatternId(), editingPreset());

    expect(useVoiceStore.getState().variants[0].name).toBe('Second');
  });

  it('refuses a blank name or an unknown id', () => {
    const saved = saveVoiceAs('pattern', openPatternId(), 'First', editingPreset());
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
    const saved = saveVoiceAs('pattern', openPatternId(), 'Doomed', editingPreset());
    if (!saved.ok) throw new Error(saved.reason);

    expect(deleteVoice('pattern', openPatternId(), saved.id)).toEqual({ ok: true, id: saved.id });

    expect(useVoiceStore.getState().variants).toEqual([]);
    // Left dangling, the ref would still resolve — silently, to the instrument's
    // default — while the pane showed nothing selected.
    expect(getEditingPattern()!.voiceRef ?? null).toBeNull();
    expect(editingPreset()).toBe(getDefaultPresetForSlot('acoustic-guitar'));
  });

  it('leaves a ref that points somewhere else alone', () => {
    const keep = saveVoiceAs('pattern', openPatternId(), 'Keep', editingPreset());
    const drop = saveVoiceAs('pattern', openPatternId(), 'Drop', editingPreset());
    if (!keep.ok || !drop.ok) throw new Error('setup failed');
    selectVoice('pattern', openPatternId(), { kind: 'user', id: keep.id });

    deleteVoice('pattern', openPatternId(), drop.id);

    expect(getEditingPattern()!.voiceRef).toEqual({ kind: 'user', id: keep.id });
  });

  it('refuses an unknown id', () => {
    expect(deleteVoice('pattern', openPatternId(), 'never-existed')).toEqual({ ok: false, reason: 'unknown-variant' });
  });
});

// ----------------------------------------------------- edit classification ---
// `Voice.swapPreset` retunes in place, except that it disposes itself on a source-KIND
// change (gap 9a) and never reconstructed sampler banks (gap 9b) — both fixed upstream,
// but the classification still routes rebuild-class edits so they can be coalesced. Source
// identity has to rebuild and everything else must not — and neither failure announces
// itself.

describe('an unsaved edit reaching the engine', () => {
  it('retunes the live voice in place for a level or effects edit', () => {
    const { voice } = startEngine();

    act(() => edit('level.volumeDb', -6));

    expect(voice.swapPreset).toHaveBeenCalledWith(draftPreset());
    expect(draftPreset().level?.volumeDb).toBe(-6);
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
    selectVoice('pattern', openPatternId(), savedVoice('clean-amp').ref);
    const { voice } = startEngine();
    const amp = editingPreset().effects?.amp;
    if (!amp) throw new Error('expected clean-amp to ship an amp');

    act(() => edit('effects.amp.preDrive', Math.min(1, amp.preDrive + 0.2)));
    // Adding a stage, not just retuning one: `clean-amp` ships no cabinet, and
    // `swapPreset` handles a chain-shape change itself (`_rebuildChain` keeps the
    // synth). Only the *source* needs a new `Voice`.
    act(() => edit('effects.cabIR.url', CABINET_IRS[0].url));

    expect(draftPreset().effects?.cabIR?.url).toBe(CABINET_IRS[0].url);
    expect(voice.swapPreset).toHaveBeenLastCalledWith(draftPreset());
    flushRebuild();
    expect(builtVoices()).toHaveLength(0);
    expect(voice.dispose).not.toHaveBeenCalled();
  });

  it('rebuilds the voice for a sample-pack change', () => {
    const { voice, scheduler } = startEngine();
    const pack = otherSamplePack(editingPreset());
    // Everything but the banks held constant, so this cannot pass on the back of an
    // incidental `release` difference — the banks have to be in the fingerprint.

    act(() => edit('source.samples', pack.id));
    flushRebuild();

    // `swapPreset` would have accepted this and changed nothing audible: the banks are
    // only ever constructed in `_ensureBuilt`.
    expect(voice.swapPreset).not.toHaveBeenCalled();
    expect(builtVoices()).toHaveLength(1);
    expect(lastVoice().preset).toBe(draftPreset());
    expect(voice.dispose).toHaveBeenCalled();
    expect(scheduler.setInstrument).toHaveBeenCalledWith(lastVoice());
    // Without this the new banks download only at the next `play()`.
    expect(lastVoice().ensureBuilt).toHaveBeenCalled();
  });

  it('rebuilds the voice for a sampler release change', () => {
    const { voice } = startEngine();
    if (editingPreset().source.kind !== 'sampler') throw new Error('expected a sampler preset');

    act(() => edit('source.release', 0.9));
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
    if (editingPreset().source.kind !== 'sampler') throw new Error('expected a sampler preset');

    for (const release of [0.4, 0.5, 0.6, 0.7]) {
      act(() => edit('source.release', release));
    }
    expect(builtVoices()).toHaveLength(0);

    flushRebuild();

    expect(builtVoices()).toHaveLength(1);
    expect(lastVoice().preset).toMatchObject({ source: { release: 0.7 } });
    expect(voice.dispose).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the voice for a source-kind change', () => {
    const { voice } = startEngine();

    act(() => edit('source.kind', 'pluck-synth'));
    flushRebuild();

    // `swapPreset` calls `this.dispose()` and returns on a kind change, leaving the
    // scheduler holding a corpse.
    expect(voice.swapPreset).not.toHaveBeenCalled();
    expect(builtVoices()).toHaveLength(1);
    expect(lastVoice().preset).toBe(draftPreset());
    expect(draftPreset().source.kind).toBe('pluck-synth');
  });

  it('does not build an audio graph when nothing has asked for a sound', () => {
    // The probe is mounted first *on purpose*: a metronome is available, so the only
    // thing stopping a build is the deliberate `engine`-not-`ensureEngine` read. Without
    // the probe this test passes no matter what the code does.
    render(createElement(EngineProbe));

    edit('level.volumeDb', -3);
    flushRebuild();

    expect(builtVoices()).toHaveLength(0);
    expect(audio.FakeScheduler.instances).toHaveLength(0);
  });

  it('builds the next voice from the unsaved draft, not from the stored variant', () => {
    edit('level.volumeDb', -3);
    const edited = draftPreset();

    render(createElement(EngineProbe));
    act(() => previewNote(0, 0));

    // The draft is not in the store, so nothing the lib resolves can see it.
    expect(lastVoice().preset).toBe(edited);
  });

  it('drops the draft once the pattern points at a different voice', () => {
    edit('level.volumeDb', -3);
    const metal = savedVoice('metal-amp');
    selectVoice('pattern', openPatternId(), metal.ref);

    render(createElement(EngineProbe));
    act(() => previewNote(0, 0));

    // Tagged with the ref it belongs to, so an abandoned edit cannot follow the user
    // onto the voice they switched to.
    expect(lastVoice().preset).toBe(metal.preset);
  });

  it('never resurrects an abandoned edit when the pattern points back at its voice', () => {
    const acoustic = savedVoice('acoustic-guitar', 'Mine acoustic');
    const metal = savedVoice('metal-amp');
    selectVoice('pattern', openPatternId(), acoustic.ref);
    const stored = editingPreset();
    edit('level.volumeDb', -30);

    // Away and back to the *same* ref. A tag that only stops matching is not enough to
    // prevent an abandoned edit coming back, since it starts matching again on the way
    // back — the `refreshVoice` a selection goes through is what retires it, because
    // `presetFor` reads (and so self-clears) the draft on the way past.
    selectVoice('pattern', openPatternId(), metal.ref);
    refreshVoice();
    selectVoice('pattern', openPatternId(), acoustic.ref);
    refreshVoice();

    render(createElement(EngineProbe));
    act(() => previewNote(0, 0));

    expect(lastVoice().preset).toBe(stored);
  });

  it('does not carry an unsaved edit onto another pattern sharing the same voice', () => {
    const stored = editingPreset();
    edit('level.volumeDb', -30);

    // Same instrument, same (absent) ref — so the tag alone cannot tell them apart, and
    // the draft's KEY has to carry the pattern id. It also means the first pattern keeps
    // its own edit, which is what makes a switch cost nothing.
    const first = openPatternId();
    openBlankPattern('Second pattern');
    render(createElement(EngineProbe));
    act(() => previewNote(0, 0));

    expect(lastVoice().preset).toBe(stored);
    expect(voicePreset('pattern', first)?.level?.volumeDb).toBe(-30);
  });

  it('restores the stored preset when the editor discards', () => {
    const { voice } = startEngine();
    const stored = editingPreset();
    edit('level.volumeDb', -30);

    act(() => discardVoiceDraft('pattern', openPatternId()));

    expect(voice.swapPreset).toHaveBeenLastCalledWith(stored);
  });

  it('discards even when the pattern was closed first', () => {
    const stored = editingPreset();
    edit('level.volumeDb', -30);

    // The order a pane unmounts in is not ours to choose: closing the pattern can precede
    // the editor's own teardown, and a discard that no-ops then leaves the abandoned edit
    // as what plays the next time the pattern is opened.
    const pattern = getEditingPattern()!;
    usePatternsStore.getState().openPatternForEditing(null);
    discardVoiceDraft('pattern', pattern.id);
    usePatternsStore.getState().openPatternForEditing(pattern.id);

    render(createElement(EngineProbe));
    act(() => previewNote(0, 0));

    expect(lastVoice().preset).toBe(stored);
  });

  it('cancels a pending rebuild on a discard made after the pattern was closed', () => {
    // The other half of the same order problem, and the one that only the timer can
    // show: a rebuild-class edit leaves a trailing build armed, and the discard has to
    // cancel it BEFORE the "is a pattern open" guard or the abandoned edit is what gets
    // built the moment the window elapses.
    //
    // ⚠ THE ASSERTION IS THE TIMER, and it has to be. Letting the window elapse and
    // counting voices cannot fail: the armed build re-reads inside the window, finds the
    // draft gone and the key back at the engine's, and returns without building — so
    // nothing is constructed whether or not the cancel ever happened.
    const { voice } = startEngine();
    const pattern = getEditingPattern()!;
    // Counted as a DELTA: this file runs on fake timers and the render leaves its own
    // behind, so the absolute count is not ours to predict.
    const idle = vi.getTimerCount();
    act(() => edit('source.release', 0.9));
    expect(vi.getTimerCount()).toBe(idle + 1);

    usePatternsStore.getState().openPatternForEditing(null);
    discardVoiceDraft('pattern', pattern.id);

    expect(vi.getTimerCount()).toBe(idle);

    usePatternsStore.getState().openPatternForEditing(pattern.id);
    flushRebuild();
    expect(builtVoices()).toHaveLength(0);
    expect(voice.dispose).not.toHaveBeenCalled();
  });

  it('leaves another pattern’s armed rebuild alone when one pattern discards', () => {
    // `pendingRebuild` is ONE binding, belonging to whichever pattern is open, and this
    // seam is addressed by id — so an unguarded cancel would let a discard aimed at some
    // other pattern disarm the open one's source-identity build, with nothing to re-arm
    // it and no sound to say so.
    const other = openPatternId();
    expect(setVoiceParam('pattern', other, 'level.volumeDb', -12).ok).toBe(true);
    openBlankPattern('Second pattern');
    const { voice } = startEngine();

    const idle = vi.getTimerCount();
    act(() => edit('source.release', 0.9));
    expect(vi.getTimerCount()).toBe(idle + 1);

    act(() => discardVoiceDraft('pattern', other));

    // Still armed — and it still lands.
    expect(vi.getTimerCount()).toBe(idle + 1);
    flushRebuild();
    expect(builtVoices()).toHaveLength(1);
    expect(voice.dispose).toHaveBeenCalled();
  });

  it('retires an edit when the pattern’s voice ref moves behind the pane’s back', () => {
    // A selection made through an editor calls `refreshVoice` itself. This is the one
    // made by something else — a pattern undo restoring a snapshot with a different
    // `voiceRef` — and the pane cannot catch it: `PaneStack` unmounts a collapsed pane's
    // body, so the engine's own hook watches the tag instead.
    const saved = saveVoiceAs('pattern', openPatternId(), 'Mine', getDefaultPresetForSlot('clean-amp'));
    if (!saved.ok) throw new Error(saved.reason);
    const metal = savedVoice('metal-amp');
    const { voice } = startEngine();
    const pattern = getEditingPattern()!;
    act(() => edit('level.volumeDb', -30));
    expect(isVoiceDirty('pattern', pattern.id)).toBe(true);

    // The store write WITHOUT the seam call around it. `selectVoice` is this line plus
    // a `refreshVoice`, and an undo that restores a snapshot carrying a different ref is
    // this line with nothing at all — which is the case being pinned.
    act(() => {
      usePatternsStore.getState().setEditingPatternVoiceRef(metal.ref);
    });

    // The entry is GONE, not merely shadowed by a tag that stopped matching: left
    // standing, a redo back to the original ref resurrects an edit the user walked away
    // from. Read through `voiceDraftKeys`, because every other read would do the
    // clearing itself and pass either way.
    expect(voiceDraftKeys()).not.toContain(`pattern:${pattern.id}`);

    // And the engine goes and gets the stored voice rather than sounding that edit on.
    // A rebuild rather than a retune because the REF moved: `voiceKeyOf` carries it.
    flushRebuild();
    expect(voice.dispose).toHaveBeenCalled();
    expect(lastVoice().preset).toEqual(metal.preset);
  });

  it("never writes the live voice's preset back into the store", () => {
    const saved = saveVoiceAs('pattern', openPatternId(), 'Mine', editingPreset());
    if (!saved.ok) throw new Error(saved.reason);
    const stored = useVoiceStore.getState().variants[0].preset;
    startEngine();

    act(() => edit('level.volumeDb', -9));

    // `swapPreset` reassigns the voice's own copy of the preset from what it managed to
    // apply, and for a sampler the banks in it are not the ones sounding — so the voice
    // is never a source of truth. Only an explicit `saveVoice` may touch the store.
    expect(useVoiceStore.getState().variants[0].preset).toBe(stored);
  });
});

describe('refreshVoice', () => {
  it('makes a selection audible without pinning it as an unsaved edit', () => {
    const saved = saveVoiceAs('pattern', openPatternId(), 'Mine', getDefaultPresetForSlot('clean-amp'));
    if (!saved.ok) throw new Error(saved.reason);
    const metal = savedVoice('metal-amp');
    startEngine();

    // A selection has to reach a *running* engine somehow — nothing else calls
    // `ensureEngine` mid-playback.
    selectVoice('pattern', openPatternId(), metal.ref);
    act(() => refreshVoice());
    flushRebuild();
    expect(lastVoice().preset).toBe(metal.preset);

    // And it must not have left a working copy behind: a variant is shared, so a Save
    // from anywhere against the ref the engine holds still has to reach the engine.
    selectVoice('pattern', openPatternId(), { kind: 'user', id: saved.id });
    act(() => refreshVoice());
    flushRebuild();
    const edited = { ...getDefaultPresetForSlot('clean-amp'), level: { volumeDb: -21, pan: 0 } };
    saveVoice('pattern', openPatternId(), edited);
    act(() => refreshVoice());

    expect(lastVoice().swapPreset).toHaveBeenLastCalledWith(edited);
  });

  it('is inert with no pattern open rather than throwing', () => {
    usePatternsStore.getState().openPatternForEditing(null);
    expect(() => refreshVoice()).not.toThrow();
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
    const metal = savedVoice('metal-amp');
    const { voice } = startEngine();

    selectVoice('pattern', openPatternId(), metal.ref);
    act(() => previewNote(0, 0));

    expect(builtVoices()).toHaveLength(1);
    expect(voice.dispose).toHaveBeenCalled();
    expect(lastVoice().preset).toBe(metal.preset);
  });

  it('rebuilds on a choice change even when the two voices share a source', () => {
    // `clean-amp` and `surf-amp` ship the same `offset-p90` banks at the same release, so
    // their source fingerprints are identical and only the *ref* half of the key can tell
    // them apart. `ensureEngine` never calls `swapPreset`, so without it the user picks
    // Surf and keeps hearing Clean — with the picker showing the new choice.
    const clean = savedVoice('clean-amp', 'Mine clean');
    const surf = savedVoice('surf-amp', 'Mine surf');
    selectVoice('pattern', openPatternId(), clean.ref);
    const { voice } = startEngine();

    selectVoice('pattern', openPatternId(), surf.ref);
    act(() => previewNote(0, 0));

    expect(builtVoices()).toHaveLength(1);
    expect(voice.dispose).toHaveBeenCalled();
    expect(lastVoice().preset).toBe(surf.preset);
  });

  it('rebuilds when a saved edit changes the source under an unchanged ref', () => {
    // The ref alone cannot carry this: Save writes a new preset under the SAME ref, so
    // the key has to see the preset's source or a pack change saved from the editor
    // would never reach the engine.
    const saved = saveVoiceAs('pattern', openPatternId(), 'Mine', editingPreset());
    if (!saved.ok) throw new Error(saved.reason);
    const { voice } = startEngine();
    const pack = otherSamplePack(editingPreset());

    saveVoice('pattern', openPatternId(), { ...editingPreset(), source: { kind: 'sampler', samples: pack.samples } });
    act(() => previewNote(0, 0));

    expect(builtVoices()).toHaveLength(1);
    expect(voice.dispose).toHaveBeenCalled();
  });
});

/**
 * NOT asserted here, and not assertable: that a rebuilt sampler really re-downloads its
 * banks, that `swapPreset` retunes without an audible click, and that a previewed cell
 * sounds at all. jsdom has no Web Audio at all, so each of those is
 * a listening test. What is pinned above is the decision that routes to them, which is
 * the part that fails in silence.
 */
