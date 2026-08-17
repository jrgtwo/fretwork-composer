import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHROMATIC_KEYS,
  DEFAULT_PATTERNS_STATE,
  DEFAULT_SCALE_ID,
  GROOVE_PRESETS,
  INSTRUMENTS,
  PPQ,
  SCALES,
  usePatternsStore,
} from '@fretwork/lib';
import { AGENT_TOOLS } from '../src/ai/tools';
import {
  COMMAND_CATALOG,
  commandsForPage,
  findCommand,
} from '../src/ai/commandCatalog';
import {
  fillCommand,
  findSlot,
  templateSlotIds,
  type ChoiceSource,
  type Command,
  type CommandMode,
  type Slot,
  type SlotValue,
} from '../src/ai/commandTypes';
import { SUB_RUN_TOOL_NAMES, patternRunInput } from '../src/ai/patternSubRun';
import type { PatternBrief } from '../src/ai/patternSubRun';
import {
  allowedValues,
  defaultValues,
  fillForNow,
  resolveCommand,
  resolveSlot,
  slotOptions,
} from '../src/ai/slotSources';
import {
  chordGrip,
  clearHistory as clearPatternHistory,
  openBlankPattern,
  setEditingPatternInstrument,
  setPatternBpm,
  setPatternGroove,
  stampNote,
} from '../src/patterns/patternService';
import { ARRANGEMENT_MODES, type ArrangementMode } from '../src/composition/arrangementMath';
import {
  addPlacement,
  addTrack,
  clearHistory as clearCompositionHistory,
  getTracks,
  openBlankComposition,
  removeTrack,
  selectTrack,
  setCompositionBpm,
  setCompositionGroove,
  setCompositionTimeSignature,
  setTrackName,
  ticksPerBar,
  totalDurationTicks,
} from '../src/composition/compositionService';

/**
 * AG-05 — the command catalog.
 *
 * ⚠ THERE IS NO DOM IN THIS FILE, no model, no provider and no harness. The
 * catalog is data and the fill is a pure function, which is the whole reason
 * AG-06 (the panel) is a separate ticket: if this needed a browser to test, the
 * split would be in the wrong place.
 *
 * The store underneath is REAL, for `AgentTools.test.ts`'s reason — the claim
 * being checked is that a slot's values are the app's actual state, and a mock
 * would assert that away.
 *
 * The tests are organised around the four things that make a table safe to grow:
 *
 *   1. every command's slots resolve, and every slot the template mentions
 *      exists (and vice versa);
 *   2. every lib-derived slot's values come FROM the lib, not from a literal
 *      written beside it;
 *   3. every tool a command names exists in AG-04's registry;
 *   4. the same slot values always render the same string.
 *
 * `ADDED_COMMAND` at the bottom is the acceptance criterion "adding a command is
 * a row and nothing else", executed rather than asserted: it is a `Command`
 * literal declared in this file and run through the same invariants, with no
 * other change anywhere.
 */

// ------------------------------------------------------------------ setup ---

beforeEach(() => {
  sessionStorage.clear();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  clearPatternHistory();
  clearCompositionHistory();
});

/** A pattern in the library with one note in it, so it has a real length. */
function seedPattern(name: string): string {
  const opened = openBlankPattern(name);
  if (!opened.ok) throw new Error(opened.reason);
  const stamped = stampNote({ stringIndex: 0, fret: 5, tick: 0, durationTicks: PPQ });
  if (!stamped.ok) throw new Error(stamped.reason);
  return opened.value.id;
}

function seedComposition(name = 'Arrangement'): void {
  const opened = openBlankComposition(name);
  if (!opened.ok) throw new Error(opened.reason);
}

/**
 * `Pattern.key` / `Pattern.scaleType` are written through the STORE here, not
 * through the seam, because no seam writes them: nothing in this app authors a
 * key yet (`FretboardView` says as much). The slot binds to the field the lib
 * already models so that it works the day something does, and this is the only
 * way to stand that day up in a test today.
 */
function forceKeyOnPatterns(key: string | null, scaleType: string | null): void {
  usePatternsStore.setState((state) => ({
    library: {
      ...state.library,
      patterns: state.library.patterns.map((pattern) => ({ ...pattern, key, scaleType })),
    },
  }));
}

/** A composition with no tracks at all — see the track-slot test for why this
 *  cannot be reached through the seam and is still worth standing up. */
function forceTracklessComposition(): void {
  usePatternsStore.setState((state) => ({
    library: {
      ...state.library,
      compositions: state.library.compositions.map((composition) => ({
        ...composition,
        tracks: [],
      })),
    },
  }));
}

const TOOL_NAMES = new Set(AGENT_TOOLS.map((tool) => tool.name));

const LIB_VOCABULARIES: Readonly<Record<string, readonly string[]>> = {
  groove: GROOVE_PRESETS.map((preset) => preset.id),
  scale: SCALES.map((scale) => scale.id),
  key: [...CHROMATIC_KEYS],
  instrument: INSTRUMENTS.map((instrument) => instrument.id),
};

// ------------------------------------------------------------ invariants ---

/**
 * Everything that must be true of ANY row, existing or new. A function rather
 * than an inline block so `ADDED_COMMAND` is held to exactly the same bar as the
 * shipped catalog — which is the only way "adding a command is a row" can be
 * demonstrated rather than claimed.
 */
function assertCommandInvariants(command: Command): void {
  const where = `${command.id}:`;

  expect(command.label.trim().length).toBeGreaterThan(2);
  expect(command.summary.length).toBeGreaterThan(20);

  // ⚠ THE TOOL BAR IS THE ROUTE'S, NOT THE CATALOG'S, and the two are opposite.
  // A `single-run` row is driven by a tool-using agent, so naming no tool means
  // the row documents no capability. An `ir-job` row's two runs are TOOL-FREE by
  // construction — the harness only sends `outputSchema` to the backend on turns
  // where nothing is registered — so a name there describes something neither
  // run can reach, and the emptiness is the assertion.
  if (command.route === 'ir-job') expect(`${where} ${command.tools.length}`).toBe(`${where} 0`);
  else expect(command.tools.length).toBeGreaterThan(0);

  // 3. Every named tool exists. Not enforcement — the model still chooses — but
  //    a renamed tool now fails here instead of mid-run.
  for (const tool of command.tools) {
    const verdict = TOOL_NAMES.has(tool) ? 'is in the registry' : 'IS NOT A TOOL';
    expect(`${where} ${tool} ${verdict}`).toBe(`${where} ${tool} is in the registry`);
  }
  expect(new Set(command.tools).size).toBe(command.tools.length);

  // 1. Slots and template agree in both directions. A placeholder with no slot
  //    renders as literal `{foo}` to the model; a slot with no placeholder is a
  //    control the user can move that changes nothing.
  const slotIds = command.slots.map((slot) => slot.id);
  expect(new Set(slotIds).size).toBe(slotIds.length);
  for (const id of slotIds) expect(id).toMatch(/^[a-z][a-zA-Z0-9]*$/);
  expect([...templateSlotIds(command.template)].sort()).toEqual([...slotIds].sort());

  for (const slot of command.slots) {
    // (A `choice` slot carrying its own `options` used to be asserted here. It
    //  is an excess-property error on any typed literal, so the assertion could
    //  not fail; the check that CAN fail is the whole-list subset check below,
    //  which catches a lib vocabulary copied into this directory whatever shape
    //  it is in. Nothing in this suite reads a source file.)
    if (slot.kind === 'enum') {
      expect(slot.options.length).toBeGreaterThan(1);
      expect(slot.options.map((option) => option.value)).toContain(slot.fallback);
      expect(new Set(slot.options.map((o) => o.value)).size).toBe(slot.options.length);

      // 2. Behavioural half: an authored list may not BE a lib vocabulary.
      //    Subset rather than "no overlap", because a single word can honestly
      //    appear in both — `blues` is a genre and also a scale id — while a
      //    whole list that fits inside one is a copy of it.
      const values = slot.options.map((option) => option.value);
      for (const [catalog, vocabulary] of Object.entries(LIB_VOCABULARIES)) {
        const copied = values.every((value) => vocabulary.includes(value));
        const verdict = copied ? `duplicates the ${catalog} catalog` : 'is authored';
        expect(`${where} ${slot.id} ${verdict}`).toBe(`${where} ${slot.id} is authored`);
      }
    }
    if (slot.kind === 'number') {
      expect(slot.min).toBeLessThan(slot.max);
      expect(slot.fallback).toBeGreaterThanOrEqual(slot.min);
      expect(slot.fallback).toBeLessThanOrEqual(slot.max);
      expect(slot.step).toBeGreaterThan(0);
    }
  }

  // 1. Resolution: every slot produces a usable default, whatever is open.
  const resolved = resolveCommand(command);
  expect(resolved.slots).toHaveLength(command.slots.length);
  for (const entry of resolved.slots) {
    if (entry.slot.kind === 'number') {
      expect(typeof entry.value).toBe('number');
    } else if (entry.options.length > 0) {
      expect(entry.options.map((option) => option.value)).toContain(entry.value);
    } else {
      // The only legal empty list is one whose emptiness is a state of the app
      // and says so — no composition open, nothing in the library.
      expect(entry.unavailable).toBeTruthy();
    }
  }

  // 4. Filling with the resolved defaults produces text — unless a slot has
  //    nothing to offer, in which case the fill must REFUSE rather than render
  //    an empty blank into the prompt. "Add a harmony track" with no tracks is
  //    exactly that case, and a command that renders `doubles the track with id
  //    , 3 semitones above it` is the failure this whole design is against.
  const values = defaultValues(command);
  const filled = fillCommand(command, values);
  if (resolved.unavailable !== null) {
    expect(`${where} ${filled.ok ? 'rendered anyway' : 'refused'}`).toBe(`${where} refused`);
    return;
  }
  if (!filled.ok) throw new Error(`${where} ${filled.reason}`);
  expect(filled.value).not.toMatch(/\{[a-zA-Z]/);
  // Every slot's VALUE reached the text. Stronger than a length floor, which
  // substitution can only ever satisfy: this fails if a placeholder is dropped,
  // rendered as its label, or substituted with the wrong slot's value.
  for (const slot of command.slots) {
    expect(`${where} ${slot.id} ${filled.value.includes(String(values[slot.id]))}`).toBe(
      `${where} ${slot.id} true`,
    );
  }

  // The live form a panel will actually call — same text, and the
  // anti-hallucination check on by construction rather than by remembering an
  // argument. Number slots must survive it: `allowedValues` skipping them is
  // what stops `bpm` being handed an empty option list and refusing itself.
  expect(fillForNow(command, values)).toEqual(filled);
}

// -------------------------------------------------------------- the table ---

describe('the catalog', () => {
  it('gives every command a unique id and a page', () => {
    const ids = COMMAND_CATALOG.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(COMMAND_CATALOG.length).toBeGreaterThan(5);
    for (const command of COMMAND_CATALOG) {
      expect(findCommand(command.id)).toBe(command);
    }
    expect(findCommand('nothing-like-this')).toBeUndefined();
  });

  it('holds every row to the invariants, with nothing open', () => {
    // Deliberately run on a bare app: a catalog that only resolves once a
    // composition exists is a catalog you cannot use to make one.
    for (const command of COMMAND_CATALOG) assertCommandInvariants(command);
  });

  it('holds every row to the invariants with real state open', () => {
    seedPattern('Riff');
    seedComposition();
    expect(addTrack('Rhythm').ok).toBe(true);
    // Guards the guard: with a pattern, a composition and a track all present,
    // no slot may report itself unavailable, so every row really does go down
    // the FILLED branch of the invariant above rather than the refused one.
    for (const command of COMMAND_CATALOG) {
      expect(`${command.id}: ${resolveCommand(command).unavailable ?? 'fillable'}`).toBe(
        `${command.id}: fillable`,
      );
      assertCommandInvariants(command);
    }
  });
});

describe('page scoping', () => {
  it('splits the catalog with no overlap and no leftovers', () => {
    const pattern = commandsForPage('pattern');
    const composition = commandsForPage('composition');
    expect(pattern.length).toBeGreaterThan(0);
    expect(composition.length).toBeGreaterThan(0);
    expect(pattern.length + composition.length).toBe(COMMAND_CATALOG.length);
    const patternIds = new Set(pattern.map((command) => command.id));
    for (const command of composition) expect(patternIds.has(command.id)).toBe(false);
  });

  it('keeps composition-only slots and tools off the pattern page', () => {
    for (const command of commandsForPage('pattern')) {
      for (const slot of command.slots) {
        if (slot.kind !== 'choice') continue;
        // A pattern command has no composition in hand; a track picker on it
        // would resolve to whatever composition happened to be open elsewhere.
        expect(`${command.id}: ${slot.source}`).not.toMatch(/^.*: track$/);
      }
      for (const tool of command.tools) {
        expect(`${command.id}: ${tool}`).not.toMatch(/: composition_/);
      }
    }
  });

  it('lets composition commands reach the pattern tools, because they build patterns', () => {
    // The asymmetry is intentional and worth pinning: a composition command
    // writes patterns into the library and then places them. If this ever fails,
    // someone has "fixed" the leak check in the wrong direction.
    const buildsPatterns = commandsForPage('composition').filter((command) =>
      command.tools.includes('pattern_stamp_notes'),
    );
    expect(buildsPatterns.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------- route scoping ---

/**
 * WHICH PIPELINE A ROW DECLARES — the third scoping question, after `page` and
 * `mode`, and the one with a live example of each answer.
 *
 * Both routes are deliberately kept in service: the backing track builds a NEW
 * composition through `irCompositionJob`, and the other six composition rows
 * EDIT the open one, which that route cannot do. Keeping both is also what lets
 * them be compared on the same page, so "everything moved" would be a
 * regression here rather than a silent redesign.
 */
describe('the route a command declares', () => {
  const backingTrack = (): Command => {
    const command = findCommand('composition-backing-track');
    if (!command) throw new Error('missing command');
    return command;
  };

  it('sends the backing track through the IR job and leaves the others on the single run', () => {
    expect(backingTrack().route).toBe('ir-job');

    const others = commandsForPage('composition').filter(
      (command) => command.id !== 'composition-backing-track',
    );
    expect(others.length).toBeGreaterThan(0);
    for (const command of others) {
      // ⚠ The default is what carries "behaves exactly as today": a row that
      // declares nothing is a single run, and this is the line that fails if
      // someone flips that default rather than adding a field to a row.
      expect(`${command.id}: ${command.route ?? 'single-run'}`).toBe(`${command.id}: single-run`);
      expect(command.tools.length).toBeGreaterThan(0);
    }
  });

  it('still fills, into a request rather than a build order', () => {
    seedComposition();
    const command = backingTrack();
    const values = defaultValues(command);
    const filled = fillForNow(command, values);
    if (!filled.ok) throw new Error(filled.reason);

    // The slots that survived the rewrite, all substituted — against the
    // RESOLVED values, because `bpm` is read off the live composition and
    // hardcoding it here would pin the seed rather than the fill.
    expect(filled.value).toContain('blues');
    expect(filled.value).toContain(`${values.bars} bars`);
    expect(filled.value).toContain(`${values.bpm} bpm`);
    expect(filled.value).toContain(`${values.key} ${values.scale}`);
    expect(filled.value).not.toMatch(/\{[a-zA-Z]/);

    // ⚠ THE READER IS `ARRANGEMENT_CHART_AGENT`, which has no tools and no
    // document in front of it. A tool name here instructs nobody, and the old
    // template was nothing but tool names in order.
    for (const tool of TOOL_NAMES) {
      expect(`${tool}: ${filled.value.includes(tool)}`).toBe(`${tool}: false`);
    }
    expect(filled.value).not.toMatch(/read the composition|open a blank|stamp|place the pattern/i);
  });

  it('leaves every number the chart prompt or the app already owns out of the template', () => {
    // The RAW template, so the slot fills do not mask it: no digit at all. Bars
    // count from 1, a chord holds until the next one, the track cap is
    // `MAX_COMPOSITION_TRACKS` and the answer is one JSON object — every one of
    // those is stated by `ARRANGEMENT_CHART_PROMPT`, and a second copy here is a
    // contradiction waiting for one of the two to be edited.
    expect(backingTrack().template).not.toMatch(/[0-9]/);
    expect(backingTrack().template).not.toMatch(/json/i);
  });
});

// ----------------------------------------------------------- mode scoping ---

/**
 * The pin on `CommandMode`'s second spelling.
 *
 * `commandTypes` may not import `arrangementMath` — `AgentTools.test.ts`'s
 * tripwire holds `src/ai/**` to the seams and reads specifiers, so `import type`
 * buys no exemption — and the header there says as much. A TEST is under no such
 * rule, so the equivalence is checked here: this fails to COMPILE the moment the
 * grid gains a mode the catalog does not know, or the catalog invents one the
 * grid does not have. Either drift would otherwise show up as a rail that is
 * silently empty.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const MODE_UNIONS_MATCH: MutuallyAssignable<ArrangementMode, CommandMode> = true;

/**
 * The modes every test below walks — the grid's OWN runtime list, never a copy.
 *
 * This is the half of the pin that survives `vitest run`, which transpiles
 * without typechecking: a fourth mode added to `ARRANGEMENT_MODES` appears here
 * at runtime and the slices below index the catalog's table with a key it does
 * not have, so the suite fails whether or not `tsc -b` ran. The type above is
 * still what fails first, and fails in the right place; the two are not
 * redundant.
 */
const MODES: readonly ArrangementMode[] = ARRANGEMENT_MODES;

describe('mode scoping', () => {
  it('names the same modes the arrangement grid does', () => {
    expect(MODE_UNIONS_MATCH).toBe(true);
    // Every mode the grid has resolves to a real (frozen) slice rather than
    // `undefined` — the runtime half of the equivalence, and the assertion that
    // catches a mode the catalog was never told about.
    for (const mode of MODES) {
      for (const page of ['pattern', 'composition'] as const) {
        expect(`${page}/${mode}: ${Array.isArray(commandsForPage(page, mode))}`).toBe(
          `${page}/${mode}: true`,
        );
      }
    }
    expect(MODES.length).toBe(3);
  });

  it('gives every composition command a mode', () => {
    // The composition rail shows ONE mode at a time. An untagged row would show
    // in all three, which is how "the commands match what the mode is for"
    // quietly stops being true — so the tag is required rather than optional
    // for this page, and the failure names the row.
    //
    // Guarded against passing vacuously: an empty composition page would satisfy
    // "every row is tagged" without offering anything.
    expect(commandsForPage('composition').length).toBeGreaterThan(0);
    for (const command of commandsForPage('composition')) {
      expect(`${command.id}: ${command.mode ?? 'untagged'}`).not.toBe(`${command.id}: untagged`);
    }
  });

  it('leaves the pattern page untouched by modes', () => {
    // Two claims. The pattern page passes no mode, and its list is pinned
    // LITERALLY rather than by re-running `offered`'s own predicate, which would
    // move with any edit and could never fail. These are also what edit mode is
    // served by, so losing one is a hole in the composition page too.
    const pattern = commandsForPage('pattern');
    expect(pattern.map((c) => c.id)).toEqual([
      'pattern-fix-timing',
      'pattern-generate',
      'pattern-write-over-a-chord',
      'pattern-density',
      'pattern-fit-key',
      'pattern-articulations',
      'pattern-feel',
    ]);
    for (const command of pattern) expect(command.mode).toBeUndefined();
    // …and because none of them is tagged, asking for one anyway returns all of
    // them. That is the "no mode means every mode" rule, and it is what stops a
    // new untagged row from being invisible.
    for (const mode of MODES) {
      expect(commandsForPage('pattern', mode).map((c) => c.id)).toEqual(pattern.map((c) => c.id));
    }
  });

  it('offers each composition mode exactly the rows tagged for it', () => {
    expect(commandsForPage('composition', 'pattern').map((command) => command.id)).toEqual([
      'composition-backing-track',
      'composition-bass-line',
      'composition-harmony-track',
      'composition-extend',
      'composition-lay-down-pattern',
    ]);
    expect(commandsForPage('composition', 'voice').map((command) => command.id)).toEqual([
      'composition-balance-mix',
      'composition-track-tone',
    ]);
    // Empty ON PURPOSE, and this is the assertion most likely to be "fixed" by
    // someone re-tagging the six pattern rows as composition ones. Do not: they
    // drive `patternService`, and edit mode points the lib's pattern-editing
    // pointer at the block so they already act on it. `page` picks the agent,
    // the tools and the history; `mode` only picks what is offered.
    expect(commandsForPage('composition', 'edit')).toEqual([]);
  });

  it('accounts for every composition row across the modes, with no row in two', () => {
    const seen = MODES.flatMap((mode) => commandsForPage('composition', mode).map((c) => c.id));
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(new Set(commandsForPage('composition').map((c) => c.id)));
  });

  it('returns the same array identity for a given page and mode', () => {
    // The reason `BY_PAGE` exists at all — a fresh array per call is a new
    // identity every render, a `useMemo` dependency that never matches and a
    // list that rebuilds its children for nothing. Adding the mode axis had to
    // keep that, so identity is asserted per SLICE, not just per page.
    expect(commandsForPage('pattern')).toBe(commandsForPage('pattern'));
    expect(commandsForPage('composition')).toBe(commandsForPage('composition'));
    for (const page of ['pattern', 'composition'] as const) {
      for (const mode of MODES) {
        expect(commandsForPage(page, mode)).toBe(commandsForPage(page, mode));
      }
    }
    // And the slices are distinct objects, so identity is not passing by every
    // call returning one shared array.
    expect(commandsForPage('composition', 'pattern')).not.toBe(
      commandsForPage('composition', 'voice'),
    );
    // The pattern page is the deliberate exception: no row there is tagged, so
    // every mode is handed back the SAME array as the mode-less call rather than
    // an equal copy. A panel that normalises to always pass a mode must not see
    // a new identity for an identical list.
    for (const mode of MODES) {
      expect(commandsForPage('pattern', mode)).toBe(commandsForPage('pattern'));
    }
  });

  it('hands out frozen lists, so a caller cannot sort one in place', () => {
    // Exactly that and no more: `Object.freeze` is shallow, so the ROWS and
    // their `slots`/`tools` are still mutable through the list. The list is a
    // render-time value handed to a component, and reordering it is the mishap
    // this stops.
    for (const mode of MODES) {
      expect(Object.isFrozen(commandsForPage('composition', mode))).toBe(true);
    }
    expect(Object.isFrozen(commandsForPage('composition'))).toBe(true);
  });
});

// ------------------------------------------------------- lib-derived slots ---

describe('slot values come from the lib', () => {
  const sourceOf = (source: ChoiceSource): Slot => ({
    kind: 'choice',
    id: 'probe',
    label: 'Probe',
    source,
  });

  /**
   * Every {@link ChoiceSource}, and where its values MUST come from.
   *
   * A `Record<ChoiceSource, …>` and not a list, so adding a source to the union
   * is a COMPILE error here until someone states its origin. The previous shape
   * — a handful of assertions naming sources by hand — let a seventh source with
   * a literal array beside it pass every test, which is the exact defect this
   * file exists to catch.
   *
   * `track` and `pattern` are live documents rather than lib catalogs, so their
   * origin is the seam's own reader; they are covered by their own tests below
   * and named here only so the record stays exhaustive.
   */
  const SOURCE_EXPECTATIONS: Readonly<Record<ChoiceSource, () => readonly string[]>> = {
    groove: () => GROOVE_PRESETS.map((preset) => preset.id),
    scale: () => SCALES.map((scale) => scale.id),
    key: () => [...CHROMATIC_KEYS],
    instrument: () => INSTRUMENTS.map((instrument) => instrument.id),
    // Finest first — `pattern-fix-timing` opens on `options[0]` and must not
    // default to flattening a riff onto quarter notes.
    subdivision: () => [PPQ / 4, PPQ / 3, PPQ / 2, PPQ].map(String),
    track: () => getTracks().map((track) => track.id),
    pattern: () => usePatternsStore.getState().library.patterns.map((pattern) => pattern.id),
  };

  it('offers exactly what the lib offers, for every source there is', () => {
    seedPattern('Riff');
    seedComposition();
    expect(addTrack('Rhythm').ok).toBe(true);

    for (const [source, expected] of Object.entries(SOURCE_EXPECTATIONS)) {
      const values = slotOptions(sourceOf(source as ChoiceSource)).map((o) => o.value);
      expect(`${source}: ${values.join(',')}`).toBe(`${source}: ${expected().join(',')}`);
      expect(values.length).toBeGreaterThan(0);
    }

    // Four grooves, and only four. "Heavy swing" is not one of them — a command
    // that wants one asks for `shuffle`, which is what the lib calls it.
    expect(GROOVE_PRESETS).toHaveLength(4);
  });

  it('derives the timing grid from PPQ rather than writing ticks out', () => {
    const ticks = slotOptions(sourceOf('subdivision')).map((option) => Number(option.value));
    expect(ticks.length).toBeGreaterThan(2);
    for (const value of ticks) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeLessThanOrEqual(PPQ);
      // A grid that is not a whole division of a quarter note is a grid nothing
      // in the app lines up with — and is what a hand-typed number produces.
      expect(PPQ % value).toBe(0);
    }
    expect(ticks).toContain(PPQ);
    // The default, and the reason the list is ordered the way it is: pressing
    // "Fix the timing" without touching the picker must not quantise a
    // sixteenth-note part onto quarter notes.
    expect(resolveSlot(sourceOf('subdivision')).value).toBe(String(PPQ / 4));
  });

  it('never keeps a second copy of a lib vocabulary in src/ai', () => {
    /**
     * The scan that makes the table safe to grow. `SOURCE_EXPECTATIONS` above
     * compares VALUES, so a hand-written copy that happens to be correct today
     * is invisible to it — and a correct copy is precisely the failure mode,
     * because it silently stops offering whatever the lib adds next.
     *
     * The rule is "quotes two or more members of one vocabulary", not "quotes
     * any". One shared word is honest — `blues` is a genre in the catalog and
     * also a scale id in the lib, and both are legitimately spelled that way.
     * Two members of the same vocabulary in one file is a list.
     *
     * GROOVE_PRESETS is held to the stricter bar of one, below: it is the
     * vocabulary the ticket calls out by name, its ids share no word with any
     * authored enum, and the tempting mistake ("heavy swing" beside `shuffle`)
     * starts with a single literal.
     */
    const VOCABULARIES: Readonly<Record<string, readonly string[]>> = {
      groove: GROOVE_PRESETS.map((preset) => preset.id),
      scale: SCALES.map((scale) => scale.id),
      key: [...CHROMATIC_KEYS],
      instrument: INSTRUMENTS.map((instrument) => instrument.id),
      // The tick grid. `String(PPQ / 4)` is derivation; `'120'` is a copy.
      subdivision: [PPQ, PPQ / 2, PPQ / 3, PPQ / 4].map(String),
    };

    const sources = import.meta.glob('../src/ai/*.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(2);

    for (const [file, source] of Object.entries(sources)) {
      for (const [name, vocabulary] of Object.entries(VOCABULARIES)) {
        // Quote characters only — NOT backticks. A backticked word in this
        // codebase is prose (`shuffle` in a doc comment explaining why the slot
        // emits the id and not "heavy swing"), and a scan that fails on the
        // comment explaining the rule is a scan people delete.
        const quoted = vocabulary.filter((member) =>
          [`'${member}'`, `"${member}"`].some((form) => source.includes(form)),
        );
        const limit = name === 'groove' ? 0 : 1;
        const verdict =
          quoted.length > limit ? `copies the ${name} catalog: ${quoted.join(',')}` : 'clean';
        expect(`${file}: ${verdict}`).toBe(`${file}: clean`);
      }
    }
  });

  it('binds a track slot to the tracks that exist, and says so when none do', () => {
    const track = sourceOf('track');
    expect(slotOptions(track)).toEqual([]);
    // The two empty states are DIFFERENT and the message has to distinguish
    // them: "no composition open" is a thing to go and do, "no tracks yet" is
    // another. A single generic sentence would satisfy a truthiness check and
    // tell the user nothing.
    expect(resolveSlot(track).unavailable).toBe('No composition is open.');

    seedComposition();
    // A blank composition starts with one track and the seam refuses to remove
    // the last one, so the track-less state is written through the STORE — the
    // reason `forceKeyOnPatterns` does the same. It is reachable: a document
    // made elsewhere can carry zero tracks, and that is the case this branch is
    // for.
    expect(removeTrack(getTracks()[0].id).ok).toBe(false);
    forceTracklessComposition();
    expect(getTracks()).toEqual([]);
    expect(resolveSlot(track).unavailable).toBe('This composition has no tracks.');

    const added = addTrack('Rhythm');
    expect(added.ok).toBe(true);

    const options = slotOptions(track);
    expect(options.map((option) => option.value)).toEqual(getTracks().map((track) => track.id));
    expect(options.map((option) => option.label)).toContain('Rhythm');
    expect(resolveSlot(track).unavailable).toBeNull();
  });

  it('binds a pattern slot to the library', () => {
    const pattern = sourceOf('pattern');
    expect(slotOptions(pattern)).toEqual([]);
    expect(resolveSlot(pattern).unavailable).toBe(
      'The pattern library is empty — nothing has been saved yet.',
    );
    const id = seedPattern('Chorus');
    const options = slotOptions(pattern);
    expect(options.map((option) => option.value)).toEqual([id]);
    expect(options[0].label).toBe('Chorus');
  });

  it('hints with the instrument NAME, not its id', () => {
    // Both hints and both labels are read by the same picker; one column saying
    // `ukulele` while the next says `Ukulele` looks like two different things.
    seedPattern('Riff');
    expect(setEditingPatternInstrument('ukulele').ok).toBe(true);
    const names = new Set(INSTRUMENTS.map((instrument) => instrument.name));

    seedComposition();
    for (const source of ['pattern', 'track'] as const) {
      for (const option of slotOptions(sourceOf(source))) {
        expect(`${source}: ${option.hint}`).toBe(
          `${source}: ${names.has(option.hint ?? '') ? option.hint : 'a display name'}`,
        );
      }
    }
  });
});

// --------------------------------------------------------------- defaults ---

describe('defaults come from live state', () => {
  const defaultsOf = (id: string): Record<string, SlotValue> => {
    const command = findCommand(id);
    if (!command) throw new Error(`no command ${id}`);
    return defaultValues(command);
  };

  /**
   * `composition-groove` HAS NO ROW USING IT, so it is probed through a slot
   * built here.
   *
   * The backing track was its last user and its groove slot went when that row
   * moved to the `'ir-job'` route — a groove is a playback preset and `ImportIR`
   * has no field for one, so the picker would have promised a swing the imported
   * piece could not have. The resolver is still correct and a composition row
   * wanting a groove is an ordinary thing to add, so the branch keeps a test
   * rather than being deleted with the slot; `resolveSlot` is the same entry
   * point `defaultValues` walks a command through.
   */
  const grooveSlot: Slot = {
    kind: 'choice',
    id: 'groove',
    label: 'Groove',
    source: 'groove',
    defaultFrom: 'composition-groove',
  };

  it('takes the tempo from the composition, and the groove for a slot that asks', () => {
    seedComposition();
    expect(setCompositionBpm(137).ok).toBe(true);
    expect(setCompositionGroove('shuffle').ok).toBe(true);

    expect(defaultsOf('composition-backing-track').bpm).toBe(137);
    expect(resolveSlot(grooveSlot).value).toBe('shuffle');
  });

  it('takes the tempo and the groove from the pattern', () => {
    seedPattern('Riff');
    expect(setPatternBpm(72).ok).toBe(true);
    expect(setPatternGroove('16th-swing').ok).toBe(true);

    const values = defaultsOf('pattern-feel');
    expect(values.bpm).toBe(72);
    expect(values.groove).toBe('16th-swing');
  });

  it('takes the track from the selection', () => {
    seedComposition();
    const second = addTrack('Lead');
    if (!second.ok) throw new Error(second.reason);
    selectTrack(second.value.id);

    expect(defaultsOf('composition-harmony-track').track).toBe(second.value.id);
    expect(defaultsOf('composition-balance-mix').lead).toBe(second.value.id);
  });

  it('takes the instrument from the open pattern', () => {
    seedPattern('Riff');
    expect(setEditingPatternInstrument('ukulele').ok).toBe(true);
    expect(defaultsOf('pattern-generate').instrument).toBe('ukulele');
  });

  it('takes the key and scale from the open pattern', () => {
    seedPattern('Riff');
    forceKeyOnPatterns('F#', 'dorian');
    const values = defaultsOf('pattern-fit-key');
    expect(values.key).toBe('F#');
    expect(values.scale).toBe('dorian');
  });

  it("takes the composition's key from its harmonic context", () => {
    seedComposition();
    usePatternsStore.getState().addHarmonicBlock({
      startTick: 0,
      endTick: PPQ * 4,
      scale: { root: 'A', type: 'minor' },
    });
    const values = defaultsOf('composition-backing-track');
    expect(values.key).toBe('A');
    expect(values.scale).toBe('minor');
  });

  it("falls back to the composition's placed patterns for a key", () => {
    const patternId = seedPattern('Riff');
    forceKeyOnPatterns('D', 'minor-pentatonic');
    seedComposition();
    const placed = addPlacement(patternId, getTracks()[0].id, 0);
    expect(placed.ok).toBe(true);

    const values = defaultsOf('composition-backing-track');
    expect(values.key).toBe('D');
    expect(values.scale).toBe('minor-pentatonic');
  });

  it("sizes 'extend by' against how long the arrangement already is", () => {
    const patternId = seedPattern('Riff');
    seedComposition();
    const track = getTracks()[0].id;
    expect(addPlacement(patternId, track, PPQ * 8).ok).toBe(true);
    // Derived here the same way the slot derives it, but from the seam's own
    // total — the claim is "it tracks the arrangement's length", not "it is 3".
    const bars = Math.ceil(totalDurationTicks() / (PPQ * 4));
    expect(bars).toBeGreaterThan(1);
    expect(defaultsOf('composition-extend').bars).toBe(bars);
  });

  it('counts those bars in the composition\'s OWN time signature', () => {
    // The only arithmetic in the module, and 4/4 hides every way of getting it
    // wrong: `PPQ * numerator` and `(PPQ * 4 * numerator) / denominator` agree
    // there and nowhere else. 6/8 is a three-quarter bar; 3/4 is a shorter bar
    // than 4/4, so the same arrangement is MORE bars long.
    const patternId = seedPattern('Riff');
    seedComposition();
    expect(addPlacement(patternId, getTracks()[0].id, PPQ * 8).ok).toBe(true);
    const total = totalDurationTicks();

    for (const ts of [
      { numerator: 4, denominator: 4 },
      { numerator: 6, denominator: 8 },
      { numerator: 3, denominator: 4 },
      { numerator: 7, denominator: 8 },
    ] as const) {
      expect(setCompositionTimeSignature(ts).ok).toBe(true);
      const perBar = ticksPerBar(ts);
      expect(defaultsOf('composition-extend').bars).toBe(Math.ceil(total / perBar));
    }
    // Sanity that the loop above discriminates at all: 6/8 bars are shorter than
    // 4/4 bars, so the same total has to come out as more of them.
    expect(ticksPerBar({ numerator: 6, denominator: 8 })).toBeLessThan(
      ticksPerBar({ numerator: 4, denominator: 4 }),
    );
  });

  it('clamps a live number into the range the slot offers', () => {
    // `composition-bars` is the one default with no upstream clamp — it is
    // COUNTED, not stored — so an arrangement longer than the slot's ceiling is
    // reachable and is what the clamp is for. Without it the slot resolves past
    // its own max and `fillCommand` then refuses its own default: a shipped
    // command that cannot be pressed.
    const patternId = seedPattern('Riff');
    seedComposition();
    const extend = findCommand('composition-extend');
    if (!extend) throw new Error('missing command');
    const bars = extend.slots.find((slot) => slot.id === 'bars');
    if (bars?.kind !== 'number') throw new Error('bars is not a number slot');

    const beyond = (bars.max + 40) * PPQ * 4;
    expect(addPlacement(patternId, getTracks()[0].id, beyond).ok).toBe(true);
    expect(Math.ceil(totalDurationTicks() / (PPQ * 4))).toBeGreaterThan(bars.max);

    expect(defaultsOf('composition-extend').bars).toBe(bars.max);
    expect(fillCommand(extend, defaultValues(extend)).ok).toBe(true);
  });

  it('rounds a fractional live number for a whole-number slot', () => {
    // The lib clamps a composition's bpm but does not round it, so 137.6 is a
    // value the app can genuinely hold. `fillCommand` rejects a fraction in a
    // step-1 slot, so without the rounding the command refuses its own default.
    seedComposition();
    expect(setCompositionBpm(137.6).ok).toBe(true);
    expect(defaultsOf('composition-backing-track').bpm).toBe(138);

    const backing = findCommand('composition-backing-track');
    if (!backing) throw new Error('missing command');
    expect(fillCommand(backing, defaultValues(backing)).ok).toBe(true);
  });

  it('falls back rather than refusing when nothing is open', () => {
    // Every command has to be fillable on a cold start, or the agent can never
    // be asked to create the thing its slots want to read.
    const values = defaultsOf('composition-backing-track');
    // ⚠ This does NOT prove `fallbackOption` honours `DEFAULT_SCALE_ID`: the
    // lib's default scale is also `SCALES[0]`, so "the declared default" and
    // "the first option" are the same string and no assertion here can tell
    // them apart. The branch is kept because it is right in principle — the day
    // the lib's default stops being first, this test starts discriminating.
    expect(values.scale).toBe(DEFAULT_SCALE_ID);
    expect(values.key).toBe(CHROMATIC_KEYS[0]);
    expect(typeof values.bpm).toBe('number');
    // Same claim, on the slot that reads the composition's groove — see
    // `grooveSlot` on why it is built here rather than taken from a row.
    expect(resolveSlot(grooveSlot).value).toBe(GROOVE_PRESETS[0].id);
  });

  it('ignores a live value the picker cannot represent', () => {
    seedComposition();
    // A groove spec that matches no named preset — reachable from a document
    // made elsewhere. `compositionGrooveId` calls it 'custom', which is not an
    // offered value, so the slot must fall back rather than show nothing.
    usePatternsStore.getState().setEditingCompositionGroove({ swing: 0.55, appliedTo: 'eighths' });
    expect(resolveSlot(grooveSlot).value).toBe(GROOVE_PRESETS[0].id);
  });
});

// ------------------------------------------------------------------- fill ---

describe('filling a command', () => {
  const backing = (): Command => {
    const command = findCommand('composition-backing-track');
    if (!command) throw new Error('missing command');
    return command;
  };

  const text = (command: Command, values: Record<string, SlotValue>): string => {
    const result = fillCommand(command, values);
    if (!result.ok) throw new Error(result.reason);
    return result.value;
  };

  it('is deterministic for the same values, whatever the app holds', () => {
    seedComposition();
    const command = backing();
    const values = defaultValues(command);
    const first = text(command, values);

    // Move the world underneath it: rename the track, change the tempo, add a
    // pattern. The rendered string must not shift, because the values did not.
    expect(setTrackName(getTracks()[0].id, 'Renamed').ok).toBe(true);
    expect(setCompositionBpm(191).ok).toBe(true);
    seedPattern('Another');

    expect(text(command, values)).toBe(first);
    expect(text(command, { ...values })).toBe(first);
  });

  it('substitutes the slot VALUE, never the label the user saw', () => {
    seedComposition();
    const added = addTrack('Sludgy Rhythm Gtr');
    if (!added.ok) throw new Error(added.reason);
    const command = findCommand('composition-balance-mix');
    if (!command) throw new Error('missing command');

    const filled = text(command, { lead: added.value.id });
    expect(filled).toContain(added.value.id);
    // The name is live state; putting it in the prompt would make the same
    // choices render differently tomorrow, which is the reproducibility the
    // catalog exists to buy.
    expect(filled).not.toContain('Sludgy Rhythm Gtr');
  });

  it('emits the lib groove id rather than a word for it', () => {
    // `pattern-feel`, because the backing track no longer has a groove slot to
    // fill — see `grooveSlot` above. The claim is about `fillCommand` and any
    // row with a groove in it demonstrates the same thing.
    const command = findCommand('pattern-feel');
    if (!command) throw new Error('missing command');
    const filled = text(command, { ...defaultValues(command), groove: 'shuffle' });
    expect(filled).toContain('shuffle');
    expect(filled).not.toMatch(/heavy swing/i);
  });

  it('refuses a missing, unknown, out-of-range or off-list value', () => {
    const command = backing();
    const values = defaultValues(command);

    const missing = fillCommand(command, { ...values, bpm: undefined as unknown as number });
    expect(missing.ok).toBe(false);

    const unknown = fillCommand(command, { ...values, tempo: 120 });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toContain('tempo');

    expect(fillCommand(command, { ...values, bpm: 9000 }).ok).toBe(false);
    expect(fillCommand(command, { ...values, bpm: 100.5 }).ok).toBe(false);
    expect(fillCommand(command, { ...values, genre: 'polka' }).ok).toBe(false);
  });

  it('leaves number slots out of the allow-list, so a tempo is not refused', () => {
    // `slotOptions` answers `[]` for a number slot. An empty list reaching
    // `fillCommand` means "offers nothing", so listing numbers here would refuse
    // every tempo and every bar count — including the command's own defaults.
    // This is the call shape the panel uses, so it has to be the tested one.
    seedComposition();
    const command = backing();
    const allowed = allowedValues(command);
    expect(Object.keys(allowed)).not.toContain('bpm');
    expect(Object.keys(allowed)).not.toContain('bars');
    expect(Object.keys(allowed)).toContain('key');

    const values = defaultValues(command);
    expect(fillForNow(command, values).ok).toBe(true);
    expect(fillForNow(command, { ...values, bpm: 137, bars: 16 }).ok).toBe(true);
    // …and the live check is still ON in that form: an off-list key refuses.
    expect(fillForNow(command, { ...values, key: 'H' }).ok).toBe(false);
  });

  it('refuses a value the app no longer offers', () => {
    seedComposition();
    const added = addTrack('Doomed');
    if (!added.ok) throw new Error(added.reason);
    const command = findCommand('composition-balance-mix');
    if (!command) throw new Error('missing command');

    const stale = { lead: added.value.id };
    expect(fillCommand(command, stale, allowedValues(command)).ok).toBe(true);

    // The anti-hallucination property, made concrete: the panel resolved the
    // options a moment ago, the world moved, and the id is refused HERE rather
    // than costing a whole agent run to discover.
    usePatternsStore.setState({
      ...DEFAULT_PATTERNS_STATE,
      library: { patterns: [], compositions: [], collections: [] },
    });
    const refused = fillCommand(command, stale, allowedValues(command));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain('no longer offers');
  });
});

// -------------------------------------------- the narrow brief, by hand ---

/**
 * `pattern-write-over-a-chord`, and the check that keeps it honest.
 *
 * The row exists so a question can be ANSWERED by ear: does one part, one chord,
 * one instrument write better music than a run holding a whole composition? A
 * person cannot type that brief — the panel has no free-text slot, deliberately
 * — and a caller building it in code will not type it either, it will construct
 * it from four fields. So the row IS that construction, done by hand, and the
 * thing being listened to is only worth listening to if it is the thing that
 * will ship.
 *
 * Hence the paragraph-for-paragraph comparison below against
 * `patternSubRun.patternRunInput`, which fails on a reword in EITHER file rather
 * than letting the two drift until the listening test measures something that
 * never ships.
 */
describe('writing a part over one chord', () => {
  const command = (): Command => {
    const found = findCommand('pattern-write-over-a-chord');
    if (!found) throw new Error('missing command');
    return found;
  };

  const filled = (values: Record<string, SlotValue>): string => {
    const result = fillCommand(command(), values);
    if (!result.ok) throw new Error(result.reason);
    return result.value;
  };

  /**
   * The slot values, and the brief input they are the hand-driven spelling of.
   *
   * FOUR BARS because that is the slot's own default, and one bar is not
   * reachable at all — see the `bars` slot for why: a template pluralises
   * nothing and drops nothing, so at one bar it would render "1 bars" and carry
   * a paragraph about later bars that do not exist. The comparison is run below
   * over `defaultValues` and over the two-bar floor as well, so the fills a
   * person can actually reach are all held to it, not just this one.
   */
  const VALUES: Readonly<Record<string, SlotValue>> = {
    chord: 'F7',
    // Not the guitar: the sub-run's brief is neck-specific, and a bass is where
    // a voicing carried over from a guitar goes wrong silently.
    instrument: 'bass',
    character: 'walking bass line',
    bars: 4,
  };

  /**
   * The {@link PatternBrief} a fill IS — derived from the fill rather than
   * written out beside it, so a slot value and its brief input cannot drift
   * apart and leave the equality below comparing two texts about different
   * music.
   *
   * ⚠ NO CHORD SYMBOL IN THE NAME, `PatternSubRun.test.ts`'s reason: the name is
   * the `character` value ("walking bass line"), so a name like "Walking Bass
   * F7" cannot make every check for the chord pass on the interpolation alone.
   */
  const briefInputFor = (values: Record<string, SlotValue>): PatternBrief => ({
    name: String(values.character),
    instrumentId: String(values.instrument),
    chord: String(values.chord),
    lengthBars: Number(values.bars),
  });

  const paragraphs = (text: string): readonly string[] => text.split('\n\n');

  /**
   * The paragraphs that CANNOT be identical in the two texts.
   *
   * Every entry is applied to BOTH sides, so nothing is excused on one side
   * only, and the counts asserted below pin how many each side loses — an
   * over-broad regex that quietly deleted real content would move one of them.
   */
  const CANNOT_MATCH: readonly RegExp[] = [
    // The chord. `patternRunInput` INJECTS the grip — it calls `chordGrip` and
    // pastes the cells in, because a fact in the brief is read before any tool
    // is chosen. A template substitutes slot values and computes nothing, so
    // this row sends the run to `read_chord_voicings`, which is the same voicer
    // behind the same seam. These five paragraphs are that swap.
    /^# The chord/,
    /^\S[^\n]* sits here:$/,
    /^ {4}stringIndex /,
    /^That is one hand position/,
    /^THERE IS NO CHORD LOOKUP IN THIS RUN/,
    /^Ask read_chord_voicings/,
    // How long it is. The brief names the bar AFTER the last one ("makes this 5
    // bars long"), and arithmetic on a slot value is not a slot value.
    /and length is not something you set/,
    // How to work. "The frets above" is only true where the frets are above.
    /^Read the pattern once first/,
  ];

  /**
   * What survives inside the two paragraphs `CANNOT_MATCH` excuses — asserted on
   * BOTH texts, because a per-paragraph excuse for a one-clause difference is a
   * hole the size of the paragraph.
   *
   * Written at `VALUES`' bar count and neck, so the numbers and the instrument
   * are substituted on one side and computed on the other, exactly as in the
   * equality. The last one is the abort that keeps a grip voiced for one neck
   * off another: it is the only thing standing between a bass line dropped into
   * a guitar pattern and a run that stamps it cleanly and sounds wrong.
   */
  const SHARED_SENTENCES: readonly string[] = [
    'rounded UP to the end of the bar the last one finishes in',
    'every note must END by the end of bar 4 — start plus duration, not start',
    'Check the last note of every string before you send it',
    'It also says which instrument the open pattern is on',
    'If it is not bass, write nothing and say so',
    'send the whole 4 bars in ONE stamp call, the dynamics in one call and the articulations in one call',
  ];

  const spine = (text: string): readonly string[] =>
    paragraphs(text).filter((para) => !CANNOT_MATCH.some((skip) => skip.test(para)));

  /**
   * The brief, with the instrument's display NAME rewritten to its id.
   *
   * `fillCommand` substitutes a slot's VALUE and never the label the user saw —
   * that is the reproducibility the catalog is built on — so a template can only
   * ever carry `bass`, while `patternRunInput` names the catalog's `Bass`. Case
   * is the whole of the difference, and normalising it here is cheaper than
   * inlining a display string into a template.
   */
  const renderBrief = (input: PatternBrief): string => {
    const instrument = INSTRUMENTS.find((entry) => entry.id === input.instrumentId);
    if (!instrument) throw new Error(`no instrument ${input.instrumentId}`);
    const built = patternRunInput(input);
    if (!built.ok) throw new Error(`patternRunInput refused: ${built.reason}`);
    return built.value.replaceAll(instrument.name, instrument.id);
  };

  /**
   * The whole anti-drift assertion over ONE fill, parametrised — because the
   * fill that matters most is not this file's hand-picked set, it is the one a
   * person gets by opening the panel and pressing go.
   */
  const expectSameAsBrief = (values: Record<string, SlotValue>): void => {
    const brief = renderBrief(briefInputFor(values));
    const text = filled(values);

    // The excuse list is doing exactly the work it documents and no more: the
    // brief loses its injected grip (five paragraphs) plus the two that differ
    // in a phrase; the template loses its lookup (two) plus the same two.
    expect(paragraphs(brief).length - spine(brief).length).toBe(7);
    expect(paragraphs(text).length - spine(text).length).toBe(4);
    expect(spine(brief).length).toBeGreaterThan(10);

    // ⚠ THE ANTI-DRIFT CHECK. Verbatim, and in order.
    expect(spine(text)).toEqual(spine(brief));
  };

  it('is offered on the pattern page, and asks for the lookup it cannot be handed', () => {
    expect(commandsForPage('pattern')).toContain(command());
    for (const tool of command().tools) expect(TOOL_NAMES.has(tool)).toBe(true);
    // The one tool the sub-run does without, and the reason it can: its grip
    // arrives in the prompt. This row's does not, so the lookup is not optional.
    expect(command().tools).toContain('read_chord_voicings');
    expect(command().template).toContain('read_chord_voicings');

    // Pinned against the constant rather than against a copy of it here, for
    // the template's own reason: `SUB_RUN_TOOL_NAMES` exists so a list can be
    // held EXACTLY, and a name added there is a capability this row must either
    // offer too or be a deliberate exception to. A hand-kept copy would drift
    // and still pass, because every name in it would exist.
    expect([...command().tools].sort()).toEqual(
      [...SUB_RUN_TOOL_NAMES, 'read_chord_voicings'].sort(),
    );
  });

  it('names the chosen chord, instrument and bar count', () => {
    const text = filled(VALUES);
    expect(text).toContain('F7');
    // Phrases only the INSTRUMENT slot can produce. Bare 'bass' cannot fail:
    // it is already a substring of the `character` value 'walking bass line'.
    expect(text).toContain('4 bars of bass over F7');
    expect(text).toContain('instrumentId "bass"');
    // The slot VALUE, not the label: a picker showing "Walking bass line" still
    // sends the lowercase phrase the brief's own sentence uses.
    expect(text).toContain('"walking bass line"');
    expect(text).not.toMatch(/\{[a-zA-Z]/);

    // A different fill is a different brief, all the way through.
    const other = filled({ ...VALUES, chord: 'Gm', instrument: 'guitar', bars: 2 });
    expect(other).toContain('Gm');
    expect(other).toContain('2 bars');
    expect(other).not.toContain('F7');
  });

  it('offers only chord symbols the app can voice, on every neck it has', () => {
    const slot = findSlot(command(), 'chord');
    if (slot?.kind !== 'enum') throw new Error('chord is not an enum slot');
    expect(slot.options.length).toBeGreaterThan(10);

    // The picker cannot offer a symbol `parseChordSymbol` refuses: the run would
    // spend its whole budget finding that out, and the seam's refusal would name
    // a chord the person picked from a list this app wrote.
    for (const option of slot.options) {
      for (const instrument of INSTRUMENTS) {
        const grip = chordGrip(option.value, instrument.id);
        const where = `${option.value} on ${instrument.id}`;
        expect(`${where}: ${grip.ok ? 'voiced' : grip.reason}`).toBe(`${where}: voiced`);
      }
    }
  });

  it("says what the pattern sub-run's brief says, paragraph for paragraph", () => {
    expectSameAsBrief(VALUES);

    const brief = renderBrief(briefInputFor(VALUES));
    const text = filled(VALUES);

    // The load-bearing paragraph of the brief, pinned against `patternRunInput`
    // rather than against a copy of it in this file: it lives inside the chord
    // section, which the swap above excuses on both sides.
    const material = paragraphs(brief).find((para) => para.startsWith('This is MATERIAL'));
    expect(material).toBeDefined();
    expect(text).toContain(material);

    // The two paragraphs `CANNOT_MATCH` excuses differ in ONE clause each, and
    // the equality above therefore compares nothing else in them — which leaves
    // the most operational instructions in the brief unchecked on both sides. A
    // reword of "start plus duration, not start", or of the abort when the open
    // pattern is on the wrong neck, would otherwise pass every assertion here.
    for (const sentence of SHARED_SENTENCES) {
      expect(text).toContain(sentence);
      expect(brief).toContain(sentence);
    }
  });

  it('says it at the fill a person is handed, and at the shortest one offered', () => {
    // With a bass pattern open, `defaultFrom: 'editing-pattern-instrument'` is
    // live rather than falling back — the panel's real opening state.
    seedPattern('Take one');
    const bass = setEditingPatternInstrument('bass');
    if (!bass.ok) throw new Error(bass.reason);

    const defaults = defaultValues(command());
    expect(defaults.instrument).toBe('bass');
    // ⚠ NOT ONE BAR. The template has no conditional and no plural, so at one
    // bar it would say "1 bars" and carry the brief's ostinato paragraph about
    // bars that do not exist. The floor is what keeps the equality reachable.
    expect(defaults.bars).toBe(4);
    expectSameAsBrief(defaults);

    const floor = findSlot(command(), 'bars');
    if (floor?.kind !== 'number') throw new Error('bars is not a number slot');
    expect(floor.min).toBe(2);
    expectSameAsBrief({ ...defaults, bars: floor.min });
  });
});

// ------------------------------------------------------------ adding a row ---

/**
 * The acceptance criterion, executed: a new capability is THIS and nothing else.
 * No new slot kind, no new source, no resolver, no component — a literal that
 * satisfies `Command`, which the invariants below then hold to the same bar as
 * every shipped row.
 *
 * It is deliberately NOT added to `COMMAND_CATALOG`. Shipping it is a one-line
 * edit; the point being proved is that the MECHANISM needs no other change, and
 * a test fixture proves that without deciding for the user that this particular
 * command is worth offering.
 */
const ADDED_COMMAND: Command = {
  id: 'pattern-halve-time',
  page: 'pattern',
  label: 'Play it half-time',
  summary: 'Stretch the pattern to twice its length without changing which notes are in it.',
  slots: [
    { kind: 'choice', id: 'grid', source: 'subdivision', label: 'Grid' },
    {
      kind: 'enum',
      id: 'ring',
      label: 'Sustain',
      options: [
        { value: 'let every note ring into the next', label: 'Ringing' },
        { value: 'keep the original note lengths', label: 'Detached' },
      ],
      // Deliberately the SECOND option. Every shipped enum puts its fallback
      // first, so `slot.fallback` and `options[0].value` are indistinguishable
      // across the whole catalog and a resolver that ignored `fallback` would
      // pass every test. This row is the one that tells them apart.
      fallback: 'keep the original note lengths',
    },
  ],
  tools: ['read_pattern', 'pattern_move_notes', 'pattern_resize_notes'],
  template: `Rewrite the open pattern half-time: double every start tick and {ring}, snapping everything to a grid of {grid} ticks.

Do not add, delete or re-fret anything.`,
};

describe('adding a command', () => {
  it('is a row and nothing else', () => {
    assertCommandInvariants(ADDED_COMMAND);

    seedPattern('Riff');
    assertCommandInvariants(ADDED_COMMAND);

    const values = defaultValues(ADDED_COMMAND);
    // The enum opens on its declared `fallback`, not on whatever happens to be
    // first in the list — see the comment on the row.
    expect(values.ring).toBe('keep the original note lengths');
    expect(values.ring).not.toBe(ADDED_COMMAND.slots[1].kind === 'enum'
      ? ADDED_COMMAND.slots[1].options[0].value
      : null);

    const filled = fillCommand(ADDED_COMMAND, values, allowedValues(ADDED_COMMAND));
    expect(filled.ok).toBe(true);
    if (filled.ok) {
      expect(filled.value).toContain(String(values.grid));
      expect(filled.value).toContain(String(values.ring));
    }
  });
});
