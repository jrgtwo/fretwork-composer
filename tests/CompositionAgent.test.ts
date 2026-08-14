import { describe, expect, it } from 'vitest';
import { COMPOSITION_AGENT, COMPOSITION_WRITE_TOOLS } from '../src/ai/compositionAgent';
import { SHARED_RULES } from '../src/ai/agentRules';
import { PATTERN_AGENT } from '../src/ai/patternAgent';
import { commandsForPage } from '../src/ai/commandCatalog';
import { AGENT_TOOLS } from '../src/ai/tools';
import { COMPOSITION_TOOLS } from '../src/ai/tools/compositionTools';
import { PATTERN_TOOLS } from '../src/ai/tools/patternTools';
import { READ_TOOLS } from '../src/ai/tools/readTools';
import { VOICE_TOOLS } from '../src/ai/tools/voiceTools';

/**
 * AG-07 — the composition page's agent spec.
 *
 * There is no model here and no harness (see `AgentService.test.ts` for why an
 * end-to-end run is not testable in jsdom). What is checked is the three
 * decisions the spec makes, every one of which is silent when it goes wrong:
 *
 *   1. **The list is `AGENT_TOOLS` BY REFERENCE.** That is the only list
 *      carrying `jobWrite`, which is what marks a tool's writes as the running
 *      job's so the job lock lets them through. A re-concatenation of the four
 *      modules looks identical, type-checks, and then has every write refused by
 *      the run's own lock.
 *   2. **It is ALL of them.** A composition job authors its parts as patterns
 *      and picks voices; a narrower list is a job that cannot do what the
 *      catalog's own rows say it does.
 *   3. **Every command the page offers is runnable by the agent its `page`
 *      names** — including the pattern rows edit mode borrows, which run on
 *      `PATTERN_AGENT` and not on this one.
 */

const names = (tools: readonly { name: string }[]) => tools.map((tool) => tool.name);

describe('the composition page agent', () => {
  it('carries the job-lock-wrapped list itself, not an equal copy of it', () => {
    // Reference equality per tool, which is the property that matters: a `run`
    // rebuilt from `COMPOSITION_TOOLS` would pass a name comparison and then be
    // refused by the lock the panel takes around it. A failure names the tool.
    expect(COMPOSITION_AGENT.tools).toHaveLength(AGENT_TOOLS.length);
    for (const [index, tool] of COMPOSITION_AGENT.tools.entries()) {
      expect(`${tool.name}: ${tool === AGENT_TOOLS[index]}`).toBe(`${tool.name}: true`);
    }
  });

  it('carries every tool the app has — reads, patterns, arrangement, voices', () => {
    expect(names(COMPOSITION_AGENT.tools)).toEqual([
      ...names(READ_TOOLS),
      ...names(PATTERN_TOOLS),
      ...names(COMPOSITION_TOOLS),
      ...names(VOICE_TOOLS),
    ]);
    // Reads first: a model handed a tool list reaches for the first thing that
    // fits, and every write needs an id a read returned.
    expect(names(COMPOSITION_AGENT.tools).slice(0, READ_TOOLS.length)).toEqual(names(READ_TOOLS));
  });

  it('carries the PATTERN tools, because a part is authored as a pattern', () => {
    // Not a duplicate of the list check above: this is the ticket's actual claim
    // — nothing writes notes straight onto the arrangement, so a composition job
    // that cannot open and stamp a pattern cannot build a bass line at all. The
    // catalog says the same thing from the other side.
    const carried = new Set(names(COMPOSITION_AGENT.tools));
    expect(carried.has('pattern_open_blank')).toBe(true);
    expect(carried.has('pattern_stamp_notes')).toBe(true);
    const bassLine = commandsForPage('composition').find((c) => c.id === 'composition-bass-line');
    expect(bassLine?.tools).toContain('pattern_open_blank');
  });

  it('can run every command the composition page offers', () => {
    const carried = new Set(names(COMPOSITION_AGENT.tools));
    for (const command of commandsForPage('composition')) {
      for (const tool of command.tools) {
        expect(`${command.id} needs ${tool}`).toBe(
          carried.has(tool) ? `${command.id} needs ${tool}` : `${command.id}: ${tool} is missing`,
        );
      }
    }
  });

  it('leaves edit mode to the pattern agent, which can still run those rows', () => {
    // Edit mode borrows the pattern page's rows and they stay `page: 'pattern'`,
    // so they are driven by `PATTERN_AGENT` against the pattern seam's history.
    // Asserted here because it is the one place both specs are in view.
    const carried = new Set(names(PATTERN_AGENT.tools));
    for (const command of commandsForPage('pattern')) {
      expect(command.page).toBe('pattern');
      for (const tool of command.tools) expect(carried.has(tool)).toBe(true);
    }
  });

  it('states the page’s standing instructions once, for all of its commands', () => {
    // Asserted as substrings because the wording is meant to be edited — what
    // must not vanish is the FACT.
    const prompt = COMPOSITION_AGENT.systemPrompt;
    expect(prompt).toContain('read_composition');
    // The two facts a model reasoning from general musical knowledge gets wrong
    // on this page: a part is a pattern, and a placed block is a deep copy.
    expect(prompt).toContain('pattern_stamp_notes');
    expect(prompt).toMatch(/deep COPY/i);
    // LIB-GAP(15): a track carries no tuning, so a job must not promise how the
    // arrangement sounds.
    expect(prompt).toMatch(/how it will sound/i);
    // THE 2026-08-11 RUN'S ANSWER: "'Blues Guitar Chords' (1-bar chord patterns)
    // at bars 1,4,7,10 (I7-IV7-I7-IV7 progression)" over ONE pattern placed four
    // times. The report has to come off what came BACK, and the invented claim
    // is named rather than left to inference.
    expect(prompt).toMatch(/what the tools RETURNED/i);
    expect(prompt).toMatch(/chord progression the arrangement does not contain/i);
    // ⚠ NOT "your last read". `read_composition` is `noArgs`, so every call to
    // it is identical, and `RESULTS` below forbids repeating a call with reads
    // included — an answer told to read the document again is an answer told to
    // break the rule that is prepended to this very prompt.
    expect(prompt).not.toMatch(/your last read/i);
    // The track cap is a memory limit and refusing is the normal path, not an
    // error to retry.
    expect(prompt).toMatch(/track limit|memory limit/i);
    expect(prompt).toMatch(/"ok":false/);
    // A chord's frets are a LOOKUP, not arithmetic. This page is where it was
    // got wrong: a backing-track run never called the tool, hand-computed bass
    // frets and got them wrong, with the tool named in the command's own
    // template. A template is not a standing rule. The claim, not just the
    // tool's name — "work them out and then check with read_chord_voicings"
    // would name the tool and invert the rule.
    expect(prompt).toContain('read_chord_voicings');
    expect(prompt).toMatch(/LOOKUP, NOT ARITHMETIC/i);
    // WHICH NECK is an argument, and the rule has to say so: the tool used to
    // answer for whichever pattern was open, and the sentence that told the
    // model to "ask again after opening a pattern on a different instrument" is
    // what killed the 2026-08-11 run — it had opened all three patterns first,
    // so the three calls were byte-identical and the loop detector ended it.
    expect(prompt).toMatch(/instrumentId/);
    // Both instruments of a backing track need the same symbols looked up, and
    // `RESULTS` forbids a repeated call in absolute terms — so this must say
    // that a second instrument is a different QUESTION, which is now true of the
    // arguments and not merely of the intent.
    expect(prompt).toMatch(/different question rather than a repeated one/i);
    // And the deleted sentence must stay deleted.
    expect(prompt).not.toMatch(/ask again after opening a pattern/i);
  });

  it('takes the chord rule from the shared rules, so the pattern page has it too', () => {
    // The decision the fix actually made: chord voicings are reachable from both
    // pages, so by `agentRules`' own rule the fact belongs there and not in a
    // page section. Asserted against `SHARED_RULES` because both prompts above
    // would still pass if the paragraph were copied into each page spec — which
    // is the drift this module exists to stop.
    expect(SHARED_RULES).toMatch(/LOOKUP, NOT ARITHMETIC/i);
    expect(SHARED_RULES).toContain('read_chord_voicings');
    // The precondition is GONE from the tool, so the rule must not reimpose it:
    // a model told to open something first goes back to the shape that failed.
    expect(SHARED_RULES).toMatch(/Nothing has to be open to ask/i);
  });

  it('keeps the "describe the arrangement" clause on this PAGE, not in the shared rules', () => {
    // The mirror of the test above, and the placement decision the fix had to
    // make: a chord progression is something only an ARRANGEMENT can fail to
    // contain — the pattern page builds one pattern and has no progression to
    // misreport — so this belongs in the page section. Without this assertion
    // both prompt checks above stay green with the clause moved into
    // `SHARED_RULES`, where it would spend the pattern page's budget too.
    expect(SHARED_RULES).not.toMatch(/chord progression the arrangement does not contain/i);
  });

  it('says a part that follows the changes is more than one pattern', () => {
    // THE 2026-08-11 RUN. It looked C7, F7 and G7 up, got all three right, and
    // then played one of them for twelve bars — every part one pattern stamped
    // twelve times. The chord rule above got the lookup made; nothing said what
    // to DO with three answers, and the cheapest route on offer (`repeat`, one
    // pattern along a track) covers a form with a single chord.
    //
    // Asserted against `SHARED_RULES` for the reason the test above gives, and
    // as the CONSEQUENCE as well as the instruction — a prompt that said "one
    // pattern per chord" without saying what repeating one costs is advice, and
    // this file's other rules are all statements of what is or is not possible.
    expect(SHARED_RULES).toMatch(/ONE PATTERN PER CHORD/i);
    expect(SHARED_RULES).toMatch(/one chord for the whole form/i);
    // In BARS, because `composition_place_pattern` takes them and the rule is
    // about placing one pattern at several of them in a single call.
    expect(SHARED_RULES).toContain('atBars');
    expect(COMPOSITION_AGENT.systemPrompt).toMatch(/ONE PATTERN PER CHORD/i);
  });

  /**
   * "NOTHING MOVES BLOCKS OUT OF EACH OTHER'S WAY" was true of the tool the rule
   * was written for and false of the other two: `composition_move_placement` and
   * `composition_duplicate_placements` both route through `movePlacement`, which
   * runs `clampStartToFreeSlot`. `movePlacementTool`'s own description says so in
   * as many words — and `agentRules` is read BEFORE any tool is chosen, so the
   * unqualified sentence won first. `RESULTS` then turns that into a loop: a
   * model that hand-spaces duplicates, reads the clamped positions back and
   * applies "a difference IS the constraint you have hit" changes approach
   * against a constraint that is not there.
   */
  it('scopes the never-nudged rule to placing, which is the only tool it is true of', () => {
    // The rule survives, for the tool it is about.
    expect(SHARED_RULES).toMatch(/A block you PLACE lands exactly where you put it/i);
    // And the exception is stated, so it cannot be read as universal.
    expect(SHARED_RULES).toMatch(/moving or duplicating/i);
    expect(SHARED_RULES).toMatch(/nearest free slot/i);
    // The absolute form is GONE. Without this the two sentences above can both
    // be added while the contradiction stays in the file.
    expect(SHARED_RULES).not.toMatch(/Nothing moves blocks out of each other's way/i);
  });
});

describe('the write-tool set the run bracket uses', () => {
  it('is every tool the agent carries except the reads, derived rather than retyped', () => {
    expect([...COMPOSITION_WRITE_TOOLS].sort()).toEqual(
      [...names(PATTERN_TOOLS), ...names(COMPOSITION_TOOLS), ...names(VOICE_TOOLS)].sort(),
    );
  });

  it('excludes the reads, so a run that only read is not reported as a write', () => {
    for (const read of READ_TOOLS) expect(COMPOSITION_WRITE_TOOLS.has(read.name)).toBe(false);
  });
});
