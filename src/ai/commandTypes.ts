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
 * The composition page's arrangement modes, as the catalog needs to name them.
 *
 * ⚠ THIS IS A SECOND SPELLING OF `ArrangementMode` (`composition/arrangementMath`),
 * and it is deliberate rather than an oversight. `AgentTools.test.ts`'s tripwire
 * holds every module under `src/ai` to an ALLOW-LIST of imports — the four seams
 * and siblings, nothing else — and it reads specifiers, so `import type` does
 * not exempt anything. `arrangementMath` is not a seam, so the agent layer may
 * not reach it even for a type. That rule is worth more than the import: it is
 * what stops this layer growing a path to the lib.
 *
 * The single-source alternative was considered and REJECTED: `compositionService`
 * is on the allow-list, so re-exporting `ArrangementMode` from it would satisfy
 * the tripwire. But the seam does not use the type for anything of its own, so
 * the re-export would exist solely to launder a forbidden import — which turns
 * every seam into a hatch for arbitrary types from non-seam modules and costs
 * the tripwire its meaning. A pinned copy is the cheaper price.
 *
 * The copy is therefore PINNED rather than trusted. `CommandCatalog.test.ts`
 * asserts the two unions are mutually assignable, so drift in either direction
 * is a compile error in the test rather than a mode with no commands.
 */
export type CommandMode = 'pattern' | 'edit' | 'voice';

/**
 * WHICH PIPELINE RUNS THE ROW — a third question, and not a third `page`.
 *
 * `page` picks the agent, the tool set and the history a run brackets against;
 * `mode` picks which rows are OFFERED (see {@link Command.mode}). Neither can
 * answer this one, because the two routes are not two agents doing the same
 * thing differently — they are different in what they PRODUCE:
 *
 *   - `'single-run'` is one tool-using run against the OPEN document. The agent
 *     reads it, writes into it, and every write is bracketed so a cancel can put
 *     it back. This is what every row did before there was a field to declare,
 *     and it is what a row that declares nothing still does.
 *   - `'ir-job'` is `irCompositionJob`: a tool-free chart run, a tool-free run
 *     per part, then one `patternService.importIR`. ⚠ IT CREATES A NEW
 *     COMPOSITION and never touches the open one, so there is no partial edit to
 *     roll back and nothing to bracket — the panel's own header spells out what
 *     that changes about a cancel.
 *
 * Two consequences a row author has to know about:
 *
 *   - ⚠ AN `'ir-job'` ROW NAMES NO TOOLS, and that is load-bearing rather than
 *     tidy. The harness sends `outputSchema` to the backend for grammar-enforced
 *     decoding ONLY on turns where no tool is offered; register one and the
 *     structured answer degrades to a `JSON.parse` of the whole reply with no
 *     fence stripping, which is no answer at all. Both runs in the job are
 *     tool-free for that reason (`arrangementChart`, `irTrackRun`), so there is
 *     no tool for the row to name. `CommandCatalog.test.ts` holds each route to
 *     its own bar.
 *   - ⚠ THE TEMPLATE IS READ BY A DIFFERENT READER. `fillCommand` still
 *     substitutes slots the same way, but the filled text goes to the CHART run,
 *     which has no tools, no document in front of it and one product:
 *     `{bars, bpm, tracks, chords}`. A build order — "read the composition, open
 *     a blank pattern, stamp the notes" — instructs nobody there.
 *
 * Omitted means `'single-run'`. That is deliberate rather than lazy: the default
 * is the behaviour every row had before this field existed, so adding the field
 * changed no row that did not opt in.
 */
export type CommandRoute = 'single-run' | 'ir-job';

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
 *
 * `composition-groove` currently has a resolver and NO row using it: the backing
 * track was the one that did, and its groove slot went when that row moved to
 * the `'ir-job'` route — a groove is a playback setting the import pipeline has
 * no field for (see the row's own note). Kept rather than deleted because the
 * resolver is correct and a composition row wanting a groove is an ordinary
 * thing to add; it is named here so the next reader knows it is unused on
 * purpose.
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
  /**
   * Which arrangement mode offers it — the composition page's `ArrangementMode`,
   * spelled locally as {@link CommandMode} for the reason given there. Omitted
   * means every mode.
   *
   * ⚠ THE STANDING RULE, and the whole reason this is a second field rather
   * than a third `page`: **`page` picks the agent, the tool set and which
   * history the run brackets against; `mode` only picks which commands are
   * OFFERED.** They answer different questions and collapsing them loses one.
   *
   * The case that forces the split is edit mode, which has no rows of its own
   * and needs none. `openPlacementForEditing` aims the lib's single
   * pattern-editing pointer at the block (`compositionService.ts`) and
   * `patternService.writePatternBack` routes writes to that placement's
   * `patternSnapshot` while `editingPlacementId` is set, so the six
   * `page: 'pattern'` rows act on the block being edited, unchanged. They drive
   * `patternService`, so they stay `page: 'pattern'` — and the composition
   * page's panel renders them in edit mode by asking for the PATTERN page's
   * list. Re-tagging them `page: 'composition'` would point them at the wrong
   * agent, the wrong tools and the wrong history to undo.
   *
   * Only the composition page has modes; the pattern page passes none, and a
   * caller that passes none gets everything that page offers.
   */
  readonly mode?: CommandMode;
  /**
   * Which pipeline runs it — see {@link CommandRoute}, which carries the whole
   * of why this is a field of its own. Omitted means `'single-run'`, so a row
   * that says nothing behaves exactly as it did before the field existed.
   */
  readonly route?: CommandRoute;
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
   *
   * ⚠ EMPTY, AND REQUIRED TO BE EMPTY, ON AN `'ir-job'` ROW. Nothing in that
   * pipeline is offered a tool — the reason is in {@link CommandRoute} and it is
   * the harness's, not a preference — so a name here would describe a capability
   * the run cannot reach. A `single-run` row must name at least one; both bars
   * are held in `CommandCatalog.test.ts`.
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
