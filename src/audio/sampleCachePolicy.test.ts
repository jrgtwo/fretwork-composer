/**
 * The sample cache's decisions, without a browser.
 *
 * Imported from `public/` deliberately. The service worker has to be served
 * from the site ROOT to intercept anything, so it cannot be bundled out of
 * `src/` — and a policy copied into it would be a second definition of "is
 * this stale" that nothing checks. One module, imported by the worker at
 * runtime and by this file at test time.
 */
import { describe, it, expect } from 'vitest';
import {
  SAMPLE_TTL_MS,
  JITTER_FRACTION,
  isSampleRequest,
  expiryFor,
  isStale,
} from '../../public/sample-cache-policy.js';

describe('isSampleRequest', () => {
  const base = 'https://ssszubkbregwjgkrpqop.supabase.co/storage/v1/object/public/samples';

  it('matches a sample file', () => {
    expect(isSampleRequest(`${base}/offsetp90-2/rr1/E3.mp3`)).toBe(true);
  });

  it('matches a cabinet impulse response, which is the same bucket', () => {
    expect(isSampleRequest(`${base}/cabinet-irs/twin.wav`)).toBe(true);
  });

  it('matches whatever project ref the storage lives under', () => {
    // The ref is not hard-coded: a moved project must not silently stop being
    // cached, which would look like a performance regression with no cause.
    expect(isSampleRequest('https://other.supabase.co/storage/v1/object/public/samples/a/b.mp3'))
      .toBe(true);
  });

  it('ignores everything else', () => {
    expect(isSampleRequest('https://ssszubkbregwjgkrpqop.supabase.co/rest/v1/voices')).toBe(false);
    expect(isSampleRequest('http://localhost:5173/src/main.tsx')).toBe(false);
    expect(isSampleRequest('https://tonejs.github.io/audio/casio/A1.mp3')).toBe(false);
    expect(isSampleRequest('not a url at all')).toBe(false);
  });
});

describe('expiryFor', () => {
  const NOW = 1_800_000_000_000;

  it('sits one TTL ahead, before jitter', () => {
    // random() === 0.5 is the midpoint, so no offset is applied.
    expect(expiryFor(NOW, () => 0.5)).toBe(NOW + SAMPLE_TTL_MS);
  });

  it('spreads expiry so a pack does not all fall due at once', () => {
    // 144 files written in the same instant would otherwise expire in the same
    // instant, and the refresh burst is exactly the shape that got the origin
    // to return 429. Jitter is what turns that spike into a trickle.
    const earliest = expiryFor(NOW, () => 0);
    const latest = expiryFor(NOW, () => 1);
    expect(latest - earliest).toBeCloseTo(2 * JITTER_FRACTION * SAMPLE_TTL_MS, 0);
    expect(earliest).toBeLessThan(NOW + SAMPLE_TTL_MS);
    expect(latest).toBeGreaterThan(NOW + SAMPLE_TTL_MS);
  });

  it('never returns an already-expired time, whatever random does', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      expect(expiryFor(NOW, () => r)).toBeGreaterThan(NOW);
    }
  });
});

describe('isStale', () => {
  const NOW = 1_800_000_000_000;

  it('is fresh before the expiry', () => {
    expect(isStale(NOW + 1000, NOW)).toBe(false);
  });

  it('is stale at and after the expiry', () => {
    expect(isStale(NOW, NOW)).toBe(true);
    expect(isStale(NOW - 1, NOW)).toBe(true);
  });

  it('treats a missing or unparseable expiry as stale', () => {
    // A cached entry written by an older build carries no stamp. Refreshing it
    // once is right; trusting it forever is how a cache outlives its format.
    expect(isStale(null, NOW)).toBe(true);
    expect(isStale(undefined, NOW)).toBe(true);
    expect(isStale(Number.NaN, NOW)).toBe(true);
  });
});
