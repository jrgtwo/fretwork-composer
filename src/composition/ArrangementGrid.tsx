import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Placement } from '@fretwork/lib';
import {
  ARRANGEMENT_ZOOM_LEVELS,
  DEFAULT_ARRANGEMENT_SNAP_ID,
  DEFAULT_ARRANGEMENT_ZOOM_INDEX,
  RULER_HEIGHT,
  TRACK_HEADER_WIDTH,
  VOICE_HEADER_HEIGHT,
  arrangementBars,
  arrangementSnap,
  arrangementWidth,
  editableSpans,
  laneHeightsFor,
  laneRects,
  laneStringCount,
  lanesHeight,
  placementDrifted,
  rulerMarks,
  tickToPx,
  zoomAnchoredScrollLeft,
  type ArrangementMode,
  type EditableSpan,
} from './arrangementMath';
import type { PatternTimeSignature } from '@fretwork/lib';
import { NoteSurface, type SurfaceGeometry } from '../timeline/NoteSurface';
import { useEdgeAutoScroll, type EdgeAutoScroll } from '../timeline/useEdgeAutoScroll';
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
  openBlankComposition,
  isTrackAudible,
  openPlacementForEditing,
  redo,
  selectTrack,
  setMasterVolumeDb,
  trackInstrumentId,
  undo,
  useEditingComposition,
  useEditingPlacementId,
  useHistoryState,
  useSelectedPlacementIds,
  useSelectedTrackId,
  useTracks,
} from './compositionService';
import {
  useLibraryPatterns,
  redo as redoNote,
  undo as undoNote,
  useHistoryState as useNoteHistoryState,
} from '../patterns/patternService';
import { DEFAULT_SNAP_ID, snapOptions, type SnapOption } from '../timeline/timelineMath';
import {
  deleteSelectedPlacements,
  duplicateSelectedPlacements,
  transposeSelectedPlacements,
  useArrangementGestures,
  type GestureGeometry,
} from './useArrangementGestures';
import { PlacementBlock } from './PlacementBlock';
import { TrackHeader } from './TrackHeader';
import { TrackVoiceRack } from './TrackVoiceRack';
import type { SectionId } from '../voice/paramSchema';

/**
 * Enough empty bars that a fresh composition is a grid to arrange into rather
 * than a blank strip, and enough room past the content that there is somewhere
 * to drop a block after the last one (CP-05). Editorial numbers, not geometry —
 * `arrangementBars` takes both as parameters precisely so they live with the
 * surface that has an opinion about them.
 */
const MIN_BARS = 8;
const TRAILING_BARS = 2;

/** Shared empty list so the default prop keeps a stable identity across renders. */
const NO_COLLAPSED_RACKS: readonly string[] = [];

/** Same, for the per-section folds. An absent entry means nobody has folded that
 *  track's rack yet, and it opens on the schema's `DEFAULT_OPEN_SECTIONS` — see
 *  `TrackVoiceRack`, which is where absent and empty are told apart. */
const NO_COLLAPSED_SECTIONS: Readonly<Record<string, readonly SectionId[]>> = {};

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
 *    ⚠ ALL OF THAT IS TIMED-MODE MACHINERY, and CP-16 made voice mode opt out of
 *    it entirely rather than thread a third case through it. Voice mode has no
 *    time axis, so it has no horizontal overflow, so there is nothing for a
 *    header column to scroll away FROM — which means the header can simply sit
 *    in the same normal-flow row as the rack beside it and the whole
 *    two-viewport lock becomes unnecessary. That is also what lets a row be as
 *    tall as the sections a user has unfolded inside it, with no measurement and
 *    no height table to drift (see `TimedArrangementMode` in `arrangementMath`).
 *    The two layouts are two subtrees below, and pattern and edit mode's is
 *    untouched.
 *
 *    The one thing voice mode still owes the timed layout is `timedScrollLeftRef`
 *    below: leaving a timed mode unmounts the scroller, so the offset has to be
 *    remembered here and written back on the way in, or tuning a rack at bar 40
 *    returns you to bar 1.
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

/**
 * One placement's editable notes, in edit mode — the surface positioned and
 * clipped to that placement's own block.
 *
 * ONE SURFACE PER PLACEMENT, not one per lane. The reasoning, and the cost it
 * accepts, is on `arrangementMath.EditableSpan`; what matters here is the
 * consequence: the surface's box IS the placement, so every pointer position it
 * measures against its own lanes element is already a tick in the snapshot's own
 * frame, and no offset is threaded through any gesture.
 *
 * The string rows come from the TRACK's instrument, never the snapshot's, so
 * every surface in a lane divides the same height into the same rows and the
 * rows line up across placements instead of double-drawing at two pitches.
 * LIB-GAP(15) applies: those rows say what neck the part is written on and
 * nothing about what will be heard.
 */
function PlacementSurface({
  placement,
  timeSignature,
  span,
  focused,
  sounding,
  onFocus,
  drifted,
  pxPerBeat,
  laneHeight,
  stringCount,
  instrumentId,
  grid,
  edgeScroll,
  geometry,
}: {
  placement: Placement;
  /** The COMPOSITION's meter, threaded down rather than read from the snapshot
   *  — see the `timeSignature` prop on `NoteSurface`. */
  timeSignature: PatternTimeSignature;
  span: EditableSpan;
  focused: boolean;
  /** This block is the one the transport is inside. Event ids are shared across
   *  copies of a pattern, so the play highlight has to be scoped by BLOCK. */
  sounding: boolean;
  onFocus: () => boolean;
  drifted: boolean;
  pxPerBeat: number;
  laneHeight: number;
  stringCount: number;
  instrumentId: string;
  grid: SnapOption;
  edgeScroll: EdgeAutoScroll;
  geometry: SurfaceGeometry;
}) {
  return (
    <div
      data-edit-placement={placement.id}
      data-focused={focused || undefined}
      style={{
        left: span.rect.left,
        top: span.rect.top,
        width: span.rect.width,
        height: span.rect.height,
      }}
      // The boundary as an INSET RING, not a border. A border would eat a pixel
      // off each side of the content box — Tailwind's preflight sets
      // `box-sizing: border-box` — while `NoteSurface` lays its rows out to the
      // full `laneAreaHeight` and draws every note at `tickToPx(startTick)`,
      // which would put every note a pixel right of the arrangement's own bar
      // lines and clip the bottom string row. An inset shadow paints inside the
      // box without taking any of it. It still paints over the surface's rows,
      // which a background ring could not.
      // `overflow-hidden` is what makes the clamp visible — a note dragged
      // against the boundary stops there rather than spilling into the next
      // block's time.
      className={`absolute overflow-hidden rounded-md inset-ring-1 ${
        focused ? 'inset-ring-brass/60' : 'inset-ring-brass/20'
      }`}
    >
      {/* Which block you are inside, drawn BEFORE the surface so the lane rows
          paint over it and it reads as a watermark rather than as a label
          competing with the notes. The drift mark is the block's own — see
          `PlacementBlock`. */}
      <span
        aria-hidden
        className="pointer-events-none absolute top-0 left-1 font-mono text-[8px] font-bold tracking-[0.12em] text-ink-mut uppercase"
      >
        {placement.patternSnapshot.name}
        {drifted && ' *'}
      </span>
      <NoteSurface
        pattern={placement.patternSnapshot}
        focused={focused}
        sounding={sounding}
        onFocus={onFocus}
        // The editable window is ONE repetition's effective length. Past it is
        // either another block's time or nothing at all, and neither is
        // writable.
        //
        // ⚠ It is DERIVED, so an edit can move it. `updateTarget` re-fits the
        // snapshot's length to its content on every write (`fitPatternDuration`,
        // floor of one bar), and an untrimmed placement's window IS that length
        // — so deleting the last note of the final bar shortens the block, and
        // with it the time that can be written into. Deliberate rather than
        // overlooked: a block is as long as the music in it, which is the same
        // rule the pattern page has always followed, and the notes are still
        // there to be re-stamped. Pinning `lengthTicks` on the first
        // placement-local edit is the alternative, and it trades this for blocks
        // that silently stop tracking their own content. Revisit with CP-12,
        // which is where a length control would live if one is wanted.
        windowTicks={span.windowTicks}
        // TODO(CP-12): the note inspector takes these controls, so the popup a
        // selected note would otherwise offer is suppressed here.
        showNoteOptions={false}
        // The COMPOSITION's meter, not the snapshot's — see `NoteSurface`'s prop.
        // The ruler above these lanes measures the arrangement's bars, and a lane
        // drawing its block's own meter would disagree with the bar lines it sits
        // under.
        timeSignature={timeSignature}
        pxPerBeat={pxPerBeat}
        laneAreaHeight={laneHeight}
        stringCount={stringCount}
        instrumentId={instrumentId}
        grid={grid}
        edgeScroll={edgeScroll}
        geometry={geometry}
      />
    </div>
  );
}

export function ArrangementGrid({
  mode,
  collapsedRacks = NO_COLLAPSED_RACKS,
  onCollapsedRacksChange,
  collapsedRackSections = NO_COLLAPSED_SECTIONS,
  onCollapsedRackSectionsChange,
  patternDragRef,
}: {
  mode: ArrangementMode;
  /**
   * Which tracks' voice racks are folded. Held by `App` for the reason `mode`
   * is: this component unmounts on every visit to the pattern page, and a rack
   * that unfolds itself behind your back is the same bug as a mode that resets.
   *
   * Defaulted so every existing caller — and every test of the other two modes —
   * needs to know nothing about racks.
   */
  collapsedRacks?: readonly string[];
  onCollapsedRacksChange?: (collapsed: readonly string[]) => void;
  /**
   * Which STAGES are folded, per track — the second level of disclosure CP-16
   * added inside a rack. Held by `App` for the reason above, one level deeper
   * again, and keyed by track id because that is the axis it varies on.
   *
   * The FOLDED set rather than the open one, so it cannot go stale when
   * `paramSchema` gains a section. A track with NO ENTRY is one nobody has
   * folded and opens on `DEFAULT_OPEN_SECTIONS`, exactly as the pattern page's
   * pane does — which is not the same as an EMPTY entry, and this component is
   * careful to keep the two apart when it reports a change.
   */
  collapsedRackSections?: Readonly<Record<string, readonly SectionId[]>>;
  onCollapsedRackSectionsChange?: (
    collapsed: Readonly<Record<string, readonly SectionId[]>>,
  ) => void;
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
  const editing = mode === 'edit';
  /**
   * Whether this mode has a time axis at all.
   *
   * Voice mode does not, and the ruler is only the most visible consequence: the
   * bar lines, the playhead, the zoom steps, the snap menu and the block
   * actions are every one of them a statement about WHEN, and a rack is not
   * placed in time. Leaving any of them up would say the racks sit somewhere on
   * the bar they are drawn beside. `editing` stays a separate question because
   * edit mode very much has a time axis and merely hands the pointer to the note
   * surfaces.
   */
  const timed = mode !== 'voice';
  /**
   * Undo is per-DOCUMENT, and edit mode edits a different one.
   *
   * The two histories are separate stacks — `compositionService`'s holds whole
   * `Composition` snapshots, `patternService`'s holds `Pattern`s — and ⌘Z is
   * already routed by mode (the arrangement's key handler is disabled in edit
   * mode; the focused `NoteSurface`'s is not). These two buttons have to follow
   * it or they are a second, contradicting code path: pressing ↶ after a note
   * edit would restore a composition snapshot captured before it and stamp the
   * pre-edit `patternSnapshot` back over the block — destroying the edit with no
   * step in either stack to recover it.
   */
  const compositionHistory = useHistoryState();
  const noteHistory = useNoteHistoryState();
  const { canUndo, canRedo } = editing ? noteHistory : compositionHistory;
  const undoHere = editing ? undoNote : undo;
  const redoHere = editing ? redoNote : redo;
  /** Which block the note editor is pointed at. Null until one is pressed —
   *  nothing is editable, and no surface owns the keyboard, until then. */
  const editingPlacementId = useEditingPlacementId();
  /** The library, to tell an edited placement from an untouched one. A stable
   *  reference until a PATTERN changes, and a placement edit writes to
   *  `library.compositions`, so this does not re-render on note entry. */
  const libraryPatterns = useLibraryPatterns();
  /** Memoised because it is rebuilt for every block on every render, and a note
   *  edit re-renders this component on every pointermove of a drag. */
  const libraryById = useMemo(
    () => new Map(libraryPatterns.map((pattern) => [pattern.id, pattern])),
    [libraryPatterns],
  );
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ARRANGEMENT_ZOOM_INDEX);
  const [snapId, setSnapId] = useState<string>(DEFAULT_ARRANGEMENT_SNAP_ID);
  /**
   * Edit mode's note grid, held SEPARATELY from the arrangement's block snap.
   *
   * One control on screen, two settings behind it, because they are two
   * different quantities that happen to share a menu: dropping a four-bar riff a
   * 16th late is never what was meant (so blocks default to the bar) and a
   * stamped note a bar long never is either (so notes default to the 16th, the
   * pattern editor's own default). Sharing one piece of state would make
   * switching modes silently re-quantise the other surface.
   */
  const [noteSnapId, setNoteSnapId] = useState<string>(DEFAULT_SNAP_ID);
  /**
   * The last refused — or otherwise consequential — track write.
   *
   * Separate from `gestures.refusal` although it lands in the same strip: that
   * one is owned by the gesture machinery and cleared by the next gesture, and
   * a track refusal must not be wiped by a pointer move over the lanes. Two
   * pieces of state, one place to read them.
   */
  const [trackNotice, setTrackNotice] = useState<string | null>(null);
  /** Why the empty state's New press did nothing. Its own state rather than
   *  `trackNotice`'s: they cannot be on screen together — one belongs to a
   *  composition that exists and the other to there being none. */
  const [newNotice, setNewNotice] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const rulerContentRef = useRef<HTMLDivElement>(null);
  const headerStackRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  /** Set only by `zoomTo` and by the return from voice mode, consumed once by
   *  the layout effect below. Non-null means "the COMPONENT wants the view
   *  moved" — the effect never imposes a position the user's own scrolling
   *  produced. */
  const pendingScrollLeftRef = useRef<number | null>(null);
  /** The vertical twin of the above, and set only by the return from voice mode.
   *  Nothing else moves the view vertically on our behalf — the user's own
   *  wheel and the browser's focus scrolling both leave it null. */
  const pendingScrollTopRef = useRef<number | null>(null);
  /**
   * Where the TIME AXIS was, kept across a visit to voice mode.
   *
   * Voice mode's content is window-wide, so it has no horizontal overflow at
   * all and the browser clamps `scrollLeft` to 0 the moment the width changes —
   * taking the offset with it, since the element is deliberately the only place
   * scroll lives (see the header). Without this, tuning a rack and coming back
   * lands at bar 1 from bar 40, and CP-01's invariant that only what a LANE
   * draws changes between modes would be false.
   *
   * Recorded from `syncViewports` rather than read on the way out: a layout
   * effect runs after the DOM is mutated, by which point the clamp has already
   * happened and the number is gone.
   */
  const timedScrollLeftRef = useRef(0);
  /**
   * And WHICH TRACKS were in view, kept across the same visit and for a stronger
   * reason than the axis.
   *
   * CP-14 could omit this because voice mode reused the timed scroller, so the
   * element — and its `scrollTop` — survived the switch. CP-16 unmounts that
   * subtree and mounts a new one on the way back, and a new element starts at 0.
   * Eight edit lanes are 8 × 192 = 1536 px, so tuning track 8's amp and coming
   * back would land on track 1 — and `syncViewports` would then translate the
   * header column to agree with it, which is the same silent discard
   * `tests/EditMode.test.tsx` guards the pattern↔edit switch against.
   */
  const timedScrollTopRef = useRef(0);
  /** For `syncViewports`, which is a stable callback and so cannot close over
   *  `timed` — and must not record voice mode's clamped zero as the axis. */
  const timedRef = useRef(timed);
  timedRef.current = timed;
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
    // In edit mode the lanes ARE note surfaces and those own the pointer and the
    // keyboard. Two gesture systems over one surface is how a drag ends up doing
    // two things — and ⌘Z would pop an arrangement step and a note step for one
    // press. See `ArrangementGesturesOptions.enabled`.
    //
    // Voice mode is the same argument for a different reason: the lanes are
    // racks, so a press is a knob, a switch or a mic dot, and a block gesture
    // running under one would rubber-band a selection while you drag Drive —
    // and, worse, a marquee release would REPLACE the block selection you left
    // behind in pattern mode. Hence `=== 'pattern'` rather than `!editing`.
    enabled: mode === 'pattern',
  });

  /**
   * Edge auto-scroll for the NOTE surfaces, distinct from the one
   * `useArrangementGestures` keeps for block drags. Two instances over one
   * scroller, never both running: exactly one of the two gesture systems is
   * enabled at a time.
   */
  const noteEdgeScroll = useEdgeAutoScroll(scrollerRef);

  /**
   * The one thing a note surface needs to know about this chrome: where the
   * window onto it is, so a rubber-band can be clipped to the lane area rather
   * than painted across the track headers. Behind a function, and memoised, for
   * `Timeline`'s reasons — a box read at render time is stale by the first
   * pointer move, and this component re-renders on every placement change.
   */
  const surfaceGeometry = useMemo<SurfaceGeometry>(
    () => ({ viewportRect: () => scrollerRef.current?.getBoundingClientRect() ?? null }),
    [],
  );

  /**
   * Point the note editor at a block — the seam call every press in a lane makes
   * before it writes anything.
   *
   * Returns whether the surface may now edit, so a refusal (the block is gone, no
   * composition is open) stops the gesture instead of letting it write into
   * whichever pattern happened to be open. Reachable by id without a pointer
   * through `compositionService.openPlacementForEditing`, which is what the agent
   * will call.
   */
  const focusPlacement = (placementId: string): boolean => {
    const opened = openPlacementForEditing(placementId);
    if (!opened.ok) setTrackNotice(opened.reason);
    return opened.ok;
  };

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
    // Every write to `scrollLeft` — a drag, a zoom, the playhead's auto-scroll —
    // raises the scroll event that runs this, so this is the one place that sees
    // all of them. Voice mode's clamped zero is not the axis and is not recorded.
    if (timedRef.current) {
      timedScrollLeftRef.current = el.scrollLeft;
      timedScrollTopRef.current = el.scrollTop;
    }
    if (rulerContentRef.current) {
      rulerContentRef.current.style.transform = `translateX(${-el.scrollLeft}px)`;
    }
    if (headerStackRef.current) {
      headerStackRef.current.style.transform = `translateY(${-el.scrollTop}px)`;
    }
  }, []);

  // Declared BEFORE the effect that consumes the ref, because layout effects run
  // in declaration order and this one has to have written the request by the time
  // that one looks. Coming back to a timed mode is the only thing that restores
  // an offset — leaving one merely stops recording, since the element clamps
  // itself and there is nowhere else the position could have gone.
  useLayoutEffect(() => {
    if (!timed) return;
    pendingScrollLeftRef.current = timedScrollLeftRef.current;
    pendingScrollTopRef.current = timedScrollTopRef.current;
  }, [timed]);

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
    if (el && pendingScrollTopRef.current !== null) {
      el.scrollTop = pendingScrollTopRef.current;
      pendingScrollTopRef.current = null;
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
        {/* CP-17. This state is now REACHABLE AND STABLE — `ensureComposition`
            creates nothing on arrival and a delete leaves you here — so it needs
            a way out. Without one it is a dead end, which is the only reason the
            page used to mint an "Untitled composition" nobody asked for.

            Here rather than in the rail's list, even though that list has a New
            of its own: the rail is only mounted in pattern mode, and this state
            is reachable in all three. */}
        <button
          type="button"
          onClick={() => {
            const created = openBlankComposition();
            setNewNotice(created.ok ? null : created.reason);
          }}
          className="pressable control-accent mt-1 rounded-lg px-3 py-1.5 font-mono text-[9px] font-bold tracking-[0.12em] uppercase"
        >
          New composition
        </button>
        {newNotice && (
          <p
            role="alert"
            aria-label="Composition message"
            className="mt-1 max-w-[36ch] rounded-md border border-brass/50 px-2 py-1 font-mono text-[9.5px] text-ink"
          >
            {newNotice}
          </p>
        )}
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
  /** The neck a track's lane draws — LIB-GAP(15): its string set, not its
   *  pitch, which the composition's single tuning owns. */
  const instrumentOfTrack = (trackId: string): string => {
    const track = tracks.find((candidate) => candidate.id === trackId);
    return track ? trackInstrumentId(track) : '';
  };
  // Edit lanes fit their own track's string count — a bass lane is four rows
  // where a guitar lane is six — which is the case `LaneHeights` grew its
  // function form for. Pattern mode is unaffected.
  //
  // ⚠ EMPTY IN VOICE MODE, and that is the CP-16 fix rather than a shortcut. A
  // lane rect is an absolute top against a shared time axis; voice mode has no
  // axis and its rows are normal flow, so there is nothing for `laneRects` to be
  // right about. `mode !== 'voice'` rather than `timed` because only the literal
  // comparison narrows the argument to `TimedArrangementMode`, which is the
  // type that now says all of this.
  const lanes =
    mode !== 'voice' ? laneRects(tracks, mode, laneHeightsFor(instrumentOfTrack)) : [];
  const height = lanesHeight(lanes);
  const snap = arrangementSnap(ts, snapId);
  const gridOptions = snapOptions(ts);
  // The pattern editor's own fallback, not the arrangement's bar: an unknown id
  // here must land on a NOTE grid. Resolved by id rather than by position — the
  // ordering of that menu is `timelineMath`'s to change, and an index would
  // silently start meaning a different note value the day it does.
  const noteGrid =
    gridOptions.find((option) => option.id === noteSnapId) ??
    gridOptions.find((option) => option.id === DEFAULT_SNAP_ID) ??
    gridOptions[0];
  // Emptiness is "no blocks", not "no duration": a snapshot that measures zero
  // still put a block on screen, and a hint printed over one is a lie.
  const nothingPlaced = tracks.every((track) => track.placements.length === 0);
  // Hidden in edit mode: every one of these acts on a BLOCK, and in edit mode
  // the thing you have selected is a note. The block selection is EMPTIED on the
  // way in, not merely hidden — `closePlacementEditing` clears it, because the
  // lib nulls its own `selectedPlacementId` when a placement is opened and the
  // two must not disagree about what is selected.
  // `=== 'pattern'`, not `!editing`: every one of these acts on a BLOCK, and
  // voice mode has no blocks on screen to act on either.
  const hasSelection = selectedPlacementIds.length > 0 && mode === 'pattern';

  // Assigned during render rather than from an effect: a gesture can begin on
  // the very first pointerdown after a zoom, which is before any effect for that
  // render has run. Everything here is already computed above, so this is a
  // handoff, not work.
  //
  // In voice mode `lanes` is empty, which is honest rather than degraded: every
  // gesture is switched off there (`gestures.enabled`, and no handler on the
  // rows), and an empty stack hit-tests to nothing — so a listener that somehow
  // outlived the switch refuses instead of acting on stale rects.
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
        {/* Zoom is a property of the TIME AXIS, so it goes with the ruler in
            voice mode rather than sitting there scaling nothing. The zoom itself
            is remembered, not reset — coming back to pattern mode finds the view
            where it was left. */}
        {timed && (
          <>
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
          </>
        )}
        {/* ⚠ THESE GO WITH ⌘Z, WHICHEVER WAY IT GOES. They are that shortcut's
            twin and call the same function, and voice mode disables the window
            key handler outright (`gestures.enabled`), so a live ↶ there would be
            the second, contradicting code path this comment block exists to
            forbid — and it would undo an arrangement edit that is not on screen,
            with no keyboard equivalent to redo it. Undo comes back with the
            surface it acts on. */}
        {timed && (
          <>
            <button
              type="button"
              aria-label="Undo"
              disabled={!canUndo}
              onClick={undoHere}
              className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold disabled:opacity-40"
            >
              ↶
            </button>
            <button
              type="button"
              aria-label="Redo"
              disabled={!canRedo}
              onClick={redoHere}
              className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold disabled:opacity-40"
            >
              ↷
            </button>
            {/* Same argument as zoom: a snap is a quantity of TIME. Both
                settings are React state and so are held across the switch —
                nothing is re-quantised by visiting a mode that cannot express
                them. */}
            <span className="mx-1 h-4 w-px bg-line" />
            <label className="flex items-center gap-1.5">
              <span className="font-mono text-[9px] tracking-[0.12em] text-ink-mut uppercase">
                {editing ? 'Grid' : 'Snap'}
              </span>
              {/* The arrangement's default is the BAR where the note grid's is
                  the 16th — the one place the two surfaces intentionally
                  disagree (`arrangementMath`). The menu is shared so the labels
                  can't drift; which of the two settings it drives follows the
                  mode, and the accessible name says which, because a control
                  that means two things under one name is one nobody can
                  address. */}
              <select
                aria-label={editing ? 'Note grid' : 'Arrangement snap'}
                value={editing ? noteSnapId : snapId}
                onChange={(e) => (editing ? setNoteSnapId : setSnapId)(e.target.value)}
                className="control rounded-lg px-1.5 py-1 font-mono text-[9px] font-bold text-ink"
              >
                {gridOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {/* The selection's actions. Present only with a selection, because every
            one of them needs one and a permanently-greyed row of five buttons
            teaches nothing about what enables them. Each is the keyboard
            shortcut's twin, calling the same function — no second code path.

            Deliberately NO repeat control: `Placement.repeat` is legacy and the
            lib's own note says the new arranger hides it. Repeated placements
            still DRAW their restart divisions (PlacementBlock).

            Gated on `timed` for the same reason undo is: a selection made in
            pattern mode survives the switch, and every one of these acts on
            blocks that voice mode does not draw while their keyboard twins are
            switched off with the rest of the gesture layer. */}
        {timed && hasSelection && (
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
          {tracks.length}/{MAX_COMPOSITION_TRACKS} {tracks.length === 1 ? 'track' : 'tracks'}
          {/* A bar count is the last statement about time in this toolbar, and
              it goes with the ruler, the playhead, the zoom and the snap for
              the same reason they do. The track count is not about time and
              stays — voice mode has exactly as many tracks. */}
          {timed ? ` · ${bars} ${bars === 1 ? 'bar' : 'bars'}` : ''}
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

      {mode === 'voice' ? (
        /* ── VOICE MODE: normal-flow rows, not lane rects ────────────────────
           One row per track holding its header AND its rack, so the row is as
           tall as the sections unfolded inside it and the rows below simply
           move. No ruler (racks are not placed in time — a bar ruler over them
           says a track's amp settings start at bar 1 and change at bar 5), no
           second clipped viewport, and nothing to lock together: the header sits
           in the same row as the rack it belongs to rather than in a column
           translated to match.

           Scrolls VERTICALLY only. There is no horizontal overflow to scroll
           to, and `overflow-x-hidden` says so rather than leaving a scrollbar
           that would move nothing. */
        <div
          data-testid="arrangement-voice-stack"
          // Focusable and named for the same reason the timed scroller is: this
          // is how the stack past the fold is reached without a pointer. It
          // answers to the same name because it is the same thing — the window
          // onto the tracks — and no mode has both.
          tabIndex={0}
          role="group"
          aria-label="Arrangement lanes"
          className="well flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto p-2"
        >
          {tracks.map((track, index) => (
            <div
              key={track.id}
              // `data-lane` is NOT under `.lanes` here, so none of the recessed
              // channel, divider or zebra styling applies — deliberately, and
              // for the reason CP-14 gave the `edit-lane` class it replaces: a
              // timeline channel under a rack face is two conflicting statements
              // about which surface is on top. The attributes stay because they
              // name the row for anything walking the DOM.
              data-lane={track.name}
              data-lane-track={track.id}
              // A `.tray` in the stack's `.well`, not a row with a rule under it.
              // A single hairline is what this had, and against four faceplates
              // it disappeared — the two tracks read as one continuous list of
              // stages. Depth is what separates surfaces everywhere else here,
              // and it is also the literal metaphor: separate units bolted into
              // a rack, not a table of rows.
              //
              // `flex-none` so a tray keeps the height its content asks for.
              // Inside a scrolling flex column the default `flex-shrink: 1`
              // would squash the tallest rack to fit rather than scrolling it,
              // which is the whole point of CP-16.
              className="tray grid flex-none overflow-hidden"
              style={{ gridTemplateColumns: `${TRACK_HEADER_WIDTH}px minmax(0, 1fr)` }}
            >
              {/* The header keeps the height it is DRAWN for rather than being
                  stretched to the rack beside it: it is an `overflow-hidden`
                  column of fixed rows, so a taller box would only add empty
                  space inside it, and a shorter one would clip the mixer strip.
                  The tray's edge and the gap beside it are what separate one
                  track from the next.

                  Which is why the header's OWN bottom rule is suppressed here:
                  in the timed modes the header IS the full lane, so its border
                  and the lane divider are the same line. An open rack makes the
                  row ~650 px, and that line would float at y=88 with the row's
                  real divider hundreds of pixels below it — two rules per track
                  where one is meant. jsdom has no layout, so nothing but the eye
                  can see this. */}
              <div className="overflow-hidden border-r border-rim-dark [&>*]:border-b-0">
                <TrackHeader
                  track={track}
                  index={index}
                  trackCount={tracks.length}
                  height={VOICE_HEADER_HEIGHT}
                  selected={selectedTrackId === track.id}
                  audible={isTrackAudible(track, tracks)}
                  onSelect={() => selectTrack(track.id)}
                  onNotice={setTrackNotice}
                />
              </div>

              <TrackVoiceRack
                track={track}
                audible={isTrackAudible(track, tracks)}
                collapsed={collapsedRacks.includes(track.id)}
                // Rebuilt from the LIVE tracks rather than pushed onto the old
                // list, which also prunes it: a removed track's id would
                // otherwise sit in `App`'s state for the rest of the session,
                // matching nothing.
                onCollapsedChange={(next) =>
                  onCollapsedRacksChange?.(
                    tracks
                      .map((candidate) => candidate.id)
                      .filter((id) =>
                        id === track.id ? next : collapsedRacks.includes(id),
                      ),
                  )
                }
                collapsedSections={collapsedRackSections[track.id]}
                // Same rule one level in: rebuilt from the live tracks, so a
                // removed track's entry goes with it.
                //
                // An EMPTY list is stored, not dropped: absent means "nobody has
                // folded this rack" and opens on the schema's default (Amp and
                // Cabinet), while empty means "the user unfolded everything".
                // Dropping the empty one would re-fold two stages the moment
                // they opened the last of them.
                onCollapsedSectionsChange={(next) => {
                  const rebuilt: Record<string, readonly SectionId[]> = {};
                  for (const candidate of tracks) {
                    const folded =
                      candidate.id === track.id ? next : collapsedRackSections[candidate.id];
                    if (folded !== undefined) rebuilt[candidate.id] = folded;
                  }
                  onCollapsedRackSectionsChange?.(rebuilt);
                }}
                onNotice={setTrackNotice}
              />
            </div>
          ))}
        </div>
      ) : (
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
              // pointer: in pattern and edit mode nothing inside is focusable
              // (blocks are inert DOM — the lane area hit-tests presses instead),
              // so without this a keyboard user cannot scroll the arrangement at
              // all. The editing keys are window-level and work wherever focus is;
              // this is only scrolling. In VOICE mode the lanes are full of
              // controls and this is one extra tab stop ahead of the first rack —
              // harmless, and cheaper than a mode-dependent tab order, but it is
              // the reason the sentence above is qualified.
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
                  // Nothing in edit mode: the note surfaces below own the pointer
                  // there, and a second handler on their container would run a
                  // block gesture under every note gesture. (Voice mode never
                  // reaches this subtree at all — its rows own their own
                  // pointers, and `gestures.enabled` says so as well.)
                  onPointerDown={mode === 'pattern' ? gestures.onLanesPointerDown : undefined}
                  onPointerMove={mode === 'pattern' ? gestures.onLanesPointerMove : undefined}
                  className={`lanes absolute inset-0 ${
                    mode === 'pattern' ? 'cursor-crosshair' : ''
                  }`}
                >
                  {lanes.map((lane, index) => {
                    const track = tracks[index];
                    const instrumentId = trackInstrumentId(track);
                    return (
                      <div
                        key={lane.trackId}
                        data-lane={track.name}
                        data-lane-track={lane.trackId}
                        style={{ height: lane.height }}
                        // `edit-lane` turns this lane's own recess and zebra OFF
                        // (src/styles/index.css). Edit mode nests one `.lanes`
                        // inside another — the track lanes, and each placement's
                        // string rows — and `.lanes > [data-lane]` matches both,
                        // so a track lane and every row inside it would each take
                        // the channel shadow and the zebra lift. Compounded, the
                        // stack stops reading as one instrument rack. The INNER
                        // set wins, because in edit mode the rows ARE the lanes;
                        // the divider between tracks is kept.
                        className={`relative ${editing ? 'edit-lane' : ''}`}
                      >
                        {/* What a lane draws is the ONLY thing that changes between
                            these two modes — the headers, the ruler and the scroll
                            position do not (CP-01). Pattern mode draws one block
                            per placement, edit mode that placement's notes on the
                            same ruler at the same zoom. Voice mode is the third
                            answer and is not here: it has no time axis, so it is a
                            different layout entirely (above). */}
                        {editing
                          ? editableSpans(track, pxPerBeat, lane.height).map((span) => {
                              const placement = track.placements.find(
                                (candidate) => candidate.id === span.placementId,
                              );
                              if (!placement) return null;
                              return (
                                <PlacementSurface
                                  key={placement.id}
                                  placement={placement}
                                  timeSignature={ts}
                                  span={span}
                                  focused={editingPlacementId === placement.id}
                                  sounding={playingPlacementIds.includes(placement.id)}
                                  onFocus={() => focusPlacement(placement.id)}
                                  drifted={placementDrifted(
                                    placement,
                                    libraryById.get(placement.patternSnapshot.id),
                                  )}
                                  pxPerBeat={pxPerBeat}
                                  laneHeight={lane.height}
                                  stringCount={laneStringCount(instrumentId)}
                                  instrumentId={instrumentId}
                                  grid={noteGrid}
                                  edgeScroll={noteEdgeScroll}
                                  geometry={surfaceGeometry}
                                />
                              );
                            })
                          : track.placements.map((placement) => (
                              <PlacementBlock
                                key={placement.id}
                                placement={placement}
                                pxPerBeat={pxPerBeat}
                                laneHeight={lane.height}
                                selected={selectedPlacementIds.includes(placement.id)}
                                playing={playingPlacementIds.includes(placement.id)}
                                drifted={placementDrifted(
                                  placement,
                                  libraryById.get(placement.patternSnapshot.id),
                                )}
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
                    hidden under a drop indicator. There is none in voice mode,
                    with the rest of the time axis: playback still runs, but a
                    sweeping line over a rack points at nothing. */}
                <ArrangementPlayhead pxPerBeat={pxPerBeat} />
              </div>
            </div>

            {/* Nothing like it in voice mode: an empty arrangement still has
                tracks, and every one of them has a voice to tune — so "nothing
                placed yet" would be printed over a screen doing its whole job. */}
            {nothingPlaced && (
              <p className="pointer-events-none absolute top-2 left-3 font-mono text-[9px] tracking-[0.12em] text-ink-mut uppercase">
                {/* Edit mode's rail holds the inspector, not the library, so
                    "drag a pattern in from the rail" would name a thing that
                    isn't there. Notes are only editable inside a block. */}
                {editing
                  ? 'Nothing to edit yet — place a pattern in Pattern mode first'
                  : 'Nothing placed yet — drag a pattern in from the rail'}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
