import { useEffect, useRef, useState } from 'react';
import { commandsForPage } from './commandCatalog';
import { COMMAND_BUTTON, SlotFields } from './commandSlots';
import { defaultValues, fillForNow } from './slotSources';
import type { Command, SlotValue } from './commandTypes';
import { COMPOSITION_AGENT, COMPOSITION_WRITE_TOOLS } from './compositionAgent';
import { PATTERN_AGENT, PATTERN_WRITE_TOOLS } from './patternAgent';
import { runAgentTask, type AgentEvent, type AgentSpec } from './agentService';
import { beginTranscript } from './runTranscript';
import { RunTranscriptControl } from './RunTranscriptControl';
import { isConfigured } from './connectorSettings';
import { useConnectorSettings } from './connectorView';
import {
  abortEditGesture,
  beginJob,
  endJob,
  beginEditGesture as beginCompositionGesture,
  endEditGesture as endCompositionGesture,
  useEditingComposition,
  useEditingPlacementId,
} from '../composition/compositionService';
import {
  beginEditGesture as beginPatternGesture,
  endEditGesture as endPatternGesture,
  useEditingPattern,
} from '../patterns/patternService';
import type { ArrangementMode } from '../composition/arrangementMath';

/**
 * The composition page's command panel — a generation JOB, not an edit (AG-07).
 *
 * Its slot half is `./commandSlots`, shared with the pattern page's panel. Its
 * run half is here and is deliberately not shared, because every one of the five
 * things a run does differs: which agent drives it, which seam's history it
 * brackets, whether the document is LOCKED for the duration, whether a failure
 * ROLLS BACK, and how long it is allowed to take. See `commandSlots`' header.
 *
 * ── ONE PANEL, THREE MODES, AND THE RUN READS NONE OF THEM ──────────────────
 *
 * `mode` decides the LIST — pattern and voice mode offer the composition page's
 * rows, edit mode offers the pattern page's six, because
 * `openPlacementForEditing` aims the lib's single pattern-editing pointer at the
 * block and `patternService` routes writes to that placement's snapshot (see
 * `Command.mode`). Nothing else here looks at it.
 *
 * The run's progress, its tool trace, its Cancel button and its outcome
 * therefore live OUTSIDE the selected-command block, and survive a mode change
 * untouched — rendering them inside the form would take them with the list,
 * since `selected` is looked up in the mode's own array. The run also names the
 * command it is running, because after a mode switch the form that started it
 * may not be on screen.
 *
 * ⚠ MID-RUN, THAT IS DEFENCE AND NOT THE LIVE PATH, and an earlier draft of this
 * note overstated it. `CompositionPage` disables the mode bar for the duration
 * of a job (`useIsJobRunning`) and `mode` reaches this panel from nowhere else,
 * so a mode change WHILE a run is in flight is currently unreachable in the app;
 * the disable is what protects edit mode's pointer, and it is the stronger of
 * the two guards. What is reachable, and what this structure buys today, is the
 * FINISHED run: its outcome, its refusals and its tool trace stay on screen
 * after the lock is released and the user goes to look at what was built. The
 * hazard the ticket names — a control vanishing out from under the user — is
 * covered by `select` below, which is the reachable version of it: choosing
 * another command mid-run must not take Cancel with it.
 *
 * ── THE JOB LOCK, AND WHY IT WRAPS EVERY RUN ────────────────────────────────
 *
 * `beginJob()` takes the document: the user's writes are refused at the seam for
 * the duration and the agent's go through (`compositionService`). That is
 * data-loss prevention rather than tidiness — a rollback restores the whole
 * composition, so anything the user edited while they waited would be rolled
 * back WITH it.
 *
 * It is taken for EDIT-MODE runs too, which act on the pattern seam and would
 * not otherwise need it. The reason is the mode bar: `CompositionPage` closes an
 * open placement on every mode change, and a switch mid-run would repoint the
 * lib's one pattern pointer out from under the agent and land its next notes in
 * the user's LIBRARY pattern — which no rollback here restores. The lock is what
 * disables that bar (`useIsJobRunning`), so an edit-mode run needs it most.
 *
 * ⚠ BOTH BRACKETS CLOSE IN A `finally`, ON EVERY PATH. A leaked gesture wedges
 * undo for the session — a defect that has shipped in this project before — and
 * a leaked LOCK is worse: the page stays read-only until it is reloaded.
 */

/**
 * Model round trips per run.
 *
 * The harness default is 8 and the pattern page allows 12. Forty was sized when
 * a backing track was three or four patterns; the standing rules now correctly
 * say ONE PATTERN PER CHORD, so the same job is a dozen patterns — open, stamp,
 * place, three calls each — plus the read, the tracks, the settings, the chord
 * lookup and an answer at the end: thirty to fifty. A run on 2026-08-11 did the
 * job RIGHT and hit forty exactly, so the ceiling was binding on the behaviour
 * we ask for. Sixty leaves room for a handful of recoveries on top of that
 * without leaving a run that will plainly never finish running for an hour.
 *
 * Running out of them mid-arrangement is not a partial success, and it is one of
 * the things the rollback below exists to catch.
 */
const MAX_ITERS = 60;

/** How long one round trip is allowed to take, on average, before the wall
 *  clock rather than the step budget is what ends the run. Measured, not
 *  chosen: on the local llama-server this design targets, a single round trip
 *  with the whole tool set in the prompt is tens of seconds. */
const SECONDS_PER_ITER = 15;

/**
 * Outer bound on the wall clock of a single run.
 *
 * Sized for the job and not for the command. AG-06 allows 180 s, which is right
 * for one read and one batched write; a backing track is a pattern per chord,
 * each authored, stamped and placed.
 *
 * ⚠ DERIVED, so the two bounds cannot drift apart. It is {@link MAX_ITERS}
 * counted the other way: leaving this behind a raised step budget would make the
 * wall clock bind first and the extra steps unreachable, which is the failure
 * the budget was raised to fix — and writing the product out as a literal is how
 * that happens, because the next person to move the budget updates the number
 * and not the arithmetic.
 *
 * It is a CEILING, not a budget: an edit-mode run started from this panel gets
 * the same one and finishes in seconds. What the deadline actually bounds is how
 * long a dead provider can hold the document lock while the user waits, and
 * Cancel is mounted the whole time for anyone unwilling to wait that long.
 */
const RUN_TIMEOUT_MS = MAX_ITERS * SECONDS_PER_ITER * 1_000;

type RunView =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running';
      readonly command: string;
      readonly tools: readonly string[];
      readonly refusals: readonly string[];
      readonly transcriptId?: string;
    }
  | {
      readonly kind: 'answered';
      readonly command: string;
      readonly tools: readonly string[];
      readonly refusals: readonly string[];
      readonly content: string;
      readonly stoppedReason: string;
      readonly rolledBack: boolean;
      readonly keptPatterns: boolean;
      readonly transcriptId?: string;
    }
  /** Everything that came back `{ok:false}`, plus the three the panel decides
   *  itself: a slot that no longer fills, a job it could not take, and the
   *  deadline above. */
  | {
      readonly kind: 'refused';
      readonly command: string;
      readonly tools: readonly string[];
      readonly refusals: readonly string[];
      readonly reason: string;
      readonly rolledBack: boolean;
      readonly keptPatterns: boolean;
      /** Absent on the refusals decided BEFORE a run exists — there is no
       *  transcript of a run that never started. */
      readonly transcriptId?: string;
    };

/** A tool that returned `{ok:false, reason}` — a refusal the model was handed and
 *  may or may not have acted on. `tool.finished` carries the tool's own result,
 *  and `ok` on the EVENT means the handler did not throw, which a refusal does
 *  not. Hence the shape test rather than reading `event.ok`. */
function refusalIn(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const shape = result as { ok?: unknown; reason?: unknown };
  return shape.ok === false && typeof shape.reason === 'string' ? shape.reason : null;
}

/** The two refusals the panel decides before a run exists — a slot that no
 *  longer fills and a job it could not take. Neither has tools to report and
 *  neither wrote anything, so neither can have been rolled back. */
const refusal = (command: string, reason: string): RunView => ({
  kind: 'refused',
  command,
  tools: [],
  refusals: [],
  reason,
  rolledBack: false,
  keptPatterns: false,
});

/**
 * Edit mode's rows: the pattern page's, less the ones that open a DIFFERENT
 * document.
 *
 * `pattern-generate` reads "Open a blank pattern, set its instrument, then stamp
 * the notes", and `openPatternForEditing` nulls `editingPlacementId` — so run
 * against a block it repoints the lib's one pattern pointer out of the block and
 * every later stamp lands in a library pattern nobody is looking at. Dropped
 * here so it is not OFFERED; `pattern_open_blank` refuses for itself while a
 * block is open, because `Command.tools` is not enforcement and a model is free
 * to reach for it from any of the other five.
 *
 * A module constant, not a filter per render: `commandsForPage` returns frozen
 * per-page arrays precisely so the list keeps its identity, and a fresh array
 * here would throw that away again.
 */
const EDIT_MODE_COMMANDS: readonly Command[] = commandsForPage('pattern').filter(
  (command) => !command.tools.includes('pattern_open_blank'),
);

export function CompositionCommandPanel({ mode }: { mode: ArrangementMode }) {
  // Edit mode is served by the PATTERN page's rows, acting on the placement the
  // lib's editing pointer is aimed at. `page` picks the agent, the tools and the
  // history; `mode` only picks what is offered — see `Command.mode`.
  const commands = mode === 'edit' ? EDIT_MODE_COMMANDS : commandsForPage('composition', mode);

  /**
   * ⚠ EDIT MODE IS NOT THE SAME AS A BLOCK BEING OPEN. Entering the mode only
   * ever CLOSES a placement (`CompositionPage`'s mode effect); one opens when a
   * lane is pressed. With none open, `patternService.writePatternBack` falls
   * through to its LIBRARY branch — so the six rows would run against whatever
   * pattern the pattern page left open, off-screen, covered by neither the
   * composition rollback nor the job lock. So they are not offered at all.
   */
  const editingPlacementId = useEditingPlacementId();
  const noBlockOpen = mode === 'edit' && editingPlacementId === null;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [values, setValues] = useState<Readonly<Record<string, SlotValue>>>({});
  const [run, setRun] = useState<RunView>({ kind: 'idle' });

  /** The run in flight, if any. Doubles as the re-entrancy guard, so the Run
   *  button never has to be `disabled` — disabling it under the pointer drops
   *  focus to `<body>`, which is the trap the connector dialog goes out of its
   *  way to avoid. */
  const inFlightRef = useRef<AbortController | null>(null);
  const liveRef = useRef(true);

  const configured = isConfigured(useConnectorSettings());

  // Both subscriptions are deliberately unused values. Every choice slot's
  // DEFAULT is read off live state — the composition's key, tempo and length and
  // its track list for the composition rows, the open pattern's key and groove
  // for the edit-mode ones — so a panel that did not re-render when either
  // changed would open a command on a track that has since been renamed, or on
  // the last pattern's key.
  useEditingComposition();
  useEditingPattern();

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      // A run holds the document lock and an open gesture, so an orphaned one is
      // cancelled rather than left to finish into a component that is gone. Both
      // brackets still close: the `finally` below is not React's to unmount, and
      // with the rollback it now leaves the composition as it was rather than
      // half-built.
      inFlightRef.current?.abort();
      // The belt to that brace, and the ONE bracket worth a second release: the
      // `finally` runs only if the harness settles its promise, and a run that
      // never comes back would leave the whole page read-only until the tab is
      // reloaded. `endJob` is idempotent and the `finally`'s `release` is gated
      // on still being the holder, so the pair cannot fight. The GESTURE has no
      // equivalent — closing it here would either push a step for work the run
      // is still doing or roll back underneath it — so it stays the `finally`'s.
      endJob();
    };
  }, []);

  const selected = commands.find((command) => command.id === selectedId) ?? null;

  const select = (command: Command) => {
    setSelectedId(command.id);
    // Seeded from live state, and only here. Re-seeding on every render would
    // undo the user's own choices between opening a command and running it.
    setValues(defaultValues(command));
    // ⚠ ONLY WHEN NOTHING IS IN FLIGHT. Clearing this unconditionally is the
    // reachable version of the failure the header names: `running` is derived
    // from `run.kind`, so one click on another row would disable Cancel while
    // the job still held the document — the mode bar dead, undo inert, every
    // user write refused, and nothing on screen saying why or offering a way
    // out. Reading the ref rather than `run.kind` because it is the run itself,
    // not the report about it, that decides.
    //
    // Deliberately NOT reset by a mode change either — only by choosing another
    // command. See the header: the run outlives the list it was started from.
    if (!inFlightRef.current) setRun({ kind: 'idle' });
  };

  const setValue = (id: string, value: SlotValue) =>
    setValues((was) => ({ ...was, [id]: value }));

  const cancel = () => inFlightRef.current?.abort();

  const start = () => {
    // Guarded here rather than with `disabled` — see `inFlightRef`.
    if (inFlightRef.current || !selected) return;
    const command = selected;
    const label = command.label;

    // `fillForNow`, never `fillCommand`: the one-argument form has the live
    // allow-list composed in, so a slot holding something the app no longer
    // offers is refused here instead of being spent on a dead id by the model.
    const filled = fillForNow(command, values);
    if (!filled.ok) {
      setRun(refusal(label, filled.reason));
      return;
    }

    // Before the lock, deliberately. `runAgentTask` refuses an unconfigured
    // provider itself, but not until after this panel has taken the document,
    // opened a bracket and run the whole rollback path over a run that never
    // existed — which is a page that flickers read-only for the app's own
    // default state. Same sentence the seam would have answered with.
    if (!configured) {
      setRun(
        refusal(
          label,
          'No provider is configured. Open Connector and set the base URL of an OpenAI-compatible endpoint.',
        ),
      );
      return;
    }

    /**
     * `page` decides everything the run does with history.
     *
     * A composition row drives `COMPOSITION_AGENT` and brackets the COMPOSITION
     * seam, whose `abortEditGesture` can put the whole document back. An
     * edit-mode row drives `PATTERN_AGENT` and brackets the PATTERN seam, which
     * has no such thing and needs none — see the rollback note below.
     */
    const onComposition = command.page === 'composition';
    const agent: AgentSpec = onComposition ? COMPOSITION_AGENT : PATTERN_AGENT;
    const writeTools = onComposition ? COMPOSITION_WRITE_TOOLS : PATTERN_WRITE_TOOLS;

    // THE LOCK IS TAKEN FIRST, before the gesture, so a refused job leaves no
    // bracket open. The seam documents the opposite order; both work, because
    // nothing writes in between, and this one has no failure path that has to
    // remember to close something it just opened.
    const job = beginJob();
    if (!job.ok) {
      setRun(refusal(label, job.reason));
      return;
    }
    // `endJob` gated on still being the holder — a run that was refused the job
    // cannot release the one that got it.
    const release = job.value;

    const controller = new AbortController();
    inFlightRef.current = controller;
    let timedOut = false;
    const deadline = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, RUN_TIMEOUT_MS);

    // Live progress, which is the one thing `AgentRunSummary` cannot give: it
    // arrives only when the run is over. The finished list still comes from the
    // summary — HARNESS-GAP(1)'s reconstruction stays in the seam and is not
    // repeated here.
    const started: string[] = [];
    /**
     * Refusals the TOOLS returned, deduplicated, in the order they first
     * happened.
     *
     * This is where the track cap surfaces. `composition_add_track` refuses at
     * `MAX_COMPOSITION_TRACKS` with `TRACK_CAP_REASON` and hands the sentence to
     * the model, which is free to write a confident summary that never mentions
     * it — "a silent stop" from where the user sits. Collected generically
     * rather than pattern-matched on the cap, because every seam refusal has the
     * same claim on being seen.
     */
    const refusals: string[] = [];
    /**
     * Whether anything that can WRITE actually ran.
     *
     * `tool.started` and not `tool.finished`: the harness emits `started` only
     * after schema validation passes, and a handler that throws mid-batch has
     * already written. Reads are excluded because every command opens with one.
     *
     * A write tool that ran and refused end to end counts as a write here. That
     * is the deliberate side of the trade — the opposite mistake, deciding
     * "nothing changed" about a run that did, costs the user the ability to undo
     * the agent at all.
     */
    let wrote = false;
    /**
     * Whether the run wrote to the PATTERN library — which the rollback does not
     * reach.
     *
     * A composition job mints patterns (`pattern_open_blank` is in three of the
     * seven commands' tool lists) and those live in the other seam's history, so
     * a cancel leaves them behind. The report says so rather than promising a
     * restore it did not perform; the prefix is enough because every
     * `pattern_*` tool is a write and the pattern READ is `read_pattern`.
     */
    let wrotePatterns = false;

    /**
     * The full record of the run, for handing to somebody else.
     *
     * Everything below this line already reaches `onEvent` and was being dropped
     * — the arguments, the results, the model's reasoning, the token spend. Two
     * jobs in a row were debugged from a photograph of this panel because of it.
     * `beginTranscript` never throws and never refuses, so nothing on the run
     * path has to account for it failing.
     */
    const transcript = beginTranscript({
      page: command.page,
      command: label,
      agent: agent.name,
      systemPrompt: agent.systemPrompt,
      input: filled.value,
    });

    setRun({
      kind: 'running',
      command: label,
      tools: [],
      refusals: [],
      transcriptId: transcript.id,
    });

    void (async () => {
      /** Did the loop finish of its own accord, having been asked to? Anything
       *  else is an incomplete arrangement — see the rollback below. */
      let completed = false;
      /**
       * What to close the transcript with, filled at whichever exit is taken and
       * written once in the `finally`.
       *
       * There rather than beside each `setRun` because one of the exits below
       * returns WITHOUT calling `setRun` — the unmounted case — and that is
       * precisely the run somebody will want the log of: the panel went away
       * mid-job and rolled the arrangement back.
       */
      let outcome: { stoppedReason?: string; content?: string; error?: string } = {};

      try {
        // Inside the `try` whose `finally` closes it, so a throw between here
        // and the run cannot leak the bracket. Safe because both closers are
        // no-ops at depth 0 — a `finally` that closes a bracket nobody opened
        // does nothing at all.
        if (onComposition) beginCompositionGesture();
        else beginPatternGesture();


        const result = await runAgentTask(agent, filled.value, {
          signal: controller.signal,
          maxIters: MAX_ITERS,
          onEvent: (event: AgentEvent) => {
            // First, and unconditionally: the transcript wants every event,
            // including the ones the progress view below returns early on.
            transcript.record(event);
            if (event.type === 'tool.started') {
              started.push(event.name);
              if (writeTools.has(event.name)) {
                wrote = true;
                if (event.name.startsWith('pattern_')) wrotePatterns = true;
              }
            } else if (event.type === 'tool.finished') {
              const reason = refusalIn(event.result);
              if (reason !== null && !refusals.includes(reason)) refusals.push(reason);
            } else {
              return;
            }
            if (liveRef.current) {
              setRun({
                kind: 'running',
                command: label,
                tools: [...started],
                refusals: [...refusals],
              });
            }
          },
        });

        completed = result.ok && !timedOut && result.value.stoppedReason === 'answered';
        const rolledBack = onComposition && !completed && wrote;
        // Only worth saying alongside a rollback: on a run that KEPT its work
        // there is nothing surprising about the patterns it wrote still being
        // there.
        const keptPatterns = rolledBack && wrotePatterns;

        outcome = result.ok
          ? { stoppedReason: result.value.stoppedReason, content: result.value.content }
          : { error: result.reason };

        if (!liveRef.current) return;
        if (!result.ok) {
          setRun({
            kind: 'refused',
            command: label,
            tools: started,
            refusals,
            reason: result.reason,
            rolledBack,
            keptPatterns,
            transcriptId: transcript.id,
          });
          return;
        }
        // An abort comes back as a SUCCESS with `stoppedReason: 'aborted'`,
        // which read plainly says the user cancelled. Nobody cancelled a run the
        // deadline killed, and saying so is the whole point of having one.
        if (timedOut) {
          setRun({
            kind: 'refused',
            command: label,
            tools: started,
            refusals,
            reason: `Gave up after ${RUN_TIMEOUT_MS / 60_000} minutes — the provider never finished.`,
            rolledBack,
            keptPatterns,
            transcriptId: transcript.id,
          });
          return;
        }
        setRun({
          kind: 'answered',
          command: label,
          tools: result.value.toolCalls,
          refusals,
          content: result.value.content,
          stoppedReason: result.value.stoppedReason,
          rolledBack,
          keptPatterns,
          transcriptId: transcript.id,
        });
      } catch (error) {
        // `runAgentTask` returns its failures rather than throwing, so arriving
        // here is a defect in this app — but both brackets below must close all
        // the same, and the panel must not be left saying "Running…" forever.
        const message = error instanceof Error ? error.message : String(error);
        outcome = { error: message };
        if (liveRef.current) {
          setRun({
            kind: 'refused',
            command: label,
            tools: started,
            refusals,
            reason: `The agent run could not complete: ${message}`,
            rolledBack: onComposition && wrote,
            keptPatterns: onComposition && wrote && wrotePatterns,
            transcriptId: transcript.id,
          });
        }
      } finally {
        // ── EVERY PATH OUT, IN THIS ORDER ───────────────────────────────────
        // The lock goes back first: the rollback writes the composition, and
        // the seam's own writes are not what the lock is holding out.
        release();

        // Closed here rather than beside each `setRun`, so the exits that never
        // reach one — an unmount mid-run, above all — still leave a complete log.
        transcript.finish({
          ...outcome,
          rolledBack: onComposition && !completed && wrote,
        });

        if (!onComposition) {
          // AG-06's behaviour, kept deliberately for edit-mode rows: NO
          // ROLLBACK. A pattern command is a handful of calls over seconds and
          // its partial work is one undo press, which the panel says out loud;
          // `patternService` has no `abortEditGesture` and does not need one.
          endPatternGesture(wrote);
        } else if (completed) {
          // No argument on purpose: the seam's default is a reference test
          // against the composition it snapshotted, which is a better answer
          // than anything reconstructed from an event stream — a run whose every
          // write was refused wrote nothing, and pushes nothing.
          endCompositionGesture();
        } else {
          /**
           * ⚠ THE ROLLBACK, AND IT IS A DELIBERATE DIVERGENCE FROM AG-06.
           *
           * A pattern command's partial work is one undo press. A composition
           * job is dozens of calls over minutes — tracks added, patterns minted,
           * blocks placed — and half of that is not a partial success, it is a
           * mess the user has to dismantle by hand. The ticket's acceptance
           * criterion is that after a cancel "the composition is as it was", and
           * `abortEditGesture` is precisely that: the bracket's own snapshot,
           * restored, with no undo step pushed.
           *
           * It fires for every incomplete end, not only for Cancel — the
           * deadline, a provider that died, a loop that ran out of turns
           * half-way. That last one is why {@link MAX_ITERS} is generous: the
           * cost of the ceiling being too low is a lost run, not a broken
           * document.
           *
           * ⚠ What it does NOT put back is the PATTERNS a job minted, which live
           * in the other seam's history — documented on `abortEditGesture` and
           * in docs/FOLLOW-UPS.md. And the restore is irreversible by design (no
           * step is pushed, so there is nothing to redo), which is affordable
           * only because the job lock guarantees that everything inside the
           * snapshot's diff is the AGENT's work and none of it is the user's.
           */
          abortEditGesture();
        }

        window.clearTimeout(deadline);
        inFlightRef.current = null;
      }
    })();
  };

  const running = run.kind === 'running';

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2">
      {!configured && (
        // A STATE, not an error — it is the state the app ships in, and the
        // panel stays entirely usable in it.
        <p className="tray px-2 py-1.5 text-[10px] leading-relaxed text-ink-mut">
          No provider yet — set one under <span className="text-ink">Connector</span>, in the
          header.
        </p>
      )}

      {noBlockOpen ? (
        // The list and the form are BOTH withheld, not merely disabled: a
        // selected command survives a mode change, so leaving the form up would
        // leave a Run button that writes into a document off-screen. Withholding
        // it is also what makes the `start` guard unnecessary — there is no
        // button to press. The run report below stays mounted regardless.
        <p className="tray px-2 py-1.5 text-[10px] leading-relaxed text-ink-mut">
          Press a block in the arrangement to open it — these commands act on the block you
          are editing.
        </p>
      ) : (
        <ul className="flex flex-col gap-[3px]">
          {commands.map((command) => (
            <li key={command.id}>
              <button
                type="button"
                aria-pressed={command.id === selectedId}
                onClick={() => select(command)}
                className={`w-full rounded-md px-2 py-1 text-left font-mono text-[10px] font-semibold ${
                  command.id === selectedId
                    ? 'control-accent pressable text-ink-hi'
                    : 'text-ink-mut hover:text-brass-hi'
                }`}
              >
                {command.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && !noBlockOpen && (
        <div className="flex flex-col gap-2 border-t border-rim-dark pt-2">
          <p className="text-[10.5px] leading-relaxed text-ink-mut">{selected.summary}</p>

          <SlotFields command={selected} values={values} onChange={setValue} />

          <button
            type="button"
            onClick={start}
            className={`${COMMAND_BUTTON} self-start ${running ? 'opacity-60' : 'control-accent'}`}
          >
            {running ? 'Running…' : 'Run'}
          </button>

          {/* Stated where the button is, and unconditionally: a user who does not
              know what a run costs them will not risk one. The two sentences
              differ because the two paths genuinely do — see the `finally`. */}
          <p className="font-mono text-[9px] leading-relaxed text-ink-mut">
            {selected.page === 'composition'
              ? // Qualified, because the rollback is not total and a promise the
                // cancel cannot keep is the one that matters — this is the
                // sentence that makes pressing Cancel feel safe. What it restores
                // is the ARRANGEMENT; patterns the run authored live in the other
                // seam's history and stay in the library (`abortEditGesture`).
                'Cancelling puts the arrangement back as it was, though patterns it wrote stay in your library. A finished run undoes in one press.'
              : 'Everything a run changes undoes in one press — cancelling included.'}
          </p>
        </div>
      )}

      {/* ── THE RUN, OUTSIDE THE FORM ────────────────────────────────────────
          Mounted for the whole life of the panel and never inside the selected
          command's block: a job outlives the list it was started from, and the
          mode switch that swaps that list must not take the Cancel button with
          it. Disabled while idle, so the keyboard skips it and it cannot strand
          anyone by disappearing under the pointer that just pressed it. */}
      <div className="flex flex-col gap-2 border-t border-rim-dark pt-2">
        <button type="button" onClick={cancel} disabled={!running} className={COMMAND_BUTTON}>
          Cancel
        </button>

        {/* `aria-live` WITHOUT `role="status"`: the connector dialog owns the
            app's one `status` landmark, and a second one makes "the status
            region" ambiguous both to a screen reader user moving by role and to
            `getByRole('status')`. Always mounted, because a live region that
            appears together with its content is announced inconsistently. */}
        <div aria-live="polite" className="empty:hidden">
          <RunReport run={run} />
        </div>
      </div>
    </div>
  );
}

/**
 * What the run did, in the order it matters: which command, whether it is still
 * going, what it CALLED, what got refused along the way, and only then what the
 * model said.
 *
 * The tool names come before the answer because they are the only evidence the
 * loop did anything — a model that answers "done!" without calling a tool is the
 * commonest failure of this whole design and it is invisible in `content`. The
 * refusals come before it for the same reason one step down: the model is free
 * to summarise a run that hit the track cap without mentioning the cap.
 */
function RunReport({ run }: { run: RunView }) {
  if (run.kind === 'idle') return null;

  return (
    <div className="well px-2 py-1.5">
      <p className="font-mono text-[9px] font-bold tracking-[0.12em] text-ink-hi uppercase">
        {/* "Done" is reserved for a loop that finished because it had FINISHED.
            A cancelled or truncated run is `{ok:true}` all the same — the seam
            treats an abort as a success, because the user got what they asked
            for — and calling that "Done" over a rolled-back arrangement is the
            one word this report must not use. */}
        {run.kind === 'running'
          ? 'Running…'
          : run.kind === 'refused'
            ? 'Refused'
            : run.stoppedReason === 'answered'
              ? 'Done'
              : 'Stopped'}
        <span className="text-ink-mut"> · {run.command}</span>
      </p>

      <ToolTrace tools={run.tools} running={run.kind === 'running'} />

      {run.kind === 'running' && (
        // No progress bar and no percentage, deliberately: a job has no fixed
        // number of steps to count towards, and a bar drawn against a guess is a
        // promise the run cannot keep.
        <p className="mt-1 font-mono text-[9px] text-ink-mut">
          No total to count towards — a job runs until it is done.
        </p>
      )}

      {run.refusals.length > 0 && (
        <div className="mt-1.5">
          <p className="font-mono text-[9px] font-bold tracking-[0.12em] text-ink-mut uppercase">
            Refused along the way
          </p>
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {run.refusals.map((reason) => (
              // Verbatim. The seams author these sentences so that a model can
              // act on them, which also makes them the clearest thing a user can
              // be shown — `TRACK_CAP_REASON` says what the cap is and why.
              <li key={reason} className="text-[10px] leading-relaxed text-ink">
                {reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {run.kind !== 'running' && run.rolledBack && (
        <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink">
          The arrangement was put back the way it was before the run.
          {/* Said only when it happened. `abortEditGesture` restores the
              COMPOSITION and nothing else, so a job that authored parts leaves
              them in the library — unreferenced, and not undoable. Claiming a
              clean restore over that is the one thing this report must not
              do. */}
          {run.keptPatterns ? ' Patterns it wrote are still in your library.' : ''}
        </p>
      )}

      {run.kind === 'refused' && (
        <p className="mt-1 text-[10.5px] leading-relaxed text-ink">{run.reason}</p>
      )}

      {run.kind === 'answered' && (
        <p className="mt-1 text-[10.5px] leading-relaxed text-ink">
          {run.content.trim() === '' ? `The run ended: ${run.stoppedReason}.` : run.content}
        </p>
      )}

      {run.kind === 'answered' && run.stoppedReason !== 'answered' && (
        // The model did not choose to stop; something stopped it. Said out loud
        // because `content` from a truncated run reads exactly like a finished
        // one.
        <p className="mt-1 font-mono text-[9px] leading-relaxed text-ink-mut">
          {run.stoppedReason === 'aborted'
            ? 'Cancelled.'
            : `The run was cut short: ${run.stoppedReason}.`}
        </p>
      )}

      {/* On every ENDED run, not only the ones that went wrong: a job that
          answered confidently and built the wrong thing is the case a
          failure-only affordance would miss, and it is the case that has come
          up. Withheld while running because the log is still growing. */}
      {run.kind !== 'running' && run.transcriptId !== undefined && (
        <RunTranscriptControl transcriptId={run.transcriptId} />
      )}
    </div>
  );
}

/** Which tools have run, and which one is running now. */
function ToolTrace({ tools, running }: { tools: readonly string[]; running: boolean }) {
  if (tools.length === 0) {
    return (
      <p className="mt-1 font-mono text-[9.5px] text-ink-mut">
        {running ? 'No tools called yet' : 'No tools called'}
      </p>
    );
  }
  return (
    // CAPPED AND SCROLLED, not left to grow: `MAX_ITERS` is 60 and a backing
    // track is around three calls a chord, so a full run is fifty-odd lines —
    // and this section is `flex-none` in a rail with no scroller of its own, so
    // an uncapped trace squeezes the mode rail below it towards zero and
    // overflows the column. The cap is a HEIGHT (`max-h-40`) and not a count,
    // so it did not have to move when the budget did. Not assertable in jsdom,
    // which has no layout.
    <ol className="mt-1 flex max-h-40 flex-col overflow-y-auto font-mono text-[9.5px] text-ink-mut">
      {tools.map((name, index) => {
        // `tool.started` arrives before the call runs, so while the run is live
        // the LAST name in the list is the one in flight. It is marked rather
        // than merely listed because a job's tools take seconds each and a
        // static list of names looks identical to a stalled one.
        const inFlight = running && index === tools.length - 1;
        return (
          // Indexed key on purpose: the same tool legitimately appears more than
          // once in call order, so the name is not an identity.
          <li key={`${name}-${index}`} className={inFlight ? 'text-ink' : undefined}>
            {index + 1}. {name}
            {inFlight ? ' …' : ''}
          </li>
        );
      })}
    </ol>
  );
}
