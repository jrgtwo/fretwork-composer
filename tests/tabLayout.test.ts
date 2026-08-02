import { describe, it, expect } from 'vitest';
import { PPQ, ticksPerBar, type PatternEvent } from '@fretwork/lib';
import { toPitchPatch } from '../src/patterns/articulations';
import {
  LABEL_GUTTER,
  ROW_HEIGHT,
  SYSTEM_GAP,
  SYSTEM_PAD,
  layoutTab,
  noteParts,
  openStrings,
  rowForString,
  stringLabels,
  type TabLayoutInput,
} from '../src/reference/tabLayout';

const FOUR_FOUR = { numerator: 4, denominator: 4 };
const BAR = ticksPerBar(FOUR_FOUR); // 1920
const STRINGS = 6;

let nextId = 0;
/** A pattern event with only the fields tab cares about; the rest are optional. */
function note(fields: Partial<PatternEvent> = {}): PatternEvent {
  return {
    id: `n${nextId++}`,
    stringIndex: 0,
    fret: 0,
    startTick: 0,
    durationTicks: PPQ / 2,
    ...fields,
  };
}

function layout(overrides: Partial<TabLayoutInput> = {}) {
  return layoutTab({
    width: 1000,
    events: [],
    timeSignature: FOUR_FOUR,
    durationTicks: BAR,
    stringCount: STRINGS,
    ...overrides,
  });
}

/**
 * Articulations authored the way the app authors them, through the same patch
 * builder the note popup uses. Written as a cast because `toPitchPatch` is typed
 * loosely on purpose (see `articulations.ts`) — going through it rather than
 * hand-writing a curve is what makes these tests catch a change in how this app
 * *stores* slides, which is the thing tab has to read.
 */
const pitch = (spec: Parameters<typeof toPitchPatch>[0]) =>
  toPitchPatch(spec) as Pick<PatternEvent, 'slide' | 'bend'>;

describe('noteParts', () => {
  it('spells a plain note as its fret number', () => {
    expect(noteParts(note({ fret: 12 }))).toEqual({ prefix: '', core: '12', suffix: '' });
  });

  it('spells a dead note as x', () => {
    expect(noteParts(note({ fret: 5, dead: true })).core).toBe('x');
  });

  it('brackets a ghost note', () => {
    expect(noteParts(note({ fret: 7, ghost: true })).core).toBe('(7)');
  });

  it('brackets a ghosted dead note rather than picking one of the two', () => {
    // `(x)` is what tab writes for it. Branching on `dead` first would spell it `x`
    // and lose the ghost silently.
    expect(noteParts(note({ fret: 7, dead: true, ghost: true })).core).toBe('(x)');
  });

  it('prefixes the technique that starts the note', () => {
    expect(noteParts(note({ hammerOn: true })).prefix).toBe('h');
    expect(noteParts(note({ pullOff: true })).prefix).toBe('p');
    expect(noteParts(note({ tap: true })).prefix).toBe('t');
  });

  it('keeps hammer-on and pull-off from doubling up', () => {
    // The lib holds these mutually exclusive, but a persisted event could carry
    // both; `hp` is not notation anyone reads.
    expect(noteParts(note({ hammerOn: true, pullOff: true })).prefix).toBe('h');
  });

  it('suffixes a bend with b and vibrato with a tilde', () => {
    expect(noteParts(note({ ...pitch({ bend: { kind: 'bend', semitones: 2 } }) })).suffix).toBe('b');
    expect(noteParts(note({ vibrato: 'slight' })).suffix).toBe('~');
    expect(noteParts(note({ vibrato: 'wide' })).suffix).toBe('~');
  });

  it('slashes a slide in the direction it travels', () => {
    expect(noteParts(note({ ...pitch({ slideOut: 'up' }) })).suffix).toBe('/');
    expect(noteParts(note({ ...pitch({ slideOut: 'down' }) })).suffix).toBe('\\');
    // A slide *into* the note leads the number rather than following it.
    expect(noteParts(note({ ...pitch({ slideIn: 'below' }) })).prefix).toBe('/');
    expect(noteParts(note({ ...pitch({ slideIn: 'above' }) })).prefix).toBe('\\');
  });

  it('spells the lib slide types our own pitch model has no word for', () => {
    // `legato`/`shift` slide *to the next note*, which `readNotePitch` can't express —
    // nothing in this app authors one, but the lib's importer fills them in with a
    // `toFret`, and reading only through our model would spell them as plain notes.
    expect(noteParts(note({ fret: 5, slide: { type: 'legato', toFret: 7 } })).suffix).toBe('/');
    expect(noteParts(note({ fret: 7, slide: { type: 'shift', toFret: 5 } })).suffix).toBe('\\');
    // `toFret` is optional on the lib type; a slide with nowhere to go still reads as one.
    expect(noteParts(note({ fret: 7, slide: { type: 'legato' } })).suffix).toBe('/');
  });

  it('reads a slide that was stored as a pitch curve', () => {
    // Both movements on one note can't fit the lib's single `slide` field, so the
    // app stores them as `bend.points` (docs/FOLLOW-UPS.md §2). Reading `event.slide`
    // — which is what guitar-tutor does — would spell this as a plain note.
    const both = note({ fret: 9, ...pitch({ slideIn: 'below', slideOut: 'down' }) });
    expect(both.slide).toBeUndefined();
    expect(noteParts(both)).toEqual({ prefix: '/', core: '9', suffix: '\\' });
  });

  it('stacks the marks a single note can carry at once', () => {
    const busy = note({
      fret: 7,
      tap: true,
      hammerOn: true,
      vibrato: 'wide',
      ...pitch({ slideOut: 'up' }),
    });
    expect(noteParts(busy)).toEqual({ prefix: 'th', core: '7', suffix: '/~' });
  });

  it('brackets a harmonic in angles, and keeps the other marks around it', () => {
    // Only the importer authors these, same as the `legato`/`shift` slides above — and
    // without a case for it a harmonic reads back as a plain fret number.
    expect(noteParts(note({ fret: 12, harmonic: { type: 'natural' } })).core).toBe('<12>');
    expect(
      noteParts(note({ fret: 12, harmonic: { type: 'artificial' }, ghost: true })).core,
    ).toBe('(<12>)');
  });

  it('leaves palm mute out of the text — it is a tint, not a character', () => {
    expect(noteParts(note({ fret: 3, palmMute: true }))).toEqual({
      prefix: '',
      core: '3',
      suffix: '',
    });
  });
});

describe('openStrings', () => {
  // The labels above are these with the octave dropped; the timeline's note names
  // need the octave kept, because it transposes off them. Both read one tuning.
  it('keeps the full pitch, indexed by stringIndex', () => {
    expect(openStrings('guitar', 6)).toEqual(['E2', 'A2', 'D3', 'G3', 'B3', 'E4']);
  });

  it('is undefined for a string the tuning has no entry for', () => {
    expect(openStrings('bass', 6)).toEqual(['E1', 'A1', 'D2', 'G2', undefined, undefined]);
  });

  // Refusing to guess is the point: falling back to the guitar would name a
  // strange neck's notes confidently and wrongly.
  it('names nothing for an instrument the catalog does not know', () => {
    expect(openStrings('not-an-instrument', 2)).toEqual([undefined, undefined]);
  });
});

describe('stringLabels', () => {
  it('labels a guitar bottom-to-top, matching stringIndex', () => {
    // Index 0 is the low E, so the array reads bottom string first — the same order
    // as `TuningDef.strings` and `PatternEvent.stringIndex`. The top E is lowercase,
    // which is how tab tells the two E lines apart, and what the timeline's string
    // gutter calls the same string in the same window.
    expect(stringLabels('guitar', 6)).toEqual(['E', 'A', 'D', 'G', 'B', 'e']);
  });

  it('leaves the top string alone when no lower one shares its letter', () => {
    // The lowercase is disambiguation, not decoration: a bass has one G and it reads
    // as `G`.
    expect(stringLabels('bass', 4)[3]).toBe('G');
  });

  it('drops the octave — tab labels the string, not the pitch', () => {
    expect(stringLabels('bass', 4)).toEqual(['E', 'A', 'D', 'G']);
  });

  it('keeps physical order on a reentrant instrument', () => {
    // Ukulele standard is G4 C4 E4 A4: the high-G drone is the *bottom* string
    // despite outranking the two above it in pitch. Sorting by pitch here would
    // mislabel every line.
    expect(stringLabels('ukulele', 4)).toEqual(['G', 'C', 'E', 'A']);
  });

  it('pads rather than throwing when the tuning is shorter than the staff', () => {
    expect(stringLabels('bass', 6)).toEqual(['E', 'A', 'D', 'G', '', '']);
    expect(stringLabels('not-an-instrument', 2)).toEqual(['', '']);
  });
});

describe('rowForString', () => {
  it('draws the highest string on the top line', () => {
    expect(rowForString(5, 6)).toBe(0);
    expect(rowForString(0, 6)).toBe(5);
  });

  it('is its own inverse, so a row maps back to its string', () => {
    expect(rowForString(rowForString(2, 6), 6)).toBe(2);
  });
});

describe('layoutTab — systems', () => {
  it('fits as many whole bars per system as the width allows', () => {
    // 320px - 20px gutter = 300px of staff; a bar needs 120px, so two fit.
    const { barsPerSystem, barWidth, systems } = layout({ width: 320, durationTicks: BAR * 8 });
    expect(barsPerSystem).toBe(2);
    expect(barWidth).toBe(150);
    expect(systems).toHaveLength(4);
  });

  it('re-wraps when the pane gets narrower', () => {
    const wide = layout({ width: 1000, durationTicks: BAR * 8 });
    const narrow = layout({ width: 400, durationTicks: BAR * 8 });

    expect(wide.systems).toHaveLength(1);
    expect(narrow.systems).toHaveLength(3);
    // Same music, taller stack — that is the whole point of wrapping.
    expect(narrow.height).toBeGreaterThan(wide.height);
  });

  it('numbers bars continuously across the wrap', () => {
    const { systems } = layout({ width: 320, durationTicks: BAR * 5 });

    expect(systems[0].bars.map((b) => b.bar)).toEqual([1, 2]);
    expect(systems[1].bars.map((b) => b.bar)).toEqual([3, 4]);
    // The remainder gets a short final system rather than a padded one.
    expect(systems[2].bars.map((b) => b.bar)).toEqual([5]);
  });

  it('gives every system the same bar width, so the last one ends early', () => {
    const { systems, barWidth } = layout({ width: 320, durationTicks: BAR * 5 });

    expect(systems[0].right).toBe(LABEL_GUTTER + 2 * barWidth);
    // Not stretched to the full width: a bar has to be the same size everywhere or
    // vertical alignment stops meaning anything.
    expect(systems[2].right).toBe(LABEL_GUTTER + barWidth);
  });

  it('does not stretch a short pattern across a wide pane', () => {
    const { barWidth, systems } = layout({ width: 2000, durationTicks: BAR });
    expect(barWidth).toBe(320);
    expect(systems[0].right).toBe(LABEL_GUTTER + 320);
  });

  it('stacks systems with a gap and reports the total height', () => {
    const { systems, height } = layout({ width: 320, durationTicks: BAR * 4 });
    const staff = SYSTEM_PAD * 2 + (STRINGS - 1) * ROW_HEIGHT;

    expect(systems[0].top).toBe(0);
    expect(systems[1].top).toBe(staff + SYSTEM_GAP);
    expect(height).toBe(2 * staff + SYSTEM_GAP);
  });

  it('spaces the string lines evenly, high string first', () => {
    const [system] = layout().systems;
    expect(system.rowYs).toEqual(
      Array.from({ length: STRINGS }, (_, row) => SYSTEM_PAD + row * ROW_HEIGHT),
    );
  });

  it('follows the time signature for what a bar holds', () => {
    const threeFour = { numerator: 3, denominator: 4 };
    const bar = ticksPerBar(threeFour); // 1440, not 4/4's 1920
    const { totalBars, barWidth, glyphs } = layoutTab({
      width: 1000,
      // Four bars of 3/4. Deliberately not three: `ceil(3 * 1440 / 1920)` is also 3, so
      // a `perBar` hardcoded to 4/4 would pass that and fail this.
      events: [note({ startTick: bar })],
      timeSignature: threeFour,
      durationTicks: bar * 4,
      stringCount: STRINGS,
    });

    expect(totalBars).toBe(4);
    // And bar 2 starts one 3/4 bar in, not three quarters of the way through bar 1.
    expect(glyphs[0].x).toBeCloseTo(LABEL_GUTTER + barWidth);
  });

  it('survives the zero width jsdom and the first paint both report', () => {
    // Not a degenerate layout: a width of 0 must still place notes at distinct x,
    // or nothing about placement could be asserted in this environment at all.
    const { barWidth, systems, glyphs } = layout({
      width: 0,
      durationTicks: BAR,
      events: [note({ startTick: 0 }), note({ startTick: PPQ })],
    });

    expect(barWidth).toBe(120);
    expect(systems).toHaveLength(1);
    expect(glyphs[0].x).not.toBe(glyphs[1].x);
  });

  it('always draws at least one bar, even for an empty pattern', () => {
    const { totalBars, systems } = layout({ durationTicks: 0, events: [] });
    expect(totalBars).toBe(1);
    expect(systems).toHaveLength(1);
  });

  it('makes room for a note that starts on the closing barline', () => {
    // The lib clamps authored durations to >= 1, but an imported or restored event can
    // carry 0 — which contributes nothing to the length of the piece, so the note would
    // be placed into a system index one past the end and throw on the way.
    const { totalBars, glyphs, systems } = layout({
      durationTicks: BAR,
      events: [note({ startTick: BAR, durationTicks: 0 })],
    });

    expect(totalBars).toBe(2);
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0].systemIndex).toBe(systems.length - 1);
  });

  it('draws something for a pattern carrying non-finite ticks instead of throwing', () => {
    // No path authors NaN, but one NaN used to make `totalBars` NaN, leave `systems`
    // empty, and take the pane down on the first glyph. Bar 1 is a wrong answer; a
    // blank pane where the tab was is a worse one.
    const { systems, glyphs, height } = layout({
      events: [note({ startTick: Number.NaN, durationTicks: Number.NaN })],
    });

    expect(systems).toHaveLength(1);
    expect(glyphs[0].x).toBe(LABEL_GUTTER);
    expect(Number.isFinite(glyphs[0].tailWidth)).toBe(true);
    expect(Number.isFinite(height)).toBe(true);
  });

  it('survives a time signature with a zero in it', () => {
    // `ticksPerBar` is unclamped and `setPatternTimeSignature` validates nothing, so a
    // corrupt import can land either of these. A numerator of 0 used to make `perBar` 0,
    // `totalBars` Infinity and the system loop allocate until the page died — the only
    // failure in this file that hangs rather than mis-draws, so it needs a test that
    // *finishes*.
    for (const timeSignature of [
      { numerator: 0, denominator: 4 },
      { numerator: 4, denominator: 0 },
    ]) {
      const { systems, glyphs } = layout({
        timeSignature,
        durationTicks: BAR,
        events: [note({ startTick: 0 }), note({ startTick: PPQ })],
      });

      expect(systems).toHaveLength(1);
      // And it falls back to a real bar rather than a one-tick one: the notes still
      // land at distinct x instead of stacking on the gutter.
      expect(glyphs[0].x).not.toBe(glyphs[1].x);
    }
  });

  it('caps how much paper it will lay out', () => {
    // Same reachability as the NaN above, and the same class of failure: ~5×10⁸ bars is
    // ~7×10⁷ system objects. Capped rather than trusted, and the notes still draw.
    const { systems, totalBars, glyphs, height } = layout({
      durationTicks: 1e12,
      events: [note({ startTick: 0 })],
    });

    expect(totalBars).toBeLessThanOrEqual(2000);
    expect(systems.length).toBeGreaterThan(0);
    expect(Number.isFinite(height)).toBe(true);
    expect(glyphs).toHaveLength(1);
  });

  it('keeps a note past the cap on the paper rather than throwing', () => {
    // The `systemIndex` clamp is what catches this: a note 10⁶ bars in has no system of
    // its own once the cap applies, and piling it into the last one is the wrong drawing
    // this file trades for a live pane.
    const { glyphs, systems } = layout({
      durationTicks: 1e12,
      events: [note({ startTick: BAR * 1e6 })],
    });

    expect(glyphs[0].systemIndex).toBe(systems.length - 1);
    expect(Number.isFinite(glyphs[0].x)).toBe(true);
  });

  it('makes room for a note past the pattern duration', () => {
    // `fitPatternDuration` keeps these in step, but an imported or restored pattern
    // can hold a note past its stated end — which would land in a system that was
    // never built.
    const { totalBars } = layout({
      durationTicks: BAR,
      events: [note({ startTick: BAR * 2, durationTicks: PPQ })],
    });
    expect(totalBars).toBe(3);
  });
});

describe('layoutTab — glyph placement', () => {
  it('puts x on the tick and nothing else, so a chord lines up', () => {
    const { glyphs, barWidth } = layout({
      events: [
        note({ stringIndex: 0, fret: 3, startTick: PPQ }),
        note({ stringIndex: 3, fret: 12, startTick: PPQ }),
        note({ stringIndex: 5, fret: 100, startTick: PPQ }),
      ],
    });

    const xs = new Set(glyphs.map((g) => g.x));
    // Three very different-looking numbers, one x — vertical alignment is what
    // makes tab readable, so it can't depend on a glyph's own width.
    expect(xs.size).toBe(1);
    expect(glyphs[0].x).toBeCloseTo(LABEL_GUTTER + barWidth / 4);
  });

  it('spaces notes in proportion to their tick', () => {
    const { glyphs, barWidth } = layout({
      events: [note({ startTick: 0 }), note({ startTick: BAR / 2 }), note({ startTick: BAR })],
    });

    expect(glyphs[0].x).toBe(LABEL_GUTTER);
    expect(glyphs[1].x).toBeCloseTo(LABEL_GUTTER + barWidth / 2);
    expect(glyphs[2].x).toBeCloseTo(LABEL_GUTTER + barWidth);
  });

  it('reverses stringIndex into rows, so the high string is on top', () => {
    const { glyphs, systems } = layout({
      events: [note({ stringIndex: 5 }), note({ stringIndex: 0 })],
    });

    expect(glyphs[0].row).toBe(0);
    expect(glyphs[0].y).toBe(systems[0].rowYs[0]);
    expect(glyphs[1].row).toBe(5);
    expect(glyphs[1].y).toBe(systems[0].rowYs[5]);
    // Backwards here puts every note on the wrong string while looking plausible.
    expect(glyphs[1].y - glyphs[0].y).toBe(5 * ROW_HEIGHT);
  });

  it('sends a note into the system that holds its bar, measured from that system', () => {
    const { glyphs, systems } = layout({
      width: 320,
      durationTicks: BAR * 4,
      events: [note({ startTick: BAR * 2 }), note({ startTick: BAR * 2 + PPQ })],
    });

    // Two bars per system, so bar 3 opens the second one — and x restarts at its
    // left edge rather than carrying on from the first system.
    expect(glyphs[0].systemIndex).toBe(1);
    expect(glyphs[0].x).toBe(LABEL_GUTTER);
    expect(glyphs[0].y).toBe(systems[1].rowYs[5]);
    expect(glyphs[1].x).toBeGreaterThan(glyphs[0].x);
  });

  it('carries the notation onto the glyph', () => {
    const [glyph] = layout({
      events: [note({ fret: 7, hammerOn: true, vibrato: 'slight', palmMute: true })],
    }).glyphs;

    expect(glyph).toMatchObject({ prefix: 'h', core: '7', suffix: '~', palmMute: true });
  });

  it('draws a tail for a note that rings, and none for a short one', () => {
    const { glyphs, barWidth } = layout({
      events: [note({ durationTicks: BAR / 2 }), note({ startTick: BAR / 2, durationTicks: 1 })],
    });

    expect(glyphs[0].tailWidth).toBeCloseTo(barWidth / 2);
    expect(glyphs[1].tailWidth).toBe(0);
  });

  it('draws a tie even when the written note is short', () => {
    const [glyph] = layout({ events: [note({ durationTicks: 1, tieToNext: true })] }).glyphs;
    // The point of a tie is that the sound carries on; hiding its tail because the
    // notated note is brief loses exactly the thing being notated.
    expect(glyph.tailWidth).toBeGreaterThan(0);
  });

  it('clips a tail at the end of its system rather than into the next one', () => {
    const { glyphs, systems } = layout({
      width: 320,
      durationTicks: BAR * 4,
      events: [note({ startTick: BAR + PPQ * 2, durationTicks: BAR * 2 })],
    });

    expect(glyphs[0].x + glyphs[0].tailWidth).toBeLessThanOrEqual(systems[0].right);
  });

  it('clips a tail starting in the last sixteenth, where the minimum would overshoot', () => {
    // The case the clip is applied *last* for: with under 14px of room left, taking the
    // minimum tail width after clipping would draw the tail back out past the closing
    // barline. Two bars per system at 150px, so the last sixteenth leaves ~9px.
    const lastSixteenth = BAR * 2 - PPQ / 4;
    const { glyphs, systems } = layout({
      width: 320,
      durationTicks: BAR * 4,
      events: [
        note({ startTick: lastSixteenth, durationTicks: BAR }),
        note({ startTick: lastSixteenth, durationTicks: 1, tieToNext: true }),
      ],
    });

    expect(systems[0].right - glyphs[0].x).toBeLessThan(14);
    for (const glyph of glyphs) {
      expect(glyph.x + glyph.tailWidth).toBeLessThanOrEqual(systems[0].right);
    }
  });

  it('counts notes on strings the staff has not got instead of dropping them silently', () => {
    const { glyphs, offStaff } = layout({
      events: [note({ stringIndex: 0 }), note({ stringIndex: 6 }), note({ stringIndex: -1 })],
    });

    // A four-string pattern drawn on a six-line staff is the failure this catches:
    // without the count the view would render fewer notes than the pattern holds and
    // look entirely plausible.
    expect(glyphs).toHaveLength(1);
    expect(offStaff).toBe(2);
  });

  it('keeps a note at a negative tick on the paper', () => {
    // Nothing authors one, but a clamp here is cheaper than a glyph placed into a
    // system index of -1.
    const [glyph] = layout({ events: [note({ startTick: -PPQ })] }).glyphs;
    expect(glyph.systemIndex).toBe(0);
    expect(glyph.x).toBe(LABEL_GUTTER);
  });

  it('keeps glyphs in pattern order, so keys stay stable across a re-wrap', () => {
    const events = [note({ startTick: BAR }), note({ startTick: 0 })];
    expect(layout({ durationTicks: BAR * 2, events }).glyphs.map((g) => g.id)).toEqual([
      events[0].id,
      events[1].id,
    ]);
  });
});
