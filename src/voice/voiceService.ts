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
 * The pattern's own voice choice, validated — null when it has none and playback
 * falls back to the instrument's active voice.
 *
 * Validated rather than cast blind because a ref is *persisted*: a malformed one
 * (a slot id the lib has since renamed, hand-edited storage) has to read as "no
 * choice" so resolution falls through cleanly, not as a choice the picker then
 * cannot find. The stored object is returned as-is when it is valid, so the
 * reference stays stable for callers that compare or memoise on it.
 */
export function readVoiceRef(pattern: Pattern): VariantRef | null {
  const ref = pattern.voiceRef;
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
 * Point the editing pattern at a voice.
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

  const ref = readVoiceRef(pattern);
  if (!ref) return refuse('no-voice');
  if (ref.kind === 'default') return refuse('built-in');

  const variant = store().variants.find((candidate) => candidate.id === ref.id);
  if (!variant) return refuse('unknown-variant');
  // A ref can outlive the instrument it made sense for — persisted, hand-edited, or a
  // future multi-instrument flow. Refused rather than coerced: the picker doesn't offer
  // this variant for this instrument, so a Save that landed here would overwrite a voice
  // the user cannot even see from where they are standing.
  if (variant.instrumentId !== patternInstrumentId(pattern)) {
    return refuse('unknown-variant');
  }

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

  const instrumentId = patternInstrumentId(pattern);
  const id = store().addVariant({
    name: trimmed,
    instrumentId,
    family: preset.family,
    collectionId: null,
    // The record and its payload must agree on both name and instrument. On the
    // instrument because the record is what filters the picker while the payload is
    // what gets built — disagree and the picker offers a voice that plays on another
    // instrument's neck.
    preset: { ...preset, name: trimmed, instrumentId },
  });
  // `addVariant` returns '' when the tier gate refuses; it has already opened its
  // own signup/upgrade prompt, so there is nothing for us to report but the refusal.
  if (!id) return refuse('capped');

  selectVoice({ kind: 'user', id });
  return { ok: true, id };
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
