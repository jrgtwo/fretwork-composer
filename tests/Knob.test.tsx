import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Knob } from '../src/voice/controls/Knob';
import { PARAM_SECTIONS, type SliderParam } from '../src/voice/paramSchema';

/**
 * jsdom implements no layout, but a drag here needs none: the component reads
 * `clientY` off the pointer events and the test supplies those numbers directly.
 * So the drag maths IS assertable — only the rendered geometry isn't, and the SVG
 * is decorative (`aria-hidden`) precisely so that nothing depends on measuring it.
 *
 * The one genuinely untestable piece is `preventDefault` on the wheel listener:
 * jsdom has no scrolling for it to suppress. Whether `dblclick` still fires after the
 * pointerdown handler calls `preventDefault` is also unanswerable here — jsdom models
 * none of the pointer→mouse compatibility-event suppression that decides it (per spec
 * it does fire, because that suppression is scoped to the mouse events, not dblclick).
 *
 * The SVG geometry, though, IS assertable: the component computes every coordinate
 * itself and jsdom serialises the attributes faithfully. Only *measured* geometry is
 * off-limits, and nothing here measures.
 */

/** A knob wired to a spy, with the props a `SliderParam` would supply. */
function setup(overrides: Partial<Parameters<typeof Knob>[0]> = {}) {
  const onChange = vi.fn();
  const user = userEvent.setup();
  const props = {
    label: 'Drive',
    value: 0.5,
    min: 0,
    max: 1,
    step: 0.01,
    onChange,
    ...overrides,
  };
  const { container, unmount } = render(<Knob {...props} />);
  return {
    onChange,
    user,
    container,
    unmount,
    dial: screen.getByRole('slider', { name: props.label }),
  };
}

/**
 * jsdom ships no `PointerEvent`, so `fireEvent.pointerDown` degrades to a bare `Event`
 * and silently drops `pointerId`/`clientY` — which is exactly what the multi-pointer
 * tests below are about. A `MouseEvent` carries the coordinates and React reads
 * `pointerId` straight off the native event, so this is what user-event does internally.
 */
function pointerEvent(
  type: string,
  init: { pointerId?: number; clientY?: number; button?: number } = {},
) {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientY: init.clientY ?? 0,
    button: init.button ?? 0,
  });
  Object.defineProperty(ev, 'pointerId', { value: init.pointerId ?? 1 });
  return ev;
}

const INDICATOR = 'line[stroke="var(--knob-indicator, var(--color-brass-hi))"]';
const LIT_TICK = 'line[stroke="var(--knob-tick-active, var(--color-brass))"]';

/** The indicator's outer end, relative to the dial centre (SVG y grows downward). */
function indicatorTip(container: HTMLElement) {
  const line = container.querySelector(INDICATOR);
  if (!line) throw new Error('no indicator line rendered');
  return {
    x: Number(line.getAttribute('x2')) - 28, // default size 56 ⇒ centre 28
    y: Number(line.getAttribute('y2')) - 28,
  };
}

/** The single value the spy was called with. Fails loudly on 0 or 2+ calls. */
const onlyCall = (onChange: ReturnType<typeof vi.fn>) => {
  expect(onChange).toHaveBeenCalledTimes(1);
  return onChange.mock.calls[0][0] as number;
};

describe('Knob', () => {
  /**
   * The whole point of the props being what they are: a rack unit maps a descriptor
   * row onto a knob with no per-parameter knowledge. Built from the real schema, so
   * a field renamed or retyped in `paramSchema.ts` fails here rather than at the
   * call site the next slice writes.
   */
  it('takes its props straight from a SliderParam descriptor', () => {
    const amp = PARAM_SECTIONS.find((s) => s.id === 'amp')!;
    const param = amp.params.find(
      (p): p is SliderParam => p.kind === 'slider' && p.path === 'effects.amp.bass',
    )!;

    render(
      <Knob
        label={param.label}
        min={param.min}
        max={param.max}
        step={param.step}
        defaultValue={param.fallback}
        value={-3}
        formatValue={(v) => `${v.toFixed(param.precision)}${param.unit ? ` ${param.unit}` : ''}`}
        onChange={vi.fn()}
      />,
    );

    const dial = screen.getByRole('slider', { name: 'Bass' });
    expect(dial).toHaveAttribute('aria-valuemin', '-12');
    expect(dial).toHaveAttribute('aria-valuemax', '12');
    expect(dial).toHaveAttribute('aria-valuetext', '-3.0 dB');
  });

  describe('accessibility', () => {
    it('is a slider named by its visible label', () => {
      setup();
      // Named by the engraved label rather than a duplicate `aria-label`, so the
      // accessible name cannot drift from what is printed on the panel.
      expect(screen.getByRole('slider', { name: 'Drive' })).toBeInTheDocument();
    });

    it('reports the range and the formatted value', () => {
      const { dial } = setup({
        value: 3,
        min: -12,
        max: 12,
        step: 0.5,
        label: 'Bass',
        formatValue: (v: number) => `${v.toFixed(1)} dB`,
      });
      expect(dial).toHaveAttribute('aria-valuemin', '-12');
      expect(dial).toHaveAttribute('aria-valuemax', '12');
      expect(dial).toHaveAttribute('aria-valuenow', '3');
      expect(dial).toHaveAttribute('aria-valuetext', '3.0 dB');
    });

    it('shows the formatted value as a readout as well', () => {
      setup({ value: 3, formatValue: (v: number) => `${v.toFixed(1)} dB` });
      expect(screen.getByText('3.0 dB')).toBeInTheDocument();
    });

    it('is keyboard reachable', async () => {
      const { user, dial } = setup();
      await user.tab();
      expect(dial).toHaveFocus();
    });

    it('declares the vertical orientation its drag gesture actually has', () => {
      // role="slider" defaults to horizontal, which would announce the wrong axis.
      expect(setup().dial).toHaveAttribute('aria-orientation', 'vertical');
    });

    it('reports a value outside the range clamped, while the readout keeps the truth', () => {
      // Reachable only from a preset authored elsewhere; ParamSlider documents the
      // same trade. ARIA forbids valuenow outside the bounds, so that one clamps.
      const { dial } = setup({ value: 5, min: 0, max: 1 });
      expect(dial).toHaveAttribute('aria-valuenow', '1');
      expect(dial).toHaveAttribute('aria-valuetext', '5.00');
    });
  });

  describe('keyboard', () => {
    it('steps up on ArrowUp and ArrowRight', async () => {
      const { user, onChange, dial } = setup({ value: 0.5, step: 0.01 });
      dial.focus();
      await user.keyboard('{ArrowUp}');
      expect(onlyCall(onChange)).toBe(0.51);

      onChange.mockClear();
      await user.keyboard('{ArrowRight}');
      expect(onlyCall(onChange)).toBe(0.51);
    });

    it('steps down on ArrowDown and ArrowLeft', async () => {
      const { user, onChange, dial } = setup({ value: 0.5, step: 0.01 });
      dial.focus();
      await user.keyboard('{ArrowDown}');
      expect(onlyCall(onChange)).toBe(0.49);

      onChange.mockClear();
      await user.keyboard('{ArrowLeft}');
      expect(onlyCall(onChange)).toBe(0.49);
    });

    it('multiplies the step by ten while Shift is held', async () => {
      const { user, onChange, dial } = setup({ value: 0.5, step: 0.01 });
      dial.focus();
      await user.keyboard('{Shift>}{ArrowUp}{/Shift}');
      expect(onlyCall(onChange)).toBe(0.6);
    });

    it('jumps to min on Home and max on End', async () => {
      const { user, onChange, dial } = setup({ value: 0.5, min: -12, max: 12, step: 0.5 });
      dial.focus();
      await user.keyboard('{Home}');
      expect(onlyCall(onChange)).toBe(-12);

      onChange.mockClear();
      await user.keyboard('{End}');
      expect(onlyCall(onChange)).toBe(12);
    });

    it('reaches the exact bounds on Home/End even when the span is not a whole number of steps', async () => {
      // 0..1 by 0.3: snapping End would emit 0.9 and leave the control unable to reach
      // its own aria-valuemax. A bound is a legal value by definition.
      const { user, onChange, dial } = setup({ value: 0.6, min: 0, max: 1, step: 0.3 });
      dial.focus();
      await user.keyboard('{End}');
      expect(onlyCall(onChange)).toBe(1);

      onChange.mockClear();
      await user.keyboard('{Home}');
      expect(onlyCall(onChange)).toBe(0);
    });

    it('pages by ten steps, matching the native range input in ParamSlider', async () => {
      const { user, onChange, dial } = setup({ value: 0.5, step: 0.01 });
      dial.focus();
      await user.keyboard('{PageUp}');
      expect(onlyCall(onChange)).toBe(0.6);

      onChange.mockClear();
      await user.keyboard('{PageDown}');
      expect(onlyCall(onChange)).toBe(0.4);
    });

    it('ignores keys it does not own', async () => {
      const { user, onChange, dial } = setup();
      dial.focus();
      await user.keyboard('{Enter} {Escape}');
      expect(onChange).not.toHaveBeenCalled();
    });

    it('emits a real number when the step is zero', async () => {
      // `Math.round(x / 0) * 0` is NaN; the guard in `snap` is what stops that number
      // reaching the preset. Every shipped SliderParam has a positive step, so nothing
      // else in the suite exercises the guard.
      const { user, onChange, dial } = setup({ value: 0.5, min: 0, max: 1, step: 0 });
      dial.focus();
      await user.keyboard('{ArrowUp}');
      expect(onlyCall(onChange)).toBe(0.5);
    });

    it('clamps at the ceiling', async () => {
      const { user, onChange, dial } = setup({ value: 1, min: 0, max: 1, step: 0.01 });
      dial.focus();
      await user.keyboard('{ArrowUp}');
      expect(onlyCall(onChange)).toBe(1);
    });

    it('clamps at the floor', async () => {
      const { user, onChange, dial } = setup({ value: 0, min: 0, max: 1, step: 0.01 });
      dial.focus();
      await user.keyboard('{ArrowDown}');
      expect(onlyCall(onChange)).toBe(0);
    });

    it('emits a value free of binary-float debris', async () => {
      // 0 + 3 * 0.01 is 0.030000000000000002 without the rounding in `snap`, and
      // that number would be written straight into the preset.
      const { user, onChange, dial } = setup({ value: 0.02, min: 0, max: 1, step: 0.01 });
      dial.focus();
      await user.keyboard('{ArrowUp}');
      expect(onlyCall(onChange)).toBe(0.03);
    });
  });

  describe('wheel', () => {
    it('increases on wheel up and decreases on wheel down', () => {
      const { onChange, dial } = setup({ value: 0.5, step: 0.01 });
      fireEvent.wheel(dial, { deltaY: -100 });
      expect(onlyCall(onChange)).toBe(0.51);

      onChange.mockClear();
      fireEvent.wheel(dial, { deltaY: 100 });
      expect(onlyCall(onChange)).toBe(0.49);
    });

    it('multiplies by ten with Shift', () => {
      const { onChange, dial } = setup({ value: 0.5, step: 0.01 });
      fireEvent.wheel(dial, { deltaY: -100, shiftKey: true });
      expect(onlyCall(onChange)).toBe(0.6);
    });

    it('ignores a horizontal trackpad swipe', () => {
      // deltaY 0 with deltaX set. Treating "not up" as "down" turns a sideways scroll
      // across the rack into a downward step on every knob it passes.
      const { onChange, dial } = setup({ value: 0.5, step: 0.01 });
      fireEvent.wheel(dial, { deltaX: -100, deltaY: 0 });
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('double-click', () => {
    it('resets to defaultValue', async () => {
      const { user, onChange, dial } = setup({ value: 0.8, defaultValue: 0.3 });
      await user.dblClick(dial);
      expect(onChange).toHaveBeenLastCalledWith(0.3);
    });

    it('resets to a defaultValue that is off the step grid', async () => {
      // The descriptor's `fallback` is the declared reset target; snapping it would
      // reset to a number the schema never named.
      const { user, onChange, dial } = setup({ value: 0.9, defaultValue: 0.25, step: 0.3 });
      await user.dblClick(dial);
      expect(onChange).toHaveBeenLastCalledWith(0.25);
    });

    it('does nothing when no defaultValue was given', async () => {
      const { user, onChange, dial } = setup({ value: 0.8 });
      await user.dblClick(dial);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('pointer drag', () => {
    it('increases when dragged up', async () => {
      // Deliberately an interior result: starting at 0.5 the expectation would be `max`,
      // which the clamp satisfies even if the sweep scale is wrong.
      const { user, onChange, dial } = setup({ value: 0.2, min: 0, max: 1, step: 0.01 });
      // 50px of a 100px sweep over a range of 1 = +0.5.
      await user.pointer([
        { target: dial, keys: '[MouseLeft>]', coords: { clientY: 100 } },
        { target: dial, coords: { clientY: 50 } },
        { keys: '[/MouseLeft]' },
      ]);
      expect(onChange).toHaveBeenLastCalledWith(0.7);
    });

    it('decreases when dragged down', async () => {
      const { user, onChange, dial } = setup({ value: 0.5, min: 0, max: 1, step: 0.01 });
      await user.pointer([
        { target: dial, keys: '[MouseLeft>]', coords: { clientY: 100 } },
        { target: dial, coords: { clientY: 120 } },
        { keys: '[/MouseLeft]' },
      ]);
      expect(onChange).toHaveBeenLastCalledWith(0.3);
    });

    it('keeps tracking after the pointer leaves the knob', async () => {
      // A full sweep is 100px across a 56px control, so every real drag ends up
      // outside it. The gesture rides `window`, not the element, for this reason.
      const { user, onChange, dial } = setup({ value: 0.5, min: 0, max: 1, step: 0.01 });
      await user.pointer([
        { target: dial, keys: '[MouseLeft>]', coords: { clientY: 100 } },
        { target: document.body, coords: { clientY: 80 } },
        { keys: '[/MouseLeft]' },
      ]);
      expect(onChange).toHaveBeenLastCalledWith(0.7);
    });

    it('is measured from where the drag began, not from the last move', async () => {
      const { user, onChange, dial } = setup({ value: 0.5, min: 0, max: 1, step: 0.01 });
      await user.pointer([
        { target: dial, keys: '[MouseLeft>]', coords: { clientY: 100 } },
        { target: dial, coords: { clientY: 90 } },
        { target: dial, coords: { clientY: 80 } },
        { keys: '[/MouseLeft]' },
      ]);
      // Absolute from the origin (+0.2), not accumulated (+0.1 then +0.1 again on
      // a value the parent never fed back).
      expect(onChange).toHaveBeenLastCalledWith(0.7);
    });

    it('divides the sweep by four while Shift is held', async () => {
      const { user, onChange, dial } = setup({ value: 0.5, min: 0, max: 1, step: 0.01 });
      await user.keyboard('{Shift>}');
      await user.pointer([
        { target: dial, keys: '[MouseLeft>]', coords: { clientY: 100 } },
        { target: dial, coords: { clientY: 60 } },
        { keys: '[/MouseLeft]' },
      ]);
      await user.keyboard('{/Shift}');
      // 40px / (100 * 4) = +0.1, where an unmodified drag would be +0.4.
      expect(onChange).toHaveBeenLastCalledWith(0.6);
    });

    it('clamps at the bounds mid-drag', async () => {
      const { user, onChange, dial } = setup({ value: 0.5, min: 0, max: 1, step: 0.01 });
      await user.pointer([
        { target: dial, keys: '[MouseLeft>]', coords: { clientY: 100 } },
        { target: dial, coords: { clientY: -900 } },
        { keys: '[/MouseLeft]' },
      ]);
      expect(onChange).toHaveBeenLastCalledWith(1);
    });

    it('stops tracking once the button is released', async () => {
      const { user, onChange, dial } = setup({ value: 0.5, min: 0, max: 1, step: 0.01 });
      await user.pointer([
        { target: dial, keys: '[MouseLeft>]', coords: { clientY: 100 } },
        { keys: '[/MouseLeft]' },
      ]);
      onChange.mockClear();
      await user.pointer({ target: document.body, coords: { clientY: 20 } });
      expect(onChange).not.toHaveBeenCalled();
    });

    it('focuses the knob it is dragging, so the keyboard can take over', async () => {
      const { user, dial } = setup();
      await user.pointer([
        { target: dial, keys: '[MouseLeft>]', coords: { clientY: 100 } },
        { keys: '[/MouseLeft]' },
      ]);
      expect(dial).toHaveFocus();
    });

    it('emits nothing when the drag has not crossed a step', async () => {
      // A native <input type="range"> only fires on a real change. 1px of a 100px sweep
      // over 24 dB is 0.24 dB, which snaps back to where it started.
      const { user, onChange, dial } = setup({ value: 0, min: -12, max: 12, step: 0.5 });
      await user.pointer([
        { target: dial, keys: '[MouseLeft>]', coords: { clientY: 100 } },
        { target: dial, coords: { clientY: 99 } },
        { keys: '[/MouseLeft]' },
      ]);
      expect(onChange).not.toHaveBeenCalled();
    });

    it('is not hijacked by a second pointer', () => {
      // Window listeners see every pointer, so without an id filter a second finger
      // anywhere on the page steers this knob — from *its* clientY against *our* origin.
      const { onChange, dial } = setup({ value: 0.5, min: 0, max: 1, step: 0.01 });
      dial.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientY: 100 }));
      window.dispatchEvent(pointerEvent('pointermove', { pointerId: 2, clientY: 20 }));
      expect(onChange).not.toHaveBeenCalled();

      window.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientY: 90 }));
      expect(onlyCall(onChange)).toBe(0.6);
      // …and a stray pointerup from the other finger must not end our gesture either.
      window.dispatchEvent(pointerEvent('pointerup', { pointerId: 2 }));
      window.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientY: 80 }));
      expect(onChange).toHaveBeenLastCalledWith(0.7);
      window.dispatchEvent(pointerEvent('pointerup', { pointerId: 1 }));
    });

    it('ends the gesture on pointercancel', () => {
      // A touch can be taken away by the OS with no pointerup at all.
      const { onChange, dial } = setup({ value: 0.5, min: 0, max: 1, step: 0.01 });
      dial.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientY: 100 }));
      window.dispatchEvent(pointerEvent('pointercancel', { pointerId: 1 }));
      onChange.mockClear();
      window.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientY: 50 }));
      expect(onChange).not.toHaveBeenCalled();
    });

    it('stops tracking when the knob unmounts mid-drag', () => {
      // The panes in this app collapse mid-interaction; the listeners live on `window`
      // and would otherwise outlive the component that installed them.
      const { onChange, dial, unmount } = setup({ value: 0.5, min: 0, max: 1, step: 0.01 });
      dial.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientY: 100 }));
      unmount();
      onChange.mockClear();
      window.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientY: 50 }));
      expect(onChange).not.toHaveBeenCalled();
    });

    it('stops tracking when the knob is disabled mid-drag', () => {
      const onChange = vi.fn();
      const props = { label: 'Drive', value: 0.5, min: 0, max: 1, step: 0.01, onChange };
      const { rerender } = render(<Knob {...props} />);
      const dial = screen.getByRole('slider', { name: 'Drive' });
      dial.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientY: 100 }));
      rerender(<Knob {...props} disabled />);
      onChange.mockClear();
      window.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientY: 50 }));
      expect(onChange).not.toHaveBeenCalled();
    });

    it('does not leave a first gesture running when a second press starts', () => {
      // `abortDrag` holds one closure; without closing the first press here, its
      // listeners are unreachable from the unmount cleanup.
      const { onChange, dial, unmount } = setup({ value: 0.5, min: 0, max: 1, step: 0.01 });
      dial.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientY: 100 }));
      dial.dispatchEvent(pointerEvent('pointerdown', { pointerId: 2, clientY: 100 }));
      unmount();
      onChange.mockClear();
      window.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientY: 50 }));
      window.dispatchEvent(pointerEvent('pointermove', { pointerId: 2, clientY: 50 }));
      expect(onChange).not.toHaveBeenCalled();
    });

    it('snaps a drag to the step grid', async () => {
      const { user, onChange, dial } = setup({ value: 0, min: -12, max: 12, step: 0.5 });
      // 7px of a 100px sweep over 24 dB = 1.68 dB, which is not on the 0.5 grid.
      await user.pointer([
        { target: dial, keys: '[MouseLeft>]', coords: { clientY: 100 } },
        { target: dial, coords: { clientY: 93 } },
        { keys: '[/MouseLeft]' },
      ]);
      expect(onChange).toHaveBeenLastCalledWith(1.5);
    });
  });

  /**
   * The dial's whole job is to point somewhere. These assert the rendered attributes,
   * not measured layout — nothing here needs a box.
   *
   * The sweep runs -135°..+135° from 12 o'clock, so min is at 7:30 (down-left), the
   * midpoint is straight up, and max is at 4:30 (down-right).
   */
  describe('geometry', () => {
    it('points down-left at min, straight up at the midpoint and down-right at max', () => {
      const { container: atMin } = render(<Knob label="A" value={0} min={0} max={1} step={0.01} onChange={vi.fn()} />);
      const min = indicatorTip(atMin);
      expect(min.x).toBeLessThan(0);
      expect(min.y).toBeGreaterThan(0);

      const { container: atMid } = render(<Knob label="B" value={0.5} min={0} max={1} step={0.01} onChange={vi.fn()} />);
      const mid = indicatorTip(atMid);
      expect(mid.x).toBeCloseTo(0, 6);
      expect(mid.y).toBeLessThan(0);

      const { container: atMax } = render(<Knob label="C" value={1} min={0} max={1} step={0.01} onChange={vi.fn()} />);
      const max = indicatorTip(atMax);
      expect(max.x).toBeGreaterThan(0);
      expect(max.y).toBeGreaterThan(0);
    });

    it('lights the tick ring up to the current value', () => {
      // The coarse read of the value — at 56px the indicator alone is ~4° between
      // adjacent dB, so if the arc stops tracking the knob stops being legible.
      const { container } = setup({ label: 'Min', value: 0, min: 0, max: 1 });
      expect(container.querySelectorAll(LIT_TICK)).toHaveLength(1);

      const { container: half } = setup({ label: 'Mid', value: 0.5, min: 0, max: 1 });
      expect(half.querySelectorAll(LIT_TICK)).toHaveLength(6);

      const { container: full } = setup({ label: 'Max', value: 1, min: 0, max: 1 });
      expect(full.querySelectorAll(LIT_TICK)).toHaveLength(11);
    });

    it('draws a degenerate range without NaN coordinates', () => {
      // `(value - min) / (max - min)` is 0/0 here; one NaN poisons every attribute the
      // SVG derives from `fraction`, and an SVG full of NaN renders as nothing at all.
      const { container } = setup({ value: 5, min: 5, max: 5, step: 0 });
      for (const el of container.querySelectorAll('*')) {
        for (const attr of el.attributes) {
          expect(`${el.tagName}.${attr.name}=${attr.value}`).not.toContain('NaN');
        }
      }
    });

    it('scales its type with `size`, so the label cannot outgrow the dial', () => {
      const { container } = setup({ size: 28 });
      const label = screen.getByText('Drive');
      expect(label).toHaveStyle({ fontSize: `${28 * 0.16}px` });
      expect(container.querySelector('svg')).toHaveAttribute('width', '28');
    });
  });

  describe('disabled', () => {
    it('is out of the tab order and marked disabled', () => {
      const { dial } = setup({ disabled: true });
      expect(dial).toHaveAttribute('tabindex', '-1');
      expect(dial).toHaveAttribute('aria-disabled', 'true');
    });

    it('ignores the keyboard', async () => {
      const { user, onChange, dial } = setup({ disabled: true });
      dial.focus();
      await user.keyboard('{ArrowUp}{Home}{End}');
      expect(onChange).not.toHaveBeenCalled();
    });

    it('ignores the wheel', () => {
      const { onChange, dial } = setup({ disabled: true });
      fireEvent.wheel(dial, { deltaY: -100 });
      expect(onChange).not.toHaveBeenCalled();
    });

    it('ignores a drag', async () => {
      const { user, onChange, dial } = setup({ disabled: true });
      await user.pointer([
        { target: dial, keys: '[MouseLeft>]', coords: { clientY: 100 } },
        { target: dial, coords: { clientY: 50 } },
        { keys: '[/MouseLeft]' },
      ]);
      expect(onChange).not.toHaveBeenCalled();
    });

    it('ignores a double-click reset', async () => {
      const { user, onChange, dial } = setup({ disabled: true, defaultValue: 0.3 });
      await user.dblClick(dial);
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});
