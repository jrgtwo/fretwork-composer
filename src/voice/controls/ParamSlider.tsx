/**
 * One numeric voice parameter: label, range input, right-aligned readout.
 *
 * The shape is guitar-tutor's `ParameterSlider` — label / range / tabular value +
 * unit — because that layout survived a 2,000-line editor and reads correctly at
 * thirty rows deep. The styling is not: this project has its own tokens and no
 * shadcn.
 *
 * A native `<input type="range">` on purpose. It is the only slider that is already
 * keyboard-operable (arrows, Home/End, PageUp/Down) and already announces its value,
 * and there are ~30 of these in the pane — a custom pointer-driven knob would have to
 * re-earn all of it thirty times.
 *
 * The label is associated by `htmlFor` rather than by wrapping, so the readout can sit
 * inside the row without being read as part of the control's name ("Bass 3.0 dB"). The
 * readout is `aria-hidden` for the same reason: the range input already reports the
 * value it duplicates.
 *
 * KNOWN, accepted: a value outside `[min, max]` renders the thumb pinned to the bound
 * while the readout shows the true number, and the first drag snaps it into range.
 * Clamping the readout would hide the fact that the preset holds a value this editor
 * cannot represent, which is worse.
 *
 * ⚠ IT WAS ONCE THE COMMON CASE, which is why the behaviour is spelled out rather than
 * waved at. Ten of the fourteen built-ins held a `source.release` of 1.5–2.8 s against the
 * 0–1 s `classes/Sampler.html` documents, so the Release row drew pinned at 1 and read
 * `2.50 s` on most voices; the lib has since retuned those presets (FOLLOW-UPS row 24) and
 * no built-in is out of range today. A hand-authored variant still can be, and then two
 * things follow: the first arrow key on that row jumps 2.5 s → 1 s in one press, and a
 * click on the far right of the track emits nothing at all, because the DOM has already
 * clamped the input's value to `max` and React's value tracker sees no change.
 */
export function ParamSlider({
  id,
  label,
  ariaLabel,
  value,
  min,
  max,
  step,
  unit,
  precision,
  onChange,
}: {
  id: string;
  label: string;
  /**
   * Overrides the visible label as the accessible name. Same job, same reason as
   * `ParamToggle.ariaLabel`: a descriptor generated under two branches puts two
   * controls called "Harmonicity" in one pane, and `role="group"` does NOT
   * contribute its name to a descendant's — it is announced on entering the
   * group, not on the control. The visible engraving stays inside its 74 px
   * column; the name carries the branch.
   */
  ariaLabel?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  precision: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor={id}
        className="w-[74px] flex-none font-mono text-[9px] tracking-[0.1em] text-ink-mut uppercase"
      >
        {label}
      </label>
      <input
        id={id}
        type="range"
        // Exclusive rather than additive: `aria-label` outranks the `<label
        // for>` in the accessible-name computation, so setting it always wins
        // and setting nothing leaves the visible label doing the naming.
        {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
        className="h-1 min-w-0 flex-1 cursor-pointer accent-brass"
      />
      <span
        aria-hidden
        className="w-[52px] flex-none text-right font-mono text-[10px] tabular-nums text-ink"
      >
        {value.toFixed(precision)}
        {unit ? <span className="ml-0.5 text-ink-mut">{unit}</span> : null}
      </span>
    </div>
  );
}
