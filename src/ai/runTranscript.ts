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
 * ⚠ THE CEILING IS COUNTED, and a JOB is where it could have got away: a job is
 * ONE ring entry holding many runs, so a per-run cap alone would have multiplied
 * the worst case by the number of sections. {@link MAX_CALLS_PER_JOB} is
 * therefore shared across a job's sections, and the buffer's bound is
 * {@link KEEP_RUNS} entries of at most that many recorded calls — five times two
 * thousand, whether those entries are jobs or single runs. `transcriptText`
 * stringifies one whole entry onto the UI thread and into the clipboard, so the
 * number is a size on a screen and not only a number in memory.
 *
 * ⚠ A transcript is meant to be COPIED OUT and shared, so treat it as something
 * that leaves the machine: it carries the model's reasoning, every argument the
 * agent sent, and whatever text the provider returned on an error. It does not
 * carry the connector settings — no event does — but a provider's own error
 * message may name the base URL it was given.
 *
 * ── A JOB IS A TRANSCRIPT WITH SECTIONS ─────────────────────────────────────
 *
 * A JOB is several runs building one thing — a different prompt and a different
 * input each time. Nothing in the app runs one today: the orchestrated
 * composition job that did was deleted on 2026-08-16 after three end-to-end runs
 * produced nothing, and the design replacing it will want these sections back.
 * ⚠ THE SECTIONS ARE KEPT DELIBERATELY, and they are why those three failures
 * were diagnosable at all — do not delete them for want of a caller.
 *
 * The shape chosen for a job is ONE transcript carrying its runs in
 * {@link RunTranscript.runs}, rather than N transcripts under a job id, and the
 * deciding question was the one thing this module is actually for: the Copy and
 * Download control takes ONE id and hands over ONE artifact. Seven files is not
 * a handover, and a job id that had to be expanded into seven lookups would put
 * that expansion in the control, in `transcriptText`, and in whatever reads it
 * next.
 *
 * So a job's id IS a transcript id: `getTranscript` finds it, `transcriptText`
 * serialises it, and the sections come with it — each with its own
 * `systemPrompt`, its own `input` and its own calls.
 *
 * ⚠ A SINGLE RUN IS A JOB OF ONE, and it stays exactly what it was: `runs` is
 * ABSENT on a transcript that {@link beginTranscript} started, so both panels,
 * the control and every existing artifact are byte-for-byte unchanged. A
 * transcript that HAS `runs` is a job; one that has not is a run. That is the
 * whole of the distinction, and it is why there are two entry points rather than
 * one with an empty section list.
 */
import type { AgentEvent } from './agentService';
import type { CommandPage } from './commandTypes';

/** How many runs are kept. Small on purpose: the question this answers is
 *  always about the run that just failed, and the one or two before it that
 *  failed the same way.
 *
 *  ⚠ COUNTED IN JOBS, not in runs — a job and its sections are one entry. Half a
 *  job's transcript answers nothing about the job, and the unit somebody asks
 *  about ("the arrangement it just built wrong") is the job. */
const KEEP_RUNS = 5;

/** Per-job ceiling on recorded sections, for {@link MAX_CALLS}' reason at the
 *  outer scale: a job's run count comes from the plan, and nothing caps how many
 *  patterns a plan may name. Recorded in `runsDropped` when it bites, so a
 *  truncated job never reads as a complete one. */
const MAX_RUNS_PER_JOB = 32;

/** Per-run ceiling on recorded calls. A run that reaches this is already a
 *  runaway, and the transcript's job at that point is to show the shape of the
 *  loop rather than every repetition of it. Recorded in the transcript when it
 *  bites, so a truncated log never reads as a complete one. */
const MAX_CALLS = 400;

/** The same ceiling one scale up: calls recorded across a WHOLE job, shared by
 *  its sections. Without it a job's bound would be {@link MAX_RUNS_PER_JOB}
 *  times {@link MAX_CALLS} — the buffer's worst case multiplied by 32 — and the
 *  one entry the Copy control stringifies would be the size of all of it.
 *  Charged where it is spent: the section that asks past the budget records the
 *  drop in its own `callsDropped`. */
const MAX_CALLS_PER_JOB = 2000;

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
   *
   * ⚠ ABSENT ON A JOB, and that is the honest answer rather than a gap: a job
   * has no standing instructions of its own, and each of its {@link runs}
   * carries the prompt that run was given. Always present on a run.
   */
  readonly systemPrompt?: string;
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
  /**
   * The runs this transcript is a JOB over, in the order they ran — each with
   * its own prompt, its own input and its own calls. ABSENT on a single run, so
   * `runs` in a transcript is what says which of the two it is; see the header.
   *
   * The property is readonly and the array is not: a section is pushed as the
   * job reaches it, and a job that dies half way still has the sections it got
   * through — which is the whole reason this is recorded live rather than
   * assembled at the end.
   */
  readonly runs?: RunTranscript[];
  /** Sections past {@link MAX_RUNS_PER_JOB}. Jobs only. */
  runsDropped?: number;
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

/**
 * A job's recorder: the same two verbs, plus the one a job has that a run does
 * not — {@link beginRun}, which opens a section.
 *
 * Deliberately NOT a `TranscriptRecorder`. A job has no event stream of its own
 * — every event belongs to one of its runs — and a `record` that quietly filed
 * events at job level would be the place they went to be lost.
 */
export interface JobTranscriptRecorder {
  readonly id: string;
  /**
   * Start a section, with the prompt and input THIS run was given. Sections are
   * kept in the order they were begun, which is the order a job runs them in.
   */
  beginRun(meta: {
    command: string;
    agent: string;
    systemPrompt: string;
    input: string;
  }): TranscriptRecorder;
  finish(outcome: NonNullable<RunTranscript['outcome']>): void;
}

/** The ring. Top-level entries only: a job is one entry and its sections live
 *  inside it. */
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
  const transcript = blank(meta);
  admit(transcript);
  notify();
  return recorderFor(transcript);
}

/**
 * Put an entry in the ring, evicting down to {@link KEEP_RUNS}.
 *
 * ⚠ THE OLDEST *FINISHED* ENTRY GOES FIRST, not simply the oldest. A job runs
 * for minutes and is registered before its first run, so a plain
 * `slice(0, KEEP_RUNS)` could evict a job WHILE IT WAS STILL RECORDING — after
 * which the transcript id its panel is holding resolves to nothing and its
 * remaining sections are pushed onto an object nobody can reach. A finished
 * entry losing its place is the cost this buffer was always willing to pay; an
 * unfinished one losing its place is the log going missing exactly when it is
 * being written. The cap is still HARD: if everything below the newest is
 * unfinished, the oldest goes anyway.
 */
function admit(entry: RunTranscript): void {
  // A new array rather than a splice in place, so anything holding the old one
  // (`recentTranscripts`) sees a changed identity.
  const next = [entry, ...runs];
  while (next.length > KEEP_RUNS) {
    let evict = next.length - 1;
    for (let index = next.length - 1; index > 0; index -= 1) {
      if (next[index]?.finishedAt !== undefined) {
        evict = index;
        break;
      }
    }
    next.splice(evict, 1);
  }
  runs = next;
}

/**
 * Start recording a JOB — several runs, one artifact. The job is registered the
 * moment it begins, for {@link beginTranscript}'s reason: the log of a job that
 * hung is wanted while it is still hanging, and the panel is handed this id
 * before the first run starts.
 *
 * `input` is the JOB's input — what the user asked the whole job for. Each run's
 * own input goes on its section, because a job's runs are handed briefs that the
 * request cannot be reconstructed from and vice versa.
 *
 * Never throws and never refuses, exactly like the single-run entry point: a job
 * runner must not have to account for its diagnostics failing.
 */
export function beginJobTranscript(meta: {
  page: CommandPage;
  command: string;
  agent: string;
  input: string;
}): JobTranscriptRecorder {
  // `runs: []` is what MAKES this a job — see the header. A section is pushed
  // into it per run; the array is never replaced.
  const job: RunTranscript = { ...blank(meta), runs: [], runsDropped: 0 };
  admit(job);
  notify();

  // ONE budget for the whole job, closed over by every section's recorder — see
  // {@link MAX_CALLS_PER_JOB}.
  const budget = { left: MAX_CALLS_PER_JOB };

  return {
    id: job.id,

    beginRun(runMeta) {
      const section = blank({ ...runMeta, page: job.page });
      // Past the ceiling the recorder still WORKS — it records into a section
      // nothing holds — so a job runner never has to check whether its
      // diagnostics are still listening. What is lost is the section, and
      // `runsDropped` is what says so.
      if ((job.runs?.length ?? 0) >= MAX_RUNS_PER_JOB) {
        job.runsDropped = (job.runsDropped ?? 0) + 1;
        notify();
        return recorderFor(section, budget);
      }
      job.runs?.push(section);
      notify();
      return recorderFor(section, budget);
    },

    finish(outcome) {
      job.finishedAt = Date.now();
      job.outcome = { ...job.outcome, ...outcome };
      notify();
    },
  };
}

/** An empty record. The id counter is shared by jobs and runs, so no id in the
 *  buffer is ever ambiguous about which it names. */
function blank(meta: {
  page: CommandPage;
  command: string;
  agent: string;
  systemPrompt?: string;
  input: string;
}): RunTranscript {
  return {
    id: `run-${nextId++}`,
    startedAt: Date.now(),
    page: meta.page,
    command: meta.command,
    agent: meta.agent,
    // Spread rather than assigned, so a job carries no `systemPrompt` key at all
    // rather than an empty one that would read as "the prompt was blank".
    ...(meta.systemPrompt === undefined ? {} : { systemPrompt: meta.systemPrompt }),
    input: meta.input,
    calls: [],
    iterations: [],
    thinking: [],
    callsDropped: 0,
  };
}

/** The event sink for ONE transcript — a single run's, or one section of a job's.
 *  Identical either way: a section IS a run, save that a section also spends its
 *  job's shared call budget. */
function recorderFor(transcript: RunTranscript, budget?: { left: number }): TranscriptRecorder {
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
          // Either ceiling: this run's own, or what is left of the job's.
          if (transcript.calls.length >= MAX_CALLS || (budget !== undefined && budget.left <= 0)) {
            transcript.callsDropped++;
            return;
          }
          if (budget !== undefined) budget.left -= 1;
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

/** Newest first. A job is ONE entry, with its runs inside it. */
export function recentTranscripts(): readonly RunTranscript[] {
  return runs;
}

/**
 * By id — a single run, a whole job, or one section of a job.
 *
 * The sections are searched too, so an id from a job's own progress report
 * resolves to the run it names. A JOB id resolves to the job, which is what the
 * Copy control has to be handed: the artifact it produces then carries every
 * section. See the header on why that is one record and not seven.
 */
export function getTranscript(id: string): RunTranscript | undefined {
  const top = runs.find((run) => run.id === id);
  if (top) return top;
  for (const job of runs) {
    const section = job.runs?.find((run) => run.id === id);
    if (section) return section;
  }
  return undefined;
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
 *
 * ⚠ A JOB ID GIVES THE WHOLE JOB, in this one string: the sections nest inside
 * the record, so nothing here had to learn about jobs at all. That is what the
 * shape was chosen for — the alternative was this function taking a list of ids
 * and inventing a way to staple seven documents together.
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
