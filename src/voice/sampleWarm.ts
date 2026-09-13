/**
 * The sample-bank warm — a debounce in front of the lib's `prefetchSampleBanks`,
 * KEYED BY HOLDER.
 *
 * Its own module rather than a pair of consts above `VoiceEditor` for the reason
 * the rest of this project keeps pure logic out of React: it is module state with
 * timers in it, it needs a reset the tests can call, and a non-component export
 * beside a component is also what breaks fast refresh for the whole file.
 */
import { prefetchSampleBanks } from '@fretwork/lib';

/**
 * The prefetch itself is the lib's — picking a pack does NOT download, because
 * `reconcile` won't build an audio graph on a page that has never made a sound,
 * so without a warm the first Play after a pack change stalls on the whole bank.
 * The RATE is ours: a native `<select>` fires `change` once per arrow key while
 * closed, so a keyboard user stepping the packs passes through every one of
 * them, and the Philharmonia pack alone is ~45 MP3s.
 *
 * ⚠ THE KEY IS THE MULTI-INSTANCE FIX. This was one module-level timer and one
 * `pendingBanks`, written once because only the pattern page had a prefetch —
 * last-writer-wins, so two racks touching their pack pickers dropped one warm
 * entirely. Both now coalesce against their own holder.
 *
 * ⚠ VESTIGIAL, kept for one task rather than permanently: the lib's
 * `prefetchSampleBanks` now routes through the sample store's `warmUrls`, which
 * pools, backs off and dedupes, and a warm of an already-cached pack stops at
 * PRESENCE. Its row in `docs/FOLLOW-UPS.md` names the deletion condition, which
 * is NOT met — the store's behaviour has not been heard in a browser yet.
 *
 * No dedupe set: `prefetchSampleBanks` is documented idempotent.
 */
const WARM_COALESCE_MS = 120;
export type Banks = ReadonlyArray<Readonly<Record<string, string>>>;
const pendingWarms = new Map<string, { timer: ReturnType<typeof setTimeout>; banks: Banks }>();

/**
 * Drop every warm that has not fired yet — FOR TESTS, and for the reason
 * `voiceDrafts.clearVoiceDrafts` exists: this map outlives every unmount, and a
 * timer armed by one test firing inside the next one fetches a sample bank
 * against whatever `fetch` that test had stubbed.
 *
 * Deliberately NOT called on unmount by the component. A warm should survive
 * navigation — that is the whole point of getting the bank on disk before the
 * first Play — and the app has exactly one page to navigate between.
 */
export function clearPendingWarms(): void {
  for (const pending of pendingWarms.values()) clearTimeout(pending.timer);
  pendingWarms.clear();
}

export function warmSampleBanks(holder: string, banks: Banks): void {
  const pending = pendingWarms.get(holder);
  if (pending) clearTimeout(pending.timer);
  const timer = setTimeout(() => {
    const entry = pendingWarms.get(holder);
    pendingWarms.delete(holder);
    if (entry) prefetchSampleBanks(entry.banks);
  }, WARM_COALESCE_MS);
  pendingWarms.set(holder, { timer, banks });
}
