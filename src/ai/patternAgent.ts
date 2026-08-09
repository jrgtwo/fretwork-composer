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
import { pagePrompt } from './agentRules';

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

/**
 * What is true of THIS page and not of the composition page.
 *
 * Everything general — ticks, batching, how to read a clamped result, that a
 * pattern's length is its notes — is in `agentRules`, shared. What is left is
 * the scope of a run and what the one read hands back.
 *
 * The scope line matters more than it looks: this same spec runs the six pattern
 * commands on the COMPOSITION page's edit mode, where the "pattern" is a block's
 * own copy. Naming the target as "the open pattern" rather than as a library
 * pattern keeps that true without the model having to know which surface it is
 * on — it is pointed at one document either way, and `read_pattern` is what says
 * which.
 */
const PATTERN_PAGE = `# The pattern

You are editing ONE guitar pattern. It is the only document you can reach: there is no tool here that opens another, and every write lands on whatever \`read_pattern\` last described.

\`read_pattern\` is the only thing that tells you the ticks per quarter note, the time signature, the instrument, how many strings it has, how far up the neck you can go, and the id of every note. Note ids come from there.`;

export const PATTERN_AGENT: AgentSpec = {
  name: 'pattern',
  systemPrompt: pagePrompt(PATTERN_PAGE),
  // Reads first, for `AGENT_TOOLS`' reason: a model handed a tool list reaches
  // for the first thing that fits, and every write below needs an id a read
  // returned.
  tools: [...READ_TOOLS, ...PATTERN_TOOLS],
};
