/**
 * The unsaved voice edits of the composition page — up to one per track.
 *
 * ── Why this is a module and not React state ─────────────────────────────────
 *
 * The pattern page's single working copy lives in `App` because `PaneStack`
 * unmounts a collapsed pane's body. Here there are up to EIGHT of them and two
 * unmounts to survive, not one: leaving voice mode replaces what every lane
 * draws, and visiting the pattern page unmounts `CompositionPage` outright. So
 * they live above every component there is — which is what a module is — for the
 * same reason `mode`, `paneOrder` and `collapsedPanes` live above the page.
 *
 * Two things follow from that, and neither is available to `App`-held state:
 *
 *  - **The agent can reach it.** {@link setTrackVoiceParam} takes a track id, a
 *    schema path and a value, refuses in words and never throws, so every knob
 *    in `TrackVoiceRack` is a way of CALLING a capability rather than the only
 *    way to have it. React state in `App` could not be called at all.
 *  - **The engine can read it without a second copy.** `playbackService` builds
 *    a track's `Voice` from {@link readTrackVoiceDraft} directly. The pattern
 *    path instead pushes its working copy at the engine, which then keeps its
 *    own tagged mirror (`workingPreset` there) — two sources of truth, which is
 *    tolerable for one voice and is not for eight.
 *
 * ── The tag, and why a draft retires ─────────────────────────────────────────
 *
 * A draft is tagged with the track's instrument and voice ref, exactly as
 * `playbackService.workingTagOf` tags the pattern page's. Pick a different voice
 * for the track, or change its instrument, and the tag stops matching: the draft
 * is an edit OF a voice, and it must not follow the user onto the next one. The
 * stored preset takes over the moment it does.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────
 *
 * There is no Save here. A draft is unsaved by definition; writing it to a
 * variant is CP-15's, along with the variant list and Save as… / Rename. A voice
 * is also a SHARED asset — the variant a track points at is the same object the
 * pattern page edits — so a Save would retune every holder, which is exactly why
 * it is a deliberate act with its own UI rather than a side effect of turning a
 * knob.
 */
import { useSyncExternalStore } from 'react';
import { getSamplePack, type Track, type VoicePreset } from '@fretwork/lib';
import { findTrack, trackInstrumentId, type Result } from '../composition/compositionService';
import {
  readTrackVoiceRef,
  resolveTrackVoicePreset,
  useTrackVoicePreset,
  voiceKey,
} from './voiceService';
import { PARAM_SECTIONS, sectionApplies, type Param, type SectionId } from './paramSchema';
import { removeAtPath, setAtPath } from './presetPaths';

/** One track's unsaved edit, and the voice choice it is an edit OF. */
interface TrackVoiceDraft {
  readonly tag: string;
  readonly preset: VoicePreset;
}

/**
 * NOT garbage-collected when a track is removed, and that is a decision rather
 * than an oversight. Track ids are unique, so nothing resurrects; what is left
 * behind is one preset object per removed track per session.
 *
 * The two hooks that look right are both worse. Pruning from
 * `compositionService.removeTrack` puts an import from the composition seam back
 * into this module's own importer — a cycle, to collect a few hundred bytes.
 * Pruning against the tracks of the CURRENT composition (from `syncComposition`,
 * say) throws a track's unsaved tone away when you open another composition and
 * come back, which is precisely the loss CP-14 is written to prevent.
 */
const drafts = new Map<string, TrackVoiceDraft>();

/**
 * Listeners are told WHICH track moved, not merely that something did: the only
 * subscriber that acts on this is the audio seam, and it rebuilds one track's
 * voice — a sampler and an HTTP load per bank — so a notification that cannot
 * name a track would rebuild eight of them per knob turn.
 */
type DraftListener = (trackId: string) => void;
const listeners = new Set<DraftListener>();

/** For `useSyncExternalStore`, which cannot take a per-track argument through
 *  `subscribe`. The per-track bail-out is the SNAPSHOT's job instead: an
 *  unchanged track hands back the same entry object and React re-renders
 *  nothing (see {@link useTrackVoiceWorkingPreset}). */
function subscribeAll(listener: () => void): () => void {
  const wrapped: DraftListener = () => listener();
  listeners.add(wrapped);
  return () => {
    listeners.delete(wrapped);
  };
}

/** Wrapped for the same reason {@link subscribeAll} wraps: a `Set` keyed by the
 *  function itself dedupes two subscribers that happen to pass the same
 *  module-level reference, and the first unsubscribe would then silence the
 *  other one. */
export function subscribeTrackVoiceDrafts(listener: DraftListener): () => void {
  const wrapped: DraftListener = (trackId) => listener(trackId);
  listeners.add(wrapped);
  return () => {
    listeners.delete(wrapped);
  };
}

function notify(trackId: string): void {
  listeners.forEach((listener) => listener(trackId));
}

/** Instrument + ref, with no preset content in it — see the tag section above.
 *  Built from the ref's discriminant rather than `JSON.stringify`, so a ref
 *  rehydrated as `{id, kind}` keys the same as the `{kind, id}` a picker mints. */
function tagOf(track: Track): string {
  const ref = readTrackVoiceRef(track);
  return `${trackInstrumentId(track)}|${ref ? voiceKey(ref) : 'none'}`;
}

/**
 * A track's unsaved preset, or null.
 *
 * SELF-CLEARING, like `playbackService.workingPresetFor`: a tag that has stopped
 * matching can never matter again, and leaving it live means an abandoned edit
 * resurrects the moment the track points back at the voice it was taken from.
 *
 * Non-reactive, and it MUTATES — so it is for the audio seam and event handlers,
 * never for a render. `useTrackVoiceWorkingPreset` compares the tag without
 * clearing, because a store write during render is a React error rather than a
 * style question.
 */
export function readTrackVoiceDraft(track: Track): VoicePreset | null {
  const draft = drafts.get(track.id);
  if (!draft) return null;
  if (draft.tag === tagOf(track)) return draft.preset;
  drafts.delete(track.id);
  return null;
}

/**
 * The preset a track's rack is showing and its engine is building: the unsaved
 * edit when there is one, otherwise whatever the lib resolves its ref to.
 *
 * The NON-REACTIVE read, paired with {@link useTrackVoiceWorkingPreset}. Used by
 * the writes below and by tests; a render wants the hook.
 */
export function trackVoicePreset(track: Track): VoicePreset {
  return readTrackVoiceDraft(track) ?? resolveTrackVoicePreset(track);
}

/** Whether this track carries an edit that no variant holds. The non-reactive
 *  half of {@link useTrackVoiceDirty}, on the same terms as above. */
export function isTrackVoiceDirty(track: Track): boolean {
  return readTrackVoiceDraft(track) !== null;
}

/**
 * React hook: {@link trackVoicePreset}, subscribed.
 *
 * TWO subscriptions, because there are two ways the answer moves. The drafts
 * store carries this track's own edits; the seam's `useTrackVoicePreset` carries
 * a rename, a save or a change to the instrument's global active variant, none
 * of which touch either this module or the composition store. That half is the
 * seam's own hook rather than a second copy of it — `voiceService` is the ONLY
 * module allowed to reach the lib's voice store, and this one is not it.
 *
 * The draft snapshot is the ENTRY OBJECT, not the preset, and that is what keeps
 * a knob drag on one rack from re-rendering the other seven: a track nobody
 * edited hands back the identical object and React bails out per consumer.
 */
export function useTrackVoiceWorkingPreset(track: Track): VoicePreset {
  const entry = useSyncExternalStore(
    subscribeAll,
    () => drafts.get(track.id),
    () => drafts.get(track.id),
  );
  const stored = useTrackVoicePreset(track);
  return entry && entry.tag === tagOf(track) ? entry.preset : stored;
}

/** React hook: whether this track's rack is showing an unsaved edit. */
export function useTrackVoiceDirty(track: Track): boolean {
  const entry = useSyncExternalStore(
    subscribeAll,
    () => drafts.get(track.id),
    () => drafts.get(track.id),
  );
  return entry !== undefined && entry.tag === tagOf(track);
}

// ----------------------------------------------------------------- writing ---

/**
 * Record an edit against one track.
 *
 * The identity guard is not an optimisation: `setAtPath` returns the SAME object
 * when the write changes nothing, so a control reporting its current value must
 * not mark the track dirty — and must not fire a voice rebuild. Compared against
 * whatever the track is showing NOW, which for a first edit is the resolved
 * preset and thereafter the draft.
 */
function commit(track: Track, next: VoicePreset): Result {
  if (next === trackVoicePreset(track)) return { ok: true, value: undefined };
  drafts.set(track.id, { tag: tagOf(track), preset: next });
  notify(track.id);
  return { ok: true, value: undefined };
}

/** Every param the schema declares, by path — so a write can be refused for
 *  addressing something the editor cannot honour, rather than quietly widening
 *  the preset with a field nothing reads. */
const PARAM_BY_PATH: ReadonlyMap<string, Param> = new Map(
  PARAM_SECTIONS.flatMap((section) => section.params.map((param) => [param.path, param])),
);

/**
 * Set one voice parameter on one track — the capability every knob, switch and
 * picker in `TrackVoiceRack` is a way of calling.
 *
 * Refused in words, never thrown, for anything the surface itself could not have
 * produced: a track that is gone, a path outside `paramSchema`, a value of the
 * wrong kind, a number outside the declared range. That last one matters more
 * for a caller with no pointer than for one with a knob — a knob clamps itself,
 * an agent hands over whatever it computed.
 *
 * A `sample-pack` param takes a PACK ID rather than the note→URL maps that land
 * in the preset. The preset stores the maps (which is why reading the selection
 * back needs the lib's `detectSamplePack`), but a caller naming one by hand
 * would be authoring a sample map, and the registry is the addressable thing.
 */
export function setTrackVoiceParam(
  trackId: string,
  path: string,
  value: unknown,
): Result {
  const track = findTrack(trackId);
  if (!track) return { ok: false, reason: 'No such track.' };

  const param = PARAM_BY_PATH.get(path);
  if (!param) return { ok: false, reason: `“${path}” is not an editable voice parameter.` };

  const preset = trackVoicePreset(track);

  switch (param.kind) {
    case 'slider': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, reason: `${param.label} takes a number.` };
      }
      if (value < param.min || value > param.max) {
        return {
          ok: false,
          reason: `${param.label} is ${param.min} to ${param.max}${param.unit ? ` ${param.unit}` : ''}.`,
        };
      }
      return commit(track, setAtPath(preset, path, value));
    }
    case 'toggle': {
      if (typeof value !== 'boolean') return { ok: false, reason: `${param.label} takes true or false.` };
      return commit(track, setAtPath(preset, path, value));
    }
    case 'enum': {
      if (typeof value !== 'string' || !param.options.some((option) => option.value === value)) {
        return { ok: false, reason: `That is not one of the ${param.label.toLowerCase()} options.` };
      }
      return commit(track, setAtPath(preset, path, value));
    }
    case 'sample-pack': {
      const pack = typeof value === 'string' ? getSamplePack(value) : undefined;
      if (!pack) return { ok: false, reason: 'That is not a registered sample pack.' };
      return commit(track, setAtPath(preset, path, pack.samples));
    }
  }
}

/** Both branch writes ask the schema which section they mean, so a section id
 *  the table no longer declares is refused rather than silently doing nothing. */
function sectionById(id: string) {
  return PARAM_SECTIONS.find((section) => section.id === id);
}

/**
 * Take a section from absent to present by seeding every REQUIRED param with its
 * `fallback` — which is why some fallbacks in `paramSchema` are not zero. The
 * optional ones are left out deliberately: the lib documents its own default for
 * each, and writing our guess would turn "unspecified" into a value the user
 * never chose. `VoicePane.addSection` is the same rule for the pattern page.
 */
export function addTrackVoiceSection(trackId: string, sectionId: SectionId): Result {
  const track = findTrack(trackId);
  if (!track) return { ok: false, reason: 'No such track.' };
  const section = sectionById(sectionId);
  if (!section) return { ok: false, reason: `“${sectionId}” is not a voice section.` };

  let next = trackVoicePreset(track);
  if (sectionApplies(next, section)) return { ok: true, value: undefined };
  for (const param of section.params) {
    if (param.optional || param.kind === 'sample-pack') continue;
    next = setAtPath(next, param.path, param.fallback);
  }
  return commit(track, next);
}

/**
 * Delete a section's whole branch — ABSENT, which is not the same as bypassed.
 * Bypass (`enabled: false`) keeps the user's tuning for when they switch the
 * stage back on; this throws it away, which is why only sections the schema
 * marks `removableBranch` can be removed at all.
 */
export function removeTrackVoiceSection(trackId: string, sectionId: SectionId): Result {
  const track = findTrack(trackId);
  if (!track) return { ok: false, reason: 'No such track.' };
  const section = sectionById(sectionId);
  if (!section) return { ok: false, reason: `“${sectionId}” is not a voice section.` };
  if (!section.removableBranch) {
    return { ok: false, reason: `${section.label} cannot be removed from a voice.` };
  }
  return commit(track, removeAtPath(trackVoicePreset(track), section.removableBranch));
}

/**
 * Throw one track's unsaved edit away and put it back on its stored voice.
 *
 * Notified even though the draft is being deleted rather than written: the
 * engine is holding a `Voice` built FROM that draft, and nothing else would tell
 * it to go back.
 */
export function discardTrackVoiceDraft(trackId: string): Result {
  if (!drafts.has(trackId)) return { ok: true, value: undefined };
  drafts.delete(trackId);
  notify(trackId);
  return { ok: true, value: undefined };
}

/**
 * Drop every draft. For test isolation, and for it alone — a module that
 * survives every unmount also survives every test in a file, and a draft left
 * behind by one test is a voice the next one silently plays through.
 */
export function clearTrackVoiceDrafts(): void {
  const ids = [...drafts.keys()];
  drafts.clear();
  ids.forEach(notify);
}
