import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PPQ, type FretInstrumentId } from '@fretwork/lib';
import { NoteSurface, type SurfaceGeometry } from '../src/timeline/NoteSurface';
import type { EdgeAutoScroll } from '../src/timeline/useEdgeAutoScroll';
import { snapOptions } from '../src/timeline/timelineMath';
import {
  clearHistory,
  getEditingPattern,
  openBlankPattern,
  setEditingPatternInstrument,
  stampNote,
} from '../src/patterns/patternService';

/**
 * The surface on its own, at string counts the pattern page never shows.
 *
 * Nothing on screen renders a four-string surface until CP-11 puts one in an
 * arrangement lane — this is the cover for the props that make that possible,
 * and for the reentrancy trap the ukulele sets: `stringIndex` 0 is the BOTTOM
 * string, which on a standard ukulele is the high G, so "lowest index" and
 * "lowest pitch" part company.
 */

const FOUR_FOUR = { numerator: 4, denominator: 4 };
const SIXTEENTH = snapOptions(FOUR_FOUR).find((o) => o.id === '16')!;

/** No scroller behind this surface, so nothing clips a rubber-band. */
const noClip: SurfaceGeometry = { viewportRect: () => null };
/** The host's edge auto-scroll. Inert here: with no scroll container there is
 *  nowhere to scroll to, which is exactly the arrangement's case too. */
const noEdgeScroll: EdgeAutoScroll = { engaged: false, track: () => {}, end: () => {} };

/**
 * jsdom has no layout, so the lanes report a rect of 0 and clientX maps straight
 * onto ticks at 48px/beat. A lane area this short puts `rowHeight` on its 22px
 * floor whatever the string count, which is what makes a drag by whole rows
 * predictable.
 */
const LANE_AREA_H = 40;
const ROW_PX = 22;

// `string`, not `FretInstrumentId`, because the prop is — the surface names its
// rows off the catalog and draws blanks for an instrument that isn't in it, which
// is a case reachable without casting past the lib's union.
function surface(instrumentId: string, stringCount: number) {
  return (
    <NoteSurface
      pxPerBeat={48}
      laneAreaHeight={LANE_AREA_H}
      stringCount={stringCount}
      instrumentId={instrumentId}
      grid={SIXTEENTH}
      edgeScroll={noEdgeScroll}
      geometry={noClip}
    />
  );
}

/** A pattern on `instrumentId` with one note, ready to render a surface over. */
function seed(instrumentId: FretInstrumentId, stringIndex: number, fret: number) {
  openBlankPattern('Test');
  // Instrument first: the note has to be stamped onto a neck that already has
  // the string it names.
  setEditingPatternInstrument(instrumentId);
  stampNote({ stringIndex, fret, tick: 0, durationTicks: PPQ / 2 });
  clearHistory(); // loading a pattern is not an undoable edit
}

const events = () => getEditingPattern()!.events;
const noteEl = (id: string) => document.querySelector<HTMLElement>(`[data-note="${id}"]`)!;
const laneLabels = () =>
  [...document.querySelectorAll('[data-lane]')].map((el) => el.getAttribute('data-lane'));

describe('NoteSurface at a string count other than six', () => {
  beforeEach(() => seed('bass', 1, 5));

  it('draws one lane per string', () => {
    render(surface('bass', 4));
    expect(document.querySelectorAll('[data-lane]')).toHaveLength(4);
  });

  it('labels the lanes from the instrument\'s own tuning, high string on top', () => {
    render(surface('bass', 4));
    // Bass standard is E1 A1 D2 G2, so no duplicate to disambiguate — unlike the
    // guitar's lowercase top "e".
    expect(laneLabels()).toEqual(['G', 'D', 'A', 'E']);
  });

  it('names pitches from the string the note is actually on', () => {
    render(surface('bass', 4));
    // 5th fret of the bass A string is a D — the fret offset, which the open
    // strings below cannot exercise. A bass cannot prove the TUNING is read
    // rather than assumed: its four strings are the guitar's low four an octave
    // down, so the pitch classes coincide. The ukulele settles that.
    expect(screen.getByTitle('Fret 5 · D')).toBeInTheDocument();
  });

  it('divides the lane area between however many strings there are', () => {
    const { unmount } = render(
      <NoteSurface
        pxPerBeat={48}
        laneAreaHeight={300}
        stringCount={4}
        instrumentId="bass"
        grid={SIXTEENTH}
        edgeScroll={noEdgeScroll}
        geometry={noClip}
      />,
    );
    const four = document.querySelector<HTMLElement>('[data-lane]')!.style.height;
    unmount();

    render(
      <NoteSurface
        pxPerBeat={48}
        laneAreaHeight={300}
        stringCount={6}
        instrumentId="guitar"
        grid={SIXTEENTH}
        edgeScroll={noEdgeScroll}
        geometry={noClip}
      />,
    );
    expect(four).toBe('75px'); // 300 / 4
    expect(document.querySelector<HTMLElement>('[data-lane]')!.style.height).toBe('50px');
  });

  it('stamps onto the string the lane belongs to', async () => {
    const user = userEvent.setup();
    render(surface('bass', 4));

    // The top lane is the G string, which is index 3 — not index 0.
    await user.pointer({
      target: document.querySelector<HTMLElement>('[data-lane="G"]')!,
      keys: '[MouseLeft]',
    });

    expect(events().at(-1)!.stringIndex).toBe(3);
  });

  it('clamps a drag to the top string of THIS neck, not the guitar\'s', async () => {
    const user = userEvent.setup();
    render(surface('bass', 4));
    const id = events()[0].id;

    // Five rows up from the bottom string on a four-string neck: the lib clamps
    // against the string count it is given, so this stops at 3. Handed 6 it
    // would stop at 5 — a string this surface has no lane for.
    await user.pointer([
      { target: noteEl(id), keys: '[MouseLeft>]', coords: { clientX: 0, clientY: 0 } },
      { coords: { clientX: 0, clientY: -5 * ROW_PX } },
      { keys: '[/MouseLeft]' },
    ]);

    expect(events()[0].stringIndex).toBe(3);
  });
});

describe('NoteSurface on a reentrant instrument', () => {
  // Standard ukulele is G4 C4 E4 A4: the high G sits at the physical bottom, so
  // index order is NOT pitch order. Everything here indexes by string position,
  // which is the only reading that survives that.
  beforeEach(() => seed('ukulele', 0, 0));

  it('keeps the physical bottom string at the bottom row', () => {
    render(surface('ukulele', 4));
    expect(laneLabels()).toEqual(['A', 'E', 'C', 'G']);
  });

  it('sounds the open bottom string as its own pitch, not the guitar\'s', () => {
    render(surface('ukulele', 4));
    expect(screen.getByTitle('Fret 0 · G')).toBeInTheDocument();
  });

  it('transposes off this neck\'s open string, not the guitar\'s', () => {
    stampNote({ stringIndex: 1, fret: 2, tick: PPQ, durationTicks: PPQ / 2 });
    render(surface('ukulele', 4));
    // Index 1 on a ukulele is the C string, so its 2nd fret is a D. On a guitar
    // that index is the A string and the same fret is a B — the two answers
    // differ, which is what makes this the one that settles the tuning read
    // rather than the open-string case above.
    expect(screen.getByTitle('Fret 2 · D')).toBeInTheDocument();
  });

  it('spells an accidental sharp, with the typographic glyph', () => {
    stampNote({ stringIndex: 1, fret: 1, tick: PPQ, durationTicks: PPQ / 2 });
    render(surface('ukulele', 4));
    // Both halves are deliberate and both are load-bearing: the lib's `noteAt`
    // would answer 'Db4' here (Tonal's `fromMidi` spells flats), and '#' is the
    // spelling everything outside a note block uses.
    expect(screen.getByTitle('Fret 1 · C♯')).toBeInTheDocument();
  });
});

describe('NoteSurface on an instrument the catalog does not know', () => {
  beforeEach(() => seed('guitar', 1, 5));

  // `stringLabels` refuses to guess, and so does the pitch naming: a blank is
  // honest where the guitar's tuning would be a confident wrong answer. The
  // lanes are still drawn, so notes on them remain reachable.
  it('draws the rows but names nothing', () => {
    render(surface('kazoo', 4));

    expect(document.querySelectorAll('[data-lane]')).toHaveLength(4);
    // Read off the attribute rather than through `getByTitle`, which trims the
    // trailing space that is the whole point of this assertion.
    expect(document.querySelector('[data-note]')!.getAttribute('title')).toBe('Fret 5 · ');
  });
});
