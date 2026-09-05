/**
 * Sample cache — a service worker that keeps sample files on disk.
 *
 * ── The problem it solves ───────────────────────────────────────────────────
 *
 * Supabase serves these files with `cache-control: no-cache`, so the browser
 * is not allowed to reuse them without asking first, and Tone keeps no buffer
 * cache of its own — every `Tone.Sampler` re-fetches and re-decodes every URL
 * it is given. A pack is 144 files at ~78 KB, and the app rebuilds voices
 * often enough that Supabase started answering 429 Too Many Requests. A
 * sampler whose notes were refused has no buffer for them, so those notes play
 * silently, with no error anywhere.
 *
 * The Cache Storage API is the right layer for this because it is EXPLICIT:
 * what goes in stays in until something takes it out. `no-cache` does not
 * apply to it, which is why this works without touching how the files are
 * served.
 *
 * ── The policy, in one line ─────────────────────────────────────────────────
 *
 * Serve from disk always; refresh in the background when an entry is past its
 * (jittered) expiry. See `sample-cache-policy.js` for why expiry is local
 * rather than revalidated against the origin.
 */
import { isSampleRequest, expiryFor, isStale } from './sample-cache-policy.js';

/** Bump to drop every cached sample on the next load. The escape hatch for
 *  "a file was overwritten and has to be gone now" — the routine path is the
 *  expiry, which needs no deploy. */
const CACHE = 'fretwork-samples-v1';

/** Where an entry's expiry is stamped. A header on the stored copy, so the
 *  expiry travels WITH the response rather than in a second store that can
 *  disagree with it. Never sent to the network. */
const EXPIRES_HEADER = 'x-fretwork-expires';

self.addEventListener('install', (event) => {
  // Take over without waiting for existing tabs: this worker only adds
  // caching, so there is no half-upgraded state to protect against.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || !isSampleRequest(request.url)) return;
  event.respondWith(serveSample(event, request));
});

async function serveSample(event, request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);

  if (!hit) return fetchAndStore(cache, request);

  const expiresAt = Number(hit.headers.get(EXPIRES_HEADER));
  if (isStale(expiresAt, Date.now())) {
    // STALE-WHILE-REVALIDATE. The user gets the copy we already have, now, and
    // the refresh happens behind them — so an expiry is never something anyone
    // waits for. `waitUntil` keeps the worker alive for it; the failure is
    // swallowed because a refresh that cannot reach the network must leave the
    // usable copy in place rather than take it away.
    event.waitUntil(fetchAndStore(cache, request).catch(() => {}));
  }
  return hit;
}

async function fetchAndStore(cache, request) {
  const response = await fetch(request);
  // Only success is worth keeping. A 429 or a 404 cached for thirty days would
  // turn a transient rate-limit into a month of silent notes — the exact bug
  // this file exists to end.
  if (response.ok) await cache.put(request, await stamped(response.clone()));
  return response;
}

/** A copy of `response` carrying the expiry we will read it back with. */
async function stamped(response) {
  const headers = new Headers(response.headers);
  headers.set(EXPIRES_HEADER, String(expiryFor(Date.now())));
  return new Response(await response.blob(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
