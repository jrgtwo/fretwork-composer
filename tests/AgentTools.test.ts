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
  beginEditGesture as beginCompositionGesture,
  clearHistory as clearCompositionHistory,
  endEditGesture as endCompositionGesture,
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

    // The `../` prefix is REPEATED rather than fixed at two, because the glob
    // above is recursive in both directions: `src/ai/commandCatalog.ts` (AG-05)
    // sits one level up from `tools/` and reaches the same seams by a shorter
    // path. Pinning the depth would have made the check pass or fail on where a
    // file lives rather than on what it imports, which is not what it is for.
    const ALLOWED =
      /^(\.\/[a-zA-Z]+|(\.\.\/)+(patterns\/(patternService|articulations)|composition\/compositionService|voice\/voiceService|audio\/playbackService))$/;

    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(4);
    for (const [file, source] of Object.entries({ ...sources, ...helper })) {
      // Both quote styles and dynamic `import('…')` as well as `from '…'`: a
      // check a rename of the quote character defeats is not a check.
      const imports = [
        ...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g),
      ].map((match) => match[1]);
      for (const specifier of imports) {
        expect(`${file}: ${specifier}`).not.toMatch(/@fretwork\/lib/);
        expect(`${file}: ${specifier}`).not.toMatch(/composition-ops/);
        // The helper is scanned for lib imports only — the allow-list is about
        // what the TOOLS may reach. Compared as a sentence so a failure names
        // the file that broke it.
        if (file in sources) {
          expect(ALLOWED.test(specifier) ? 'a seam' : `${file}: ${specifier}`).toBe('a seam');
        }
      }
    }
    expect(Object.keys(helper)).toHaveLength(1);
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
    const bend = schemaOf('pattern_set_pitch').properties?.bend;
    expect(bend?.properties?.semitones?.enum).toEqual([...BEND_SEMITONES]);
    expect(bend?.properties?.kind?.enum).toEqual([...BEND_KINDS]);
    expect(schemaOf('pattern_set_articulations').properties?.vibrato?.enum).toEqual([
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
    expect(schemaViolations(schemaOf('pattern_move_note'), { tick: 0 })).toContain(
      'missing noteId',
    );
  });

  it('allows null where null means "clear", and only there', () => {
    // `nullable` has to widen the enum as well as the type, or a validator that
    // checks both refuses the clear it just accepted.
    const dynamic = schemaOf('pattern_set_dynamic').properties?.dynamic;
    expect(dynamic?.type).toEqual(['string', 'null']);
    expect(dynamic?.enum).toContain(null);
    expect(dynamic?.enum).toContain('mf');
    expect(schemaOf('pattern_set_note_fret').properties?.fret?.type).toBe('integer');
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
    // states it every time.
    expect(pattern.strings).toMatch(/index 0 = lowest/);
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
  it('refuses an unknown note id', () => {
    seedPattern('Riff');
    expect(reason(call('pattern_move_note', { noteId: 'ev_nope', tick: 0 }))).toBe(
      'No such note.',
    );
    expect(reason(call('pattern_set_dynamic', { noteId: 'ev_nope', dynamic: 'f' }))).toBe(
      'No such note.',
    );
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

    const raised = value(call('pattern_set_note_fret', {
      noteId: rows(value(call('read_pattern')).notes)[0].noteId,
      fret: 20,
    }));
    expect(raised.aboveTheNeck).toBe(true);
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

    expect(reason(call('pattern_move_note', { noteId: second, tick: 0 }))).toContain('overlap');
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

    const moved = value(call('pattern_move_note', { noteId: second, tick: PPQ * 4 }));
    expect(moved.startTick).toBe(PPQ * 4);
    expect(moved.stringIndex).toBe(0);

    // Onto the seeded note. The lib REJECTS this (the group move clamps, this
    // one does not), leaving the note where it was — which is only visible by
    // reading it back.
    const refused = reason(call('pattern_move_note', { noteId: second, tick: 0 }));
    expect(refused).toContain('overlap');
    const notes = rows(value(call('read_pattern')).notes);
    expect(notes.find((note) => note.noteId === second)?.tick).toBe(PPQ * 4);

    // A move to another string is a move, not a refusal.
    const across = value(call('pattern_move_note', { noteId: second, tick: 0, stringIndex: 3 }));
    expect(across).toEqual({ startTick: 0, stringIndex: 3 });
  });

  it('reports the duration a resize actually kept', () => {
    seedPattern('Riff');
    const noteId = rows(value(call('read_pattern')).notes)[0].noteId as string;
    expect(value(call('pattern_resize_note', { noteId, durationTicks: PPQ * 2 })).durationTicks).toBe(
      PPQ * 2,
    );

    // Clamped against the next note on the same string, so the request is
    // honoured in part and the reply says by how much.
    value(
      call('pattern_stamp_notes', {
        notes: [{ stringIndex: 0, fret: 7, tick: PPQ * 4, durationTicks: PPQ }],
      }),
    );
    expect(
      value(call('pattern_resize_note', { noteId, durationTicks: PPQ * 16 })).durationTicks,
    ).toBe(PPQ * 4);
  });

  it('changes only the articulations it was sent, and clears with null', () => {
    seedPattern('Riff');
    const noteId = rows(value(call('read_pattern')).notes)[0].noteId as string;

    value(call('pattern_set_articulations', { noteId, palmMute: true, ghost: true }));
    const first = rows(value(call('read_pattern')).notes)[0].articulations as string[];
    expect(first).toContain('palmMute');
    expect(first).toContain('ghost');

    // An ABSENT key leaves the field alone; `null` clears one. Sending every
    // field unconditionally would wipe `palmMute` here, which is the whole
    // reason the patch is built by conditional spread.
    value(call('pattern_set_articulations', { noteId, ghost: null }));
    const second = rows(value(call('read_pattern')).notes)[0].articulations as string[];
    expect(second).toContain('palmMute');
    expect(second).not.toContain('ghost');

    value(call('pattern_set_articulations', { noteId, vibrato: 'wide' }));
    expect(rows(value(call('read_pattern')).notes)[0].articulations).toContain('vibrato:wide');
  });

  it('replaces a note’s pitch movement, and clears it when sent nothing', () => {
    seedPattern('Riff');
    const noteId = rows(value(call('read_pattern')).notes)[0].noteId as string;

    value(
      call('pattern_set_pitch', {
        noteId,
        slideIn: 'below',
        bend: { kind: 'bend', semitones: 2 },
      }),
    );
    const flags = rows(value(call('read_pattern')).notes)[0].articulations as string[];
    expect(flags).toContain('slideIn:below');
    expect(flags.some((flag) => flag.startsWith('bend:'))).toBe(true);

    // The tool REPLACES rather than patches, so no movement means none.
    value(call('pattern_set_pitch', { noteId }));
    expect(rows(value(call('read_pattern')).notes)[0].articulations).toBeUndefined();
  });

  it('sets a dynamic and clears it', () => {
    seedPattern('Riff');
    const noteId = rows(value(call('read_pattern')).notes)[0].noteId as string;
    value(call('pattern_set_dynamic', { noteId, dynamic: 'ff' }));
    expect(rows(value(call('read_pattern')).notes)[0].dynamic).toBe('ff');
    value(call('pattern_set_dynamic', { noteId, dynamic: null }));
    expect(rows(value(call('read_pattern')).notes)[0].dynamic).toBe(null);
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
