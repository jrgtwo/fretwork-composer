/**
 * What the lib's import pipeline ACTUALLY does, pinned against a fixture written
 * by hand.
 *
 * `importIR` is three lib stages behind one seam function, and every interesting
 * decision belongs to the lib rather than to us: which document shape produces a
 * composition at all, how a document is CUT into patterns, what is clamped, what
 * is dropped, and what merely earns a warning. The agent-facing half of this
 * design has to emit a document that survives all of it, so this file is the
 * reference for what such a document has to look like — not a smoke test.
 *
 * Everything is asserted against what landed IN THE STORE, read back through the
 * seams (`getLibraryPatterns`, `findLibraryPattern`,
 * `compositionService.getEditingComposition`), never against the mapper's return
 * value. The mapper's output being right and the store's contents being right are
 * two different claims, and the second one is the one a caller lives with.
 *
 * No model, no DOM.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_PATTERNS_STATE,
  DYNAMIC_VELOCITY,
  getCap,
  useAuthStore,
  usePatternsStore,
  type Pattern,
} from '@fretwork/lib';
import {
  PPQ,
  getLibraryPatterns,
  findLibraryPattern,
  importIR,
  openBlankPattern,
  stampNote,
  undo,
  type ImportIR,
} from '../src/patterns/patternService';
import {
  addTrack,
  getEditingComposition,
  openBlankComposition,
} from '../src/composition/compositionService';

// ------------------------------------------------------------- the fixture ---

const BEAT = PPQ; // 480
const EIGHTH = PPQ / 2;
const BAR = PPQ * 4; // 4/4

type Cell = { string: number; fret: number };

/**
 * A twelve-bar blues in C, quick-change: I–IV–I–I / IV–IV–I–I / V–IV–I–V.
 *
 * The regions are the CHORD CHANGES, and each one becomes a section marker —
 * which is what makes the document cut into per-section patterns at all. Bars
 * 3–4, 5–6 and 7–8 sit on one chord each, so nine regions cover twelve bars.
 */
const FORM: readonly { chord: 'C7' | 'F7' | 'G7'; atBar: number; bars: number }[] = [
  { chord: 'C7', atBar: 0, bars: 1 },
  { chord: 'F7', atBar: 1, bars: 1 },
  { chord: 'C7', atBar: 2, bars: 2 },
  { chord: 'F7', atBar: 4, bars: 2 },
  { chord: 'C7', atBar: 6, bars: 2 },
  { chord: 'G7', atBar: 8, bars: 1 },
  { chord: 'F7', atBar: 9, bars: 1 },
  { chord: 'C7', atBar: 10, bars: 1 },
  { chord: 'G7', atBar: 11, bars: 1 },
];

const sectionName = (index: number) => `${FORM[index].chord} @ bar ${FORM[index].atBar + 1}`;
const sectionTick = (index: number) => FORM[index].atBar * BAR;

/** Root–3–5–6 walking cells, on a four-string bass (index 0 = low E). */
const BASS_WALK: Record<'C7' | 'F7' | 'G7', readonly Cell[]> = {
  // C E G A
  C7: [
    { string: 1, fret: 3 },
    { string: 1, fret: 7 },
    { string: 2, fret: 5 },
    { string: 2, fret: 7 },
  ],
  // F A C D
  F7: [
    { string: 0, fret: 1 },
    { string: 0, fret: 5 },
    { string: 1, fret: 3 },
    { string: 1, fret: 5 },
  ],
  // G B D E
  G7: [
    { string: 0, fret: 3 },
    { string: 0, fret: 7 },
    { string: 1, fret: 5 },
    { string: 1, fret: 7 },
  ],
};

/** Four-note dominant-seventh grips, on a six-string guitar (index 0 = low E). */
const GUITAR_GRIP: Record<'C7' | 'F7' | 'G7', readonly Cell[]> = {
  // x32310 — C E Bb C
  C7: [
    { string: 1, fret: 3 },
    { string: 2, fret: 2 },
    { string: 3, fret: 3 },
    { string: 4, fret: 1 },
  ],
  // 131211 — F C Eb A
  F7: [
    { string: 0, fret: 1 },
    { string: 1, fret: 3 },
    { string: 2, fret: 1 },
    { string: 3, fret: 2 },
  ],
  // 320001 — G B D F
  G7: [
    { string: 0, fret: 3 },
    { string: 1, fret: 2 },
    { string: 2, fret: 0 },
    { string: 5, fret: 1 },
  ],
};

/** A C-blues lick in eighth notes: C – Eb (hammered) – F (sliding) – G (bent up
 *  a semitone, with vibrato). Carries one of every articulation the pattern model
 *  understands, so the mapping of each can be read off the stored pattern. */
const LICK: readonly ImportIR['tracks'][number]['events'][number]['notes'][number][] = [
  { string: 3, fret: 5 },
  { string: 3, fret: 8, hammerOn: true },
  { string: 4, fret: 6, slide: { type: 'shift' } },
  { string: 4, fret: 8, bend: { type: 'bend', semitones: 1 }, vibrato: 'wide' },
];

function bassEvents(): ImportIR['tracks'][number]['events'] {
  const events: ImportIR['tracks'][number]['events'] = [];
  for (const region of FORM) {
    for (let bar = 0; bar < region.bars; bar++) {
      // Walk up on the first bar of a region and back down on the second, which
      // is what a bass player does over a two-bar chord.
      const cells = bar % 2 === 0 ? BASS_WALK[region.chord] : [...BASS_WALK[region.chord]].reverse();
      for (let beat = 0; beat < 4; beat++) {
        events.push({
          atTick: (region.atBar + bar) * BAR + beat * BEAT,
          durationTicks: BEAT,
          notes: [cells[beat]],
          dynamic: 'mf',
        });
      }
    }
  }
  return events;
}

function rhythmEvents(): ImportIR['tracks'][number]['events'] {
  const events: ImportIR['tracks'][number]['events'] = [];
  for (const region of FORM) {
    for (let bar = 0; bar < region.bars; bar++) {
      for (const beat of [0, 2]) {
        events.push({
          atTick: (region.atBar + bar) * BAR + beat * BEAT,
          durationTicks: BEAT,
          notes: [...GUITAR_GRIP[region.chord]],
          effects: { palmMute: true },
          dynamic: 'mf',
        });
      }
    }
  }
  return events;
}

/** The lead answers on every other chord region, so half the lead's section
 *  patterns are deliberately EMPTY — the mapper is documented to make one anyway,
 *  and lane alignment in the arranger depends on it. */
function leadEvents(): ImportIR['tracks'][number]['events'] {
  const events: ImportIR['tracks'][number]['events'] = [];
  FORM.forEach((region, index) => {
    if (index % 2 !== 0) return;
    LICK.forEach((note, i) => {
      events.push({
        atTick: region.atBar * BAR + i * EIGHTH,
        durationTicks: EIGHTH,
        notes: [note],
        dynamic: 'f',
      });
    });
  });
  return events;
}

function twelveBarBlues(): ImportIR {
  return {
    meta: {
      title: 'Twelve-Bar Blues in C',
      artist: 'Fixture',
      sourceFormat: 'ascii-tab',
    },
    ticksPerQuarter: PPQ,
    totalTicks: 12 * BAR,
    tempos: [{ atTick: 0, bpm: 96, interpolation: 'step' }],
    timeSignatures: [{ atTick: 0, numerator: 4, denominator: 4 }],
    keySignatures: [{ atTick: 0, key: 'C', mode: 'major' }],
    sections: FORM.map((_, index) => ({ atTick: sectionTick(index), name: sectionName(index) })),
    chords: FORM.map((region) => ({ atTick: region.atBar * BAR, symbol: region.chord })),
    tracks: [
      {
        id: 'bass',
        name: 'Bass',
        instrumentHint: 'bass',
        tuning: ['E1', 'A1', 'D2', 'G2'],
        events: bassEvents(),
      },
      {
        id: 'rhythm',
        name: 'Rhythm Guitar',
        instrumentHint: 'guitar',
        tuning: ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'],
        events: rhythmEvents(),
      },
      {
        id: 'lead',
        name: 'Lead Guitar',
        instrumentHint: 'guitar',
        tuning: ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'],
        events: leadEvents(),
      },
    ],
  };
}

// ------------------------------------------------------------------ helpers ---

/** A minimal IR — one track, no sections — for the questions that are about the
 *  document's SHAPE rather than about its music. */
function bareIR(overrides: Partial<ImportIR> = {}): ImportIR {
  return {
    meta: { title: 'Bare', sourceFormat: 'ascii-tab' },
    ticksPerQuarter: PPQ,
    totalTicks: 2 * BAR,
    tempos: [{ atTick: 0, bpm: 120, interpolation: 'step' }],
    timeSignatures: [{ atTick: 0, numerator: 4, denominator: 4 }],
    keySignatures: [],
    sections: [],
    tracks: [
      {
        id: 't1',
        name: 'One',
        instrumentHint: 'guitar',
        events: [{ atTick: 0, durationTicks: BEAT, notes: [{ string: 0, fret: 5 }] }],
      },
    ],
    ...overrides,
  };
}

function track(id: string, name: string, atTicks: readonly number[]): ImportIR['tracks'][number] {
  return {
    id,
    name,
    instrumentHint: 'guitar',
    events: atTicks.map((atTick) => ({
      atTick,
      durationTicks: BEAT,
      notes: [{ string: 0, fret: 5 }],
    })),
  };
}

const patternNamed = (name: string): Pattern | undefined =>
  getLibraryPatterns().find((pattern) => pattern.name === name);

/** Unwrap or fail loudly — a refusal here means the assertions below are about
 *  nothing, and `result.ok` narrowing keeps the types honest. */
function imported(result: ReturnType<typeof importIR>) {
  if (!result.ok) throw new Error(`import refused: ${result.reason}`);
  return result.value;
}

beforeEach(() => {
  sessionStorage.clear();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  // The tier-cap test below trips `gateCreate`, which opens the signup modal in
  // a DIFFERENT global store — one nothing else here resets. Left dirty it would
  // leak into every test that runs after it.
  useAuthStore.setState({ signupModalOpen: false, signupModalContext: null });
});

// ------------------------------------------------------- the fixture, end to end ---

describe('a twelve-bar blues, validated → mapped → committed', () => {
  it('stores one pattern per track per section, plus one composition', () => {
    const result = imported(importIR(twelveBarBlues()));

    // 3 tracks × 9 chord regions. NOT 9 — see the sections × tracks group below.
    expect(result.patternIds).toHaveLength(27);
    expect(result.topology).toBe('composition');
    expect(result.compositionId).not.toBeNull();

    // Read back through the seam, not off the mapper's result.
    expect(getLibraryPatterns()).toHaveLength(27);
    for (const id of result.patternIds) expect(findLibraryPattern(id)).toBeDefined();

    const composition = getEditingComposition();
    expect(composition?.id).toBe(result.compositionId);
    expect(composition?.name).toBe('Twelve-Bar Blues in C');
    expect(composition?.bpm).toBe(96);
    expect(composition?.timeSignature).toEqual({ numerator: 4, denominator: 4 });
  });

  it('gives every track a lane whose blocks land on the chord changes', () => {
    imported(importIR(twelveBarBlues()));
    const composition = getEditingComposition();

    // Track order is the IR's, with the selected (primary) track first — here the
    // bass, since it is the first track with events and nothing else was asked for.
    expect(composition?.tracks.map((t) => t.name)).toEqual(['Bass', 'Rhythm Guitar', 'Lead Guitar']);

    for (const lane of composition?.tracks ?? []) {
      expect(lane.placements).toHaveLength(FORM.length);
      expect(lane.placements.map((p) => p.startTick)).toEqual(FORM.map((_, i) => sectionTick(i)));
      // Every block is a SNAPSHOT of the library pattern it was cut from, sharing
      // its id — the arranger edits the snapshot, not the library row.
      for (const placement of lane.placements) {
        expect(findLibraryPattern(placement.patternSnapshot.id)).toBeDefined();
        expect(placement.repeat).toBe(1);
        expect(placement.transposeSemitones).toBe(0);
      }
    }
  });

  it('names each pattern for its track and its section', () => {
    imported(importIR(twelveBarBlues()));

    // `<Track> · <Section>` — the only handle a caller has on a row it did not
    // create, and the reason section names are worth writing carefully.
    expect(patternNamed(`Bass · ${sectionName(0)}`)).toBeDefined();
    expect(patternNamed(`Rhythm Guitar · ${sectionName(3)}`)).toBeDefined();
    expect(patternNamed(`Lead Guitar · ${sectionName(8)}`)).toBeDefined();
  });

  it('puts the walking bass on the bass, at the ticks it was written on', () => {
    imported(importIR(twelveBarBlues()));

    // `instrumentHint: 'bass'` → the bass neck. The string BOUND comes from the
    // track's `tuning` (in the validator and in the mapper alike), never from the
    // hint — so a four-entry tuning is what keeps this track's notes on strings a
    // bass has. See "a bass track with no tuning" below for the inverse.
    const barOne = patternNamed(`Bass · ${sectionName(0)}`);
    expect(barOne?.instrumentId).toBe('bass');
    expect(barOne?.suggestedBpm).toBe(96);
    // Section-relative, NOT song-relative: the first bar starts at 0 in its own
    // pattern and the placement carries the offset.
    expect(barOne?.events.map((e) => [e.startTick, e.stringIndex, e.fret])).toEqual([
      [0, 1, 3],
      [BEAT, 1, 7],
      [2 * BEAT, 2, 5],
      [3 * BEAT, 2, 7],
    ]);

    // A two-bar region walks up then back down, and both bars live in ONE pattern.
    const twoBar = patternNamed(`Bass · ${sectionName(2)}`);
    expect(twoBar?.events).toHaveLength(8);
    expect(twoBar?.events.slice(4).map((e) => [e.startTick - BAR, e.stringIndex, e.fret])).toEqual([
      [0, 2, 7],
      [BEAT, 2, 5],
      [2 * BEAT, 1, 7],
      [3 * BEAT, 1, 3],
    ]);
  });

  it('flattens a chord stab into one event per string', () => {
    imported(importIR(twelveBarBlues()));

    // The IR's unit is a BEAT carrying n notes; the pattern's unit is a note. Two
    // stabs of a four-note grip is eight pattern events, not two.
    const stabs = patternNamed(`Rhythm Guitar · ${sectionName(0)}`);
    expect(stabs?.instrumentId).toBe('guitar');
    expect(stabs?.events).toHaveLength(8);
    expect(stabs?.events.filter((e) => e.startTick === 0).map((e) => [e.stringIndex, e.fret])).toEqual(
      GUITAR_GRIP.C7.map((cell) => [cell.string, cell.fret]),
    );
    // Palm-mute lives on the IR BEAT and is replicated onto every note of it.
    expect(stabs?.events.every((e) => e.palmMute === true)).toBe(true);
  });

  it('maps dynamics to BOTH the mark and the velocity the lib curve gives', () => {
    imported(importIR(twelveBarBlues()));

    // The answer to "should the agent bother emitting `dynamic`?" — yes. The
    // mapper back-fills `velocity` through `DYNAMIC_VELOCITY`, which is the only
    // field playback reads, so a dynamic in the IR is audible rather than cosmetic.
    const stabs = patternNamed(`Rhythm Guitar · ${sectionName(0)}`);
    expect(stabs?.events.every((e) => e.dynamic === 'mf')).toBe(true);
    expect(stabs?.events.every((e) => e.velocity === DYNAMIC_VELOCITY.mf)).toBe(true);

    const lick = patternNamed(`Lead Guitar · ${sectionName(0)}`);
    // Length first: `every` on an empty array is vacuously true, and the whole
    // claim of this assertion is that the four lead notes carry the velocity.
    expect(lick?.events).toHaveLength(4);
    expect(lick?.events.every((e) => e.velocity === DYNAMIC_VELOCITY.f)).toBe(true);
  });

  it('carries articulations through to the pattern model, mapper header notwithstanding', () => {
    imported(importIR(twelveBarBlues()));

    // ⚠ The mapper's own header says phase-1 maps every IRNote as a PLAIN NOTE.
    // In this build it does not: hammer-ons, slides, bends, vibrato, ghost/dead,
    // taps, harmonics, ties, palm-mute and dynamics all reach `PatternEvent`.
    // Pinned because the agent-facing schema's scope follows from it.
    const lick = patternNamed(`Lead Guitar · ${sectionName(0)}`);
    expect(lick?.events).toHaveLength(4);
    expect(lick?.events[1].hammerOn).toBe(true);
    expect(lick?.events[3].vibrato).toBe('wide');
    expect(lick?.events[3].bend).toEqual({ type: 'bend', semitones: 1, points: undefined });
    // The mapper RESOLVES a shift slide's destination by walking forward to the
    // next note on the same string — the IR does not have to state it.
    expect(lick?.events[2].slide).toEqual({ type: 'shift', toFret: 8 });
  });

  it('still cuts a pattern for a section the track is silent in', () => {
    imported(importIR(twelveBarBlues()));

    // The lead answers on alternate regions. The silent ones still get a row, so
    // every lane has the same block skeleton and the arranger stays aligned.
    const silent = patternNamed(`Lead Guitar · ${sectionName(1)}`);
    expect(silent).toBeDefined();
    expect(silent?.events).toHaveLength(0);
    // Its length is the SECTION's, not its content's — an empty pattern is still
    // a bar wide, which is what keeps the placement grid honest.
    expect(silent?.durationTicks).toBe(BAR);
  });

  it('drops the chord markers on the floor', () => {
    const result = imported(importIR(twelveBarBlues()));

    // ⚠ `ImportIR.chords` is a documented field the MAPPER reads (it builds the
    // harmony lane from it) — but `validateImportIR` does not copy it onto the IR
    // it returns, so anything routed through the validator loses it. The harmony
    // lane arrives empty no matter what the caller wrote.
    expect(getEditingComposition()?.harmonicContext).toEqual([]);
    expect(result.warnings.join(' ')).not.toContain('chord');
  });
});

// ------------------------------------------------- question 1: sections ---

describe('what a section marker actually decides', () => {
  it('makes NO composition for a single-track document with no sections', () => {
    const result = imported(importIR(bareIR()));

    expect(result.topology).toBe('single-pattern');
    expect(result.compositionId).toBeNull();
    expect(result.patternIds).toHaveLength(1);
    expect(usePatternsStore.getState().library.compositions).toHaveLength(0);
    // Single-pattern mode opens the PATTERN instead — there is no composition to open.
    expect(usePatternsStore.getState().editingPatternId).toBe(result.patternIds[0]);
  });

  it('makes a composition for a MULTI-track document with no sections at all', () => {
    // ⚠ The mapper's doc comment says `composition` is "null … when no sections
    // exist" and that composition mode "falls back to single-pattern when the IR
    // has no sections". Neither is true in this build: more than one non-empty
    // track is enough on its own, and each track becomes ONE pattern spanning the
    // whole piece. This is what makes sections optional for the agent.
    const result = imported(
      importIR(
        bareIR({
          sections: [],
          tracks: [track('a', 'A', [0, BAR]), track('b', 'B', [0, BAR])],
        }),
      ),
    );

    expect(result.topology).toBe('composition');
    expect(result.compositionId).not.toBeNull();
    expect(result.patternIds).toHaveLength(2);
    const composition = getEditingComposition();
    expect(composition?.tracks).toHaveLength(2);
    expect(composition?.tracks.every((t) => t.placements.length === 1)).toBe(true);
    // One section means the pattern keeps the TRACK's bare name — no ` · ` suffix.
    expect(patternNamed('A')).toBeDefined();
    expect(patternNamed('B')).toBeDefined();
  });

  it('makes a composition from ONE section on ONE track', () => {
    const result = imported(
      importIR(bareIR({ sections: [{ atTick: 0, name: 'Head' }] })),
    );

    // A single marker is enough to force composition mode even on a lone track.
    expect(result.topology).toBe('composition');
    expect(result.patternIds).toHaveLength(1);
    expect(getEditingComposition()?.tracks).toHaveLength(1);
    // Named for the track, not the section: the section name is only used to
    // disambiguate when there is more than one.
    expect(patternNamed('One')).toBeDefined();
  });

  it('invents an "Intro" section when the first marker is not at tick 0', () => {
    const result = imported(
      importIR(
        bareIR({
          totalTicks: 4 * BAR,
          sections: [{ atTick: 2 * BAR, name: 'Verse' }],
          tracks: [track('a', 'A', [0, 2 * BAR])],
        }),
      ),
    );

    // ⚠ Two patterns from one marker. Music before the first marker is not
    // dropped — it becomes a section called "Intro" — so a caller that writes its
    // first marker anywhere but 0 gets a section it did not ask for.
    expect(result.patternIds).toHaveLength(2);
    expect(patternNamed('A · Intro')).toBeDefined();
    expect(patternNamed('A · Verse')).toBeDefined();
    expect(getEditingComposition()?.tracks[0].placements.map((p) => p.startTick)).toEqual([
      0,
      2 * BAR,
    ]);
  });
});

// ------------------------------------------- question 2: sections × tracks ---

describe('sections × tracks', () => {
  it('is a PRODUCT — 3 tracks and 4 sections make 12 patterns, not 4', () => {
    const sections = [0, BAR, 2 * BAR, 3 * BAR].map((atTick, i) => ({
      atTick,
      name: `S${i + 1}`,
    }));
    const beats = [0, BAR, 2 * BAR, 3 * BAR];
    const result = imported(
      importIR(
        bareIR({
          totalTicks: 4 * BAR,
          sections,
          tracks: [
            track('a', 'A', beats),
            track('b', 'B', beats),
            track('c', 'C', beats),
          ],
        }),
      ),
    );

    expect(result.patternIds).toHaveLength(12);
    expect(getLibraryPatterns()).toHaveLength(12);

    // The placements do NOT share patterns across lanes: each track's section is
    // cut from that track's own notes, so the library holds 12 distinct rows and
    // each lane's four blocks are its own four.
    const composition = getEditingComposition();
    expect(composition?.tracks).toHaveLength(3);
    const idsPerLane = composition?.tracks.map((lane) =>
      lane.placements.map((p) => p.patternSnapshot.id),
    );
    expect(idsPerLane?.every((ids) => ids.length === 4)).toBe(true);
    expect(new Set(idsPerLane?.flat()).size).toBe(12);

    for (const lane of composition?.tracks ?? []) {
      expect(lane.placements.map((p) => p.startTick)).toEqual([0, BAR, 2 * BAR, 3 * BAR]);
      for (const placement of lane.placements) {
        // One bar of one note each — the section's notes, cut to section-relative
        // ticks, and no other track's.
        expect(placement.patternSnapshot.events).toHaveLength(1);
        expect(placement.patternSnapshot.events[0].startTick).toBe(0);
      }
    }
    // Every pattern is named for its own lane and section, so the 12 rows are
    // individually addressable rather than four names repeated three times.
    for (const laneName of ['A', 'B', 'C']) {
      for (let i = 1; i <= 4; i++) expect(patternNamed(`${laneName} · S${i}`)).toBeDefined();
    }
  });
});

// ------------------------------------------ question 3: ticksPerQuarter ---

describe('ticksPerQuarter rescaling', () => {
  it('passes a document authored at 480 through unscaled', () => {
    // The one we will emit. `scale = irPpq / 480`, so 480 in is 1:1 out — every
    // tick the caller wrote is the tick that lands.
    expect(PPQ).toBe(480);
    imported(importIR(twelveBarBlues()));

    const barOne = patternNamed(`Bass · ${sectionName(0)}`);
    expect(barOne?.events.map((e) => e.startTick)).toEqual([0, 480, 960, 1440]);
    expect(barOne?.events.every((e) => e.durationTicks === 480)).toBe(true);
    expect(getEditingComposition()?.tracks[0].placements.map((p) => p.startTick)).toEqual(
      FORM.map((_, i) => sectionTick(i)),
    );
  });

  it('halves a document authored at 960', () => {
    // Proves the 480 case above is a pass-through and not a coincidence.
    const at960 = bareIR({
      ticksPerQuarter: 960,
      totalTicks: 4 * 960,
      tracks: [
        {
          id: 't1',
          name: 'One',
          instrumentHint: 'guitar',
          events: [
            { atTick: 0, durationTicks: 960, notes: [{ string: 0, fret: 5 }] },
            { atTick: 1920, durationTicks: 960, notes: [{ string: 0, fret: 7 }] },
          ],
        },
      ],
    });
    const result = imported(importIR(at960));

    const pattern = findLibraryPattern(result.patternIds[0]);
    expect(pattern?.events.map((e) => [e.startTick, e.durationTicks])).toEqual([
      [0, 480],
      [960, 480],
    ]);
  });
});

// -------------------------------------------------------------- refusals ---

describe('refusals', () => {
  const storeIsEmpty = () => {
    const { library } = usePatternsStore.getState();
    expect(library.patterns).toHaveLength(0);
    expect(library.compositions).toHaveLength(0);
  };

  it('refuses a structurally broken document and stores nothing', () => {
    // The validator THROWS `ImportValidationError` rather than returning; the
    // seam puts its own idiom back on and carries the lib's `issues` through, so
    // the caller hears WHICH field was wrong.
    const broken = importIR({ ...twelveBarBlues(), ticksPerQuarter: 0 });

    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.reason).toContain('ticksPerQuarter');
    storeIsEmpty();
  });

  it('refuses a document whose tracks are not a list', () => {
    const broken = importIR({
      ...twelveBarBlues(),
      tracks: null as unknown as ImportIR['tracks'],
    });

    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.reason).toContain('tracks');
    storeIsEmpty();
  });

  it('refuses a document that is not a document', () => {
    const broken = importIR(null as unknown as ImportIR);

    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.reason).toContain('valid import');
    storeIsEmpty();
  });

  it('refuses a document with tracks but no notes', () => {
    // The mapper would happily make an empty pattern out of this. A caller that
    // wrote no notes wants to hear so.
    const silent = importIR(bareIR({ tracks: [track('a', 'A', [])] }));

    expect(silent.ok).toBe(false);
    if (silent.ok) return;
    expect(silent.reason).toContain('no notes');
    storeIsEmpty();
  });

  it('refuses a track list whose entries are not objects, in words', () => {
    // The validator walks off the end of this shape rather than rejecting it —
    // `validateTrack` dereferences `t.tuning` — so what comes back is a raw
    // TypeError. On its own it names nothing a caller can change.
    const broken = importIR({
      ...bareIR(),
      tracks: [null] as unknown as ImportIR['tracks'],
    });

    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.reason).toContain("isn't an object");
    storeIsEmpty();
  });

  it('refuses a selected track the document has not got', () => {
    // The mapper answers this with a WARNING and zero patterns, which reads
    // downstream as an empty document rather than as a bad argument.
    const wrong = importIR(twelveBarBlues(), { selectedTrackId: 'keys' });

    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.reason).toContain('keys');
    expect(wrong.reason).toContain('bass');
    storeIsEmpty();
  });

  it('refuses a selected track that EXISTS but has no notes', () => {
    // Worse than naming a track that isn't there, and it used to succeed: the
    // mapper treats a silent primary as a legitimate pick, forces single-pattern
    // mode, throws every other track's music away and commits ONE empty pattern.
    // A refusal that names the silent track is the only readable answer.
    const wrong = importIR(
      bareIR({ tracks: [track('lead', 'Lead', [0, BAR]), track('silent', 'Silent', [])] }),
      { selectedTrackId: 'silent' },
    );

    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.reason).toContain('silent');
    expect(wrong.reason).toContain('no notes');
    // And the tracks that DO have notes are named, so the caller can pick one.
    expect(wrong.reason).toContain('lead');
    storeIsEmpty();
  });

  it('refuses fractional ticks by naming them, not by saying "no notes"', () => {
    // `atTick: 0.5` is dropped SILENTLY by the validator — event and all — and
    // fractional numbers are the likeliest mistake in a hand- or model-written
    // document. Refusing with "no notes on any of them" would send the caller
    // looking at the wrong field.
    const fractional = importIR(
      bareIR({
        tracks: [
          {
            id: 't1',
            name: 'One',
            instrumentHint: 'guitar',
            events: [{ atTick: 0.5, durationTicks: BEAT, notes: [{ string: 0, fret: 5 }] }],
          },
        ],
      }),
    );

    expect(fractional.ok).toBe(false);
    if (fractional.ok) return;
    expect(fractional.reason).toContain('whole numbers');
    expect(fractional.reason).toContain('atTick');
    storeIsEmpty();
  });

  it('refuses a document whose events all survived but carry no notes', () => {
    // The nastier half of the same defect: a fractional `fret` drops the NOTE and
    // keeps the EVENT, so counting events would find this document playable and
    // commit a pattern with nothing in it.
    const fractional = importIR(
      bareIR({
        tracks: [
          {
            id: 't1',
            name: 'One',
            instrumentHint: 'guitar',
            events: [{ atTick: 0, durationTicks: BEAT, notes: [{ string: 0, fret: 5.5 }] }],
          },
        ],
      }),
    );

    expect(fractional.ok).toBe(false);
    if (fractional.ok) return;
    expect(fractional.reason).toContain('whole numbers');
    storeIsEmpty();
  });

  it('refuses two section markers on one tick', () => {
    // Each marker STARTS a section, so two on a tick makes one of them zero ticks
    // long — and the mapper builds a real `durationTicks: 0` pattern for it,
    // commits it, and hangs a placement off it. Nothing downstream refuses that,
    // and these patterns never pass through `fitPatternDuration`.
    const doubled = importIR(
      bareIR({
        sections: [
          { atTick: 0, name: 'A' },
          { atTick: 0, name: 'B' },
        ],
        tracks: [track('a', 'A', [0, BAR])],
      }),
    );

    expect(doubled.ok).toBe(false);
    if (doubled.ok) return;
    expect(doubled.reason).toContain('tick 0');
    storeIsEmpty();
  });

  it('refuses a section marker at or past the end of the document', () => {
    // Same zero-length pattern by a different route: the last interval runs from
    // the marker to `totalTicks`, which is BEHIND it.
    const past = importIR(
      bareIR({
        totalTicks: 2 * BAR,
        sections: [
          { atTick: 0, name: 'Head' },
          { atTick: 9 * BAR, name: 'Nowhere' },
        ],
        tracks: [track('a', 'A', [0, BAR])],
      }),
    );

    expect(past.ok).toBe(false);
    if (past.ok) return;
    expect(past.reason).toContain('totalTicks');
    storeIsEmpty();
  });

  it('refuses in words when the tier cap is in the way, and mutates nothing', () => {
    // `commitImport` returns `null` and writes nothing when `gateCreate` declines
    // — its only signal. The library is filled to one under the free cap rather
    // than by importing that many times; the count is DERIVED because the cap is
    // documented as temporarily bumped. These stubs are never read; only
    // `library.patterns.length` is.
    const room = getCap('free', 'patterns') - 1;
    const filler = Array.from(
      { length: room },
      (_, i) => ({ id: `filler-${i}`, name: `Filler ${i}`, events: [] }) as unknown as Pattern,
    );
    usePatternsStore.setState((state) => ({
      library: { ...state.library, patterns: filler },
    }));

    const capped = importIR(twelveBarBlues());

    expect(capped.ok).toBe(false);
    if (capped.ok) return;
    // Not "import failed" — how many rows it needed, what is already held, and
    // that nothing happened. It does NOT claim which of the two caps declined:
    // `commitImport` gates patterns and compositions independently and says so to
    // nobody, so naming one would be a guess.
    expect(capped.reason).toContain('27');
    expect(capped.reason).toContain(String(room));
    expect(capped.reason).toContain('Nothing was imported');
    expect(usePatternsStore.getState().library.patterns).toHaveLength(room);
    expect(usePatternsStore.getState().library.compositions).toHaveLength(0);
  });
});

// -------------------------------------------------- clamping and warnings ---

describe('clamping', () => {
  it('CLAMPS an out-of-range fret and string rather than refusing', () => {
    const result = imported(
      importIR(
        bareIR({
          tracks: [
            {
              id: 't1',
              name: 'Out of range',
              instrumentHint: 'guitar',
              tuning: ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'],
              events: [
                { atTick: 0, durationTicks: BEAT, notes: [{ string: 42, fret: 99 }] },
                { atTick: BEAT, durationTicks: BEAT, notes: [{ string: -3, fret: -5 }] },
              ],
            },
          ],
        }),
      ),
    );

    // Both notes survive, at the edges of the range: string into the tuning's
    // length, fret into 0..36 (the VALIDATOR's ceiling — the app's own `MAX_FRET`
    // is 24, so an imported note can sit above the neck this app draws).
    const pattern = findLibraryPattern(result.patternIds[0]);
    expect(pattern?.events.map((e) => [e.stringIndex, e.fret])).toEqual([
      [5, 36],
      [0, 0],
    ]);
  });

  it('says NOTHING about having clamped them', () => {
    // ⚠ Contradicts the validator's own header, which lists clamping among the
    // things it "surfaces as a warning". `validateNote` clamps silently: only the
    // per-track and per-document CAPS produce warnings. So a caller that writes
    // fret 99 gets fret 36 with no way to notice — which is exactly why the seam
    // above this one must range-check what it emits rather than trusting the
    // pipeline to complain.
    const result = imported(
      importIR(
        bareIR({
          tracks: [
            {
              // Named blandly on purpose: the mapper echoes the track name back
              // in a warning, and a name like "Out of range" would satisfy the
              // assertions below without the pipeline having said anything.
              id: 't1',
              name: 'Lead',
              instrumentHint: 'guitar',
              tuning: ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'],
              events: [{ atTick: 0, durationTicks: BEAT, notes: [{ string: 42, fret: 99 }] }],
            },
          ],
        }),
      ),
    );

    const said = result.warnings.join(' ').toLowerCase();
    expect(said).not.toContain('clamp');
    expect(said).not.toContain('out of range');
    expect(said).not.toContain('fret');
  });

  it('DOES drop a note the capo pushes off the end of the neck, with a warning', () => {
    // The one range warning that reaches a caller: the validator clamps fret and
    // capo independently, and the mapper then adds them — so fret 36 + capo 24 is
    // off the neck and is dropped rather than clamped again.
    const result = imported(
      importIR(
        bareIR({
          tracks: [
            {
              id: 't1',
              name: 'Capo',
              instrumentHint: 'guitar',
              capo: 24,
              events: [
                { atTick: 0, durationTicks: BEAT, notes: [{ string: 0, fret: 36 }] },
                { atTick: BEAT, durationTicks: BEAT, notes: [{ string: 0, fret: 2 }] },
              ],
            },
          ],
        }),
      ),
    );

    expect(result.warnings.some((w) => w.includes('Dropped 1 notes'))).toBe(true);
    const pattern = findLibraryPattern(result.patternIds[0]);
    // The survivor keeps the capo folded into its fret — 2 + 24.
    expect(pattern?.events.map((e) => e.fret)).toEqual([26]);
  });
});

describe('warnings', () => {
  it('carries BOTH the validator’s and the mapper’s to the caller', () => {
    // 65 tracks trips the validator's 64-track cap; the 64 survivors then trip the
    // mapper's 8-track composition cap. One document, two stages, and dropping
    // either set would leave the caller believing it imported more than it did.
    const many = bareIR({
      tracks: Array.from({ length: 65 }, (_, i) => track(`t${i}`, `T${i}`, [0])),
    });
    const result = imported(importIR(many));

    const validatorSaid = result.warnings.filter((w) => w.includes('64-track cap'));
    const mapperSaid = result.warnings.filter((w) => w.includes('8-track cap'));
    expect(validatorSaid).toHaveLength(1);
    expect(mapperSaid).toHaveLength(1);
    // The validator's come FIRST — they describe the document the mapper then saw.
    expect(result.warnings.indexOf(validatorSaid[0])).toBeLessThan(
      result.warnings.indexOf(mapperSaid[0]),
    );
    // And the cap is what actually landed, not just what was said.
    expect(getEditingComposition()?.tracks).toHaveLength(8);
    expect(getLibraryPatterns()).toHaveLength(8);
  });

  it('inventories the articulations it found, per track', () => {
    const result = imported(importIR(twelveBarBlues()));

    const said = result.warnings.join('\n');
    expect(said).toContain('[Lead Guitar]');
    expect(said).toContain('bends');
    expect(said).toContain('[Rhythm Guitar]');
    expect(said).toContain('palm-muted');
    // A summary line a caller can check its own arithmetic against.
    expect(said).toContain('Imported 3 tracks');
  });

  it('reports notes the validator discarded for not being whole numbers', () => {
    // The pipeline drops these in total silence. Where the whole document is lost
    // that is a refusal (see above); where SOME notes survive it has to be the
    // third channel, or a caller believes it imported music that isn't there.
    const result = imported(
      importIR(
        bareIR({
          tracks: [
            {
              id: 't1',
              name: 'One',
              instrumentHint: 'guitar',
              events: [
                { atTick: 0, durationTicks: BEAT, notes: [{ string: 0, fret: 5 }] },
                { atTick: BEAT, durationTicks: BEAT, notes: [{ string: 0, fret: 7.5 }] },
                { atTick: 2.5, durationTicks: BEAT, notes: [{ string: 0, fret: 9 }] },
              ],
            },
          ],
        }),
      ),
    );

    expect(result.warnings.some((w) => w.includes('Discarded 2 notes'))).toBe(true);
    expect(findLibraryPattern(result.patternIds[0])?.events).toHaveLength(1);
  });

  it('reports notes that landed on strings the instrument has not got', () => {
    // ⚠ The two bounds never meet: the validator clamps `string` against the
    // TRACK'S TUNING — 6 when the track gave none — while the mapper picks the
    // instrument from `instrumentHint`. So a bass-hinted track with no tuning
    // stores notes on strings 4 and 5 of a four-string bass: undrawable,
    // unplayable, and silent until `checkString` refuses to edit one of them.
    const result = imported(
      importIR(
        bareIR({
          tracks: [
            {
              id: 'bass',
              name: 'Bass',
              instrumentHint: 'bass',
              events: [
                { atTick: 0, durationTicks: BEAT, notes: [{ string: 1, fret: 3 }] },
                { atTick: BEAT, durationTicks: BEAT, notes: [{ string: 5, fret: 3 }] },
              ],
            },
          ],
        }),
      ),
    );

    // The note IS stored — this is a warning, not a refusal, because the pattern
    // stays editable and changing instrument would make it legal again.
    const pattern = findLibraryPattern(result.patternIds[0]);
    expect(pattern?.instrumentId).toBe('bass');
    expect(pattern?.events.map((e) => e.stringIndex)).toEqual([1, 5]);
    expect(result.warnings.some((w) => w.includes("strings a bass hasn't got"))).toBe(true);
  });

  it('says nothing when every note is on a string the instrument has', () => {
    // The negative half: the fixture's bass carries a four-entry tuning, so the
    // warning above must NOT fire for it.
    const result = imported(importIR(twelveBarBlues()));

    expect(result.warnings.some((w) => w.includes("hasn't got"))).toBe(false);
  });
});

// ------------------------------------------------------- the options ---

describe('ImportOptions', () => {
  const threeTracks = () =>
    bareIR({ tracks: [track('a', 'A', [0]), track('b', 'B', [0]), track('c', 'C', [0])] });

  it('forces single-pattern topology on a document that would be a composition', () => {
    // The mapper honours an explicit topology "regardless of file shape". Its own
    // `MapperResult.topology` doc says the opposite — that composition mode falls
    // back when there are no sections — so this is worth pinning.
    const result = imported(importIR(threeTracks(), { topology: 'single-pattern' }));

    expect(result.topology).toBe('single-pattern');
    expect(result.compositionId).toBeNull();
    expect(result.patternIds).toHaveLength(1);
    expect(usePatternsStore.getState().library.compositions).toHaveLength(0);
    // Only the primary track's music survives; the rest are named in a warning.
    expect(getLibraryPatterns()[0].events).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes('Skipped tracks'))).toBe(true);
  });

  it('restricts the import to includedTrackIds — plus the selected track, always', () => {
    // ⚠ The mapper force-adds the selected track to the list. Asking for only 'b'
    // while the default selection is 'a' therefore imports TWO lanes, which is
    // one more than the caller asked for.
    const result = imported(importIR(threeTracks(), { includedTrackIds: ['b'] }));

    expect(getLibraryPatterns().map((p) => p.name)).toEqual(['A', 'B']);
    expect(result.warnings.some((w) => w.includes('Excluded 1 track'))).toBe(true);

    // Setting both is what actually restricts it to one lane.
    usePatternsStore.setState({ library: { patterns: [], compositions: [], collections: [] } });
    imported(importIR(threeTracks(), { includedTrackIds: ['b'], selectedTrackId: 'b' }));
    expect(getLibraryPatterns().map((p) => p.name)).toEqual(['B']);
  });

  it('files every new row under the collection it was given', () => {
    const result = imported(importIR(threeTracks(), { collectionId: 'coll-1' }));

    // `commitImport` tags rows only when the value is neither undefined nor null,
    // which is why the seam passes `?? null` rather than leaving it undefined.
    for (const id of result.patternIds) expect(findLibraryPattern(id)?.collectionId).toBe('coll-1');
    expect(getEditingComposition()?.collectionId).toBe('coll-1');

    usePatternsStore.setState({ library: { patterns: [], compositions: [], collections: [] } });
    const untagged = imported(importIR(threeTracks()));
    expect(findLibraryPattern(untagged.patternIds[0])?.collectionId).toBeNull();
  });

  it('uses fallbackInstrumentId only for a track whose hint is missing', () => {
    // Without it the mapper hard-codes a guitar, so a ukulele or bass user's
    // hint-less import lands on the wrong neck. A hint that IS present wins.
    const result = imported(
      importIR(
        bareIR({
          tracks: [
            { id: 'a', name: 'No hint', events: track('a', 'A', [0]).events },
            { ...track('b', 'Hinted', [0]), instrumentHint: 'guitar' },
          ],
        }),
        { fallbackInstrumentId: 'ukulele' },
      ),
    );

    expect(result.patternIds.map((id) => findLibraryPattern(id)?.instrumentId)).toEqual([
      'ukulele',
      'guitar',
    ]);
    // And the composition takes the PRIMARY track's instrument, which here is the
    // hint-less one — so the fallback reaches the composition too.
    expect(getEditingComposition()?.instrumentId).toBe('ukulele');
  });

  it('defaults the primary track to the first one with NOTES, not the first one', () => {
    const result = imported(
      importIR(bareIR({ tracks: [track('empty', 'Empty', []), track('b', 'B', [0, BAR])] })),
    );

    // One non-empty track and no sections → single-pattern mode, and the pattern
    // that lands is B's. Picking `tracks[0]` instead would have selected a silent
    // track, which is now a refusal.
    expect(result.topology).toBe('single-pattern');
    expect(findLibraryPattern(result.patternIds[0])?.events).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes('Skipped tracks'))).toBe(true);
  });
});

// --------------------------------------------- fields that go nowhere ---

describe('IR fields the pipeline ignores', () => {
  it('never reads keySignatures', () => {
    // ⚠ `mapper.js` contains no reference to `keySignatures` at all; every pattern
    // is built with `key: null, scaleType: null`. Anything a caller writes there
    // is dead weight (it does survive on `sourceIR`), which is what decides
    // whether the agent-facing schema should offer the field.
    const result = imported(
      importIR(
        bareIR({
          keySignatures: [{ atTick: 0, key: 'Eb', mode: 'minor' }],
          sections: [{ atTick: 0, name: 'Head' }],
        }),
      ),
    );

    const pattern = findLibraryPattern(result.patternIds[0]);
    expect(pattern?.key).toBeNull();
    expect(pattern?.scaleType).toBeNull();
  });

  it('turns a drums track into a guitar, silently, in composition mode', () => {
    // ⚠ The "imported as guitar (no native drums support)" warning is pushed only
    // on the SINGLE-PATTERN branch. Composition mode — the mode a multi-track
    // document is always in — never emits it, so a drums or vocals track lands as
    // guitar notes with nothing said. The agent-facing schema should simply not
    // offer those hints.
    const result = imported(
      importIR(
        bareIR({
          tracks: [
            { ...track('d', 'Kit', [0, BAR]), instrumentHint: 'drums' },
            { ...track('v', 'Voice', [0, BAR]), instrumentHint: 'vocals' },
          ],
        }),
      ),
    );

    expect(result.topology).toBe('composition');
    expect(getLibraryPatterns().map((p) => p.instrumentId)).toEqual(['guitar', 'guitar']);
    expect(result.warnings.join(' ')).not.toContain('no native');
  });

  it('keeps events in the order they were written, and never sorts them', () => {
    // ⚠ A document whose events are out of tick order produces a pattern whose
    // `startTick`s run backwards — and `resolveSlideTarget` walks FORWARD BY INDEX
    // for a slide's destination, so it resolves to the wrong fret. The seam does
    // not sort on the caller's behalf: the agent-facing brief has to state that
    // events are tick-ordered per track.
    const result = imported(
      importIR(
        bareIR({
          tracks: [
            {
              id: 't1',
              name: 'One',
              instrumentHint: 'guitar',
              events: [
                {
                  atTick: BEAT,
                  durationTicks: BEAT,
                  notes: [{ string: 0, fret: 7, slide: { type: 'shift' } }],
                },
                { atTick: 0, durationTicks: BEAT, notes: [{ string: 0, fret: 5 }] },
              ],
            },
          ],
        }),
      ),
    );

    const pattern = findLibraryPattern(result.patternIds[0]);
    expect(pattern?.events.map((e) => [e.startTick, e.fret])).toEqual([
      [BEAT, 7],
      [0, 5],
    ]);
    // The slide on the LATER note resolved to the EARLIER one, because "next" is
    // the next index rather than the next tick.
    expect(pattern?.events[0].slide).toEqual({ type: 'shift', toFret: 5 });
  });
});

// ------------------------------------------ what an import does to the app ---

describe('what an import does to what is open', () => {
  it('creates a NEW composition and leaves the open one untouched', () => {
    // The headline claim of the doc comment, and the reason it warns about undo.
    const before = openBlankComposition('Already open');
    if (!before.ok) throw new Error(before.reason);
    addTrack('Existing');
    const snapshot = JSON.stringify(
      usePatternsStore.getState().library.compositions.find((c) => c.id === before.value.id),
    );

    const result = imported(importIR(twelveBarBlues()));

    // Two compositions in the library, and the old one byte-identical.
    const { compositions } = usePatternsStore.getState().library;
    expect(compositions).toHaveLength(2);
    expect(JSON.stringify(compositions.find((c) => c.id === before.value.id))).toBe(snapshot);
    // ...but the store is now pointed at the new one.
    expect(usePatternsStore.getState().editingCompositionId).toBe(result.compositionId);
    expect(result.compositionId).not.toBe(before.value.id);
    expect(getEditingComposition()?.name).toBe('Twelve-Bar Blues in C');
  });

  it('drops the pattern seam’s undo history, so an undo cannot rewrite the old row', () => {
    // History is per-pattern and `writePatternBack` addresses whatever is open
    // NOW. Carried across an import, the pre-import stack still holds the pattern
    // that was open, `undo` matches it by id, and the library row for a document
    // the user is no longer looking at is silently reverted — with nothing on
    // screen changing. Single-pattern mode, because that is where a pattern is
    // open on both sides of the import.
    const opened = openBlankPattern('Before the import');
    if (!opened.ok) throw new Error(opened.reason);
    stampNote({ stringIndex: 0, fret: 3, tick: 0 });
    expect(findLibraryPattern(opened.value.id)?.events).toHaveLength(1);

    const result = imported(importIR(bareIR()));
    expect(result.topology).toBe('single-pattern');

    undo();

    // Still one note: the undo found no stack to pop, rather than stamping the
    // pre-stamp snapshot back over a row nobody is looking at.
    expect(findLibraryPattern(opened.value.id)?.events).toHaveLength(1);
    // And the imported pattern — the one that IS open — is untouched.
    expect(findLibraryPattern(result.patternIds[0])?.events).toHaveLength(1);
  });
});
