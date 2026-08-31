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
 * ⚠ THIS IS NOT AN EDGE CASE ANY MORE, and the header used to claim it was. Ten of the
 * fourteen built-ins hold a `source.release` outside the 0–1 s that `classes/Sampler.html`
 * documents — 1.5 to 2.8 s — so on every one of them the Release row draws pinned at 1
 * and reads `2.50 s`. They are listed in `STALE_PRESET_VALUES` in
 * `src/voice/paramSchema.test.ts`, and they are stale PRESET data (the lib is out of
 * bounds for this app), not a wrong bound. Two consequences to expect until they are
 * retuned: the first arrow key on that row jumps 2.5 s → 1 s in one press, and a click on
 * the far right of the track emits nothing at all, because the DOM has already clamped
 * the input's value to `max` and React's value tracker sees no change.
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
