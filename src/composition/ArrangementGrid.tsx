import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ARRANGEMENT_ZOOM_LEVELS,
  DEFAULT_ARRANGEMENT_SNAP_ID,
  DEFAULT_ARRANGEMENT_ZOOM_INDEX,
  RULER_HEIGHT,
  TRACK_HEADER_WIDTH,
  arrangementBars,
  arrangementSnap,
  arrangementWidth,
  laneRects,
  lanesHeight,
  rulerMarks,
  tickToPx,
  zoomAnchoredScrollLeft,
  type ArrangementMode,
} from './arrangementMath';
import {
  useActivePlacementIds,
  useHeadTick,
  useIsPlaying,
  useLoopBoundaryTicks,
} from '../audio/playbackService';
import { useTimelineAutoScroll } from '../timeline/useTimelineAutoScroll';
import {
  MAX_COMPOSITION_TRACKS,
  TRACK_CAP_REASON,
  VOLUME_RANGE_DB,
  addTrack,
  isTrackAudible,
  redo,
  selectTrack,
  setMasterVolumeDb,
  undo,
  useEditingComposition,
  useHistoryState,
  useSelectedPlacementIds,
  useSelectedTrackId,
  useTracks,
} from './compositionService';
import { snapOptions } from '../timeline/timelineMath';
import {
  deleteSelectedPlacements,
  duplicateSelectedPlacements,
  transposeSelectedPlacements,
  useArrangementGestures,
  type GestureGeometry,
} from './useArrangementGestures';
import { PlacementBlock } from './PlacementBlock';
import { TrackHeader } from './TrackHeader';

/**
 * Enough empty bars that a fresh composition is a grid to arrange into rather
 * than a blank strip, and enough room past the content that there is somewhere
 * to drop a block after the last one (CP-05). Editorial numbers, not geometry —
 * `arrangementBars` takes both as parameters precisely so they live with the
 * surface that has an opinion about them.
 */
const MIN_BARS = 8;
const TRAILING_BARS = 2;

/**
 * The arrangement: a time ruler across the top, a fixed track-header column down
 * the left, and the lane area between them.
 *
 * Every pointer gesture the lane area understands lives in
 * `useArrangementGestures` — this component supplies the GEOMETRY those gestures
 * work against and draws whatever preview they ask for, and holds no gesture
 * state of its own. Still missing: the mini note previews inside a block
 * (CP-09).
 *
 * ── Two things that look like details and are not ────────────────────────────
 *
 * 1. The lane area is the ONLY scroll container on this page. The ruler and the
 *    header column are clipped viewports whose content is TRANSLATED to match —
 *    not scroll containers kept in step by writing `scrollLeft`, the usual
 *    trick. Translating is one write with no scroll events of its own, so it
 *    cannot enter the feedback loop two sync'd scrollers can (each one's
 *    correction firing the other's handler); it is also the only version of this
 *    that any test can see, because jsdom implements no scrolling and reports
 *    every `scrollLeft` as 0 forever.
 *
 *    THE ELEMENT IS THE SOURCE OF TRUTH for scroll, and the transforms are
 *    written straight onto the DOM rather than rendered from state. Mirroring
 *    `scrollLeft` into state and writing it back is the bug `Timeline.tsx` has
 *    already been through (see the auto-scroll comment there): the element can
 *    legitimately have moved on by the time React commits, so the write-back
 *    rewinds a fast scroll, and it cannot see the browser's own clamp when the
 *    content shrinks under it — leaving the ruler translated to a number the
 *    lanes never reached. Reading after every write means the clamp is simply
 *    what we read.
 *
 *    The pattern editor solves this by putting its ruler INSIDE the one
 *    scroller, which needs no JS at all; that is not available here because the
 *    lanes scroll vertically too, and a header column inside the scroller would
 *    scroll away horizontally with them.
 *
 * 2. Zoom holds the leftmost visible tick still, which is real arithmetic
 *    (`zoomAnchoredScrollLeft`) and not a CSS property. Without it, zooming out
 *    at bar 30 lands you at bar 120 with no way to tell what happened.
 *
 * ── Where the view state lives ───────────────────────────────────────────────
 *
 * Zoom and scroll are held HERE, and so are forgotten when this unmounts — which
 * is every visit to the pattern page. That is deliberate rather than overlooked:
 * `App` owns `mode` for exactly the opposite reason (a mode that silently resets
 * is a mode you can't trust), but zoom and scroll are re-established by looking
 * at the screen, and lifting them would put a scroll offset measured in one
 * zoom's pixels into a component tree that outlives the zoom it was measured
 * against. If a later ticket needs the view restored across a page visit, it is
 * the same lift `mode` already models — see `App.tsx`.
 */
export type PatternDragStarter = (patternId: string, e: React.PointerEvent) => void;

/**
 * The sweeping playhead.
 *
 * Its own component for one reason, and it is the same reason `playbackService`
 * publishes per-slice getters: the head moves sixty times a second, and
 * subscribing to it from `ArrangementGrid` would re-render every lane, every
 * block and the whole ruler on every frame. Here the re-render is one absolutely
 * positioned line.
 *
 * Drawn in lanes-CONTENT coordinates and mounted inside the scrolled content, so
 * it tracks the arrangement when the view moves rather than needing the scroll
 * offset subtracted out of it. `null` while stopped, which is what makes
 * `stop()`'s clear visible rather than leaving a line parked wherever the last
 * frame put it.
 */
function ArrangementPlayhead({ pxPerBeat }: { pxPerBeat: number }) {
  const headTick = useHeadTick();
  if (headTick === null) return null;
  return (
    <div
      aria-hidden
      data-testid="arrangement-playhead"
      data-head-tick={headTick}
      style={{ left: tickToPx(headTick, pxPerBeat) }}
      className="pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 bg-brass-hi shadow-glow-brass"
    />
  );
}

export function ArrangementGrid({
  mode,
  patternDragRef,
}: {
  mode: ArrangementMode;
  /**
   * Filled with the grid's drag-to-place entry point while this is mounted, so
   * the rail — a sibling, not a child — can hand it a press.
   *
   * A ref rather than a context because the direction is wrong for one: the
   * geometry a pattern drag needs (lane rects, zoom, snap, the scroller) exists
   * only here, below the page that also owns the rail. Lifting that state to
   * make a provider possible is exactly the "scroll position in state" the
   * header of this file argues against.
   */
  patternDragRef?: React.RefObject<PatternDragStarter | null>;
}) {
  const composition = useEditingComposition();
  const tracks = useTracks();
  const selectedTrackId = useSelectedTrackId();
  const selectedPlacementIds = useSelectedPlacementIds();
  const { canUndo, canRedo } = useHistoryState();
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ARRANGEMENT_ZOOM_INDEX);
  const [snapId, setSnapId] = useState<string>(DEFAULT_ARRANGEMENT_SNAP_ID);
  /**
   * The last refused — or otherwise consequential — track write.
   *
   * Separate from `gestures.refusal` although it lands in the same strip: that
   * one is owned by the gesture machinery and cleared by the next gesture, and
   * a track refusal must not be wiped by a pointer move over the lanes. Two
   * pieces of state, one place to read them.
   */
  const [trackNotice, setTrackNotice] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const rulerContentRef = useRef<HTMLDivElement>(null);
  const headerStackRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  /** Set only by `zoomTo`, consumed once by the layout effect below. Non-null
   *  means "the COMPONENT wants the view moved" — the effect never imposes a
   *  position the user's own scrolling produced. */
  const pendingScrollLeftRef = useRef<number | null>(null);
  /**
   * The view as the gestures see it, refreshed on every render.
   *
   * A ref because a gesture's window listeners outlive the render that
   * installed them and must read the CURRENT zoom, snap and lane stack — a zoom
   * mid-drag has to be picked up, not frozen. Null until the first render with
   * a composition, which is why every handler tolerates null.
   */
  const geometryRef = useRef<GestureGeometry | null>(null);

  const gestures = useArrangementGestures({
    geometry: useCallback(() => geometryRef.current, []),
    scrollerRef,
  });

  const isPlaying = useIsPlaying();
  // Which blocks are sounding. A snapshot slice rather than something derived
  // from the head here, so this component re-renders at placement boundaries
  // instead of at frame rate — see `playbackService.headFrame`.
  const playingPlacementIds = useActivePlacementIds();
  const loopBoundaryTicks = useLoopBoundaryTicks();

  const pxPerBeat = ARRANGEMENT_ZOOM_LEVELS[zoomIndex];

  /**
   * Keeps the playhead on screen. The pattern editor's hook, unchanged: it reads
   * the transport in its own rAF and writes `scrollLeft` straight onto the
   * element, which is exactly this component's model of scroll (see the header)
   * — the element is the source of truth and nothing mirrors it into state.
   *
   * It deliberately does NOT go through `pendingScrollLeftRef`. That ref exists
   * so a scroll position decided during RENDER (the zoom anchor) survives to the
   * layout effect that can apply it; routing a per-frame rAF write through it
   * would mean a re-render per frame to consume it. Nothing is fought over
   * either way: the layout effect only writes when the ref is non-null, and only
   * `zoomTo` ever sets it. The scroll event these writes raise runs
   * `syncViewports`, so the ruler follows the head as well.
   *
   * The boundary is the ENGINE's loop point, not `useTotalDurationTicks()` — the
   * two differ for a truncated placement (LIB-GAP(11)), and following the drawn
   * width would page the view back a bar early on every loop.
   */
  useTimelineAutoScroll(
    scrollerRef,
    pxPerBeat,
    isPlaying,
    loopBoundaryTicks,
    composition?.loop ?? false,
  );

  // A track notice names a track — or a cap — in ONE composition. Carried across
  // a switch it is a refusal from a document that is no longer on screen, with no
  // way to tell that is what it is.
  const compositionId = composition?.id ?? null;
  useEffect(() => {
    setTrackNotice(null);
  }, [compositionId]);

  useEffect(() => {
    if (!patternDragRef) return;
    patternDragRef.current = gestures.startPatternDrag;
    // Cleared on unmount: the rail outlives this component (the page keeps
    // rendering it while the grid reports a failure to open), and a stale
    // starter would drag against a geometry that no longer exists.
    return () => {
      patternDragRef.current = null;
    };
  }, [patternDragRef, gestures.startPatternDrag]);

  /** Match the two clipped viewports to wherever the scroller actually is. */
  const syncViewports = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (rulerContentRef.current) {
      rulerContentRef.current.style.transform = `translateX(${-el.scrollLeft}px)`;
    }
    if (headerStackRef.current) {
      headerStackRef.current.style.transform = `translateY(${-el.scrollTop}px)`;
    }
  }, []);

  // No dependency list on purpose: the transforms are not rendered from props,
  // so every render — a zoom, a new track, a moved block — has to re-assert them
  // against the element, or a re-render would leave the ruler at the last
  // offset React knew about.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el && pendingScrollLeftRef.current !== null) {
      el.scrollLeft = pendingScrollLeftRef.current;
      pendingScrollLeftRef.current = null;
    }
    // After the write, never instead of it: zooming out shrinks the content, and
    // the browser clamps an offset past the new end. Reading back is how the
    // ruler follows the element rather than our wish.
    syncViewports();
  });

  const zoomTo = (index: number) => {
    const next = Math.max(0, Math.min(ARRANGEMENT_ZOOM_LEVELS.length - 1, index));
    if (next === zoomIndex) return;
    // Anchor from the zoom being LEFT, before `setZoomIndex`: afterwards there is
    // no way to know what pixel-per-beat the current offset was measured in.
    const el = scrollerRef.current;
    if (el) {
      pendingScrollLeftRef.current = zoomAnchoredScrollLeft(
        el.scrollLeft,
        pxPerBeat,
        ARRANGEMENT_ZOOM_LEVELS[next],
      );
    }
    setZoomIndex(next);
  };

  if (!composition) {
    // Nothing to gesture against, and a stale geometry would hit-test against
    // lanes that are no longer drawn.
    geometryRef.current = null;
    return (
      <div className="well flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 text-center">
        <p className="font-mono text-[10px] font-semibold tracking-[0.16em] text-ink-mut uppercase">
          Arrangement
        </p>
        {/* Not "Opening…": nothing here retries, so a message that implies
            progress would never resolve. */}
        <p className="font-mono text-[9px] tracking-[0.12em] text-ink-mut/70 uppercase">
          No composition open
        </p>
      </div>
    );
  }

  const ts = composition.timeSignature;
  const bars = arrangementBars(tracks, ts, {
    minBars: MIN_BARS,
    trailingBars: TRAILING_BARS,
  });
  const width = arrangementWidth(bars, ts, pxPerBeat);
  const marks = rulerMarks(bars, ts, pxPerBeat);
  const lanes = laneRects(tracks, mode);
  const height = lanesHeight(lanes);
  const snap = arrangementSnap(ts, snapId);
  // Emptiness is "no blocks", not "no duration": a snapshot that measures zero
  // still put a block on screen, and a hint printed over one is a lie.
  const nothingPlaced = tracks.every((track) => track.placements.length === 0);
  const hasSelection = selectedPlacementIds.length > 0;

  // Assigned during render rather than from an effect: a gesture can begin on
  // the very first pointerdown after a zoom, which is before any effect for that
  // render has run. Everything here is already computed above, so this is a
  // handoff, not work.
  geometryRef.current = {
    lanes,
    tracks,
    pxPerBeat,
    snap,
    /**
     * Client → lane-area CONTENT coordinates.
     *
     * Measured off the `.lanes` element, whose box IS the content origin: it is
     * `absolute inset-0` inside the sized content div, so its top-left is tick
     * 0 of the first lane with the scroll already applied by the browser.
     * Taking the SCROLLER's box instead would be off by exactly `scrollLeft` —
     * a difference of zero until the user scrolls, which is the worst kind.
     */
    toContent(clientX: number, clientY: number) {
      const rect = lanesRef.current?.getBoundingClientRect();
      return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
    },
    /**
     * The SCROLLER's box, not `.lanes`': the scroller is what the user can see,
     * where `.lanes` is the full content and extends past the right edge by
     * however many bars are scrolled out of view. A drop has to be inside the
     * window onto the arrangement, not inside the arrangement.
     *
     * A degenerate box counts as INSIDE. jsdom reports every rect as 0×0, so
     * the strict reading would refuse every drop in every test and the suite
     * would pass vacuously while the app did nothing.
     */
    inViewport(clientX: number, clientY: number) {
      const rect = scrollerRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return true;
      return (
        clientX >= rect.left &&
        clientX < rect.right &&
        clientY >= rect.top &&
        clientY < rect.bottom
      );
    },
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1.5 flex flex-none items-center gap-1.5">
        <span className="font-mono text-[9px] font-semibold tracking-[0.16em] text-ink-mut uppercase">
          Zoom
        </span>
        <button
          type="button"
          aria-label="Zoom out"
          disabled={zoomIndex === 0}
          onClick={() => zoomTo(zoomIndex - 1)}
          className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold disabled:opacity-40"
        >
          –
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          disabled={zoomIndex === ARRANGEMENT_ZOOM_LEVELS.length - 1}
          onClick={() => zoomTo(zoomIndex + 1)}
          className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold disabled:opacity-40"
        >
          +
        </button>
        <span className="mx-1 h-4 w-px bg-line" />
        <button
          type="button"
          aria-label="Undo"
          disabled={!canUndo}
          onClick={undo}
          className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold disabled:opacity-40"
        >
          ↶
        </button>
        <button
          type="button"
          aria-label="Redo"
          disabled={!canRedo}
          onClick={redo}
          className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold disabled:opacity-40"
        >
          ↷
        </button>
        <span className="mx-1 h-4 w-px bg-line" />
        <label className="flex items-center gap-1.5">
          <span className="font-mono text-[9px] tracking-[0.12em] text-ink-mut uppercase">
            Snap
          </span>
          {/* The arrangement's default is the BAR where the note grid's is the
              16th — the one place the two surfaces intentionally disagree
              (`arrangementMath`). The menu is shared so the labels can't drift. */}
          <select
            aria-label="Arrangement snap"
            value={snapId}
            onChange={(e) => setSnapId(e.target.value)}
            className="control rounded-lg px-1.5 py-1 font-mono text-[9px] font-bold text-ink"
          >
            {snapOptions(ts).map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {/* The selection's actions. Present only with a selection, because every
            one of them needs one and a permanently-greyed row of five buttons
            teaches nothing about what enables them. Each is the keyboard
            shortcut's twin, calling the same function — no second code path.

            Deliberately NO repeat control: `Placement.repeat` is legacy and the
            lib's own note says the new arranger hides it. Repeated placements
            still DRAW their restart divisions (PlacementBlock). */}
        {hasSelection && (
          <>
            <span className="mx-1 h-4 w-px bg-line" />
            <span className="font-mono text-[9px] tracking-[0.12em] text-ink-mut uppercase">
              {selectedPlacementIds.length} sel
            </span>
            <button
              type="button"
              aria-label="Split at cursor"
              title="Split the selection where the pointer last was"
              onClick={gestures.splitAtCursor}
              className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold"
            >
              Split
            </button>
            <button
              type="button"
              aria-label="Transpose down a semitone"
              title="Transpose down (↓ · shift for an octave)"
              onClick={() => transposeSelectedPlacements(-1)}
              className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold"
            >
              ♭
            </button>
            <button
              type="button"
              aria-label="Transpose up a semitone"
              title="Transpose up (↑ · shift for an octave)"
              onClick={() => transposeSelectedPlacements(1)}
              className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold"
            >
              ♯
            </button>
            <button
              type="button"
              aria-label="Duplicate selection"
              title="Duplicate one selection-length to the right (⌘D)"
              onClick={() => duplicateSelectedPlacements()}
              className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold"
            >
              ⧉
            </button>
            <button
              type="button"
              aria-label="Delete selection"
              title="Delete (⌫)"
              onClick={() => deleteSelectedPlacements()}
              className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold"
            >
              ✕
            </button>
          </>
        )}

        <span className="flex-1" />

        {/* The composition's own output fader. Here rather than in a header,
            because it is not a track: everything mixes through it, including
            tracks that are soloed. dB, like every other volume in this model. */}
        <span className="font-mono text-[9px] tracking-[0.12em] text-ink-mut uppercase">
          Master
        </span>
        <input
          type="range"
          aria-label="Master volume in decibels"
          min={VOLUME_RANGE_DB.min}
          max={VOLUME_RANGE_DB.max}
          step={0.5}
          // `?? 0` for the reason `TrackControls`' fader carries it: the field is
          // optional on the model and the lib's migration leaves an already-
          // populated composition untouched, so `undefined` here would flip a
          // controlled range to uncontrolled and print NaN beside it.
          value={composition.masterVolumeDb ?? 0}
          onChange={(e) => {
            const result = setMasterVolumeDb(e.currentTarget.valueAsNumber);
            if (!result.ok) setTrackNotice(result.reason);
          }}
          className="h-1 w-20 cursor-pointer accent-brass"
        />
        <span
          aria-hidden
          className="w-[42px] text-right font-mono text-[9px] tabular-nums text-ink"
        >
          {(composition.masterVolumeDb ?? 0) > 0 ? '+' : ''}
          {(composition.masterVolumeDb ?? 0).toFixed(1)} dB
        </span>

        <span className="mx-1 h-4 w-px bg-line" />

        {/* `aria-disabled`, not `disabled`, at the cap. A disabled button cannot
            be focused, shows no tooltip in most browsers and answers nothing —
            and the cap is the one limit here that is NOT self-evident, since it
            is a memory budget rather than a rule about music. Pressed at the
            cap this reaches the seam like any other press and renders the reason
            it gets back, which is also the reason the agent gets. */}
        <button
          type="button"
          aria-label="Add track"
          aria-disabled={tracks.length >= MAX_COMPOSITION_TRACKS || undefined}
          // The seam's own sentence, not a paraphrase of it: the tooltip before
          // the press and the refusal after it are the same memory budget, and
          // two authorings of it are two things to keep in step.
          title={
            tracks.length >= MAX_COMPOSITION_TRACKS ? TRACK_CAP_REASON : 'Add a track'
          }
          onClick={() => {
            const added = addTrack();
            // A success does NOT clear the strip. Whatever is up there — a
            // refused drop, "3 blocks were written for another instrument" — is
            // unrelated to this press and may not have been read yet.
            if (!added.ok) setTrackNotice(added.reason);
            else selectTrack(added.value.id);
          }}
          className={`pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold ${
            tracks.length >= MAX_COMPOSITION_TRACKS ? 'opacity-40' : ''
          }`}
        >
          + Track
        </button>
        <span className="font-mono text-[11px] font-bold text-ink-hi">
          {/* The cap is part of the reading, not a surprise waiting at 8. */}
          {tracks.length}/{MAX_COMPOSITION_TRACKS} {tracks.length === 1 ? 'track' : 'tracks'}{' '}
          · {bars} {bars === 1 ? 'bar' : 'bars'}
        </span>
      </div>

      {/* A refused drop and a split with nothing under the cursor are the two
          gestures where the correct outcome is that nothing happens, so they are
          also the two that are indistinguishable from a broken app unless the
          reason is said out loud. */}
      {gestures.refusal && (
        <div className="mb-1.5 flex flex-none items-center gap-2">
          {/* Named because the track strip below is also an alert and the two
              are designed to be on screen together — unnamed, they are two
              indistinguishable alerts and no by-role query can tell which is
              which. */}
          <p
            role="alert"
            aria-label="Gesture message"
            className="flex-1 rounded-md border border-brass/50 px-2 py-1 font-mono text-[9.5px] text-ink"
          >
            {gestures.refusal}
          </p>
          <button
            type="button"
            aria-label="Dismiss message"
            onClick={gestures.dismissRefusal}
            className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold"
          >
            ✕
          </button>
        </div>
      )}

      {/* Track writes report here for the same reason: adding past the cap and
          removing the last track both LOOK like a dead button otherwise. Its
          own row rather than sharing the gesture strip, so a refused drop and a
          refused add can be on screen at once — they are unrelated events and
          the second must not overwrite the first. */}
      {trackNotice && (
        <div className="mb-1.5 flex flex-none items-center gap-2">
          <p
            role="alert"
            aria-label="Track message"
            className="flex-1 rounded-md border border-brass/50 px-2 py-1 font-mono text-[9.5px] text-ink"
          >
            {trackNotice}
          </p>
          <button
            type="button"
            aria-label="Dismiss track message"
            onClick={() => setTrackNotice(null)}
            className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold"
          >
            ✕
          </button>
        </div>
      )}

      <div
        className="grid min-h-0 flex-1"
        style={{
          gridTemplateColumns: `${TRACK_HEADER_WIDTH}px minmax(0, 1fr)`,
          gridTemplateRows: `${RULER_HEIGHT}px minmax(0, 1fr)`,
        }}
      >
        <div
          className="flex items-center border-r border-b border-rim-dark px-2 font-mono text-[8.5px] font-semibold tracking-[0.16em] text-ink-mut uppercase"
          style={{ height: RULER_HEIGHT }}
        >
          Bar
        </div>

        {/* The ruler's viewport. `data-testid` is a test seam throughout this
            component: none of these elements has a role or an accessible name,
            and with jsdom reporting every box as 0×0 there is nothing else to
            hold on to.

            `aria-hidden`: the whole strip is a picture of the time axis. Left
            audible it reads out as "1 2 3 4 5 6 7 8" — the bar count is already
            stated in words above.

            `border-l border-transparent` is ALIGNMENT, not decoration: the lane
            scroller wears `.well`, whose 1px border pushes its content box a
            pixel in from the column edge. Without a matching pixel here the
            ruler names bar 40 one pixel left of where bar 40 is drawn, at every
            zoom. Same reason for `border-t` on the header column below. */}
        <div
          aria-hidden
          data-testid="arrangement-ruler"
          className="relative overflow-hidden border-b border-b-rim-dark border-l border-l-transparent"
          style={{ height: RULER_HEIGHT }}
        >
          <div
            ref={rulerContentRef}
            data-testid="arrangement-ruler-content"
            className="relative h-full"
            style={{ width }}
          >
            {marks.map((mark) => (
              <span key={mark.tick}>
                <i
                  data-ruler-line={mark.tick}
                  style={{ left: mark.x }}
                  className={`absolute bottom-0 w-px ${
                    mark.isBar
                      ? mark.major
                        ? 'top-0 bg-beat-line'
                        : 'top-1 bg-beat-line/70'
                      : 'top-2.5 bg-well-line'
                  }`}
                />
                {mark.label !== null && (
                  <span
                    data-ruler-label={mark.bar}
                    style={{ left: mark.x }}
                    className={`absolute top-0.5 pl-1 font-mono text-[8.5px] font-bold ${
                      mark.major ? 'text-ink-hi' : 'text-ink-mut'
                    }`}
                  >
                    {mark.label}
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>

        {/* The header column's viewport — vertically locked to the lanes. */}
        <div
          data-testid="track-header-column"
          className="overflow-hidden border-t border-t-transparent border-r border-r-rim-dark"
        >
          <div ref={headerStackRef} data-testid="track-header-stack" style={{ height }}>
            {lanes.map((lane, index) => {
              const track = tracks[index];
              return (
                <TrackHeader
                  key={lane.trackId}
                  track={track}
                  index={index}
                  trackCount={tracks.length}
                  height={lane.height}
                  selected={selectedTrackId === lane.trackId}
                  // Computed HERE, once per render, because the answer depends
                  // on every other track's solo state — a header cannot work it
                  // out from the track it is given.
                  audible={isTrackAudible(track, tracks)}
                  onSelect={() => selectTrack(lane.trackId)}
                  onNotice={setTrackNotice}
                />
              );
            })}
            {/* Add / remove live in the toolbar rather than under this stack:
                the stack is exactly as tall as the lanes and scrolls with them,
                so a control appended here sits at the one offset that is never
                on screen — the bottom edge at maximum scroll. */}
          </div>
        </div>

        {/* Wrapper so the empty-arrangement hint can sit OUTSIDE the scrolled
            content: printed inside it, the one message telling a user what to do
            next scrolls off the screen the moment they look around. */}
        <div className="relative min-h-0 min-w-0">
          <div
            ref={scrollerRef}
            data-testid="arrangement-lanes-scroller"
            onScroll={syncViewports}
            // Focusable because it is the only way to reach bar 40 without a
            // pointer: nothing inside is focusable (blocks are inert DOM — the
            // lane area hit-tests presses instead), so without this a keyboard
            // user cannot scroll the arrangement at all. The editing keys are
            // window-level and work wherever focus is; this is only scrolling.
            tabIndex={0}
            role="group"
            aria-label="Arrangement lanes"
            className="well h-full overflow-auto"
          >
            <div className="relative" style={{ width, height }}>
              {/* The bar/beat grid, drawn from the SAME marks the ruler is drawn
                  from — not from a second computation that could round
                  differently and leave every block a pixel off its bar line.

                  Under the lanes rather than inside them, so `.lanes`' zebra and
                  channel shading (src/styles/index.css) still see the lane
                  elements as its only children — `:nth-child(even)` counts every
                  sibling, so a line layer in there would shade the wrong rows.

                  Elements rather than the pattern editor's repeating-gradient
                  background (`gridImage` in Timeline.tsx), and the difference is
                  deliberate: that gradient repeats on a fixed period, which is
                  exactly right for a lane whose lines are evenly spaced, and
                  wrong here — this ruler THINS ITSELF OUT with zoom, so the line
                  set is a list, not a period. Sharing `marks` with the ruler is
                  what guarantees the two layers agree. */}
              <div aria-hidden className="pointer-events-none absolute inset-0">
                {marks.map((mark) => (
                  <i
                    key={mark.tick}
                    data-grid-line={mark.tick}
                    style={{ left: mark.x }}
                    className={`absolute top-0 bottom-0 w-px ${
                      mark.isBar ? 'bg-beat-line/60' : 'bg-well-line/70'
                    }`}
                  />
                ))}
              </div>

              {/* `data-lane` is not a test hook: `.lanes > [data-lane]` in
                  src/styles/index.css is what carves the recessed channel, the
                  divider and the zebra. Renaming it silently flattens the grid
                  into a plain box.

                  ONE pointer handler for every block, every edge and every
                  patch of empty lane. What was pressed is `hitTest`'s answer,
                  not the DOM's — which is why the blocks below carry no
                  handlers, why a trim edge needs no element of its own to work,
                  and why all of it is testable where every box is 0×0. */}
              <div
                ref={lanesRef}
                data-testid="arrangement-lanes"
                onPointerDown={gestures.onLanesPointerDown}
                onPointerMove={gestures.onLanesPointerMove}
                className="lanes absolute inset-0 cursor-crosshair"
              >
                {lanes.map((lane, index) => {
                  const track = tracks[index];
                  return (
                    <div
                      key={lane.trackId}
                      data-lane={track.name}
                      data-lane-track={lane.trackId}
                      style={{ height: lane.height }}
                      className="relative"
                    >
                      {/* Pattern mode's lane content. CP-11 (string rows) and
                          CP-14 (voice racks) replace what a lane draws in the
                          other two modes; until then they draw these at their
                          own lane height, so an inert mode is never a blank
                          page. */}
                      {track.placements.map((placement) => (
                        <PlacementBlock
                          key={placement.id}
                          placement={placement}
                          pxPerBeat={pxPerBeat}
                          laneHeight={lane.height}
                          selected={selectedPlacementIds.includes(placement.id)}
                          playing={playingPlacementIds.includes(placement.id)}
                        />
                      ))}
                    </div>
                  );
                })}
              </div>

              {/* The gesture overlay. A SIBLING of `.lanes`, never a child:
                  `.lanes > [data-lane]:nth-child(even)` counts every sibling,
                  so an extra element in there shifts the zebra by one row and
                  the grid quietly stops reading as a stack of channels.

                  Drawn in lanes-CONTENT coordinates (lane tops included), which
                  is the frame the gestures work in — `PlacementBlock` is the
                  one that draws lane-LOCAL, because its lane element is already
                  positioned. */}
              {gestures.preview && (
                <div aria-hidden className="pointer-events-none absolute inset-0">
                  {gestures.preview.kind === 'drop' ? (
                    <div
                      data-testid="arrangement-drop-preview"
                      data-drop-track={gestures.preview.trackId}
                      data-drop-refused={gestures.preview.refusal ?? undefined}
                      style={{
                        left: gestures.preview.left,
                        top: gestures.preview.top,
                        width: gestures.preview.width,
                        height: gestures.preview.height,
                      }}
                      className={`absolute flex flex-col justify-center overflow-hidden rounded-md border-2 border-dashed px-1.5 ${
                        gestures.preview.refusal
                          ? 'border-ink-mut bg-ink-mut/10'
                          : 'border-brass bg-brass/10'
                      }`}
                    >
                      <span className="truncate font-mono text-[9.5px] font-bold text-ink-hi">
                        {gestures.preview.label}
                      </span>
                      {/* The reason travels WITH the indicator: read after the
                          drop it explains a mystery, read during it prevents
                          one. */}
                      {gestures.preview.refusal && (
                        <span className="truncate font-mono text-[8px] tracking-[0.1em] text-ink-mut uppercase">
                          {gestures.preview.refusal}
                        </span>
                      )}
                    </div>
                  ) : (
                    <div
                      data-testid="arrangement-marquee"
                      style={{
                        left: gestures.preview.left,
                        top: gestures.preview.top,
                        width: gestures.preview.width,
                        height: gestures.preview.height,
                      }}
                      className="absolute rounded-xs border border-brass bg-brass/10"
                    />
                  )}
                </div>
              )}

              {/* Also a SIBLING of `.lanes`, for the zebra reason above — and
                  above the gesture preview in the source so the head is never
                  hidden under a drop indicator. */}
              <ArrangementPlayhead pxPerBeat={pxPerBeat} />
            </div>
          </div>

          {nothingPlaced && (
            <p className="pointer-events-none absolute top-2 left-3 font-mono text-[9px] tracking-[0.12em] text-ink-mut uppercase">
              Nothing placed yet — drag a pattern in from the rail
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
