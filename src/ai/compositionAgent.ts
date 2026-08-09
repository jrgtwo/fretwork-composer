/**
 * The composition page's agent — ONE spec for all seven of its commands, and for
 * the generation jobs they start.
 *
 * Written the way `patternAgent.ts` is, and for the same reason: the command's
 * `template` is the TASK and the catalog explains at length why the templates
 * read as they do, so what is left here is what is true of the PAGE whichever
 * command is running. Seven copies of "a placed block is a deep copy" would be
 * seven things to keep in step.
 *
 * ── IT GETS ALL THIRTY-SEVEN TOOLS, AND THAT IS THE DESIGN ──────────────────
 *
 * `patternAgent` carries fourteen and argues that the composition tools would
 * "buy nothing but refusals" on a page with no composition open. Turned around,
 * the same argument gives this one everything:
 *
 *   - A composition job legitimately AUTHORS THE PARTS. There is no tool that
 *     writes notes onto the arrangement, because there is no such thing — a
 *     block is a pattern, so building a bass line is `pattern_open_blank`,
 *     `pattern_stamp_notes` and then `composition_place_pattern`. The catalog
 *     says so itself: `composition-bass-line` names both pattern tools in its
 *     own `tools` list.
 *   - EDIT MODE runs the pattern page's commands against a placement (see
 *     `Command.mode`), which is a `PATTERN_AGENT` run and not this one — but the
 *     pattern tools are here regardless, because a job that has just stamped a
 *     riff may need to fix it before placing it.
 *   - `voiceTools` is here because two of the seven commands are voice-mode rows
 *     that reach `voice_set_for_track`, and because choosing a tone is part of
 *     "make me a backing track".
 *
 * What is NOT claimed: that thirty-seven schemas are free. They are prompt
 * budget, and a smaller list would be a cheaper prompt. The trade is deliberate
 * — a job that cannot reach a tool takes a worse route or gives up, and the
 * page's whole product claim is that one command builds a whole arrangement.
 *
 * ⚠ THE LIST IS `AGENT_TOOLS`, BY REFERENCE, AND NOT A RE-CONCATENATION OF THE
 * FOUR MODULES. It is the only list carrying `jobWrite` (see `tools/index.ts`),
 * which is what marks a tool's writes as the running job's so the job lock lets
 * them through. Rebuilt out of `COMPOSITION_TOOLS` and friends it would look
 * identical, type-check, and then have every one of its own writes refused by
 * its own lock the moment a run started. `tests/CompositionAgent.test.ts` pins
 * the identity for exactly that reason.
 */
import { AGENT_TOOLS } from './tools';
import { READ_TOOLS } from './tools/readTools';
import type { AgentSpec } from './agentService';
import { pagePrompt } from './agentRules';

const READ_NAMES: ReadonlySet<string> = new Set(READ_TOOLS.map((tool) => tool.name));

/**
 * The names of the page's tools that can CHANGE something.
 *
 * Everything the agent carries except the reads — derived, so a tool added to
 * any of the four modules is covered without anybody remembering to add its name
 * here. Exported for a panel that has to decide whether a run wrote anything at
 * all; the composition seam's own reference test is the better answer where it
 * applies (see `CompositionCommandPanel`), and this is what covers the runs that
 * touch the PATTERN library instead.
 *
 * The reads are excluded because every command opens with one, and a run that
 * read and then failed must not leave an undo step restoring a state nothing
 * ever left.
 */
export const COMPOSITION_WRITE_TOOLS: ReadonlySet<string> = new Set(
  AGENT_TOOLS.map((tool) => tool.name).filter((name) => !READ_NAMES.has(name)),
);

/**
 * What is true of THIS page and not of the pattern page.
 *
 * The order is the order a job needs them in: what the document is, then the
 * one structural fact that decides every route through the tools (a part is a
 * pattern), then the two limits a long job actually runs into, then how to
 * report. Everything general is in `agentRules`.
 *
 * "Never say how it will sound" is the one instruction here that constrains the
 * ANSWER rather than the work, and it is not politeness: LIB-GAP(15) means a
 * track carries no tuning, so a bass part in a guitar composition sounds an
 * octave high. A job that promised a sound would be wrong through no fault of
 * its own, and the catalog's templates are worded to avoid the same trap.
 */
const COMPOSITION_PAGE = `# The arrangement

You are building a multi-track arrangement. \`read_composition\` tells you the tempo, the time signature, the ticks per quarter note, which tracks exist and their ids, and every block already placed with its own id and span. Ids come from there.

A PART IS A PATTERN. Nothing writes notes straight onto the arrangement, because there is no such thing: author the notes with \`pattern_open_blank\` and \`pattern_stamp_notes\`, then put the result on a track with \`composition_place_pattern\`. Get the pattern right BEFORE you place it — a placed block is a deep COPY, so editing the pattern afterwards does not reach the block, and fixing a block means replacing it.

The TRACK LIMIT is a memory limit, not a preference — each track loads its own sample bank. When adding a track is refused, build what you can on the tracks that already exist and say so in your answer.

A track's TONE is a voice. \`voice_list_for_track\` is how you find the ones that exist; \`voice_set_for_track\` picks one. A track you never voice still plays.

# Your answer

Say what you BUILT — which tracks, how many blocks, how many bars. Never say how it will SOUND: a track carries no tuning of its own, so you cannot know what pitch it comes out at.`;

export const COMPOSITION_AGENT: AgentSpec = {
  name: 'composition',
  systemPrompt: pagePrompt(COMPOSITION_PAGE),
  tools: AGENT_TOOLS,
};
