import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TIME_SIGNATURES, getInstrument, ticksPerBar } from '@fretwork/lib';
import { NoteSurface, type SurfaceGeometry } from './NoteSurface';
import {
  play,
  setClickSubdivision,
  setClickTimeSignature,
  setTempo,
  stop,
  toggleClick,
  useClickMuted,
  useHeadTick,
  useIsPlaying,
  usePlaybackEngine,
  useTempo,
} from '../audio/playbackService';
import {
  patternInstrumentId,
  redo,
  setPatternBpm,
  setPatternLoop,
  setPatternSubdivision,
  setPatternTimeSignature,
  SUBDIVISION_OPTIONS,
  type SubdivisionId,
  undo,
  useEditingPattern,
  useHistoryState,
} from '../patterns/patternService';
import { stringLabels } from '../reference/tabLayout';

/** How each subdivision reads in a control this small. The ids are the lib's
 *  and are not all self-explanatory. Same labels as the arrangement's. */
const SUBDIVISION_LABEL: Record<SubdivisionId, string> = {
  off: 'off',
  '8ths': '8ths',
  triplets: 'trips',
  '16ths': '16ths',
  sextuplets: 'sext',
};
import { useTimelineAutoScroll } from './useTimelineAutoScroll';
import { useEdgeAutoScroll } from './useEdgeAutoScroll';
import {
  barBeatLines,
  laneMetrics,
  rowOrder,
  snapOptions,
  tickToPx,
  DEFAULT_SNAP_ID,
  DEFAULT_ZOOM_INDEX,
  ZOOM_LEVELS,
} from './timelineMath';

const RULER_H = 20;

/**
 * How many rows to draw with no instrument the catalog recognises. Also the type
 * guard for `getInstrument` — `patternInstrumentId` only ever returns a catalog
 * id, so that lookup can't actually miss.
 */
const DEFAULT_STRING_COUNT = 6;

/**
 * The pattern editor's timeline chrome: the toolbar, the bar/beat ruler, the
 * string-label gutter, the scrolling well and the playhead.
 *
 * The notes themselves are `NoteSurface`'s, which owns every edit gesture and
 * nothing else — no scroll container, no zoom, no ruler. That split is what lets
 * the same surface be dropped into an arrangement lane (CP-11), driven by the
 * arrangement's scroll and zoom instead of this one's.
 */
export function Timeline() {
  usePlaybackEngine();
  const pattern = useEditingPattern();
  const { canUndo, canRedo } = useHistoryState();
  const isPlaying = useIsPlaying();
  const headTick = useHeadTick();
  const clickMuted = useClickMuted();
  const tempo = useTempo();
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  const [snapId, setSnapId] = useState(DEFAULT_SNAP_ID);
  const pxPerBeat = ZOOM_LEVELS[zoomIndex];
  const areaRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [areaHeight, setAreaHeight] = useState(240);

  // The lib treats `suggestedBpm` as the author's intent and expects the editor
  // to load it into the metronome; without this the transport keeps whatever
  // tempo the last pattern left behind.
  const suggestedBpm = pattern?.suggestedBpm ?? null;
  useEffect(() => {
    if (suggestedBpm !== null) setTempo(suggestedBpm);
  }, [suggestedBpm]);

  // Drives the view while a drag is held near the well's edge, so a note can be
  // taken somewhere that wasn't on screen when the drag started. It belongs to
  // the chrome because the scroller does: the surface has no scroll container,
  // so it cannot own scroll-driven behaviour — it is handed this instead.
  const edgeScroll = useEdgeAutoScroll(scrollerRef);

  // The one thing the surface's gestures need to know about this chrome: where
  // the well's window onto them is, so a rubber-band can be clipped to it.
  // Behind a function for `useArrangementGestures`'s reason — a box read at
  // render time is stale by the first pointer move, and under jsdom it is 0×0
  // unless a test hands one over.
  //
  // Memoised rather than built per render: this component re-renders on every
  // `headTick` during playback, and the surface would otherwise be handed a new
  // object 60 times a second for a value that never changes.
  const geometry = useMemo<SurfaceGeometry>(
    () => ({ viewportRect: () => scrollerRef.current?.getBoundingClientRect() ?? null }),
    [],
  );

  // Keeps the playhead on screen. Runs its own transport-reading loop rather
  // than reacting to head state — see the hook for why.
  //
  // Suspended for the length of a drag: both this and the edge scroll write
  // `scrollLeft`, and with playback running they would trade the view back and
  // forth every few frames — the note landing wherever the tug-of-war left it.
  // The hand on the pointer wins, for the whole gesture rather than only at the
  // edges: having the view yank itself away mid-drag is the same bug in a less
  // obvious place. Playback keeps sounding throughout, and the follow resumes
  // (and catches up, jumping if the head has run off) on pointerup.
  useTimelineAutoScroll(
    scrollerRef,
    pxPerBeat,
    isPlaying && !edgeScroll.engaged,
    pattern?.durationTicks ?? 0,
    true,
  );

  // Rows follow the pane height, which the user can drag — measure, don't assume.
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setAreaHeight(entry.contentRect.height));
    observer.observe(el);
    setAreaHeight(el.getBoundingClientRect().height);
    return () => observer.disconnect();
  }, []);

  if (!pattern) return null;

  const ts = pattern.timeSignature;
  const bars = Math.max(1, Math.ceil(pattern.durationTicks / ticksPerBar(ts)));
  const width = tickToPx(bars * ticksPerBar(ts), pxPerBeat);
  const lines = barBeatLines(bars, ts, pxPerBeat);
  /** The document first, the click second — and the click only if the document
   *  agreed. `setPatternTimeSignature` refuses a meter outside the lib's
   *  catalog, and a click in a meter the pattern does not have is the worse of
   *  the two failures. */
  const chooseTimeSignature = (id: string) => {
    const option = TIME_SIGNATURES.find((candidate) => candidate.id === id);
    if (!option) return;
    const saved = setPatternTimeSignature({
      numerator: option.numerator,
      denominator: option.denominator,
    });
    if (saved.ok) setClickTimeSignature(id);
  };

  const chooseSubdivision = (subdivision: SubdivisionId) => {
    if (setPatternSubdivision(subdivision).ok) setClickSubdivision(subdivision);
  };

  const grid = snapOptions(ts).find((o) => o.id === snapId) ?? snapOptions(ts)[3];

  // The neck this pattern is written on decides how many rows there are and what
  // they are called — the same question `TablatureView` asks of the same
  // pattern, answered the same way rather than with a hardcoded six.
  const instrumentId = patternInstrumentId(pattern);
  const stringCount = getInstrument(instrumentId)?.stringCount ?? DEFAULT_STRING_COUNT;
  const labels = stringLabels(instrumentId, stringCount);

  // The ruler is the chrome's, so its height comes off before the rows divide
  // what is left. The gutter and the surface therefore size their rows from the
  // same number through the same function, rather than from two calculations
  // free to drift apart.
  const laneAreaHeight = areaHeight - RULER_H;
  const { rowHeight } = laneMetrics(laneAreaHeight, stringCount);

  // A note on a string this instrument hasn't got has no lane to be drawn in, so
  // it can't be clicked, banded or deleted — while still counting in "N notes"
  // and still sounding. Reachable because `setPatternInstrument` swaps the id and
  // prunes nothing: take a six-string riff to bass and its top two strings go
  // quietly missing from the editor. Said out loud in `TrackHeader`'s words for
  // the same fact, since a silently hidden note is worse than an ugly toolbar.
  const offInstrument = pattern.events.filter((e) => e.stringIndex >= stringCount).length;

  /**
   * Tempo lives in two places on purpose: the metronome drives playback now, and
   * the pattern remembers the choice for next time. Writing only the metronome
   * would lose the tempo on reload; only the pattern wouldn't change what you hear.
   */
  const changeTempo = (delta: number) => {
    const next = Math.max(20, Math.min(300, tempo + delta));
    setTempo(next);
    setPatternBpm(next);
  };

  return (
    <div className="flex flex-col">
      <div className="mb-1.5 flex flex-none items-center gap-1.5">
        <span className="font-mono text-[9px] font-semibold tracking-[0.16em] text-ink-mut uppercase">
          Zoom
        </span>
        <button
          type="button"
          aria-label="Zoom out"
          disabled={zoomIndex === 0}
          onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
          className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold disabled:opacity-40"
        >
          –
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          disabled={zoomIndex === ZOOM_LEVELS.length - 1}
          onClick={() => setZoomIndex((i) => Math.min(ZOOM_LEVELS.length - 1, i + 1))}
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
        <button
          type="button"
          aria-label={isPlaying ? 'Stop' : 'Play'}
          // `play` needs the click itself as the user gesture that unblocks the
          // AudioContext, so it is called here rather than from an effect.
          onClick={() => {
            if (isPlaying) stop();
            else void play();
          }}
          className={`pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold ${
            isPlaying ? 'control-accent' : ''
          }`}
        >
          {isPlaying ? '■' : '▶'}
        </button>
        <button
          type="button"
          aria-label={pattern.loop ? 'Turn looping off' : 'Turn looping on'}
          aria-pressed={pattern.loop}
          onClick={() => setPatternLoop(!pattern.loop)}
          className={`pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold ${
            pattern.loop ? 'control-accent' : ''
          }`}
        >
          ⟲ loop
        </button>
        <span className="mx-1 h-4 w-px bg-line" />
        <label className="flex items-center gap-1.5">
          <span className="font-mono text-[9px] tracking-[0.12em] text-ink-mut uppercase">
            Grid
          </span>
          <select
            aria-label="Grid resolution"
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
        <span className="mx-1 h-4 w-px bg-line" />
        {/* The PATTERN's meter and click subdivision — the composition page has
            the same pair for the arrangement, and overrides these while a block
            is played from there. Two writes each: the document, so it persists
            and the bars redraw, and the metronome, so it is audible now rather
            than at the next press of Play. */}
        <select
          aria-label="Time signature"
          value={`${ts.numerator}/${ts.denominator}`}
          onChange={(e) => chooseTimeSignature(e.target.value)}
          className="control rounded-lg px-1.5 py-1 font-mono text-[9px] font-bold text-ink"
        >
          {TIME_SIGNATURES.map((option) => (
            <option key={option.id} value={option.id}>
              {option.id}
            </option>
          ))}
        </select>
        <select
          aria-label="Click subdivision"
          value={pattern.subdivision ?? 'off'}
          onChange={(e) => chooseSubdivision(e.target.value as SubdivisionId)}
          className="control rounded-lg px-1.5 py-1 font-mono text-[9px] font-bold text-ink"
        >
          {SUBDIVISION_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {SUBDIVISION_LABEL[option]}
            </option>
          ))}
        </select>
        <span className="mx-1 h-4 w-px bg-line" />
        <span className="font-mono text-[9px] tracking-[0.12em] text-ink-mut uppercase">bpm</span>
        <button
          type="button"
          aria-label="Decrease tempo"
          onClick={() => changeTempo(-1)}
          className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold"
        >
          –
        </button>
        <span className="min-w-7 text-center font-mono text-[11px] font-bold text-ink-hi">
          {tempo}
        </span>
        <button
          type="button"
          aria-label="Increase tempo"
          onClick={() => changeTempo(1)}
          className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold"
        >
          +
        </button>
        <span className="mx-1 h-4 w-px bg-line" />
        <button
          type="button"
          aria-label={clickMuted ? 'Unmute metronome click' : 'Mute metronome click'}
          aria-pressed={!clickMuted}
          title="The click is separate from the notes — muting it doesn't affect playback"
          onClick={toggleClick}
          className={`pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold ${
            clickMuted ? 'opacity-50' : 'control-accent'
          }`}
        >
          {clickMuted ? '🔇' : '🔊'} click
        </button>
        <span className="flex-1" />
        {offInstrument > 0 && (
          <span
            title={`${offInstrument} ${offInstrument === 1 ? 'note sits' : 'notes sit'} on strings this pattern's instrument hasn't got, so the editor cannot show them`}
            className="font-mono text-[7.5px] tracking-[0.12em] text-ink-mut uppercase"
          >
            ⚠ {offInstrument} off-instrument
          </span>
        )}
        <span className="font-mono text-[11px] font-bold text-ink-hi">
          {bars} {bars === 1 ? 'bar' : 'bars'} · {pattern.events.length} notes
        </span>
      </div>

      {/* Height is ruler + one row per string, all explicit — so the grid needs no
          share of a supplied height. Only the horizontal axis scrolls, for time. */}
      <div ref={areaRef} className="grid grid-cols-[24px_1fr]">
        <div className="flex flex-col" style={{ paddingTop: RULER_H }}>
          {rowOrder(stringCount).map((stringIndex) => (
            <span
              key={stringIndex}
              style={{ height: rowHeight }}
              className="flex items-center justify-end pr-1.5 font-mono text-[9px] font-bold text-ink-mut"
            >
              {labels[stringIndex]}
            </span>
          ))}
        </div>

        {/* `data-testid` is a test seam: the scroller has no role or name, and
            handing it a real geometry is the only way jsdom can exercise the
            edge auto-scroll at all. */}
        <div
          ref={scrollerRef}
          data-testid="well"
          className="well overflow-x-auto overflow-y-hidden"
        >
          <div className="relative" style={{ width }}>
            <div className="relative" style={{ height: RULER_H }}>
              {lines.map((line) => (
                <span key={`${line.bar}.${line.beat}`}>
                  <i
                    aria-hidden
                    className={`absolute top-0 bottom-0 w-px ${line.isBar ? 'bg-beat-line' : 'bg-well-line'}`}
                    style={{ left: line.x }}
                  />
                  <span
                    className="absolute top-1 pl-1 font-mono text-[8.5px] font-bold text-ink-mut"
                    style={{ left: line.x }}
                  >
                    {line.isBar ? <b className="text-ink-hi">{line.bar}</b> : line.beat}
                  </span>
                </span>
              ))}
            </div>

            {/* No width of its own: the surface fills this content box, which is
                what lets every pointer position be measured against the lanes
                rather than against a scroll offset nobody passes it. */}
            <NoteSurface
              // The one pattern this page has, handed over rather than read
              // from the store by the surface: it is the same object either way
              // here, and it is what lets edit mode mount one surface per
              // placement without every one of them drawing the same notes.
              pattern={pattern}
              // The PATTERN's own meter here — on this page the pattern IS the
              // document. The composition page passes the arrangement's instead,
              // which is the override CP-18 introduced.
              timeSignature={ts}
              // Always. There is one surface on this page and it is never
              // mounted beside the composition page's — `App` swaps the whole
              // page — so the edit target is always this pattern.
              focused
              pxPerBeat={pxPerBeat}
              laneAreaHeight={laneAreaHeight}
              stringCount={stringCount}
              instrumentId={instrumentId}
              grid={grid}
              edgeScroll={edgeScroll}
              geometry={geometry}
            />

            {/* Sits in the scrolled content, not the viewport, so it tracks the
                lanes when the well is scrolled. Transparent to the pointer, or
                it would swallow clicks on the notes it crosses. */}
            {headTick !== null && (
              <div
                data-testid="playhead"
                aria-hidden
                style={{ left: tickToPx(headTick, pxPerBeat), top: RULER_H }}
                className="pointer-events-none absolute bottom-0 z-10 w-0.5 bg-brass-hi shadow-glow-brass"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
