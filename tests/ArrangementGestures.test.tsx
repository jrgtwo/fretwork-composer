import { useCallback, useRef, useState } from 'react';
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
  TRACK_HEADER_HEIGHT,
  arrangementSnap,
  droppedByTranspose,
  laneRects,
  tickToPx,
} from '../src/composition/arrangementMath';
import { ArrangementGrid } from '../src/composition/ArrangementGrid';
import {
  addPlacement,
  addTrack,
  beginJob,
  clearHistory,
  endJob,
  moveTrack,
  removeTrack,
  getEditingComposition,
  getSelectedPlacementIds,
  getTracks,
  openBlankComposition,
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
import { Knob } from '../src/voice/controls/Knob';
import { ParamEncoder } from '../src/voice/controls/ParamEncoder';
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
// One global mode still, so every lane is a pattern lane — which under
// `max(header, content)` is the track header's height, a block's own content
// minimum being ~48. `laneRects` takes a per-track callback because the page is
// growing per-track views.
const patternLanes = (tracks: readonly { id: string }[]) =>
  laneRects(tracks, () => TRACK_HEADER_HEIGHT);
const LANE_HEIGHT = patternLanes([{ id: 'probe' }])[0].height;

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
  // Idempotent, as the `ensureComposition` this replaced was: a helper that
  // CREATES unconditionally would switch away from a composition the test had
  // already opened, and the switch is silent.
  if (!getEditingComposition()) openBlankComposition('Song');
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
        lanes: patternLanes(tracks),
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
    openBlankComposition('Song');
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
  // Idempotent, as the `ensureComposition` this replaced was: a helper that
  // CREATES unconditionally would switch away from a composition the test had
  // already opened, and the switch is silent.
  if (!getEditingComposition()) openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
    const bassId = seedPattern('Walkline', 4, 'bass');
    const result = appendPatternToTrack(bassId, getTracks()[0].id);
    expect(result.ok).toBe(false);
    expect(countPlacements()).toBe(0);
  });

  it('states the refusal in terms of both instruments', () => {
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
    openBlankPattern('High');
    stampNote({ stringIndex: 0, fret: 20, tick: 0, durationTicks: PPQ });
    const id = place(getEditingPattern()!.id, getTracks()[0].id, 0);
    const view = render(<ArrangementGrid />);

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
    openBlankComposition('Song');
    openBlankPattern('High');
    stampNote({ stringIndex: 0, fret: 24, tick: 0, durationTicks: PPQ });
    const id = place(getEditingPattern()!.id, getTracks()[0].id, 0);
    expect(droppedByTranspose(findBlock(id).placement)).toBe(0);
  });

  it('ignores notes past a trim, which were already not sounding', () => {
    openBlankComposition('Song');
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

/**
 * COMPS-TRACK-TABS milestone 3 — the hook's two new seams.
 *
 * `Harness` above passes NEITHER of them, which is deliberate and is half of
 * what these assert: the defaults are what every existing test in this file
 * runs on, so nothing here changed for a host with no notion of an active
 * track.
 */
describe('activation and teardown seams', () => {
  /** The harness again, with the coordinator's two entry points wired. */
  function ActivatingHarness({
    activateTrack,
    endRef,
  }: {
    activateTrack?: (trackId: string) => boolean;
    endRef?: React.RefObject<(() => void) | null>;
  }) {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const geometryRef = useRef<GestureGeometry | null>(null);
    const composition = useEditingComposition();
    const tracks = useTracks();
    geometryRef.current = composition
      ? {
          lanes: patternLanes(tracks),
          tracks,
          pxPerBeat: PX,
          snap: arrangementSnap(composition.timeSignature, DEFAULT_ARRANGEMENT_SNAP_ID),
          toContent: (clientX: number, clientY: number) => ({ x: clientX, y: clientY }),
          inViewport: () => true,
        }
      : null;
    const gestures = useArrangementGestures({
      geometry: useCallback(() => geometryRef.current, []),
      scrollerRef,
      activateTrack,
    });
    if (endRef) endRef.current = gestures.endGestures;
    return (
      <div ref={scrollerRef}>
        <div
          data-testid="lanes"
          onPointerDown={gestures.onLanesPointerDown}
          onPointerMove={gestures.onLanesPointerMove}
          style={{ width: 4000, height: LANE_HEIGHT * tracks.length }}
        />
      </div>
    );
  }

  it('activates the track a press landed on, before the gesture starts', async () => {
    const { trackIds, c } = seedArrangement();
    const asked: string[] = [];
    const user = userEvent.setup();
    render(<ActivatingHarness activateTrack={(id) => (asked.push(id), true)} />);

    // A press on the block in lane 1 — not the lane the drag ends over.
    await dragFrom(user, lanes(), [
      { x: bodyX(0), y: laneY(1) },
      { x: bodyX(0), y: laneY(0) },
    ]);

    // ONE activation, for the track the press landed on. A drag that crosses
    // lanes does not activate every lane it passes.
    expect(asked).toEqual([trackIds[1]]);
    // And the gesture itself ran: the block moved up a lane.
    expect(trackOf(c)).toBe(trackIds[0]);
  });

  it('does nothing at all when the activation is refused', async () => {
    const { trackIds, c } = seedArrangement();
    const user = userEvent.setup();
    render(<ActivatingHarness activateTrack={() => false} />);

    await dragFrom(user, lanes(), [
      { x: bodyX(0), y: laneY(1) },
      { x: bodyX(0), y: laneY(0) },
    ]);

    // Not moved, not selected, and no marquee left behind — a refused
    // activation must not fall through into the gesture underneath it.
    expect(trackOf(c)).toBe(trackIds[1]);
    expect(getSelectedPlacementIds()).toEqual([]);
  });

  /** The DEFAULT is covered by every other test in this file — none of them
   *  passes `activateTrack` and all of them drag. What is asserted here is only
   *  that a hover never asks. */
  it('is not asked at all by a hover', async () => {
    const asked: string[] = [];
    const user = userEvent.setup();
    seedArrangement();
    render(<ActivatingHarness activateTrack={(id) => (asked.push(id), true)} />);

    await user.pointer({ target: lanes(), coords: { clientX: bodyX(0), clientY: laneY(1) } });
    expect(asked).toEqual([]);
  });

  /**
   * `endGestures` is what the page's activation coordinator calls before it
   * repoints the document. The listeners are on `window`, so unmounting the
   * element they were installed from would not remove them — this is the only
   * thing that does, and it has to be callable mid-drag.
   */
  it('ends an in-flight drag on demand, and is idempotent', async () => {
    const { trackIds, b } = seedArrangement();
    const endRef = { current: null } as React.RefObject<(() => void) | null>;
    const user = userEvent.setup();
    render(<ActivatingHarness endRef={endRef} />);

    const startedAt = startOf(b);
    await user.pointer([
      {
        target: lanes(),
        keys: '[MouseLeft>]',
        coords: { clientX: bodyX(startedAt), clientY: laneY(0) },
      },
      { coords: { clientX: bodyX(startedAt) + 400, clientY: laneY(0) } },
    ]);
    const draggedTo = startOf(b);
    expect(draggedTo).not.toBe(startedAt);

    act(() => {
      endRef.current!();
      // Twice: every piece clears its own handle, so the second call is a no-op.
      endRef.current!();
    });

    await user.pointer([
      { coords: { clientX: bodyX(startedAt) + 1200, clientY: laneY(0) } },
      { keys: '[/MouseLeft]' },
    ]);

    expect(startOf(b)).toBe(draggedTo);
    expect(trackOf(b)).toBe(trackIds[0]);
  });

  /**
   * The OTHER half of `endGestures`: a held arrow's undo bracket is closed by a
   * keyup, and a track switch is not a keyup. Left open, the gesture DEPTH never
   * returns to zero, and while it is open `history.capture` is suppressed — so
   * every later write pushes NO step and the arrangement's undo stack stops
   * growing.
   *
   * ⚠ WHAT THIS DOES NOT CLAIM. Every ordinary way of reaching `endGestures`
   * has already ended the run before it gets there: the keydown handler calls
   * `endTransposeRun` on any non-repeat key, and a capture-phase `pointerdown`
   * listener does the same for any press. So the follow-up edit here is a SEAM
   * write with no DOM event at all — the agent's shape, and the only one that
   * can observe the depth directly. The call in `endGestures` is the guarantee
   * that the depth is zero when the coordinator repoints the document, which is
   * what the next milestone's callers will rely on.
   *
   * Keys dispatched raw because `repeat: true` is the whole condition and
   * user-event does not set it; with NO keyup, because that is the state a track
   * switch arrives in.
   */
  it('returns the gesture depth to zero from a held arrow', () => {
    const { a } = seedArrangement();
    selectPlacements([a]);
    const endRef = { current: null } as React.RefObject<(() => void) | null>;
    render(<ActivatingHarness endRef={endRef} />);

    const press = (repeat: boolean) =>
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, repeat }),
      );
    act(() => {
      press(false);
      press(true);
    });
    expect(findBlock(a).placement.transposeSemitones).toBe(2);

    act(() => endRef.current!());

    // With the bracket still open this write's `history.capture` is swallowed,
    // no step is pushed, and the undo below lands on the state before the HOLD
    // instead of on the state the hold left.
    act(() => {
      const moved = setPlacementTranspose(a, 5);
      if (!moved.ok) throw new Error(moved.reason);
    });
    expect(findBlock(a).placement.transposeSemitones).toBe(5);

    undo();
    expect(findBlock(a).placement.transposeSemitones).toBe(2);
  });

  /**
   * THE TWO BRACKETS NEST, AND THE ORDER DECIDES WHETHER THE DRAG SURVIVES.
   *
   * A pointer drag opens depth 1; a held arrow over it opens depth 2. Only the
   * OUTERMOST close decides whether a step is pushed (`endEditGesture`), and the
   * held arrow's close passes `false` because its first press already recorded
   * the state. So ending the DRAG first closes at depth 2 (ignored) and leaves
   * the run's `false` to close at depth 1 — the drag's snapshot is discarded and
   * the move it wrote becomes un-undoable.
   *
   * Only reachable in this order: a `pointerdown` mid-run ends the run first
   * (capture-phase listener), so a drag can never open INSIDE a hold.
   */
  it('keeps a drag’s undo step when an arrow is held over it', async () => {
    const { b } = seedArrangement();
    const endRef = { current: null } as React.RefObject<(() => void) | null>;
    const user = userEvent.setup();
    render(<ActivatingHarness endRef={endRef} />);

    const startedAt = startOf(b);
    await user.pointer([
      {
        target: lanes(),
        keys: '[MouseLeft>]',
        coords: { clientX: bodyX(startedAt), clientY: laneY(0) },
      },
      { coords: { clientX: bodyX(startedAt) + 400, clientY: laneY(0) } },
    ]);
    expect(startOf(b)).not.toBe(startedAt);

    // The hold opens the INNER bracket, over the drag that is still down.
    act(() => {
      const press = (repeat: boolean) =>
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, repeat }),
        );
      press(false);
      press(true);
    });
    expect(findBlock(b).placement.transposeSemitones).toBe(2);

    act(() => endRef.current!());
    await user.pointer([{ keys: '[/MouseLeft]' }]);

    // ONE step covering both, and it is the drag's own pre-gesture snapshot.
    // Closed in the wrong order there is no step at all and this undo does
    // nothing.
    undo();
    expect(startOf(b)).toBe(startedAt);
    expect(findBlock(b).placement.transposeSemitones).toBe(0);
  });

  // ⚠ NOT COVERED, and deliberately so: `endGestures` also ends the edge
  // auto-scroll, which jsdom cannot show — it has no scrolling, so a scroller
  // left spinning and one stopped are the same DOM.
});

/**
 * COMPS-TRACK-TABS milestone 3, task 2 — eligibility, keyboard boundaries and
 * captured geometry.
 *
 * ⚠ WHY THESE ARE DRIVEN THROUGH A HARNESS AND NOT THROUGH `ArrangementGrid`.
 * The page still has ONE global mode, so `viewOfTrack` answers the same view for
 * every track and the eligibility filter it passes is the identity. There is no
 * arrangement of props that puts a Pattern lane and a non-Pattern lane in one
 * stack yet — milestone 4 is what does. So the filter is exercised here, at the
 * seam that will receive it, with the harness standing in for that selector.
 * The alternative is a filter first written under milestone 4's deadline.
 */
/** What a test uses to move the world while a gesture is in flight. */
interface WorldControl {
  setLaneHeight(px: number): void;
  setZoom(px: number): void;
  /** Take a track out of Pattern view. Milestone 4's per-track selector,
   *  stood in for by a prop while the page still has one global mode. */
  hide(trackId: string | null): void;
}

/**
 * The harness again, with the eligibility filter wired and a few controls to
 * move the ground under a gesture.
 *
 * The four buttons are the TOOLBAR's wiring, literally: `ArrangementGrid`
 * hangs its ♯ / ⧉ / ✕ on these same `gestures.*` members, so a command proved
 * here is proved for the button and for the shortcut at once — which is the
 * point of there being one implementation.
 */
function ScopedHarness({
  control,
  dials = false,
  pointerEnabled = true,
  keyboardEnabled = true,
}: {
  control?: React.RefObject<WorldControl | null>;
  dials?: boolean;
  /** The two halves of §4's split, driven INDEPENDENTLY. `ArrangementGrid`
   *  still derives both from one global mode, so this harness is the only place
   *  the two can be set against each other — which is the whole claim. */
  pointerEnabled?: boolean;
  keyboardEnabled?: boolean;
}) {
  const patterns = useLibraryPatterns();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const geometryRef = useRef<GestureGeometry | null>(null);
  const [laneHeight, setLaneHeight] = useState(LANE_HEIGHT);
  // `number`, not the literal union `ARRANGEMENT_ZOOM_LEVELS` infers — the
  // point of the control is to set a scale the zoom scale does not contain.
  const [zoom, setZoom] = useState<number>(PX);
  const [hidden, setHidden] = useState<string | null>(null);
  if (control) control.current = { setLaneHeight, setZoom, hide: setHidden };

  const composition = useEditingComposition();
  const tracks = useTracks();
  geometryRef.current = composition
    ? {
        lanes: laneRects(tracks, () => laneHeight),
        tracks,
        pxPerBeat: zoom,
        snap: arrangementSnap(composition.timeSignature, DEFAULT_ARRANGEMENT_SNAP_ID),
        toContent: (clientX: number, clientY: number) => ({ x: clientX, y: clientY }),
        inViewport: () => true,
      }
    : null;

  const isPatternLane = useCallback((trackId: string) => trackId !== hidden, [hidden]);
  const gestures = useArrangementGestures({
    geometry: useCallback(() => geometryRef.current, []),
    scrollerRef,
    isPatternLane,
    pointerEnabled,
    keyboardEnabled,
  });

  return (
    <div ref={scrollerRef} data-testid="scoped-scroller">
      <div
        data-testid="lanes"
        onPointerDown={gestures.onLanesPointerDown}
        onPointerMove={gestures.onLanesPointerMove}
        style={{ width: 4000, height: laneHeight * tracks.length }}
      />
      <p data-testid="sel">{gestures.effectiveSelection.join(' ')}</p>
      {/* The rail's row, so the OTHER public pointer entry point is drivable
          here too — `startPatternDrag` guards on `pointerEnabled` itself. */}
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
      <button type="button" onClick={gestures.selectAll}>
        select all
      </button>
      <button type="button" onClick={gestures.deleteSelection}>
        delete
      </button>
      <button type="button" onClick={gestures.duplicateSelection}>
        duplicate
      </button>
      <button type="button" onClick={() => gestures.transposeSelection(1)}>
        transpose
      </button>
      {gestures.preview && <p data-testid={`preview-${gestures.preview.kind}`} />}
      {dials && <Dials />}
    </div>
  );
}

/** A real `Knob` and a real `ParamEncoder`, because the two custom roles are
 *  the whole point — a stand-in `div role="slider"` would prove the selector
 *  matches itself and nothing about the controls that ship. */
function Dials() {
  const [knob, setKnob] = useState(3);
  const [encoder, setEncoder] = useState(0);
  return (
    <>
      <Knob
        value={knob}
        onChange={setKnob}
        min={0}
        max={10}
        step={1}
        label="Drive"
        ariaLabel="Drive"
      />
      <ParamEncoder
        value={encoder}
        onChange={setEncoder}
        step={1}
        precision={0}
        fallback={0}
        label="Offset"
        ariaLabel="Offset"
      />
    </>
  );
}


describe('placement eligibility', () => {
  const selectedIds = () => [...getSelectedPlacementIds()];
  const transposeOf = (id: string) => findBlock(id).placement.transposeSemitones;

  it('enumerates only eligible placements for Select All', async () => {
    const { trackIds, a, b, c } = seedArrangement();
    const control = { current: null } as React.RefObject<WorldControl | null>;
    const user = userEvent.setup();
    render(<ScopedHarness control={control} />);
    act(() => control.current!.hide(trackIds[1]));

    await user.keyboard('{Meta>}a{/Meta}');

    // `selectAllPlacements()` unfiltered would have returned all three.
    expect(selectedIds().sort()).toEqual([a, b].sort());
    expect(selectedIds()).not.toContain(c);
  });

  it('leaves an externally supplied out-of-view selection in the document, and out of the UI', async () => {
    const { trackIds, a, c } = seedArrangement();
    const control = { current: null } as React.RefObject<WorldControl | null>;
    render(<ScopedHarness control={control} />);
    act(() => control.current!.hide(trackIds[1]));

    // What an agent run leaves behind: a selection spanning every track it
    // wrote, including one this view is not drawing.
    act(() => selectPlacements([a, c]));

    // The DOCUMENT still holds both — nothing was overwritten to satisfy the
    // view — and the UI acts on one.
    expect(selectedIds().sort()).toEqual([a, c].sort());
    expect(screen.getByTestId('sel')).toHaveTextContent(a);
    expect(screen.getByTestId('sel')).not.toHaveTextContent(c);
  });

  it('deletes only the eligible half of an external selection', async () => {
    const { trackIds, a, c } = seedArrangement();
    const control = { current: null } as React.RefObject<WorldControl | null>;
    const user = userEvent.setup();
    render(<ScopedHarness control={control} />);
    act(() => control.current!.hide(trackIds[1]));
    act(() => selectPlacements([a, c]));

    await user.click(screen.getByText('delete'));

    expect(() => findBlock(a)).toThrow();
    // Hidden, so untouchable: a UI command may not mutate what it is not drawing.
    expect(trackOf(c)).toBe(trackIds[1]);
  });

  it('duplicates and transposes only the eligible half, from the keyboard too', async () => {
    const { trackIds, a, c } = seedArrangement();
    const control = { current: null } as React.RefObject<WorldControl | null>;
    const user = userEvent.setup();
    render(<ScopedHarness control={control} />);
    act(() => control.current!.hide(trackIds[1]));
    act(() => selectPlacements([a, c]));

    const before = countPlacements();
    await user.keyboard('{Meta>}d{/Meta}');
    expect(countPlacements()).toBe(before + 1);

    await user.keyboard('{ArrowUp}');
    expect(transposeOf(a)).toBe(1);
    expect(transposeOf(c)).toBe(0);
  });

  it('marquees only over Pattern lanes, and adds to the eligible selection only', async () => {
    const { trackIds, a, b, c } = seedArrangement();
    const control = { current: null } as React.RefObject<WorldControl | null>;
    const user = userEvent.setup();
    render(<ScopedHarness control={control} />);
    act(() => control.current!.hide(trackIds[1]));

    // A band over the WHOLE stack, both lanes included. It STARTS past the last
    // block on lane 0 — a press that landed on a block would be a move, not a
    // marquee — and is dragged back to the origin.
    await dragFrom(user, lanes(), [
      { x: 3000, y: laneY(0) },
      { x: 0, y: LANE_HEIGHT * 2 },
    ]);
    expect(selectedIds().sort()).toEqual([a, b].sort());
    expect(selectedIds()).not.toContain(c);

    // Additive, over an external selection that names the hidden block: the
    // shift-band adds to what the UI has, and does not write `c` back as
    // though the user had just picked it.
    act(() => selectPlacements([a, c]));
    await dragFrom(
      user,
      lanes(),
      [
        // In the gap between the two blocks on lane 0, then into the second one.
        { x: tickToPx(2 * bar(), PX) - 10, y: laneY(0) },
        { x: tickToPx(2 * bar(), PX) + 20, y: laneY(0) },
      ],
      { shift: true },
    );
    expect(selectedIds().sort()).toEqual([a, b].sort());
  });

  it('ignores a press on a lane it does not own', async () => {
    const { trackIds, c } = seedArrangement();
    const control = { current: null } as React.RefObject<WorldControl | null>;
    const user = userEvent.setup();
    render(<ScopedHarness control={control} />);
    act(() => control.current!.hide(trackIds[1]));

    await dragFrom(user, lanes(), [
      { x: bodyX(0), y: laneY(1) },
      { x: bodyX(0) + tickToPx(bar(), PX), y: laneY(1) },
    ]);

    // The lane is a GAP, not a shifted neighbour: the press must not land on
    // lane 0's block either.
    expect(startOf(c)).toBe(0);
    expect(selectedIds()).toEqual([]);
  });

  it('leaves a press on a lane it does not own entirely alone', async () => {
    const { trackIds } = seedArrangement();
    const control = { current: null } as React.RefObject<WorldControl | null>;
    const user = userEvent.setup();
    render(<ScopedHarness control={control} />);
    act(() => control.current!.hide(trackIds[1]));

    // Read on `window` in the BUBBLE phase, which is after React's root handler
    // has run — so this is the flag the row underneath would see.
    const prevented: boolean[] = [];
    const spy = (e: Event) => prevented.push(e.defaultPrevented);
    window.addEventListener('pointerdown', spy);
    const press = async (y: number) => {
      prevented.length = 0;
      await user.pointer({
        target: lanes(),
        keys: '[MouseLeft]',
        coords: { clientX: bodyX(0), clientY: y },
      });
      return prevented;
    };

    // ⚠ NOT JUST "writes nothing". `pointerEnabled` now means "SOME lane is a
    // Pattern lane", so this handler runs over lanes the arrangement does not
    // own — and `NoteSurface.onLaneDown` does not stop propagation, so an Edit
    // lane's empty string row bubbles here. Suppressing the default and taking
    // DOM focus on the way past would break the row's own handling of a press
    // this handler has just declined.
    expect(await press(laneY(1))).toEqual([false]);
    // The control: a press the arrangement DOES own still suppresses the text
    // selection a drag across the block labels would otherwise start.
    expect(await press(laneY(0))).toEqual([true]);
    window.removeEventListener('pointerdown', spy);
  });

  it('drags only the eligible members of a group', async () => {
    const { trackIds, a, c } = seedArrangement();
    const control = { current: null } as React.RefObject<WorldControl | null>;
    const user = userEvent.setup();
    render(<ScopedHarness control={control} />);
    act(() => control.current!.hide(trackIds[1]));
    act(() => selectPlacements([a, c]));

    await dragFrom(user, lanes(), [
      { x: bodyX(0), y: laneY(0) },
      { x: bodyX(0) + tickToPx(bar(), PX), y: laneY(0) },
    ]);

    expect(startOf(a)).toBe(bar());
    // Validated BEFORE `startMove`: a block with no index in the captured lane
    // array is not in the gesture at all.
    expect(startOf(c)).toBe(0);
  });

  it('drops an ineligible id from an additive shift-CLICK rather than writing it back', async () => {
    const { trackIds, a, b, c } = seedArrangement();
    const control = { current: null } as React.RefObject<WorldControl | null>;
    const user = userEvent.setup();
    render(<ScopedHarness control={control} />);
    act(() => control.current!.hide(trackIds[1]));
    // Written from OUTSIDE this page — an agent run that selected across every
    // track it wrote. `c` is on the hidden lane.
    act(() => selectPlacements([a, c]));

    await clickAt(user, lanes(), { x: bodyX(2 * bar()), y: laneY(0) }, { shift: true });

    // The seam's own `'toggle'` would have carried `c` straight through: it acts
    // on the STORE's selection, which is where the ineligible id lives.
    expect(selectedIds().sort()).toEqual([a, b].sort());
    expect(selectedIds()).not.toContain(c);
  });
});

/**
 * COMPS-TRACK-TABS milestone 3 §A — the split itself.
 *
 * ⚠ THE ONLY PLACE THE TWO FLAGS ARE SET AGAINST EACH OTHER. `ArrangementGrid`
 * derives both from one global mode, so through the page they always agree and
 * nothing there can tell a split from the single `enabled` it replaced. Driven
 * here, each one is pinned to the half of the machinery it actually gates.
 */
describe('pointer and keyboard eligibility are separate', () => {
  const selectedIds = () => [...getSelectedPlacementIds()];
  const transposeOf = (id: string) => findBlock(id).placement.transposeSemitones;

  it('drags a block while the keyboard belongs to another surface', async () => {
    const { a } = seedArrangement();
    const user = userEvent.setup();
    render(<ScopedHarness pointerEnabled keyboardEnabled={false} />);
    act(() => selectPlacements([a]));

    await dragFrom(user, lanes(), [
      { x: bodyX(0), y: laneY(0) },
      { x: bodyX(0) + tickToPx(bar(), PX), y: laneY(0) },
    ]);
    // The POINTER names its own target, so it stays live while some other
    // track's view owns the keys.
    expect(startOf(a)).toBe(bar());

    // ...and neither shortcut is this surface's. ⌘A would have selected all
    // three; ArrowUp would have transposed the one that is selected.
    act(() => selectPlacements([]));
    await user.keyboard('{Meta>}a{/Meta}');
    expect(selectedIds()).toEqual([]);

    act(() => selectPlacements([a]));
    await user.keyboard('{ArrowUp}');
    expect(transposeOf(a)).toBe(0);
  });

  it('answers the shortcuts while both pointer entry points are closed', async () => {
    const { a } = seedArrangement();
    const user = userEvent.setup();
    render(<ScopedHarness pointerEnabled={false} keyboardEnabled />);
    act(() => selectPlacements([a]));

    // Neither the lane surface...
    await dragFrom(user, lanes(), [
      { x: bodyX(0), y: laneY(0) },
      { x: bodyX(0) + tickToPx(bar(), PX), y: laneY(0) },
    ]);
    expect(startOf(a)).toBe(0);

    // ...nor the rail's row, which is the other public entry point and guards
    // itself rather than relying on the rail not rendering.
    const placedBefore = countPlacements();
    await dragFrom(user, screen.getByLabelText('library Riff'), [
      { x: 0, y: 0 },
      { x: bodyX(4 * bar()), y: laneY(0) },
    ]);
    expect(countPlacements()).toBe(placedBefore);

    // The keyboard is untouched by either.
    await user.keyboard('{ArrowUp}');
    expect(transposeOf(a)).toBe(1);
  });
});

/**
 * COMPS-TRACK-TABS milestone 3 §B — the keyboard boundary.
 *
 * ⚠ REACHABILITY, stated so nobody deletes these as speculative. Under the one
 * global mode a voice rack and the arrangement's key handler are never on screen
 * together, so it is not a bug a user can reach TODAY. It is a bug the moment one
 * track can show Voice while another shows Pattern, and the controls are the ones
 * that ship: `Knob` is `role="slider"`, `ParamEncoder` is `role="spinbutton"`,
 * and the selector these two handlers shared covered neither.
 *
 * Both dials `preventDefault` and do NOT `stopPropagation`, so the keystroke
 * genuinely reaches the window handler. Without the boundary test one ArrowUp
 * would turn the dial AND transpose a block.
 */
describe('arrangement shortcuts stop at a local control', () => {
  it('lets a focused Knob have ArrowUp to itself', async () => {
    const { a } = seedArrangement();
    const user = userEvent.setup();
    render(<ScopedHarness dials />);
    act(() => selectPlacements([a]));

    const knob = screen.getByRole('slider', { name: 'Drive' });
    knob.focus();
    await user.keyboard('{ArrowUp}');

    expect(knob).toHaveAttribute('aria-valuenow', '4');
    expect(findBlock(a).placement.transposeSemitones).toBe(0);
  });

  it('lets a focused ParamEncoder have ArrowUp to itself', async () => {
    const { a } = seedArrangement();
    const user = userEvent.setup();
    render(<ScopedHarness dials />);
    act(() => selectPlacements([a]));

    const encoder = screen.getByRole('spinbutton', { name: 'Offset' });
    encoder.focus();
    await user.keyboard('{ArrowUp}');

    expect(encoder).toHaveAttribute('aria-valuenow', '1');
    expect(findBlock(a).placement.transposeSemitones).toBe(0);
  });

  it('still answers the same key when nothing local has focus', async () => {
    const { a } = seedArrangement();
    const user = userEvent.setup();
    render(<ScopedHarness dials />);
    act(() => selectPlacements([a]));

    await user.keyboard('{ArrowUp}');

    expect(findBlock(a).placement.transposeSemitones).toBe(1);
  });

  it('keeps the field, textarea and select boundaries it already had', async () => {
    const { a } = seedArrangement();
    const user = userEvent.setup();
    render(
      <>
        <ScopedHarness />
        <input aria-label="field" />
      </>,
    );
    act(() => selectPlacements([a]));

    screen.getByLabelText('field').focus();
    await user.keyboard('{ArrowUp}');

    expect(findBlock(a).placement.transposeSemitones).toBe(0);
  });
});

/**
 * COMPS-TRACK-TABS milestone 3 §E — a group drag captures its lane order and its
 * geometry, and finishes through the EXISTING teardown the moment either stops
 * describing the page.
 *
 * Each of these asserts the same two things: no further write lands after the
 * invalidation, and the listeners came OFF — which is why every one of them
 * keeps moving the pointer afterwards. Removing handlers from JSX would not have
 * done that; the listeners are on `window`.
 */
describe('a gesture ends when the ground moves under it', () => {
  /** Press a block and drag it one bar, leaving the pointer DOWN. */
  async function halfDrag(user: ReturnType<typeof userEvent.setup>, id: string) {
    const from = startOf(id);
    await user.pointer([
      { target: lanes(), keys: '[MouseLeft>]', coords: { clientX: bodyX(from), clientY: laneY(0) } },
      { coords: { clientX: bodyX(from) + tickToPx(bar(), PX), clientY: laneY(0) } },
    ]);
    return from;
  }

  /** Drag on, far past where the block already is, then release. */
  async function finishDrag(user: ReturnType<typeof userEvent.setup>, from: number) {
    await user.pointer([
      { coords: { clientX: bodyX(from) + tickToPx(4 * bar(), PX), clientY: laneY(0) } },
      { keys: '[/MouseLeft]' },
    ]);
  }

  it('ends on a track reorder', async () => {
    const { trackIds, a } = seedArrangement();
    const user = userEvent.setup();
    render(<ScopedHarness />);

    const from = await halfDrag(user, a);
    expect(startOf(a)).toBe(from + bar());

    act(() => {
      moveTrack(trackIds[1], 0);
    });
    await finishDrag(user, from);

    // The captured lane order no longer describes the stack, so nothing more was
    // written against indices into it.
    expect(startOf(a)).toBe(from + bar());
  });

  it('ends on a track deletion', async () => {
    const { trackIds, a } = seedArrangement();
    const user = userEvent.setup();
    render(<ScopedHarness />);

    const from = await halfDrag(user, a);
    act(() => {
      removeTrack(trackIds[1]);
    });
    await finishDrag(user, from);

    expect(startOf(a)).toBe(from + bar());
  });

  it('ends on a lane height change', async () => {
    const { a } = seedArrangement();
    const control = { current: null } as React.RefObject<WorldControl | null>;
    const user = userEvent.setup();
    render(<ScopedHarness control={control} />);

    const from = await halfDrag(user, a);
    // A voice rack being measured or folded is exactly this: every lane below it
    // gets a new top, and an index captured against the old tops now names a
    // different row.
    act(() => control.current!.setLaneHeight(LANE_HEIGHT + 24));
    await finishDrag(user, from);

    expect(startOf(a)).toBe(from + bar());
  });

  it('ends when a lane leaves Pattern view', async () => {
    const { trackIds, a } = seedArrangement();
    const control = { current: null } as React.RefObject<WorldControl | null>;
    const user = userEvent.setup();
    render(<ScopedHarness control={control} />);

    const from = await halfDrag(user, a);
    act(() => control.current!.hide(trackIds[1]));
    await finishDrag(user, from);

    expect(startOf(a)).toBe(from + bar());
  });

  it('ends when a generation job takes the document', async () => {
    const { a } = seedArrangement();
    const user = userEvent.setup();
    render(<ScopedHarness />);

    const from = await halfDrag(user, a);
    act(() => {
      const started = beginJob();
      if (!started.ok) throw new Error(started.reason);
    });
    // ONE move under the lock — which is what ends the gesture; the check runs
    // on a pointer move, not on the job starting. To a DIFFERENT point from the
    // release below, because `userEvent` does not dispatch a move to the
    // coordinates the pointer is already at.
    await user.pointer([
      { coords: { clientX: bodyX(from) + tickToPx(6 * bar(), PX), clientY: laneY(0) } },
    ]);
    // ⚠ THE JOB IS RELEASED BEFORE THE POINTER IS, so what is asserted below
    // cannot be the seam refusing each write. The document is the user's again
    // and the pointer is still down: only the listeners being gone explains it.
    act(() => endJob());
    await finishDrag(user, from);

    expect(startOf(a)).toBe(from + bar());
  });

  it('ends on a zoom change rather than mixing two scales', async () => {
    const { a } = seedArrangement();
    const control = { current: null } as React.RefObject<WorldControl | null>;
    const user = userEvent.setup();
    render(<ScopedHarness control={control} />);

    const from = await halfDrag(user, a);
    // ZOOMED OUT, not in, and it matters for the test rather than for the code:
    // the same pointer travel at half the scale asks for a tick twice as far
    // along, which is empty. Zoomed IN it asks for bar 2 — where the seeded
    // arrangement's second block already sits, so the lib would block the move
    // and the test would pass whether or not the gesture had ended.
    act(() => control.current!.setZoom(PX / 2));
    await finishDrag(user, from);

    expect(startOf(a)).toBe(from + bar());
  });

  /**
   * The edge auto-scroll's own teardown, from the ONE path that can reach it
   * from inside a drag frame.
   *
   * `invalidated` aborts from inside `handlers.drag`, which is called from
   * `apply()`, which `onMove` calls — and `onMove` then re-armed the loop the
   * teardown had just stopped. With the `pointermove` listener gone the tracked
   * x can never change again, so the speed never falls back to 0 and the rAF
   * loop scrolls the arrangement to the end for the life of the page.
   *
   * ⚠ IT NEEDS THE RIG. jsdom measures every element 0×0 and `edgeScrollSpeed`
   * answers 0 for a degenerate box, so without a box the loop never starts and
   * this passes with the leak in place — which is why the other seven tests in
   * this block missed it.
   */
  it('leaves no auto-scroll loop running when it ends mid-drag', async () => {
    const { trackIds, a } = seedArrangement();
    const control = { current: null } as React.RefObject<WorldControl | null>;
    const user = userEvent.setup();
    render(<ScopedHarness control={control} />);

    const WELL_W = 400;
    const scroller = screen.getByTestId('scoped-scroller');
    let scrollLeft = 0;
    Object.defineProperty(scroller, 'scrollLeft', {
      configurable: true,
      get: () => scrollLeft,
      set: (v: number) => {
        scrollLeft = Math.max(0, Math.min(1200, v));
      },
    });
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, WELL_W, 300);
    const clock = installFrameClock();

    // Press the block, then invalidate BEFORE the pointer reaches the edge zone:
    // the abort has to happen inside a `pointermove`, which is the frame that
    // re-armed the loop.
    const from = startOf(a);
    await user.pointer({
      target: lanes(),
      keys: '[MouseLeft>]',
      coords: { clientX: bodyX(from), clientY: laneY(0) },
    });
    act(() => control.current!.hide(trackIds[1]));

    // Five pixels short of the right edge, deep in the zone.
    await user.pointer({ coords: { clientX: WELL_W - 5, clientY: laneY(0) } });

    // Nothing was written — the gesture ended on that move.
    expect(startOf(a)).toBe(from);
    // And nothing is still driving the view. Several frames, because the loop
    // re-arms itself before it does any work: one step would not catch it.
    clock.step(50);
    clock.step(50);
    clock.step(50);
    expect(scrollLeft).toBe(0);
  });

  it('ends a marquee when the ground moves under it', async () => {
    const { trackIds } = seedArrangement();
    const control = { current: null } as React.RefObject<WorldControl | null>;
    const user = userEvent.setup();
    render(<ScopedHarness control={control} />);

    // Start on empty lane space — past both blocks on lane 0 — and sweep LEFT
    // back across them.
    await user.pointer([
      {
        target: lanes(),
        keys: '[MouseLeft>]',
        coords: { clientX: tickToPx(5 * bar(), PX), clientY: laneY(0) },
      },
      { coords: { clientX: tickToPx(4 * bar(), PX), clientY: laneY(0) } },
    ]);
    act(() => {
      moveTrack(trackIds[1], 0);
    });
    await user.pointer([
      { coords: { clientX: 1, clientY: laneY(0) } },
      { keys: '[/MouseLeft]' },
    ]);

    // NOTHING was selected, because the gesture ended on the first move after
    // the stack changed. Carrying on, the band would have been measured against
    // the REORDERED lanes: lane 0 is now the other track, so a sweep the user
    // made across `a` and `b` would have picked up `c` — a row the pointer never
    // crossed. Selection is not an edit, which is why this is the cheap failure
    // rather than a bad write; §5 still says every gesture ends through the one
    // teardown.
    expect([...getSelectedPlacementIds()]).toEqual([]);
    // And the band itself is gone: the abort runs `finish`, which clears it.
    expect(screen.queryByTestId('preview-marquee')).toBeNull();
  });

  it('leaves the whole aborted drag as exactly one undo step', async () => {
    const { trackIds, a } = seedArrangement();
    const user = userEvent.setup();
    render(<ScopedHarness />);

    const from = await halfDrag(user, a);
    act(() => {
      moveTrack(trackIds[1], 0);
    });
    await finishDrag(user, from);

    // The bracket closed on the way out. If it had been left open the abort's
    // own step would still be there — `endEditGesture` is what pushes it — so
    // the discriminating question is whether a LATER, unrelated edit still
    // records one: with a bracket open, `history.capture` ignores every one of
    // them for the life of the page.
    undo();
    expect(startOf(a)).toBe(from);

    act(() => selectPlacements([a]));
    const moved = transposeSelectedPlacements(1);
    expect(moved.ok).toBe(true);
    expect(findBlock(a).placement.transposeSemitones).toBe(1);
    undo();
    expect(findBlock(a).placement.transposeSemitones).toBe(0);
  });
});
