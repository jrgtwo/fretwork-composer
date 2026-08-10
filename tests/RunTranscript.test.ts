import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/ai/agentService';
import {
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
