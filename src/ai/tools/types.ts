/**
 * The shape of an agent tool — deliberately NOT the harness's.
 *
 * AG-03 embeds `agent-harness` and adapts what is here to its `ToolDef`. This
 * module names no harness type and imports nothing, on purpose: the capability
 * layer says what the app can DO, and which runner drives it is a separate
 * question with a separate answer (a hosted loop, a one-shot structured call,
 * a test). A tool that could only be built by importing the runner would have to
 * be rebuilt to swap it.
 *
 * A tool is three things and no more:
 *
 *   - a `name` the model calls,
 *   - a JSON Schema for its arguments, which is ENFORCEMENT and not advice —
 *     the harness validates against it with `ajv` before `run` is reached, so an
 *     instrument or groove that does not exist is rejected before any app code
 *     sees it;
 *   - a `run` that returns a {@link ToolResult}.
 *
 * ⚠ Every tool goes through one of the four seams (`patternService`,
 * `compositionService`, `voiceService`, `playbackService`). A tool that imports
 * `@fretwork/lib`'s stores or `composition-ops` is a defect and not a shortcut:
 * the whole design is that the agent reaches the SAME code path the UI reaches,
 * so a rule the UI obeys cannot be walked past by asking the model nicely.
 */

// ------------------------------------------------------------------ json ---

export type JsonPrimitive = string | number | boolean | null;

export interface JsonObject {
  // `undefined` is allowed so a mapper can leave an absent field absent —
  // `JSON.stringify` drops those keys, which is what the model should see.
  readonly [key: string]: JsonValue | undefined;
}

export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

// ---------------------------------------------------------------- schema ---

export type JsonSchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null';

/** The JSON Schema subset these tools use. Narrow on purpose — a schema a
 *  validator can't check is a schema that isn't enforcing anything. */
export interface JsonSchema {
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  readonly description?: string;
  readonly enum?: readonly JsonPrimitive[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
}

/** A string, optionally constrained to a list. The list always comes from the
 *  lib (through a seam), never from a literal written here. */
export const str = (description: string, values?: readonly string[]): JsonSchema =>
  values === undefined
    ? { type: 'string', description }
    : { type: 'string', description, enum: values };

/**
 * A name. `minLength` because the seams REFUSE a blank one — a track's name is
 * what every control on it is labelled with — and a rule the validator can
 * express is a rule the model is told about before it spends a call on it.
 * Whitespace still reaches the seam, which trims; the schema catches only `''`.
 */
export const name = (description: string): JsonSchema => ({
  type: 'string',
  description,
  minLength: 1,
});

export const int = (
  description: string,
  range?: { min?: number; max?: number },
): JsonSchema => ({
  type: 'integer',
  description,
  ...(range?.min === undefined ? {} : { minimum: range.min }),
  ...(range?.max === undefined ? {} : { maximum: range.max }),
});

export const num = (
  description: string,
  range?: { min?: number; max?: number },
): JsonSchema => ({
  type: 'number',
  description,
  ...(range?.min === undefined ? {} : { minimum: range.min }),
  ...(range?.max === undefined ? {} : { maximum: range.max }),
});

/** A number constrained to a list — the numeric counterpart of `str`'s enum, and
 *  used for the same reason: the list is the app's own and never a range someone
 *  guessed the ends of. */
export const numFrom = (description: string, values: readonly number[]): JsonSchema => ({
  type: 'number',
  description,
  enum: [...values],
});

export const bool = (description: string): JsonSchema => ({ type: 'boolean', description });

/**
 * Allow `null` as well — which is how the model spells "clear this".
 *
 * `null` has to be added to `enum` as well as to `type`, or a validator that
 * checks both (ajv does) rejects the value on the enum after accepting it on the
 * type. Easy to get half-right and impossible to notice until a clear is
 * refused as a schema error the model cannot read.
 */
export const nullable = (schema: JsonSchema): JsonSchema => ({
  ...schema,
  type: schema.type === undefined ? 'null' : [...[schema.type].flat(), 'null'],
  ...(schema.enum === undefined ? {} : { enum: [...schema.enum, null] }),
});

/**
 * A list, with both ends bound.
 *
 * ⚠ `maxItems` is REQUIRED, and that is the point of it. Every array here was
 * unbounded until 2026-09-18, which is the surface a runaway tool call is
 * written on: one `pattern_stamp_notes` carrying 800 notes is tens of thousands
 * of argument tokens, and the model only finds out it went too far when the
 * provider truncates it mid-JSON — malformed, unparseable, and reported as
 * nothing more useful than "unexpected end of input". A default here would let
 * the next array added slip back through, so there isn't one.
 *
 * A ceiling is the opposite kind of bound in two ways that matter. It is in the
 * schema, so the model reads it BEFORE it writes rather than discovering it
 * after; and the harness compiles these with `ajv` and checks every call against
 * them (`agent-harness/src/agent/loop.ts`), so going over comes back as a
 * validation error the model can act on — send fewer, or split the work — while
 * the pattern is left untouched.
 *
 * Picking one: it is a bound on a RUNAWAY, not a budget for normal work. Set it
 * where a legitimate call cannot reach and an absurd one cannot pass. Refusing
 * work the app invites is the expensive mistake — `agentRules.ts` tells the
 * model to send one call per kind of edit carrying the whole list, so a ceiling
 * under that is the app contradicting itself, and the user meets it as a command
 * that fails for no reason they can see.
 */
export const arr = (items: JsonSchema, description: string, maxItems: number): JsonSchema => ({
  type: 'array',
  description,
  items,
  minItems: 1,
  maxItems,
});

/**
 * The three ceilings, in one place so a new tool picks one rather than inventing
 * a fourth. Settled 2026-09-18; the reasoning for each is below, and
 * `arr`'s header says how to think about a ceiling at all.
 *
 * NOTES — one call may carry 256 notes. A stamped note costs ~19 tokens
 * (`{"stringIndex":2,"fret":5,"tick":480,"durationTicks":240}` at the ~3.06
 * chars/token this app's JSON measures), so 256 is ~4900 tokens of arguments:
 * the largest call that still leaves a tool run room to reason inside its own
 * ceiling. The only real shape it refuses is four bars of sixteenths across six
 * strings (384), which `pattern_stamp_notes`'s `repeat` expresses better anyway.
 *
 * The EDIT lists share it rather than taking a smaller number of their own.
 * They address notes that are already in the pattern, so a stamp is what put
 * them there and the stamp ceiling already bounds them upstream; and
 * `agentRules.ts` tells the model to send one call per kind of edit carrying the
 * whole list, so a lower ceiling would refuse the agent re-voicing a pattern it
 * had just written. Matching numbers mean one call can always address a pattern
 * the size of one stamp.
 *
 * PLACEMENTS — 64. One block per bar over a 64-bar form, which is longer than
 * anything the app is used for; `agentRules.ts` has the model place a chord's
 * pattern at every bar that chord covers, so this is the list that most wants
 * headroom.
 *
 * CHORD SYMBOLS — 32. A progression, not a form: `read_chord_voicings` is told
 * in its own description to ask for the whole progression in one call, and a
 * twelve-bar blues is six.
 */
export const MAX_NOTES_PER_CALL = 256;
export const MAX_PLACEMENTS_PER_CALL = 64;
export const MAX_CHORD_SYMBOLS_PER_CALL = 32;

/**
 * An object schema. `additionalProperties: false` on every one of them, so a
 * misspelt argument is a validation error rather than a silently ignored
 * instruction — the failure mode where the model believes it set something.
 */
export const obj = (
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = [],
): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

/** No arguments at all — the read tools. */
export const noArgs: JsonSchema = obj({});

// ---------------------------------------------------------------- result ---

/**
 * What a tool hands back to the model.
 *
 * A refusal is RETURNED, never thrown and never silent, and carries the seam's
 * own reason: "no such track" is a thing a model can recover from and "it did
 * nothing" is not. The whole point of the seams returning `Result` is that this
 * sentence exists to pass on.
 */
export type ToolResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly reason: string };

export const ok = (value: JsonValue): ToolResult => ({ ok: true, value });
export const fail = (reason: string): ToolResult => ({ ok: false, reason });

/** How many refusals a refusal sentence names before it stops. A 200-entry
 *  batch that fails end to end is one sentence per entry otherwise, which is
 *  prompt budget spent restating the same thing. */
export const REFUSALS_NAMED = 10;

/**
 * The refusals, named. A model can only recover from a refusal it can act on,
 * and "some of them are wrong" is not one — these sentences are the seam's
 * product and are passed on verbatim, one per entry.
 *
 * Lives HERE rather than beside its first caller because it is the batch rule
 * itself and not one tool's formatting: every batching tool caps the same way,
 * and a cap a new call site has to remember to opt into is a cap that reads as
 * house style until the first uncapped reply.
 */
export function namedRefusals(refused: readonly { label: string; reason: string }[]): string {
  const named = refused
    .slice(0, REFUSALS_NAMED)
    .map((entry) => `${entry.label}: ${entry.reason}`)
    .join(' ');
  const rest = refused.length - REFUSALS_NAMED;
  return rest > 0 ? `${named} …and ${rest} more.` : named;
}

/** The seams' `Result<T>`, as this module sees it. Structural rather than
 *  imported so `types.ts` stays dependency-free; it is the same type. */
type SeamResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/**
 * Pass a seam `Result` straight through, mapping the success value into JSON.
 *
 * The refusal text is the SEAM's, verbatim. Rewording it here would put the
 * sentence the model reads out of step with the one the UI shows for the same
 * refusal, and the seam is where that sentence is authored precisely because
 * both surfaces need it.
 */
export function fromResult<T>(
  result: SeamResult<T>,
  toValue: (value: T) => JsonValue,
): ToolResult {
  return result.ok ? ok(toValue(result.value)) : fail(result.reason);
}

// ------------------------------------------------------------------ tool ---

export interface AgentTool {
  readonly name: string;
  readonly description: string;
  /** Always an object schema — every provider's tool-calling API expects one. */
  readonly parameters: JsonSchema;
  readonly run: (args: unknown) => ToolResult;
}

/**
 * Define a tool with typed arguments.
 *
 * The one cast in the layer lives here, and this is what it is worth: the
 * harness validates `args` against `parameters` before calling, so by the time
 * `run` is reached the arguments HAVE the declared shape. Making every handler
 * re-narrow `unknown` would be re-implementing the validator thirty times, and
 * badly.
 *
 * The `catch` is not defensive padding. A throw escaping into the agent loop
 * ends the run; the same failure as a returned refusal is something the model
 * can read and work around, which is the same reason the seams refuse rather
 * than throw. It should stay unreachable — the seams return their refusals —
 * so anything that lands here is a bug, and it says so in the message.
 */
export function defineTool<A>(spec: {
  name: string;
  description: string;
  parameters: JsonSchema;
  run: (args: A) => ToolResult;
}): AgentTool {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    run: (args: unknown) => {
      try {
        return spec.run(args as A);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return fail(`${spec.name} failed unexpectedly (this is a bug): ${detail}`);
      }
    },
  };
}
