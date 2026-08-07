import { describe, expect, it } from 'vitest';
import { ToolRegistry } from 'agent-harness/browser';
import { toToolDef } from '../src/ai/agentService';
import { SKETCH_STUB_RIFF } from '../src/ai/composerAgent';
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
  /** Every tool the app has, plus the stub, which is not in `AGENT_TOOLS`. */
  const ALL = [...AGENT_TOOLS, SKETCH_STUB_RIFF];

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

    // The stub's only argument is optional, so no arguments is valid.
    expect(registry.validate('sketch_stub_riff', {})).toEqual({ ok: true });
    // `minLength: 1` — the whole reason the tool uses the `name` helper and not
    // `str`. The lib names a pattern by default parameter, so `''` would be
    // stored verbatim as an unlabelled row in the library.
    expect(registry.validate('sketch_stub_riff', { name: '' }).ok).toBe(false);
    // `additionalProperties: false` on every tool: a misspelt argument has to be
    // a validation error the model can read, not an instruction silently
    // dropped.
    expect(registry.validate('sketch_stub_riff', { nmae: 'typo' }).ok).toBe(false);
    // And a required argument that is missing, on a real tool.
    expect(registry.validate('pattern_stamp_notes', {}).ok).toBe(false);
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
