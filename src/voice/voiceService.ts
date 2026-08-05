/**
 * The seam between the app and `@fretwork/lib`'s voices module — the third one,
 * alongside `patternService` (the pattern store) and `playbackService` (the audio
 * engine).
 *
 * Components call this, never `useVoiceStore` or the resolver, because the voices
 * module is awkward in ways that shouldn't leak:
 *   - a voice is a SHARED asset. `pattern.voiceRef` is a reference, so editing a
 *     user variant changes it for every pattern pointing at it. That is intended;
 *     what must not leak is the temptation to auto-fork a private copy per pattern.
 *   - the fourteen built-in slots are `readonly` consts with no setter anywhere in
 *     the lib, so Save is not merely discouraged for them — it is impossible, and
 *     the refusal has to be a guard here rather than a disabled button in a pane.
 *   - `pattern.voiceRef` is typed `unknown` on `Pattern` (the lib keeps its pattern
 *     model independent of the voices module and documents casting at use), so
 *     exactly one module should own that cast and its validation. This one.
 *   - `resolveActiveVoice` is a plain function over a zustand store, not a hook, so
 *     nothing recomputes on its own.
 *
 * The GLOBAL `activeVariants` map — one voice per instrument, shared by every
 * pattern with no explicit ref — is deliberately read-only from here. It is a
 * different concept from `pattern.voiceRef` and writing it would retune every other
 * pattern in the library.
 *
 * `paramSchema.ts` reads the static registries (`AMP_MODELS`, `CABINET_IRS`,
 * `SAMPLE_PACKS`) directly. That is not a hole in this seam: those are frozen option
 * tables with no store behind them, and a descriptor table is the right owner. What
 * lives here is everything with state or resolution order in it.
 */
import { useMemo } from 'react';
import {
  ALL_SLOT_IDS,
  getDefaultPresetForSlot,
  getSlotsForInstrument,
  resolveActiveVoice,
  useVoiceStore,
  type FretInstrumentId,
  type Pattern,
  type SlotId,
  type Track,
  type Variant,
  type VariantRef,
  type VoicePreset,
} from '@fretwork/lib';
import {
  getEditingPattern,
  patternInstrumentId,
  setEditingPatternVoiceRef,
  useEditingPattern,
} from '../patterns/patternService';
// The COMPOSITION seam, for the track path below. One-directional:
// `compositionService` imports nothing from here — it stores `Track.voiceRef`
// opaquely and says so — so there is no cycle.
import {
  findTrack,
  setTrackVoiceRef,
  trackInstrumentId,
  type Result,
} from '../composition/compositionService';

const store = () => useVoiceStore.getState();

/** Membership asked of the lib's own list, so a slot the lib adds is accepted and
 *  one it renames is rejected. Both matter — the lib has renamed slots before and
 *  ships a migration map for it. */
const KNOWN_SLOT_IDS: ReadonlySet<string> = new Set(ALL_SLOT_IDS);

// ------------------------------------------------------------------- refs ---

/**
 * A voice the user can pick, built-in or their own.
 *
 * `key` exists because a `VariantRef` is an object and a `<select>` value is a
 * string. It round-trips through `parseVoiceKey`, so a picker never has to
 * reconstruct a ref by hand.
 */
export interface VoiceOption {
  readonly key: string;
  readonly ref: VariantRef;
  readonly name: string;
  /** Built-ins are readonly lib consts. Save is refused for them. */
  readonly builtIn: boolean;
}

export interface SelectableVoices {
  readonly builtIns: readonly VoiceOption[];
  readonly userVariants: readonly VoiceOption[];
}

export function voiceKey(ref: VariantRef): string {
  return ref.kind === 'default' ? `default:${ref.slotId}` : `user:${ref.id}`;
}

/**
 * The inverse of `voiceKey`. Null for anything unrecognised — including a slot id
 * the lib no longer knows, because an unknown slot resolves to the instrument's
 * first default and the picker would then show a selection that plays something
 * else. A variant id can't be validated here (variants come and go); `saveVoice`
 * and `renameVoice` check that separately.
 */
export function parseVoiceKey(key: string): VariantRef | null {
  const separator = key.indexOf(':');
  if (separator === -1) return null;
  const kind = key.slice(0, separator);
  const rest = key.slice(separator + 1);
  if (!rest) return null;
  if (kind === 'user') return { kind: 'user', id: rest };
  if (kind === 'default' && KNOWN_SLOT_IDS.has(rest)) {
    return { kind: 'default', slotId: rest as SlotId };
  }
  return null;
}

/**
 * The one cast, in the one module allowed to make it.
 *
 * `Pattern.voiceRef` and `Track.voiceRef` are the SAME `unknown` field for the
 * same reason (the lib keeps its pattern model independent of the voices
 * module), so they validate through one function rather than two that drift.
 *
 * Validated rather than cast blind because a ref is *persisted*: a malformed one
 * (a slot id the lib has since renamed, hand-edited storage) has to read as "no
 * choice" so resolution falls through cleanly, not as a choice the picker then
 * cannot find. The stored object is returned as-is when it is valid, so the
 * reference stays stable for callers that compare or memoise on it — which
 * `playbackService` and the lib's own `diffTracks` both do.
 */
function validateVoiceRef(ref: unknown): VariantRef | null {
  if (typeof ref !== 'object' || ref === null) return null;
  const candidate = ref as { kind?: unknown; slotId?: unknown; id?: unknown };
  if (candidate.kind === 'user' && typeof candidate.id === 'string' && candidate.id !== '') {
    return ref as VariantRef;
  }
  if (
    candidate.kind === 'default' &&
    typeof candidate.slotId === 'string' &&
    KNOWN_SLOT_IDS.has(candidate.slotId)
  ) {
    return ref as VariantRef;
  }
  return null;
}

/**
 * The pattern's own voice choice, validated — null when it has none and playback
 * falls back to the instrument's active voice.
 *
 * ⚠ PATTERN, not track. {@link readTrackVoiceRef} is the other one; see the
 * TRACK PATH banner below for why they are two functions and not one generic.
 */
export function readVoiceRef(pattern: Pattern): VariantRef | null {
  return validateVoiceRef(pattern.voiceRef);
}

/** React hook: the editing pattern's voice choice, or null. */
export function useEditingVoiceRef(): VariantRef | null {
  const pattern = useEditingPattern();
  return pattern ? readVoiceRef(pattern) : null;
}

// --------------------------------------------------------------- resolving ---

/**
 * The preset a pattern actually plays through.
 *
 * Delegated to the lib's resolver rather than reimplemented. Its fall-through
 * (user variant → default slot → the instrument's first default) is what keeps a
 * dangling ref from crashing the app on boot, and a second copy of that order here
 * would drift from the one playback uses — which is the same call.
 */
export function resolveVoicePreset(pattern: Pattern): VoicePreset {
  return resolveActiveVoice(patternInstrumentId(pattern), readVoiceRef(pattern));
}

/** Non-reactive read — for event handlers and the audio seam. */
export function getEditingVoicePreset(): VoicePreset | null {
  const pattern = getEditingPattern();
  return pattern ? resolveVoicePreset(pattern) : null;
}

/** React hook: the resolved preset for the editing pattern. */
export function useEditingVoicePreset(): VoicePreset | null {
  const pattern = useEditingPattern();
  // The selector ignores its argument on purpose. `resolveActiveVoice` reads the
  // voice store itself and is not reactive, so subscribing through `useVoiceStore`
  // is the only thing that makes a variant edit, rename or delete reach the pane.
  // Sound as a `useSyncExternalStore` snapshot because every resolution returns
  // either a stored object or a built-in const, so the reference is stable between
  // calls and React's cache check passes.
  return useVoiceStore(() => (pattern ? resolveVoicePreset(pattern) : null));
}

// ----------------------------------------------------------------- listing ---

/**
 * Zero or one option, because `getDefaultPresetForSlot` *throws* for a slot id with no
 * shipped preset. That is a lib inconsistency rather than something a user can cause,
 * but the same reasoning that makes `parseVoiceKey` reject an unknown slot applies here:
 * a registry the lib has half-renamed must cost the picker one entry, not the render.
 */
const optionForSlot = (slotId: SlotId): VoiceOption[] => {
  try {
    return [
      {
        key: voiceKey({ kind: 'default', slotId }),
        ref: { kind: 'default', slotId },
        // The slot's own preset name. `parseSlotId` is the lib's id splitter and is
        // deliberately unused: it assumes `<family>-<instrumentId>`, which holds for 3 of
        // the 11 guitar slots and turns `clean-amp` into instrument "amp" and
        // `karoryfer-green-guitar` into "green". The lib's own `getDefaultPresetForSlot`
        // sidesteps it for the same reason, in a comment that says so.
        name: getDefaultPresetForSlot(slotId).name,
        builtIn: true,
      },
    ];
  } catch {
    return [];
  }
};

const optionForVariant = (variant: Variant): VoiceOption => ({
  key: voiceKey({ kind: 'user', id: variant.id }),
  ref: { kind: 'user', id: variant.id },
  name: variant.name,
  builtIn: false,
});

function selectableVoices(
  instrumentId: FretInstrumentId,
  variants: readonly Variant[],
): SelectableVoices {
  return {
    // Registry order — the lib groups the instrument's own voices before its amp
    // slots, which is the order a picker wants anyway.
    builtIns: getSlotsForInstrument(instrumentId).flatMap(optionForSlot),
    // Filtered by instrument: a bass variant offered on a guitar pattern would
    // resolve to a bass preset on the wrong neck. Left in store order, which is
    // creation order — sorting by name would reshuffle the list under a rename.
    userVariants: variants
      .filter((variant) => variant.instrumentId === instrumentId)
      .map(optionForVariant),
  };
}

/** Non-reactive read. */
export function listSelectableVoices(instrumentId: FretInstrumentId): SelectableVoices {
  return selectableVoices(instrumentId, store().variants);
}

/** React hook: everything the user can pick for this instrument, split so a picker
 *  can label the two groups differently — the distinction is load-bearing, since
 *  only one of them can be saved to. */
export function useSelectableVoices(instrumentId: FretInstrumentId): SelectableVoices {
  const variants = useVoiceStore((s) => s.variants);
  return useMemo(() => selectableVoices(instrumentId, variants), [instrumentId, variants]);
}

// -------------------------------------------------------------- track path ---
/**
 * ⚠ THE SECOND PATH. Everything above this line is PATTERN-shaped; everything
 * between here and the writing section is TRACK-shaped, and the two must not be
 * crossed.
 *
 * A composition track carries its own `Track.voiceRef`, which is what lets a
 * clean lead guitar and a driven rhythm guitar exist in one arrangement. The
 * lib's resolver takes that ref DIRECTLY (`resolveActiveVoice(instrumentId,
 * explicitRef)`), bypassing the global `activeVariants` map, so per-track voices
 * need no new resolution order — only a read, a resolve and a write of their own.
 *
 * ⚠ {@link selectVoice} IS THE FUNCTION THAT LOOKS RIGHT AND IS WRONG for a
 * track. It writes the EDITING PATTERN's ref: called from a track control it
 * would retune whatever pattern happens to be open (on this page, the placement
 * being edited) and leave every track exactly as it was — which, with a single
 * track on screen and that track on the fallback, can even look like it worked.
 * {@link setTrackVoice} is the track write. They are deliberately named so that
 * neither completes into the other.
 *
 * The `unknown` cast stays in this module for tracks too: `compositionService`
 * stores `Track.voiceRef` opaquely by charter and must not narrow it.
 */

/**
 * A track's own voice choice, validated — null when it has none, which is the
 * lib's documented fallback to the instrument's global active variant.
 */
export function readTrackVoiceRef(track: Track): VariantRef | null {
  return validateVoiceRef(track.voiceRef);
}

/**
 * The preset a track actually plays through.
 *
 * The same delegation {@link resolveVoicePreset} makes, for the same reason: the
 * fall-through (user variant → default slot → the instrument's first default) is
 * the lib's, and `playbackService`'s `buildTrackVoice` reaches it through
 * `buildEffectiveVoice`, which is that same call. A second copy here would drift
 * from what is audible.
 */
export function resolveTrackVoicePreset(track: Track): VoicePreset {
  return resolveActiveVoice(trackInstrumentId(track), readTrackVoiceRef(track));
}

/**
 * React hook: the resolved preset for one track.
 *
 * Subscribed through `useVoiceStore` for {@link useEditingVoicePreset}'s reason —
 * `resolveActiveVoice` reads that store and is not reactive, so a rename, an edit
 * or a change of the instrument's global active variant would otherwise never
 * reach the picker. The `track` argument carries the ref itself and comes from the
 * composition store, which re-renders the strip on its own.
 */
export function useTrackVoicePreset(track: Track): VoicePreset {
  return useVoiceStore(() => resolveTrackVoicePreset(track));
}

/**
 * What a track's stored ref actually IS, which is not a yes/no.
 *
 *   `none`            — no override; the track follows the instrument's global
 *                       active variant, which is the lib's documented fallback.
 *   `ok`              — a voice this track can be offered and does play.
 *   `deleted`         — a user variant that has left the library. The track fell
 *                       back the moment it went, so nothing is lost by clearing.
 *   `wrong-instrument`— a real variant, for another instrument. Never offered
 *                       here, and resolving it would pick a preset for a neck
 *                       this track has not got.
 *
 * Three states rather than "offered / not offered" because the two failures are
 * different sentences to the user AND different answers to "is there anything to
 * lose here" — a dangling ref costs nothing to destroy, and a confirmation for a
 * free action is how people learn to click through confirmations.
 */
export type TrackVoiceStatus = 'none' | 'ok' | 'deleted' | 'wrong-instrument';

/** The shared classifier, so {@link setTrackVoice}'s refusal and the picker's
 *  label can never disagree about which of the two failures this is. */
function voiceStatusOf(
  instrumentId: FretInstrumentId,
  ref: VariantRef,
  variants: readonly Variant[],
): Exclude<TrackVoiceStatus, 'none'> {
  const key = voiceKey(ref);
  const offered = selectableVoices(instrumentId, variants);
  const known =
    offered.builtIns.some((option) => option.key === key) ||
    offered.userVariants.some((option) => option.key === key);
  if (known) return 'ok';
  if (ref.kind === 'user' && !variants.some((variant) => variant.id === ref.id)) {
    return 'deleted';
  }
  return 'wrong-instrument';
}

/** Non-reactive read — for event handlers and the write path. */
export function trackVoiceRefStatus(track: Track): TrackVoiceStatus {
  const ref = readTrackVoiceRef(track);
  if (!ref) return 'none';
  return voiceStatusOf(trackInstrumentId(track), ref, store().variants);
}

/**
 * React hook: {@link trackVoiceRefStatus}, subscribed.
 *
 * Through `useVoiceStore` because the answer changes when the LIBRARY changes,
 * not when the track does: deleting a variant in the voice pane is what turns an
 * `ok` ref into a `deleted` one, and nothing about the composition store moves
 * when that happens.
 */
export function useTrackVoiceStatus(track: Track): TrackVoiceStatus {
  const variants = useVoiceStore((s) => s.variants);
  return useMemo(() => {
    const ref = readTrackVoiceRef(track);
    if (!ref) return 'none';
    return voiceStatusOf(trackInstrumentId(track), ref, variants);
  }, [track, variants]);
}

/**
 * Point ONE track at a voice. `null` clears the override and puts the track back
 * on the instrument's global active variant.
 *
 * Refused rather than coerced when the ref is not one this track could be offered
 * — a variant that has been deleted, or one belonging to another instrument, which
 * would resolve to a preset for a neck the track has not got. Membership is asked
 * of {@link listSelectableVoices}, so the picker's offer set and the write can
 * never disagree; the agent reaches the same guard by calling this with a ref of
 * its own.
 *
 * Returns the COMPOSITION seam's `Result` rather than {@link VoiceWriteResult}: the
 * write lands in the composition store, its refusals are composition facts ("no
 * such track"), and every other track write on this page already reports that way.
 *
 * Nothing is disposed or rebuilt here. `playbackService` picks the change up from
 * the composition store — the engine's own diff swaps that track's voice and only
 * that track's — so this is audible mid-playback without a restart.
 *
 * ⚠ IDEMPOTENT BY VALUE, and that is not a nicety. `compositionService` guards on
 * REFERENCE identity, deliberately — the value is opaque to it by charter — but
 * every ref that reaches here is freshly minted (`parseVoiceKey` builds one,
 * `listSelectableVoices` builds new ones per call), so a re-emitted pick would be
 * a write. During playback the lib's `diffTracks` compares by reference too, so
 * that write comes out as `'voice'` and rebuilds the whole `Voice` — one
 * `Tone.Sampler` and an HTTP load per bank, with the track silent until they
 * decode — for a change that is not a change. Unreachable from a `<select>`,
 * which fires nothing on an unchanged value; squarely reachable by the agent,
 * which is the caller that matters here.
 */
export function setTrackVoice(trackId: string, ref: VariantRef | null): Result {
  const track = findTrack(trackId);
  if (!track) return { ok: false, reason: 'No such track.' };
  // Cleared straight through: "follow the instrument" is always a legal choice,
  // and there is nothing to validate about it. `== null` rather than `=== null`
  // because `createEmptyTrack` never sets the field at all — a fresh track holds
  // `undefined`, and writing `null` over it would rebuild the voice to say the
  // same thing. A ref that is merely MALFORMED is written over, not skipped: it
  // resolves the same way but it is still garbage in the document.
  if (ref === null) {
    return track.voiceRef == null ? { ok: true, value: undefined } : setTrackVoiceRef(trackId, null);
  }

  const instrumentId = trackInstrumentId(track);
  const status = voiceStatusOf(instrumentId, ref, store().variants);
  if (status !== 'ok') {
    // Two different mistakes, and the caller can only fix one of them: a variant
    // that is simply gone, versus one that exists but is for another instrument.
    return {
      ok: false,
      reason:
        status === 'deleted'
          ? 'That voice is no longer in your library.'
          : `That voice is not one of the ${instrumentId} voices this track can play.`,
    };
  }
  // After the membership check, never before: a ref this track cannot play still
  // has to be refused, even in the impossible case that it is already stored.
  const current = readTrackVoiceRef(track);
  if (current && voiceKey(current) === voiceKey(ref)) return { ok: true, value: undefined };
  return setTrackVoiceRef(trackId, ref);
}

// ----------------------------------------------------------------- writing ---

/**
 * Why a write was refused. Returned rather than thrown because every one of these
 * is a state a pane can legitimately be in, and the pane has to say which:
 *
 *   `no-pattern`      — nothing open to attach a voice to.
 *   `no-voice`        — the pattern has no explicit ref, so it is playing whatever
 *                       the instrument's active voice resolves to. Nothing
 *                       addressable to write back to; Save-as is the way out.
 *   `built-in`        — one of the fourteen readonly slot presets.
 *   `unknown-variant` — the ref names a variant that no longer exists.
 *   `empty-name`      — a variant with a blank name is unfindable in the picker.
 *   `capped`          — the lib's tier gate refused and has already opened its own
 *                       signup/upgrade prompt.
 */
export type VoiceRefusal =
  | 'no-pattern'
  | 'no-voice'
  | 'built-in'
  | 'unknown-variant'
  | 'empty-name'
  | 'capped';

export type VoiceWriteResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: VoiceRefusal };

const refuse = (reason: VoiceRefusal): VoiceWriteResult => ({ ok: false, reason });

/**
 * The same refusals, plus the one only a track can suffer.
 *
 * A SUPERSET rather than a member of {@link VoiceRefusal}, deliberately:
 * `VoicePane` maps that union with a `Record`, so widening it would make the
 * pattern page fail to compile for a state it can never be in. `no-pattern` is
 * carried along because {@link renameVoice} and {@link deleteVoice} are shared
 * with the pattern page and are typed on the narrower union — neither can
 * actually return it, but a rail rendering their results has to have a sentence
 * for every member it is handed.
 */
export type TrackVoiceRefusal = VoiceRefusal | 'no-track';

export type TrackVoiceWriteResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: TrackVoiceRefusal };

/**
 * Point the EDITING PATTERN at a voice.
 *
 * ⚠ NOT the track write — {@link setTrackVoice} is. This one addresses whichever
 * pattern is open, so from a composition track control it would retune the
 * placement being edited and change no track at all.
 *
 * Writes `pattern.voiceRef` and nothing else. In particular not the global
 * `activeVariants` map: that is the instrument-wide default shared by every pattern
 * without an explicit ref, and setting it here would silently retune all of them.
 *
 * Nothing becomes audible as a side effect. `playbackService` keys its live voice on
 * this ref, so the change lands the next time the engine is asked for one; to hear it
 * mid-playback the caller follows this with `playbackService.refreshVoice()`. Not
 * `applyVoicePreset` — that would pin the newly resolved preset as an unsaved working
 * copy and shadow the store for as long as the ref stays put.
 *
 * Follow it with `refreshVoice()` even when nothing is playing: that call is also what
 * retires the working copy the user just walked away from, so it cannot come back if
 * they later return to the voice it was taken from.
 */
export function selectVoice(ref: VariantRef): void {
  setEditingPatternVoiceRef(ref);
}

/**
 * Overwrite the variant the editing pattern points at with `preset`.
 *
 * The built-in refusal is the real guard, not a mirror of a disabled button: the
 * fourteen slot presets are `readonly` consts reached through
 * `getDefaultPresetForSlot`, and `useVoiceStore` has no setter for them at all —
 * only `updateVariant`, which addresses user variants by id. A UI that let this
 * through would look like it saved and lose the edit on the next reload.
 *
 * Remember that a variant is SHARED: this changes the voice for every pattern
 * pointing at the same ref, which is intended.
 */
export function saveVoice(preset: VoicePreset): VoiceWriteResult {
  const pattern = getEditingPattern();
  if (!pattern) return refuse('no-pattern');
  return writeVariant(readVoiceRef(pattern), patternInstrumentId(pattern), preset);
}

/**
 * Overwrite the variant a ref names — the shared core of {@link saveVoice} and
 * {@link saveTrackVoice}.
 *
 * The two callers differ only in WHOSE ref and instrument they resolve. Shared
 * rather than copied because these four guards are the whole of Save's
 * semantics, and a second copy of the built-in refusal is a second place for it
 * to drift from the one the buttons are disabled by.
 */
function writeVariant(
  ref: VariantRef | null,
  instrumentId: FretInstrumentId,
  preset: VoicePreset,
): VoiceWriteResult {
  if (!ref) return refuse('no-voice');
  if (ref.kind === 'default') return refuse('built-in');

  const variant = store().variants.find((candidate) => candidate.id === ref.id);
  if (!variant) return refuse('unknown-variant');
  // A ref can outlive the instrument it made sense for — persisted, hand-edited, or a
  // future multi-instrument flow. Refused rather than coerced: the picker doesn't offer
  // this variant for this instrument, so a Save that landed here would overwrite a voice
  // the user cannot even see from where they are standing.
  if (variant.instrumentId !== instrumentId) return refuse('unknown-variant');

  // `Variant.name`/`family` and the payload's are kept in lockstep — the picker reads the
  // record, exports and Save-as read the payload, and a user who renames one and
  // sees the other is right to call it a bug.
  store().updateVariant(ref.id, { preset, name: preset.name, family: preset.family });
  return { ok: true, id: ref.id };
}

/**
 * Copy `preset` into a new user variant and point the pattern at it.
 *
 * The repoint is the whole point: without it the pattern keeps playing the built-in
 * the copy was taken from, and the saved variant sits in the library unused.
 *
 * Folders are a later slice, so the variant lands at the root. `collectionId` has to
 * be passed regardless — the lib's `addVariant` takes the whole record minus its
 * generated fields.
 */
export function saveVoiceAs(name: string, preset: VoicePreset): VoiceWriteResult {
  const pattern = getEditingPattern();
  if (!pattern) return refuse('no-pattern');

  const trimmed = name.trim();
  if (!trimmed) return refuse('empty-name');

  const id = addUserVariant(trimmed, patternInstrumentId(pattern), preset);
  // `addVariant` returns '' when the tier gate refuses; it has already opened its
  // own signup/upgrade prompt, so there is nothing for us to report but the refusal.
  if (!id) return refuse('capped');

  selectVoice({ kind: 'user', id });
  return { ok: true, id };
}

/**
 * Copy a preset into a new user variant and return its id, or '' when the lib's
 * tier gate refuses.
 *
 * The COPY only — pointing something at the result is the caller's, and it is
 * the whole difference between {@link saveVoiceAs} and {@link saveTrackVoiceAs}.
 * Folders are a later slice, so the variant lands at the root; `collectionId`
 * has to be passed regardless, because the lib's `addVariant` takes the whole
 * record minus its generated fields.
 */
function addUserVariant(
  name: string,
  instrumentId: FretInstrumentId,
  preset: VoicePreset,
): string {
  return store().addVariant({
    name,
    instrumentId,
    family: preset.family,
    collectionId: null,
    // The record and its payload must agree on both name and instrument. On the
    // instrument because the record is what filters the picker while the payload is
    // what gets built — disagree and the picker offers a voice that plays on another
    // instrument's neck.
    preset: { ...preset, name, instrumentId },
  });
}

/**
 * Rename a user variant.
 *
 * Not `renameVariant`, which only patches the record: `saveVoice` writes the
 * record's name back from `preset.name`, so a rename that skipped the payload would
 * be silently reverted by the next Save.
 */
export function renameVoice(id: string, name: string): VoiceWriteResult {
  const trimmed = name.trim();
  if (!trimmed) return refuse('empty-name');

  const variant = store().variants.find((candidate) => candidate.id === id);
  if (!variant) return refuse('unknown-variant');

  store().updateVariant(id, { name: trimmed, preset: { ...variant.preset, name: trimmed } });
  return { ok: true, id };
}

/**
 * Delete a user variant.
 *
 * The lib's `deleteVariant` repoints the global `activeVariants` map off the deleted
 * id but knows nothing about patterns, so the editing pattern's ref is cleared here.
 * Left dangling it would resolve — silently, by design — to the instrument's first
 * built-in, and the pane would show nothing selected while the pattern still played.
 *
 * Only the editing pattern is repaired: other patterns in the library can hold the
 * same ref and there is no bulk pattern write to fix them with (LIB-GAP(1) is the
 * same missing primitive). They fall back cleanly, which is the lib's own answer.
 */
export function deleteVoice(id: string): VoiceWriteResult {
  if (!store().variants.some((variant) => variant.id === id)) {
    return refuse('unknown-variant');
  }
  store().deleteVariant(id);

  const pattern = getEditingPattern();
  const ref = pattern ? readVoiceRef(pattern) : null;
  if (ref?.kind === 'user' && ref.id === id) setEditingPatternVoiceRef(null);

  return { ok: true, id };
}

// --------------------------------------------------------- track writing ---
/**
 * ⚠ THE SECOND WRITE PATH, and the same trap as {@link selectVoice}.
 *
 * {@link saveVoice} and {@link saveVoiceAs} resolve their target through
 * `getEditingPattern()`. Called from a composition surface they would overwrite
 * the variant the OPEN PATTERN points at and repoint that pattern — leaving
 * every track exactly as it was, which with one track on the fallback can even
 * look like it worked. The two below resolve through a `Track` instead and
 * repoint through {@link setTrackVoice}. They share `writeVariant` and
 * `addUserVariant` with the pattern pair, so the refusals cannot drift.
 *
 * {@link renameVoice} is NOT duplicated here: it addresses a variant by id, and a
 * variant is a SHARED asset with no per-holder identity — renaming one from a
 * track and from a pattern are the same act on the same object. Deleting is the
 * same act too, but it leaves a dangling ref BEHIND it, and the holder to repair
 * differs — hence {@link deleteTrackVoice}, which is `deleteVoice` plus that one
 * repair rather than a second implementation of it.
 */

/**
 * Overwrite the variant ONE TRACK points at.
 *
 * Takes the preset rather than reading the track's draft, exactly as
 * {@link saveVoice} does: `trackVoiceDrafts` imports this module, so reading it
 * from here would be a cycle. The caller passes `trackVoicePreset(track)`.
 *
 * Remember that a variant is SHARED. This retunes every pattern AND every other
 * track pointing at the same ref, which is intended and is why the rail says so
 * before the button is pressed. There is deliberately no per-track fork.
 */
export function saveTrackVoice(trackId: string, preset: VoicePreset): TrackVoiceWriteResult {
  const track = findTrack(trackId);
  if (!track) return { ok: false, reason: 'no-track' };
  return writeVariant(readTrackVoiceRef(track), trackInstrumentId(track), preset);
}

/**
 * Copy a preset into a new user variant and point ONE TRACK at it.
 *
 * The repoint is the whole point, and it is the half that differs from
 * {@link saveVoiceAs}: without it the track keeps playing the built-in the copy
 * was taken from and the saved variant sits in the library unused.
 */
export function saveTrackVoiceAs(
  trackId: string,
  name: string,
  preset: VoicePreset,
): TrackVoiceWriteResult {
  const track = findTrack(trackId);
  if (!track) return { ok: false, reason: 'no-track' };

  const trimmed = name.trim();
  if (!trimmed) return { ok: false, reason: 'empty-name' };

  const id = addUserVariant(trimmed, trackInstrumentId(track), preset);
  if (!id) return { ok: false, reason: 'capped' };

  // The variant was just minted FOR this track's instrument, so the membership
  // half of `setTrackVoice` cannot refuse it; the only reachable refusal left is
  // the track having gone, which this synchronous stretch makes impossible. The
  // guard stands anyway, and the variant is deliberately NOT rolled back if it
  // ever fires — a voice the user has named is not garbage, and it is now in the
  // library where they can point anything at it.
  const pointed = setTrackVoice(trackId, { kind: 'user', id });
  // Reported as the only refusal that could still be true rather than collapsing
  // three into one: `setTrackVoice` also refuses `deleted` and `wrong-instrument`,
  // and printing "that track is no longer in this composition" for either would be
  // a confidently wrong sentence the day `voiceStatusOf` changes.
  if (!pointed.ok) {
    return { ok: false, reason: findTrack(trackId) ? 'unknown-variant' : 'no-track' };
  }

  return { ok: true, id };
}

/**
 * Delete a user variant AND repair the track that pointed at it — one act.
 *
 * {@link deleteVoice} repairs the editing PATTERN's ref and knows nothing about
 * tracks, so a caller with no pointer would get the pattern fixed and every track
 * left dangling. Pairing them here is what keeps the gesture and the seam doing
 * the same thing: one command, one undo step, callable by id.
 *
 * Only THIS track is repaired, for the same reason only the editing pattern is:
 * there is no bulk track write to fix the others with (LIB-GAP(1) is the same
 * missing primitive), and they fall back cleanly, which is the lib's own answer.
 */
export function deleteTrackVoice(trackId: string, id: string): TrackVoiceWriteResult {
  const track = findTrack(trackId);
  if (!track) return { ok: false, reason: 'no-track' };

  const deleted = deleteVoice(id);
  // `unknown-variant` is the ONLY refusal `deleteVoice` has, and it means the
  // variant is already gone — this track's ref is the dangling remains of it, so
  // the repair below still has to happen. Anything else left the library untouched
  // and the ref is still good.
  if (!deleted.ok && deleted.reason !== 'unknown-variant') return deleted;

  const ref = readTrackVoiceRef(track);
  if (ref?.kind === 'user' && ref.id === id) {
    const repaired = setTrackVoice(trackId, null);
    if (!repaired.ok) return { ok: false, reason: 'no-track' };
  }
  return { ok: true, id };
}
