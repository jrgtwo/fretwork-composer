/**
 * Tears down the retired sample-cache service worker.
 *
 * ── What this is cleaning up ─────────────────────────────────────────────────
 *
 * Sample caching moved into `@fretwork/lib` (`playback/voices/sample-store.ts`),
 * which reads Cache Storage FIRST and treats the network as the last resort.
 * The worker this app used to register was the opposite shape — a network
 * interceptor, so every load still began as a request, and a request is the
 * axis Supabase rate-limits on. `public/sw.js` and its policy module are gone;
 * this is the only thing left of them, and it exists solely to get the already
 * registered copies out of the request path — FROM THE NEXT LOAD ON. An active
 * worker keeps controlling the clients it already controls until they unload,
 * so `unregister()` marks the registration gone and changes nothing about this
 * page: loads on the load that performs the teardown are still intercepted and
 * still read `(ServiceWorker)`. That is why the warning below distinguishes
 * "still controlling" from "could not be removed" — one is expected once, the
 * other never is.
 *
 * ── Why a teardown is mandatory, not belt-and-braces ────────────────────────
 *
 * Deleting `sw.js` does not unregister it. A 404 on the script during an update
 * check would, per spec — but Vite's SPA fallback answers `/sw.js` with
 * `index.html`, so the update check fails on MIME type instead and the
 * registration survives every reload. A surviving worker keeps intercepting:
 * it double-stores every file, and it answers the lib store's misses out of its
 * own cache, which reports as `(ServiceWorker)` in the Network tab. That is the
 * store's only failure signal, masked.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 *
 * It does not touch Cache Storage. The lib's store reuses the worker's cache
 * name (`fretwork-samples-v1`) on purpose, so every file the worker already put
 * on disk is a hit on day one. Clearing it here would throw that away and send
 * the whole library back to the origin once more — the exact cost this work
 * exists to remove.
 *
 * It also only unregisters workers whose script is `/sw.js`, which NARROWS the
 * ownership overreach the old worker's activate handler was faulted for without
 * eliminating it: `/sw.js` is the conventional path, so a co-tenant on a shared
 * dev origin (the same condition that makes the lib's `fretwork:master-gain-db`
 * key shared) serving its worker there is caught too, and nothing client-side
 * can tell the two apart. What the match does buy is that this never enumerates
 * registrations and removes them blindly. A worker registered against a
 * DIFFERENT origin — `localhost:5174` from a run before `strictPort` landed —
 * is not reachable from here at all, and has to be cleared by hand in DevTools.
 *
 * ── Failure is not an error ─────────────────────────────────────────────────
 *
 * Same discipline as the registration it replaces: every branch degrades to
 * "the worker is still there" rather than throwing. This runs before
 * `createRoot`, so an escaping throw is a blank page — a cache teardown taking
 * the whole app down. Service workers are absent in plenty of ordinary
 * situations (private windows, insecure origins, disabled by the user), and in
 * every one of them there is also no worker to remove.
 */

/** The script the retired worker was served as. Matched rather than assumed —
 *  see the ownership note in the header. */
const RETIRED_WORKER_PATH = '/sw.js';

export function unregisterSampleCache(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    const container = navigator.serviceWorker;
    // `getRegistrations` rather than `getRegistration('/')`: scope alone cannot
    // tell our root-scoped worker from a co-tenant's, and the script URL can.
    Promise.resolve(container.getRegistrations())
      .then((registrations) =>
        Promise.all(
          registrations.filter(isRetiredSampleCache).map((registration) =>
            // A rejected `unregister()` is one worker still in the path, not a
            // reason to abandon the others.
            Promise.resolve(registration.unregister()).catch(report),
          ),
        ),
      )
      .then((removed) => {
        if (removed.length > 0) reportStillControlling();
      })
      .catch(report);
  } catch (error) {
    // `.catch` covers a REJECTED call; this covers a THROWN one. The
    // registration this replaces needed the same pair, and for the same reason:
    // the throw would otherwise escape into `main.tsx` ahead of the first
    // render.
    report(error);
  }
}

/**
 * Is this registration the worker we retired?
 *
 * All three slots are checked because a registration mid-update has its script
 * in `installing` or `waiting` and not yet in `active` — and a worker that is
 * only installing is one reload away from intercepting.
 */
function isRetiredSampleCache(registration: ServiceWorkerRegistration): boolean {
  const workers = [registration.active, registration.waiting, registration.installing];
  return workers.some((worker) => {
    if (!worker?.scriptURL) return false;
    try {
      return new URL(worker.scriptURL).pathname === RETIRED_WORKER_PATH;
    } catch {
      // A `scriptURL` that will not parse is not one of ours; leaving it alone
      // is the safe half of the guess.
      return false;
    }
  });
}

/**
 * Say so when the removed worker is still driving THIS page.
 *
 * Only reached when something of ours was actually unregistered, so a
 * co-tenant's worker controlling the page cannot trip it. Deliberately not a
 * `location.reload()`: this runs ahead of `createRoot`, and a reload there is a
 * boot loop away from a bug.
 */
function reportStillControlling(): void {
  if (!navigator.serviceWorker?.controller) return;
  console.warn(
    '[fretwork] the retired sample-cache worker is unregistered but still controlling ' +
      'this page — reload once to leave its request path.',
  );
}

/**
 * Say so when the worker could not be removed.
 *
 * REPORTED, not swallowed, and this one matters more than the failed
 * registration it replaces did: a surviving worker does not look broken. It
 * looks like the new store working, because its `(ServiceWorker)` responses are
 * fast and its cache is the same cache. The only way to tell from the outside
 * is Application → Service Workers, which nobody checks unbidden.
 *
 * `warn` rather than `error`: the app plays either way.
 */
function report(error: unknown): void {
  console.warn(
    '[fretwork] the retired sample-cache worker could not be unregistered — ' +
      'it may still be intercepting sample loads. Remove it in DevTools → Application.',
    error,
  );
}
