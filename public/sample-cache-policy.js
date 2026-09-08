/**
 * When a cached sample file stops being trusted.
 *
 * ── Why this file is in `public/` ───────────────────────────────────────────
 *
 * A service worker only intercepts requests within its own scope, and scope
 * comes from where the script is SERVED. Bundling it out of `src/` would land
 * it in `/assets/`, whose scope is `/assets/` — it would intercept nothing.
 * So the worker is served from the root, unbundled, and this module sits
 * beside it. `src/audio/sampleCachePolicy.test.ts` imports this same file, so
 * there is one definition of "is this stale" rather than a tested copy and a
 * shipped copy that quietly disagree.
 *
 * ── Why a local expiry rather than asking the origin ────────────────────────
 *
 * The obvious alternative is HTTP revalidation: let the browser ask "changed?"
 * when its `max-age` runs out. That is cheap in bytes — a 304 is a few hundred
 * — but it is one REQUEST PER FILE, and a pack is 144 files. Requests are the
 * axis that broke: Supabase answered with 429 Too Many Requests, and a sampler
 * whose notes were refused has no buffer for them, so they play silently.
 *
 * Expiring locally inverts the trade. A 30-day TTL costs 144 requests a month
 * instead of ~4,300, at the price of re-downloading ~11 MB that probably did
 * not change. Bytes are the cheap axis, so that is the right thing to waste.
 * Serve stale while refreshing, so nobody waits on it.
 *
 * ── What was measured, and what cannot be changed ───────────────────────────
 *
 * MEASURED, not inferred. Supabase answers a CDN MISS with `cache-control:
 * no-cache` and a Smart CDN HIT with `public, max-age=3600` — so a `curl` from
 * outside the CDN only ever sees the former, and the browser's own HTTP cache
 * cannot be relied on either way. `cacheControl` can only be set at UPLOAD
 * time: there is no API for it and no dashboard field, so changing what the
 * origin says means re-uploading all 670 objects (~78 KB each, ~45 MB).
 *
 * And there is no fallback inside Tone. `ToneAudioBuffer.downloads` is a list
 * of in-flight promises for `Tone.loaded()` to await, NOT a URL to buffer map,
 * so every new `Tone.Sampler` re-fetches and re-decodes every file it is given.
 *
 * ── Rejected by the user ────────────────────────────────────────────────────
 *
 * Content-addressed URLs — never reusing a path — because overwriting a sample
 * in place has to keep working. And any extra Supabase API call to check
 * freshness, because REQUESTS are the axis being conserved.
 */

/** How long a downloaded sample is trusted. Long, because these files change
 *  rarely and the cost of being wrong is one stale note, not a broken app. */
export const SAMPLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How far either side of the TTL an entry's expiry is spread. */
export const JITTER_FRACTION = 0.1;

/**
 * Whether this request is a sample file we should be caching.
 *
 * Matched on the storage PATH, not on the project's hostname. Hard-coding the
 * project ref would mean a moved project silently stops being cached — which
 * presents as an unexplained performance regression with nothing pointing at
 * the cause.
 */
export function isSampleRequest(url) {
  try {
    return new URL(url).pathname.includes('/storage/v1/object/public/samples/');
  } catch {
    return false;
  }
}

/**
 * When an entry written now should fall due.
 *
 * Jittered, and that is load-bearing rather than tidy. A pack's 144 files are
 * written within the same second, so a fixed TTL makes all 144 expire within
 * the same second — and the refresh is then the same 144-request burst that
 * caused the rate limiting in the first place. Spreading them turns the spike
 * into a trickle.
 *
 * @param nowMs   current epoch ms
 * @param random  injected so the spread is testable; defaults to Math.random
 */
export function expiryFor(nowMs, random = Math.random) {
  const offset = (random() * 2 - 1) * JITTER_FRACTION * SAMPLE_TTL_MS;
  return nowMs + SAMPLE_TTL_MS + offset;
}

/**
 * Whether a cached entry is due for a refresh.
 *
 * A missing or unparseable stamp counts as stale. An entry written by an older
 * build carries no expiry, and refreshing it once is right where trusting it
 * forever is how a cache outlives the format it was written in.
 */
export function isStale(expiresAtMs, nowMs) {
  if (typeof expiresAtMs !== 'number' || !Number.isFinite(expiresAtMs)) return true;
  return nowMs >= expiresAtMs;
}
