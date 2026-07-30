/**
 * One boolean voice parameter — in this slice always a stage's `enabled`, i.e. bypass.
 *
 * `role="switch"` rather than the `aria-pressed` buttons used elsewhere in the app: the
 * others are mode selectors where "pressed" is the right metaphor, and this is a stage
 * that is either in the chain or out of it. The visible text says which as well, so the
 * state is legible without an accessibility tree.
 *
 * Bypassed is NOT absent. Turning a stage off here keeps the user's tuning on the
 * preset for when they turn it back on; removing the section is the other, lossy thing,
 * and it lives on the section header.
 */
export function ParamToggle({
  id,
  label,
  ariaLabel,
  value,
  onChange,
}: {
  id: string;
  label: string;
  /**
   * Overrides the visible label as the accessible name. Every stage's bypass is called
   * "Enabled", and more than one stage is on screen at a time, so the caller qualifies
   * the name with the stage while the visible label stays inside a 74px column.
   */
  ariaLabel?: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        id={`${id}-label`}
        className="w-[74px] flex-none font-mono text-[9px] tracking-[0.1em] text-ink-mut uppercase"
      >
        {label}
      </span>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={value}
        // Exclusive, not additive: `aria-labelledby` outranks `aria-label` in the name
        // computation, so emitting both would silently ignore the qualified name.
        {...(ariaLabel ? { 'aria-label': ariaLabel } : { 'aria-labelledby': `${id}-label` })}
        onClick={() => onChange(!value)}
        className={`pressable rounded-lg px-2 py-0.5 font-mono text-[9px] font-bold tracking-[0.06em] uppercase ${
          value ? 'control-accent' : 'control'
        }`}
      >
        {value ? 'In chain' : 'Bypassed'}
      </button>
    </div>
  );
}
