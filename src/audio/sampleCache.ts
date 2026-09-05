/**
 * Registers the sample cache's service worker.
 *
 * ── What it buys ────────────────────────────────────────────────────────────
 *
 * Sample files are fetched once per machine instead of once per voice rebuild.
 * Supabase serves them `cache-control: no-cache` and Tone keeps no buffer
 * cache, so without this every rebuilt voice re-requests all 144 files of a
 * pack — enough, in practice, for the origin to start answering 429, at which
 * point the refused notes play silently.
 *
 * ── Why a service worker and not something simpler ──────────────────────────
 *
 * `Tone.Sampler` does its own fetching, inside the lib, with no hook to pass a
 * cache through. A worker is the only place the app can get between Tone and
 * the network without changing how the lib loads samples.
 *
 * ── Failure is not an error ─────────────────────────────────────────────────
 *
 * Every branch here degrades to "no cache" rather than throwing. Service
 * workers are unavailable in a lot of ordinary situations — private windows,
 * insecure origins, a user who has disabled them — and none of those should
 * stop the app loading. Uncached is slower and costlier; it is not broken.
 */

/** Scope is the site root because the worker is served from there. A worker
 *  under `/assets/` would only see requests under `/assets/` and would
 *  intercept nothing — which is why `public/sw.js` is unbundled. */
const SERVICE_WORKER_URL = '/sw.js';

export function registerSampleCache(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    // A module worker, because `sw.js` imports the policy it shares with its
    // tests rather than carrying a second copy of it.
    navigator.serviceWorker.register(SERVICE_WORKER_URL, { type: 'module' }).catch(report);
  } catch (error) {
    // `.catch` covers a REJECTED registration; this covers a THROWN one, which
    // some browsers do for an unsupported `type: 'module'` worker. Without it
    // the throw escapes into `main.tsx` ahead of `createRoot` and the page is
    // blank — a caching optimisation taking the whole app down.
    report(error);
  }
}

/**
 * Say so when the cache does not come up.
 *
 * REPORTED, not swallowed. A failed registration is invisible from the outside
 * — the app works, just slower and at the origin's expense — so the only
 * symptom is network traffic nobody expected, with nothing to point at. That
 * is the same shape as the swallowed rebuild failure in `playbackService`, and
 * it cost a debugging session to find.
 *
 * `warn` rather than `error`: nothing is broken, and every reason this fails
 * (private window, insecure origin, service workers disabled) is a legitimate
 * way to run the app.
 */
function report(error: unknown): void {
  console.warn('[fretwork] sample cache unavailable — samples will be re-fetched.', error);
}
