/**
 * The shape of a command, and the pure half of filling one in.
 *
 * The catalog is DATA — the same decision as `voice/paramSchema.ts`, and made
 * again for the same payoff: adding a capability to the agent is a row in a
 * table, not a better prompt, and a table is the only thing a tripwire test can
 * walk. Nothing here imports React, the seams or the lib; the live half — what
 * a slot's values actually ARE right now — is `./slotSources`.
 *
 * ── Why slots are typed and not a text box ──────────────────────────────────
 *
 * The stated reason for prebaked commands is bounding misuse. The larger payoff
 * is that a slot BINDS TO REAL STATE: a track slot offers the tracks that exist,
 * so it cannot name one that does not. The same constraint that stops misuse
 * stops hallucination.
 *
 * That is why there are two list-shaped slot kinds and they are not
 * interchangeable:
 *
 *   - {@link ChoiceSlot} carries NO list. It names a {@link ChoiceSource}, and
 *     `slotSources` asks the seams for the values. A groove slot cannot drift
 *     from `GROOVE_PRESETS` because it never held a copy of it.
 *   - {@link EnumSlot} carries an authored list, and is legitimate ONLY where
 *     the lib has no type for the thing — "busier"/"sparser" is a direction of
 *     travel, not a value the lib models. Using one where a lib vocabulary
 *     exists is the defect `CommandCatalog.test.ts` fails on.
 *
 * ── What reaches the model ──────────────────────────────────────────────────
 *
 * {@link fillCommand} substitutes the slot's VALUE, never the label the user
 * saw. A groove slot emits `shuffle`; a track slot emits the track's id. Two
 * consequences, both wanted:
 *
 *   - the agent is handed vocabulary the tools' schemas will actually accept,
 *     rather than a word ("heavy swing") that no preset answers to;
 *   - the filled string is a pure function of the command and the values, so
 *     the same choices produce the same input on a different day with a
 *     differently-named track. Reproducibility is the thing paraphrased prose
 *     cannot give you, and it is lost the moment a display name is inlined.
 */

// ------------------------------------------------------------------ slots ---

export type CommandPage = 'pattern' | 'composition';

/**
 * Where a {@link ChoiceSlot}'s values come from. Every one of these is resolved
 * by `slotSources` through a seam — `compositionService.getTracks`,
 * `patternService.listGrooves`, and so on. The union exists so a source with no
 * resolver is a type error rather than an empty picker.
 *
 * `subdivision` is a rhythmic grid in ticks, derived from the seam's `PPQ`. It
 * is a choice and not an enum because writing `240` beside a label would be a
 * hardcoded copy of a lib constant — the exact thing this file separates.
 *
 * There is ONE `instrument` source, not one per seam. A `track-instrument`
 * member existed briefly and was deleted unused: `listInstruments` and
 * `listTrackInstruments` read the same lib catalog, so the split bought a second
 * resolver branch and no behaviour. If the two catalogs ever diverge, the member
 * comes back WITH the command that needs it.
 */
export type ChoiceSource =
  | 'track'
  | 'pattern'
  | 'instrument'
  | 'groove'
  | 'scale'
  | 'key'
  | 'subdivision';

/**
 * Which piece of live state seeds a slot before the user touches it.
 *
 * A token rather than a function on the row, because the row is data that has to
 * stay readable and comparable; `slotSources` owns the one switch that turns
 * these into reads. A default that does not resolve — no composition open, a
 * groove the lib calls `'custom'` — falls back to the slot's own fallback, so a
 * command is always fillable.
 */
export type DefaultSource =
  | 'selected-track'
  | 'editing-pattern-instrument'
  | 'pattern-groove'
  | 'composition-groove'
  | 'pattern-key'
  | 'composition-key'
  | 'pattern-scale'
  | 'composition-scale'
  | 'pattern-bpm'
  | 'composition-bpm'
  | 'composition-bars';

export interface SlotOption {
  /** What {@link fillCommand} substitutes. A lib id, never a display string. */
  readonly value: string;
  readonly label: string;
  /** Secondary text for a picker — an instrument, a swing amount. */
  readonly hint?: string;
}

interface SlotCommon {
  /** The `{id}` the template substitutes. */
  readonly id: string;
  readonly label: string;
  /** One line under the control, when the label alone is not enough. */
  readonly help?: string;
}

export interface ChoiceSlot extends SlotCommon {
  readonly kind: 'choice';
  readonly source: ChoiceSource;
  /** Omitted means "the first value the source offers". */
  readonly defaultFrom?: DefaultSource;
}

/**
 * An authored list. Allowed ONLY where the lib models nothing — see the header.
 * `fallback` is what the slot holds when nothing better is known, and must be
 * one of `options`.
 */
export interface EnumSlot extends SlotCommon {
  readonly kind: 'enum';
  readonly options: readonly SlotOption[];
  readonly fallback: string;
}

export interface NumberSlot extends SlotCommon {
  readonly kind: 'number';
  readonly min: number;
  readonly max: number;
  /** `1` also means "whole numbers only" to {@link fillCommand}. */
  readonly step: number;
  readonly unit?: string;
  readonly fallback: number;
  readonly defaultFrom?: DefaultSource;
}

export type Slot = ChoiceSlot | EnumSlot | NumberSlot;

export type SlotValue = string | number;

// --------------------------------------------------------------- commands ---

export interface Command {
  readonly id: string;
  /** Which page offers it. The two catalogs are disjoint by construction — a
   *  pattern command has no composition to act on and vice versa. */
  readonly page: CommandPage;
  /** What the button says. */
  readonly label: string;
  /** One sentence for the panel, describing the OUTCOME rather than the steps. */
  readonly summary: string;
  readonly slots: readonly Slot[];
  /**
   * The tools this command expects the agent to reach for, by name.
   *
   * NOT enforcement — the model still chooses, and a run that finds a better
   * route is not a bug. It is what makes the tripwire possible (every name here
   * must exist in AG-04's registry, so a renamed tool fails a test instead of a
   * run) and it documents which capability the row is actually about.
   */
  readonly tools: readonly string[];
  /** The instruction, with `{slotId}` where a slot's value goes. */
  readonly template: string;
}

// ------------------------------------------------------------------- fill ---

export type FillResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

/** Every `{slot}` a template mentions, in order, deduplicated. */
export function templateSlotIds(template: string): readonly string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1]))];
}

/** The values a template will accept, as a lookup. Exported for the panel, which
 *  has to know which slot a validation failure belongs to. */
export function findSlot(command: Command, slotId: string): Slot | undefined {
  return command.slots.find((slot) => slot.id === slotId);
}

function checkNumber(slot: NumberSlot, value: SlotValue): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `${slot.label} needs a number.`;
  }
  if (value < slot.min || value > slot.max) {
    return `${slot.label} has to be between ${slot.min} and ${slot.max}.`;
  }
  // Only the whole-number case is checked. A fractional step is a UI stride, and
  // rejecting 0.30000000000000004 for failing a modulo is a worse bug than
  // accepting a value between two stops.
  if (slot.step === 1 && !Number.isInteger(value)) return `${slot.label} has to be a whole number.`;
  return null;
}

/**
 * Render a command into the string the agent receives.
 *
 * Pure and total: the same `command` and the same `values` give the same string,
 * whatever the app currently holds. That is deliberate — see the header — and it
 * is why `allowed` is a PARAMETER rather than a live read: a replay of a saved
 * run has to render the same text months later, when the tracks it named are
 * gone.
 *
 * ⚠ `allowed` is therefore OPTIONAL, and omitting it turns the anti-hallucination
 * check off. Nothing running against the live app should call this directly —
 * `slotSources.fillForNow` is the same function with `allowedValues` already
 * composed in, and is what a panel is meant to reach for. This one is for tests
 * and for replay.
 */
export function fillCommand(
  command: Command,
  values: Readonly<Record<string, SlotValue>>,
  allowed?: Readonly<Record<string, readonly string[]>>,
): FillResult {
  for (const key of Object.keys(values)) {
    // The same rule the tools' schemas enforce with `additionalProperties: false`,
    // for the same reason: a misspelt slot that is silently ignored leaves the
    // caller believing it set something.
    if (!findSlot(command, key)) return { ok: false, reason: `${command.id} has no slot "${key}".` };
  }

  for (const slot of command.slots) {
    const value = values[slot.id];
    if (value === undefined) return { ok: false, reason: `${slot.label} has no value.` };

    if (slot.kind === 'number') {
      const problem = checkNumber(slot, value);
      if (problem) return { ok: false, reason: problem };
      continue;
    }

    if (typeof value !== 'string' || value === '') {
      return { ok: false, reason: `${slot.label} has no value.` };
    }
    if (slot.kind === 'enum' && !slot.options.some((option) => option.value === value)) {
      return { ok: false, reason: `${value} is not one of ${slot.label}'s options.` };
    }
    const live = allowed?.[slot.id];
    if (live && !live.includes(value)) {
      // The anti-hallucination property, stated: a track slot cannot carry a
      // track that is not there. Worth a refusal rather than a silent pass,
      // because the agent would otherwise spend a whole run on a dead id.
      return { ok: false, reason: `${slot.label} no longer offers "${value}".` };
    }
  }

  return {
    ok: true,
    value: command.template.replace(PLACEHOLDER, (_match, id: string) => String(values[id])),
  };
}
