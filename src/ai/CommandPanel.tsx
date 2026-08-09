import { useEffect, useId, useRef, useState } from 'react';
import { commandsForPage } from './commandCatalog';
import { defaultValues, fillForNow, resolveCommand, type ResolvedSlot } from './slotSources';
import type { Command, SlotValue } from './commandTypes';
import { PATTERN_AGENT, PATTERN_WRITE_TOOLS } from './patternAgent';
import { runAgentTask, type AgentEvent } from './agentService';
import { isConfigured } from './connectorSettings';
import { useConnectorSettings } from './connectorView';
import { beginEditGesture, endEditGesture, useEditingPattern } from '../patterns/patternService';

/**
 * The pattern page's command panel — a section of the right rail (AG-06).
 *
 * ── THE PANEL KNOWS NO COMMAND ──────────────────────────────────────────────
 *
 * It renders the catalog and nothing else: a list of `commandsForPage('pattern')`,
 * and for the selected one a control per slot chosen by `slot.kind` alone. There
 * is no branch anywhere below on a command id, and if one is ever needed then
 * either a slot type is missing or the row does not belong in a catalog. Same
 * rule that keeps `VoicePane` a renderer of `paramSchema`.
 *
 * ── NO FREE TEXT ANYWHERE ───────────────────────────────────────────────────
 *
 * That is the decision the whole feature rests on, and it is what makes a slot
 * bind to real state: a choice slot offers what `slotSources` says exists right
 * now, so it cannot name a groove the lib does not ship. The same constraint
 * that bounds misuse is the one that stops hallucination — see `commandTypes`.
 *
 * A number is therefore a stepper and not a typed field. The stride is the
 * catalog's `step` and the stops are its `min`/`max`, which is the same control
 * the timeline already uses for tempo (±1 over 20–300); a second, cleverer one
 * here would be a second answer to a question the app has already answered.
 *
 * ── THE RUN-LEVEL UNDO BRACKET ──────────────────────────────────────────────
 *
 * `patternTools` brackets each tool call, so a command that moves twelve notes
 * in three batches is three undo presses without this. The whole run is wrapped
 * in one more bracket HERE, and the per-tool ones nest inside it (`patternService`
 * counts depth). It belongs to the panel and not to `agentService` because a
 * bracket has to name a HISTORY — pattern or composition — and the panel is the
 * thing that knows which page it is on; making the harness seam import
 * `patternService` would cross two seams to answer a question its caller already
 * knows.
 *
 * ⚠ The bracket closes in a `finally`, on every path — answered, refused,
 * cancelled, or a throw from anywhere in the chain. An early return that skipped
 * `endEditGesture` would leave the gesture depth above zero for the rest of the
 * session, and every subsequent edit in the timeline would silently join one
 * ever-growing undo step. That defect has shipped in this project before.
 *
 * NO AUTO-ROLLBACK. `runAgentTask` treats an abort as a SUCCESS on the stated
 * grounds that the user got what they asked for, and the design rests on "the
 * worst case is an edit the user presses undo on". A rollback would be a second
 * write path contradicting both. With the bracket in place a cancelled run's
 * partial work is ONE undo press — and the panel says so out loud, because a
 * user who does not know a generation is undoable will never try one.
 */

/**
 * Outer bound on the wall clock of a single run.
 *
 * Not belt and braces: without it a firewalled provider leaves the request
 * outstanding for as long as the tab is open, and with it the EDIT GESTURE OPEN
 * — which is the wedged-undo failure above, arrived at by waiting. Longer than
 * the connector probe's 15 s and than the trigger this replaces, because these
 * runs are several model round trips on whatever hardware the user has.
 */
const RUN_TIMEOUT_MS = 180_000;

/**
 * Model round trips per run. The harness default is 8; a command is a read, one
 * batched write per kind of edit, room to act on a refusal, and an answer — and
 * running out of turns half way through a rewrite is worse than the same run
 * costing a little more.
 */
const MAX_ITERS = 12;

type RunView =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly tools: readonly string[] }
  | {
      readonly kind: 'answered';
      readonly tools: readonly string[];
      readonly content: string;
      readonly stoppedReason: string;
    }
  /** Everything that came back `{ok:false}`, plus the two the panel decides
   *  itself: a slot that no longer fills, and the deadline above. */
  | { readonly kind: 'refused'; readonly tools: readonly string[]; readonly reason: string };

const BUTTON =
  'pressable control rounded-[7px] px-2.5 py-1.5 font-mono text-[9.5px] font-bold tracking-[0.12em] uppercase';

const FIELD_LABEL =
  'font-mono text-[9px] font-semibold tracking-[0.14em] text-ink-mut uppercase';

export function CommandPanel() {
  const commands = commandsForPage('pattern');
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

  // Subscribed, and the value is deliberately unused: every choice slot's
  // DEFAULT is read off the open pattern (`pattern-key`, `pattern-groove`,
  // `pattern-bpm`), so a panel that did not re-render when the pattern changed
  // would open a command on the last pattern's key.
  useEditingPattern();

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      // A run has SIDE EFFECTS and may be holding an edit gesture open, so an
      // orphaned one is cancelled rather than left to finish into a component
      // that is gone. The bracket still closes: the `finally` below is not
      // React's to unmount.
      inFlightRef.current?.abort();
    };
  }, []);

  const selected = commands.find((command) => command.id === selectedId) ?? null;
  // Re-resolved every render rather than memoised: `slotOptions` reads the seams,
  // and a memo keyed on the command alone would be a picker that stopped
  // following the app the moment anything else changed it.
  const resolved = selected ? resolveCommand(selected) : null;

  const select = (command: Command) => {
    setSelectedId(command.id);
    // Seeded from live state, and only here. Re-seeding on every render would
    // undo the user's own choices between opening a command and running it.
    setValues(defaultValues(command));
    setRun({ kind: 'idle' });
  };

  const setValue = (id: string, value: SlotValue) =>
    setValues((was) => ({ ...was, [id]: value }));

  const cancel = () => inFlightRef.current?.abort();

  const start = () => {
    // Guarded here rather than with `disabled` — see `inFlightRef`.
    if (inFlightRef.current || !selected) return;

    // `fillForNow`, never `fillCommand`: the one-argument form has the live
    // allow-list composed in, so a slot holding something the app no longer
    // offers is refused here instead of being spent on a dead id by the model.
    const filled = fillForNow(selected, values);
    if (!filled.ok) {
      setRun({ kind: 'refused', tools: [], reason: filled.reason });
      return;
    }

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
     * Whether anything that can WRITE actually ran, which is what decides
     * `endEditGesture(changed)`.
     *
     * `tool.started` and not `tool.finished`: the harness emits `started` only
     * after schema validation passes, and a handler that throws mid-batch has
     * already written. Reads are excluded because every command opens with
     * `read_pattern`, and a run that read and then failed must not leave an undo
     * step restoring a state nothing left.
     *
     * A write tool that ran and refused end to end does leave one such step.
     * That is the deliberate side of the trade: the opposite mistake — deciding
     * "nothing changed" about a run that did — costs the user the ability to
     * undo the agent at all.
     */
    let wrote = false;

    setRun({ kind: 'running', tools: [] });

    void (async () => {
      beginEditGesture();
      try {
        const result = await runAgentTask(PATTERN_AGENT, filled.value, {
          signal: controller.signal,
          maxIters: MAX_ITERS,
          onEvent: (event: AgentEvent) => {
            if (event.type !== 'tool.started') return;
            started.push(event.name);
            if (PATTERN_WRITE_TOOLS.has(event.name)) wrote = true;
            if (liveRef.current) setRun({ kind: 'running', tools: [...started] });
          },
        });
        if (!liveRef.current) return;
        if (!result.ok) {
          setRun({ kind: 'refused', tools: started, reason: result.reason });
          return;
        }
        // An abort comes back as a SUCCESS with `stoppedReason: 'aborted'`,
        // which read plainly says the user cancelled. Nobody cancelled a run the
        // deadline killed, and saying so is the whole point of having one.
        if (timedOut) {
          setRun({
            kind: 'refused',
            tools: started,
            reason: `Gave up after ${RUN_TIMEOUT_MS / 1000}s — the provider never finished.`,
          });
          return;
        }
        setRun({
          kind: 'answered',
          tools: result.value.toolCalls,
          content: result.value.content,
          stoppedReason: result.value.stoppedReason,
        });
      } catch (error) {
        // `runAgentTask` returns its failures rather than throwing, so arriving
        // here is a defect in this app — but the bracket below must close all
        // the same, and the panel must not be left saying "Running…" forever.
        if (liveRef.current) {
          setRun({
            kind: 'refused',
            tools: started,
            reason: `The agent run could not complete: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      } finally {
        // THE BRACKET, closed on every path out of the try — including the two
        // early returns above and a throw from anywhere in the chain.
        endEditGesture(wrote);
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
        // panel stays entirely usable in it. Deliberately terse: the sentence
        // that explains a REFUSED RUN is `runAgentTask`'s and is not restated
        // here, the way `testConnection` authors the connector's outcomes.
        <p className="tray px-2 py-1.5 text-[10px] leading-relaxed text-ink-mut">
          No provider yet — set one under <span className="text-ink">Connector</span>, in the
          header.
        </p>
      )}

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

      {selected && resolved && (
        <div className="flex flex-col gap-2 border-t border-rim-dark pt-2">
          <p className="text-[10.5px] leading-relaxed text-ink-mut">{selected.summary}</p>

          {resolved.slots.map((slot) => (
            <SlotControl
              key={slot.slot.id}
              resolved={slot}
              value={values[slot.slot.id]}
              onChange={(next) => setValue(slot.slot.id, next)}
            />
          ))}

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={start}
              className={`${BUTTON} ${running ? 'opacity-60' : 'control-accent'}`}
            >
              {running ? 'Running…' : 'Run'}
            </button>
            {/* Mounted for the whole life of the panel rather than only while a
                run is in flight. A control that appears when you need it also
                DISAPPEARS under the pointer that just pressed it, dropping focus
                to `<body>`; disabled while idle it is skipped by the keyboard
                and cannot strand anyone. */}
            <button type="button" onClick={cancel} disabled={!running} className={BUTTON}>
              Cancel
            </button>
          </div>

          {/* Stated where the button is, and unconditionally: a user who does not
              know a generation is undoable will not risk one, and the same
              sentence is what makes cancelling safe to press. */}
          <p className="font-mono text-[9px] leading-relaxed text-ink-mut">
            Everything a run changes undoes in one press — cancelling included.
          </p>

          {/* `aria-live` WITHOUT `role="status"`: the connector dialog owns the
              app's one `status` landmark, and a second one makes "the status
              region" ambiguous both to a screen reader user moving by role and
              to `getByRole('status')`. The live behaviour is identical.
              Always mounted, because a live region that appears together with
              its content is announced inconsistently. */}
          <div aria-live="polite" className="empty:hidden">
            <RunReport run={run} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One slot, as the control its KIND implies — and the only place in the panel
 * that branches on anything.
 *
 * `choice` and `enum` render identically on purpose. They are different in where
 * their values come from, which is `slotSources`' business and already settled
 * by the time a `ResolvedSlot` exists; a user picking a groove and a user picking
 * a direction of travel are doing the same thing and should not face two
 * different widgets to do it.
 */
function SlotControl({
  resolved,
  value,
  onChange,
}: {
  resolved: ResolvedSlot;
  value: SlotValue | undefined;
  onChange: (value: SlotValue) => void;
}) {
  const controlId = useId();
  const { slot } = resolved;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={controlId} className={FIELD_LABEL}>
        {slot.label}
      </label>

      {slot.kind === 'number' ? (
        <NumberStepper
          controlId={controlId}
          label={slot.label}
          min={slot.min}
          max={slot.max}
          step={slot.step}
          unit={slot.unit}
          value={typeof value === 'number' ? value : slot.fallback}
          onChange={onChange}
        />
      ) : resolved.unavailable ? (
        // A choice source with nothing to offer is a STATE the panel says out
        // loud, not an empty picker that opens onto nothing.
        <p className="text-[10px] leading-relaxed text-ink-mut">{resolved.unavailable}</p>
      ) : (
        <select
          id={controlId}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.currentTarget.value)}
          className="control w-full rounded-lg px-1.5 py-1 font-mono text-[10px] font-bold text-ink"
        >
          {resolved.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.hint ? `${option.label} — ${option.hint}` : option.label}
            </option>
          ))}
        </select>
      )}

      {slot.help && <p className="text-[9.5px] leading-relaxed text-ink-mut">{slot.help}</p>}
    </div>
  );
}

/** ±`step` over the catalog's range, which is the control the timeline already
 *  uses for tempo. Clamped rather than wrapped, and the readout is the value
 *  itself so there is nothing to type. */
function NumberStepper({
  controlId,
  label,
  min,
  max,
  step,
  unit,
  value,
  onChange,
}: {
  controlId: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const nudge = (delta: number) => onChange(Math.min(max, Math.max(min, value + delta)));

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        onClick={() => nudge(-step)}
        className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold"
      >
        –
      </button>
      {/* The readout carries the field's id so the `<label>` above names it —
          there is no input to point at, by design. `tabIndex` is deliberately
          absent: it is text, and the two buttons are what a keyboard drives. */}
      <span
        id={controlId}
        className="min-w-8 text-center font-mono text-[11px] font-bold text-ink-hi"
      >
        {value}
      </span>
      {unit && (
        <span className="font-mono text-[9px] tracking-[0.12em] text-ink-mut uppercase">
          {unit}
        </span>
      )}
      <button
        type="button"
        aria-label={`Increase ${label}`}
        onClick={() => nudge(step)}
        className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold"
      >
        +
      </button>
    </div>
  );
}

/**
 * What the run did, in the order it matters: whether it is still going, what it
 * CALLED, and only then what it said.
 *
 * The tool names come first because they are the only evidence the loop did
 * anything — a model that answers "done!" without calling a tool is the
 * commonest failure of this whole design and it is invisible in `content`.
 */
function RunReport({ run }: { run: RunView }) {
  if (run.kind === 'idle') return null;

  return (
    <div className="well px-2 py-1.5">
      <p className="font-mono text-[9px] font-bold tracking-[0.12em] text-ink-hi uppercase">
        {run.kind === 'running' ? 'Running…' : run.kind === 'refused' ? 'Refused' : 'Done'}
      </p>

      <ToolTrace tools={run.tools} running={run.kind === 'running'} />

      {run.kind === 'refused' && (
        // The seams author these sentences deliberately — a refusal a model can
        // act on is one that names what was wrong — so it is shown verbatim
        // rather than summarised into "something went wrong".
        <p className="mt-1 text-[10.5px] leading-relaxed text-ink">{run.reason}</p>
      )}

      {run.kind === 'answered' && (
        <p className="mt-1 text-[10.5px] leading-relaxed text-ink">
          {run.content.trim() === '' ? `The run ended: ${run.stoppedReason}.` : run.content}
        </p>
      )}
    </div>
  );
}

function ToolTrace({ tools, running }: { tools: readonly string[]; running: boolean }) {
  if (tools.length === 0) {
    return (
      <p className="mt-1 font-mono text-[9.5px] text-ink-mut">
        {running ? 'No tools called yet' : 'No tools called'}
      </p>
    );
  }
  return (
    <ol className="mt-1 flex flex-col font-mono text-[9.5px] text-ink-mut">
      {tools.map((name, index) => (
        // Indexed key on purpose: the same tool legitimately appears more than
        // once in call order, so the name is not an identity.
        <li key={`${name}-${index}`}>
          {index + 1}. {name}
        </li>
      ))}
    </ol>
  );
}
