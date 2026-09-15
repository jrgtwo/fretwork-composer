import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Placement } from '@fretwork/lib';
import {
  ARRANGEMENT_ZOOM_LEVELS,
  DEFAULT_ARRANGEMENT_SNAP_ID,
  DEFAULT_ARRANGEMENT_ZOOM_INDEX,
  RULER_HEIGHT,
  TRACK_HEADER_WIDTH,
  arrangementBars,
  arrangementSnap,
  arrangementWidth,
  editableSpans,
  laneHeightResolver,
  laneRects,
  laneStringCount,
  lanesHeight,
  placementDrifted,
  rulerMarks,
  selectedTrackView,
  tickToPx,
  setTrackView,
  timedBands,
  viewOf,
  zoomAnchoredScrollLeft,
  type ArrangementMode,
  type CompositionTrackViews,
  type EditableSpan,
  type LaneRect,
  type TimedBand,
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
  BLOCK_OFF_TRACK_REASON,
  JOB_LOCK_REASON,
  MAX_COMPOSITION_TRACKS,
  TRACK_CAP_REASON,
  TRACK_GONE_REASON,
  VOLUME_RANGE_DB,
  addTrack,
  closePlacementEditing,
  openBlankComposition,
  getEditingPlacementId,
  getSelectedTrackId,
  getTracks,
  isJobRunning,
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
  useIsJobRunning,
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

/** Same, for the view map: an uncontrolled grid is one where every track is on
 *  Pattern, which is what an empty map means (`arrangementMath.viewOf`). */
const NO_VIEWS: CompositionTrackViews = {};

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
 *    CP-16 used to make voice mode opt OUT of all of it — a second subtree of
 *    normal-flow rows, each as tall as the rack inside it. COMPS-TRACK-TABS
 *    milestone 2 deleted that subtree: there is ONE stack now, and a voice lane
 *    is a lane like any other, sized by `laneRects`. It is as tall as its rack
 *    MEASURES (`measureRack` below, `laneHeightResolver` in `arrangementMath`),
 *    so this scroller is the page's only vertical scrollbar and no rack is
 *    clipped. Every per-lane decision below goes through `viewOfTrack`, which
 *    milestone 4 repoints at a per-composition map.
 *
 * 1b. THE RACKS LIVE IN THEIR OWN LAYER, and its position in the DOM is the one
 *    thing in this file most likely to be broken by a well-meaning edit. It is a
 *    zero-height `position: sticky` sheet that MUST be the first child of the
 *    scroller — its normal-flow origin is then content y=0, the same origin
 *    `lane.top` is measured from. The long comment at the element itself has the
 *    rest.
 *
 *    `timedScrollLeftRef` below is now the only thing left of the old split, and
 *    it is still needed: an ALL-VOICE stack has no horizontal overflow, so the
 *    browser clamps `scrollLeft` to 0 and the offset is gone unless it was
 *    recorded. The scroller itself no longer unmounts, which makes the vertical
 *    twin belt-and-braces rather than load-bearing.
 *
 * 2. Zoom holds the leftmost visible tick still, which is real arithmetic
 *    (`zoomAnchoredScrollLeft`) and not a CSS property. Without it, zooming out
 *    at bar 30 lands you at bar 120 with no way to tell what happened.
 *
 * ── Where the view state lives ───────────────────────────────────────────────
 *
 * Zoom and scroll are held HERE, and so are forgotten when this unmounts — which
 * is every visit to the pattern page. That is deliberate rather than overlooked:
 * `App` owns the per-track VIEW MAP for exactly the opposite reason (a stack of
 * views that silently resets is a page you can't trust), but zoom and scroll are
 * re-established by looking at the screen, and lifting them would put a scroll
 * offset measured in one zoom's pixels into a component tree that outlives the
 * zoom it was measured against. If a later ticket needs the view restored across
 * a page visit, it is the same lift the view map already models — see `App.tsx`.
 */
export type PatternDragStarter = (patternId: string, e: React.PointerEvent) => void;

/**
 * What an activation is being asked FOR — the last step of the coordinator
 * below, and the only thing that varies between its callers.
 *
 * `select` is a header press, a view-button press, a lane press or a freshly
 * added track: it makes a track the active one and starts nothing. Selecting an
 * Edit header therefore does NOT open a block, which is deliberate — the
 * inspector's empty state is what says so. A VIEW press is a `select` plus the
 * view write that follows it (`changeTrackView`), rather than a case of its own:
 * what the coordinator has to do is identical, and the write is the caller's.
 *
 * `edit` is a note surface taking the document. It selects the track AND points
 * the editor at that block, and only a successful open grants focus.
 */
type TrackActivation =
  | { readonly kind: 'select' }
  | { readonly kind: 'edit'; readonly placementId: string };

/** Shared, so the common case is not a new object on every press. */
const SELECT_TRACK: TrackActivation = { kind: 'select' };

/** What a context with no document of its own reports — `edit-idle` and
 *  `voice`. A shared constant so it is not a fresh object every render. */
const NO_HISTORY = { canUndo: false, canRedo: false } as const;

/**
 * ── THE ONE DIRECT-EDITING COMMAND CONTEXT (§4) ──────────────────────────────
 *
 * What the toolbar's buttons and the window shortcuts are BOTH derived from, so
 * there is one answer to "which document does ⌘Z pop" rather than one for the
 * button and another for the key.
 *
 * | context     | undo / redo           | other commands                      |
 * | ----------- | --------------------- | ----------------------------------- |
 * | `pattern`   | composition history   | the eligible placement selection    |
 * | `edit`      | note history          | that placement's notes              |
 * | `edit-idle` | DISABLED              | a prompt to select a block          |
 * | `voice`     | neither is available  | the voice controls' own behaviour   |
 *
 * `edit-idle` is the row that is a real change. Edit mode with nothing open used
 * to point ↶ at the NOTE history anyway — which is the pattern page's history,
 * carrying whatever was done there — so a press undid an edit on a document not
 * on screen. It is disabled now.
 *
 * It controls DIRECT EDITING only. The agent's composition commands are
 * available in every one of these rows; milestone 5 is where that split is drawn
 * in the rail.
 */
type DirectEditContext =
  | { readonly kind: 'pattern' }
  | { readonly kind: 'edit'; readonly placementId: string }
  | { readonly kind: 'edit-idle' }
  | { readonly kind: 'voice' };

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
 *
 * ONE SEGMENT, given the BAND it may draw in — a contiguous run of lanes that
 * have a time axis (`timedBands`). A full-height line would sweep across a voice
 * lane's rack, where it points at nothing and lands on top of the controls; the
 * rack's opaque background hides it, but drawing it there at all makes the
 * background the only thing standing between a knob and a moving line. With
 * every lane timed there is one band spanning the stack, which is the single
 * top-to-bottom line this drew before voice became a lane.
 */
function ArrangementPlayhead({ pxPerBeat, band }: { pxPerBeat: number; band: TimedBand }) {
  const headTick = useHeadTick();
  if (headTick === null) return null;
  return (
    <div
      aria-hidden
      data-testid="arrangement-playhead"
      data-head-tick={headTick}
      style={{ left: tickToPx(headTick, pxPerBeat), top: band.top, height: band.height }}
      className="pointer-events-none absolute z-10 w-0.5 bg-brass-hi shadow-glow-brass"
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
  stringCount,
  instrumentId,
  grid,
  edgeScroll,
  geometry,
  registerDeactivate,
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
  stringCount: number;
  instrumentId: string;
  grid: SnapOption;
  edgeScroll: EdgeAutoScroll;
  geometry: SurfaceGeometry;
  /** The activation coordinator's handle on this surface's in-flight work —
   *  see `NoteSurface.registerDeactivate`. */
  registerDeactivate: (end: () => void) => () => void;
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
        // The SPAN's height, not the lane's. A lane can be taller than its
        // string rows — a four-string bass lane is 128 of content in a 143 lane
        // — and `NoteSurface` divides whatever it is given into `stringCount`
        // rows, so the lane's height here would stretch the bass to a 35.75 px
        // pitch beside the guitar lane above it. `editableSpans` has already
        // centred this box in the lane.
        laneAreaHeight={span.rect.height}
        stringCount={stringCount}
        instrumentId={instrumentId}
        grid={grid}
        edgeScroll={edgeScroll}
        geometry={geometry}
        registerDeactivate={registerDeactivate}
      />
    </div>
  );
}

export function ArrangementGrid({
  views,
  onTrackViewChange,
  collapsedRacks = NO_COLLAPSED_RACKS,
  onCollapsedRacksChange,
  collapsedRackSections = NO_COLLAPSED_SECTIONS,
  onCollapsedRackSectionsChange,
  patternDragRef,
}: {
  /**
   * WHICH VIEW EACH TRACK IS SHOWING, keyed by composition id then track id —
   * `App`'s map, read through `arrangementMath.viewOf` and never indexed here.
   * A missing entry means Pattern, which is why an uncontrolled grid needs no
   * seeding.
   *
   * Optional with local state behind it, the way `CompositionPage`'s rail
   * sections are: a caller that passes neither half gets working view buttons
   * that simply do not outlive this component.
   */
  views?: CompositionTrackViews;
  onTrackViewChange?: (
    compositionId: string,
    trackId: string,
    view: ArrangementMode,
  ) => void;
  /**
   * Which tracks' voice racks are folded. Held by `App` for the reason `views`
   * is: this component unmounts on every visit to the pattern page, and a rack
   * that unfolds itself behind your back is the same bug as a view that resets.
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
  // No `useSelectedPlacementIds()` here any more. Everything on this page that
  // asks about the block selection asks `gestures.effectiveSelection`, which is
  // that subscription with the view's eligibility already applied — and the
  // hook holds it, so this component still re-renders on every selection change.
  /**
   * A generation job holds the document.
   *
   * Read HERE and not only at the seam, because two of the three things this
   * milestone added are UI state the seam cannot refuse: which surface owns the
   * keyboard, and whether a press may take a track. The seam still refuses every
   * WRITE (`openPlacementForEditing` and friends) — this is what stops a refused
   * activation from ever reaching one.
   */
  const jobRunning = useIsJobRunning();
  /** The composition the map is keyed under. `''` with none open — no track id
   *  is asked about in that state, and `viewOf` is total, so it needs no guard
   *  of its own. */
  const compositionId = composition?.id ?? '';
  /**
   * The uncontrolled fallback — see the `views` prop, and the rail sections in
   * `CompositionPage` for the shape.
   *
   * A PASSED MAP WINS, exactly as a passed section list does: the caller owns
   * it, and a caller that passes one and no handler is one that does not want it
   * changed from in here (a test pinning a fixed stack, a `rerender` standing in
   * for a view change). The local state is what an uncontrolled render uses, and
   * the buttons write to it.
   */
  const [ownViews, setOwnViews] = useState<CompositionTrackViews>(NO_VIEWS);
  const trackViews = views ?? ownViews;
  /**
   * THE ONE PLACE A TRACK'S VIEW IS DECIDED.
   *
   * Every per-lane decision in this file routes through here — the lane's
   * height, what it draws, whether it is timed, whether its blocks can be
   * pressed, which history ⌘Z pops — so there is exactly one answer to "what is
   * this track showing" and the per-composition map is the only place it comes
   * from. Adding a second lookup to a per-lane branch is how that stops being
   * true; milestone 2 kept this signature through a uniform-mode step precisely
   * so this milestone could replace the BODY and nothing else.
   *
   * Total: an unknown track answers Pattern, because that is what the absence of
   * an entry means (`arrangementMath.viewOf`).
   */
  const viewOfTrack = useCallback(
    (trackId: string): ArrangementMode => viewOf(trackViews, compositionId, trackId),
    [trackViews, compositionId],
  );
  /**
   * Is there a Pattern lane on screen at all.
   *
   * A PER-LANE question asked of the whole stack, and the page-level half of the
   * pointer split (§4): WHICH lane was pressed is `isPatternLane`'s answer at
   * the press. It gates the lane area's own pointer handlers, the gesture hook,
   * and the empty-arrangement hint's wording — every one of which is a statement
   * about whether a block can be placed or grabbed anywhere in this stack.
   */
  const anyPatternLane = tracks.some((track) => viewOfTrack(track.id) === 'pattern');
  /**
   * Whether there is a time axis on screen at all.
   *
   * A PER-LANE question asked of the whole stack: the axis is up unless every
   * lane is a voice lane. A voice lane has no time in it — the bar lines, the
   * playhead, the zoom steps, the snap menu and the block actions are every one
   * of them a statement about WHEN, and a rack is not placed in time — but ONE
   * timed lane is enough to need a ruler over it, so this cannot be "no lane is
   * voice".
   *
   * An EMPTY stack has no lane to ask, and `some` on nothing is `false` — which
   * is the wrong answer, so the composition's OWN DEFAULT VIEW is the fallback
   * and that default is Pattern (`viewOf` on a track nobody has switched). A
   * trackless composition is therefore timed. It is not a per-lane branch: it is
   * what the page shows when there are no lanes.
   *
   * ⚠ Why it is not simply `true`. A trackless composition is not reachable
   * through `compositionService` (the seam refuses to delete the last track),
   * but one built elsewhere can carry zero tracks — and before milestone 2 this
   * was an unconditional `true`, which put the ruler, the zoom steps, the snap
   * menu, the bar count and "Nothing placed yet" on screen beside a rail
   * labelled Voices. Keeping the fallback explicit is what documents that the
   * answer comes from a VIEW rather than from there being nothing to draw.
   *
   * Edit stays timed: an edit lane very much has a time axis and merely hands
   * the pointer to the note surfaces.
   */
  const timed =
    tracks.length === 0 || tracks.some((track) => viewOfTrack(track.id) !== 'voice');
  /**
   * Undo is per-DOCUMENT, and edit mode edits a different one.
   *
   * The two histories are separate stacks — `compositionService`'s holds whole
   * `Composition` snapshots, `patternService`'s holds `Pattern`s — and ⌘Z is
   * already routed by the selected track's view (the arrangement's key handler
   * is off in Edit; the focused `NoteSurface`'s is not). These two buttons follow
   * it or they are a second, contradicting code path: pressing ↶ after a note
   * edit would restore a composition snapshot captured before it and stamp the
   * pre-edit `patternSnapshot` back over the block — destroying the edit with no
   * step in either stack to recover it.
   */
  const compositionHistory = useHistoryState();
  const noteHistory = useNoteHistoryState();
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
   *
   * ⚠ NOT the voice racks'. `TrackVoiceRack` used to report here and now keeps its
   * own notice line, because up to eight of them are on screen and each one has
   * something saveable in it — a refusal about the fifth track, read at the top of
   * the page, names none of them. What is left here is about the TRACK: its
   * instrument, its place in the stack, a drop the arrangement refused.
   */
  const [notice, setNotice] = useState<{ text: string; seq: number } | null>(null);
  /**
   * ⚠ A COUNTER RIDES ALONG, and it is what makes a REPEATED refusal audible.
   * Setting the same string twice is a React bail-out, so the second and third
   * refused press during a job would re-render nothing and a screen reader would
   * announce nothing — and the coordinator refuses the same way on every path,
   * which makes that the common case rather than a corner. The counter changes
   * on every set, and the alert is keyed on it, so the node is replaced and
   * `role="alert"` fires again.
   */
  const setTrackNotice = useCallback(
    (text: string | null) =>
      setNotice((previous) =>
        text === null ? null : { text, seq: (previous?.seq ?? 0) + 1 },
      ),
    [],
  );
  /** Why the empty state's New press did nothing. Its own state rather than
   *  `trackNotice`'s: they cannot be on screen together — one belongs to a
   *  composition that exists and the other to there being none. */
  const [newNotice, setNewNotice] = useState<string | null>(null);
  /**
   * What each track's voice rack MEASURED, keyed by track id — the input to the
   * voice arm of `laneHeightResolver`.
   *
   * ⚠ A MEASUREMENT, NOT A PREDICTION, and that is the whole reason a voice lane
   * is allowed to be sized by its content at all. CP-14 kept a pixel table that
   * guessed how tall an open rack came out and was ~40 px short; a
   * `ResizeObserver` reads the box the browser has just laid out, so folding a
   * stage fires it and the lane follows. The forbidden thing is deriving a
   * height from the rack's sections — see `laneHeightResolver`.
   *
   * 0 / absent means NOT MEASURED YET, never "a zero-height lane": jsdom reports
   * every box as 0×0 and the suite's stubbed observer never fires, and a rack
   * that has not been observed yet must open at the header's height rather than
   * vanish. The resolver's `max` is what turns that into the fallback.
   */
  const [rackHeights, setRackHeights] = useState<Readonly<Record<string, number>>>({});
  const rackObserverRef = useRef<ResizeObserver | null>(null);
  /**
   * Attach/detach for one rack's measured box.
   *
   * A React 19 ref CLEANUP rather than a `null` call: the cleanup runs when the
   * element goes — the track left voice view, was deleted, or the page
   * unmounted — so nothing has to work out which id disappeared in order to
   * unobserve it.
   *
   * The observer is built LAZILY — on the first rack to mount rather than on
   * every render — and UNCONDITIONALLY, as `Timeline` and `TablatureView`
   * already do. `ResizeObserver` is not optional here: with the row's inner
   * scroller gone, an unmeasured open rack is clipped to the header's height
   * with no way to reach the rest of the chain. It has been baseline in every
   * browser since 2020, and `tests/setup.ts` installs a stub so jsdom mounts —
   * that stub's `observe` never FIRES, which is why nothing is measured under
   * vitest unless a test swaps in a firing one (`tests/TablatureView.test.tsx`
   * is the precedent, and `tests/VoiceMode.test.tsx` now does it here).
   */
  const measureRack = useCallback((el: HTMLDivElement | null) => {
    if (el === null) return undefined;
    if (rackObserverRef.current === null) {
      rackObserverRef.current = new ResizeObserver((entries) => {
        setRackHeights((current) => {
          let next: Record<string, number> | null = null;
          for (const entry of entries) {
            const trackId = entry.target.getAttribute('data-voice-rack');
            if (trackId === null) continue;
            // `borderBoxSize`, not `contentRect`: the rack's padding and any
            // border are part of how tall the lane has to be, and `contentRect`
            // reports neither.
            const box = entry.borderBoxSize?.[0];
            const raw = box ? box.blockSize : entry.contentRect.height;
            // ROUNDED, and written only when the rounded value CHANGES. An
            // observer whose callback re-renders into a measurement differing
            // by a subpixel is an infinite loop, and what it looks like is
            // "ResizeObserver loop completed with undelivered notifications".
            // Returning `current` unchanged is a React bail-out, so the common
            // case costs no render at all.
            const height = Math.round(raw);
            if (!(height > 0)) continue;
            if ((next ?? current)[trackId] === height) continue;
            next = { ...(next ?? current), [trackId]: height };
          }
          return next ?? current;
        });
      });
    }
    const observer = rackObserverRef.current;
    // `box: 'border-box'` rather than the default content box, so the
    // NOTIFICATION is gated on the same box the callback READS. The wrapper is
    // deliberately unstyled today, which makes the two boxes equal — this is
    // what keeps that an implementation detail rather than a dependency.
    observer.observe(el, { box: 'border-box' });
    return () => observer.unobserve(el);
  }, []);
  // One observer for the page, disconnected with it. `unobserve` above handles
  // the per-rack case; this is the teardown for the whole thing.
  useEffect(
    () => () => {
      rackObserverRef.current?.disconnect();
      rackObserverRef.current = null;
    },
    [],
  );
  /**
   * Forget the rack height of a track that no longer exists.
   *
   * The ref cleanup above unobserves the element; it does not drop the entry,
   * and an entry for a deleted id would pin a height for the rest of the session
   * — visible the moment an undo brings that id back, at whatever the rack
   * happened to measure before. Keyed on the id LIST rather than on `tracks`,
   * which is a fresh array on every store write.
   */
  const trackIdKey = tracks.map((track) => track.id).join('\u0000');
  useEffect(() => {
    const live = new Set(trackIdKey === '' ? [] : trackIdKey.split('\u0000'));
    setRackHeights((current) => {
      const stale = Object.keys(current).filter((id) => !live.has(id));
      if (stale.length === 0) return current;
      const next = { ...current };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [trackIdKey]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const rulerContentRef = useRef<HTMLDivElement>(null);
  const headerStackRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  /** Set only by `zoomTo` and by the return of a timed lane, consumed once by
   *  the layout effect below. Non-null means "the COMPONENT wants the view
   *  moved" — the effect never imposes a position the user's own scrolling
   *  produced. */
  const pendingScrollLeftRef = useRef<number | null>(null);
  /** The vertical twin of the above, and set by the same return. Nothing else
   *  moves the view vertically on our behalf — the user's own wheel and the
   *  browser's focus scrolling both leave it null. */
  const pendingScrollTopRef = useRef<number | null>(null);
  /**
   * Where the TIME AXIS was, kept across a stretch with no timed lane on screen.
   *
   * An all-voice stack's content is window-wide, so it has no horizontal
   * overflow at all and the browser clamps `scrollLeft` to 0 the moment the
   * width changes — taking the offset with it, since the element is deliberately
   * the only place scroll lives (see the header). Without this, tuning a rack
   * and coming back lands at bar 1 from bar 40, and CP-01's invariant that only
   * what a LANE draws changes between views would be false.
   *
   * Recorded from `syncViewports` rather than read on the way out: a layout
   * effect runs after the DOM is mutated, by which point the clamp has already
   * happened and the number is gone.
   */
  const timedScrollLeftRef = useRef(0);
  /**
   * And WHICH TRACKS were in view, kept across the same stretch.
   *
   * NOT belt-and-braces, and not redundant now that the scroller survives a
   * visit: a lane is `max(header, content)`, so an all-voice stack of open racks
   * is several times as tall as an all-pattern one (143 a lane) and an all-edit
   * one is 192 a lane. Coming BACK shrinks the content under a `scrollTop` the
   * browser then clamps to the new end, and the number is gone from the one
   * place it lives. What that costs is real: eight edit lanes are 8 × 192 =
   * 1536 px, and a discarded `scrollTop` would put you on track 1 with
   * `syncViewports` translating the header column to agree, which is the silent
   * discard `tests/EditMode.test.tsx` guards the pattern↔edit switch against.
   *
   * It is therefore deliberately RE-IMPOSING the last timed position rather than
   * only rescuing a lost one: scrolling down a stack of racks and coming back
   * lands where the timed lanes were left, not on whichever track the taller
   * stack happened to be showing. The two stacks are different heights, so there
   * is no offset that means the same thing in both. Racks now grow and shrink as
   * stages are folded, which makes that more true, not less.
   */
  const timedScrollTopRef = useRef(0);
  /** For `syncViewports`, which is a stable callback and so cannot close over
   *  `timed` — and must not record an all-voice stack's clamped zero as the
   *  axis. */
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

  /**
   * Every mounted note surface's synchronous teardown — see
   * `NoteSurface.registerDeactivate`.
   *
   * ALL of them, not just the focused one's, because effects flush child-first:
   * a surface that deregistered on losing focus would already be gone by the
   * time this component's own reconciler effect ran, which is the one caller
   * that has no other way to reach it. Each teardown is a no-op on a surface
   * with nothing in flight, so the set costs nothing to sweep.
   */
  const surfaceTeardownsRef = useRef(new Set<() => void>());
  const registerSurfaceDeactivate = useCallback((end: () => void) => {
    const teardowns = surfaceTeardownsRef.current;
    teardowns.add(end);
    return () => {
      teardowns.delete(end);
    };
  }, []);
  /**
   * The arrangement gestures' teardown, through a ref because the two are
   * mutually recursive: the coordinator has to end a block drag before it
   * repoints the page, and the gesture hook has to call the coordinator before
   * it starts one. A ref is the cut.
   */
  const endArrangementGesturesRef = useRef<() => void>(() => {});

  /**
   * End everything the page is still holding over the OUTGOING target — the
   * focused note surface's pointer gesture, fret timer and undo brackets, and
   * any arrangement drag or held-arrow bracket (COMPS-TRACK-TABS milestone 3
   * §B). Synchronous, and idempotent.
   *
   * ⚠ WHAT THE AUDIT FOUND, so the next reader does not re-derive it.
   * `NoteSurface` already ends its KEY RUNS from its own capture-phase
   * `pointerdown` listener and from the first non-digit keydown, so every
   * activation that arrives through a press or a key press has already closed
   * them before this runs — that is why the `closes.at` assertions in
   * tests/EditMode.test.tsx hold either way for those paths. Two things are NOT
   * covered by that, and are the reason this exists:
   *
   *  - A POINTER GESTURE. `focused` going false does not end one; its teardown
   *    is tied to completion and unmount, so a note drag's window listeners
   *    survive a track switch and keep writing — into whatever the seam has
   *    repointed at by then.
   *  - A PROGRAMMATIC activation. The reconciler below closes the editor in
   *    response to a `selectTrack` from outside this page, which trips neither
   *    of `NoteSurface`'s listeners.
   */
  const endOutgoingWork = useCallback(() => {
    for (const end of surfaceTeardownsRef.current) end();
    endArrangementGesturesRef.current();
  }, []);

  /**
   * ── THE ACTIVATION COORDINATOR ──────────────────────────────────────────────
   *
   * THE ONE WAY A TRACK BECOMES THE ACTIVE ONE, and the one place the order of
   * operations is written down. Track headers, their view buttons, lane presses
   * and the note surfaces' focus callbacks all arrive here (COMPS-TRACK-TABS
   * milestone 3 §A, milestone 4 §2). The order is the whole of it, and every
   * step is load-bearing:
   *
   *  1. VALIDATE the target and the lock, before anything is torn down — a
   *     refusal here has to leave the page exactly as it was, which is why step
   *     1 checks every condition step 5 could refuse on (the lock, the track,
   *     and that the track still owns the block). Step 5 refusing anyway would
   *     mean the document moved between the two, and it leaves the new track
   *     SELECTED with nothing open rather than the page untouched — stated
   *     because it is an exception to the sentence above, not a hole in it.
   *  2. END THE OUTGOING GESTURES SYNCHRONOUSLY, against the target they started
   *     on. A React effect cleanup runs after the new target is already open,
   *     by which point a fret timer's or a held arrow's undo bracket closes over
   *     the wrong document and `history.capture` swallows every later edit.
   *  3. CLOSE the outgoing placement — BEFORE any new selection, because
   *     `closePlacementEditing` empties the placement selection itself and would
   *     erase one made first (§C).
   *  4. SELECT the new track.
   *  5. START the requested action.
   *
   * Returns whether the activation SUCCEEDED, and a false must stop the caller:
   * a refused focus that fell through into `NoteSurface`'s gesture would write
   * into whichever pattern happened to be open.
   *
   * What it deliberately does NOT do is touch `compositionService.selectTrack`'s
   * contract or any agent capability. The seam stays reachable by id with no
   * pointer and with no view state; this is the UI's own front door to it.
   */
  const activateTrack = (trackId: string, action: TrackActivation): boolean => {
    // 1 — the lock first, so a refusal costs nothing. The headers' view buttons
    // are disabled during a job for the same reason (§4 asks for both), but a
    // header press, a lane press and a surface taking focus reach no disabled
    // control.
    if (isJobRunning()) {
      setTrackNotice(JOB_LOCK_REASON);
      return false;
    }
    // LIVE, not this render's array. The coordinator is called from window
    // handlers that outlive their render, and from the Add Track button in the
    // same tick as the write that created the track — a render-time list would
    // report the new track as gone and refuse the activation it was asked for.
    //
    // Both refusals below are defences against a target that went STALE between
    // the render that offered it and the press — a lane geometry ref outliving
    // its track, an agent retracting a placement mid-gesture. Neither is a case
    // the UI produces on its own, which is why neither has a test that drives it
    // through the UI.
    const track = getTracks().find((candidate) => candidate.id === trackId);
    if (!track) {
      setTrackNotice(TRACK_GONE_REASON);
      return false;
    }
    const owns = (placementId: string) =>
      track.placements.some((placement) => placement.id === placementId);
    if (action.kind === 'edit' && !owns(action.placementId)) {
      setTrackNotice(BLOCK_OFF_TRACK_REASON);
      return false;
    }

    const openPlacementId = getEditingPlacementId();
    // The open block belongs to the track being activated — which is how
    // re-selecting a track PRESERVES its active placement, and how a block the
    // agent opened by id is adopted rather than thrown away.
    const keepsOpenPlacement = openPlacementId !== null && owns(openPlacementId);
    const willClose = openPlacementId !== null && !keepsOpenPlacement;
    const willOpen = action.kind === 'edit' && openPlacementId !== action.placementId;

    // 2 — nothing below may run with a bracket still open over the outgoing
    // target. Idempotent, so this costs nothing when nothing is in flight.
    if (getSelectedTrackId() !== trackId || willClose || willOpen) endOutgoingWork();

    // 3 — before the selection, never after it.
    if (willClose) closePlacementEditing();

    // 4
    selectTrack(trackId);

    // 5 — only a SUCCESSFUL open grants focus.
    if (action.kind === 'edit') {
      const opened = openPlacementForEditing(action.placementId);
      if (!opened.ok) {
        setTrackNotice(opened.reason);
        return false;
      }
    }
    return true;
  };

  /**
   * Which TRACK owns the open block, or null when nothing is open — or when the
   * block has been retracted out from under the pointer, which an undo can do
   * (the seam's `pruneEditingPlacement` is what closes it; this only has to stop
   * drawing it as live in the meantime).
   */
  const editingTrackId =
    editingPlacementId === null
      ? null
      : (tracks.find((track) =>
          track.placements.some((placement) => placement.id === editingPlacementId),
        )?.id ?? null);
  /**
   * The block the UI treats as live — the one a surface may focus, the one whose
   * notes the inspector is about, the one the keyboard is pointed at.
   *
   * DERIVED FROM CURRENT OWNERSHIP, not from an effect, and that is the point of
   * §4: an effect that closed the editor on the way to agreeing with the
   * selection would have rendered one frame of the wrong track's notes first.
   * The reconciler below is a BACKSTOP for changes that arrive from outside this
   * component (the agent, an undo, another page), never the primary path.
   *
   * Three things can make the open block not ours:
   *
   *  - A JOB HOLDS THE DOCUMENT. The pointer is the agent's, and §4 is explicit
   *    that UI reconciliation must not close or repoint it to satisfy an
   *    invariant — so the block stays open and the UI simply stops owning it.
   *    With no surface focused, no window key listener is attached (see
   *    `NoteSurface.focused`) and the shortcuts are suppressed rather than
   *    fought over.
   *  - ANOTHER TRACK IS SELECTED. Selection is what ownership follows.
   *  - THE OWNING TRACK IS NOT IN EDIT. Its lane draws no surface at all.
   *
   * A null selection is deliberately NOT one of them: `openPlacementForEditing`
   * is reachable by id with no pointer, and a page that immediately disowned
   * what the agent opened would make that capability depend on React view state
   * — which §4 forbids. The reconciler adopts the track instead.
   */
  const uiEditingPlacementId =
    editingPlacementId !== null &&
    !jobRunning &&
    editingTrackId !== null &&
    (selectedTrackId === null || selectedTrackId === editingTrackId) &&
    viewOfTrack(editingTrackId) === 'edit'
      ? editingPlacementId
      : null;

  /**
   * THE SELECTED TRACK'S VIEW — the input to everything below that is about a
   * DOCUMENT rather than about a lane.
   *
   * `arrangementMath.selectedTrackView`, which is also what the RAIL is picked
   * from (`CompositionPage`). One function rather than the same three clauses
   * written out in both files: the two must agree, and a fallback changed in one
   * copy would split the rail from the keyboard with nothing to catch it. The
   * membership check and the no-selection fallback are documented there.
   */
  const selectedView: ArrangementMode = selectedTrackView(
    trackViews,
    compositionId,
    selectedTrackId,
    tracks,
  );
  /**
   * Which view the page's DIRECT EDITING commands belong to — see
   * `DirectEditContext`.
   *
   * The SELECTED track's view, which is what §4's table means by a context:
   * ⌘Z pops the history of the document the user is pointed at, and with three
   * tracks in three views on screen at once "the page's view" names nothing.
   * `uiEditingPlacementId` is the edit arm's input rather than the store's raw
   * pointer because that derivation already asks who OWNS the block, and
   * ownership is what the selected track's view decides.
   */
  const commandContext: DirectEditContext =
    selectedView === 'voice'
      ? { kind: 'voice' }
      : selectedView === 'edit'
        ? uiEditingPlacementId !== null
          ? { kind: 'edit', placementId: uiEditingPlacementId }
          : { kind: 'edit-idle' }
        : { kind: 'pattern' };
  /**
   * ↶ and ↷, routed by the ONE context above — the selected track's view.
   *
   * `edit-idle` — edit view with no block live — is DISABLED, which is the
   * behaviour change §4's table asks for. Pointed at the note history it was
   * pointed at the pattern page's own stack, so the press undid an edit made on
   * a document that is not on screen and left nothing to redo it with. `voice`
   * has no arrangement or note document to act on either, and the buttons do not
   * render there at all.
   */
  const { canUndo, canRedo } =
    commandContext.kind === 'edit'
      ? noteHistory
      : commandContext.kind === 'pattern'
        ? compositionHistory
        : NO_HISTORY;
  const undoHere = commandContext.kind === 'edit' ? undoNote : undo;
  const redoHere = commandContext.kind === 'edit' ? redoNote : redo;
  /**
   * Whether this track's lane draws BLOCKS — the arrangement's own hit target.
   *
   * The one input the gesture hook needs to filter lanes, selections and drops.
   * `useCallback` because it is read through a ref inside window handlers and a
   * new identity every render would churn the hook's mirror for nothing.
   */
  const isPatternLane = useCallback(
    (trackId: string) => viewOfTrack(trackId) === 'pattern',
    [viewOfTrack],
  );

  const gestures = useArrangementGestures({
    geometry: useCallback(() => geometryRef.current, []),
    scrollerRef,
    /**
     * ── THE SPLIT (§4) ───────────────────────────────────────────────────────
     *
     * POINTER: is there a Pattern lane on screen to press at all. WHICH lane
     * was pressed is `isPatternLane`'s answer at the press, not this one — a
     * press on an Edit or Voice row falls through to whatever that row draws,
     * because the arrangement hit-tests only the lanes it owns. So the pointer
     * surface does not care which track is SELECTED, and a Pattern block stays
     * draggable while some other track's view is the one in the rail.
     *
     * A composition with NO TRACKS answers false: there is nothing to press and
     * nothing to drop onto (`dropTarget` over zero lanes is null either way), so
     * `startPatternDrag` declines rather than starting a drag that could never
     * place anything. `openBlankComposition` makes one, so the state is
     * reachable.
     */
    pointerEnabled: anyPatternLane,
    /**
     * KEYBOARD: exclusive with a focused `NoteSurface`, which answers the same
     * keys against the notes. Two keyboard systems over one surface is how one
     * ⌘Z pops an arrangement step and a note step at once.
     *
     * ⚠ THE EXCLUSION IS SPELLED OUT, and milestone 4 is why. It used to be
     * structural: `keyboardEnabled` was true only in the `pattern` context, and
     * `uiEditingPlacementId` — the only thing that focuses a surface — was
     * non-null only in `edit`, because both read the ONE page mode. They read
     * two different things now. The context is the SELECTED track's view;
     * ownership is the view of the track that OWNS the open block. With nothing
     * selected those disagree by design: a block opened by id adopts its own
     * track (§4 forbids making that capability depend on React view state), so
     * it is live and focused while the context is still the no-selection Pattern
     * fallback. The reconciler selects that track on the very next effect, so
     * the overlap cannot outlive one commit and no keypress can land inside it —
     * but "cannot be true at once" is no longer a property of the derivation,
     * and a second window key handler over a focused note surface is not
     * something to leave resting on an effect's timing.
     *
     * Voice is the same argument for a different reason: those lanes are racks,
     * so ArrowUp there belongs to a knob. The boundary predicate catches a
     * FOCUSED dial in any view; this is what stops the arrangement answering
     * keys in a view that is drawing no blocks at all.
     *
     * ⚠ `timed` IS PART OF IT, and it is the ALL-VOICE stack with nothing
     * selected: §4's table puts the no-selection fallback in the Pattern row, so
     * without this a ⌘Z over a screen holding nothing but racks would pop an
     * arrangement step made on a surface that is not on screen — and the
     * toolbar's ↶, its literal twin, is not even rendered there (it is gated on
     * `timed` too). The two must agree or one of them is a second, contradicting
     * code path.
     */
    keyboardEnabled:
      timed && commandContext.kind === 'pattern' && uiEditingPlacementId === null,
    isPatternLane,
    // A lane press takes its track before the gesture writes anything — and a
    // refusal stops the press dead. Only `onLanesPointerDown` calls it: a drag
    // passing over a lane, a hover, and a library drop all deliberately leave
    // the selection alone (plan §2).
    activateTrack: (trackId) => activateTrack(trackId, SELECT_TRACK),
  });
  endArrangementGesturesRef.current = gestures.endGestures;

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
   * Point the note editor at a block — what every press inside an edit lane does
   * before it writes anything.
   *
   * Through the COORDINATOR now rather than straight at the seam: a press has to
   * take the block's TRACK as well, and it has to end whatever the outgoing
   * block still had in flight first. Returns whether the surface may now edit,
   * so a refusal (a job holds the document, the block is gone, no composition is
   * open) stops the gesture instead of letting it write into whichever pattern
   * happened to be open. Still reachable by id without a pointer through
   * `compositionService.openPlacementForEditing`, which is what the agent calls.
   */
  const focusPlacement = (trackId: string, placementId: string): boolean =>
    activateTrack(trackId, { kind: 'edit', placementId });

  /**
   * ── A TRACK'S VIEW BUTTON (§2) ──────────────────────────────────────────────
   *
   * A view click SELECTS ITS TRACK AND SETS ITS VIEW, even when that view is
   * already the active one — which is the whole reason this is not a bare
   * setter. It goes through the coordinator like every other activation, so a
   * job holding the document refuses it, an outgoing note drag is ended against
   * the block it started on, and another track's open block is closed before the
   * selection moves. A refused activation writes NO VIEW: the page has to be
   * left exactly as it was.
   *
   * ⚠ LEAVING EDIT CLOSES THIS TRACK'S OWN BLOCK, here and synchronously.
   * `activateTrack` deliberately KEEPS an open block that belongs to the track
   * being activated — that is how re-selecting a track preserves what it was
   * editing — so on the Pattern and Voice buttons this is the step that gives it
   * up. The reconciler below would also catch it one commit later (it asks
   * `viewOfTrack(editingTrackId) !== 'edit'`), but that is the BACKSTOP for
   * changes made outside this component, and a close that arrives a commit late
   * leaves the lib's editing pointer parked on a lane that has stopped drawing
   * it. The cost is the documented one: the block's edits survive, its note undo
   * history does not.
   *
   * The teardown before the close, as everywhere else — this is a button press,
   * so `NoteSurface`'s own capture-phase run-enders have already fired, but a
   * POINTER gesture is not ended by either of them (§B).
   */
  const changeTrackView = (trackId: string, view: ArrangementMode): void => {
    if (!activateTrack(trackId, SELECT_TRACK)) return;
    if (view !== 'edit') {
      const open = getEditingPlacementId();
      const owned =
        open !== null &&
        (getTracks()
          .find((candidate) => candidate.id === trackId)
          ?.placements.some((placement) => placement.id === open) ??
          false);
      if (owned) {
        endOutgoingWork();
        closePlacementEditing();
      }
    }
    if (onTrackViewChange) onTrackViewChange(compositionId, trackId, view);
    // ⚠ ONLY WHEN THIS GRID IS UNCONTROLLED. A caller that passes `views` and no
    // handler owns the map and does not want it written from in here (see the
    // prop) — `setOwnViews` there would write state nothing reads and re-render
    // for it, which is the classic controlled/uncontrolled trap. The SELECTION
    // above still moves, because that is the seam's and not this map's.
    else if (views === undefined) {
      setOwnViews((was) => setTrackView(was, compositionId, trackId, view));
    }
  };

  /**
   * THE BACKSTOP. Reconcile the open block with who owns it, for the changes
   * this component did not make: an agent run that opened one by id, an undo
   * that moved a placement to another track, a view or selection written from
   * somewhere else.
   *
   * Silent while a JOB IS RUNNING — the pointer is the job's, and closing it
   * here would land the agent's next note in the user's library pattern, which a
   * cancel does not undo. The effect re-runs when the lock lifts, which is where
   * "reconcile against live state when the job releases ownership" happens.
   *
   * ⚠ Silent about the DOCUMENT, not about the pointer. A job taking the
   * document is one of §E's invalidators, and the arrangement's own gestures
   * fold `isJobRunning()` into `invalidated`; a NOTE drag has no equivalent.
   * `uiEditingPlacementId` goes null under the lock, so `focused` goes false —
   * and `focused` going false ends no pointer gesture (see `endOutgoingWork`):
   * the surface's window listeners keep writing into the block the agent now
   * owns, with a `patternService` undo bracket held open across the job. So the
   * work ends here even though the pointer stays where it is.
   */
  useEffect(() => {
    // Idempotent, and the effect re-runs only when one of its inputs moves, so
    // this is one sweep per lock transition rather than per agent write.
    if (jobRunning) {
      endOutgoingWork();
      return;
    }
    if (editingPlacementId === null) return;
    // Gone from the document entirely: the seam's own `pruneEditingPlacement`
    // owns that case, and closing it here as well would race it. Its callers are
    // every write that can retract a placement out from under the pointer —
    // `removeTrack`, `removePlacement` (the lib's own action nulls the pointer
    // there), `undo`, `redo` and `abortEditGesture` — so by the time this effect
    // runs the pointer has already been closed, and `editingPlacementId === null`
    // above has returned.
    if (editingTrackId === null) return;
    if (viewOfTrack(editingTrackId) !== 'edit') {
      endOutgoingWork();
      closePlacementEditing();
      return;
    }
    // Nobody owns the selection, so the open block claims its own track rather
    // than being discarded — see `uiEditingPlacementId`.
    if (selectedTrackId === null) {
      selectTrack(editingTrackId);
      return;
    }
    if (selectedTrackId !== editingTrackId) {
      // The teardown first, exactly as the coordinator does it — this path is
      // reached by a `selectTrack` from OUTSIDE the page, which arrives through
      // neither a pointerdown nor a keydown and so trips none of `NoteSurface`'s
      // own capture-phase run-enders.
      endOutgoingWork();
      closePlacementEditing();
    }
  }, [jobRunning, editingPlacementId, editingTrackId, selectedTrackId, viewOfTrack, endOutgoingWork]);

  /**
   * PAGE EXIT, and its own effect on purpose.
   *
   * Leaving the composition page leaves the lib's one editing pointer parked on
   * a placement, and the pattern page would then draw that block's snapshot —
   * the CP-02 family of defect. `CompositionPage` used to carry the same cleanup
   * keyed on its global `mode`; milestone 4 deleted that mode, and an
   * unconditional cleanup keyed on the view map that replaced it would run on
   * every unrelated track's view change, which is exactly what §4 says not to
   * do. So this is now the ONLY page-exit close, and it is keyed on the one
   * STABLE callback it uses: it fires on unmount and on nothing else. Leaving
   * Edit is the other half, and it is per-TRACK — `changeTrackView` closes
   * synchronously and the reconciler above is its backstop.
   *
   * The teardown FIRST, as everywhere else: this is the only close the
   * coordinator does not own, and a pointer gesture's window listeners are not
   * removed by taking its element out of the tree (§B).
   *
   * ⚠ In dev this cleanup also runs once immediately after mount, because
   * `main.tsx` wraps the app in `StrictMode`, so it is not literally "on unmount
   * only" in the environment the app is developed in. Still a no-op, and the
   * reason is worth naming now that `closePlacementEditing` also clears the NOTE
   * selection (LIB-GAP(26)): that clear is guarded on
   * `editingPlacementId !== null || editingPatternId === null`, and at mount
   * neither holds while the pattern page has a pattern open — which is the only
   * state with a note selection worth keeping. With no pattern open the ids are
   * the stale ones the guard exists to drop.
   */
  useEffect(
    () => () => {
      endOutgoingWork();
      closePlacementEditing();
    },
    [endOutgoingWork],
  );

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
  // way to tell that is what it is. `compositionId` is declared with the view
  // map above, which is keyed by it.
  useEffect(() => {
    setTrackNotice(null);
  }, [compositionId, setTrackNotice]);

  // Pulled out of `gestures` so the effect below depends on the ONE function it
  // calls rather than on the whole hook result, which changes every render.
  const { startPatternDrag } = gestures;
  useEffect(() => {
    if (!patternDragRef) return;
    /**
     * ⚠ SAY SO WHEN THE DRAG CANNOT LAND, rather than letting it be inert.
     *
     * `startPatternDrag` returns immediately when `pointerEnabled` is false, and
     * milestone 4 is what makes that state reachable WITH THE LIBRARY ON SCREEN:
     * the rail falls back to the pattern library whenever no valid track is
     * selected, so a stack with every lane in Edit or Voice — or a composition
     * with no tracks at all — shows a list of patterns that nothing can be
     * dragged out of. A press that does nothing and explains nothing reads as a
     * broken library.
     *
     * The track strip's notice line, which is where every other refusal about
     * this stack already lands.
     */
    patternDragRef.current = (patternId, e) => {
      if (!anyPatternLane) {
        setTrackNotice(
          tracks.length === 0
            ? 'Add a track before placing a block.'
            : 'Put a track in Pattern view to place a block.',
        );
        return;
      }
      startPatternDrag(patternId, e);
    };
    // Cleared on unmount: the rail outlives this component (the page keeps
    // rendering it while the grid reports a failure to open), and a stale
    // starter would drag against a geometry that no longer exists.
    return () => {
      patternDragRef.current = null;
    };
  }, [patternDragRef, startPatternDrag, anyPatternLane, tracks.length, setTrackNotice]);

  /** Match the two clipped viewports to wherever the scroller actually is. */
  const syncViewports = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // Every write to `scrollLeft` — a drag, a zoom, the playhead's auto-scroll —
    // raises the scroll event that runs this, so this is the one place that sees
    // all of them. An all-voice stack's clamped zero is not the axis and is not
    // recorded.
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
  // that one looks. A timed lane coming back is the only thing that restores an
  // offset — the last one leaving merely stops the recording, since the element
  // clamps itself and there is nowhere else the position could have gone.
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
    // END THE GESTURE BEFORE THE SCALE CHANGES (§5). A drag captures its lane
    // geometry and its pixels-per-beat at the press; carrying it across a zoom
    // would mix a tick computed at the new scale with a grab offset measured at
    // the old one, and the block would jump.
    //
    // ⚠ NOTHING ASSERTS THIS, and that is a property of the button rather than a
    // gap in the tests. Every route to it already ends the work first: a press
    // is a `pointerup`, which every in-flight drag's own window listener
    // catches, and a keyboard activation is a `keydown`, which both key
    // handlers treat as the end of a run. So this is belt to the braces the
    // gesture layer already wears — the REACHABLE case, a scale that changes
    // under a live gesture, is the hook's `invalidated` check, which folds in
    // `pxPerBeat` and is tested there. Kept because the day a wheel or pinch
    // zoom calls this, it will be the only thing standing between a live drag
    // and two scales at once.
    endOutgoingWork();
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
            of its own: the rail's composition list belongs to the PATTERN rail,
            and that is only the rail a selected Pattern track gets. With no
            composition open there is no track to select, so the page does fall
            back to the pattern rail here — but that is the fallback answering,
            not a guarantee, and an empty state with no way out is what CP-17
            went to the trouble of removing. */}
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
  // ONE RULE: a lane is `max(track header, its content)`. An edit lane fits its
  // own track's string count — a bass lane is four rows where a guitar lane is
  // six — and a voice lane is as tall as its rack MEASURED, so a folded rack
  // settles back on the header's height with no special case. That is what
  // `laneHeightResolver` is for; the numbers are all its.
  //
  // EVERY view, including all-voice. CP-16's voice rows were normal flow, so
  // there was nothing for `laneRects` to be right about and this returned an
  // empty stack; a voice lane now has a top and a height like any other, and the
  // rack in the layer above is positioned FROM that rect. An empty stack here
  // would put every rack at y=0 on top of each other.
  const lanes = laneRects(
    tracks,
    laneHeightResolver({
      viewOf: viewOfTrack,
      instrumentOf: instrumentOfTrack,
      // 0 until the observer has seen this rack — the resolver's `max` turns
      // that into "open at the header's height", which is also where a folded
      // rack lands. NEVER a zero-height lane.
      voiceRackHeight: (trackId) => rackHeights[trackId] ?? 0,
    }),
  );
  // The strips a bar line or the playhead may be drawn across. One band spanning
  // the whole stack whenever no lane is in voice, which is the case this page
  // has always drawn.
  /**
   * ⚠ NEVER PAIR A LANE LIST WITH THE TRACK LIST BY INDEX (§5).
   *
   * `laneRects` returns one rect per track in order, so today `lanes[i]` and
   * `tracks[i]` ARE the same track — and that is exactly what makes the bug
   * invisible: §5 requires a Pattern-ONLY lane array for hit tests, drops and
   * marquee selection (the gesture hook builds one, keeping the original tops,
   * so a non-Pattern row is a GAP), and the day any FILTERED list is handed to a
   * `.map((lane, index) => tracks[index])` the headers and the blocks silently
   * belong to the wrong tracks and still look plausible. Resolving by id cannot
   * drift, so the three render loops below all go through this.
   *
   * The index is carried with the track because `TrackControls`' move-up /
   * move-down needs the track's position in the STACK — which is the track
   * list's index, never the filtered lane list's.
   *
   * Not memoised, unlike `libraryById` above, and it cannot be: this sits below
   * the `!composition` early return, where a hook is illegal. `MAX_COMPOSITION_TRACKS`
   * is 8, so the map is eight entries built from an array that is already in hand.
   */
  const laneTrackById = new Map(tracks.map((track, index) => [track.id, { track, index }]));
  const laneTrack = (lane: LaneRect) => laneTrackById.get(lane.trackId);
  const bands = timedBands(lanes, viewOfTrack);
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
  // Hidden when the SELECTED track is in Edit: every one of these acts on a
  // BLOCK, and there the thing you have selected is a note. The block selection
  // is EMPTIED on the way in, not merely hidden — `closePlacementEditing` clears
  // it, because the lib nulls its own `selectedPlacementId` when a placement is
  // opened and the two must not disagree about what is selected.
  // `commandContext.kind === 'pattern'`, which is also false for a selected
  // Voice track: that context has no block on screen to act on either.
  //
  // `gestures.effectiveSelection`, not the store's: a selection written from
  // outside this page can name blocks on lanes the arrangement is not drawing,
  // and a toolbar that counted those would offer five buttons that act on
  // something nobody can see. The COMMANDS re-derive the same set when they
  // fire, so this is only what is drawn — see `ArrangementGestures`.
  const uiSelection = gestures.effectiveSelection;
  // Also what the blocks are DRAWN selected on, so the ring and the actions row
  // appear and disappear together — see `PlacementBlock` below.
  const hasSelection = uiSelection.length > 0 && commandContext.kind === 'pattern';

  // Assigned during render rather than from an effect: a gesture can begin on
  // the very first pointerdown after a zoom, which is before any effect for that
  // render has run. Everything here is already computed above, so this is a
  // handoff, not work.
  //
  // `lanes` now includes VOICE lanes, where it used to be empty in voice mode —
  // so `hitTest` can land on one. Deliberately not guarded here — it is guarded
  // at the hit test instead: every gesture filters this array through
  // `isPatternLane` before touching it, so a voice lane is a GAP that `laneAt`
  // answers null for rather than a row a press can land on. Keeping the full
  // stack here is what makes those gaps keep their original tops.
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
            twin and call the same function, and the voice context disables the
            window key handler outright (`keyboardEnabled`), so a live ↶ there
            would be the second, contradicting code path this comment block
            exists to forbid — and it would undo an arrangement edit that is not on screen,
            with no keyboard equivalent to redo it. Undo comes back with the
            surface it acts on. */}
        {timed && commandContext.kind !== 'voice' && (
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
                nothing is re-quantised by looking at a track whose view cannot
                express them. */}
            <span className="mx-1 h-4 w-px bg-line" />
            <label className="flex items-center gap-1.5">
              <span className="font-mono text-[9px] tracking-[0.12em] text-ink-mut uppercase">
                {commandContext.kind === 'pattern' ? 'Snap' : 'Grid'}
              </span>
              {/* The arrangement's default is the BAR where the note grid's is
                  the 16th — the one place the two surfaces intentionally
                  disagree (`arrangementMath`). The menu is shared so the labels
                  can't drift; which of the two settings it drives follows the
                  context, and the accessible name says which, because a control
                  that means two things under one name is one nobody can
                  address. */}
              <select
                aria-label={
                  commandContext.kind === 'pattern' ? 'Arrangement snap' : 'Note grid'
                }
                value={commandContext.kind === 'pattern' ? snapId : noteSnapId}
                onChange={(e) =>
                  (commandContext.kind === 'pattern' ? setSnapId : setNoteSnapId)(
                    e.target.value,
                  )
                }
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

        {/* THE UNDO COST, said while it is being incurred.
            `closePlacementEditing` clears the pattern history on the way out, so
            moving to another track loses the open block's note undo stack — the
            EDITS are written through and survive, the steps do not. That is the
            existing history model and milestone 3 keeps it (per-placement
            retained histories are a separate follow-up); what it does not keep
            is leaving the user to discover it.

            Here rather than in the inspector's empty state, because an empty
            state is the one screen a user editing notes never looks at. Beside
            the ↶ it qualifies, and only while a block is actually live.

            ⚠ TWO LINES AT THIS WIDTH, and at the toolbar's own 9px rather than
            anything smaller. The row is `items-center` with `h-4` separators,
            so a caveat wrapping to three or four lines would grow the toolbar
            every time a block went live. jsdom has no layout, so nothing here
            can assert it — it is held by the copy staying short. */}
        {uiEditingPlacementId !== null && (
          <>
            <span className="mx-1 h-4 w-px bg-line" />
            <span
              // Named and quiet: it is a standing caveat, not an event, so it
              // must not read out as an alert every time the selection changes.
              role="note"
              aria-label="Undo scope"
              className="max-w-[40ch] font-mono text-[9px] leading-tight tracking-[0.04em] text-ink-mut"
            >
              Undo is this block’s. Leaving it keeps its edits, clears its undo
              history.
            </span>
          </>
        )}

        {/* The selection's actions. Present only with a selection, because every
            one of them needs one and a permanently-greyed row of five buttons
            teaches nothing about what enables them. Each is the keyboard
            shortcut's twin, calling the LITERAL same function — `gestures.*` is
            what the window key handler calls too, so eligibility is resolved
            once, at the press, against live state (§4: both the toolbar and the
            keyboard must validate the current context at execution time).

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
              {uiSelection.length} sel
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
              onClick={() => gestures.transposeSelection(-1)}
              className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold"
            >
              ♭
            </button>
            <button
              type="button"
              aria-label="Transpose up a semitone"
              title="Transpose up (↑ · shift for an octave)"
              onClick={() => gestures.transposeSelection(1)}
              className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold"
            >
              ♯
            </button>
            <button
              type="button"
              aria-label="Duplicate selection"
              title="Duplicate one selection-length to the right (⌘D)"
              onClick={gestures.duplicateSelection}
              className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold"
            >
              ⧉
            </button>
            <button
              type="button"
              aria-label="Delete selection"
              title="Delete (⌫)"
              onClick={gestures.deleteSelection}
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
            else activateTrack(added.value.id, SELECT_TRACK);
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
      {notice && (
        <div className="mb-1.5 flex flex-none items-center gap-2">
          <p
            // Re-keyed on every set so a repeat of the SAME sentence is a new
            // node, and so announced — see `setTrackNotice`.
            key={notice.seq}
            role="alert"
            aria-label="Track message"
            className="flex-1 rounded-md border border-brass/50 px-2 py-1 font-mono text-[9.5px] text-ink"
          >
            {notice.text}
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
          // The ruler ROW goes with the ruler. Left declared with no ruler in
          // it, an all-voice stack would keep a 28 px strip of nothing above
          // the first rack — the lane area would be 28 px shorter than the
          // space it has, at every window height.
          gridTemplateRows: timed ? `${RULER_HEIGHT}px minmax(0, 1fr)` : 'minmax(0, 1fr)',
        }}
      >
        {/* A fragment, so the corner and the ruler are two grid ITEMS rather
            than one wrapper that would take a cell of its own. */}
        {timed && (
          <>
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
          </>
        )}

        {/* The header column's viewport — vertically locked to the lanes. */}
        <div
          data-testid="track-header-column"
          className="overflow-hidden border-t border-t-transparent border-r border-r-rim-dark"
        >
          <div ref={headerStackRef} data-testid="track-header-stack" style={{ height }}>
            {lanes.map((lane) => {
              const entry = laneTrack(lane);
              if (!entry) return null;
              const { track, index } = entry;
              return (
                <TrackHeader
                  key={lane.trackId}
                  track={track}
                  index={index}
                  trackCount={tracks.length}
                  height={lane.height}
                  selected={selectedTrackId === lane.trackId}
                  // This track's own view, and the button that changes it. Both
                  // by id: the header is drawn from a lane, and a lane knows
                  // which track it belongs to and nothing about where that track
                  // sits in an array.
                  view={viewOfTrack(lane.trackId)}
                  onViewChange={(view) => changeTrackView(lane.trackId, view)}
                  // A job owns the document; a view change can close an open
                  // block, so the buttons go dead with the rest of the page's
                  // activation (§4). The coordinator refuses the callback too —
                  // disabling is what makes the refusal legible before the press.
                  locked={jobRunning}
                  // Computed HERE, once per render, because the answer depends
                  // on every other track's solo state — a header cannot work it
                  // out from the track it is given.
                  audible={isTrackAudible(track, tracks)}
                  // Through the coordinator: selecting a track ends whatever
                  // the outgoing one had in flight and closes its open block
                  // before the selection moves. `selectTrack` itself stays the
                  // pointer-free seam the agent uses.
                  onSelect={() => activateTrack(lane.trackId, SELECT_TRACK)}
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
            // this is only scrolling. Where a VOICE lane is on screen the layer
            // above is full of controls and this is one extra tab stop ahead of
            // the first rack — harmless, and cheaper than a view-dependent tab
            // order, but it is the reason the sentence above is qualified.
            // Focus ORDER across the two layers is milestone 6.
            tabIndex={0}
            role="group"
            aria-label="Arrangement lanes"
            // `scrollbar-gutter: stable` closes a loop that milestone 2's fixed
            // 360 px voice lane did not have: a lane's height now comes from
            // its rack, the rack's height comes from how its pedalboard wraps,
            // that wrapping follows this scroller's client width, and the client
            // width follows whether the vertical scrollbar is showing — which
            // the stack height decides. Reserving the gutter takes the width out
            // of the cycle. The rounded-value guard in `measureRack` stops an
            // A→A subpixel loop; it cannot stop an A→B→A one.
            className="well h-full overflow-auto [scrollbar-gutter:stable]"
          >
            {/* ── The VOICE LAYER ─────────────────────────────────────────────
                A zero-height sheet the racks hang off, over the timed content.

                ⚠ IT MUST BE THE FIRST CHILD OF THE SCROLLER, and nothing about
                that is stylistic. It has no `top`, so its normal-flow origin is
                whatever the previous sibling leaves — as the first child that is
                content y = 0, the same origin `lane.top` is measured from. Moved
                below the song-sized div it starts at the BOTTOM of the stack and
                every rack is drawn one whole stack-height too low, which is the
                single most likely thing for a later edit to undo. `height: 0` is
                what keeps it out of the scroll height the song div owns.

                `position: sticky` with `left: 0` and NO `top`: it pins
                HORIZONTALLY, so a rack stays put while the timeline scrolls
                underneath it, and scrolls VERTICALLY with the lanes, because a
                rack belongs to a track and a track moves. Sticky is positioned,
                so it is also the containing block for the rows below — and its
                `width: 100%` resolves against the SCROLLER's content box, which
                is viewport-sized rather than song-sized. That is what makes a
                rack as wide as the window instead of as wide as 40 bars.

                `pointer-events: none` here, `auto` on each real row, so the
                transparent gaps between racks do not swallow presses meant for
                the pattern and edit lanes underneath.

                z-index is stated on BOTH layers. Source order stops being proof
                of occlusion the moment either one creates a stacking context. */}
            <div
              data-testid="arrangement-voice-layer"
              className="pointer-events-none sticky left-0 z-20 h-0 w-full"
            >
              {lanes.map((lane) => {
                if (viewOfTrack(lane.trackId) !== 'voice') return null;
                const track = laneTrack(lane)?.track;
                if (!track) return null;
                return (
                  <div
                    key={lane.trackId}
                    data-testid="arrangement-voice-lane"
                    // Its OWN attribute rather than `data-lane-track`: the
                    // spacer down in `.lanes` carries that one, and two elements
                    // answering to it would make every walk of the DOM pick
                    // whichever came first.
                    data-voice-lane-track={lane.trackId}
                    // The lane's own rect, so the rack sits exactly where the
                    // spacer below it does and the header beside it agrees.
                    style={{ top: lane.top, height: lane.height }}
                    // OPAQUE (`.tray`), and that is load-bearing rather than
                    // decorative: the timed content is drawn underneath at full
                    // song width, and a translucent rack would have bar lines
                    // running through its faceplates.
                    className="tray pointer-events-auto absolute left-0 w-full overflow-hidden"
                  >
                    {/* THE MEASURED BOX, and the ONLY reason this wrapper
                        exists. It is deliberately unstyled — no height, no
                        overflow — so it lays out at the rack's natural height
                        inside a row whose height we set, which is what makes it
                        safe to observe: the row follows the wrapper, never the
                        other way round.

                        It REPLACES an `h-full overflow-y-auto` viewport. The
                        lane is sized to the rack now, so there is nothing left
                        to scroll inside it and the arrangement scroller is the
                        page's only vertical scrollbar — three open racks used to
                        mean three nested ones, each clipped to 360 px.

                        `data-voice-rack` is how the observer's entries find
                        their track: a `ResizeObserver` callback gets elements,
                        not ids, and a per-element closure would rebuild the
                        observer on every render. */}
                    <div ref={measureRack} data-voice-rack={track.id}>
                      <TrackVoiceRack
                        track={track}
                        audible={isTrackAudible(track, tracks)}
                        collapsed={collapsedRacks.includes(track.id)}
                        // Rebuilt from the LIVE tracks rather than pushed onto
                        // the old list, which also prunes it: a removed track's
                        // id would otherwise sit in `App`'s state for the rest of
                        // the session, matching nothing.
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
                        // Same rule one level in: rebuilt from the live tracks,
                        // so a removed track's entry goes with it.
                        //
                        // An EMPTY list is stored, not dropped: absent means
                        // "nobody has folded this rack" and opens on the schema's
                        // default (Amp and Cabinet), while empty means "the user
                        // unfolded everything". Dropping the empty one would
                        // re-fold two stages the moment they opened the last of
                        // them.
                        onCollapsedSectionsChange={(next) => {
                          const rebuilt: Record<string, readonly SectionId[]> = {};
                          for (const candidate of tracks) {
                            const folded =
                              candidate.id === track.id
                                ? next
                                : collapsedRackSections[candidate.id];
                            if (folded !== undefined) rebuilt[candidate.id] = folded;
                          }
                          onCollapsedRackSectionsChange?.(rebuilt);
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* The song-sized content. `z-0` rather than nothing, for the
                stacking reason above — and WIDTH follows the time axis: with
                every lane a voice lane there is no axis to scroll along, so the
                content is the width of the window and the browser has nothing to
                overflow. The HEIGHT is the whole stack in every view, which is
                what keeps `scrollTop` meaningful and the voice layer's origin
                real. */}
            <div
              data-testid="arrangement-lanes-content"
              className="relative z-0"
              style={{ width: timed ? width : '100%', height }}
            >
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
                  what guarantees the two layers agree.

                  ONE LAYER PER TIMED BAND rather than one across the whole
                  stack. A bar line swept over a voice lane would run through a
                  rack's faceplates and point at nothing — the rack's opaque
                  background hides it, but a background is not a reason to draw
                  something untrue, and stacking order should be the second line
                  of defence rather than the only one. With every lane timed
                  `timedBands` returns exactly one band spanning the stack, so
                  this is the same element count and the same DOM it has always
                  been. */}
              {bands.map((band) => (
                <div
                  key={band.top}
                  aria-hidden
                  className="pointer-events-none absolute right-0 left-0"
                  style={{ top: band.top, height: band.height }}
                >
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
              ))}

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
                // ⚠ ONE CONTAINER, A MIXED STACK UNDER IT. This is attached
                // whenever SOME lane is a Pattern lane — the same question
                // `pointerEnabled` asks — and the per-lane half is the hit test:
                // `onLanesPointerDown` filters `geo.lanes` through
                // `isPatternLane`, so a press over an Edit or Voice row lands in
                // a gap, answers null and returns BEFORE it takes focus or
                // suppresses the default. That ordering is what lets the note
                // surface underneath own a press this declines (§4), and it is
                // why the handler can sit over rows it does not own at all.
                //
                // A voice lane's rack is in the layer ABOVE this one and takes
                // its own presses; what is left down here for it is an empty
                // spacer.
                onPointerDown={anyPatternLane ? gestures.onLanesPointerDown : undefined}
                onPointerMove={anyPatternLane ? gestures.onLanesPointerMove : undefined}
                className="lanes absolute inset-0"
              >
                {lanes.map((lane) => {
                  const track = laneTrack(lane)?.track;
                  if (!track) return null;
                  const instrumentId = trackInstrumentId(track);
                  const view = viewOfTrack(lane.trackId);
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
                      //
                      // `voice-lane` turns the same two off for the same reason
                      // one level out: this row is a SPACER under an opaque rack,
                      // and a recessed timeline channel drawn behind a faceplate
                      // is two conflicting statements about which surface is on
                      // top. The divider is kept here too.
                      // The crosshair is PER LANE now, not on the container:
                      // it advertises a lane you can place into, and over an
                      // Edit or Voice row — whose press the arrangement declines
                      // — it would be a promise the surface underneath does not
                      // keep.
                      className={`relative ${
                        view === 'edit'
                          ? 'edit-lane'
                          : view === 'voice'
                            ? 'voice-lane'
                            : 'cursor-crosshair'
                      }`}
                    >
                      {/* What a lane draws is the ONLY thing that changes between
                          the views — the headers, the ruler and the scroll
                          position do not (CP-01). Pattern draws one block per
                          placement, edit that placement's notes on the same ruler
                          at the same zoom, and voice draws NOTHING: its rack is
                          in the layer above, and what is left down here is a
                          spacer carrying the lane's height so the stack's
                          arithmetic, the dividers and the zebra's `:nth-child`
                          counting all stay whole. */}
                      {view === 'voice'
                        ? null
                        : view === 'edit'
                        ? editableSpans(
                            track,
                            pxPerBeat,
                            lane.height,
                            laneStringCount(instrumentId),
                          ).map((span) => {
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
                                // OWNERSHIP, not the raw store pointer: a block
                                // the agent holds, or one on a track that is not
                                // the selected one, is drawn but is not live.
                                focused={uiEditingPlacementId === placement.id}
                                sounding={playingPlacementIds.includes(placement.id)}
                                onFocus={() => focusPlacement(track.id, placement.id)}
                                drifted={placementDrifted(
                                  placement,
                                  libraryById.get(placement.patternSnapshot.id),
                                )}
                                pxPerBeat={pxPerBeat}
                                stringCount={laneStringCount(instrumentId)}
                                instrumentId={instrumentId}
                                grid={noteGrid}
                                edgeScroll={noteEdgeScroll}
                                geometry={surfaceGeometry}
                                registerDeactivate={registerSurfaceDeactivate}
                              />
                            );
                          })
                        : track.placements.map((placement) => (
                            <PlacementBlock
                              key={placement.id}
                              placement={placement}
                              pxPerBeat={pxPerBeat}
                              laneHeight={lane.height}
                              // The EFFECTIVE selection AND the toolbar's own
                              // gate, so what is drawn as selected is exactly
                              // what the toolbar counts and what a command would
                              // touch — the same `hasSelection` the actions row
                              // is rendered on.
                              //
                              // ⚠ THE GATE IS NOT REDUNDANT, and milestone 4 is
                              // why. `effectiveSelection` filters to PATTERN
                              // LANES, which a mixed stack still has plenty of
                              // while the SELECTED track sits in Voice or Edit —
                              // and the plan's context table gives neither of
                              // those rows any placement-selection command. So
                              // without this the blocks on some other track kept
                              // their selected ring while every action on them,
                              // toolbar and keyboard alike, was gone with no
                              // explanation. The selection itself is untouched:
                              // it is the store's, and re-selecting a Pattern
                              // track draws it again.
                              selected={hasSelection && uiSelection.includes(placement.id)}
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
                  hidden under a drop indicator.

                  ONE SEGMENT PER TIMED BAND, for the reason the grid lines are
                  banded: playback still runs while a rack is on screen, but a
                  line sweeping across its knobs points at nothing. An all-voice
                  stack has no bands and so draws no head at all, which is what
                  voice mode did before it was a lane. */}
              {bands.map((band) => (
                <ArrangementPlayhead key={band.top} pxPerBeat={pxPerBeat} band={band} />
              ))}
            </div>
          </div>

          {/* Nothing like it with every lane in voice: an empty arrangement
              still has tracks, and every one of them has a voice to tune — so
              "nothing placed yet" would be printed over a screen doing its whole
              job. Gated on `timed` rather than on a view, so it is the presence
              of a time axis that decides. */}
          {timed && nothingPlaced && (
            <p className="pointer-events-none absolute top-2 left-3 font-mono text-[9px] tracking-[0.12em] text-ink-mut uppercase">
              {/* The library is the rail of a PATTERN track, so with no
                  Pattern lane in the stack "drag a pattern in from the rail"
                  names a thing that isn't there — and notes are only editable
                  inside a block, so there is nothing to edit either. Asked of
                  the lanes rather than of a selection: it is about where a
                  pattern could be dropped, and a drop does not need a
                  selection.
                  An EMPTY stack has no lane to ask and takes the composition's
                  own default view, exactly as `timed` does — the track it does
                  not have yet will arrive on Pattern. */}
              {tracks.length === 0 || anyPatternLane
                ? 'Nothing placed yet — drag a pattern in from the rail'
                : 'Nothing to edit yet — put a track in Pattern view and place one first'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
