import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PATTERNS_STATE,
  GROOVE_PRESETS,
  INSTRUMENTS,
  MAX_COMPOSITION_TRACKS,
  PPQ,
  usePatternsStore,
  useVoiceStore,
} from '@fretwork/lib';
import { AGENT_TOOLS, findTool } from '../src/ai/tools';
// The read half of the registry, so "this one cannot write" can be asserted as a
// property of the SET rather than of one tool's name.
import { READ_TOOLS } from '../src/ai/tools/readTools';
import type { JsonPrimitive, JsonSchema, JsonValue, ToolResult } from '../src/ai/tools/types';
import {
  BEND_KINDS,
  BEND_SEMITONES,
  VIBRATOS,
} from '../src/patterns/articulations';
// The editor's labelled copy of the bend depths — imported only to pin the two
// lists together; see the schema test.
import { DEPTHS } from '../src/timeline/noteModel';
import {
  beginEditGesture as beginPatternGesture,
  clearHistory as clearPatternHistory,
  endEditGesture as endPatternGesture,
  undo as patternUndo,
  useHistoryState as usePatternHistory,
} from '../src/patterns/patternService';
import {
  abortEditGesture as abortCompositionGesture,
  addTrack as addTrackDirect,
  beginEditGesture as beginCompositionGesture,
  beginJob,
  clearHistory as clearCompositionHistory,
  closePlacementEditing,
  endEditGesture as endCompositionGesture,
  endJob,
  openPlacementForEditing,
  setTrackVoiceRef as setTrackVoiceRefDirect,
  undo as compositionUndo,
  useHistoryState as useCompositionHistory,
} from '../src/composition/compositionService';

/**
 * AG-04 — the agent's tools over the seams.
 *
 * ⚠ THE POINT OF THIS FILE IS WHAT IS *NOT* IN IT. There is no model, no
 * provider, no harness and no DOM: every tool is driven directly, by id and by
 * value, with no pointer anywhere. That is the project's standing constraint
 * restated as a check — *every capability is a seam function first and a gesture
 * second*. A capability that needed a rendered component to be exercised would
 * be one the agent cannot reach.
 *
 * The store underneath is real, for `compositionService.test.ts`'s reason: a
 * mock would assert away the only thing worth asserting, which is that the write
 * lands where the UI's write lands.
 *
 * (`renderHook` appears exactly once, for `useHistoryState` — an undo step that
 * was never pushed is invisible in the document, so the only way to see one is
 * to ask the history.)
 */

// ------------------------------------------------------------------ harness ---

const call = (name: string, args: Record<string, unknown> = {}): ToolResult => {
  const tool = findTool(name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return tool.run(args);
};

/** The success value, or a loud failure carrying the refusal — a test that
 *  silently treats a refusal as an empty object is the same bug the tools exist
 *  to prevent. */
function value(result: ToolResult): Record<string, JsonValue> {
  if (!result.ok) throw new Error(`tool refused: ${result.reason}`);
  return result.value as Record<string, JsonValue>;
}

const reason = (result: ToolResult): string => {
  if (result.ok) throw new Error('expected a refusal');
  return result.reason;
};

const rows = (v: JsonValue | undefined): Record<string, JsonValue>[] =>
  (v ?? []) as Record<string, JsonValue>[];

function canUndoPattern(): boolean {
  const view = renderHook(() => usePatternHistory());
  const result = view.result.current.canUndo;
  view.unmount();
  return result;
}

function canUndoComposition(): boolean {
  const view = renderHook(() => useCompositionHistory());
  const result = view.result.current.canUndo;
  view.unmount();
  return result;
}

/** A pattern with one note, in the library, ready to place. Built through the
 *  TOOLS rather than the seam, so the fixture exercises the same path. */
function seedPattern(name: string, fret = 5): string {
  const pattern = value(call('pattern_open_blank', { name }));
  value(
    call('pattern_stamp_notes', {
      notes: [{ stringIndex: 0, fret, tick: 0, durationTicks: PPQ }],
    }),
  );
  return pattern.patternId as string;
}

beforeEach(() => {
  sessionStorage.clear();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  useVoiceStore.getState().reset();
  // Module state on the seam, so a test that left a job open would refuse every
  // write in every test after it — with the seam's own sentence, which reads
  // like a real refusal. Gesture DEPTH is module state for the same reason and
  // `clearHistory` deliberately preserves it, so drain that too: a test that
  // threw inside a bracket would leave every later gesture looking nested and
  // pushing no step. `endEditGesture` is a no-op at zero.
  endJob();
  // An open PLACEMENT is module state one document down: it repoints the lib's
  // single pattern pointer, so a test that left one open would send the next
  // test's pattern writes into a block.
  closePlacementEditing();
  for (let i = 0; i < 8; i += 1) endCompositionGesture(false);
  for (let i = 0; i < 8; i += 1) endPatternGesture(false);
  clearPatternHistory();
  clearCompositionHistory();
});

// ------------------------------------------------------------- the registry ---

describe('the tool registry', () => {
  it('names every tool uniquely and legally', () => {
    const names = AGENT_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    // Providers accept `^[a-zA-Z0-9_-]{1,64}$` for a tool name; a dot or a space
    // is rejected at the API boundary, where the error is unhelpful.
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
  });

  it('gives every tool an object schema that rejects unknown arguments', () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.parameters.type).toBe('object');
      // A misspelt argument has to be a validation error. Silently ignored, it
      // leaves the model believing it set something it did not.
      expect(tool.parameters.additionalProperties).toBe(false);
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  /**
   * The tripwire. The agent gets NO privileged path: a tool that imported the
   * lib's store or `composition-ops` would bypass the guards the seams enforce —
   * the track cap, the empty-name rule, the built-in refusal — every one of
   * which exists at the seam precisely because the agent does not press buttons.
   */
  it('reaches the lib only through the seams', () => {
    // Read as source rather than by inspecting the modules, because the defect
    // this guards against is an IMPORT — a tool that reached the store directly
    // would behave identically here and differently in the app, where the
    // seam's guards are the only thing standing between the agent and the rules
    // the UI obeys. `import.meta.glob` and not `node:fs`: the app project has no
    // node types, and vitest resolves this the way Vite does.
    //
    // Recursive (`**`), because a future `tools/generation/*.ts` would otherwise
    // walk straight out of this check; and an ALLOW-LIST rather than a blocklist
    // of two names, because the failure is "reached something that is not a
    // seam" and there are more ways to spell the lib than to spell the seams.
    const sources = import.meta.glob('../src/ai/**/*.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;

    // The one non-seam module the tools reach: the pure articulation vocabulary
    // they build schemas out of. Scanned TOO, one hop deeper, because it is
    // harmless today only because it imports nothing at all — and the tripwire
    // would not notice if that changed.
    const helper = import.meta.glob('../src/patterns/articulations.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;

    /**
     * The harness check runs over a SECOND, WIDER glob — every source file in
     * the app, `.tsx` included.
     *
     * The narrow one above cannot see the failure it was written for.
     * `ConnectorPanel.tsx` is in `src/ai` and is not a `.ts`; `src/shell` and
     * `src/timeline` are not scanned at all. Any one of them could
     * `import { runAgent } from 'agent-harness'` — the default entry, which
     * pulls in `ws` and Node builtins — and the only symptom would be a broken
     * `pnpm build`, which is precisely what this test exists to pre-empt.
     *
     * The SEAM allow-list stays on the narrow glob: it is a rule about what the
     * agent layer may reach, and the rest of the app reaches the lib legitimately
     * everywhere.
     */
    const everySource = import.meta.glob('../src/**/*.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;

    // The `../` prefix is REPEATED rather than fixed at two, because the glob
    // above is recursive in both directions: `src/ai/commandCatalog.ts` (AG-05)
    // sits one level up from `tools/` and reaches the same seams by a shorter
    // path. Pinning the depth would have made the check pass or fail on where a
    // file lives rather than on what it imports, which is not what it is for.
    // `\./[a-zA-Z]+(/[a-zA-Z]+)*` and not `\./[a-zA-Z]+`: AG-03 put
    // `agentService.ts` and `composerAgent.ts` at the top of `src/ai`, and they
    // reach the tool vocabulary as `./tools/types` — a SIBLING, one directory
    // down. Pinning the sibling branch to a single segment made the check pass
    // or fail on how deep a file sat rather than on what it reached, which is
    // not what it is for. It still cannot match `..`, which is the half that
    // matters.
    const ALLOWED =
      /^(\.\/[a-zA-Z]+(\/[a-zA-Z]+)*|(\.\.\/)+(patterns\/(patternService|articulations)|composition\/compositionService|voice\/voiceService|audio\/playbackService))$/;

    /**
     * The fifth seam's charter, pinned. `agentService.ts` is the ONLY module in
     * the app allowed to import the harness, and `agent-harness/browser` is the
     * only entry it may import: the default '.' entry pulls in `ws` and Node
     * builtins and does not survive a browser build, and './client' is a
     * WebSocket client to a server this app has decided not to run. Both
     * mistakes are silent in a unit test and fatal in a browser, so they are
     * checked here rather than discovered at `pnpm build`.
     */
    const HARNESS_SEAM = '../src/ai/agentService.ts';

    // Both quote styles and dynamic `import('…')` as well as `from '…'`: a
    // check a rename of the quote character defeats is not a check.
    const importsIn = (source: string): string[] =>
      [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);

    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(4);
    for (const [file, source] of Object.entries({ ...sources, ...helper })) {
      for (const specifier of importsIn(source)) {
        expect(`${file}: ${specifier}`).not.toMatch(/@fretwork\/lib/);
        expect(`${file}: ${specifier}`).not.toMatch(/composition-ops/);
        // The helper is scanned for lib imports only — the allow-list is about
        // what the TOOLS may reach. Compared as a sentence so a failure names
        // the file that broke it.
        if (file in sources && !specifier.startsWith('agent-harness')) {
          expect(ALLOWED.test(specifier) ? 'a seam' : `${file}: ${specifier}`).toBe('a seam');
        }
      }
    }
    expect(Object.keys(helper)).toHaveLength(1);

    // The whole app, for the harness rule alone.
    expect(Object.keys(everySource).length).toBeGreaterThan(files.length);
    // The seam has to be IN the wide glob, or the loop below would pass by
    // scanning nothing that could break it.
    expect(everySource).toHaveProperty(HARNESS_SEAM);
    let seamImports = 0;
    for (const [file, source] of Object.entries(everySource)) {
      for (const specifier of importsIn(source)) {
        if (!specifier.startsWith('agent-harness')) continue;
        // Stated as a sentence so a failure names the file and the entry that
        // broke it rather than just saying `false`.
        expect(`${file} imports ${specifier}`).toBe(`${HARNESS_SEAM} imports agent-harness/browser`);
        seamImports += 1;
      }
    }
    expect(seamImports).toBe(1);
  });
});

// ------------------------------------------------------------------ schemas ---

/**
 * Enum membership, checked here because `ajv` arrives with the harness in AG-03
 * and the acceptance criterion is about the SCHEMA, not about the validator:
 * a value outside an enum has to be rejected before any handler runs, which is
 * true exactly when the enum is the lib's own list. This stand-in checks only
 * that; it is not an attempt at a second validator.
 */
function schemaViolations(schema: JsonSchema, args: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const key of schema.required ?? []) {
    if (!(key in args)) problems.push(`missing ${key}`);
  }
  for (const [key, argument] of Object.entries(args)) {
    const property = schema.properties?.[key];
    if (!property) {
      problems.push(`unknown property ${key}`);
      continue;
    }
    if (property.enum && !property.enum.includes(argument as JsonPrimitive)) {
      problems.push(`${key} is not one of ${property.enum.join(', ')}`);
    }
  }
  return problems;
}

const schemaOf = (name: string): JsonSchema => {
  const tool = findTool(name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return tool.parameters;
};

/**
 * The schema of ONE entry in a batching tool's array argument.
 *
 * Every per-note write is a batch, so the interesting schema — the enums, the
 * ranges, the required `noteId` — sits one level down inside `items`. A check
 * written against the top level would pass by asserting nothing about the
 * values a model actually sends.
 */
const entryOf = (name: string, key: string): JsonSchema => {
  const property = schemaOf(name).properties?.[key];
  if (!property?.items) throw new Error(`${name}.${key} is not an array of entries`);
  return property.items;
};

describe('schemas constrain values to the lib’s own lists', () => {
  it('offers exactly the instruments the lib has, and rejects one it has not', () => {
    for (const schema of [
      schemaOf('pattern_set_instrument'),
      schemaOf('composition_add_track'),
      schemaOf('composition_set_track_instrument'),
    ]) {
      expect(schema.properties?.instrumentId?.enum).toEqual(
        INSTRUMENTS.map((instrument) => instrument.id),
      );
    }
    expect(
      schemaViolations(schemaOf('pattern_set_instrument'), { instrumentId: 'theremin' }),
    ).toHaveLength(1);
    expect(
      schemaViolations(schemaOf('pattern_set_instrument'), { instrumentId: 'guitar' }),
    ).toEqual([]);
  });

  it('offers exactly the lib’s groove presets, and rejects a made-up feel', () => {
    const grooves = GROOVE_PRESETS.map((preset) => preset.id);
    expect(schemaOf('pattern_set_playback').properties?.groove?.enum).toEqual(grooves);
    expect(schemaOf('composition_set_settings').properties?.groove?.enum).toEqual(grooves);
    expect(
      schemaViolations(schemaOf('composition_set_settings'), { groove: 'reggaeton' }),
    ).toHaveLength(1);
    expect(schemaViolations(schemaOf('composition_set_settings'), { groove: 'shuffle' })).toEqual(
      [],
    );
  });

  it('offers exactly the bend depths the editor can draw', () => {
    // The editor matches a note's depth against `DEPTHS` to show which one is
    // selected, so a depth outside that list renders as a bend with nothing
    // chosen. The two lists are pinned together HERE rather than by an import,
    // because the labels are the editor's and the semitone values are musical.
    expect(DEPTHS.map((depth) => depth.semitones)).toEqual([...BEND_SEMITONES]);
    const bend = entryOf('pattern_set_pitches', 'pitches').properties?.bend;
    expect(bend?.properties?.semitones?.enum).toEqual([...BEND_SEMITONES]);
    expect(bend?.properties?.kind?.enum).toEqual([...BEND_KINDS]);
    expect(entryOf('pattern_set_articulations', 'notes').properties?.vibrato?.enum).toEqual([
      ...VIBRATOS,
      null,
    ]);
  });

  it('says a name cannot be empty, and reports a missing required argument', () => {
    // `minLength` is the only way a schema can carry the seams' non-blank rule,
    // and without it every name field in the layer is unconstrained.
    for (const [tool, key] of [
      ['composition_add_track', 'name'],
      ['composition_rename_track', 'name'],
      ['composition_set_settings', 'name'],
      ['pattern_open_blank', 'name'],
    ] as const) {
      expect(schemaOf(tool).properties?.[key]?.minLength).toBe(1);
    }
    expect(schemaViolations(entryOf('pattern_move_notes', 'moves'), { tick: 0 })).toContain(
      'missing noteId',
    );
    expect(schemaViolations(schemaOf('pattern_move_notes'), {})).toContain('missing moves');
  });

  it('allows null where null means "clear", and only there', () => {
    // `nullable` has to widen the enum as well as the type, or a validator that
    // checks both refuses the clear it just accepted.
    const dynamic = entryOf('pattern_set_dynamics', 'dynamics').properties?.dynamic;
    expect(dynamic?.type).toEqual(['string', 'null']);
    expect(dynamic?.enum).toContain(null);
    expect(dynamic?.enum).toContain('mf');
    expect(entryOf('pattern_set_note_frets', 'frets').properties?.fret?.type).toBe('integer');
  });

  /**
   * The defect this whole change was made against: `pattern-fix-timing` has to
   * correct EVERY note, and one call per note runs the harness out of iterations
   * half-way and reports `max_iters`, which reads as a model failure and is not
   * one. Asserted as a property of the registry rather than of four names, so a
   * future singular write tool fails here rather than in a run.
   */
  it('takes every per-note write as a batch, with no singular twin', () => {
    // The mark of an id-addressed write: a PROPERTY named `noteId`/`noteIds`
    // exists somewhere in the schema. Matched structurally rather than by
    // searching the serialised schema for the substring, which a tool whose
    // description merely mentions note ids would trip, and which a tool that
    // named its argument `id` would slip past. `pattern_open_blank`,
    // `pattern_stamp_notes`, `pattern_set_playback` and `pattern_set_instrument`
    // address no note by id and are not in scope.
    const namesANote = (schema: JsonSchema | undefined): boolean =>
      Object.entries(schema?.properties ?? {}).some(
        ([key, property]) =>
          key === 'noteId' ||
          key === 'noteIds' ||
          namesANote(property) ||
          namesANote(property.items),
      );
    const perNote = AGENT_TOOLS.filter((tool) => namesANote(tool.parameters));
    expect(perNote.map((tool) => tool.name)).toEqual([
      'pattern_move_notes',
      'pattern_resize_notes',
      'pattern_set_note_frets',
      'pattern_delete_notes',
      'pattern_set_articulations',
      'pattern_set_dynamics',
      'pattern_set_pitches',
    ]);

    for (const tool of perNote) {
      // `noteId` at the TOP level is the singular write this rules out. A second
      // top-level argument is NOT ruled out — a batch tool that also took, say,
      // a shared `snapToGrid` would be legitimate — so the assertion is about
      // where the note id lives, not about how many arguments there are.
      const properties = Object.entries(tool.parameters.properties ?? {});
      const singular = properties.some(([key]) => key === 'noteId');
      expect(`${tool.name}: ${singular ? 'singular' : 'batch'}`).toBe(`${tool.name}: batch`);
      const batch = properties.find(([, property]) => property.type === 'array');
      expect(`${tool.name}: ${batch?.[1].type}`).toBe(`${tool.name}: array`);
      expect(tool.parameters.required).toContain(batch?.[0]);
    }
  });
});

// ------------------------------------------------------------------- reading ---

describe('reading', () => {
  it('refuses readably when nothing is open', () => {
    expect(reason(call('read_pattern'))).toBe('No pattern is open.');
    expect(reason(call('read_composition'))).toBe('No composition is open.');
  });

  it('reports notes by id, and says which end of stringIndex is the low E', () => {
    seedPattern('Riff', 7);
    const pattern = value(call('read_pattern'));

    expect(pattern.name).toBe('Riff');
    expect(pattern.ticksPerQuarterNote).toBe(PPQ);
    // The mistake that still looks plausible when it is backwards, so the read
    // states it every time — WITH the reentrant caveat, because "index 0 is the
    // lowest-pitched string" is false on a standard ukulele and a model that
    // believes it reaches for the wrong end of a chord shape.
    expect(pattern.strings).toMatch(/index 0 = the bottom string/);
    expect(pattern.strings).toMatch(/reentrant ukulele/);
    const notes = rows(pattern.notes);
    expect(notes).toHaveLength(1);
    expect(notes[0].fret).toBe(7);
    expect(typeof notes[0].noteId).toBe('string');
  });

  it('lists the library the placement tool places from', () => {
    const patternId = seedPattern('Library riff');
    const library = rows(value(call('read_pattern_library')).patterns);
    expect(library.map((entry) => entry.patternId)).toContain(patternId);
    expect(library[0].noteCount).toBe(1);
  });
});

// -------------------------------------------------------------- refusals ---

describe('refusals reach the caller as sentences', () => {
  it('refuses an unknown note id, and says WHICH id it could not find', () => {
    seedPattern('Riff');
    // The id is in the sentence. A batch of twenty that comes back "No such
    // note." tells the model nothing it can act on — which of the twenty? — and
    // naming them is the whole product of this layer.
    for (const refused of [
      reason(call('pattern_move_notes', { moves: [{ noteId: 'ev_nope', tick: 0 }] })),
      reason(call('pattern_set_dynamics', { dynamics: [{ noteId: 'ev_nope', dynamic: 'f' }] })),
      reason(call('pattern_resize_notes', { resizes: [{ noteId: 'ev_nope', durationTicks: PPQ }] })),
      reason(call('pattern_set_note_frets', { frets: [{ noteId: 'ev_nope', fret: 3 }] })),
      reason(call('pattern_set_articulations', { notes: [{ noteId: 'ev_nope', ghost: true }] })),
      reason(call('pattern_set_pitches', { pitches: [{ noteId: 'ev_nope' }] })),
    ]) {
      expect(refused).toContain('ev_nope');
      expect(refused).toContain('No such note.');
    }
  });

  it('refuses an unknown track and an unknown block', () => {
    value(call('composition_open_blank', { name: 'Song' }));
    expect(reason(call('composition_rename_track', { trackId: 'no', name: 'Bass' }))).toBe(
      'No such track.',
    );
    expect(
      reason(call('composition_transpose_placement', { placementId: 'no', semitones: 2 })),
    ).toBe('No such block in this composition.');
  });

  it('refuses the track cap, and says WHY the cap exists', () => {
    value(call('composition_open_blank', { name: 'Song' }));
    // One track exists already — the lib's model invariant is never zero.
    for (let i = 1; i < MAX_COMPOSITION_TRACKS; i++) value(call('composition_add_track', {}));
    expect(rows(value(call('read_composition')).tracks)).toHaveLength(MAX_COMPOSITION_TRACKS);

    const refused = reason(call('composition_add_track', {}));
    expect(refused).toContain(`at most ${MAX_COMPOSITION_TRACKS} tracks`);
    // A memory limit someone can plan around, not an arbitrary number.
    expect(refused).toContain('sample bank');
  });

  /**
   * ⚠ THE POINTER TRAP, refused at the tool rather than at the seam.
   *
   * The lib keeps ONE pattern-editing pointer and `openPatternForEditing` nulls
   * `editingPlacementId`, so a run that opened a new pattern while a composition
   * BLOCK was open would silently repoint the editor: `writePatternBack` stops
   * routing to the placement's snapshot and every later stamp lands in a library
   * pattern nobody is looking at, outside the composition rollback. The
   * composition page's edit mode runs the pattern commands against a block, so
   * this is one model decision away — `Command.tools` is documented as not
   * enforcement.
   *
   * The SEAM stays permissive: a user starting a new pattern with a block open
   * is a legitimate move (tests/EditMode). This is a rule about agent runs.
   */
  it('refuses to open a new pattern while a composition block is open', () => {
    const patternId = seedPattern('Riff');
    value(call('composition_open_blank', { name: 'Song' }));
    const trackId = rows(value(call('read_composition')).tracks)[0].trackId as string;
    const placed = rows(
      value(call('composition_place_pattern', { patternId, trackId, atTicks: [0] })).placed,
    );
    const placementId = placed[0].placementId as string;
    expect(openPlacementForEditing(placementId).ok).toBe(true);

    const refused = reason(call('pattern_open_blank', { name: 'Somewhere else' }));
    expect(refused).toContain('A composition block is open');
    // Actionable, which is the whole product of a refusal: it names the route
    // the model should have taken.
    expect(refused).toContain('stamp your notes into the pattern that is already open');
    // And the pointer is exactly where it was.
    expect(usePatternsStore.getState().editingPlacementId).toBe(placementId);

    closePlacementEditing();
    // With the block closed it is an ordinary capability again.
    value(call('pattern_open_blank', { name: 'Somewhere else' }));
  });

  it('refuses a write to a built-in voice, and says what to do instead', () => {
    value(call('composition_open_blank', { name: 'Song' }));
    const trackId = rows(value(call('read_composition')).tracks)[0].trackId as string;
    const voices = rows(value(call('voice_list_for_track', { trackId })).voices);
    const builtIn = voices.find((voice) => voice.builtIn === true);
    expect(builtIn).toBeDefined();

    const key = builtIn?.voiceKey as string;
    expect(key.startsWith('default:')).toBe(true);
    // The fourteen slot presets are readonly lib consts with no setter anywhere
    // in the lib, so this is a refusal and not a disabled button.
    for (const refused of [
      reason(call('voice_rename', { voiceKey: key, name: 'Mine' })),
      reason(call('voice_delete', { trackId, voiceKey: key })),
    ]) {
      expect(refused).toContain('built-in');
      expect(refused).toContain('Save it as a new voice');
    }
  });

  it('refuses a string the instrument has not got, rather than losing the note', () => {
    seedPattern('Riff');
    // The lib stores an out-of-range string index quite happily; nothing draws
    // it and nothing plays it. Only the seam can turn that into a sentence.
    const refused = reason(
      call('pattern_stamp_notes', {
        notes: [{ stringIndex: 9, fret: 3, tick: 0, durationTicks: PPQ }],
      }),
    );
    expect(refused).toContain('String 9 does not exist');
    expect(rows(value(call('read_pattern')).notes)).toHaveLength(1);
  });

  it('refuses a fret the app has no room for, and prices one the neck cannot reach', () => {
    // Two different bounds, and conflating them is the bug: `MAX_FRET` is the
    // app's and is refused; the INSTRUMENT's neck is shorter, and a note above
    // it is legal, editable, drawn by nothing and played by nothing — so it is
    // reported rather than refused, exactly as the editor treats one.
    seedPattern('Riff');
    const guitar = INSTRUMENTS.find((instrument) => instrument.id === 'guitar');
    expect(value(call('read_pattern')).frets).toBe(guitar?.fretCount);
    expect(value(call('read_pattern')).notesAboveTheNeck).toBe(0);

    expect(
      reason(
        call('pattern_stamp_notes', {
          notes: [{ stringIndex: 1, fret: 30, tick: 0, durationTicks: PPQ }],
        }),
      ),
    ).toContain('Fret 30 does not exist');

    const placed = value(
      call('pattern_stamp_notes', {
        notes: [{ stringIndex: 1, fret: 24, tick: 0, durationTicks: PPQ }],
      }),
    );
    expect(rows(placed.placed)[0].aboveTheNeck).toBe(true);
    expect(value(call('read_pattern')).notesAboveTheNeck).toBe(1);

    // The neck moves with the instrument — a ukulele's is shorter still, so the
    // same note costs more without anything about the note changing.
    value(call('pattern_set_instrument', { instrumentId: 'ukulele' }));
    const ukulele = INSTRUMENTS.find((instrument) => instrument.id === 'ukulele');
    expect(value(call('read_pattern')).frets).toBe(ukulele?.fretCount);
    expect(value(call('read_pattern')).notesAboveTheNeck).toBe(1);

    const raised = value(
      call('pattern_set_note_frets', {
        frets: [{ noteId: rows(value(call('read_pattern')).notes)[0].noteId, fret: 20 }],
      }),
    );
    expect(rows(raised.applied)[0].aboveTheNeck).toBe(true);
  });

  it('refuses an instrument the lib has not got, without relying on the validator', () => {
    // The schema rejects this first in production; the refusal has to exist at
    // the SEAM as well, because a cast that only a validator makes safe is a
    // rule the next caller walks past.
    seedPattern('Riff');
    expect(reason(call('pattern_set_instrument', { instrumentId: 'theremin' }))).toContain(
      'No such instrument',
    );
    value(call('composition_open_blank', { name: 'Song' }));
    const trackId = rows(value(call('read_composition')).tracks)[0].trackId as string;
    expect(reason(call('composition_add_track', { instrumentId: 'theremin' }))).toContain(
      'No such instrument',
    );
    expect(
      reason(call('composition_set_track_instrument', { trackId, instrumentId: 'theremin' })),
    ).toContain('No such instrument');
  });

  it('refuses a blank track name rather than making two headers identical', () => {
    value(call('composition_open_blank', { name: 'Song' }));
    expect(reason(call('composition_add_track', { name: '   ' }))).toBe('A track needs a name.');
    expect(rows(value(call('read_composition')).tracks)).toHaveLength(1);
  });

  it('names the missing composition rather than blaming the ids it was given', () => {
    // The lib returns the same null for "nothing is open" as for "no such
    // pattern", and telling a caller to check ids it got right is the
    // unrecoverable kind of wrong answer.
    const patternId = seedPattern('Riff');
    expect(
      reason(call('composition_place_pattern', { patternId, trackId: 'anything', atTicks: [0] })),
    ).toBe('No composition is open.');
  });

  it('reports the note that could not be placed without losing the ones that could', () => {
    seedPattern('Riff');
    const result = value(
      call('pattern_stamp_notes', {
        notes: [
          // Straight onto the seeded note — one string cannot ring twice.
          { stringIndex: 0, fret: 3, tick: 0, durationTicks: PPQ },
          { stringIndex: 1, fret: 3, tick: 0, durationTicks: PPQ },
        ],
      }),
    );
    expect(rows(result.placed)).toHaveLength(1);
    const refused = rows(result.refused);
    expect(refused).toHaveLength(1);
    expect(refused[0].index).toBe(0);
    expect(refused[0].tick).toBe(0);
    // NO `repeatIndex` on a call that sent no repeat. A "1" here names a
    // dimension the model never used, in the one field it has to act on.
    expect(refused[0].repeatIndex).toBeUndefined();
    expect(refused[0].reason).toContain('already sounding');
  });
});

// ------------------------------------------------------------ undo batching ---

describe('one tool call is one undo step', () => {
  it('collapses a whole stamped phrase into a single step', () => {
    seedPattern('Riff');
    clearPatternHistory();

    value(
      call('pattern_stamp_notes', {
        notes: [
          { stringIndex: 1, fret: 3, tick: 0, durationTicks: PPQ },
          { stringIndex: 2, fret: 5, tick: PPQ, durationTicks: PPQ },
          { stringIndex: 3, fret: 7, tick: PPQ * 2, durationTicks: PPQ },
        ],
      }),
    );
    expect(rows(value(call('read_pattern')).notes)).toHaveLength(4);

    patternUndo();
    expect(rows(value(call('read_pattern')).notes)).toHaveLength(1);
    expect(canUndoPattern()).toBe(false);
  });

  it('stays one step when tool calls nest inside an outer gesture', () => {
    // THE REASON `patternService` COUNTS BRACKET DEPTH (added by AG-04). Each
    // tool brackets itself; a command that calls two of them brackets those.
    // Without the count, the first inner close would end the OUTER gesture and
    // everything after it would push its own step — one command, three undos.
    seedPattern('Riff');
    clearPatternHistory();

    const notes = (tick: number) => ({
      notes: [{ stringIndex: 1, fret: 3, tick, durationTicks: PPQ }],
    });

    beginPatternGesture();
    value(call('pattern_stamp_notes', notes(0)));
    value(call('pattern_stamp_notes', notes(PPQ * 4)));
    endPatternGesture();
    expect(rows(value(call('read_pattern')).notes)).toHaveLength(3);

    patternUndo();
    expect(rows(value(call('read_pattern')).notes)).toHaveLength(1);
    expect(canUndoPattern()).toBe(false);
  });

  it('survives a switch of edit target in the middle of an outer gesture', () => {
    // `pattern_open_blank` CLEARS the history — it is per-pattern — from inside
    // whatever bracket the caller opened. Dropping the bracket depth there would
    // orphan the outer gesture: every tool after it opens and closes its own,
    // pushes its own step, and the outer close finds nothing. One command, three
    // undos, which is the exact failure the depth count exists to prevent.
    seedPattern('Riff');
    clearPatternHistory();

    beginPatternGesture();
    value(call('pattern_open_blank', { name: 'Second' }));
    value(
      call('pattern_stamp_notes', {
        notes: [{ stringIndex: 0, fret: 3, tick: 0, durationTicks: PPQ }],
      }),
    );
    value(
      call('pattern_stamp_notes', {
        notes: [{ stringIndex: 1, fret: 5, tick: 0, durationTicks: PPQ }],
      }),
    );
    endPatternGesture();
    expect(rows(value(call('read_pattern')).notes)).toHaveLength(2);

    patternUndo();
    expect(rows(value(call('read_pattern')).notes)).toHaveLength(0);
    expect(canUndoPattern()).toBe(false);
  });

  it('keeps a whole arrangement command to one step across a composition switch', () => {
    // The AG-05 shape: open a composition, add tracks, place blocks — one
    // command. `composition_open_blank` clears the composition history the same
    // way, and the same orphaning applies.
    const patternId = seedPattern('Riff');
    clearCompositionHistory();

    beginCompositionGesture();
    value(call('composition_open_blank', { name: 'Song' }));
    const added = value(call('composition_add_track', { name: 'Bass' }));
    value(
      call('composition_place_pattern', {
        patternId,
        trackId: added.trackId,
        atTicks: [0, PPQ * 16],
      }),
    );
    endCompositionGesture();
    expect(rows(value(call('read_composition')).tracks)).toHaveLength(2);

    compositionUndo();
    // Back to the freshly-opened composition: one track, nothing on it.
    const tracks = rows(value(call('read_composition')).tracks);
    expect(tracks).toHaveLength(1);
    expect(rows(tracks[0].blocks)).toHaveLength(0);
    expect(canUndoComposition()).toBe(false);
  });

  it('leaves no undo step behind a write the lib refused', () => {
    // The seam snapshots BEFORE it can know the lib will reject an overlapping
    // move, so an unbracketed refusal grows the user's undo stack with a step
    // that restores the state it never left.
    seedPattern('Riff');
    const second = rows(
      value(
        call('pattern_stamp_notes', {
          notes: [{ stringIndex: 0, fret: 7, tick: PPQ * 2, durationTicks: PPQ }],
        }),
      ).placed,
    )[0].noteId as string;
    clearPatternHistory();

    expect(reason(call('pattern_move_notes', { moves: [{ noteId: second, tick: 0 }] }))).toContain(
      'overlap',
    );
    expect(canUndoPattern()).toBe(false);
  });

  it('collapses a delete of several notes into a single step, all or nothing', () => {
    seedPattern('Riff');
    value(
      call('pattern_stamp_notes', {
        notes: [
          { stringIndex: 1, fret: 3, tick: 0, durationTicks: PPQ },
          { stringIndex: 2, fret: 5, tick: 0, durationTicks: PPQ },
        ],
      }),
    );
    clearPatternHistory();
    const ids = rows(value(call('read_pattern')).notes).map((note) => note.noteId as string);
    expect(ids).toHaveLength(3);

    // One bad id refuses the whole call — a caller that cannot see the pattern
    // has no way to tell a partial delete from a complete one.
    expect(
      reason(call('pattern_delete_notes', { noteIds: [ids[0], 'ev_nope'] })),
    ).toContain('No such note');
    expect(rows(value(call('read_pattern')).notes)).toHaveLength(3);
    expect(canUndoPattern()).toBe(false);

    const deleted = value(call('pattern_delete_notes', { noteIds: [ids[0], ids[1]] }));
    expect(deleted.deleted).toBe(2);
    expect(rows(value(call('read_pattern')).notes)).toHaveLength(1);

    patternUndo();
    expect(rows(value(call('read_pattern')).notes)).toHaveLength(3);
    expect(canUndoPattern()).toBe(false);

    // A repeated id deletes one note once, and says so.
    expect(value(call('pattern_delete_notes', { noteIds: [ids[2], ids[2]] })).deleted).toBe(1);
  });

  it('collapses a multi-placement drop into a single step', () => {
    const patternId = seedPattern('Riff');
    value(call('composition_open_blank', { name: 'Song' }));
    const trackId = rows(value(call('read_composition')).tracks)[0].trackId as string;
    clearCompositionHistory();

    const placed = value(
      call('composition_place_pattern', {
        patternId,
        trackId,
        atTicks: [0, PPQ * 8, PPQ * 16],
      }),
    );
    expect(rows(placed.placed)).toHaveLength(3);
    expect(rows(rows(value(call('read_composition')).tracks)[0].blocks)).toHaveLength(3);

    compositionUndo();
    expect(rows(rows(value(call('read_composition')).tracks)[0].blocks)).toHaveLength(0);
    expect(canUndoComposition()).toBe(false);
  });
});

// ------------------------------------------------------------ note editing ---

describe('editing notes by id', () => {
  it('moves a note, and refuses a move onto a string that is already sounding', () => {
    seedPattern('Riff');
    const second = rows(
      value(
        call('pattern_stamp_notes', {
          notes: [{ stringIndex: 0, fret: 7, tick: PPQ * 2, durationTicks: PPQ }],
        }),
      ).placed,
    )[0].noteId as string;

    const moved = value(call('pattern_move_notes', { moves: [{ noteId: second, tick: PPQ * 4 }] }));
    expect(rows(moved.applied)[0]).toEqual({
      noteId: second,
      startTick: PPQ * 4,
      stringIndex: 0,
    });

    // Onto the seeded note. The lib REJECTS this (the group move clamps, this
    // one does not), leaving the note where it was — which is only visible by
    // reading it back.
    const refused = reason(call('pattern_move_notes', { moves: [{ noteId: second, tick: 0 }] }));
    expect(refused).toContain('overlap');
    const notes = rows(value(call('read_pattern')).notes);
    expect(notes.find((note) => note.noteId === second)?.tick).toBe(PPQ * 4);

    // A move to another string is a move, not a refusal.
    const across = value(
      call('pattern_move_notes', { moves: [{ noteId: second, tick: 0, stringIndex: 3 }] }),
    );
    expect(rows(across.applied)[0]).toEqual({ noteId: second, startTick: 0, stringIndex: 3 });
  });

  it('reports the duration a resize actually kept', () => {
    seedPattern('Riff');
    const noteId = rows(value(call('read_pattern')).notes)[0].noteId as string;
    expect(
      rows(value(call('pattern_resize_notes', { resizes: [{ noteId, durationTicks: PPQ * 2 }] }))
        .applied)[0].durationTicks,
    ).toBe(PPQ * 2);

    // Clamped against the next note on the same string, so the request is
    // honoured in part and the reply says by how much.
    value(
      call('pattern_stamp_notes', {
        notes: [{ stringIndex: 0, fret: 7, tick: PPQ * 4, durationTicks: PPQ }],
      }),
    );
    expect(
      rows(value(call('pattern_resize_notes', { resizes: [{ noteId, durationTicks: PPQ * 16 }] }))
        .applied)[0].durationTicks,
    ).toBe(PPQ * 4);
  });

  it('changes only the articulations it was sent, and clears with null', () => {
    seedPattern('Riff');
    const noteId = rows(value(call('read_pattern')).notes)[0].noteId as string;

    value(call('pattern_set_articulations', { notes: [{ noteId, palmMute: true, ghost: true }] }));
    const first = rows(value(call('read_pattern')).notes)[0].articulations as string[];
    expect(first).toContain('palmMute');
    expect(first).toContain('ghost');

    // An ABSENT key leaves the field alone; `null` clears one. Sending every
    // field unconditionally would wipe `palmMute` here, which is the whole
    // reason the patch is built by conditional spread.
    value(call('pattern_set_articulations', { notes: [{ noteId, ghost: null }] }));
    const second = rows(value(call('read_pattern')).notes)[0].articulations as string[];
    expect(second).toContain('palmMute');
    expect(second).not.toContain('ghost');

    value(call('pattern_set_articulations', { notes: [{ noteId, vibrato: 'wide' }] }));
    expect(rows(value(call('read_pattern')).notes)[0].articulations).toContain('vibrato:wide');
  });

  it('replaces a note’s pitch movement, and clears it when sent nothing', () => {
    seedPattern('Riff');
    const noteId = rows(value(call('read_pattern')).notes)[0].noteId as string;

    value(
      call('pattern_set_pitches', {
        pitches: [{ noteId, slideIn: 'below', bend: { kind: 'bend', semitones: 2 } }],
      }),
    );
    const flags = rows(value(call('read_pattern')).notes)[0].articulations as string[];
    expect(flags).toContain('slideIn:below');
    expect(flags.some((flag) => flag.startsWith('bend:'))).toBe(true);

    // The tool REPLACES rather than patches, so no movement means none.
    value(call('pattern_set_pitches', { pitches: [{ noteId }] }));
    expect(rows(value(call('read_pattern')).notes)[0].articulations).toBeUndefined();
  });

  it('sets a dynamic and clears it', () => {
    seedPattern('Riff');
    const noteId = rows(value(call('read_pattern')).notes)[0].noteId as string;
    value(call('pattern_set_dynamics', { dynamics: [{ noteId, dynamic: 'ff' }] }));
    expect(rows(value(call('read_pattern')).notes)[0].dynamic).toBe('ff');
    value(call('pattern_set_dynamics', { dynamics: [{ noteId, dynamic: null }] }));
    expect(rows(value(call('read_pattern')).notes)[0].dynamic).toBe(null);
  });
});

// -------------------------------------------------------- batched editing ---

/**
 * The reason the per-note writes are plural at all: `pattern-fix-timing` and
 * `pattern-fit-key` have to touch EVERY note, and one call per note runs the
 * harness out of iterations half-way through. These check the three things a
 * batch has to get right — one undo step, partial application, and a refusal
 * that names the notes it is about.
 */
describe('editing many notes in one call', () => {
  /** Four notes on four strings, one per beat, and the ids in that order. */
  function seedFour(): string[] {
    seedPattern('Riff');
    value(
      call('pattern_stamp_notes', {
        notes: [1, 2, 3].map((index) => ({
          stringIndex: index,
          fret: 3 + index,
          tick: PPQ * index,
          durationTicks: PPQ,
        })),
      }),
    );
    const notes = rows(value(call('read_pattern')).notes);
    expect(notes).toHaveLength(4);
    return notes.map((note) => note.noteId as string);
  }

  it('applies a whole batch of moves as ONE undo step', () => {
    const ids = seedFour();
    clearPatternHistory();

    const moved = value(
      call('pattern_move_notes', {
        moves: ids.map((noteId, index) => ({ noteId, tick: PPQ * (index + 8) })),
      }),
    );
    expect(rows(moved.applied)).toHaveLength(4);
    expect(rows(moved.refused)).toHaveLength(0);
    const after = rows(value(call('read_pattern')).notes);
    expect(after.map((note) => note.tick).sort((a, b) => Number(a) - Number(b))).toEqual([
      PPQ * 8,
      PPQ * 9,
      PPQ * 10,
      PPQ * 11,
    ]);

    // ONE press, not four. Four steps here is the defect that the depth count in
    // `patternService` and the single bracket per tool call exist to prevent.
    patternUndo();
    const restored = rows(value(call('read_pattern')).notes);
    expect(restored.map((note) => note.tick).sort((a, b) => Number(a) - Number(b))).toEqual([
      0,
      PPQ,
      PPQ * 2,
      PPQ * 3,
    ]);
    expect(canUndoPattern()).toBe(false);
  });

  /**
   * The configuration that `seedFour` cannot reach, and the only one where the
   * ORDER of a batch can decide whether it works: several notes on ONE string.
   *
   * The lib rejects a move onto a span another note still occupies, judged
   * against the pattern as it stands at that instant — so a phrase nudged LATER
   * on one string refuses every note but the last if the batch is applied in a
   * single pass, which is precisely the job `pattern-fix-timing` sends and
   * precisely the order `read_pattern` hands the notes back in.
   */
  it('applies a batch on ONE string whatever order it arrives in', () => {
    value(call('pattern_open_blank', { name: 'Rushed' }));
    value(
      call('pattern_stamp_notes', {
        notes: [1, 2, 3, 4].map((beat) => ({
          stringIndex: 0,
          fret: 5,
          // Ten ticks ahead of the beat, back to back — the note behind each one
          // is what blocks it, and a single pass would land only the last.
          tick: PPQ * beat - 10,
          durationTicks: PPQ,
        })),
      }),
    );
    const ids = rows(value(call('read_pattern')).notes).map((note) => note.noteId as string);
    expect(ids).toHaveLength(4);
    clearPatternHistory();

    const moved = value(
      call('pattern_move_notes', {
        moves: ids.map((noteId, index) => ({ noteId, tick: PPQ * (index + 1) })),
      }),
    );
    expect(rows(moved.refused)).toHaveLength(0);
    expect(rows(moved.applied)).toHaveLength(4);
    expect(rows(value(call('read_pattern')).notes).map((note) => note.tick)).toEqual([
      PPQ,
      PPQ * 2,
      PPQ * 3,
      PPQ * 4,
    ]);

    // Retried passes are still inside the one bracket.
    patternUndo();
    expect(rows(value(call('read_pattern')).notes).map((note) => note.tick)).toEqual([
      PPQ - 10,
      PPQ * 2 - 10,
      PPQ * 3 - 10,
      PPQ * 4 - 10,
    ]);
    expect(canUndoPattern()).toBe(false);
  });

  it('applies the edits it can and names the ones it could not', () => {
    // THE PARTIAL-FAILURE RULE, which is the design decision this batching
    // forced: the seventeen that work land, and the three that do not come back
    // by id with the seam's own sentence. Refusing the whole call would cost the
    // round trips the batch exists to save, and (LIB-GAP(20)) could only be
    // implemented by writing and rolling back.
    const ids = seedFour();
    clearPatternHistory();

    const result = value(
      call('pattern_set_note_frets', {
        frets: [
          { noteId: ids[0], fret: 9 },
          { noteId: 'ev_nope', fret: 9 },
          { noteId: ids[2], fret: 11 },
        ],
      }),
    );

    const applied = rows(result.applied);
    expect(applied.map((entry) => entry.noteId)).toEqual([ids[0], ids[2]]);
    expect(applied.map((entry) => entry.fret)).toEqual([9, 11]);

    const refused = rows(result.refused);
    expect(refused).toHaveLength(1);
    expect(refused[0].noteId).toBe('ev_nope');
    expect(refused[0].reason).toBe('No such note.');

    // The two that landed really landed, and undo takes both back together.
    const frets = new Map(
      rows(value(call('read_pattern')).notes).map((note) => [note.noteId, note.fret]),
    );
    expect(frets.get(ids[0])).toBe(9);
    expect(frets.get(ids[2])).toBe(11);
    patternUndo();
    expect(rows(value(call('read_pattern')).notes).map((note) => note.fret)).toEqual([5, 4, 5, 6]);
    expect(canUndoPattern()).toBe(false);
  });

  /**
   * The other half of the partial-failure rule. The `ev_nope` case above is
   * refused at the id check, BEFORE anything is written; this one is declined by
   * the lib AFTER `capture()` and after the store write (LIB-GAP(20): the op
   * returns the pattern unchanged), which is where "a step was pushed and the
   * refused note is untouched" actually has to hold.
   */
  it('applies the rest when the LIB declines a move, and leaves that note alone', () => {
    const ids = seedFour();
    clearPatternHistory();

    const result = value(
      call('pattern_move_notes', {
        moves: [
          // Onto string 1, where ids[1] sits at PPQ and is not going anywhere in
          // this batch — so no number of retries can free it.
          { noteId: ids[0], tick: PPQ, stringIndex: 1 },
          { noteId: ids[2], tick: PPQ * 8 },
          { noteId: ids[3], tick: PPQ * 9 },
        ],
      }),
    );

    expect(rows(result.applied).map((entry) => entry.noteId)).toEqual([ids[2], ids[3]]);
    const refused = rows(result.refused);
    expect(refused).toHaveLength(1);
    expect(refused[0].noteId).toBe(ids[0]);
    expect(refused[0].reason).toContain('overlap');

    const before = new Map(
      rows(value(call('read_pattern')).notes).map((note) => [note.noteId, note.tick]),
    );
    // Untouched: still on string 0 at 0, not half-moved.
    expect(before.get(ids[0])).toBe(0);
    expect(before.get(ids[2])).toBe(PPQ * 8);

    patternUndo();
    expect(
      rows(value(call('read_pattern')).notes)
        .map((note) => Number(note.tick))
        .sort((a, b) => a - b),
    ).toEqual([0, PPQ, PPQ * 2, PPQ * 3]);
    expect(canUndoPattern()).toBe(false);
  });

  it('refuses — rather than reporting an empty success — when nothing applied', () => {
    // `ok` with an empty `applied` is the unrecoverable answer: it reads to a
    // model as "done". A batch where every entry was refused is a refusal, and
    // it carries every note and every reason.
    const ids = seedFour();
    clearPatternHistory();

    const refused = reason(
      call('pattern_move_notes', {
        // Both onto notes that are already sounding there — the lib declines the
        // move and leaves each note where it was.
        moves: [
          { noteId: ids[0], tick: PPQ, stringIndex: 1 },
          { noteId: ids[2], tick: PPQ * 3, stringIndex: 3 },
        ],
      }),
    );
    expect(refused).toContain(ids[0]);
    expect(refused).toContain(ids[2]);
    expect(refused).toContain('overlap');

    // Nothing moved, so nothing to undo. A step here would restore a state the
    // pattern never left, and would cost the user a press to discover that.
    expect(rows(value(call('read_pattern')).notes).map((note) => note.tick)).toEqual([
      0,
      PPQ,
      PPQ * 2,
      PPQ * 3,
    ]);
    expect(canUndoPattern()).toBe(false);
  });

  it('marks a whole articulation pass in one call, one step', () => {
    const ids = seedFour();
    clearPatternHistory();

    const marked = value(
      call('pattern_set_articulations', {
        notes: ids.map((noteId) => ({ noteId, palmMute: true })),
      }),
    );
    expect(rows(marked.applied)).toHaveLength(4);
    for (const note of rows(value(call('read_pattern')).notes)) {
      expect(note.articulations).toContain('palmMute');
    }

    patternUndo();
    for (const note of rows(value(call('read_pattern')).notes)) {
      expect(note.articulations).toBeUndefined();
    }
    expect(canUndoPattern()).toBe(false);
  });

  // Asserted on its own, and with its own undo: `pattern_set_dynamics` and
  // `pattern_set_pitches` had NO gesture at all before they became batches, so
  // "four steps instead of one" is a live mutation here and is invisible if the
  // undo is shared with a later call's step.
  it('shapes every dynamic in one call, one step', () => {
    const ids = seedFour();
    clearPatternHistory();

    value(
      call('pattern_set_dynamics', {
        dynamics: ids.map((noteId, index) => ({ noteId, dynamic: index < 2 ? 'p' : 'ff' })),
      }),
    );
    expect(rows(value(call('read_pattern')).notes).map((note) => note.dynamic)).toEqual([
      'p',
      'p',
      'ff',
      'ff',
    ]);

    expect(canUndoPattern()).toBe(true);
    patternUndo();
    expect(rows(value(call('read_pattern')).notes).map((note) => note.dynamic)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(canUndoPattern()).toBe(false);
  });

  it('sets pitch movement on every note in one call, one step', () => {
    const ids = seedFour();
    clearPatternHistory();

    const set = value(
      call('pattern_set_pitches', {
        pitches: ids.map((noteId) => ({ noteId, slideOut: 'down' })),
      }),
    );
    expect(rows(set.applied)).toHaveLength(4);
    for (const note of rows(value(call('read_pattern')).notes)) {
      expect(note.articulations).toContain('slideOut:down');
    }

    patternUndo();
    for (const note of rows(value(call('read_pattern')).notes)) {
      expect(note.articulations).toBeUndefined();
    }
    expect(canUndoPattern()).toBe(false);
  });

  it('sets every length in one call, one step', () => {
    const ids = seedFour();
    clearPatternHistory();

    const resized = value(
      call('pattern_resize_notes', {
        resizes: ids.map((noteId) => ({ noteId, durationTicks: PPQ / 2 })),
      }),
    );
    expect(rows(resized.applied).map((entry) => entry.durationTicks)).toEqual([
      PPQ / 2,
      PPQ / 2,
      PPQ / 2,
      PPQ / 2,
    ]);

    expect(canUndoPattern()).toBe(true);
    patternUndo();
    expect(rows(value(call('read_pattern')).notes).map((note) => note.durationTicks)).toEqual([
      PPQ,
      PPQ,
      PPQ,
      PPQ,
    ]);
    expect(canUndoPattern()).toBe(false);
  });

  /**
   * A stamp has no id to name an entry by, so the refusal names the string and
   * tick the model itself sent — EVERY one of them. One reason out of a phrase
   * that failed end to end leaves the model re-sending blind, which is the same
   * unrecoverable answer the plural writes exist to avoid.
   */
  it('names every entry of a stamp that placed nothing at all', () => {
    seedPattern('Riff');
    value(
      call('pattern_stamp_notes', {
        notes: [{ stringIndex: 1, fret: 7, tick: 0, durationTicks: PPQ }],
      }),
    );
    clearPatternHistory();

    const refused = reason(
      call('pattern_stamp_notes', {
        notes: [
          { stringIndex: 0, fret: 3, tick: 0, durationTicks: PPQ },
          { stringIndex: 1, fret: 3, tick: 0, durationTicks: PPQ },
        ],
      }),
    );
    expect(refused).toContain('string 0 tick 0');
    expect(refused).toContain('string 1 tick 0');
    // And nothing about repeating, on a call that did not. `toContain` on the
    // labels above is satisfied by a `repeat 1 ` prefix in front of them, so the
    // absence has to be asserted separately.
    expect(refused).not.toContain('repeat');
    expect(rows(value(call('read_pattern')).notes)).toHaveLength(2);
    expect(canUndoPattern()).toBe(false);
  });

  /**
   * The seam's own sentence, not the tools'. With nothing open every id lookup
   * fails, and answering "No such note." twenty times told the model twenty
   * notes had vanished — unrecoverable — rather than that there was nothing to
   * edit, which it can act on by opening a pattern.
   */
  it('says the pattern is not open rather than that the notes do not exist', () => {
    for (const [tool, args] of [
      ['pattern_move_notes', { moves: [{ noteId: 'ev_1', tick: 0 }] }],
      ['pattern_resize_notes', { resizes: [{ noteId: 'ev_1', durationTicks: PPQ }] }],
      ['pattern_set_note_frets', { frets: [{ noteId: 'ev_1', fret: 3 }] }],
      ['pattern_set_articulations', { notes: [{ noteId: 'ev_1', ghost: true }] }],
      ['pattern_set_dynamics', { dynamics: [{ noteId: 'ev_1', dynamic: 'f' }] }],
      ['pattern_set_pitches', { pitches: [{ noteId: 'ev_1' }] }],
      ['pattern_delete_notes', { noteIds: ['ev_1'] }],
    ] as const) {
      // The batch tools wrap the seam's sentence per entry; `pattern_delete_notes`
      // is all-or-nothing and passes it straight through.
      expect(`${tool}: ${reason(call(tool, args))}`).toContain('No pattern is open.');
    }
  });
});

// ------------------------------------------------------------- arrangement ---

describe('arranging', () => {
  it('reports where a block actually landed rather than where it was aimed', () => {
    const patternId = seedPattern('Riff');
    value(call('composition_open_blank', { name: 'Song' }));
    const trackId = rows(value(call('read_composition')).tracks)[0].trackId as string;
    const placed = value(
      call('composition_place_pattern', { patternId, trackId, atTicks: [0, PPQ * 16] }),
    );
    const second = rows(placed.placed)[1].placementId as string;

    const moved = value(call('composition_move_placement', { placementId: second, trackId, atTick: 0 }));
    expect(moved.trackId).toBe(trackId);
    // Blocks never overlap and never push each other, so the block lands in the
    // nearest free slot — which is the far side of the block already at 0, and
    // NOT the tick that was asked for.
    const blocks = rows(rows(value(call('read_composition')).tracks)[0].blocks);
    const first = blocks.find((block) => block.startTick === 0);
    expect(moved.startTick).not.toBe(0);
    expect(moved.startTick).toBe(first?.endTick);
  });

  it('trims a block, removes blocks and duplicates them, each as one step', () => {
    const patternId = seedPattern('Riff');
    value(call('composition_open_blank', { name: 'Song' }));
    const trackId = rows(value(call('read_composition')).tracks)[0].trackId as string;
    const placed = rows(
      value(
        call('composition_place_pattern', { patternId, trackId, atTicks: [0, PPQ * 16] }),
      ).placed,
    ).map((block) => block.placementId as string);
    clearCompositionHistory();

    // Clamped to at least a beat, so the reply is the length that stuck.
    const trimmed = value(call('composition_resize_placement', {
      placementId: placed[0],
      lengthTicks: 1,
    }));
    expect(trimmed.lengthTicks).toBe(PPQ);

    const copies = value(
      call('composition_duplicate_placements', {
        placementIds: placed,
        deltaTicks: PPQ * 32,
      }),
    );
    expect((copies.placementIds as string[]).length).toBe(2);
    expect(rows(rows(value(call('read_composition')).tracks)[0].blocks)).toHaveLength(4);
    compositionUndo();
    expect(rows(rows(value(call('read_composition')).tracks)[0].blocks)).toHaveLength(2);

    expect(reason(call('composition_remove_placements', { placementIds: ['nope'] }))).toContain(
      'No such block',
    );
    const removed = value(call('composition_remove_placements', { placementIds: placed }));
    expect((removed.removed as string[]).length).toBe(2);
    expect(rows(rows(value(call('read_composition')).tracks)[0].blocks)).toHaveLength(0);
    compositionUndo();
    expect(rows(rows(value(call('read_composition')).tracks)[0].blocks)).toHaveLength(2);
  });

  it('reorders tracks, and refuses to remove the last one', () => {
    value(call('composition_open_blank', { name: 'Song' }));
    const first = rows(value(call('read_composition')).tracks)[0].trackId as string;
    const second = value(call('composition_add_track', { name: 'Bass' })).trackId as string;

    value(call('composition_move_track', { trackId: second, toIndex: 0 }));
    expect(rows(value(call('read_composition')).tracks).map((track) => track.trackId)).toEqual([
      second,
      first,
    ]);

    value(call('composition_remove_track', { trackId: first }));
    expect(rows(value(call('read_composition')).tracks)).toHaveLength(1);
    // The lib's model invariant is at least one track.
    expect(reason(call('composition_remove_track', { trackId: second }))).toBeTruthy();
    expect(rows(value(call('read_composition')).tracks)).toHaveLength(1);
  });

  it('prices a transposition instead of letting notes vanish', () => {
    // LIB-GAP(12): `flattenComposition` drops any note whose transposed fret
    // leaves the neck, silently and with nothing on screen. A caller with no
    // screen has to be told.
    const patternId = seedPattern('Open string riff', 0);
    value(call('composition_open_blank', { name: 'Song' }));
    const trackId = rows(value(call('read_composition')).tracks)[0].trackId as string;
    const placed = value(call('composition_place_pattern', { patternId, trackId, atTicks: [0] }));
    const placementId = rows(placed.placed)[0].placementId as string;

    const down = value(call('composition_transpose_placement', { placementId, semitones: -1 }));
    expect(down.semitones).toBe(-1);
    expect(down.notesDroppedFromPlayback).toBe(1);

    const up = value(call('composition_transpose_placement', { placementId, semitones: 2 }));
    expect(up.notesDroppedFromPlayback).toBe(0);
  });

  it('returns the ids a split mints, because the original stops existing', () => {
    const patternId = seedPattern('Riff');
    value(call('composition_open_blank', { name: 'Song' }));
    const trackId = rows(value(call('read_composition')).tracks)[0].trackId as string;
    const placed = value(call('composition_place_pattern', { patternId, trackId, atTicks: [0] }));
    const placementId = rows(placed.placed)[0].placementId as string;

    const split = value(call('composition_split_placement', { placementId, atTick: PPQ }));
    const ids = (split.placementIds ?? []) as string[];
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(placementId);

    // A cut on the block's own edge is nothing to do, and says so.
    expect(reason(call('composition_split_placement', { placementId: ids[0], atTick: 0 }))).toContain(
      'inside the block',
    );
  });

  it('says what a track change costs in strings, never in audibility', () => {
    // LIB-GAP(15): a track has no tuning — only the composition does — so the
    // honest report is about strings the instrument has not got.
    const patternId = seedPattern('Six-string riff');
    // A note on string 5 — the high E, which a four-string bass has not got.
    value(
      call('pattern_stamp_notes', {
        notes: [{ stringIndex: 5, fret: 3, tick: PPQ, durationTicks: PPQ }],
      }),
    );
    value(call('composition_open_blank', { name: 'Song' }));
    const trackId = rows(value(call('read_composition')).tracks)[0].trackId as string;
    value(call('composition_place_pattern', { patternId, trackId, atTicks: [0] }));

    const changed = value(
      call('composition_set_track_instrument', { trackId, instrumentId: 'bass' }),
    );
    expect(changed.instrumentId).toBe('bass');
    expect(changed.blocksWrittenForAnotherInstrument).toBe(1);
    // One note stranded, not a type. The count is about STRINGS and never about
    // audibility — a track has no tuning of its own (LIB-GAP(15)).
    expect(changed.notesOnStringsThisInstrumentLacks).toBe(1);
    expect(rows(value(call('read_composition')).tracks)[0].notesOnStringsThisInstrumentLacks).toBe(
      1,
    );
  });

  it('applies the mixer by value and clamps what it stores', () => {
    value(call('composition_open_blank', { name: 'Song' }));
    const trackId = rows(value(call('read_composition')).tracks)[0].trackId as string;

    const mixed = value(call('composition_set_track_mix', { trackId, volumeDb: -6, muted: true }));
    expect(mixed.volumeDb).toBe(-6);

    expect(mixed.muted).toBe(true);
    // Read back, so the two fields this call did not send are the track's own
    // and not a null standing in for "not sent".
    expect(mixed.soloed).toBe(false);

    const track = rows(value(call('read_composition')).tracks)[0];
    expect(track.volumeDb).toBe(-6);
    expect(track.muted).toBe(true);
    // Mute beats solo, and the read says what the engine will actually do.
    expect(track.audible).toBe(false);

    const master = value(call('composition_set_master_volume', { volumeDb: 99 }));
    expect(master.volumeDb).toBe(6);
  });

  it('edits a block without touching the pattern it was cut from', () => {
    const patternId = seedPattern('Riff');
    value(call('composition_open_blank', { name: 'Song' }));
    const trackId = rows(value(call('read_composition')).tracks)[0].trackId as string;
    const placed = value(call('composition_place_pattern', { patternId, trackId, atTicks: [0] }));
    const placementId = rows(placed.placed)[0].placementId as string;

    value(call('composition_edit_placement', { placementId }));
    expect(value(call('read_pattern')).editingCompositionBlock).toBe(placementId);
    value(
      call('pattern_stamp_notes', {
        notes: [{ stringIndex: 2, fret: 9, tick: 0, durationTicks: PPQ }],
      }),
    );
    expect(rows(value(call('read_pattern')).notes)).toHaveLength(2);

    value(call('composition_stop_editing_placement'));
    // The library pattern is a separate document — the block holds a deep copy.
    const library = rows(value(call('read_pattern_library')).patterns);
    expect(library.find((entry) => entry.patternId === patternId)?.noteCount).toBe(1);
  });
});

// ------------------------------------------------------------------ voices ---

describe('voices', () => {
  it('saves what a track sounds like, renames it and deletes it, all by id', () => {
    value(call('composition_open_blank', { name: 'Song' }));
    const trackId = rows(value(call('read_composition')).tracks)[0].trackId as string;

    const saved = value(call('voice_save_as', { trackId, name: 'Agent lead' }));
    const voiceKey = saved.voiceKey as string;
    expect(voiceKey.startsWith('user:')).toBe(true);
    expect(rows(value(call('read_composition')).tracks)[0].voiceKey).toBe(voiceKey);

    value(call('voice_rename', { voiceKey, name: 'Agent rhythm' }));
    const listed = rows(value(call('voice_list_for_track', { trackId })).voices);
    expect(listed.find((voice) => voice.voiceKey === voiceKey)?.name).toBe('Agent rhythm');

    value(call('voice_delete', { trackId, voiceKey }));
    // Deleting repairs the track that pointed at it — a dangling ref would
    // resolve silently to something else.
    expect(rows(value(call('read_composition')).tracks)[0].voiceKey).toBe(null);
  });

  it('refuses a voice key that names nothing', () => {
    value(call('composition_open_blank', { name: 'Song' }));
    const trackId = rows(value(call('read_composition')).tracks)[0].trackId as string;
    expect(reason(call('voice_set_for_track', { trackId, voiceKey: 'nonsense' }))).toContain(
      'Not a voice key',
    );
    expect(reason(call('voice_rename', { voiceKey: 'user:gone', name: 'x' }))).toContain(
      'not in your library',
    );
  });
});

// --------------------------------------------------------------- settings ---

describe('settings', () => {
  it('sets tempo, meter, loop and feel in one call, and reports what stuck', () => {
    value(call('composition_open_blank', { name: 'Song' }));
    const applied = value(
      call('composition_set_settings', {
        name: '  Blues in A  ',
        bpm: 80,
        timeSignature: { numerator: 12, denominator: 8 },
        loop: true,
        groove: 'shuffle',
      }),
    );
    // The seam TRIMS, so the reply is the stored name and not the argument.
    expect(applied.name).toBe('Blues in A');
    expect(applied.groove).toBe('shuffle');

    const composition = value(call('read_composition'));
    expect(composition.name).toBe('Blues in A');
    expect(composition.bpm).toBe(80);
    expect(composition.timeSignature).toEqual({ numerator: 12, denominator: 8 });
    expect(composition.loop).toBe(true);
    // The feel is READABLE, not just writable — a capability a caller cannot
    // confirm is one it cannot reason from. The value is the lib's own preset
    // id, matched back off the stored `GrooveSpec`.
    expect(composition.groove).toBe('shuffle');
    expect(GROOVE_PRESETS.map((preset) => preset.id)).toContain(composition.groove);

    value(call('composition_set_settings', { groove: 'straight' }));
    expect(value(call('read_composition')).groove).toBe('straight');
  });

  it('refuses a blank composition name rather than blanking every label', () => {
    value(call('composition_open_blank', { name: 'Song' }));
    expect(reason(call('composition_set_settings', { name: '   ' }))).toBe(
      'A composition needs a name.',
    );
  });

  it('keeps the pattern’s tempo and feel out of undo, and reads the feel back', () => {
    seedPattern('Riff');
    clearPatternHistory();
    const applied = value(
      call('pattern_set_playback', { bpm: 92, loop: false, groove: 'swing-8ths' }),
    );
    expect(applied).toEqual({ bpm: 92, loop: false, groove: 'swing-8ths' });

    const pattern = value(call('read_pattern'));
    expect(pattern.suggestedBpm).toBe(92);
    expect(pattern.loop).toBe(false);
    expect(pattern.groove).toBe('swing-8ths');
    // Settings, not content — the same line the seams draw everywhere else.
    expect(canUndoPattern()).toBe(false);

    // A cleared tempo and an untouched one are different answers, so the reply
    // is read back rather than echoed.
    expect(value(call('pattern_set_playback', { bpm: null })).bpm).toBe(null);
    expect(value(call('pattern_set_playback', { loop: true })).groove).toBe('swing-8ths');
  });
});

// ------------------------------------------------------------- the job lock ---

/**
 * AG-07. The seam refuses the USER's writes while a job owns the document, and
 * these are what has to keep working through it — otherwise the lock refuses the
 * job its own tools.
 *
 * The exemption is a per-handler flag rather than a flag held across the run,
 * because the run is asynchronous and the user's clicks land between its tool
 * calls. That is only sound while handlers are synchronous, which the `AgentTool`
 * type enforces (`run` returns `ToolResult`, never a promise).
 */
describe('agent writes during a job', () => {
  it('lets every composition tool through while refusing the user', () => {
    value(call('composition_open_blank', { name: 'Song' }));
    const patternId = seedPattern('Riff');
    const trackId = rows(value(call('read_composition')).tracks)[0].trackId as string;

    beginJob();

    // A single-write tool. `oneUndoStep` wraps only the three batching tools, so
    // an exemption hung there would refuse this one — which is why it is hung on
    // every tool instead.
    const added = value(call('composition_add_track', { name: 'Bass' }));
    // A batching tool, whose bracket nests inside the job's.
    value(call('composition_place_pattern', { patternId, trackId, atTicks: [0] }));
    // A settings tool, which brackets nothing at all.
    value(call('composition_set_settings', { bpm: 132 }));
    // And edit mode, which the lock covers precisely so the user cannot repoint
    // the lib's one pattern pointer under a job that is creating patterns.
    const blocks = rows(rows(value(call('read_composition')).tracks)[0].blocks);
    value(call('composition_edit_placement', { placementId: blocks[0].placementId }));

    expect(rows(value(call('read_composition')).tracks)).toHaveLength(2);
    expect(added.name).toBe('Bass');

    // Meanwhile the same write reached the way a component reaches it — the
    // seam, directly — is refused.
    const refused = addTrackDirect('Mine');
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toMatch(/generation job/i);

    endJob();
    expect(addTrackDirect('Mine').ok).toBe(true);
  });

  /**
   * The reason the exemption is wrapped over `AGENT_TOOLS` and not over
   * `COMPOSITION_TOOLS`: `voice_set_for_track` is a VOICE tool that writes
   * `Track.voiceRef` through the composition seam, and `composition-track-voice`
   * is a composition command that calls it. Wrapping only the composition list
   * would leave `setTrackVoiceRef` the one unlocked track write — or, once it was
   * locked, refuse that command its own tool.
   */
  it('lets a voice tool through too, since it writes the composition', () => {
    value(call('composition_open_blank', { name: 'Song' }));
    const trackId = rows(value(call('read_composition')).tracks)[0].trackId as string;
    // Two, and the track left pointing at the SECOND: `voiceService` returns ok
    // without writing when the ref is already stored, so setting the one that is
    // already on the track would pass whether the seam was locked or not.
    const first = value(call('voice_save_as', { trackId, name: 'Agent lead' }))
      .voiceKey as string;
    value(call('voice_save_as', { trackId, name: 'Agent rhythm' }));

    beginJob();

    value(call('voice_set_for_track', { trackId, voiceKey: first }));
    expect(rows(value(call('read_composition')).tracks)[0].voiceKey).toBe(first);
    // And the user's hand on the same control is refused, which it was not
    // before — `setTrackVoiceRef` used to be the one track write with no guard.
    expect(setTrackVoiceRefDirect(trackId, null).ok).toBe(false);

    endJob();
    expect(setTrackVoiceRefDirect(trackId, null).ok).toBe(true);
  });

  /** The agent's exemption stops short of a composition SWITCH: `clearHistory`
   *  re-arms the open bracket on the new document, so a job that switched would
   *  have nothing left to roll back to. */
  it('refuses the job a new composition, not just the user', () => {
    value(call('composition_open_blank', { name: 'Song' }));
    const openBefore = usePatternsStore.getState().editingCompositionId;

    beginCompositionGesture();
    beginJob();
    const refused = call('composition_open_blank', { name: 'Stray' });

    expect(refused.ok).toBe(false);
    expect(usePatternsStore.getState().editingCompositionId).toBe(openBefore);
    endJob();
    abortCompositionGesture();
  });

  it('rolls the whole job back as one movement when it is cancelled', () => {
    const patternId = seedPattern('Riff');
    value(call('composition_open_blank', { name: 'Song' }));
    const trackId = rows(value(call('read_composition')).tracks)[0].trackId as string;
    value(call('composition_place_pattern', { patternId, trackId, atTicks: [0] }));
    const before = rows(rows(value(call('read_composition')).tracks)[0].blocks);
    clearCompositionHistory();

    // The bracket belongs to the PANEL, not to `agentService`: a bracket has to
    // name a history, and the panel is what knows which page it is on.
    beginCompositionGesture();
    beginJob();
    value(call('composition_add_track', { name: 'Bass' }));
    const bassId = rows(value(call('read_composition')).tracks)[1].trackId as string;
    value(call('composition_place_pattern', { patternId, trackId: bassId, atTicks: [0, PPQ * 16] }));
    value(call('composition_remove_placements', { placementIds: [before[0].placementId] }));
    endJob();

    abortCompositionGesture();

    const tracks = rows(value(call('read_composition')).tracks);
    expect(tracks).toHaveLength(1);
    expect(rows(tracks[0].blocks)).toEqual(before);
    // A cancel that left an undo step would be a cancel the user could
    // un-cancel into a half-built arrangement.
    expect(canUndoComposition()).toBe(false);
  });
});

// ------------------------------------------- what a run could not find out ---

/**
 * Three gaps a real backing-track run fell into on 2026-08-09, each of which
 * cost it the run and none of which it could diagnose from what it got back.
 * The log is in the session notes; what follows is the shape of each.
 */
describe('the answers a run needs and used to have to guess', () => {
  it('opens a pattern on the instrument it asked for, in one call', () => {
    // THE POINT: a new pattern is a guitar, so this used to be two calls whose
    // second — `pattern_set_instrument {"instrumentId":"bass"}` — was identical
    // every time. Three bass parts made it three times, and the harness's loop
    // detector cut the run short for repeating itself. The repeat was forced by
    // this tool taking no instrument.
    const opened = value(call('pattern_open_blank', { name: 'Bass part', instrumentId: 'bass' }));
    expect(opened.instrumentId).toBe('bass');
    // The string count comes back with it: it is what decides which
    // `stringIndex` values are writable, and a bass has fewer than a guitar.
    expect(opened.strings).toBe(4);
  });

  it('still opens a guitar when no instrument is named', () => {
    const opened = value(call('pattern_open_blank', { name: 'Whatever' }));
    expect(opened.instrumentId).toBe('guitar');
    expect(opened.strings).toBe(6);
  });

  it('reports the length a stamp produced, rounded up to the whole bar', () => {
    // THE POINT: `fitPatternDuration` rounds content UP to a whole bar. A run
    // stamped 49 quarter notes for a twelve-bar part — one too many, the 49th
    // landing on bar 13's downbeat — was told all 49 were placed, and found out
    // only from a later library read that it had thirteen bars. It could see it
    // was wrong and not why, so it deleted everything and stamped the identical
    // notes again.
    value(call('pattern_open_blank', { name: 'Twelve bars', instrumentId: 'bass' }));
    const bar = PPQ * 4;

    const twelve = value(
      call('pattern_stamp_notes', {
        notes: Array.from({ length: 48 }, (_, beat) => ({
          stringIndex: 0,
          fret: 0,
          tick: beat * PPQ,
          durationTicks: PPQ,
        })),
      }),
    );
    expect(twelve.bars).toBe(12);
    expect(twelve.durationTicks).toBe(12 * bar);

    // One note too many, and the whole pattern is a bar longer.
    const thirteen = value(
      call('pattern_stamp_notes', {
        notes: [{ stringIndex: 0, fret: 0, tick: 48 * PPQ, durationTicks: PPQ }],
      }),
    );
    expect(thirteen.bars).toBe(13);
  });

  it('reports the length a delete produced, which can be shorter by a whole bar', () => {
    value(call('pattern_open_blank', { name: 'Shrinking', instrumentId: 'guitar' }));
    const stamped = value(
      call('pattern_stamp_notes', {
        notes: [
          { stringIndex: 0, fret: 0, tick: 0, durationTicks: PPQ },
          { stringIndex: 0, fret: 0, tick: PPQ * 4, durationTicks: PPQ },
        ],
      }),
    );
    expect(stamped.bars).toBe(2);

    const placed = stamped.placed as { noteId: string }[];
    const deleted = value(call('pattern_delete_notes', { noteIds: [placed[1].noteId] }));
    expect(deleted.deleted).toBe(1);
    // The second bar goes with the note that was holding it open — the same
    // rounding seen from the other side, and just as invisible from the args.
    expect(deleted.bars).toBe(1);
  });

  it('never reports a pattern shorter than one bar, however little is in it', () => {
    // `fitPatternDuration`'s floor. An empty or nearly empty pattern is one bar,
    // not zero — which is why "bars" is safe to compare against what was asked
    // for without special-casing the empty case.
    value(call('pattern_open_blank', { name: 'Tiny' }));
    const stamped = value(
      call('pattern_stamp_notes', {
        notes: [{ stringIndex: 0, fret: 0, tick: 0, durationTicks: 1 }],
      }),
    );
    expect(stamped.bars).toBe(1);
  });
});

// -------------------------------------------------------- repeating a phrase ---

/**
 * AG-10. A backing-track run on 2026-08-09 emitted 1002 notes in ONE call —
 * ticks 0 to 480000, some thirty thousand output tokens, a 251-bar pattern —
 * because there was no way to say "this four-note phrase, twelve times". Every
 * individual call in that run succeeded; what failed was what the surface let
 * the model express. `repeat` is that sentence made sayable.
 */
describe('stamping the same phrase several times over', () => {
  const BAR = PPQ * 4;

  /** One bar of a bass ostinato: four notes, one per beat. */
  const ostinato = [0, 1, 2, 3].map((beat) => ({
    stringIndex: 0,
    fret: beat,
    tick: beat * PPQ,
    durationTicks: PPQ,
  }));

  it('lays the phrase down once per pass, offset by everyTicks', () => {
    value(call('pattern_open_blank', { name: 'Ostinato', instrumentId: 'bass' }));

    const stamped = value(
      call('pattern_stamp_notes', { notes: ostinato, repeat: { times: 12, everyTicks: BAR } }),
    );
    expect(stamped.placedCount).toBe(48);
    // `toEqual` rather than a length through `rows()`, which maps a missing
    // `refused` to `[]` and would pass just as happily if the key were dropped.
    expect(stamped.refused).toEqual([]);
    expect(stamped.refusedCount).toBe(0);
    expect(stamped.aboveTheNeck).toBe(0);
    // The length is unchanged by the repeat and is the only thing that tells the
    // model how long the thing it just built came out.
    expect(stamped.bars).toBe(12);
    expect(stamped.durationTicks).toBe(12 * BAR);

    // ITEMISING IS DROPPED, on purpose: 48 note objects hand back most of the
    // tokens `repeat` exists to save, and `read_pattern` has the ids for the
    // rare case where the model wants them.
    expect(stamped.placed).toBeUndefined();

    const ticks = rows(value(call('read_pattern')).notes)
      .map((note) => Number(note.tick))
      .sort((a, b) => a - b);
    expect(ticks).toHaveLength(48);
    // Every pass is the phrase again, a whole bar later — not a phrase stretched
    // or re-spaced by whatever its own notes happened to span.
    expect(ticks).toEqual(
      Array.from({ length: 12 }, (_, pass) => ostinato.map((note) => note.tick + pass * BAR)).flat(),
    );
  });

  it('makes times: 1 identical to sending no repeat at all', () => {
    // Not merely "equivalent". The reply SHAPE has to match too, or the model
    // learns a rule about `repeat` that is really a rule about the number 1.
    const withoutIds = (reply: Record<string, JsonValue>) => ({
      ...reply,
      // The ids are minted per pattern and these are two patterns; everything
      // else about a placed note is the model's own values read back.
      placed: rows(reply.placed).map((note) =>
        Object.fromEntries(Object.entries(note).filter(([key]) => key !== 'noteId')),
      ),
    });

    value(call('pattern_open_blank', { name: 'Plain', instrumentId: 'bass' }));
    const plain = value(call('pattern_stamp_notes', { notes: ostinato }));

    value(call('pattern_open_blank', { name: 'Once', instrumentId: 'bass' }));
    const once = value(
      call('pattern_stamp_notes', { notes: ostinato, repeat: { times: 1, everyTicks: BAR } }),
    );

    // `toEqual` treats an absent key and an `undefined` one alike, so the keys
    // are compared as well — a `placed` that had quietly gone missing would pass
    // the comparison below on its own.
    expect(Object.keys(once)).toEqual(Object.keys(plain));
    expect(withoutIds(once)).toEqual(withoutIds(plain));
    expect(rows(once.placed)).toHaveLength(4);
    expect(once.placedCount).toBe(4);
  });

  it('refuses only the passes that collide, and lands the rest', () => {
    value(call('pattern_open_blank', { name: 'Ostinato', instrumentId: 'bass' }));
    // TWO notes in the phrase, and the obstacle sits where only the SECOND note
    // of the THIRD pass wants to go. A one-note phrase cannot tell "refuses the
    // note that collided" apart from "refuses the whole pass that collided", and
    // the two are the difference between losing one note and losing a bar.
    const phrase = [0, 1].map((beat) => ({
      stringIndex: 0,
      fret: beat + 3,
      tick: beat * PPQ,
      durationTicks: PPQ,
    }));
    value(
      call('pattern_stamp_notes', {
        notes: [{ stringIndex: 0, fret: 7, tick: 2 * BAR + PPQ, durationTicks: PPQ }],
      }),
    );

    const stamped = value(
      call('pattern_stamp_notes', { notes: phrase, repeat: { times: 4, everyTicks: BAR } }),
    );
    // Seven of the eight. The first note of the third pass is untouched by its
    // neighbour's collision.
    expect(stamped.placedCount).toBe(7);
    expect(stamped.refusedCount).toBe(1);

    const refused = rows(stamped.refused);
    expect(refused).toHaveLength(1);
    // 1-BASED, like the bar numbers in `agentRules`. A model holding two
    // counting conventions at once looks at the wrong pass.
    expect(refused[0].repeatIndex).toBe(3);
    // `index` is into the phrase as SENT, not a running count across passes.
    expect(refused[0].index).toBe(1);
    // The tick it was actually tried at, so the model does not have to
    // reconstruct it from index × spacing.
    expect(refused[0].tick).toBe(2 * BAR + PPQ);
    expect(refused[0].reason).toContain('already sounding');

    // And the passes that did not collide are all there, obstacle included.
    expect(rows(value(call('read_pattern')).notes)).toHaveLength(8);
  });

  /**
   * The failure case must not undo the reply-size decision the success case
   * makes. `refused` is `notes.length × times` entries, each carrying a whole
   * seam sentence — up to 64 times the array the model sent — in the one call
   * added to stop a thirty-thousand-token reply.
   */
  it('names only the first ten casualties of a repeat, and counts the rest', () => {
    value(call('pattern_open_blank', { name: 'Ostinato', instrumentId: 'bass' }));
    // Nineteen downbeats already taken; the twentieth is free.
    value(
      call('pattern_stamp_notes', {
        notes: [{ stringIndex: 0, fret: 7, tick: 0, durationTicks: PPQ }],
        repeat: { times: 19, everyTicks: BAR },
      }),
    );

    const stamped = value(
      call('pattern_stamp_notes', {
        notes: [{ stringIndex: 0, fret: 0, tick: 0, durationTicks: PPQ }],
        repeat: { times: 20, everyTicks: BAR },
      }),
    );
    expect(stamped.placedCount).toBe(1);
    expect(stamped.refusedCount).toBe(19);
    expect(rows(stamped.refused)).toHaveLength(10);
    // The ones it does name are the earliest, which is where a model looking for
    // the shape of the problem starts.
    expect(rows(stamped.refused)[0].repeatIndex).toBe(1);
  });

  /**
   * A note the neck cannot reach is placed, is silent, and — once `placed` is
   * gone — has nothing else in the reply to mention it. Losing that with a
   * repeat would hide exactly the failure this layer exists to surface.
   */
  it('still counts the silent notes when it stops naming them', () => {
    value(call('pattern_open_blank', { name: 'Ostinato', instrumentId: 'bass' }));

    const stamped = value(
      call('pattern_stamp_notes', {
        // Past the end of a bass neck (21 frets) but inside the app's ceiling.
        notes: [{ stringIndex: 0, fret: 24, tick: 0, durationTicks: PPQ }],
        repeat: { times: 3, everyTicks: BAR },
      }),
    );
    expect(stamped.placed).toBeUndefined();
    expect(stamped.placedCount).toBe(3);
    // Every copy is silent, and the count is all the model gets here —
    // `read_pattern` is what names which.
    expect(stamped.aboveTheNeck).toBe(3);
    expect(value(call('read_pattern')).notesAboveTheNeck).toBe(3);
  });

  it('names the pass and the real tick when a whole repeat is refused', () => {
    value(call('pattern_open_blank', { name: 'Ostinato', instrumentId: 'bass' }));
    value(
      call('pattern_stamp_notes', {
        notes: [0, 1].map((pass) => ({
          stringIndex: 0,
          fret: 7,
          tick: pass * BAR,
          durationTicks: PPQ,
        })),
      }),
    );
    clearPatternHistory();

    const refused = reason(
      call('pattern_stamp_notes', {
        notes: [{ stringIndex: 0, fret: 0, tick: 0, durationTicks: PPQ }],
        repeat: { times: 2, everyTicks: BAR },
      }),
    );
    // The tick named is where the note was ACTUALLY attempted, which for a
    // repeat is not the tick that was sent.
    expect(refused).toContain('repeat 1 string 0 tick 0');
    expect(refused).toContain(`repeat 2 string 0 tick ${BAR}`);
    expect(rows(value(call('read_pattern')).notes)).toHaveLength(2);
    expect(canUndoPattern()).toBe(false);
  });

  /**
   * AG-13. The 2026-08-10 run, reduced to two bars.
   *
   * It wrote every bar of a twelve-bar line into ONE `notes` array — each bar at
   * bar-local ticks 0/480/960/1440 — and expected `repeat` to walk the groups
   * forward a bar at a time. Twenty-seven of its thirty-three notes were on top
   * of another note in the SAME call; 429 attempts placed 78 and came back `ok`.
   * Unlike a collision with the pattern, that one is arithmetic on the arguments,
   * so it is refused before anything is written.
   */
  it('refuses notes that land on each other, before it writes a thing', () => {
    value(call('pattern_open_blank', { name: 'Blues', instrumentId: 'bass' }));
    clearPatternHistory();

    /** One bar of a walking line, at BAR-LOCAL ticks — which is the mistake. */
    const barGroup = (frets: readonly number[]) =>
      frets.map((fret, beat) => ({
        stringIndex: 0,
        fret,
        tick: beat * PPQ,
        durationTicks: PPQ,
      }));

    const refused = reason(
      call('pattern_stamp_notes', {
        notes: [...barGroup([3, 0, 2, 3]), ...barGroup([0, 5, 7, 5])],
        repeat: { times: 12, everyTicks: BAR },
      }),
    );
    // How many of its own notes are shut out, so the model can tell "one typo"
    // from "the whole list is doubled up". FOUR: the second bar-group is the one
    // that cannot land, and counting the notes it lands on as well would double
    // every number the model is trying to reason about.
    expect(refused).toContain('4 of the 8');
    // The misunderstanding named, not just the symptom.
    expect(refused).toContain('send ONE bar');
    // A concrete pair, so the model can see which one it meant to move. These
    // two are on the very same tick, and saying "still sounding until 480" of a
    // note that starts at 480 would give it nothing to tell the ends apart with.
    expect(refused).toContain('string 0 tick 0');
    expect(refused).toContain('another note at that same tick');

    // NOTHING was written, and no step was pushed to undo it with.
    expect(rows(value(call('read_pattern')).notes)).toHaveLength(0);
    expect(canUndoPattern()).toBe(false);
  });

  it('refuses passes that would land on the pass before, naming both numbers', () => {
    value(call('pattern_open_blank', { name: 'Ostinato', instrumentId: 'bass' }));
    clearPatternHistory();

    // The phrase is a whole bar long and the passes are half a bar apart, so
    // every pass sits on top of the second half of the one before it.
    const refused = reason(
      call('pattern_stamp_notes', { notes: ostinato, repeat: { times: 4, everyTicks: BAR / 2 } }),
    );
    // BOTH numbers: the spacing it sent is only wrong relative to a span it never
    // computed, and naming one without the other leaves it guessing again. The
    // span is the STRING's, not the call's — see the accept case below.
    expect(refused).toContain('on string 0');
    expect(refused).toContain(`span ${BAR} ticks`);
    expect(refused).toContain(`every ${BAR / 2}`);

    expect(rows(value(call('read_pattern')).notes)).toHaveLength(0);
    expect(canUndoPattern()).toBe(false);
  });

  /**
   * Without a repeat there is no repeat to steer the model towards, and the
   * fault is a different one: ticks counted from the top of a bar instead of
   * from the top of the pattern. The whole-refusal applies here just the same,
   * and this is the commoner call shape.
   */
  it('refuses a phrase that overlaps itself with no repeat at all', () => {
    value(call('pattern_open_blank', { name: 'Blues', instrumentId: 'bass' }));
    clearPatternHistory();

    const refused = reason(
      call('pattern_stamp_notes', {
        notes: [
          { stringIndex: 0, fret: 3, tick: 0, durationTicks: PPQ },
          { stringIndex: 0, fret: 5, tick: 0, durationTicks: PPQ },
        ],
      }),
    );
    expect(refused).toContain('1 of the 2');
    expect(refused).toContain('start of the PATTERN');
    // Advice about a parameter it did not use buries the fault it did make.
    expect(refused).not.toContain('send ONE bar');

    expect(rows(value(call('read_pattern')).notes)).toHaveLength(0);
    expect(canUndoPattern()).toBe(false);
  });

  /**
   * The 2026-08-10 call produced eighty-four colliding pairs. Naming them all
   * would undo the reply-size decision every other refusal sentence here makes.
   */
  it('names ten of the pairs and counts the rest', () => {
    value(call('pattern_open_blank', { name: 'Blues', instrumentId: 'bass' }));
    clearPatternHistory();

    // Twelve distinct beats, sent twice — twelve notes shut out, ten named.
    const line = Array.from({ length: 12 }, (_, beat) => ({
      stringIndex: 0,
      fret: 3,
      tick: beat * PPQ,
      durationTicks: PPQ,
    }));

    const refused = reason(call('pattern_stamp_notes', { notes: [...line, ...line] }));
    expect(refused).toContain('12 of the 24');
    expect(refused).toContain('…and 2 more.');
  });

  /**
   * The premise "two notes that overlap on one string cannot both be placed" is
   * FALSE against the lib, and a check built on it refuses calls that work.
   * `stampEvent` declines only a note whose start tick is already sounding;
   * anything else it places and CLAMPS. A pedal or sustained note written after
   * the shorter note it reaches over is the everyday shape of that, and it must
   * still land — shortened, with the length that stuck coming back.
   */
  it('still accepts a long note written after the note it reaches over', () => {
    value(call('pattern_open_blank', { name: 'Pedal', instrumentId: 'bass' }));

    const stamped = value(
      call('pattern_stamp_notes', {
        notes: [
          { stringIndex: 0, fret: 5, tick: PPQ, durationTicks: PPQ },
          // Overlaps the note above by three beats — and lands, clamped to one.
          { stringIndex: 0, fret: 3, tick: 0, durationTicks: BAR },
        ],
      }),
    );
    expect(stamped.placedCount).toBe(2);
    expect(stamped.refusedCount).toBe(0);
    expect(rows(stamped.placed)[1].durationTicks).toBe(PPQ);
  });

  /**
   * The check is narrow ON PURPOSE, and these are the two shapes an over-broad
   * one silently bans: every chord, and every legato line.
   */
  it('still accepts a chord, and notes that merely abut', () => {
    value(call('pattern_open_blank', { name: 'Chord', instrumentId: 'bass' }));

    // Same tick, DIFFERENT strings. Four fingers, one moment.
    const chord = value(
      call('pattern_stamp_notes', {
        notes: [0, 1, 2].map((stringIndex) => ({
          stringIndex,
          fret: 3,
          tick: 0,
          durationTicks: PPQ,
        })),
      }),
    );
    expect(chord.placedCount).toBe(3);
    expect(chord.refusedCount).toBe(0);

    // One string, back to back: each note starts exactly where the last ended,
    // and so does each PASS. An off-by-one in the comparison bans both.
    const legato = value(
      call('pattern_stamp_notes', {
        notes: [0, 1, 2, 3].map((beat) => ({
          stringIndex: 3,
          fret: 5,
          tick: beat * PPQ,
          durationTicks: PPQ,
        })),
        repeat: { times: 2, everyTicks: BAR },
      }),
    );
    expect(legato.placedCount).toBe(8);
    expect(legato.refusedCount).toBe(0);
    expect(rows(value(call('read_pattern')).notes)).toHaveLength(11);
  });

  /**
   * And the third shape: a phrase that reaches further than its own spacing and
   * still never touches itself, because the two ends of it are on DIFFERENT
   * strings. Comparing the call's span against everyTicks — which is what the
   * refusal sentence talks about, and the obvious thing to implement — bans a
   * bass note under a top-string fill, which is most of what a repeat is for.
   */
  it('still accepts passes that overlap in time on different strings', () => {
    value(call('pattern_open_blank', { name: 'Riff', instrumentId: 'bass' }));

    const stamped = value(
      call('pattern_stamp_notes', {
        notes: [
          { stringIndex: 0, fret: 3, tick: 0, durationTicks: PPQ },
          // Three beats after the note above, so the phrase spans a whole bar
          // while the passes are half a bar apart. Neither string collides.
          { stringIndex: 1, fret: 5, tick: 3 * PPQ, durationTicks: PPQ },
        ],
        repeat: { times: 4, everyTicks: BAR / 2 },
      }),
    );
    expect(stamped.placedCount).toBe(8);
    expect(stamped.refusedCount).toBe(0);
  });

  /**
   * The other half of the same rule. A collision with a note ALREADY in the
   * pattern is not provable from the arguments — it is the seam's answer, known
   * only after the write — so it stays what it was: per note, partial, itemised.
   */
  it('leaves collisions with the pattern itself partial, as they were', () => {
    value(call('pattern_open_blank', { name: 'Riff', instrumentId: 'bass' }));
    value(
      call('pattern_stamp_notes', {
        notes: [{ stringIndex: 0, fret: 7, tick: 0, durationTicks: PPQ }],
      }),
    );

    const stamped = value(
      call('pattern_stamp_notes', {
        notes: [
          // Onto the note that is already there — refused by the seam.
          { stringIndex: 0, fret: 3, tick: 0, durationTicks: PPQ },
          // And this one lands, which is the whole point of not refusing whole.
          { stringIndex: 1, fret: 3, tick: 0, durationTicks: PPQ },
        ],
      }),
    );
    expect(stamped.placedCount).toBe(1);
    const refused = rows(stamped.refused);
    expect(refused).toHaveLength(1);
    expect(refused[0].index).toBe(0);
    expect(refused[0].reason).toContain('already sounding');
    expect(rows(value(call('read_pattern')).notes)).toHaveLength(2);
  });

  /**
   * What this can and cannot catch. It catches a refusal that leaves an undo
   * step behind, which is the user-visible defect. It does NOT catch the check
   * being moved inside `oneUndoStep`'s bracket: `changed` is `result.ok`, so a
   * refusal returned from inside the bracket pushes nothing either, and the two
   * orderings are indistinguishable from out here. Running the check first is
   * still the right construction — it is what makes "no write, no step" true
   * rather than true by accident of another predicate — but it is not assertable
   * through this seam.
   */
  it('pushes no undo step when it refuses a call whole', () => {
    value(call('pattern_open_blank', { name: 'Ostinato', instrumentId: 'bass' }));
    clearPatternHistory();
    value(call('pattern_stamp_notes', { notes: ostinato }));
    expect(canUndoPattern()).toBe(true);

    reason(
      call('pattern_stamp_notes', {
        notes: [...ostinato, ...ostinato],
        repeat: { times: 4, everyTicks: BAR },
      }),
    );

    // ONE press takes the pattern back past the phrase that DID land. A step
    // pushed by the refusal would swallow that press restoring a state the
    // pattern never left, and leave the notes sitting there.
    patternUndo();
    expect(rows(value(call('read_pattern')).notes)).toHaveLength(0);
    expect(canUndoPattern()).toBe(false);
  });

  it('collapses a whole repeat into ONE undo step', () => {
    value(call('pattern_open_blank', { name: 'Ostinato', instrumentId: 'bass' }));
    clearPatternHistory();

    value(call('pattern_stamp_notes', { notes: ostinato, repeat: { times: 12, everyTicks: BAR } }));
    expect(rows(value(call('read_pattern')).notes)).toHaveLength(48);

    // ONE press. Forty-eight would be the same defect the batching exists to
    // prevent, arrived at from the other direction.
    patternUndo();
    expect(rows(value(call('read_pattern')).notes)).toHaveLength(0);
    expect(canUndoPattern()).toBe(false);
  });

  it('declares repeat as an all-or-nothing pair with a bounded count', () => {
    // The stand-in above reads `required` and `enum` and nothing else — it
    // evaluates neither `minimum` nor `maximum`, so the bounds below are
    // assertions that the schema DECLARES them. That a declared bound is
    // ENFORCED is `ajv`'s job and is asserted against the real registry in
    // `AgentToolRegistry.test.ts`; both halves are needed and neither implies
    // the other.
    const repeat = schemaOf('pattern_stamp_notes').properties?.repeat;
    if (!repeat) throw new Error('pattern_stamp_notes declares no repeat argument');
    expect(repeat.type).toBe('object');
    // Half a repeat is not a repeat: a `times` with no spacing has no meaning
    // that is not the derivation this argument exists to refuse.
    expect(repeat.required).toEqual(['times', 'everyTicks']);
    expect(schemaViolations(repeat, { times: 12 })).toContain('missing everyTicks');
    expect(schemaViolations(repeat, { times: 12, everyTicks: BAR })).toEqual([]);
    expect(repeat.additionalProperties).toBe(false);
    // `times: 0` is not "no repeat", it is a call that asks for nothing, and the
    // ceiling is a schema-level backstop rather than a limit on notes.
    expect(repeat.properties?.times?.minimum).toBe(1);
    expect(repeat.properties?.times?.maximum).toBe(64);
    // A pass on top of the pass before it is a pile, not a repeat.
    expect(repeat.properties?.everyTicks?.minimum).toBe(1);
    // `notes` alone stays required — a repeat with nothing to repeat is not a
    // call.
    expect(schemaOf('pattern_stamp_notes').required).toEqual(['notes']);
  });
});

// ------------------------------------------- asking where a chord is on the neck ---

/**
 * AG-09. The other half of the same 2026-08-09 failure `repeat` answers: a
 * twelve-bar part over five changes is some seventy fret numbers worked out by
 * hand, on whichever neck the part is on, and nothing in the surface would tell
 * the model what they were.
 *
 * It is a READ, and every test here is about that as much as about the frets. A
 * tool that stamped the chord would have removed the arithmetic AND the
 * authorship, and turned every backing track into block chords on the downbeat.
 */
describe('looking a chord up on the open instrument', () => {
  const voicings = (result: ToolResult) => rows(value(result).voicings);

  it('gives frets and strings for a whole progression in one call', () => {
    value(call('pattern_open_blank', { name: 'Blues', instrumentId: 'guitar' }));

    const reply = value(call('read_chord_voicings', { symbols: ['A7', 'D7', 'E7'] }));
    // Which end of the string axis this is, on the reply itself: cells read
    // against the wrong end put every note on the wrong string and still look
    // like a chord. The reentrant caveat rides along, because this is the tool
    // that invites "take the root off index 0 for the bass note" and on a
    // ukulele index 0 is the high G.
    expect(reply.strings).toMatch(/index 0 = the bottom string/);
    expect(reply.strings).toMatch(/reentrant ukulele/);
    expect(reply.instrumentId).toBe('guitar');

    const answers = rows(reply.voicings);
    // In order, one per symbol — the model addresses them by position in the
    // progression it sent.
    expect(answers.map((entry) => entry.symbol)).toEqual(['A7', 'D7', 'E7']);
    // The chord's own facts reach the model as well as the frets: which tones
    // the shape is made of is what a line written OUT of it is chosen against,
    // and `notes` is the only place the reply says so.
    expect(answers[0].root).toBe('A');
    expect(answers[0].quality).toBe('dominant seventh');
    expect(answers[0].notes).toEqual(['A', 'C#', 'E', 'G']);
    // x02020 — the open A7 and not a barre somewhere plausible.
    expect(answers[0].cells).toEqual([
      { stringIndex: 1, fret: 0 },
      { stringIndex: 2, fret: 2 },
      { stringIndex: 3, fret: 0 },
      { stringIndex: 4, fret: 2 },
      { stringIndex: 5, fret: 0 },
    ]);
    for (const answer of answers) expect(rows(answer.cells).length).toBeGreaterThan(0);
  });

  it('answers for the instrument the pattern is on — a bass never gets a six-string grip', () => {
    // Acceptance criterion 2, and the values are pinned for the reason
    // `patternService.test.ts` argues at length: a guitar grip trimmed to four
    // strings passes every bound this could otherwise state, so bounds cannot be
    // what catches a wrong tuning source.
    value(call('pattern_open_blank', { name: 'Bass part', instrumentId: 'bass' }));

    const answers = voicings(call('read_chord_voicings', { symbols: ['A7'] }));
    expect(answers[0].cells).toEqual([
      { stringIndex: 0, fret: 5 },
      { stringIndex: 1, fret: 4 },
      { stringIndex: 2, fret: 5 },
      { stringIndex: 3, fret: 6 },
    ]);
  });

  it('names the symbol it could not read, and still answers the others', () => {
    value(call('pattern_open_blank', { name: 'Mixed', instrumentId: 'guitar' }));

    const answers = voicings(call('read_chord_voicings', { symbols: ['G', 'H7', 'C'] }));
    expect(answers).toHaveLength(3);
    expect(answers[1].symbol).toBe('H7');
    expect(answers[1].refused as string).toContain('H7');
    // The partial-failure rule, from the read side: one bad symbol does not cost
    // the caller the round trip for the other eleven.
    expect(rows(answers[0].cells).length).toBeGreaterThan(0);
    expect(rows(answers[2].cells).length).toBeGreaterThan(0);
  });

  it('refuses the whole call when nothing at all parsed, carrying every reason', () => {
    value(call('pattern_open_blank', { name: 'Nonsense' }));

    const refused = reason(call('read_chord_voicings', { symbols: ['H7', 'zzz'] }));
    expect(refused).toContain('H7');
    expect(refused).toContain('zzz');
  });

  it('refuses in the words the other reads use when no pattern is open', () => {
    expect(reason(call('read_chord_voicings', { symbols: ['A7'] }))).toBe('No pattern is open.');
  });

  it('changes nothing and pushes no undo step', () => {
    // THE POINT OF THE TICKET, executed. `pattern_open_blank` clears the pattern
    // history, so an undo step appearing after this can only have come from the
    // lookup — and an undo step that was never pushed is invisible in the
    // document, which is why the history is asked rather than the notes alone.
    value(call('pattern_open_blank', { name: 'Untouched', instrumentId: 'guitar' }));
    expect(canUndoPattern()).toBe(false);
    const before = JSON.stringify(value(call('read_pattern')));

    value(call('read_chord_voicings', { symbols: ['A7', 'D7', 'E7', 'G', 'C'] }));

    expect(canUndoPattern()).toBe(false);
    expect(JSON.stringify(value(call('read_pattern')))).toBe(before);
  });

  it('caps a refusal that names every symbol, like every other batch does', () => {
    // Twelve nonsense symbols is twelve copies of one ~120-character sentence,
    // and the tenth says nothing the first nine did not. The same cap
    // `pattern_stamp_notes` applies, which is why it lives in `types.ts` rather
    // than beside one caller.
    value(call('pattern_open_blank', { name: 'Nonsense', instrumentId: 'guitar' }));

    const refused = reason(
      call('read_chord_voicings', {
        symbols: Array.from({ length: 13 }, (_, index) => `H${index}`),
      }),
    );
    expect(refused).toContain('H0');
    expect(refused).toContain('H9');
    expect(refused).not.toContain('H10');
    expect(refused).toContain('…and 3 more.');
  });

  it('offers no way to write a chord, only to read one', () => {
    // A `pattern_stamp_chord` would be the same knowledge with the authorship
    // taken away. If one is ever added it should be argued for on its own
    // ticket, and this line is where that argument has to start.
    const names = AGENT_TOOLS.map((tool) => tool.name);
    expect(names).toContain('read_chord_voicings');
    expect(names.filter((toolName) => toolName.includes('chord'))).toEqual([
      'read_chord_voicings',
    ]);
    // Name-shaped on its own, which a `pattern_stamp_grip` would walk straight
    // past — so the SET is asserted too: everything the read module exports is
    // named as a read, which is how the model tells a read from a write before
    // it calls one.
    expect(READ_TOOLS.map((tool) => tool.name)).toContain('read_chord_voicings');
    for (const tool of READ_TOOLS) expect(tool.name.startsWith('read_')).toBe(true);
  });
});
