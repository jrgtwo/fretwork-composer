/**
 * Geometry for the arrangement grid: ticks ↔ pixels at composition scale, where
 * the lanes sit, where a placement's block lands, and what is under the cursor.
 *
 * Separate from `timelineMath` in charter, not in arithmetic — the tick↔pixel
 * conversion, the bar/beat lines, the zoom steps and the snap menu are all
 * imported from there rather than restated. Two copies of a time↔pixel
 * conversion that drift is a silent wrong-note bug, and the two surfaces share a
 * time axis by design (see `tickets/composition-page/README.md`).
 *
 * No React, no DOM, no store. jsdom has no layout — every `getBoundingClientRect`
 * is 0×0 — so geometry is only testable while it is a plain function.
 */
import {
  getInstrument,
  placementEffectiveLength,
  placementEndTick,
  snapTick,
  sortedEvents,
  ticksPerBar,
  ticksPerBeat,
  type Pattern,
  type PatternEvent,
  type PatternTimeSignature,
  type Placement,
  type Tick,
} from '@fretwork/lib';
import {
  DEFAULT_ZOOM_INDEX,
  ZOOM_LEVELS,
  barBeatLines,
  barsSpanned,
  pxToTick,
  snapOptions,
  tickToPx,
  type GridLine,
  type SnapOption,
} from '../timeline/timelineMath';

// `barsSpanned` is re-exported rather than re-homed here because both library
// rails print it and only one of them is on this side of the app — see its note
// in `timelineMath`. Callers already reading arrangement geometry keep reading
// it from one place.
export { barsSpanned, pxToTick, tickToPx };

// ------------------------------------------------------------------- zoom ---

/**
 * Composition-scale zoom, derived from the pattern editor's steps rather than
 * restated, with two coarser levels prepended: a whole song has to fit on
 * screen, and at 12 px/beat a 100-bar arrangement is 4800 px wide.
 *
 * Deliberately a separate list instead of widening `ZOOM_LEVELS` in place:
 * prepending there would silently shift `DEFAULT_ZOOM_INDEX`, and with it the
 * pattern page's default zoom. The values still come from one place.
 */
export const ARRANGEMENT_ZOOM_LEVELS = [3, 6, ...ZOOM_LEVELS] as const;

const COARSE_ZOOM_COUNT = ARRANGEMENT_ZOOM_LEVELS.length - ZOOM_LEVELS.length;

/** Opens at the same px/beat the pattern editor opens at, so switching pages
 *  does not rescale the time axis under the user. */
export const DEFAULT_ARRANGEMENT_ZOOM_INDEX = COARSE_ZOOM_COUNT + DEFAULT_ZOOM_INDEX;

// ------------------------------------------------------------------- snap ---

/**
 * Arrangement gestures snap to the bar, not the 16th. This is the one place the
 * two surfaces intentionally disagree: note entry needs sub-beat resolution,
 * dropping a four-bar riff a 16th late is never what was meant.
 */
export const DEFAULT_ARRANGEMENT_SNAP_ID = 'bar';

/** Resolve a snap id against the same menu the pattern editor offers. Unknown
 *  ids fall back to the bar rather than to the editor's 16th — `snapOptions`
 *  emits the bar first, so `options[0]` IS the arrangement default (pinned by a
 *  test, because that ordering is `timelineMath`'s to change). */
export function arrangementSnap(ts: PatternTimeSignature, snapId: string): SnapOption {
  const options = snapOptions(ts);
  return options.find((option) => option.id === snapId) ?? options[0];
}

/** Quantize a tick to a snap option. A `null` grid (`'off'`) passes through. */
export function snapArrangementTick(tick: Tick, snap: SnapOption | null): Tick {
  if (snap === null || snap.ticks === null) return Math.max(0, Math.round(tick));
  return Math.max(0, snapTick(Math.max(0, tick), snap.ticks));
}

// ------------------------------------------------------------------ ruler ---

/** Every Nth bar gets a stronger line and a printed number when the ruler is
 *  too dense to number every bar. */
export const MAJOR_DIVISION_BARS = 4;

/** Below this, beat lines are closer together than the eye resolves and the
 *  ruler reads as a smear — draw bars only. */
const MIN_BEAT_LINE_PX = 18;

/** Below this bar width, numbering every bar collides; number the majors only. */
const MIN_BAR_LABEL_PX = 44;

export interface RulerMark extends GridLine {
  /** Bar line at a `MAJOR_DIVISION_BARS` boundary — stronger rule. */
  major: boolean;
  /** Printed bar number, or null when this mark is unlabelled. */
  label: string | null;
}

/**
 * Ruler marks across `bars`, built on the pattern editor's `barBeatLines` so the
 * arrangement ruler and the note grid cannot disagree about where beat 3 is.
 *
 * The composition ruler labels BARS, not beats, and thins itself out as it zooms
 * out: beat lines disappear first, then all but every fourth bar number.
 *
 * Constant meter only. `Composition.timeSignatureTrack` exists in the lib and its
 * import pipeline populates it, but nothing in this app writes it and no ticket
 * on the composition-page board reads it; a meter map would have to be walked
 * here (and in `arrangementBars`) exactly as guitar-tutor's `computeBarLines`
 * walks one, or every bar line after the first change lands on the wrong tick.
 */
export function rulerMarks(
  bars: number,
  ts: PatternTimeSignature,
  pxPerBeat: number,
): RulerMark[] {
  // Measured against the REAL spacing, not against pxPerBeat: `tickToPx` divides
  // by PPQ, so pxPerBeat is pixels per QUARTER. In 7/8 the notated beat is half
  // that, and comparing the two directly draws beat lines 12 px apart under an
  // 18 px legibility floor.
  const showBeats = tickToPx(ticksPerBeat(ts), pxPerBeat) >= MIN_BEAT_LINE_PX;
  const labelEveryBar = tickToPx(ticksPerBar(ts), pxPerBeat) >= MIN_BAR_LABEL_PX;
  const marks: RulerMark[] = [];
  for (const line of barBeatLines(bars, ts, pxPerBeat)) {
    if (!line.isBar && !showBeats) continue;
    const major = line.isBar && (line.bar - 1) % MAJOR_DIVISION_BARS === 0;
    marks.push({
      ...line,
      major,
      label: line.isBar && (labelEveryBar || major) ? String(line.bar) : null,
    });
  }
  return marks;
}

// ------------------------------------------------------------------ lanes ---

/**
 * Every arrangement mode, in the order the grid's tabs read.
 *
 * The VALUE is the declaration and {@link ArrangementMode} is derived from it,
 * rather than the other way round, so that anything needing to walk the modes
 * walks a real list. A union alone can only be checked at compile time: a test
 * that hand-writes `['pattern','edit','voice']` beside it is comparing two
 * literals and passes forever, which is exactly how `CommandCatalog.test.ts`'s
 * pin on the catalog's second spelling of this union was toothless under
 * `vitest run` (no typecheck) before this existed.
 */
export const ARRANGEMENT_MODES = ['pattern', 'edit', 'voice'] as const;

/**
 * What a lane draws. The grid itself — ruler, headers, time axis, scroll — is
 * identical in all three; only the lane content and the rail change
 * (`tickets/composition-page/README.md`).
 */
export type ArrangementMode = (typeof ARRANGEMENT_MODES)[number];

// ------------------------------------------------------ per-track views ---

/**
 * Which view each track of ONE composition is showing, keyed by track id.
 *
 * A MISSING entry means `'pattern'`. That is the only spelling of the default —
 * `setTrackView` deletes rather than stores it — so the map names exactly the
 * tracks a user has moved off pattern and two maps showing the same thing are
 * the same map.
 */
export type TrackViews = Readonly<Record<string, ArrangementMode>>;

/**
 * Every composition's track views, keyed by composition id.
 *
 * Keyed by composition first because `CompositionPage` unmounts on every visit
 * to the pattern page and composition A -> B -> A has to come back to the views
 * A was showing, so the map outlives both. `App` owns it for the reason it owns
 * the collapsed racks.
 *
 * SESSION ONLY: nothing here is persisted, and nothing here is PRUNED. A
 * deleted track keeps its entry on purpose — undo restoring that same track id
 * must restore the view it was showing, and an entry pruned on delete is a view
 * silently reset by an undo. Do not copy the collapse-state pruning pattern in
 * here. A stale entry for an id that never returns costs one key for the rest of
 * the session; `viewOf` never reads it.
 */
export type CompositionTrackViews = Readonly<Record<string, TrackViews>>;

/**
 * The view a track is showing.
 *
 * Total and pure: an unknown composition, an unknown track and a track that has
 * never been switched all answer `'pattern'`, because that is what the absence
 * of an entry means.
 */
export function viewOf(
  views: CompositionTrackViews,
  compositionId: string,
  trackId: string,
): ArrangementMode {
  const inner = views[compositionId];
  // `Object.hasOwn` rather than a `??` on the lookup, so an id that collides
  // with something on `Object.prototype` — `toString`, `constructor` — answers
  // `'pattern'` like any other id this map has no entry for, instead of
  // handing back an inherited member typed as a view. Lib-generated track ids
  // never collide; the point is that the "total" above is true without relying
  // on that.
  if (!inner || !Object.hasOwn(inner, trackId)) return 'pattern';
  return inner[trackId];
}

/**
 * One track's view, set immutably.
 *
 * Returns the SAME REFERENCE when the call changes nothing — setting the view a
 * track already has, or clearing one it never had. Every view button click lands
 * here whether or not it changes anything (§2: a view click selects its track
 * even when that view is already active), and the map is identity-compared by
 * its consumers, so a fresh object per click would re-render every lane on a
 * no-op.
 *
 * `'pattern'` DELETES the inner key instead of storing the value, and an emptied
 * inner record drops its composition key: see {@link TrackViews}.
 *
 * A composition id with no entry yet gets one; every other composition's entry
 * is carried over untouched, which is what makes an import or a generated
 * composition a new key rather than a reset.
 *
 * Ids are the lib's, so `__proto__` is not among them. Handed one anyway this
 * stores nothing (the prototype setter rejects a string) and `viewOf` keeps
 * answering `'pattern'` — the two agree, which is what matters; it is only the
 * same-reference no-op above that such an id would slip past.
 */
export function setTrackView(
  views: CompositionTrackViews,
  compositionId: string,
  trackId: string,
  view: ArrangementMode,
): CompositionTrackViews {
  const current = views[compositionId];
  // Asked through `viewOf` rather than re-read here, so the no-op guard and the
  // reader can never disagree about what counts as an entry.
  if (viewOf(views, compositionId, trackId) === view) return views;

  const inner: Record<string, ArrangementMode> = { ...current };
  if (view === 'pattern') delete inner[trackId];
  else inner[trackId] = view;

  const next: Record<string, TrackViews> = { ...views };
  if (Object.keys(inner).length === 0) delete next[compositionId];
  else next[compositionId] = inner;
  return next;
}

/**
 * What the track HEADER needs, and therefore the FLOOR under every lane.
 *
 * ── Why this number is this number (the record, carried forward) ─────────────
 *
 * Pattern mode was 88 until CP-19 added the pan row to the strip. The old figure
 * was chosen so eight tracks plus a ruler fit a laptop viewport, and this costs
 * roughly one of those — accepted knowingly when the alternative was squeezing
 * pan in beside the fader.
 *
 * 104 -> 130 for AU-04's two meter rows, then 130 -> 143 for AF-01's third: the
 * amp drive tap. Neither growth is a decision the user has taken, and the total
 * now costs roughly two tracks of laptop viewport against the pre-meter strip.
 * The cheaper layout is one row carrying every bar, ~13 px instead of ~39 — at
 * the price of the per-tap dB readouts, which are the reason the meters were
 * asked for. Put the trade to the user rather than quietly picking the compact
 * one; CP-19's pan row was settled in a single line that way.
 *
 * ── What it is now ───────────────────────────────────────────────────────────
 *
 * It used to BE pattern mode's lane height, and every other view declared its
 * own number beside it. It is now the FLOOR under every lane in every view:
 * `laneHeightResolver` returns `max(this, content)`, so mute/solo, the fader,
 * pan, the three meter rows and the voice picker always have room beside a lane
 * whatever that lane is drawing. Pattern and a four-string edit lane come out at
 * exactly this; a six-string edit lane and an open voice rack come out taller
 * because their content does.
 */
export const TRACK_HEADER_HEIGHT = 143;

/** The height of the ruler strip. Lanes start below it. */
export const RULER_HEIGHT = 28;

/** Width of the fixed track-header column to the left of the lanes. */
export const TRACK_HEADER_WIDTH = 200;

/** Only the identity is needed to lay a lane out; a lib `Track` satisfies it. */
export interface LaneTrack {
  readonly id: string;
}

/** A track that also carries its content, for hit testing. A lib `Track`
 *  satisfies this too. */
export interface PlacedTrack extends LaneTrack {
  readonly placements: readonly Placement[];
}

export interface LaneRect {
  readonly trackId: string;
  readonly top: number;
  readonly height: number;
}

/**
 * Stack the lanes top to bottom. Rects are half-open (`top <= y < top + height`)
 * so a point on a boundary belongs to exactly one lane — the alternative silently
 * hits two, and the second one wins by iteration order.
 *
 * Coordinates are lane-area content space: y = 0 is the first lane's top, the
 * ruler is not included, and the caller has already undone scroll.
 *
 * `heightOfTrack` is REQUIRED and takes the track alone. There is no mode
 * parameter and no per-mode table any more: with per-track views the stack has
 * no single mode to key one on — a pattern lane, an open voice lane and a
 * four-string edit lane are three heights in one column. `laneHeightResolver`
 * builds the usual callback; a test can pass any function.
 *
 * A height that is not finite falls back to {@link TRACK_HEADER_HEIGHT}, and a
 * negative one clamps to 0. The HEADER is the fallback because a lane whose
 * height cannot be worked out still has to hold its header — mute, solo, the
 * fader, pan, the meters, the picker — rather than collapse to a row that cannot
 * be clicked to fix itself.
 */
export function laneRects(
  tracks: readonly LaneTrack[],
  heightOfTrack: (track: LaneTrack) => number,
): LaneRect[] {
  const rects: LaneRect[] = [];
  let top = 0;
  for (const track of tracks) {
    const raw = heightOfTrack(track);
    const height = Number.isFinite(raw) ? Math.max(0, raw) : TRACK_HEADER_HEIGHT;
    rects.push({ trackId: track.id, top, height });
    top += height;
  }
  return rects;
}

/** Total height of a stack of lanes — the lane area's scrollable content height.
 *  Takes the lowest edge rather than the last entry's: `laneRects` returns them
 *  in order, but callers hand-build lane arrays too. */
export function lanesHeight(lanes: readonly LaneRect[]): number {
  return lanes.reduce((height, lane) => Math.max(height, lane.top + lane.height), 0);
}

/** The lane containing `y`, or null above the first / below the last. */
export function laneAt(lanes: readonly LaneRect[], y: number): LaneRect | null {
  return lanes.find((lane) => y >= lane.top && y < lane.top + lane.height) ?? null;
}

/** A horizontal strip of the lane area that HAS a time axis. Content
 *  coordinates, like `LaneRect` — `top` is measured from the first lane's top. */
export interface TimedBand {
  readonly top: number;
  readonly height: number;
}

/**
 * The strips of the stack a bar line, a beat line or the playhead may be drawn
 * across: every run of adjacent lanes that is not a voice lane, merged.
 *
 * A voice lane draws a rack — knobs, switches, a mic dot — and a line swept over
 * one points at nothing and lands on top of controls. The rack's own opaque
 * background already hides whatever is behind it, but a background is not a
 * reason to DRAW something wrong: bands are what make the time layer say only
 * what is true, so that stacking order stays a second line of defence rather
 * than the only one.
 *
 * BANDS, not one rectangle per lane. With every track timed there is exactly one
 * band spanning the whole stack, which is the element count — and the DOM — the
 * page had before voice became a lane, so the common case costs nothing.
 *
 * Runs are measured from the first lane's `top` to the last one's bottom rather
 * than by summing heights, so a hand-built stack with a gap in it yields one
 * band covering the gap instead of silently splitting. Zero-height runs are
 * dropped: there is nothing to draw in them and an empty layer would still take
 * a key.
 */
export function timedBands(
  lanes: readonly LaneRect[],
  viewOf: (trackId: string) => ArrangementMode,
): TimedBand[] {
  const bands: TimedBand[] = [];
  let open: { top: number; bottom: number } | null = null;
  const close = () => {
    if (open && open.bottom > open.top) bands.push({ top: open.top, height: open.bottom - open.top });
    open = null;
  };
  for (const lane of lanes) {
    if (viewOf(lane.trackId) === 'voice') {
      close();
      continue;
    }
    if (!open) open = { top: lane.top, bottom: lane.top + lane.height };
    else open.bottom = Math.max(open.bottom, lane.top + lane.height);
  }
  close();
  return bands;
}

/**
 * How tall one string row is in an edit-mode lane. THE DECLARATION — a
 * six-string lane's 192 is now a consequence of it rather than its source.
 *
 * It used to be `DEFAULT_LANE_HEIGHTS.edit / 6`, reading the per-view table
 * backwards. With the table gone the direction is the one this module already
 * prefers everywhere else (`ARRANGEMENT_MODES` declares, `ArrangementMode`
 * derives): the ROW PITCH is what CP-04 actually chose, and `editLaneHeight`
 * multiplies it up.
 *
 * ⚠ THE PITCH IS CONSTANT DOWN THE WHOLE STACK, and edit is the one view whose
 * content is NOT stretched to fill a taller lane because of it. A four-string
 * bass lane's content is 4 × 32 = 128 in a {@link TRACK_HEADER_HEIGHT} lane; its
 * rows stay at 32 and the 15 px of slack becomes symmetric padding
 * (`editableSpans`). Grown to 35.75 instead, the bass would read as a different
 * scale from the guitar lane above it and the stack would stop reading as one
 * instrument rack.
 */
export const EDIT_STRING_ROW_PX = 32;

/** Edit-mode CONTENT height for a track drawing `stringCount` strings — what the
 *  string rows need, which is not necessarily what the lane gives them. An
 *  unusable count falls back to the catalog's own default instrument, which is
 *  six strings and so 192. */
export function editLaneHeight(stringCount: number): number {
  if (!Number.isFinite(stringCount)) return FALLBACK_STRING_COUNT * EDIT_STRING_ROW_PX;
  return Math.max(1, Math.floor(stringCount)) * EDIT_STRING_ROW_PX;
}

/**
 * Pattern-mode CONTENT height: the least a block needs to draw anything at all —
 * room for its name, one `MIN_PREVIEW_ROW_PX` row per string, and room for its
 * badges. A MINIMUM, not a target: the block FILLS whatever the lane gives it
 * (`previewMarks` divides the whole band into rows), so this only decides
 * whether pattern could ever out-vote the header. For six strings it is ~48, so
 * it never does — which is the arithmetic behind "pattern is 143 because the
 * header is 143", now derived instead of declared.
 *
 * ⚠ THE TRACK'S NECK, NOT ANY ONE BLOCK'S. `previewMarks` sizes itself from
 * `snapshotNeck(placement)`, which can carry MORE strings than the track's
 * instrument has, so a block can want more than this returns (a 12-string
 * snapshot on a guitar track wants 60). Harmless only while the header wins by
 * the width it does; if this ever became the deciding term it would have to take
 * the max over the track's placements' snapshot necks instead.
 */
export function patternLaneContentHeight(stringCount: number): number {
  const strings = Number.isFinite(stringCount) ? Math.max(1, Math.floor(stringCount)) : FALLBACK_STRING_COUNT;
  return PREVIEW_TOP_PX + strings * MIN_PREVIEW_ROW_PX + PREVIEW_BOTTOM_PX;
}

/**
 * How many string rows a lane draws for an instrument.
 *
 * LIB-GAP(15): the string set a lane DRAWS comes from the track's own
 * instrument, while what SOUNDS comes from the composition's single tuning.
 * These rows are therefore a statement about the neck the part is written on and
 * about nothing else — do not read audibility into them.
 */
export function laneStringCount(instrumentId: string): number {
  return getInstrument(instrumentId)?.stringCount ?? FALLBACK_STRING_COUNT;
}

/**
 * The `heightOfTrack` callback `laneRects` takes, built from the three things a
 * lane's height actually depends on.
 *
 * ── ONE RULE: `max(header, content)` ─────────────────────────────────────────
 *
 * There is no per-view height table any more and no number is hand-chosen for a
 * view. A lane is as tall as the taller of the track HEADER beside it
 * ({@link TRACK_HEADER_HEIGHT}) and the CONTENT inside it, and every figure in
 * use falls out of that: pattern and a four-string edit lane come to 143 because
 * the header wins, a six-string edit lane to 192 and an open voice lane to
 * whatever the rack measures because the content does. A folded voice rack
 * measures short and lands on 143 with no special case of its own — the old
 * `COLLAPSED_VOICE_LANE_HEIGHT` is this rule, not an exception to it.
 *
 * Where the header wins, the content GROWS to fill the lane rather than leaving
 * dead space — `previewMarks` divides the whole band into string rows. Edit is
 * the deliberate exception: its rows keep a constant 32 px pitch and are centred
 * in the lane instead (see `EDIT_STRING_ROW_PX` and `editableSpans`).
 *
 * ── ⚠ MEASURING A RACK IS NOT CP-14 RETURNING ────────────────────────────────
 *
 * This is worth stating, because the constant that used to stand here argued the
 * opposite and the distinction is the whole reason the reversal is safe.
 *
 * CP-14 kept a hand-maintained pixel table that PREDICTED how tall an open rack
 * would come out, and it was ~40 px short because the derivation omitted two
 * rendered rows — which put the cabinet picker below the fold of every open
 * rack, in a place jsdom (no layout) could never fail on. A prediction can
 * disagree with the DOM.
 *
 * `voiceRackHeight` is not a prediction. It is a `ResizeObserver` reading the
 * rack element's own BORDER BOX (`ArrangementGrid`) — the box the browser has
 * just laid out — so it cannot be short of the content by construction, and
 * folding a stage makes the observer fire and the lane follow within the frame.
 *
 * What stays forbidden is exactly what CP-14 did: deriving a voice height from
 * the rack's SECTIONS, from `paramSchema`, or from anything else a user can
 * fold. The moment this computes a rack's height instead of being told one, it
 * is CP-14 again.
 *
 * ── Purity ───────────────────────────────────────────────────────────────────
 *
 * A function rather than a table because every input varies PER TRACK: the view
 * each track is showing, the instrument whose string count an edit lane draws (a
 * bass lane is four rows where a guitar lane is six), and what that track's rack
 * last measured. `laneRects` remains the only thing that may decide where the
 * next lane starts.
 *
 * Pure, and deliberately parameterised by callbacks rather than handed the
 * stores or the DOM: jsdom has no layout, so geometry is only testable while it
 * is a plain function of plain values. THIS never measures anything; it is
 * handed the number.
 */
export function laneHeightResolver({
  viewOf: viewOfTrack,
  instrumentOf,
  voiceRackHeight,
}: {
  viewOf: (trackId: string) => ArrangementMode;
  instrumentOf: (trackId: string) => string;
  /**
   * The last measured border-box height of this track's rack, or 0 when nothing
   * has measured it yet.
   *
   * 0 is "not measured", never "a zero-height lane" — an unmeasured rack simply
   * loses the `max` to the header and the lane opens at
   * {@link TRACK_HEADER_HEIGHT} until the first observation arrives. That is the
   * fallback, and it is the same number a folded rack settles at, so the first
   * frame of an open rack is a short lane rather than a missing one.
   */
  voiceRackHeight: (trackId: string) => number;
}): (track: LaneTrack) => number {
  return (track) => {
    const view = viewOfTrack(track.id);
    return Math.max(TRACK_HEADER_HEIGHT, contentHeight(view, track));
  };

  function contentHeight(view: ArrangementMode, track: LaneTrack): number {
    switch (view) {
      case 'pattern':
        return patternLaneContentHeight(laneStringCount(instrumentOf(track.id)));
      case 'edit':
        return editLaneHeight(laneStringCount(instrumentOf(track.id)));
      case 'voice': {
        const measured = voiceRackHeight(track.id);
        return Number.isFinite(measured) ? Math.max(0, measured) : 0;
      }
      default: {
        // Every view is named above, so a fourth member of `ARRANGEMENT_MODES`
        // fails to compile HERE rather than quietly drawing itself at the
        // header's height — which is a wrong lane nothing on screen announces.
        // The `never` binding is the whole mechanism; returning it keeps the
        // function total (`never` is assignable to `number`).
        const unreachable: never = view;
        return unreachable;
      }
    }
  }
}

// ------------------------------------------------------------- placements ---

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * `repeat` as a drawable count. The lib documents `repeat >= 1` and the new UI
 * writes nothing else, but a legacy or hand-edited composition can carry 0 or a
 * fraction — and a zero-width block cannot be grabbed to fix itself.
 *
 * Shared by `placementRect` and `placementRepeatRects` so the block and its
 * internal divisions can never disagree about where the right edge is. Note
 * `Math.floor(NaN)` is `NaN` and `Math.max(1, NaN)` is `NaN`, so the finiteness
 * check has to come after the floor, not instead of it.
 */
function repeatCount(placement: Placement): number {
  const repeat = Math.floor(placement.repeat);
  return Number.isFinite(repeat) ? Math.max(1, repeat) : 1;
}

/**
 * Where a placement's block draws inside its lane.
 *
 * Length comes from the lib's `placementEffectiveLength`, never from
 * `patternSnapshot.durationTicks`: `lengthTicks` OVERRIDES the snapshot's
 * duration when non-null (a trimmed placement) and `repeat` multiplies it
 * (legacy placements only — the new UI exposes no repeat control). Recomputing
 * that formula here is the exact bug this indirection exists to prevent; for any
 * well-formed placement this is `placementEndTick` exactly, and a test pins it.
 */
export function placementRect(
  placement: Placement,
  pxPerBeat: number,
  laneTop: number,
  laneHeight: number,
): Rect {
  const endTick =
    placement.startTick + placementEffectiveLength(placement) * repeatCount(placement);
  const left = tickToPx(placement.startTick, pxPerBeat);
  return {
    left,
    top: laneTop,
    width: tickToPx(endTick, pxPerBeat) - left,
    height: laneHeight,
  };
}

/**
 * One rect per repetition, left to right. A repeated legacy placement is a
 * single block with internal divisions — the divisions have to land on the
 * repetition boundaries or the block lies about where its pattern restarts.
 */
export function placementRepeatRects(
  placement: Placement,
  pxPerBeat: number,
  laneTop: number,
  laneHeight: number,
): Rect[] {
  const length = placementEffectiveLength(placement);
  const repeats = repeatCount(placement);
  const rects: Rect[] = [];
  for (let i = 0; i < repeats; i++) {
    const startTick = placement.startTick + length * i;
    const left = tickToPx(startTick, pxPerBeat);
    rects.push({
      left,
      top: laneTop,
      width: tickToPx(startTick + length, pxPerBeat) - left,
      height: laneHeight,
    });
  }
  return rects;
}

/**
 * Last tick occupied by any placement on any track. 0 when nothing is placed.
 *
 * LIB-GAP(11): this is the lib's `totalDurationTicks(comp)` done correctly — that
 * one measures a placement as `startTick + patternSnapshot.durationTicks * repeat`
 * and never consults `lengthTicks`, so a trimmed block claims its snapshot's full
 * width and the ruler draws up to 4× too many bars. `compositionService.compositionEndTick`
 * masks the same gap on a whole `Composition`; delete both when the lib's
 * `totalDurationTicks` routes through `placementEndTick`.
 */
export function contentEndTick(tracks: readonly PlacedTrack[]): Tick {
  let end = 0;
  for (const track of tracks) {
    for (const placement of track.placements) {
      end = Math.max(end, placementEndTick(placement));
    }
  }
  return end;
}

/**
 * How many bars the ruler and grid should span: enough to cover the content,
 * never fewer than `minBars`, plus `trailingBars` of empty room to drop into.
 * Without the trailing room there is nowhere to place a block past the end of
 * the arrangement.
 *
 * Constant meter only, for the reason given on `rulerMarks`.
 */
export function arrangementBars(
  tracks: readonly PlacedTrack[],
  ts: PatternTimeSignature,
  opts: { minBars?: number; trailingBars?: number } = {},
): number {
  const { minBars = 1, trailingBars = 0 } = opts;
  const perBar = ticksPerBar(ts);
  const filled = Math.ceil(contentEndTick(tracks) / perBar);
  return Math.max(minBars, filled + trailingBars);
}

// --------------------------------------------------------------- viewport ---

/**
 * Width of the scrollable content, in px. The ruler's and the lane area's are
 * the same number by construction — they share one time axis, and a ruler even a
 * bar wider than the lanes puts bar 40's label past where bar 40 can be drawn.
 *
 * Bars rather than ticks, so the axis always ends on a bar line.
 */
export function arrangementWidth(
  bars: number,
  ts: PatternTimeSignature,
  pxPerBeat: number,
): number {
  return tickToPx(Math.max(0, bars) * ticksPerBar(ts), pxPerBeat);
}

/**
 * Where to scroll to after a zoom so the leftmost visible tick stays put.
 *
 * Zoom that leaves `scrollLeft` alone teleports the view: 960 px in is bar 6 at
 * 48 px/beat and bar 21 at 12. The ratio is exact and deliberately NOT a round
 * trip through `pxToTick`/`tickToPx` — `pxToTick` rounds to whole ticks, and at
 * 3 px/beat one pixel is 160 ticks, so a there-and-back zoom would walk the view
 * a bar to the left every few presses.
 *
 * A non-positive `from` has no anchor to preserve — there is no tick at "0 px per
 * beat" — so the view goes home rather than to NaN or Infinity.
 */
export function zoomAnchoredScrollLeft(
  scrollLeft: number,
  fromPxPerBeat: number,
  toPxPerBeat: number,
): number {
  if (!(fromPxPerBeat > 0) || !Number.isFinite(toPxPerBeat)) return 0;
  if (!Number.isFinite(scrollLeft)) return 0;
  return Math.max(0, scrollLeft) * (toPxPerBeat / fromPxPerBeat);
}

// ------------------------------------------------------------ hit testing ---

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Which part of a block the cursor is over. CP-06 branches on this: the body
 * drags the placement, the edges trim it.
 */
export type HitZone = 'body' | 'trim-start' | 'trim-end';

export type ArrangementHit =
  | {
      readonly kind: 'placement';
      readonly trackId: string;
      readonly placementId: string;
      readonly zone: HitZone;
      /** Unsnapped tick under the cursor — snap belongs to the gesture. */
      readonly tick: Tick;
    }
  | {
      readonly kind: 'lane';
      readonly trackId: string;
      readonly tick: Tick;
    }
  | null;

/** Grab width of a trim edge, in px. */
export const TRIM_HANDLE_PX = 8;

/**
 * What is under `point`, in lane-area content coordinates.
 *
 * Rects are half-open horizontally as well as vertically, so two placements that
 * abut exactly (the common case — the lib cascades placements to prevent
 * overlap) hit as two distinct blocks rather than both claiming the shared edge.
 * Where placements do overlap, the last one wins, matching paint order.
 *
 * An x left of the origin reports the lane at tick 0, exactly as `dropTarget`
 * does — a drag that overshoots the left edge must not have its track evaporate
 * out from under the drop indicator that is still showing it.
 */
export function hitTest(
  point: Point,
  lanes: readonly LaneRect[],
  tracks: readonly PlacedTrack[],
  pxPerBeat: number,
  opts: { trimHandlePx?: number } = {},
): ArrangementHit {
  const lane = laneAt(lanes, point.y);
  if (lane === null) return null;

  const tick = pxToTick(Math.max(0, point.x), pxPerBeat);
  const track = tracks.find((candidate) => candidate.id === lane.trackId);
  if (track === undefined) return { kind: 'lane', trackId: lane.trackId, tick };

  const handle = Math.max(0, opts.trimHandlePx ?? TRIM_HANDLE_PX);
  for (let i = track.placements.length - 1; i >= 0; i--) {
    const placement = track.placements[i];
    const rect = placementRect(placement, pxPerBeat, lane.top, lane.height);
    if (point.x < rect.left || point.x >= rect.left + rect.width) continue;
    return {
      kind: 'placement',
      trackId: lane.trackId,
      placementId: placement.id,
      zone: trimZone(point.x - rect.left, rect.width, handle),
      tick,
    };
  }
  return { kind: 'lane', trackId: lane.trackId, tick };
}

/**
 * How wide a block's trim handle actually is, for a block `width` px across.
 *
 * A block narrower than three handles would be all edge and no body, leaving it
 * undraggable at low zoom; the handles shrink instead so the middle third always
 * drags.
 *
 * Exported because `PlacementBlock` draws the two edge affordances that show
 * where those zones are. Drawing them from a second `Math.min` would let the
 * cursor say "resize" a pixel either side of where a press actually resizes —
 * the sort of disagreement that reads as the app being imprecise rather than as
 * a bug, and so never gets reported.
 */
export function trimHandleWidth(width: number, handlePx: number = TRIM_HANDLE_PX): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  return Math.min(Math.max(0, handlePx), width / 3);
}

function trimZone(offsetX: number, width: number, handlePx: number): HitZone {
  const handle = trimHandleWidth(width, handlePx);
  if (offsetX < handle) return 'trim-start';
  if (offsetX >= width - handle) return 'trim-end';
  return 'body';
}

// ------------------------------------------------------------ drop target ---

export interface DropTarget {
  readonly trackId: string;
  readonly tick: Tick;
}

/**
 * Where a drag from the pattern library would land. `null` outside the lanes —
 * the caller shows no drop indicator rather than guessing a track.
 *
 * The tick is snapped (to the bar by default) because a dropped block that
 * starts a 16th before the downbeat is never what the gesture meant.
 */
export function dropTarget(
  point: Point,
  lanes: readonly LaneRect[],
  pxPerBeat: number,
  snap: SnapOption | null,
): DropTarget | null {
  const lane = laneAt(lanes, point.y);
  if (lane === null) return null;
  return {
    trackId: lane.trackId,
    tick: snapArrangementTick(pxToTick(Math.max(0, point.x), pxPerBeat), snap),
  };
}

// ---------------------------------------------------------------- marquee ---

/** A rubber-band selection rectangle, in lane-area content coordinates. Corners
 *  in either order — the band is normalized before it is used. */
export interface MarqueeBand {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * Ids of every placement the band touches.
 *
 * Geometric rather than DOM-measured, which is the opposite of `Timeline.tsx`'s
 * marquee — that one hit-tests `getBoundingClientRect` on each `[data-note]`.
 * The arrangement already HAS every rect as a pure function of the model, so
 * asking the DOM would be asking a second, slower source that jsdom answers
 * 0×0 to. Here the band test is exactly as testable as the block positions are.
 *
 * Half-open on both axes, matching `hitTest` and `laneRects`: a band whose edge
 * lands exactly on a block's edge does not catch it, so two abutting blocks
 * can be separated by a band drawn along the seam between them.
 */
export function placementsInBand(
  band: MarqueeBand,
  lanes: readonly LaneRect[],
  tracks: readonly PlacedTrack[],
  pxPerBeat: number,
): string[] {
  const left = Math.min(band.left, band.right);
  const right = Math.max(band.left, band.right);
  const top = Math.min(band.top, band.bottom);
  const bottom = Math.max(band.top, band.bottom);

  const ids: string[] = [];
  for (const lane of lanes) {
    if (lane.top >= bottom || lane.top + lane.height <= top) continue;
    const track = tracks.find((candidate) => candidate.id === lane.trackId);
    if (track === undefined) continue;
    for (const placement of track.placements) {
      const rect = placementRect(placement, pxPerBeat, lane.top, lane.height);
      if (rect.left >= right || rect.left + rect.width <= left) continue;
      ids.push(placement.id);
    }
  }
  return ids;
}

// ------------------------------------------------------------- group move ---

/** One placement's position at the moment a drag began: which lane it was in,
 *  and where it started. Captured once, so repeated pointer moves resolve
 *  against the gesture's origin instead of compounding. */
export interface PlacementDragItem {
  readonly id: string;
  /** Index into the lane stack, not a track id — a cross-lane drag is a delta
   *  of ROWS, and only the index makes "one lane down" expressible. */
  readonly trackIndex: number;
  readonly startTick: Tick;
}

/**
 * Where each member of a dragged group should land, and in what order to move
 * them there.
 *
 * Two decisions, both of which look like details and are not:
 *
 * 1. THE CLAMPS ARE SHARED, not per item. Clamping each block against tick 0
 *    and against the ends of the lane stack independently piles the group up
 *    against the wall — the leading block stops and the trailing ones keep
 *    coming, so a drag to the left edge silently collapses a four-bar spread
 *    into a stack. Clamping the DELTA against the extreme member keeps every
 *    relative offset exactly, and the group simply stops moving. Same reasoning
 *    as the group-fret clamp in `patternService.nudgeSelectedFret`.
 *
 * 2. THE ORDER IS BY DESTINATION, farthest-travelled first, ON BOTH AXES. The
 *    lib's `movePlacement` BLOCKS/CLAMPS against whatever is already in the
 *    destination lane — including the group's own members, which are still
 *    sitting at their old positions. Moving a group one bar right leftmost-first
 *    parks block 1 on top of where block 2 still is, and the lib deflects it.
 *    Moving the rightmost first vacates each slot before the next block needs
 *    it. The lib's own `duplicatePlacements` sorts for the same reason.
 *
 *    THE LANE AXIS COMES FIRST, because a purely vertical drag has no tick
 *    delta to order by: dragging two stacked blocks down one lane top-first
 *    lands the upper one on the lower one's old slot and the lib deflects it a
 *    bar sideways — an offset that did not exist before the drag, which is
 *    exactly what "group move preserves relative timing" forbids. Moving the
 *    bottom-most first vacates each lane before the block above it arrives.
 */
export function planGroupMove(
  items: readonly PlacementDragItem[],
  deltaTicks: Tick,
  deltaLanes: number,
  laneCount: number,
): PlacementDragItem[] {
  if (items.length === 0 || laneCount <= 0) return [];

  const ticksWanted = Number.isFinite(deltaTicks) ? Math.round(deltaTicks) : 0;
  const lanesWanted = Number.isFinite(deltaLanes) ? Math.round(deltaLanes) : 0;

  let minStart = Infinity;
  let minLane = Infinity;
  let maxLane = -Infinity;
  for (const item of items) {
    minStart = Math.min(minStart, item.startTick);
    minLane = Math.min(minLane, item.trackIndex);
    maxLane = Math.max(maxLane, item.trackIndex);
  }

  const ticks = Math.max(ticksWanted, -minStart);
  // Upper bound before lower: with a group taller than the stack the lower
  // bound has to win, or the top member would be pushed off the top.
  const lanes = Math.max(-minLane, Math.min(lanesWanted, laneCount - 1 - maxLane));

  return items
    .map((item) => ({
      id: item.id,
      trackIndex: item.trackIndex + lanes,
      startTick: item.startTick + ticks,
    }))
    .sort((a, b) => {
      // Only when the group actually changes lane: with no lane delta nothing
      // vacates a lane for anything else, and ordering by an axis that isn't
      // moving would override the axis that is.
      if (lanes !== 0) {
        const byLane = lanes > 0 ? b.trackIndex - a.trackIndex : a.trackIndex - b.trackIndex;
        if (byLane !== 0) return byLane;
      }
      return ticks > 0 ? b.startTick - a.startTick : a.startTick - b.startTick;
    });
}

// ------------------------------------------------------------- edit mode ---
// Where a lane's editable note surfaces sit, how far a note may be dragged
// inside one, and whether a placement's snapshot has drifted from the library
// pattern it is named after. Pure, like everything else here — the components
// place a surface with these numbers and do no arithmetic of their own.

/**
 * One editable window inside a lane: a placement's own note surface.
 *
 * ⚠ THE DESIGN DECISION CP-11 HAD TO MAKE, recorded here because the alternative
 * is reasonable and somebody will re-litigate it. A lane can hold SEVERAL
 * placements, each with its own snapshot, at different `startTick`s — so either
 * (a) one surface per placement, positioned and clipped to that placement's
 * rect, or (b) one surface per lane taking several patterns with tick offsets.
 *
 * **(a), one surface per placement.** A `NoteSurface` measures every pointer
 * position against its own lanes element and draws every note at
 * `tickToPx(event.startTick)`, so a surface offset to the placement's left edge
 * IS the placement-local tick frame — no offset has to be threaded through any
 * gesture. Under (b) every gesture (stamp, drag, marquee, the typed fret) would
 * have to decide which of several patterns it is acting on, which is the
 * boundary problem moved inside the surface rather than solved.
 *
 * The cost of (a) is that the string rows are drawn once per placement and have
 * to align across them. They do, by construction and not by luck: every surface
 * in a lane is handed the SAME `laneAreaHeight` (the lane's own height) and the
 * SAME `stringCount` (the TRACK's, not the snapshot's), so `laneMetrics` returns
 * the same row pitch for all of them. A snapshot written for another instrument
 * therefore draws on the track's neck and its off-neck strings are not drawn at
 * all — the same honest gap `Timeline` reports as "off-instrument" and
 * `TrackHeader` reports as stranded notes.
 */
export interface EditableSpan {
  readonly placementId: string;
  /**
   * LANE-LOCAL box to draw and clip the surface into — `PlacementBlock`'s
   * frame, for `PlacementBlock`'s reason: the lane element is already
   * positioned.
   *
   * Its HEIGHT is the string rows' content height (`editLaneHeight`), NOT the
   * lane's, and its `top` is the slack between the two, halved. The lane can be
   * taller than its content — a four-string bass lane is 128 of content in a 143
   * lane, because the header wins the `max` — and dividing the whole lane into
   * four rows would put the bass at a 35.75 px pitch beside a guitar lane's 32.
   * The rows keep their pitch and the lane's spare room becomes symmetric
   * padding above and below them. See `EDIT_STRING_ROW_PX`.
   */
  readonly rect: Rect;
  /**
   * How long the window is, in the SNAPSHOT's ticks — nothing may be written
   * past it.
   *
   * It is `placementEffectiveLength`, so a TRIMMED placement's window is shorter
   * than its snapshot: events past the cut still exist, are not played, and are
   * drawn outside the surface's `overflow-hidden` box — invisible, unselectable
   * and undeletable from here. Correct rather than overlooked (they are exactly
   * the notes the trim excluded, and widening the block in pattern mode brings
   * them back), but it is not obvious from the number, so it is written down.
   */
  readonly windowTicks: Tick;
}

/**
 * The editable windows in one track's lane, left to right.
 *
 * Only the FIRST repetition of a legacy repeated placement is editable, and that
 * is deliberate: the later repetitions replay the same snapshot, so editing one
 * would be editing the first at an offset — two ways to write one note. The
 * block still DRAWS its restart divisions in pattern mode.
 *
 * The accepted cost is that repetitions 2..n draw nothing at all in edit mode, so
 * they read as empty lane rather than as "not editable here". Left alone rather
 * than papered over with inert bounded regions: `Placement.repeat` is legacy, the
 * lib's own note says the new arranger hides it, and this app writes nothing but
 * 1 — so the case is reachable only through an imported or hand-edited
 * composition. Revisit if a repeat control is ever exposed.
 *
 * A zero-width span is dropped rather than mounted: a surface with no width has
 * no row to press and no note that can be told from its neighbour, and it would
 * still cost a mounted component per placement.
 *
 * `stringCount` is the TRACK's, and it is what decides the span's height — see
 * {@link EditableSpan.rect}. Passing the lane's own height as the content height
 * was correct only while `editLaneHeight` made every edit lane exactly
 * `32 × strings`; under `max(header, content)` it no longer does.
 */
export function editableSpans(
  track: PlacedTrack,
  pxPerBeat: number,
  laneHeight: number,
  stringCount: number,
): EditableSpan[] {
  const contentHeight = editLaneHeight(stringCount);
  // Negative slack is impossible through `laneHeightResolver` (the lane is the
  // max of the two), but `laneHeight` is a caller's number and a span pushed
  // half its own height above the lane would be worse than a flush one. A
  // non-finite one is the case `Math.max` does NOT catch — `NaN` loses every
  // comparison, so it would come back out and become a `NaN` `rect.top`.
  const offsetTop = Number.isFinite(laneHeight)
    ? Math.max(0, (laneHeight - contentHeight) / 2)
    : 0;
  const spans: EditableSpan[] = [];
  for (const placement of track.placements) {
    const rect = placementRepeatRects(placement, pxPerBeat, offsetTop, contentHeight)[0];
    if (rect === undefined || !(rect.width > 0)) continue;
    const windowTicks = placementEffectiveLength(placement);
    if (!(windowTicks > 0)) continue;
    spans.push({ placementId: placement.id, rect, windowTicks });
  }
  return spans;
}

/**
 * A key that is equal for two structurally identical values whatever order their
 * keys were built in.
 *
 * `JSON.stringify` is not enough on its own: key order follows construction
 * order, and a note stamped fresh inside a placement is built by a different
 * sequence of spreads than the one it was cloned from — so two identical notes
 * would compare different and every placement would report drift forever.
 * `undefined` fields are dropped, because clearing an articulation and never
 * having set it are the same note.
 */
function stableKeyOf(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableKeyOf).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, field]) => field !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, field]) => `${key}:${stableKeyOf(field)}`)
    .join(',')}}`;
}

/**
 * The key for one events array, cached on the array's own identity.
 *
 * `placementDrifted` runs once per placement in a render body, and a note edit
 * writes `library.compositions` — so without this, every pointermove of a note
 * drag re-serialises every event of every placement AND of every library pattern
 * it is compared against. The lib's ops return the SAME array when they leave a
 * pattern's events alone, so identity is exactly the right cache key, and a
 * `WeakMap` means a discarded snapshot takes its entry with it.
 */
const keyCache = new WeakMap<readonly PatternEvent[], string>();

function eventsKey(events: readonly PatternEvent[]): string {
  const cached = keyCache.get(events);
  if (cached !== undefined) return cached;
  const key = stableKeyOf(sortedEvents([...events]));
  keyCache.set(events, key);
  return key;
}

/**
 * Whether a placement's snapshot still says what the library pattern it is named
 * after says.
 *
 * Placement editing is placement-LOCAL by design — the snapshot is deep-copied at
 * placement time and rippling an edit back to the library is explicitly deferred
 * (`tickets/INDEX.md`) — so an edited block keeps a name that is no longer the
 * whole truth. Marking the difference is what stops "Riff A" meaning four
 * different things in one arrangement.
 *
 * EVENTS only. Length is derived from them (`fitPatternDuration`), and name,
 * tempo and voice are settings rather than the material. Events are compared in
 * the lib's own sort order so a re-sorted array is not a difference.
 *
 * A missing source is NOT drift: the pattern has been deleted from the library,
 * and there is nothing left for the block to differ FROM.
 */
export function placementDrifted(placement: Placement, source: Pattern | undefined): boolean {
  if (source === undefined) return false;
  const mine = placement.patternSnapshot.events;
  // The cheap discriminator first: a different note count is drift and needs no
  // serialisation at all, which is the common case on a page full of blocks.
  if (mine.length !== source.events.length) return true;
  return eventsKey(mine) !== eventsKey(source.events);
}

// ----------------------------------------------------------- diagnostics ---
// What a placement COSTS at play time, so the surface can say so before the
// user finds out by ear. Pure, like everything else here — it reads the lib's
// instrument catalog and the placement's own snapshot, nothing else.

/**
 * The lib's own fallback when a placement's snapshot names an instrument the
 * catalog doesn't have (`composition-ops.ts`, `DEFAULT_FRETBOARD_FRET_COUNT`).
 * Not exported by the lib, so it is restated — see the LIB-GAP note below.
 */
const FALLBACK_FRET_COUNT = 22;

/** Six, because the catalog's default instrument is a guitar. Only reached by a
 *  snapshot naming an instrument the catalog doesn't have. */
const FALLBACK_STRING_COUNT = 6;

/**
 * The neck a placement's notes are measured against: the SNAPSHOT's instrument,
 * not the track's, exactly as `flattenTrack` measures it. Those can differ, and
 * using the track's would judge the wrong notes on a mismatched placement.
 */
function snapshotNeck(placement: Placement): { strings: number; frets: number } {
  const instrument = getInstrument(placement.patternSnapshot.instrumentId);
  return {
    strings: instrument?.stringCount ?? FALLBACK_STRING_COUNT,
    frets: instrument?.fretCount ?? FALLBACK_FRET_COUNT,
  };
}

/**
 * The fret an event actually plays at once the placement's transposition is
 * applied, or `null` when the shift pushes it outside `0..fretCount` and
 * `flattenTrack` therefore DROPS it.
 *
 * One rule, two callers — `droppedByTranspose` counts the nulls and
 * `previewMarks` refuses to draw them (and shades its marks by the fret this
 * returns). Stated twice, a preview would eventually show a note the arrangement
 * no longer plays, which is worse than showing none.
 *
 * LIB-GAP(12): this IS the restatement that gap covers — see the full note on
 * `droppedByTranspose`, which is the entry named in docs/FOLLOW-UPS.md. This
 * function, both its callers and BOTH fallback constants disappear together when
 * the lib exposes the diagnostic; the row in docs/FOLLOW-UPS.md names all of them.
 */
function soundingFret(fret: number, transpose: number, fretCount: number): number | null {
  const shifted = fret + transpose;
  return shifted < 0 || shifted > fretCount ? null : shifted;
}

/**
 * How many of the placement's notes a transposition pushes off the neck.
 *
 * `flattenComposition` DROPS any event whose transposed fret leaves
 * `0..fretCount` — silently, at play time, with no trace on screen. A block
 * transposed +7 can therefore go quiet in its top voice and look untouched, and
 * the first sign is a mix that has lost a part.
 *
 * Counted per PATTERN note, not per repetition: "3 notes won't sound" is the
 * fact the user can act on, where a legacy `repeat: 4` block would otherwise
 * report 12 of the same three.
 *
 * The fret range comes from `snapshotNeck` for the reason given there.
 *
 * LIB-GAP(12): this restates a rule the lib already implements and does not
 * expose. `flattenTrack` applies it but is not on the root barrel, and nothing
 * reports which events a placement would lose, so the only alternative is
 * running `flattenComposition` over the whole arrangement on every render and
 * attributing its ids back to placements. Delete when the lib exposes the
 * diagnostic (or exports `flattenTrack`). See docs/FOLLOW-UPS.md.
 */
export function droppedByTranspose(placement: Placement): number {
  const transpose = placement.transposeSemitones ?? 0;
  if (transpose === 0) return 0;
  const { frets } = snapshotNeck(placement);
  const length = placementEffectiveLength(placement);

  let dropped = 0;
  for (const event of placement.patternSnapshot.events) {
    // Events past the truncation point are already not played, so they are not
    // notes the transposition costs.
    if (event.startTick >= length) continue;
    if (soundingFret(event.fret, transpose, frets) === null) dropped++;
  }
  return dropped;
}

// -------------------------------------------------------- block preview ---
// A miniature of a placement's notes, drawn inside its own block so a wall of
// identically-sized rectangles reads as music. Non-interactive by construction:
// it returns rects and nothing else, and `hitTest` never consults it.

/**
 * NOT greenfield: guitar-tutor already shipped this drawing as
 * `src/patterns/arranger/MiniPatternSignature.tsx`, and its approach is what is
 * ported here — one `<svg preserveAspectRatio="none">` per block, one row per
 * string in REVERSE `stringIndex` order, a minimum mark width so a short note
 * still shows, events at or past the effective length dropped and a straddling
 * event's duration clipped to it. Three deliberate divergences:
 *
 *  - the time axis is the arrangement's `tickToPx`, not the pattern's duration
 *    normalised to a fixed 100×28 box, so a placement's notes line up with the
 *    ruler and with every other block at the same zoom;
 *  - `repeat` is honoured (that component drew one snapshot, always);
 *  - its six per-string guide `<line>`s are NOT drawn. That is a decision, not
 *    an oversight: they are 6 more nodes on every block on a page that can carry
 *    hundreds, and six of them behind the marks read as a grey wash behind the
 *    name rather than as strings. A preview with notes on only two strings
 *    therefore floats, which is the accepted cost. (The strip is no longer the
 *    ~32 px this originally measured — it fills the block's whole band now — so
 *    it is worth re-judging by eye rather than re-deciding from this note.)
 *
 * The two in-repo reuse candidates were checked and neither fits:
 *
 *  - `src/reference/patternCells.ts` is fretboard-oriented — `footprintCellsFor`
 *    and friends return cells on a NECK. There is no time axis in them at all.
 *  - `src/reference/tabLayout.ts` is a full tablature renderer with systems,
 *    bars, glyphs and stems, and it WRAPS into systems. A preview that wraps
 *    inside a block is not a preview.
 *
 * What is reused is the part that could drift: the tick→px mapping and the
 * repetition rects are `tickToPx` and `placementRepeatRects`, so a mark can
 * never land somewhere its block does not cover.
 */
export interface PreviewMark extends Rect {
  /** The snapshot event drawn. Not unique on its own — a repeated placement
   *  draws the same event once per repetition. */
  readonly eventId: string;
  /** Which repetition this mark belongs to, 0-based. */
  readonly repeat: number;
  /**
   * How far up the neck the note SOUNDS, as a fill opacity in
   * `PREVIEW_OPACITY_MIN..PREVIEW_OPACITY_MAX` — open strings faintest, the last
   * fret fullest.
   *
   * The one non-geometric field here, and it earns its place: the lib transposes
   * FRETS and leaves `stringIndex` alone, so without it a placement at +5 whose
   * notes all stay on the neck would draw a pixel-identical preview to the
   * untransposed one and the drawing would be silent about the single edit most
   * likely to have changed what it shows. It is resolved here rather than in the
   * component for the same reason the rects are: the component does no
   * arithmetic, so the value it applies is the value the tests pin.
   */
  readonly opacity: number;
}

/**
 * Narrower than this and a repetition is all trim handle and no readable
 * content — 3 × `TRIM_HANDLE_PX` is exactly the width at which `trimHandleWidth`
 * stops shrinking the handles and a middle third exists to draw into. Below it
 * the preview draws NOTHING rather than a smear; the block keeps its label.
 */
export const MIN_PREVIEW_WIDTH = 3 * TRIM_HANDLE_PX;

/** A string row thinner than this cannot show a gap between itself and its
 *  neighbour, so six of them read as one grey bar rather than as six strings.
 *  The floor is per string, so a four-string bass previews in a shorter strip
 *  than a six-string guitar does — which is correct, not a coincidence. */
export const MIN_PREVIEW_ROW_PX = 2;

/**
 * Vertical room the block's own chrome needs: the name across the top, the
 * transpose and dropped-note badges across the bottom. The preview is
 * SUBORDINATE to both — it may not overlap either, so these are subtracted
 * before anything is drawn rather than trusted to z-order.
 *
 * Both are the rendered line boxes of `PlacementBlock`'s two rows plus its
 * `py-1` (4 px). Neither `text-[9.5px]` nor `text-[8px]` sets a line height, so
 * both inherit the sheet's `line-height: 1.55` (src/styles/index.css): the name
 * is 9.5 × 1.55 + 4 ≈ 18.7 and the badge row is 8 × 1.55 + 4 ≈ 16.4, rounded UP
 * — an under-reserve puts the top string row under the name at the height
 * threshold, where the strip fills the band exactly.
 *
 * They live here rather than in the component because the component is not
 * allowed to do pixel arithmetic — that rule is why this module exists.
 */
const PREVIEW_TOP_PX = 19;
const PREVIEW_BOTTOM_PX = 17;

/** Blank space above and below each mark inside its row, so adjacent strings
 *  stay legible as separate rows. Exported because the row pitch a caller (or a
 *  test) can observe is `mark.height + 2 × this`, and restating the literal is
 *  how an assertion quietly stops testing what it names.
 *
 *  ⚠ CHOSEN AGAINST THE CAPPED STRIP and not re-judged since: 0.5 was 9% of the
 *  5.33 px pitch a 32 px strip gave six strings, and it is 2.8% of the ~17.8 the
 *  filled band gives them. Six sustained notes may now read as one slab rather
 *  than six rows. A look question, so it is on milestone 2's browser checklist
 *  (item 5) rather than guessed at here; the fix if it shows is a PROPORTIONAL
 *  gap (`rowHeight × 0.08`, floored at this), not the cap back. `previewMarks`'
 *  "positive by construction" argument holds either way. */
export const PREVIEW_ROW_GAP_PX = 0.5;

/** A 16th note at the coarsest zoom is under a pixel wide. Marks get a floor so
 *  a fast passage reads as notes rather than as nothing. */
const MIN_MARK_PX = 1.5;

/** The horizontal counterpart of `PREVIEW_ROW_GAP_PX`, and the reason it exists
 *  is `MIN_MARK_PX`: the floor is the one thing here that can draw a mark WIDER
 *  than the distance to the next onset on its string, i.e. fabricate an overlap
 *  the music has not got. `previewMarks` refuses to draw at all when the tightest
 *  onset spacing on any one string falls below `MIN_MARK_PX + this`, so the floor
 *  can never do that and two consecutive short notes always show daylight. */
const PREVIEW_MARK_GAP_PX = 0.5;

/** The fill opacity of a mark at fret 0 and at the neck's last fret. The span is
 *  narrow on purpose: the preview is SUBORDINATE to the block's name and to its
 *  selected fill, so the shading has to be readable as a gradient across a phrase
 *  without any single mark reading as a second label. */
const PREVIEW_OPACITY_MIN = 0.55;
const PREVIEW_OPACITY_MAX = 1;

/**
 * Where every note of a placement draws INSIDE its own block, in block-local
 * pixels — (0, 0) is the block's top-left corner, so the caller applies these
 * verbatim to one `<svg>` laid over the block.
 *
 * The preview shows what will PLAY, which is three separate obligations:
 *
 *  - `lengthTicks` TRUNCATION. Events at or past `placementEffectiveLength` are
 *    not emitted by `flattenComposition`, so they are not drawn; an event
 *    straddling the cut has its mark clipped exactly as the lib clips its
 *    duration. A trimmed block therefore draws nothing past its right edge.
 *  - `transposeSemitones`. The lib shifts FRETS, not strings, so a transposition
 *    moves no mark vertically — the axis here is the string, and the string is
 *    what does not change. It changes the marks in two other ways: notes shifted
 *    off `0..fretCount` are dropped from playback (LIB-GAP(12)) and are dropped
 *    here by the same `soundingFret` rule `droppedByTranspose` counts them with,
 *    and every surviving mark's `opacity` is taken from its SOUNDING fret, so a
 *    transposition that keeps every note on the neck still visibly moves.
 *  - `repeat`. A repeated legacy placement replays its snapshot, so the marks
 *    repeat too, once per rect from `placementRepeatRects`.
 *
 * ONE exception to "what will play", inherited from `placementRect` so that the
 * marks cannot leave their block: repetitions are counted with `repeatCount`
 * (floored, minimum 1) where `flattenTrack` loops on the raw `repeat`. A
 * malformed `repeat: 0` therefore draws one set of marks and plays none, and
 * `repeat: 2.5` draws two where three sound. The new UI writes neither.
 *
 * Row order is the REVERSE of `stringIndex`: index 0 is the low E, which is the
 * physically bottom string, and every display in this app draws the high string
 * on top (`ROW_ORDER` in `Timeline.tsx` is the authority). Inverted, every note
 * lands on the wrong string and at this scale still looks entirely plausible.
 *
 * Returns `[]` — draw nothing at all — when a repetition is too narrow, the strip
 * too short for the instrument's strings, or the notes too dense at this zoom to
 * stay apart. Mush that implies notes that aren't there is worse than an
 * unadorned block.
 */
export function previewMarks(
  placement: Placement,
  pxPerBeat: number,
  blockHeight: number,
): PreviewMark[] {
  if (!(pxPerBeat > 0) || !Number.isFinite(pxPerBeat) || !Number.isFinite(blockHeight)) return [];

  const { strings, frets } = snapshotNeck(placement);
  if (!(strings > 0)) return [];

  // THE STRIP IS THE WHOLE BAND. It used to be capped at 32 px total — ~5.3 px
  // per string in a 143 px lane — on the reasoning that a preview taller than
  // that competes with the block's name; that reasoning was written when a
  // pattern lane was 88 px tall. Under `max(header, content)` the block is given
  // a lane the header's size and the content FILLS it rather than floating in
  // the middle of it. The name and the badges are still not competed with: their
  // rows are subtracted out first, which is what `PREVIEW_TOP_PX` and
  // `PREVIEW_BOTTOM_PX` are.
  const stripHeight = blockHeight - PREVIEW_TOP_PX - PREVIEW_BOTTOM_PX;
  if (stripHeight < strings * MIN_PREVIEW_ROW_PX) return [];
  const stripTop = PREVIEW_TOP_PX;
  const rowHeight = stripHeight / strings;
  // Positive by construction: the row floor above is wider than both gaps, so
  // there is no clamp here and no case where one would silently fire.
  const markHeight = rowHeight - 2 * PREVIEW_ROW_GAP_PX;

  const length = placementEffectiveLength(placement);
  if (!(length > 0)) return [];

  // Lane-local rects, one per repetition, taken from the same function the block
  // draws its restart divisions from. Rebased to the block's own left edge here
  // and not in the component, which does no arithmetic.
  const repeats = placementRepeatRects(placement, pxPerBeat, 0, blockHeight);
  const originX = tickToPx(placement.startTick, pxPerBeat);
  // Every repetition is the same width, so the first one decides for all of
  // them. Testing the REPETITION rather than the whole block is what keeps a
  // legacy `repeat: 16` from drawing sixteen unreadable smears in a wide block —
  // and it bounds the mark count, since repetitions cannot be narrower than this.
  if (repeats.length === 0 || repeats[0].width < MIN_PREVIEW_WIDTH) return [];

  const transpose = placement.transposeSemitones ?? 0;

  // Resolved ONCE, not once per repetition: which events survive to be drawn,
  // and everything about each that does not depend on which repetition it is in.
  const drawable: { event: PatternEvent; row: number; opacity: number }[] = [];
  for (const event of placement.patternSnapshot.events) {
    if (!(event.startTick >= 0) || event.startTick >= length) continue;
    // Display order, reversed. Out of range means the snapshot carries more
    // strings than its instrument has — draw nothing rather than a mark clamped
    // onto a string that isn't the note's.
    const row = strings - 1 - event.stringIndex;
    if (row < 0 || row >= strings) continue;
    const fret = soundingFret(event.fret, transpose, frets);
    if (fret === null) continue;
    const upTheNeck = frets > 0 ? Math.min(Math.max(fret / frets, 0), 1) : 0;
    drawable.push({
      event,
      row,
      opacity: PREVIEW_OPACITY_MIN + upTheNeck * (PREVIEW_OPACITY_MAX - PREVIEW_OPACITY_MIN),
    });
  }

  // Trap 3 on the OTHER axis: the width thresholds above bound the block, not the
  // notes in it, and at 6 px/beat — a real zoom level — a 16th is exactly
  // `MIN_MARK_PX`, so a 16th line draws as one solid bar and a 32nd run draws
  // marks wider than the space between their onsets. Measured per STRING because
  // marks in different rows cannot collide however close their onsets are.
  if (tickToPx(tightestOnsetGap(drawable), pxPerBeat) < MIN_MARK_PX + PREVIEW_MARK_GAP_PX) {
    return [];
  }

  const marks: PreviewMark[] = [];
  for (let repeat = 0; repeat < repeats.length; repeat++) {
    const rect = repeats[repeat];
    const base = rect.left - originX;
    for (const { event, row, opacity } of drawable) {
      const left = base + tickToPx(event.startTick, pxPerBeat);
      const clipped = Math.min(Math.max(event.durationTicks, 0), length - event.startTick);
      marks.push({
        eventId: event.id,
        repeat,
        opacity,
        left,
        top: stripTop + row * rowHeight + PREVIEW_ROW_GAP_PX,
        // Clamped to THIS repetition's right edge, not the block's: a note held
        // over the loop point does not sound into the next repetition, so it
        // must not be drawn there either. Doubles as the guarantee that no mark
        // escapes the block's rounded corners.
        width: Math.min(Math.max(tickToPx(clipped, pxPerBeat), MIN_MARK_PX), base + rect.width - left),
        height: markHeight,
      });
    }
  }
  return marks;
}

/**
 * The smallest tick distance between two DISTINCT onsets sharing a string,
 * `Infinity` when no string carries two. Simultaneous notes (a chord, or a
 * doubled event) are a distance of 0 and are excluded: they are one mark drawn
 * over another, not two marks that read as a smear.
 */
function tightestOnsetGap(drawable: readonly { event: PatternEvent; row: number }[]): number {
  const byRow = new Map<number, number[]>();
  for (const { event, row } of drawable) {
    const onsets = byRow.get(row);
    if (onsets) onsets.push(event.startTick);
    else byRow.set(row, [event.startTick]);
  }

  let tightest = Number.POSITIVE_INFINITY;
  for (const onsets of byRow.values()) {
    onsets.sort((a, b) => a - b);
    for (let i = 1; i < onsets.length; i++) {
      const gap = onsets[i] - onsets[i - 1];
      if (gap > 0 && gap < tightest) tightest = gap;
    }
  }
  return tightest;
}
