/**
 * What a slot's values ARE, right now.
 *
 * `commandTypes` says a slot is a `groove`; this says the grooves are the four
 * the lib ships, and that the one already on the composition is the one to open
 * on. Split in two so the catalog stays pure data that a test can walk without
 * a store, and so there is exactly ONE place that reads live state.
 *
 * ⚠ Every read below goes through a seam — `patternService`,
 * `compositionService` — and never through `usePatternsStore` or the lib. Not
 * house style for its own sake: `listGrooves` and `listInstruments` exist on the
 * seams precisely because those catalogs grow on the lib side, and a slot that
 * held its own copy would silently stop offering whatever was added next while
 * still type-checking. The command catalog's whole claim is that its values are
 * ones the tools will accept; a hardcoded list is that claim quietly failing.
 *
 * A default that cannot be resolved is not an error. Nothing is open when the
 * app starts, and a command whose slots refuse to fill until a composition
 * exists is a command nobody can use to CREATE one. Every default therefore
 * falls back — to the lib's own default where there is one, to the first offered
 * value otherwise — and `ResolvedSlot.unavailable` carries the reason the list
 * is empty when it genuinely is.
 */
import {
  DEFAULT_SCALE_ID,
  PPQ,
  getEditingPattern,
  getLibraryPatterns,
  listGrooves,
  listInstruments,
  listKeys,
  listScales,
  patternGrooveId,
  patternInstrumentId,
} from '../patterns/patternService';
import {
  compositionGrooveId,
  getEditingComposition,
  getSelectedTrackId,
  getTracks,
  ticksPerBar,
  totalDurationTicks,
  trackInstrumentId,
} from '../composition/compositionService';
import {
  fillCommand,
  type ChoiceSlot,
  type Command,
  type DefaultSource,
  type FillResult,
  type Slot,
  type SlotOption,
  type SlotValue,
} from './commandTypes';

// ---------------------------------------------------------------- options ---

/**
 * The rhythmic grids "fix the timing" can snap to, in TICKS.
 *
 * Derived from the seam's `PPQ` rather than written out, so this is a choice
 * source and not an authored enum: `240` beside the label "Eighth notes" is a
 * copy of a lib constant, and copies are what this module exists to avoid.
 *
 * ⚠ This is deliberately NOT `timeline/timelineMath.snapOptions`, which is the
 * editor's own snap vocabulary and is richer — it carries Bar, 1/32, 1/16T and
 * Off. Bar depends on a time signature this module is not given; Off means "do
 * not snap", which is not a grid an instruction can name; and 1/32 and 1/16T are
 * finer than any quantise pass should be reaching for unasked. The two lists are
 * allowed to differ because they answer different questions, but neither may
 * hold a hand-typed tick count, which is why both derive from `PPQ`.
 *
 * Ordered FINEST FIRST. A choice slot with no live default opens on `options[0]`
 * (see `fallbackOption`), and "Fix the timing" pressed as it opens must land on
 * the grid that destroys the least — quantising a sixteenth-note riff to quarter
 * notes because that happened to be first in the list is the worst default of
 * the four.
 */
function subdivisionOptions(): readonly SlotOption[] {
  return [
    { value: String(PPQ / 4), label: 'Sixteenth notes' },
    { value: String(PPQ / 3), label: 'Eighth triplets' },
    { value: String(PPQ / 2), label: 'Eighth notes' },
    { value: String(PPQ), label: 'Quarter notes' },
  ].map((option) => ({ ...option, hint: `${option.value} ticks` }));
}

/** An instrument's display name, for a hint. Read through the seam's catalog so
 *  a hint says "Guitar" where a label says "Guitar" — a picker that shows the
 *  raw id in one column and the name in the next looks like two things. */
function instrumentName(instrumentId: string): string {
  return listInstruments().find((instrument) => instrument.id === instrumentId)?.name ?? instrumentId;
}

/** Why a choice slot has nothing to offer, or null when it does. Separate from
 *  the options so a panel can say "no tracks yet" rather than showing a picker
 *  that opens onto nothing. */
function emptinessOf(source: ChoiceSlot['source']): string | null {
  switch (source) {
    case 'track':
      return getEditingComposition() ? 'This composition has no tracks.' : 'No composition is open.';
    case 'pattern':
      return 'The pattern library is empty — nothing has been saved yet.';
    default:
      // The rest are lib catalogs. They are never empty, and claiming otherwise
      // would hide a broken import behind a friendly sentence.
      return null;
  }
}

export function slotOptions(slot: Slot): readonly SlotOption[] {
  if (slot.kind === 'enum') return slot.options;
  if (slot.kind === 'number') return [];
  switch (slot.source) {
    case 'track':
      return getTracks().map((track) => ({
        value: track.id,
        label: track.name,
        hint: instrumentName(trackInstrumentId(track)),
      }));
    case 'pattern':
      return getLibraryPatterns().map((pattern) => ({
        value: pattern.id,
        label: pattern.name,
        hint: instrumentName(pattern.instrumentId),
      }));
    case 'instrument':
      return listInstruments().map((instrument) => ({
        value: instrument.id,
        label: instrument.name,
      }));
    case 'groove':
      return listGrooves().map((groove) => ({ value: groove.id, label: groove.name }));
    case 'scale':
      return listScales().map((scale) => ({ value: scale.id, label: scale.name }));
    case 'key':
      return listKeys().map((key) => ({ value: key, label: key }));
    case 'subdivision':
      return subdivisionOptions();
  }
}

// --------------------------------------------------------------- defaults ---

/**
 * The composition's key, which the `Composition` model does not have a field
 * for.
 *
 * Two places carry one and both are read, nearest-thing-first: the authored
 * harmonic-context layer (`harmonicContext[*].scale`, the lib's own "what
 * everyone is thinking" track) and failing that the first placed block whose
 * pattern snapshot declares a key. The second is worth the few lines — nothing
 * in this app authors a harmonic context yet, so the first is almost always
 * absent, and a Key picker that always opens on C when the arrangement is
 * plainly in A minor is the kind of default that trains people to distrust
 * defaults.
 *
 * Read off the object the SEAM returns, not out of the store.
 */
function compositionHarmony(): { root: string | null; type: string | null } {
  const composition = getEditingComposition();
  if (!composition) return { root: null, type: null };

  const authored = composition.harmonicContext?.find((block) => block.scale)?.scale;
  if (authored) return { root: authored.root, type: authored.type };

  for (const track of composition.tracks) {
    for (const placement of track.placements) {
      const snapshot = placement.patternSnapshot;
      if (snapshot.key) return { root: snapshot.key, type: snapshot.scaleType };
    }
  }
  return { root: null, type: null };
}

/** The arrangement's current length in bars, rounded up — "extend by" wants a
 *  number of the same order as what is already there. The conversion is the
 *  lib's `ticksPerBar` through the seam, not `(PPQ * 4 * n) / d` written out
 *  here: 6/8 is a three-quarter bar, not a six-quarter one, and that is exactly
 *  the sort of thing a second copy of the formula gets wrong later. */
function compositionBars(): number | null {
  const composition = getEditingComposition();
  if (!composition) return null;
  const perBar = ticksPerBar(composition.timeSignature);
  if (!Number.isFinite(perBar) || perBar <= 0) return null;
  const bars = Math.ceil(totalDurationTicks() / perBar);
  return bars > 0 ? bars : null;
}

function fromLiveState(source: DefaultSource): SlotValue | null {
  switch (source) {
    case 'selected-track':
      return getSelectedTrackId();
    case 'editing-pattern-instrument': {
      const pattern = getEditingPattern();
      return pattern ? patternInstrumentId(pattern) : null;
    }
    // `patternGrooveId`/`compositionGrooveId` answer `'custom'` for a spec that
    // matches no named preset — a document made elsewhere can hold one. That is
    // not an offered value, so it fails the membership check below and the slot
    // falls back, which is the right outcome: the picker cannot represent it.
    case 'pattern-groove':
      return patternGrooveId();
    case 'composition-groove':
      return compositionGrooveId();
    case 'pattern-key':
      return getEditingPattern()?.key ?? null;
    case 'pattern-scale':
      return getEditingPattern()?.scaleType ?? null;
    case 'composition-key':
      return compositionHarmony().root;
    case 'composition-scale':
      return compositionHarmony().type;
    case 'pattern-bpm':
      return getEditingPattern()?.suggestedBpm ?? null;
    case 'composition-bpm':
      return getEditingComposition()?.bpm ?? null;
    case 'composition-bars':
      return compositionBars();
  }
}

/** Where a choice slot lands when live state offered nothing usable. The lib's
 *  declared default beats array position wherever the lib declares one. */
function fallbackOption(slot: ChoiceSlot, options: readonly SlotOption[]): string {
  if (slot.source === 'scale') {
    const declared = options.find((option) => option.value === DEFAULT_SCALE_ID);
    if (declared) return declared.value;
  }
  return options[0]?.value ?? '';
}

// --------------------------------------------------------------- resolved ---

export interface ResolvedSlot {
  readonly slot: Slot;
  /** Empty for a number slot, and for a choice slot with nothing to offer. */
  readonly options: readonly SlotOption[];
  /** The default, already checked against `options`. */
  readonly value: SlotValue;
  /** Why `options` is empty, when that is a state rather than a bug. */
  readonly unavailable: string | null;
}

export interface ResolvedCommand {
  readonly command: Command;
  readonly slots: readonly ResolvedSlot[];
  /** The first reason a slot cannot be filled, or null. A command with one is
   *  still worth SHOWING — "no tracks yet" tells the user what to do — which is
   *  why it is a field and not an omission from the list. */
  readonly unavailable: string | null;
}

export function resolveSlot(slot: Slot): ResolvedSlot {
  const options = slotOptions(slot);

  if (slot.kind === 'number') {
    const live = slot.defaultFrom === undefined ? null : fromLiveState(slot.defaultFrom);
    const value =
      typeof live === 'number' && Number.isFinite(live)
        ? Math.min(slot.max, Math.max(slot.min, slot.step === 1 ? Math.round(live) : live))
        : slot.fallback;
    return { slot, options, value, unavailable: null };
  }

  // An enum has no live default and cannot have one: its list is authored
  // precisely because the app models nothing to read a default OUT of. It opens
  // on its own fallback, always.
  if (slot.kind === 'enum') {
    return { slot, options, value: slot.fallback, unavailable: null };
  }

  const live = slot.defaultFrom === undefined ? null : fromLiveState(slot.defaultFrom);
  const usable =
    typeof live === 'string' && options.some((option) => option.value === live) ? live : null;

  return {
    slot,
    options,
    value: usable ?? fallbackOption(slot, options),
    unavailable: options.length === 0 ? emptinessOf(slot.source) : null,
  };
}

export function resolveCommand(command: Command): ResolvedCommand {
  const slots = command.slots.map(resolveSlot);
  return {
    command,
    slots,
    unavailable: slots.find((slot) => slot.unavailable !== null)?.unavailable ?? null,
  };
}

/** The command's slots pre-filled from live state — what a panel opens on, and
 *  what `fillCommand` can be handed unchanged. */
export function defaultValues(command: Command): Record<string, SlotValue> {
  const values: Record<string, SlotValue> = {};
  for (const resolved of resolveCommand(command).slots) values[resolved.slot.id] = resolved.value;
  return values;
}

/**
 * The live option values per slot, for `fillCommand`'s `allowed` check.
 *
 * Number slots are SKIPPED rather than given an empty list: `slotOptions`
 * answers `[]` for a number, and `[]` reaching `fillCommand` would mean "this
 * slot offers nothing", refusing every tempo the user could possibly type. A
 * number is bounded by its own `min`/`max`, which `fillCommand` already checks.
 */
export function allowedValues(command: Command): Record<string, readonly string[]> {
  const allowed: Record<string, readonly string[]> = {};
  for (const slot of command.slots) {
    if (slot.kind === 'number') continue;
    allowed[slot.id] = slotOptions(slot).map((option) => option.value);
  }
  return allowed;
}

/**
 * Fill a command against the app AS IT IS RIGHT NOW — what a panel calls.
 *
 * `fillCommand`'s `allowed` argument is optional so that a replay can render an
 * old run's text without today's tracks, which also means a caller that forgets
 * it silently loses the anti-hallucination check. This is the one-argument form
 * that cannot forget: anything driving the live app calls this, and
 * `fillCommand` stays the pure function underneath it.
 */
export function fillForNow(
  command: Command,
  values: Readonly<Record<string, SlotValue>>,
): FillResult {
  return fillCommand(command, values, allowedValues(command));
}
