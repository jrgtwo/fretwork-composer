import { useId } from 'react';
import { resolveCommand, type ResolvedSlot } from './slotSources';
import type { Command, SlotValue } from './commandTypes';

/**
 * The half of a command panel that is the SAME on both pages: turning a
 * `Command`'s slots into controls.
 *
 * AG-06 wrote all of this inside `CommandPanel`; AG-07 needed the identical
 * thing and this is the extraction rather than the copy. What is shared is
 * shared because it is genuinely one behaviour — a slot's control is decided by
 * `slot.kind` and by nothing else, and neither page has an opinion about it.
 *
 * ⚠ WHAT IS DELIBERATELY *NOT* SHARED IS THE RUN. There is no `page` prop here
 * and there is no one panel with one: the two run halves differ in what they
 * bracket (which history), whether a failure ROLLS BACK, whether the document is
 * locked for the duration, how long a run is allowed to take, and which agent
 * drives it. A single component branching on a page id for all five would be the
 * fork with extra steps — the same argument `PatternLibraryPanel` makes in its
 * own header about `PatternLibraryRail`. Two panels, one slot layer.
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
 */

/** Run and Cancel, on both panels. Here rather than duplicated for the reason
 *  the controls below are: the two panels sit in two rails of the same app and a
 *  user should not be able to tell which one they are looking at from the
 *  buttons. */
export const COMMAND_BUTTON =
  'pressable control rounded-[7px] px-2.5 py-1.5 font-mono text-[9.5px] font-bold tracking-[0.12em] uppercase';

const FIELD_LABEL =
  'font-mono text-[9px] font-semibold tracking-[0.14em] text-ink-mut uppercase';

/**
 * Every slot of one command, as controls.
 *
 * The command is resolved HERE, on every render, rather than by the caller:
 * `slotOptions` reads the seams, and a memo keyed on the command alone would be
 * a picker that stopped following the app the moment anything else changed it.
 * Keeping the resolve inside also means neither panel holds a `ResolvedCommand`
 * it has to remember to refresh.
 */
export function SlotFields({
  command,
  values,
  onChange,
}: {
  command: Command;
  values: Readonly<Record<string, SlotValue>>;
  onChange: (slotId: string, value: SlotValue) => void;
}) {
  return (
    <>
      {resolveCommand(command).slots.map((resolved) => (
        <SlotControl
          key={resolved.slot.id}
          resolved={resolved}
          value={values[resolved.slot.id]}
          onChange={(next) => onChange(resolved.slot.id, next)}
        />
      ))}
    </>
  );
}

/**
 * One slot, as the control its KIND implies — and the only place in either
 * panel that branches on anything.
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
  const labelId = `${controlId}-label`;
  const { slot } = resolved;

  /**
   * Whether there will be a LABELABLE element to point a `<label>` at.
   *
   * `htmlFor` associates with form controls and with nothing else, so a `<label>`
   * aimed at the stepper's readout — a `<span>`, deliberately, because there is
   * nothing to type — names it for no one: not for a screen reader, and not for
   * `getByLabelText` either. The same is true of the empty-source branch, which
   * renders a sentence and no control at all. Those two name themselves through
   * `aria-labelledby` on a group instead.
   */
  const labelable = slot.kind !== 'number' && resolved.unavailable === null;

  return (
    <div className="flex flex-col gap-1">
      {labelable ? (
        <label htmlFor={controlId} className={FIELD_LABEL}>
          {slot.label}
        </label>
      ) : (
        <span id={labelId} className={FIELD_LABEL}>
          {slot.label}
        </span>
      )}

      {slot.kind === 'number' ? (
        <NumberStepper
          labelId={labelId}
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
  labelId,
  label,
  min,
  max,
  step,
  unit,
  value,
  onChange,
}: {
  labelId: string;
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
    // A GROUP, named by the field's label: `role="group"` is what gives the
    // readout and its two buttons one accessible name, which a `<label>` cannot
    // do for a span. See `labelable` above.
    <div role="group" aria-labelledby={labelId} className="flex items-center gap-1.5">
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        onClick={() => nudge(-step)}
        className="pressable control rounded-lg px-2 py-1 font-mono text-[9px] font-bold"
      >
        –
      </button>
      {/* Text, not a control: there is nothing to type, by design. `tabIndex` is
          deliberately absent — the two buttons are what a keyboard drives, and
          the group above is what names all three. */}
      <span className="min-w-8 text-center font-mono text-[11px] font-bold text-ink-hi">
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
