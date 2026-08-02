import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PATTERNS_STATE,
  MAX_COMPOSITION_TRACKS,
  PPQ,
  usePatternsStore,
  type Composition,
  type Track,
} from '@fretwork/lib';
import { getEditingPattern, openBlankPattern } from '../patterns/patternService';
import {
  addPlacement,
  addTrack,
  beginEditGesture,
  clearHistory,
  duplicatePlacements,
  endEditGesture,
  ensureComposition,
  findPlacement,
  getSelectedPlacementIds,
  getSelectedTrackId,
  movePlacement,
  openBlankComposition,
  redo,
  removePlacement,
  removeTrack,
  resizePlacement,
  selectPlacements,
  selectTrack,
  setCompositionBpm,
  setCompositionLoop,
  setCompositionName,
  setCompositionTimeSignature,
  setMasterVolumeDb,
  setPlacementTranspose,
  setTrackInstrument,
  setTrackMuted,
  setTrackName,
  setTrackSoloed,
  setTrackVoiceRef,
  setTrackVolumeDb,
  splitPlacement,
  totalDurationTicks,
  trackInstrumentId,
  undo,
  useEditingComposition,
  useHistoryState,
  useSelectedPlacementIds,
  useSelectedTrackId,
  useTotalDurationTicks,
  useTracks,
} from './compositionService';

/**
 * The seam over the lib's COMPOSITION store.
 *
 * The store is real, not a stand-in — the whole point of these tests is that a
 * write reaches `library.compositions` and survives being read back, which a
 * mock would assert away. So every assertion reads through
 * `usePatternsStore.getState().library`, NOT through this module's own getters:
 * a seam that wrote nowhere and cached the value in a module variable would pass
 * the second and fail the first.
 *
 * Almost all of it needs no DOM — nothing renders, and the hooks are thin
 * `useSyncExternalStore` wrappers over the same state these tests read directly.
 * The exception is the `hooks` block: reading through the getters can't tell
 * whether a subscriber was ever notified, so the re-render path needs
 * `renderHook` to be tested at all.
 */

/** The composition as the STORE holds it — the round-trip assertion. */
const stored = (): Composition => {
  const id = usePatternsStore.getState().editingCompositionId;
  const composition = usePatternsStore
    .getState()
    .library.compositions.find((c) => c.id === id);
  if (!composition) throw new Error('no composition open');
  return composition;
};

const storedTracks = () => stored().tracks;
const storedPlacements = (trackIndex = 0) => storedTracks()[trackIndex].placements;

/**
 * Whether an undo step exists.
 *
 * The hook is the only reader of the history's own state, and several tests have
 * to assert that NO step was pushed — which an `undo()` cannot show, because a
 * spurious step restores exactly the state it captured and so is invisible in
 * the composition.
 */
function canUndo(): boolean {
  const view = renderHook(() => useHistoryState());
  const value = view.result.current.canUndo;
  view.unmount();
  return value;
}

/** A library pattern to place. Created through `patternService` rather than the
 *  store, so the test respects the pattern seam the same way the app does. */
function seedPattern(name: string): string {
  openBlankPattern(name);
  const pattern = getEditingPattern();
  if (!pattern) throw new Error('pattern seam did not open a pattern');
  return pattern.id;
}

beforeEach(() => {
  sessionStorage.clear();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  clearHistory();
  selectPlacements([]);
  selectTrack(null);
});

// ------------------------------------------------------------- lifecycle ---

describe('ensureComposition', () => {
  it('seeds a composition and reports the one it opened', () => {
    const result = ensureComposition();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(usePatternsStore.getState().library.compositions).toHaveLength(1);
    expect(result.value.id).toBe(usePatternsStore.getState().editingCompositionId);
    // The lib's own invariant: never zero tracks.
    expect(result.value.tracks.length).toBeGreaterThan(0);
  });

  it('reopens the existing composition rather than creating a second', () => {
    const first = ensureComposition();
    const second = ensureComposition();

    expect(first.ok && second.ok && first.value.id === second.value.id).toBe(true);
    expect(usePatternsStore.getState().library.compositions).toHaveLength(1);
  });

  it('refuses rather than reporting success when nothing was opened', () => {
    // `ensureEditingComposition` runs a subscription gate and returns silently
    // when refused, so the seam has to verify. The gate can't be tripped from
    // here (the free cap is 500), so the refusal path is provoked by emptying
    // the library from under the action — the same observable end state.
    const real = usePatternsStore.getState().ensureEditingComposition;
    usePatternsStore.setState({ ensureEditingComposition: () => {} });
    try {
      const result = ensureComposition();

      expect(result).toEqual({
        ok: false,
        reason: expect.stringContaining("Couldn't open a composition"),
      });
    } finally {
      // The action is not part of the state `beforeEach` restores, so the stub
      // would leak into every later test in the file.
      usePatternsStore.setState({ ensureEditingComposition: real });
    }
  });
});

describe('openBlankComposition', () => {
  it('creates a composition, opens it, and clears selection and history', () => {
    ensureComposition();
    const firstId = stored().id;
    const trackId = storedTracks()[0].id;
    const patternId = seedPattern('Riff');
    addPlacement(patternId, trackId);
    selectTrack(trackId);
    expect(getSelectedPlacementIds()).toHaveLength(1);

    const result = openBlankComposition('Song 2');

    expect(result.ok).toBe(true);
    expect(stored().name).toBe('Song 2');
    expect(usePatternsStore.getState().library.compositions).toHaveLength(2);
    // History and selection are per-composition; carrying either across the
    // switch would undo into a composition that is no longer open. The
    // discriminating assertion is on the FIRST composition: an uncleared stack
    // would still hold its pre-placement snapshot and this undo would write it
    // back, silently deleting a block from a composition nobody is looking at.
    undo();
    const first = usePatternsStore
      .getState()
      .library.compositions.find((c) => c.id === firstId);
    expect(first?.tracks[0].placements).toHaveLength(1);
    expect(getSelectedPlacementIds()).toEqual([]);
    expect(getSelectedTrackId()).toBeNull();
  });

  it('leaves the open PATTERN alone', () => {
    // The lib's `createComposition` nulls `editingPatternId` — it assumes the two
    // documents are separate pages. `App.tsx` re-seeds a demo pattern whenever
    // nothing is open, so an uncorrected null appends a junk pattern to the
    // library on every press.
    seedPattern('Riff');
    const patternId = usePatternsStore.getState().editingPatternId;
    expect(patternId).not.toBeNull();
    const patternCount = usePatternsStore.getState().library.patterns.length;

    openBlankComposition('Song 2');

    expect(usePatternsStore.getState().editingPatternId).toBe(patternId);
    expect(usePatternsStore.getState().library.patterns).toHaveLength(patternCount);
  });
});

// ---------------------------------------------------------------- tracks ---

describe('addTrack', () => {
  beforeEach(() => {
    ensureComposition();
  });

  it('appends a track and writes it through to the store', () => {
    const before = storedTracks().length;

    const result = addTrack('Bass', 'bass');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(storedTracks()).toHaveLength(before + 1);
    expect(storedTracks().at(-1)?.id).toBe(result.value.id);
    expect(storedTracks().at(-1)?.name).toBe('Bass');
    expect(trackInstrumentId(storedTracks().at(-1)!)).toBe('bass');
  });

  it(`refuses past ${MAX_COMPOSITION_TRACKS} tracks instead of silently no-op'ing`, () => {
    while (storedTracks().length < MAX_COMPOSITION_TRACKS) {
      expect(addTrack().ok).toBe(true);
    }
    expect(storedTracks()).toHaveLength(MAX_COMPOSITION_TRACKS);

    const result = addTrack('One too many');

    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining(String(MAX_COMPOSITION_TRACKS)),
    });
    expect(storedTracks()).toHaveLength(MAX_COMPOSITION_TRACKS);
  });

  it('pushes no undo step for the refusal', () => {
    while (storedTracks().length < MAX_COMPOSITION_TRACKS) addTrack();
    clearHistory();

    expect(addTrack('One too many').ok).toBe(false);

    // Asserted through the history rather than by undoing: a step captured on a
    // refusal snapshots the CURRENT composition, so undoing it changes nothing
    // and any assertion on the tracks would pass either way.
    expect(canUndo()).toBe(false);
  });

  it('refuses with no composition open', () => {
    usePatternsStore.setState({ editingCompositionId: null });
    expect(addTrack().ok).toBe(false);
  });
});

describe('removeTrack', () => {
  beforeEach(() => {
    ensureComposition();
  });

  it('removes the track and clears any selection pointing into it', () => {
    const patternId = seedPattern('Riff');
    const first = storedTracks()[0].id;
    const added = addTrack('Second');
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const placed = addPlacement(patternId, added.value.id);
    expect(placed.ok).toBe(true);
    selectTrack(added.value.id);

    const result = removeTrack(added.value.id);

    expect(result.ok).toBe(true);
    expect(storedTracks().map((t) => t.id)).toEqual([first]);
    expect(getSelectedTrackId()).toBeNull();
    // The placement went with the track, so the selection can't still name it.
    expect(getSelectedPlacementIds()).toEqual([]);
  });

  it("refuses to remove the last track — the model's invariant is at least one", () => {
    const only = storedTracks()[0].id;

    expect(removeTrack(only).ok).toBe(false);
    expect(storedTracks()).toHaveLength(1);
  });

  it('refuses an unknown id', () => {
    expect(removeTrack('nope').ok).toBe(false);
  });
});

describe('track settings round-trip through the store', () => {
  beforeEach(() => {
    ensureComposition();
  });

  it('writes name, instrument, volume, mute and solo', () => {
    const id = storedTracks()[0].id;

    setTrackName(id, 'Rhythm');
    expect(storedTracks()[0].name).toBe('Rhythm');

    setTrackInstrument(id, 'ukulele');
    expect(trackInstrumentId(storedTracks()[0])).toBe('ukulele');

    setTrackVolumeDb(id, -6);
    expect(storedTracks()[0].volumeDb).toBe(-6);

    setTrackMuted(id, true);
    expect(storedTracks()[0].muted).toBe(true);

    setTrackSoloed(id, true);
    expect(storedTracks()[0].soloed).toBe(true);
  });

  it('stores a voiceRef opaquely — the cast is voiceService’s, not this seam’s', () => {
    const id = storedTracks()[0].id;
    const ref = { kind: 'default', slotId: 'clean-amp' };

    setTrackVoiceRef(id, ref);

    expect(storedTracks()[0].voiceRef).toEqual(ref);
  });

  it('writes the master volume', () => {
    setMasterVolumeDb(-3);
    expect(stored().masterVolumeDb).toBe(-3);
  });

  it('refuses an unknown track instead of persisting a phantom write', () => {
    // The lib's track ops run `replaceTrack` and return a bumped composition
    // whether or not anything matched, so without a guard here an unknown id
    // persists a new composition, bumps `updatedAt` and re-renders every
    // subscriber while telling the caller nothing.
    const before = stored();

    expect(setTrackName('nope', 'zzz').ok).toBe(false);
    expect(setTrackInstrument('nope', 'bass').ok).toBe(false);
    expect(setTrackVoiceRef('nope', { kind: 'default' }).ok).toBe(false);
    expect(setTrackVolumeDb('nope', -6).ok).toBe(false);
    expect(setTrackMuted('nope', true).ok).toBe(false);
    expect(setTrackSoloed('nope', true).ok).toBe(false);

    expect(stored()).toBe(before);
  });

  it('skips a write that would set the value already there', () => {
    const id = storedTracks()[0].id;
    setTrackVolumeDb(id, -6);
    setTrackMuted(id, true);
    const settled = stored();

    setTrackVolumeDb(id, -6);
    setTrackMuted(id, true);

    // Identity, not equality: a fader dragged across a value it passes through
    // would otherwise persist the whole composition once per pointermove.
    expect(stored()).toBe(settled);
  });

  it('survives an undo of an unrelated edit', () => {
    // Settings push no undo step, but undo restores a WHOLE composition — so
    // without carrying them forward, a rename made after the last capture is
    // destroyed by an undo that had nothing to do with it.
    const id = storedTracks()[0].id;
    setTrackName(id, 'Rhythm');
    const placed = addPlacement(seedPattern('Riff'), id);
    expect(placed.ok).toBe(true);
    setTrackName(id, 'Lead');
    setTrackMuted(id, true);
    setCompositionBpm(96);

    undo();

    expect(storedPlacements()).toHaveLength(0);
    expect(storedTracks()[0].name).toBe('Lead');
    expect(storedTracks()[0].muted).toBe(true);
    expect(stored().bpm).toBe(96);
  });

  it('restores a removed track with the settings it had, not the survivor’s', () => {
    const added = addTrack('Second');
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    setTrackVolumeDb(added.value.id, -12);
    removeTrack(added.value.id);

    undo();

    // The track is back from the snapshot; there is no live copy to merge over
    // it, so its own settings are what returns.
    expect(storedTracks().at(-1)?.volumeDb).toBe(-12);
  });
});

describe('trackInstrumentId', () => {
  it('falls back to the default for an instrument the lib catalog has never heard of', () => {
    ensureComposition();
    // Straight through the store: the seam's own setter is typed to the catalog,
    // which is exactly why the resolver exists — persisted data isn't.
    const track = { ...storedTracks()[0], instrumentId: 'kazoo' } as Track;

    expect(trackInstrumentId(track)).toBe('guitar');
  });
});

// ----------------------------------------------------- composition settings ---

describe('composition settings round-trip through the store', () => {
  beforeEach(() => {
    ensureComposition();
  });

  it('writes name, bpm, time signature and loop', () => {
    setCompositionName('Opener');
    expect(stored().name).toBe('Opener');

    setCompositionBpm(132);
    expect(stored().bpm).toBe(132);

    setCompositionTimeSignature({ numerator: 6, denominator: 8 });
    expect(stored().timeSignature).toEqual({ numerator: 6, denominator: 8 });

    setCompositionLoop(true);
    expect(stored().loop).toBe(true);
  });
});

// ------------------------------------------------------------ placements ---

describe('placement writes round-trip through the store', () => {
  let trackId = '';
  let patternId = '';

  beforeEach(() => {
    ensureComposition();
    trackId = storedTracks()[0].id;
    patternId = seedPattern('Riff');
  });

  it('places a deep copy of the library pattern and selects it', () => {
    const result = addPlacement(patternId, trackId, 0);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(storedPlacements()).toHaveLength(1);
    expect(storedPlacements()[0].id).toBe(result.value);
    // Snapshot semantics: a copy that keeps the source id as provenance.
    expect(storedPlacements()[0].patternSnapshot.id).toBe(patternId);
    expect(getSelectedPlacementIds()).toEqual([result.value]);
  });

  it('refuses an unknown pattern or track', () => {
    expect(addPlacement('no-such-pattern', trackId).ok).toBe(false);
    expect(addPlacement(patternId, 'no-such-track').ok).toBe(false);
    expect(storedPlacements()).toHaveLength(0);
  });

  it('moves a placement, including across tracks', () => {
    const placed = addPlacement(patternId, trackId, 0);
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    const second = addTrack('Second');
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    movePlacement(placed.value, second.value.id, 4 * PPQ);

    expect(storedPlacements(0)).toHaveLength(0);
    expect(storedPlacements(1)).toHaveLength(1);
    expect(storedPlacements(1)[0].startTick).toBe(4 * PPQ);
    expect(findPlacement(placed.value)?.track.id).toBe(second.value.id);
  });

  it('splits, resizes and transposes', () => {
    const placed = addPlacement(patternId, trackId, 0);
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;

    setPlacementTranspose(placed.value, 5);
    expect(storedPlacements()[0].transposeSemitones).toBe(5);

    resizePlacement(placed.value, 2 * PPQ);
    expect(storedPlacements()[0].lengthTicks).toBe(2 * PPQ);

    splitPlacement(placed.value, PPQ);
    expect(storedPlacements()).toHaveLength(2);
    expect(storedPlacements().map((p) => p.lengthTicks)).toEqual([PPQ, PPQ]);
    // Both halves are NEW placements and the original is gone, so a selection
    // naming it would silently no-op every later gesture.
    expect(getSelectedPlacementIds()).not.toContain(placed.value);
    expect(usePatternsStore.getState().selectedPlacementId).not.toBe(placed.value);
  });

  it('duplicates a set of placements in one write', () => {
    const a = addPlacement(patternId, trackId, 0);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const span = storedPlacements()[0].patternSnapshot.durationTicks;

    duplicatePlacements([a.value], span);

    expect(storedPlacements()).toHaveLength(2);
    expect(storedPlacements().map((p) => p.startTick).sort((x, y) => x - y)).toEqual([
      0,
      span,
    ]);
  });

  it('removes a placement and drops it from the selection', () => {
    const placed = addPlacement(patternId, trackId, 0);
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;

    removePlacement(placed.value);

    expect(storedPlacements()).toHaveLength(0);
    expect(getSelectedPlacementIds()).toEqual([]);
    expect(findPlacement(placed.value)).toBeUndefined();
  });

  it('reports the arrangement length from the longest track', () => {
    expect(totalDurationTicks()).toBe(0);
    const placed = addPlacement(patternId, trackId, 0);
    expect(placed.ok).toBe(true);

    expect(totalDurationTicks()).toBe(
      storedPlacements()[0].patternSnapshot.durationTicks,
    );
  });

  it('measures a TRUNCATED placement by its own length, not its snapshot’s', () => {
    // LIB-GAP(11): the lib's `totalDurationTicks` never consults `lengthTicks`,
    // so it would still report the full snapshot here and the ruler would draw
    // up to 4× too much empty bar.
    const placed = addPlacement(patternId, trackId, 0);
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    const full = storedPlacements()[0].patternSnapshot.durationTicks;
    expect(full).toBeGreaterThan(PPQ);

    resizePlacement(placed.value, PPQ);

    expect(storedPlacements()[0].lengthTicks).toBe(PPQ);
    expect(totalDurationTicks()).toBe(PPQ);
  });
});

// -------------------------------------------------------------- selection ---

describe('placement selection', () => {
  let trackId = '';
  let ids: string[] = [];

  beforeEach(() => {
    ensureComposition();
    trackId = storedTracks()[0].id;
    const patternId = seedPattern('Riff');
    ids = [];
    // Three blocks laid end to end — the lib clamps a placement into the nearest
    // free slot, so appending without an explicit tick is what keeps them apart.
    for (let i = 0; i < 3; i += 1) {
      const placed = addPlacement(patternId, trackId);
      if (!placed.ok) throw new Error('placement refused');
      ids.push(placed.value);
    }
    selectPlacements([]);
  });

  it('holds a multi-selection app-side — the lib store has only one id', () => {
    // Deliberately not in placement order: `addPlacementToTrack` leaves the
    // store pointing at the last block placed, so selecting in that same order
    // would assert nothing about the sync.
    selectPlacements([ids[2], ids[0], ids[1]]);

    expect(getSelectedPlacementIds()).toEqual([ids[2], ids[0], ids[1]]);
    // The lib's single field tracks the primary (last-touched) id so anything
    // reading the store directly can't disagree with us about which is focused.
    expect(usePatternsStore.getState().selectedPlacementId).toBe(ids[1]);
  });

  it('adds without duplicating, and toggles', () => {
    selectPlacements([ids[0]]);
    selectPlacements([ids[1], ids[0]], 'add');
    expect(getSelectedPlacementIds()).toEqual([ids[0], ids[1]]);

    selectPlacements([ids[0], ids[2]], 'toggle');
    expect(getSelectedPlacementIds()).toEqual([ids[1], ids[2]]);

    selectPlacements([], 'replace');
    expect(getSelectedPlacementIds()).toEqual([]);
    expect(usePatternsStore.getState().selectedPlacementId).toBeNull();
  });

  it('drops ids an undo has retracted', () => {
    beginEditGesture();
    const fresh = addPlacement(seedPattern('Second riff'), trackId);
    endEditGesture();
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    selectPlacements([ids[0], fresh.value]);

    undo();

    expect(getSelectedPlacementIds()).toEqual([ids[0]]);
  });
});

// ------------------------------------------------------------------ hooks ---
// The only tests here that need a renderer. Everything else reads through the
// getters, and a getter cannot tell whether a subscriber was ever notified —
// deleting the notify from the selection writers leaves the rest of this file
// green while the arranger's highlight silently stops re-rendering.

describe('hooks re-render on the state they name', () => {
  let trackId = '';
  let patternId = '';

  beforeEach(() => {
    ensureComposition();
    trackId = storedTracks()[0].id;
    patternId = seedPattern('Riff');
  });

  it('reports the composition, its tracks and its length', () => {
    const view = renderHook(() => ({
      composition: useEditingComposition(),
      tracks: useTracks(),
      duration: useTotalDurationTicks(),
    }));
    expect(view.result.current.composition?.id).toBe(stored().id);
    expect(view.result.current.tracks).toHaveLength(1);
    expect(view.result.current.duration).toBe(0);

    act(() => {
      addTrack('Second');
      addPlacement(patternId, trackId, 0);
    });

    expect(view.result.current.tracks).toHaveLength(2);
    expect(view.result.current.duration).toBe(
      storedPlacements()[0].patternSnapshot.durationTicks,
    );
  });

  it('reports the placement selection', () => {
    const placed = addPlacement(patternId, trackId, 0);
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    selectPlacements([]);
    const view = renderHook(() => useSelectedPlacementIds());
    expect(view.result.current).toEqual([]);

    act(() => selectPlacements([placed.value]));

    expect(view.result.current).toEqual([placed.value]);
  });

  it('reports the track selection', () => {
    const view = renderHook(() => useSelectedTrackId());
    expect(view.result.current).toBeNull();

    act(() => selectTrack(trackId));

    expect(view.result.current).toBe(trackId);
  });

  it('reports what undo and redo can do', () => {
    const view = renderHook(() => useHistoryState());
    expect(view.result.current).toEqual({ canUndo: false, canRedo: false });

    act(() => {
      addPlacement(patternId, trackId, 0);
    });
    expect(view.result.current).toEqual({ canUndo: true, canRedo: false });

    act(() => undo());
    expect(view.result.current).toEqual({ canUndo: false, canRedo: true });
  });
});

// ---------------------------------------------------------------- history ---

describe('gesture batching', () => {
  let trackId = '';
  let placementId = '';

  beforeEach(() => {
    ensureComposition();
    trackId = storedTracks()[0].id;
    const placed = addPlacement(seedPattern('Riff'), trackId, 0);
    if (!placed.ok) throw new Error('placement refused');
    placementId = placed.value;
    clearHistory();
  });

  it('collapses N writes inside one begin/end into a single undo step', () => {
    beginEditGesture();
    for (let tick = PPQ; tick <= 8 * PPQ; tick += PPQ) {
      movePlacement(placementId, trackId, tick);
    }
    endEditGesture();
    expect(storedPlacements()[0].startTick).toBe(8 * PPQ);

    undo();

    expect(storedPlacements()[0].startTick).toBe(0);
    // One step, not eight: a second undo has nothing left to restore.
    undo();
    expect(storedPlacements()[0].startTick).toBe(0);
  });

  it('redoes the collapsed gesture as one step', () => {
    beginEditGesture();
    movePlacement(placementId, trackId, 2 * PPQ);
    movePlacement(placementId, trackId, 6 * PPQ);
    endEditGesture();
    undo();

    redo();

    expect(storedPlacements()[0].startTick).toBe(6 * PPQ);
  });

  it('records nothing when the gesture is abandoned', () => {
    // A step pushed here would snapshot the current state, so undoing it is
    // invisible — the only way to see it is to put a REAL step underneath and
    // check that one undo reaches past the abandoned gesture to it.
    movePlacement(placementId, trackId, 2 * PPQ);

    beginEditGesture();
    movePlacement(placementId, trackId, 4 * PPQ);
    endEditGesture(false);

    undo();

    expect(storedPlacements()[0].startTick).toBe(0);
  });

  it('records nothing for a gesture that wrote nothing', () => {
    // A pointer handler brackets every press, so a click that never became a
    // drag must not cost the user a dead undo.
    movePlacement(placementId, trackId, 2 * PPQ);

    beginEditGesture();
    endEditGesture();

    undo();
    expect(storedPlacements()[0].startTick).toBe(0);
  });

  /**
   * `history` keeps ONE gesture slot, so a nested `beginGesture` would overwrite
   * the outer snapshot and the inner `endGesture` would close the outer bracket
   * — after which every remaining write in the outer gesture captures a step of
   * its own. That is not hypothetical: every arrangement capability brackets
   * itself, so any shortcut pressed during a held drag nests one inside the
   * other, and so does a held arrow whose repeats are folded into one run.
   */
  it('collapses NESTED gestures into the outermost one', () => {
    beginEditGesture();
    movePlacement(placementId, trackId, 2 * PPQ);
    // An inner capability, bracketing itself exactly as it would if reached on
    // its own.
    beginEditGesture();
    movePlacement(placementId, trackId, 4 * PPQ);
    endEditGesture();
    // ...and the outer gesture carries on writing afterwards.
    movePlacement(placementId, trackId, 6 * PPQ);
    endEditGesture();

    expect(storedPlacements()[0].startTick).toBe(6 * PPQ);
    undo();
    expect(storedPlacements()[0].startTick).toBe(0);
    // One step for all three writes, not one plus however many followed the
    // inner close.
    undo();
    expect(storedPlacements()[0].startTick).toBe(0);
  });

  it('honours an explicit `changed` only on the outermost close', () => {
    movePlacement(placementId, trackId, PPQ);

    beginEditGesture();
    beginEditGesture();
    movePlacement(placementId, trackId, 4 * PPQ);
    // The inner caller discarding its own step must not discard the outer
    // gesture's — it does not own that decision.
    endEditGesture(false);
    endEditGesture();

    undo();
    expect(storedPlacements()[0].startTick).toBe(PPQ);
  });

  it('ignores an unmatched close rather than swallowing the next gesture', () => {
    // A stray `endEditGesture` with nothing open used to be harmless; with a
    // depth count it must not push the counter negative, or the next real
    // gesture's close would be treated as nested and never record a step.
    endEditGesture();

    beginEditGesture();
    movePlacement(placementId, trackId, 3 * PPQ);
    endEditGesture();

    undo();
    expect(storedPlacements()[0].startTick).toBe(0);
  });

  it('records one step per write outside a gesture', () => {
    movePlacement(placementId, trackId, 2 * PPQ);
    movePlacement(placementId, trackId, 6 * PPQ);

    undo();
    expect(storedPlacements()[0].startTick).toBe(2 * PPQ);
    undo();
    expect(storedPlacements()[0].startTick).toBe(0);
  });

  it('records no step for a write the lib declined', () => {
    // A declined write snapshots the CURRENT state, so undoing one is invisible
    // — the only way to see the spurious step is to put a real one under it and
    // check that a single undo reaches past the declined ones to it.
    movePlacement(placementId, trackId, 2 * PPQ);

    movePlacement('no-such-placement', trackId, 4 * PPQ);
    setPlacementTranspose('no-such-placement', 3);
    removePlacement('no-such-placement');

    undo();

    expect(storedPlacements()).toHaveLength(1);
    expect(storedPlacements()[0].startTick).toBe(0);
  });

  it('restores a removed placement', () => {
    removePlacement(placementId);
    expect(storedPlacements()).toHaveLength(0);

    undo();

    expect(storedPlacements()).toHaveLength(1);
    expect(storedPlacements()[0].id).toBe(placementId);
  });

  it('restores a removed track', () => {
    const added = addTrack('Second');
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    removeTrack(added.value.id);
    expect(storedTracks()).toHaveLength(1);

    undo();

    expect(storedTracks().map((t) => t.name)).toContain('Second');
  });

  it('drops a track selection the undo has retracted', () => {
    const added = addTrack('Second');
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    selectTrack(added.value.id);

    undo();

    // Otherwise the header highlights nothing while every write aimed at the
    // focused track is refused for a reason the user can't see.
    expect(storedTracks()).toHaveLength(1);
    expect(getSelectedTrackId()).toBeNull();

    redo();
    expect(getSelectedTrackId()).toBeNull();
  });
});
