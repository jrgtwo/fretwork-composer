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
 * `paramSchema.test.ts` walks every shipped preset against every declared range, so
 * nothing built-in reaches it — only a variant authored by guitar-tutor's Sound Lab,
 * whose fader ranges differ from ours, could. Clamping the readout would hide the fact
 * that the preset holds a value this editor cannot represent, which is worse.
 */
export function ParamSlider({
  id,
  label,
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
