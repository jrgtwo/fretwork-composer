/**
 * The track run: one part, written as JSON, checked before it can reach the
 * import pipeline.
 *
 * ⚠ THERE IS NO MODEL IN THIS FILE. Every model call goes through the injected
 * `runTask`, which returns what the test says it returns — because what this
 * module decides is the BRIEF that goes out, the schema beside it, the narrowing
 * of what comes back, and which parts are refusable. None of that needs a
 * provider, and a test with one could assert none of it.
 *
 * What is REAL: the schema, the spec, `trackRunInput`'s chord lookup through
 * `chordGrip`, and every rule in `reviewTrack`. What no test here can check is
 * whether the part is any good — that is a listening test's, and this file exists
 * so that what it listens to is the thing that will ship.
 *
 * ⚠ THE REFUSAL TESTS ARE THE POINT. Each one names a thing the import pipeline
 * does IN SILENCE, pinned in `tests/ImportIR.test.ts` against the lib's real
 * behaviour: a fractional tick drops the event, an out-of-range string or fret is
 * clamped without a warning, and an event whose notes were all dropped survives
 * empty. If one of these stops refusing, the failure moves from here to a piece
 * that plays the wrong notes with nothing said.
 */
import { describe, expect, it } from 'vitest';
import {
  IR_TRACK_AGENT,
  STRUM_SPANS,
  TICKS_PER_BAR,
  asTrackEvents,
  expandStrums,
  irTrackSchema,
  reviewTrack,
  runIRTrack,
  trackRunInput,
  type IRAnswerEvent,
  type IREvent,
  type TrackBrief,
  type TrackRunDeps,
} from '../src/ai/irTrackRun';
import { patternRunInput } from '../src/ai/patternSubRun';
import {
  DYNAMICS,
  MAX_FRET,
  PPQ,
  chordGrip,
  instrumentFretCount,
} from '../src/patterns/patternService';
import type { AgentRunSummary, AgentSpec, RunAgentTaskOptions } from '../src/ai/agentService';
import type { ImportIR, Result } from '../src/patterns/patternService';

// --------------------------------------------------------------- fixtures ---

const BEAT = PPQ;

/**
 * A twelve-bar blues in C as one part's brief: the form, the changes, and what
 * this player is for.
 *
 * ⚠ THE NAME AND THE ROLE CARRY NO CHORD SYMBOL, deliberately. With a name like
 * "Walking Bass over C7" every `toContain('C7')` below would pass on the
 * interpolated name alone, and deleting the progression from the brief entirely
 * would fail nothing.
 */
const bassBrief = (overrides: Partial<TrackBrief> = {}): TrackBrief => ({
  id: 'bass',
  name: 'Bass',
  instrumentId: 'bass',
  role: 'walking bass, quarter notes, root to root',
  bars: 12,
  chords: [
    { bar: 1, symbol: 'C7' },
    { bar: 5, symbol: 'F7' },
    { bar: 7, symbol: 'C7' },
    { bar: 9, symbol: 'G7' },
    { bar: 10, symbol: 'F7' },
    { bar: 11, symbol: 'C7' },
  ],
  ...overrides,
});

/** One bar of one chord — the smallest brief the events below are checked
 *  against, so a refusal is never about the form when it is meant to be about a
 *  note. */
const oneBar = (overrides: Partial<TrackBrief> = {}): TrackBrief =>
  bassBrief({ bars: 1, chords: [{ bar: 1, symbol: 'C7' }], ...overrides });

/** The same bar on a guitar — the neck the 2026-08-16 run got wrong, and the only
 *  one in the catalog whose C7 shape leaves a string unused. */
const guitarBar = (overrides: Partial<TrackBrief> = {}): TrackBrief =>
  oneBar({
    id: 'rhythm',
    name: 'Rhythm',
    instrumentId: 'guitar',
    role: 'comping, off the beat',
    ...overrides,
  });

/** The WHOLE twelve-bar on a guitar — the brief the 2026-08-16 'Guitar 2' was
 *  given, and the only fixture with more than one chord on the neck that failed,
 *  which is what a stale shape needs to be findable at all. */
const guitarBlues = (overrides: Partial<TrackBrief> = {}): TrackBrief =>
  bassBrief({
    id: 'rhythm',
    name: 'Guitar 2',
    instrumentId: 'guitar',
    role: 'comping, off the beat',
    ...overrides,
  });

/**
 * A chord's shape on a neck, ASKED OF THE SEAM and sorted the way the strum
 * spans count. Every expectation below is built out of this rather than out of
 * frets written here: a hardcoded grip is a grip that goes stale the day the lib
 * revoices anything, and then the tests pass while the app is wrong.
 */
interface Cell {
  readonly stringIndex: number;
  readonly fret: number;
}

const shapeOf = (symbol: string, instrumentId: string): readonly Cell[] => {
  const grip = chordGrip(symbol, instrumentId);
  if (!grip.ok) throw new Error(grip.reason);
  return [...grip.value.cells].sort((a, b) => a.stringIndex - b.stringIndex);
};

/** The shape as the model would have had to type it out — which is the thing this
 *  card exists to stop it doing. */
const asNotes = (cells: readonly Cell[]) =>
  cells.map((cell) => ({ string: cell.stringIndex, fret: cell.fret }));

/** A walkable bar: four quarter notes, none of them overlapping. */
const fourOnTheFloor = (): readonly IREvent[] =>
  [0, 1, 2, 3].map((beat) => ({
    atTick: beat * BEAT,
    durationTicks: BEAT,
    notes: [{ string: beat % 2, fret: 3 + beat }],
    dynamic: 'mf',
  }));

const brief = (of: TrackBrief): string => {
  const built = trackRunInput(of);
  if (!built.ok) throw new Error(`trackRunInput refused: ${built.reason}`);
  return built.value;
};

const refusalFor = (of: TrackBrief): string => {
  const built = trackRunInput(of);
  if (built.ok) throw new Error('trackRunInput was expected to refuse and did not');
  return built.reason;
};

/** One run, with what went out recorded. */
interface Rig {
  readonly deps: TrackRunDeps;
  readonly calls: {
    spec: AgentSpec;
    input: string;
    options: RunAgentTaskOptions | undefined;
  }[];
}

function rig(answer: Result<AgentRunSummary>): Rig {
  const calls: Rig['calls'] = [];
  return {
    calls,
    deps: {
      runTask: (spec, input, options) => {
        calls.push({ spec, input, options });
        return Promise.resolve(answer);
      },
    },
  };
}

/** A finished run that answered with `structured`. */
const answered = (structured: unknown): Result<AgentRunSummary> => ({
  ok: true,
  value: { content: '', stoppedReason: 'answered', toolCalls: [], structured },
});

/** The reasons a review gave, as one string — the shape a caller reads. */
const reviewed = (events: readonly IREvent[], of: TrackBrief = oneBar()): string =>
  reviewTrack(events, of)
    .map((refusal) => `${refusal.label}: ${refusal.reason}`)
    .join(' ');

// ------------------------------------------------------------------ tools ---

/**
 * THE GUARANTEE THE WHOLE DESIGN RESTS ON, and it is one assertion because the
 * harness makes it one: `outputSchema` reaches the backend as a grammar ONLY on a
 * turn where no tools are offered at all. A tool added to this spec does not
 * break a test about tools — it silently turns a decoded structure into a hope
 * about what the model happened to write, which no other test here would notice.
 */
describe('the track run has no tools', () => {
  it('offers none at all', () => {
    expect(IR_TRACK_AGENT.tools).toEqual([]);
  });

  it('tells the model so, and tells it not to fence the JSON', () => {
    // Both halves of the same fact: `JSON.parse` runs over the WHOLE reply with
    // no fence stripping, so a ```json block yields nothing.
    expect(IR_TRACK_AGENT.systemPrompt).toContain('no tools');
    expect(IR_TRACK_AGENT.systemPrompt).toContain('code fence');
  });
});

// ----------------------------------------------------------------- schema ---

describe('the schema is the neck it was built for', () => {
  it('bounds `string` by the instrument, not by the widest neck there is', () => {
    // A schema that took a guitar's six for a bass would let the grammar produce
    // string 5 on a four-string neck — which the pipeline then CLAMPS in silence,
    // sounding a pitch nobody wrote.
    const notesOf = (instrumentId: string) =>
      irTrackSchema(instrumentId).properties?.events.items?.properties?.notes.items?.properties;

    expect(notesOf('bass')?.string.maximum).toBe(3);
    expect(notesOf('guitar')?.string.maximum).toBe(5);
    expect(notesOf('ukulele')?.string.maximum).toBe(3);
  });

  it('tells the model what each string SOUNDS on the field it is filling in', () => {
    // ⚠ THIS SCHEMA IS PROMPT. These runs are tool-free precisely so the harness
    // sends it for grammar-enforced decoding, descriptions and all — so a
    // convention explained here reaches the model exactly as the brief's prose
    // does, only attached to the field. The 2026-08-16 bass run received "0 is
    // the BOTTOM string (the low E on a guitar)" HERE while being briefed as a
    // bass, and put all 48 of its notes on the G.
    const stringOf = (instrumentId: string) =>
      irTrackSchema(instrumentId).properties?.events.items?.properties?.notes.items?.properties
        ?.string.description ?? '';

    expect(stringOf('bass')).toContain('0 sounds E1');
    expect(stringOf('bass')).toContain('3 sounds G2');
    expect(stringOf('bass')).toContain('0 is the lowest-sounding');
    expect(stringOf('guitar')).toContain('5 sounds E4');
    // The neck it names is THIS neck, or the assertions above would hold for a
    // description that named a guitar for every part — which is what the deleted
    // sentence did.
    expect(stringOf('bass')).not.toContain('sounds E4');
    expect(stringOf('guitar')).not.toContain('sounds E1');
    expect(JSON.stringify(irTrackSchema('bass'))).not.toContain('low E on a guitar');

    // And the reentrant neck is not told the falsehood the brief refuses to tell
    // it: these two sentences reach the model in the same request and must not
    // contradict each other.
    expect(stringOf('ukulele')).toContain('0 sounds G4');
    expect(stringOf('ukulele')).toContain('They do not run low to high');
    expect(stringOf('ukulele')).toContain('1 is the lowest-sounding');
    expect(stringOf('ukulele')).not.toContain('0 is the lowest-sounding');
  });

  it('bounds `fret` by THIS neck, not by the app-wide ceiling', () => {
    // The ceiling is 24 for everything; the necks are not. A ukulele part at fret
    // 20 passes a `MAX_FRET` grammar, imports clean, is drawn by nothing and is
    // dropped from playback by `flattenTrack` — docs/FOLLOW-UPS.md row 12 — with
    // nothing said anywhere. Asked of the seam so a revoiced catalog moves this.
    const fretOf = (instrumentId: string) =>
      irTrackSchema(instrumentId).properties?.events.items?.properties?.notes.items?.properties
        ?.fret.maximum;

    expect(fretOf('guitar')).toBe(instrumentFretCount('guitar'));
    expect(fretOf('bass')).toBe(instrumentFretCount('bass'));
    expect(fretOf('ukulele')).toBe(instrumentFretCount('ukulele'));
    // And they really do differ from each other and from the app's ceiling, or
    // the three assertions above would hold for a bound that ignored the neck.
    expect(fretOf('ukulele')).toBeLessThan(Number(fretOf('bass')));
    expect(fretOf('bass')).toBeLessThan(Number(fretOf('guitar')));
    expect(fretOf('guitar')).toBeLessThan(MAX_FRET);
  });

  it('requires the time and nothing else, because what sounds has two shapes', () => {
    const event = irTrackSchema('guitar').properties?.events.items;

    // `notes` OR `strum`, and this dialect has no `oneOf` to say so — the grammar
    // can only require what every entry carries. `reviewTrack` refuses an entry
    // with neither, in a sentence a model can act on.
    expect(event?.required).toEqual(['atTick', 'durationTicks']);
    expect(Object.keys(event?.properties ?? {})).toEqual([
      'atTick',
      'durationTicks',
      'notes',
      'strum',
      'dynamic',
    ]);
    // A field the model spends tokens on that reaches nothing is worse than no
    // field: bends, slides and harmonics are not offered.
    expect(event?.additionalProperties).toBe(false);
  });

  it('offers the strum as a closed list, so the model cannot invent a span', () => {
    const strum = irTrackSchema('guitar').properties?.events.items?.properties?.strum;

    expect(strum?.enum).toEqual([...STRUM_SPANS]);
    // The whole point of the field: it carries no string and no fret, so there is
    // nothing in it to copy wrong.
    expect(strum?.type).toBe('string');
  });

  it('hands back the SAME object for one instrument', () => {
    // Not tidiness: `runAgentTask` passes the schema to the harness by reference
    // because `ajv`'s cache is keyed on the schema OBJECT and never evicted, so a
    // fresh object per run would leak a compiled validator per run.
    expect(irTrackSchema('bass')).toBe(irTrackSchema('bass'));
    expect(irTrackSchema('bass')).not.toBe(irTrackSchema('guitar'));
  });

  it('does NOT memoize a neck the catalog has never heard of', () => {
    // The memo's whole justification is that it is bounded by a catalog with
    // three entries in it. `irTrackSchema` is exported, so caching an arbitrary id
    // would grow the map for the life of the tab — one entry per typo, forever.
    expect(irTrackSchema('sitar')).not.toBe(irTrackSchema('sitar'));
  });
});

// ------------------------------------------------------------------ brief ---

describe('the brief does the arithmetic the model got wrong', () => {
  it('gives every chord its bars AND its ticks', () => {
    const text = brief(bassBrief());

    // A twelve-bar blues at 4/4: bar 5 starts at tick 7680, bar 9 at 15360.
    expect(TICKS_PER_BAR).toBe(1920);
    expect(text).toContain('C7 — bars 1 to 4, ticks 0 up to 7680');
    expect(text).toContain('F7 — bars 5 to 6, ticks 7680 up to 11520');
    expect(text).toContain('G7 — bar 9, ticks 15360 up to 17280');
    // The last chord runs to the end of the form, and nothing says "bar 13".
    expect(text).toContain('C7 — bars 11 to 12, ticks 19200 up to 23040');
    expect(text).not.toContain('bar 13');
  });

  it('names the end of the form in ticks, and says start PLUS duration', () => {
    const text = brief(bassBrief());

    expect(text).toContain('tick 23040');
    expect(text).toContain('Start plus duration, not start');
  });

  it('tells the model to work none of it out again', () => {
    expect(brief(bassBrief())).toContain('Do not work any of it out again');
  });
});

describe('the brief is voiced for THIS neck', () => {
  it('carries a different grip for a bass and for a guitar over the same chord', () => {
    // The whole reason the chart names a chord SYMBOL and never a fret: the same
    // C7 is a different hand position on each instrument, and a guitar shape moved
    // across onto a bass is a different chord with nothing to warn anyone.
    const bass = brief(oneBar());
    const guitar = brief(oneBar({ instrumentId: 'guitar', name: 'Rhythm', id: 'rhythm' }));

    // Asserted against the SEAM's own answer rather than against numbers written
    // out here — a hardcoded grip is a grip that goes stale the day the lib
    // revoices anything.
    const gripOf = (instrumentId: string) => {
      const grip = chordGrip('C7', instrumentId);
      if (!grip.ok) throw new Error(grip.reason);
      return grip.value.cells;
    };
    const bassCells = gripOf('bass');
    const guitarCells = gripOf('guitar');
    expect(bassCells).not.toEqual(guitarCells);

    for (const cell of bassCells) {
      expect(bass).toContain(`string ${cell.stringIndex}, fret ${cell.fret}`);
    }
    for (const cell of guitarCells) {
      expect(guitar).toContain(`string ${cell.stringIndex}, fret ${cell.fret}`);
    }
    // A four-string neck cannot carry the guitar's own cell on string 5.
    expect(guitarCells.some((cell) => cell.stringIndex > 3)).toBe(true);
    expect(bass).not.toContain('string 5,');
  });

  it('spells the string axis the way the ANSWER has to spell it', () => {
    // `chordGrip` says `stringIndex`; `IRNote` says `string`. Same number, same
    // convention, different key — and a model asked to rename a field mid-answer
    // is a model that will sometimes not.
    const text = brief(oneBar());

    expect(text).toContain('string 3, fret 0');
    expect(text).not.toContain('stringIndex');
  });

  it('says how many strings this instrument has', () => {
    expect(brief(oneBar())).toContain('This Bass has 4');
    expect(brief(oneBar({ instrumentId: 'guitar' }))).toContain('This Guitar has 6');
  });

  it('says where THIS neck ends, and not where the app’s ceiling is', () => {
    // The octave clause in the lifted MATERIAL paragraph sends a model twelve
    // frets up the same string. On a ukulele that runs off the end of a 15-fret
    // neck long before it reaches `MAX_FRET`, and nothing downstream says so.
    expect(brief(oneBar({ instrumentId: 'ukulele' }))).toContain(
      `up to ${instrumentFretCount('ukulele')}`,
    );
    expect(brief(oneBar({ instrumentId: 'ukulele' }))).not.toContain(`up to ${MAX_FRET}`);
    expect(brief(oneBar({ instrumentId: 'guitar' }))).toContain(
      `up to ${instrumentFretCount('guitar')}`,
    );
  });

  it('names what every string SOUNDS, and a different set per instrument', () => {
    // THE 2026-08-16 BASS DEFECT. The brief used to explain our numbering — "0 is
    // the low E on a guitar" — and lost to the player's numbering, where the
    // lowest string carries the HIGHEST number. All 48 notes of a bass part
    // landed on string 3, the G, which is in range on every one of them, so
    // nothing downstream caught it and nothing could have.
    const bass = brief(oneBar());
    const guitar = brief(oneBar({ instrumentId: 'guitar' }));

    // ⚠ BOTH LISTS ARE WRITTEN OUT, not asked of `instrumentOpenStrings`. An
    // expectation derived from the accessor the brief is built from reverses
    // whenever it does and passes either way — and the reversal is the whole
    // failure mode, at its worst on the six-string neck.
    expect(bass).toContain(
      'string 0 sounds E1, string 1 sounds A1, string 2 sounds D2, string 3 sounds G2',
    );
    expect(guitar).toContain(
      'string 0 sounds E2, string 1 sounds A2, string 2 sounds D3, string 3 sounds G3, string 4 sounds B3, string 5 sounds E4',
    );
    // The two really are different necks, or the assertions above would hold for
    // a brief that named one instrument for every part.
    expect(bass).not.toContain('string 5 sounds');
    expect(bass).not.toContain('string 0 sounds E2');
    expect(guitar).not.toContain('string 0 sounds E1');
  });

  it('states which string sounds LOWEST, which is the anchor the bass run needed', () => {
    // THE REGRESSION. The pitch list alone still leaves the model to work out
    // which end of it `string` 0 is. This is the sentence that says so, and a
    // future edit must not quietly drop it.
    const bass = brief(oneBar());

    expect(bass).toContain('string 0 sounds E1');
    expect(bass).toContain('String 0 is the lowest-sounding string on this instrument');
    // The second neck the task asked to differ gets the same anchor — the
    // ascending branch is not a bass-only sentence.
    expect(brief(oneBar({ instrumentId: 'guitar' }))).toContain(
      'String 0 is the lowest-sounding string on this instrument',
    );
    // ...and the old rule it replaced is gone, not sitting beside it — in the
    // schema that ships with the brief as well as in the prose.
    expect(bass).not.toContain('low E on a guitar');
    expect(JSON.stringify(irTrackSchema('bass'))).not.toContain('low E on a guitar');
  });

  it('does not tell a ukulele player that string 0 is the lowest PITCH', () => {
    // A reentrant ukulele is G4 C4 E4 A4: index 0 is the bottom string and the
    // second-highest note on it. "String 0 is the lowest-sounding" is a sentence
    // that is false on an instrument this module explicitly supports.
    const uke = brief(oneBar({ instrumentId: 'ukulele' }));

    expect(uke).toContain(
      'string 0 sounds G4, string 1 sounds C4, string 2 sounds E4, string 3 sounds A4',
    );
    expect(uke).toContain('They do not run low to high');
    expect(uke).toContain('string 1 (C4) is the lowest-sounding');
    expect(uke).toContain('string 3 (A4) the highest');
    expect(uke).not.toContain('String 0 is the lowest-sounding');
  });
});

describe('the brief tells the model to ask for a chord rather than copy one', () => {
  it('names the strum, every span it can ask for, and forbids the copy', () => {
    const text = brief(guitarBar());

    expect(text).toContain('"strum"');
    for (const span of STRUM_SPANS) expect(text).toContain(`"${span}"`);
    // The 2026-08-16 failure was a copied shape, so the brief says so in the
    // imperative rather than leaving the strum as an option among equals.
    expect(text).toContain('Never write a shape');
    expect(text).toContain('refused if they are not it');
    // ...and only about the strings the shape uses, which is all the check can
    // know: a promise the code does not keep is a rule the model avoids legal
    // writing to obey.
    expect(text).toContain('on the strings that shape uses');
  });

  it('says how long a strum occupies its strings, which the model cannot see', () => {
    // ⚠ THE ONE RULE THE FEATURE HIDES THE INPUTS TO. A strum's strings are never
    // shown to the model, so it cannot work out that a chord left ringing under a
    // second attack is two notes on one string — and the overlap walk refuses that
    // pair, with no retry, for a figure a guitarist plays every day.
    const text = brief(guitarBar());

    expect(text).toContain('A strum holds every string it hits for the whole of its');
    expect(text).toContain('starts at or after this one ends');
  });

  it('still hands over the shape, because the notes in it are the material', () => {
    // The strum does not replace the grip in the brief: `notes` is still how a
    // line is written, and the line is built out of these tones.
    const text = brief(guitarBar());

    for (const cell of shapeOf('C7', 'guitar')) {
      expect(text).toContain(`string ${cell.stringIndex}, fret ${cell.fret}`);
    }
    // Printed ASCENDING BY STRING, the order `shapeOf` sorts into and the order
    // the spans count in — the brief tells the model that "lowest-numbered" is
    // nearest string 0, and a shape printed in some other order would make that
    // sentence and the strum it describes disagree.
    const block = shapeOf('C7', 'guitar')
      .map((cell) => `    string ${cell.stringIndex}, fret ${cell.fret}`)
      .join('\n');
    expect(text).toContain(block);
  });
});

describe('a brief that cannot be built is refused rather than run', () => {
  it('passes the seam’s own sentence on for a symbol it cannot read', () => {
    const reason = refusalFor(oneBar({ chords: [{ bar: 1, symbol: 'Zz9' }] }));

    expect(reason).toContain('Zz9');
    expect(reason).toContain('not a chord symbol this app can read');
  });

  it('passes the seam’s own sentence on for a neck this app has not got', () => {
    const reason = refusalFor(oneBar({ instrumentId: 'sitar' }));

    expect(reason).toContain('sitar');
    expect(reason).toContain('not an instrument this app has a neck for');
  });

  it('refuses a form that is not a whole number of bars', () => {
    expect(refusalFor(bassBrief({ bars: 0 }))).toContain('whole number of bars');
    expect(refusalFor(bassBrief({ bars: 4.5 }))).toContain('whole number of bars');
  });

  it('refuses a chord that arrives outside the form, or out of order', () => {
    expect(
      refusalFor(oneBar({ bars: 4, chords: [{ bar: 1, symbol: 'C7' }, { bar: 9, symbol: 'F7' }] })),
    ).toContain('outside a form of 4 bars');
    expect(
      refusalFor(
        oneBar({
          bars: 8,
          // Bar 1 is present, or the refusal below would be about the hole at the
          // top of the form rather than about the order.
          chords: [
            { bar: 1, symbol: 'C7' },
            { bar: 5, symbol: 'F7' },
            { bar: 2, symbol: 'G7' },
          ],
        }),
      ),
    ).toContain('ascending bar order');
  });

  it('refuses a part with no name and a part with no role', () => {
    expect(refusalFor(oneBar({ name: '  ' }))).toContain('what the part is for');
    expect(refusalFor(oneBar({ role: '' }))).toContain('what the part DOES');
  });

  it('refuses a brief with no progression at all', () => {
    expect(refusalFor(oneBar({ chords: [] }))).toContain('no progression');
  });

  it('refuses a progression that names no chord at bar 1', () => {
    // Otherwise the brief tells the model to play the whole 12 bars while naming
    // no harmony for bars 1 and 2 — a hole no other check here can see, because
    // every one of them is about an entry that IS there.
    const reason = refusalFor(bassBrief({ chords: [{ bar: 3, symbol: 'C7' }] }));

    expect(reason).toContain('no chord at bar 1');
  });

  it('refuses a blank id, which the pipeline would replace with one of its own', () => {
    // The id is the CALLER's — ids are the one thing a model must never be asked
    // to keep unique — and `validateImportIR` silently substitutes `track-<n>`, so
    // a blank one becomes a track nobody can match back to the brief it came from.
    expect(refusalFor(oneBar({ id: '  ' }))).toContain('no id');
  });
});

// ------------------------------------------------- the prose that was lifted ---

/**
 * ⚠ THE MUSICAL PARAGRAPHS ARE `patternRunInput`'s, AND THIS IS THE PIN.
 *
 * That function's brief is the only prose in this area the user has verified by
 * hand. This run covers a progression rather than one chord and answers with JSON
 * rather than by calling tools, but what it says about MUSIC has to be the same
 * text — reworded, it is a second baseline nobody has listened to, and the two
 * would drift apart one clause at a time with every test still passing.
 *
 * The comparison fails on a reword in EITHER file, which is what makes it worth
 * having. Exactly two clauses are excused, by name, for the two reasons this run
 * differs at all.
 */
describe('the musical paragraphs are the sub-run’s, lifted', () => {
  const paragraphs = (text: string): readonly string[] => text.split('\n\n');

  const paragraphStartingWith = (text: string, prefix: string): string => {
    const found = paragraphs(text).filter((para) => para.startsWith(prefix));
    // Exactly one, or the assertions below are about the wrong text — and a
    // paragraph that has been split in two would otherwise silently match half.
    expect(found).toHaveLength(1);
    return found[0];
  };

  /** The sub-run's brief for a part of the same length, so the paragraph about
   *  going somewhere over several bars exists in both. */
  const subRun = (): string => {
    const built = patternRunInput({
      name: 'Walking Bass',
      instrumentId: 'bass',
      chord: 'C7',
      lengthBars: 12,
    });
    if (!built.ok) throw new Error(`patternRunInput refused: ${built.reason}`);
    return built.value;
  };

  it('says what MATERIAL means in the same words, minus the articulations it has not got', () => {
    // The one excused clause: this run emits `dynamic` and nothing else, because
    // that is all the mapper carries to velocity. Telling the model to choose an
    // articulation it cannot express is a brief that lies.
    const theirs = paragraphStartingWith(subRun(), 'This is MATERIAL');
    const ours = paragraphStartingWith(brief(bassBrief()), 'This is MATERIAL');

    expect(theirs).toContain(', how hard and with what articulation');
    expect(ours).toBe(theirs.replace(', how hard and with what articulation', ' and how hard'));
  });

  it('forbids the chord dumped on the downbeat in the same words, minus the tool’s verb', () => {
    // The other excused clause: there is no stamp tool in this run, and a verb
    // naming one is a verb the model will go looking for.
    const theirs = paragraphStartingWith(subRun(), 'Do not stamp the shape');
    const ours = paragraphStartingWith(brief(bassBrief()), 'Do not write the shape');

    expect(ours).toBe(theirs.replace('Do not stamp the shape', 'Do not write the shape'));
  });

  it('asks for a bar with something in it in exactly the same words', () => {
    // No excuse at all on this one — character for character.
    const theirs = paragraphStartingWith(subRun(), 'A bar has more than one attack');
    const ours = paragraphStartingWith(brief(bassBrief()), 'A bar has more than one attack');

    expect(ours).toBe(theirs);
  });
});

// ----------------------------------------------------------------- review ---

describe('what the import pipeline would swallow, refused here', () => {
  it('accepts a part that is in range, in time and out of its own way', () => {
    expect(reviewTrack(fourOnTheFloor(), oneBar())).toEqual([]);
  });

  it('refuses a fractional atTick rather than letting the event be dropped', () => {
    // `validateImportIR` discards a non-integer `atTick` — the EVENT and every
    // note on it — and says nothing at all. It is the single likeliest mistake for
    // a model emitting JSON.
    const said = reviewed([
      { atTick: 0, durationTicks: BEAT, notes: [{ string: 0, fret: 3 }] },
      { atTick: 480.5, durationTicks: BEAT, notes: [{ string: 1, fret: 5 }] },
    ]);

    // Named by position AND by tick: the position is what the model can find in
    // what it wrote, and printing `480.5` back is most of the repair.
    expect(said).toContain('event 2');
    expect(said).toContain('480.5');
    expect(said).toContain('whole numbers');
  });

  it('refuses a fractional durationTicks the same way', () => {
    const said = reviewed([{ atTick: 0, durationTicks: 240.5, notes: [{ string: 0, fret: 3 }] }]);

    expect(said).toContain('240.5');
    expect(said).toContain('whole number of ticks');
  });

  it('refuses a negative atTick', () => {
    const said = reviewed([{ atTick: -BEAT, durationTicks: BEAT, notes: [{ string: 0, fret: 3 }] }]);

    expect(said).toContain('-480');
    expect(said).toContain('counted from 0');
  });

  it('refuses a durationTicks of zero, which is an attack with no length', () => {
    const said = reviewed([{ atTick: 0, durationTicks: 0, notes: [{ string: 0, fret: 3 }] }]);

    expect(said).toContain('durationTicks is 0');
    expect(said).toContain('at least 1');
  });

  it('refuses a fret past the end of the range rather than letting it be clamped', () => {
    // The validator clamps at 36, not at a neck, so fret 99 becomes a fret nobody
    // wrote. Only the per-track and per-document caps ever warn.
    const said = reviewed([{ atTick: 0, durationTicks: BEAT, notes: [{ string: 0, fret: 99 }] }]);

    expect(said).toContain('fret 99');
    expect(said).toContain(String(instrumentFretCount('bass')));
  });

  it('refuses a fret past THIS neck even though the app-wide ceiling allows it', () => {
    // Fret 20 on a ukulele is inside `MAX_FRET` and five frets off the end of the
    // instrument. Nothing clamps it — it is stored, drawn by nothing and dropped
    // from playback, which is a note the run believes it wrote and nobody hears.
    const high = [{ atTick: 0, durationTicks: BEAT, notes: [{ string: 0, fret: 20 }] }];

    expect(20).toBeLessThan(MAX_FRET);
    expect(reviewed(high, oneBar({ instrumentId: 'ukulele' }))).toContain('fret 20');
    // The same note on a guitar is inside its 22 and is not refused.
    expect(reviewTrack(high, oneBar({ instrumentId: 'guitar' }))).toEqual([]);
  });

  it('refuses a fret and a string that are not whole numbers', () => {
    // Exactly as likely as a fractional tick from a model emitting JSON, and the
    // pipeline's guard is `isFiniteInt` on both axes: a fractional one is dropped
    // from the note list without a word.
    expect(
      reviewed([{ atTick: 0, durationTicks: BEAT, notes: [{ string: 0, fret: 3.5 }] }]),
    ).toContain('fret 3.5');
    expect(
      reviewed([{ atTick: 0, durationTicks: BEAT, notes: [{ string: 1.5, fret: 3 }] }]),
    ).toContain('string 1.5');
  });

  it('refuses a string this instrument has not got', () => {
    // String 5 exists on a guitar and not on a bass, so the same note is a
    // refusal on one brief and fine on the other — which is the whole reason the
    // bound is asked of the instrument rather than assumed.
    const note = { atTick: 0, durationTicks: BEAT, notes: [{ string: 5, fret: 3 }] };

    const said = reviewed([note]);
    expect(said).toContain('string 5');
    expect(said).toContain('bass has not got');
    expect(said).toContain('strings 0 to 3');

    expect(reviewTrack([note], oneBar({ instrumentId: 'guitar' }))).toEqual([]);
  });

  it('refuses an event with no notes, which the pipeline commits as a silence', () => {
    // The nastiest of the three: an event whose notes were all dropped SURVIVES
    // with an empty list, so a pattern with nothing in it commits as a success.
    const said = reviewed([{ atTick: 0, durationTicks: BEAT, notes: [] }]);

    expect(said).toContain('event 1');
    expect(said).toContain('no notes');
  });

  it('refuses a part with no events at all, and says so once', () => {
    const refusals = reviewTrack([], oneBar());

    expect(refusals).toHaveLength(1);
    expect(refusals[0].reason).toContain('no events at all');
  });

  it('refuses two notes that overlap on one string', () => {
    // The same rule `pattern_stamp_notes` enforces, and for the same reason: a
    // string can only ring one note at a time. The import path stores both without
    // a word, where the editor's own seam would have refused the second.
    const said = reviewed([
      { atTick: 0, durationTicks: BEAT, notes: [{ string: 1, fret: 3 }] },
      { atTick: BEAT / 2, durationTicks: BEAT, notes: [{ string: 1, fret: 5 }] },
    ]);

    expect(said).toContain('string 1');
    expect(said).toContain('still sounding until 480');
    expect(said).toContain('one note at a time');
  });

  it('refuses two notes of ONE event that land on the same string', () => {
    // A grip written back with a doubled string is the commonest way to write an
    // unplayable chord, and it looks exactly like a legal one.
    const said = reviewed([
      { atTick: 0, durationTicks: BEAT, notes: [{ string: 2, fret: 3 }, { string: 2, fret: 5 }] },
    ]);

    expect(said).toContain('string 2');
    expect(said).toContain('one note at a time');
  });

  it('allows two notes at one tick on DIFFERENT strings', () => {
    // TWO, as the name says: a double-stop carries no harmony of its own and the
    // chord check below never looks at it. Three would be a chord and is judged
    // as one — 'a typed chord is checked against the shape' has that.
    expect(
      reviewTrack(
        [
          {
            atTick: 0,
            durationTicks: BEAT,
            notes: [
              { string: 0, fret: 3 },
              { string: 1, fret: 2 },
            ],
          },
        ],
        oneBar(),
      ),
    ).toEqual([]);
  });

  it('allows a note that ends exactly where the next one on that string begins', () => {
    // The bound is half-open, as it has to be: back-to-back quarter notes on one
    // string is the most ordinary bass line there is.
    expect(
      reviewTrack(
        [
          { atTick: 0, durationTicks: BEAT, notes: [{ string: 0, fret: 3 }] },
          { atTick: BEAT, durationTicks: BEAT, notes: [{ string: 0, fret: 5 }] },
        ],
        oneBar({ bars: 1 }),
      ),
    ).toEqual([]);
  });

  it('refuses an event that rings past the end of the form', () => {
    // `atTick + durationTicks`, not `atTick`: a note that begins inside the last
    // bar and rings past its barline is still a note past the end of the piece.
    const said = reviewed([
      { atTick: TICKS_PER_BAR - BEAT, durationTicks: BEAT * 2, notes: [{ string: 0, fret: 3 }] },
    ]);

    expect(said).toContain(String(TICKS_PER_BAR));
    expect(said).toContain('past the end');
  });

  it('says nothing about the form when the brief’s own form is not a whole count', () => {
    // `trackRunInput` refuses such a brief before a run ever happens, so this is a
    // suppression and not a second opinion: blaming every event for one bad number
    // in the brief fills the capped refusal with noise about the wrong thing.
    const pastAnyForm = [
      { atTick: 0, durationTicks: TICKS_PER_BAR * 9, notes: [{ string: 0, fret: 3 }] },
    ];

    expect(reviewTrack(pastAnyForm, oneBar({ bars: 4.5 }))).toEqual([]);
    // ...and the same events against a real form ARE refused, or the assertion
    // above would hold for a check that had simply been deleted.
    expect(reviewed(pastAnyForm, oneBar({ bars: 4 }))).toContain('past the end');
  });

  it('names EVERY note a long one is sitting on top of, not just the first', () => {
    // Sorted by start and compared only with the immediate predecessor, the third
    // note here is missed: it sits wholly inside the first, but the second (already
    // refused, and still in the array) ends before it begins. Detection was never
    // wrong — the part is refused either way — but the model repairs from the list,
    // and one collision per round trip is one round trip per collision.
    const said = reviewTrack(
      [
        { atTick: 0, durationTicks: TICKS_PER_BAR, notes: [{ string: 1, fret: 3 }] },
        { atTick: BEAT, durationTicks: BEAT, notes: [{ string: 1, fret: 5 }] },
        { atTick: BEAT * 3, durationTicks: BEAT, notes: [{ string: 1, fret: 7 }] },
      ],
      oneBar(),
    );

    expect(said).toHaveLength(2);
    // Both are named against the note that is actually still ringing — event 1.
    for (const refusal of said) {
      expect(refusal.reason).toContain('event 1');
      expect(refusal.reason).toContain(`sounding until ${TICKS_PER_BAR}`);
    }
    expect(said.map((refusal) => refusal.label)).toEqual(['event 2 (tick 480)', 'event 3 (tick 1440)']);
  });

  it('says nothing about the range of an event it has already thrown out', () => {
    // A fractional tick means the event will not exist by the time anything could
    // complain about where it ends. Two accounts of one mistake fill the capped
    // refusal sentence with the same fact twice.
    const refusals = reviewTrack(
      [{ atTick: 0.5, durationTicks: TICKS_PER_BAR * 9, notes: [] }],
      oneBar(),
    );

    expect(refusals).toHaveLength(1);
    expect(refusals[0].reason).toContain('0.5');
  });
});

// ------------------------------------------------------------------ strum ---

/**
 * ⚠ THE DEFECT THIS SECTION IS ABOUT is the 2026-08-16 run: the C7 shape was
 * handed over in full and the guitar retyped it right 8 times out of 24. The fix
 * is that it never types it — it says WHEN, HOW LONG and HOW MUCH OF IT, and the
 * cells come from the grip this module already looked up.
 */
describe('a chord the model does not have to transcribe', () => {
  it('fills a strum in from the shape, at the tick and length it asked for', () => {
    const filled = expandStrums(
      [{ atTick: BEAT, durationTicks: BEAT * 2, strum: 'all', dynamic: 'ff' }],
      guitarBar(),
    );

    expect(filled.refusals).toEqual([]);
    expect(filled.events).toEqual([
      {
        atTick: BEAT,
        durationTicks: BEAT * 2,
        dynamic: 'ff',
        notes: asNotes(shapeOf('C7', 'guitar')),
      },
    ]);
  });

  it('derives WHICH chord from the tick, so the model never names one', () => {
    // Bar 5 of the twelve-bar is F7 and bar 1 is C7. The brief already carries
    // both and the tick each arrives at; asking the model to say which one it is
    // playing is one more fact to restate and get wrong.
    const filled = expandStrums(
      [
        { atTick: 0, durationTicks: BEAT, strum: 'all' },
        { atTick: TICKS_PER_BAR * 4, durationTicks: BEAT, strum: 'all' },
      ],
      bassBrief(),
    );

    expect(filled.events[0].notes).toEqual(asNotes(shapeOf('C7', 'bass')));
    expect(filled.events[1].notes).toEqual(asNotes(shapeOf('F7', 'bass')));
    expect(filled.events[0].notes).not.toEqual(filled.events[1].notes);
  });

  it('holds a chord until the next one arrives, mid-bar included', () => {
    // A chord holds; the strum lands on the last eighth of bar 6, which is still
    // the F7 that arrived at bar 5.
    const filled = expandStrums(
      [{ atTick: TICKS_PER_BAR * 6 - BEAT / 2, durationTicks: BEAT / 2, strum: 'all' }],
      bassBrief(),
    );

    expect(filled.events[0].notes).toEqual(asNotes(shapeOf('F7', 'bass')));
  });

  it('takes only the part of the shape a partial strum asked for — every span', () => {
    // A comping part does not hit every string every time, which is the whole
    // reason this is a span and not a boolean.
    //
    // ⚠ DRIVEN OFF `STRUM_SPANS`, so a span added without an expectation here is a
    // TYPE error rather than a span nothing checks: the record below is total over
    // the union. Each slice is stated independently of the module's own table —
    // the test says what a span MEANS, the module says how it is computed.
    const expected: Record<(typeof STRUM_SPANS)[number], (cells: readonly Cell[]) => readonly Cell[]> =
      {
        all: (cells) => cells,
        'bottom-2': (cells) => cells.slice(0, 2),
        'bottom-3': (cells) => cells.slice(0, 3),
        'top-2': (cells) => cells.slice(cells.length - 2),
        'top-3': (cells) => cells.slice(cells.length - 3),
      };
    const shape = shapeOf('C7', 'guitar');
    // ...and the five really are five different answers on this shape, or a span
    // that quietly strummed everything would satisfy the loop below.
    expect(shape).toHaveLength(5);

    const seen = new Set<string>();
    for (const span of STRUM_SPANS) {
      const filled = expandStrums([{ atTick: 0, durationTicks: BEAT, strum: span }], guitarBar());

      expect(filled.refusals).toEqual([]);
      expect(filled.events[0].notes).toEqual(asNotes(expected[span](shape)));
      seen.add(JSON.stringify(filled.events[0].notes));
    }
    expect(seen.size).toBe(STRUM_SPANS.length);
  });

  it('fills the chord in for an entry that left an empty `notes` behind', () => {
    // `notes` is still an advertised property, so an entry that asked for the
    // chord and emitted `"notes": []` said ONE thing. Refusing it for saying two
    // would cost the whole part over an empty array, and there is no retry.
    const filled = expandStrums(
      [{ atTick: 0, durationTicks: BEAT, strum: 'all', notes: [] }],
      guitarBar(),
    );

    expect(filled.refusals).toEqual([]);
    expect(filled.events[0].notes).toEqual(asNotes(shapeOf('C7', 'guitar')));
  });

  it('leaves a written line exactly as it was written', () => {
    const line = fourOnTheFloor();

    expect(expandStrums(line, oneBar()).events).toEqual(line);
  });

  it('is caught by the EXISTING overlap check when it lands on a ringing string', () => {
    // ⚠ THE POINT OF EXPANDING BEFORE THE REVIEW. A filled-in chord is subject to
    // every check the model's own notes are — there is no second path into the
    // document that skips them.
    const shape = shapeOf('C7', 'guitar');
    const held = shape[1];
    const answer: IRAnswerEvent[] = [
      {
        atTick: 0,
        durationTicks: BEAT * 2,
        notes: [{ string: held.stringIndex, fret: held.fret }],
      },
      { atTick: BEAT, durationTicks: BEAT, strum: 'all' },
    ];

    const filled = expandStrums(answer, guitarBar());
    const said = reviewTrack(filled.events, guitarBar());

    expect(filled.refusals).toEqual([]);
    expect(said).toHaveLength(1);
    expect(said[0].label).toBe(`event 2 (tick ${BEAT})`);
    expect(said[0].reason).toContain(`string ${held.stringIndex}`);
    expect(said[0].reason).toContain('one note at a time');
  });

  it('refuses an entry that both asks for the chord and types its own notes', () => {
    // Nothing else can see this one: after expansion it is just an event with
    // notes on it, and both readings sound different.
    const filled = expandStrums(
      [{ atTick: 0, durationTicks: BEAT, strum: 'all', notes: [{ string: 0, fret: 3 }] }],
      guitarBar(),
    );

    expect(filled.refusals).toHaveLength(1);
    expect(filled.refusals[0].label).toBe('event 1 (tick 0)');
    expect(filled.refusals[0].reason).toContain('both');
    // What it typed is kept, so the rest of the review still speaks about it.
    expect(filled.events[0].notes).toEqual([{ string: 0, fret: 3 }]);
  });

  it('leaves an entry with neither to the review, which already names it', () => {
    const filled = expandStrums([{ atTick: 0, durationTicks: BEAT }], guitarBar());

    expect(filled.refusals).toEqual([]);
    expect(filled.events[0].notes).toEqual([]);
    expect(reviewed(filled.events, guitarBar())).toContain('no notes');
  });

  it('numbers the events where the model wrote them', () => {
    // Expansion is 1:1 and in order, so `event 3` in a refusal is the third entry
    // of the answer. An expansion that dropped or merged entries would renumber
    // every refusal after it.
    const filled = expandStrums(
      [
        { atTick: 0, durationTicks: BEAT, strum: 'all' },
        { atTick: BEAT, durationTicks: BEAT, strum: 'top-2' },
        { atTick: BEAT * 2, durationTicks: 0.5, strum: 'all' },
      ],
      guitarBar(),
    );

    expect(filled.events).toHaveLength(3);
    expect(reviewTrack(filled.events, guitarBar())[0].label).toBe(`event 3 (tick ${BEAT * 2})`);
  });
});

// ----------------------------------------------------- the chord it did type ---

describe('a typed chord is checked against the shape', () => {
  /** The shape written out by hand — the 8 events of the run that were right. */
  const typed = (cells: readonly { stringIndex: number; fret: number }[]): IREvent[] => [
    { atTick: 0, durationTicks: BEAT, notes: asNotes(cells) },
  ];

  it('THE REGRESSION: refuses the 2026-08-16 voicing, every string shifted down one', () => {
    // The exact failure. The brief was right, the shape was handed over in full,
    // and a third of the section came back with the same frets on the wrong
    // strings — which sounds G-D-F-C-D instead of C-G-Bb-E-G.
    const shape = shapeOf('C7', 'guitar');
    // The shift has to stay on the neck, or the range check would be what fires.
    expect(shape[0].stringIndex).toBeGreaterThan(0);
    const shifted = shape.map((cell) => ({ string: cell.stringIndex - 1, fret: cell.fret }));

    const said = reviewTrack([{ atTick: 0, durationTicks: BEAT, notes: shifted }], guitarBar());

    expect(said).toHaveLength(1);
    expect(said[0].label).toBe('event 1 (tick 0)');
    expect(said[0].reason).toContain('C7');
    // Named, as the range refusals name theirs: every note that moved off the
    // shape, and the shape it was measured against.
    const onShape = new Map(shape.map((cell) => [cell.stringIndex, cell.fret]));
    const moved = shifted.filter(
      (note) => onShape.has(note.string) && onShape.get(note.string) !== note.fret,
    );
    expect(moved.length).toBeGreaterThan(1);
    for (const note of moved) {
      expect(said[0].reason).toContain(`string ${note.string} fret ${note.fret}`);
    }
    expect(said[0].reason).toContain(`string ${shape[0].stringIndex} fret ${shape[0].fret}`);
    // And it says what to do instead, which is the only repair there is.
    expect(said[0].reason).toContain('strum');
  });

  it('THE REGRESSION: names the chord it actually played, not "a fret or two off"', () => {
    // ⚠ THE 2026-08-16 'Guitar 2' FAILURE, byte for byte. Its first event was six
    // notes, strings 0..5 at frets 1,3,1,2,1,1 — the F7 barre — at bar 1, where
    // the chart said C7. It had copied the wrong line out of its own brief.
    //
    // The check caught it and said the wrong thing: TWO of those six sit within
    // `SLIP_FRETS` of C7's shape, so the slip branch claimed the event and
    // reported "two notes are a fret or two off" about a stack that was a
    // different chord entirely — while the stale branch, the one that could have
    // named F7, was computed only where the slip branch had NOT fired.
    const wrong = asNotes(shapeOf('F7', 'guitar'));
    // Pinned as the literal event, so a revoicing in the lib says "this fixture
    // is no longer the historical failure" rather than quietly testing something
    // else under the same name.
    expect(wrong).toEqual([
      { string: 0, fret: 1 },
      { string: 1, fret: 3 },
      { string: 2, fret: 1 },
      { string: 3, fret: 2 },
      { string: 4, fret: 1 },
      { string: 5, fret: 1 },
    ]);

    const said = reviewTrack(
      [{ atTick: 0, durationTicks: BEAT, notes: wrong }],
      guitarBlues(),
    );

    expect(said).toHaveLength(1);
    expect(said[0].label).toBe('event 1 (tick 0)');
    // The diagnosis a model can act on in one go: the chord it played, the bars
    // that chord belongs to, and the chord that belongs here.
    expect(said[0].reason).toContain('F7');
    expect(said[0].reason).toContain('bars 5 and 10');
    expect(said[0].reason).toContain('C7');
    expect(said[0].reason).toContain('bar 1');
    // And NOT the sentence that used to win this race.
    expect(said[0].reason).not.toContain('a fret or two off');
    expect(said[0].reason).toContain('strum');
  });

  it('names the other chord off a SUBSET of it, and claims no more than that', () => {
    // ⚠ THE PREDICATE IS A SUBSET, NOT AN IDENTITY: three notes that are three
    // cells of a six-cell barre satisfy it. The diagnosis is still the useful one
    // — those cells are that chord's and not this one's — but the sentence must
    // not say the stack IS the whole shape, which it has not checked.
    const three = asNotes(shapeOf('F7', 'guitar').slice(0, 3));
    const said = reviewTrack([{ atTick: 0, durationTicks: BEAT, notes: three }], guitarBlues());

    expect(said).toHaveLength(1);
    expect(said[0].reason).toContain('every one of them is a cell of the F7 shape');
    expect(said[0].reason).not.toContain('they are the shape of F7');
  });

  it('does not call a voicing stale over ONE cell it shares with another chord', () => {
    // ⚠ WHAT THE `every` IN THE STALE PREDICATE IS FOR, and the only assertion
    // that would notice it loosening to `some`. The stale shape is now looked for
    // FIRST and unconditionally, so the way it can newly cost music is by
    // claiming a legitimate voicing that merely OVERLAPS another chord of the
    // progression — and overlap is ordinary: two chords a fourth apart share
    // cells. This is C7 with one note borrowed off F7's shape, which is the
    // tolerated colour note the case above allows, and it must stay allowed.
    const c7 = shapeOf('C7', 'guitar');
    const f7 = shapeOf('F7', 'guitar');
    const borrowed = f7.find((cell) =>
      c7.some((own) => own.stringIndex === cell.stringIndex && own.fret !== cell.fret),
    );
    if (borrowed === undefined) throw new Error('expected F7 and C7 to share a string');

    const notes = asNotes(c7).map((note) =>
      note.string === borrowed.stringIndex ? { string: note.string, fret: borrowed.fret } : note,
    );
    // It OVERLAPS F7 without being it — a stack that is F7 cell for cell is the
    // regression above, and this one has to stay on the other side of that line.
    const shared = notes.filter((note) =>
      f7.some((cell) => cell.stringIndex === note.string && cell.fret === note.fret),
    );
    expect(shared.length).toBeGreaterThan(0);
    expect(shared.length).toBeLessThan(notes.length);
    expect(notes.length).toBeGreaterThanOrEqual(3);

    expect(reviewTrack([{ atTick: 0, durationTicks: BEAT, notes }], guitarBlues())).toEqual([]);
  });

  it('allows the shape typed out correctly, which is the other two thirds', () => {
    expect(reviewTrack(typed(shapeOf('C7', 'guitar')), guitarBar())).toEqual([]);
  });

  it('allows the shape an octave up on the same string', () => {
    // The one piece of fret arithmetic the brief sanctions: twelve frets up the
    // same string is the same tone. Only the cells that still fit the neck.
    const shape = shapeOf('C7', 'guitar')
      .map((cell) => ({ stringIndex: cell.stringIndex, fret: cell.fret + 12 }))
      .filter((cell) => cell.fret <= instrumentFretCount('guitar'));

    expect(shape.length).toBeGreaterThanOrEqual(3);
    expect(reviewTrack(typed(shape), guitarBar())).toEqual([]);
  });

  it('allows ONE note off the shape as colour', () => {
    // The tolerance, pinned: a comper adds a tone the preferred voicing left out,
    // and the run has no retry — refusing real music costs more than passing an
    // odd voicing.
    const shape = shapeOf('C7', 'guitar');
    const coloured = asNotes(shape).map((note, index) =>
      index === 0 ? { string: note.string, fret: note.fret + 1 } : note,
    );

    expect(reviewTrack([{ atTick: 0, durationTicks: BEAT, notes: coloured }], guitarBar())).toEqual(
      [],
    );
    // ⚠ AND AGAINST A BRIEF WITH MORE THAN ONE CHORD ON IT, which is the only
    // kind where the stale branch can fire at all: `guitarBar` has ONE chord, so
    // `other.symbol !== shape.symbol` is never true and this case would pass with
    // the stale check deleted. Since the stale shape is now looked for FIRST and
    // unconditionally, over-refusing a legitimate voicing is exactly what it
    // risks, and this is the assertion that would notice.
    expect(
      reviewTrack([{ atTick: 0, durationTicks: BEAT, notes: coloured }], guitarBlues()),
    ).toEqual([]);
  });

  it('does not treat a two-note double-stop as a chord', () => {
    // Two notes carry no harmony of their own — a tenth, a sixth, a root and
    // fifth are ordinary line writing. Both of these are off the shape.
    const shape = shapeOf('C7', 'guitar');
    const doubleStop = [
      { string: shape[0].stringIndex, fret: shape[0].fret + 1 },
      { string: shape[1].stringIndex, fret: shape[1].fret + 1 },
    ];

    expect(reviewTrack([{ atTick: 0, durationTicks: BEAT, notes: doubleStop }], guitarBar())).toEqual(
      [],
    );
  });

  it('does not refuse a walking bass line of passing notes', () => {
    // ⚠ THE THING THE CHECK MUST NOT DO. A walk is mostly notes that are not in
    // the chord, and every one of them is a single note — the check never looks.
    const walk: IREvent[] = Array.from({ length: 16 }, (_, step) => ({
      atTick: step * BEAT,
      durationTicks: BEAT,
      notes: [{ string: step % 2, fret: 1 + (step % 12) }],
    }));

    expect(reviewTrack(walk, bassBrief())).toEqual([]);
  });

  it('does not let a THREE-note mis-copy through, which pins the threshold', () => {
    // The threshold from above: at four, this stack would pass and only the
    // five-note ones below would be refused. Every fret one off the shape, on
    // three strings the shape uses.
    const shape = shapeOf('C7', 'guitar');
    const misread = shape
      .slice(0, 3)
      .map((cell) => ({ string: cell.stringIndex, fret: cell.fret + 1 }));
    const said = reviewTrack([{ atTick: 0, durationTicks: BEAT, notes: misread }], guitarBar());

    expect(said).toHaveLength(1);
    expect(said[0].reason).toContain('C7');
  });

  it('allows a voicing taken somewhere else on the neck entirely', () => {
    // ⚠ WHAT THE SLIP BOUND IS FOR. `chordGrip` returns ONE voicing, so "not this
    // fret" is not "not this chord": a stack four frets away is a position this
    // module was never told about, and refusing it would cost the whole piece for
    // a chord that may well be right. One fret further than the bound, so raising
    // the bound to reach it fails here.
    const shape = shapeOf('C7', 'guitar');
    const elsewhere = shape
      .slice(0, 3)
      .map((cell) => ({ string: cell.stringIndex, fret: cell.fret + 4 }));

    expect(elsewhere.every((note) => note.fret <= instrumentFretCount('guitar'))).toBe(true);
    expect(reviewTrack([{ atTick: 0, durationTicks: BEAT, notes: elsewhere }], guitarBar())).toEqual(
      [],
    );
    // Against the whole progression too, for the reason given above: with F7 and
    // G7 also on the sheet, the stale branch is live and this voicing is the
    // shape of none of them.
    expect(
      reviewTrack([{ atTick: 0, durationTicks: BEAT, notes: elsewhere }], guitarBlues()),
    ).toEqual([]);
  });

  it('says nothing about notes on strings the shape does not use', () => {
    // ⚠ A LIMIT, NOT A CHOICE. `chordGrip` hands back cells and tone NAMES and no
    // tuning — deliberately — so nothing on this side of the seam can say what
    // pitch an arbitrary string and fret is. On a string the shape does not use,
    // a chord tone and a wrong note are indistinguishable here, so neither is
    // counted. The 2026-08-16 voicing is caught by the four strings it MOVED.
    //
    // ⚠ THE STACK IS FIVE NOTES AND ONE OF THEM IS ALREADY THE TOLERATED ONE, so
    // that counting the stranger too would tip it over: three cells typed right,
    // one a fret off as colour, and the stranger. A check that judged an off-shape
    // string would refuse this, which is the whole claim.
    const shape = shapeOf('C7', 'guitar');
    const unused = [0, 1, 2, 3, 4, 5].filter(
      (index) => !shape.some((cell) => cell.stringIndex === index),
    );

    expect(unused).not.toHaveLength(0);
    const withStranger = [
      ...asNotes(shape.slice(1, 4)),
      { string: shape[0].stringIndex, fret: shape[0].fret + 1 },
      { string: unused[0], fret: 7 },
    ];
    expect(withStranger).toHaveLength(5);
    expect(
      reviewTrack([{ atTick: 0, durationTicks: BEAT, notes: withStranger }], guitarBar()),
    ).toEqual([]);
  });

  it('measures the chord on the notes that survived, not on the ones it threw out', () => {
    // The `playable` filter, pinned: a note refused for its fret is a note whose
    // fret is not yet known, so it can be neither on nor off the shape — and
    // counting it would tip this stack past the tolerance and put two accounts of
    // one mistake in a capped sentence.
    const shape = shapeOf('C7', 'guitar');
    const said = reviewTrack(
      [
        {
          atTick: 0,
          durationTicks: BEAT,
          notes: [
            ...asNotes(shape.slice(1, 3)),
            { string: shape[0].stringIndex, fret: shape[0].fret + 1 },
            { string: shape[3].stringIndex, fret: shape[3].fret + 0.5 },
          ],
        },
      ],
      guitarBar(),
    );

    expect(said).toHaveLength(1);
    expect(said[0].reason).toContain(`fret ${shape[3].fret + 0.5}`);
  });

  it('says nothing about notes it has already refused for being off the neck', () => {
    // A note refused for its string is a note whose string is not yet known, so it
    // can be neither on nor off the shape — two accounts of one mistake is what
    // the capped refusal sentence cannot afford.
    const shape = shapeOf('C7', 'guitar');
    const said = reviewTrack(
      [
        {
          atTick: 0,
          durationTicks: BEAT,
          notes: [...asNotes(shape).slice(0, 2), { string: 9, fret: 3 }],
        },
      ],
      guitarBar(),
    );

    expect(said).toHaveLength(1);
    expect(said[0].reason).toContain('string 9');
  });

  it('judges each event on the chord in force at ITS tick, and names the stale one', () => {
    // The same frets are C7's shape in bar 1 and the chord from the bar before in
    // bar 5, which is what a copied shape looks like after a change. It is far
    // enough from F7's own shape that the slip bound says nothing about it — the
    // ONE thing that can still be said is that it is, cell for cell, another chord
    // of this same progression, and that is what the refusal says.
    const shape = shapeOf('C7', 'bass');
    const said = reviewTrack(
      [
        { atTick: 0, durationTicks: BEAT, notes: asNotes(shape) },
        { atTick: TICKS_PER_BAR * 4, durationTicks: BEAT, notes: asNotes(shape) },
      ],
      bassBrief(),
    );

    expect(said).toHaveLength(1);
    expect(said[0].label).toBe(`event 2 (tick ${TICKS_PER_BAR * 4})`);
    // Both chords by name — the one that should be sounding and the one that is.
    expect(said[0].reason).toContain('F7');
    expect(said[0].reason).toContain('C7');
    expect(said[0].reason).toContain('strum');
  });

  it('does not call a stack stale for a chord that is not in this progression', () => {
    // The stale half is not a general "is this some chord" check, and it cannot
    // be: it is only ever the shapes this brief looked up. An E7 grip over C7 is
    // far from C7's shape and belongs to no bar of this form, so nothing here can
    // say what it is — which is the honest answer and not a pass by accident.
    const said = reviewTrack(
      [{ atTick: 0, durationTicks: BEAT, notes: asNotes(shapeOf('E7', 'bass')) }],
      bassBrief({ chords: [{ bar: 1, symbol: 'C7' }] }),
    );

    expect(said).toEqual([]);
  });
});

// -------------------------------------------------------------- narrowing ---

describe('what comes back is narrowed before it is judged', () => {
  it('reads a well-formed list of events', () => {
    expect(asTrackEvents({ events: fourOnTheFloor() })).toEqual(fourOnTheFloor());
  });

  it('is not a list of events when it is prose, or an array, or missing', () => {
    expect(asTrackEvents('here are the events')).toBeNull();
    expect(asTrackEvents([{ atTick: 0 }])).toBeNull();
    expect(asTrackEvents({ notes: [] })).toBeNull();
    expect(asTrackEvents(undefined)).toBeNull();
  });

  it('loses the whole reply to ONE unreadable event rather than leaving a hole', () => {
    // Dropping one silently is a bar of rest nobody asked for, in a document
    // whose other tracks were written to fill it — and the review would then pass,
    // because what is left is internally consistent.
    expect(
      asTrackEvents({
        events: [
          { atTick: 0, durationTicks: BEAT, notes: [{ string: 0, fret: 3 }] },
          { atTick: BEAT, durationTicks: BEAT, notes: [{ fret: 5 }] },
        ],
      }),
    ).toBeNull();
  });

  it('copies the fields rather than casting the reply', () => {
    // A provider that ignored `additionalProperties: false` must not smuggle a
    // `bend` or a `tieToNext` into a document that will silently do nothing with
    // it.
    const events = asTrackEvents({
      events: [
        {
          atTick: 0,
          durationTicks: BEAT,
          notes: [{ string: 0, fret: 3, bend: { type: 'bend', semitones: 1 } }],
          tieToNext: true,
        },
      ],
    });

    expect(events).toEqual([{ atTick: 0, durationTicks: BEAT, notes: [{ string: 0, fret: 3 }] }]);
  });

  it('reads an entry that asks for the chord instead of writing the notes', () => {
    expect(
      asTrackEvents({ events: [{ atTick: 0, durationTicks: BEAT, strum: 'top-3' }] }),
    ).toEqual([{ atTick: 0, durationTicks: BEAT, strum: 'top-3' }]);
  });

  it('loses the reply to a strum span that is not one of the five', () => {
    // Unlike `dynamic`, which is dropped: a strum is the CONTENT of the attack,
    // and a dropped one is an event with nothing on it — silence where a chord
    // was meant to be, in a document whose other tracks were written around it.
    expect(STRUM_SPANS).not.toContain('down');
    expect(
      asTrackEvents({ events: [{ atTick: 0, durationTicks: BEAT, strum: 'down' }] }),
    ).toBeNull();
  });

  it('reads an entry with neither, and leaves the refusal to the review', () => {
    // Type-readable, and refused by name a step later — a grammar error is not a
    // sentence a model can act on.
    expect(asTrackEvents({ events: [{ atTick: 0, durationTicks: BEAT }] })).toEqual([
      { atTick: 0, durationTicks: BEAT },
    ]);
  });

  it('keeps a dynamic and drops one that is not a string', () => {
    // The one field worth losing on its own: a dynamic is a mark on a note that is
    // otherwise complete, and losing one is a note at the default velocity rather
    // than a note in the wrong place.
    expect(
      asTrackEvents({
        events: [{ atTick: 0, durationTicks: BEAT, notes: [{ string: 0, fret: 3 }], dynamic: 7 }],
      }),
    ).toEqual([{ atTick: 0, durationTicks: BEAT, notes: [{ string: 0, fret: 3 }] }]);
  });

  it('drops a dynamic that is a string but not one of DYNAMICS', () => {
    // `"loud"` would otherwise travel all the way to the mapper, which ignores a
    // mark it does not know: the same note at the default velocity, at a further
    // address, with nobody told. Dropping it here is what makes `IREvent.dynamic`'s
    // narrowed type a fact rather than a claim about a `string`.
    expect(DYNAMICS).not.toContain('loud');
    expect(
      asTrackEvents({
        events: [
          { atTick: 0, durationTicks: BEAT, notes: [{ string: 0, fret: 3 }], dynamic: 'loud' },
        ],
      }),
    ).toEqual([{ atTick: 0, durationTicks: BEAT, notes: [{ string: 0, fret: 3 }] }]);

    // ...and a real one survives, or the assertion above would hold for a
    // narrowing that had dropped every dynamic there is.
    expect(
      asTrackEvents({
        events: [
          { atTick: 0, durationTicks: BEAT, notes: [{ string: 0, fret: 3 }], dynamic: 'ff' },
        ],
      }),
    ).toEqual([{ atTick: 0, durationTicks: BEAT, notes: [{ string: 0, fret: 3 }], dynamic: 'ff' }]);
  });
});

// -------------------------------------------------------------------- run ---

describe('a run that answered with a part', () => {
  it('hands back a track with the caller’s identity on it, ticks unscaled', async () => {
    // ⚠ THE TICKS ARE NOT RESCALED ANYWHERE. `importIR` rescales by
    // `irPpq / 480`, so a document authored at 480 passes through 1:1 — pinned in
    // tests/ImportIR.test.ts. Every tick this run writes is the tick that lands.
    expect(PPQ).toBe(480);

    const events = fourOnTheFloor();
    const track = await runIRTrack(bassBrief(), { deps: rig(answered({ events })).deps });

    if (!track.ok) throw new Error(track.reason);
    expect(track.value).toEqual({
      // The three fields the model was never asked to author.
      id: 'bass',
      name: 'Bass',
      instrumentHint: 'bass',
      events,
    });
    expect(track.value.events.map((event) => event.atTick)).toEqual([0, 480, 960, 1440]);
    expect(track.value.events.every((event) => event.durationTicks === 480)).toBe(true);
  });

  it('hands back a comping part with the shapes already filled in', async () => {
    // End to end: what the model wrote carries no string and no fret at all, and
    // the track that reaches the seam is the grip for the chord in force at each
    // tick. This is the whole card in one assertion.
    const answer = [
      { atTick: 0, durationTicks: BEAT, strum: 'bottom-2', dynamic: 'mf' },
      { atTick: BEAT, durationTicks: BEAT, strum: 'top-3' },
      { atTick: TICKS_PER_BAR * 4, durationTicks: BEAT, strum: 'all' },
    ];
    const track = await runIRTrack(guitarBar({ bars: 12, chords: bassBrief().chords }), {
      deps: rig(answered({ events: answer })).deps,
    });

    if (!track.ok) throw new Error(track.reason);
    const c7 = shapeOf('C7', 'guitar');
    expect(track.value.events.map((event) => event.notes)).toEqual([
      asNotes(c7.slice(0, 2)),
      asNotes(c7.slice(-3)),
      asNotes(shapeOf('F7', 'guitar')),
    ]);
    expect(track.value.events[0].dynamic).toBe('mf');
    expect(track.value.instrumentHint).toBe('guitar');
  });

  it('reviews the filled-in chord too, because the RUN expands before it judges', async () => {
    // ⚠ THE ORDER INSIDE `runIRTrack`, asserted through the run itself rather than
    // by composing the two functions by hand: review first and a strum would reach
    // the document unjudged, with the collision below committed in silence.
    const held = shapeOf('C7', 'guitar')[1];
    const answer = [
      {
        atTick: 0,
        durationTicks: BEAT * 2,
        notes: [{ string: held.stringIndex, fret: held.fret }],
      },
      { atTick: BEAT, durationTicks: BEAT, strum: 'all' },
    ];
    const track = await runIRTrack(guitarBar(), { deps: rig(answered({ events: answer })).deps });

    expect(track.ok).toBe(false);
    if (track.ok) return;
    expect(track.reason).toContain(`string ${held.stringIndex}`);
    expect(track.reason).toContain('one note at a time');
    expect(track.reason).toContain(`event 2 (tick ${BEAT})`);
  });

  it('sends the brief and the neck’s own schema, and no tools', async () => {
    const run = rig(answered({ events: fourOnTheFloor() }));
    await runIRTrack(oneBar(), { deps: run.deps });

    expect(run.calls).toHaveLength(1);
    expect(run.calls[0].spec.tools).toEqual([]);
    expect(run.calls[0].input).toBe(brief(oneBar()));
    expect(run.calls[0].options?.outputSchema).toBe(irTrackSchema('bass'));
  });

  it('forwards the caller’s options, strips `deps`, and OVERWRITES `outputSchema`', async () => {
    // The schema and the brief describe one shape, so a caller substituting
    // another would get events the narrowing cannot read. Swap the spread order in
    // `runIRTrack` and nothing else here notices.
    const run = rig(answered({ events: fourOnTheFloor() }));
    await runIRTrack(oneBar(), {
      deps: run.deps,
      modelId: 'some-model',
      outputSchema: irTrackSchema('guitar'),
    });

    expect(run.calls[0].options).toEqual({
      modelId: 'some-model',
      outputSchema: irTrackSchema('bass'),
    });
    // `deps` is this module's own parameter and is not part of the seam's shape.
    expect(run.calls[0].options).not.toHaveProperty('deps');
  });

  it('hands back a track the seam can take without a cast', () => {
    // ⚠ THE COMPILE IS THE ASSERTION. `src/ai/**` may not import the lib, so the
    // agreement between this module's structural `IRTrack` and the lib's is
    // checked exactly where the document crosses `patternService.importIR` — and a
    // shape that failed to compile for EVERY input, rather than for a bad one,
    // would teach the assembly job to write `as ImportIR` and throw the check
    // away. `readonly` arrays and a `string` `instrumentHint` were both that.
    return runIRTrack(bassBrief(), {
      deps: rig(answered({ events: fourOnTheFloor() })).deps,
    }).then((track) => {
      if (!track.ok) throw new Error(track.reason);

      const document: ImportIR = {
        meta: { title: 'Blues', sourceFormat: 'ascii-tab' },
        ticksPerQuarter: PPQ,
        totalTicks: TICKS_PER_BAR * 12,
        tempos: [{ atTick: 0, bpm: 120, interpolation: 'step' }],
        timeSignatures: [{ atTick: 0, numerator: 4, denominator: 4 }],
        keySignatures: [],
        sections: [],
        tracks: [track.value],
      };

      expect(document.tracks[0].instrumentHint).toBe('bass');
      expect(document.tracks[0].events).toHaveLength(4);
    });
  });

  it('sorts the events by tick, because the mapper never will', () => {
    // `mapImportToLibrary` preserves IR order and never sorts, so an out-of-order
    // document produces a pattern whose `startTick`s run backwards. Order carries
    // no information here, so it is derived rather than demanded.
    const outOfOrder = [
      { atTick: BEAT, durationTicks: BEAT, notes: [{ string: 1, fret: 5 }] },
      { atTick: 0, durationTicks: BEAT, notes: [{ string: 0, fret: 3 }] },
    ];

    return runIRTrack(oneBar(), { deps: rig(answered({ events: outOfOrder })).deps }).then(
      (track) => {
        if (!track.ok) throw new Error(track.reason);
        expect(track.value.events.map((event) => event.atTick)).toEqual([0, BEAT]);
      },
    );
  });
});

// -------------------------------------------------------- the second attempt ---

describe('a second attempt carries the refusal and changes nothing else', () => {
  /** A refusal in the shape `reviewTrack` writes them — the sentence the caller
   *  hands straight back. */
  const REFUSED = '"Bass" cannot be imported as written. event 1 (tick 0.5): Its atTick is 0.5.';

  const again = (of: TrackBrief, said: string): string => {
    const built = trackRunInput(of, said);
    if (!built.ok) throw new Error(`trackRunInput refused: ${built.reason}`);
    return built.value;
  };

  it('says nothing about a previous attempt on the first one', () => {
    expect(brief(oneBar())).not.toContain('Your last answer was refused');
  });

  it('appends it as its own marked section at the very end', () => {
    // ⚠ THE MUSICAL PROSE IS UNTOUCHED, and this is the assertion that says so:
    // the first brief is a PREFIX of the second. Reword one paragraph to
    // accommodate the feedback and this fails, which is the point — that prose is
    // a deferred tuning ticket's baseline.
    const second = again(oneBar(), REFUSED);

    expect(second.startsWith(brief(oneBar()))).toBe(true);
    expect(second).toContain('Your last answer was refused');
    expect(second).toContain('Its atTick is 0.5.');
    // In the model's own words, not re-worded into ours.
    expect(second).toContain(REFUSED);
  });

  it('tells it to write the whole part again rather than to patch it', () => {
    // The brief it is reading is the same brief, not a diff — a model asked to
    // "fix event 3" answers with event 3.
    expect(again(oneBar(), REFUSED)).toContain('Write the whole part again');
  });

  it('points a mis-copied grip at "strum" rather than away from it', () => {
    // ⚠ THE ONE CLAUSE THE WHOLE RETRY TURNS ON. Every item in that list
    // describes the strum, so a dropped "not" tells the model that writing
    // `strum` is the way to get the harmony wrong twice — the opposite of the
    // instruction, at the last place it reads about it.
    const second = again(oneBar(), REFUSED);

    expect(second).toContain('not to get the harmony wrong twice in a row');
    expect(second).not.toContain('is the one way to get the harmony wrong twice in a row');
  });

  it('restates the bare-object rule, which it otherwise displaces', () => {
    // The addendum goes AFTER `# Answer`, so on a second attempt the last
    // paragraph is feedback rather than "the object alone". An answer that came
    // back as prose is an `'answer'` stop, which the job deliberately does NOT
    // retry — so a retry that regressed into a sentence would lose the part.
    const second = again(oneBar(), REFUSED);

    expect(second.trimEnd().endsWith('no fence, no preamble, nothing after it.')).toBe(true);
  });

  it('adds nothing for a refusal that is blank once trimmed', () => {
    // A heading with nothing under it is an instruction the model cannot follow.
    expect(again(oneBar(), '   ')).toBe(brief(oneBar()));
  });

  it('puts it in the brief the model is actually sent, and not in the options', () => {
    const run = rig(answered({ events: fourOnTheFloor() }));

    return runIRTrack(oneBar(), { deps: run.deps, previousRefusal: REFUSED }).then(() => {
      expect(run.calls[0].input).toBe(again(oneBar(), REFUSED));
      // `previousRefusal` is this module's own parameter and is not part of the
      // seam's shape — spread through and the harness gets a key it will not read.
      expect(run.calls[0].options).not.toHaveProperty('previousRefusal');
    });
  });

  it('still runs exactly once — a second attempt is the CALLER’s', async () => {
    // Retrying in here would hide the second model call from the caller that pays
    // for it and from the transcript that has to show it.
    const run = rig(
      answered({ events: [{ atTick: 0.5, durationTicks: BEAT, notes: [{ string: 0, fret: 3 }] }] }),
    );

    const track = await runIRTrack(oneBar(), { deps: run.deps });

    expect(track.ok).toBe(false);
    expect(run.calls).toHaveLength(1);
  });
});

describe('a run that did not', () => {
  it('passes the seam’s refusal on untouched', async () => {
    const dead: Result<AgentRunSummary> = { ok: false, reason: 'No provider is configured.' };
    const track = await runIRTrack(oneBar(), { deps: rig(dead).deps });

    expect(track.ok).toBe(false);
    if (track.ok) return;
    expect(track.reason).toBe('No provider is configured.');
    // ⚠ NOT `'review'`, which is the only stop a caller asks again for. A dead
    // provider is still dead on a second call.
    expect(track.stopped).toBe('run');
  });

  it('says what a prose answer cost, and names the stop reason', async () => {
    const prose: Result<AgentRunSummary> = {
      ok: true,
      value: { content: '```json\n{"events":[]}\n```', stoppedReason: 'answered', toolCalls: [] },
    };
    const track = await runIRTrack(oneBar(), { deps: rig(prose).deps });

    expect(track.ok).toBe(false);
    if (track.ok) return;
    expect(track.reason).toContain('answered');
    expect(track.reason).toContain('code fence');
    expect(track.stopped).toBe('answer');
  });

  it('does not blame a run the user stopped for fencing its JSON', async () => {
    // `runAgentTask` reports an abort as `ok: true` with no `structured`, so this
    // is the path a user takes by pressing stop. Telling them about code fences is
    // telling them they did something wrong.
    const stopped: Result<AgentRunSummary> = {
      ok: true,
      value: { content: '', stoppedReason: 'aborted', toolCalls: [] },
    };
    const track = await runIRTrack(oneBar(), { deps: rig(stopped).deps });

    expect(track.ok).toBe(false);
    if (track.ok) return;
    expect(track.reason).toContain('aborted');
    expect(track.reason).toContain('before it answered');
    expect(track.reason).not.toContain('code fence');
    // ⚠ NOT `'review'`. Asking again for a part the user stopped would spend a
    // model call answering their own click.
    expect(track.stopped).toBe('answer');
  });

  it('refuses the whole part when the review found anything, naming the part', async () => {
    const track = await runIRTrack(oneBar(), {
      deps: rig(
        answered({ events: [{ atTick: 0.5, durationTicks: BEAT, notes: [{ string: 0, fret: 3 }] }] }),
      ).deps,
    });

    expect(track.ok).toBe(false);
    if (track.ok) return;
    expect(track.reason).toContain('"Bass"');
    expect(track.reason).toContain('0.5');
    // ⚠ THE ONE STOP WORTH ASKING AGAIN ABOUT: the sentence above names the
    // event and says what is wrong with it, which is what an addendum carries.
    expect(track.stopped).toBe('review');
  });

  it('never reaches the model when the brief could not be built', async () => {
    const run = rig(answered({ events: fourOnTheFloor() }));
    const track = await runIRTrack(oneBar({ chords: [{ bar: 1, symbol: 'Zz9' }] }), {
      deps: run.deps,
    });

    expect(track.ok).toBe(false);
    if (track.ok) return;
    // A whole run spent finding out that the caller wrote a chord nobody can read.
    expect(run.calls).toHaveLength(0);
    // And there is no answer to give feedback on, so nobody asks again.
    expect(track.stopped).toBe('brief');
  });

  it('reports a neck this app has not got as a brief failure, before any run', async () => {
    const run = rig(answered({ events: fourOnTheFloor() }));
    const track = await runIRTrack(oneBar({ instrumentId: 'trumpet' }), { deps: run.deps });

    expect(track.ok).toBe(false);
    if (track.ok) return;
    expect(track.stopped).toBe('brief');
    expect(run.calls).toHaveLength(0);
  });
});
