import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_PATTERNS_STATE,
  PPQ,
  usePatternsStore,
  type Placement,
} from '@fretwork/lib';
import { App } from '../src/App';
import { ArrangementGrid } from '../src/composition/ArrangementGrid';
import { laneGridImage } from '../src/timeline/timelineMath';

// Spied, not replaced: the real implementation still draws, and what this file
// needs to see is WHICH METER the surface hands it — see the CP-18 block below.
vi.mock('../src/timeline/timelineMath', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/timeline/timelineMath')>();
  return { ...actual, laneGridImage: vi.fn(actual.laneGridImage) };
});

/**
 * WHICH BLOCK WAS THE TARGET when an undo bracket closed.
 *
 * The only way to see the ORDER milestone 3 §B is about. A bracket closed
 * against the outgoing block records that block's id; one closed by a React
 * effect cleanup — which runs after the commit, and so after the editor has
 * already been closed or repointed — records whatever the target is by then.
 * Both leave the same history behind (`openPlacementForEditing` and
 * `closePlacementEditing` each clear it), so nothing downstream can tell them
 * apart: this is the seam where the difference is visible.
 */
const closes = vi.hoisted(() => ({ at: [] as (string | null)[] }));
vi.mock('../src/patterns/patternService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/patterns/patternService')>();
  // Imported HERE rather than closed over from the module body: a mock factory
  // runs during the import phase, before this file's own bindings exist.
  const { usePatternsStore: store } = await import('@fretwork/lib');
  return {
    ...actual,
    endEditGesture(changed?: boolean) {
      closes.at.push(store.getState().editingPlacementId);
      actual.endEditGesture(changed);
    },
  };
});
import { CompositionPage } from '../src/composition/CompositionPage';
import {
  ARRANGEMENT_ZOOM_LEVELS,
  arrangementWidth,
  DEFAULT_ARRANGEMENT_ZOOM_INDEX,
  editableSpans,
  editLaneHeight,
  setTrackView,
  tickToPx,
  TRACK_HEADER_HEIGHT,
  type ArrangementMode,
  type CompositionTrackViews,
} from '../src/composition/arrangementMath';
import {
  JOB_LOCK_REASON,
  addPlacement,
  addTrack,
  beginJob,
  clearHistory,
  closePlacementEditing,
  endJob,
  getEditingComposition,
  getEditingPlacementId,
  getSelectedPlacementIds,
  getSelectedTrackId,
  getTracks,
  movePlacement,
  openBlankComposition,
  openPlacementForEditing,
  removePlacement,
  removeTrack,
  selectPlacements,
  selectTrack,
  setCompositionTimeSignature,
  setTrackMuted,
} from '../src/composition/compositionService';
import {
  clearHistory as clearPatternHistory,
  findLibraryPattern,
  getEditingPattern,
  getLibraryPatterns,
  getSelectedIds,
  openBlankPattern,
  redo,
  selectNotes,
  stampNote,
  undo,
} from '../src/patterns/patternService';
import { Knob } from '../src/voice/controls/Knob';
import { ParamEncoder } from '../src/voice/controls/ParamEncoder';

/**
 * Every track of the open composition in ONE view — the uniform stack this suite
 * assumed back when the page had a single global mode (COMPS-TRACK-TABS
 * milestone 4 made the view per track).
 *
 * Built from the LIVE composition at the moment it is called, so it goes in the
 * render call after the fixtures are up. Tracks added afterwards are not in it,
 * and that is the real rule rather than a limitation of the helper: a new track
 * defaults to Pattern (§3).
 */
const viewsOf = (view: ArrangementMode): CompositionTrackViews => {
  const composition = getEditingComposition();
  if (!composition || view === 'pattern') return {};
  return {
    [composition.id]: Object.fromEntries(
      composition.tracks.map((track) => [track.id, view] as const),
    ),
  };
};


/**
 * CP-11 — edit mode.
 *
 * jsdom has NO LAYOUT (every `getBoundingClientRect` is 0×0), NO SCROLLING and
 * NO Web Audio, so nothing here asserts that anything LOOKS right; the geometry
 * is pure and lives in `src/composition/arrangementMath.test.ts`. What is
 * asserted here is the STATE MACHINE, which is where every hazard in this
 * ticket actually lives:
 *
 *   - the cross-page pointer leak — a placement is open, so the PATTERN PAGE
 *     would draw that placement's snapshot unless every exit restores the
 *     pointer,
 *   - the keyboard gate — two mounted surfaces, one keypress, and a `history`
 *     that keeps a single snapshot,
 *   - that an edit lands on the pressed placement's snapshot and on neither the
 *     library pattern nor the sibling placement,
 *   - that a note clamps at the placement boundary instead of crossing it,
 *   - that one gesture is one undo step, and that undoing writes back to the
 *     PLACEMENT rather than stamping it over the library pattern.
 *
 * The one thing measured off the DOM is a lane's HEIGHT, and only because it is
 * an inline style the component writes from a pure function — it is compared
 * against a fresh call to that function, never against a number typed in here.
 *
 * jsdom's 0×0 boxes are what make the pointer arithmetic predictable: a surface
 * measures ticks from its lanes element's left edge, which reads 0, so
 * `clientX` maps straight through `pxToTick` at the grid's zoom.
 */

/**
 * What the transport claims is sounding. `vi.hoisted` because the mock factory
 * below runs before this file's body does, so a plain `let` would still be in
 * its temporal dead zone.
 */
const playing = vi.hoisted(() => ({
  events: [] as readonly string[],
  placements: [] as readonly string[],
}));

// jsdom has no Web Audio; the composition page mounts the transport on render.
// The two "what is sounding" hooks are stubbed as well, because there is no
// engine to make anything sound and the play highlight has to be asserted.
vi.mock('../src/audio/playbackService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audio/playbackService')>();
  return {
    ...actual,
    stop: vi.fn(actual.stop),
    useActiveEventIds: () => playing.events,
    useActivePlacementIds: () => playing.placements,
  };
});

const PX_PER_BEAT = ARRANGEMENT_ZOOM_LEVELS[DEFAULT_ARRANGEMENT_ZOOM_INDEX];
/** The library pattern every placement below is cut from: one bar, one note. */
const SOURCE_FRET = 5;
const BAR_TICKS = 4 * PPQ;

beforeEach(() => {
  // A leaked job bracket would lock every later test out of the document, and
  // the lock is module state `setState` cannot reach. Unconditional and
  // idempotent, exactly as the placement close below is.
  endJob();
  closes.at.length = 0;
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  // `compositionService` remembers the pattern that was open when placement
  // editing began in MODULE state, which `setState` cannot reach — a test that
  // opens a placement and never closes it would otherwise leave a stale id for
  // whichever test runs next.
  closePlacementEditing();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  selectPlacements([]);
  selectTrack(null);
  playing.events = [];
  playing.placements = [];
});

/** A one-bar library pattern with a single note, so a placement of it has a real
 *  width and something to edit. */
function seedPattern(name: string): string {
  openBlankPattern(name);
  const pattern = getEditingPattern();
  if (!pattern) throw new Error('pattern seam did not open a pattern');
  stampNote({ stringIndex: 0, fret: SOURCE_FRET, tick: 0, durationTicks: PPQ });
  clearPatternHistory();
  return pattern.id;
}

/**
 * Two placements of ONE pattern, a bar apart on the first track, plus a bass
 * track with none.
 *
 * Two copies of one pattern is the arrangement that makes every hazard in this
 * ticket visible at once: the two snapshots carry the SAME event ids (the lib's
 * `snapshotPatternForPlacement` copies events verbatim), so anything that reads
 * the global edit target instead of the surface it belongs to lands on both.
 */
function seedArrangement() {
  // Idempotent, as the `ensureComposition` this replaced was: a helper that
  // CREATES unconditionally would switch away from a composition the test had
  // already opened, and the switch is silent.
  if (!getEditingComposition()) openBlankComposition('Song');
  const patternId = seedPattern('Riff');
  addTrack('Bass', 'bass');
  const [guitarTrack, bassTrack] = getTracks();

  const place = (atTick: number) => {
    const placed = addPlacement(patternId, guitarTrack.id, atTick);
    if (!placed.ok) throw new Error(placed.reason);
    return placed.value;
  };
  const first = place(0);
  const second = place(BAR_TICKS);

  selectPlacements([]);
  clearHistory();
  clearPatternHistory();
  return { patternId, first, second, guitarId: guitarTrack.id, bassId: bassTrack.id };
}

const placements = (): Placement[] => getTracks().flatMap((track) => [...track.placements]);
const placementById = (id: string): Placement => {
  const found = placements().find((placement) => placement.id === id);
  if (!found) throw new Error(`no placement ${id}`);
  return found;
};
/** Frets in a placement's snapshot, in event order — the whole of what an edit
 *  can be seen to have done to one block. */
const fretsIn = (id: string) => placementById(id).patternSnapshot.events.map((e) => e.fret);
const libraryFrets = (patternId: string) =>
  findLibraryPattern(patternId)!.events.map((e) => e.fret);

const surfaceEl = (placementId: string) =>
  document.querySelector<HTMLElement>(`[data-edit-placement="${placementId}"]`)!;
/** The notes drawn INSIDE one placement's surface. Scoped, because the two
 *  snapshots share their event ids and a document-wide query cannot tell the
 *  two copies apart. */
const noteIn = (placementId: string) =>
  within(surfaceEl(placementId)).getAllByTitle(/^Fret /)[0];

const editGrid = () => <ArrangementGrid views={viewsOf('edit')} />;

describe("the composition overrides a block's own meter (CP-18)", () => {
  it("computes the note lanes' grid from the ARRANGEMENT's meter, not the snapshot's", () => {
    // A block's snapshot carries its own meter, but the ruler above these lanes
    // measures the COMPOSITION's bars — so lanes drawn in the snapshot's meter
    // would put bar lines where the ruler says there are none.
    //
    // Asserted on the CALL rather than on the rendered `background-image`:
    // jsdom's CSS parser drops a comma-joined list of `repeating-linear-gradient`
    // and hands back an empty string, so the DOM cannot show this.
    seedArrangement();
    setCompositionTimeSignature({ numerator: 3, denominator: 4 });
    const snapshotMeter = getTracks()[0].placements[0].patternSnapshot.timeSignature;
    expect(snapshotMeter).toEqual({ numerator: 4, denominator: 4 });
    vi.mocked(laneGridImage).mockClear();

    render(<ArrangementGrid views={viewsOf('edit')} />);

    const meters = vi.mocked(laneGridImage).mock.calls.map((call) => call[2]);
    expect(meters.length).toBeGreaterThan(0);
    expect(meters).toContainEqual({ numerator: 3, denominator: 4 });
    expect(meters).not.toContainEqual(snapshotMeter);
  });
});

describe('what an edit-mode lane draws', () => {
  it('mounts one editable surface per placement, at the block’s own rect', () => {
    const { first, second } = seedArrangement();
    render(editGrid());

    const spans = editableSpans(getTracks()[0], PX_PER_BEAT, editLaneHeight(6), 6);
    expect(spans.map((span) => span.placementId)).toEqual([first, second]);
    for (const span of spans) {
      const el = surfaceEl(span.placementId);
      // Compared against a fresh call, so a changed rect policy fails here
      // rather than splitting the drawing and the geometry silently.
      expect(el.style.left).toBe(`${span.rect.left}px`);
      expect(el.style.width).toBe(`${span.rect.width}px`);
    }
  });

  // ⚠ CHANGED VALUE, and deliberately: the bass LANE used to be
  // `editLaneHeight(4)` = 128 and is now 143. Lane height is
  // `max(track header, content)`, and 128 of string rows loses to the 143 px
  // header — the bass lane grew by 15 px. What did NOT change is the thing the
  // number was protecting: the bass's ROWS are still 32 px, the guitar's pitch,
  // because the slack goes into centring the span rather than into the rows
  // (the test below).
  it('fits a lane to its own track’s string count, floored by the track header', () => {
    seedArrangement();
    render(editGrid());

    const [guitarLane, bassLane] = document.querySelectorAll<HTMLElement>('[data-lane-track]');
    expect(guitarLane.style.height).toBe(`${editLaneHeight(6)}px`);
    expect(guitarLane.style.height).toBe('192px');
    expect(bassLane.style.height).toBe(`${TRACK_HEADER_HEIGHT}px`);
    // A lane's rows are the SURFACE's, and they come from the track's neck: six
    // for the guitar, whatever the snapshot inside was written on.
    expect(surfaceEl(placements()[0].id).querySelectorAll('[data-lane]')).toHaveLength(6);
  });

  // The other half of that change: a four-string lane's SURFACE keeps the
  // guitar's row pitch and is centred in the taller lane, rather than stretching
  // to fill it. Stretched, the bass would read as a different scale from the
  // guitar lane above it and the stack would stop reading as one instrument
  // rack. jsdom cannot see any of that; what it can see is the box.
  it('centres a bass surface in its lane instead of stretching its rows', () => {
    const { patternId, bassId } = seedArrangement();
    // The seed leaves the bass track empty; an edit lane draws nothing without a
    // block in it.
    const onBass = addPlacement(patternId, bassId, 0);
    if (!onBass.ok) throw new Error(onBass.reason);
    render(editGrid());

    const el = surfaceEl(onBass.value);

    expect(el.style.height).toBe(`${editLaneHeight(4)}px`);
    expect(el.style.height).toBe('128px');
    expect(el.style.top).toBe(`${(TRACK_HEADER_HEIGHT - 128) / 2}px`);
    // Four rows in 128 px is the guitar's 32 px pitch — what all of this is for.
    expect(el.querySelectorAll('[data-lane]')).toHaveLength(4);

    // The guitar's content IS its lane, so its surface stays flush at the top.
    const guitarEl = surfaceEl(placements()[0].id);
    expect(guitarEl.style.top).toBe('0px');
    expect(guitarEl.style.height).toBe('192px');
  });

  it('draws no surface in empty time, so nothing can be written there', async () => {
    const { guitarId, bassId } = seedArrangement();
    render(editGrid());

    // The property that actually encodes "not editable": the editable surfaces
    // stop at the last block's right edge, and the lane runs on for six more
    // bars past it. A lane-wide surface — the obvious wrong implementation —
    // fails here, where a click on the lane cannot.
    const editableRight = Math.max(
      ...[...document.querySelectorAll<HTMLElement>('[data-edit-placement]')].map(
        (el) => parseFloat(el.style.left) + parseFloat(el.style.width),
      ),
    );
    expect(editableRight).toBe(tickToPx(2 * BAR_TICKS, PX_PER_BEAT));
    const laneWidth = parseFloat(
      screen.getByTestId('arrangement-ruler-content').style.width,
    );
    expect(laneWidth).toBeGreaterThan(editableRight);
    // A track with nothing on it is editable NOWHERE, not editable-but-empty.
    const bassLane = document.querySelector<HTMLElement>(`[data-lane-track="${bassId}"]`)!;
    expect(bassLane.querySelectorAll('[data-edit-placement]')).toHaveLength(0);

    // And the lane itself answers a press with nothing at all.
    const before = placements().map((p) => p.patternSnapshot.events.length);
    const lane = document.querySelector<HTMLElement>(`[data-lane-track="${guitarId}"]`)!;
    await userEvent.pointer({ target: lane, keys: '[MouseLeft]' });

    expect(placements().map((p) => p.patternSnapshot.events.length)).toEqual(before);
    expect(getEditingPlacementId()).toBeNull();
  });

  it('lights up the notes of the block that is sounding, and only that one', () => {
    const { first, second } = seedArrangement();
    // The hazard: `snapshotPatternForPlacement` copies events verbatim, so two
    // placements of one pattern carry the SAME event ids — and the transport
    // reports a flat list of event ids across every track.
    const eventId = placementById(first).patternSnapshot.events[0].id;
    expect(placementById(second).patternSnapshot.events[0].id).toBe(eventId);

    playing.events = [eventId];
    playing.placements = [first];
    render(editGrid());

    expect(noteIn(first).dataset.active).toBe('true');
    expect(noteIn(second).dataset.active).toBeUndefined();
  });

  it('marks a placement whose snapshot has drifted from the pattern it is named after', async () => {
    const { patternId, first, second } = seedArrangement();
    render(editGrid());

    await userEvent.pointer({ target: noteIn(second), keys: '[MouseLeft]' });
    await userEvent.keyboard('12');

    // Pattern mode is where a block wears its name, so the mark is asserted
    // there — the surface's watermark is the same string.
    const { rerender } = render(<ArrangementGrid />);
    rerender(<ArrangementGrid />);
    const blocks = document.querySelectorAll<HTMLElement>('[data-placement]');
    const edited = [...blocks].filter((el) => el.dataset.placement === second);
    const untouched = [...blocks].filter((el) => el.dataset.placement === first);
    expect(edited.every((el) => el.dataset.drifted === 'true')).toBe(true);
    expect(untouched.every((el) => el.dataset.drifted === undefined)).toBe(true);
    expect(edited[0].textContent).toContain('*');
    expect(libraryFrets(patternId)).toEqual([SOURCE_FRET]);
  });
});

describe('which pattern an edit lands on', () => {
  it('opens the placement that was pressed, and edits only its snapshot', async () => {
    const { patternId, first, second } = seedArrangement();
    render(editGrid());

    await userEvent.pointer({ target: noteIn(second), keys: '[MouseLeft]' });
    expect(getEditingPlacementId()).toBe(second);

    await userEvent.keyboard('12');

    expect(fretsIn(second)).toEqual([12]);
    // The sibling holds a copy of the SAME event id and must not have moved.
    expect(fretsIn(first)).toEqual([SOURCE_FRET]);
    // Nor the library pattern the block is named after — placement editing is
    // placement-local by design; rippling back is explicitly deferred.
    expect(libraryFrets(patternId)).toEqual([SOURCE_FRET]);
  });

  it('moves the edit target when a different block is pressed', async () => {
    const { first, second } = seedArrangement();
    render(editGrid());

    await userEvent.pointer({ target: noteIn(second), keys: '[MouseLeft]' });
    await userEvent.keyboard('12');
    await userEvent.pointer({ target: noteIn(first), keys: '[MouseLeft]' });
    expect(getEditingPlacementId()).toBe(first);
    await userEvent.keyboard('09');

    expect(fretsIn(first)).toEqual([9]);
    expect(fretsIn(second)).toEqual([12]);
  });

  it('is reachable by id with no pointer at all', () => {
    const { second } = seedArrangement();

    expect(openPlacementForEditing(second)).toEqual({ ok: true, value: second });
    expect(getEditingPattern()!.events.map((e) => e.fret)).toEqual([SOURCE_FRET]);
    // The agent gets the same typed refusal the UI does, never a throw.
    expect(openPlacementForEditing('no-such-block')).toEqual({
      ok: false,
      reason: 'No such block in this composition.',
    });
  });
});

describe('the keyboard gate', () => {
  /**
   * THE DEFECT THIS COVERS. The shortcuts live on `window` and act on the ONE
   * global edit target, so a second ATTACHED surface answers the same keypress
   * a second time against the same document.
   *
   * ⌘Z is the sharp case and the reason the gate is a real gate rather than a
   * consequence of the selection scoping: every other shortcut bails out on an
   * empty selection, and an unfocused surface has none — but undo takes no
   * selection at all, so two listeners pop TWO steps for one press. Two surfaces
   * really are mounted here; `seedArrangement` places the same pattern twice.
   */
  it('answers one ⌘Z once, however many surfaces are mounted', async () => {
    const { second } = seedArrangement();
    render(editGrid());
    expect(document.querySelectorAll('[data-edit-placement]')).toHaveLength(2);

    await userEvent.pointer({ target: noteIn(second), keys: '[MouseLeft]' });
    // Two digits complete the number, so each is one finished step without
    // having to wait out the typing window.
    await userEvent.keyboard('12');
    await userEvent.keyboard('09');
    expect(fretsIn(second)).toEqual([9]);

    await userEvent.keyboard('{Meta>}z{/Meta}');

    expect(fretsIn(second)).toEqual([12]);
  });

  it('does not let ⌘Z in an Edit context pop an ARRANGEMENT step as well', async () => {
    const { second, bassId, guitarId } = seedArrangement();
    // An arrangement step to lose: a block moved onto the other track.
    const tracksBefore = getTracks();
    movePlacement(second, bassId, 0);
    expect(getTracks()).not.toBe(tracksBefore);
    const placedOnBass = getTracks()[1].placements.map((p) => p.id);

    // ⚠ THE SELECTION IS WHAT DECIDES NOW. The direct-editing context is the
    // SELECTED track's view (§4), not a page mode — an Edit lane nobody has
    // selected leaves the arrangement's own shortcuts armed, which is the
    // no-track Pattern fallback and is correct.
    selectTrack(guitarId);
    render(editGrid());
    await userEvent.keyboard('{Meta>}z{/Meta}');

    // The arrangement gestures' own shortcuts are inert in edit mode: the two
    // key sets are both on `window` and both answer ⌘Z, so one press would undo
    // a note edit AND a block move.
    expect(getTracks()[1].placements.map((p) => p.id)).toEqual(placedOnBass);
  });

  it('leaves the unfocused surface’s notes unselected', async () => {
    const { first, second } = seedArrangement();
    render(editGrid());

    await userEvent.pointer({ target: noteIn(second), keys: '[MouseLeft]' });

    expect(noteIn(second).dataset.selected).toBe('true');
    // Same event id, different block: the selection belongs to the edit target,
    // so the other copy must not light up.
    expect(noteIn(first).dataset.selected).toBeUndefined();
  });

  it('undoes a placement edit back into the PLACEMENT, not over the library pattern', async () => {
    const { patternId, first, second } = seedArrangement();
    render(editGrid());

    await userEvent.pointer({ target: noteIn(second), keys: '[MouseLeft]' });
    await userEvent.keyboard('12');
    undo();

    // The whole hazard: a placement's snapshot keeps the id of the pattern it
    // was cut from, so a library-only write-back would stamp this snapshot over
    // the library pattern and leave the placement where it was.
    expect(fretsIn(second)).toEqual([SOURCE_FRET]);
    expect(libraryFrets(patternId)).toEqual([SOURCE_FRET]);
    expect(fretsIn(first)).toEqual([SOURCE_FRET]);

    redo();
    expect(fretsIn(second)).toEqual([12]);
    expect(libraryFrets(patternId)).toEqual([SOURCE_FRET]);
  });

  it('does not carry an undo step across a switch of block', async () => {
    const { first, second } = seedArrangement();
    render(editGrid());

    // The two blocks are copies of ONE pattern, so they start identical — and a
    // step stamped from the wrong one would be indistinguishable from doing
    // nothing. Give the first its own content, and clear the history so the only
    // step in it afterwards is the SECOND block's.
    await userEvent.pointer({ target: noteIn(first), keys: '[MouseLeft]' });
    await userEvent.keyboard('07');
    expect(fretsIn(first)).toEqual([7]);
    clearPatternHistory();

    await userEvent.pointer({ target: noteIn(second), keys: '[MouseLeft]' });
    await userEvent.keyboard('12');
    await userEvent.pointer({ target: noteIn(first), keys: '[MouseLeft]' });
    undo();

    // History is per-document and `writePatternBack` writes to whichever target
    // is current, so a step carried across the switch would stamp the SECOND
    // block's pre-edit notes (fret 5) into the first, which is now on 7.
    expect(fretsIn(first)).toEqual([7]);
    expect(fretsIn(second)).toEqual([12]);
  });

  it('answers Backspace with the note, never the selected block', async () => {
    const { first, second } = seedArrangement();
    // A block selection left over from pattern mode, which the arrangement's own
    // Backspace would delete.
    selectPlacements([first]);
    render(editGrid());

    await userEvent.pointer({ target: noteIn(second), keys: '[MouseLeft]' });
    await userEvent.keyboard('{Backspace}');

    expect(placementById(second).patternSnapshot.events).toHaveLength(0);
    expect(placements().map((placement) => placement.id).sort()).toEqual(
      [first, second].sort(),
    );
  });

  it('points the toolbar’s undo at the document the selected track is editing', async () => {
    const { first, second, guitarId } = seedArrangement();
    const { rerender } = render(<ArrangementGrid />);

    // A step in the COMPOSITION history — the one the toolbar is wired to on a
    // Pattern track, and the one it must stop being wired to on an Edit one.
    movePlacement(second, guitarId, 6 * BAR_TICKS);
    expect(placementById(second).startTick).toBe(6 * BAR_TICKS);

    // The SELECTED track's view is the context (§4), so the switch is a
    // selection as well as a map.
    act(() => selectTrack(guitarId));
    rerender(<ArrangementGrid views={viewsOf('edit')} />);
    // Nothing has been edited in THIS document yet, so there is nothing to undo
    // — even though the arrangement has a step waiting.
    expect(screen.getByLabelText('Undo')).toBeDisabled();

    await userEvent.pointer({ target: noteIn(first), keys: '[MouseLeft]' });
    await userEvent.keyboard('12');
    expect(fretsIn(first)).toEqual([12]);

    await userEvent.click(screen.getByLabelText('Undo'));

    expect(fretsIn(first)).toEqual([SOURCE_FRET]);
    // Wired to the composition, this press would have restored the snapshot
    // captured before the move — putting the block back AND stamping the
    // pre-edit snapshot over the note edit with no step left to recover it.
    expect(placementById(second).startTick).toBe(6 * BAR_TICKS);
  });

  it('rubber-bands only the notes inside its own block', async () => {
    // TWO library patterns, deliberately: copies of one pattern share their
    // event ids, so a document-wide hit test would be indistinguishable from a
    // scoped one. Different patterns mean different ids.
    openBlankComposition('Song');
    const patternA = seedPattern('A');
    const patternB = seedPattern('B');
    const [track] = getTracks();
    const placedA = addPlacement(patternA, track.id, 0);
    const placedB = addPlacement(patternB, track.id, BAR_TICKS);
    if (!placedA.ok || !placedB.ok) throw new Error('seed failed');
    selectPlacements([]);
    render(editGrid());

    const idsIn = (placementId: string) =>
      placementById(placementId).patternSnapshot.events.map((event) => event.id);
    expect(idsIn(placedA.value)).not.toEqual(idsIn(placedB.value));

    // A band from A's own lanes, dragged far enough right and down to cover the
    // whole grid. Every box is 0×0 at the origin in jsdom, so the band catches
    // every note the query returns — which is exactly what makes the SCOPE of
    // that query the only thing under test.
    const rows = surfaceEl(placedA.value).querySelectorAll<HTMLElement>('[data-lane]');
    await userEvent.pointer([
      { target: rows[5], keys: '[MouseLeft>]', coords: { clientX: 0, clientY: 0 } },
      { coords: { clientX: 400, clientY: 200 } },
      { keys: '[/MouseLeft]' },
    ]);

    expect(getSelectedIds()).toEqual(idsIn(placedA.value));
  });
});

describe('the placement boundary', () => {
  it('clamps a dragged note at the boundary instead of moving it into the neighbour', async () => {
    const { first, second } = seedArrangement();
    render(editGrid());
    const note = noteIn(first);

    // Far past the end of the first block. Boxes are 0×0 in jsdom, so clientX
    // is content x and `pxToTick` maps it straight through at this zoom.
    await userEvent.pointer([
      { target: note, keys: '[MouseLeft>]', coords: { clientX: 0, clientY: 0 } },
      { coords: { clientX: tickToPx(20 * PPQ, PX_PER_BEAT), clientY: 0 } },
      { keys: '[/MouseLeft]' },
    ]);

    const moved = placementById(first).patternSnapshot.events[0];
    // The note is a beat long and the window is a bar, so the furthest its start
    // can go is the last beat — it ends exactly ON the boundary.
    expect(moved.startTick + moved.durationTicks).toBe(BAR_TICKS);
    expect(moved.startTick).toBe(BAR_TICKS - PPQ);
    // And it did NOT arrive in the block next door.
    expect(placementById(second).patternSnapshot.events).toHaveLength(1);
    expect(placementById(second).patternSnapshot.events[0].startTick).toBe(0);
  });

  it('counts a whole drag as one undo step', async () => {
    const { first } = seedArrangement();
    render(editGrid());

    await userEvent.pointer([
      { target: noteIn(first), keys: '[MouseLeft>]', coords: { clientX: 0, clientY: 0 } },
      { coords: { clientX: tickToPx(PPQ, PX_PER_BEAT), clientY: 0 } },
      { coords: { clientX: tickToPx(2 * PPQ, PX_PER_BEAT), clientY: 0 } },
      { coords: { clientX: tickToPx(3 * PPQ, PX_PER_BEAT), clientY: 0 } },
      { keys: '[/MouseLeft]' },
    ]);
    expect(placementById(first).patternSnapshot.events[0].startTick).toBe(3 * PPQ);

    undo();

    // One step for the whole drag, not one per pointermove.
    expect(placementById(first).patternSnapshot.events[0].startTick).toBe(0);
  });

  it('refuses a stamp past the end of the window', async () => {
    const { first } = seedArrangement();
    render(editGrid());
    // Focus first, so the stamp is not refused for want of an edit target.
    openPlacementForEditing(first);

    const lanes = surfaceEl(first).querySelectorAll<HTMLElement>('[data-lane]');
    const before = placementById(first).patternSnapshot.events.length;
    await userEvent.pointer({
      target: lanes[1],
      keys: '[MouseLeft]',
      coords: { clientX: tickToPx(9 * PPQ, PX_PER_BEAT), clientY: 0 },
    });

    expect(placementById(first).patternSnapshot.events).toHaveLength(before);
  });

  it('stamps inside the window, on the string its lane belongs to', async () => {
    const { first } = seedArrangement();
    render(editGrid());
    openPlacementForEditing(first);

    const lanes = surfaceEl(first).querySelectorAll<HTMLElement>('[data-lane]');
    await userEvent.pointer({
      target: lanes[0],
      keys: '[MouseLeft]',
      coords: { clientX: tickToPx(2 * PPQ, PX_PER_BEAT), clientY: 0 },
    });

    const added = placementById(first).patternSnapshot.events.find(
      (event) => event.startTick === 2 * PPQ,
    );
    // The TOP row is the highest string, which on a six-string neck is index 5.
    expect(added?.stringIndex).toBe(5);
  });
});

describe('the cross-page pointer', () => {
  /**
   * `selectEditingPattern` IS `currentEditTarget()?.pattern`, and
   * `useEditingPattern()` is what the pattern page and `App` read — so an open
   * placement means the pattern page draws that placement's snapshot.
   * `openPlacementForEditing` nulls `editingPatternId` outright, so the library
   * pattern is CLOSED rather than shadowed and `App`'s `ensurePattern` would
   * adopt whatever was updated most recently on the way back.
   *
   * Identity, not equality: what the pattern page renders is the object
   * `getEditingPattern()` returns, and a snapshot with equal contents would pass
   * a value comparison while being the wrong document.
   */
  const expectPatternPagePointer = (patternId: string) => {
    expect(getEditingPlacementId()).toBeNull();
    expect(usePatternsStore.getState().editingPatternId).toBe(patternId);
    expect(getEditingPattern()).toBe(getLibraryPatterns().find((p) => p.id === patternId));
  };

  it('restores the pattern pointer when edit mode is left', async () => {
    const { patternId, second } = seedArrangement();
    const { rerender } = render(
      <CompositionPage views={viewsOf('edit')} />,
    );

    await userEvent.pointer({ target: noteIn(second), keys: '[MouseLeft]' });
    expect(getEditingPlacementId()).toBe(second);
    expect(getEditingPattern()).not.toBe(findLibraryPattern(patternId));

    rerender(<CompositionPage />);

    expectPatternPagePointer(patternId);
  });

  it('restores it when the composition page unmounts', async () => {
    const { patternId, second } = seedArrangement();
    const { unmount } = render(<CompositionPage views={viewsOf('edit')} />);

    await userEvent.pointer({ target: noteIn(second), keys: '[MouseLeft]' });
    unmount();

    expectPatternPagePointer(patternId);
  });

  it('restores it through the seam alone, for a caller with no page', () => {
    const { patternId, second } = seedArrangement();

    openPlacementForEditing(second);
    expect(usePatternsStore.getState().editingPatternId).toBeNull();

    closePlacementEditing();

    expectPatternPagePointer(patternId);
  });

  it('does not carry the note selection out to the pattern page', async () => {
    const { patternId, second } = seedArrangement();
    const { rerender } = render(<CompositionPage views={viewsOf('edit')} />);

    await userEvent.pointer({ target: noteIn(second), keys: '[MouseLeft]' });
    expect(getSelectedIds()).toHaveLength(1);

    rerender(<CompositionPage />);

    expectPatternPagePointer(patternId);
    // The other half of the leak: a placement's events keep the ids they were
    // copied from, so those ids exist in the library pattern too — left
    // selected, the next Backspace would delete from a document the user was
    // not editing.
    expect(getSelectedIds()).toEqual([]);
  });

  it('still remembers the pattern when the lib closes a placement behind us', () => {
    const { patternId, first, second } = seedArrangement();

    openPlacementForEditing(first);
    // The lib nulls `editingPlacementId` ITSELF when the open block is removed,
    // and puts nothing back — so "no placement is open" is not proof that the
    // pattern pointer was never taken.
    removePlacement(first);
    expect(getEditingPlacementId()).toBeNull();
    expect(usePatternsStore.getState().editingPatternId).toBeNull();

    openPlacementForEditing(second);
    closePlacementEditing();

    expectPatternPagePointer(patternId);
  });

  it('restores it when another composition is opened', () => {
    const { patternId, second } = seedArrangement();
    openPlacementForEditing(second);
    expect(usePatternsStore.getState().editingPatternId).toBeNull();

    // A block open in a composition that is no longer the one being arranged
    // would keep the pattern page pointed at that block's snapshot.
    expect(openBlankComposition('Second').ok).toBe(true);

    expectPatternPagePointer(patternId);
  });

  it('does not put the pointer back over a pattern something else has opened', () => {
    const { second } = seedArrangement();
    openPlacementForEditing(second);

    // The user went to the pattern page and started a new pattern; putting the
    // remembered id back would close it under them.
    openBlankPattern('Later');
    const later = getEditingPattern()!.id;
    closePlacementEditing();

    expect(usePatternsStore.getState().editingPatternId).toBe(later);
  });

  it('shows the LIBRARY pattern on the pattern page after an edit-mode round trip', async () => {
    const { patternId, second } = seedArrangement();
    render(<App />);

    await userEvent.click(
      within(screen.getByRole('navigation', { name: 'Editor' })).getByRole('button', {
        name: 'Composition',
      }),
    );
    // The view lives in the TRACK HEADER now — there is no mode bar. The press
    // selects the track and sets its view in one go (§2).
    await userEvent.click(
      screen.getByRole('button', { name: `Edit view, ${getTracks()[0].name}` }),
    );
    await userEvent.pointer({ target: noteIn(second), keys: '[MouseLeft]' });
    await userEvent.keyboard('12');
    expect(fretsIn(second)).toEqual([12]);

    await userEvent.click(
      within(screen.getByRole('navigation', { name: 'Editor' })).getByRole('button', {
        name: 'Pattern',
      }),
    );

    expectPatternPagePointer(patternId);
    // What the timeline actually draws: the library pattern's untouched note,
    // not the placement's edited one.
    expect(screen.getByTitle(`Fret ${SOURCE_FRET} · A`)).toBeInTheDocument();
    expect(screen.queryByTitle(/^Fret 12 /)).not.toBeInTheDocument();
  });
});

describe('what does NOT change between modes', () => {
  it('keeps the ruler, the header column and the time axis where they were', async () => {
    seedArrangement();
    const { rerender } = render(<ArrangementGrid />);

    // OFF the default zoom before the switch. At the default, a mode change that
    // reset the zoom would land back on the very number this test captured and
    // every width assertion below would pass through the bug.
    await userEvent.click(screen.getByLabelText('Zoom out'));
    const defaultWidth = arrangementWidth(
      8 + 2,
      { numerator: 4, denominator: 4 },
      PX_PER_BEAT,
    );
    const rulerWidth = screen.getByTestId('arrangement-ruler-content').style.width;
    expect(rulerWidth).not.toBe(`${defaultWidth}px`);

    const markCount = document.querySelectorAll('[data-ruler-line]').length;
    const headerNames = [...document.querySelectorAll('[data-lane-track]')].map(
      (el) => el.getAttribute('data-lane'),
    );
    // Captured, not re-queried: the scroller is the ONE scroll container on the
    // page, and a remount would silently discard the user's scroll position.
    const scroller = screen.getByTestId('arrangement-lanes-scroller');

    rerender(<ArrangementGrid views={viewsOf('edit')} />);

    expect(screen.getByTestId('arrangement-ruler-content').style.width).toBe(rulerWidth);
    expect(document.querySelectorAll('[data-ruler-line]')).toHaveLength(markCount);
    expect(
      [...document.querySelectorAll('[data-lane-track]')].map((el) =>
        el.getAttribute('data-lane'),
      ),
    ).toEqual(headerNames);
    expect(screen.getByTestId('arrangement-lanes-scroller')).toBe(scroller);
  });

  it('holds a separate grid for notes and for blocks', async () => {
    const { guitarId } = seedArrangement();
    const { rerender } = render(<ArrangementGrid />);
    expect(screen.getByLabelText('Arrangement snap')).toHaveValue('bar');

    // Which of the two is on screen follows the SELECTED track's view, so the
    // selection is part of the switch now.
    act(() => selectTrack(guitarId));
    rerender(<ArrangementGrid views={viewsOf('edit')} />);
    // Note entry needs sub-beat resolution where block placement does not, so
    // the two settings are separate and the context chooses which is on screen.
    expect(screen.getByLabelText('Note grid')).toHaveValue('16');
    await userEvent.selectOptions(screen.getByLabelText('Note grid'), '8');

    rerender(<ArrangementGrid />);
    expect(screen.getByLabelText('Arrangement snap')).toHaveValue('bar');
  });
});

/**
 * COMPS-TRACK-TABS milestone 3 — the activation coordinator.
 *
 * ⚠ THIS STEP CHANGES BEHAVIOUR, deliberately, and under the SAME single global
 * mode the page has always had. Before it, a track header press was a bare
 * `selectTrack` and an edit surface's press was a bare `openPlacementForEditing`;
 * the two knew nothing about each other, and neither ended anything. Now every
 * one of them goes through one function that validates the target and the job
 * lock, ends the outgoing surface's work synchronously, closes the outgoing
 * block, selects, and only then starts what was asked for. So:
 *
 *   - selecting another track CLOSES the open block (and loses its note undo
 *     history, which is the cost §4 chose to keep and to state on screen),
 *   - a block open on a track that is NOT selected is drawn but is not live,
 *   - a job holding the document refuses every activation and suppresses the
 *     note keyboard WITHOUT closing the pointer the job is using.
 *
 * None of that is "unchanged", and nothing below asserts that it is.
 */

/** The bass track's own pattern, so its event ids differ from the guitar's —
 *  copies of ONE pattern share their ids, and half of what these tests check is
 *  that a selection did not cross a track. */
function seedTwoEditTracks() {
  const base = seedArrangement();
  const bassPatternId = seedPattern('Bassline');
  const placed = addPlacement(bassPatternId, base.bassId, 0);
  if (!placed.ok) throw new Error(placed.reason);
  selectPlacements([]);
  selectTrack(null);
  clearHistory();
  clearPatternHistory();
  return { ...base, bassPatternId, onBass: placed.value };
}

/**
 * The grid with an OWNER, seeded with every track on Edit.
 *
 * `editGrid()` passes a map with no handler, which is a FIXTURE the caller does
 * not want changed (see `ArrangementGrid`'s `views` prop) — fine for a stack
 * that never moves, useless for pressing a view button. This is the shape the
 * app runs in: `App` holds the map and hands back the updated one.
 */
function OwnedEditGrid() {
  const [views, setViews] = useState<CompositionTrackViews>(() => viewsOf('edit'));
  return (
    <ArrangementGrid
      views={views}
      onTrackViewChange={(compositionId, trackId, view) =>
        setViews((was) => setTrackView(was, compositionId, trackId, view))
      }
    />
  );
}

/** A track's view button, in its own header — the control that replaced the
 *  page's mode bar (COMPS-TRACK-TABS milestone 4). */
const viewButton = (label: string, trackId: string) => {
  const track = getTracks().find((candidate) => candidate.id === trackId);
  if (!track) throw new Error(`no track ${trackId}`);
  return screen.getByRole('button', { name: `${label} view, ${track.name}` });
};

const headerSelect = (trackId: string) => {
  const track = getTracks().find((candidate) => candidate.id === trackId);
  if (!track) throw new Error(`no track ${trackId}`);
  return screen.getByRole('button', { name: `Select track ${track.name}` });
};
/** The strip the coordinator reports a refusal on. */
const trackAlert = () => screen.queryByRole('alert', { name: 'Track message' });
const pressNote = (placementId: string) =>
  userEvent.pointer({ target: noteIn(placementId), keys: '[MouseLeft]' });

describe('the activation coordinator — ending the outgoing run', () => {
  /**
   * A held arrow opens an undo bracket that only a keyup closes, and a track
   * switch is not a keyup. Left open, `patternService`'s gesture DEPTH never
   * returns to zero — so the next run's `beginEditGesture` is a nested no-op,
   * its writes each push a step of their own, and one ⌘Z undoes half an edit
   * for the rest of the page's life.
   *
   * Dispatched on `window` rather than through `userEvent.keyboard`, because
   * `repeat: true` is the whole condition being tested and user-event does not
   * set it.
   */
  it('closes a held arrow’s undo bracket against the block it was held over', async () => {
    const { first, bassId, onBass } = seedTwoEditTracks();
    render(editGrid());

    await pressNote(first);
    // On an ELEMENT, not on `window`: the handler asks its target whether it is
    // a form field, and `window` has no `matches`. It bubbles to the window
    // listener either way.
    fireEvent.keyDown(document.body, { key: 'ArrowUp' });
    fireEvent.keyDown(document.body, { key: 'ArrowUp', repeat: true });
    expect(fretsIn(first)).toEqual([SOURCE_FRET + 2]);

    // No keyup: the switch is what has to end it.
    closes.at.length = 0;
    await userEvent.click(headerSelect(bassId));

    // THE ORDER: the bracket closed while `first` was still the target, not
    // after the editor had moved on.
    //
    // ⚠ Honest about what covers it. `NoteSurface` already ends its key runs
    // from a capture-phase `pointerdown` listener, so for a PRESS this holds
    // with or without the coordinator's own call — the audit §B asked for found
    // the key-run paths already synchronous, and the gap was the POINTER
    // gesture (the drag test below) and the programmatic path (the reconciler
    // test further down). This pins the invariant; it does not claim to be what
    // enforces it.
    expect(closes.at).toEqual([first]);
    // The EDITS survive — only the history goes. That is the model §4 keeps.
    expect(fretsIn(first)).toEqual([SOURCE_FRET + 2]);

    // The proof the bracket closed: a whole typed number on the NEXT block is
    // still exactly one undo step. With the bracket leaked it is two, and this
    // undo lands on fret 1.
    await pressNote(onBass);
    await userEvent.keyboard('12');
    expect(fretsIn(onBass)).toEqual([12]);
    undo();
    expect(fretsIn(onBass)).toEqual([SOURCE_FRET]);
  });

  /**
   * The same hazard from the other side: a half-typed fret holds the bracket
   * open until its timer fires, and the timer is 800ms away.
   *
   * ⚠ HONEST ABOUT WHAT COVERS IT, like the arrow test above and for a second
   * reason as well. A click is a `pointerdown`, which `NoteSurface`'s own
   * capture-phase listener treats as the end of a run — and on the PROGRAMMATIC
   * route the surface's focus-loss effect closes it, a child effect that runs
   * before the reconciler's. So a KEY RUN is covered on every route with or
   * without the coordinator's call. The gap `endOutgoingWork` closes is the
   * POINTER GESTURE, which `focused` going false does not end; the two drag
   * tests below are the ones that fail without it. This pins the invariant and
   * the ORDER — the bracket closed while `first` was still the target.
   */
  it('closes a pending fret-entry run against the block it was typed into', async () => {
    const { first, bassId, onBass } = seedTwoEditTracks();
    render(editGrid());

    await pressNote(first);
    // One digit: the run stays open, waiting for a second.
    await userEvent.keyboard('1');
    expect(fretsIn(first)).toEqual([1]);

    closes.at.length = 0;
    await userEvent.click(headerSelect(bassId));

    // Against the block it was typed into — see the header comment.
    expect(closes.at).toEqual([first]);
    expect(fretsIn(first)).toEqual([1]);

    await pressNote(onBass);
    await userEvent.keyboard('12');
    undo();
    expect(fretsIn(onBass)).toEqual([SOURCE_FRET]);
  });

  /**
   * A pointer gesture parks its listeners on `window`, so removing the surface
   * from the tree removes nothing — the drag keeps writing into the outgoing
   * block after the page has moved on. Pressed and moved with `fireEvent` so the
   * pointer stays DOWN across the switch, which is the only way the gesture is
   * still in flight when it happens.
   */
  it('takes an in-flight note drag off window before the selection moves', async () => {
    const { patternId, first, bassId } = seedTwoEditTracks();
    // The pattern the seam falls BACK to when the block closes, pinned to the
    // riff on purpose: a snapshot copies its events VERBATIM, ids included, so a
    // drag still listening on `window` after the switch is seen to move the
    // library riff. Left on the bass pattern the leak would be silent — the
    // drag's snapshot names ids that pattern has not got.
    usePatternsStore.setState({ editingPatternId: patternId });
    const user = userEvent.setup();
    render(editGrid());
    const libraryStarts = () =>
      findLibraryPattern(patternId)!.events.map((event) => event.startTick);
    const libraryBefore = libraryStarts();

    // The button stays DOWN across the switch — there is no other way to have a
    // gesture still in flight when it happens. Nothing after the first entry
    // names a target: the listeners are on `window`, which is the point.
    await user.pointer([
      { target: noteIn(first), keys: '[MouseLeft>]', coords: { clientX: 0, clientY: 0 } },
      // ONE BEAT along, deliberately short of the block's boundary: a drag that
      // had already clamped could not move again afterwards, and the assertion
      // below would hold whether or not the listeners came off.
      { coords: { clientX: PX_PER_BEAT, clientY: 0 } },
    ]);
    const draggedTo = placementById(first).patternSnapshot.events[0].startTick;
    expect(draggedTo).toBeGreaterThan(0);

    // `fireEvent`, not `user.click`: a click from user-event would press a
    // second button into the session that is holding the drag.
    fireEvent.click(headerSelect(bassId));

    // Still down, still moving — and now reaching nothing. `focused` going
    // false does NOT end a pointer gesture (its teardown is tied to completion
    // and unmount), so this is the one path the coordinator's synchronous call
    // is the only thing covering.
    await user.pointer([
      { coords: { clientX: PX_PER_BEAT * 5, clientY: 0 } },
      { keys: '[/MouseLeft]' },
    ]);

    // The outgoing block kept exactly what the drag had written when the switch
    // happened...
    expect(placementById(first).patternSnapshot.events[0].startTick).toBe(draggedTo);
    // ...and the moves after it reached NOTHING. With the listeners still on
    // `window` they reach the seam's new target instead, which by then is the
    // library pattern — the leak this is here to catch.
    expect(libraryStarts()).toEqual(libraryBefore);
  });

  /** The teardown is idempotent and re-selecting a track preserves its block —
   *  what this actually observes is the second, since the count of teardowns is
   *  not visible from here. */
  it('preserves the active block when the same track is activated twice', async () => {
    const { first, guitarId, onBass, bassId } = seedTwoEditTracks();
    render(editGrid());

    await pressNote(first);
    await userEvent.click(headerSelect(guitarId));
    await userEvent.click(headerSelect(guitarId));
    // Re-selecting the track that is already active preserves its block.
    expect(getEditingPlacementId()).toBe(first);

    await userEvent.click(headerSelect(bassId));
    await userEvent.click(headerSelect(bassId));
    expect(getEditingPlacementId()).toBeNull();

    // Everything still works afterwards.
    await pressNote(onBass);
    expect(getEditingPlacementId()).toBe(onBass);
  });
});

describe('the activation coordinator — two Edit tracks in sequence', () => {
  it('gives the keyboard and the selection to one block only', async () => {
    const { first, onBass } = seedTwoEditTracks();
    render(editGrid());

    await pressNote(first);
    expect(surfaceEl(first).dataset.focused).toBe('true');

    await pressNote(onBass);

    expect(getSelectedTrackId()).toBe(getTracks()[1].id);
    expect(surfaceEl(onBass).dataset.focused).toBe('true');
    expect(surfaceEl(first).dataset.focused).toBeUndefined();

    await userEvent.keyboard('12');
    expect(fretsIn(onBass)).toEqual([12]);
    expect(fretsIn(first)).toEqual([SOURCE_FRET]);

    // The inspector follows `patternService`'s NOTE selection, and the two
    // tracks' patterns have different event ids — so this is the assertion that
    // it can never show the other track's notes.
    const bassIds = placementById(onBass).patternSnapshot.events.map((e) => e.id);
    expect(getSelectedIds().length).toBeGreaterThan(0);
    expect(getSelectedIds().every((id) => bassIds.includes(id))).toBe(true);
  });

  it('selecting an Edit header alone opens no block', async () => {
    const { first, bassId } = seedTwoEditTracks();
    render(editGrid());

    await pressNote(first);
    await userEvent.click(headerSelect(bassId));

    expect(getSelectedTrackId()).toBe(bassId);
    expect(getEditingPlacementId()).toBeNull();
    expect(document.querySelector('[data-edit-placement][data-focused]')).toBeNull();
  });

  /**
   * THE UNDO COST, stated as a test rather than as prose: the edits are written
   * through and survive, the STEPS do not. `closePlacementEditing` clears the
   * pattern history on the way out, and milestone 3 keeps that model — what it
   * adds is saying so on screen while the block is open.
   */
  it('keeps the outgoing block’s edits and drops its undo history, and says so', async () => {
    const { first, bassId, onBass } = seedTwoEditTracks();
    render(editGrid());

    await pressNote(first);
    expect(screen.getByLabelText('Undo scope')).toHaveTextContent(/clears its undo history/i);
    await userEvent.keyboard('07');
    expect(fretsIn(first)).toEqual([7]);
    expect(screen.getByLabelText('Undo')).toBeEnabled();

    await userEvent.click(headerSelect(bassId));

    expect(fretsIn(first)).toEqual([7]);
    // The button and the shortcut are the same history, and both are now empty.
    expect(screen.getByLabelText('Undo')).toBeDisabled();
    await userEvent.keyboard('{Meta>}z{/Meta}');
    expect(fretsIn(first)).toEqual([7]);
    // No block is live, so the caveat is not on screen either.
    expect(screen.queryByLabelText('Undo scope')).toBeNull();

    // The next block's history is its own, and the toolbar's undo reaches it.
    await pressNote(onBass);
    await userEvent.keyboard('09');
    expect(fretsIn(onBass)).toEqual([9]);
    await userEvent.click(screen.getByLabelText('Undo'));
    expect(fretsIn(onBass)).toEqual([SOURCE_FRET]);
    expect(fretsIn(first)).toEqual([7]);
  });

  /**
   * ⚠ THE TWO CASES §4 SAYS MUST NOT BE CONFLATED. A write to ANOTHER track that
   * leaves the selection alone must leave the editor alone. Clicking that same
   * track's header SELECTS it, and so must close the editor. Same track, opposite
   * outcomes, and the difference is whether selection moved.
   */
  it('survives an unrelated track update, and closes on that track’s header press', async () => {
    const { first, bassId } = seedTwoEditTracks();
    render(editGrid());

    await pressNote(first);
    expect(getEditingPlacementId()).toBe(first);

    act(() => {
      const muted = setTrackMuted(bassId, true);
      if (!muted.ok) throw new Error(muted.reason);
    });

    expect(getEditingPlacementId()).toBe(first);
    expect(surfaceEl(first).dataset.focused).toBe('true');

    await userEvent.click(headerSelect(bassId));

    expect(getEditingPlacementId()).toBeNull();
  });

  it('clears the note selection on the way out, with or without a pattern to fall back to', () => {
    const { first } = seedTwoEditTracks();
    // Nothing remembered: `restorePatternPointer` is then a no-op, so the clear
    // cannot be a side effect of re-opening the previous pattern.
    usePatternsStore.setState({ editingPatternId: null });

    const opened = openPlacementForEditing(first);
    expect(opened.ok).toBe(true);
    selectNotes(getEditingPattern()!.events.map((event) => event.id));
    expect(getSelectedIds().length).toBeGreaterThan(0);

    closePlacementEditing();

    expect(getSelectedIds()).toEqual([]);
  });

  /**
   * LIB-GAP(26), from the side the branch does NOT cover. The lib nulls
   * `editingPlacementId` behind our back — `openComposition` calls
   * `openCompositionForArranging` before this seam's own cleanup runs — and
   * `openCompositionForArranging` leaves `selectedEventIds` alone. On that path
   * the `editingPlacementId !== null` branch is skipped entirely, so a clear
   * written inside it would never run and the ids of a closed snapshot would
   * stay selected, naming events that exist in the LIBRARY pattern too.
   */
  it('clears it even when the lib nulled the placement pointer first', () => {
    const { first } = seedTwoEditTracks();
    usePatternsStore.setState({ editingPatternId: null });

    const opened = openPlacementForEditing(first);
    expect(opened.ok).toBe(true);
    const ids = getEditingPattern()!.events.map((event) => event.id);
    selectNotes(ids);
    // Exactly what `openCompositionForArranging` does: the pointer goes, the
    // note selection stays.
    act(() => {
      usePatternsStore.setState({ editingPlacementId: null });
    });
    expect(getSelectedIds()).toEqual(ids);

    closePlacementEditing();

    expect(getSelectedIds()).toEqual([]);
  });

  /**
   * ⚠ And the case the clear must NOT touch: a library pattern open on the
   * pattern page owns its own selection, and leaving the composition page calls
   * this seam unconditionally.
   */
  it('leaves an open library pattern’s own note selection alone', () => {
    const { patternId } = seedTwoEditTracks();
    usePatternsStore.setState({ editingPatternId: patternId });
    const ids = getEditingPattern()!.events.map((event) => event.id);
    selectNotes(ids);

    // Nothing is open in the composition: this is the no-op call every page exit
    // makes.
    expect(getEditingPlacementId()).toBeNull();
    closePlacementEditing();

    expect(getSelectedIds()).toEqual(ids);
  });

  /**
   * §A's "close it when its placement/track disappears". `removeCompositionTrack`
   * is a plain `applyComposition` in the lib — unlike `removePlacement`, which
   * nulls the pointer itself — so nothing else closes the editor here, and a
   * dangling `editingPlacementId` makes every later note write hit nothing.
   */
  it('closes the editor when the open block’s track is removed', async () => {
    const { first, guitarId } = seedTwoEditTracks();
    render(editGrid());

    await pressNote(first);
    expect(getEditingPlacementId()).toBe(first);

    await act(async () => {
      const removed = removeTrack(guitarId);
      if (!removed.ok) throw new Error(removed.reason);
    });

    expect(getEditingPlacementId()).toBeNull();
  });

  /**
   * PAGE EXIT. Its own effect, keyed on nothing that changes, so it fires on
   * unmount and on nothing else — §A is explicit that an unconditional cleanup
   * keyed on the view map (which milestone 4 introduces) would fire on every
   * unrelated change instead. Without it the pattern page draws the block's
   * snapshot, which is the CP-02 family of defect.
   */
  it('closes the editor when the page unmounts', async () => {
    const { first } = seedTwoEditTracks();
    const { unmount } = render(editGrid());

    await pressNote(first);
    expect(getEditingPlacementId()).toBe(first);

    unmount();

    expect(getEditingPlacementId()).toBeNull();
  });

  /**
   * ⚠ THE PAIR §4 SAYS MUST NOT BE CONFLATED, now through the control that
   * actually makes a view change — the header's own view buttons
   * (COMPS-TRACK-TABS milestone 4). The mute test above is the same distinction
   * seen through an unrelated WRITE; this is it seen through an unrelated VIEW,
   * which is the state the milestone introduces and the one an unconditional
   * cleanup keyed on the view map would get wrong.
   */
  it('survives an unrelated track’s view change when the selection does not move', async () => {
    const { first, bassId } = seedTwoEditTracks();
    const composition = getEditingComposition()!;
    const allEdit = viewsOf('edit');
    const { rerender } = render(<ArrangementGrid views={allEdit} />);

    await pressNote(first);
    expect(getEditingPlacementId()).toBe(first);
    const guitarId = getTracks()[0].id;

    // The map moves for ANOTHER track and the selection stays put — the shape a
    // change arriving from the owner has (`App` holds the map; this page is not
    // the only thing that can write it). §4: a state update to an unrelated
    // track that preserves selection must PRESERVE the active editor, and an
    // unconditional cleanup keyed on the whole map is what gets this wrong.
    rerender(
      <ArrangementGrid
        views={setTrackView(allEdit, composition.id, bassId, 'voice')}
      />,
    );

    expect(getSelectedTrackId()).toBe(guitarId);
    expect(getEditingPlacementId()).toBe(first);
    expect(surfaceEl(first).dataset.focused).toBe('true');
  });

  /**
   * ⚠ THE PAIR §4 SAYS MUST NOT BE CONFLATED, now through the control that
   * actually makes a view change — the header's own view buttons
   * (COMPS-TRACK-TABS milestone 4). The same track's view button PRESERVES the
   * editor; another track's CLOSES it, because a view press selects its track
   * (§2). Same control, opposite outcomes, and the difference is whether
   * selection moved.
   */
  it('keeps the editor on a same-track view press and closes it on another track’s', async () => {
    const user = userEvent.setup();
    const { first, bassId } = seedTwoEditTracks();
    render(<OwnedEditGrid />);

    await pressNote(first);
    const guitarId = getTracks()[0].id;
    expect(getSelectedTrackId()).toBe(guitarId);

    // SAME TRACK, its already-active view: selects it again and preserves the
    // open block. §2 is explicit that the press still counts as a selection.
    await user.click(viewButton('Edit', guitarId));
    expect(getSelectedTrackId()).toBe(guitarId);
    expect(getEditingPlacementId()).toBe(first);
    expect(surfaceEl(first).dataset.focused).toBe('true');

    // ANOTHER track's view button: it selects that track, so it closes the
    // outgoing editor.
    await user.click(viewButton('Edit', bassId));
    expect(getSelectedTrackId()).toBe(bassId);
    expect(getEditingPlacementId()).toBeNull();
    // The edits survive; only the history goes (the documented cost).
    expect(fretsIn(first)).toEqual([SOURCE_FRET]);
  });

  /**
   * LEAVING EDIT ON THE OWNING TRACK. `activateTrack` deliberately KEEPS a block
   * that belongs to the track being activated — that is how re-selecting
   * preserves it — so the Pattern and Voice buttons are what have to give it up.
   *
   * ⚠ HONEST ABOUT WHAT COVERS IT. `changeTrackView` closes synchronously and
   * the grid's reconciler closes it again on the next effect
   * (`viewOfTrack(editingTrackId) !== 'edit'`), so this test PASSES with the
   * synchronous call stubbed out — probe-checked. What it pins is the outcome;
   * the synchronous half exists so no commit renders with the lib's editing
   * pointer parked on a lane that has stopped drawing it, and jsdom cannot see a
   * difference that lives inside one commit.
   */
  it('closes its own block when the track leaves Edit', async () => {
    const user = userEvent.setup();
    const { first } = seedTwoEditTracks();
    render(<OwnedEditGrid />);

    await pressNote(first);
    expect(getEditingPlacementId()).toBe(first);
    const guitarId = getTracks()[0].id;

    await user.click(viewButton('Pattern', guitarId));

    expect(getEditingPlacementId()).toBeNull();
    expect(getSelectedTrackId()).toBe(guitarId);
    // The lane is drawing blocks now, not surfaces.
    expect(document.querySelectorAll(`[data-edit-placement="${first}"]`)).toHaveLength(0);
    expect(fretsIn(first)).toEqual([SOURCE_FRET]);
  });

  /**
   * And the same press while a JOB owns the document: the button is DISABLED,
   * and the view does not move.
   *
   * ⚠ HONEST ABOUT WHICH HALF THIS IS. §4 asks for two — disable the buttons and
   * guard the callback — and only the first is assertable from here. React does
   * not dispatch synthetic mouse events on a disabled `button`
   * (`shouldPreventMouseEvent`), so a `fireEvent.click` on this control reaches
   * no handler and would pass against any callback whatsoever. The CALLBACK half
   * is `changeTrackView`'s opening `if (!activateTrack(...)) return`, and it is
   * the coordinator's own refusal — covered, through a control that is not
   * disabled, by 'refuses every activation path…' in the next describe.
   */
  it('refuses a view press while a job holds the document', async () => {
    const { first, bassId } = seedTwoEditTracks();
    render(<OwnedEditGrid />);
    await pressNote(first);

    act(() => {
      const started = beginJob();
      if (!started.ok) throw new Error('job refused');
    });

    const button = viewButton('Voice', bassId);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-pressed', 'false');
    // The job's block is still the open one, and the lock is what is keeping the
    // view where it is: every view button in the stack is out of reach.
    expect(viewButton('Pattern', bassId)).toBeDisabled();
    expect(getEditingPlacementId()).toBe(first);

    act(() => endJob());
  });
});

describe('the activation coordinator — while a generation job holds the document', () => {
  it('refuses every activation path and suppresses the note keyboard, without closing the job’s block', async () => {
    const { first, guitarId, bassId, onBass } = seedTwoEditTracks();
    render(editGrid());

    await pressNote(first);
    expect(getEditingPlacementId()).toBe(first);

    const job = beginJob();
    if (!job.ok) throw new Error(job.reason);
    // The lock is not React state the render knows about; the hook subscribes.
    await act(async () => {});

    // THE POINTER IS THE JOB'S. The UI stops owning it and does NOT close it:
    // closing would repoint the lib's one pattern pointer out from under the
    // agent, and a cancel does not put the agent's notes back.
    expect(getEditingPlacementId()).toBe(first);
    expect(surfaceEl(first).dataset.focused).toBeUndefined();

    // A header press is refused, and says why.
    await userEvent.click(headerSelect(bassId));
    expect(getSelectedTrackId()).toBe(guitarId);
    expect(trackAlert()).toHaveTextContent(JOB_LOCK_REASON);

    // So is a surface taking focus — and the refusal must not fall through into
    // the note gesture underneath it.
    await pressNote(onBass);
    expect(getEditingPlacementId()).toBe(first);
    expect(fretsIn(onBass)).toEqual([SOURCE_FRET]);

    // No surface is focused, so no window key listener is attached at all.
    await userEvent.keyboard('12');
    expect(fretsIn(first)).toEqual([SOURCE_FRET]);

    // An EXTERNAL selection change during the job — the agent's own
    // `selectTrack`, which stays pointer-free and view-free — must not trip UI
    // cleanup of the job's pointer.
    await act(async () => {
      selectTrack(bassId);
    });
    expect(getEditingPlacementId()).toBe(first);
  });

  /**
   * A REFUSAL REPEATED IS A REFUSAL ANNOUNCED. `role="alert"` fires when its
   * content is inserted, and setting the same string twice is a React bail-out
   * that renders nothing — so a second and third refused press during a job
   * would be silent to a screen reader while looking identical on screen. The
   * coordinator refuses with the same sentence on every path, which makes that
   * the common case rather than a corner; the alert is keyed on a counter so
   * each set replaces the node.
   */
  it('re-announces the same refusal on every refused press', async () => {
    const { first, bassId, guitarId } = seedTwoEditTracks();
    render(editGrid());

    await pressNote(first);
    const job = beginJob();
    if (!job.ok) throw new Error(job.reason);
    await act(async () => {});

    await userEvent.click(headerSelect(bassId));
    const firstAlert = trackAlert();
    expect(firstAlert).toHaveTextContent(JOB_LOCK_REASON);

    await userEvent.click(headerSelect(guitarId));
    const secondAlert = trackAlert();
    expect(secondAlert).toHaveTextContent(JOB_LOCK_REASON);
    // A NEW node, which is the whole of what makes it announce again.
    expect(secondAlert).not.toBe(firstAlert);

    await act(async () => {
      endJob();
    });
  });

  /**
   * §E lists JOB OWNERSHIP as an invalidator, and the arrangement's own gestures
   * fold `isJobRunning()` into `invalidated`. A NOTE drag has no equivalent: its
   * listeners are on `window`, `focused` going false ends none of them (that is
   * the whole reason `endOutgoingWork` exists), and `patternService`'s writes are
   * not behind the job lock — so without the reconciler ending the work, a drag
   * in flight when a job starts keeps writing into the block the agent now owns,
   * with an undo bracket held open across the run.
   */
  it('ends an in-flight note drag when a job takes the document', async () => {
    const { patternId, first } = seedTwoEditTracks();
    // The pattern the seam falls back to, pinned to the riff for the reason the
    // programmatic-drag test gives: a snapshot copies event ids verbatim, so a
    // leaked drag is SEEN to move the library pattern.
    usePatternsStore.setState({ editingPatternId: patternId });
    const user = userEvent.setup();
    render(editGrid());
    const libraryStarts = () =>
      findLibraryPattern(patternId)!.events.map((event) => event.startTick);

    await user.pointer([
      { target: noteIn(first), keys: '[MouseLeft>]', coords: { clientX: 0, clientY: 0 } },
      { coords: { clientX: PX_PER_BEAT, clientY: 0 } },
    ]);
    const draggedTo = placementById(first).patternSnapshot.events[0].startTick;
    expect(draggedTo).toBeGreaterThan(0);
    const libraryBefore = libraryStarts();

    const job = beginJob();
    if (!job.ok) throw new Error(job.reason);
    await act(async () => {});

    // Still down, still moving, and now reaching nothing.
    await user.pointer([
      { coords: { clientX: PX_PER_BEAT * 5, clientY: 0 } },
      { keys: '[/MouseLeft]' },
    ]);

    expect(placementById(first).patternSnapshot.events[0].startTick).toBe(draggedTo);
    expect(libraryStarts()).toEqual(libraryBefore);

    await act(async () => {
      endJob();
    });
  });

  it('reconciles against live state when the job completes, and activates normally after', async () => {
    const { first, bassId, onBass } = seedTwoEditTracks();
    render(editGrid());

    await pressNote(first);
    const job = beginJob();
    if (!job.ok) throw new Error(job.reason);
    await act(async () => {
      selectTrack(bassId);
    });

    await act(async () => {
      job.value();
    });

    // The selected track is the bass and the open block is the guitar's, so the
    // block the job left open is closed — the reconciliation §4 defers until
    // ownership is handed back.
    expect(getEditingPlacementId()).toBeNull();

    await pressNote(onBass);
    expect(getEditingPlacementId()).toBe(onBass);
    await userEvent.keyboard('12');
    expect(fretsIn(onBass)).toEqual([12]);
    expect(fretsIn(first)).toEqual([SOURCE_FRET]);
  });

  it('activates normally after a CANCELLED job too', async () => {
    const { first, guitarId, onBass } = seedTwoEditTracks();
    render(editGrid());

    await pressNote(first);
    const job = beginJob();
    if (!job.ok) throw new Error(job.reason);
    await act(async () => {});
    expect(surfaceEl(first).dataset.focused).toBeUndefined();

    // The unconditional escape hatch, which is what a cancelled run reaches for.
    await act(async () => {
      endJob();
    });

    // Nothing moved while the job ran, so the block it left open is still the
    // selected track's and stays open — ownership simply comes back.
    expect(getSelectedTrackId()).toBe(guitarId);
    expect(getEditingPlacementId()).toBe(first);
    expect(surfaceEl(first).dataset.focused).toBe('true');

    await userEvent.keyboard('12');
    expect(fretsIn(first)).toEqual([12]);

    await pressNote(onBass);
    expect(getEditingPlacementId()).toBe(onBass);
  });
});

describe('the activation coordinator — ownership of a block nobody selected', () => {
  /**
   * `openPlacementForEditing` is reachable by id with no pointer, which is the
   * standing rule for every capability here — so the page must not disown what
   * the agent opened. It ADOPTS the owning track instead of closing the block,
   * which is the one case where reconciliation writes the selection rather than
   * the pointer.
   */
  it('adopts the owning track when a block is opened by id with nothing selected', async () => {
    const { first, guitarId } = seedTwoEditTracks();
    render(editGrid());
    expect(getSelectedTrackId()).toBeNull();

    await act(async () => {
      const opened = openPlacementForEditing(first);
      if (!opened.ok) throw new Error(opened.reason);
    });

    expect(getSelectedTrackId()).toBe(guitarId);
    expect(getEditingPlacementId()).toBe(first);
    expect(surfaceEl(first).dataset.focused).toBe('true');
  });

  it('closes a block whose track loses the selection from outside', async () => {
    const { first, bassId } = seedTwoEditTracks();
    render(editGrid());

    await pressNote(first);
    await act(async () => {
      selectTrack(bassId);
    });

    expect(getEditingPlacementId()).toBeNull();
  });

  /**
   * The RECONCILER has to end the outgoing work too, and its trigger is a
   * `selectTrack` from outside this page — the agent's, or another surface's.
   * That is neither a pointerdown nor a keydown, so none of `NoteSurface`'s own
   * capture-phase run-enders fire, and `focused` going false does not end a
   * pointer gesture. Without the teardown the drag keeps writing, into whatever
   * the seam has repointed at by then.
   */
  it('ends an in-flight drag when the selection is taken away programmatically', async () => {
    const { patternId, first, bassId } = seedTwoEditTracks();
    usePatternsStore.setState({ editingPatternId: patternId });
    const user = userEvent.setup();
    render(editGrid());
    const libraryStarts = () =>
      findLibraryPattern(patternId)!.events.map((event) => event.startTick);

    await user.pointer([
      { target: noteIn(first), keys: '[MouseLeft>]', coords: { clientX: 0, clientY: 0 } },
      { coords: { clientX: PX_PER_BEAT, clientY: 0 } },
    ]);
    const draggedTo = placementById(first).patternSnapshot.events[0].startTick;
    expect(draggedTo).toBeGreaterThan(0);
    const libraryBefore = libraryStarts();

    await act(async () => {
      selectTrack(bassId);
    });
    await user.pointer([
      { coords: { clientX: PX_PER_BEAT * 5, clientY: 0 } },
      { keys: '[/MouseLeft]' },
    ]);

    expect(getEditingPlacementId()).toBeNull();
    expect(placementById(first).patternSnapshot.events[0].startTick).toBe(draggedTo);
    expect(libraryStarts()).toEqual(libraryBefore);
  });
});

/**
 * COMPS-TRACK-TABS milestone 3 §B — the same keyboard boundary, at the OTHER
 * call site.
 *
 * `NoteSurface` renders on both pages, and its window key handler used the same
 * literal `'input, textarea, select, [contenteditable]'` the arrangement used.
 * Neither covered the voice editor's dials: `Knob` is `role="slider"` and
 * `ParamEncoder` is `role="spinbutton"`. Both call `preventDefault` and neither
 * calls `stopPropagation`, so ArrowUp over a dial reached this handler and
 * nudged the selected note's fret as well as turning the dial.
 *
 * The dials are rendered BESIDE the grid rather than inside it, because the
 * handler is on `window` and does not care where in the document the keystroke
 * came from — which is the whole of the defect. A rack that is genuinely in the
 * same stack as an edit lane arrives with milestone 4's per-track views.
 */
describe('note shortcuts stop at a local control', () => {
  function Dial({ kind }: { kind: 'knob' | 'encoder' }) {
    const [value, setValue] = useState(kind === 'knob' ? 3 : 0);
    return kind === 'knob' ? (
      <Knob
        value={value}
        onChange={setValue}
        min={0}
        max={10}
        step={1}
        label="Drive"
        ariaLabel="Drive"
      />
    ) : (
      <ParamEncoder
        value={value}
        onChange={setValue}
        step={1}
        precision={0}
        fallback={0}
        label="Offset"
        ariaLabel="Offset"
      />
    );
  }

  it('lets a focused Knob have ArrowUp to itself', async () => {
    const { first } = seedArrangement();
    const user = userEvent.setup();
    render(
      <>
        {editGrid()}
        <Dial kind="knob" />
      </>,
    );

    await pressNote(first);
    const knob = screen.getByRole('slider', { name: 'Drive' });
    knob.focus();
    await user.keyboard('{ArrowUp}');

    expect(knob).toHaveAttribute('aria-valuenow', '4');
    expect(fretsIn(first)).toEqual([SOURCE_FRET]);
  });

  it('lets a focused ParamEncoder have ArrowUp to itself', async () => {
    const { first } = seedArrangement();
    const user = userEvent.setup();
    render(
      <>
        {editGrid()}
        <Dial kind="encoder" />
      </>,
    );

    await pressNote(first);
    const encoder = screen.getByRole('spinbutton', { name: 'Offset' });
    encoder.focus();
    await user.keyboard('{ArrowUp}');

    expect(encoder).toHaveAttribute('aria-valuenow', '1');
    expect(fretsIn(first)).toEqual([SOURCE_FRET]);
  });

  /**
   * THE OTHER HALF, and the one that matters most: the surface's own shortcuts
   * are unchanged. The pattern page renders this same component with no host
   * callbacks at all, so "still works with nothing local focused" is the
   * behaviour that must not have moved.
   */
  it('still nudges the note when nothing local has focus', async () => {
    const { first } = seedArrangement();
    const user = userEvent.setup();
    render(
      <>
        {editGrid()}
        <Dial kind="knob" />
      </>,
    );

    await pressNote(first);
    await user.keyboard('{ArrowUp}');

    expect(fretsIn(first)).toEqual([SOURCE_FRET + 1]);
  });
});

/**
 * §4's command-context table, in the one row that is a deliberate change of
 * behaviour: EDIT VIEW WITH NO BLOCK LIVE DISABLES UNDO.
 *
 * It used to point at the note history unconditionally, and the note history in
 * that state is the PATTERN PAGE's — so a press undid an edit made to a document
 * that is not on screen, with nothing in either stack to put it back.
 */
describe('the direct-editing command context', () => {
  it('disables undo in edit view until a block is live', async () => {
    const { first } = seedArrangement();
    render(editGrid());

    // A step waiting in the pattern seam's history, made before anything here
    // was opened — exactly what the old wiring would have offered to undo.
    act(() => {
      openBlankPattern('Elsewhere');
      stampNote({ stringIndex: 0, fret: 3, tick: 0, durationTicks: PPQ });
    });
    expect(screen.getByLabelText('Undo')).toBeDisabled();

    await pressNote(first);
    await userEvent.keyboard('{ArrowUp}');
    // Live block, note history, enabled — and it acts on THIS block.
    expect(screen.getByLabelText('Undo')).toBeEnabled();
    await userEvent.click(screen.getByLabelText('Undo'));
    expect(fretsIn(first)).toEqual([SOURCE_FRET]);
  });
});

/**
 * COMPS-TRACK-TABS milestone 3 §4/§5, at the PAGE level rather than at the hook's.
 */
describe('the page ends its work before it changes the ground', () => {
  /**
   * ⚠ THE ZOOM HALF OF §5 IS NOT ASSERTED HERE, AND CANNOT BE. `zoomTo` ends
   * every in-flight gesture before it changes the scale, but a press on the Zoom
   * button is a `pointerup` — which the drag's own window listener already
   * catches — and a keyboard activation of it is a `keydown`, which
   * `NoteSurface`'s handler already treats as the end of a key run. Every route
   * to that button therefore ends the work BEFORE `zoomTo` runs, so no test
   * through the UI can tell the teardown from the button press.
   *
   * The reachable half of the same requirement — a scale that changes UNDER a
   * live gesture — is asserted at the hook, where it can be driven directly:
   * "ends on a zoom change rather than mixing two scales" in
   * tests/ArrangementGestures.test.tsx.
   */

  /**
   * §4: "NoteSurface focus and arrangement KEYBOARD eligibility stay mutually
   * exclusive". ⌘A is the sharpest probe — the arrangement answers it and the
   * note surface does not, so a surface that let it through would leave every
   * block in the composition selected under an open note editor, and the next
   * ⌫ would delete blocks instead of notes.
   */
  it('gives the arrangement no keyboard while a block is live', async () => {
    const { first } = seedArrangement();
    const user = userEvent.setup();
    render(editGrid());

    await pressNote(first);
    await user.keyboard('{Meta>}a{/Meta}');

    expect(getSelectedPlacementIds()).toEqual([]);
  });
});
