/**
 * ParamEncoder — the endless rotary encoder.
 *
 * WHY IT EXISTS. Several of the synth-source settings the voice editor is about to
 * expose have no documented range: the Tone.js pages that document them give a `Min:`
 * and `Max:` for some properties and deliberately give none for others, on the same
 * page. A `slider` cannot render those without someone inventing the bounds, and an
 * invented bound is indistinguishable in the UI from a real one — the user then tunes
 * against a fence that does not exist. So this control has no fence: it spins forever
 * in both directions and steps by a fixed increment, and the real limits get found by
 * ear during QA and only then become a `SliderParam`.
 *
 * WHY IT IS NOT `role="slider"`. ARIA 1.2 gives `slider` an implicit `aria-valuemin` of
 * 0 and `aria-valuemax` of 100 when the attributes are absent, so omitting them does not
 * say "unbounded" — it says "0 to 100", and a screen reader announces a percentage that
 * is a fabrication. `spinbutton` is the role whose spec states that `aria-valuemin` /
 * `aria-valuemax` are "not needed" when the widget has no minimum or maximum, and whose
 * expected keys (arrows to step, Page keys to step larger) are exactly this gesture set.
 * Hence spinbutton, `aria-valuenow` + `aria-valuetext`, and NO min/max attribute at all.
 * The task brief asked for slider semantics minus `aria-valuemax`; that combination
 * would have been the fabrication above, so this is the deviation and this is the why.
 * The role's one overreach is that it is an input-category role, so a screen reader
 * offers to type into a dial that takes no typing. An `<input type="number">` with no
 * min/max would carry the role natively AND accept a typed value — worth doing, but it
 * is a different control from the one the pane's other four are, and typed entry is a
 * pane-wide affordance (`Knob` and `ParamSlider` have not got it either) rather than
 * this control's alone. Not `aria-readonly`: it is not read-only, it is not typeable.
 *
 * WHY THE MATHS IS RELATIVE, not snapped to a grid. `Knob` quantises to `min + n*step`
 * because it has an origin to quantise against. This has none, so every result is
 * `startValue ± n*step`: an authored value sitting off the step grid (Tone's shipped
 * `harmonicity` need not be a multiple of our increment) is *carried*, not silently
 * dragged onto a grid by the first touch. That is also how real hardware behaves —
 * an encoder reports movement, not position.
 *
 * WHY IT LOOKS LIKE THIS. An endless encoder has no end stops, so the tick ring runs the
 * full 360° with no gap — that unbroken ring is the whole visual claim, against `Knob`'s
 * 270° sweep with a lit arc showing "how far along". There is no "how far along" here,
 * so nothing is arc-lit: one brass detent marks where the shaft currently sits and it
 * wraps past 12 o'clock without stopping. The cap is knurled rather than pointed,
 * because a pointer implies an absolute position this control does not have — so the
 * notch sits inside the knurl band, as one flute of it catching the light rather than as
 * a needle reaching for a scale. Materials, tokens and `--encoder-*` hooks follow `Knob`.
 *
 * WHY SHIFT MEANS COARSE, on every gesture. `Knob` reads Shift as "finer", because a
 * knob's drag maps 100px onto a whole range and there are values between the pixels to
 * reach. Here the increment is the atom: a finer drag could only reach values the arrow
 * keys never can, so Shift instead multiplies by `KEY_MULTIPLIER` on drag, wheel and
 * keys alike. It has to, because unbounded exploration is this control's job — at 8px a
 * detent, walking `harmonicity` from 1 to 10 at step 0.1 is 720px of plain drag.
 *
 * NOT SHARED WITH `Knob` — deliberately, and this is a debt not a design. The drag
 * transport (window listeners filtered on `pointerId`, the abort-on-unmount ref, the
 * non-passive wheel listener) is the same plumbing solved the same way, and it wants to
 * be one `usePointerSpin` hook. Extracting it means editing `Knob.tsx`, which is outside
 * this change's remit; the seam to lift is `handlePointerDown` + the two effects, and the
 * only real difference is that this one converts pixels to DETENTS while `Knob` converts
 * pixels to a FRACTION of its span. Tracked in `docs/FOLLOW-UPS.md` §5, with the third
 * copy in `rack/CabinetGraphic.tsx` and with `Knob`'s stale-closure defect, which this
 * file fixes for itself (see `latest`) and therefore now differs on.
 */
import { useCallback, useEffect, useId, useRef } from 'react';
import { DETENTS, detentIndexOf, tidy } from './encoderMath';

const DEFAULT_SIZE = 56; // px — matches `Knob`, so mixed racks line up
const DRAG_PX_PER_DETENT = 8; // px of vertical drag per increment
const KEY_MULTIPLIER = 10; // Shift multiplies every gesture; PageUp/Down are always this

/**
 * Exactly an `encoder` row of the control table (`path`, `label`, `step`, `precision`,
 * optional `unit`, `fallback`) plus the two things the table cannot know. Spreading a
 * descriptor over this compiles: extra descriptor keys (`kind`, `optional`,
 * `rebuildsVoice`) are not excess-property-checked through a spread.
 */
export interface ParamEncoderProps {
  /**
   * The descriptor's dotted preset path. Accepted so a row spreads in without an adapter;
   * never read here — the pane owns the write. Optional because only the row supplies it.
   */
  path?: string;
  /** Engraved under the cap, and the control's accessible name unless
   *  {@link ParamEncoderProps.ariaLabel} overrides it. */
  label: string;
  /**
   * Overrides the engraving as the accessible name. Same job, same reason as
   * `ParamToggle.ariaLabel`: a descriptor generated under two branches puts two
   * spinbuttons called "Harmonicity" in one pane, and the enclosing
   * `role="group"` does NOT contribute its name to a descendant's — it is
   * announced on entering the group, not on the control.
   */
  ariaLabel?: string;
  value: number;
  /** The increment. One detent, one arrow press, one wheel notch. */
  step: number;
  /** Decimal places in the readout and in `aria-valuetext`. */
  precision: number;
  /** Suffix on the readout — `Hz`, `dB`, `×`. */
  unit?: string;
  /**
   * The value the descriptor declares for an absent path. Used here as the
   * double-click reset target, which is `Knob`'s `defaultValue` under the descriptor's
   * own name — the pane passes the same number to both.
   */
  fallback: number;
  onChange(next: number): void;
  /** Outer SVG dimension in px. */
  size?: number;
  disabled?: boolean;
}

export function ParamEncoder({
  label,
  ariaLabel,
  value,
  step,
  precision,
  unit,
  fallback,
  onChange,
  size = DEFAULT_SIZE,
  disabled = false,
}: ParamEncoderProps) {
  // Sanitised for the same reason `Knob` sanitises: interpolated into unquoted
  // `url(#…)` fragments, which cannot carry a colon.
  const uid = useId().replace(/:/g, '');
  const labelId = `${uid}-label`;
  const dialRef = useRef<HTMLDivElement | null>(null);
  /** Tears down the in-flight drag, so unmounting mid-gesture doesn't leak listeners. */
  const abortDrag = useRef<(() => void) | null>(null);
  /**
   * The value the NEXT gesture starts from, which is not always the `value` prop. A
   * wheel handler is a native listener, so its `onChange` runs at React's default
   * priority and the re-render can lag a burst of trackpad events — every one of which
   * would otherwise read the same stale prop and emit the same single step. Written on
   * every emit, and re-synced from the prop on every render so an outside change (a
   * preset swap, a parent that refuses the write) still wins. `Knob` reads the prop
   * directly and drops those steps; that is the divergence the header names.
   */
  const latest = useRef(value);
  latest.current = value;

  // NO CLAMP ANYWHERE IN THIS FILE. That is the feature. If a `Math.min`/`Math.max` on
  // the value ever appears here, `ParamEncoder.test.tsx`'s "never clamps" cases fail.
  const spin = useCallback(
    (from: number, detents: number) => tidy(from + detents * step),
    [step],
  );

  /**
   * The current `onChange`, held in a ref so `emit` below can be stable.
   *
   * Both renderers of this control pass a fresh arrow per render (`onChange={(value) =>
   * commit(setAtPath(preset, path, value))}` — it closes over `preset`, so it HAS to be
   * fresh). Depending on it directly made `emit` a new function every render, which made
   * the wheel effect re-run every render: thirteen encoders per FM rack, up to eight
   * racks, tearing down and re-adding a native listener on every keystroke in the pane.
   * Read through the ref instead and the effect keys on `disabled` and `step` alone.
   */
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  /** Every emit goes through here, so `latest` can never fall behind what was sent. */
  const emit = useCallback((next: number) => {
    latest.current = next;
    onChangeRef.current(next);
  }, []);

  const formatted = `${value.toFixed(precision)}${unit ? ` ${unit}` : ''}`;

  const detentIndex = detentIndexOf(value, step);
  const angle = detentIndex * (360 / DETENTS);

  /**
   * Drag transport is `window` listeners rather than pointer capture: it is what
   * `Knob`, `Timeline` and `CabinetGraphic` already do, and jsdom implements no pointer
   * capture, so a captured drag would be untestable here. The handlers therefore filter
   * on `pointerId` themselves, or a second finger anywhere on the page steers this one.
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
      const startValue = latest.current;
      let lastDetents = 0;

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const dy = startY - ev.clientY; // up = increase
        // `Math.abs` then re-signed, because `Math.round` breaks ties towards +∞: a
        // plain `Math.round(dy / 8)` steps on 4px up and stays silent on 4px down, so
        // the dial's threshold would depend on which way it is turned.
        const detents =
          Math.sign(dy) *
          Math.round(Math.abs(dy) / DRAG_PX_PER_DETENT) *
          (ev.shiftKey ? KEY_MULTIPLIER : 1);
        // Absolute from the gesture's origin, not incremental: a re-render mid-drag
        // must not compound, and a coarse step would otherwise emit the same number
        // dozens of times per gesture.
        if (detents === lastDetents) return;
        lastDetents = detents;
        emit(spin(startValue, detents));
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
    [disabled, emit, spin],
  );

  useEffect(() => () => abortDrag.current?.(), []);

  // `onMove` closes over the `disabled` of its pointerdown, so a pane that disables the
  // encoder mid-gesture would keep taking drag input until the button came up.
  useEffect(() => {
    if (disabled) abortDrag.current?.();
  }, [disabled]);

  // React attaches `wheel` at the root as passive, so `onWheel` cannot preventDefault
  // and the page would scroll under the cursor while the encoder turned. Hence a native
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
      emit(spin(latest.current, direction * mult));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // Not keyed on `value`, and `emit` is stable (see `onChangeRef`), so the listener is
    // not torn down and re-added on every step of a spin — nor on every render of the
    // pane around it, which is what a fresh `onChange` in the deps used to cost.
  }, [disabled, emit, spin]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      const detents = e.shiftKey ? KEY_MULTIPLIER : 1;
      // preventDefault on all four: PageUp/PageDown scroll the pane out from under the
      // dial, and the arrows scroll it too once the pane is taller than the viewport.
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
        e.preventDefault();
        emit(spin(latest.current, detents));
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
        e.preventDefault();
        emit(spin(latest.current, -detents));
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        emit(spin(latest.current, KEY_MULTIPLIER));
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        emit(spin(latest.current, -KEY_MULTIPLIER));
      }
      // Home/End are deliberately unhandled. Both `Knob` and the native range in
      // `ParamSlider` answer them with min/max, and there is no min or max here —
      // binding them to anything else would give one gesture two meanings across two
      // renderers of the same pane. Double-click is the reset.
    },
    [disabled, emit, spin],
  );

  const handleDoubleClick = useCallback(() => {
    if (disabled) return;
    // Verbatim, not stepped: an authored fallback is what the descriptor declares the
    // reset target to be, even when it sits off this control's increment.
    emit(fallback);
  }, [disabled, emit, fallback]);

  // ---------------------------------------------------------------- geometry ---
  const c = size / 2;
  const ringR = c - 1; // outer end of the ticks
  const tickLen = size * 0.09;
  const socketR = size * 0.36; // the recess — wide enough that the cap's shadow lands in it
  const capR = size * 0.315; // the raised cap inside it
  const knurlCount = 16;
  const polar = (r: number, deg: number) => {
    // SVG measures from +X; 12 o'clock is the dial's zero, hence the -90°.
    const rad = ((deg - 90) * Math.PI) / 180;
    return [c + r * Math.cos(rad), c + r * Math.sin(rad)] as const;
  };
  // The lit flute sits ON the knurl band (0.72 → 0.97), not reaching in towards the
  // centre: a line running from the hub outwards is read as a pointer at a position,
  // and this control has no position to point at.
  const [nx1, ny1] = polar(capR * 0.72, angle);
  const [nx2, ny2] = polar(capR * 0.97, angle);

  return (
    <div className="inline-flex select-none flex-col items-center gap-1">
      <div
        ref={dialRef}
        role="spinbutton"
        tabIndex={disabled ? -1 : 0}
        // Exclusive, not additive: `aria-labelledby` outranks `aria-label` in the
        // name computation, so the two cannot both be set — the same choice
        // `ParamToggle` makes and for the same reason.
        {...(ariaLabel ? { 'aria-label': ariaLabel } : { 'aria-labelledby': labelId })}
        aria-valuenow={value}
        // No aria-valuemin / aria-valuemax: see the header. Their ABSENCE is the
        // statement, and on `spinbutton` it is a legal one.
        aria-valuetext={formatted}
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
              <stop offset="0%" stopColor="var(--encoder-cap-hi, var(--color-raise-hi))" />
              <stop offset="100%" stopColor="var(--encoder-cap, var(--color-raise))" />
            </linearGradient>
            {/* …and the socket's is at the bottom, which is what makes it read sunken. */}
            <linearGradient id={`${uid}-socket`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--encoder-socket, var(--color-rim-dark))" />
              <stop offset="100%" stopColor="var(--encoder-socket-hi, var(--color-rim))" />
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

          {/* The full 360° detent ring — no gap, because there is no end stop. Exactly
              one tick is brass: where the shaft is, not how far along it is. */}
          <g>
            {Array.from({ length: DETENTS }, (_, i) => {
              const deg = i * (360 / DETENTS);
              const [x1, y1] = polar(ringR, deg);
              const [x2, y2] = polar(ringR - tickLen, deg);
              const active = i === detentIndex;
              return (
                <line
                  key={i}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={
                    active
                      ? 'var(--encoder-tick-active, var(--color-brass))'
                      : 'var(--encoder-tick, var(--color-line))'
                  }
                  strokeWidth={active ? 1.5 : 1}
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
            stroke="var(--encoder-edge, var(--color-rim-dark))"
            strokeWidth={1}
          />
          <circle
            cx={c}
            cy={c}
            r={capR}
            fill={`url(#${uid}-cap)`}
            stroke="var(--encoder-edge, var(--color-rim-dark))"
            strokeWidth={1}
            filter={`url(#${uid}-lift)`}
          />

          {/* Knurling. It turns with the value, so a spin past the ring's wrap point is
              still visibly a spin — which is the one thing a bounded dial never needs
              to show and this one always does. */}
          <g opacity="0.55">
            {Array.from({ length: knurlCount }, (_, i) => {
              const deg = angle + i * (360 / knurlCount);
              const [x1, y1] = polar(capR * 0.72, deg);
              const [x2, y2] = polar(capR * 0.97, deg);
              return (
                <line
                  key={i}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke="var(--encoder-knurl, var(--color-rim-dark))"
                  strokeWidth={0.75}
                  strokeLinecap="round"
                />
              );
            })}
          </g>
          <circle cx={c} cy={c} r={capR - 0.5} fill="none" stroke={`url(#${uid}-gloss)`} strokeWidth={1} />

          {/* A notch, not a pointer: it reads as one flute of the knurl catching the
              light rather than as an absolute-position indicator. */}
          <line
            x1={nx1}
            y1={ny1}
            x2={nx2}
            y2={ny2}
            stroke="var(--encoder-notch, var(--color-brass-hi))"
            strokeWidth={Math.max(1.5, size * 0.036)}
            strokeLinecap="round"
          />
        </svg>
      </div>

      {/* Type scales with `size` for the same reason `Knob`'s does: at a fixed 9px a
          small dial's label is wider than the dial and sets the column width. */}
      <span
        id={labelId}
        style={{ fontSize: size * 0.16 }}
        className="font-mono tracking-[0.1em] text-ink-mut uppercase"
      >
        {label}
      </span>
      {/* aria-hidden: `aria-valuetext` already announces exactly this string. */}
      <span aria-hidden style={{ fontSize: size * 0.18 }} className="font-mono tabular-nums text-ink">
        {value.toFixed(precision)}
        {unit ? <span className="ml-0.5 text-ink-mut">{unit}</span> : null}
      </span>
    </div>
  );
}
