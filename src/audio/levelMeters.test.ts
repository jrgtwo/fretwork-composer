/**
 * The meter plumbing (AU-04).
 *
 * What is worth testing here is not "does a number come out" — it is the three
 * things that would each fail SILENTLY in a browser and look like a dead meter:
 * a source with nothing behind it, a voice the engine has already disposed, and
 * a loop that keeps running after the last meter leaves the screen.
 *
 * The module keeps its registry and its subscriber set at module scope, so every
 * test re-imports it rather than sharing one instance.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const masterPeak = vi.fn(() => -12);

vi.mock('@fretwork/lib', () => ({
  MasterBus: {
    getOutputPeakDb: () => masterPeak(),
  },
}));

type Meters = typeof import('./levelMeters');

/** A stand-in for the lib's `Voice` — only the three readings are used.
 *  `driveDb` defaults to silence, which is what a voice with no amp stage
 *  reports. */
function fakeVoice(inDb: number, outDb: number, driveDb = -Infinity) {
  return {
    getInputLevelDb: vi.fn(() => inDb),
    getDriveLevelDb: vi.fn(() => driveDb),
    getOutputLevelDb: vi.fn(() => outDb),
  } as unknown as import('@fretwork/lib').Voice;
}

/** Drive `requestAnimationFrame` by hand so a test can advance exactly one
 *  frame, and so the sample throttle can be crossed deliberately. */
let pending: FrameRequestCallback[] = [];
let clockMs = 0;

function flushFrame(advanceMs = 40): void {
  clockMs += advanceMs;
  const due = pending;
  pending = [];
  for (const cb of due) cb(clockMs);
}

let meters: Meters;

beforeEach(async () => {
  pending = [];
  clockMs = 0;
  masterPeak.mockReturnValue(-12);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    pending.push(cb);
    return pending.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    pending = [];
  });
  vi.resetModules();
  meters = await import('./levelMeters');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('subscribeMeter', () => {
  it('reports a registered track voice’s three taps separately', () => {
    meters.registerTrackVoice('t1', fakeVoice(-3, -18, -9));
    const seen: Record<string, number> = {};
    meters.subscribeMeter({ kind: 'track-in', trackId: 't1' }, (db) => (seen.in = db));
    meters.subscribeMeter({ kind: 'track-drive', trackId: 't1' }, (db) => (seen.drive = db));
    meters.subscribeMeter({ kind: 'track-out', trackId: 't1' }, (db) => (seen.out = db));

    flushFrame();

    expect(seen.in).toBe(-3);
    expect(seen.drive).toBe(-9);
    expect(seen.out).toBe(-18);
  });

  it('does NOT apply the fader to the drive tap', () => {
    // The drive tap is inside the amp; the fader is two stages past the end of
    // the voice. `track-out` adds it because the meter would otherwise not move
    // with its own fader — but doing the same here would report a level that
    // exists at no point in the graph.
    meters.registerTrackVoice('t1', fakeVoice(-3, -18, -9));
    meters.setTrackFaders([
      { id: 't1', name: 'T', volumeDb: -6, muted: false, soloed: false } as never,
    ]);
    const seen: Record<string, number> = {};
    meters.subscribeMeter({ kind: 'track-drive', trackId: 't1' }, (db) => (seen.drive = db));
    meters.subscribeMeter({ kind: 'track-out', trackId: 't1' }, (db) => (seen.out = db));

    flushFrame();

    expect(seen.drive).toBe(-9);
    expect(seen.out).toBe(-24);
  });

  it('a voice with no amp stage reads silence at the drive tap, not zero', () => {
    // The lib builds the meter unconditionally and connects it only when the
    // preset has an amp, so `getDriveLevelDb` returns -Infinity. Zero would read
    // as "this stage is at full scale" on a voice that has no such stage.
    meters.registerTrackVoice('t1', fakeVoice(-3, -18));
    let db = 0;
    meters.subscribeMeter({ kind: 'track-drive', trackId: 't1' }, (value) => (db = value));

    flushFrame();

    expect(db).toBe(meters.SILENCE_DB);
  });

  it('keys the drive tap separately, so it is not deduped against in or out', () => {
    // `sourceKey` keys any non-master source by `${kind}:${trackId}`, so this
    // needs no change for a third kind — but a regression there would make two
    // of the three meters silently show the same number.
    const voice = fakeVoice(-3, -18, -9);
    meters.registerTrackVoice('t1', voice);
    const seen: Record<string, number> = {};
    meters.subscribeMeter({ kind: 'track-in', trackId: 't1' }, (db) => (seen.in = db));
    meters.subscribeMeter({ kind: 'track-drive', trackId: 't1' }, (db) => (seen.drive = db));
    meters.subscribeMeter({ kind: 'track-out', trackId: 't1' }, (db) => (seen.out = db));

    flushFrame();

    expect(new Set([seen.in, seen.drive, seen.out]).size).toBe(3);
  });

  it('reads the master through MasterBus', () => {
    masterPeak.mockReturnValue(-0.4);
    let db = 0;
    meters.subscribeMeter({ kind: 'master' }, (value) => (db = value));

    flushFrame();

    expect(db).toBe(-0.4);
  });

  it('reports silence for a track with no voice registered', () => {
    let db = 0;
    meters.subscribeMeter({ kind: 'track-in', trackId: 'ghost' }, (value) => (db = value));

    flushFrame();

    // Absence and silence are deliberately the same reading — a meter with no
    // source draws empty rather than erroring.
    expect(db).toBe(meters.SILENCE_DB);
  });

  it('reports silence when a voice throws, rather than taking the page down', () => {
    const disposed = {
      getInputLevelDb: () => {
        throw new Error('disposed');
      },
      getOutputLevelDb: () => {
        throw new Error('disposed');
      },
    } as unknown as import('@fretwork/lib').Voice;
    meters.registerTrackVoice('t1', disposed);
    let db = 0;

    meters.subscribeMeter({ kind: 'track-in', trackId: 't1' }, (value) => (db = value));

    expect(() => flushFrame()).not.toThrow();
    expect(db).toBe(meters.SILENCE_DB);
  });

  it('reads one point once per frame however many meters watch it', () => {
    const voice = fakeVoice(-6, -6);
    meters.registerTrackVoice('t1', voice);
    meters.subscribeMeter({ kind: 'track-in', trackId: 't1' }, () => {});
    meters.subscribeMeter({ kind: 'track-in', trackId: 't1' }, () => {});
    meters.subscribeMeter({ kind: 'track-in', trackId: 't1' }, () => {});

    flushFrame();

    expect(voice.getInputLevelDb).toHaveBeenCalledTimes(1);
  });

  it('keeps polling while a listener remains, and stops when the last one goes', () => {
    meters.registerTrackVoice('t1', fakeVoice(-6, -6));
    let calls = 0;
    const stop = meters.subscribeMeter({ kind: 'track-in', trackId: 't1' }, () => {
      calls += 1;
    });

    flushFrame();
    flushFrame();
    expect(calls).toBe(2);

    stop();

    // Cancelled straight away, not merely left to lapse on the next tick — a
    // frame already queued would otherwise still fire once against a registry
    // the caller has finished with.
    expect(pending).toHaveLength(0);

    flushFrame();

    // And it does not re-arm. The loop is the only thing on this page that runs
    // every frame; a meter that unmounts and leaves it spinning is a leak
    // nothing would ever notice.
    expect(calls).toBe(2);
    expect(pending).toHaveLength(0);
  });

  it('does not re-arm when the last meter unsubscribes DURING a frame', () => {
    // The realistic shape of this: a track strip unmounts while a frame is
    // already in flight, so the loop's own top-of-tick guard has already been
    // passed. Only the check before re-arming can stop it, and if it is missing
    // the loop spins forever against an empty subscriber set — invisible in a
    // browser, and permanent.
    meters.registerTrackVoice('t1', fakeVoice(-6, -6));
    let stop = () => {};
    stop = meters.subscribeMeter({ kind: 'track-in', trackId: 't1' }, () => {
      stop();
    });

    flushFrame();

    expect(pending).toHaveLength(0);
  });

  it('does not start a frame loop at all when nothing is subscribed', () => {
    meters.registerTrackVoice('t1', fakeVoice(-6, -6));
    expect(pending).toHaveLength(0);
  });

  it('survives one listener throwing without starving the others', () => {
    meters.registerTrackVoice('t1', fakeVoice(-3, -18));
    let reached = false;
    meters.subscribeMeter({ kind: 'track-in', trackId: 't1' }, () => {
      throw new Error('bad listener');
    });
    meters.subscribeMeter({ kind: 'track-out', trackId: 't1' }, () => {
      reached = true;
    });

    expect(() => flushFrame()).not.toThrow();
    expect(reached).toBe(true);
  });
});

describe('the OUT reading is post-fader', () => {
  /** Only the fields `setTrackFaders` reads. */
  function track(id: string, fields: Partial<{ volumeDb: number; muted: boolean; soloed: boolean }> = {}) {
    return { id, volumeDb: 0, muted: false, soloed: false, ...fields } as unknown as import('@fretwork/lib').Track;
  }

  function outOf(trackId: string): number {
    let db = 0;
    meters.subscribeMeter({ kind: 'track-out', trackId }, (value) => (db = value));
    flushFrame();
    return db;
  }

  it('moves with the fader — the whole reason a mixer meter exists', () => {
    meters.registerTrackVoice('t1', fakeVoice(-30, -12));
    meters.setTrackFaders([track('t1', { volumeDb: -6 })]);

    // The stage between the voice's tap and the master is ONE linear gain, so
    // its value in dB adds exactly. This is derived rather than measured and it
    // is not an approximation.
    expect(outOf('t1')).toBeCloseTo(-18, 5);
  });

  it('leaves the IN reading alone — the fader is downstream of it', () => {
    meters.registerTrackVoice('t1', fakeVoice(-30, -12));
    meters.setTrackFaders([track('t1', { volumeDb: -6 })]);
    let db = 0;

    meters.subscribeMeter({ kind: 'track-in', trackId: 't1' }, (value) => (db = value));
    flushFrame();

    expect(db).toBe(-30);
  });

  it('drops a muted track by the lib’s real mute depth, not to absolute silence', () => {
    meters.registerTrackVoice('t1', fakeVoice(-30, -12));
    meters.setTrackFaders([track('t1', { muted: true })]);

    // The lib mutes to a finite -80 dB, not to zero. A meter that drew mute as
    // silence would be telling a more comfortable story than the audio does.
    expect(outOf('t1')).toBeCloseTo(-92, 5);
  });

  it('silences a track because ANOTHER track is soloed', () => {
    meters.registerTrackVoice('t1', fakeVoice(-30, -12));
    meters.registerTrackVoice('t2', fakeVoice(-30, -12));
    meters.setTrackFaders([track('t1'), track('t2', { soloed: true })]);

    // Solo is not a property of the track being metered — which is why the whole
    // list has to be pushed, not one track at a time.
    expect(outOf('t1')).toBeCloseTo(-92, 5);
    expect(outOf('t2')).toBeCloseTo(-12, 5);
  });

  it('reads unaffected rather than silent for a track it has not been told about', () => {
    meters.registerTrackVoice('t1', fakeVoice(-30, -12));

    // Slightly wrong beats going dark on a bookkeeping miss.
    expect(outOf('t1')).toBe(-12);
  });

  it('stays silent when the voice itself is silent, whatever the fader says', () => {
    meters.registerTrackVoice('t1', fakeVoice(-Infinity, -Infinity));
    meters.setTrackFaders([track('t1', { volumeDb: 6 })]);

    // Without the guard this is `-Infinity + 6`, which is NaN territory for the
    // bar maths and draws as a full-scale meter on a silent track.
    expect(outOf('t1')).toBe(meters.SILENCE_DB);
  });

  it('forgets the faders when the engine is torn down', () => {
    meters.registerTrackVoice('t1', fakeVoice(-30, -12));
    meters.setTrackFaders([track('t1', { volumeDb: -6 })]);
    expect(outOf('t1')).toBeCloseTo(-18, 5);

    meters.clearTrackVoices();
    meters.registerTrackVoice('t1', fakeVoice(-30, -12));

    expect(outOf('t1')).toBe(-12);
  });
});

describe('the voice registry', () => {
  it('meters the voice that replaced one swapped live', () => {
    meters.registerTrackVoice('t1', fakeVoice(-30, -30));
    meters.registerTrackVoice('t1', fakeVoice(-2, -2));
    let db = 0;
    meters.subscribeMeter({ kind: 'track-in', trackId: 't1' }, (value) => (db = value));

    flushFrame();

    expect(db).toBe(-2);
  });

  it('falls back to silence once the engine is torn down', () => {
    meters.registerTrackVoice('t1', fakeVoice(-3, -3));
    let db = 0;
    meters.subscribeMeter({ kind: 'track-in', trackId: 't1' }, (value) => (db = value));
    flushFrame();
    expect(db).toBe(-3);

    meters.clearTrackVoices();
    flushFrame();

    expect(db).toBe(meters.SILENCE_DB);
  });

  it('forgets a single track without disturbing the others', () => {
    meters.registerTrackVoice('t1', fakeVoice(-3, -3));
    meters.registerTrackVoice('t2', fakeVoice(-9, -9));
    const seen: Record<string, number> = {};
    meters.subscribeMeter({ kind: 'track-in', trackId: 't1' }, (db) => (seen.t1 = db));
    meters.subscribeMeter({ kind: 'track-in', trackId: 't2' }, (db) => (seen.t2 = db));

    meters.unregisterTrackVoice('t1');
    flushFrame();

    expect(seen.t1).toBe(meters.SILENCE_DB);
    expect(seen.t2).toBe(-9);
  });
});
