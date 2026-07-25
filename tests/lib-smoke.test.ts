import { describe, it, expect } from 'vitest';
import { createEmptyPattern } from '@fretwork/lib';

// Smoke test: confirms the @fretwork/lib git dep resolves and runs under Vitest
// (the dist barrel's directory imports need vite's server.deps.inline). No app
// wiring here — just "the music domain is available."
describe('@fretwork/lib', () => {
  it('createEmptyPattern returns a pattern object', () => {
    const pattern = createEmptyPattern('Smoke Test');
    expect(pattern.id).toEqual(expect.any(String));
    expect(pattern.name).toBe('Smoke Test');
    expect(pattern.durationTicks).toBeGreaterThan(0);
  });
});
