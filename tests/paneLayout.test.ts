import { describe, it, expect } from 'vitest';
import {
  allCollapsed,
  clampHeight,
  fillerId,
  reorder,
  splitTarget,
  type PaneSpec,
  type PaneState,
} from '../src/shell/paneLayout';

// The three panes of the pattern page. "Instrument & Amp" is the one allowed to
// absorb slack; the other two are capped so they can't stretch into nonsense.
const SPECS: PaneSpec[] = [
  { id: 'reference', title: 'Reference', min: 60, max: 220 },
  { id: 'amp', title: 'Instrument & Amp', canFill: true },
  { id: 'timeline', title: 'Timeline', min: 150, max: 700 },
];
const ORDER = ['reference', 'amp', 'timeline'];

const open = (): Record<string, PaneState> => ({
  reference: { height: 118, collapsed: false },
  amp: { height: 0, collapsed: false },
  timeline: { height: 250, collapsed: false },
});
const spec = (id: string) => SPECS.find((s) => s.id === id)!;

describe('clampHeight', () => {
  it('honours min and max', () => {
    expect(clampHeight(spec('timeline'), 400)).toBe(400);
    expect(clampHeight(spec('timeline'), 20)).toBe(150);
    expect(clampHeight(spec('timeline'), 5000)).toBe(700);
  });

  it('leaves a fill pane unconstrained', () => {
    expect(clampHeight(spec('amp'), 5000)).toBe(5000);
  });
});

describe('reorder', () => {
  it('moves a pane to the front', () => {
    expect(reorder(ORDER, 'timeline', 0)).toEqual(['timeline', 'reference', 'amp']);
  });

  it('moves a pane to the middle', () => {
    expect(reorder(ORDER, 'reference', 1)).toEqual(['amp', 'reference', 'timeline']);
  });

  it('moves a pane to the end', () => {
    expect(reorder(ORDER, 'reference', 2)).toEqual(['amp', 'timeline', 'reference']);
  });

  it('is a no-op for an unknown id', () => {
    expect(reorder(ORDER, 'nope', 0)).toEqual(ORDER);
  });
});

describe('splitTarget', () => {
  it('drives the pane above when it is resizable and expanded', () => {
    // splitter 0 sits between reference and amp
    expect(splitTarget(ORDER, 0, SPECS, open())).toEqual({ id: 'reference', dir: 1 });
  });

  it('falls back to the pane below when the one above is collapsed', () => {
    const states = open();
    states.reference.collapsed = true;
    // above (reference) is out; below is amp, which can fill and so is not resizable
    expect(splitTarget(ORDER, 0, SPECS, states)).toBeNull();
  });

  it('skips a collapsed neighbour rather than going dead', () => {
    const states = open();
    states.amp.collapsed = true;
    // splitter 1 sits between amp (collapsed, unresizable) and timeline
    expect(splitTarget(ORDER, 1, SPECS, states)).toEqual({ id: 'timeline', dir: -1 });
  });

  it('gives the last pane a trailing splitter so it can claim free space', () => {
    expect(splitTarget(ORDER, 2, SPECS, open())).toEqual({ id: 'timeline', dir: 1 });
  });

  it('has no trailing splitter when the last pane is collapsed', () => {
    const states = open();
    states.timeline.collapsed = true;
    expect(splitTarget(ORDER, 2, SPECS, states)).toBeNull();
  });

  it('has no trailing splitter when the last pane is a fill pane', () => {
    const order = ['reference', 'timeline', 'amp'];
    expect(splitTarget(order, 2, SPECS, open())).toBeNull();
  });
});

describe('fillerId', () => {
  it('is the fill pane while it is expanded', () => {
    expect(fillerId(ORDER, SPECS, open())).toBe('amp');
  });

  it('is null when the fill pane is collapsed — collapsed panes must not stretch', () => {
    const states = open();
    states.amp.collapsed = true;
    expect(fillerId(ORDER, SPECS, states)).toBeNull();
  });
});

describe('allCollapsed', () => {
  it('is false while any pane is open', () => {
    const states = open();
    states.amp.collapsed = true;
    states.timeline.collapsed = true;
    expect(allCollapsed(ORDER, states)).toBe(false);
  });

  it('is true only when every pane is collapsed', () => {
    const states = open();
    ORDER.forEach((id) => (states[id].collapsed = true));
    expect(allCollapsed(ORDER, states)).toBe(true);
  });
});
