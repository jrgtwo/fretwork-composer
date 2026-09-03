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
import {
  PARAM_SECTIONS,
  PEDALS,
  paramApplies,
  sectionApplies,
  subBranchApplies,
  type Param,
  type ParamSection,
  type ParamSubBranch,
  type Pedal,
  type PedalId,
  type SectionId,
} from './paramSchema';
import { removeAtPath, setAtPath } from './presetPaths';
import { isSourceKind, withLayerSourceKind, withSourceKind } from './sourceDefaults';

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
 *
 * A `source-kind` param takes a kind and replaces the WHOLE `source` branch, for
 * the reason `sourceDefaults` documents: writing the discriminant alone produces
 * an object matching no arm of `VoiceSource`. It is also the only param here
 * whose write is not a `setAtPath` of the value it was handed.
 *
 * An `encoder` param is range-checked only for finiteness, and for a `floor`
 * where the row declares one. That is the point of the control: Tone publishes no
 * bound for those fields, so refusing a value would be enforcing a fence this app
 * invented — see `paramSchema`'s header. The exception is narrow and is named at
 * each row: a frequency of zero is not a quiet setting, it is a track that plays
 * silence with every control reading normally, and this caller has no ear on the
 * result. See `EncoderParam.floor`.
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

  // A row the current source does not have is refused rather than written: an FM
  // param on a sampler would widen the preset with a field `Voice` never reads,
  // and an agent with no pointer is exactly the caller that would try it.
  if (!paramApplies(preset, param)) {
    return {
      ok: false,
      reason: `${param.label} is not a setting of this voice's source.`,
    };
  }

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
      // Only where the FIELD is integral, never merely because the fader's step
      // is: a step is a detent, and refusing 3.7 dB on a half-decibel fader would
      // be inventing a grid the preset does not have. See `SliderParam.integral`.
      if (param.integral && !Number.isInteger(value)) {
        return { ok: false, reason: `${param.label} is a whole number.` };
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
    case 'encoder': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, reason: `${param.label} takes a number.` };
      }
      if (param.floor !== undefined && value < param.floor) {
        return {
          ok: false,
          reason: `${param.label} is ${param.floor}${param.unit ? ` ${param.unit}` : ''} or more.`,
        };
      }
      return commit(track, setAtPath(preset, path, value));
    }
    case 'sample-pack': {
      const pack = typeof value === 'string' ? getSamplePack(value) : undefined;
      if (!pack) return { ok: false, reason: 'That is not a registered sample pack.' };
      return commit(track, setAtPath(preset, path, pack.samples));
    }
    case 'source-kind': {
      if (!isSourceKind(value)) {
        return { ok: false, reason: `That is not one of the ${param.label.toLowerCase()} options.` };
      }
      return commit(track, withSourceKind(preset, value));
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
    if (param.optional) continue;
    if (!paramApplies(next, param)) continue;
    // Exhaustive, for the reason `VoicePane.addSection` spells out: `source-kind` and
    // `sample-pack` are the two rows whose value is not what `setAtPath(path, fallback)`
    // would write, and a bare `source.kind: 'sampler'` is precisely the malformed union
    // `withSourceKind` exists to prevent. The `default` makes a future `Param` kind a
    // `tsc` failure here rather than a silent write.
    switch (param.kind) {
      case 'slider':
      case 'encoder':
      case 'enum':
      case 'toggle':
        next = setAtPath(next, param.path, param.fallback);
        break;
      case 'sample-pack':
      case 'source-kind':
        break;
      default:
        param satisfies never;
    }
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
 * The section that declares `subBranchId`, and the sub-branch itself.
 *
 * Looked up rather than passed, for the reason `sectionById` is: a caller names
 * a branch the schema knows, so an id the table no longer declares is refused in
 * words instead of writing a path nothing renders.
 */
function subBranchById(
  id: string,
): { section: ParamSection; sub: ParamSubBranch } | undefined {
  for (const section of PARAM_SECTIONS) {
    if (section.subBranch?.id === id) return { section, sub: section.subBranch };
  }
  return undefined;
}

/**
 * Add one nested optional branch — the second source, or the body filter's
 * cutoff envelope.
 *
 * Path-addressed rather than `SectionId`-keyed, because a sub-branch is not a
 * section: it lives INSIDE one, has no bypass of its own, and is created in a
 * single write from `ParamSubBranch.seed` rather than row by row from fallbacks.
 * A `VoiceLayer` contains a whole `VoiceSource`, and no amount of row fallbacks
 * produces one — which is the entire reason `seed` exists (see `ParamSubBranch`).
 *
 * ⚠ WITHOUT THIS, the second source is unreachable to any caller without a
 * pointer: `addTrackVoiceSection` cannot name it, and every `layer.*` write is
 * refused while the branch is absent, so a track that lacks a layer could never
 * gain one and one that has a layer could never lose it. Every feature needs a
 * seam the agent can call; this is the layer's.
 *
 * Adding what is already there is a no-op rather than a refusal — the same
 * contract `addTrackVoiceSection` has, and the one that makes the call
 * idempotent for a caller that cannot see the rack.
 */
export function addTrackVoiceSubBranch(trackId: string, subBranchId: string): Result {
  const track = findTrack(trackId);
  if (!track) return { ok: false, reason: 'No such track.' };
  const found = subBranchById(subBranchId);
  if (!found) return { ok: false, reason: `“${subBranchId}” is not a voice sub-branch.` };

  const preset = trackVoicePreset(track);
  if (subBranchApplies(preset, found.sub)) return { ok: true, value: undefined };
  return commit(track, setAtPath(preset, found.sub.branch, found.sub.seed(preset)));
}

/**
 * Delete one nested optional branch, tuning and all.
 *
 * ABSENT, not bypassed, and a sub-branch has no third state to offer: it has no
 * `enabled` flag, so this is the only way back and it throws the branch's
 * settings away. `VoicePane`'s Remove says the same thing in words.
 */
export function removeTrackVoiceSubBranch(trackId: string, subBranchId: string): Result {
  const track = findTrack(trackId);
  if (!track) return { ok: false, reason: 'No such track.' };
  const found = subBranchById(subBranchId);
  if (!found) return { ok: false, reason: `“${subBranchId}” is not a voice sub-branch.` };
  return commit(track, removeAtPath(trackVoicePreset(track), found.sub.branch));
}

/**
 * The pedal `pedalId` names. Looked up rather than passed, for the reason
 * `sectionById` and `subBranchById` are: a caller names something the schema
 * knows, so an id the table no longer declares is refused in words instead of
 * writing a path nothing renders.
 */
function pedalById(id: string): Pedal | undefined {
  return PEDALS.find((pedal) => pedal.id === id);
}

/**
 * Put one pedal on a track's board.
 *
 * ⚠ WITHOUT THIS, every pedal is unreachable to a caller with no pointer, and in
 * a way no other seam covers. `addTrackVoiceSection` names a SECTION, and the
 * pedalboard section is `presenceProbe: null` — always present, nothing to add —
 * so it can neither name a pedal nor create one. Meanwhile every `compressor.*`
 * and `effects.<pedal>.*` write is refused by `setTrackVoiceParam` while the
 * branch is absent, because each row declares `requiresBranch`. So a track
 * without a distortion could never gain one and a track with one could never lose
 * it. Adding a pedal is its own gesture because a pedal is its own stage.
 *
 * Seeded in ONE write from `Pedal.seed`, not row by row from fallbacks the way
 * `addTrackVoiceSection` builds a section. A pedal's params interface is required
 * in full the moment the branch exists — `Voice.buildChain` reads every field
 * straight into a Tone constructor — so a half-built branch is a node built with
 * `undefined`s rather than a stage waiting to be finished.
 *
 * Adding what is already there is a no-op rather than a refusal, the contract
 * both sibling adds have, and the one that makes the call idempotent for a caller
 * that cannot see the rack. Note it is a no-op even for a BYPASSED pedal: that
 * pedal is on the board with the user's tuning intact, and re-seeding it would
 * throw that away to answer a question nobody asked.
 */
export function addTrackVoicePedal(trackId: string, pedalId: PedalId | string): Result {
  const track = findTrack(trackId);
  if (!track) return { ok: false, reason: 'No such track.' };
  const pedal = pedalById(pedalId);
  if (!pedal) return { ok: false, reason: `“${pedalId}” is not a pedal.` };

  const preset = trackVoicePreset(track);
  if (sectionApplies(preset, pedal)) return { ok: true, value: undefined };
  return commit(track, setAtPath(preset, pedal.branch, pedal.seed));
}

/**
 * Take one pedal off a track's board.
 *
 * ABSENT, not bypassed, and the difference is the user's tuning: bypass keeps it
 * for when they switch the pedal back on, this throws it away. Both states are
 * reachable and they are not the same — `sectionPresence` is what tells them
 * apart, and `TrackVoiceRack` offers both gestures for that reason.
 *
 * Removing what is not there is a no-op, matching the add and for the same
 * reason: `removeAtPath` on an absent branch returns the same preset, `commit`
 * sees an unchanged reference, and nothing is marked dirty.
 */
export function removeTrackVoicePedal(trackId: string, pedalId: PedalId | string): Result {
  const track = findTrack(trackId);
  if (!track) return { ok: false, reason: 'No such track.' };
  const pedal = pedalById(pedalId);
  if (!pedal) return { ok: false, reason: `“${pedalId}” is not a pedal.` };
  return commit(track, removeAtPath(trackVoicePreset(track), pedal.branch));
}

/**
 * Re-kind a sub-branch's source — today, the second source's.
 *
 * ⚠ NOT REACHABLE THROUGH {@link setTrackVoiceParam}, and deliberately so. That
 * function resolves a `source-kind` row through `withSourceKind`, which takes no
 * path and always replaces `preset.source`; a `layer.source.kind` row sitting in
 * `PARAM_BY_PATH` would therefore let any caller ask to re-kind the SECOND source
 * and silently re-kind the primary instead. Keeping the layer's picker on
 * `ParamSubBranch.kindRow` keeps it out of that map, and this is the branch-aware
 * write it needs — `VoicePane.renderSubBranchKind` is the same call.
 *
 * `withLayerSourceKind` by name rather than a generic branch write, for the same
 * reason `VoicePane` uses it: the value's SHAPE is the point, and a typed spread
 * is checked where a dotted path is not. The layer is the only sub-branch with a
 * `kindRow` today and `paramSchema.test.ts` fails the day a second one appears
 * without its own swap, so the guard here is an assertion of that, not a
 * limitation this function invented.
 */
export function setTrackVoiceSubBranchKind(
  trackId: string,
  subBranchId: string,
  kind: unknown,
): Result {
  const track = findTrack(trackId);
  if (!track) return { ok: false, reason: 'No such track.' };
  const found = subBranchById(subBranchId);
  if (!found?.sub.kindRow) {
    return { ok: false, reason: `“${subBranchId}” has no source of its own.` };
  }
  if (found.sub.id !== 'layer') {
    return { ok: false, reason: `${found.sub.label} has no branch-aware source swap yet.` };
  }
  if (!isSourceKind(kind) || !found.sub.kindRow.options.some((o) => o.value === kind)) {
    return { ok: false, reason: `That is not one of the ${found.sub.label.toLowerCase()} kinds.` };
  }
  const preset = trackVoicePreset(track);
  // Refused rather than silently creating one: `withLayerSourceKind` returns the
  // preset untouched when there is no layer, so without this the call would
  // report success and change nothing.
  if (!subBranchApplies(preset, found.sub)) {
    return { ok: false, reason: `This voice has no ${found.sub.label.toLowerCase()}.` };
  }
  return commit(track, withLayerSourceKind(preset, kind));
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
