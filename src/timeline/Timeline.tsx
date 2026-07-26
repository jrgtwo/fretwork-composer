import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PPQ, snapTick, ticksPerBar, type PatternEvent } from '@fretwork/lib';
import { readNotePitch } from '../patterns/articulations';
import { NotePopup } from './NotePopup';
import {
  beginEditGesture,
  deleteNotes,
  endEditGesture,
  moveNote,
  redo,
  resizeNote,
  selectNotes,
  stampNote,
  undo,
  useEditingPattern,
  useHistoryState,
  useSelectedIds,
} from '../patterns/patternService';
import {
  barBeatLines,
  laneMetrics,
  pxToTick,
  tickToPx,
  ZOOM_LEVELS,
  DEFAULT_ZOOM_INDEX,
} from './timelineMath';

/** High → low, matching a `PatternEvent`'s stringIndex. */
const STRING_LABELS = ['e', 'B', 'G', 'D', 'A', 'E'];
const OPEN_MIDI = [64, 59, 55, 50, 45, 40];
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const RULER_H = 20;
const SNAP = PPQ / 4; // sixteenth-note grid
const DEFAULT_DURATION = PPQ / 2;
const DRAG_THRESHOLD = 3;

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
  const pattern = useEditingPattern();
  const selectedIds = useSelectedIds();
  const { canUndo, canRedo } = useHistoryState();
  // Anchored to the note's on-screen box, captured when the popup is opened.
  const [popupFor, setPopupFor] = useState<{ id: string; anchor: DOMRect } | null>(null);
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  const pxPerBeat = ZOOM_LEVELS[zoomIndex];
  const areaRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const [areaHeight, setAreaHeight] = useState(240);

  // Rows follow the pane height, which the user can drag — measure, don't assume.
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setAreaHeight(entry.contentRect.height));
    observer.observe(el);
    setAreaHeight(el.getBoundingClientRect().height);
    return () => observer.disconnect();
  }, []);

  // Editing shortcuts. All ignored while typing into a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable]')) return;

      const mod = e.metaKey || e.ctrlKey;
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds]);

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
  // Read fresh each render so the popup reflects edits made through it.
  const popupNote = popupFor ? pattern.events.find((e) => e.id === popupFor.id) : undefined;

  const carve = (w: number, dark: number, light: number) =>
    `repeating-linear-gradient(90deg,transparent 0 ${w - 2}px,` +
    `rgb(0 0 0/${dark}) ${w - 2}px ${w - 1}px,rgb(255 255 255/${light}) ${w - 1}px ${w}px)`;
  const gridImage = [
    carve(tickToPx(SNAP, pxPerBeat), 0.3, 0.022),
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
    selectNotes([event.id]);

    const startX = e.clientX;
    const startY = e.clientY;
    // Ticks between the pointer and the note's start, so it doesn't jump on grab.
    const grabOffset = tickAt(startX) - event.startTick;
    let moved = false;
    // One undo step for the whole drag, not one per pointermove.
    beginEditGesture();

    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD && Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return;
      moved = true;

      if (mode === 'resize') {
        const end = snapTick(tickAt(ev.clientX), SNAP);
        resizeNote(event.id, Math.max(SNAP, end - event.startTick));
        return;
      }

      const tick = Math.max(0, snapTick(tickAt(ev.clientX) - grabOffset, SNAP));
      const rows = Math.round((ev.clientY - startY) / rowHeight);
      const stringIndex = Math.max(
        0,
        Math.min(STRING_LABELS.length - 1, event.stringIndex + rows),
      );
      moveNote(event.id, tick, stringIndex);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      endEditGesture(moved); // a click that never moved isn't an edit
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /** Clicking empty lane space places a note there. */
  const onLaneDown = (stringIndex: number) => (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return;
    const tick = snapTick(tickAt(e.clientX), SNAP);
    // Reuse the last-used fret so repeated stamping doesn't reset to 0.
    const fret = selectedIds.length
      ? (pattern.events.find((ev) => ev.id === selectedIds[0])?.fret ?? 0)
      : 0;
    stampNote({ stringIndex, fret, tick, durationTicks: DEFAULT_DURATION });
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
        <span className="flex-1" />
        <span className="font-mono text-[11px] font-bold text-ink-hi">
          {bars} {bars === 1 ? 'bar' : 'bars'} · {pattern.events.length} notes
        </span>
      </div>

      <div ref={areaRef} className="grid min-h-0 flex-1 grid-cols-[24px_1fr]">
        <div className="flex flex-col" style={{ paddingTop: RULER_H }}>
          {STRING_LABELS.map((label) => (
            <span
              key={label}
              style={{ height: rowHeight }}
              className="flex items-center justify-end pr-1.5 font-mono text-[9px] font-bold text-ink-mut"
            >
              {label}
            </span>
          ))}
        </div>

        <div className="well overflow-x-auto overflow-y-hidden">
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
              {STRING_LABELS.map((label, stringIndex) => (
                <div
                  key={label}
                  data-lane={label}
                  onPointerDown={onLaneDown(stringIndex)}
                  style={{ height: rowHeight, backgroundImage: gridImage }}
                  className="relative cursor-crosshair"
                >
                  {pattern.events
                    .filter((event) => event.stringIndex === stringIndex)
                    .map((event) => {
                      const selected = selectedIds.includes(event.id);
                      return (
                        <div
                          key={event.id}
                          data-note={event.id}
                          data-selected={selected || undefined}
                          title={`Fret ${event.fret} · ${pitchName(stringIndex, event.fret)}`}
                          onPointerDown={startDrag(event, 'move')}
                          style={{
                            left: tickToPx(event.startTick, pxPerBeat),
                            width: Math.max(14, tickToPx(event.durationTicks, pxPerBeat) - 2),
                            top: noteTop,
                            height: noteHeight,
                          }}
                          className={`pressable absolute flex cursor-grab flex-col items-center justify-center gap-px rounded-[5px] font-mono text-[10.5px] font-bold select-none ${
                            selected
                              ? 'border border-brass bg-linear-to-b from-[#4a4433] to-[#3a3529] text-brass-hi shadow-[0_0_0_1px_var(--color-brass)]'
                              : 'control'
                          }`}
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
          </div>
        </div>
      </div>

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
