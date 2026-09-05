/**
 * Registration degrades rather than throws.
 *
 * The worker's own behaviour is not testable here — jsdom has no service
 * worker and no Cache Storage — and its decisions live in
 * `sampleCachePolicy.test.ts`, which tests the module the worker actually
 * imports. What is left, and what this holds, is that none of the ordinary
 * ways a service worker is unavailable can stop the app booting: this is
 * called before `createRoot`, so a throw here is a blank page.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerSampleCache } from './sampleCache';

const original = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');

function withServiceWorker(value: unknown): void {
  Object.defineProperty(navigator, 'serviceWorker', {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (original) Object.defineProperty(navigator, 'serviceWorker', original);
  else delete (navigator as { serviceWorker?: unknown }).serviceWorker;
});

describe('registerSampleCache', () => {
  it('registers the root-scoped worker as a module', () => {
    const register = vi.fn().mockResolvedValue({});
    withServiceWorker({ register });
    registerSampleCache();
    // Root scope is the whole point: a worker served from anywhere else
    // intercepts nothing.
    expect(register).toHaveBeenCalledWith('/sw.js', { type: 'module' });
  });

  it('does nothing where service workers are unavailable', () => {
    withServiceWorker(undefined);
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    expect(() => registerSampleCache()).not.toThrow();
  });

  it('swallows a rejected registration', async () => {
    // Private windows, insecure origins, a user who turned them off. All
    // ordinary, none of them a reason for the app not to start.
    const register = vi.fn().mockRejectedValue(new Error('nope'));
    withServiceWorker({ register });
    expect(() => registerSampleCache()).not.toThrow();
    await Promise.resolve();
  });

  it('swallows a synchronous throw from register', () => {
    const register = vi.fn(() => {
      throw new Error('nope');
    });
    withServiceWorker({ register });
    expect(() => registerSampleCache()).not.toThrow();
  });
});
