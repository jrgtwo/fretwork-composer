import { describe, expect, it } from 'vitest';
import { PATTERN_AGENT, PATTERN_WRITE_TOOLS } from '../src/ai/patternAgent';
import { commandsForPage } from '../src/ai/commandCatalog';
import { AGENT_TOOLS } from '../src/ai/tools';
import { PATTERN_TOOLS } from '../src/ai/tools/patternTools';
import { READ_TOOLS } from '../src/ai/tools/readTools';

/**
 * AG-06 — the pattern page's agent spec.
 *
 * There is no model here and no harness. What is checked is the two decisions
 * the spec actually makes, both of which are silent when they go wrong:
 *
 *   1. **The tool set is the PAGE's.** Too narrow (a command's own `tools`) and
 *      a run that finds a better route cannot take it — which `commandTypes`
 *      explicitly says is not a bug. Too wide (all thirty-seven) and the model
 *      is choosing between composition tools it has no composition for. Neither
 *      failure shows up as anything but worse runs.
 *   2. **Every command the page offers is RUNNABLE by it.** A command naming a
 *      tool the spec does not carry is a row that can only ever half-work, and
 *      nothing else in the suite compares the two lists.
 */

const names = (tools: readonly { name: string }[]) => tools.map((tool) => tool.name);

describe('the pattern page agent', () => {
  it('carries the page’s tools — the reads and the pattern writes, in that order', () => {
    expect(names(PATTERN_AGENT.tools)).toEqual([...names(READ_TOOLS), ...names(PATTERN_TOOLS)]);
  });

  it('leaves out every tool that belongs to another page', () => {
    const carried = new Set(names(PATTERN_AGENT.tools));
    const missing = AGENT_TOOLS.filter((tool) => !carried.has(tool.name)).map((t) => t.name);
    // Stated as a fact about the leftovers rather than a count: a failure names
    // the tool that leaked in or fell out.
    expect(missing.every((name) => name.startsWith('composition_') || name.startsWith('voice_'))).toBe(
      true,
    );
    expect(carried.size).toBeLessThan(AGENT_TOOLS.length);
  });

  it('can run every command the page offers', () => {
    const carried = new Set(names(PATTERN_AGENT.tools));
    for (const command of commandsForPage('pattern')) {
      for (const tool of command.tools) {
        expect(`${command.id} needs ${tool}`).toBe(
          carried.has(tool) ? `${command.id} needs ${tool}` : `${command.id}: ${tool} is missing`,
        );
      }
    }
  });

  it('offers six commands on the pattern page, and none of them belong elsewhere', () => {
    const commands = commandsForPage('pattern');
    expect(commands).toHaveLength(6);
    for (const command of commands) expect(command.page).toBe('pattern');
  });

  it('states the page’s standing instructions once, for all six commands', () => {
    // ONE prompt, not one per command: the command's template is the task, and
    // these are true whichever one is running. Asserted as substrings because
    // the wording is meant to be edited — what must not vanish is the FACT.
    const prompt = PATTERN_AGENT.systemPrompt;
    expect(prompt).toContain('read_pattern');
    // The single likeliest way for an agent edit to land on the wrong string.
    expect(prompt).toMatch(/String index 0/i);
    // A chord's frets are a LOOKUP. Stated up here rather than left to
    // `read_chord_voicings`'s description, because a description is read after
    // the tool has been chosen and the tool that never gets chosen is exactly
    // the failure this covers. The claim is asserted as well as the name: a
    // paragraph saying to work the shapes out and check them afterwards would
    // satisfy the name alone and be the opposite instruction.
    expect(prompt).toContain('read_chord_voicings');
    expect(prompt).toMatch(/LOOKUP, NOT ARITHMETIC/i);
    // Which neck is an ARGUMENT now, and the rule must not send the model back
    // to opening a pattern first — that ordering is what the 2026-08-11 run died
    // of, three identical calls expecting three different necks.
    expect(prompt).toMatch(/instrumentId/);
    expect(prompt).not.toMatch(/ask again after opening a pattern/i);
    // The counterweight to `repeat`, which is CALLED from this page even when
    // the arrangement it is feeding lives on the other one: every pass is the
    // same notes, so a part that follows the changes is one pattern per chord.
    // It reaches here through the shared length rules; a copy in the
    // composition page's own section would leave the page that does the
    // stamping without it.
    expect(prompt).toMatch(/ONE PATTERN PER CHORD/i);
    // A refusal is text to act on, not a crash — the seams author those
    // sentences and AG-04 hands them to the model.
    expect(prompt).toMatch(/"ok":false/);
    expect(prompt).toMatch(/refusal/i);
  });
});

describe('the write-tool set the undo bracket uses', () => {
  it('is exactly the pattern tools, derived rather than retyped', () => {
    expect([...PATTERN_WRITE_TOOLS].sort()).toEqual(names(PATTERN_TOOLS).slice().sort());
  });

  it('excludes the reads, so a run that only read pushes no undo step', () => {
    // Every command opens with `read_pattern`. Counting it as a write would put
    // an undo step on the end of every failed run, and the user's next undo
    // would spend itself restoring a state nothing ever left.
    for (const read of READ_TOOLS) expect(PATTERN_WRITE_TOOLS.has(read.name)).toBe(false);
  });
});
