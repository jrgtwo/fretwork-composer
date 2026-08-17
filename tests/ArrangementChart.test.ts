/**
 * The chart run: the harmony and the parts, decided once, written nowhere.
 *
 * ⚠ THERE IS NO MODEL IN THIS FILE. Every model call goes through the injected
 * `runTask`, which returns what the test says it returns — because what this
 * module decides is the SHAPE that goes out, the narrowing of what comes back,
 * and which charts are refusable. None of that needs a provider, and a test with
 * one could assert none of it.
 *
 * What is REAL: the schema, the spec, `reviewChart` and its chord lookup through
 * `chordGrip`. What no test here can check is whether the harmony is any good —
 * that is a listening test's, and this file exists so that what it listens to is
 * the thing that will ship.
 */
import { describe, expect, it } from 'vitest';
import {
  ARRANGEMENT_CHART_AGENT,
  ARRANGEMENT_CHART_SCHEMA,
  asChart,
  reviewChart,
  runArrangementChart,
  type ArrangementChart,
  type ChartRunDeps,
} from '../src/ai/arrangementChart';
import { MAX_COMPOSITION_TRACKS, TRACK_CAP_REASON } from '../src/composition/compositionService';
import { trackRunInput } from '../src/ai/irTrackRun';
import { INSTRUMENT_IDS, INSTRUMENT_LIST } from '../src/ai/tools/instrumentCatalog';
import type { AgentRunSummary, AgentSpec, RunAgentTaskOptions } from '../src/ai/agentService';
import type { Result } from '../src/patterns/patternService';

// --------------------------------------------------------------- fixtures ---

/**
 * A twelve-bar blues in C, as a CHART: I–I–I–I / IV–IV–I–I / V–IV–I–V, written
 * the way a chart is — one entry per CHANGE, not one per bar.
 *
 * Bars 1, 5, 7, 9, 10 and 11 are the six changes of that form, and bars 2, 3, 4,
 * 6, 8 and 12 are absent BECAUSE the chord before them is still holding. That
 * absence is the whole design being pinned: six entries for twelve bars.
 */
const blues = (): ArrangementChart => ({
  bars: 12,
  bpm: 120,
  tracks: [
    { name: 'Bass', instrumentId: 'bass', role: 'walking bass, quarter notes, root to root' },
    { name: 'Rhythm Guitar', instrumentId: 'guitar', role: 'off-beat comping, upper strings' },
    { name: 'Lead', instrumentId: 'guitar', role: 'sparse fills in the gaps' },
  ],
  chords: [
    { bar: 1, symbol: 'C7' },
    { bar: 5, symbol: 'F7' },
    { bar: 7, symbol: 'C7' },
    { bar: 9, symbol: 'G7' },
    { bar: 10, symbol: 'F7' },
    { bar: 11, symbol: 'C7' },
  ],
});

const withChords = (chords: ArrangementChart['chords']): ArrangementChart => ({
  ...blues(),
  chords,
});

/** One run, with what went out recorded. Everything answers success; each test
 *  overrides the one thing it is about. */
interface Rig {
  readonly deps: ChartRunDeps;
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

const refusal = async (chart: unknown): Promise<string> => {
  const result = await runArrangementChart('a blues', { deps: rig(answered(chart)).deps });
  if (result.ok) throw new Error('expected a refusal, got a chart');
  return result.reason;
};

// ------------------------------------------------------------------ spec ---

describe('the chart run is tool-free', () => {
  /**
   * THE ASSERTION THE WHOLE MODULE RESTS ON. The harness sends `outputSchema` to
   * the backend for grammar-enforced decoding ONLY on turns where no tools are
   * offered; one registered tool downgrades the structured answer to a
   * best-effort `JSON.parse` of the whole reply with no fence stripping. So the
   * empty list is not an omission, it is what makes the schema enforced.
   */
  it('offers no tools at all', () => {
    expect(ARRANGEMENT_CHART_AGENT.tools).toEqual([]);
  });

  it('runs with its own schema as the output schema', async () => {
    const harness = rig(answered(blues()));
    await runArrangementChart('a twelve-bar blues in C', { deps: harness.deps });

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0].spec).toBe(ARRANGEMENT_CHART_AGENT);
    expect(harness.calls[0].input).toBe('a twelve-bar blues in C');
    expect(harness.calls[0].options?.outputSchema).toBe(ARRANGEMENT_CHART_SCHEMA);
  });

  /**
   * The pass-through, pinned by the two options a caller CANNOT see go missing:
   * `onEvent` is the run transcript and `signal` is the cancel button, and both
   * would go quietly dead — "cancel does nothing" is not a symptom anyone traces
   * back to a spread in this module.
   */
  it('passes the caller’s own run options through to the seam', async () => {
    const harness = rig(answered(blues()));
    const onEvent = () => {};
    const signal = new AbortController().signal;
    await runArrangementChart('a blues', {
      deps: harness.deps,
      maxIters: 3,
      modelId: 'some-model',
      onEvent,
      signal,
    });

    const options = harness.calls[0].options;
    expect(options?.maxIters).toBe(3);
    expect(options?.modelId).toBe('some-model');
    expect(options?.onEvent).toBe(onEvent);
    expect(options?.signal).toBe(signal);
    // `deps` is this module's own handle and is not the seam's business.
    expect(options && 'deps' in options).toBe(false);
  });

  /**
   * The prompt is not decoration: the JSON instruction is the difference between
   * a chart and nothing at all (the answer is parsed whole, with no fence
   * stripping), and the cap is a live substitution — a chart over it is refused
   * by a rule the model was never told about if this drops out.
   */
  it('tells the model to answer with bare JSON, and what the track cap is', () => {
    const prompt = ARRANGEMENT_CHART_AGENT.systemPrompt;
    expect(prompt).toContain('ONE JSON OBJECT AND NOTHING ELSE');
    expect(prompt).toContain('no code fence');
    expect(prompt).toContain(`AT MOST ${MAX_COMPOSITION_TRACKS} TRACKS`);
    expect(prompt).toContain(TRACK_CAP_REASON);
  });

  /**
   * The catalog is asserted as the LIVE value rather than as typed-out ids, and
   * then EVERY id in it separately, so an instrument the lib adds fails here
   * unless the prompt is offering it.
   *
   * ⚠ WHAT THIS CANNOT CATCH: the prompt builds its sentence at module eval, so
   * no stub of the catalog can make it re-derive, and a relapse to a literal
   * list that happened to match today's catalog would pass both assertions. That
   * one is review's, not this file's. The `not.toBe('')` guard is here because
   * `toContain('')` is vacuously true, which would leave the live-value claim
   * resting on nothing the day the catalog is empty.
   */
  it('tells the model which necks this app has, from the live catalog', () => {
    const prompt = ARRANGEMENT_CHART_AGENT.systemPrompt;
    expect(INSTRUMENT_LIST).not.toBe('');
    expect(prompt).toContain(INSTRUMENT_LIST);
    expect(INSTRUMENT_IDS).not.toEqual([]);
    INSTRUMENT_IDS.forEach((id) => expect(prompt).toContain(id));
    expect(prompt).toContain('THESE ARE THE ONLY NECKS THERE ARE');
  });

  /**
   * THE WHOLE REPAIR, AND THE SECOND ATTEMPT AT IT. Naming the catalog was the
   * first attempt and it did not hold: told this app plays fretted strings and
   * nothing else, the 2026-08-16 follow-up run sent a LEGAL `ukulele` and called
   * the part "Piano" anyway — it changed the id it sent, not the part it
   * imagined. Nothing in the data catches that and nothing should try to (see
   * `reviewChart`'s DELIBERATELY NOT CHECKED for the argument, and the test below
   * for the guard on it), so the prompt is the entire repair.
   *
   * What is pinned is the SHAPE of the instruction rather than its wording: a
   * relation between the `name`/`role` and the `instrumentId` beside them, not a
   * rule about the set of instruments the app lacks. A rewrite that drops back to
   * "we have no drums" fails here, which is the point — that sentence was already
   * tried.
   */
  it('requires the part to be named and briefed for the instrument it is on', () => {
    const prompt = ARRANGEMENT_CHART_AGENT.systemPrompt;
    expect(prompt).toContain('A PART IS THE INSTRUMENT IT IS ON');
    // The mechanical reason, which is what makes it checkable by the model — and
    // it has to be the TRUE one. An earlier draft said the writing run never sees
    // the `name`; `trackRunInput` opens its brief with the name and calls it what
    // the part is FOR, so that draft was both false and an argument that naming a
    // ukulele part "Piano" is free. This assertion pins the corrected mechanism,
    // and the companion assertion in tests/IrTrackRun.test.ts pins the other end
    // of it: the writing brief really does carry the name.
    expect(prompt).toContain('handed your `name`');
    expect(prompt).toContain('WHAT THE PART IS FOR');
    expect(prompt).not.toContain('changes nothing that sounds');
    // The observed failure, named as the wrong PAIRING rather than as a banned
    // word — the form that survives the lib growing a catalog entry.
    expect(prompt).toContain('"Piano" on a `ukulele`');
    // What to do with the imagined part instead, which is the only sentence that
    // answers the failure rather than describing it.
    expect(prompt).toContain('do not dress another instrument in its name');
    // And the schema's own description of the field, which is what a provider
    // decoding against the grammar reads.
    expect(
      ARRANGEMENT_CHART_SCHEMA.properties?.tracks?.items?.properties?.name?.description,
    ).toContain('Name it for the instrument it is on');
  });

  /**
   * THE POSITIVE HALF, and it is a separate failure from the one above.
   *
   * The rule against dressing one instrument in another's name ends "or leave it
   * out", which on its own answers a wanted third part by dropping to two. The
   * 2026-08-16 run reached for a ukulele as a third colour and called it Piano;
   * banning the name without naming the alternative just loses the part. So the
   * prompt has to say that a second guitar IS the alternative — parts may share a
   * neck, and that is how another voice is got.
   */
  it('says a second part on the same instrument is how another voice is got', () => {
    const prompt = ARRANGEMENT_CHART_AGENT.systemPrompt;
    expect(prompt).toContain('PARTS MAY SHARE A NECK');
    // The concrete pairing, in the direction the observed failure went — and as a
    // preference rather than a ban, because a piece that genuinely wants a
    // ukulele must still be able to have one.
    expect(prompt).toContain('Pick a second guitar over a first ukulele');
    expect(prompt).toContain('unless the piece asks for that ukulele');
  });

  /**
   * THE OTHER END OF THE MECHANISM THE PROMPT ABOVE ASSERTS, so that the claim is
   * enforced rather than believed.
   *
   * The chart prompt tells the model the writing run is handed its `name` and is
   * told the name says what the part is FOR. That is a claim about a DIFFERENT
   * prompt in a different module, and the first draft of it was simply false —
   * it said the name is a label that changes nothing that sounds, which is both
   * wrong and an argument that calling a ukulele part "Piano" is harmless. A
   * comment cannot stop that coming back; this can. If `trackRunInput` ever stops
   * carrying the track name, the chart prompt is lying again and this fails.
   *
   * It is deliberately the WEAKEST possible coupling to that module: one real
   * brief, one assertion that the name is in it. Nothing about the writing run's
   * musical paragraphs is asserted here — those are `tests/IrTrackRun.test.ts`'s.
   */
  it('is telling the truth about the writing run reading the name', () => {
    const [part] = blues().tracks;
    // ⚠ THE NAME IS A SENTINEL RATHER THAN THE FIXTURE'S "Bass", and that is the
    // whole difference between this test and one that cannot fail. The brief
    // prints the INSTRUMENT as well, so a track called "Bass" on a bass is found
    // in the brief whether the name reached it or not — asserting the fixture's
    // name passes even on a brief that dropped the field entirely. This name
    // appears nowhere else the brief could get it from.
    const name = 'Understudy Filigree';
    const written = trackRunInput({
      id: 'track-0',
      name,
      instrumentId: part.instrumentId,
      role: part.role,
      bars: 12,
      chords: blues().chords,
    });
    if (!written.ok) throw new Error(`trackRunInput refused: ${written.reason}`);

    expect(written.value).toContain(name);
    expect(written.value).toContain(part.role);
    expect(written.value).toContain('what the part is FOR');
  });

  /**
   * The `role` is the entire brief the writing run is handed, so an exemplar
   * naming a part this app has no neck for asks for a guitar written around a
   * silence — the same defect the section above exists to stop, one field over.
   */
  it('gives no role example that leans on a part the app cannot play', () => {
    const prompt = ARRANGEMENT_CHART_AGENT.systemPrompt;
    // More than one spelling of the defect, because one word was a guard against
    // one wording rather than against the mistake. These are instruments with no
    // neck in this app; "Drums" and "Piano" are deliberately absent from the list
    // because the prompt names both ON PURPOSE, as the wrong PAIRINGS.
    ['vocal', 'horn', 'organ', 'saxophone', 'trumpet'].forEach((absent) =>
      expect(prompt.toLowerCase()).not.toContain(absent),
    );
  });

  /** The deleted step made the model author pattern ids, lengths and bar lists,
   *  and died on all three. `additionalProperties: false` is what makes a
   *  relapse a decoding failure rather than an answer, so the four keys are
   *  pinned exactly. */
  it('asks for four keys and nothing that could be derived', () => {
    expect(Object.keys(ARRANGEMENT_CHART_SCHEMA.properties ?? {})).toEqual([
      'bars',
      'bpm',
      'tracks',
      'chords',
    ]);
    expect(ARRANGEMENT_CHART_SCHEMA.additionalProperties).toBe(false);
    const track = ARRANGEMENT_CHART_SCHEMA.properties?.tracks.items?.properties ?? {};
    expect(Object.keys(track)).toEqual(['name', 'instrumentId', 'role']);
    const chord = ARRANGEMENT_CHART_SCHEMA.properties?.chords.items?.properties ?? {};
    expect(Object.keys(chord)).toEqual(['bar', 'symbol']);
  });
});

// ---------------------------------------------------------------- passing ---

describe('a chart that would build', () => {
  it('passes a twelve-bar blues in C with three parts', () => {
    expect(reviewChart(blues())).toEqual([]);
  });

  it('hands the chart back from a run that answered one', async () => {
    const result = await runArrangementChart('a blues', { deps: rig(answered(blues())).deps });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The six CHANGES, not the twelve bars — the property the shape exists for.
    expect(result.value.chords.map((chord) => chord.bar)).toEqual([1, 5, 7, 9, 10, 11]);
    expect(result.value.tracks).toHaveLength(3);
    expect(result.value.bars).toBe(12);
  });
});

// --------------------------------------------------------------- refusals ---

describe('a chord the app cannot read', () => {
  it('is refused, naming the symbol and the bar', async () => {
    const reason = await refusal(
      withChords([
        { bar: 1, symbol: 'C7' },
        { bar: 5, symbol: 'Zz9' },
      ]),
    );
    expect(reason).toContain('Zz9');
    expect(reason).toContain('bar 5');
  });

  it('is refused once rather than once per neck', () => {
    // The blues fixture has three tracks over TWO necks, so a symbol no neck can
    // read could be reported twice. `chordRefusal` returns at the first neck
    // that refuses, which is what makes one bad symbol one sentence — the batch
    // rule every tool in this app caps by, at a narrower address.
    const refusals = reviewChart(withChords([{ bar: 1, symbol: 'Zz9' }]));
    expect(refusals).toHaveLength(1);
    expect(refusals[0].label).toBe('bar 1');
  });

  it('is not also blamed for its bar when the bar is what is wrong', () => {
    // One entry, one sentence: an entry already refused for WHERE it arrives is
    // not sent to the symbol check as well. Two accounts of one mistake fill the
    // named-refusal cap before it reaches the later chords.
    const refusals = reviewChart(
      withChords([
        { bar: 1, symbol: 'C7' },
        { bar: 99, symbol: 'Zz9' },
      ]),
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0].reason).toContain('outside a form of 12 bars');
  });
});

describe('a progression that does not fit the form', () => {
  it('refuses a chord past the last bar, naming the bar and the length', async () => {
    const reason = await refusal(
      withChords([
        { bar: 1, symbol: 'C7' },
        { bar: 13, symbol: 'G7' },
      ]),
    );
    expect(reason).toContain('bar 13');
    expect(reason).toContain('12 bars');
  });

  it('refuses chords out of ascending order, naming both', async () => {
    const reason = await refusal(
      withChords([
        { bar: 1, symbol: 'C7' },
        { bar: 9, symbol: 'G7' },
        { bar: 5, symbol: 'F7' },
      ]),
    );
    expect(reason).toContain('bar 5');
    expect(reason).toContain('bar 9');
    expect(reason).toContain('ascending');
  });

  it('refuses two chords arriving in the same bar', () => {
    // "Ascending" is strict: a chord holds until the NEXT one, so two entries at
    // one bar is a change with no length and no way to say which won.
    const refusals = reviewChart(
      withChords([
        { bar: 1, symbol: 'C7' },
        { bar: 1, symbol: 'F7' },
      ]),
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0].label).toBe('bar 1');
  });

  it('refuses a chord arriving on a fraction of a bar', () => {
    // Nothing else catches this: 1.5 is inside the form and after bar 1, and the
    // schema's `integer` is the provider's to honour.
    const refusals = reviewChart(
      withChords([
        { bar: 1, symbol: 'C7' },
        { bar: 1.5, symbol: 'F7' },
      ]),
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0].reason).toContain('whole bar from 1 to 12');
  });

  it('refuses a chord before bar 1, rather than only noticing bar 1 is empty', () => {
    const refusals = reviewChart(withChords([{ bar: 0, symbol: 'C7' }]));
    // Two mistakes, two sentences: nothing starts the form, AND bar 0 is not a
    // bar. The second is the one that says what to change.
    expect(refusals.map((entry) => entry.label)).toEqual(['bar 1', 'bar 0']);
  });

  it('refuses a form that never starts', async () => {
    const reason = await refusal(
      withChords([
        { bar: 3, symbol: 'C7' },
        { bar: 5, symbol: 'F7' },
      ]),
    );
    expect(reason).toContain('bar 1');
  });
});

describe('the form and the tempo', () => {
  /**
   * `bars` is the length every later step derives ticks from, and NEITHER layer
   * used to look at it: `asChart` checks only that it is a finite number, and
   * the schema's `integer, minimum: 1` is advice a provider may ignore. A
   * fractional or absurd form length went through clean.
   */
  it('refuses a form that is not a whole number of bars', () => {
    const refusals = reviewChart({ ...blues(), bars: 12.5 });
    expect(refusals).toHaveLength(1);
    expect(refusals[0].label).toBe('12.5 bars');
  });

  it('refuses a form of no bars at all', () => {
    const refusals = reviewChart({ ...blues(), bars: 0 });
    expect(refusals[0].label).toBe('0 bars');
  });

  it('blames the form length once rather than every chord in it', () => {
    // A bad `bars` suppresses the per-chord range test: comparing against 12.5
    // would refuse all six chords for one bad number, and print that number in
    // each sentence.
    const refusals = reviewChart({ ...blues(), bars: 12.5 });
    expect(refusals.map((entry) => entry.label)).toEqual(['12.5 bars']);
  });

  /** `setCompositionBpm` refuses only a non-finite or non-positive tempo, so the
   *  schema's bounds are the only other statement of this and a provider that
   *  ignored the grammar would have a piece playing at 100000. */
  it('refuses a tempo the app does not play', () => {
    expect(reviewChart({ ...blues(), bpm: 0 })).toHaveLength(1);
    expect(reviewChart({ ...blues(), bpm: 100000 })[0].label).toBe('100000 bpm');
    expect(reviewChart({ ...blues(), bpm: 20 })).toEqual([]);
    expect(reviewChart({ ...blues(), bpm: 400 })).toEqual([]);
  });
});

describe('the parts', () => {
  /**
   * A chart with no parts used to pass clean, and took an unreadable symbol
   * through with it: no track is refusable, and with no necks to ask on the
   * chord lookup never runs. `ok: true` with nothing to play.
   */
  it('refuses a chart that names no parts at all', async () => {
    const reason = await refusal({ ...blues(), tracks: [] });
    expect(reason).toContain('no parts');
  });

  it('does not let an empty cast smuggle an unreadable chord past', () => {
    const refusals = reviewChart({
      ...blues(),
      tracks: [],
      chords: [{ bar: 1, symbol: 'Zz9' }],
    });
    expect(refusals).not.toEqual([]);
  });

  it('refuses an instrument this app has no neck for, naming the track', async () => {
    const chart = blues();
    const reason = await refusal({
      ...chart,
      tracks: [...chart.tracks, { name: 'Horns', instrumentId: 'trumpet', role: 'stabs' }],
    });
    expect(reason).toContain('Horns');
    expect(reason).toContain('trumpet');
  });

  it('does not also blame every chord for the unknown neck', () => {
    // The unknown instrument is excluded from the necks chords are asked about,
    // so one missing neck is one sentence rather than one per chord.
    const chart = blues();
    const refusals = reviewChart({
      ...chart,
      tracks: [...chart.tracks, { name: 'Horns', instrumentId: 'trumpet', role: 'stabs' }],
    });
    expect(refusals).toHaveLength(1);
  });

  /**
   * THE DECLINED CHECK, PINNED SO REVERSING IT FAILS — and it is the case that
   * MUST NOT BE REFUSED. Both charts that went wrong are here: "Drums" on a
   * `bass` (2026-08-16) and "Piano" on a `ukulele` (the run after it). Both are
   * built correctly by the app, and `reviewChart` deliberately has nothing to say
   * about either.
   *
   * The reason is not that a blocklist would be wrong — after two runs it would
   * be right more often than not. It is that the chart is the one step
   * `irCompositionJob` never re-asks, so a refusal here throws away the WHOLE
   * composition, and what it would be throwing away is a piece that plays. A
   * right refusal costs as much as a wrong one. See `reviewChart`'s own header
   * for the full argument; the repair is the prompt, tested above.
   *
   * The FIRST track is the false positive a blocklist would take with it — it is
   * called "Drums" and its role is a percussive muted-string pulse, which is a
   * real bass part a player would nickname exactly that. The third is that same
   * part named the way the prompt now asks for, and is here to show a correctly
   * named part is not refused either: the check is absent, not lenient.
   */
  it('does not refuse a part for what it is called', () => {
    expect(
      reviewChart({
        ...blues(),
        tracks: [
          { name: 'Drums', instrumentId: 'bass', role: 'percussive muted-string pulse' },
          { name: 'Piano', instrumentId: 'ukulele', role: 'light comping, inner voices' },
          { name: 'Muted Pulse', instrumentId: 'bass', role: 'dead-string sixteenths' },
        ],
      }),
    ).toEqual([]);
  });

  it('refuses more parts than a composition can hold', () => {
    const track = (index: number) => ({
      name: `Part ${index}`,
      instrumentId: 'guitar',
      role: 'doubling everything else',
    });
    const tracks = Array.from({ length: MAX_COMPOSITION_TRACKS + 1 }, (_, i) => track(i));
    const refusals = reviewChart({ ...blues(), tracks });
    expect(refusals).toHaveLength(1);
    expect(refusals[0].reason).toContain(`${MAX_COMPOSITION_TRACKS}`);
  });
});

// -------------------------------------------------------------- narrowing ---

describe('what comes back from the run', () => {
  it('refuses a run that answered prose, naming the stop reason', async () => {
    const result = await runArrangementChart('a blues', {
      deps: rig({
        ok: true,
        value: { content: 'Here is a blues!', stoppedReason: 'answered', toolCalls: [] },
      }).deps,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('answered');
  });

  it('passes the run’s own refusal straight through', async () => {
    const result = await runArrangementChart('a blues', {
      deps: rig({ ok: false, reason: 'No provider is configured.' }).deps,
    });
    expect(result).toEqual({ ok: false, reason: 'No provider is configured.' });
  });

  it('refuses an empty ask without spending a run', async () => {
    const harness = rig(answered(blues()));
    const result = await runArrangementChart('   ', { deps: harness.deps });
    expect(result.ok).toBe(false);
    expect(harness.calls).toEqual([]);
  });

  /** One bad entry makes the whole reply unusable, deliberately: dropping a
   *  chord silently EXTENDS the one before it, because a chord holds until the
   *  next one. */
  it('reads no chart out of a reply with a malformed chord', () => {
    expect(asChart({ ...blues(), chords: [{ bar: 1 }] })).toBeNull();
  });

  /** The other half of the same guard. Without it a null track reaches
   *  `reviewChart`, which reads `track.instrumentId` off it and throws a
   *  `TypeError` out of the run — the outcome the narrowing exists to prevent. */
  it('reads no chart out of a reply with a malformed track', () => {
    expect(asChart({ ...blues(), tracks: [{ name: 'Bass' }] })).toBeNull();
    expect(asChart({ ...blues(), tracks: [...blues().tracks, null] })).toBeNull();
  });

  it('copies the fields rather than passing the reply through', () => {
    const chart = asChart({ ...blues(), sections: ['A', 'B'] });
    expect(chart).not.toBeNull();
    expect(chart && 'sections' in chart).toBe(false);
  });
});
