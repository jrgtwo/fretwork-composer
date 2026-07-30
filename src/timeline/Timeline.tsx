import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PPQ, snapTick, ticksPerBar, type PatternEvent } from '@fretwork/lib';
import { readNotePitch } from '../patterns/articulations';
import { NotePopup } from './NotePopup';
import {
  play,
  stop,
  useActiveEventIds,
  useClickMuted,
  useHeadTick,
  useTempo,
  setTempo,
  useIsPlaying,
  usePlaybackEngine,
  toggleClick,
} from '../audio/playbackService';
import {
  beginEditGesture,
  deleteNotes,
  endEditGesture,
  getEditingPattern,
  nudgeSelectedFret,
  redo,
  selectNotes,
  moveNotesBy,
  resizeNotesBy,
  setPatternBpm,
  setPatternLoop,
  setSelectedFret,
  snapshotForDrag,
  snapshotForResize,
  stampNote,
  undo,
  useEditingPattern,
  useHistoryState,
  useSelectedIds,
} from '../patterns/patternService';
import { useTimelineAutoScroll } from './useTimelineAutoScroll';
import { useEdgeAutoScroll } from './useEdgeAutoScroll';
import {
  barBeatLines,
  laneMetrics,
  pxToTick,
  snapOptions,
  tickToPx,
  DEFAULT_SNAP_ID,
  DEFAULT_ZOOM_INDEX,
  FREE_NOTE_TICKS,
  ZOOM_LEVELS,
} from './timelineMath';

/**
 * Indexed by `PatternEvent.stringIndex`, which the lib defines low-to-high: its
 * `standard` tuning is `['E2','A2','D3','G3','B3','E4']` and the scheduler reads
 * `openStrings[stringIndex]`. Getting this backwards plays every note on the
 * wrong string, so the array order here is not cosmetic.
 */
const STRING_LABELS = ['E', 'A', 'D', 'G', 'B', 'e'];
const OPEN_MIDI = [40, 45, 50, 55, 59, 64];

/** Tab puts the highest string on top, so rows run in reverse index order. */
const ROW_ORDER = [...STRING_LABELS.keys()].reverse();
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const RULER_H = 20;
const DRAG_THRESHOLD = 3;

/**
 * How long a typed fret stays open to a second digit.
 *
 * Long enough that "1" then "2" is comfortably 12 for anyone not touch-typing,
 * short enough that a deliberate second number doesn't land on the first one —
 * roughly the gap DAWs use for the same "type a number at a thing" idiom.
 * Anything under ~500ms punishes hesitation; much over a second and consecutive
 * single-digit frets feel stuck together.
 */
const FRET_TYPING_MS = 800;

const pitchName = (stringIndex: number, fret: number) =>
  NOTE_NAMES[(OPEN_MIDI[stringIndex] + fret) % 12];

/**
 * Marks drawn on a note, positioned where the articulation actually happens:
 * slides-in hang off the left edge, slides-out off the right, bends sit above,
 * and technique flags tuck under. Reading it should mirror playing it.
 */
function NoteMarks({ event }: { event: PatternEvent }) {
  const pitch = readNotePitch(event);
  const flags = [
    event.hammerOn && 'H',
    event.pullOff && 'P',
    event.tap && 'T',
    event.palmMute && 'PM',
    event.ghost && '( )',
    event.tieToNext && '⌒',
  ].filter(Boolean) as string[];

  return (
    <>
      {pitch.slideIn && (
        <span
          title={`Slide in from ${pitch.slideIn}`}
          className="absolute top-1/2 -left-2.5 -translate-y-1/2 font-mono text-[10px] leading-none text-brass-hi"
        >
          {pitch.slideIn === 'below' ? '╱' : '╲'}
        </span>
      )}
      {pitch.slideOut && (
        <span
          title={`Slide out ${pitch.slideOut}`}
          className="absolute top-1/2 -right-2.5 -translate-y-1/2 font-mono text-[10px] leading-none text-brass-hi"
        >
          {pitch.slideOut === 'up' ? '╱' : '╲'}
        </span>
      )}
      {pitch.bend && (
        <span
          title={`Bend ${pitch.bend.semitones} semitones`}
          className="absolute -top-2 left-1/2 -translate-x-1/2 font-mono text-[8px] leading-none whitespace-nowrap text-brass-hi"
        >
          {pitch.bend.kind === 'bend-release' ? '⤴⤵' : pitch.bend.kind === 'pre-bend' ? '•⤴' : '⤴'}
        </span>
      )}
      {event.vibrato && (
        <span
          title={`${event.vibrato} vibrato`}
          className="absolute -top-1.5 right-0.5 font-mono text-[8px] leading-none text-brass-hi"
        >
          {event.vibrato === 'wide' ? '≈' : '~'}
        </span>
      )}
      {/* Loudness as a fill along the note's foot: readable in passing, and it
          costs no space a fret number or a flag was using. A note with no
          velocity draws nothing at all, so untouched notes are unchanged. */}
      {event.velocity !== undefined && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-[3px] bottom-[2px] h-[2px] overflow-hidden rounded-full bg-ink-mut/25"
        >
          {/* `data-velocity` is a test seam, not app state: the bar is aria-hidden
              and decorative, so jsdom has no other handle on it. Clamped because a
              negative width is invalid CSS and gets dropped — which would draw a
              full-looking bar for the quietest possible note. */}
          <i
            data-velocity={event.velocity}
            className="block h-full rounded-full bg-brass-hi"
            style={{ width: `${Math.round(Math.min(1, Math.max(0, event.velocity)) * 100)}%` }}
          />
        </span>
      )}
      {flags.length > 0 && (
        <span className="absolute -bottom-1.5 left-0.5 font-mono text-[7px] leading-none text-ink-mut">
          {flags.join(' ')}
        </span>
      )}
    </>
  );
}

type DragMode = 'move' | 'resize';

/**
 * Places its child next to `rect`, preferring below and flipping above when
 * there isn't room. Measures the child after mount rather than assuming a size,
 * since the popup's height changes as sub-controls appear.
 */
function AnchoredTo({ rect, children }: { rect: DOMRect; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const gap = 8;
    const left = Math.min(
      window.innerWidth - width - gap,
      Math.max(gap, rect.left + rect.width / 2 - width / 2),
    );
    const below = rect.bottom + gap;
    const top = below + height > window.innerHeight - gap
      ? Math.max(gap, rect.top - height - gap)
      : below;
    setPos({ left, top });
  }, [rect]);

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left: pos?.left ?? rect.left,
        top: pos?.top ?? rect.bottom + 8,
        // Avoid a flash at the wrong spot before the first measurement.
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>
  );
}

/**
 * The pattern editor's timeline: string lanes, a bar/beat ruler, and the events
 * laid out in time. Every edit goes through the pattern service, so the lib's
 * invariants (no same-string overlap, clamped durations, auto-fitted length)
 * hold without this component knowing about them.
 */
export function Timeline() {
  usePlaybackEngine();
  const pattern = useEditingPattern();
  const selectedIds = useSelectedIds();
  const { canUndo, canRedo } = useHistoryState();
  const isPlaying = useIsPlaying();
  const headTick = useHeadTick();
  const clickMuted = useClickMuted();
  const tempo = useTempo();
  const activeIds = useActiveEventIds();
  // Anchored to the note's on-screen box, captured when the popup is opened.
  const [popupFor, setPopupFor] = useState<{ id: string; anchor: DOMRect } | null>(null);
  // Viewport coordinates — the band is drawn fixed, over everything.
  const [marquee, setMarquee] = useState<{
    left: number;
    right: number;
    top: number;
    bottom: number;
  } | null>(null);
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  const [snapId, setSnapId] = useState(DEFAULT_SNAP_ID);
  const pxPerBeat = ZOOM_LEVELS[zoomIndex];
  const areaRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  /** Tears down whichever pointer gesture is in flight. Null when none is. */
  const abortGesture = useRef<(() => void) | null>(null);
  /** Digits typed so far for a fret, the timer that will commit them, and
   *  whether any of them actually moved a note. Null when nothing is typed. */
  const fretRun = useRef<{ digits: string; timer: number; changed: boolean } | null>(null);
  /** True while an arrow key's auto-repeat is being folded into the undo step
   *  its first press already recorded. */
  const nudgeRun = useRef(false);
  const [areaHeight, setAreaHeight] = useState(240);

  // The lib treats `suggestedBpm` as the author's intent and expects the editor
  // to load it into the metronome; without this the transport keeps whatever
  // tempo the last pattern left behind.
  const suggestedBpm = pattern?.suggestedBpm ?? null;
  useEffect(() => {
    if (suggestedBpm !== null) setTempo(suggestedBpm);
  }, [suggestedBpm]);

  // Drives the view while a drag is held near the well's edge, so a note can be
  // taken somewhere that wasn't on screen when the drag started.
  const edgeScroll = useEdgeAutoScroll(scrollerRef);

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

  // Editing shortcuts — one listener for all of them, so nothing has to race a
  // second handler for the same key. All ignored while typing into a field: a
  // `select` counts, since arrows are how you change one.
  useEffect(() => {
    /** End the number being typed: the next digit starts a fresh one, and the
     *  undo gesture holding the whole number closes. */
    const commitFretRun = () => {
      const run = fretRun.current;
      if (!run) return;
      clearTimeout(run.timer);
      fretRun.current = null;
      // Retyping the fret a note is already on is not an edit.
      endEditGesture(run.changed);
    };

    /**
     * Close the gesture that swallows a held arrow's repeats. Its snapshot is
     * discarded rather than pushed: the key's *first* press already recorded the
     * pre-nudge state, so the whole held run undoes as that one step.
     */
    const endNudgeRun = () => {
      if (!nudgeRun.current) return;
      nudgeRun.current = false;
      endEditGesture(false);
    };

    /**
     * Any pointer edit landing mid-run would otherwise begin a gesture inside
     * the keyboard one, and `history` keeps only a single snapshot — so one of
     * the two edits would vanish from the undo stack entirely. Capture phase, so
     * this runs before the note's own pointerdown handler.
     */
    const endKeyRuns = () => {
      commitFretRun();
      endNudgeRun();
    };

    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable]')) {
        // The keystroke isn't ours, but it still ends a run — otherwise tabbing
        // into a field mid-number leaves the gesture open, and every edit made
        // through that field goes unrecorded.
        endKeyRuns();
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      // Auto-repeat is excluded: holding "1" would otherwise cycle 1 → 11 → 1.
      const isDigit =
        !mod && !e.altKey && !e.repeat && e.key.length === 1 && e.key >= '0' && e.key <= '9';
      // Any other key ends a number in progress, so a fret can't accumulate
      // across an unrelated edit. Repeating a key is the only thing that
      // continues a run rather than ending one.
      if (!isDigit) commitFretRun();
      if (!e.repeat) endNudgeRun();

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }

      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (selectedIds.length === 0) return;
        e.preventDefault();
        deleteNotes(selectedIds);
        return;
      }

      // Everything below edits the selection, so there has to be one.
      if (selectedIds.length === 0) return;

      if (isDigit) {
        e.preventDefault();
        const run = fretRun.current;
        // The whole typed number is one undo step, however many digits it took.
        if (!run) beginEditGesture();
        else clearTimeout(run.timer);
        const digits = (run?.digits ?? '') + e.key;
        const before = getEditingPattern();
        // Out-of-range numbers clamp rather than being rejected, so "9" then "9"
        // lands on the top fret instead of silently doing nothing. The trade is
        // that "3" then "0" is fret 24, not fret 3 followed by fret 0 — waiting
        // out the window is how you type two single-digit frets in a row.
        setSelectedFret(Number(digits));
        // The lib returns the pattern untouched when an op changes nothing, so
        // identity is enough to tell a real edit from a retyped fret.
        const changed = (run?.changed ?? false) || getEditingPattern() !== before;
        if (digits.length === 2) {
          // The top fret is two digits, so a second one completes the number —
          // commit now rather than making the user wait out the window.
          fretRun.current = null;
          endEditGesture(changed);
          return;
        }
        fretRun.current = {
          digits,
          changed,
          timer: window.setTimeout(commitFretRun, FRET_TYPING_MS),
        };
        return;
      }

      // Shift is ours (the octave modifier); Cmd/Ctrl/Alt+arrow belong to the OS
      // and the browser — scroll-to-top, history navigation — so they fall
      // through uncancelled.
      if (!mod && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        // Without this the well scrolls and focus walks off to the next control.
        e.preventDefault();
        // A held key repeats ~30 times a second. Bracketing the repeats keeps
        // the whole hold to the one undo step the first press pushed.
        if (e.repeat && !nudgeRun.current) {
          nudgeRun.current = true;
          beginEditGesture();
        }
        // Shift is an octave — 12 frets is the same pitch on the same string.
        nudgeSelectedFret((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1));
      }
    };
    // Releasing the key is the normal end of a repeat run; `endKeyRuns` covers
    // the cases where no keyup ever arrives.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') endNudgeRun();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('pointerdown', endKeyRuns, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointerdown', endKeyRuns, true);
    };
  }, [selectedIds]);

  // A pointer gesture parks its listeners on `window` so it keeps tracking once
  // the pointer leaves the lane — which also means nothing else would tear them
  // down if this unmounts mid-drag, leaving the undo stack stuck inside an
  // open gesture and every later edit unrecorded. A half-typed fret or a held
  // arrow leaves the same gesture open, so those close here too.
  useEffect(
    () => () => {
      abortGesture.current?.();
      if (nudgeRun.current) {
        nudgeRun.current = false;
        endEditGesture(false);
      }
      const run = fretRun.current;
      if (!run) return;
      clearTimeout(run.timer);
      fretRun.current = null;
      endEditGesture(run.changed);
    },
    [],
  );

  if (!pattern) return null;

  const ts = pattern.timeSignature;
  const bars = Math.max(1, Math.ceil(pattern.durationTicks / ticksPerBar(ts)));
  const width = tickToPx(bars * ticksPerBar(ts), pxPerBeat);
  const lines = barBeatLines(bars, ts, pxPerBeat);
  const { rowHeight, noteHeight, noteTop, isTall } = laneMetrics(
    areaHeight,
    STRING_LABELS.length,
    RULER_H,
  );
  const grid = snapOptions(ts).find((o) => o.id === snapId) ?? snapOptions(ts)[3];
  /** Quantise, unless the grid is off — then take the raw tick. */
  const snapToGrid = (tick: number) => (grid.ticks ? snapTick(tick, grid.ticks) : tick);
  /** A stamped note is one grid step long, so the grid sets the note length too. */
  const stampLength = grid.ticks ?? FREE_NOTE_TICKS;

  // Read fresh each render so the popup reflects edits made through it.
  const popupNote = popupFor ? pattern.events.find((e) => e.id === popupFor.id) : undefined;

  const carve = (w: number, dark: number, light: number) =>
    `repeating-linear-gradient(90deg,transparent 0 ${w - 2}px,` +
    `rgb(0 0 0/${dark}) ${w - 2}px ${w - 1}px,rgb(255 255 255/${light}) ${w - 1}px ${w}px)`;
  const gridImage = [
    // The finest grid line follows the snap setting, so the visual grid and the
    // positions notes can actually take always agree.
    carve(tickToPx(grid.ticks ?? PPQ / 4, pxPerBeat), 0.3, 0.022),
    carve(pxPerBeat, 0.5, 0.045),
    carve(tickToPx(ticksPerBar(ts), pxPerBeat), 0.72, 0.085),
  ].join(',');

  /** Pointer x → tick, measured against the lane's own box so scrolling is free. */
  const tickAt = (clientX: number) => {
    const rect = lanesRef.current?.getBoundingClientRect();
    return pxToTick(clientX - (rect?.left ?? 0), pxPerBeat);
  };

  const startDrag = (event: PatternEvent, mode: DragMode) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Shift is the selection modifier wherever a note can be grabbed — including
    // the resize edge, which overhangs the note and is easy to hit by accident.
    if (e.shiftKey) {
      selectNotes([event.id], 'toggle');
      return;
    }

    // Grabbing a note outside the selection replaces it; grabbing one inside
    // keeps the group, so a multi-selection can be dragged as a unit.
    const group = selectedIds.includes(event.id) ? selectedIds : [event.id];
    if (!selectedIds.includes(event.id)) selectNotes([event.id]);

    const startX = e.clientX;
    const startY = e.clientY;
    // Ticks between the pointer and the note's start, so it doesn't jump on grab.
    const grabOffset = tickAt(startX) - event.startTick;
    // Captured once: the lib clamps deltas against these, so repeated moves
    // don't compound into an accelerating drag.
    const dragFrom = snapshotForDrag(group);
    const resizeFrom = snapshotForResize(group);
    let moved = false;
    // One undo step for the whole drag, not one per pointermove.
    beginEditGesture();

    /**
     * The drag, re-derived from the last pointer position. Everything here
     * reads the pointer's place in *content* space via `tickAt`, never a delta,
     * which is what lets edge auto-scroll call this again on a pointer that
     * hasn't moved: the lanes have slid under it, so the same clientX is a
     * later tick. A delta-based version would compute zero and stick.
     */
    let last: { x: number; y: number } | null = null;
    const apply = () => {
      if (!last) return;

      if (mode === 'resize') {
        const end = snapToGrid(tickAt(last.x));
        // The lib's floor is one tick, so a shared delta dragged past the left
        // edge would collapse the group into invisible slivers. Clamping the
        // delta against the shortest member keeps every note at least a
        // sixteenth *and* preserves the relative lengths within the group.
        const shortest = Math.min(...resizeFrom.map((s) => s.durationTicks));
        const delta = end - (event.startTick + event.durationTicks);
        resizeNotesBy(resizeFrom, Math.max(stampLength - shortest, delta));
        return;
      }

      const tick = Math.max(0, snapToGrid(tickAt(last.x) - grabOffset));
      // Rows descend the screen but string indices ascend with pitch, so
      // dragging down moves to a lower-numbered string.
      const rows = Math.round((last.y - startY) / rowHeight);
      moveNotesBy(dragFrom, tick - event.startTick, -rows, STRING_LABELS.length);
    };

    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD && Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return;
      moved = true;
      last = { x: ev.clientX, y: ev.clientY };
      apply();
      // Only once the press has become a drag: a click held over the edge is
      // not a request to go anywhere.
      edgeScroll.track(ev.clientX, apply);
    };
    // pointercancel closes the gesture too — the browser can take the pointer
    // away (touch scroll, an OS gesture) and no pointerup ever arrives.
    const finish = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      edgeScroll.end();
      abortGesture.current = null;
      endEditGesture(moved); // a click that never moved isn't an edit
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    abortGesture.current = finish;
  };

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

  /**
   * Empty lane space does double duty: a click stamps a note, a drag rubber-bands
   * a selection. They're told apart by movement, so neither needs a modifier —
   * the same trick guitar-tutor uses.
   */
  const onLaneDown = (stringIndex: number) => (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return;
    const originX = e.clientX;
    const originY = e.clientY;
    // The band's anchor is kept in content space, for the same reason `tickAt`
    // works that way: under an edge auto-scroll the lanes slide but the corner
    // the user started from stays on the note they started from, so the band
    // grows instead of sliding along with the view.
    const originContentX = originX - (lanesRef.current?.getBoundingClientRect().left ?? 0);
    const additive = e.shiftKey;
    const before = additive ? selectedIds : [];
    let marqueeing = false;

    /** The band and its selection, re-derived from the last pointer position. */
    let last: { x: number; y: number } | null = null;
    /** The previous frame's hits, to tell a changed selection from a repeat.
     *  Null until the first pass, which always has to run. */
    let lastHits: string | null = null;
    const apply = () => {
      if (!last) return;
      const laneLeft = lanesRef.current?.getBoundingClientRect().left ?? 0;
      const pointerContentX = last.x - laneLeft;
      const bandLeft = Math.min(originContentX, pointerContentX);
      const bandRight = Math.max(originContentX, pointerContentX);
      const top = Math.min(originY, last.y);
      const bottom = Math.max(originY, last.y);

      // Vertically the well never scrolls, so a band dragged up into the toolbar
      // or down past the lanes would otherwise catch notes the user can't see.
      // Horizontally the *hit test* is deliberately not clipped: content
      // scrolled out of view is exactly what a band stretched by auto-scroll is
      // reaching for.
      const well = scrollerRef.current?.getBoundingClientRect();
      const hitTop = Math.max(top, well?.top ?? top);
      const hitBottom = Math.min(bottom, well?.bottom ?? bottom);

      // The drawn band is another matter: it lives in viewport coordinates, and
      // once auto-scroll has run a few thousand pixels the content-space band
      // starts far off-screen left — painting a slab across the string labels
      // and everything else beside the well. Clipping the paint alone keeps the
      // band over the region it is actually selecting.
      const drawLeft = Math.max(laneLeft + bandLeft, well?.left ?? -Infinity);
      const drawRight = Math.max(
        drawLeft,
        Math.min(laneLeft + bandRight, well?.right ?? Infinity),
      );
      setMarquee({ left: drawLeft, right: drawRight, top, bottom });

      // Hit-test against what the notes report rather than recomputing geometry
      // — they already know where they are — but compare horizontally in
      // content space, which is the one frame both ends of the band share once
      // the view has moved under it.
      const hits =
        hitTop > hitBottom
          ? []
          : [...document.querySelectorAll<HTMLElement>('[data-note]')]
              .filter((el) => {
                const box = el.getBoundingClientRect();
                return (
                  box.right - laneLeft >= bandLeft &&
                  box.left - laneLeft <= bandRight &&
                  box.bottom >= hitTop &&
                  box.top <= hitBottom
                );
              })
              .map((el) => el.dataset.note!);

      // Auto-scroll calls this every frame, and the lib's `selectEvents` returns
      // a fresh array whether or not the ids changed — which re-renders the
      // whole timeline, which makes the next frame re-measure every note. A
      // pointer parked in the edge zone over empty space would pay that 60x a
      // second for a selection nobody touched.
      const key = hits.join(' ');
      if (key === lastHits) return;
      lastHits = key;
      selectNotes([...new Set([...before, ...hits])]);
    };

    const onMove = (ev: PointerEvent) => {
      if (
        !marqueeing &&
        Math.abs(ev.clientX - originX) < DRAG_THRESHOLD &&
        Math.abs(ev.clientY - originY) < DRAG_THRESHOLD
      ) {
        return;
      }
      marqueeing = true;
      last = { x: ev.clientX, y: ev.clientY };
      apply();
      edgeScroll.track(ev.clientX, apply);
    };

    // Only a real pointerup stamps or keeps a selection; pointercancel and an
    // unmount just have to leave nothing behind.
    const stopTracking = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', stopTracking);
      edgeScroll.end();
      abortGesture.current = null;
      setMarquee(null);
    };

    const onUp = (ev: PointerEvent) => {
      stopTracking();
      if (marqueeing) return;

      // A plain click on empty space: clear the selection, or stamp a note.
      if (selectedIds.length > 1) {
        selectNotes([]);
        return;
      }
      const tick = snapToGrid(tickAt(ev.clientX));
      // Reuse the last-used fret so repeated stamping doesn't reset to 0.
      const fret = selectedIds.length
        ? (pattern.events.find((ev2) => ev2.id === selectedIds[0])?.fret ?? 0)
        : 0;
      stampNote({ stringIndex, fret, tick, durationTicks: stampLength });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', stopTracking);
    abortGesture.current = stopTracking;
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
        <span className="font-mono text-[11px] font-bold text-ink-hi">
          {bars} {bars === 1 ? 'bar' : 'bars'} · {pattern.events.length} notes
        </span>
      </div>

      {/* Height is ruler + one row per string, all explicit — so the grid needs no
          share of a supplied height. Only the horizontal axis scrolls, for time. */}
      <div ref={areaRef} className="grid grid-cols-[24px_1fr]">
        <div className="flex flex-col" style={{ paddingTop: RULER_H }}>
          {ROW_ORDER.map((stringIndex) => (
            <span
              key={stringIndex}
              style={{ height: rowHeight }}
              className="flex items-center justify-end pr-1.5 font-mono text-[9px] font-bold text-ink-mut"
            >
              {STRING_LABELS[stringIndex]}
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

            <div className="lanes" ref={lanesRef}>
              {ROW_ORDER.map((stringIndex) => (
                <div
                  key={stringIndex}
                  data-lane={STRING_LABELS[stringIndex]}
                  onPointerDown={onLaneDown(stringIndex)}
                  style={{ height: rowHeight, backgroundImage: gridImage }}
                  className="relative cursor-crosshair"
                >
                  {pattern.events
                    .filter((event) => event.stringIndex === stringIndex)
                    .map((event) => {
                      const selected = selectedIds.includes(event.id);
                      const active = activeIds.includes(event.id);
                      return (
                        <div
                          key={event.id}
                          data-note={event.id}
                          data-selected={selected || undefined}
                          data-active={active || undefined}
                          title={
                            `Fret ${event.fret} · ${pitchName(stringIndex, event.fret)}` +
                            (event.dynamic ? ` · ${event.dynamic}` : '')
                          }
                          onPointerDown={startDrag(event, 'move')}
                          style={{
                            left: tickToPx(event.startTick, pxPerBeat),
                            width: Math.max(14, tickToPx(event.durationTicks, pxPerBeat) - 2),
                            top: noteTop,
                            height: noteHeight,
                          }}
                          // `touch-none` because a horizontal drag on a note
                          // would otherwise be claimed by the well's native pan,
                          // which fires pointercancel and kills the gesture
                          // before it ever reaches an edge — preventDefault on
                          // pointerdown cannot stop that, only the CSS can. Empty
                          // lane space keeps its pan: that is how a touch user
                          // scrolls (at the cost of a touch marquee).
                          className={`pressable touch-none absolute flex cursor-grab flex-col items-center justify-center gap-px rounded-[5px] font-mono text-[10.5px] font-bold select-none ${
                            selected
                              ? 'border border-brass bg-linear-to-b from-[#4a4433] to-[#3a3529] text-brass-hi shadow-[0_0_0_1px_var(--color-brass)]'
                              : 'control'
                          } ${active ? 'border-brass-hi text-brass-hi shadow-glow-brass' : ''}`}
                        >
                          <NoteMarks event={event} />
                          <span>{event.fret}</span>
                          {isTall && (
                            <span className="font-mono text-[8px] font-semibold opacity-70">
                              {pitchName(stringIndex, event.fret)}
                            </span>
                          )}
                          {selected && (
                            <button
                              type="button"
                              aria-label="Note options"
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) =>
                                setPopupFor({
                                  id: event.id,
                                  anchor: (
                                    e.currentTarget.closest('[data-note]') as HTMLElement
                                  ).getBoundingClientRect(),
                                })
                              }
                              className="control-accent pressable absolute top-1/2 -right-2.5 flex h-[18px] w-[18px] -translate-y-1/2 items-center justify-center rounded-[5px] font-mono text-[10px] leading-none"
                            >
                              ⋯
                            </button>
                          )}
                          <span
                            data-resize={event.id}
                            onPointerDown={startDrag(event, 'resize')}
                            className="absolute top-0 -right-1 bottom-0 w-2 cursor-ew-resize"
                          />
                        </div>
                      );
                    })}
                </div>
              ))}
            </div>

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

      {marquee && (
        <div
          data-testid="marquee"
          className="pointer-events-none fixed z-40 rounded-xs border border-brass bg-brass/10"
          style={{
            left: marquee.left,
            top: marquee.top,
            width: marquee.right - marquee.left,
            height: marquee.bottom - marquee.top,
          }}
        />
      )}

      {popupNote && popupFor && (
        <div className="fixed inset-0 z-50" onPointerDown={() => setPopupFor(null)}>
          <AnchoredTo rect={popupFor.anchor}>
            <NotePopup
              event={popupNote}
              events={pattern.events}
              pitchName={pitchName(popupNote.stringIndex, popupNote.fret)}
              onClose={() => setPopupFor(null)}
            />
          </AnchoredTo>
        </div>
      )}
    </div>
  );
}
