import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/ai/agentService';
import {
  beginJobTranscript,
  beginTranscript,
  clearTranscripts,
  getTranscript,
  recentTranscripts,
  transcriptText,
} from '../src/ai/runTranscript';

/**
 * The transcript exists because two composition jobs were debugged from a
 * photograph of the panel, so what is asserted here is the thing those
 * photographs could not show: WHICH call, with WHAT arguments, got WHAT back.
 *
 * The events are hand-built rather than driven through `runAgentTask`, which
 * would need the harness and a provider. That is not a gap: the contract this
 * module has is with `AgentEvent`, and `AgentEvent` is what is fed in.
 */

const RUN = 'r1';

const meta = {
  page: 'composition' as const,
  command: 'Create a backing track',
  agent: 'composition',
  systemPrompt: '# How you work\n\nYou act only by calling tools.',
  input: 'Build a blues backing track in A minor at 80bpm.',
};

const requested = (callId: string, name: string, args: unknown): AgentEvent => ({
  type: 'tool.requested',
  runId: RUN,
  callId,
  name,
  args,
});

const finished = (callId: string, name: string, result: unknown, ms = 5): AgentEvent => ({
  type: 'tool.finished',
  runId: RUN,
  callId,
  name,
  ok: true,
  result,
  ms,
});

beforeEach(() => clearTranscripts());

describe('a recorded run', () => {
  it('keeps the arguments a screenshot could not show', () => {
    const transcript = beginTranscript(meta);
    transcript.record(
      requested('c1', 'pattern_delete_notes', { noteIds: ['ev_dead1', 'ev_dead2'] }),
    );
    transcript.record(
      finished('c1', 'pattern_delete_notes', { ok: false, reason: 'No such note.' }),
    );

    const call = getTranscript(transcript.id)?.calls[0];
    expect(call?.name).toBe('pattern_delete_notes');
    expect(call?.args).toEqual({ noteIds: ['ev_dead1', 'ev_dead2'] });
    expect(call?.result).toEqual({ ok: false, reason: 'No such note.' });
    expect(call?.ms).toBe(5);
  });

  it('pairs a result with its own call, not with the next one of the same name', () => {
    // Two calls to one tool, finishing in the opposite order — which is what
    // makes `callId` load-bearing rather than decorative.
    const transcript = beginTranscript(meta);
    transcript.record(requested('a', 'pattern_stamp_notes', { notes: ['first'] }));
    transcript.record(requested('b', 'pattern_stamp_notes', { notes: ['second'] }));
    transcript.record(finished('b', 'pattern_stamp_notes', { stamped: 'second' }));
    transcript.record(finished('a', 'pattern_stamp_notes', { stamped: 'first' }));

    const calls = getTranscript(transcript.id)?.calls ?? [];
    expect(calls.map((call) => call.seq)).toEqual([1, 2]);
    expect(calls[0]?.result).toEqual({ stamped: 'first' });
    expect(calls[1]?.result).toEqual({ stamped: 'second' });
  });

  it('shows which call a hung run is still inside', () => {
    // No `tool.finished`: the run is still in flight, or died in the handler.
    const transcript = beginTranscript(meta);
    transcript.record(requested('c1', 'read_composition', {}));
    transcript.record(requested('c2', 'composition_add_track', { name: 'Bass' }));
    transcript.record(finished('c1', 'read_composition', { tracks: [] }));

    const calls = getTranscript(transcript.id)?.calls ?? [];
    expect(calls[0]?.ok).toBe(true);
    expect(calls[1]?.ok).toBeUndefined();
    expect(calls[1]?.name).toBe('composition_add_track');
  });

  it('records the model iterations and the reasoning behind a call', () => {
    const transcript = beginTranscript(meta);
    transcript.record({ type: 'thinking', runId: RUN, text: 'The block is too short.' });
    transcript.record({
      type: 'model.call.finished',
      runId: RUN,
      iter: 1,
      finishReason: 'tool_calls',
      usage: { promptTokens: 900, completionTokens: 40, totalTokens: 940 },
    });

    const recorded = getTranscript(transcript.id);
    expect(recorded?.thinking).toEqual(['The block is too short.']);
    expect(recorded?.iterations).toEqual([
      { iter: 1, finishReason: 'tool_calls', usage: { promptTokens: 900, completionTokens: 40, totalTokens: 940 } },
    ]);
  });

  it('ignores an event type it does not record rather than storing it', () => {
    const transcript = beginTranscript(meta);
    transcript.record({ type: 'token', runId: RUN, text: 'streamed answer' });
    const recorded = getTranscript(transcript.id);
    expect(recorded?.calls).toHaveLength(0);
    expect(recorded?.thinking).toHaveLength(0);
  });
});

describe('closing a run', () => {
  it('keeps a run.error alongside the outcome the panel decided', () => {
    const transcript = beginTranscript(meta);
    transcript.record({ type: 'run.error', runId: RUN, error: 'provider refused' });
    transcript.finish({ stoppedReason: 'loop_break', rolledBack: true });

    const outcome = getTranscript(transcript.id)?.outcome;
    expect(outcome?.error).toBe('provider refused');
    expect(outcome?.stoppedReason).toBe('loop_break');
    expect(outcome?.rolledBack).toBe(true);
  });

  it('is recorded from the moment it starts, so a run that never finishes still has one', () => {
    const transcript = beginTranscript(meta);
    expect(getTranscript(transcript.id)?.finishedAt).toBeUndefined();
    expect(recentTranscripts()).toHaveLength(1);
  });
});

describe('the buffer', () => {
  it('keeps the five most recent runs, newest first', () => {
    const ids = Array.from({ length: 7 }, (_, index) =>
      beginTranscript({ ...meta, command: `run ${index}` }).id,
    );
    const kept = recentTranscripts();
    expect(kept).toHaveLength(5);
    expect(kept.map((run) => run.id)).toEqual([...ids].reverse().slice(0, 5));
  });

  it('stops recording calls past the ceiling and says how many it dropped', () => {
    const transcript = beginTranscript(meta);
    for (let index = 0; index < 405; index++) {
      transcript.record(requested(`c${index}`, 'read_composition', {}));
    }
    const recorded = getTranscript(transcript.id);
    expect(recorded?.calls).toHaveLength(400);
    // A truncated log that did not say so would read as a complete one.
    expect(recorded?.callsDropped).toBe(5);
  });

  it('evicts a FINISHED entry before one that is still recording', () => {
    // A job runs for minutes and is registered before its first run. Trimming it
    // out while it was still going would leave the panel holding an id that
    // resolves to nothing, and its later sections pushed onto an object nobody
    // can reach.
    const job = beginJobTranscript({
      page: 'composition',
      command: 'Arrange',
      agent: 'arrangement-job',
      input: 'a twelve-bar blues in C',
    });
    for (let index = 0; index < 6; index++) {
      beginTranscript({ ...meta, command: `run ${index}` }).finish({ stoppedReason: 'answered' });
    }

    expect(recentTranscripts()).toHaveLength(5);
    expect(getTranscript(job.id)).toBeDefined();
    // The cap is still HARD — the oldest finished one went, not nothing.
    expect(recentTranscripts().map((entry) => entry.command)).toContain('Arrange');
    expect(recentTranscripts().map((entry) => entry.command)).not.toContain('run 0');
  });

  it('still evicts when everything below the newest is unfinished', () => {
    const ids = Array.from({ length: 7 }, (_, index) =>
      beginTranscript({ ...meta, command: `run ${index}` }).id,
    );
    expect(recentTranscripts().map((run) => run.id)).toEqual([...ids].reverse().slice(0, 5));
  });
});

describe('handing it to somebody', () => {
  it('serialises to JSON carrying the arguments and the outcome', () => {
    const transcript = beginTranscript(meta);
    transcript.record(requested('c1', 'pattern_stamp_notes', { notes: [{ fret: 5 }] }));
    transcript.finish({ stoppedReason: 'answered' });

    const text = transcriptText(transcript.id);
    expect(JSON.parse(text)).toMatchObject({
      command: 'Create a backing track',
      agent: 'composition',
      calls: [{ seq: 1, name: 'pattern_stamp_notes', args: { notes: [{ fret: 5 }] } }],
      outcome: { stoppedReason: 'answered' },
    });
  });

  it('reports a value it cannot serialise instead of throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const transcript = beginTranscript(meta);
    transcript.record(requested('c1', 'pattern_stamp_notes', cyclic));

    expect(() => transcriptText(transcript.id)).not.toThrow();
    expect(transcriptText(transcript.id)).toContain('could not be serialised');
  });

  it('says so for an id that is no longer in the buffer', () => {
    expect(transcriptText('run-999')).toBe('No transcript for run-999.');
  });
});

/**
 * A JOB — several runs with different prompts and different inputs, building one
 * arrangement. `arrangementJob` records one of these per job: a plan run, then
 * one sub-run per pattern.
 *
 * What is asserted here is the thing the shape was chosen for: ONE id gives the
 * WHOLE job as ONE artifact. Handing somebody seven files is handing them
 * nothing, and every failure since 2026-08-09 was read out of a log like this.
 */
describe('a job of several runs', () => {
  const jobMeta = {
    page: 'composition' as const,
    command: 'Arrange',
    agent: 'arrangement-job',
    input: 'a twelve-bar blues in C',
  };

  it('holds each run with its own prompt and its own input', () => {
    const job = beginJobTranscript(jobMeta);
    const planRun = job.beginRun({
      command: 'Arrange — plan',
      agent: 'arrangement-plan',
      systemPrompt: '# What you are doing\n\nYou are PLANNING an arrangement.',
      input: 'the composition, then the ask',
    });
    planRun.finish({ stoppedReason: 'answered', content: '{"bars":12}' });

    const patternRun = job.beginRun({
      command: 'C7 Comp (C7)',
      agent: 'pattern-sub-run',
      systemPrompt: '# How you work\n\nYou act only by calling tools.',
      input: '# What to write\n\nWrite "C7 Comp": 2 bars of Guitar over C7.',
    });
    patternRun.record(requested('c1', 'pattern_stamp_notes', { notes: [{ fret: 3 }] }));
    patternRun.finish({ stoppedReason: 'answered' });
    job.finish({ stoppedReason: 'answered' });

    const recorded = getTranscript(job.id);
    expect(recorded?.runs?.map((run) => run.agent)).toEqual([
      'arrangement-plan',
      'pattern-sub-run',
    ]);
    // Different prompts and different inputs — the reason a job cannot be one
    // transcript with one of each, which is what `beginTranscript` records.
    expect(recorded?.runs?.[0]?.systemPrompt).toContain('PLANNING');
    expect(recorded?.runs?.[1]?.systemPrompt).toContain('calling tools');
    expect(recorded?.runs?.[0]?.input).toContain('the ask');
    expect(recorded?.runs?.[1]?.input).toContain('C7 Comp');
    // The calls are recorded onto the run that made them, not onto the job.
    expect(recorded?.runs?.[1]?.calls[0]?.args).toEqual({ notes: [{ fret: 3 }] });
    expect(recorded?.calls).toHaveLength(0);
    // A job has no standing instructions of its own — each run carries its own.
    expect(recorded?.systemPrompt).toBeUndefined();
    expect(recorded?.input).toBe('a twelve-bar blues in C');
  });

  it('exports as ONE artifact carrying every run', () => {
    const job = beginJobTranscript(jobMeta);
    job
      .beginRun({
        command: 'Arrange — plan',
        agent: 'arrangement-plan',
        systemPrompt: 'plan prompt',
        input: 'plan input',
      })
      .finish({ stoppedReason: 'answered' });
    const sub = job.beginRun({
      command: 'Walking Bass (F7)',
      agent: 'pattern-sub-run',
      systemPrompt: 'sub prompt',
      input: 'sub input',
    });
    sub.record(requested('c1', 'pattern_stamp_notes', { notes: ['walk'] }));
    sub.record(finished('c1', 'pattern_stamp_notes', { noteIds: ['ev_1'] }));
    job.finish({ stoppedReason: 'answered' });

    // ⚠ THE WHOLE JOB FROM THE ONE ID the Copy control is handed — no second
    // lookup, no stapling seven documents together.
    const text = transcriptText(job.id);
    expect(JSON.parse(text)).toMatchObject({
      command: 'Arrange',
      agent: 'arrangement-job',
      input: 'a twelve-bar blues in C',
      outcome: { stoppedReason: 'answered' },
      runs: [
        { agent: 'arrangement-plan', systemPrompt: 'plan prompt', input: 'plan input' },
        {
          agent: 'pattern-sub-run',
          input: 'sub input',
          calls: [{ seq: 1, name: 'pattern_stamp_notes', result: { noteIds: ['ev_1'] } }],
        },
      ],
    });
  });

  it('finds a run of a job by that run′s own id', () => {
    const job = beginJobTranscript(jobMeta);
    const sub = job.beginRun({
      command: 'C7 Comp (C7)',
      agent: 'pattern-sub-run',
      systemPrompt: 'sub prompt',
      input: 'sub input',
    });
    expect(getTranscript(sub.id)?.agent).toBe('pattern-sub-run');
    // And that section is not a top-level entry: the buffer holds jobs.
    expect(recentTranscripts().map((entry) => entry.id)).toEqual([job.id]);
  });

  it('counts as ONE entry in the buffer, however many runs it holds', () => {
    // Half a job's log answers nothing about the job, so the ring keeps jobs
    // rather than runs.
    const job = beginJobTranscript(jobMeta);
    for (let index = 0; index < 4; index++) {
      job.beginRun({
        command: `run ${index}`,
        agent: 'pattern-sub-run',
        systemPrompt: 'sub prompt',
        input: `input ${index}`,
      });
    }
    const single = beginTranscript(meta);
    expect(recentTranscripts().map((entry) => entry.id)).toEqual([single.id, job.id]);
    expect(getTranscript(job.id)?.runs).toHaveLength(4);
  });

  it('stops recording runs past the ceiling and says how many it dropped', () => {
    const job = beginJobTranscript(jobMeta);
    const recorders = Array.from({ length: 33 }, (_, index) =>
      job.beginRun({
        command: `run ${index}`,
        agent: 'pattern-sub-run',
        systemPrompt: 'sub prompt',
        input: `input ${index}`,
      }),
    );
    const recorded = getTranscript(job.id);
    expect(recorded?.runs).toHaveLength(32);
    // A truncated job that did not say so would read as a complete one.
    expect(recorded?.runsDropped).toBe(1);
    // The recorder past the ceiling still WORKS — a job runner never has to
    // check whether its diagnostics are still listening.
    expect(() =>
      recorders[32]?.record(requested('c1', 'pattern_stamp_notes', {})),
    ).not.toThrow();
  });

  it('spends ONE call budget across all its sections', () => {
    // A job is one ring entry, so a per-run cap alone would multiply the
    // buffer's worst case by the number of sections — and `transcriptText`
    // stringifies the whole entry onto the UI thread.
    const job = beginJobTranscript(jobMeta);
    const sections = Array.from({ length: 6 }, (_, index) =>
      job.beginRun({
        command: `run ${index}`,
        agent: 'pattern-sub-run',
        systemPrompt: 'sub prompt',
        input: `input ${index}`,
      }),
    );
    for (const section of sections) {
      for (let index = 0; index < 400; index++) {
        section.record(requested(`c${index}`, 'pattern_stamp_notes', {}));
      }
    }

    const recorded = getTranscript(job.id);
    // Five sections' worth of calls recorded, and the sixth section shut out by
    // the job's budget rather than by its own — which is what says the budget is
    // shared.
    expect(recorded?.runs?.slice(0, 5).map((run) => run.calls.length)).toEqual([
      400, 400, 400, 400, 400,
    ]);
    expect(recorded?.runs?.[5]?.calls).toHaveLength(0);
    expect(recorded?.runs?.[5]?.callsDropped).toBe(400);
  });

  it('leaves a single run exactly what it was — a job of one, with no sections', () => {
    // The panels both record single runs, and every artifact they have ever
    // produced has to keep its shape.
    const single = beginTranscript(meta);
    single.finish({ stoppedReason: 'answered' });
    const recorded = getTranscript(single.id);
    expect(recorded?.runs).toBeUndefined();
    expect(recorded?.runsDropped).toBeUndefined();
    expect(JSON.parse(transcriptText(single.id))).not.toHaveProperty('runs');
  });
});
