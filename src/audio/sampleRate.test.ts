import { describe, expect, it, vi } from 'vitest';
// The entry's TEXT, not its module — importing it would mount the app.
import entrySource from '../main.tsx?raw';

const lib = vi.hoisted(() => ({ forceSampleRate: vi.fn() }));

vi.mock('@fretwork/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fretwork/lib')>();
  return { ...actual, forceSampleRate: lib.forceSampleRate };
});

describe('sampleRate', () => {
  it('pins the context to 48kHz on import', async () => {
    const { AUDIO_SAMPLE_RATE } = await import('./sampleRate');
    expect(lib.forceSampleRate).toHaveBeenCalledWith(48_000);
    expect(AUDIO_SAMPLE_RATE).toBe(48_000);
  });

  it('is the entry point’s first import', () => {
    // The ordering IS the mechanism: `forceSampleRate` replaces Tone's context,
    // which only works while nothing has been built on the old one. An import
    // sorter that moves this below `./App` breaks it silently — the app still
    // runs, at the device's native rate, and the only symptom is playback
    // drifting behind the playhead on high-rate devices.
    const imports = entrySource
      .split('\n')
      .filter((line: string) => line.startsWith('import '));
    expect(imports[0]).toContain('./audio/sampleRate');
  });
});
