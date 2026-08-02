import { useCallback, useRef } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PATTERNS_STATE,
  PPQ,
  placementEffectiveLength,
  ticksPerBar,
  usePatternsStore,
  type Placement,
  type Track,
} from '@fretwork/lib';
import {
  ARRANGEMENT_ZOOM_LEVELS,
  DEFAULT_ARRANGEMENT_SNAP_ID,
  DEFAULT_ARRANGEMENT_ZOOM_INDEX,
  arrangementSnap,
  droppedByTranspose,
  laneRects,
  tickToPx,
} from '../src/composition/arrangementMath';
import { ArrangementGrid } from '../src/composition/ArrangementGrid';
import {
  addPlacement,
  addTrack,
  clearHistory,
  ensureComposition,
  getEditingComposition,
  getSelectedPlacementIds,
  getTracks,
  removePlacement,
  selectPlacements,
  selectTrack,
  setPlacementTranspose,
  undo,
  useEditingComposition,
  useTracks,
} from '../src/composition/compositionService';
import {
  appendPatternToTrack,
  deleteSelectedPlacements,
  duplicateSelectedPlacements,
  patternDropRefusal,
  selectAllPlacements,
  splitSelectedPlacements,
  transposeSelectedPlacements,
  useArrangementGestures,
  type GestureGeometry,
} from '../src/composition/useArrangementGestures';
import {
  getEditingPattern,
  getLibraryPatterns,
  openBlankPattern,
  setEditingPatternInstrument,
  stampNote,
  useLibraryPatterns,
} from '../src/patterns/patternService';
import { installFrameClock } from './frameClock';

/**
 * The arrangement's gesture machine (CP-05 + CP-06).
 *
 * jsdom has NO LAYOUT: every `getBoundingClientRect` is 0×0, so a test that
 * pressed a real block element and asked the DOM where it was would assert
 * nothing at all. What is exercised instead is the STATE MACHINE — pointer
 * down/move/up sequences against a geometry the test supplies — over the REAL
 * `hitTest`, `laneRects` and `placementRect`. The one thing faked is
 * `toContent`, which is made the identity, so a `clientX` in these tests IS a
 * lane-content pixel and a `clientY` IS a distance down the lane stack.
 *
 * That is the whole reason the geometry is a pure module: the gestures can be
 * driven with exact coordinates and the arithmetic under them is the same
 * arithmetic the browser runs.
 *
 * Undo is asserted by COUNTING, never by `canUndo` alone: a gesture is correct
 * only if the whole of it collapses to exactly one step, so each test undoes
 * once, checks the arrangement is back, and checks there is nothing left to
 * undo.
 */

const PX = ARRANGEMENT_ZOOM_LEVELS[DEFAULT_ARRANGEMENT_ZOOM_INDEX];
const LANE_HEIGHT = laneRects([{ id: 'probe' }], 'pattern')[0].height;

beforeEach(() => {
  sessionStorage.clear();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  selectPlacements([]);
  selectTrack(null);
  clearHistory();
});

// ------------------------------------------------------------------ seeds ---

/** A library pattern `beats` long. The note matters: the lib auto-fits a
 *  pattern's length to its content, so stamping is the only way to set one. */
function seedPattern(name: string, beats = 4, instrumentId?: 'guitar' | 'bass'): string {
  openBlankPattern(name);
  if (instrumentId) setEditingPatternInstrument(instrumentId);
  const pattern = getEditingPattern();
  if (!pattern) throw new Error('pattern seam did not open a pattern');
  stampNote({ stringIndex: 0, fret: 5, tick: 0, durationTicks: beats * PPQ });
  return pattern.id;
}

function place(patternId: string, trackId: string, atTick: number): string {
  const result = addPlacement(patternId, trackId, atTick);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

/** Two tracks, both guitar. Track 0 holds two one-bar blocks, track 1 one. */
function seedArrangement() {
  ensureComposition();
  const patternId = seedPattern('Riff');
  addTrack('Rhythm');
  const trackIds = getTracks().map((t) => t.id);
  const a = place(patternId, trackIds[0], 0);
  const b = place(patternId, trackIds[0], 2 * bar());
  const c = place(patternId, trackIds[1], 0);
  selectPlacements([]);
  clearHistory();
  return { patternId, trackIds, a, b, c };
}

function bar(): number {
  const composition = getEditingComposition();
  if (!composition) throw new Error('no composition open');
  return ticksPerBar(composition.timeSignature);
}

function findBlock(id: string): { track: Track; placement: Placement } {
  for (const track of getTracks()) {
    const placement = track.placements.find((p) => p.id === id);
    if (placement) return { track, placement };
  }
  throw new Error(`no placement ${id}`);
}

const startOf = (id: string) => findBlock(id).placement.startTick;
const lengthOf = (id: string) => placementEffectiveLength(findBlock(id).placement);
const trackOf = (id: string) => findBlock(id).track.id;
const countPlacements = () =>
  getTracks().reduce((total, track) => total + track.placements.length, 0);

// ---------------------------------------------------------------- harness ---

/**
 * The smallest thing that can hold the hook: a lane surface with the two
 * handlers on it, a stand-in library row per pattern, and whatever preview and
 * refusal the gesture produces.
 *
 * `toContent` is the identity, so coordinates in these tests are lane-content
 * coordinates. The lane rects, tracks, zoom and snap are the real ones.
 */
function Harness({ inViewport }: { inViewport?: (x: number, y: number) => boolean } = {}) {
  const patterns = useLibraryPatterns();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const geometryRef = useRef<GestureGeometry | null>(null);

  // Reactive reads, matching `ArrangementGrid`: every arrangement write has to
  // re-render this or the geometry a gesture reads goes stale mid-drag.
  const composition = useEditingComposition();
  const tracks = useTracks();
  geometryRef.current = composition
    ? {
        lanes: laneRects(tracks, 'pattern'),
        tracks,
        pxPerBeat: PX,
        snap: arrangementSnap(composition.timeSignature, DEFAULT_ARRANGEMENT_SNAP_ID),
        toContent: (clientX: number, clientY: number) => ({ x: clientX, y: clientY }),
        // Everything is over the lanes unless a test says otherwise — the real
        // one says the same of a degenerate box, because jsdom measures every
        // element 0×0 and a strict reading would refuse every drop in the file.
        inViewport: inViewport ?? (() => true),
      }
    : null;

  const gestures = useArrangementGestures({
    geometry: useCallback(() => geometryRef.current, []),
    scrollerRef,
  });

  return (
    <div ref={scrollerRef} data-testid="scroller">
      <div
        data-testid="lanes"
        onPointerDown={gestures.onLanesPointerDown}
        onPointerMove={gestures.onLanesPointerMove}
        // A real box would be nice and is not available; the identity
        // `toContent` is what stands in for one.
        style={{ width: 4000, height: LANE_HEIGHT * tracks.length }}
      />
      <button type="button" onClick={gestures.splitAtCursor}>
        split
      </button>
      {patterns.map((pattern) => (
        <button
          key={pattern.id}
          type="button"
          aria-label={`library ${pattern.name}`}
          onPointerDown={(e) => gestures.startPatternDrag(pattern.id, e)}
        >
          {pattern.name}
        </button>
      ))}
      {gestures.preview && (
        <p
          data-testid={`preview-${gestures.preview.kind}`}
          data-left={gestures.preview.left}
          data-top={gestures.preview.top}
          data-width={gestures.preview.width}
          data-height={gestures.preview.height}
          data-refused={
            gestures.preview.kind === 'drop' ? (gestures.preview.refusal ?? '') : ''
          }
        />
      )}
      {gestures.refusal && <p role="alert">{gestures.refusal}</p>}
    </div>
  );
}

const lanes = () => screen.getByTestId('lanes');

/** Distance down the lane stack to the middle of lane `index`. */
const laneY = (index: number) => index * LANE_HEIGHT + LANE_HEIGHT / 2;

/** A pixel inside a block's body — past the trim handle, which is 8px wide. */
const bodyX = (tick: number) => tickToPx(tick, PX) + 40;

/** Drag from one point through the rest, releasing at the last. Nothing here
 *  passes a target after the first press: the gesture's listeners are on
 *  `window`, which is the point of them. */
async function dragFrom(
  user: ReturnType<typeof userEvent.setup>,
  target: Element,
  points: { x: number; y: number }[],
  opts: { shift?: boolean } = {},
) {
  const [first, ...rest] = points;
  if (opts.shift) await user.keyboard('{Shift>}');
  await user.pointer([
    { target, keys: '[MouseLeft>]', coords: { clientX: first.x, clientY: first.y } },
    ...rest.map((point) => ({ coords: { clientX: point.x, clientY: point.y } })),
    { keys: '[/MouseLeft]' },
  ]);
  if (opts.shift) await user.keyboard('{/Shift}');
}

/** A press that never moves — the case that must NOT push an undo step. */
async function clickAt(
  user: ReturnType<typeof userEvent.setup>,
  target: Element,
  point: { x: number; y: number },
  opts: { shift?: boolean } = {},
) {
  if (opts.shift) await user.keyboard('{Shift>}');
  await user.pointer({
    target,
    keys: '[MouseLeft]',
    coords: { clientX: point.x, clientY: point.y },
  });
  if (opts.shift) await user.keyboard('{/Shift}');
}

// -------------------------------------------------------------------------- //

describe('moving a block', () => {
  it('lands it on the snapped tick the pointer asked for', async () => {
    const user = userEvent.setup();
    const { a } = seedArrangement();
    render(<Harness />);

    await dragFrom(user, lanes(), [
      { x: bodyX(0), y: laneY(0) },
      { x: bodyX(0) + tickToPx(bar(), PX), y: laneY(0) },
    ]);

    expect(startOf(a)).toBe(bar());
  });

  it('snaps to the bar, so a drop a sixteenth late still lands on the downbeat', async () => {
    const user = userEvent.setup();
    const { a } = seedArrangement();
    render(<Harness />);

    await dragFrom(user, lanes(), [
      { x: bodyX(0), y: laneY(0) },
      { x: bodyX(0) + tickToPx(bar() + PPQ / 4, PX), y: laneY(0) },
    ]);

    expect(startOf(a)).toBe(bar());
  });

  it('collapses the whole drag to exactly one undo step, however many moves it took', async () => {
    const user = userEvent.setup();
    const { a } = seedArrangement();
    render(<Harness />);

    await dragFrom(user, lanes(), [
      { x: bodyX(0), y: laneY(0) },
      { x: bodyX(0) + tickToPx(bar(), PX), y: laneY(0) },
      { x: bodyX(0) + tickToPx(2 * bar(), PX), y: laneY(0) },
      { x: bodyX(0) + tickToPx(3 * bar(), PX), y: laneY(0) },
      { x: bodyX(0) + tickToPx(4 * bar(), PX), y: laneY(0) },
    ]);
    expect(startOf(a)).toBe(4 * bar());

    undo();
    expect(startOf(a)).toBe(0);
    // Nothing left: five pointer moves were one step, not five.
    undo();
    expect(startOf(a)).toBe(0);
  });

  it('carries the block across lanes', async () => {
    const user = userEvent.setup();
    const { a, trackIds } = seedArrangement();
    render(<Harness />);

    await dragFrom(user, lanes(), [
      { x: bodyX(0), y: laneY(0) },
      { x: bodyX(0) + tickToPx(4 * bar(), PX), y: laneY(1) },
    ]);

    expect(trackOf(a)).toBe(trackIds[1]);
    expect(startOf(a)).toBe(4 * bar());
  });

  it('moves a whole selection, preserving every relative offset', async () => {
    const user = userEvent.setup();
    const { a, b, c, trackIds } = seedArrangement();
    selectPlacements([a, b, c]);
    render(<Harness />);

    // Grab `a`, which is inside the selection, so the group travels with it.
    await dragFrom(user, lanes(), [
      { x: bodyX(0), y: laneY(0) },
      { x: bodyX(0) + tickToPx(4 * bar(), PX), y: laneY(0) },
    ]);

    expect(startOf(a)).toBe(4 * bar());
    expect(startOf(b)).toBe(6 * bar()); // was two bars after `a`, still is
    expect(startOf(c)).toBe(4 * bar()); // was level with `a`, still is
    expect(trackOf(c)).toBe(trackIds[1]); // and stayed in its own lane
  });

  it('replaces the selection when a block outside it is grabbed', async () => {
    const user = userEvent.setup();
    const { a, b } = seedArrangement();
    selectPlacements([a]);
    render(<Harness />);

    await clickAt(user, lanes(), { x: bodyX(2 * bar()), y: laneY(0) });

    expect(getSelectedPlacementIds()).toEqual([b]);
  });

  it('pushes NO undo step for a click that never became a drag', async () => {
    const user = userEvent.setup();
    const { a } = seedArrangement();
    render(<Harness />);

    await clickAt(user, lanes(), { x: bodyX(0), y: laneY(0) });

    expect(getSelectedPlacementIds()).toEqual([a]);
    // A dead step here would eat the previous real edit on the next undo.
    removePlacement(a);
    undo();
    expect(countPlacements()).toBe(3);
  });

  /**
   * The instrument rule CP-05 states out loud is defeated entirely if a block
   * can be placed on the right track and then dragged down onto the wrong one.
   */
  it('refuses to carry a block onto a track of another instrument, and keeps moving it along its own', async () => {
    const user = userEvent.setup();
    ensureComposition();
    const patternId = seedPattern('Riff');
    addTrack('Low', 'bass');
    const trackIds = getTracks().map((t) => t.id);
    const id = place(patternId, trackIds[0], 0);
    selectPlacements([]);
    clearHistory();
    render(<Harness />);

    await dragFrom(user, lanes(), [
      { x: bodyX(0), y: laneY(0) },
      { x: bodyX(0) + tickToPx(2 * bar(), PX), y: laneY(1) },
    ]);

    expect(trackOf(id)).toBe(trackIds[0]);
    // The lane change is what is refused, not the drag: the block still travels
    // the two bars the pointer took it.
    expect(startOf(id)).toBe(2 * bar());
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/guitar pattern/);
    expect(alert).toHaveTextContent(/bass track/);
  });

  it('toggles the selection on shift, and moves nothing', async () => {
    const user = userEvent.setup();
    const { a, b } = seedArrangement();
    selectPlacements([a]);
    render(<Harness />);

    await clickAt(user, lanes(), { x: bodyX(2 * bar()), y: laneY(0) }, { shift: true });
    expect([...getSelectedPlacementIds()].sort()).toEqual([a, b].sort());

    await clickAt(user, lanes(), { x: bodyX(2 * bar()), y: laneY(0) }, { shift: true });
    expect(getSelectedPlacementIds()).toEqual([a]);
    expect(startOf(b)).toBe(2 * bar());
  });
});

describe('trimming a block', () => {
  /**
   * A FOUR-bar block, alone on its track.
   *
   * Deliberately not the one-bar block the other suites use: the arrangement
   * snaps to the BAR, so a one-bar block cannot be trimmed to anything except
   * itself or the lib's one-beat floor, and a test written against it would
   * pass whatever the trim did.
   */
  /** `atBars` rather than a tick, because the caller cannot ask how long a bar
   *  is until a composition is open — which is this function's first act. */
  function seedLongBlock(atBars = 0) {
    ensureComposition();
    const patternId = seedPattern('Verse', 16);
    const id = place(patternId, getTracks()[0].id, atBars * bar());
    selectPlacements([]);
    clearHistory();
    return { id, patternId };
  }

  it('sets the length from the right edge, leaving the start alone', async () => {
    const user = userEvent.setup();
    const { id } = seedLongBlock();
    render(<Harness />);
    expect(lengthOf(id)).toBe(4 * bar());

    await dragFrom(user, lanes(), [
      { x: tickToPx(4 * bar(), PX) - 2, y: laneY(0) },
      { x: tickToPx(2 * bar(), PX), y: laneY(0) },
    ]);

    expect(startOf(id)).toBe(0);
    expect(lengthOf(id)).toBe(2 * bar());
  });

  it('moves the start AND shortens by the same amount from the left edge', async () => {
    const user = userEvent.setup();
    const { id } = seedLongBlock();
    render(<Harness />);
    const wasEnd = startOf(id) + lengthOf(id);

    await dragFrom(user, lanes(), [
      { x: 2, y: laneY(0) },
      { x: tickToPx(bar(), PX), y: laneY(0) },
    ]);

    // Both, together: getting only one right looks correct until you play it.
    expect(startOf(id)).toBe(bar());
    expect(lengthOf(id)).toBe(3 * bar());
    // Which is the same thing said the other way — the right edge did not move.
    expect(startOf(id) + lengthOf(id)).toBe(wasEnd);
  });

  it('is one undo step, and undoing restores both fields', async () => {
    const user = userEvent.setup();
    const { id } = seedLongBlock();
    render(<Harness />);

    await dragFrom(user, lanes(), [
      { x: 2, y: laneY(0) },
      { x: tickToPx(bar(), PX), y: laneY(0) },
      { x: tickToPx(2 * bar(), PX), y: laneY(0) },
      { x: tickToPx(bar(), PX), y: laneY(0) },
    ]);
    expect(startOf(id)).toBe(bar());
    expect(lengthOf(id)).toBe(3 * bar());

    undo();
    expect(startOf(id)).toBe(0);
    expect(lengthOf(id)).toBe(4 * bar());
    undo();
    expect(startOf(id)).toBe(0);
    expect(lengthOf(id)).toBe(4 * bar());
  });

  /**
   * The left edge is TWO writes and the lib clamps only one of them:
   * `resizePlacement` refuses a length outside `[one beat, the snapshot's own
   * duration]` while `movePlacement` honours any start it is given. An
   * unclamped gesture therefore performs a move the resize declined — and the
   * user who grabbed an edge watches the whole block travel.
   */
  it('does not slide the block when the left edge is dragged past what it can grow to', async () => {
    const user = userEvent.setup();
    // Seeded a bar in, so there is somewhere to the LEFT to be dragged to. At
    // tick 0 this failure is unreachable, which is why the other cases miss it.
    const { id } = seedLongBlock(1);
    render(<Harness />);

    await dragFrom(user, lanes(), [
      { x: tickToPx(bar(), PX) + 2, y: laneY(0) },
      { x: 0, y: laneY(0) },
    ]);

    // Untrimmed already, so there is no length to give back: the correct
    // outcome is that nothing moves at all.
    expect(startOf(id)).toBe(bar());
    expect(lengthOf(id)).toBe(4 * bar());
  });

  it('keeps the block inside its own span when the left edge is dragged past the right one', async () => {
    const user = userEvent.setup();
    const { id } = seedLongBlock();
    render(<Harness />);
    const end = lengthOf(id);

    await dragFrom(user, lanes(), [
      { x: 2, y: laneY(0) },
      // Two bars beyond the block's own end.
      { x: tickToPx(6 * bar(), PX), y: laneY(0) },
    ]);

    // The lib floors the length at one beat, so the start can go no further
    // than one beat short of the end. Without the clamp the block relocates
    // whole bars past where it ever was.
    expect(startOf(id)).toBe(end - PPQ);
    expect(lengthOf(id)).toBe(PPQ);
  });

  it('trims inward against an abutting neighbour without being deflected by it', async () => {
    const user = userEvent.setup();
    const { id, patternId } = seedLongBlock();
    // Butted directly against the long block's right edge, so a resize that ran
    // in the wrong order would find the slot taken and the lib would clamp the
    // move somewhere else entirely.
    const neighbour = place(patternId, getTracks()[0].id, 4 * bar());
    selectPlacements([]);
    clearHistory();
    render(<Harness />);

    await dragFrom(user, lanes(), [
      { x: 2, y: laneY(0) },
      { x: tickToPx(bar(), PX), y: laneY(0) },
    ]);

    expect(startOf(id)).toBe(bar());
    expect(lengthOf(id)).toBe(3 * bar());
    expect(startOf(neighbour)).toBe(4 * bar());
  });
});

describe('marquee selection', () => {
  it('selects every block the band crosses, across lanes', async () => {
    const user = userEvent.setup();
    const { a, b, c } = seedArrangement();
    render(<Harness />);

    // Start on empty lane space past the last block, and sweep back over all of
    // them and down into the second lane.
    await dragFrom(user, lanes(), [
      { x: tickToPx(6 * bar(), PX), y: 2 },
      { x: 1, y: LANE_HEIGHT * 2 - 2 },
    ]);

    expect([...getSelectedPlacementIds()].sort()).toEqual([a, b, c].sort());
  });

  it('adds to the selection on shift instead of replacing it', async () => {
    const user = userEvent.setup();
    const { a, b, c } = seedArrangement();
    selectPlacements([c]);
    render(<Harness />);

    await dragFrom(
      user,
      lanes(),
      [
        { x: tickToPx(6 * bar(), PX), y: 2 },
        { x: 1, y: LANE_HEIGHT - 2 },
      ],
      { shift: true },
    );

    expect([...getSelectedPlacementIds()].sort()).toEqual([a, b, c].sort());
  });

  it('clears the selection on a plain click over empty space, and keeps it on shift', async () => {
    const user = userEvent.setup();
    const { a, c } = seedArrangement();
    render(<Harness />);

    selectPlacements([a, c]);
    await clickAt(user, lanes(), { x: tickToPx(6 * bar(), PX), y: laneY(0) }, { shift: true });
    expect([...getSelectedPlacementIds()].sort()).toEqual([a, c].sort());

    await clickAt(user, lanes(), { x: tickToPx(6 * bar(), PX), y: laneY(0) });
    expect(getSelectedPlacementIds()).toEqual([]);
  });

  it('draws a band while it drags and takes it away afterwards', async () => {
    const user = userEvent.setup();
    seedArrangement();
    render(<Harness />);

    await user.pointer([
      {
        target: lanes(),
        keys: '[MouseLeft>]',
        coords: { clientX: tickToPx(6 * bar(), PX), clientY: 2 },
      },
      { coords: { clientX: 1, clientY: LANE_HEIGHT - 2 } },
    ]);
    const band = screen.getByTestId('preview-marquee');
    expect(Number(band.dataset.left)).toBe(1);
    expect(Number(band.dataset.width)).toBe(tickToPx(6 * bar(), PX) - 1);

    await user.pointer({ keys: '[/MouseLeft]' });
    expect(screen.queryByTestId('preview-marquee')).not.toBeInTheDocument();
  });
});

describe('dragging a pattern in from the library', () => {
  it('previews the insertion at the snapped tick, then places it there', async () => {
    const user = userEvent.setup();
    ensureComposition();
    const patternId = seedPattern('Riff');
    addTrack('Rhythm');
    const trackIds = getTracks().map((t) => t.id);
    clearHistory();
    render(<Harness />);

    const row = screen.getByRole('button', { name: 'library Riff' });
    await user.pointer([
      { target: row, keys: '[MouseLeft>]', coords: { clientX: 0, clientY: 0 } },
      { coords: { clientX: tickToPx(2 * bar(), PX) + 5, clientY: laneY(1) } },
    ]);

    const preview = screen.getByTestId('preview-drop');
    expect(Number(preview.dataset.left)).toBe(tickToPx(2 * bar(), PX));
    expect(preview.dataset.refused).toBe('');
    // The indicator is the block's own footprint, not a marker: a fresh
    // placement is never truncated, so it is exactly one pattern wide and one
    // lane tall, sitting on the lane it will land in.
    expect(Number(preview.dataset.width)).toBe(tickToPx(4 * PPQ, PX));
    expect(Number(preview.dataset.top)).toBe(LANE_HEIGHT);
    expect(Number(preview.dataset.height)).toBe(LANE_HEIGHT);

    await user.pointer({ keys: '[/MouseLeft]' });

    const track = getTracks()[1];
    expect(track.id).toBe(trackIds[1]);
    expect(track.placements).toHaveLength(1);
    expect(track.placements[0].startTick).toBe(2 * bar());
    expect(track.placements[0].patternSnapshot.id).toBe(patternId);
  });

  it('is one undo step, and undo removes the block entirely', async () => {
    const user = userEvent.setup();
    ensureComposition();
    seedPattern('Riff');
    clearHistory();
    render(<Harness />);

    await dragFrom(user, screen.getByRole('button', { name: 'library Riff' }), [
      { x: 0, y: 0 },
      { x: tickToPx(bar(), PX), y: laneY(0) },
    ]);
    expect(countPlacements()).toBe(1);

    undo();
    expect(countPlacements()).toBe(0);
    undo();
    expect(countPlacements()).toBe(0);
  });

  it('refuses an instrument-mismatched drop with a stated reason, and places nothing', async () => {
    const user = userEvent.setup();
    ensureComposition();
    seedPattern('Walkline', 4, 'bass');
    expect(getTracks()[0].instrumentId).toBe('guitar');
    clearHistory();
    render(<Harness />);

    const row = screen.getByRole('button', { name: 'library Walkline' });
    await user.pointer([
      { target: row, keys: '[MouseLeft>]', coords: { clientX: 0, clientY: 0 } },
      { coords: { clientX: tickToPx(bar(), PX), clientY: laneY(0) } },
    ]);
    // The reason travels with the indicator, so it is readable BEFORE the drop.
    expect(screen.getByTestId('preview-drop').dataset.refused).toMatch(/bass pattern/);

    await user.pointer({ keys: '[/MouseLeft]' });

    expect(countPlacements()).toBe(0);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Walkline/);
    expect(alert).toHaveTextContent(/bass pattern/);
    expect(alert).toHaveTextContent(/guitar track/);
  });

  it('places nothing when the release lands off the lane viewport', async () => {
    const user = userEvent.setup();
    ensureComposition();
    seedPattern('Riff');
    clearHistory();
    // The rail is a horizontal SIBLING of the grid, so a release over it maps to
    // a perfectly plausible lane several bars to the right — the one axis
    // `dropTarget` cannot bound, since `laneAt` only tests y.
    render(<Harness inViewport={(x) => x < 1000} />);

    await dragFrom(user, screen.getByRole('button', { name: 'library Riff' }), [
      { x: 1200, y: 4 },
      { x: 1250, y: laneY(0) },
    ]);

    // No indicator was ever drawn out there, and nothing was placed.
    expect(screen.queryByTestId('preview-drop')).not.toBeInTheDocument();
    expect(countPlacements()).toBe(0);
  });

  it('ignores a press that is not the primary button', async () => {
    const user = userEvent.setup();
    ensureComposition();
    seedPattern('Riff');
    render(<Harness />);

    // Guarded at the entry point rather than in each caller: a right- or
    // middle-press starts a drag whose `pointerup` may never arrive, and this
    // is a public member of `ArrangementGestures`.
    await user.pointer([
      {
        target: screen.getByRole('button', { name: 'library Riff' }),
        keys: '[MouseRight>]',
        coords: { clientX: 0, clientY: 0 },
      },
      { coords: { clientX: tickToPx(bar(), PX), clientY: laneY(0) } },
    ]);

    expect(screen.queryByTestId('preview-drop')).not.toBeInTheDocument();
    await user.pointer({ keys: '[/MouseRight]' });
    expect(countPlacements()).toBe(0);
  });

  it('shows no indicator while the pointer is off the lanes', async () => {
    const user = userEvent.setup();
    ensureComposition();
    seedPattern('Riff');
    render(<Harness />);

    await user.pointer([
      {
        target: screen.getByRole('button', { name: 'library Riff' }),
        keys: '[MouseLeft>]',
        coords: { clientX: 0, clientY: 0 },
      },
      // Below the last lane: there is no track to guess at.
      { coords: { clientX: 100, clientY: LANE_HEIGHT * 8 } },
    ]);

    expect(screen.queryByTestId('preview-drop')).not.toBeInTheDocument();
    await user.pointer({ keys: '[/MouseLeft]' });
    expect(countPlacements()).toBe(0);
  });
});

describe('drag-edge auto-scroll', () => {
  /** jsdom has no layout and no scrolling, so the view has to be RIGGED before
   *  any of this does anything: a box for the edge zones to exist inside, and a
   *  `scrollLeft` that clamps the way a real scroller's does. Same rig as
   *  `tests/Timeline.test.tsx`, for the same reason. */
  const WELL_W = 400;
  const MAX_SCROLL = 1200;

  function rigScroller() {
    const scroller = screen.getByTestId('scroller');
    let scrollLeft = 0;
    Object.defineProperty(scroller, 'scrollLeft', {
      configurable: true,
      get: () => scrollLeft,
      set: (v: number) => {
        scrollLeft = Math.max(0, Math.min(MAX_SCROLL, v));
      },
    });
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, WELL_W, 300);
    return { ...installFrameClock(), scrollLeft: () => scrollLeft };
  }

  it('scrolls the arrangement while a block drag holds the right edge', async () => {
    const user = userEvent.setup();
    seedArrangement();
    render(<Harness />);
    const rig = rigScroller();

    await user.pointer([
      { target: lanes(), keys: '[MouseLeft>]', coords: { clientX: bodyX(0), clientY: laneY(0) } },
      // Five pixels short of the edge, deep in the zone. The pointer never
      // moves again: everything below is the loop's doing.
      { coords: { clientX: WELL_W - 5, clientY: laneY(0) } },
    ]);
    rig.step(50);
    rig.step(50);

    expect(rig.scrollLeft()).toBeGreaterThan(0);

    await user.pointer({ keys: '[/MouseLeft]' });
    // And it stops with the gesture rather than running on.
    const parked = rig.scrollLeft();
    rig.step(50);
    expect(rig.scrollLeft()).toBe(parked);
  });
});

describe('splitting where the pointer last was', () => {
  it('cuts at the SNAPPED tick after a press, exactly as after a move', async () => {
    const user = userEvent.setup();
    ensureComposition();
    const patternId = seedPattern('Verse', 16);
    const id = place(patternId, getTracks()[0].id, 0);
    selectPlacements([]);
    clearHistory();
    render(<Harness />);

    // A press two bars in, 40px past the bar line: `hitTest` reports that tick
    // UNSNAPPED on purpose, so a gesture that stored it raw would cut there.
    await clickAt(user, lanes(), { x: bodyX(2 * bar()), y: laneY(0) });
    expect(getSelectedPlacementIds()).toEqual([id]);

    await user.click(screen.getByRole('button', { name: 'split' }));

    const halves = getTracks()[0].placements;
    expect(halves).toHaveLength(2);
    expect(halves.map((p) => p.startTick)).toEqual([0, 2 * bar()]);
    expect(halves.map(placementEffectiveLength)).toEqual([2 * bar(), 2 * bar()]);
  });

  it('says why when the cursor is nowhere near the selection', async () => {
    const user = userEvent.setup();
    const { a } = seedArrangement();
    render(<Harness />);

    // Empty lane space eight bars out, then split: the cursor is real, there is
    // just nothing selected under it.
    await clickAt(user, lanes(), { x: tickToPx(8 * bar(), PX), y: laneY(0) });
    selectPlacements([a]);
    await user.click(screen.getByRole('button', { name: 'split' }));

    expect(countPlacements()).toBe(3);
    expect(screen.getByRole('alert')).toHaveTextContent(/inside a selected block/);
  });
});

/**
 * The keyboard layer. Every shortcut is the twin of a toolbar button and calls
 * the same capability, so what is asserted here is the DISPATCHER: that the key
 * reaches the function, that a held key is still one undo step, and that a field
 * with focus keeps its own arrows.
 */
describe('editing shortcuts', () => {
  /** A key held down. The browser sends one plain keydown and then repeats with
   *  `repeat: true` ~30 times a second; `userEvent` has no notion of that, so
   *  the events are built by hand. Dispatched on `body` rather than on `window`
   *  because that is where a real key event starts. */
  function holdKey(key: string, repeats: number) {
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      for (let i = 0; i < repeats; i++) {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, repeat: true }),
        );
      }
      document.body.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    });
  }

  it('deletes the selection, as one step', async () => {
    const user = userEvent.setup();
    const { a, b } = seedArrangement();
    selectPlacements([a, b]);
    render(<Harness />);

    await user.keyboard('{Delete}');
    expect(countPlacements()).toBe(1);

    undo();
    expect(countPlacements()).toBe(3);
    undo();
    expect(countPlacements()).toBe(3);
  });

  it('does nothing on Delete with an empty selection', async () => {
    const user = userEvent.setup();
    seedArrangement();
    render(<Harness />);

    await user.keyboard('{Backspace}');
    expect(countPlacements()).toBe(3);
  });

  it('duplicates on the modifier + D', async () => {
    const user = userEvent.setup();
    const { a } = seedArrangement();
    selectPlacements([a]);
    render(<Harness />);

    await user.keyboard('{Control>}d{/Control}');
    expect(countPlacements()).toBe(4);

    undo();
    expect(countPlacements()).toBe(3);
  });

  it('undoes and redoes on the modifier + Z', async () => {
    const user = userEvent.setup();
    const { a } = seedArrangement();
    render(<Harness />);

    removePlacement(a);
    expect(countPlacements()).toBe(2);

    await user.keyboard('{Control>}z{/Control}');
    expect(countPlacements()).toBe(3);

    await user.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');
    expect(countPlacements()).toBe(2);
  });

  it('selects everything on the modifier + A — the keyboard route into a selection', async () => {
    const user = userEvent.setup();
    const { a, b, c } = seedArrangement();
    render(<Harness />);

    await user.keyboard('{Control>}a{/Control}');
    expect([...getSelectedPlacementIds()].sort()).toEqual([a, b, c].sort());

    // Which is what makes the rest of this suite reachable without a pointer.
    await user.keyboard('{Delete}');
    expect(countPlacements()).toBe(0);
  });

  it('transposes on the arrows, an octave with shift', async () => {
    const user = userEvent.setup();
    const { a } = seedArrangement();
    selectPlacements([a]);
    render(<Harness />);

    await user.keyboard('{ArrowUp}');
    expect(findBlock(a).placement.transposeSemitones).toBe(1);

    await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
    expect(findBlock(a).placement.transposeSemitones).toBe(-11);
  });

  /**
   * The one every capability bracketing itself gets wrong: `history` keeps a
   * single gesture slot, so without a depth count the run's own bracket is
   * closed by the first repeat's inner `endEditGesture` and every later repeat
   * pushes a step of its own — thirty steps for a second's hold.
   */
  it('folds a HELD arrow into the one step its first press recorded', async () => {
    const { a } = seedArrangement();
    selectPlacements([a]);
    render(<Harness />);

    holdKey('ArrowUp', 5);
    expect(findBlock(a).placement.transposeSemitones).toBe(6);

    undo();
    expect(findBlock(a).placement.transposeSemitones).toBe(0);
    undo();
    expect(findBlock(a).placement.transposeSemitones).toBe(0);
  });

  it('leaves the arrows alone while a form field has focus', async () => {
    const user = userEvent.setup();
    const { a } = seedArrangement();
    selectPlacements([a]);
    render(<Harness />);

    const field = document.createElement('select');
    document.body.appendChild(field);
    field.focus();
    // Arrows are how a `select` is changed; stealing them would break it.
    await user.keyboard('{ArrowUp}');
    expect(findBlock(a).placement.transposeSemitones).toBe(0);
    field.remove();
  });
});

/**
 * The named trap: an interrupted drag once wedged undo in this project
 * permanently, and no test caught it. The mechanism is `patterns/history.ts` —
 * while a gesture is open, `capture` is IGNORED, so a bracket that is never
 * closed silently swallows every LATER edit's undo step too.
 *
 * Each case below therefore checks the same two things: the arrangement is
 * still coherent, and a subsequent unrelated edit is still undoable.
 */
describe('a drag interrupted', () => {
  /** A plain seam write that records its own step — the canary. `undo` putting
   *  the block back is proof no gesture is still swallowing captures. */
  function expectUndoStillWorks(id: string) {
    const before = countPlacements();
    removePlacement(id);
    expect(countPlacements()).toBe(before - 1);
    undo();
    expect(countPlacements()).toBe(before);
  }

  it('leaves undo working after pointercancel', async () => {
    const user = userEvent.setup();
    const { a, b } = seedArrangement();
    render(<Harness />);

    await user.pointer([
      { target: lanes(), keys: '[MouseLeft>]', coords: { clientX: bodyX(0), clientY: laneY(0) } },
      { coords: { clientX: bodyX(0) + tickToPx(4 * bar(), PX), clientY: laneY(0) } },
    ]);
    expect(startOf(a)).toBe(4 * bar());

    // The browser can take the pointer away — a touch handed to a native
    // scroll, an OS gesture — and NO POINTERUP EVER ARRIVES. Which is why none
    // of these cases releases the button afterwards: a trailing pointerup would
    // close the bracket by itself and the test would pass however broken the
    // abort was.
    window.dispatchEvent(new Event('pointercancel'));

    expectUndoStillWorks(b);
  });

  it('leaves undo working after Escape', async () => {
    const user = userEvent.setup();
    const { a, b } = seedArrangement();
    render(<Harness />);

    await user.pointer([
      { target: lanes(), keys: '[MouseLeft>]', coords: { clientX: bodyX(0), clientY: laneY(0) } },
      { coords: { clientX: bodyX(0) + tickToPx(4 * bar(), PX), clientY: laneY(0) } },
    ]);
    // Still held: Escape has to be what ends this, not the release.
    await user.keyboard('{Escape}');

    // Escape ends the drag where it stands rather than reverting it — the seam
    // offers no whole-composition write, and a moved block with no step to move
    // it back would be worse than one with a step.
    expect(startOf(a)).toBe(4 * bar());
    undo();
    expect(startOf(a)).toBe(0);
    expectUndoStillWorks(b);
  });

  it('leaves undo working after the window loses focus', async () => {
    const user = userEvent.setup();
    const { a, b } = seedArrangement();
    render(<Harness />);

    await user.pointer([
      { target: lanes(), keys: '[MouseLeft>]', coords: { clientX: bodyX(0), clientY: laneY(0) } },
      { coords: { clientX: bodyX(0) + tickToPx(4 * bar(), PX), clientY: laneY(0) } },
    ]);
    // Alt-tabbing away: the pointer is still down as far as this page knows.
    window.dispatchEvent(new Event('blur'));

    expect(startOf(a)).toBe(4 * bar());
    expectUndoStillWorks(b);
  });

  it('leaves undo working after the grid unmounts mid-drag', async () => {
    const user = userEvent.setup();
    const { a, b } = seedArrangement();
    const view = render(<Harness />);

    await user.pointer([
      { target: lanes(), keys: '[MouseLeft>]', coords: { clientX: bodyX(0), clientY: laneY(0) } },
      { coords: { clientX: bodyX(0) + tickToPx(4 * bar(), PX), clientY: laneY(0) } },
    ]);
    // Leaving for the pattern page unmounts the whole composition page.
    view.unmount();

    expect(startOf(a)).toBe(4 * bar());
    expectUndoStillWorks(b);
  });

  it('closes the first bracket before a second gesture opens its own', async () => {
    const user = userEvent.setup();
    const { a, b } = seedArrangement();
    render(<Harness />);

    // Drag `a` with the mouse and hold it.
    await user.pointer([
      { target: lanes(), keys: '[MouseLeft>]', coords: { clientX: bodyX(0), clientY: laneY(0) } },
      { coords: { clientX: bodyX(0) + tickToPx(4 * bar(), PX), clientY: laneY(0) } },
    ]);

    // A second pointer lands before the first is released — a finger while the
    // mouse is still down. Its `beginEditGesture` would otherwise CLOBBER the
    // held gesture's snapshot (history keeps exactly one), silently folding the
    // first drag into the second and losing a step off the stack.
    await user.pointer([
      {
        target: lanes(),
        keys: '[TouchA>]',
        coords: { clientX: bodyX(2 * bar()), clientY: laneY(0) },
      },
      {
        pointerName: 'TouchA',
        coords: { clientX: bodyX(2 * bar()) + tickToPx(4 * bar(), PX), clientY: laneY(0) },
      },
      { keys: '[/TouchA]' },
    ]);
    await user.pointer({ keys: '[/MouseLeft]' });

    expect(startOf(b)).toBe(6 * bar());

    // Two gestures, two steps. With one bracket swallowing the other this
    // second undo has nothing left to do and `a` never comes home.
    undo();
    expect(startOf(b)).toBe(2 * bar());
    undo();
    expect(startOf(a)).toBe(0);
    expectUndoStillWorks(b);
  });

  it('does not leave a dead step behind when the interrupted drag never moved', async () => {
    const user = userEvent.setup();
    const { a, b } = seedArrangement();
    render(<Harness />);

    await user.pointer({
      target: lanes(),
      keys: '[MouseLeft>]',
      coords: { clientX: bodyX(0), clientY: laneY(0) },
    });
    window.dispatchEvent(new Event('pointercancel'));

    expect(startOf(a)).toBe(0);
    expectUndoStillWorks(b);
  });
});

describe('capabilities, reached without a pointer', () => {
  it('deletes the whole selection as one step', () => {
    const { a, b, c } = seedArrangement();
    selectPlacements([a, b, c]);

    expect(deleteSelectedPlacements()).toEqual({ ok: true, value: 3 });
    expect(countPlacements()).toBe(0);

    undo();
    expect(countPlacements()).toBe(3);
    undo();
    expect(countPlacements()).toBe(3);
  });

  it('selects every placement, and refuses when there is none', () => {
    const { a, b, c } = seedArrangement();
    expect(selectAllPlacements()).toEqual({ ok: true, value: 3 });
    expect([...getSelectedPlacementIds()].sort()).toEqual([a, b, c].sort());

    deleteSelectedPlacements();
    expect(selectAllPlacements()).toEqual({ ok: false, reason: 'Nothing is placed yet.' });
  });

  it('refuses to delete with nothing selected', () => {
    seedArrangement();
    expect(deleteSelectedPlacements()).toEqual({
      ok: false,
      reason: 'Nothing is selected.',
    });
  });

  it('duplicates a selection one selection-length to the right, as one step', () => {
    const { a, b } = seedArrangement();
    selectPlacements([a, b]);

    // `a` starts at 0, `b` ends three bars in, so the span is three bars.
    expect(duplicateSelectedPlacements().ok).toBe(true);
    expect(countPlacements()).toBe(5);
    const starts = getTracks()[0].placements.map((p) => p.startTick).sort((x, y) => x - y);
    expect(starts).toEqual([0, 2 * bar(), 3 * bar(), 5 * bar()]);

    undo();
    expect(countPlacements()).toBe(3);
  });

  it('transposes relatively, so a mixed selection keeps its intervals', () => {
    const { a, b } = seedArrangement();
    setPlacementTranspose(b, 5);
    clearHistory();
    selectPlacements([a, b]);

    expect(transposeSelectedPlacements(2).ok).toBe(true);
    expect(findBlock(a).placement.transposeSemitones).toBe(2);
    expect(findBlock(b).placement.transposeSemitones).toBe(7);

    undo();
    expect(findBlock(a).placement.transposeSemitones).toBe(0);
    expect(findBlock(b).placement.transposeSemitones).toBe(5);
  });

  it('splits at a tick inside the block, and refuses at one outside it', () => {
    const { a } = seedArrangement();
    selectPlacements([a]);

    expect(splitSelectedPlacements(10 * bar())).toEqual({
      ok: false,
      reason: 'Nothing to split there — put the cursor inside a selected block.',
    });
    expect(countPlacements()).toBe(3);

    selectPlacements([a]);
    expect(splitSelectedPlacements(2 * PPQ)).toEqual({ ok: true, value: 1 });
    expect(countPlacements()).toBe(4);
    // Both halves are NEW placements, so the id that named the original is gone.
    expect(getSelectedPlacementIds()).toEqual([]);

    undo();
    expect(countPlacements()).toBe(3);
  });

  it('appends a pattern to a named track, and to the focused one by default', () => {
    ensureComposition();
    const patternId = seedPattern('Riff');
    addTrack('Rhythm');
    const trackIds = getTracks().map((t) => t.id);
    clearHistory();

    const first = appendPatternToTrack(patternId, trackIds[1]);
    expect(first.ok).toBe(true);
    expect(getTracks()[1].placements[0].startTick).toBe(0);

    // No track named: the focused one wins.
    selectTrack(trackIds[1]);
    expect(appendPatternToTrack(patternId).ok).toBe(true);
    const starts = getTracks()[1].placements.map((p) => p.startTick);
    expect(starts).toEqual([0, 4 * PPQ]);
    expect(getTracks()[0].placements).toHaveLength(0);

    undo();
    expect(getTracks()[1].placements).toHaveLength(1);
  });

  it('refuses to append a pattern onto the wrong instrument', () => {
    ensureComposition();
    const bassId = seedPattern('Walkline', 4, 'bass');
    const result = appendPatternToTrack(bassId, getTracks()[0].id);
    expect(result.ok).toBe(false);
    expect(countPlacements()).toBe(0);
  });

  it('states the refusal in terms of both instruments', () => {
    ensureComposition();
    const bassId = seedPattern('Walkline', 4, 'bass');
    const pattern = getLibraryPatterns().find((p) => p.id === bassId)!;
    const reason = patternDropRefusal(pattern, getTracks()[0]);
    expect(reason).toMatch(/bass pattern/);
    expect(reason).toMatch(/guitar track/);
    expect(patternDropRefusal(pattern, { ...getTracks()[0], instrumentId: 'bass' })).toBeNull();
  });
});

describe('out-of-range transposition', () => {
  it('counts the notes the lib would silently drop from playback', () => {
    ensureComposition();
    openBlankPattern('High');
    stampNote({ stringIndex: 0, fret: 20, tick: 0, durationTicks: PPQ });
    stampNote({ stringIndex: 1, fret: 2, tick: 0, durationTicks: PPQ });
    const patternId = getEditingPattern()!.id;
    const id = place(patternId, getTracks()[0].id, 0);

    expect(droppedByTranspose(findBlock(id).placement)).toBe(0);

    // Guitar tops out at fret 22, so +5 pushes the fret-20 note off the neck
    // and leaves the fret-2 one comfortably on it.
    setPlacementTranspose(id, 5);
    expect(droppedByTranspose(findBlock(id).placement)).toBe(1);

    // ...and below the nut in the other direction.
    setPlacementTranspose(id, -5);
    expect(droppedByTranspose(findBlock(id).placement)).toBe(1);
  });

  it('says so ON THE BLOCK, so the loss is visible before playback', () => {
    ensureComposition();
    openBlankPattern('High');
    stampNote({ stringIndex: 0, fret: 20, tick: 0, durationTicks: PPQ });
    const id = place(getEditingPattern()!.id, getTracks()[0].id, 0);
    const view = render(<ArrangementGrid mode="pattern" />);

    expect(document.querySelector('[data-dropped]')).toBeNull();

    act(() => setPlacementTranspose(id, 5));
    const flag = document.querySelector('[data-dropped]');
    expect(flag).not.toBeNull();
    expect(flag?.getAttribute('data-dropped')).toBe('1');
    // Readable, not a bare colour cue — this is the only warning a part has
    // gone quiet.
    expect(flag).toHaveAttribute('title', expect.stringContaining("won't sound"));
    view.unmount();
  });

  it('is 0 at no transposition, whatever the frets', () => {
    ensureComposition();
    openBlankPattern('High');
    stampNote({ stringIndex: 0, fret: 24, tick: 0, durationTicks: PPQ });
    const id = place(getEditingPattern()!.id, getTracks()[0].id, 0);
    expect(droppedByTranspose(findBlock(id).placement)).toBe(0);
  });

  it('ignores notes past a trim, which were already not sounding', () => {
    ensureComposition();
    openBlankPattern('High');
    stampNote({ stringIndex: 0, fret: 2, tick: 0, durationTicks: PPQ });
    stampNote({ stringIndex: 0, fret: 20, tick: 2 * PPQ, durationTicks: PPQ });
    const id = place(getEditingPattern()!.id, getTracks()[0].id, 0);
    setPlacementTranspose(id, 5);
    expect(droppedByTranspose(findBlock(id).placement)).toBe(1);

    // Trimmed to a single beat, the high note is outside the playing range.
    usePatternsStore.getState().resizePlacement(id, PPQ);
    expect(droppedByTranspose(findBlock(id).placement)).toBe(0);
  });
});
