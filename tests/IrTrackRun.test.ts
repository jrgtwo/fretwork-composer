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
  TICKS_PER_BAR,
  asTrackEvents,
  irTrackSchema,
  reviewTrack,
  runIRTrack,
  trackRunInput,
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

  it('requires everything but the dynamic', () => {
    const event = irTrackSchema('guitar').properties?.events.items;

    expect(event?.required).toEqual(['atTick', 'durationTicks', 'notes']);
    expect(Object.keys(event?.properties ?? {})).toEqual([
      'atTick',
      'durationTicks',
      'notes',
      'dynamic',
    ]);
    // A field the model spends tokens on that reaches nothing is worse than no
    // field: bends, slides and harmonics are not offered.
    expect(event?.additionalProperties).toBe(false);
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

  it('does not tell a ukulele player that string 0 is the lowest PITCH', () => {
    // A reentrant ukulele is G4 C4 E4 A4: index 0 is the bottom string and the
    // fourth-lowest note on it. "The lowest string" is a sentence that is false on
    // an instrument this module explicitly supports.
    expect(brief(oneBar({ instrumentId: 'ukulele' }))).toContain('counts from the BOTTOM string');
    expect(brief(oneBar({ instrumentId: 'ukulele' }))).not.toContain('from the LOWEST string');
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
    expect(
      reviewTrack(
        [
          {
            atTick: 0,
            durationTicks: BEAT,
            notes: [
              { string: 0, fret: 3 },
              { string: 1, fret: 2 },
              { string: 2, fret: 3 },
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

describe('a run that did not', () => {
  it('passes the seam’s refusal on untouched', async () => {
    const dead: Result<AgentRunSummary> = { ok: false, reason: 'No provider is configured.' };
    const track = await runIRTrack(oneBar(), { deps: rig(dead).deps });

    expect(track.ok).toBe(false);
    if (track.ok) return;
    expect(track.reason).toBe('No provider is configured.');
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
  });

  it('never reaches the model when the brief could not be built', async () => {
    const run = rig(answered({ events: fourOnTheFloor() }));
    const track = await runIRTrack(oneBar({ chords: [{ bar: 1, symbol: 'Zz9' }] }), {
      deps: run.deps,
    });

    expect(track.ok).toBe(false);
    // A whole run spent finding out that the caller wrote a chord nobody can read.
    expect(run.calls).toHaveLength(0);
  });
});
