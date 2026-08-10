/**
 * What actually happened during an agent run, kept so it can be handed to
 * somebody.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Two composition jobs failed in a row and both were debugged from a phone
 * screenshot of the panel — a scroll-clipped list of tool NAMES. The arguments
 * that would have named the fourteen dead note ids, the results that would have
 * shown which call first went wrong, the model's own reasoning, the token spend:
 * all of it reached the app and was dropped on arrival.
 *
 * ⚠ NOTHING HERE IS NEW INSTRUMENTATION. Every field below is already on an
 * `AgentEvent` that `runAgentTask` hands to `onEvent` today. The panels listened
 * for `tool.started` and ignored the rest. This is the "rest".
 *
 * ── Why a module and not component state ────────────────────────────────────
 *
 * `CompositionPage` unmounts on every visit to the pattern page, and a run that
 * went wrong is exactly when somebody goes to look at what it did. A transcript
 * held in the panel would be destroyed by the navigation that follows every
 * failure. So this is module state, and it outlives the surface that recorded it.
 *
 * ── Deliberately NOT persisted ──────────────────────────────────────────────
 *
 * Memory only, and a short ring. A transcript carries every argument of every
 * call — a stamp of two hundred notes is a large object — and `localStorage` is
 * a 5 MB budget already holding the connector settings. The failure mode this
 * serves is "it just went wrong, get me the log", which is answered by a buffer
 * that survives a navigation, not by one that survives a reload.
 *
 * ⚠ A transcript is meant to be COPIED OUT and shared, so treat it as something
 * that leaves the machine: it carries the model's reasoning, every argument the
 * agent sent, and whatever text the provider returned on an error. It does not
 * carry the connector settings — no event does — but a provider's own error
 * message may name the base URL it was given.
 */
import type { AgentEvent } from './agentService';
import type { CommandPage } from './commandTypes';

/** How many runs are kept. Small on purpose: the question this answers is
 *  always about the run that just failed, and the one or two before it that
 *  failed the same way. */
const KEEP_RUNS = 5;

/** Per-run ceiling on recorded calls. A run that reaches this is already a
 *  runaway, and the transcript's job at that point is to show the shape of the
 *  loop rather than every repetition of it. Recorded in the transcript when it
 *  bites, so a truncated log never reads as a complete one. */
const MAX_CALLS = 400;

export interface TranscriptCall {
  /** 1-based position in the run, so a transcript read out of order still says
   *  what came before what. Matches the numbering the panel shows. */
  readonly seq: number;
  readonly name: string;
  /** Exactly what the model sent — the field the screenshots never had. */
  readonly args: unknown;
  /** Absent while the call is still in flight, which is how a transcript taken
   *  from a run that hung shows WHICH call it hung in. */
  readonly ok?: boolean;
  readonly result?: unknown;
  readonly error?: string;
  readonly ms?: number;
}

export interface TranscriptIteration {
  readonly iter: number;
  readonly finishReason: string;
  /** The harness reports token usage per model call; summing it is how a run's
   *  cost is known at all. Optional because a provider may not return it. */
  readonly usage?: unknown;
}

export interface RunTranscript {
  readonly id: string;
  readonly startedAt: number;
  readonly page: CommandPage;
  /** The command's label, and the agent spec that ran — which differ on the
   *  composition page's edit mode, where a pattern command runs the pattern
   *  agent. Both are recorded because "which agent was this?" is otherwise
   *  unanswerable from the log. */
  readonly command: string;
  readonly agent: string;
  /**
   * The agent's standing instructions, verbatim.
   *
   * Recorded because the question these logs are read to answer is usually "did
   * the rule I added last night actually change anything?" — and without the
   * prompt in the file, a log from a tab that was never reloaded is
   * indistinguishable from one that has the fix. Costs a few KB against a run
   * that is already carrying every argument of every call.
   */
  readonly systemPrompt: string;
  /** The filled template. The task the model was actually given, as opposed to
   *  the template the catalog holds. */
  readonly input: string;
  readonly calls: TranscriptCall[];
  readonly iterations: TranscriptIteration[];
  /** The model's own reasoning, when the provider emits it. This is the only
   *  record of WHY a tool was reached for. */
  readonly thinking: string[];
  /** Set when the harness compacted the context — a run that was truncated
   *  mid-way has a different explanation available than one that was not. */
  compactedAt?: number;
  callsDropped: number;
  finishedAt?: number;
  outcome?: {
    readonly stoppedReason?: string;
    readonly content?: string;
    readonly error?: string;
    /** Whether the panel put the document back, which is not visible from the
     *  event stream — it is the app's decision, made after the run returned. */
    readonly rolledBack?: boolean;
  };
}

export interface TranscriptRecorder {
  readonly id: string;
  /** Feed it every event. Unrecognised types are ignored rather than stored, so
   *  a harness that grows a new event does not silently bloat the buffer. */
  record(event: AgentEvent): void;
  finish(outcome: NonNullable<RunTranscript['outcome']>): void;
}

let runs: RunTranscript[] = [];
let nextId = 1;

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/** Subscribe to the buffer changing — for a control that has to appear when the
 *  first run of a session is recorded. */
export function subscribeTranscripts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Start recording. The returned recorder is fed from the panel's existing
 * `onEvent`, alongside whatever that callback already does.
 *
 * Never throws and never refuses: this is diagnostics, and a recorder that
 * could fail would be one more thing to reason about on the path that matters
 * most. A run is registered the moment it begins, so a run that hangs and is
 * never finished still has a transcript.
 */
export function beginTranscript(meta: {
  page: CommandPage;
  command: string;
  agent: string;
  systemPrompt: string;
  input: string;
}): TranscriptRecorder {
  const transcript: RunTranscript = {
    id: `run-${nextId++}`,
    startedAt: Date.now(),
    page: meta.page,
    command: meta.command,
    agent: meta.agent,
    systemPrompt: meta.systemPrompt,
    input: meta.input,
    calls: [],
    iterations: [],
    thinking: [],
    callsDropped: 0,
  };

  runs = [transcript, ...runs].slice(0, KEEP_RUNS);
  notify();

  // `callId` is the harness's own pairing of a request with its result. Keyed
  // rather than searched because a run makes hundreds of calls and the same
  // tool name recurs constantly — matching on name would attribute a result to
  // the wrong call the moment two of the same tool are in flight.
  const byCallId = new Map<string, TranscriptCall>();

  return {
    id: transcript.id,

    record(event) {
      switch (event.type) {
        case 'tool.requested': {
          if (transcript.calls.length >= MAX_CALLS) {
            transcript.callsDropped++;
            return;
          }
          const call: TranscriptCall = {
            seq: transcript.calls.length + 1,
            name: event.name,
            args: event.args,
          };
          transcript.calls.push(call);
          byCallId.set(event.callId, call);
          break;
        }
        case 'tool.finished': {
          const call = byCallId.get(event.callId);
          if (!call) return;
          // Mutated in place rather than replaced so `seq` and the array's order
          // hold: the finish order is not the request order once calls overlap.
          Object.assign(call, {
            ok: event.ok,
            result: event.result,
            error: event.error,
            ms: event.ms,
          });
          byCallId.delete(event.callId);
          break;
        }
        case 'model.call.finished':
          transcript.iterations.push({
            iter: event.iter,
            finishReason: event.finishReason,
            usage: event.usage,
          });
          break;
        case 'thinking':
          transcript.thinking.push(event.text);
          break;
        case 'context.compacted':
          transcript.compactedAt = transcript.calls.length;
          break;
        case 'run.error':
          transcript.outcome = { ...transcript.outcome, error: event.error };
          break;
        default:
          // `token` is skipped on purpose — it is the answer being streamed, and
          // the finished answer already arrives whole in `outcome.content`.
          break;
      }
      notify();
    },

    finish(outcome) {
      transcript.finishedAt = Date.now();
      // Merged, not replaced: `run.error` may already have recorded the reason,
      // and it is more specific than anything reconstructed after the fact.
      transcript.outcome = { ...transcript.outcome, ...outcome };
      notify();
    },
  };
}

/** Newest first. */
export function recentTranscripts(): readonly RunTranscript[] {
  return runs;
}

export function getTranscript(id: string): RunTranscript | undefined {
  return runs.find((run) => run.id === id);
}

/** For tests, and for a user who has copied one out and wants it gone. */
export function clearTranscripts(): void {
  runs = [];
  notify();
}

/**
 * A transcript as the text that gets pasted into a bug report.
 *
 * JSON, not prose: the point is that nothing is summarised away, and the reader
 * is as likely to be another agent as a person. `JSON.stringify` can throw on a
 * cyclic argument — nothing the tools take is cyclic, but the whole value of
 * this module is being available when something unexpected happened, so the
 * failure is caught and reported rather than allowed to take the panel down.
 */
export function transcriptText(id: string): string {
  const transcript = getTranscript(id);
  if (!transcript) return `No transcript for ${id}.`;
  try {
    return JSON.stringify(transcript, null, 2);
  } catch (error) {
    return `Transcript ${id} could not be serialised: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}
