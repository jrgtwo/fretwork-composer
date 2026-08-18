import { beforeEach, describe, expect, it, vi } from 'vitest';

const tone = vi.hoisted(() => {
  const state = {
    lookAhead: 0.1 as number,
    bpm: 120 as number,
    /** Set to throw from both accessors, as Tone does with no AudioContext. */
    dead: false,
  };
  return {
    state,
    getContext: () => {
      if (state.dead) throw new Error('no AudioContext');
      return { lookAhead: state.lookAhead };
    },
    getTransport: () => {
      if (state.dead) throw new Error('no AudioContext');
      return { bpm: { value: state.bpm } };
    },
  };
});

const lib = vi.hoisted(() => ({ getTransportTicks: vi.fn(() => 0) }));

vi.mock('tone', () => ({
  getContext: tone.getContext,
  getTransport: tone.getTransport,
}));

vi.mock('@fretwork/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fretwork/lib')>();
  return { ...actual, getTransportTicks: lib.getTransportTicks };
});

const { audibleTransportTicks, wrapToDuration } = await import('./transportClock');

const PPQ = 480;

beforeEach(() => {
  tone.state.lookAhead = 0.1;
  tone.state.bpm = 120;
  tone.state.dead = false;
  lib.getTransportTicks.mockReturnValue(0);
});

describe('audibleTransportTicks', () => {
  it('subtracts the lookAhead window, converted to ticks at the transport tempo', () => {
    // Tone evaluates `Transport.ticks` at `currentTime + lookAhead`, so the raw
    // read is a prediction of where the transport WILL be — one lookAhead ahead
    // of what has been rendered. 0.1s at 120bpm and 480 PPQ is 96 ticks.
    lib.getTransportTicks.mockReturnValue(1000);
    expect(audibleTransportTicks(PPQ)).toBe(904);
  });

  it('scales the correction with tempo', () => {
    lib.getTransportTicks.mockReturnValue(1000);
    tone.state.bpm = 60;
    expect(audibleTransportTicks(PPQ)).toBe(952);
  });

  it('never reports a position before the start', () => {
    // The first lookAhead window of playback: the transport has a position but
    // nothing has been rendered yet. A negative head would draw off the grid.
    lib.getTransportTicks.mockReturnValue(50);
    expect(audibleTransportTicks(PPQ)).toBe(0);
  });

  it('falls back to the raw read when there is no AudioContext', () => {
    // jsdom, and every frame before the first user gesture. The contract is the
    // lib's: callers are rAF loops, so this must not throw.
    tone.state.dead = true;
    lib.getTransportTicks.mockReturnValue(1000);
    expect(audibleTransportTicks(PPQ)).toBe(1000);
  });

  it('falls back to the raw read when the tempo is not a number', () => {
    lib.getTransportTicks.mockReturnValue(1000);
    tone.state.bpm = Number.NaN;
    expect(audibleTransportTicks(PPQ)).toBe(1000);
  });
});

describe('wrapToDuration', () => {
  it('folds a climbing tick back into the loop', () => {
    expect(wrapToDuration(2000, 1920)).toBe(80);
  });

  it('passes the tick through when there is no duration to wrap to', () => {
    expect(wrapToDuration(2000, 0)).toBe(2000);
  });
});
