import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PATTERNS_STATE, usePatternsStore } from '@fretwork/lib';
import { ToolRegistry } from 'agent-harness/browser';
import { ARRANGEMENT_PLAN_AGENT, planRunInput, reviewPlan } from '../src/ai/arrangementPlan';
import { ARRANGEMENT_PLAN_SCHEMA } from '../src/ai/arrangementPlanSchema';
import type { ArrangementPlan } from '../src/ai/arrangementPlanSchema';
import { toToolDef } from '../src/ai/agentService';
import { MAX_COMPOSITION_TRACKS } from '../src/composition/compositionService';
import { READ_TOOLS } from '../src/ai/tools/readTools';
import { findTool } from '../src/ai/tools';
import type { AgentTool, JsonValue, ToolResult } from '../src/ai/tools/types';

/**
 * OR-02 — the planning step: what gets built, decided before anything is.
 *
 * ⚠ THERE IS NO MODEL IN THIS FILE, and there cannot be one: the whole claim of
 * the ticket is that a plan is checkable AS DATA, so every check below is a
 * plain function over a plain object. The one test that touches the app at all
 * is the last, and it touches it through `read_composition` — the same tool the
 * building runs read, which is the point being pinned.
 */

const call = (name: string, args: Record<string, unknown> = {}): ToolResult => {
  const tool = findTool(name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return tool.run(args);
};

const value = (result: ToolResult): JsonValue => {
  if (!result.ok) throw new Error(`tool refused: ${result.reason}`);
  return result.value;
};

const input = (result: ReturnType<typeof planRunInput>): string => {
  if (!result.ok) throw new Error(`planRunInput refused: ${result.reason}`);
  return result.value;
};

beforeEach(() => {
  sessionStorage.clear();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
});

// ------------------------------------------------------------------ plans ---

/**
 * A twelve-bar blues in C, as a plan: one pattern per chord, each placed at
 * every bar its chord covers. The bar lists are the form's own — C7 over 1-4,
 * 7-8 and 11, F7 over 5-6 and 10, G7 over 9 and 12 — so "covers all twelve bars"
 * is a property of the fixture and not of an assertion that agrees with it.
 */
const bluesPlan = (): ArrangementPlan => ({
  bars: 12,
  tracks: [
    { name: 'Rhythm Guitar', instrumentId: 'guitar' },
    { name: 'Bass', instrumentId: 'bass' },
  ],
  patterns: [
    { name: 'C7 Comp', instrumentId: 'guitar', chord: 'C7', lengthBars: 1 },
    { name: 'F7 Comp', instrumentId: 'guitar', chord: 'F7', lengthBars: 1 },
    { name: 'G7 Comp', instrumentId: 'guitar', chord: 'G7', lengthBars: 1 },
    { name: 'C7 Walk', instrumentId: 'bass', chord: 'C7', lengthBars: 1 },
    { name: 'F7 Walk', instrumentId: 'bass', chord: 'F7', lengthBars: 1 },
    { name: 'G7 Walk', instrumentId: 'bass', chord: 'G7', lengthBars: 1 },
  ],
  placements: [
    { patternName: 'C7 Comp', trackName: 'Rhythm Guitar', atBars: [1, 2, 3, 4, 7, 8, 11] },
    { patternName: 'F7 Comp', trackName: 'Rhythm Guitar', atBars: [5, 6, 10] },
    { patternName: 'G7 Comp', trackName: 'Rhythm Guitar', atBars: [9, 12] },
    { patternName: 'C7 Walk', trackName: 'Bass', atBars: [1, 2, 3, 4, 7, 8, 11] },
    { patternName: 'F7 Walk', trackName: 'Bass', atBars: [5, 6, 10] },
    { patternName: 'G7 Walk', trackName: 'Bass', atBars: [9, 12] },
  ],
});

/** One track, one two-bar riff, and wherever the caller says to put it. */
const riffPlan = (atBars: readonly number[]): ArrangementPlan => ({
  bars: 8,
  tracks: [{ name: 'Rhythm Guitar', instrumentId: 'guitar' }],
  patterns: [{ name: 'Two-bar riff', instrumentId: 'guitar', chord: 'A7', lengthBars: 2 }],
  placements: [{ patternName: 'Two-bar riff', trackName: 'Rhythm Guitar', atBars }],
});

// ------------------------------------------------------------------ review ---

describe('a plan that would build', () => {
  it('passes a twelve-bar blues with a pattern per chord, and reports no holes', () => {
    const review = reviewPlan(bluesPlan());
    expect(review.refusals).toEqual([]);
    // Every bar of both parts is spoken for — the shape four runs in a row
    // failed to produce while every reply read healthy.
    expect(review.emptyBars).toEqual([]);
    expect(review.span).toBe(12);
  });

  it('passes a two-bar pattern spaced by its own length', () => {
    // The counterweight to the refusal below: the rule is about the SPACING and
    // not about a list of four, so the correctly spaced four copies pass and
    // cover the whole eight bars.
    const review = reviewPlan(riffPlan([1, 3, 5, 7]));
    expect(review.refusals).toEqual([]);
    expect(review.emptyBars).toEqual([]);
  });
});

describe('placements that would stack', () => {
  it('refuses a two-bar pattern placed at consecutive bars, naming the overlap', () => {
    // THE mistake that burned a whole run's step budget: four two-bar blocks a
    // bar apart, discovered three blocks at a time at write time.
    const review = reviewPlan(riffPlan([1, 2, 3, 4]));

    // Measured against the SURVIVORS: bar 1 stands, bar 2 lands on it, bar 3 is
    // clear of bar 1, bar 4 lands on bar 3. Two refusals, not six pairings — and
    // the copies left standing are themselves a placement that would build.
    expect(review.refusals.map((refusal) => refusal.rule)).toEqual([
      'self-overlap',
      'self-overlap',
    ]);
    expect(review.refusals.map((refusal) => refusal.bar)).toEqual([2, 4]);

    const [first] = review.refusals;
    expect(first.reason).toContain('"Two-bar riff"');
    expect(first.reason).toContain('bar 2');
    // The copy in the way, the ground it holds, and the spacing that works —
    // the three things `composition_place_pattern` says at write time.
    expect(first.reason).toContain('the copy at bar 1');
    expect(first.reason).toContain('covers bars 1-2');
    expect(first.reason).toContain('space the copies 2 bars apart');
  });

  it('refuses two DIFFERENT patterns overlapping on one track, and says to split them', () => {
    const plan: ArrangementPlan = {
      bars: 8,
      tracks: [{ name: 'Rhythm Guitar', instrumentId: 'guitar' }],
      patterns: [
        { name: 'Verse comp', instrumentId: 'guitar', chord: 'A7', lengthBars: 4 },
        { name: 'Lead lick', instrumentId: 'guitar', chord: 'A7', lengthBars: 2 },
      ],
      placements: [
        { patternName: 'Verse comp', trackName: 'Rhythm Guitar', atBars: [1, 5] },
        { patternName: 'Lead lick', trackName: 'Rhythm Guitar', atBars: [3] },
      ],
    };
    const review = reviewPlan(plan);

    expect(review.refusals.map((refusal) => refusal.rule)).toEqual(['track-overlap']);
    expect(review.refusals[0].bar).toBe(3);
    expect(review.refusals[0].reason).toContain('"Lead lick"');
    expect(review.refusals[0].reason).toContain('"Verse comp"');
    // The advice BRANCHES: spacing is the fix for another copy of the same
    // pattern and a loop for a different one — two parts that sound together
    // belong on two tracks.
    expect(review.refusals[0].reason).toContain('two tracks');
    expect(review.refusals[0].reason).not.toContain('space the copies');
  });

  it('says a bar listed twice is a duplicate, not a spacing mistake', () => {
    const blues = bluesPlan();
    const review = reviewPlan({
      ...blues,
      tracks: [blues.tracks[0]],
      // One-bar pattern, bar 3 written down twice.
      placements: [{ patternName: 'C7 Comp', trackName: 'Rhythm Guitar', atBars: [3, 3] }],
    });

    expect(review.refusals.map((refusal) => refusal.rule)).toEqual(['self-overlap']);
    expect(review.refusals[0].bar).toBe(3);
    expect(review.refusals[0].reason).toContain('bar 3 is listed twice');
    // The spacing sentence is advice the caller cannot act on here — it would
    // read "space the copies at bar 3 and bar 3 one bar apart".
    expect(review.refusals[0].reason).not.toContain('space the copies');
    expect(review.refusals[0].reason).toContain('drop the duplicate');
  });
});

describe('plans that could not be assembled at all', () => {
  it('refuses two patterns or two tracks sharing a name, naming it', () => {
    const plan: ArrangementPlan = {
      bars: 4,
      tracks: [
        { name: 'Rhythm Guitar', instrumentId: 'guitar' },
        { name: 'Rhythm Guitar', instrumentId: 'bass' },
      ],
      patterns: [
        { name: 'Riff', instrumentId: 'guitar', chord: 'A7', lengthBars: 1 },
        { name: 'Riff', instrumentId: 'guitar', chord: 'D7', lengthBars: 4 },
      ],
      placements: [{ patternName: 'Riff', trackName: 'Rhythm Guitar', atBars: [1, 2, 3, 4] }],
    };
    const review = reviewPlan(plan);

    // Not cosmetic: the placement below resolves to the FIRST declaration, so a
    // duplicate silently decides which `lengthBars` the overlap walk runs
    // against — bars 1-4 spaced by 1 here, and four 4-bar blocks on top of each
    // other if the second one had won.
    expect(review.refusals.map((refusal) => refusal.rule)).toEqual([
      'duplicate-name',
      'duplicate-name',
    ]);
    expect(review.refusals[0].reason).toContain('"Riff"');
    expect(review.refusals[1].reason).toContain('"Rhythm Guitar"');
  });

  it(`refuses more than ${MAX_COMPOSITION_TRACKS} tracks, which is a hard cap and not a preference`, () => {
    const plan: ArrangementPlan = {
      bars: 4,
      tracks: Array.from({ length: MAX_COMPOSITION_TRACKS + 1 }, (_unused, index) => ({
        name: `Part ${index + 1}`,
        instrumentId: 'guitar',
      })),
      patterns: [{ name: 'Riff', instrumentId: 'guitar', chord: 'A7', lengthBars: 1 }],
      placements: [{ patternName: 'Riff', trackName: 'Part 1', atBars: [1, 2, 3, 4] }],
    };
    const review = reviewPlan(plan);

    // `composition_add_track` refuses past the cap, so this plan cannot be
    // assembled however well it is spaced — the one rule here that is fatal
    // rather than expensive.
    expect(review.refusals.map((refusal) => refusal.rule)).toEqual(['track-cap']);
    expect(review.refusals[0].reason).toContain(String(MAX_COMPOSITION_TRACKS + 1));
    // The seam's own sentence, so the model reads the same reason the UI shows.
    expect(review.refusals[0].reason).toContain(`at most ${MAX_COMPOSITION_TRACKS} tracks`);
  });

  it('refuses a copy that runs past the form, and does not let it stretch the report', () => {
    const blues = bluesPlan();
    const review = reviewPlan({
      ...blues,
      placements: [
        ...blues.placements.filter((placement) => placement.trackName === 'Rhythm Guitar'),
        // One mistyped bar. Measured against the furthest bar ANYTHING reaches,
        // this would make the span 40 and report the guitar empty from bar 13 to
        // bar 40 — burying the report this step exists for under phantom holes.
        { patternName: 'C7 Walk', trackName: 'Bass', atBars: [40] },
      ],
    });

    expect(review.refusals.map((refusal) => refusal.rule)).toEqual(['past-form']);
    expect(review.refusals[0].bar).toBe(40);
    expect(review.refusals[0].reason).toContain('1 bar long');
    expect(review.refusals[0].reason).toContain('past the end of the form');
    expect(review.refusals[0].reason).toContain('bar 12 at the latest');

    expect(review.span).toBe(12);
    // The guitar covers the whole form and is reported as covering it; the bass
    // has nothing INSIDE the form at all.
    expect(review.emptyBars).toEqual([{ trackName: 'Bass', emptyBars: [{ from: 1, to: 12 }] }]);
  });

  it('refuses a placement that names no bars, which would otherwise vanish', () => {
    const review = reviewPlan(riffPlan([]));
    expect(review.refusals.map((refusal) => refusal.rule)).toEqual(['bar-number']);
    // No bar to point at — the rule is about the placement, not a position.
    expect(review.refusals[0].bar).toBeUndefined();
    expect(review.refusals[0].reason).toContain('names no bars');
    // …and the track it named reads as empty, which is now explained rather
    // than silent.
    expect(review.emptyBars).toEqual([
      { trackName: 'Rhythm Guitar', emptyBars: [{ from: 1, to: 8 }] },
    ]);
  });
});

describe('placements that name something that is not there', () => {
  it('refuses an undeclared pattern and an undeclared track, naming both', () => {
    const plan: ArrangementPlan = {
      ...bluesPlan(),
      placements: [
        { patternName: 'Turnaround', trackName: 'Rhythm Guitar', atBars: [12] },
        { patternName: 'C7 Comp', trackName: 'Horns', atBars: [1] },
      ],
    };
    const review = reviewPlan(plan);

    expect(review.refusals.map((refusal) => refusal.rule)).toEqual([
      'unknown-pattern',
      'unknown-track',
    ]);
    const [pattern, track] = review.refusals;
    // The name that was not found, and the bar that says WHICH placement — a
    // plan has no ids to point with.
    expect(pattern.reason).toContain('"Turnaround"');
    expect(pattern.bar).toBe(12);
    // …and what it could have named instead, so the repair needs no second look.
    expect(pattern.reason).toContain('"C7 Comp"');
    expect(track.reason).toContain('"Horns"');
    expect(track.reason).toContain('"Rhythm Guitar"');
    expect(track.bar).toBe(1);
  });

  it('says so plainly when the plan declares nothing to name', () => {
    const review = reviewPlan({
      bars: 4,
      tracks: [{ name: 'Rhythm Guitar', instrumentId: 'guitar' }],
      patterns: [],
      placements: [{ patternName: 'Riff', trackName: 'Rhythm Guitar', atBars: [1] }],
    });
    expect(review.refusals.map((refusal) => refusal.rule)).toEqual(['unknown-pattern']);
    // Rather than "The patterns it declares are ." — the list is a repair
    // instruction, and an empty one has to read as an answer.
    expect(review.refusals[0].reason).toContain('declares are none');
  });

  it('refuses a pattern shorter than a bar', () => {
    const plan: ArrangementPlan = {
      ...riffPlan([1]),
      patterns: [{ name: 'Two-bar riff', instrumentId: 'guitar', chord: 'A7', lengthBars: 0 }],
    };
    const review = reviewPlan(plan);
    expect(review.refusals.map((refusal) => refusal.rule)).toEqual(['pattern-length']);
    expect(review.refusals[0].reason).toContain('at least 1 whole bar');
  });

  it('refuses a start that is not a bar, and a form that is not bars long', () => {
    // Both are floors the schema also states — but `reviewPlan` is a pure
    // function over an object and is reachable without it, and the overlap
    // arithmetic below rests on both being whole numbers counted from 1.
    const zeroth = reviewPlan(riffPlan([0]));
    expect(zeroth.refusals.map((refusal) => refusal.rule)).toEqual(['bar-number']);
    expect(zeroth.refusals[0].bar).toBe(0);
    expect(zeroth.refusals[0].reason).toContain('counted FROM 1');

    const formless = reviewPlan({ ...riffPlan([1]), bars: 0 });
    expect(formless.refusals.map((refusal) => refusal.rule)).toEqual(['form-length']);
    // The span falls back to what the placements actually reach, so the gaps it
    // reports are still true — a two-bar copy at bar 1 leaves nothing empty.
    expect(formless.span).toBe(2);
    expect(formless.emptyBars).toEqual([]);
  });
});

describe('bars nothing covers', () => {
  it('reports every track that has holes, in declared order, without refusing any', () => {
    const blues = bluesPlan();
    const plan: ArrangementPlan = {
      ...blues,
      placements: [
        // The guitar stops at bar 4 of twelve.
        { patternName: 'C7 Comp', trackName: 'Rhythm Guitar', atBars: [1, 2, 3, 4] },
        // The bass runs the whole form bar the IV in bars 5-6 and 10 — a
        // DIFFERENT hole, so a report that stopped after the first track, or
        // reused one track's gaps for another, could not pass.
        { patternName: 'C7 Walk', trackName: 'Bass', atBars: [1, 2, 3, 4, 7, 8, 11] },
        { patternName: 'G7 Walk', trackName: 'Bass', atBars: [9, 12] },
      ],
    };
    const review = reviewPlan(plan);

    // NOT a refusal. A sparse arrangement can be intended; being told is the
    // point, and four runs in a row were not.
    expect(review.refusals).toEqual([]);
    expect(review.emptyBars).toEqual([
      { trackName: 'Rhythm Guitar', emptyBars: [{ from: 5, to: 12 }] },
      { trackName: 'Bass', emptyBars: [{ from: 5, to: 6 }, { from: 10, to: 10 }] },
    ]);
    expect(review.span).toBe(12);
  });

  it('reports the holes BETWEEN the blocks, not just the one after the last', () => {
    // The 2026-08-11 shape exactly: a one-bar chord pattern at bars 1, 4, 7 and
    // 10 of a twelve-bar form, two thirds of the tune silent, every field in
    // every reply reading healthy. Interior gaps are the ones nothing reported.
    const blues = bluesPlan();
    const review = reviewPlan({
      ...blues,
      tracks: [blues.tracks[0]],
      placements: [{ patternName: 'C7 Comp', trackName: 'Rhythm Guitar', atBars: [1, 4, 7, 10] }],
    });

    expect(review.refusals).toEqual([]);
    expect(review.emptyBars).toEqual([
      {
        trackName: 'Rhythm Guitar',
        emptyBars: [
          { from: 2, to: 3 },
          { from: 5, to: 6 },
          { from: 8, to: 9 },
          { from: 11, to: 12 },
        ],
      },
    ]);
  });

  it('counts a short copy inside a long one as covered, refusal and all', () => {
    // The refused copy still covers ground: which copy SURVIVES is a different
    // question from whether the bar has anything on it, and a cursor wound
    // backwards by the shorter block would invent a hole over bar 4.
    const plan: ArrangementPlan = {
      bars: 8,
      tracks: [{ name: 'Rhythm Guitar', instrumentId: 'guitar' }],
      patterns: [
        { name: 'Verse comp', instrumentId: 'guitar', chord: 'A7', lengthBars: 4 },
        { name: 'Lead lick', instrumentId: 'guitar', chord: 'A7', lengthBars: 2 },
      ],
      placements: [
        { patternName: 'Verse comp', trackName: 'Rhythm Guitar', atBars: [1] },
        { patternName: 'Lead lick', trackName: 'Rhythm Guitar', atBars: [2] },
      ],
    };
    const review = reviewPlan(plan);

    expect(review.refusals.map((refusal) => refusal.rule)).toEqual(['track-overlap']);
    expect(review.emptyBars).toEqual([
      { trackName: 'Rhythm Guitar', emptyBars: [{ from: 5, to: 8 }] },
    ]);
  });

  it('reports a declared track with nothing planned on it at all', () => {
    const blues = bluesPlan();
    const review = reviewPlan({
      ...blues,
      // The bass is declared and never played — which `read_composition` would
      // say twice over with `distinctPatterns: 0` and an empty block list, and a
      // plan has no such field to say it with.
      placements: blues.placements.filter((placement) => placement.trackName !== 'Bass'),
    });
    expect(review.refusals).toEqual([]);
    expect(review.emptyBars).toEqual([{ trackName: 'Bass', emptyBars: [{ from: 1, to: 12 }] }]);
  });
});

// ------------------------------------------------------------------- input ---

describe('what the planning run is handed', () => {
  it('carries NO tools, which is what makes the schema a grammar', () => {
    // The harness sends `outputSchema` for grammar-enforced decoding only on a
    // turn where no tools are offered at all. A tool added to this spec would
    // leave the schema a best-effort parse of whatever the model wrote, and
    // nothing would say so.
    expect(ARRANGEMENT_PLAN_AGENT.tools).toEqual([]);
    expect(ARRANGEMENT_PLAN_SCHEMA.required).toEqual(['bars', 'tracks', 'patterns', 'placements']);
    // A field the model invents has to be a decoding failure, not a silently
    // dropped instruction.
    expect(ARRANGEMENT_PLAN_SCHEMA.additionalProperties).toBe(false);
  });

  /**
   * The facts the prompt is the ONLY carrier of, pinned one substring each.
   *
   * Two of them are said twice in the codebase on purpose — the spacing rule and
   * "one pattern per chord" are also two paragraphs of `agentRules.LENGTH`, kept
   * apart because that section is written in tools and ticks and this run has
   * neither. A pinned substring is what survives whoever collapses them.
   */
  it('states the facts a plan run cannot be told any other way', () => {
    const prompt = ARRANGEMENT_PLAN_AGENT.systemPrompt;

    // The whole run's product. The harness `JSON.parse`s the WHOLE final answer
    // and strips no fences, so a fenced plan is no plan.
    expect(prompt).toContain('ANSWER WITH ONE JSON OBJECT AND NOTHING ELSE');
    expect(prompt).toContain('no code fence around it');
    // The shape in words, because grammar-enforced decoding is the PROVIDER's to
    // honour and a backend that ignores it leaves the model guessing field names.
    expect(prompt).toContain('"patternName"');
    expect(prompt).toContain('"atBars"');
    expect(prompt).toContain('"lengthBars"');
    // Bars, from 1.
    expect(prompt).toContain('Everything is counted in BARS, FROM 1');
    // Chords as symbols, never frets — what makes a bass part a bass part.
    expect(prompt).toContain('Never a fret and never a string');
    // One pattern per chord: the 2026-08-14 failure, one repeated cell per part.
    expect(prompt).toContain('A pattern has ONE chord for the whole of it');
    // Spacing by the pattern's own length, with the worked example.
    expect(prompt).toContain('starts at bars 1, 3, 5, 7');
    // The cap, which is fatal rather than expensive.
    expect(prompt).toContain(`AT MOST ${MAX_COMPOSITION_TRACKS} TRACKS`);
  });

  /**
   * ⚠ AJV COMPILES THIS SCHEMA IN THE BROWSER, and a schema it rejects is a
   * `ToolRegistry` constructor that THROWS — the run dead before the first
   * token, with an error about JSON Schema and no mention of a plan.
   * `AgentToolRegistry.test.ts` makes the same check for the tool schemas and
   * says why at length; this is the same check for the one schema that is not a
   * tool's.
   *
   * It doubles as the only thing pinning the schema to the `ArrangementPlan`
   * interface: `bluesPlan()` is typed, so a field added to one and not the other
   * fails here.
   */
  it('is a schema ajv accepts, and one that holds the plan to its shape', () => {
    const registry = new ToolRegistry();
    const answerWithAPlan: AgentTool = {
      name: 'answer_with_a_plan',
      description: 'Never registered on a real run — the planning run has no tools at all.',
      parameters: ARRANGEMENT_PLAN_SCHEMA,
      run: () => ({ ok: true, value: null }),
    };
    // Construction is half the assertion: `register` calls `ajv.compile`.
    expect(() => registry.register([toToolDef(answerWithAPlan)])).not.toThrow();

    const check = (plan: unknown): boolean => registry.validate('answer_with_a_plan', plan).ok;
    expect(check(bluesPlan())).toBe(true);

    // A field the model invents is a decoding failure, not a dropped instruction.
    expect(check({ ...bluesPlan(), key: 'C' })).toBe(false);
    // The chord is the whole brief a pattern-writing run gets.
    expect(
      check({
        ...bluesPlan(),
        patterns: [{ name: 'Riff', instrumentId: 'guitar', lengthBars: 1 }],
      }),
    ).toBe(false);
    // The floors the overlap arithmetic rests on.
    expect(check({ ...bluesPlan(), bars: 0 })).toBe(false);
    expect(
      check({
        ...bluesPlan(),
        patterns: [{ name: 'Riff', instrumentId: 'guitar', chord: 'A7', lengthBars: 0 }],
      }),
    ).toBe(false);
    expect(check(riffPlan([0]))).toBe(false);
    // A placement that names no bar places nothing.
    expect(check(riffPlan([]))).toBe(false);
    // And an instrument the app does not have is a track that cannot be added.
    expect(
      check({
        ...riffPlan([1]),
        tracks: [{ name: 'Rhythm Guitar', instrumentId: 'theremin' }],
      }),
    ).toBe(false);
  });

  it('describes the composition with `read_composition`, not with a second renderer', () => {
    value(call('composition_open_blank', { name: 'Blues' }));
    const readComposition = READ_TOOLS.find((tool) => tool.name === 'read_composition');
    if (!readComposition) throw new Error('read_composition is missing');

    const described = value(readComposition.run({}));
    const prompt = input(planRunInput('Make me a twelve-bar blues'));

    // The read's own JSON, byte for byte. A renderer of our own would drift from
    // the description the writing runs see, which is the one thing a plan has to
    // agree with.
    expect(prompt).toContain(JSON.stringify(described));
    expect(prompt).toContain('Make me a twelve-bar blues');
  });

  it('refuses with the read\'s own sentence when no composition is open', () => {
    const refused = planRunInput('Make me a twelve-bar blues');
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.reason).toBe('No composition is open.');
  });
});
