/**
 * Every unsaved voice edit in the app — up to one per HOLDER, where a holder is
 * the pattern the pattern page has open or one of the composition's tracks.
 *
 * ── Why this is a module and not React state ─────────────────────────────────
 *
 * There are up to nine of these at once and two unmounts to survive: leaving
 * voice mode replaces what every lane draws, visiting the pattern page unmounts
 * `CompositionPage` outright, and `PaneStack` unmounts the Instrument & Amp
 * pane's body the moment it is collapsed. So they live above every component
 * there is — which is what a module is — for the same reason `mode`, `paneOrder`
 * and `collapsedPanes` live above the page.
 *
 * Two things follow from that, and neither is available to `App`-held state:
 *
 *  - **The agent can reach it.** {@link setVoiceParam} takes a holder kind, an
 *    id, a schema path and a value, refuses in words and never throws, so every
 *    knob in `TrackVoiceRack` and `VoicePane` is a way of CALLING a capability
 *    rather than the only way to have it. React state in `App` could not be
 *    called at all.
 *  - **The engine can read it without a second copy.** `playbackService` builds
 *    a holder's `Voice` from {@link readVoiceDraft} directly. The pattern page
 *    used to push its working copy at the engine instead, which then kept its
 *    own tagged mirror of it — two sources of truth, which was
 *    tolerable for one voice and is not for nine.
 *
 * ── Addressed by kind and id, never by a document ────────────────────────────
 *
 * Every function here takes `(kind, id, …)`. A `{ kind: 'pattern'; pattern }`
 * argument would be a POINTER, and `CLAUDE.md`'s rule is that the agent must be
 * able to act without one. The component resolves its own `Pattern` / `Track`
 * from the id it already has; the seam never receives one. `HolderKind` lives in
 * `voiceService`, which this module imports — declaring it here and importing it
 * back would be a cycle.
 *
 * ── The tag, and why a draft retires ─────────────────────────────────────────
 *
 * A draft is tagged with its holder's instrument and voice ref
 * (`voiceService.holderVoiceTag`). Pick a different voice for the holder, or
 * change its instrument, and the tag stops matching: the draft is an edit OF a
 * voice, and it must not follow the user onto the next one. The stored preset
 * takes over the moment it does.
 *
 * A STOPPED TAG IS NOT YET A RETIRED DRAFT, and the difference matters. The hooks
 * only SHADOW a mismatch — they compare without deleting, because a store write
 * during render is a React error — so the entry is still there to resurrect if the
 * holder is pointed back at the voice it was taken from. {@link readVoiceDraft} is
 * what actually drops it, and two things make sure something reads: every editor
 * gesture that repoints a holder discards explicitly, and `playbackService`'s
 * `usePlaybackEngine` watches the editing pattern's tag for the repoint made
 * behind the editor's back — an undo restoring a snapshot with a different ref.
 *
 * The pattern ID IS NOT IN THE TAG, because it is in the KEY. Two patterns
 * sharing a voice share the saved one and keep their own unsaved ones, which is
 * what makes a pattern switch cost nothing.
 *
 * That key is the pattern id, which is not quite unique: a placement's snapshot
 * carries the id of the library pattern it was cut from (`patternService.openPattern`
 * says so), so those two documents share one draft and deleting the library row
 * prunes the placement's. Pre-existing — the working copy this replaced was keyed
 * by pattern id too — and named here rather than fixed, because the id is what
 * every other seam addresses a pattern by.
 *
 * ── What is collected, and what is not ───────────────────────────────────────
 *
 * PATTERN drafts are pruned when the pattern leaves the library
 * ({@link subscribeRemovedPatterns}). A pattern library is unbounded,
 * `openBlankPattern` mints ids freely, and a sampler preset carries a ~45-entry
 * note→URL map per bank — so "one preset object per deleted pattern per session"
 * is not the bounded cost the track side has.
 *
 * TRACK drafts are NOT pruned when a track is removed, and that is a decision
 * rather than an oversight: the population is bounded at
 * `MAX_COMPOSITION_TRACKS`, track ids are unique so nothing resurrects, and the
 * two hooks that look right are both worse. Pruning from
 * `compositionService.removeTrack` puts an import from the composition seam back
 * into this module's own importer — a cycle, to collect a few hundred bytes.
 * Pruning against the tracks of the CURRENT composition (from `syncComposition`,
 * say) throws a track's unsaved tone away when you open another composition and
 * come back, which is precisely the loss CP-14 is written to prevent. The
 * pattern side has neither problem: its notifier runs one way, and a deleted
 * pattern does not come back.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────
 *
 * There is no Save here. A draft is unsaved by definition; writing it to a
 * variant is `voiceService`'s, along with the variant list and Save as… /
 * Rename. A voice is also a SHARED asset — the variant a track points at is the
 * same object the pattern page edits — so a Save would retune every holder,
 * which is exactly why it is a deliberate act with its own UI rather than a side
 * effect of turning a knob. {@link setVoiceName} is the one apparent exception
 * and is not one: it patches the name INSIDE an unsaved copy so the next Save
 * does not undo a rename, and creates nothing.
 */
import { useSyncExternalStore } from 'react';
import { getSamplePack, type VoicePreset } from '@fretwork/lib';
import { subscribeRemovedPatterns } from '../patterns/patternService';
import type { Result } from '../composition/compositionService';
import {
  holderVoiceTag,
  resolveHolderVoicePreset,
  useHolderVoicePreset,
  type HolderKind,
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

/** One holder's unsaved edit, and the voice choice it is an edit OF. */
interface VoiceDraft {
  readonly tag: string;
  readonly preset: VoicePreset;
}

/** `"pattern:<id>"` / `"track:<id>"`. One entry per holder, and the two kinds
 *  cannot collide however ids are minted. */
const draftKey = (kind: HolderKind, id: string) => `${kind}:${id}`;

const drafts = new Map<string, VoiceDraft>();

/**
 * Listeners are told WHICH holder moved and of which kind, not merely that
 * something did. The only subscriber that acts on this is the audio seam, and
 * the two kinds are rebuilt on different timings — a track's is coalesced per
 * track, a pattern's is retuned at once — so a notification that could not name
 * one would rebuild eight tracks' samplers per knob turn.
 */
type DraftListener = (kind: HolderKind, id: string) => void;
const listeners = new Set<DraftListener>();

/** For `useSyncExternalStore`, which cannot take a per-holder argument through
 *  `subscribe`. The per-holder bail-out is the SNAPSHOT's job instead: an
 *  unchanged holder hands back the same entry object and React re-renders
 *  nothing (see {@link useVoiceWorkingPreset}). */
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
export function subscribeVoiceDrafts(listener: DraftListener): () => void {
  const wrapped: DraftListener = (kind, id) => listener(kind, id);
  listeners.add(wrapped);
  return () => {
    listeners.delete(wrapped);
  };
}

function notify(kind: HolderKind, id: string): void {
  listeners.forEach((listener) => listener(kind, id));
}

/**
 * A pattern's draft dies with the pattern. See the collection note in the header
 * for why the track side does not do this.
 *
 * Silent — no {@link notify} — because there is no holder left to sound: the
 * only subscriber routes a pattern id to the engine's reconcile, which addresses
 * whatever pattern is OPEN, and this one is gone. `patternService.deletePattern`
 * has already opened another by the time this runs.
 */
subscribeRemovedPatterns((patternId) => {
  drafts.delete(draftKey('pattern', patternId));
});

/** The refusal for an id that names nothing, in the holder's own words. */
const noHolder = (kind: HolderKind): Result => ({
  ok: false,
  reason: kind === 'track' ? 'No such track.' : 'No such pattern.',
});

/**
 * A holder's unsaved preset, or null.
 *
 * SELF-CLEARING: a tag that has stopped matching can never matter again, and
 * leaving it live means an abandoned edit resurrects the moment the holder
 * points back at the voice it was taken from.
 *
 * Non-reactive, and it MUTATES — so it is for the audio seam and event handlers,
 * never for a render. {@link useVoiceWorkingPreset} compares the tag without
 * clearing, because a store write during render is a React error rather than a
 * style question.
 */
export function readVoiceDraft(kind: HolderKind, id: string): VoicePreset | null {
  const key = draftKey(kind, id);
  const draft = drafts.get(key);
  if (!draft) return null;
  if (draft.tag === holderVoiceTag(kind, id)) return draft.preset;
  drafts.delete(key);
  return null;
}

/**
 * The preset a holder's editor is showing and its engine is building: the
 * unsaved edit when there is one, otherwise whatever the lib resolves its ref
 * to. Null when the holder itself is gone.
 *
 * The NON-REACTIVE read, paired with {@link useVoiceWorkingPreset}. Used by the
 * writes below, by the audio seam and by tests; a render wants the hook.
 */
export function voicePreset(kind: HolderKind, id: string): VoicePreset | null {
  return readVoiceDraft(kind, id) ?? resolveHolderVoicePreset(kind, id);
}

/** Whether this holder carries an edit that no variant holds. The non-reactive
 *  half of {@link useVoiceDirty}, on the same terms as above. */
export function isVoiceDirty(kind: HolderKind, id: string): boolean {
  return readVoiceDraft(kind, id) !== null;
}

/**
 * React hook: {@link voicePreset}, subscribed.
 *
 * TWO subscriptions, because there are two ways the answer moves. This store
 * carries the holder's own edits; the seam's `useHolderVoicePreset` carries a
 * rename, a save or a change to the instrument's global active variant, none of
 * which touch either this module or the document stores. That half is the seam's
 * own hook rather than a second copy of it — `voiceService` is the ONLY module
 * allowed to reach the lib's voice store, and this one is not it.
 *
 * The draft snapshot is the ENTRY OBJECT, not the preset, and that is what keeps
 * a knob drag on one rack from re-rendering the other seven: a holder nobody
 * edited hands back the identical object and React bails out per consumer.
 */
export function useVoiceWorkingPreset(kind: HolderKind, id: string): VoicePreset | null {
  const key = draftKey(kind, id);
  const entry = useSyncExternalStore(
    subscribeAll,
    () => drafts.get(key),
    () => drafts.get(key),
  );
  const stored = useHolderVoicePreset(kind, id);
  return entry && entry.tag === holderVoiceTag(kind, id) ? entry.preset : stored;
}

/** React hook: whether this holder's editor is showing an unsaved edit. */
export function useVoiceDirty(kind: HolderKind, id: string): boolean {
  const key = draftKey(kind, id);
  const entry = useSyncExternalStore(
    subscribeAll,
    () => drafts.get(key),
    () => drafts.get(key),
  );
  return entry !== undefined && entry.tag === holderVoiceTag(kind, id);
}

// ----------------------------------------------------------------- writing ---

/**
 * The holder a write is about to land on: its key, its tag, and the preset it is
 * showing NOW — the draft when there is one, the resolved variant otherwise.
 *
 * ⚠ RESOLVED INSIDE EVERY CALL, and that is the property the pattern page's
 * `presetRef` hack used to buy. `Knob` and `CabinetGraphic` register their drag
 * listeners on `window` at pointerdown and run the whole gesture against the
 * handler captured then, so a caller that closed over the rendered preset would
 * compare a drag's last value against the preset as it was when the drag
 * STARTED: drag away from a value and back, and `setAtPath` returns that same
 * starting object, so the edit that restores the original value would be the one
 * edit silently dropped. Nothing here closes over anything.
 *
 * Self-clearing on a stale tag, for {@link readVoiceDraft}'s reason.
 */
interface DraftHolder {
  readonly key: string;
  readonly tag: string;
  readonly preset: VoicePreset;
}

function holderOf(kind: HolderKind, id: string): DraftHolder | null {
  const tag = holderVoiceTag(kind, id);
  if (tag === null) return null;
  const key = draftKey(kind, id);
  const entry = drafts.get(key);
  if (entry) {
    if (entry.tag === tag) return { key, tag, preset: entry.preset };
    drafts.delete(key);
  }
  const stored = resolveHolderVoicePreset(kind, id);
  // Unreachable: a tag resolved, so the holder did. Guarded rather than asserted
  // because the alternative is a non-null assertion on a lib resolution.
  if (!stored) return null;
  return { key, tag, preset: stored };
}

/**
 * Record an edit against one holder.
 *
 * The identity guard is not an optimisation: `setAtPath` returns the SAME object
 * when the write changes nothing, so a control reporting its current value must
 * not mark the holder dirty — and must not fire a voice rebuild. Compared
 * against whatever the holder is showing NOW, which for a first edit is the
 * resolved preset and thereafter the draft.
 */
function commit(
  kind: HolderKind,
  id: string,
  holder: DraftHolder,
  next: VoicePreset,
): Result {
  if (next === holder.preset) return { ok: true, value: undefined };
  drafts.set(holder.key, { tag: holder.tag, preset: next });
  notify(kind, id);
  return { ok: true, value: undefined };
}

/** Every param the schema declares, by path — so a write can be refused for
 *  addressing something the editor cannot honour, rather than quietly widening
 *  the preset with a field nothing reads. */
const PARAM_BY_PATH: ReadonlyMap<string, Param> = new Map(
  PARAM_SECTIONS.flatMap((section) => section.params.map((param) => [param.path, param])),
);

/**
 * Set one voice parameter on one holder — the capability every knob, switch and
 * picker in `TrackVoiceRack` and `VoicePane` is a way of calling.
 *
 * Refused in words, never thrown, for anything the surface itself could not have
 * produced: a holder that is gone, a path outside `paramSchema`, a value of the
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
export function setVoiceParam(
  kind: HolderKind,
  id: string,
  path: string,
  value: unknown,
): Result {
  const holder = holderOf(kind, id);
  if (!holder) return noHolder(kind);

  const param = PARAM_BY_PATH.get(path);
  if (!param) return { ok: false, reason: `“${path}” is not an editable voice parameter.` };

  const preset = holder.preset;

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
      return commit(kind, id, holder, setAtPath(preset, path, value));
    }
    case 'toggle': {
      if (typeof value !== 'boolean') return { ok: false, reason: `${param.label} takes true or false.` };
      return commit(kind, id, holder, setAtPath(preset, path, value));
    }
    case 'enum': {
      if (typeof value !== 'string' || !param.options.some((option) => option.value === value)) {
        return { ok: false, reason: `That is not one of the ${param.label.toLowerCase()} options.` };
      }
      return commit(kind, id, holder, setAtPath(preset, path, value));
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
      return commit(kind, id, holder, setAtPath(preset, path, value));
    }
    case 'sample-pack': {
      const pack = typeof value === 'string' ? getSamplePack(value) : undefined;
      if (!pack) return { ok: false, reason: 'That is not a registered sample pack.' };
      return commit(kind, id, holder, setAtPath(preset, path, pack.samples));
    }
    case 'source-kind': {
      if (!isSourceKind(value)) {
        return { ok: false, reason: `That is not one of the ${param.label.toLowerCase()} options.` };
      }
      return commit(kind, id, holder, withSourceKind(preset, value));
    }
  }
}

/**
 * Rename the voice INSIDE an unsaved copy — the one write here that is not a
 * schema param.
 *
 * ⚠ WITHOUT THIS A RENAME IS SILENTLY UNDONE. `saveVoice`, under either kind,
 * writes the record's name back from `preset.name`, and a draft carries the name
 * the voice had when the edit started — so renaming a variant while an edit is
 * in flight, then saving, puts the old name back. `VoicePane` used to patch its
 * own React copy; `VoiceRail`, which then held the buttons, could not, and disabled
 * Rename while dirty to say so. One write here is the answer for both, and it is
 * what lets `TrackVoiceRack` — which holds them now — leave Rename enabled.
 *
 * A no-op when there is no draft, and deliberately: the variant's own record is
 * the authority when nothing is unsaved, and minting a draft here would mark a
 * holder dirty for an act that changed no sound.
 */
export function setVoiceName(kind: HolderKind, id: string, name: string): Result {
  const holder = holderOf(kind, id);
  if (!holder) return noHolder(kind);
  const trimmed = name.trim();
  if (trimmed === '') return { ok: false, reason: 'A voice needs a name.' };
  // Only an existing draft is patched — see above. `holderOf` has already dropped a
  // stale entry, so the map alone answers this; `readVoiceDraft` here would resolve
  // the holder a second time to learn what is already known.
  if (!drafts.has(holder.key)) return { ok: true, value: undefined };
  if (holder.preset.name === trimmed) return { ok: true, value: undefined };
  return commit(kind, id, holder, { ...holder.preset, name: trimmed });
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
 * never chose.
 *
 * ⚠ THE SUB-BRANCH IS NOT PART OF THE SECTION'S SEED. A sub-branch is created
 * only by {@link addVoiceSubBranch}, from its own `seed`, so its rows are skipped
 * here even when `paramApplies` says they apply. Without the skip, a section
 * whose sub-branch sits OUTSIDE its removable branch — the Cabinet's room, at
 * `effects.reverb` while the section removes `effects.cabIR` — would have the
 * user's tuning overwritten by row fallbacks the moment the section was added
 * back, silently and with no refusal. Every other sub-branch happens to nest
 * under its section's branch, so it goes absent with it and never reaches this
 * loop; the rule is written for the general case rather than that accident.
 */
export function addVoiceSection(kind: HolderKind, id: string, sectionId: SectionId): Result {
  const holder = holderOf(kind, id);
  if (!holder) return noHolder(kind);
  const section = sectionById(sectionId);
  if (!section) return { ok: false, reason: `“${sectionId}” is not a voice section.` };

  let next = holder.preset;
  if (sectionApplies(next, section)) return { ok: true, value: undefined };
  const sub = section.subBranch;
  for (const param of section.params) {
    if (sub && param.path.startsWith(`${sub.branch}.`)) continue;
    if (param.optional) continue;
    if (!paramApplies(next, param)) continue;
    // Exhaustive: `source-kind` and `sample-pack` are the two rows whose value is
    // not what `setAtPath(path, fallback)` would write, and a bare
    // `source.kind: 'sampler'` is precisely the malformed union `withSourceKind`
    // exists to prevent. The `default` makes a future `Param` kind a `tsc`
    // failure here rather than a silent write.
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
  return commit(kind, id, holder, next);
}

/**
 * Delete a section's whole branch — ABSENT, which is not the same as bypassed.
 * Bypass (`enabled: false`) keeps the user's tuning for when they switch the
 * stage back on; this throws it away, which is why only sections the schema
 * marks `removableBranch` can be removed at all.
 *
 * ⚠ AND ITS SUB-BRANCH WITH IT. The button says "Remove Cabinet + room", and
 * `sectionApplies` takes the sub-branch off screen along with the section, so a
 * sub-branch left behind is a stage still wired, still audible, and with no
 * control anywhere to reach it — `effects.reverb` surviving a removed
 * `effects.cabIR` is exactly that, because the room is the one sub-branch that
 * does not nest under its section's removable branch. For every other one this
 * second `removeAtPath` is a no-op the first already did.
 */
export function removeVoiceSection(kind: HolderKind, id: string, sectionId: SectionId): Result {
  const holder = holderOf(kind, id);
  if (!holder) return noHolder(kind);
  const section = sectionById(sectionId);
  if (!section) return { ok: false, reason: `“${sectionId}” is not a voice section.` };
  if (!section.removableBranch) {
    return { ok: false, reason: `${section.label} cannot be removed from a voice.` };
  }
  let next = removeAtPath(holder.preset, section.removableBranch);
  if (section.subBranch) next = removeAtPath(next, section.subBranch.branch);
  return commit(kind, id, holder, next);
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
 * Add one nested optional branch — the second source, the body filter's cutoff
 * envelope, or the cabinet's room.
 *
 * Path-addressed rather than `SectionId`-keyed, because a sub-branch is not a
 * section: it is a SECOND optional branch under a section that already carries
 * one `presenceProbe` and one `removableBranch`, and it is created in a single
 * write from `ParamSubBranch.seed` rather than row by row from fallbacks.
 *
 * ⚠ "HAS NO BYPASS OF ITS OWN" USED TO BE PART OF THAT RULE AND IS NOT ANY MORE.
 * The room is a real stage of the chain and carries `effects.reverb.enabled`, so
 * it has all three states a section has. What still separates the two is purely
 * mechanical — the count of branches a `ParamSection` can declare — and
 * `paramSchema`'s header carries the same correction in full.
 * A `VoiceLayer` contains a whole `VoiceSource`, and no amount of row fallbacks
 * produces one — which is the entire reason `seed` exists (see `ParamSubBranch`).
 *
 * ⚠ WITHOUT THIS, the second source is unreachable to any caller without a
 * pointer: {@link addVoiceSection} cannot name it, and every `layer.*` write is
 * refused while the branch is absent, so a holder that lacks a layer could never
 * gain one and one that has a layer could never lose it. Every feature needs a
 * seam the agent can call; this is the layer's.
 *
 * Adding what is already there is a no-op rather than a refusal — the same
 * contract {@link addVoiceSection} has, and the one that makes the call
 * idempotent for a caller that cannot see the rack.
 */
export function addVoiceSubBranch(kind: HolderKind, id: string, subBranchId: string): Result {
  const holder = holderOf(kind, id);
  if (!holder) return noHolder(kind);
  const found = subBranchById(subBranchId);
  if (!found) return { ok: false, reason: `“${subBranchId}” is not a voice sub-branch.` };

  const preset = holder.preset;
  if (subBranchApplies(preset, found.sub)) return { ok: true, value: undefined };
  return commit(kind, id, holder, setAtPath(preset, found.sub.branch, found.sub.seed(preset)));
}

/**
 * Delete one nested optional branch, tuning and all.
 *
 * ABSENT, not bypassed, and it throws the branch's settings away. Both editors'
 * Remove says the same thing in words.
 *
 * For the layer and the cutoff envelope this is the ONLY way back, because
 * neither has an `enabled` flag to switch instead. The room does — bypassing it
 * with `effects.reverb.enabled` keeps its size and mix, and this deletes them —
 * so the two gestures are genuinely different there rather than one standing in
 * for the other.
 */
export function removeVoiceSubBranch(kind: HolderKind, id: string, subBranchId: string): Result {
  const holder = holderOf(kind, id);
  if (!holder) return noHolder(kind);
  const found = subBranchById(subBranchId);
  if (!found) return { ok: false, reason: `“${subBranchId}” is not a voice sub-branch.` };
  return commit(kind, id, holder, removeAtPath(holder.preset, found.sub.branch));
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
 * Put one pedal on a holder's board.
 *
 * ⚠ WITHOUT THIS, every pedal is unreachable to a caller with no pointer, and in
 * a way no other seam covers. {@link addVoiceSection} names a SECTION, and the
 * pedalboard section is `presenceProbe: null` — always present, nothing to add —
 * so it can neither name a pedal nor create one. Meanwhile every `compressor.*`
 * and `effects.<pedal>.*` write is refused by {@link setVoiceParam} while the
 * branch is absent, because each row declares `requiresBranch`. So a holder
 * without a distortion could never gain one and one with one could never lose
 * it. Adding a pedal is its own gesture because a pedal is its own stage.
 *
 * Seeded in ONE write from `Pedal.seed`, not row by row from fallbacks the way
 * {@link addVoiceSection} builds a section. A pedal's params interface is
 * required in full the moment the branch exists — `Voice.buildChain` reads every
 * field straight into a Tone constructor — so a half-built branch is a node
 * built with `undefined`s rather than a stage waiting to be finished.
 *
 * Adding what is already there is a no-op rather than a refusal, the contract
 * both sibling adds have, and the one that makes the call idempotent for a caller
 * that cannot see the rack. Note it is a no-op even for a BYPASSED pedal: that
 * pedal is on the board with the user's tuning intact, and re-seeding it would
 * throw that away to answer a question nobody asked.
 */
export function addVoicePedal(kind: HolderKind, id: string, pedalId: PedalId | string): Result {
  const holder = holderOf(kind, id);
  if (!holder) return noHolder(kind);
  const pedal = pedalById(pedalId);
  if (!pedal) return { ok: false, reason: `“${pedalId}” is not a pedal.` };

  const preset = holder.preset;
  if (sectionApplies(preset, pedal)) return { ok: true, value: undefined };
  return commit(kind, id, holder, setAtPath(preset, pedal.branch, pedal.seed));
}

/**
 * Take one pedal off a holder's board.
 *
 * ABSENT, not bypassed, and the difference is the user's tuning: bypass keeps it
 * for when they switch the pedal back on, this throws it away. Both states are
 * reachable and they are not the same — `sectionPresence` is what tells them
 * apart, and both editors offer both gestures for that reason.
 *
 * Removing what is not there is a no-op, matching the add and for the same
 * reason: `removeAtPath` on an absent branch returns the same preset, `commit`
 * sees an unchanged reference, and nothing is marked dirty.
 */
export function removeVoicePedal(kind: HolderKind, id: string, pedalId: PedalId | string): Result {
  const holder = holderOf(kind, id);
  if (!holder) return noHolder(kind);
  const pedal = pedalById(pedalId);
  if (!pedal) return { ok: false, reason: `“${pedalId}” is not a pedal.` };
  return commit(kind, id, holder, removeAtPath(holder.preset, pedal.branch));
}

/**
 * Re-kind a sub-branch's source — today, the second source's.
 *
 * ⚠ NOT REACHABLE THROUGH {@link setVoiceParam}, and deliberately so. That
 * function resolves a `source-kind` row through `withSourceKind`, which takes no
 * path and always replaces `preset.source`; a `layer.source.kind` row sitting in
 * `PARAM_BY_PATH` would therefore let any caller ask to re-kind the SECOND source
 * and silently re-kind the primary instead. Keeping the layer's picker on
 * `ParamSubBranch.kindRow` keeps it out of that map, and this is the branch-aware
 * write it needs — both editors' layer picker is the same call.
 *
 * `withLayerSourceKind` by name rather than a generic branch write: the value's
 * SHAPE is the point, and a typed spread is checked where a dotted path is not.
 * The layer is the only sub-branch with a `kindRow` today and `paramSchema.test.ts`
 * fails the day a second one appears without its own swap, so the guard here is
 * an assertion of that, not a limitation this function invented.
 */
export function setVoiceSubBranchKind(
  kind: HolderKind,
  id: string,
  subBranchId: string,
  sourceKind: unknown,
): Result {
  const holder = holderOf(kind, id);
  if (!holder) return noHolder(kind);
  const found = subBranchById(subBranchId);
  if (!found?.sub.kindRow) {
    return { ok: false, reason: `“${subBranchId}” has no source of its own.` };
  }
  if (found.sub.id !== 'layer') {
    return { ok: false, reason: `${found.sub.label} has no branch-aware source swap yet.` };
  }
  if (!isSourceKind(sourceKind) || !found.sub.kindRow.options.some((o) => o.value === sourceKind)) {
    return { ok: false, reason: `That is not one of the ${found.sub.label.toLowerCase()} kinds.` };
  }
  const preset = holder.preset;
  // Refused rather than silently creating one: `withLayerSourceKind` returns the
  // preset untouched when there is no layer, so without this the call would
  // report success and change nothing.
  if (!subBranchApplies(preset, found.sub)) {
    return { ok: false, reason: `This voice has no ${found.sub.label.toLowerCase()}.` };
  }
  return commit(kind, id, holder, withLayerSourceKind(preset, sourceKind));
}

/**
 * Throw one holder's unsaved edit away and put it back on its stored voice.
 *
 * Notified even though the draft is being deleted rather than written: the
 * engine is holding a `Voice` built FROM that draft, and nothing else would tell
 * it to go back.
 *
 * An absent draft is a no-op. A draft that WAS there notifies whether or not its
 * holder is still the one on screen, and the audio seam relies on that: a
 * pattern discarded after its editor closed has to cancel the rebuild it left
 * pending, or the abandoned edit is still what plays when it is reopened.
 */
export function discardVoiceDraft(kind: HolderKind, id: string): Result {
  const key = draftKey(kind, id);
  if (!drafts.has(key)) return { ok: true, value: undefined };
  drafts.delete(key);
  notify(kind, id);
  return { ok: true, value: undefined };
}

/**
 * Drop every draft. For test isolation, and for it alone — a module that
 * survives every unmount also survives every test in a file, and a draft left
 * behind by one test is a voice the next one silently plays through.
 */
export function clearVoiceDrafts(): void {
  const keys = [...drafts.keys()];
  drafts.clear();
  keys.forEach((key) => {
    const separator = key.indexOf(':');
    notify(key.slice(0, separator) as HolderKind, key.slice(separator + 1));
  });
}

/**
 * Which holders currently have an entry — WITHOUT resolving a tag, and so without
 * the self-clearing every other read does.
 *
 * For the collection tests, and for them alone. It is the only observable that can
 * tell a pruned entry from one merely shadowed by a stale tag: every public read
 * drops a mismatched entry on the way past, so a test written against
 * {@link isVoiceDirty} passes whether or not {@link subscribeRemovedPatterns} above
 * ever fires, and the pruning it was written to pin could be deleted under it.
 */
export function voiceDraftKeys(): readonly string[] {
  return [...drafts.keys()];
}
