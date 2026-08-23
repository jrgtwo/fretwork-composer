/**
 * The meter's visible behaviour (AU-04).
 *
 * Everything here is written from a subscription callback straight onto the DOM,
 * bypassing React entirely — so the ordinary "render and assert on the output"
 * shape would test nothing at all. These assert on the nodes AFTER a reading has
 * been delivered, which is the only place the behaviour exists.
 *
 * jsdom has no layout, and none is needed: the bar is a `transform`, the peak is
 * a percentage, and the clip lamp is an attribute. All three are values we set
 * rather than values the browser computes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const listeners: ((db: number) => void)[] = [];
const unsubscribe = vi.fn();

vi.mock('../audio/levelMeters', () => ({
  SILENCE_DB: -Infinity,
  subscribeMeter: (_source: unknown, listener: (db: number) => void) => {
    listeners.push(listener);
    return unsubscribe;
  },
}));

import { LevelMeter, CLIP_DB, METER_MIN_DB, METER_MAX_DB } from './LevelMeter';

/** Deliver one reading, at a controlled wall-clock time. */
function emit(db: number, atMs?: number): void {
  if (atMs !== undefined) vi.spyOn(performance, 'now').mockReturnValue(atMs);
  act(() => {
    for (const listener of listeners) listener(db);
  });
}

function fill(): HTMLElement {
  const node = document.querySelector('.meter-fill');
  if (!(node instanceof HTMLElement)) throw new Error('no fill');
  return node;
}

function lamp(): HTMLElement {
  return screen.getByRole('button', { name: /clip indicator/i });
}

/**
 * The fraction of the groove revealed, recovered from the clip window.
 *
 * Asserting on `clip-path` rather than a transform is the point: a transform
 * would scale the gradient with the bar, so every level would show the whole
 * green-to-red ramp and the colour would mean nothing. Reading it back this way
 * is what stops that regressing.
 */
function scale(): number {
  const match = /inset\(0(?:px)? ([\d.]+)% 0(?:px)? 0(?:px)?\)/.exec(fill().style.clipPath);
  return match ? 1 - Number(match[1]) / 100 : NaN;
}

beforeEach(() => {
  listeners.length = 0;
  unsubscribe.mockClear();
  vi.spyOn(performance, 'now').mockReturnValue(1000);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LevelMeter', () => {
  it('draws empty before any reading arrives', () => {
    render(<LevelMeter source={{ kind: 'master' }} label="MSTR" title="Master output level" />);
    expect(scale()).toBe(0);
    expect(lamp().dataset.lit).toBe('false');
  });

  it('fills in proportion to the reading, on the dB scale', () => {
    render(<LevelMeter source={{ kind: 'master' }} label="MSTR" title="Master output level" />);

    const midpointDb = (METER_MIN_DB + METER_MAX_DB) / 2;
    emit(midpointDb);

    expect(scale()).toBeCloseTo(0.5, 5);
  });

  it('clamps rather than overflowing when the signal is past the top of the scale', () => {
    render(<LevelMeter source={{ kind: 'master' }} label="MSTR" title="Master output level" />);

    emit(METER_MAX_DB + 40);

    // A bar wider than its groove would be a rendering bug that reads as "very
    // loud" — which it is — but the number it implies is meaningless.
    expect(scale()).toBe(1);
  });

  it('draws empty for silence', () => {
    render(<LevelMeter source={{ kind: 'master' }} label="MSTR" title="Master output level" />);

    emit(-Infinity);

    expect(scale()).toBe(0);
  });

  it('latches the clip lamp at full scale and HOLDS it after the signal drops', () => {
    render(<LevelMeter source={{ kind: 'master' }} label="MSTR" title="Master output level" />);

    emit(CLIP_DB, 1000);
    expect(lamp().dataset.lit).toBe('true');

    // The whole point of the latch: the over-level lasted one frame and the
    // quiet that follows must not erase the evidence of it.
    emit(-30, 1200);
    expect(lamp().dataset.lit).toBe('true');
  });

  it('releases the clip lamp once the hold has elapsed', () => {
    render(<LevelMeter source={{ kind: 'master' }} label="MSTR" title="Master output level" />);

    emit(CLIP_DB, 1000);
    emit(-30, 5000);

    expect(lamp().dataset.lit).toBe('false');
  });

  it('does not latch below full scale', () => {
    render(<LevelMeter source={{ kind: 'master' }} label="MSTR" title="Master output level" />);

    emit(CLIP_DB - 0.5, 1000);

    expect(lamp().dataset.lit).toBe('false');
  });

  it('clears the latch when the lamp is clicked', async () => {
    render(<LevelMeter source={{ kind: 'master' }} label="MSTR" title="Master output level" />);
    emit(CLIP_DB, 1000);
    expect(lamp().dataset.lit).toBe('true');

    await userEvent.click(lamp());

    expect(lamp().dataset.lit).toBe('false');
  });

  it('holds the peak above a level that has already fallen away', () => {
    render(<LevelMeter source={{ kind: 'master' }} label="MSTR" title="Master output level" />);

    emit(-6, 1000);
    expect(screen.getByText('-6.0')).toBeTruthy();

    // 30 ms later the signal is gone, but the peak falls at a fixed rate rather
    // than snapping down — a pluck is over in a few frames and an unheld meter
    // is unreadable.
    emit(-Infinity, 1030);
    const readout = screen.getByTitle('Master output level').querySelector('span:last-child');
    expect(readout?.textContent).not.toBe('-∞');
  });

  it('unsubscribes on unmount', () => {
    const view = render(
      <LevelMeter source={{ kind: 'master' }} label="MSTR" title="Master output level" />,
    );
    view.unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
