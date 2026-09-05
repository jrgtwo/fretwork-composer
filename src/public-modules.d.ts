/**
 * Types for the modules under `public/`.
 *
 * `public/sample-cache-policy.js` is plain JavaScript on purpose: it is
 * imported at runtime by `public/sw.js`, which has to be served unbundled from
 * the site root or its service-worker scope would not cover the app. It is
 * also imported by `sampleCachePolicy.test.ts`, so the shipped policy and the
 * tested policy are one file rather than two that can drift.
 *
 * The declaration lives here rather than as a `.d.ts` beside the module so
 * that `public/` contains only files meant to be served.
 */
declare module '*/sample-cache-policy.js' {
  export const SAMPLE_TTL_MS: number;
  export const JITTER_FRACTION: number;
  export function isSampleRequest(url: string): boolean;
  export function expiryFor(nowMs: number, random?: () => number): number;
  export function isStale(expiresAtMs: number | null | undefined, nowMs: number): boolean;
}
