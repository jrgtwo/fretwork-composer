/**
 * Knob — the rotary control the amp rack is built from.
 *
 * The interaction model is guitar-tutor's `ui/Knob.tsx` essentially intact, because
 * that part is expensive to get right and it was already right: vertical drag with a
 * fixed pixel sweep, a precision modifier, wheel, arrows, Home/End and double-click to
 * default. The SVG is not: guitar-tutor draws a zinc-and-chrome Marshall dial, and this
 * project's surfaces are the `.control` / `.well` vocabulary in `styles/index.css`. So
 * the shape is amp gear and the material is ours — a top-lit raised cap sitting in a
 * sunken socket, brass indicator, brass arc.
 *
 * Every prop is satisfiable from one `SliderParam` in `paramSchema.ts`
 * (value/min/max/step/fallback→defaultValue/label, precision+unit→formatValue).
 *
 * WHY THE ARC IS COLOURED, not just the indicator: at 56px the indicator line alone is
 * a ~4° difference between "Bass -1" and "Bass 0". The lit portion of the tick ring is
 * the coarse read, the indicator the fine one, and the numeric readout the confirmation.
 *
 * THEMING: colours resolve through `--knob-*` custom properties that fall back to our
 * tokens, so an ancestor can retone a whole rack unit without touching this file. They
 * are read, never written, here — guitar-tutor set them in inline `style`, which is
 * exactly the one place a cascading override cannot reach.
 *
 * Value mapping is linear in [min, max]; no `SliderParam` we declare is log-scaled.
 * A caller that needs one pre-transforms in `value` and reverses in `onChange`.
 */
import { useCallback, useEffect, useId, useRef } from 'react';

const DEFAULT_SIZE = 56; // px — outer SVG dimension
const DRAG_RANGE_PX = 100; // px of vertical drag = full min→max sweep
const DRAG_PRECISION = 4; // Shift divides the sweep by this
const KEY_MULTIPLIER = 10; // Shift multiplies arrow / wheel steps by this
const SWEEP_DEGREES = 270; // 135° either side of 12 o'clock, as on real gear
const TICK_COUNT = 11; // the "0..10" ring

interface KnobProps {
  value: number;
  onChange(next: number): void;
  min: number;
  max: number;
  /** Smallest valid step. Drag, wheel and arrow results all snap to this grid. */
  step: number;
  /** Reset target on double-click. Absent = double-click does nothing. */
  defaultValue?: number;
  /** Engraved under the cap, and the control's accessible name. */
  label: string;
  /** Readout + `aria-valuetext`. e.g. `(v) => `${v.toFixed(1)} dB``. */
  formatValue?(v: number): string;
  /** Outer SVG dimension in px. */
  size?: number;
  disabled?: boolean;
}

export function Knob({
  value,
  onChange,
  min,
  max,
  step,
  defaultValue,
  label,
  formatValue,
  size = DEFAULT_SIZE,
  disabled = false,
}: KnobProps) {
  // Defensive sanitisation: the id is interpolated into unquoted `url(#…)` fragments
  // below, which cannot carry a colon. React 19 emits `_r_0_`-form ids so this is a
  // no-op today; it is here because the id format is React's to change, not ours.
  const uid = useId().replace(/:/g, '');
  const labelId = `${uid}-label`;
  const dialRef = useRef<HTMLDivElement | null>(null);
  /** Tears down the in-flight drag, so unmounting mid-gesture doesn't leak listeners. */
  const abortDrag = useRef<(() => void) | null>(null);

  const clamp = useCallback((n: number) => Math.min(max, Math.max(min, n)), [min, max]);

  const snap = useCallback(
    (n: number) => {
      if (step <= 0) return clamp(n);
      // Rounding after the multiply: `min + 3 * 0.01` is 0.030000000000000002, and
      // that lands in the preset verbatim and shows up in `aria-valuenow`. The
      // readout's `toFixed` would hide it; the stored value would keep it.
      const snapped = min + Math.round((n - min) / step) * step;
      return clamp(Math.round(snapped * 1e9) / 1e9);
    },
    [min, step, clamp],
  );

  // A value outside [min, max] pins the dial to the bound while the readout shows the
  // true number — the same trade `ParamSlider` documents, for the same reason: hiding
  // it would hide that the preset holds something this editor cannot represent.
  const fraction = max === min ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)));
  const angle = -SWEEP_DEGREES / 2 + fraction * SWEEP_DEGREES;
  const formatted = formatValue ? formatValue(value) : value.toFixed(2);

  /**
   * Drag transport is `window` listeners rather than pointer capture, for two reasons:
   * it is what `Timeline.tsx` already does, and jsdom implements no pointer capture, so
   * a captured drag would be untestable here. Capture would otherwise scope the gesture
   * to one pointer for free — since it doesn't, the handlers filter on `pointerId`
   * themselves, or a second finger anywhere on the page steers this knob.
   */
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (disabled || e.button !== 0) return;
      // A second press must not orphan the first gesture's teardown — `abortDrag` holds
      // one closure, so the previous listeners would otherwise outlive unmount.
      abortDrag.current?.();
      e.preventDefault(); // suppress text selection and the native image drag
      dialRef.current?.focus(); // …which also suppressed the focus this press would have given

      const pointerId = e.pointerId;
      const startY = e.clientY;
      const startValue = value;
      // A native <input type="range"> only fires on a real change; a knob dragged across
      // a coarse step would otherwise emit the same number dozens of times per gesture.
      let lastEmitted = startValue;

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const dy = startY - ev.clientY; // up = increase
        const precision = ev.shiftKey ? DRAG_PRECISION : 1;
        const next = snap(startValue + (dy / (DRAG_RANGE_PX * precision)) * (max - min));
        if (next === lastEmitted) return;
        lastEmitted = next;
        onChange(next);
      };
      // pointercancel closes it too — a touch can be taken away with no pointerup.
      // Called with no event when aborted from unmount or a disabled flip.
      const finish = (ev?: PointerEvent) => {
        if (ev && ev.pointerId !== pointerId) return;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        abortDrag.current = null;
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
      abortDrag.current = finish;
    },
    [disabled, max, min, onChange, snap, value],
  );

  useEffect(() => () => abortDrag.current?.(), []);

  // `onMove` closes over the `disabled` of its pointerdown, so a pane that disables the
  // knob mid-gesture would keep taking drag input until the button came up.
  useEffect(() => {
    if (disabled) abortDrag.current?.();
  }, [disabled]);

  // React attaches `wheel` at the root as passive, so `onWheel` cannot preventDefault
  // and the page would scroll under the cursor while the knob turned. Hence a native
  // non-passive listener.
  useEffect(() => {
    const el = dialRef.current;
    if (!el || disabled) return;
    const onWheel = (e: WheelEvent) => {
      // A two-finger horizontal trackpad swipe is deltaY 0 / deltaX ±n, and is not ours
      // to consume — without this it reads as a downward step.
      if (e.deltaY === 0) return;
      e.preventDefault();
      const mult = e.shiftKey ? KEY_MULTIPLIER : 1;
      const direction = e.deltaY < 0 ? 1 : -1; // wheel up = increase
      onChange(snap(value + direction * step * mult));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [disabled, onChange, snap, step, value]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      const delta = step * (e.shiftKey ? KEY_MULTIPLIER : 1);
      // PageUp/Down because the native range input in `ParamSlider` answers them, and
      // the two renderers sit over one schema — the same parameter must not answer
      // different keys depending on which one drew it.
      const pageDelta = step * KEY_MULTIPLIER;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
        e.preventDefault();
        onChange(snap(value + delta));
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
        e.preventDefault();
        onChange(snap(value - delta));
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        onChange(snap(value + pageDelta));
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        onChange(snap(value - pageDelta));
      } else if (e.key === 'Home') {
        // Not `snap`: a bound is a legal value by definition, and a range whose span is
        // not a whole number of steps would otherwise land short of its own valuemax.
        e.preventDefault();
        onChange(clamp(min));
      } else if (e.key === 'End') {
        e.preventDefault();
        onChange(clamp(max));
      }
    },
    [clamp, disabled, max, min, onChange, snap, step, value],
  );

  const handleDoubleClick = useCallback(() => {
    if (disabled || defaultValue === undefined) return;
    // Clamped, not snapped: an authored default is what the descriptor declares the
    // reset target to be, even if it sits off the step grid.
    onChange(clamp(defaultValue));
  }, [clamp, defaultValue, disabled, onChange]);

  // ---------------------------------------------------------------- geometry ---
  const c = size / 2;
  const ringR = c - 1; // outer end of the ticks
  const tickLen = size * 0.09;
  const socketR = size * 0.36; // the recess — wide enough that the cap's shadow lands in it
  const capR = size * 0.315; // the raised cap inside it
  const polar = (r: number, deg: number) => {
    // SVG measures from +X; 12 o'clock is the dial's zero, hence the -90°.
    const rad = ((deg - 90) * Math.PI) / 180;
    return [c + r * Math.cos(rad), c + r * Math.sin(rad)] as const;
  };
  const [ix1, iy1] = polar(capR * 0.2, angle);
  const [ix2, iy2] = polar(capR * 0.86, angle);

  return (
    <div className="inline-flex select-none flex-col items-center gap-1">
      <div
        ref={dialRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby={labelId}
        // Deliberately the clamped value: ARIA requires valuenow within
        // [valuemin, valuemax], and `aria-valuetext` below carries the true one.
        aria-valuenow={clamp(value)}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuetext={formatted}
        // role="slider" defaults to horizontal; the primary gesture here is a vertical drag.
        aria-orientation="vertical"
        aria-disabled={disabled || undefined}
        onPointerDown={handlePointerDown}
        onKeyDown={handleKeyDown}
        onDoubleClick={handleDoubleClick}
        className={`touch-none rounded-full ${
          disabled ? 'cursor-not-allowed opacity-40' : 'cursor-grab active:cursor-grabbing'
        }`}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden focusable="false">
          <defs>
            {/* Lit from above: the cap's light edge is at the top… */}
            <linearGradient id={`${uid}-cap`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--knob-cap-hi, var(--color-raise-hi))" />
              <stop offset="100%" stopColor="var(--knob-cap, var(--color-raise))" />
            </linearGradient>
            {/* …and the socket's is at the bottom, which is what makes it read sunken. */}
            <linearGradient id={`${uid}-socket`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--knob-socket, var(--color-rim-dark))" />
              <stop offset="100%" stopColor="var(--knob-socket-hi, var(--color-rim))" />
            </linearGradient>
            {/* The `.control` top highlight, as a stroke that fades out by the equator. */}
            <linearGradient id={`${uid}-gloss`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.16" />
              <stop offset="45%" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>
            <filter id={`${uid}-lift`} x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow
                dx="0"
                dy={size * 0.035}
                stdDeviation={size * 0.02}
                floodColor="#000000"
                floodOpacity="0.55"
              />
            </filter>
          </defs>

          <g>
            {Array.from({ length: TICK_COUNT }, (_, i) => {
              const t = i / (TICK_COUNT - 1);
              const deg = -SWEEP_DEGREES / 2 + t * SWEEP_DEGREES;
              const [x1, y1] = polar(ringR, deg);
              const [x2, y2] = polar(ringR - tickLen, deg);
              const lit = t <= fraction + 1e-4;
              return (
                <line
                  key={i}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={
                    lit ? 'var(--knob-tick-active, var(--color-brass))' : 'var(--knob-tick, var(--color-line))'
                  }
                  strokeWidth={1.5}
                  strokeLinecap="round"
                />
              );
            })}
          </g>

          <circle
            cx={c}
            cy={c}
            r={socketR}
            fill={`url(#${uid}-socket)`}
            stroke="var(--knob-edge, var(--color-rim-dark))"
            strokeWidth={1}
          />
          <circle
            cx={c}
            cy={c}
            r={capR}
            fill={`url(#${uid}-cap)`}
            stroke="var(--knob-edge, var(--color-rim-dark))"
            strokeWidth={1}
            filter={`url(#${uid}-lift)`}
          />
          <circle cx={c} cy={c} r={capR - 0.5} fill="none" stroke={`url(#${uid}-gloss)`} strokeWidth={1} />

          <line
            x1={ix1}
            y1={iy1}
            x2={ix2}
            y2={iy2}
            stroke="var(--knob-indicator, var(--color-brass-hi))"
            strokeWidth={Math.max(1.5, size * 0.036)}
            strokeLinecap="round"
          />
        </svg>
      </div>

      {/* Type scales with `size`: at a fixed 9px a small knob's label is wider than its
          dial and sets the column width, so a rack of mixed sizes stops lining up. */}
      <span
        id={labelId}
        style={{ fontSize: size * 0.16 }}
        className="font-mono tracking-[0.1em] text-ink-mut uppercase"
      >
        {label}
      </span>
      {/* aria-hidden: `aria-valuetext` already announces exactly this string. */}
      <span aria-hidden style={{ fontSize: size * 0.18 }} className="font-mono tabular-nums text-ink">
        {formatted}
      </span>
    </div>
  );
}
