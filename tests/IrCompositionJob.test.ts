/**
 * The job that joins the three surfaces: a chart, a part at a time, one import.
 *
 * ⚠ THERE IS NO MODEL IN THIS FILE, and no library either. Both outside calls go
 * through the injected deps — `runTask` returns what the test says it returns,
 * and `importDocument` records the document instead of committing it. What this
 * module decides is the ORDER of the steps, the ENVELOPE it builds around the
 * parts, what happens to a part that fails, and where a cancel is honoured. None
 * of that needs a provider or a store, and a test with either could assert none
 * of it.
 *
 * What is REAL: `runArrangementChart`'s narrowing and `reviewChart`,
 * `runIRTrack`'s brief and `reviewTrack`, and the transcript. So a chart or a
 * part that would be refused in production is refused here, by the module that
 * authored the sentence.
 *
 * ⚠ THE IMPORT ASSERTIONS ARE THE POINT OF THE HAPPY PATH. `totalTicks`,
 * `ticksPerQuarter` and the track count are the whole of what this module
 * contributes to the document — the model contributes the events and nothing
 * else — and every one of them is a number the import pipeline accepts in
 * silence when it is wrong.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { runAgentTask } from '../src/ai/agentService';
import {
  IR_COMPOSITION_JOB_DEPS,
  runIrCompositionJob,
  type IrCompositionJobDeps,
  type IrCompositionJobEvent,
} from '../src/ai/irCompositionJob';
import { TICKS_PER_BAR } from '../src/ai/irTrackRun';
import { clearTranscripts, getTranscript } from '../src/ai/runTranscript';
import { PPQ, importIR } from '../src/patterns/patternService';
import type {
  AgentEvent,
  AgentRunSummary,
  AgentSpec,
  RunAgentTaskOptions,
} from '../src/ai/agentService';
import type {
  ImportIR,
  ImportOptions,
  ImportedDocuments,
  Result,
} from '../src/patterns/patternService';

// --------------------------------------------------------------- fixtures ---

const BARS = 2;

/** A chart of three parts on three different necks — three because the count is
 *  what the per-part progress is numbered against, and a run against two would
 *  pass with an off-by-one either way. */
const CHART = {
  bars: BARS,
  bpm: 96,
  tracks: [
    { name: 'Bass', instrumentId: 'bass', role: 'walking bass, quarter notes' },
    { name: 'Rhythm Guitar', instrumentId: 'guitar', role: 'off-beat comping' },
    { name: 'Uke', instrumentId: 'ukulele', role: 'straight strumming on the beat' },
  ],
  chords: [{ bar: 1, symbol: 'C7' }],
};

/**
 * Two attacks on the bottom string, a bar apart.
 *
 * ⚠ DELIBERATELY PLAYABLE ON ALL THREE NECKS, so one answer serves every part
 * and a refusal in these tests is never about the fixture: string 0 exists on a
 * four-string bass, and fret 5 is inside a ukulele's fifteen.
 */
const EVENTS = [
  { atTick: 0, durationTicks: PPQ, notes: [{ string: 0, fret: 3 }] },
  { atTick: TICKS_PER_BAR, durationTicks: PPQ, notes: [{ string: 0, fret: 5 }] },
];

const answered = (structured: unknown): Result<AgentRunSummary> => ({
  ok: true,
  value: { content: '', stoppedReason: 'answered', toolCalls: [], structured },
});

/** A run the harness could not make at all — the shape `runAgentTask` refuses
 *  in. */
const dead = (reason: string): Result<AgentRunSummary> => ({ ok: false, reason });

const IMPORTED: ImportedDocuments = {
  patternIds: ['pat-1', 'pat-2', 'pat-3'],
  compositionId: 'comp-1',
  topology: 'composition',
  warnings: [],
};

/**
 * What the harness actually emits during a TOOL-FREE run, which is all either of
 * these runs ever is: the model's own reasoning and the call that produced it.
 *
 * ⚠ THE TWO TYPES ARE CHOSEN, not arbitrary. `runTranscript`'s recorder files
 * `thinking` into `thinking` and `model.call.finished` into `iterations`, so both
 * land in a field a test can read — a `token` event, by contrast, is dropped on
 * purpose and would make the recording untestable while looking like a test of
 * it. Nothing in this file has a tool to emit `tool.requested` for.
 */
const runEvents = (agent: string): AgentEvent[] => [
  { type: 'thinking', runId: agent, text: `${agent} thought about it` },
  { type: 'model.call.finished', runId: agent, iter: 1, finishReason: 'stop' },
];

// -------------------------------------------------------------------- rig ---

interface Rig {
  readonly deps: IrCompositionJobDeps;
  /** The agent name of every run, in the order the runs happened. */
  readonly agents: string[];
  /** The brief each run was given, so a test can tell one part from another. */
  readonly inputs: string[];
  /** What each run was called with — the signal above all. */
  readonly options: (RunAgentTaskOptions | undefined)[];
  /** Every document handed to the seam. Length is how many imports happened. */
  readonly documents: ImportIR[];
  /** The `ImportOptions` each import was given — the job passes none, and that
   *  is a decision its header states rather than a default nobody looked at. */
  readonly importOptions: (ImportOptions | undefined)[];
}

interface RigOptions {
  /** The chart run's answer. Defaults to {@link CHART}. */
  readonly chart?: Result<AgentRunSummary>;
  /** The nth part run's answer, 1-based. Defaults to {@link EVENTS}. */
  readonly track?: (index: number) => Result<AgentRunSummary>;
  readonly imported?: Result<ImportedDocuments>;
  /** Called after each run returns, so a test can abort BETWEEN two of them. */
  readonly afterRun?: (agent: string, count: number) => void;
  /** Thrown out of the nth part run instead of an answer — the shape a BUG in
   *  the harness has, as opposed to a run that failed and said so. */
  readonly throwOn?: (agent: string, count: number) => Error | undefined;
}

function rig(options: RigOptions = {}): Rig {
  const agents: string[] = [];
  const inputs: string[] = [];
  const seenOptions: (RunAgentTaskOptions | undefined)[] = [];
  const documents: ImportIR[] = [];
  const importOptions: (ImportOptions | undefined)[] = [];
  let tracksRun = 0;

  const runTask = (
    spec: AgentSpec,
    input: string,
    runOptions?: RunAgentTaskOptions,
  ): Promise<Result<AgentRunSummary>> => {
    agents.push(spec.name);
    inputs.push(input);
    seenOptions.push(runOptions);
    const isChart = spec.name === 'arrangement-chart';
    if (!isChart) tracksRun += 1;
    const nth = isChart ? 1 : tracksRun;
    // ⚠ THE EVENTS ARE EMITTED, not merely accepted. Without this the job's
    // `onEvent` wrapper — the log-first-then-the-view pair the whole transcript
    // depends on — is dead code in every test in this file, and deleting it
    // outright would keep the suite green.
    for (const event of runEvents(spec.name)) runOptions?.onEvent?.(event);
    const thrown = options.throwOn?.(spec.name, nth);
    if (thrown) {
      options.afterRun?.(spec.name, nth);
      return Promise.reject(thrown);
    }
    const answer = isChart
      ? (options.chart ?? answered(CHART))
      : (options.track?.(tracksRun) ?? answered({ events: EVENTS }));
    options.afterRun?.(spec.name, nth);
    return Promise.resolve(answer);
  };

  return {
    agents,
    inputs,
    options: seenOptions,
    documents,
    importOptions,
    deps: {
      runTask,
      importDocument: (raw, importOpts) => {
        documents.push(raw);
        importOptions.push(importOpts);
        return options.imported ?? { ok: true, value: IMPORTED };
      },
    },
  };
}

/** Every progress event, in order, with the callback attached. */
function progress(): { readonly events: IrCompositionJobEvent[]; readonly onProgress: (event: IrCompositionJobEvent) => void } {
  const events: IrCompositionJobEvent[] = [];
  return { events, onProgress: (event) => events.push(event) };
}

const types = (events: readonly IrCompositionJobEvent[]): string[] =>
  events.map((event) => event.type);

/** The job's transcript id, off `job.started` — the only handle a job that was
 *  REFUSED gives out, and the reason that event carries it before anything runs.
 *  The ids themselves are a module-wide counter that `clearTranscripts` does not
 *  reset, so no test may name one. */
function jobIdFrom(events: readonly IrCompositionJobEvent[]): string {
  const started = events[0];
  if (started?.type !== 'job.started') throw new Error('expected job.started first');
  return started.transcriptId;
}

beforeEach(() => {
  clearTranscripts();
});

// ------------------------------------------------------------ happy path ---

describe('a job that runs to the end', () => {
  it('runs the chart, then one run per part, then one import', async () => {
    const fake = rig();

    const outcome = await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    expect(outcome.ok).toBe(true);
    expect(fake.agents).toEqual(['arrangement-chart', 'ir-track', 'ir-track', 'ir-track']);
    expect(fake.documents).toHaveLength(1);
  });

  it('briefs each part with its own name and role', async () => {
    const fake = rig();

    await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    // The chart run gets the request; the parts get briefs, and never the
    // request — see the job's header on why the parts are briefed from the
    // chart alone.
    expect(fake.inputs[0]).toBe('a two-bar blues');
    expect(fake.inputs[1]).toContain('walking bass, quarter notes');
    expect(fake.inputs[2]).toContain('off-beat comping');
    expect(fake.inputs[3]).toContain('straight strumming on the beat');
  });

  it('builds the envelope itself, from the chart', async () => {
    const fake = rig();

    await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    const document = fake.documents[0];
    expect(document.ticksPerQuarter).toBe(PPQ);
    expect(document.totalTicks).toBe(BARS * TICKS_PER_BAR);
    expect(document.tracks).toHaveLength(3);
    expect(document.tempos).toEqual([{ atTick: 0, bpm: 96, interpolation: 'step' }]);
    expect(document.timeSignatures).toEqual([{ atTick: 0, numerator: 4, denominator: 4 }]);
  });

  it('gives every track a distinct id and the name the chart chose', async () => {
    const fake = rig();

    await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    const tracks = fake.documents[0].tracks;
    expect(tracks.map((track) => track.id)).toEqual(['track-1', 'track-2', 'track-3']);
    expect(tracks.map((track) => track.name)).toEqual(['Bass', 'Rhythm Guitar', 'Uke']);
    expect(tracks.map((track) => track.instrumentHint)).toEqual(['bass', 'guitar', 'ukulele']);
  });

  it('carries each part\'s events through unedited', async () => {
    // The envelope is this module's and the CONTENT is the model's: the job
    // adds nothing to a part and takes nothing away. Without this, a document
    // whose tracks were all empty — or all the same track — passes every other
    // assertion in this block.
    const fake = rig();

    await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    for (const track of fake.documents[0].tracks) expect(track.events).toEqual(EVENTS);
  });

  it('passes no import options, so the chart\'s first part is the primary one', async () => {
    // The mapper's default `selectedTrackId` is the first track with notes, and
    // the primary track sorts first and gives the composition its instrument.
    // Stated in the job's header as a decision; pinned here so passing an option
    // later is a deliberate change rather than a silent one.
    const fake = rig();

    await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    expect(fake.importOptions).toEqual([undefined]);
  });

  it('takes the first LINE of a multi-line request as the name', async () => {
    // A brief whose second paragraph is not a title — without the line split the
    // composition is filed under the whole thing.
    const fake = rig();

    await runIrCompositionJob('a slow blues\n\nkeep it sparse', { deps: fake.deps });

    expect(fake.documents[0].meta.title).toBe('a slow blues');
  });

  it('imports a one-part chart as whatever the seam makes of it, forcing nothing', async () => {
    // `reviewChart` allows a one-part chart on purpose and the mapper calls it
    // `single-pattern`; the job forces no topology, so a composition of one lane
    // nobody asked for is never built. See the job's header.
    const fake = rig({ chart: answered({ ...CHART, tracks: [CHART.tracks[0]] }) });

    const outcome = await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    expect(outcome.ok).toBe(true);
    expect(fake.agents).toEqual(['arrangement-chart', 'ir-track']);
    expect(fake.documents).toHaveLength(1);
    expect(fake.documents[0].tracks).toHaveLength(1);
    expect(fake.importOptions).toEqual([undefined]);
  });

  it('writes no sections, no chords and no key signatures', async () => {
    // All three are dead weight in this build — the validator discards `chords`,
    // the mapper never reads `keySignatures`, and a section marker would cut
    // every part into one pattern per section. Pinned in tests/ImportIR.test.ts.
    const fake = rig();

    await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    const document = fake.documents[0];
    expect(document.sections).toEqual([]);
    expect(document.keySignatures).toEqual([]);
    expect(document.chords).toBeUndefined();
  });

  it('names the composition after the request', async () => {
    // `mapImportToLibrary` reads `meta.title || selectedTrack.name`, so without
    // this the piece would be filed under whichever part sorted first.
    const fake = rig();

    await runIrCompositionJob('a slow two-bar blues in C', { deps: fake.deps });

    expect(fake.documents[0].meta.title).toBe('a slow two-bar blues in C');
  });

  it('cuts a request too long to be a name, and says it cut it', async () => {
    const fake = rig();
    const long = `${'twelve bars of blues '.repeat(10)}please`;

    await runIrCompositionJob(long, { deps: fake.deps });

    // `ImportMeta.title` is optional on the lib's side; this job always writes
    // one, which is the thing being asserted.
    const title = fake.documents[0].meta.title ?? '';
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith('…')).toBe(true);
  });

  it('hands back the chart, what the import made, and the transcript id', async () => {
    const fake = rig();

    const outcome = await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    if (!outcome.ok) throw new Error(`expected a finished job, got: ${outcome.reason}`);
    expect(outcome.value.chart.bars).toBe(BARS);
    expect(outcome.value.documents).toEqual(IMPORTED);
    expect(getTranscript(outcome.value.transcriptId)).toBeDefined();
  });
});

// ------------------------------------------------------------- part names ---

describe('the names the parts are filed under', () => {
  it('gives two parts of one name distinct ones', async () => {
    // `reviewChart` allows duplicate names on purpose — "a later step's to
    // derive around" — and this is that step. Nothing after it derives anything:
    // the mapper names the pattern AND the composition's track `irTrack.name`,
    // so two "Guitar"s would make two lanes a screen reader cannot tell apart.
    const fake = rig({
      chart: answered({
        ...CHART,
        tracks: [
          { name: 'Guitar', instrumentId: 'guitar', role: 'off-beat comping' },
          { name: 'Guitar', instrumentId: 'guitar', role: 'single-note lead' },
        ],
      }),
    });

    const outcome = await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    expect(outcome.ok).toBe(true);
    expect(fake.documents[0].tracks.map((track) => track.name)).toEqual(['Guitar', 'Guitar 2']);
  });

  it('does not collide with a number the chart already used', async () => {
    const fake = rig({
      chart: answered({
        ...CHART,
        tracks: [
          { name: 'Guitar', instrumentId: 'guitar', role: 'off-beat comping' },
          { name: 'Guitar 2', instrumentId: 'guitar', role: 'single-note lead' },
          { name: 'Guitar', instrumentId: 'guitar', role: 'open-string drone' },
        ],
      }),
    });

    await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    expect(fake.documents[0].tracks.map((track) => track.name)).toEqual([
      'Guitar',
      'Guitar 2',
      'Guitar 3',
    ]);
  });

  it('numbers a part the chart left nameless rather than losing the job over it', async () => {
    // A whitespace name passes the grammar (`minLength: 1` admits " ") and
    // `trackRunInput` refuses a part with no name — so without the derivation
    // the whole arrangement dies on a stray space.
    const fake = rig({
      chart: answered({
        ...CHART,
        tracks: [CHART.tracks[0], { name: '  ', instrumentId: 'guitar', role: 'off-beat comping' }],
      }),
    });

    const outcome = await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    expect(outcome.ok).toBe(true);
    expect(fake.documents[0].tracks.map((track) => track.name)).toEqual(['Bass', 'Track 2']);
  });

  it('says the derived name everywhere the job says a name at all', async () => {
    // One name across the brief, the progress event, the transcript section and
    // the document — a panel showing the chart's word for a part the library
    // filed under another is the drift this derivation exists to stop.
    const fake = rig({
      chart: answered({
        ...CHART,
        tracks: [
          { name: 'Guitar', instrumentId: 'guitar', role: 'off-beat comping' },
          { name: 'Guitar', instrumentId: 'guitar', role: 'single-note lead' },
        ],
      }),
    });
    const seen = progress();

    const outcome = await runIrCompositionJob('a two-bar blues', {
      deps: fake.deps,
      label: 'Arrange',
      onProgress: seen.onProgress,
    });

    if (!outcome.ok) throw new Error(`expected a finished job, got: ${outcome.reason}`);
    expect(fake.inputs[2]).toContain('"Guitar 2"');
    const started = seen.events.filter((event) => event.type === 'track.started');
    expect(started.map((event) => (event.type === 'track.started' ? event.track.name : ''))).toEqual(
      ['Guitar', 'Guitar 2'],
    );
    expect(getTranscript(outcome.value.transcriptId)?.runs?.map((run) => run.command)).toEqual([
      'Arrange — chart',
      'Arrange — Guitar',
      'Arrange — Guitar 2',
    ]);
    // The chart handed back keeps the model's own words — it is the record of
    // what the model said, not of what was filed.
    expect(outcome.value.chart.tracks.map((track) => track.name)).toEqual(['Guitar', 'Guitar']);
  });
});

// -------------------------------------------------------- the chart failing ---

describe('a chart that never arrives', () => {
  it('stops before any part is run, and imports nothing', async () => {
    const fake = rig({ chart: dead('No provider is configured.') });

    const outcome = await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    expect(outcome).toMatchObject({ ok: false, stopped: 'chart-failed' });
    expect(fake.agents).toEqual(['arrangement-chart']);
    expect(fake.documents).toHaveLength(0);
  });

  it('passes on the chart run\'s own sentence', async () => {
    const fake = rig({ chart: dead('No provider is configured.') });

    const outcome = await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.reason).toContain('No provider is configured.');
  });

  it('stops on a chart that fails review, before any part is run', async () => {
    // A chord arriving past the end of the form — `reviewChart`'s rule, run for
    // real here, and the one thing between a nonsense chart and three wasted
    // part runs.
    const fake = rig({
      chart: answered({ ...CHART, chords: [{ bar: 1, symbol: 'C7' }, { bar: 40, symbol: 'F7' }] }),
    });

    const outcome = await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    expect(outcome).toMatchObject({ ok: false, stopped: 'chart-failed' });
    expect(fake.agents).toEqual(['arrangement-chart']);
    expect(fake.documents).toHaveLength(0);
  });
});

// -------------------------------------------------------- a part that fails ---

describe('a part that cannot be written', () => {
  /** The second part's run answers with a part that `reviewTrack` refuses — a
   *  fractional tick, which the import pipeline would DROP in silence. */
  const brokenSecond = rig.bind(null, {
    track: (index: number) =>
      index === 2
        ? answered({ events: [{ atTick: 0.5, durationTicks: PPQ, notes: [{ string: 0, fret: 3 }] }] })
        : answered({ events: EVENTS }),
  });

  it('refuses the whole job rather than importing what is left', async () => {
    // The decision, pinned: a composition needs two or more non-empty tracks,
    // and a backing track minus one part is a different thing from the one that
    // was asked for. See the job's header.
    const fake = brokenSecond();

    const outcome = await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    expect(outcome).toMatchObject({ ok: false, stopped: 'track-failed' });
    expect(fake.documents).toHaveLength(0);
  });

  it('stops there rather than running the parts after it', async () => {
    const fake = brokenSecond();

    await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    expect(fake.agents).toEqual(['arrangement-chart', 'ir-track', 'ir-track']);
  });

  it('names the part, its place in the job, and why', async () => {
    const fake = brokenSecond();

    const outcome = await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.reason).toContain('Rhythm Guitar');
    expect(outcome.reason).toContain('part 2 of 3');
    // `runIRTrack`'s own account of it, passed on rather than re-worded.
    expect(outcome.reason).toContain('atTick');
    // ⚠ AND WHAT IT COST, which is the whole of the refuse-the-whole-job
    // decision: a refusal that hid the thrown-away part would read as a job that
    // had barely started.
    expect(outcome.reason).toContain('the part already written was not kept');
  });

  it('says the job stopped there when the FIRST part is the one that failed', async () => {
    const fake = rig({
      track: (index) => (index === 1 ? answered({ events: [] }) : answered({ events: EVENTS })),
    });

    const outcome = await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.reason).toContain('the job stopped there');
    expect(outcome.reason).not.toContain('already written');
  });

  it('reports it on the event stream as well, against the part it happened to', async () => {
    const fake = brokenSecond();
    const seen = progress();

    await runIrCompositionJob('a two-bar blues', { deps: fake.deps, onProgress: seen.onProgress });

    const failed = seen.events.find(
      (event) => event.type === 'track.finished' && !event.ok,
    );
    expect(failed).toMatchObject({ index: 2, count: 3, ok: false });
    expect(failed).toHaveProperty('track.name', 'Rhythm Guitar');
  });

  it('refuses a part that came back empty, which the pipeline would commit', async () => {
    // A track with no notes survives validation and commits as a pattern with
    // nothing in it — `reviewTrack` is what stops that, and this is the job
    // honouring its refusal.
    const fake = rig({
      track: (index) => (index === 1 ? answered({ events: [] }) : answered({ events: EVENTS })),
    });

    const outcome = await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    expect(outcome).toMatchObject({ ok: false, stopped: 'track-failed' });
    expect(fake.documents).toHaveLength(0);
  });
});

// -------------------------------------------------------- the import failing ---

describe('a document the seam refuses', () => {
  it('reports it as an import refusal, in the seam\'s own words', async () => {
    const fake = rig({ imported: { ok: false, reason: 'That document isn\'t a valid import.' } });

    const outcome = await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    expect(outcome).toMatchObject({ ok: false, stopped: 'import-refused' });
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.reason).toContain('valid import');
  });
});

// ----------------------------------------------------------- cancellation ---

describe('cancellation', () => {
  it('writes nothing when the signal is already aborted', async () => {
    const fake = rig();
    const controller = new AbortController();
    controller.abort();

    const outcome = await runIrCompositionJob('a two-bar blues', {
      deps: fake.deps,
      signal: controller.signal,
    });

    expect(outcome).toMatchObject({ ok: false, stopped: 'cancelled' });
    expect(fake.agents).toHaveLength(0);
    expect(fake.documents).toHaveLength(0);
  });

  it('threads the one signal into every run', async () => {
    // The between-step checks below are only half of it: a run already in
    // flight is the harness's to abort, and it can only do that if the signal
    // reached it.
    const fake = rig();
    const controller = new AbortController();

    await runIrCompositionJob('a two-bar blues', {
      deps: fake.deps,
      signal: controller.signal,
    });

    expect(fake.options).toHaveLength(4);
    expect(fake.options.every((options) => options?.signal === controller.signal)).toBe(true);
  });

  it('stops between two parts, and does NOT import', async () => {
    // ⚠ THE CHECK THIS FILE EXISTS FOR. The abort lands after part 1 has come
    // back and before part 2 is asked for — the harness cannot help here,
    // because there is no run in flight for it to abort.
    const fake = rig();
    const controller = new AbortController();
    const seen = progress();

    const outcome = await runIrCompositionJob('a two-bar blues', {
      deps: fake.deps,
      signal: controller.signal,
      onProgress: (event) => {
        seen.onProgress(event);
        if (event.type === 'track.finished' && event.index === 1) controller.abort();
      },
    });

    expect(outcome).toMatchObject({ ok: false, stopped: 'cancelled' });
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.reason).toContain('after 1 of 3 parts');
    expect(fake.agents).toEqual(['arrangement-chart', 'ir-track']);
    expect(fake.documents).toHaveLength(0);
    expect(types(seen.events)).not.toContain('import.started');
  });

  it('emits only job.finished when the signal was already aborted', async () => {
    // ⚠ THE ONE EXCEPTION to "job.started first", and it is deliberate: no
    // transcript is opened for a job that never ran, so there is no id to carry
    // and no entry spent evicting a log somebody is on their way to read.
    const fake = rig();
    const controller = new AbortController();
    controller.abort();
    const seen = progress();

    await runIrCompositionJob('a two-bar blues', {
      deps: fake.deps,
      signal: controller.signal,
      onProgress: seen.onProgress,
    });

    expect(types(seen.events)).toEqual(['job.finished']);
  });

  it('reports a cancel DURING the chart run as a cancel, not as a bad chart', async () => {
    // An aborted run comes back `ok` with `stoppedReason: 'aborted'` and no
    // structure, which `runArrangementChart` turns into "no usable chart". Read
    // the result first and the job blames the model for the user's own click.
    const controller = new AbortController();
    const fake = rig({
      afterRun: (agent) => {
        if (agent === 'arrangement-chart') controller.abort();
      },
    });

    const outcome = await runIrCompositionJob('a two-bar blues', {
      deps: fake.deps,
      signal: controller.signal,
    });

    expect(outcome).toMatchObject({ ok: false, stopped: 'cancelled' });
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.reason).toContain('writing the chart');
    expect(fake.agents).toEqual(['arrangement-chart']);
    expect(fake.documents).toHaveLength(0);
  });

  it('reports a cancel DURING a part run against that part, not as a bad part', async () => {
    // Same reason one step down, and this is where the wall-clock time is. Read
    // the result first and someone who pressed stop is told to run it again.
    const controller = new AbortController();
    const fake = rig({
      afterRun: (agent, count) => {
        if (agent === 'ir-track' && count === 2) controller.abort();
      },
    });
    const seen = progress();

    const outcome = await runIrCompositionJob('a two-bar blues', {
      deps: fake.deps,
      signal: controller.signal,
      onProgress: seen.onProgress,
    });

    expect(outcome).toMatchObject({ ok: false, stopped: 'cancelled' });
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.reason).toContain('Rhythm Guitar');
    expect(outcome.reason).toContain('part 2 of 3');
    expect(fake.agents).toHaveLength(3);
    expect(fake.documents).toHaveLength(0);
    // ⚠ AND NO `track.finished` FOR IT. `ok: false` means the model wrote
    // something unusable, and a cancel is not that — the pairing is broken on
    // purpose and `job.finished` is what a panel clears the part on. Stated in
    // the event's own doc comment.
    const finished = seen.events.filter((event) => event.type === 'track.finished');
    expect(finished).toHaveLength(1);
    expect(types(seen.events).slice(-2)).toEqual(['track.started', 'job.finished']);
  });

  it('names the cancel that landed before the first part was written', async () => {
    // "after 0 of 3 parts" is reachable — a panel that aborts inside the
    // `chart.finished` callback lands exactly here — and reads as a count rather
    // than as a place.
    const fake = rig();
    const controller = new AbortController();

    const outcome = await runIrCompositionJob('a two-bar blues', {
      deps: fake.deps,
      signal: controller.signal,
      onProgress: (event) => {
        if (event.type === 'chart.finished') controller.abort();
      },
    });

    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.reason).toContain('before the first part was written');
    expect(outcome.reason).not.toContain('0 of 3');
    expect(fake.agents).toEqual(['arrangement-chart']);
  });

  it('stops after the last part rather than importing a document nobody wants', async () => {
    const fake = rig();
    const controller = new AbortController();

    const outcome = await runIrCompositionJob('a two-bar blues', {
      deps: fake.deps,
      signal: controller.signal,
      onProgress: (event) => {
        if (event.type === 'track.finished' && event.index === 3) controller.abort();
      },
    });

    expect(outcome).toMatchObject({ ok: false, stopped: 'cancelled' });
    expect(fake.documents).toHaveLength(0);
  });
});

// -------------------------------------------------------------- progress ---

describe('progress', () => {
  it('emits the phases in order, once each', async () => {
    const fake = rig();
    const seen = progress();

    await runIrCompositionJob('a two-bar blues', { deps: fake.deps, onProgress: seen.onProgress });

    expect(types(seen.events)).toEqual([
      'job.started',
      'chart.started',
      'chart.finished',
      'track.started',
      'track.finished',
      'track.started',
      'track.finished',
      'track.started',
      'track.finished',
      'import.started',
      'import.finished',
      'job.finished',
    ]);
  });

  it('numbers the parts 1-based, against a count the panel does not have to infer', async () => {
    const fake = rig();
    const seen = progress();

    await runIrCompositionJob('a two-bar blues', { deps: fake.deps, onProgress: seen.onProgress });

    const started = seen.events.filter((event) => event.type === 'track.started');
    expect(started.map((event) => (event.type === 'track.started' ? event.index : 0))).toEqual([
      1, 2, 3,
    ]);
    expect(started.every((event) => event.type === 'track.started' && event.count === 3)).toBe(true);
  });

  it('carries the job transcript id on the first event, before anything runs', async () => {
    const fake = rig();
    const seen = progress();

    await runIrCompositionJob('a two-bar blues', { deps: fake.deps, onProgress: seen.onProgress });

    const first = seen.events[0];
    if (first.type !== 'job.started') throw new Error('expected job.started first');
    expect(getTranscript(first.transcriptId)).toBeDefined();
  });

  it('ends with job.finished even when the job was refused', async () => {
    const fake = rig({ chart: dead('No provider is configured.') });
    const seen = progress();

    await runIrCompositionJob('a two-bar blues', { deps: fake.deps, onProgress: seen.onProgress });

    const last = seen.events[seen.events.length - 1];
    expect(last).toMatchObject({ type: 'job.finished', ok: false, stopped: 'chart-failed' });
  });

  it('survives a listener that throws', async () => {
    // A view's throw is not the job's problem — `runAgentTask` says the same.
    const fake = rig();

    const outcome = await runIrCompositionJob('a two-bar blues', {
      deps: fake.deps,
      onProgress: () => {
        throw new Error('the panel blew up');
      },
    });

    expect(outcome.ok).toBe(true);
  });
});

// ------------------------------------------------- the raw harness stream ---

describe('the runs\' own events', () => {
  it('relays every run\'s events to the caller, in the order they happened', async () => {
    const fake = rig();
    const seen: AgentEvent[] = [];

    await runIrCompositionJob('a two-bar blues', {
      deps: fake.deps,
      onEvent: (event) => seen.push(event),
    });

    // Four runs, two events each — and the chart's before any part's.
    expect(seen).toHaveLength(8);
    expect(seen.map((event) => event.type)).toEqual([
      'thinking',
      'model.call.finished',
      'thinking',
      'model.call.finished',
      'thinking',
      'model.call.finished',
      'thinking',
      'model.call.finished',
    ]);
    expect(seen[0]).toMatchObject({ type: 'thinking', text: 'arrangement-chart thought about it' });
    expect(seen[2]).toMatchObject({ type: 'thinking', text: 'ir-track thought about it' });
  });

  it('records them into the section of the run they belong to', async () => {
    // ⚠ THE ARTIFACT THE HEADER CALLS THE DIAGNOSTIC CHANNEL. Without this the
    // wrapper that records them could be deleted outright and every other test
    // in this file would still pass, while the exported log would hold no
    // reasoning, no iteration and no tool call for any run in the job.
    const fake = rig();

    const outcome = await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    if (!outcome.ok) throw new Error(`expected a finished job, got: ${outcome.reason}`);
    const sections = getTranscript(outcome.value.transcriptId)?.runs ?? [];
    expect(sections).toHaveLength(4);
    expect(sections[0].thinking).toEqual(['arrangement-chart thought about it']);
    expect(sections[1].thinking).toEqual(['ir-track thought about it']);
    expect(sections.every((section) => section.iterations.length === 1)).toBe(true);
  });

  it('logs FIRST, so a view that throws cannot cost the log an event', async () => {
    const fake = rig();

    const outcome = await runIrCompositionJob('a two-bar blues', {
      deps: fake.deps,
      onEvent: () => {
        throw new Error('the panel blew up');
      },
    });

    if (!outcome.ok) throw new Error(`expected a finished job, got: ${outcome.reason}`);
    const sections = getTranscript(outcome.value.transcriptId)?.runs ?? [];
    expect(sections).toHaveLength(4);
    expect(sections.every((section) => section.thinking.length === 1)).toBe(true);
  });
});

// ------------------------------------------------------------ a step that throws ---

describe('a step that throws', () => {
  it('reports a seam that threw as a job error rather than rejecting', async () => {
    const fake = rig();
    const seen = progress();

    const outcome = await runIrCompositionJob('a two-bar blues', {
      deps: {
        ...fake.deps,
        importDocument: () => {
          throw new Error('boom');
        },
      },
      onProgress: seen.onProgress,
    });

    expect(outcome).toMatchObject({ ok: false, stopped: 'job-error' });
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.reason).toContain('boom');
    expect(seen.events[seen.events.length - 1]).toMatchObject({
      type: 'job.finished',
      ok: false,
      stopped: 'job-error',
    });
    // Closed, not left open: an unfinished transcript reads in the buffer as a
    // job that is still running.
    expect(getTranscript(jobIdFrom(seen.events))?.finishedAt).toBeDefined();
  });

  it('closes the section of the run that threw, rather than filing it as a hang', async () => {
    // An unfinished section is this log format's signal for "the run hung here",
    // so a crash recorded as a hang is a wrong answer to the one question the
    // transcript is read to answer.
    const fake = rig({
      throwOn: (agent, count) =>
        agent === 'ir-track' && count === 2 ? new Error('the harness fell over') : undefined,
    });
    const seen = progress();

    const outcome = await runIrCompositionJob('a two-bar blues', {
      deps: fake.deps,
      onProgress: seen.onProgress,
    });

    expect(outcome).toMatchObject({ ok: false, stopped: 'job-error' });
    const sections = getTranscript(jobIdFrom(seen.events))?.runs ?? [];
    expect(sections).toHaveLength(3);
    expect(sections[2].finishedAt).toBeDefined();
    expect(sections[2].outcome?.error).toContain('the harness fell over');
  });
});

// ------------------------------------------------------------ transcript ---

describe('the transcript', () => {
  it('holds one section per run, in the order they ran', async () => {
    const fake = rig();

    const outcome = await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    if (!outcome.ok) throw new Error(`expected a finished job, got: ${outcome.reason}`);
    const job = getTranscript(outcome.value.transcriptId);
    expect(job?.runs?.map((run) => run.agent)).toEqual([
      'arrangement-chart',
      'ir-track',
      'ir-track',
      'ir-track',
    ]);
  });

  it('records what each run was actually given, prompt and input', async () => {
    const fake = rig();

    const outcome = await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    if (!outcome.ok) throw new Error(`expected a finished job, got: ${outcome.reason}`);
    const sections = getTranscript(outcome.value.transcriptId)?.runs ?? [];
    expect(sections[0].input).toBe('a two-bar blues');
    expect(sections[2].input).toContain('off-beat comping');
    expect(sections.every((section) => (section.systemPrompt ?? '').length > 0)).toBe(true);
  });

  it('names each section after the part it wrote', async () => {
    const fake = rig();

    const outcome = await runIrCompositionJob('a two-bar blues', {
      deps: fake.deps,
      label: 'Arrange',
    });

    if (!outcome.ok) throw new Error(`expected a finished job, got: ${outcome.reason}`);
    expect(getTranscript(outcome.value.transcriptId)?.runs?.map((run) => run.command)).toEqual([
      'Arrange — chart',
      'Arrange — Bass',
      'Arrange — Rhythm Guitar',
      'Arrange — Uke',
    ]);
  });

  it('keeps the sections of a job that stopped half way', async () => {
    // The whole reason the log is written live rather than assembled at the
    // end: the job that failed is the one somebody wants the log of.
    const fake = rig({
      track: (index) => (index === 2 ? dead('The endpoint is unreachable.') : answered({ events: EVENTS })),
    });
    const seen = progress();

    const outcome = await runIrCompositionJob('a two-bar blues', {
      deps: fake.deps,
      onProgress: seen.onProgress,
    });

    if (outcome.ok) throw new Error('expected a refusal');
    const job = getTranscript(jobIdFrom(seen.events));
    expect(job?.runs).toHaveLength(3);
    expect(job?.finishedAt).toBeDefined();
    expect(job?.outcome).toMatchObject({ stoppedReason: 'track-failed' });
  });

  it('leaves exactly one section when the chart itself was refused', async () => {
    // A chart naming an instrument this app has no neck for: `reviewChart`
    // refuses it, the track loop is never entered, and the log holds the chart
    // run and nothing else.
    const fake = rig({
      chart: answered({
        ...CHART,
        tracks: [{ name: 'Horns', instrumentId: 'trumpet', role: 'stabs' }],
      }),
    });
    const seen = progress();

    await runIrCompositionJob('a two-bar blues', { deps: fake.deps, onProgress: seen.onProgress });

    expect(getTranscript(jobIdFrom(seen.events))?.runs).toHaveLength(1);
    expect(fake.agents).toEqual(['arrangement-chart']);
  });

  it('opens no section for a part whose brief never reached a model', async () => {
    // ⚠ THE LOOP IS ENTERED HERE, unlike the case above. `reviewChart`
    // deliberately does not check a part's ROLE, so a chart with a blank one
    // passes review and `trackRunInput` refuses the brief — a part that got a
    // `track.started` and no run, and the honest record of it is a log with no
    // section for it.
    const fake = rig({
      chart: answered({
        ...CHART,
        tracks: [CHART.tracks[0], { name: 'Rhythm Guitar', instrumentId: 'guitar', role: '  ' }],
      }),
    });
    const seen = progress();

    const outcome = await runIrCompositionJob('a two-bar blues', {
      deps: fake.deps,
      onProgress: seen.onProgress,
    });

    expect(outcome).toMatchObject({ ok: false, stopped: 'track-failed' });
    // Two parts were STARTED; only one of them reached a model.
    expect(seen.events.filter((event) => event.type === 'track.started')).toHaveLength(2);
    expect(fake.agents).toEqual(['arrangement-chart', 'ir-track']);
    expect(getTranscript(jobIdFrom(seen.events))?.runs).toHaveLength(2);
  });

  it('puts the import\'s warnings in the log, not only on the returned value', async () => {
    // Silent clamps, dropped events and notes on strings the instrument hasn't
    // got are the pipeline's account of what it approximated — and the log is
    // the artifact that gets exported and pasted into a bug report.
    const fake = rig({
      imported: {
        ok: true,
        value: { ...IMPORTED, warnings: ['Dropped 3 notes that fell outside the range'] },
      },
    });

    const outcome = await runIrCompositionJob('a two-bar blues', { deps: fake.deps });

    if (!outcome.ok) throw new Error(`expected a finished job, got: ${outcome.reason}`);
    const content = getTranscript(outcome.value.transcriptId)?.outcome?.content ?? '';
    expect(content).toContain('Imported 3 patterns as composition.');
    expect(content).toContain('Dropped 3 notes that fell outside the range');
  });
});

// ------------------------------------------------------------- the defaults ---

describe('what ships', () => {
  it('defaults to the real seam and the real runner', () => {
    // ⚠ IDENTITY, not `toBeTypeOf('function')` — a test double is a function
    // too, so the shape assertion this replaces could not fail. A job
    // constructed without deps must run against the harness and the seam.
    expect(IR_COMPOSITION_JOB_DEPS.runTask).toBe(runAgentTask);
    expect(IR_COMPOSITION_JOB_DEPS.importDocument).toBe(importIR);
  });
});
