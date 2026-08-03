import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_PATTERNS_STATE,
  PPQ,
  usePatternsStore,
  type Placement,
} from '@fretwork/lib';
import { App } from '../src/App';
import { ArrangementGrid } from '../src/composition/ArrangementGrid';
import { CompositionPage } from '../src/composition/CompositionPage';
import {
  ARRANGEMENT_ZOOM_LEVELS,
  DEFAULT_ARRANGEMENT_ZOOM_INDEX,
  arrangementWidth,
  editLaneHeight,
  editableSpans,
  tickToPx,
} from '../src/composition/arrangementMath';
import {
  addPlacement,
  addTrack,
  clearHistory,
  closePlacementEditing,
  ensureComposition,
  getEditingPlacementId,
  getTracks,
  movePlacement,
  openBlankComposition,
  openPlacementForEditing,
  removePlacement,
  selectPlacements,
  selectTrack,
} from '../src/composition/compositionService';
import {
  clearHistory as clearPatternHistory,
  findLibraryPattern,
  getEditingPattern,
  getLibraryPatterns,
  getSelectedIds,
  openBlankPattern,
  redo,
  stampNote,
  undo,
} from '../src/patterns/patternService';

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
  ensureComposition();
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

const editGrid = () => <ArrangementGrid mode="edit" />;

describe('what an edit-mode lane draws', () => {
  it('mounts one editable surface per placement, at the block’s own rect', () => {
    const { first, second } = seedArrangement();
    render(editGrid());

    const spans = editableSpans(getTracks()[0], PX_PER_BEAT, editLaneHeight(6));
    expect(spans.map((span) => span.placementId)).toEqual([first, second]);
    for (const span of spans) {
      const el = surfaceEl(span.placementId);
      // Compared against a fresh call, so a changed rect policy fails here
      // rather than splitting the drawing and the geometry silently.
      expect(el.style.left).toBe(`${span.rect.left}px`);
      expect(el.style.width).toBe(`${span.rect.width}px`);
    }
  });

  it('fits a lane to its own track’s string count', () => {
    seedArrangement();
    render(editGrid());

    const [guitarLane, bassLane] = document.querySelectorAll<HTMLElement>('[data-lane-track]');
    expect(guitarLane.style.height).toBe(`${editLaneHeight(6)}px`);
    expect(bassLane.style.height).toBe(`${editLaneHeight(4)}px`);
    // A lane's rows are the SURFACE's, and they come from the track's neck: six
    // for the guitar, whatever the snapshot inside was written on.
    expect(surfaceEl(placements()[0].id).querySelectorAll('[data-lane]')).toHaveLength(6);
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
    const { rerender } = render(<ArrangementGrid mode="pattern" />);
    rerender(<ArrangementGrid mode="pattern" />);
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

  it('does not let ⌘Z in edit mode pop an ARRANGEMENT step as well', async () => {
    const { second, bassId } = seedArrangement();
    // An arrangement step to lose: a block moved onto the other track.
    const tracksBefore = getTracks();
    movePlacement(second, bassId, 0);
    expect(getTracks()).not.toBe(tracksBefore);
    const placedOnBass = getTracks()[1].placements.map((p) => p.id);

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

  it('points the toolbar’s undo at the document the mode is editing', async () => {
    const { first, second, guitarId } = seedArrangement();
    const { rerender } = render(<ArrangementGrid mode="pattern" />);

    // A step in the COMPOSITION history — the one the toolbar is wired to in
    // pattern mode, and the one it must stop being wired to in edit mode.
    movePlacement(second, guitarId, 6 * BAR_TICKS);
    expect(placementById(second).startTick).toBe(6 * BAR_TICKS);

    rerender(<ArrangementGrid mode="edit" />);
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
    ensureComposition();
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
      <CompositionPage mode="edit" onModeChange={() => {}} />,
    );

    await userEvent.pointer({ target: noteIn(second), keys: '[MouseLeft]' });
    expect(getEditingPlacementId()).toBe(second);
    expect(getEditingPattern()).not.toBe(findLibraryPattern(patternId));

    rerender(<CompositionPage mode="pattern" onModeChange={() => {}} />);

    expectPatternPagePointer(patternId);
  });

  it('restores it when the composition page unmounts', async () => {
    const { patternId, second } = seedArrangement();
    const { unmount } = render(<CompositionPage mode="edit" onModeChange={() => {}} />);

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
    const { rerender } = render(<CompositionPage mode="edit" onModeChange={() => {}} />);

    await userEvent.pointer({ target: noteIn(second), keys: '[MouseLeft]' });
    expect(getSelectedIds()).toHaveLength(1);

    rerender(<CompositionPage mode="pattern" onModeChange={() => {}} />);

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
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Composition mode' })).getByRole('button', {
        name: 'Edit mode',
      }),
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
    const { rerender } = render(<ArrangementGrid mode="pattern" />);

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

    rerender(<ArrangementGrid mode="edit" />);

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
    seedArrangement();
    const { rerender } = render(<ArrangementGrid mode="pattern" />);
    expect(screen.getByLabelText('Arrangement snap')).toHaveValue('bar');

    rerender(<ArrangementGrid mode="edit" />);
    // Note entry needs sub-beat resolution where block placement does not, so
    // the two settings are separate and the mode chooses which is on screen.
    expect(screen.getByLabelText('Note grid')).toHaveValue('16');
    await userEvent.selectOptions(screen.getByLabelText('Note grid'), '8');

    rerender(<ArrangementGrid mode="pattern" />);
    expect(screen.getByLabelText('Arrangement snap')).toHaveValue('bar');
  });
});
