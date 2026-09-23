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
 *   - the app has ONE kind of voice: the user's own. `VariantRef`'s `default` arm —
 *     the lib's fourteen slot presets — is unrepresentable above this line (see
 *     {@link UserVariantRef}), so nothing here offers, names or validates against
 *     it. The lib keeps those presets because its resolver needs a FLOOR, and that
 *     floor is what "Auto" / "Instrument default" plays; the app authors no
 *     starting preset of its own.
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
 * `paramSchema.ts` reads the static registries (`CIRCUIT_AMPS`, `CABINET_IRS`,
 * `SAMPLE_PACKS`) directly. That is not a hole in this seam: those are frozen option
 * tables with no store behind them, and a descriptor table is the right owner. What
 * lives here is everything with state or resolution order in it.
 */
import { useMemo } from 'react';
import {
  resolveActiveVoice,
  useVoiceStore,
  type FretInstrumentId,
  type Pattern,
  type Track,
  type Variant,
  type VariantRef,
  type VoicePreset,
} from '@fretwork/lib';
import {
  findLibraryPattern,
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

// ------------------------------------------------------------------- refs ---

/**
 * ⚠ THE ONLY KIND OF REF THE APP HAS — a user variant.
 *
 * `VariantRef`'s other arm, `{ kind: 'default', slotId }`, names one of the lib's
 * fourteen slot presets. The app stopped modelling those (2026-09-20,
 * `docs/PLAN-remove-presets.md`): a holder either points at a voice of the user's
 * own or has none and follows its instrument, and the instrument's fall-through is
 * the lib resolver's own floor rather than anything this module names.
 *
 * Narrowed at the TYPE rather than refused at a guard, which is the whole point:
 * every "is this a built-in?" branch that used to exist is now unrepresentable
 * instead of unreachable, so none of them can survive as dead code. A stored
 * default ref therefore reads as `null` through {@link readVoiceRef} — not
 * migrated, not displayed, and not a picker state of its own.
 */
export type UserVariantRef = Extract<VariantRef, { kind: 'user' }>;

/**
 * A voice the user can pick. All of them are the user's own.
 *
 * `key` exists because a ref is an object and a `<select>` value is a string. It
 * round-trips through `parseVoiceKey`, so a picker never has to reconstruct a ref
 * by hand.
 */
export interface VoiceOption {
  readonly key: string;
  readonly ref: UserVariantRef;
  readonly name: string;
}

export interface SelectableVoices {
  readonly userVariants: readonly VoiceOption[];
}

/** Still prefixed, and the prefix is not vestigial: it is what makes
 *  {@link parseVoiceKey} able to reject a key that is not one of ours — a stored
 *  `default:clean-amp` included — rather than reading its tail as a variant id. */
export function voiceKey(ref: UserVariantRef): string {
  return `user:${ref.id}`;
}

/**
 * The inverse of `voiceKey`. Null for anything else, which now includes every
 * `default:<slotId>` key a previous version of this app handed out: the app has no
 * such voice any more, so the only honest answer is "not a voice key". A variant id
 * can't be validated here (variants come and go); `saveVoice` and `renameVoice`
 * check that separately.
 */
export function parseVoiceKey(key: string): UserVariantRef | null {
  const separator = key.indexOf(':');
  if (separator === -1) return null;
  const kind = key.slice(0, separator);
  const rest = key.slice(separator + 1);
  if (!rest) return null;
  if (kind === 'user') return { kind: 'user', id: rest };
  return null;
}

/**
 * The one cast, in the one module allowed to make it.
 *
 * `Pattern.voiceRef` and `Track.voiceRef` are the SAME `unknown` field for the
 * same reason (the lib keeps its pattern model independent of the voices
 * module), so they validate through one function rather than two that drift.
 *
 * Validated rather than cast blind because a ref is *persisted*: anything that is
 * not a user variant (hand-edited storage, or a `{ kind: 'default', slotId }` left
 * behind by the version of this app that offered the lib's slot presets) has to
 * read as "no choice" so resolution falls through cleanly, not as a choice the
 * picker then cannot find. That fall-through IS the migration — see
 * {@link UserVariantRef}. The stored object is returned as-is when it is valid, so
 * the reference stays stable for callers that compare or memoise on it — which
 * `playbackService` and the lib's own `diffTracks` both do.
 */
function validateVoiceRef(ref: unknown): UserVariantRef | null {
  if (typeof ref !== 'object' || ref === null) return null;
  const candidate = ref as { kind?: unknown; id?: unknown };
  if (candidate.kind === 'user' && typeof candidate.id === 'string' && candidate.id !== '') {
    return ref as UserVariantRef;
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
export function readVoiceRef(pattern: Pattern): UserVariantRef | null {
  return validateVoiceRef(pattern.voiceRef);
}

/** React hook: the editing pattern's voice choice, or null. */
export function useEditingVoiceRef(): UserVariantRef | null {
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

// ----------------------------------------------------------------- listing ---

const optionForVariant = (variant: Variant): VoiceOption => ({
  key: voiceKey({ kind: 'user', id: variant.id }),
  ref: { kind: 'user', id: variant.id },
  name: variant.name,
});

function selectableVoices(
  instrumentId: FretInstrumentId,
  variants: readonly Variant[],
): SelectableVoices {
  return {
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

/** React hook: everything the user can pick for this instrument.
 *
 *  Still a record with one field rather than a bare array: a picker draws the
 *  user's voices as a labelled group beside the "Auto" / "Instrument default" row,
 *  and a named field is what keeps that grouping from being implied by position. */
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
 * ⚠ {@link selectVoice} WITH THE WRONG `kind` IS THE TRAP, and since the write
 * seam merged it is the only one left. `selectVoice('pattern', …)` writes the
 * EDITING PATTERN's ref: aimed at a track it would retune whatever pattern
 * happens to be open (on this page, the placement being edited) and leave every
 * track exactly as it was — which, with a single track on screen and that track
 * on the fallback, can even look like it worked. The `kind` is the whole of the
 * difference between the two writes and it is never inferred.
 *
 * The `unknown` cast stays in this module for tracks too: `compositionService`
 * stores `Track.voiceRef` opaquely by charter and must not narrow it.
 */

/**
 * A track's own voice choice, validated — null when it has none, which is the
 * lib's documented fallback to the instrument's global active variant.
 */
export function readTrackVoiceRef(track: Track): UserVariantRef | null {
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
 * Subscribed through `useVoiceStore` for {@link useHolderVoicePreset}'s reason —
 * `resolveActiveVoice` reads that store and is not reactive, so a rename, an edit
 * or a change of the instrument's global active variant would otherwise never
 * reach the picker. The `track` argument carries the ref itself and comes from the
 * composition store, which re-renders the strip on its own.
 */
export function useTrackVoicePreset(track: Track): VoicePreset {
  return useVoiceStore(() => resolveTrackVoicePreset(track));
}

// ------------------------------------------------------------ the holders ---
// A voice belongs to a PATTERN or to a TRACK, and `voiceDrafts` holds an unsaved
// edit for either. Addressed by kind and id and never by the document itself —
// `CLAUDE.md`'s rule is that the agent must be able to act without a pointer, and
// a `{ kind: 'pattern'; pattern: Pattern }` argument would take that away.

/** Which kind of document a voice edit belongs to. Declared HERE and not in
 *  `voiceDrafts` because that module imports this one; the other way round is a
 *  cycle. */
export type HolderKind = 'pattern' | 'track';

type VoiceHolder =
  | { readonly kind: 'pattern'; readonly pattern: Pattern }
  | { readonly kind: 'track'; readonly track: Track };

/**
 * The document `kind` and `id` name, or null when it is gone.
 *
 * The EDITING pattern wins over the library row of the same id, and that is not
 * an optimisation: a placement's snapshot carries the id of the library pattern
 * it was cut from (`patternService.openPattern` says so), so the two can be
 * different documents under one id — and the one the engine plays is the one
 * that is open.
 */
function findVoiceHolder(kind: HolderKind, id: string): VoiceHolder | null {
  if (kind === 'track') {
    const track = findTrack(id);
    return track ? { kind: 'track', track } : null;
  }
  const editing = getEditingPattern();
  if (editing?.id === id) return { kind: 'pattern', pattern: editing };
  const stored = findLibraryPattern(id);
  return stored ? { kind: 'pattern', pattern: stored } : null;
}

/**
 * The pattern arm's holder: the EDITING pattern, and only when it is the one
 * named.
 *
 * Narrower than {@link findVoiceHolder} on purpose, and only the WRITES use it.
 * `setEditingPatternVoiceRef` is the only pattern-side ref write the pattern seam
 * has, so a library row handed in by id could be read and never repointed — a
 * Save-as that minted a variant and then could not point the document at it is a
 * worse answer than a refusal. The reads above stay on `findVoiceHolder`, which
 * is right for them: a tag or a resolved preset is answerable for any pattern.
 */
function editingPatternById(id: string): Pattern | null {
  const editing = getEditingPattern();
  return editing?.id === id ? editing : null;
}

/**
 * Instrument + ref, with no preset content in it — what a draft is tagged with,
 * so an edit OF a voice retires when the holder is pointed at a different one.
 *
 * Null when the holder is gone, which is also how the draft store tells "no such
 * track" from "a track with no edit".
 *
 * Built from the ref's discriminant rather than `JSON.stringify`, so a ref
 * rehydrated as `{id, kind}` keys the same as the `{kind, id}` a picker mints.
 */
export function holderVoiceTag(kind: HolderKind, id: string): string | null {
  const holder = findVoiceHolder(kind, id);
  if (!holder) return null;
  const instrumentId =
    holder.kind === 'pattern'
      ? patternInstrumentId(holder.pattern)
      : trackInstrumentId(holder.track);
  const ref =
    holder.kind === 'pattern' ? readVoiceRef(holder.pattern) : readTrackVoiceRef(holder.track);
  return `${instrumentId}|${ref ? voiceKey(ref) : 'none'}`;
}

/** The preset a holder plays through with no unsaved edit in front of it — the
 *  lib's own resolution, whichever kind of holder it is. Null when it is gone. */
export function resolveHolderVoicePreset(kind: HolderKind, id: string): VoicePreset | null {
  const holder = findVoiceHolder(kind, id);
  if (!holder) return null;
  return holder.kind === 'pattern'
    ? resolveVoicePreset(holder.pattern)
    : resolveTrackVoicePreset(holder.track);
}

/**
 * React hook: {@link resolveHolderVoicePreset}, subscribed.
 *
 * Subscribed through `useVoiceStore`, and that is the load-bearing half: the
 * selector ignores its state argument, because `resolveActiveVoice` reads the voice
 * store itself and is not reactive — so a rename, a save or a change to the
 * instrument's global active variant would otherwise never reach the editor. Sound
 * as a snapshot only because every resolution returns either a stored object or one
 * of the lib's own frozen preset consts, so the reference is stable between
 * renders; a resolution that started spreading would render-loop its consumer
 * rather than fail an assertion. The HOLDER half is the caller's own subscription:
 * the pane reads `useEditingPattern`, the rack is handed a `Track` by a grid that
 * reads the composition store, and either re-renders this.
 */
export function useHolderVoicePreset(kind: HolderKind, id: string): VoicePreset | null {
  return useVoiceStore(() => resolveHolderVoicePreset(kind, id));
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

/** The shared classifier, so the track arm of {@link selectVoice} and the picker's
 *  label can never disagree about which of the two failures this is. */
function voiceStatusOf(
  instrumentId: FretInstrumentId,
  ref: UserVariantRef,
  variants: readonly Variant[],
): Exclude<TrackVoiceStatus, 'none'> {
  const key = voiceKey(ref);
  // Asked of the OFFER SET rather than of `variants` directly, though the two
  // filters are one line apart: it is what makes "the picker offers it" and "the
  // write accepts it" the same question by construction.
  const offered = selectableVoices(instrumentId, variants);
  if (offered.userVariants.some((option) => option.key === key)) return 'ok';
  // Present but not offered can only mean the wrong neck, since the offer set is
  // the instrument's variants and nothing else.
  return variants.some((variant) => variant.id === ref.id) ? 'wrong-instrument' : 'deleted';
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

// ----------------------------------------------------------------- writing ---
/**
 * ⚠ FIVE WRITES, EACH WITH TWO ARMS.
 *
 * A voice belongs to a PATTERN or to a TRACK, and the writes below take
 * `(kind, id, …)` so one caller — the agent included — can address either
 * without holding the document. `renameVoice` is the exception and takes
 * neither: it addresses a VARIANT by id, and a variant is a shared asset with no
 * per-holder identity to disagree about.
 *
 * The arms are kept apart INSIDE each function rather than flattened. The two
 * holders validate differently, repair differently, and one of them needs a
 * `refreshVoice()` after the call that the other must never make. A merged
 * signature is the point; a merged body would be the bug.
 */

/**
 * Why a write was refused. Returned rather than thrown because every one of these
 * is a state a surface can legitimately be in, and the surface has to say which:
 *
 *   `no-holder`       — nothing open to attach a voice to: no pattern open (or a
 *                       different one open), or no such track in this
 *                       composition. ONE code for both kinds, because a surface
 *                       only ever renders its own; the prose that names the kind
 *                       is {@link describeVoiceRefusal}'s and each surface's own.
 *   `no-voice`        — the holder has no explicit ref, so it is playing whatever
 *                       the instrument's active voice resolves to. Nothing
 *                       addressable to write back to; Save-as is the way out.
 *   `unknown-variant` — the ref names a variant that no longer exists, belongs to
 *                       another instrument, or was named by a string that is not
 *                       one of our voice keys at all ({@link variantIdFromKey},
 *                       which is the agent's path in). THREE states, ONE code and
 *                       one sentence, deliberately: all three mean "that is not a
 *                       voice you have", and a caller's only move is the same in
 *                       each.
 *   `empty-name`      — a variant with a blank name is unfindable in the picker.
 *   `capped`          — the lib's tier gate refused and has already opened its own
 *                       signup/upgrade prompt.
 */
export type VoiceRefusal =
  | 'no-holder'
  | 'no-voice'
  | 'unknown-variant'
  | 'empty-name'
  | 'capped';

export type VoiceWriteResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: VoiceRefusal };

const refuse = (reason: VoiceRefusal): VoiceWriteResult => ({ ok: false, reason });

/**
 * The refusal as a SENTENCE.
 *
 * The codes above are for a surface that wants to render each state differently
 * (`VoicePane` and `TrackVoiceRack` both map them with a `Record`, and get to phrase
 * them in their own voice next to the control that caused them). A caller with no
 * surface — the agent's tools, a log line — needs prose, and `'no-voice'` on its
 * own is not prose. Authored HERE rather than in the tool layer so there is one
 * map to widen when the union grows, and so a new refusal cannot reach a caller
 * as a bare identifier.
 *
 * ⚠ THE KIND IS A PARAMETER, NOT A FIELD ON THE REFUSAL, and merging `no-pattern`
 * and `no-track` into `no-holder` is what forced the choice: "no holder" is not a
 * sentence anyone can act on, so the prose has to name which document is missing.
 * Carrying the kind on the refusal would make it an object, and both surfaces
 * index these codes as `Record` keys — it has to stay a bare union member for
 * that to compile, and for a new refusal to be a compile error in both surfaces
 * rather than a missing sentence in one. Every caller already knows its kind: a
 * surface is one holder, and the agent's voice tools are the track path.
 *
 * Deliberately not wired into the two surfaces' refusal maps: their copy sits
 * next to the button and can say less, and each says "this pattern" or "this
 * track" where this one has to be self-contained. The ONE place a surface does
 * render this wording is {@link selectVoice}, whose arms answer with the
 * composition seam's `Result` — prose, not a code — so a refused PICK reads in
 * this voice while a refused Save reads in the surface's own.
 */
export function describeVoiceRefusal(kind: HolderKind, reason: VoiceRefusal): string {
  switch (reason) {
    case 'no-holder':
      // Not "no pattern is open": the pattern arm also refuses a pattern that is
      // in the library but not the one open, and "is open" would be a confidently
      // wrong sentence for it.
      return kind === 'pattern'
        ? 'No such pattern is open.'
        : 'That track is no longer in this composition.';
    case 'no-voice':
      return 'That has no voice of its own to save — it is playing the instrument’s active voice. Save it as a new voice instead.';
    case 'unknown-variant':
      return 'That voice is not in your library (or belongs to another instrument).';
    case 'empty-name':
      return 'A voice needs a name.';
    case 'capped':
      return 'Your library is at its voice limit, so nothing was saved.';
  }
}

/**
 * Point a pattern, or ONE track, at a voice.
 *
 * Returns the COMPOSITION seam's `Result` rather than {@link VoiceWriteResult} on
 * both arms: the track write lands in the composition store, its refusals are
 * composition facts ("no such track"), and every other track write on that page
 * already reports that way. The pattern arm reported nothing at all before the
 * merge and gained one here — strictly more than it used to say, and on the path
 * a picker can reach it can only be `ok`.
 *
 * ⚠ THREE THINGS DIFFER BETWEEN THE ARMS, and none of them survives a flattening:
 *
 *   1. VALIDATION. The track arm asks {@link listSelectableVoices} whether this
 *      track could be OFFERED the ref and refuses `deleted` and
 *      `wrong-instrument` in words, because a variant for another instrument
 *      would resolve to a preset for a neck the track has not got. The pattern
 *      arm validates nothing beyond the holder, deliberately: it is the write
 *      the pattern picker has always made, and a pattern whose ref stops
 *      resolving falls through to the instrument's first default rather than
 *      breaking. Tightening it is a change to make on purpose, not here.
 *   2. NULL. `null` means "follow the instrument's global active variant". That
 *      is a real choice for a track and NOT one for a pattern: a pattern with no
 *      ref plays the global `activeVariants` entry that every other ref-less
 *      pattern plays, so "clear it" hands the document over to a setting the
 *      user did not name from here. There has never been a clear-the-ref write
 *      on the pattern side and there still is not — it is refused in words
 *      rather than quietly ignored.
 *   3. `refreshVoice()`. The PATTERN arm needs the caller to follow with
 *      `playbackService.refreshVoice()`: it is what makes the selection audible,
 *      and it is also what retires an edit abandoned behind the pane's back, so
 *      it is called even when nothing is playing. The TRACK arm must not —
 *      `playbackService` picks a track's ref change up from the composition
 *      store and swaps that one track's voice, while `refreshVoice` rebuilds the
 *      EDITING PATTERN's voice, which this write never touched. The seam cannot
 *      make either call itself: `playbackService` imports this module, so the
 *      arrow only points one way.
 */
export function selectVoice(kind: HolderKind, id: string, ref: UserVariantRef | null): Result {
  return kind === 'track' ? selectTrackVoice(id, ref) : selectPatternVoice(id, ref);
}

/**
 * The PATTERN arm of {@link selectVoice}.
 *
 * Writes `pattern.voiceRef` and nothing else. In particular not the global
 * `activeVariants` map: that is the instrument-wide default shared by every
 * pattern without an explicit ref, and setting it here would silently retune all
 * of them.
 *
 * Nothing becomes audible as a side effect — see point 3 above.
 */
function selectPatternVoice(patternId: string, ref: UserVariantRef | null): Result {
  const pattern = editingPatternById(patternId);
  if (!pattern) return { ok: false, reason: describeVoiceRefusal('pattern', 'no-holder') };
  if (ref === null) {
    return {
      ok: false,
      reason:
        'A pattern’s voice cannot be cleared: with no voice of its own it plays the instrument’s active voice, which every other pattern without one plays too. Pick a voice instead.',
    };
  }
  // The pattern seam's own `Result`, not a fabricated one: it is the write that
  // could fail, and re-stating its answer would be this arm's second opinion.
  return setEditingPatternVoiceRef(ref);
}

/**
 * The TRACK arm of {@link selectVoice}. `null` clears the override and puts the
 * track back on the instrument's global active variant.
 *
 * Refused rather than coerced when the ref is not one this track could be offered
 * — a variant that has been deleted, or one belonging to another instrument, which
 * would resolve to a preset for a neck the track has not got. Membership is asked
 * of {@link listSelectableVoices}, so the picker's offer set and the write can
 * never disagree; the agent reaches the same guard by calling this with a ref of
 * its own.
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
function selectTrackVoice(trackId: string, ref: UserVariantRef | null): Result {
  const track = findTrack(trackId);
  // Through {@link describeVoiceRefusal} rather than a sentence of its own: this is
  // the same `no-holder` state `saveVoice` and `deleteVoice` refuse on this arm, and
  // two authorings of it is two vocabularies reaching the agent from one seam.
  if (!track) return { ok: false, reason: describeVoiceRefusal('track', 'no-holder') };
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

/**
 * Overwrite the variant a pattern or a track points at with `preset`.
 *
 * `no-voice` is the real guard, not a mirror of a disabled button: a holder with no
 * ref is playing whatever the lib's resolver falls through to, and `useVoiceStore`
 * has only `updateVariant`, which addresses a user variant by id. A UI that let
 * that through would look like it saved and lose the edit on the next reload.
 * Save-as is the way out, and it is what the surfaces say.
 *
 * Remember that a variant is SHARED: this changes the voice for every pattern AND
 * every track pointing at the same ref, which is intended and is why both
 * surfaces say so before the button is pressed. There is deliberately no
 * per-holder fork.
 *
 * Takes the preset rather than reading the holder's draft: `voiceDrafts` imports
 * this module, so reading it from here would be a cycle. The caller passes
 * `voicePreset(kind, id)`.
 *
 * The arms differ only in WHOSE ref and instrument they resolve — the three guards
 * in {@link writeVariant} are the whole of Save's semantics and are shared, so
 * there is one authoring of them to drift from.
 */
export function saveVoice(kind: HolderKind, id: string, preset: VoicePreset): VoiceWriteResult {
  if (kind === 'track') {
    const track = findTrack(id);
    if (!track) return refuse('no-holder');
    return writeVariant(readTrackVoiceRef(track), trackInstrumentId(track), preset);
  }
  const pattern = editingPatternById(id);
  if (!pattern) return refuse('no-holder');
  return writeVariant(readVoiceRef(pattern), patternInstrumentId(pattern), preset);
}

/**
 * Overwrite the variant a ref names — the shared core of {@link saveVoice}'s two
 * arms.
 *
 * The arms differ only in WHOSE ref and instrument they resolve. Shared rather
 * than copied because these three guards are the whole of Save's semantics, and a
 * second copy of them is a second place to drift from the rule the buttons are
 * disabled by.
 */
function writeVariant(
  ref: UserVariantRef | null,
  instrumentId: FretInstrumentId,
  preset: VoicePreset,
): VoiceWriteResult {
  if (!ref) return refuse('no-voice');

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
 * Copy `preset` into a new user variant and point the holder at it.
 *
 * The repoint is the whole point: without it the holder keeps playing whatever the
 * copy was taken from, and the saved variant sits in the library unused. It is
 * also the half that differs between the arms — everything before it is the same
 * mint through {@link addUserVariant}, and folders are a later slice either way,
 * so the variant lands at the root.
 */
export function saveVoiceAs(
  kind: HolderKind,
  id: string,
  name: string,
  preset: VoicePreset,
): VoiceWriteResult {
  const trimmed = name.trim();

  if (kind === 'track') {
    const track = findTrack(id);
    if (!track) return refuse('no-holder');
    if (!trimmed) return refuse('empty-name');

    const variantId = addUserVariant(trimmed, trackInstrumentId(track), preset);
    if (!variantId) return refuse('capped');

    // The variant was just minted FOR this track's instrument, so the membership
    // half of the track arm cannot refuse it; the only reachable refusal left is
    // the track having gone, which this synchronous stretch makes impossible. The
    // guard stands anyway, and the variant is deliberately NOT rolled back if it
    // ever fires — a voice the user has named is not garbage, and it is now in the
    // library where they can point anything at it.
    const pointed = selectVoice('track', id, { kind: 'user', id: variantId });
    // Reported as the only refusal that could still be true rather than collapsing
    // three into one: the track arm also refuses `deleted` and `wrong-instrument`,
    // and printing "that track is no longer in this composition" for either would
    // be a confidently wrong sentence the day `voiceStatusOf` changes.
    if (!pointed.ok) {
      return refuse(findTrack(id) ? 'unknown-variant' : 'no-holder');
    }
    return { ok: true, id: variantId };
  }

  const pattern = editingPatternById(id);
  if (!pattern) return refuse('no-holder');
  if (!trimmed) return refuse('empty-name');

  const variantId = addUserVariant(trimmed, patternInstrumentId(pattern), preset);
  // `addVariant` returns '' when the tier gate refuses; it has already opened its
  // own signup/upgrade prompt, so there is nothing for us to report but the refusal.
  if (!variantId) return refuse('capped');

  // No result to weigh: the pattern arm refuses only a holder that is not open and
  // a null ref, and the line above has just ruled out both.
  selectVoice('pattern', id, { kind: 'user', id: variantId });
  return { ok: true, id: variantId };
}

/**
 * Copy a preset into a new user variant and return its id, or '' when the lib's
 * tier gate refuses.
 *
 * The COPY only — pointing something at the result is the caller's, and it is
 * the whole difference between {@link saveVoiceAs}'s two arms. Folders are a
 * later slice, so the variant lands at the root; `collectionId` has to be passed
 * regardless, because the lib's `addVariant` takes the whole record minus its
 * generated fields.
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
 * The user variant a {@link voiceKey} names — the bridge between the READ path
 * and the WRITE path.
 *
 * Everything that offers a voice hands out keys (`listSelectableVoices`,
 * `voiceKey`) and {@link selectVoice} takes a ref, but {@link renameVoice} and
 * {@link deleteVoice} take a bare VARIANT ID. A caller holding only keys would
 * otherwise strip the prefix itself, and `key.split(':')[1]` reads the tail of
 * ANY key as a variant id — including a `default:<slotId>` one left over in
 * storage, which would then address a variant that never existed.
 *
 * Kept as a function rather than inlined for the reason the parse itself is: the
 * key format has one authoring, and a caller that re-derives it is a second one.
 */
export function variantIdFromKey(
  key: string,
): { readonly ok: true; readonly id: string } | { readonly ok: false; readonly reason: VoiceRefusal } {
  const ref = parseVoiceKey(key);
  if (!ref) return { ok: false, reason: 'unknown-variant' };
  return { ok: true, id: ref.id };
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
 * Delete a user variant AND repair the holder that pointed at it — one act.
 *
 * ⚠ TWO REPAIRS, NOT ONE, and this is the function where flattening them would be
 * silent. The lib's `deleteVariant` repoints the global `activeVariants` map off
 * the deleted id and knows nothing about documents, so a dangling ref is left in
 * whatever pointed at the variant. Left alone it would resolve — silently, by
 * design — to the instrument's default, with the surface showing nothing selected
 * while the holder still played.
 *
 *   - The EDITING PATTERN's ref is repaired on BOTH arms, in
 *     {@link destroyVariant}. It is not the track arm's business who else
 *     pointed at the variant, but a delete made from a composition while a
 *     pattern is open leaves that pattern dangling just the same, and that is
 *     what the pre-merge `deleteTrackVoice` did by calling `deleteVoice`.
 *   - The TRACK's own ref is repaired on the track arm only, through
 *     {@link selectVoice}, which is the only way to write it.
 *
 * Only the named holder is repaired, on either arm: other patterns and other
 * tracks can hold the same ref and there is no bulk write to fix them with
 * (LIB-GAP(1) is the same missing primitive). They fall back cleanly, which is
 * the lib's own answer.
 */
export function deleteVoice(kind: HolderKind, id: string, variantId: string): VoiceWriteResult {
  if (kind === 'track') {
    const track = findTrack(id);
    if (!track) return refuse('no-holder');

    const deleted = destroyVariant(variantId);
    // `unknown-variant` is the ONLY refusal `destroyVariant` has, and it means the
    // variant is already gone — this track's ref is the dangling remains of it, so
    // the repair below still has to happen. Anything else left the library
    // untouched and the ref is still good.
    if (!deleted.ok && deleted.reason !== 'unknown-variant') return deleted;

    const ref = readTrackVoiceRef(track);
    if (ref?.id === variantId) {
      const repaired = selectVoice('track', id, null);
      if (!repaired.ok) return refuse('no-holder');
    }
    return { ok: true, id: variantId };
  }

  if (!editingPatternById(id)) return refuse('no-holder');
  return destroyVariant(variantId);
}

/**
 * Destroy the variant and repair the editing PATTERN's ref — the half both arms
 * of {@link deleteVoice} run.
 *
 * The pattern repair goes straight to `setEditingPatternVoiceRef` rather than
 * through {@link selectVoice}: the pattern arm of that one refuses `null` on
 * purpose, because clearing a ref is not a choice a picker gets to make. Clearing
 * a ref whose variant has just ceased to exist is a different act — there is
 * nothing left to point at.
 */
function destroyVariant(variantId: string): VoiceWriteResult {
  if (!store().variants.some((variant) => variant.id === variantId)) {
    return refuse('unknown-variant');
  }
  store().deleteVariant(variantId);

  const pattern = getEditingPattern();
  const ref = pattern ? readVoiceRef(pattern) : null;
  if (ref?.id === variantId) setEditingPatternVoiceRef(null);

  return { ok: true, id: variantId };
}
