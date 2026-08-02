/**
 * Tablature geometry — every number in the tab view is decided here.
 *
 * Kept out of React for the same reason as `patternCells`: none of it needs a DOM,
 * and jsdom has no layout at all (every `getBoundingClientRect` is 0×0), so a
 * component that did this arithmetic inline would be untestable by construction.
 * The view measures its own width and renders whatever this returns.
 *
 * The one thing tab has to get right is that notes at the same tick line up
 * vertically, so x is a pure function of the tick and nothing else — never of a
 * note's own width or of what its neighbours are doing. That also means dense
 * passages can collide horizontally; proportional-to-time spacing is what both of
 * guitar-tutor's tab renderers do, and real engraving spacing (which pushes
 * neighbours apart) would break the alignment that makes a chord readable.
 */
import {
  PPQ,
  getInstrument,
  getTuning,
  ticksPerBar,
  type PatternEvent,
  type PatternTimeSignature,
} from '@fretwork/lib';
import { readNotePitch } from '../patterns/articulations';

/** Vertical distance between adjacent string lines. */
export const ROW_HEIGHT = 15;
/** Room at the left of every system for its string labels. */
export const LABEL_GUTTER = 20;
/**
 * Space above the top line and below the bottom one. Two things overhang into it:
 * a glyph on the outer line (half its own height) and, at the top, the system's bar
 * number above that — so this has to clear both, not just the glyph.
 */
export const SYSTEM_PAD = 20;
/** Blank space between stacked systems. */
export const SYSTEM_GAP = 14;

/**
 * A bar narrower than this can't hold four legible sixteenth columns, so it sets
 * how many bars a system will take. The upper bound matters just as much: a
 * one-bar pattern in a wide pane would otherwise stretch that bar across the whole
 * width and read as nothing at all.
 */
const MIN_BAR_WIDTH = 120;
const MAX_BAR_WIDTH = 320;

/** A ring-out tail shorter than this is visual noise beside the fret number. */
const MIN_TAIL = 14;

/**
 * How much paper this will lay out, at most.
 *
 * The bar count is the one number here whose corruption *hangs* instead of drawing
 * something wrong: the system loop allocates an object per bar-group, so a
 * `durationTicks` of 1e12 asks for ~5×10⁸ bars and takes the page down. Nothing
 * authors that; a corrupt import or a hand-edited sessionStorage entry can, which is
 * the same reachability `atLeastZero` is written for. Past the cap, notes pile into
 * the last system via the `systemIndex` clamp below — a wrong drawing, which is the
 * trade this whole file makes against a frozen pane.
 */
const MAX_BARS = 2000;

/**
 * A tick or a width, made safe to do arithmetic with. Negatives clamp to zero and
 * non-finite values read as zero: a single `NaN` off a corrupt import would otherwise
 * poison `totalBars`, leave `systems` empty, and take the pane down with it — which is
 * a worse answer than drawing the note at the top of bar 1.
 */
function atLeastZero(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export interface NoteParts {
  prefix: string;
  core: string;
  suffix: string;
}

/**
 * The tab spelling of one note, in guitar-tutor's `noteParts` vocabulary:
 * `t`/`h`/`p` before the number, `x` for a dead note, a slash or backslash for a
 * slide, `b` for a bend, `~` for vibrato. Palm mute is deliberately absent — it is
 * a tint on the glyph, not a character, in both apps.
 *
 * Angle brackets for a harmonic are the one addition, since the lib has the field and
 * real tab has the notation (guitar-tutor's own `noteParts` predates it).
 *
 * This is *not* the decorative glyph set `Timeline.tsx` draws (`╱`, `⤴`, `≈`, `H`,
 * `PM`). Those are labels on a note block; these are what real tab uses, and a
 * third vocabulary would be one too many.
 *
 * Two departures from guitar-tutor, both forced by this app:
 *   - slides are read through `readNotePitch` rather than off `event.slide`,
 *     because our pitch articulations are stored as `bend.points` whenever a note
 *     carries more than one movement (see docs/FOLLOW-UPS.md §2). Reading the raw
 *     field would silently drop every slide authored through the note popup.
 *   - a slide *into* the note prefixes the number instead of following it. That
 *     case doesn't exist in guitar-tutor (the lib's `slide` field holds one
 *     direction), but ours can hold both, and `12/\` for "slid into from below,
 *     slid out downwards" is unreadable. Leading slash is the standard notation
 *     for it anyway.
 */
export function noteParts(event: PatternEvent): NoteParts {
  const pitch = readNotePitch(event);
  // Travelling upward into the note is a forward slash, matching the suffix rule.
  const slideIn = pitch.slideIn === undefined ? '' : pitch.slideIn === 'below' ? '/' : '\\';
  const technique =
    (event.tap ? 't' : '') + (event.hammerOn ? 'h' : event.pullOff ? 'p' : '');

  // Composed rather than branched, so a note that is all three keeps all three marks:
  // `(<x>)` is nonsense to play but it is what the stored event says, and picking one
  // mark would drop the others silently.
  //
  // `<12>` is how tab writes a harmonic. Nothing in this app authors one — the pattern
  // importer does, same as the `legato`/`shift` slides below — and without this a
  // harmonic reads back as a plain fret number.
  const inner = event.dead ? 'x' : String(event.fret);
  const sounded = event.harmonic === undefined ? inner : `<${inner}>`;
  const core = event.ghost ? `(${sounded})` : sounded;

  let suffix = '';
  if (pitch.slideOut !== undefined) suffix += pitch.slideOut === 'up' ? '/' : '\\';
  // `legato`/`shift` are the lib's two slide-to-the-next-note types, and the only
  // ones `readNotePitch` has no case for — it models slides as in/out of a single
  // note. Nothing in this app authors them; the pattern importer does, so a note
  // read back from an imported pattern would otherwise be spelled as plain.
  else if (event.slide?.type === 'legato' || event.slide?.type === 'shift')
    suffix += (event.slide.toFret ?? event.fret) < event.fret ? '\\' : '/';
  if (pitch.bend !== undefined) suffix += 'b';
  if (event.vibrato !== undefined) suffix += '~';

  return { prefix: slideIn + technique, core, suffix };
}

/**
 * The open pitch of every string, indexed by `stringIndex` exactly like
 * `PatternEvent.stringIndex` and the lib's `TuningDef.strings` — full pitches
 * (`'A2'`), so a caller can transpose off them as well as name them.
 *
 * The tuning is the instrument's declared default rather than whatever happens to
 * come first out of the catalog — `getTuningsForInstrument(id)[0]` agrees today only
 * because of the order `TUNINGS` is written in, and reordering that data would
 * silently relabel this staff to Drop D. `playbackService` takes the same `[0]`
 * shortcut, which is the third consumer docs/FOLLOW-UPS.md §3 warns about: nothing
 * owns instrument/tuning/capo yet, so the labels and the notes you hear agree only
 * as long as both keep landing on the same tuning.
 *
 * `undefined` for a string the tuning has no entry for, and all of them undefined
 * for an instrument the catalog doesn't know: no fallback to `DEFAULT_TUNING_ID`,
 * because labelling a strange neck with the guitar's tuning is a confident wrong
 * answer where a blank is an honest one.
 */
export function openStrings(
  instrumentId: string,
  stringCount: number,
): (string | undefined)[] {
  const instrument = getInstrument(instrumentId);
  const strings = (instrument ? getTuning(instrument.defaultTuningId)?.strings : undefined) ?? [];
  return Array.from({ length: Math.max(0, stringCount) }, (_, index) => strings[index]);
}

/**
 * String labels bottom-to-top, from {@link openStrings}. Octave digits are
 * stripped — tab labels the string, not the pitch.
 */
export function stringLabels(instrumentId: string, stringCount: number): string[] {
  const labels = openStrings(instrumentId, stringCount).map(
    (open) => open?.replace(/-?\d+$/, '') ?? '',
  );

  // Standard guitar has an E at both ends, and tab writes the top one lowercase so
  // the two lines can be told apart — the timeline's string gutter reads these same
  // labels for the same pattern in the same window. Derived rather than hardcoded so
  // it also holds for a tuning whose duplicate isn't E.
  const top = stringCount - 1;
  if (top > 0 && labels.slice(0, top).includes(labels[top])) {
    labels[top] = labels[top].toLowerCase();
  }
  return labels;
}

/**
 * The row a string is drawn on. Tab puts the highest string on top and
 * `stringIndex` counts from the bottom one, so display order is the reverse of
 * index order — the same inversion `timelineMath.rowOrder` makes from the other
 * end, and getting it backwards puts every note on the wrong string while
 * looking completely plausible.
 */
export function rowForString(stringIndex: number, stringCount: number): number {
  return stringCount - 1 - stringIndex;
}

export interface TabBar {
  /** 1-based bar number, counted from the start of the pattern. */
  bar: number;
  x: number;
  width: number;
}

/** One staff of six lines holding a run of whole bars. */
export interface TabSystem {
  index: number;
  top: number;
  height: number;
  /** x of the left barline; the label gutter sits to its left. */
  left: number;
  /** x of the closing barline. Short on the last system — see `layoutTab`. */
  right: number;
  /** Ticks this system covers, end exclusive. */
  startTick: number;
  endTick: number;
  /** y of each string line, top row first. */
  rowYs: number[];
  bars: TabBar[];
}

export interface TabGlyph extends NoteParts {
  id: string;
  systemIndex: number;
  /** 0 = top line (highest string). */
  row: number;
  /** Centre of the number. */
  x: number;
  /** Centre of the row it sits on. */
  y: number;
  /** How far the note rings, clipped to the system. 0 when too short to draw. */
  tailWidth: number;
  palmMute: boolean;
}

export interface TabLayout {
  systems: TabSystem[];
  glyphs: TabGlyph[];
  /** Total height of the stack, for the scroller to size itself against. */
  height: number;
  barWidth: number;
  barsPerSystem: number;
  totalBars: number;
  /** Notes on a string this staff has no line for. See `layoutTab`. */
  offStaff: number;
}

export interface TabLayoutInput {
  /** Available width in px. Any value is tolerated, including jsdom's 0. */
  width: number;
  events: readonly PatternEvent[];
  timeSignature: PatternTimeSignature;
  durationTicks: number;
  stringCount: number;
}

/**
 * Lay the pattern out as stacked systems, sheet-music style.
 *
 * Bars per system follows the available width, which is why this takes a measured
 * number rather than a zoom level: resizing the pane re-wraps the music instead of
 * revealing more of one endless line.
 *
 * All but the last system are full, and the last one is *not* stretched to fill —
 * bar width is uniform across the whole piece, so a phrase occupies the same
 * amount of paper wherever it lands. That is engraving practice and it is also the
 * only version in which vertical alignment means anything.
 */
export function layoutTab({
  width,
  events,
  timeSignature,
  durationTicks,
  stringCount,
}: TabLayoutInput): TabLayout {
  // `ticksPerBar` is `numerator * (PPQ * 4 / denominator)` with no clamp, and
  // `setPatternTimeSignature` spreads its argument straight through — so a degenerate
  // signature reaches here intact. `{numerator: 0}` makes this 0, which divides
  // `totalBars` up to Infinity and hangs the system loop; `{denominator: 0}` makes it
  // Infinity, which collapses every note onto the gutter. A 4/4 bar is the fallback
  // rather than `Math.max(1, atLeastZero(raw))`, because `atLeastZero(Infinity)` is 0
  // and a one-tick bar means a system per tick — the hang again, by another route.
  const rawPerBar = ticksPerBar(timeSignature);
  const perBar = Number.isFinite(rawPerBar) && rawPerBar > 0 ? rawPerBar : PPQ * 4;
  const rows = Math.max(1, stringCount);

  // `durationTicks` is auto-fitted by the lib on every edit, but a pattern that
  // arrived any other way (import, a restored snapshot) can hold a note past its
  // stated end. Taking the later of the two is what keeps such a note on paper
  // instead of dropping it into a system that was never built.
  //
  // The one-tick floor on the duration matters: a note *starting* exactly on the final
  // barline needs a bar of its own to sit in, and one whose duration is 0 or negative
  // (the lib clamps authored ones, an imported one can carry either) would otherwise
  // contribute nothing to the length and be placed into a system that was never built.
  const lastEnd = events.reduce(
    (end, event) =>
      Math.max(end, atLeastZero(event.startTick) + Math.max(1, atLeastZero(event.durationTicks))),
    0,
  );
  const totalBars = Math.min(
    MAX_BARS,
    Math.max(1, Math.ceil(Math.max(atLeastZero(durationTicks), lastEnd) / perBar)),
  );

  // Floored at one bar's worth so a width of 0 — every measurement under jsdom, and
  // the first paint before the ResizeObserver reports — still yields real geometry
  // rather than a layout where every note shares an x of zero.
  const usable = Math.max(MIN_BAR_WIDTH, atLeastZero(width) - LABEL_GUTTER);
  const barsPerSystem = Math.min(totalBars, Math.max(1, Math.floor(usable / MIN_BAR_WIDTH)));
  const barWidth = Math.min(MAX_BAR_WIDTH, usable / barsPerSystem);
  const pxPerTick = barWidth / perBar;

  const systemHeight = SYSTEM_PAD * 2 + (rows - 1) * ROW_HEIGHT;
  const systemCount = Math.ceil(totalBars / barsPerSystem);

  const systems: TabSystem[] = [];
  for (let index = 0; index < systemCount; index++) {
    const startBar = index * barsPerSystem;
    const barCount = Math.min(barsPerSystem, totalBars - startBar);
    const top = index * (systemHeight + SYSTEM_GAP);
    systems.push({
      index,
      top,
      height: systemHeight,
      left: LABEL_GUTTER,
      right: LABEL_GUTTER + barCount * barWidth,
      startTick: startBar * perBar,
      endTick: (startBar + barCount) * perBar,
      rowYs: Array.from({ length: rows }, (_, row) => top + SYSTEM_PAD + row * ROW_HEIGHT),
      bars: Array.from({ length: barCount }, (_, bar) => ({
        bar: startBar + bar + 1,
        x: LABEL_GUTTER + bar * barWidth,
        width: barWidth,
      })),
    });
  }

  const glyphs: TabGlyph[] = [];
  let offStaff = 0;

  for (const event of events) {
    const row = rowForString(event.stringIndex, rows);
    // A note on a string this staff hasn't got has nowhere to go. Counted rather
    // than dropped in silence, so the view can say so — the same honesty
    // `FretboardView` applies to notes above the last fret.
    if (row < 0 || row >= rows) {
      offStaff++;
      continue;
    }

    const tick = atLeastZero(event.startTick);
    // `totalBars` already makes room for every event's own start tick, so the index is
    // in range for any pattern this can be handed. Clamped anyway: this is the one
    // dereference in the file that would throw rather than draw something wrong, and
    // a `TypeError` here takes the whole pane down.
    const systemIndex = Math.floor(tick / perBar / barsPerSystem);
    const system = systems[Math.min(systems.length - 1, systemIndex)];
    const x = LABEL_GUTTER + (tick - system.startTick) * pxPerTick;
    const tail = atLeastZero(event.durationTicks) * pxPerTick;

    // A tie always draws its tail: the point of it is that the note carries on, even
    // when the written note is short. Otherwise a tail only appears once it is long
    // enough to read as sustain.
    const wanted = tail >= MIN_TAIL || event.tieToNext === true ? Math.max(MIN_TAIL, tail) : 0;

    glyphs.push({
      id: event.id,
      systemIndex: system.index,
      row,
      x,
      y: system.rowYs[row],
      // Clipped to the closing barline *last*, so the minimum can't push a tail back
      // out past it. A note that rings across the wrap therefore stops at the end of
      // its system and draws no continuation stub at the start of the next one — the
      // one place a reader would want it, and deliberately not built: the head would
      // need an id of its own to stay a stable React key, which is more machinery
      // than a reference view needs.
      tailWidth: Math.max(0, Math.min(wanted, system.right - x)),
      palmMute: event.palmMute === true,
      ...noteParts(event),
    });
  }

  return {
    systems,
    glyphs,
    height: systemCount * systemHeight + (systemCount - 1) * SYSTEM_GAP,
    barWidth,
    barsPerSystem,
    totalBars,
    offStaff,
  };
}
