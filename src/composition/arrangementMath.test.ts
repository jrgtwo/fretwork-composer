import {
  PPQ,
  createEmptyPattern,
  placementEffectiveLength,
  placementEndTick,
  ticksPerBar,
  type PatternEvent,
  type PatternTimeSignature,
  type Placement,
} from '@fretwork/lib';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ZOOM_INDEX, ZOOM_LEVELS, snapOptions } from '../timeline/timelineMath';
import {
  ARRANGEMENT_ZOOM_LEVELS,
  DEFAULT_ARRANGEMENT_SNAP_ID,
  DEFAULT_ARRANGEMENT_ZOOM_INDEX,
  DEFAULT_LANE_HEIGHTS,
  MAJOR_DIVISION_BARS,
  MIN_PREVIEW_ROW_PX,
  MIN_PREVIEW_WIDTH,
  PREVIEW_ROW_GAP_PX,
  TRIM_HANDLE_PX,
  arrangementBars,
  arrangementSnap,
  arrangementWidth,
  barsSpanned,
  contentEndTick,
  droppedByTranspose,
  dropTarget,
  hitTest,
  laneAt,
  laneRects,
  lanesHeight,
  placementRect,
  placementRepeatRects,
  placementsInBand,
  planGroupMove,
  previewMarks,
  pxToTick,
  rulerMarks,
  snapArrangementTick,
  tickToPx,
  trimHandleWidth,
  zoomAnchoredScrollLeft,
  type ArrangementMode,
  type PlacedTrack,
  type PlacementDragItem,
  type PreviewMark,
} from './arrangementMath';

const TS_4_4: PatternTimeSignature = { numerator: 4, denominator: 4 };
const TS_3_4: PatternTimeSignature = { numerator: 3, denominator: 4 };
const TS_7_8: PatternTimeSignature = { numerator: 7, denominator: 8 };

const MODES: ArrangementMode[] = ['pattern', 'edit', 'voice'];

/** A placement whose snapshot has a real duration, so trimming and repeating are
 *  distinguishable from the untouched case. */
function placement(over: Partial<Placement> & { id: string }): Placement {
  const snapshot = createEmptyPattern('riff');
  return {
    patternSnapshot: { ...snapshot, durationTicks: 4 * PPQ },
    startTick: 0,
    repeat: 1,
    transposeSemitones: 0,
    lengthTicks: null,
    ...over,
  };
}

function track(id: string, placements: Placement[] = []): PlacedTrack {
  return { id, placements };
}

/** Deterministic pseudo-random so a failure is reproducible; property tests here
 *  are about covering the space, not about randomness. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('zoom', () => {
  it('extends the pattern editor steps downward without restating them', () => {
    expect(ARRANGEMENT_ZOOM_LEVELS.slice(-ZOOM_LEVELS.length)).toEqual([...ZOOM_LEVELS]);
    expect([...ARRANGEMENT_ZOOM_LEVELS]).toEqual([...ARRANGEMENT_ZOOM_LEVELS].sort((a, b) => a - b));
  });

  it('has coarser levels than the pattern editor offers', () => {
    expect(ARRANGEMENT_ZOOM_LEVELS[0]).toBeLessThan(ZOOM_LEVELS[0]);
  });

  // The whole reason the arrangement keeps its own index: prepending levels to
  // ZOOM_LEVELS would have silently moved the pattern page's default.
  it('opens at the same px/beat as the pattern editor', () => {
    expect(ARRANGEMENT_ZOOM_LEVELS[DEFAULT_ARRANGEMENT_ZOOM_INDEX]).toBe(
      ZOOM_LEVELS[DEFAULT_ZOOM_INDEX],
    );
  });
});

describe('tick ↔ px round trip', () => {
  it.each(ARRANGEMENT_ZOOM_LEVELS.map((z) => [z]))(
    'pxToTick(tickToPx(t)) returns t at %i px/beat',
    (pxPerBeat) => {
      const random = lcg(pxPerBeat);
      for (let i = 0; i < 200; i++) {
        // Ticks on the 32nd grid — the finest thing the snap menu offers.
        const tick = Math.round(random() * 400) * (PPQ / 8);
        expect(pxToTick(tickToPx(tick, pxPerBeat), pxPerBeat)).toBe(tick);
      }
    },
  );

  // An arbitrary pixel lands between two ticks, so it cannot round-trip exactly —
  // but pxToTick rounds to the NEAREST tick, so the error is at most half a
  // tick's worth of pixels. Stated in ticks, not in a flat half-pixel: even at
  // the widest zoom a tick is 0.4 px, so a half-pixel slack would tolerate a
  // whole tick of error (and pass a `Math.floor` implementation at every zoom).
  it.each(ARRANGEMENT_ZOOM_LEVELS.map((z) => [z]))(
    'tickToPx(pxToTick(x)) stays within half a tick at %i px/beat',
    (pxPerBeat) => {
      const random = lcg(pxPerBeat + 7);
      const tolerance = tickToPx(0.5, pxPerBeat) + 1e-9;
      for (let i = 0; i < 200; i++) {
        const px = random() * 5000;
        expect(
          Math.abs(tickToPx(pxToTick(px, pxPerBeat), pxPerBeat) - px),
        ).toBeLessThanOrEqual(tolerance);
      }
    },
  );
});

describe('snap', () => {
  it('defaults to the bar, not the pattern editor 16th', () => {
    expect(DEFAULT_ARRANGEMENT_SNAP_ID).toBe('bar');
    expect(arrangementSnap(TS_4_4, DEFAULT_ARRANGEMENT_SNAP_ID).ticks).toBe(ticksPerBar(TS_4_4));
  });

  it.each([
    ['4/4', TS_4_4],
    ['3/4', TS_3_4],
    ['7/8', TS_7_8],
  ])('bar snapping follows the %s meter', (_label, ts) => {
    const bar = arrangementSnap(ts, 'bar');
    const random = lcg(11);
    for (let i = 0; i < 200; i++) {
      const raw = Math.round(random() * 20000);
      const snapped = snapArrangementTick(raw, bar);
      expect(snapped % ticksPerBar(ts)).toBe(0);
      // Nearest, so never more than half a bar away.
      expect(Math.abs(snapped - raw)).toBeLessThanOrEqual(ticksPerBar(ts) / 2);
    }
  });

  it('resolves every id the pattern editor offers', () => {
    for (const option of snapOptions(TS_4_4)) {
      expect(arrangementSnap(TS_4_4, option.id)).toEqual(option);
    }
  });

  it('falls back to the bar for an unknown id rather than to the editor default', () => {
    expect(arrangementSnap(TS_4_4, 'nonsense').id).toBe('bar');
  });

  // arrangementSnap's fallback is `options[0]`, which is only the bar because
  // snapOptions puts it first. That ordering belongs to timelineMath, so pin it
  // here rather than leaving an unreachable second fallback behind to guard it.
  it('relies on snapOptions offering the bar first', () => {
    for (const ts of [TS_4_4, TS_3_4, TS_7_8]) {
      expect(snapOptions(ts)[0].id).toBe(DEFAULT_ARRANGEMENT_SNAP_ID);
    }
  });

  it('passes ticks through when snapping is off, and never returns a negative tick', () => {
    const off = arrangementSnap(TS_4_4, 'off');
    expect(off.ticks).toBeNull();
    expect(snapArrangementTick(1234, off)).toBe(1234);
    expect(snapArrangementTick(1234, null)).toBe(1234);
    expect(snapArrangementTick(-500, off)).toBe(0);
    expect(snapArrangementTick(-500, arrangementSnap(TS_4_4, 'bar'))).toBe(0);
  });
});

describe('ruler marks', () => {
  it('places every mark at its own tick', () => {
    for (const ts of [TS_4_4, TS_3_4, TS_7_8]) {
      for (const pxPerBeat of ARRANGEMENT_ZOOM_LEVELS) {
        for (const mark of rulerMarks(8, ts, pxPerBeat)) {
          expect(mark.x).toBeCloseTo(tickToPx(mark.tick, pxPerBeat), 9);
          expect(mark.tick).toBe(
            (mark.bar - 1) * ticksPerBar(ts) + (mark.beat - 1) * (ticksPerBar(ts) / ts.numerator),
          );
        }
      }
    }
  });

  it('labels bars, never beats', () => {
    for (const pxPerBeat of ARRANGEMENT_ZOOM_LEVELS) {
      for (const mark of rulerMarks(16, TS_4_4, pxPerBeat)) {
        if (mark.label !== null) {
          expect(mark.isBar).toBe(true);
          expect(mark.label).toBe(String(mark.bar));
        }
      }
    }
  });

  it('marks every fourth bar major, at every zoom and meter', () => {
    for (const ts of [TS_4_4, TS_3_4, TS_7_8]) {
      for (const pxPerBeat of ARRANGEMENT_ZOOM_LEVELS) {
        for (const mark of rulerMarks(16, ts, pxPerBeat)) {
          expect(mark.major).toBe(mark.isBar && (mark.bar - 1) % MAJOR_DIVISION_BARS === 0);
        }
      }
    }
  });

  it('keeps every bar line at every zoom, and thins beats out as it zooms out', () => {
    const bars = 16;
    const barsAt = (pxPerBeat: number) =>
      rulerMarks(bars, TS_4_4, pxPerBeat).filter((mark) => mark.isBar).length;
    const beatsAt = (pxPerBeat: number) =>
      rulerMarks(bars, TS_4_4, pxPerBeat).filter((mark) => !mark.isBar).length;

    for (const pxPerBeat of ARRANGEMENT_ZOOM_LEVELS) expect(barsAt(pxPerBeat)).toBe(bars);
    // Monotone: no zoom level shows fewer beat lines than a coarser one.
    for (let i = 1; i < ARRANGEMENT_ZOOM_LEVELS.length; i++) {
      expect(beatsAt(ARRANGEMENT_ZOOM_LEVELS[i])).toBeGreaterThanOrEqual(
        beatsAt(ARRANGEMENT_ZOOM_LEVELS[i - 1]),
      );
    }
    expect(beatsAt(ARRANGEMENT_ZOOM_LEVELS[0])).toBe(0);
    expect(beatsAt(ZOOM_LEVELS[DEFAULT_ZOOM_INDEX])).toBe(bars * (TS_4_4.numerator - 1));
  });

  it('drops all but the major bar numbers when bars get too narrow to label', () => {
    const labelled = (pxPerBeat: number) =>
      rulerMarks(16, TS_4_4, pxPerBeat).filter((mark) => mark.label !== null);
    expect(labelled(3).every((mark) => mark.major)).toBe(true);
    expect(labelled(3)).toHaveLength(16 / MAJOR_DIVISION_BARS);
    expect(labelled(ZOOM_LEVELS[DEFAULT_ZOOM_INDEX])).toHaveLength(16);
  });

  // pxPerBeat is pixels per QUARTER (tickToPx divides by PPQ), so in 7/8 the
  // notated beat is half of it and a bar is 3.5× it. Comparing pxPerBeat itself
  // against the legibility floors — as if every meter were /4 — smears the ruler
  // at exactly the zooms those floors exist to prevent.
  it('measures density by real spacing, not by pxPerBeat, in a /8 meter', () => {
    const beats = (pxPerBeat: number) =>
      rulerMarks(16, TS_7_8, pxPerBeat).filter((mark) => !mark.isBar).length;
    const labelled = (pxPerBeat: number) =>
      rulerMarks(16, TS_7_8, pxPerBeat).filter((mark) => mark.label !== null);

    // 24 px per quarter is 12 px per notated beat — under the beat-line floor.
    expect(beats(24)).toBe(0);
    expect(beats(48)).toBe(16 * (TS_7_8.numerator - 1));
    // 12 px per quarter is a 42 px bar — too narrow to number every bar.
    expect(labelled(12).every((mark) => mark.major)).toBe(true);
    expect(labelled(12)).toHaveLength(16 / MAJOR_DIVISION_BARS);
    expect(labelled(24)).toHaveLength(16);
  });

  it('returns nothing for zero bars', () => {
    expect(rulerMarks(0, TS_4_4, 48)).toEqual([]);
  });
});

describe('lane rects', () => {
  const tracks = [track('a'), track('b'), track('c')];

  it.each(MODES.map((m) => [m]))('stacks lanes with no gap and no overlap in %s mode', (mode) => {
    const lanes = laneRects(tracks, mode);
    expect(lanes.map((lane) => lane.trackId)).toEqual(['a', 'b', 'c']);
    expect(lanes[0].top).toBe(0);
    for (let i = 1; i < lanes.length; i++) {
      expect(lanes[i].top).toBe(lanes[i - 1].top + lanes[i - 1].height);
    }
    expect(lanesHeight(lanes)).toBe(lanes.reduce((sum, lane) => sum + lane.height, 0));
  });

  it('uses the height for the mode it was given', () => {
    for (const mode of MODES) {
      expect(laneRects([track('a')], mode)[0].height).toBe(DEFAULT_LANE_HEIGHTS[mode]);
    }
  });

  it('takes per-mode overrides', () => {
    expect(laneRects(tracks, 'pattern', { pattern: 40 }).map((lane) => lane.top)).toEqual([
      0, 40, 80,
    ]);
    // An override for another mode is ignored, not applied.
    expect(laneRects(tracks, 'pattern', { edit: 40 })[0].height).toBe(
      DEFAULT_LANE_HEIGHTS.pattern,
    );
  });

  it('takes a per-track resolver, because edit-mode lanes vary by string count', () => {
    const lanes = laneRects(tracks, 'edit', (t) => (t.id === 'b' ? 100 : 50));
    expect(lanes.map((lane) => ({ top: lane.top, height: lane.height }))).toEqual([
      { top: 0, height: 50 },
      { top: 50, height: 100 },
      { top: 150, height: 50 },
    ]);
  });

  it('falls back to the mode default rather than producing a NaN lane', () => {
    expect(laneRects([track('a')], 'pattern', () => Number.NaN)[0].height).toBe(
      DEFAULT_LANE_HEIGHTS.pattern,
    );
    expect(laneRects([track('a')], 'pattern', () => -10)[0].height).toBe(0);
  });

  // lanesHeight is exported and callers hand-build lane arrays (the orphan-lane
  // case below does), so it must not assume the last entry is the lowest.
  it('reports the lowest edge of an unordered lane array', () => {
    expect(
      lanesHeight([
        { trackId: 'b', top: 100, height: 40 },
        { trackId: 'a', top: 0, height: 40 },
      ]),
    ).toBe(140);
  });

  it('handles no tracks and the eight-track cap', () => {
    expect(laneRects([], 'pattern')).toEqual([]);
    expect(lanesHeight([])).toBe(0);
    const eight = Array.from({ length: 8 }, (_, i) => track(`t${i}`));
    expect(lanesHeight(laneRects(eight, 'pattern'))).toBe(8 * DEFAULT_LANE_HEIGHTS.pattern);
  });

  // Half-open rects: a y on a boundary belongs to exactly one lane. Closed rects
  // hit two, and which one wins is iteration order — a coin flip, per pixel.
  it('assigns every y inside the stack to exactly one lane', () => {
    const lanes = laneRects(tracks, 'pattern');
    const total = lanesHeight(lanes);
    for (let y = 0; y < total; y++) {
      const hits = lanes.filter((lane) => y >= lane.top && y < lane.top + lane.height);
      expect(hits).toHaveLength(1);
      expect(laneAt(lanes, y)).toBe(hits[0]);
    }
    expect(laneAt(lanes, -1)).toBeNull();
    expect(laneAt(lanes, total)).toBeNull();
  });
});

describe('placement rects', () => {
  const pxPerBeat = ZOOM_LEVELS[DEFAULT_ZOOM_INDEX];

  const cases: [string, Placement][] = [
    ['plain', placement({ id: 'p', startTick: 4 * PPQ })],
    // lengthTicks OVERRIDES the snapshot duration — it does not add to it.
    ['trimmed', placement({ id: 'p', startTick: 4 * PPQ, lengthTicks: PPQ })],
    ['trimmed longer than the snapshot', placement({ id: 'p', lengthTicks: 16 * PPQ })],
    ['repeated', placement({ id: 'p', startTick: 2 * PPQ, repeat: 3 })],
    ['trimmed and repeated', placement({ id: 'p', lengthTicks: 2 * PPQ, repeat: 4 })],
  ];

  it.each(cases)('spans start → placementEndTick for a %s placement', (_label, p) => {
    for (const zoom of ARRANGEMENT_ZOOM_LEVELS) {
      const rect = placementRect(p, zoom, 30, 88);
      expect(rect.left).toBe(tickToPx(p.startTick, zoom));
      expect(rect.left + rect.width).toBeCloseTo(tickToPx(placementEndTick(p), zoom), 9);
      expect(rect.top).toBe(30);
      expect(rect.height).toBe(88);
    }
  });

  // The formula this module refuses to restate. A trimmed placement's width is
  // driven by lengthTicks, NOT by the snapshot's durationTicks.
  it('ignores the snapshot duration once lengthTicks is set', () => {
    const full = placement({ id: 'p' });
    const trimmed = placement({ id: 'p', lengthTicks: PPQ });
    expect(placementRect(full, pxPerBeat, 0, 88).width).toBe(4 * pxPerBeat);
    expect(placementRect(trimmed, pxPerBeat, 0, 88).width).toBe(pxPerBeat);
    expect(placementEffectiveLength(trimmed)).toBe(PPQ);
  });

  it('multiplies width by repeat', () => {
    const once = placement({ id: 'p' });
    const thrice = placement({ id: 'p', repeat: 3 });
    expect(placementRect(thrice, pxPerBeat, 0, 88).width).toBe(
      placementRect(once, pxPerBeat, 0, 88).width * 3,
    );
  });

  it.each(cases)('tiles repeat rects edge to edge across the block for a %s placement', (_l, p) => {
    const rects = placementRepeatRects(p, pxPerBeat, 12, 88);
    const whole = placementRect(p, pxPerBeat, 12, 88);
    expect(rects).toHaveLength(p.repeat);
    expect(rects[0].left).toBe(whole.left);
    for (let i = 1; i < rects.length; i++) {
      expect(rects[i].left).toBeCloseTo(rects[i - 1].left + rects[i - 1].width, 9);
    }
    const last = rects[rects.length - 1];
    expect(last.left + last.width).toBeCloseTo(whole.left + whole.width, 9);
    for (const rect of rects) {
      expect(rect.width).toBeCloseTo(tickToPx(placementEffectiveLength(p), pxPerBeat), 9);
      expect(rect.top).toBe(12);
      expect(rect.height).toBe(88);
    }
  });

  // A bogus repeat has to be sanitized the SAME way in both functions: a block
  // drawn 0 px wide with one full-length division inside it is worse than either
  // reading of the data, and a zero-width block cannot be grabbed to fix itself.
  it.each([[0], [-3], [2.5], [Number.NaN]])(
    'draws at least one full repetition, and agrees with the block, for repeat %s',
    (repeat) => {
      const p = placement({ id: 'p', startTick: 2 * PPQ, repeat });
      const rects = placementRepeatRects(p, pxPerBeat, 0, 88);
      const whole = placementRect(p, pxPerBeat, 0, 88);
      expect(rects.length).toBeGreaterThanOrEqual(1);
      const last = rects[rects.length - 1];
      expect(last.left + last.width).toBeCloseTo(whole.left + whole.width, 9);
      expect(whole.width).toBeGreaterThan(0);
    },
  );

  // The formula placementRect uses is placementEndTick's own, with only the
  // repeat sanitized — so for any well-formed placement the two must agree.
  it.each(cases)('matches placementEndTick exactly for a well-formed %s placement', (_l, p) => {
    for (const zoom of ARRANGEMENT_ZOOM_LEVELS) {
      const rect = placementRect(p, zoom, 0, 88);
      expect(rect.left + rect.width).toBeCloseTo(tickToPx(placementEndTick(p), zoom), 9);
    }
  });
});

describe('content extent', () => {
  it('is the furthest placement end across all tracks', () => {
    const tracks = [
      track('a', [placement({ id: '1', startTick: 0, repeat: 2 })]),
      track('b', [
        placement({ id: '2', startTick: 32 * PPQ, lengthTicks: PPQ }),
        placement({ id: '3', startTick: 8 * PPQ }),
      ]),
    ];
    expect(contentEndTick(tracks)).toBe(33 * PPQ);
    expect(contentEndTick([])).toBe(0);
    expect(contentEndTick([track('a')])).toBe(0);
  });

  it('spans enough bars to cover the content, plus the trailing room', () => {
    // Ends mid-bar: the bar it ends in still has to be drawn.
    const tracks = [track('a', [placement({ id: '1', startTick: 0, lengthTicks: 5 * PPQ })])];
    expect(arrangementBars(tracks, TS_4_4)).toBe(2);
    expect(arrangementBars(tracks, TS_4_4, { trailingBars: 4 })).toBe(6);
    expect(arrangementBars([], TS_4_4, { minBars: 8 })).toBe(8);
    // Meter-aware: the same content is more bars in 3/4.
    expect(arrangementBars(tracks, TS_3_4)).toBe(2);
    expect(
      arrangementBars([track('a', [placement({ id: '1', lengthTicks: 12 * PPQ })])], TS_3_4),
    ).toBe(4);
  });

  it('never returns fewer bars than the content needs', () => {
    const random = lcg(99);
    for (let i = 0; i < 100; i++) {
      const startTick = Math.round(random() * 40) * PPQ;
      const p = placement({ id: '1', startTick, repeat: 1 + Math.floor(random() * 3) });
      const bars = arrangementBars([track('a', [p])], TS_4_4);
      expect(bars * ticksPerBar(TS_4_4)).toBeGreaterThanOrEqual(placementEndTick(p));
    }
  });
});

describe('viewport', () => {
  it('is as wide as the bars it spans, at every zoom', () => {
    for (const zoom of ARRANGEMENT_ZOOM_LEVELS) {
      expect(arrangementWidth(12, TS_4_4, zoom)).toBe(
        tickToPx(12 * ticksPerBar(TS_4_4), zoom),
      );
      // Meter-aware, and the two meters disagree — a width that didn't consult
      // the time signature would pass in 4/4 and be a third short in 3/4.
      expect(arrangementWidth(12, TS_3_4, zoom)).toBe(
        tickToPx(12 * ticksPerBar(TS_3_4), zoom),
      );
      expect(arrangementWidth(0, TS_4_4, zoom)).toBe(0);
      expect(arrangementWidth(-4, TS_4_4, zoom)).toBe(0);
    }
  });

  // The ruler and the lanes are laid out from the same bar count, so this is
  // what keeps the two surfaces the same width.
  it('ends past the last ruler mark, on the bar line after it', () => {
    const zoom = ARRANGEMENT_ZOOM_LEVELS[DEFAULT_ARRANGEMENT_ZOOM_INDEX];
    const bars = 9;
    const marks = rulerMarks(bars, TS_4_4, zoom);
    const last = marks[marks.length - 1];
    expect(last.x).toBeLessThan(arrangementWidth(bars, TS_4_4, zoom));
    expect(arrangementWidth(bars, TS_4_4, zoom)).toBe(
      tickToPx(bars * ticksPerBar(TS_4_4), zoom),
    );
  });

  describe('zoom anchor', () => {
    // The property that matters, stated as the ticket states it: the tick at the
    // left edge of the viewport is the same tick before and after the zoom.
    it('keeps the leftmost visible tick fixed across every pair of zoom levels', () => {
      const leftTick = 37 * PPQ + PPQ / 2;
      for (const from of ARRANGEMENT_ZOOM_LEVELS) {
        for (const to of ARRANGEMENT_ZOOM_LEVELS) {
          const scrollLeft = tickToPx(leftTick, from);
          const next = zoomAnchoredScrollLeft(scrollLeft, from, to);
          expect(next).toBeCloseTo(tickToPx(leftTick, to), 9);
        }
      }
    });

    it('scales with the zoom ratio', () => {
      expect(zoomAnchoredScrollLeft(960, 48, 96)).toBe(1920);
      expect(zoomAnchoredScrollLeft(960, 48, 12)).toBe(240);
      expect(zoomAnchoredScrollLeft(960, 48, 48)).toBe(960);
    });

    it('leaves the home position at home', () => {
      for (const to of ARRANGEMENT_ZOOM_LEVELS) {
        expect(zoomAnchoredScrollLeft(0, 48, to)).toBe(0);
      }
    });

    // Overscroll (macOS rubber-banding) reports a negative scrollLeft, and a
    // zero or absent pxPerBeat has no anchor at all — neither may become NaN, or
    // the view jumps to the far end of the arrangement and cannot be scrolled
    // back with the pointer.
    it.each([
      [-120, 48, 96],
      [Number.NaN, 48, 96],
      [960, 0, 96],
      [960, -48, 96],
      [960, Number.NaN, 96],
      [960, 48, Number.NaN],
    ])('goes home rather than to NaN for (%s, %s, %s)', (scrollLeft, from, to) => {
      expect(zoomAnchoredScrollLeft(scrollLeft, from, to)).toBe(0);
    });

    // Zooming out and back must not walk the view: the naive implementation
    // (round trip through pxToTick) quantizes to whole ticks and drifts.
    it('returns to where it started after a round trip', () => {
      let scrollLeft = tickToPx(64 * PPQ, ARRANGEMENT_ZOOM_LEVELS[0]);
      const start = scrollLeft;
      for (let i = 1; i < ARRANGEMENT_ZOOM_LEVELS.length; i++) {
        scrollLeft = zoomAnchoredScrollLeft(
          scrollLeft,
          ARRANGEMENT_ZOOM_LEVELS[i - 1],
          ARRANGEMENT_ZOOM_LEVELS[i],
        );
      }
      for (let i = ARRANGEMENT_ZOOM_LEVELS.length - 1; i > 0; i--) {
        scrollLeft = zoomAnchoredScrollLeft(
          scrollLeft,
          ARRANGEMENT_ZOOM_LEVELS[i],
          ARRANGEMENT_ZOOM_LEVELS[i - 1],
        );
      }
      expect(scrollLeft).toBeCloseTo(start, 9);
    });
  });
});

describe('hit testing', () => {
  const pxPerBeat = ZOOM_LEVELS[DEFAULT_ZOOM_INDEX];
  const a1 = placement({ id: 'a1', startTick: 0, lengthTicks: 4 * PPQ });
  const a2 = placement({ id: 'a2', startTick: 8 * PPQ, repeat: 2 });
  const b1 = placement({ id: 'b1', startTick: 4 * PPQ, lengthTicks: 2 * PPQ, repeat: 3 });
  const tracks = [track('a', [a1, a2]), track('b', [b1]), track('c')];
  const lanes = laneRects(tracks, 'pattern');

  const laneFor = (trackId: string) => {
    const lane = lanes.find((candidate) => candidate.trackId === trackId);
    if (lane === undefined) throw new Error(`no lane for ${trackId}`);
    return lane;
  };

  // The invariant the whole module exists to guarantee: whatever the rect says
  // it covers, the hit test agrees it covers. Stated as a property because a
  // literal "x=200 hits a2" test goes stale the moment a height or zoom changes.
  it.each([
    ['a', a1],
    ['a', a2],
    ['b', b1],
  ] as const)('reports %s / every interior point of a placement as that placement', (id, p) => {
    for (const zoom of ARRANGEMENT_ZOOM_LEVELS) {
      const lane = laneFor(id);
      const rect = placementRect(p, zoom, lane.top, lane.height);
      const random = lcg(Math.round(zoom * 31 + p.startTick));
      for (let i = 0; i < 60; i++) {
        const point = {
          x: rect.left + random() * rect.width,
          y: rect.top + random() * rect.height,
        };
        const hit = hitTest(point, lanes, tracks, zoom);
        expect(hit).not.toBeNull();
        expect(hit?.kind).toBe('placement');
        if (hit?.kind !== 'placement') continue;
        expect(hit.placementId).toBe(p.id);
        expect(hit.trackId).toBe(id);
      }
    }
  });

  it('reports the lane, not a placement, in the gaps between blocks', () => {
    const lane = lanes[0];
    // Between a1 (ends at 4 beats) and a2 (starts at 8 beats).
    const hit = hitTest(
      { x: tickToPx(6 * PPQ, pxPerBeat), y: lane.top + 10 },
      lanes,
      tracks,
      pxPerBeat,
    );
    expect(hit).toEqual({ kind: 'lane', trackId: 'a', tick: 6 * PPQ });
  });

  it('reports the lane for a track with no placements at all', () => {
    const lane = lanes[2];
    expect(hitTest({ x: 5, y: lane.top + 1 }, lanes, tracks, pxPerBeat)?.kind).toBe('lane');
  });

  it('returns null outside the lane stack', () => {
    expect(hitTest({ x: 10, y: -1 }, lanes, tracks, pxPerBeat)).toBeNull();
    expect(hitTest({ x: 10, y: lanesHeight(lanes) }, lanes, tracks, pxPerBeat)).toBeNull();
  });

  // hitTest and dropTarget take the same coordinates from the same pointer, so
  // they must not disagree about what is left of the origin: a drag that
  // overshoots must not lose its track while the drop indicator still shows it.
  it('clamps left of the origin to tick 0 in the lane, exactly as dropTarget does', () => {
    const point = { x: -500, y: lanes[0].top + 5 };
    const bar = arrangementSnap(TS_4_4, DEFAULT_ARRANGEMENT_SNAP_ID);
    expect(hitTest(point, lanes, tracks, pxPerBeat)).toEqual({
      kind: 'lane',
      trackId: 'a',
      tick: 0,
    });
    expect(dropTarget(point, lanes, pxPerBeat, bar)).toEqual({ trackId: 'a', tick: 0 });
  });

  // Overlap is not the normal case — the lib cascades placements apart — but a
  // legacy or imported composition can carry one, and the rule has to be stated
  // by a test or the reverse iteration reads as an accident.
  it('gives an overlap to the later placement, matching paint order', () => {
    const under = placement({ id: 'under', startTick: 0, lengthTicks: 8 * PPQ });
    const over = placement({ id: 'over', startTick: 2 * PPQ, lengthTicks: 2 * PPQ });
    const stacked = [track('a', [under, over])];
    const stackedLanes = laneRects(stacked, 'pattern');
    const inside = {
      x: tickToPx(3 * PPQ, pxPerBeat),
      y: stackedLanes[0].top + 5,
    };
    const outside = {
      x: tickToPx(6 * PPQ, pxPerBeat),
      y: stackedLanes[0].top + 5,
    };
    const hit = hitTest(inside, stackedLanes, stacked, pxPerBeat);
    expect(hit?.kind === 'placement' && hit.placementId).toBe('over');
    // Past the overlap the underlying block is still reachable.
    const beyond = hitTest(outside, stackedLanes, stacked, pxPerBeat);
    expect(beyond?.kind === 'placement' && beyond.placementId).toBe('under');
  });

  // Two placements butted against each other is the normal case — the lib
  // cascades placements apart on overlap — so the shared edge must belong to
  // exactly one of them.
  it('gives an abutting pair a shared edge that belongs to the later block', () => {
    const left = placement({ id: 'L', startTick: 0, lengthTicks: 4 * PPQ });
    const right = placement({ id: 'R', startTick: 4 * PPQ, lengthTicks: 4 * PPQ });
    const abutting = [track('a', [left, right])];
    const abuttingLanes = laneRects(abutting, 'pattern');
    const edgeX = tickToPx(4 * PPQ, pxPerBeat);
    const y = abuttingLanes[0].top + 5;
    const before = hitTest({ x: edgeX - 0.001, y }, abuttingLanes, abutting, pxPerBeat);
    const at = hitTest({ x: edgeX, y }, abuttingLanes, abutting, pxPerBeat);
    expect(before?.kind === 'placement' && before.placementId).toBe('L');
    expect(at?.kind === 'placement' && at.placementId).toBe('R');
  });

  it('zones the edges for trimming and the middle for dragging', () => {
    const lane = lanes[0];
    const rect = placementRect(a1, pxPerBeat, lane.top, lane.height);
    const y = lane.top + 5;
    const zoneAt = (x: number) => {
      const hit = hitTest({ x, y }, lanes, tracks, pxPerBeat);
      return hit?.kind === 'placement' ? hit.zone : null;
    };
    expect(zoneAt(rect.left)).toBe('trim-start');
    expect(zoneAt(rect.left + TRIM_HANDLE_PX - 1)).toBe('trim-start');
    expect(zoneAt(rect.left + TRIM_HANDLE_PX)).toBe('body');
    expect(zoneAt(rect.left + rect.width / 2)).toBe('body');
    expect(zoneAt(rect.left + rect.width - TRIM_HANDLE_PX)).toBe('trim-end');
    expect(zoneAt(rect.left + rect.width - 0.001)).toBe('trim-end');
  });

  // A block narrower than three handles would be pure edge — undraggable at low
  // zoom, which is exactly where blocks get narrow.
  it('always leaves a draggable body, however narrow the block', () => {
    const tiny = placement({ id: 'tiny', startTick: 0, lengthTicks: PPQ / 8 });
    const tinyTracks = [track('a', [tiny])];
    const tinyLanes = laneRects(tinyTracks, 'pattern');
    for (const zoom of ARRANGEMENT_ZOOM_LEVELS) {
      const rect = placementRect(tiny, zoom, tinyLanes[0].top, tinyLanes[0].height);
      const hit = hitTest(
        { x: rect.left + rect.width / 2, y: tinyLanes[0].top + 5 },
        tinyLanes,
        tinyTracks,
        zoom,
      );
      expect(hit?.kind === 'placement' && hit.zone).toBe('body');
    }
  });

  it('honours a custom trim handle width, including zero', () => {
    const lane = lanes[0];
    const rect = placementRect(a1, pxPerBeat, lane.top, lane.height);
    const y = lane.top + 5;
    const hit = hitTest({ x: rect.left + 20, y }, lanes, tracks, pxPerBeat, { trimHandlePx: 24 });
    expect(hit?.kind === 'placement' && hit.zone).toBe('trim-start');
    const noHandles = hitTest({ x: rect.left, y }, lanes, tracks, pxPerBeat, { trimHandlePx: 0 });
    expect(noHandles?.kind === 'placement' && noHandles.zone).toBe('body');
  });

  it('reports the unsnapped tick under the cursor', () => {
    const lane = lanes[0];
    const tick = 9 * PPQ + PPQ / 4;
    const hit = hitTest(
      { x: tickToPx(tick, pxPerBeat), y: lane.top + 5 },
      lanes,
      tracks,
      pxPerBeat,
    );
    expect(hit?.tick).toBe(tick);
  });

  it('reports the lane when the lane stack has a track the caller did not supply', () => {
    const orphanLanes = [...lanes, { trackId: 'ghost', top: lanesHeight(lanes), height: 40 }];
    const hit = hitTest({ x: 10, y: lanesHeight(lanes) + 5 }, orphanLanes, tracks, pxPerBeat);
    expect(hit).toEqual({ kind: 'lane', trackId: 'ghost', tick: pxToTick(10, pxPerBeat) });
  });
});

describe('drop target', () => {
  const pxPerBeat = ZOOM_LEVELS[DEFAULT_ZOOM_INDEX];
  const tracks = [track('a'), track('b')];
  const lanes = laneRects(tracks, 'pattern');
  const bar = arrangementSnap(TS_4_4, DEFAULT_ARRANGEMENT_SNAP_ID);

  it('names the lane under the cursor', () => {
    expect(dropTarget({ x: 0, y: lanes[0].top }, lanes, pxPerBeat, bar)?.trackId).toBe('a');
    expect(dropTarget({ x: 0, y: lanes[1].top }, lanes, pxPerBeat, bar)?.trackId).toBe('b');
    expect(dropTarget({ x: 0, y: -1 }, lanes, pxPerBeat, bar)).toBeNull();
    expect(dropTarget({ x: 0, y: lanesHeight(lanes) }, lanes, pxPerBeat, bar)).toBeNull();
  });

  it('lands on a bar line at every zoom, from anywhere in the lane', () => {
    const random = lcg(5);
    for (const zoom of ARRANGEMENT_ZOOM_LEVELS) {
      for (let i = 0; i < 100; i++) {
        const x = random() * 4000;
        const drop = dropTarget({ x, y: lanes[0].top + 3 }, lanes, zoom, bar);
        if (drop === null) throw new Error('expected a drop target inside the lane');
        const tick = drop.tick;
        expect(tick % ticksPerBar(TS_4_4)).toBe(0);
        // Nearest bar to the pointer, so never more than half a bar of drift.
        expect(Math.abs(tick - pxToTick(x, zoom))).toBeLessThanOrEqual(ticksPerBar(TS_4_4) / 2);
      }
    }
  });

  it('clamps a drop left of the origin to tick 0', () => {
    expect(dropTarget({ x: -500, y: lanes[0].top }, lanes, pxPerBeat, bar)?.tick).toBe(0);
  });

  it('respects a finer snap when the user picks one, and none when off', () => {
    const x = tickToPx(PPQ + 37, pxPerBeat);
    const point = { x, y: lanes[0].top };
    expect(dropTarget(point, lanes, pxPerBeat, arrangementSnap(TS_4_4, '4'))?.tick).toBe(PPQ);
    expect(dropTarget(point, lanes, pxPerBeat, arrangementSnap(TS_4_4, 'off'))?.tick).toBe(
      PPQ + 37,
    );
    expect(dropTarget(point, lanes, pxPerBeat, null)?.tick).toBe(PPQ + 37);
  });
});

describe('barsSpanned', () => {
  it('rounds up — a riff a beat into bar 3 occupies three bars', () => {
    expect(barsSpanned(2 * ticksPerBar(TS_4_4) + PPQ, TS_4_4)).toBe(3);
  });

  it('counts an exact bar boundary as that many bars, not one more', () => {
    for (const bars of [1, 2, 4, 17]) {
      expect(barsSpanned(bars * ticksPerBar(TS_4_4), TS_4_4)).toBe(bars);
    }
  });

  it('follows the meter rather than assuming 4/4', () => {
    expect(barsSpanned(ticksPerBar(TS_3_4), TS_3_4)).toBe(1);
    // The same span is fewer bars of a longer bar.
    expect(barsSpanned(12 * PPQ, TS_3_4)).toBe(4);
    expect(barsSpanned(12 * PPQ, TS_4_4)).toBe(3);
  });

  it('is 0 for an empty or nonsensical span rather than NaN', () => {
    expect(barsSpanned(0, TS_4_4)).toBe(0);
    expect(barsSpanned(-500, TS_4_4)).toBe(0);
    expect(barsSpanned(Number.NaN, TS_4_4)).toBe(0);
  });
});

describe('trimHandleWidth', () => {
  it('is the full handle on any block at least three handles wide', () => {
    for (const width of [3 * TRIM_HANDLE_PX, 200, 4000]) {
      expect(trimHandleWidth(width)).toBe(TRIM_HANDLE_PX);
    }
  });

  it('shrinks to a third on a narrow block, so the middle third always drags', () => {
    const width = TRIM_HANDLE_PX; // one handle wide
    expect(trimHandleWidth(width)).toBeCloseTo(width / 3);
    // Which is exactly the rule `hitTest` applies: dead centre is still a body.
    const lane = laneRects([{ id: 't' }], 'pattern')[0];
    const tiny = placement({ id: 'p', lengthTicks: PPQ });
    // A zoom that makes the block one handle wide.
    const zoom = (TRIM_HANDLE_PX * PPQ) / PPQ;
    const rect = placementRect(tiny, zoom, lane.top, lane.height);
    const hit = hitTest(
      { x: rect.left + rect.width / 2, y: lane.top + 1 },
      [lane],
      [track('t', [tiny])],
      zoom,
    );
    expect(hit).toMatchObject({ kind: 'placement', zone: 'body' });
  });

  it('is 0 for a degenerate width rather than negative', () => {
    expect(trimHandleWidth(0)).toBe(0);
    expect(trimHandleWidth(-40)).toBe(0);
    expect(trimHandleWidth(Number.NaN)).toBe(0);
  });
});

describe('placementsInBand', () => {
  const pxPerBeat = ARRANGEMENT_ZOOM_LEVELS[DEFAULT_ARRANGEMENT_ZOOM_INDEX];
  const bar = ticksPerBar(TS_4_4);
  const a = placement({ id: 'a', startTick: 0 });
  const b = placement({ id: 'b', startTick: 2 * bar });
  const c = placement({ id: 'c', startTick: 0 });
  const tracks = [track('t1', [a, b]), track('t2', [c])];
  const lanes = laneRects(tracks, 'pattern');

  const bandOver = (
    fromTick: number,
    toTick: number,
    top: number,
    bottom: number,
  ) => ({
    left: tickToPx(fromTick, pxPerBeat),
    right: tickToPx(toTick, pxPerBeat),
    top,
    bottom,
  });

  it('catches every block the band overlaps, across lanes', () => {
    const band = bandOver(0, 3 * bar, 0, lanes[1].top + lanes[1].height);
    expect(placementsInBand(band, lanes, tracks, pxPerBeat).sort()).toEqual(['a', 'b', 'c']);
  });

  it('leaves out lanes the band never reaches', () => {
    const band = bandOver(0, 3 * bar, lanes[0].top, lanes[0].top + lanes[0].height - 1);
    expect(placementsInBand(band, lanes, tracks, pxPerBeat).sort()).toEqual(['a', 'b']);
  });

  it('leaves out blocks the band stops short of', () => {
    const band = bandOver(0, bar, 0, lanes[0].height);
    expect(placementsInBand(band, lanes, tracks, pxPerBeat)).toEqual(['a']);
  });

  it('normalizes a band dragged up and to the left', () => {
    const forward = bandOver(0, 3 * bar, 0, lanes[1].top + 1);
    const backward = {
      left: forward.right,
      right: forward.left,
      top: forward.bottom,
      bottom: forward.top,
    };
    expect(placementsInBand(backward, lanes, tracks, pxPerBeat)).toEqual(
      placementsInBand(forward, lanes, tracks, pxPerBeat),
    );
  });

  it('is half-open, so a band drawn along the seam between two blocks takes one', () => {
    // `a` ends exactly where a block starting at 1 bar would begin.
    const abutting = placement({ id: 'd', startTick: 4 * PPQ });
    const oneTrack = [track('t1', [a, abutting])];
    const oneLane = laneRects(oneTrack, 'pattern');
    const seam = tickToPx(4 * PPQ, pxPerBeat);
    expect(
      placementsInBand(
        { left: 0, right: seam, top: 0, bottom: oneLane[0].height },
        oneLane,
        oneTrack,
        pxPerBeat,
      ),
    ).toEqual(['a']);
  });
});

describe('planGroupMove', () => {
  const bar = ticksPerBar(TS_4_4);
  const group = [
    { id: 'a', trackIndex: 0, startTick: 0 },
    { id: 'b', trackIndex: 0, startTick: 2 * bar },
    { id: 'c', trackIndex: 1, startTick: bar },
  ];

  const byId = (moves: readonly PlacementDragItem[]): Record<string, PlacementDragItem> =>
    Object.fromEntries(moves.map((move) => [move.id, move]));

  it('preserves every relative offset, in time and across lanes', () => {
    const moved = byId(planGroupMove(group, 3 * bar, 1, 4));
    expect(moved.a).toMatchObject({ trackIndex: 1, startTick: 3 * bar });
    expect(moved.b).toMatchObject({ trackIndex: 1, startTick: 5 * bar });
    expect(moved.c).toMatchObject({ trackIndex: 2, startTick: 4 * bar });
  });

  it('clamps the DELTA at tick 0, so the group stops instead of collapsing', () => {
    const moved = byId(planGroupMove(group, -10 * bar, 0, 4));
    // The earliest member lands on 0 and everything keeps its gap to it.
    expect(moved.a.startTick).toBe(0);
    expect(moved.b.startTick).toBe(2 * bar);
    expect(moved.c.startTick).toBe(bar);
  });

  it('clamps the lane delta against the extreme member, both ways', () => {
    expect(byId(planGroupMove(group, 0, -5, 4)).c.trackIndex).toBe(1);
    expect(byId(planGroupMove(group, 0, 5, 4)).a.trackIndex).toBe(2);
    // ...and the spread survives the clamp.
    const up = byId(planGroupMove(group, 0, 5, 4));
    expect(up.c.trackIndex - up.a.trackIndex).toBe(1);
  });

  it('moves the far end first, so the group never blocks itself', () => {
    // Rightward: the rightmost block vacates its slot before its neighbour needs it.
    expect(planGroupMove(group, bar, 0, 4).map((m) => m.id)).toEqual(['b', 'c', 'a']);
    // Leftward: the other way round.
    expect(planGroupMove(group, -bar, 0, 4).map((m) => m.id)).toEqual(['a', 'c', 'b']);
  });

  /**
   * A drag straight down has NO tick delta to order by, so ordering on the tick
   * axis alone leaves the members in whatever order they were collected. The
   * lib's `movePlacement` then clamps each one against its destination lane's
   * CURRENT contents — including the group's own members, which have not moved
   * yet — and deflects the block that arrives first onto the next free slot.
   * That invents an offset the selection never had, which is exactly what
   * "group move preserves relative timing" forbids.
   */
  it('orders a purely vertical move by lane, farthest-travelled first', () => {
    const stacked = [
      { id: 'top', trackIndex: 0, startTick: 0 },
      { id: 'bottom', trackIndex: 1, startTick: 0 },
    ];
    // Downward: the bottom one leaves lane 1 before the top one arrives in it.
    expect(planGroupMove(stacked, 0, 1, 4).map((m) => m.id)).toEqual(['bottom', 'top']);
    // Upward: the other way round.
    expect(planGroupMove(stacked, 0, -1, 4).map((m) => m.id)).toEqual(['top', 'bottom']);
  });

  it('still orders within a lane by tick when the whole group changes lane', () => {
    // `a` and `b` land in the same destination lane, so the tick axis decides
    // between them; `c` is a lane below and goes first on a downward move.
    expect(planGroupMove(group, bar, 1, 4).map((m) => m.id)).toEqual(['c', 'b', 'a']);
  });

  it('is empty for an empty group or a stack with no lanes', () => {
    expect(planGroupMove([], bar, 0, 4)).toEqual([]);
    expect(planGroupMove(group, bar, 0, 0)).toEqual([]);
  });

  it('treats a non-finite delta as no movement rather than NaN', () => {
    const moved = byId(planGroupMove(group, Number.NaN, Number.NaN, 4));
    expect(moved.a).toMatchObject({ trackIndex: 0, startTick: 0 });
    expect(moved.b).toMatchObject({ trackIndex: 0, startTick: 2 * bar });
  });
});

describe('previewMarks', () => {
  const bar = ticksPerBar(TS_4_4);
  /** Tall enough for the pattern lane's real block (`DEFAULT_LANE_HEIGHTS.pattern`). */
  const BLOCK_H = DEFAULT_LANE_HEIGHTS.pattern;
  /** 4 beats × 48 px = a 192 px block, comfortably over `MIN_PREVIEW_WIDTH`. */
  const PX = 48;
  const GUITAR_STRINGS = 6;

  function note(over: Partial<PatternEvent> & { id: string }): PatternEvent {
    return { stringIndex: 0, fret: 5, startTick: 0, durationTicks: PPQ, ...over };
  }

  /** A one-bar placement carrying `events`. */
  function riff(events: PatternEvent[], over: Partial<Placement> = {}): Placement {
    const base = placement({ id: 'p', ...over });
    return { ...base, patternSnapshot: { ...base.patternSnapshot, events } };
  }

  const byEvent = (marks: readonly PreviewMark[]): Record<string, PreviewMark> =>
    Object.fromEntries(marks.map((mark) => [mark.eventId, mark]));

  /**
   * THE TRAP. `stringIndex` 0 is the low E — the physically BOTTOM string — and
   * every display in this app draws the high string on top (`ROW_ORDER` in
   * `Timeline.tsx`). Reversed, every note lands on the wrong string and at
   * preview scale still looks entirely plausible, so it is pinned here rather
   * than left to the eye.
   */
  it('draws the low E at the bottom and the high E on top', () => {
    const marks = byEvent(
      previewMarks(
        riff([note({ id: 'low', stringIndex: 0 }), note({ id: 'high', stringIndex: 5 })]),
        PX,
        BLOCK_H,
      ),
    );
    expect(marks.high.top).toBeLessThan(marks.low.top);

    // And by exactly five rows, not merely in the right order — a preview that
    // ordered the strings correctly but spaced them wrongly would still put
    // notes on strings they are not on.
    const rowHeight = marks.high.height + 2 * PREVIEW_ROW_GAP_PX;
    expect(marks.low.top - marks.high.top).toBeCloseTo(5 * rowHeight, 6);
  });

  it('gives every string its own row and keeps them all inside the block', () => {
    const events = Array.from({ length: GUITAR_STRINGS }, (_, stringIndex) =>
      note({ id: `s${stringIndex}`, stringIndex }),
    );
    const marks = previewMarks(riff(events), PX, BLOCK_H);
    expect(marks).toHaveLength(GUITAR_STRINGS);

    const tops = new Set(marks.map((mark) => mark.top));
    expect(tops.size).toBe(GUITAR_STRINGS);
    for (const mark of marks) {
      expect(mark.top).toBeGreaterThanOrEqual(0);
      expect(mark.top + mark.height).toBeLessThanOrEqual(BLOCK_H);
    }
  });

  it('drops a note whose string the snapshot instrument does not have', () => {
    // A six-string snapshot re-pointed at a four-string instrument: string 5
    // has nowhere to draw, and clamping it onto string 3 would assert a note
    // that is not there.
    const marks = previewMarks(
      riff([note({ id: 'gone', stringIndex: 5 }), note({ id: 'kept', stringIndex: 0 })], {
        patternSnapshot: { ...createEmptyPattern('riff', 'bass'), durationTicks: bar },
      }),
      PX,
      BLOCK_H,
    );
    expect(marks.map((mark) => mark.eventId)).toEqual(['kept']);
  });

  describe('what will actually play', () => {
    it('drops the notes a transposition pushes off the neck, and only those', () => {
      // Fret 20 + 5 = 25, past a guitar's 22. Fret 1 + 5 = 6, still on it.
      const events = [note({ id: 'off', fret: 20 }), note({ id: 'on', fret: 1, stringIndex: 1 })];
      const transposed = riff(events, { transposeSemitones: 5 });

      expect(previewMarks(transposed, PX, BLOCK_H).map((mark) => mark.eventId)).toEqual(['on']);
      // The same rule the block's ⚠ badge counts with — one answer, not two.
      expect(droppedByTranspose(transposed)).toBe(1);
      expect(previewMarks(riff(events), PX, BLOCK_H)).toHaveLength(2);
    });

    /**
     * The lib transposes FRETS and copies `stringIndex` unchanged, so the
     * string/time geometry of a transposed placement is identical to the
     * untransposed one — which would make the preview silent about the single
     * edit most likely to have changed what it shows, unless the sounding fret
     * reaches the drawing some other way. It does, as `opacity`.
     */
    it('shades a mark by the fret it will SOUND at, not the fret it was written at', () => {
      const events = [
        note({ id: 'open', fret: 0 }),
        note({ id: 'high', fret: 12, stringIndex: 1 }),
      ];
      const plain = byEvent(previewMarks(riff(events), PX, BLOCK_H));
      const up = byEvent(previewMarks(riff(events, { transposeSemitones: 5 }), PX, BLOCK_H));

      // Up the neck is fuller. Within one placement, and between a placement and
      // its own transposition.
      expect(plain.high.opacity).toBeGreaterThan(plain.open.opacity);
      expect(up.open.opacity).toBeGreaterThan(plain.open.opacity);
      expect(up.high.opacity).toBeGreaterThan(plain.high.opacity);

      // And the transposition changed NOTHING else — it is the fret that moved.
      for (const id of ['open', 'high']) {
        expect({ ...up[id], opacity: 0 }).toEqual({ ...plain[id], opacity: 0 });
      }
    });

    it('keeps every mark subordinate: opacity stays inside a usable band', () => {
      const events = [note({ id: 'open', fret: 0 }), note({ id: 'top', fret: 22, stringIndex: 1 })];
      for (const mark of previewMarks(riff(events), PX, BLOCK_H)) {
        // Never invisible, never fuller than the fill the class already sets.
        expect(mark.opacity).toBeGreaterThan(0.25);
        expect(mark.opacity).toBeLessThanOrEqual(1);
      }
    });

    it('draws nothing past a trim, and clips a note straddling it', () => {
      const events = [
        note({ id: 'inside', startTick: 0, durationTicks: bar }),
        note({ id: 'past', startTick: bar, stringIndex: 1 }),
      ];
      // Cut three beats in: 'past' starts after the cut and never sounds, and
      // 'inside' is a full bar long so its tail straddles it.
      const trimmed = riff(events, {
        patternSnapshot: { ...createEmptyPattern('riff'), durationTicks: 2 * bar },
        lengthTicks: bar - PPQ,
      });

      const marks = previewMarks(trimmed, PX, BLOCK_H);
      expect(marks.map((mark) => mark.eventId)).toEqual(['inside']);

      // Clipped to the cut exactly, the way `flattenComposition` clips its
      // duration — not merely kept inside the block by the overflow.
      const blockWidth = placementRect(trimmed, PX, 0, BLOCK_H).width;
      expect(marks[0].left + marks[0].width).toBeCloseTo(blockWidth, 6);
    });

    it('repeats the snapshot once per repetition, at the repetition boundaries', () => {
      const repeated = riff([note({ id: 'a' }), note({ id: 'b', startTick: PPQ })], { repeat: 3 });
      const marks = previewMarks(repeated, PX, BLOCK_H);
      expect(marks).toHaveLength(6);

      const rects = placementRepeatRects(repeated, PX, 0, BLOCK_H);
      const origin = tickToPx(repeated.startTick, PX);
      for (const mark of marks) {
        // Each mark sits within its own repetition's span, taken from the same
        // function the block draws its restart divisions from.
        const rect = rects[mark.repeat];
        expect(mark.left).toBeGreaterThanOrEqual(rect.left - origin);
        expect(mark.left + mark.width).toBeLessThanOrEqual(rect.left - origin + rect.width);
      }
    });

    it('does not let a held note bleed into the next repetition', () => {
      // A note longer than the pattern: it is clipped by the effective length in
      // playback, and must be clipped by the repetition here.
      const repeated = riff([note({ id: 'held', durationTicks: 4 * bar })], { repeat: 2 });
      const [first] = previewMarks(repeated, PX, BLOCK_H);
      const rects = placementRepeatRects(repeated, PX, 0, BLOCK_H);
      expect(first.left + first.width).toBeCloseTo(rects[0].width, 6);
    });

    it('never draws outside the block, whatever the placement carries', () => {
      const random = lcg(97);
      for (let i = 0; i < 200; i++) {
        const events = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, n) =>
          note({
            id: `e${n}`,
            stringIndex: Math.floor(random() * 8) - 1,
            fret: Math.floor(random() * 26),
            startTick: Math.floor(random() * 2 * bar),
            durationTicks: Math.floor(random() * 2 * bar),
          }),
        );
        const subject = riff(events, {
          repeat: 1 + Math.floor(random() * 4),
          transposeSemitones: Math.floor(random() * 9) - 4,
          lengthTicks: random() < 0.5 ? null : 1 + Math.floor(random() * 2 * bar),
        });
        const rect = placementRect(subject, PX, 0, BLOCK_H);
        for (const mark of previewMarks(subject, PX, BLOCK_H)) {
          expect(mark.left).toBeGreaterThanOrEqual(0);
          expect(mark.left + mark.width).toBeLessThanOrEqual(rect.width + 1e-9);
          expect(mark.width).toBeGreaterThan(0);
          expect(mark.top).toBeGreaterThanOrEqual(0);
          expect(mark.top + mark.height).toBeLessThanOrEqual(BLOCK_H);
        }
      }
    });
  });

  describe('degrading rather than mushing', () => {
    /** px/beat at which a one-bar block is exactly `MIN_PREVIEW_WIDTH` across. */
    const AT_MIN_WIDTH = MIN_PREVIEW_WIDTH / 4;

    it('draws at the width threshold and nothing below it', () => {
      const subject = riff([note({ id: 'a' })]);
      expect(placementRect(subject, AT_MIN_WIDTH, 0, BLOCK_H).width).toBe(MIN_PREVIEW_WIDTH);
      expect(previewMarks(subject, AT_MIN_WIDTH, BLOCK_H)).toHaveLength(1);
      expect(previewMarks(subject, AT_MIN_WIDTH - 1, BLOCK_H)).toEqual([]);
    });

    it('measures the width threshold per repetition, not per block', () => {
      // Four repetitions make the BLOCK four times the threshold while each
      // repetition is a quarter of it — four unreadable smears, so: nothing.
      const repeated = riff([note({ id: 'a' })], { repeat: 4 });
      expect(placementRect(repeated, AT_MIN_WIDTH / 4, 0, BLOCK_H).width).toBe(MIN_PREVIEW_WIDTH);
      expect(previewMarks(repeated, AT_MIN_WIDTH / 4, BLOCK_H)).toEqual([]);
    });

    it('draws at the height threshold and nothing below it', () => {
      const subject = riff([note({ id: 'a' })]);
      // The shortest block whose strip still gives every guitar string
      // `MIN_PREVIEW_ROW_PX`. Found by search rather than restated from the
      // module's private chrome reserve, so the test pins the BEHAVIOUR.
      let shortest = BLOCK_H;
      while (shortest > 0 && previewMarks(subject, PX, shortest - 1).length > 0) shortest--;

      expect(previewMarks(subject, PX, shortest)).toHaveLength(1);
      expect(previewMarks(subject, PX, shortest - 1)).toEqual([]);
      // Every row is at or above the floor at the threshold — the point of it.
      const [mark] = previewMarks(subject, PX, shortest);
      expect(mark.height + 2 * PREVIEW_ROW_GAP_PX).toBeGreaterThanOrEqual(MIN_PREVIEW_ROW_PX);
    });

    /**
     * The width thresholds bound the BLOCK; this bounds the notes in it. At
     * `pxPerBeat` 6 — a real entry in `ARRANGEMENT_ZOOM_LEVELS`, and the one at
     * which a bar is exactly `MIN_PREVIEW_WIDTH` — a 16th is 1.5 px, which is
     * the mark floor, so a 16th line on one string would draw as one solid bar
     * and a 32nd run would draw marks wider than the space between their onsets.
     */
    it('draws nothing when the notes on a string are too close to stay apart', () => {
      const COARSE = 6;
      /** The tightest onset spacing that still leaves daylight at this zoom. */
      const SPARSE = 160;
      const line = (gapTicks: number, stringIndex = 0) =>
        riff([
          note({ id: 'a', stringIndex, startTick: 0, durationTicks: gapTicks }),
          note({ id: 'b', stringIndex, startTick: gapTicks, durationTicks: gapTicks }),
        ]);

      expect(previewMarks(line(SPARSE), COARSE, BLOCK_H)).toHaveLength(2);
      expect(previewMarks(line(SPARSE - 1), COARSE, BLOCK_H)).toEqual([]);
      // A 16th at this zoom — the case that motivated the threshold.
      expect(previewMarks(line(PPQ / 4), COARSE, BLOCK_H)).toEqual([]);
      // The same passage drawn wide enough is fine: it is density AT A ZOOM.
      expect(previewMarks(line(PPQ / 4), PX, BLOCK_H)).toHaveLength(2);
    });

    it('measures density per string, since marks in different rows cannot collide', () => {
      const COARSE = 6;
      const TIGHT = PPQ / 4;
      // The same two onsets, once stacked on one string and once split across
      // two. Split, they are two rows apart and read perfectly well.
      const stacked = riff([
        note({ id: 'a', stringIndex: 0, startTick: 0 }),
        note({ id: 'b', stringIndex: 0, startTick: TIGHT }),
      ]);
      const split = riff([
        note({ id: 'a', stringIndex: 0, startTick: 0 }),
        note({ id: 'b', stringIndex: 3, startTick: TIGHT }),
      ]);
      expect(previewMarks(stacked, COARSE, BLOCK_H)).toEqual([]);
      expect(previewMarks(split, COARSE, BLOCK_H)).toHaveLength(2);
    });

    it('ignores the spacing of notes it is not going to draw anyway', () => {
      const COARSE = 6;
      // Two 16ths on one string, but the second is pushed off the neck by the
      // transposition and never drawn — so there is no pair to be too close.
      const subject = riff(
        [
          note({ id: 'kept', fret: 0, startTick: 0 }),
          note({ id: 'dropped', fret: 22, startTick: PPQ / 4 }),
        ],
        { transposeSemitones: 3 },
      );
      expect(previewMarks(subject, COARSE, BLOCK_H).map((mark) => mark.eventId)).toEqual(['kept']);
    });

    /**
     * The strip's chrome reserve, derived here from the CSS rather than from the
     * module's private constants so the two can disagree: `PlacementBlock`'s
     * name row is `text-[9.5px]` and its badge row `text-[8px]`, neither sets a
     * line height so both inherit `line-height: 1.55` (src/styles/index.css),
     * and the block's padding is `py-1` = 4 px. Under-reserve and the top string
     * lands under the name at the height threshold, where the strip fills the
     * band exactly — and z-order will NOT save it, because the SVG is positioned
     * and paints above the in-flow text whatever the DOM order.
     */
    it('clears the block’s own name and badges at every drawable height', () => {
      const LINE_HEIGHT = 1.55;
      const PY = 4;
      const nameRow = 9.5 * LINE_HEIGHT + PY;
      const badgeRow = 8 * LINE_HEIGHT + PY;
      const subject = riff(
        Array.from({ length: GUITAR_STRINGS }, (_, stringIndex) =>
          note({ id: `s${stringIndex}`, stringIndex }),
        ),
      );

      let drew = 0;
      for (let height = 1; height <= 2 * BLOCK_H; height++) {
        const marks = previewMarks(subject, PX, height);
        if (marks.length === 0) continue;
        drew++;
        for (const mark of marks) {
          expect(mark.top).toBeGreaterThanOrEqual(nameRow);
          expect(mark.top + mark.height).toBeLessThanOrEqual(height - badgeRow);
        }
      }
      expect(drew).toBeGreaterThan(0);
    });

    it('lets a four-string bass preview in a strip a guitar cannot use', () => {
      const events = [note({ id: 'a' })];
      const guitar = riff(events);
      const bass = riff(events, {
        patternSnapshot: { ...createEmptyPattern('riff', 'bass'), durationTicks: bar },
      });
      let shortest = BLOCK_H;
      while (shortest > 0 && previewMarks(guitar, PX, shortest - 1).length > 0) shortest--;

      expect(previewMarks(guitar, PX, shortest - 1)).toEqual([]);
      expect(previewMarks(bass, PX, shortest - 1)).toHaveLength(1);
    });
  });

  it('draws nothing for an empty pattern, a zero-length one, or no zoom', () => {
    expect(previewMarks(riff([]), PX, BLOCK_H)).toEqual([]);
    expect(
      previewMarks(riff([note({ id: 'a' })], { lengthTicks: 0 }), PX, BLOCK_H),
    ).toEqual([]);
    expect(previewMarks(riff([note({ id: 'a' })]), 0, BLOCK_H)).toEqual([]);
    expect(previewMarks(riff([note({ id: 'a' })]), Number.NaN, BLOCK_H)).toEqual([]);
    expect(previewMarks(riff([note({ id: 'a' })]), PX, Number.NaN)).toEqual([]);
    // Infinite zoom passes `> 0` and would otherwise produce `Infinity −
    // Infinity` = NaN widths in the right-edge clamp.
    expect(previewMarks(riff([note({ id: 'a' })]), Number.POSITIVE_INFINITY, BLOCK_H)).toEqual([]);
    expect(previewMarks(riff([note({ id: 'a' })]), PX, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  /**
   * The one place the preview does NOT show what will play, inherited from
   * `placementRect` so the marks cannot leave their block: `repeatCount` floors
   * and clamps to 1 where `flattenTrack` loops on the raw `repeat`. Pinned so
   * the documented exception is the observed one.
   */
  it('draws one repetition for a malformed repeat, as the block itself does', () => {
    for (const repeat of [0, -3, Number.NaN]) {
      const marks = previewMarks(riff([note({ id: 'a' })], { repeat }), PX, BLOCK_H);
      expect(marks.map((mark) => mark.repeat)).toEqual([0]);
    }
    // A fractional repeat draws the whole repetitions only.
    expect(
      previewMarks(riff([note({ id: 'a' })], { repeat: 2.5 }), PX, BLOCK_H).map((m) => m.repeat),
    ).toEqual([0, 1]);
  });

  it('gives a note too short to see a visible minimum width', () => {
    const marks = previewMarks(riff([note({ id: 'a', durationTicks: 1 })]), PX, BLOCK_H);
    expect(marks[0].width).toBeGreaterThan(tickToPx(1, PX));
    expect(marks[0].width).toBeGreaterThanOrEqual(1);
  });
});
