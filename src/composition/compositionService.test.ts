import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PATTERNS_STATE,
  MAX_COMPOSITION_TRACKS,
  PPQ,
  TIME_SIGNATURES,
  usePatternsStore,
  type Composition,
  type SubdivisionId,
  type Track,
} from '@fretwork/lib';
import { getEditingPattern, openBlankPattern } from '../patterns/patternService';
import {
  abortEditGesture,
  addPlacement,
  addTrack,
  asJobWrite,
  beginEditGesture,
  beginJob,
  clearHistory,
  compositionGrooveId,
  deleteComposition,
  duplicateComposition,
  duplicatePlacements,
  endEditGesture,
  endJob,
  ensureComposition,
  findLibraryComposition,
  findPlacement,
  getEditingComposition,
  getLibraryCompositions,
  getEditingPlacementId,
  getSelectedPlacementIds,
  getSelectedTrackId,
  isJobRunning,
  JOB_LOCK_REASON,
  moveTrack,
  movePlacement,
  openBlankComposition,
  openComposition,
  openPlacementForEditing,
  renameComposition,
  redo,
  removePlacement,
  removeTrack,
  resizePlacement,
  selectPlacements,
  selectTrack,
  setCompositionBpm,
  setCompositionGroove,
  setCompositionLoop,
  setCompositionName,
  setCompositionSubdivision,
  setCompositionTimeSignature,
  setMasterVolumeDb,
  setPlacementTranspose,
  setTrackInstrument,
  setTrackMuted,
  setTrackName,
  setTrackSoloed,
  setTrackVoiceRef,
  setTrackVolumeDb,
  setTrackPan,
  splitPlacement,
  totalDurationTicks,
  trackInstrumentId,
  undo,
  useEditingComposition,
  useHistoryState,
  useIsJobRunning,
  useLibraryCompositions,
  useSelectedPlacementIds,
  useSelectedTrackId,
  useTotalDurationTicks,
  useTracks,
  type Result,
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
  // The job flag is module state and outlives a failing test, so a leaked one
  // would refuse every write in every test that followed — with the seam's own
  // sentence, which reads like a real refusal and would send someone hunting.
  endJob();
  // Bracket DEPTH is module state too, and `clearHistory` deliberately preserves
  // it (see there). A test that threw between `beginEditGesture` and its close
  // would leave the count raised, and every gesture after it would look nested
  // and push no step — a failure landing nowhere near its cause. Nothing can read
  // the depth and `endEditGesture` is a no-op at zero, so close generously:
  // deeper than any test here nests.
  for (let i = 0; i < 8; i += 1) endEditGesture(false);
  clearHistory();
  selectPlacements([]);
  selectTrack(null);
});

// ------------------------------------------------------------- lifecycle ---

describe('ensureComposition', () => {
  it('CREATES NOTHING when the library is empty, and says so with ok(null)', () => {
    // CP-17 changed this deliberately. It used to seed "Untitled composition"
    // on arrival, which minted a document nobody asked for and made the empty
    // state something you could only be in until you navigated. `null` is not a
    // failure — the page renders its empty state and its New button — so the
    // page's error branch must not fire.
    const result = ensureComposition();

    expect(result).toEqual({ ok: true, value: null });
    expect(usePatternsStore.getState().library.compositions).toEqual([]);
    expect(usePatternsStore.getState().editingCompositionId).toBeNull();
  });

  it('opens the most recently updated composition when one exists', () => {
    openBlankComposition('Older');
    const olderId = stored().id;
    openBlankComposition('Newer');
    const newerId = stored().id;
    // Nothing open, both still in the library — the state after a delete, and
    // the state on arriving at the page in a new tab.
    usePatternsStore.setState({ editingCompositionId: null });
    usePatternsStore.setState((state) => ({
      library: {
        ...state.library,
        compositions: state.library.compositions.map((c) =>
          c.id === newerId ? { ...c, updatedAt: 20_000 } : { ...c, updatedAt: 10_000 },
        ),
      },
    }));

    const result = ensureComposition();

    expect(result.ok && result.value?.id).toBe(newerId);
    expect(olderId).not.toBe(newerId);
    expect(usePatternsStore.getState().library.compositions).toHaveLength(2);
  });

  it('keeps the open composition rather than adopting another', () => {
    openBlankComposition('First');
    const firstId = stored().id;
    openBlankComposition('Second');
    const secondId = stored().id;

    const result = ensureComposition();

    expect(result.ok && result.value?.id).toBe(secondId);
    expect(secondId).not.toBe(firstId);
  });

  it('forgets per-composition state when it adopts a different one', () => {
    // Adopting is a switch like any other: a carried-over selection names
    // blocks in a document that is no longer open.
    openBlankComposition('Song');
    const trackId = storedTracks()[0].id;
    const patternId = seedPattern('Riff');
    addPlacement(patternId, trackId);
    selectTrack(trackId);
    expect(getSelectedPlacementIds()).toHaveLength(1);
    usePatternsStore.setState({ editingCompositionId: null });

    ensureComposition();

    expect(getSelectedPlacementIds()).toEqual([]);
    expect(getSelectedTrackId()).toBeNull();
  });
});

describe('openBlankComposition', () => {
  it('creates a composition, opens it, and clears selection and history', () => {
    openBlankComposition('Song');
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

describe('the composition library', () => {
  it('lists what the store holds, and finds one by id', () => {
    openBlankComposition('One');
    const oneId = stored().id;
    openBlankComposition('Two');

    expect(getLibraryCompositions().map((c) => c.name)).toEqual(['One', 'Two']);
    expect(findLibraryComposition(oneId)?.name).toBe('One');
    expect(findLibraryComposition('nope')).toBeUndefined();
  });

  it('re-renders a subscriber when the library changes', () => {
    const view = renderHook(() => useLibraryCompositions());
    expect(view.result.current).toEqual([]);

    act(() => {
      openBlankComposition('One');
    });

    expect(view.result.current).toHaveLength(1);
    view.unmount();
  });

  it('gives a new blank composition a name unique in the library', () => {
    // The lib names every blank "Untitled composition" flat. With a New button
    // in the rail this is reachable in two clicks, and two rows with one name
    // between them cannot be told apart.
    openBlankComposition();
    openBlankComposition();

    const names = getLibraryCompositions().map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('openComposition', () => {
  it('switches the open composition and forgets the previous one\'s state', () => {
    openBlankComposition('First');
    const firstId = stored().id;
    const trackId = storedTracks()[0].id;
    const patternId = seedPattern('Riff');
    addPlacement(patternId, trackId);
    selectTrack(trackId);
    openBlankComposition('Second');

    const result = openComposition(firstId);

    expect(result.ok && result.value.id).toBe(firstId);
    expect(usePatternsStore.getState().editingCompositionId).toBe(firstId);
    expect(getSelectedPlacementIds()).toEqual([]);
    expect(getSelectedTrackId()).toBeNull();
  });

  it('drops history, so an undo cannot write back into the composition it left', () => {
    openBlankComposition('First');
    const firstId = stored().id;
    openBlankComposition('Second');
    const secondId = stored().id;
    const trackId = storedTracks()[0].id;
    const patternId = seedPattern('Riff');
    addPlacement(patternId, trackId);
    expect(storedPlacements()).toHaveLength(1);

    openComposition(firstId);
    undo();

    // The discriminating assertion is on SECOND: an uncleared stack would hold
    // its pre-placement snapshot and this undo would write it back, deleting a
    // block from a composition nobody is looking at.
    const second = usePatternsStore
      .getState()
      .library.compositions.find((c) => c.id === secondId);
    expect(second?.tracks[0].placements).toHaveLength(1);
  });

  it('refuses an id that is not in the library', () => {
    openBlankComposition('Only');

    expect(openComposition('nope')).toEqual({
      ok: false,
      reason: expect.stringContaining('No such composition'),
    });
  });

  it('is refused while a job holds the document — the agent included', () => {
    // Not `lockedOut()`: switching composition mid-job destroys the rollback,
    // because `forgetPerCompositionState` re-arms the bracket on the NEW
    // document. `openBlankComposition` is guarded the same way and says why.
    openBlankComposition('First');
    const firstId = stored().id;
    openBlankComposition('Second');
    const held = beginJob();
    if (!held.ok) throw new Error('job refused');
    try {
      expect(openComposition(firstId)).toEqual({ ok: false, reason: JOB_LOCK_REASON });
      const asAgent: Result<Composition> = asJobWrite(() => openComposition(firstId));
      expect(asAgent).toEqual({ ok: false, reason: JOB_LOCK_REASON });
    } finally {
      held.value();
    }
  });
});

describe('renameComposition', () => {
  it('renames by id, whether or not it is the one open', () => {
    openBlankComposition('First');
    const firstId = stored().id;
    openBlankComposition('Second');

    const result = renameComposition(firstId, '  Blues in C  ');

    expect(result.ok).toBe(true);
    expect(findLibraryComposition(firstId)?.name).toBe('Blues in C');
    // Renaming another row must not switch what is open.
    expect(stored().name).toBe('Second');
  });

  it('refuses an empty name', () => {
    // Ours, not the lib's: `renameComposition` writes whatever it is given, and
    // a composition named '' has no handle left in any list.
    openBlankComposition('Song');
    const id = stored().id;

    expect(renameComposition(id, '   ')).toEqual({
      ok: false,
      reason: expect.stringContaining('needs a name'),
    });
    expect(findLibraryComposition(id)?.name).toBe('Song');
  });

  it('refuses an id that is not in the library', () => {
    expect(renameComposition('nope', 'x')).toEqual({
      ok: false,
      reason: expect.stringContaining('No such composition'),
    });
  });
});

describe('duplicateComposition', () => {
  it('copies the tracks and their placements without opening the copy', () => {
    openBlankComposition('Song');
    const sourceId = stored().id;
    const trackId = storedTracks()[0].id;
    const patternId = seedPattern('Riff');
    addPlacement(patternId, trackId);

    const result = duplicateComposition(sourceId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).not.toBe(sourceId);
    expect(result.value.tracks[0].placements).toHaveLength(1);
    // Deep copy: editing the copy must not reach the original.
    expect(result.value.tracks[0].id).not.toBe(trackId);
    // Not opened — a duplicate is usually made to keep the original safe.
    expect(usePatternsStore.getState().editingCompositionId).toBe(sourceId);
  });

  it('names the copy so the two can be told apart', () => {
    // `forkComposition` keeps the source name verbatim — it is built for forking
    // someone else's published work, not for a local copy. See LIB-GAP(22).
    openBlankComposition('Song');
    const sourceId = stored().id;

    const result = duplicateComposition(sourceId);

    expect(result.ok && result.value.name).not.toBe('Song');
    const names = getLibraryCompositions().map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('refuses an id that is not in the library', () => {
    expect(duplicateComposition('nope')).toEqual({
      ok: false,
      reason: expect.stringContaining('No such composition'),
    });
  });
});

describe('deleteComposition', () => {
  it('removes it and leaves NOTHING open when it was the one being arranged', () => {
    // CP-17: no successor is chased. "Nothing open" is a state the page renders
    // properly, and this ticket is what gives it a way out.
    openBlankComposition('Only');
    const id = stored().id;

    const result = deleteComposition(id);

    expect(result.ok).toBe(true);
    expect(getLibraryCompositions()).toEqual([]);
    expect(usePatternsStore.getState().editingCompositionId).toBeNull();
    expect(getEditingComposition()).toBeNull();
  });

  it('clears the selection and history that belonged to it', () => {
    openBlankComposition('Song');
    const id = stored().id;
    const trackId = storedTracks()[0].id;
    const patternId = seedPattern('Riff');
    addPlacement(patternId, trackId);
    selectTrack(trackId);

    deleteComposition(id);

    expect(getSelectedPlacementIds()).toEqual([]);
    expect(getSelectedTrackId()).toBeNull();
    expect(canUndo()).toBe(false);
  });

  it('leaves the open composition alone when another row is deleted', () => {
    openBlankComposition('Other');
    const otherId = stored().id;
    openBlankComposition('Open');
    const openId = stored().id;

    deleteComposition(otherId);

    expect(usePatternsStore.getState().editingCompositionId).toBe(openId);
    expect(getLibraryCompositions().map((c) => c.name)).toEqual(['Open']);
  });

  it('refuses an id that is not in the library', () => {
    expect(deleteComposition('nope')).toEqual({
      ok: false,
      reason: expect.stringContaining('No such composition'),
    });
  });

  it('is refused while a job holds the document — the agent included', () => {
    openBlankComposition('Song');
    const id = stored().id;
    const held = beginJob();
    if (!held.ok) throw new Error('job refused');
    try {
      expect(deleteComposition(id)).toEqual({ ok: false, reason: JOB_LOCK_REASON });
      const asAgent: Result<Composition> = asJobWrite(() => deleteComposition(id));
      expect(asAgent).toEqual({ ok: false, reason: JOB_LOCK_REASON });
    } finally {
      held.value();
    }
  });
});

// ---------------------------------------------------------------- tracks ---

describe('addTrack', () => {
  beforeEach(() => {
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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

  /* CP-19. Pan is the missing half of the pair volume already has: the VOICE
     carries the sound's own stereo image, the TRACK carries where that sound
     sits in this mix. Everything here mirrors the fader's seam, including
     returning the value actually stored rather than the one requested. */
  describe('pan', () => {
    it('writes it, and reports the value actually stored', () => {
      const id = storedTracks()[0].id;
      const result = setTrackPan(id, -0.5);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(-0.5);
      expect(storedTracks()[0].pan).toBe(-0.5);
    });

    it('starts a new track centred', () => {
      expect(storedTracks()[0].pan ?? 0).toBe(0);
    });

    it('clamps out of range and REPORTS the clamped value', () => {
      // The agent is the caller that can send 2, and the one least able to
      // notice a silent coercion — so the reply carries what is playing.
      const id = storedTracks()[0].id;
      const result = setTrackPan(id, 2);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(1);
      expect(storedTracks()[0].pan).toBe(1);
    });

    it('refuses a non-number rather than storing NaN', () => {
      const id = storedTracks()[0].id;
      expect(setTrackPan(id, Number.NaN).ok).toBe(false);
      expect(storedTracks()[0].pan ?? 0).toBe(0);
    });

    it('skips a write that would set the value already there', () => {
      // Identity, not equality: this control is DRAGGED, so every value it
      // passes through would otherwise persist the whole composition and
      // re-render every subscriber once per pointermove.
      const id = storedTracks()[0].id;
      setTrackPan(id, 0.25);
      const settled = stored();
      setTrackPan(id, 0.25);
      expect(stored()).toBe(settled);
    });

    it('compares against the CLAMPED value, so a repeated out-of-range call settles', () => {
      const id = storedTracks()[0].id;
      setTrackPan(id, 5);
      const settled = stored();
      setTrackPan(id, 5);
      expect(stored()).toBe(settled);
    });

    it('is not undoable — it is mix, not arrangement', () => {
      const id = storedTracks()[0].id;
      const placed = addPlacement(seedPattern('Riff'), id);
      expect(placed.ok).toBe(true);
      setTrackPan(id, -1);

      undo();

      expect(storedPlacements()).toHaveLength(0);
      expect(storedTracks()[0].pan).toBe(-1);
    });
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
    expect(setTrackPan('nope', -0.5).ok).toBe(false);
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
    openBlankComposition('Song');
    // Straight through the store: the seam's own setter is typed to the catalog,
    // which is exactly why the resolver exists — persisted data isn't.
    const track = { ...storedTracks()[0], instrumentId: 'kazoo' } as Track;

    expect(trackInstrumentId(track)).toBe('guitar');
  });
});

// ----------------------------------------------------- composition settings ---

describe('time signature and subdivision (CP-18)', () => {
  it('saves the time signature ON THE COMPOSITION, where the grid reads it', () => {
    openBlankComposition('Song');

    const result = setCompositionTimeSignature({ numerator: 3, denominator: 4 });

    expect(result.ok).toBe(true);
    // Read through the STORE, not the seam's getter: a value cached in a module
    // variable would pass a getter check and lose the user's meter on reload.
    expect(stored().timeSignature).toEqual({ numerator: 3, denominator: 4 });
  });

  it('refuses a meter the lib has no catalog entry for', () => {
    // The seam took ANY numerator/denominator, and the agent reaches it by value.
    // A 4/7 bar is 1097.142… ticks, so no bar after the first starts on one —
    // `composition_place_pattern` already has to refuse bar input in that case.
    openBlankComposition('Song');

    const result = setCompositionTimeSignature({ numerator: 4, denominator: 7 });

    expect(result).toEqual({ ok: false, reason: expect.stringContaining('4/7') });
    expect(stored().timeSignature).toEqual({ numerator: 4, denominator: 4 });
  });

  it('accepts every meter the catalog ships', () => {
    openBlankComposition('Song');

    for (const ts of TIME_SIGNATURES) {
      const result = setCompositionTimeSignature({
        numerator: ts.numerator,
        denominator: ts.denominator,
      });
      expect(`${ts.id}: ${result.ok}`).toBe(`${ts.id}: true`);
    }
  });

  it('saves the click subdivision on the composition', () => {
    openBlankComposition('Song');

    expect(setCompositionSubdivision('8ths').ok).toBe(true);

    expect(stored().subdivision).toBe('8ths');
  });

  it('refuses a subdivision the metronome has no setting for', () => {
    openBlankComposition('Song');

    expect(setCompositionSubdivision('quintuplets' as SubdivisionId)).toEqual({
      ok: false,
      reason: expect.stringContaining('quintuplets'),
    });
  });

  it('refuses both while a job holds the document', () => {
    openBlankComposition('Song');
    const held = beginJob();
    if (!held.ok) throw new Error('job refused');
    try {
      expect(setCompositionTimeSignature({ numerator: 3, denominator: 4 })).toEqual({
        ok: false,
        reason: JOB_LOCK_REASON,
      });
      expect(setCompositionSubdivision('8ths')).toEqual({
        ok: false,
        reason: JOB_LOCK_REASON,
      });
    } finally {
      held.value();
    }
  });
});

describe('composition settings round-trip through the store', () => {
  beforeEach(() => {
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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

// ------------------------------------------------------------- rollback ---

/**
 * AG-07. The bracket-closer that puts the document back instead of recording a
 * step — how a cancelled generation job stops being the user's problem.
 *
 * The assertions that matter are the two negatives: the arrangement is the one
 * the bracket opened on, and NO undo step exists afterwards. The second is
 * invisible in the document (a spurious step snapshots the state it restores),
 * which is what `canUndo` is for.
 */
describe('abortEditGesture', () => {
  let trackId = '';
  let placementId = '';

  beforeEach(() => {
    openBlankComposition('Song');
    trackId = storedTracks()[0].id;
    const placed = addPlacement(seedPattern('Riff'), trackId, 0);
    if (!placed.ok) throw new Error('placement refused');
    placementId = placed.value;
    clearHistory();
  });

  it('restores the arrangement and records no step', () => {
    const before = storedPlacements();

    beginEditGesture();
    addTrack('Agent');
    addPlacement(seedPattern('Chorus'), trackId, 16 * PPQ);
    removePlacement(placementId);
    expect(storedTracks()).toHaveLength(2);

    abortEditGesture();

    expect(storedTracks()).toHaveLength(1);
    // Byte-for-byte, not merely "the right number of blocks": the placement is
    // the object the snapshot held, ids and all.
    expect(storedPlacements()).toEqual(before);
    // The whole difference from `undo`. A step here would be a cancel the user
    // could un-cancel into a half-built arrangement.
    expect(canUndo()).toBe(false);
  });

  /**
   * The one place this parts company with `undo`, and the reviewers' finding:
   * `undo` merges the live settings FORWARD, because its caller is the user and
   * the mix pushes no step of its own. A cancel cannot borrow that argument — the
   * job lock refuses the user every field that merge carries, so the only writer
   * of any of them during a job is the agent, and carrying them forward would
   * mean cancelling a job that keeps the tempo and mix it chose.
   */
  it('restores the settings too, unlike undo', () => {
    const beforeBpm = stored().bpm;
    const beforeVolume = storedTracks()[0].volumeDb;

    beginEditGesture();
    addTrack('Agent');
    setTrackVolumeDb(trackId, -6);
    setCompositionBpm(132);
    setTrackName(trackId, 'Rhythm');
    setCompositionGroove('swing-8ths');

    abortEditGesture();

    expect(storedTracks()).toHaveLength(1);
    expect(storedTracks()[0].volumeDb).toBe(beforeVolume);
    expect(storedTracks()[0].name).not.toBe('Rhythm');
    expect(stored().bpm).toBe(beforeBpm);
    // `groove` was never in `mergeSettingsForward`'s list, so the merged restore
    // half-reverted a single `composition_set_settings({bpm, groove})`. Verbatim
    // is what makes the two agree.
    expect(compositionGrooveId()).not.toBe('swing-8ths');
  });

  /** `undo` keeps merging them forward — that caller IS the user, and its
   *  rationale is untouched by this. Asserted so the asymmetry is pinned on both
   *  sides rather than only the new one. */
  it('leaves undo merging the live settings forward', () => {
    movePlacement(placementId, trackId, 2 * PPQ);
    setTrackVolumeDb(trackId, -6);

    undo();

    expect(storedPlacements()[0].startTick).toBe(0);
    expect(storedTracks()[0].volumeDb).toBe(-6);
  });

  it('closes a placement the restore has retracted', () => {
    beginEditGesture();
    const placed = addPlacement(seedPattern('Chorus'), trackId, 16 * PPQ);
    if (!placed.ok) throw new Error('placement refused');
    expect(openPlacementForEditing(placed.value).ok).toBe(true);
    expect(getEditingPlacementId()).toBe(placed.value);

    abortEditGesture();

    // The lib nulls its pointer only when its OWN `removePlacement` runs, and a
    // restore is a raw setState (LIB-GAP(1)). Left dangling, every note edit
    // would silently hit nothing.
    expect(getEditingPlacementId()).toBeNull();
  });

  it('leaves the stacks alone, so the user’s own last edit is still the undo target', () => {
    movePlacement(placementId, trackId, 2 * PPQ);

    beginEditGesture();
    movePlacement(placementId, trackId, 6 * PPQ);
    abortEditGesture();

    expect(storedPlacements()[0].startTick).toBe(2 * PPQ);
    undo();
    expect(storedPlacements()[0].startTick).toBe(0);
  });

  it('drops a selection the restore has retracted', () => {
    beginEditGesture();
    const placed = addPlacement(seedPattern('Chorus'), trackId, 16 * PPQ);
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    // `addPlacement` selects what it created, so the selection now names a block
    // the rollback is about to take away.
    expect(getSelectedPlacementIds()).toEqual([placed.value]);

    abortEditGesture();

    expect(getSelectedPlacementIds()).toEqual([]);
  });

  it('drops a track focus the restore has retracted', () => {
    beginEditGesture();
    const added = addTrack('Agent');
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    selectTrack(added.value.id);

    abortEditGesture();

    expect(getSelectedTrackId()).toBeNull();
  });

  /**
   * The documented degradation. Depth is honoured exactly as `endEditGesture`
   * honours it — that symmetry is what keeps "one gesture, one step" true — so
   * an abort inside an open inner bracket only decrements, and the outer close
   * then records an ordinary step. One undo instead of an automatic rollback.
   */
  it('only decrements when an inner bracket is still open', () => {
    beginEditGesture();
    beginEditGesture();
    movePlacement(placementId, trackId, 4 * PPQ);

    abortEditGesture();

    expect(storedPlacements()[0].startTick).toBe(4 * PPQ);
    endEditGesture();
    expect(canUndo()).toBe(true);
    undo();
    expect(storedPlacements()[0].startTick).toBe(0);
  });

  it('ignores an unmatched abort rather than swallowing the next gesture', () => {
    // Same hazard `endEditGesture` guards: pushing the counter negative would
    // make the next real close look nested and record nothing.
    abortEditGesture();

    beginEditGesture();
    movePlacement(placementId, trackId, 3 * PPQ);
    endEditGesture();

    undo();
    expect(storedPlacements()[0].startTick).toBe(0);
  });
});

// ------------------------------------------------------------- job lock ---

/**
 * AG-07. While an agent job owns the document the USER's writes are refused and
 * the job's own go through — because a cancel rolls the document back, and
 * anything the user built meanwhile would be rolled back with it.
 *
 * `asJobWrite` stands in for a tool handler here, which is exactly what it is:
 * `compositionTools` wraps every handler in it, and the handlers are synchronous
 * so nothing of the user's can run inside one.
 */
describe('the job lock', () => {
  let trackId = '';
  let placementId = '';

  beforeEach(() => {
    openBlankComposition('Song');
    trackId = storedTracks()[0].id;
    const placed = addPlacement(seedPattern('Riff'), trackId, 0);
    if (!placed.ok) throw new Error('placement refused');
    placementId = placed.value;
    clearHistory();
  });

  /** Every write the seam guards, as a thunk. The guard is one line copied into
   *  each of them, which is the failure the lock's own header rejects for props
   *  — so it is checked in one place rather than trusted twenty-odd times. The
   *  day someone adds an unguarded write, this list is what fails. */
  function guardedWrites(): readonly (readonly [string, () => Result<unknown>])[] {
    const otherTrack = storedTracks()[0].id;
    return [
      ['openBlankComposition', () => openBlankComposition('X')],
      ['addTrack', () => addTrack('Mine')],
      ['removeTrack', () => removeTrack(trackId)],
      ['moveTrack', () => moveTrack(trackId, 0)],
      ['setTrackName', () => setTrackName(trackId, 'Mine')],
      ['setTrackInstrument', () => setTrackInstrument(trackId, 'bass')],
      ['setTrackVoiceRef', () => setTrackVoiceRef(trackId, { id: 'x' })],
      ['setTrackVolumeDb', () => setTrackVolumeDb(trackId, -3)],
      ['setTrackPan', () => setTrackPan(trackId, -0.5)],
      ['setTrackMuted', () => setTrackMuted(trackId, true)],
      ['setTrackSoloed', () => setTrackSoloed(trackId, true)],
      ['setMasterVolumeDb', () => setMasterVolumeDb(-3)],
      ['addPlacement', () => addPlacement(seedPattern('Mine'), otherTrack, 32 * PPQ)],
      ['movePlacement', () => movePlacement(placementId, trackId, 8 * PPQ)],
      ['splitPlacement', () => splitPlacement(placementId, 2 * PPQ)],
      ['resizePlacement', () => resizePlacement(placementId, 2 * PPQ)],
      ['setPlacementTranspose', () => setPlacementTranspose(placementId, 2)],
      ['removePlacement', () => removePlacement(placementId)],
      ['duplicatePlacements', () => duplicatePlacements([placementId], 16 * PPQ)],
      ['openPlacementForEditing', () => openPlacementForEditing(placementId)],
      ['setCompositionName', () => setCompositionName('Mine')],
      ['setCompositionBpm', () => setCompositionBpm(140)],
      [
        'setCompositionTimeSignature',
        () => setCompositionTimeSignature({ numerator: 3, denominator: 4 }),
      ],
      ['setCompositionLoop', () => setCompositionLoop(true)],
      ['setCompositionGroove', () => setCompositionGroove('swing-8ths')],
    ];
  }

  it('refuses every user write it guards, with the same sentence', () => {
    const before = stored();
    beginJob();

    for (const [name, write] of guardedWrites()) {
      const result = write();
      expect(`${name}: ${result.ok}`).toBe(`${name}: false`);
      if (result.ok) continue;
      // A sentence, not a silence: the five components that write here all
      // render the seam's reason already, which is why the lock needs no new UI.
      expect(result.reason).toBe(JOB_LOCK_REASON);
    }

    // Nothing landed, so the rollback cannot be taking anything of the user's.
    expect(stored()).toEqual(before);
  });

  /** The other half, and deliberately about the REASON rather than success: the
   *  list mutates the document as it runs (and `openBlankComposition` switches
   *  it), so later entries legitimately refuse for their own reasons. What must
   *  never appear with no job running is the lock's sentence. */
  it('refuses none of them for the lock’s reason once the job hands it back', () => {
    const held = beginJob();
    if (!held.ok) throw new Error('job refused');
    held.value();

    for (const [name, write] of guardedWrites()) {
      const result = write();
      if (result.ok) continue;
      expect(`${name}: ${result.reason}`).not.toBe(`${name}: ${JOB_LOCK_REASON}`);
    }
  });

  it('reports itself running, and tells its subscribers', () => {
    const seen: boolean[] = [];
    const view = renderHook(() => useIsJobRunning());
    expect(view.result.current).toBe(false);

    act(() => {
      beginJob();
    });
    seen.push(view.result.current);
    act(() => {
      endJob();
    });
    seen.push(view.result.current);
    view.unmount();

    // Without the notification the flag is unreadable from React, and the undo
    // button stays enabled and dead for the length of the run.
    expect(seen).toEqual([true, false]);
    expect(isJobRunning()).toBe(false);
  });

  it('lets the job’s own writes through the same lock', () => {
    beginJob();

    const added = asJobWrite(() => addTrack('Agent'));

    expect(added.ok).toBe(true);
    expect(storedTracks()).toHaveLength(2);
    // And the exemption is not left raised behind it.
    expect(addTrack('Mine').ok).toBe(false);
  });

  it('refuses a second job rather than letting two roll back over each other', () => {
    expect(beginJob().ok).toBe(true);
    expect(beginJob().ok).toBe(false);
  });

  it('refuses a job with no document to own', () => {
    usePatternsStore.setState({ editingCompositionId: null });

    const started = beginJob();

    // A job with nothing open would lock the user out while every one of its own
    // writes answered "No composition is open."
    expect(started.ok).toBe(false);
    expect(isJobRunning()).toBe(false);
  });

  it('hands the release to the holder, and only the holder', () => {
    const held = beginJob();
    expect(held.ok).toBe(true);
    if (!held.ok) return;

    // The loser's own `finally` must not unlock the winner.
    const refused = beginJob();
    expect(refused.ok).toBe(false);
    expect(isJobRunning()).toBe(true);

    held.value();
    expect(isJobRunning()).toBe(false);
    // ...and a second release is a no-op rather than a lock the NEXT job loses.
    const second = beginJob();
    expect(second.ok).toBe(true);
    held.value();
    expect(isJobRunning()).toBe(true);
  });

  /**
   * The agent's exemption deliberately does NOT reach this one.
   * `openBlankComposition` clears the history, and `clearHistory` re-arms the
   * open bracket on the NEW document — so the snapshot a cancel would restore
   * becomes the blank composition and the pre-job one is never put back.
   */
  it('refuses a composition switch to the job itself, not only to the user', () => {
    const openBefore = usePatternsStore.getState().editingCompositionId;
    beginEditGesture();
    beginJob();

    const switched = asJobWrite(() => openBlankComposition('Stray'));

    expect(switched.ok).toBe(false);
    expect(usePatternsStore.getState().editingCompositionId).toBe(openBefore);
    expect(usePatternsStore.getState().library.compositions).toHaveLength(1);
    endJob();
    abortEditGesture();
  });

  it('covers edit mode, so the pattern pointer cannot be repointed under a job', () => {
    // A composition job creates patterns, and the lib keeps ONE pattern-editing
    // pointer — the user opening a block mid-job would take it, and the agent's
    // next note would land in the user's block.
    beginJob();
    expect(openPlacementForEditing(placementId).ok).toBe(false);

    endJob();
    expect(openPlacementForEditing(placementId).ok).toBe(true);
  });

  it('leaves undo and redo inert for the duration, and draws them inert', () => {
    movePlacement(placementId, trackId, 2 * PPQ);
    beginJob();

    undo();

    // Undoing into a document the agent is still writing would leave a hybrid
    // neither side asked for; cancelling the job is the way out during one.
    expect(storedPlacements()[0].startTick).toBe(2 * PPQ);
    // These two are the only writes here with no channel to refuse through, so
    // the buttons must not be left LOOKING alive — that is the one refusal in
    // the design with no feedback at all.
    expect(canUndo()).toBe(false);

    endJob();
    undo();
    expect(storedPlacements()[0].startTick).toBe(0);

    // And redo, which is a separate guard and would otherwise be asserted by
    // nothing: deleting its `lockedOut()` line has to fail something.
    beginJob();
    redo();
    expect(storedPlacements()[0].startTick).toBe(0);
    endJob();
    redo();
    expect(storedPlacements()[0].startTick).toBe(2 * PPQ);
  });

  it('does not lock selection — the user can still look while they wait', () => {
    beginJob();

    selectPlacements([placementId]);
    selectTrack(trackId);

    expect(getSelectedPlacementIds()).toEqual([placementId]);
    expect(getSelectedTrackId()).toBe(trackId);
  });

  /**
   * THE PATH THAT WILL ACTUALLY HAPPEN: a job builds for a while, the user
   * presses cancel, and everything the agent did goes away in one movement while
   * the user is refused nothing they could have lost.
   */
  it('rolls a cancelled job back to the document it started from', () => {
    const before = stored();

    beginEditGesture();
    const started = beginJob();
    if (!started.ok) throw new Error('job refused');

    asJobWrite(() => addTrack('Bass'));
    const bassId = storedTracks()[1].id;
    asJobWrite(() => addPlacement(seedPattern('Bassline'), bassId, 0));
    asJobWrite(() => addPlacement(seedPattern('Bassline 2'), bassId, 16 * PPQ));
    asJobWrite(() => removePlacement(placementId));
    // The agent balanced the mix and renamed the piece on the way — SETTINGS,
    // which push no undo step. They are the agent's, not the user's, because the
    // lock refused the user every one of those fields for the duration.
    asJobWrite(() => setTrackVolumeDb(trackId, -4));
    asJobWrite(() => setCompositionName('Half a song'));
    // ...and the user's own edit was refused the whole time, so the rollback
    // below cannot be taking anything of theirs with it.
    expect(addPlacement(seedPattern('Mine'), trackId, 32 * PPQ).ok).toBe(false);

    started.value();
    abortEditGesture();

    // Byte-for-byte the document the bracket opened on — the mix and the title
    // the agent chose included, since cancelling a job that keeps the tempo and
    // name it picked is not what "cancel" means.
    expect(stored()).toEqual(before);
    // One cancel, no undo step — not "the agent's work, one Ctrl-Z away".
    expect(canUndo()).toBe(false);
    // And the seam is handed back: the next user write lands.
    expect(addTrack('Mine').ok).toBe(true);
  });
});
