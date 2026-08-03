import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { pitchClass, snapTick, type Pattern, type PatternEvent, type Tick } from '@fretwork/lib';
import { readNotePitch } from '../patterns/articulations';
import { openStrings, stringLabels } from '../reference/tabLayout';
import { NotePopup } from './NotePopup';
import { useActiveEventIds } from '../audio/playbackService';
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
  setSelectedFret,
  snapshotForDrag,
  snapshotForResize,
  stampNote,
  undo,
  useSelectedIds,
} from '../patterns/patternService';
import type { EdgeAutoScroll } from './useEdgeAutoScroll';
import {
  clampMoveDelta,
  clampResizeDelta,
  laneGridImage,
  laneMetrics,
  pxToTick,
  rowOrder,
  tickToPx,
  FREE_NOTE_TICKS,
  type SnapOption,
} from './timelineMath';

/**
 * Sharp spellings, because a fretboard has no key to spell against — and the lib's
 * `noteAt` cannot supply them: Tonal's `Note.fromMidi` returns FLATS (`noteAt('C4',1)`
 * is `'Db4'`), so routing this through the lib would respell every accidental in the
 * editor. `spellInKey` is the lib's answer to spelling and it needs a tonic nothing
 * here has. The typographic `♯` is deliberate: it is what an 8px glyph inside a note
 * block should be, not a hash.
 */
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
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

/**
 * What a fret on a given string is called, off the instrument's own open strings
 * — a bass or a ukulele names its notes from its own tuning, read through the one
 * resolver `stringLabels` uses so the gutter and the notes beside it can't come
 * from two different tunings.
 *
 * No octave: a note block labels the pitch, not the register.
 *
 * `''` for a string the tuning has no entry for — a blank name is honest where
 * the guitar's would be a confident wrong answer. The tuning is the instrument's
 * declared default, the same choice and the same caveat as `stringLabels`:
 * nothing owns instrument/tuning/capo yet, so these names and the notes you hear
 * agree only as long as both keep landing on the same tuning (FOLLOW-UPS §3).
 */
function pitchNamer(instrumentId: string, stringCount: number) {
  const opens = openStrings(instrumentId, stringCount);
  return (stringIndex: number, fret: number): string => {
    const open = opens[stringIndex];
    if (open === undefined) return '';
    return NOTE_NAMES[(pitchClass(open) + fret) % 12];
  };
}

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

/** Digits typed so far for a fret, the timer that will commit them, and whether
 *  any of them actually moved a note. */
interface FretRun {
  digits: string;
  timer: number;
  changed: boolean;
}

/**
 * Close whichever undo bracket a keyboard run left open.
 *
 * Module scope so the two effects that need it — losing focus and unmounting —
 * share one implementation: they are the two ways a run ends with no keyup, and
 * a bracket left open makes `history.capture` ignore every later edit for the
 * life of the page. The held arrow's snapshot is DISCARDED (`false`) because the
 * key's first press already recorded the pre-nudge state; a typed number's is
 * pushed only if a digit actually moved a note.
 */
function closeKeyRuns(
  fretRun: React.RefObject<FretRun | null>,
  nudgeRun: React.RefObject<boolean>,
): void {
  if (nudgeRun.current) {
    nudgeRun.current = false;
    endEditGesture(false);
  }
  const run = fretRun.current;
  if (!run) return;
  clearTimeout(run.timer);
  fretRun.current = null;
  endEditGesture(run.changed);
}

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
 * What the surface needs to know about the view it is drawn inside, read fresh
 * on every pointer event rather than captured at render — the same injectable
 * shape `useArrangementGestures.GestureGeometry` uses, and for the same reason:
 * jsdom measures every element as 0×0, so a surface that reached for its host's
 * box itself could never be exercised in a test.
 */
export interface SurfaceGeometry {
  /**
   * Client rect of the window the surface is seen through — the pattern page's
   * scrolling well, and in CP-11 the arrangement's lane area. Null when nothing
   * clips the surface, in which case a marquee is bounded only by the pointer.
   */
  viewportRect(): DOMRect | null;
}

/** Shared empty selection, so an unfocused surface keeps a stable identity. */
const NO_IDS: readonly string[] = [];

export interface NoteSurfaceProps {
  /**
   * The pattern to DRAW. A surface draws what it is given and reads no pattern
   * of its own — which is the whole reason edit mode can mount one per placement
   * and have each show its own track's notes. Reading the store here (as CP-10
   * did) gives every mounted surface the ONE global edit target, so eight lanes
   * would draw eight copies of the same pattern.
   *
   * Reading and writing are deliberately split: WRITES still go through
   * `patternService` to that one global target, which the lib redirects at a
   * placement's snapshot once `openPlacementForEditing` has pointed it at one.
   * So only the FOCUSED surface may write — see `focused` and `onFocus`.
   */
  pattern: Pattern;
  /**
   * Whether this surface owns the global edit target right now.
   *
   * It gates two things that would otherwise act on the wrong pattern:
   *
   *  - THE WINDOW KEYBOARD SHORTCUTS. They are on `window` and every handler
   *    acts on the edit target, so two mounted surfaces would run two
   *    `beginEditGesture`/`setSelectedFret` pairs for one keypress against a
   *    `history` that keeps a single snapshot — and one of the two edits would
   *    vanish from the undo stack. Only a focused surface attaches them.
   *  - THE SELECTION. `selectedEventIds` belongs to the edit target, so an
   *    unfocused surface has none; without this, two placements of the same
   *    pattern would draw the same ids selected and a keypress meant for one
   *    would look like it acted on both.
   */
  focused: boolean;
  /**
   * Whether THIS surface's notes are the ones currently sounding. Defaults to
   * true, which is the pattern page: one surface, one pattern, and whatever the
   * transport reports is its.
   *
   * False gates the play highlight off, and it has to: `useActiveEventIds()` is
   * a flat merged list of EVENT ids across every track, and two placements of
   * one pattern carry the SAME event ids (`snapshotPatternForPlacement` copies
   * them verbatim). Without the gate, playing one block lights the notes up in
   * every other copy of it as well. The host knows which blocks are sounding —
   * `playbackService.useActivePlacementIds` — and says so here.
   */
  sounding?: boolean;
  /**
   * Point the global edit target at THIS surface's pattern, and report whether
   * it may now be edited.
   *
   * Called synchronously at the head of every gesture that writes, before
   * anything reads the target — the store's write is synchronous, so
   * `getEditingPattern()` after it is already this pattern. Omitted on the
   * pattern page, where there is only ever one target and one surface.
   */
  onFocus?: () => boolean;
  /**
   * How long the editable window is, in this pattern's own ticks — a
   * placement's effective length. Notes CLAMP at it and a stamp past it is
   * refused, so you cannot write into empty time or drag a note into the
   * neighbouring block (which would be two snapshot writes and an ambiguous
   * undo step).
   *
   * `null`, the default, is the pattern page: its length auto-fits to its
   * content, so there is no boundary to stop at.
   */
  windowTicks?: Tick | null;
  /**
   * Whether a selected note offers the ⋯ options popup. False in an arrangement
   * lane, where the same controls belong in the rail — see TODO(CP-12) below.
   */
  showNoteOptions?: boolean;
  /** Zoom, owned by whatever chrome hosts this. */
  pxPerBeat: number;
  /**
   * Height available to the string rows — the ruler's share, if the host draws
   * one, has already been taken off. Rows divide it between them.
   */
  laneAreaHeight: number;
  /**
   * How many rows to draw. Separate from `instrumentId` on purpose, and separate
   * from the PATTERN's instrument too: an arrangement lane draws the TRACK's
   * neck, so every placement in it shares one row pitch and the rows line up
   * across them (`arrangementMath.EditableSpan`). A snapshot written for a wider
   * instrument keeps its off-neck notes and simply cannot show them — the same
   * gap `Timeline` reports as "off-instrument".
   */
  stringCount: number;
  /** Which instrument's tuning names the rows and the notes on them. */
  instrumentId: string;
  /** Snap resolution — sets the visible grid, quantisation, and stamp length. */
  grid: SnapOption;
  /**
   * The host's edge auto-scroll. Injected rather than owned: the surface has no
   * scroll container, so it cannot have scroll-driven behaviour of its own.
   */
  edgeScroll: EdgeAutoScroll;
  geometry: SurfaceGeometry;
}

/**
 * The editable note surface: one row per string, the pattern's events laid out
 * in time, and every gesture that edits them — click-to-stamp, drag to move,
 * drag the right edge to resize, rubber-band select, typed frets and arrow
 * nudges.
 *
 * It owns no scroll container, no zoom and no ruler. Its width comes from
 * whatever it is rendered inside, which is why nothing here needs a scroll
 * offset: every pointer position is measured against the lane element's own
 * box, so the host can scroll it, offset it or nest it freely.
 *
 * Every edit goes through the pattern service, so the lib's invariants (no
 * same-string overlap, clamped durations, auto-fitted length) hold without this
 * component knowing about them.
 *
 * ── Reading and writing are split, and that is the whole of CP-11 ────────────
 *
 * It DRAWS the `pattern` it is handed. It WRITES to the global edit target,
 * which the lib redirects at a placement's snapshot once
 * `openPlacementForEditing` has pointed the store at one — so every existing
 * pattern-service operation edits a placement unchanged, and the surface needs
 * no write path of its own. There is exactly one such target, so exactly one
 * mounted surface may write at a time: `focused` says which, and `onFocus` is
 * how a press moves it. Mounting eight of these that all READ the store would
 * have drawn the same pattern eight times, which is what the `pattern` prop
 * exists to prevent.
 *
 * One deliberate consequence of the shortcuts living here rather than with the
 * chrome: they are dead while no pattern is open, because `Timeline` renders
 * nothing at all in that state. Undo used to survive it. `App`'s `ensurePattern`
 * makes that state last a single render, so it is recorded rather than fixed.
 */
export function NoteSurface({
  pattern,
  focused,
  sounding = true,
  onFocus,
  windowTicks = null,
  showNoteOptions = true,
  pxPerBeat,
  laneAreaHeight,
  stringCount,
  instrumentId,
  grid,
  edgeScroll,
  geometry,
}: NoteSurfaceProps) {
  // The store's selection belongs to the EDIT TARGET, so a surface that does not
  // own the target has none — see `focused`.
  const globalSelection = useSelectedIds();
  const selectedIds = focused ? globalSelection : NO_IDS;
  // Event ids are shared between copies of one pattern, so a surface that is not
  // the one sounding has no active notes — see `sounding`.
  const globalActive = useActiveEventIds();
  const activeIds = sounding ? globalActive : NO_IDS;
  // Anchored to the note's on-screen box, captured when the popup is opened.
  const [popupFor, setPopupFor] = useState<{ id: string; anchor: DOMRect } | null>(null);
  // Viewport coordinates — the band is drawn fixed, over everything.
  const [marquee, setMarquee] = useState<{
    left: number;
    right: number;
    top: number;
    bottom: number;
  } | null>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  /** Tears down whichever pointer gesture is in flight. Null when none is. */
  const abortGesture = useRef<(() => void) | null>(null);
  /** The number being typed for a fret. Null when nothing is. */
  const fretRun = useRef<FretRun | null>(null);
  /** True while an arrow key's auto-repeat is being folded into the undo step
   *  its first press already recorded. */
  const nudgeRun = useRef(false);

  // Editing shortcuts — one listener for all of them, so nothing has to race a
  // second handler for the same key. All ignored while typing into a field: a
  // `select` counts, since arrows are how you change one.
  //
  // GATED ON `focused`, which is not an optimisation: these are on `window` and
  // every handler acts on the global edit target, so a second attached surface
  // would run a second `beginEditGesture`/`setSelectedFret` pair for one
  // keypress against a `history` that keeps a single snapshot — and one of the
  // two edits would vanish from the undo stack. Exactly one surface may be
  // focused, so exactly one listener is ever attached.
  useEffect(() => {
    if (!focused) return;

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
  }, [selectedIds, focused]);

  // Losing the edit target abandons a half-typed fret or a held arrow — the next
  // keystroke goes to another surface entirely — so the bracket it opened has to
  // close, or `history.capture` ignores every later edit for the life of the
  // page. Its OWN effect rather than the shortcut effect's cleanup, because that
  // one also re-runs on every selection change and a number being typed must
  // survive one; and not the unmount effect's, because that aborts the pointer
  // gesture too and `focused` flips to true at the START of a drag.
  useEffect(() => {
    if (!focused) return;
    return () => closeKeyRuns(fretRun, nudgeRun);
  }, [focused]);

  // A pointer gesture parks its listeners on `window` so it keeps tracking once
  // the pointer leaves the lane — which also means nothing else would tear them
  // down if this unmounts mid-drag, leaving the undo stack stuck inside an
  // open gesture and every later edit unrecorded. A half-typed fret or a held
  // arrow leaves the same gesture open, so those close here too.
  useEffect(
    () => () => {
      abortGesture.current?.();
      closeKeyRuns(fretRun, nudgeRun);
    },
    [],
  );

  const rows = rowOrder(stringCount);
  const labels = stringLabels(instrumentId, stringCount);
  const pitchName = pitchNamer(instrumentId, stringCount);

  const { rowHeight, noteHeight, noteTop, isTall } = laneMetrics(laneAreaHeight, stringCount);
  /** Quantise, unless the grid is off — then take the raw tick. */
  const snapToGrid = (tick: number) => (grid.ticks ? snapTick(tick, grid.ticks) : tick);
  /** A stamped note is one grid step long, so the grid sets the note length too. */
  const stampLength = grid.ticks ?? FREE_NOTE_TICKS;
  const gridImage = laneGridImage(pxPerBeat, grid.ticks, pattern.timeSignature);

  // Read fresh each render so the popup reflects edits made through it.
  const popupNote = popupFor ? pattern.events.find((e) => e.id === popupFor.id) : undefined;

  /** Pointer x → tick, measured against the lane's own box so scrolling is free.
   *  In an arrangement lane that box is the PLACEMENT's, so this is already the
   *  snapshot's own tick frame and no offset has to be threaded through. */
  const tickAt = (clientX: number) => {
    const rect = lanesRef.current?.getBoundingClientRect();
    return pxToTick(clientX - (rect?.left ?? 0), pxPerBeat);
  };

  /**
   * Take the global edit target before anything reads it.
   *
   * Synchronous on purpose: the store's write lands immediately, so every
   * `getEditingPattern()` below — `snapshotForDrag`, `beginEditGesture`,
   * `stampNote` — already sees THIS pattern. Called at the head of every gesture
   * that writes, and returning false is how a host refuses (the block is gone,
   * no composition is open); the gesture then does nothing at all rather than
   * editing whichever pattern happened to be open.
   */
  const takeFocus = (): boolean => (focused ? true : (onFocus?.() ?? true));

  const startDrag = (event: PatternEvent, mode: DragMode) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!takeFocus()) return;

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
        // Both ends of the delta are clamped ACROSS THE GROUP rather than per
        // note — see `clampResizeDelta`. `dragFrom` carries the start ticks the
        // window bound needs; `resizeFrom` is what the lib clamps against.
        const delta = clampResizeDelta(
          dragFrom,
          end - (event.startTick + event.durationTicks),
          windowTicks,
          stampLength,
        );
        resizeNotesBy(resizeFrom, delta);
        return;
      }

      const tick = Math.max(0, snapToGrid(tickAt(last.x) - grabOffset));
      // Rows descend the screen but string indices ascend with pitch, so
      // dragging down moves to a lower-numbered string.
      const rowDelta = Math.round((last.y - startY) / rowHeight);
      // Clamped at the placement boundary rather than carried into the
      // neighbour: crossing would be two snapshot writes and an ambiguous undo
      // step. Unbounded on the pattern page, where `windowTicks` is null.
      const delta = clampMoveDelta(dragFrom, tick - event.startTick, windowTicks);
      moveNotesBy(dragFrom, delta, -rowDelta, stringCount);
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
   * Empty lane space does double duty: a click stamps a note, a drag rubber-bands
   * a selection. They're told apart by movement, so neither needs a modifier —
   * the same trick guitar-tutor uses.
   */
  const onLaneDown = (stringIndex: number) => (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return;
    if (!takeFocus()) return;
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
      const lanesEl = lanesRef.current;
      const laneLeft = lanesEl?.getBoundingClientRect().left ?? 0;
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
      const well = geometry.viewportRect();
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
      //
      // Scoped to this surface's own lanes rather than the document: CP-11 puts
      // more than one of these on a page, and a document-wide query would drag
      // a neighbouring block's notes into the band.
      //
      // Covered by tests/EditMode.test.tsx: two surfaces over snapshots of
      // DIFFERENT library patterns, so the ids a document-wide query would drag
      // in are ids this surface's pattern has not got.
      const hits =
        hitTop > hitBottom || !lanesEl
          ? []
          : [...lanesEl.querySelectorAll<HTMLElement>('[data-note]')]
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
      const pressedAt = tickAt(ev.clientX);
      let tick = snapToGrid(pressedAt);
      if (windowTicks !== null) {
        // Nothing may be written into empty time. Inside a placement the window
        // is its effective length, so a press past the last tick stamps nothing
        // at all rather than a note the block would have to grow to hold.
        if (pressedAt >= windowTicks) return;
        // The press was inside, but `snapToGrid` ROUNDS — so one in the right
        // half of the FINAL grid cell lands exactly on `windowTicks`. Refusing
        // those would leave half a cell of silent dead zone at the end of every
        // block, which reads as the app ignoring presses. Clamp back to the last
        // grid position that fits instead.
        const step = grid.ticks ?? FREE_NOTE_TICKS;
        const lastInWindow = Math.max(0, Math.floor((windowTicks - 1) / step) * step);
        if (tick > lastInWindow) tick = lastInWindow;
      }
      // Reuse the last-used fret so repeated stamping doesn't reset to 0.
      const fret = selectedIds.length
        ? (pattern.events.find((ev2) => ev2.id === selectedIds[0])?.fret ?? 0)
        : 0;
      stampNote({
        stringIndex,
        fret,
        tick,
        // A note stamped against the boundary is SHORTENED to fit rather than
        // refused: the grid step is a default length, not part of the request.
        durationTicks:
          windowTicks === null ? stampLength : Math.min(stampLength, windowTicks - tick),
      });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', stopTracking);
    abortGesture.current = stopTracking;
  };

  return (
    <>
      {/* Nothing but lanes may be a child of `.lanes`: `styles/index.css` shades
          it with `:nth-child(even)`, which counts every sibling. The overlays
          below are therefore siblings of it, not of the rows. */}
      <div className="lanes" ref={lanesRef}>
        {rows.map((stringIndex) => (
          <div
            key={stringIndex}
            data-lane={labels[stringIndex]}
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
                    {selected && showNoteOptions && (
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

      {/* The popup belongs to the SURFACE, not the chrome: both the button that
          opens it and the box it anchors to are parts of a note, and nothing
          outside these lanes can produce either. Handing the chrome a callback
          would mean lifting `{id, DOMRect}` out only to hand it straight back —
          more coupling to NotePopup, not less.
          `showNoteOptions` is false in an arrangement lane: a popup anchored to
          a note inside a clipped, scrolling lane stack has nowhere good to go,
          and TODO(CP-12) puts the same controls in the rail instead. */}
      {showNoteOptions && popupNote && popupFor && (
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
    </>
  );
}
