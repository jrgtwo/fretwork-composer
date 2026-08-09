/**
 * The pattern page's agent — ONE spec for all six of its commands.
 *
 * It replaces `composerAgent.ts`, which was AG-03's three-note stub and said so
 * in its own header. What is here instead is the real thing: the page's standing
 * instructions and the page's tools, with the TASK supplied per run by the
 * command catalog's filled template.
 *
 * ── One prompt, not one per command ─────────────────────────────────────────
 *
 * The command's `template` already says what to do — it is authored, it is
 * specific, and `commandCatalog.ts` explains at length why the templates read
 * the way they do. Everything below is what is true of the PAGE whichever
 * command is running: read before you write, string index 0 is the low E, a
 * refusal is a sentence you can act on. Six copies of those would be six things
 * to keep in step, which is the same argument that made the catalog a table
 * instead of prose.
 *
 * ── The tool set is the PAGE's, not the command's ───────────────────────────
 *
 * `Command.tools` is deliberately NOT used here. `commandTypes.ts` documents
 * that field as "NOT enforcement — the model still chooses, and a run that finds
 * a better route is not a bug"; handing it to the registry as the tool set would
 * make a better route impossible and turn a piece of documentation into a cage.
 *
 * Nor is it all thirty-seven. Composition tools on a page with no composition
 * open buy nothing but refusals, and every extra schema is prompt budget spent
 * making the choice harder. `voiceTools` stays out for the plainer reason that
 * no pattern command names one.
 *
 * ⚠ `READ_TOOLS` is taken WHOLE, and that includes `read_composition`. It is the
 * one member of the set with nothing to say on this page — it refuses when no
 * composition is open. It is kept because the reads are one vocabulary and
 * splitting them per page would put a second list of tool names somewhere, which
 * is the drift `tools/index.ts` exists to avoid; a read that refuses costs one
 * turn and returns a sentence, which is the cheapest failure in this system.
 */
import { PATTERN_TOOLS } from './tools/patternTools';
import { READ_TOOLS } from './tools/readTools';
import type { AgentSpec } from './agentService';

/**
 * The names of the page's tools that can CHANGE the pattern.
 *
 * Exported for the run-level undo bracket, which has to decide whether to push
 * an undo step at all — see `CommandPanel`. It is derived from `PATTERN_TOOLS`
 * rather than written out, so a tool added there is covered by the bracket
 * without anybody remembering to add its name here.
 *
 * The reads are excluded because every command opens with `read_pattern`, and a
 * run that read the pattern and then failed must not leave an undo step
 * restoring a state nothing ever left.
 */
export const PATTERN_WRITE_TOOLS: ReadonlySet<string> = new Set(
  PATTERN_TOOLS.map((tool) => tool.name),
);

export const PATTERN_AGENT: AgentSpec = {
  name: 'pattern',
  systemPrompt: [
    'You are editing ONE guitar pattern inside a pattern editor. The user can see it; you cannot. You act only by calling tools — anything you merely describe did not happen.',
    'Call read_pattern before you change anything. It is the only thing that tells you the ticks per quarter note, the time signature, the instrument, how many strings it has, how far up the neck you can go, and the id of every note. Note ids come from there; do not invent them.',
    'String index 0 is the lowest-pitched string on a standard guitar — the low E. Higher indices go towards the high E. Times and durations are in ticks, never in bars or seconds.',
    'The tools that take a list take the WHOLE list. Send one call per kind of edit rather than one call per note: a batch is a single step for the user to undo, and a pattern edited one note per call runs out of turns before it is finished.',
    'A tool result of the form {"ok":false,"reason":"…"} is a refusal, not a crash. The reason says exactly what was wrong — read it, fix that, and do not repeat the identical call.',
    'Stop when the command you were given is done, and finish with one or two sentences saying what you actually changed.',
  ].join('\n'),
  // Reads first, for `AGENT_TOOLS`' reason: a model handed a tool list reaches
  // for the first thing that fits, and every write below needs an id a read
  // returned.
  tools: [...READ_TOOLS, ...PATTERN_TOOLS],
};
