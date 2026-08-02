import {
  PPQ,
  createEmptyPattern,
  placementEffectiveLength,
  placementEndTick,
  ticksPerBar,
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
  TRIM_HANDLE_PX,
  arrangementBars,
  arrangementSnap,
  arrangementWidth,
  contentEndTick,
  dropTarget,
  hitTest,
  laneAt,
  laneRects,
  lanesHeight,
  placementRect,
  placementRepeatRects,
  pxToTick,
  rulerMarks,
  snapArrangementTick,
  tickToPx,
  zoomAnchoredScrollLeft,
  type ArrangementMode,
  type PlacedTrack,
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
