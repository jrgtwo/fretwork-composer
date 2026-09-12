/**
 * The teardown removes our worker, only ours, and never throws.
 *
 * jsdom has no service worker and no Cache Storage, so `navigator.serviceWorker`
 * is stubbed here. That limits what can be asserted to the decisions the module
 * makes — which registrations it picks and how it degrades — not to whether a
 * real worker actually leaves the request path, which is a browser check
 * (Application → Service Workers shows none registered, on the SECOND load: an
 * active worker keeps controlling this page until it unloads).
 *
 * Degrading matters as much as the removal: this is called before `createRoot`,
 * so a throw here is a blank page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// The entry's TEXT, not its module — importing it would mount the app.
import entrySource from '../main.tsx?raw';
import { unregisterSampleCache } from './sampleCache';

const original = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');

function withServiceWorker(value: unknown): void {
  Object.defineProperty(navigator, 'serviceWorker', {
    value,
    configurable: true,
    writable: true,
  });
}

/** Enough of a registration for the script-URL match, with an `unregister` spy. */
function registration(
  scriptURL: string | null,
  slot: 'active' | 'waiting' | 'installing' = 'active',
) {
  const unregister = vi.fn().mockResolvedValue(true);
  return {
    active: null,
    waiting: null,
    installing: null,
    [slot]: scriptURL === null ? null : { scriptURL },
    unregister,
  } as unknown as ServiceWorkerRegistration & { unregister: ReturnType<typeof vi.fn> };
}

/** Let the module's promise chain settle — it is fire-and-forget by design. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Stubbed for every test: several of these drive `report()` on purpose, and an
 *  unstubbed one prints a stack trace out of a green suite. */
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  if (original) Object.defineProperty(navigator, 'serviceWorker', original);
  else delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  delete (globalThis as { caches?: unknown }).caches;
  vi.restoreAllMocks();
});

describe('unregisterSampleCache', () => {
  // All three slots, because a registration mid-update has its script in
  // `installing` or `waiting` and not yet in `active` — and a worker one reload
  // from intercepting is still a worker in the path.
  it.each(['active', 'waiting', 'installing'] as const)(
    'unregisters the retired /sw.js worker found in %s',
    async (slot) => {
      const ours = registration('https://app.test/sw.js', slot);
      withServiceWorker({ getRegistrations: vi.fn().mockResolvedValue([ours]) });
      unregisterSampleCache();
      await settle();
      expect(ours.unregister).toHaveBeenCalled();
    },
  );

  it('leaves another app sharing the origin alone', async () => {
    // Matching the script path narrows the ownership overreach the old worker's
    // activate handler was faulted for; it cannot eliminate it, because `/sw.js`
    // is also the conventional path.
    const theirs = registration('https://app.test/other-worker.js');
    withServiceWorker({ getRegistrations: vi.fn().mockResolvedValue([theirs]) });
    unregisterSampleCache();
    await settle();
    expect(theirs.unregister).not.toHaveBeenCalled();
  });

  it('warns once per failure rather than once per batch', async () => {
    // The per-registration `.catch` is the only observable difference from
    // letting the rejections fall through to the outer one: `map` has already
    // called every `unregister` before any of them can reject, so "keeps going"
    // is guaranteed by the loop. What the inner catch buys is that a second
    // failed worker is still reported.
    const first = registration('https://app.test/sw.js');
    first.unregister.mockRejectedValue(new Error('nope'));
    const second = registration('https://app.test/sw.js');
    second.unregister.mockRejectedValue(new Error('nope either'));
    withServiceWorker({ getRegistrations: vi.fn().mockResolvedValue([first, second]) });
    unregisterSampleCache();
    await settle();
    expect(second.unregister).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('ignores a registration with no script URL at all', async () => {
    const empty = registration(null);
    withServiceWorker({ getRegistrations: vi.fn().mockResolvedValue([empty]) });
    expect(() => unregisterSampleCache()).not.toThrow();
    await settle();
    expect(empty.unregister).not.toHaveBeenCalled();
    // Not warning is the assertion with teeth: both guards degrade to "skip it",
    // so a missing one is a REJECTED chain rather than a thrown call, and
    // `not.toThrow()` alone passes either way.
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores a script URL that will not parse', async () => {
    // Not one of ours, and leaving it alone is the safe half of the guess.
    const unparseable = registration('not a url');
    withServiceWorker({ getRegistrations: vi.fn().mockResolvedValue([unparseable]) });
    expect(() => unregisterSampleCache()).not.toThrow();
    await settle();
    expect(unparseable.unregister).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does nothing, and says nothing, where service workers are unavailable', async () => {
    // Private windows, insecure origins, a user who turned them off. In every
    // one of them there is also no worker left to remove — so the guard is not
    // only about not throwing: without it the app warns on every boot in
    // situations that are entirely ordinary.
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    expect(() => unregisterSampleCache()).not.toThrow();
    await settle();
    expect(warn).not.toHaveBeenCalled();
  });

  it('never touches Cache Storage', async () => {
    // The expensive invariant. The lib's store reuses the retired worker's cache
    // name on purpose, so every file already on disk is a hit on day one; a
    // `caches.delete` slipped in here would send the whole library back to an
    // origin that answers 429, with nothing on screen to say so.
    const caches = { open: vi.fn(), keys: vi.fn(), delete: vi.fn(), match: vi.fn() };
    (globalThis as { caches?: unknown }).caches = caches;
    const ours = registration('https://app.test/sw.js');
    withServiceWorker({ getRegistrations: vi.fn().mockResolvedValue([ours]) });
    unregisterSampleCache();
    await settle();
    expect(caches.open).not.toHaveBeenCalled();
    expect(caches.keys).not.toHaveBeenCalled();
    expect(caches.delete).not.toHaveBeenCalled();
    expect(caches.match).not.toHaveBeenCalled();
  });

  it('says so when the unregistered worker is still controlling the page', async () => {
    // `unregister()` marks the registration gone; the active worker keeps
    // controlling already-controlled clients until they unload. Without this the
    // first load after the change looks exactly like a failed teardown.
    const ours = registration('https://app.test/sw.js');
    withServiceWorker({
      getRegistrations: vi.fn().mockResolvedValue([ours]),
      controller: { scriptURL: 'https://app.test/sw.js' },
    });
    unregisterSampleCache();
    await settle();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('still controlling'));
  });

  it('does not blame a co-tenant’s controller when nothing of ours was found', async () => {
    const theirs = registration('https://app.test/other-worker.js');
    withServiceWorker({
      getRegistrations: vi.fn().mockResolvedValue([theirs]),
      controller: { scriptURL: 'https://app.test/other-worker.js' },
    });
    unregisterSampleCache();
    await settle();
    expect(warn).not.toHaveBeenCalled();
  });

  it('swallows a rejected getRegistrations', async () => {
    withServiceWorker({ getRegistrations: vi.fn().mockRejectedValue(new Error('nope')) });
    expect(() => unregisterSampleCache()).not.toThrow();
    await settle();
  });

  it('swallows a synchronous throw from getRegistrations', () => {
    withServiceWorker({
      getRegistrations: vi.fn(() => {
        throw new Error('nope');
      }),
    });
    expect(() => unregisterSampleCache()).not.toThrow();
  });

  it('warns when the teardown fails, because a surviving worker does not look broken', async () => {
    withServiceWorker({ getRegistrations: vi.fn().mockRejectedValue(new Error('nope')) });
    unregisterSampleCache();
    await settle();
    expect(warn).toHaveBeenCalled();
  });
});

describe('the entry point', () => {
  it('calls the teardown, and before the first render', () => {
    // The call site IS the change: delete it and the worker survives every
    // reload, with the only symptom being that sample loads keep reading
    // `(ServiceWorker)`. Asserted against the entry's TEXT for the same reason
    // `sampleRate.test.ts` does — importing it would mount the app.
    expect(entrySource).toContain('unregisterSampleCache()');
    expect(entrySource.indexOf('unregisterSampleCache()')).toBeLessThan(
      entrySource.indexOf('createRoot('),
    );
  });
});
