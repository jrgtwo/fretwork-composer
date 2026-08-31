/**
 * ParamEncoder's behaviour.
 *
 * jsdom implements no layout, and a drag here needs none: the component reads `clientY`
 * off the pointer events and these tests supply those numbers directly. So the drag
 * maths IS assertable — only rendered geometry is not, and the SVG is `aria-hidden`
 * decoration precisely so nothing depends on measuring it. The one thing the SVG is
 * asserted for is WHICH tick is brass, which is an attribute, not a position.
 *
 * Genuinely unanswerable here, and therefore not asserted: whether the wheel's
 * `preventDefault` actually suppresses anything (jsdom has no scrolling), and whether the
 * encoder *feels* like a detented shaft, which is the only test that finally matters and
 * is a QA-by-ear one.
 *
 * The centre of gravity is `never clamps`. Those cases were mutation-checked — see the
 * comment on that block for exactly how.
 *
 * A note on the shape of the rest: where a test drives two gestures in a row it renders
 * `Spun`, which holds its own value, because the component now carries the emitted value
 * forward in a ref (a wheel burst must not read one stale prop 20 times). A spy-only
 * encoder is frozen at its prop, so a second gesture on one would be asserting against a
 * state no real parent produces.
 */
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ParamEncoder, type ParamEncoderProps } from './ParamEncoder';
import { detentIndexOf } from './encoderMath';

/** An encoder wired to a spy, with the props an `encoder` row would supply. */
function setup(overrides: Partial<ParamEncoderProps> = {}) {
  const onChange = vi.fn();
  const user = userEvent.setup();
  const props: ParamEncoderProps = {
    label: 'Harmonicity',
    value: 3,
    step: 0.1,
    precision: 2,
    fallback: 1,
    onChange,
    ...overrides,
  };
  const { container, unmount, rerender } = render(<ParamEncoder {...props} />);
  return {
    onChange,
    user,
    container,
    unmount,
    rerender: (next: Partial<ParamEncoderProps>) =>
      rerender(<ParamEncoder {...props} {...next} />),
    // Scoped to this render, not to `screen`: two encoders in one document is a
    // legitimate case here (a test comparing two configurations) and a document-wide
    // role query would report an ambiguity instead of the behaviour under test.
    dial: within(container).getByRole('spinbutton', { name: props.label }),
  };
}

/**
 * jsdom ships no `PointerEvent`, so `fireEvent.pointerDown` degrades to a bare `Event`
 * and silently drops `pointerId`/`clientY`. A `MouseEvent` carries the coordinates and
 * React reads `pointerId` straight off the native event — what user-event does too.
 */
function pointerEvent(
  type: string,
  init: { pointerId?: number; clientY?: number; button?: number; shiftKey?: boolean } = {},
) {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientY: init.clientY ?? 0,
    button: init.button ?? 0,
    shiftKey: init.shiftKey ?? false,
  });
  Object.defineProperty(ev, 'pointerId', { value: init.pointerId ?? 1 });
  return ev;
}

/**
 * Press, move `dy` pixels (positive = upward = increase), release. Expressed as a
 * delta rather than as coordinates because the component only ever reads the
 * difference — and because a 2000px downward drag written as absolute clientY values
 * is a test that fails when someone changes the arbitrary start point.
 *
 * ONE move per gesture, deliberately: a multi-move gesture is a different property and
 * has its own cases below, which is exactly the hole a single-move helper leaves.
 */
const DRAG_ORIGIN_Y = 4000;
function drag(dial: HTMLElement, dy: number, { shiftKey = false }: { shiftKey?: boolean } = {}) {
  const toY = DRAG_ORIGIN_Y - dy;
  fireEvent(dial, pointerEvent('pointerdown', { clientY: DRAG_ORIGIN_Y }));
  fireEvent(window, pointerEvent('pointermove', { clientY: toY, shiftKey }));
  fireEvent(window, pointerEvent('pointerup', { clientY: toY }));
}

/** Press, then move to each `dy` in turn without releasing, then release at the last. */
function dragThrough(dial: HTMLElement, ...dys: number[]) {
  fireEvent(dial, pointerEvent('pointerdown', { clientY: DRAG_ORIGIN_Y }));
  for (const dy of dys) {
    fireEvent(window, pointerEvent('pointermove', { clientY: DRAG_ORIGIN_Y - dy }));
  }
  fireEvent(window, pointerEvent('pointerup', { clientY: DRAG_ORIGIN_Y - dys[dys.length - 1] }));
}

/** The single value the spy was called with. Fails loudly on 0 or 2+ calls. */
const onlyCall = (onChange: ReturnType<typeof vi.fn>) => {
  expect(onChange).toHaveBeenCalledTimes(1);
  return onChange.mock.calls[0][0] as number;
};

/**
 * A self-contained encoder that keeps its own value, so a gesture ACCUMULATES the way
 * it does in the pane. A spy-only encoder is frozen at its prop and can never show that
 * the control passes a bound — which is the thing these tests exist to prove.
 */
function Spun({ start, step = 1, precision = 1 }: { start: number; step?: number; precision?: number }) {
  const [value, setValue] = useState(start);
  return (
    <ParamEncoder
      label="Harmonicity"
      value={value}
      step={step}
      precision={precision}
      fallback={start}
      onChange={setValue}
    />
  );
}

const spun = () => screen.getByRole('spinbutton', { name: 'Harmonicity' });
/** The announced value. `valueNow`, not `readout`: the visible text is asserted too. */
const valueNow = () => Number(spun().getAttribute('aria-valuenow'));

describe('ParamEncoder', () => {
  /**
   * The whole point of the props being what they are: the control table maps an
   * `encoder` row onto this with no per-parameter knowledge and no adapter. The spread
   * is the assertion — if the prop names drift from the row's, this stops compiling.
   */
  it('takes its props straight from an encoder row descriptor', () => {
    const row = {
      path: 'source.params.harmonicity',
      label: 'Harmonic',
      step: 0.25,
      precision: 2,
      unit: '×',
      fallback: 1,
    } as const;

    render(<ParamEncoder {...row} value={3.5} onChange={vi.fn()} />);

    const dial = screen.getByRole('spinbutton', { name: 'Harmonic' });
    expect(dial).toHaveAttribute('aria-valuenow', '3.5');
    expect(dial).toHaveAttribute('aria-valuetext', '3.50 ×');
  });

  describe('accessibility', () => {
    it('takes its accessible name from the engraved label, not from a duplicate string', () => {
      // `aria-labelledby` rather than `aria-label`, so the name a screen reader reads and
      // the text on screen cannot drift apart.
      const { dial } = setup({ label: 'Detune' });
      const engraved = screen.getByText('Detune');
      expect(dial.getAttribute('aria-labelledby')).toBe(engraved.id);
      expect(engraved.id).not.toBe('');
    });

    /**
     * The reason the role is `spinbutton` and not `slider`. ARIA 1.2 gives `slider` an
     * implicit valuemin of 0 and valuemax of 100, so a bounded role with the attributes
     * omitted announces a fabricated percentage rather than "no limit". Asserting their
     * ABSENCE is asserting that nobody has quietly reintroduced a range.
     */
    it('declares no minimum and no maximum', () => {
      const { dial } = setup();
      expect(dial).not.toHaveAttribute('aria-valuemin');
      expect(dial).not.toHaveAttribute('aria-valuemax');
      expect(dial).toHaveAttribute('role', 'spinbutton');
    });

    // `Knob` has to clamp valuenow because ARIA forbids it outside the bounds. With no
    // bounds there is nothing to clamp against and nothing to hide. Two cases, two
    // renders: a failed assertion between them would otherwise leave two encoders in one
    // document and the role query would report an ambiguity instead of the real failure.
    it('reports a value far above any bound a slider would have had', () => {
      expect(setup({ value: 9999 }).dial).toHaveAttribute('aria-valuenow', '9999');
    });

    it('reports a value far below zero', () => {
      expect(setup({ value: -9999 }).dial).toHaveAttribute('aria-valuenow', '-9999');
    });

    it('is not focusable when disabled', () => {
      expect(setup({ disabled: true }).dial).toHaveAttribute('tabindex', '-1');
    });
  });

  describe('readout', () => {
    it('renders the value at the declared precision', () => {
      const { dial } = setup({ value: 2, precision: 3 });
      expect(screen.getByText('2.000')).toBeInTheDocument();
      expect(dial).toHaveAttribute('aria-valuetext', '2.000');
    });

    it('rounds a longer value down to the declared precision', () => {
      setup({ value: 1.23456, precision: 2 });
      expect(screen.getByText('1.23')).toBeInTheDocument();
    });

    it('shows an integer precision with no decimal point', () => {
      setup({ value: 440.6, precision: 0 });
      expect(screen.getByText('441')).toBeInTheDocument();
    });

    it('appends the unit, and announces it in the value text', () => {
      const { dial } = setup({ value: 12, precision: 1, unit: 'Hz' });
      expect(screen.getByText('Hz')).toBeInTheDocument();
      expect(dial).toHaveAttribute('aria-valuetext', '12.0 Hz');
    });
  });

  /**
   * The brass tick. It is the encoder's only feedback that a spin past the ring's wrap
   * point is still a spin, and it is `aria-hidden` decoration, so nothing else in the
   * suite can notice if it goes out. `detentIndexOf` is exported for that reason: the
   * wrap is asserted as arithmetic, and one DOM case pins the wiring.
   */
  describe('detent ring', () => {
    it('indexes a positive value onto the ring', () => {
      expect(detentIndexOf(0, 0.1)).toBe(0);
      expect(detentIndexOf(0.1, 0.1)).toBe(1);
      expect(detentIndexOf(3, 0.1)).toBe(6); // 30 detents, wrapped once past 24
    });

    it('wraps a negative value onto the ring rather than off the front of it', () => {
      expect(detentIndexOf(-0.1, 0.1)).toBe(23);
      expect(detentIndexOf(-2.4, 0.1)).toBe(0); // exactly one turn down
      expect(detentIndexOf(-2.5, 0.1)).toBe(23);
    });

    it('returns a positive zero for the values Math.round sends to -0', () => {
      // `Math.round` breaks ties towards +∞, so everything in (-0.5, 0] rounds to `-0`
      // — and `-0` compared against a tick index matches nothing, lighting no tick.
      expect(Object.is(detentIndexOf(-0.04, 0.1), 0)).toBe(true);
      expect(Object.is(detentIndexOf(-0.05, 0.1), 0)).toBe(true); // -0.5 rounds to -0
      expect(detentIndexOf(-0.06, 0.1)).toBe(23); // the first tick below zero
    });

    it('has no ring to index onto when the step is meaningless', () => {
      expect(detentIndexOf(5, 0)).toBe(0);
      expect(detentIndexOf(5, -1)).toBe(0);
    });

    const activeTicks = (container: HTMLElement) =>
      [...container.querySelectorAll('line')].filter((l) =>
        (l.getAttribute('stroke') ?? '').includes('encoder-tick-active'),
      );

    it('lights exactly one tick, at a negative value as well as a positive one', () => {
      expect(activeTicks(setup({ value: 25, step: 1 }).container)).toHaveLength(1);
      expect(activeTicks(setup({ value: -5, step: 1 }).container)).toHaveLength(1);
    });
  });

  describe('keyboard', () => {
    it.each(['{ArrowUp}', '{ArrowRight}'])('steps up by one increment on %s', async (key) => {
      const { user, onChange, dial } = setup({ value: 3, step: 0.1 });
      dial.focus();
      await user.keyboard(key);
      expect(onlyCall(onChange)).toBe(3.1);
    });

    it.each(['{ArrowDown}', '{ArrowLeft}'])('steps down by one increment on %s', async (key) => {
      const { user, onChange, dial } = setup({ value: 3, step: 0.1 });
      dial.focus();
      await user.keyboard(key);
      expect(onlyCall(onChange)).toBe(2.9);
    });

    it('multiplies the increment by ten while Shift is held', async () => {
      const { user, onChange, dial } = setup({ value: 3, step: 0.1 });
      dial.focus();
      await user.keyboard('{Shift>}{ArrowUp}{/Shift}');
      expect(onlyCall(onChange)).toBe(4);
    });

    it('pages up by ten increments, matching Knob and the native range in ParamSlider', async () => {
      const { user, onChange, dial } = setup({ value: 3, step: 0.1 });
      dial.focus();
      await user.keyboard('{PageUp}');
      expect(onlyCall(onChange)).toBe(4);
    });

    it('pages down by ten increments', async () => {
      const { user, onChange, dial } = setup({ value: 3, step: 0.1 });
      dial.focus();
      await user.keyboard('{PageDown}');
      expect(onlyCall(onChange)).toBe(2);
    });

    it.each(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'])(
      'consumes %s so the pane does not scroll under the dial',
      (key) => {
        // `fireEvent` returns false when a handler called preventDefault. Without it,
        // PageDown scrolls the voice pane away while the encoder turns.
        const { dial } = setup();
        expect(fireEvent.keyDown(dial, { key })).toBe(false);
      },
    );

    it('leaves Home and End alone, because there is no bound for them to mean', async () => {
      // On `Knob` and on the native range they jump to min/max. Binding them to
      // anything else here would give one key two meanings across two renderers of the
      // same pane, so this control simply does not answer them.
      const { user, onChange, dial } = setup();
      dial.focus();
      await user.keyboard('{Home}{End}');
      expect(onChange).not.toHaveBeenCalled();
      expect(fireEvent.keyDown(dial, { key: 'Home' })).toBe(true);
    });

    it('ignores keys it does not own', async () => {
      const { user, onChange, dial } = setup();
      dial.focus();
      await user.keyboard('{Enter} {Escape}');
      expect(onChange).not.toHaveBeenCalled();
    });

    it('emits a value free of binary-float debris', async () => {
      // 0.2 + 0.1 is 0.30000000000000004 without the rounding, and that number goes
      // straight into the preset where `toFixed` in the readout would never show it.
      const { user, onChange, dial } = setup({ value: 0.2, step: 0.1 });
      dial.focus();
      await user.keyboard('{ArrowUp}');
      expect(onlyCall(onChange)).toBe(0.3);
    });

    it('carries a value that sits off the increment grid', async () => {
      // The difference between an encoder and a slider: `Knob` would snap 1.53 onto its
      // min+n*step grid on the first touch, silently rewriting an authored preset value.
      // This adds to what is there.
      const { user, onChange, dial } = setup({ value: 1.53, step: 0.1 });
      dial.focus();
      await user.keyboard('{ArrowUp}');
      expect(onlyCall(onChange)).toBe(1.63);
    });

    it('advances every press of a burst that arrives before the re-render', () => {
      // Key repeat, and the same hazard the wheel case below covers: the handler must
      // step from what it last EMITTED, not from a prop that has not come back yet. The
      // spy never feeds a value back, which is precisely the frozen-prop condition.
      const { onChange, dial } = setup({ value: 3, step: 0.1 });
      fireEvent.keyDown(dial, { key: 'ArrowUp' });
      fireEvent.keyDown(dial, { key: 'ArrowUp' });
      fireEvent.keyDown(dial, { key: 'ArrowUp' });
      expect(onChange.mock.calls.map((c) => c[0])).toEqual([3.1, 3.2, 3.3]);
    });

    it('re-syncs to the prop when the value changes from outside', () => {
      // The other half of that ref: a preset swap, or an agent write, must not be
      // stepped over. A render with a new value is what puts the dial back on it.
      const { onChange, dial, rerender } = setup({ value: 3, step: 0.1 });
      fireEvent.keyDown(dial, { key: 'ArrowUp' });
      rerender({ value: 8 });
      fireEvent.keyDown(dial, { key: 'ArrowUp' });
      expect(onChange).toHaveBeenLastCalledWith(8.1);
    });
  });

  describe('wheel', () => {
    it('increases on wheel up', () => {
      const { onChange, dial } = setup({ value: 3, step: 0.1 });
      fireEvent.wheel(dial, { deltaY: -100 });
      expect(onlyCall(onChange)).toBe(3.1);
    });

    it('decreases on wheel down', () => {
      const { onChange, dial } = setup({ value: 3, step: 0.1 });
      fireEvent.wheel(dial, { deltaY: 100 });
      expect(onlyCall(onChange)).toBe(2.9);
    });

    it('multiplies by ten with Shift', () => {
      const { onChange, dial } = setup({ value: 3, step: 0.1 });
      fireEvent.wheel(dial, { deltaY: -100, shiftKey: true });
      expect(onlyCall(onChange)).toBe(4);
    });

    it('ignores a horizontal trackpad swipe', () => {
      const { onChange, dial } = setup({ value: 3, step: 0.1 });
      fireEvent.wheel(dial, { deltaX: -100, deltaY: 0 });
      expect(onChange).not.toHaveBeenCalled();
    });

    it('advances every notch of a burst that arrives before the re-render', () => {
      // The wheel listener is native, so its update runs at React's default priority and
      // a trackpad burst can outrun the commit. Reading the prop each time turns twenty
      // notches into one step — the failure is silent and looks like a sticky dial.
      const { onChange, dial } = setup({ value: 3, step: 0.1 });
      fireEvent.wheel(dial, { deltaY: -100 });
      fireEvent.wheel(dial, { deltaY: -100 });
      fireEvent.wheel(dial, { deltaY: -100 });
      expect(onChange.mock.calls.map((c) => c[0])).toEqual([3.1, 3.2, 3.3]);
    });
  });

  describe('drag', () => {
    it('spins up as the pointer rises', () => {
      const { onChange, dial } = setup({ value: 3, step: 0.1 });
      drag(dial, 8 * 5); // five detents up
      expect(onlyCall(onChange)).toBe(3.5);
    });

    it('spins down as the pointer falls', () => {
      const { onChange, dial } = setup({ value: 3, step: 0.1 });
      drag(dial, -8 * 5);
      expect(onlyCall(onChange)).toBe(2.5);
    });

    it('costs a fixed number of pixels per increment', () => {
      // 8px per detent. A third of a detent's travel is still zero detents, and the
      // control must stay silent rather than emit its own value back — a no-op onChange
      // marks the preset dirty (`presetPaths` returns the same reference for an
      // unchanged write precisely so that does not happen).
      const { onChange, dial } = setup({ value: 3, step: 0.1 });
      drag(dial, 3);
      expect(onChange).not.toHaveBeenCalled();

      drag(dial, 8);
      expect(onlyCall(onChange)).toBe(3.1);
    });

    it('crosses the half-detent threshold at the same distance in both directions', () => {
      // `Math.round` breaks ties towards +∞, so a naive `Math.round(dy / 8)` steps on
      // 4px up and does nothing on 4px down — a dial that is stiffer one way round.
      const up = setup({ value: 3, step: 0.1 });
      drag(up.dial, 4);
      expect(onlyCall(up.onChange)).toBe(3.1);

      const down = setup({ value: 3, step: 0.1 });
      drag(down.dial, -4);
      expect(onlyCall(down.onChange)).toBe(2.9);
    });

    it('multiplies each detent by ten while Shift is held', () => {
      // Shift is COARSE here, not fine, and means the same thing on all three gestures.
      // A finer drag could only reach values between the increments, which no keypress
      // could reproduce; what an unbounded control actually needs is to cover ground.
      const { onChange, dial } = setup({ value: 3, step: 0.1 });
      drag(dial, 8 * 3, { shiftKey: true }); // three detents × 10
      expect(onlyCall(onChange)).toBe(6);
    });

    it('measures from where the gesture started, so moves do not compound', () => {
      // Every move recomputes from the press origin. Accumulating instead would turn a
      // 40px drag delivered in five moves into 1+2+3+4+5 detents, and the dial would run
      // away under the finger — invisible to any single-move test.
      render(<Spun start={0} step={1} />);
      dragThrough(spun(), 8, 16, 24);
      expect(valueNow()).toBe(3);
    });

    it('follows the pointer back down within one gesture', () => {
      render(<Spun start={0} step={1} />);
      dragThrough(spun(), 80, -80);
      expect(valueNow()).toBe(-10);
    });

    it('ignores a press that is not the primary button', () => {
      // A right-click opens a context menu; it must not also start a spin that the
      // matching pointerup never ends.
      const { onChange, dial } = setup({ value: 3, step: 0.1 });
      fireEvent(dial, pointerEvent('pointerdown', { clientY: 200, button: 2 }));
      fireEvent(window, pointerEvent('pointermove', { clientY: 100 }));
      expect(onChange).not.toHaveBeenCalled();
    });

    it('ignores a second pointer during a gesture', () => {
      const { onChange, dial } = setup({ value: 3, step: 0.1 });
      fireEvent(dial, pointerEvent('pointerdown', { pointerId: 1, clientY: 200 }));
      fireEvent(window, pointerEvent('pointermove', { pointerId: 2, clientY: 100 }));
      expect(onChange).not.toHaveBeenCalled();

      fireEvent(window, pointerEvent('pointermove', { pointerId: 1, clientY: 192 }));
      expect(onlyCall(onChange)).toBe(3.1);
    });

    it('stops taking input after the pointer comes up', () => {
      const { onChange, dial } = setup({ value: 3, step: 0.1 });
      drag(dial, 8);
      onChange.mockClear();
      fireEvent(window, pointerEvent('pointermove', { clientY: 0 }));
      expect(onChange).not.toHaveBeenCalled();
    });

    it('stops taking input after the pointer is cancelled', () => {
      // A touch can be taken away by the OS with no pointerup at all — a system gesture,
      // a palm rejection. Without the pointercancel listener those window listeners live
      // for the rest of the session and every later move turns the dial.
      const { onChange, dial } = setup({ value: 3, step: 0.1 });
      fireEvent(dial, pointerEvent('pointerdown', { clientY: 200 }));
      fireEvent(window, pointerEvent('pointercancel', { clientY: 200 }));
      fireEvent(window, pointerEvent('pointermove', { clientY: 100 }));
      expect(onChange).not.toHaveBeenCalled();
    });

    it('lets go of the window when unmounted mid-gesture', () => {
      const { onChange, dial, unmount } = setup({ value: 3, step: 0.1 });
      fireEvent(dial, pointerEvent('pointerdown', { clientY: 200 }));
      unmount();
      fireEvent(window, pointerEvent('pointermove', { clientY: 100 }));
      expect(onChange).not.toHaveBeenCalled();
    });

    it('lets go of the window when a second press replaces the gesture', () => {
      // `abortDrag` holds ONE closure. A second press that does not first call it leaves
      // the previous gesture's listeners with nothing left to tear them down, so they
      // outlive the unmount.
      const { onChange, dial, unmount } = setup({ value: 3, step: 0.1 });
      fireEvent(dial, pointerEvent('pointerdown', { clientY: 200 }));
      fireEvent(dial, pointerEvent('pointerdown', { clientY: 200 }));
      unmount();
      fireEvent(window, pointerEvent('pointermove', { clientY: 100 }));
      expect(onChange).not.toHaveBeenCalled();
    });

    it('lets go of the window when the pane disables it mid-gesture', () => {
      // `onMove` closed over the `disabled` of its pointerdown, so without the abort
      // effect a control that has just been disabled keeps taking drag input until the
      // button comes up.
      const { onChange, dial, rerender } = setup({ value: 3, step: 0.1 });
      fireEvent(dial, pointerEvent('pointerdown', { clientY: 200 }));
      rerender({ disabled: true });
      fireEvent(window, pointerEvent('pointermove', { clientY: 100 }));
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  /**
   * THE FEATURE, and mutation-checked rather than assumed. Two clamps were put into
   * `spin` in `ParamEncoder.tsx` and the suite re-run:
   *
   *   - `Math.min(100, Math.max(-100, …))` — a generous two-sided clamp, the shape
   *     someone adds "for safety" after QA finds a limit. EXACTLY the three spin cases
   *     below fail; no other test in this file notices a bound at ±100, which is the
   *     proof that they are the ones carrying it.
   *   - `Math.max(0, …)` — a one-sided floor. The two cases that cross zero fail.
   *
   * Which is also why the numbers are what they are: 125, -140, 150, -150, 200. A
   * spin that stops at 1, or at 10, would be caught by a clamp nobody would write.
   */
  describe('never clamps', () => {
    it('spins far past any plausible upper bound, and back down through zero', () => {
      render(<Spun start={0} step={1} />);
      // 1000px up at 8px per detent = 125 — past 1, past 100, past anything a slider
      // for an undocumented Tone parameter would have invented.
      drag(spun(), 1000);
      expect(valueNow()).toBe(125);
      expect(screen.getByText('125.0')).toBeInTheDocument();

      // …and 2120px back down, which passes zero and keeps going.
      drag(spun(), -2120);
      expect(valueNow()).toBe(-140);
      expect(screen.getByText('-140.0')).toBeInTheDocument();
    });

    it('spins without limit from the keyboard', async () => {
      const user = userEvent.setup();
      render(<Spun start={0} step={1} />);
      spun().focus();
      for (let i = 0; i < 15; i += 1) await user.keyboard('{Shift>}{ArrowUp}{/Shift}');
      expect(valueNow()).toBe(150);

      for (let i = 0; i < 30; i += 1) await user.keyboard('{PageDown}');
      expect(valueNow()).toBe(-150);
    });

    it('spins without limit from the wheel', () => {
      render(<Spun start={0} step={1} />);
      for (let i = 0; i < 20; i += 1) fireEvent.wheel(spun(), { deltaY: -100, shiftKey: true });
      expect(valueNow()).toBe(200);
    });

    it('holds a fractional increment accurately over a long spin', async () => {
      // Twenty single steps of 0.1: naive accumulation lands on 2.0000000000000004 and
      // the preset keeps that number forever, while the readout shows 2.00 either way.
      // Ten-at-a-time would NOT show it — 10 × 0.1 is exactly 1 in binary, so a PageUp
      // spin of the same distance passes with the rounding deleted.
      const user = userEvent.setup();
      render(<Spun start={0} step={0.1} precision={2} />);
      spun().focus();
      for (let i = 0; i < 20; i += 1) await user.keyboard('{ArrowUp}');
      expect(valueNow()).toBe(2);
      expect(screen.getByText('2.00')).toBeInTheDocument();
    });
  });

  describe('double-click', () => {
    it('resets to the descriptor fallback', async () => {
      const { user, onChange, dial } = setup({ value: 87.5, fallback: 1 });
      await user.dblClick(dial);
      expect(onChange).toHaveBeenLastCalledWith(1);
    });

    it('resets to a fallback that sits off the increment grid', async () => {
      const { user, onChange, dial } = setup({ value: 0, step: 0.1, fallback: 1.53 });
      await user.dblClick(dial);
      expect(onChange).toHaveBeenLastCalledWith(1.53);
    });
  });

  describe('disabled', () => {
    it('ignores the keyboard', async () => {
      const { user, onChange, dial } = setup({ disabled: true });
      dial.focus();
      await user.keyboard('{ArrowUp}');
      expect(onChange).not.toHaveBeenCalled();
    });

    it('ignores the wheel', () => {
      const { onChange, dial } = setup({ disabled: true });
      fireEvent.wheel(dial, { deltaY: -100 });
      expect(onChange).not.toHaveBeenCalled();
    });

    it('ignores a drag', () => {
      const { onChange, dial } = setup({ disabled: true });
      drag(dial, 100);
      expect(onChange).not.toHaveBeenCalled();
    });

    it('ignores a double-click', async () => {
      const { user, onChange, dial } = setup({ disabled: true, value: 9, fallback: 1 });
      await user.dblClick(dial);
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});
