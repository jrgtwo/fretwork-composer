import { describe, expect, it } from 'vitest';
import { ToolRegistry } from 'agent-harness/browser';
import { toToolDef } from '../src/ai/agentService';
import { AGENT_TOOLS } from '../src/ai/tools';

/**
 * The adapter against the REAL registry — the one file in the suite that does
 * not mock `agent-harness/browser`.
 *
 * `AgentService.test.ts` mocks the harness, which is the only way to assert what
 * is HANDED to it, and it therefore compares the adapter's output against a
 * `ToolDefLike` interface declared in that file. Nothing there ever compiles a
 * schema. That leaves the load-bearing half of the wiring unchecked: the harness
 * runs `ajv.compile(t.params)` on every registered tool, and a schema `ajv`
 * rejects is a `ToolRegistry` constructor that THROWS — every run dead, in the
 * browser only, with an error about JSON Schema and no mention of a tool.
 *
 * Ours is a narrow schema subset (`src/ai/tools/types.ts`), which is exactly why
 * this is cheap and worth having: the vocabulary is small enough that compiling
 * all of it is one call, and the failure it catches is one nobody would guess.
 *
 * No network is involved and no run happens — a registry is compiled and asked
 * questions. This says nothing about whether a model can be reached, which
 * remains a by-hand check.
 */

describe('the adapter against the real ToolRegistry', () => {
  /** Every tool the app has. AG-03's stub used to be appended here because it
   *  was not in `AGENT_TOOLS`; AG-06 deleted it along with the agent that was
   *  its only caller. */
  const ALL = AGENT_TOOLS;

  it('compiles every tool the app ships', () => {
    // Construction is the assertion: `register` calls `ajv.compile` per tool and
    // an unsupported keyword or a malformed schema throws out of it.
    expect(() => new ToolRegistry().register(ALL.map(toToolDef))).not.toThrow();
  });

  it('presents each tool to the model under its own name and description', () => {
    const registry = new ToolRegistry();
    registry.register(ALL.map(toToolDef));
    expect(registry.names()).toEqual(ALL.map((tool) => tool.name));
    // `schemas()` is literally what is put in the request body. A `params` the
    // adapter dropped would surface here as a tool the model cannot pass
    // arguments to, and nowhere else.
    const schemas = registry.schemas();
    expect(schemas).toHaveLength(ALL.length);
    for (const [index, schema] of schemas.entries()) {
      expect(schema.description).toBe(ALL[index].description);
      expect(schema.parameters).toEqual(ALL[index].parameters);
    }
  });

  it('enforces the schemas rather than merely carrying them', () => {
    const registry = new ToolRegistry();
    registry.register(ALL.map(toToolDef));

    // `pattern_open_blank`'s only argument is optional, so no arguments is valid.
    expect(registry.validate('pattern_open_blank', {})).toEqual({ ok: true });
    // `minLength: 1` — the whole reason the tool uses the `name` helper and not
    // `str`. The lib names a pattern by default parameter, so `''` would be
    // stored verbatim as an unlabelled row in the library.
    expect(registry.validate('pattern_open_blank', { name: '' }).ok).toBe(false);
    // `additionalProperties: false` on every tool: a misspelt argument has to be
    // a validation error the model can read, not an instruction silently
    // dropped.
    expect(registry.validate('pattern_open_blank', { nmae: 'typo' }).ok).toBe(false);
    // And a required argument that is missing, on a real tool.
    expect(registry.validate('pattern_stamp_notes', {}).ok).toBe(false);
    // `read_chord_voicings`'s neck, against the REAL validator. The tool used to
    // answer about whichever pattern was open; `instrumentId` is what makes two
    // necks two different calls, and the stand-in in `AgentTools.test.ts` reads
    // the schema object rather than compiling it — so "the model cannot leave it
    // out" and "the model cannot invent a neck" are enforced here or nowhere.
    expect(
      registry.validate('read_chord_voicings', { symbols: ['A7'], instrumentId: 'bass' }),
    ).toEqual({ ok: true });
    expect(registry.validate('read_chord_voicings', { symbols: ['A7'] }).ok).toBe(false);
    expect(
      registry.validate('read_chord_voicings', { symbols: ['A7'], instrumentId: 'theremin' }).ok,
    ).toBe(false);
  });

  /**
   * The per-note writes are batches, so their real schema is an object nested
   * inside `items` — required keys, enums and `nullable`'s widened type all one
   * level down. `ajv` is the only thing in the project that enforces at that
   * depth: the stand-in in `AgentTools.test.ts` reads the TOP level only, so a
   * batch whose entries validated against nothing would pass there and fail in
   * a browser.
   */
  it('validates the entries inside a batch, not just the array around them', () => {
    const registry = new ToolRegistry();
    registry.register(ALL.map(toToolDef));

    expect(
      registry.validate('pattern_move_notes', { moves: [{ noteId: 'ev_1', tick: 0 }] }),
    ).toEqual({ ok: true });
    // A missing required key INSIDE an entry.
    expect(registry.validate('pattern_move_notes', { moves: [{ tick: 0 }] }).ok).toBe(false);
    // A misspelt key inside an entry — `additionalProperties: false` has to
    // reach the entry schema, or an instruction is silently dropped. The entry
    // is otherwise COMPLETE on purpose: with `tick` left out as well, `required`
    // alone would refuse it and the assertion would pass with
    // `additionalProperties` deleted from `obj()`.
    expect(
      registry.validate('pattern_move_notes', { moves: [{ noteId: 'ev_1', tick: 0, tik: 0 }] }).ok,
    ).toBe(false);
    // The singular shape these tools replaced. It has to be a validation error
    // rather than a batch of nothing.
    expect(registry.validate('pattern_move_notes', { noteId: 'ev_1', tick: 0 }).ok).toBe(false);
    // `nullable` inside an entry: null is a clear, a made-up mark is not.
    expect(
      registry.validate('pattern_set_dynamics', { dynamics: [{ noteId: 'ev_1', dynamic: null }] }),
    ).toEqual({ ok: true });
    expect(
      registry.validate('pattern_set_dynamics', { dynamics: [{ noteId: 'ev_1', dynamic: 'sfz' }] })
        .ok,
    ).toBe(false);
    // `minItems: 1` — an empty batch is a call that asks for nothing.
    expect(registry.validate('pattern_move_notes', { moves: [] }).ok).toBe(false);
  });

  /**
   * AG-10's `repeat`, which is the other nested shape — an OBJECT argument
   * rather than an array of them, with numeric bounds on both of its fields.
   * `ajv` is the only thing in the project that evaluates `minimum`/`maximum`
   * at all: the stand-in in `AgentTools.test.ts` reads `required` and `enum`,
   * so `times: 0` is rejected here or nowhere.
   */
  it('enforces the bounds on a repeat, not just the keys', () => {
    const registry = new ToolRegistry();
    registry.register(ALL.map(toToolDef));
    const notes = [{ stringIndex: 0, fret: 0, tick: 0, durationTicks: 480 }];

    expect(registry.validate('pattern_stamp_notes', { notes })).toEqual({ ok: true });
    expect(
      registry.validate('pattern_stamp_notes', { notes, repeat: { times: 12, everyTicks: 1920 } }),
    ).toEqual({ ok: true });
    // `times: 0` is not "no repeat", it is a call asking for nothing to happen.
    expect(
      registry.validate('pattern_stamp_notes', { notes, repeat: { times: 0, everyTicks: 1920 } }).ok,
    ).toBe(false);
    // The backstop on the far end. (The ceiling on total NOTES is AG-12's, and
    // this is not it.)
    expect(
      registry.validate('pattern_stamp_notes', { notes, repeat: { times: 65, everyTicks: 1920 } })
        .ok,
    ).toBe(false);
    // Half a repeat: spacing is never derived from the phrase, so a `times`
    // alone has no meaning to fall back on.
    expect(registry.validate('pattern_stamp_notes', { notes, repeat: { times: 12 } }).ok).toBe(
      false,
    );
    expect(registry.validate('pattern_stamp_notes', { notes, repeat: { everyTicks: 1920 } }).ok).toBe(
      false,
    );
    // A pass on top of the pass before it is a pile, not a repeat.
    expect(
      registry.validate('pattern_stamp_notes', { notes, repeat: { times: 12, everyTicks: 0 } }).ok,
    ).toBe(false);
    // And `additionalProperties: false` reaches inside the object too.
    expect(
      registry.validate('pattern_stamp_notes', {
        notes,
        repeat: { times: 12, everyTicks: 1920, evryTicks: 1920 },
      }).ok,
    ).toBe(false);
  });

  /**
   * `atBars` is 1-BASED, and `minimum: 1` in its schema is the only thing that
   * says so to a caller. Nothing in `run` re-checks it: bar N becomes
   * `(N - 1) * ticksPerBar`, so bar 0 is a NEGATIVE start tick handed straight
   * to the seam. `AgentTools.test.ts` drives `tool.run` directly and never sees
   * the schema, so ajv is the only place this bound can be asserted at all.
   */
  it('enforces that a bar number starts at 1, since the tick maths does not', () => {
    const registry = new ToolRegistry();
    registry.register(ALL.map(toToolDef));
    const where = { patternId: 'pt_1', trackId: 'tr_1' };

    expect(registry.validate('composition_place_pattern', { ...where, atBars: [1] })).toEqual({
      ok: true,
    });
    // Bar 0 does not exist; it converts to tick -1920.
    expect(registry.validate('composition_place_pattern', { ...where, atBars: [0] }).ok).toBe(
      false,
    );
    expect(registry.validate('composition_place_pattern', { ...where, atBars: [-1] }).ok).toBe(
      false,
    );
    // `minItems: 1` — an empty list is a call that asks for nothing placed.
    expect(registry.validate('composition_place_pattern', { ...where, atBars: [] }).ok).toBe(false);
    expect(registry.validate('composition_place_pattern', { ...where, atTicks: [] }).ok).toBe(
      false,
    );
    // Ticks are 0-based, and that difference is the whole point of the pair.
    expect(registry.validate('composition_place_pattern', { ...where, atTicks: [0] })).toEqual({
      ok: true,
    });
    expect(registry.validate('composition_place_pattern', { ...where, atTicks: [-1] }).ok).toBe(
      false,
    );
    // Neither is required by the SCHEMA — the exclusivity is a typed refusal in
    // `run`, because `JsonSchema` has no `oneOf` and a schema the validator
    // cannot check would not be enforcing anything.
    expect(registry.validate('composition_place_pattern', where)).toEqual({ ok: true });
  });

  it('marks every tool as running without consent, which is what `mode` records', () => {
    const registry = new ToolRegistry();
    registry.register(ALL.map(toToolDef));
    // The harness gates anything that is not exactly `'auto'` behind
    // `requestConsent`, and this app passes no consent transport — a tool that
    // reached that branch would hang the run rather than fail it.
    for (const name of registry.names()) expect(registry.get(name)?.mode).toBe('auto');
  });
});
