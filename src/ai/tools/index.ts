/**
 * The agent's capability layer — AG-04.
 *
 * These are the ONLY things the agent can do to this app, and every one of them
 * is a function the UI already calls. That is the standing constraint of the
 * whole project, checked on all sixteen composition tickets and cashed in here:
 * *every capability is a seam function first and a gesture second*. A tool that
 * reached past `patternService` / `compositionService` / `voiceService` /
 * `playbackService` would be the single failure this design exists to prevent —
 * a rule the UI obeys and the agent walks past, or a lib bug that only bites
 * when the model triggers it.
 *
 * The tool SHAPE is the harness's business, not this layer's — see `./types`.
 * AG-03 adapts `AgentTool` to the runner's `ToolDef`; AG-05 builds the command
 * catalog ON TOP of these, deciding what the USER is offered. This file decides
 * only what is possible.
 *
 * ── Coverage ────────────────────────────────────────────────────────────────
 *
 * The three seams export well over a hundred functions between them and this
 * wraps about thirty, because an unused tool is prompt budget spent on nothing.
 * What each group leaves out, and why, is written at the top of its own file.
 * The two omissions worth knowing here:
 *
 *   - **The transport.** `playbackService` is agent-reachable and nothing below
 *     touches it. Building an arrangement never requires making a sound, and a
 *     tool that started playback would do it in a tab the user may not be
 *     looking at.
 *   - **Harmony as such.** The lib models chords and scales
 *     (`HarmonicContextBlock`, `Pattern.key`/`scaleType`) and NO seam exposes
 *     either, so there is nothing to wrap — see the ticket's Resolution. The
 *     agent works in strings, frets and ticks, which is what the app itself
 *     currently does.
 */
import { COMPOSITION_TOOLS } from './compositionTools';
import { PATTERN_TOOLS } from './patternTools';
import { READ_TOOLS } from './readTools';
import { VOICE_TOOLS } from './voiceTools';
import type { AgentTool } from './types';

export type { AgentTool, ToolResult, JsonSchema, JsonValue } from './types';

/** Reads first: a model that has just been handed a tool list tends to use the
 *  first thing that fits, and every write below needs an id one of these
 *  returns. */
export const AGENT_TOOLS: readonly AgentTool[] = [
  ...READ_TOOLS,
  ...PATTERN_TOOLS,
  ...COMPOSITION_TOOLS,
  ...VOICE_TOOLS,
];

/** Look a tool up by name — what a runner does with a model's tool call. */
export function findTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((tool) => tool.name === name);
}
