import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  ARRANGEMENT_ZOOM_LEVELS,
  DEFAULT_ARRANGEMENT_ZOOM_INDEX,
  RULER_HEIGHT,
  TRACK_HEADER_WIDTH,
  arrangementBars,
  arrangementWidth,
  laneRects,
  lanesHeight,
  rulerMarks,
  zoomAnchoredScrollLeft,
  type ArrangementMode,
} from './arrangementMath';
import {
  selectTrack,
  useEditingComposition,
  useSelectedPlacementIds,
  useSelectedTrackId,
  useTracks,
} from './compositionService';
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
 * READ-ONLY in this ticket. Selecting a track is the only wired gesture;
 * everything a block can do is CP-06's, the rail is CP-05's, the playhead is
 * CP-08's.
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
export function ArrangementGrid({ mode }: { mode: ArrangementMode }) {
  const composition = useEditingComposition();
  const tracks = useTracks();
  const selectedTrackId = useSelectedTrackId();
  const selectedPlacementIds = useSelectedPlacementIds();
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ARRANGEMENT_ZOOM_INDEX);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const rulerContentRef = useRef<HTMLDivElement>(null);
  const headerStackRef = useRef<HTMLDivElement>(null);
  /** Set only by `zoomTo`, consumed once by the layout effect below. Non-null
   *  means "the COMPONENT wants the view moved" — the effect never imposes a
   *  position the user's own scrolling produced. */
  const pendingScrollLeftRef = useRef<number | null>(null);

  const pxPerBeat = ARRANGEMENT_ZOOM_LEVELS[zoomIndex];

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
  // Emptiness is "no blocks", not "no duration": a snapshot that measures zero
  // still put a block on screen, and a hint printed over one is a lie.
  const nothingPlaced = tracks.every((track) => track.placements.length === 0);

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
        <span className="flex-1" />
        <span className="font-mono text-[11px] font-bold text-ink-hi">
          {tracks.length} {tracks.length === 1 ? 'track' : 'tracks'} · {bars}{' '}
          {bars === 1 ? 'bar' : 'bars'}
        </span>
      </div>

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
                  height={lane.height}
                  selected={selectedTrackId === lane.trackId}
                  onSelect={() => selectTrack(lane.trackId)}
                />
              );
            })}
            {/* TODO(CP-07): add / remove / reorder track controls belong under
                the stack, where they scroll with it. */}
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
            // pointer: nothing inside is focusable in this ticket (blocks are
            // deliberately inert), so without this a keyboard user cannot scroll
            // the arrangement at all. Not an edit gesture — CP-06 still owns
            // every key that changes something.
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
                  into a plain box. */}
              <div className="lanes absolute inset-0">
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
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {nothingPlaced && (
            <p className="pointer-events-none absolute top-2 left-3 font-mono text-[9px] tracking-[0.12em] text-ink-mut uppercase">
              {/* TODO(CP-05): the rail this points at. */}
              Nothing placed yet — patterns arrive from the rail
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
