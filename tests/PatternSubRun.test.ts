import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PATTERN_SUB_RUN_AGENT,
  SUB_RUN_TOOL_NAMES,
  patternRunInput,
} from '../src/ai/patternSubRun';
import { PATTERN_AGENT } from '../src/ai/patternAgent';
import { reviewPlan } from '../src/ai/arrangementPlan';
import { AGENT_TOOLS } from '../src/ai/tools';
import { chordGrip } from '../src/patterns/patternService';
import type { PlannedPattern } from '../src/ai/arrangementPlanSchema';

/**
 * OR-03 — the sub-run: one pattern, one chord, one instrument.
 *
 * ⚠ NO MODEL IN THIS FILE, and none is needed. Both halves of the ticket are
 * checkable without one: the tool list is a list of names, and the brief is a
 * pure function of a plan entry. What no test here can check is whether the
 * brief produces better music — that is the listening test's, and this file
 * exists so that what it listens to is the thing that will ship.
 */

/** ⚠ THE NAME CARRIES NO CHORD SYMBOL, deliberately. With a name like "Walking
 *  Bass F7" every `toContain('F7')` below passes on the interpolated name alone,
 *  and deleting the chord from the brief entirely would fail nothing. */
const bassLine = (): PlannedPattern => ({
  name: 'Walking Bass',
  instrumentId: 'bass',
  chord: 'F7',
  lengthBars: 1,
});

const brief = (pattern: PlannedPattern): string => {
  const result = patternRunInput(pattern);
  if (!result.ok) throw new Error(`patternRunInput refused: ${result.reason}`);
  return result.value;
};

const toolNames = (): readonly string[] => PATTERN_SUB_RUN_AGENT.tools.map((tool) => tool.name);

afterEach(() => {
  vi.useRealTimers();
});

// ------------------------------------------------------------------ tools ---

/**
 * THE GUARANTEE THE REST OF THE EPIC RESTS ON. Asserted by NAME over the built
 * list rather than against a constant, because a constant would agree with
 * whatever someone widened it to. `AgentSpec.tools` is what `toHarnessAgent`
 * registers, so a name absent from here cannot be called at all.
 */
describe('the sub-run is restricted to writing one pattern', () => {
  it('offers no composition tool and no voice tool', () => {
    expect(toolNames().filter((name) => name.startsWith('composition_'))).toEqual([]);
    expect(toolNames().filter((name) => name.startsWith('voice_'))).toEqual([]);
  });

  it('offers nothing that opens a pattern', () => {
    // `pattern_open` does not exist in this build. Named anyway: the day it does,
    // it must not appear here, and a test that only knew about `pattern_open_blank`
    // would pass on the day the pointer starts moving under the orchestrator.
    expect(toolNames()).not.toContain('pattern_open_blank');
    expect(toolNames()).not.toContain('pattern_open');
    expect(toolNames().filter((name) => name.includes('open'))).toEqual([]);
  });

  it('cannot change the instrument the injected frets were voiced for', () => {
    // Not a `composition_*`, not a `voice_*`, does not contain "open" — so every
    // other test in this block passes with it added. It is the one addition that
    // silently invalidates the brief: the grip in the prompt is for the plan's
    // neck, and a run that switched necks would leave those frets describing a
    // different instrument with every stamp still landing in range.
    expect(toolNames()).not.toContain('pattern_set_instrument');
  });

  it('is exactly the declared list and nothing more', () => {
    // The prefix and by-name prohibitions above are what stop someone widening
    // the constant; this is what stops the built list widening without anyone
    // editing the constant at all, and makes any widening a deliberate act.
    expect([...toolNames()].sort()).toEqual([...SUB_RUN_TOOL_NAMES].sort());
    expect(SUB_RUN_TOOL_NAMES).toEqual([
      'read_pattern',
      'pattern_stamp_notes',
      'pattern_set_dynamics',
      'pattern_set_articulations',
      'pattern_delete_notes',
    ]);
  });

  it('takes the tools from AGENT_TOOLS, so its writes carry the job-lock wrap', () => {
    // BY IDENTITY, not by name. `AGENT_TOOLS` is the only list whose writes are
    // wrapped in `asJobWrite`; rebuilding this from `[...READ_TOOLS,
    // ...PATTERN_TOOLS]` gives identical names, type-checks, and loses the
    // exemption the day an orchestrator holds a composition job lock.
    // `CompositionAgent.test.ts` pins the same property the same way.
    for (const tool of PATTERN_SUB_RUN_AGENT.tools) expect(AGENT_TOOLS).toContain(tool);
  });

  it('can read the pattern and write notes into it', () => {
    expect(toolNames()).toContain('read_pattern');
    expect(toolNames()).toContain('pattern_stamp_notes');
  });

  it('is narrower than the pattern page it borrows its rules from', () => {
    const page = PATTERN_AGENT.tools.map((tool) => tool.name);
    for (const name of toolNames()) expect(page).toContain(name);
    expect(toolNames().length).toBeLessThan(page.length);
  });

  it('uses the pattern page rules, not a prompt of its own', () => {
    expect(PATTERN_SUB_RUN_AGENT.systemPrompt).toBe(PATTERN_AGENT.systemPrompt);
  });
});

// ------------------------------------------------------------------ brief ---

describe('the brief', () => {
  it('names the chord, the instrument and how many bars', () => {
    // The name is "Comping" and not "Comp C7": with the symbol in the name the
    // chord assertion below passes even if the brief never mentions the chord.
    const text = brief({
      name: 'Comping',
      instrumentId: 'guitar',
      chord: 'C7',
      lengthBars: 2,
    });
    expect(text).toContain('C7');
    expect(text).toContain('Guitar');
    expect(text).toContain('2 bars');
    expect(text).toContain('Comping');
  });

  it('asks for music rather than for a data structure', () => {
    const text = brief(bassLine());
    // The ask itself, in the words a reader would check it by.
    expect(text).toContain('Write "Walking Bass": 1 bar of Bass over F7');
    // What the part is FOR, which is the half that asks for music at all.
    expect(text).toContain('Its name is what the part is FOR');
    // The failure the whole epic is reacting to, forbidden in advance.
    expect(text).toContain('Do not stamp the shape once at the top of the bar and stop');
    expect(text).toContain('A bar has more than one attack in it');
  });

  it('countermands the shared rule about writing one pattern per chord', () => {
    // `SHARED_RULES` → `LENGTH` is prepended to every page prompt and half of it
    // is about the composition: `atBars`, block spacing, resize, duplicate, and
    // "write ONE PATTERN PER CHORD and place each at every bar its chord
    // covers". This run can write exactly one pattern and has none of those
    // tools, so the instruction has to be withdrawn where the run will read it.
    expect(PATTERN_SUB_RUN_AGENT.systemPrompt).toContain('ONE PATTERN PER CHORD');
    expect(PATTERN_SUB_RUN_AGENT.systemPrompt).toContain('composition_place_pattern');
    expect(toolNames().filter((name) => name.startsWith('composition_'))).toEqual([]);

    const text = brief(bassLine());
    expect(text).toContain('THERE IS NO ARRANGEMENT IN THIS RUN');
    expect(text).toContain('ONE PATTERN PER CHORD and placing each where its chord runs');
  });

  it('says there is no chord lookup, since the run has not got one', () => {
    // The counter to `agentRules`' NECK section, which tells every run on this
    // prompt to ask `read_chord_voicings`. That instruction is in the system
    // prompt this spec reuses, and the tool is not in its list.
    expect(PATTERN_SUB_RUN_AGENT.systemPrompt).toContain('read_chord_voicings');
    expect(toolNames()).not.toContain('read_chord_voicings');
    expect(brief(bassLine())).toContain('THERE IS NO CHORD LOOKUP IN THIS RUN');
  });

  it('measures the length by where notes END, not where they start', () => {
    // `fitPatternDuration` takes `max(startTick + durationTicks)` and rounds
    // that UP to a bar, so a note starting well inside the last bar and ringing
    // past its barline buys a whole extra bar. A rule phrased about where notes
    // START does not cover that case, and it is the likely one right after the
    // brief has asked for notes of varied length.
    const oneBar = brief(bassLine());
    expect(oneBar).toContain('every note must END by the end of bar 1');
    expect(oneBar).toContain('makes this 2 bars long');
    // The arithmetic is "one bar longer than asked", not the asked length.
    expect(brief({ ...bassLine(), lengthBars: 4 })).toContain('makes this 5 bars long');
  });

  it('tells the run to check the open pattern is on the neck the frets are for', () => {
    // The cost of injecting the grip: the frets are neck-specific and somebody
    // else opened the pattern. A bass grip stamped into a guitar pattern lands
    // on strings 0-3 with nothing refused and sounds like another chord.
    const text = brief(bassLine());
    expect(text).toContain('that must be Bass');
    expect(text).toContain('write nothing and say so');
    expect(toolNames()).not.toContain('pattern_set_instrument');
  });

  it('does not promise note ids back from a repeated stamp', () => {
    // `pattern_stamp_notes` sets `itemise = times === 1` and drops `placed`
    // entirely for a repeat, so the ids the two marking tools need do not come
    // back. Recovering by re-reading is what `RESULTS` in this very system
    // prompt forbids ("NEVER MAKE THE SAME CALL TWICE … reads included") and
    // `read_pattern` takes no arguments, so the second call is byte-identical.
    // The brief therefore routes around it rather than carving an exception.
    const text = brief({ ...bassLine(), lengthBars: 4 });
    expect(text).toContain('EXCEPT on a call that used `repeat`, which reports counts only');
    expect(text).toContain('anything you mean to mark is stamped out rather than repeated');
    expect(text).toContain('hands back no note ids');
  });

  it('only argues against repeating bars when there is more than one', () => {
    const oneBar = brief(bassLine());
    const fourBars = brief({ ...bassLine(), lengthBars: 4 });
    // The SENTENCE, not the word: "repeat" appears in the marks section of every
    // brief, and a bare substring check would fail the day anyone writes
    // "repeated" into the shared text for an unrelated reason.
    expect(oneBar).not.toContain('the part goes somewhere');
    expect(oneBar).not.toContain('`repeat` is for a figure that genuinely recurs');
    expect(fourBars).toContain('Over 4 bars the part goes somewhere');
    expect(fourBars).toContain('`repeat` is for a figure that genuinely recurs');
  });

  it('is the same brief every time for the same plan entry', () => {
    // Pure: no clock, no randomness. The clock is MOVED between the two calls
    // rather than trusted to move on its own — two synchronous calls land in the
    // same millisecond, so a hidden `Date.now()` would pass and flake later.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const first = brief(bassLine());
    vi.setSystemTime(new Date('2026-08-15T12:34:56Z'));
    expect(brief(bassLine())).toBe(first);
  });

  it('is a function of its input — a different entry gives a different brief', () => {
    // The other half of purity: same in, same out is also true of a constant.
    expect(brief({ ...bassLine(), chord: 'C7' })).not.toBe(brief(bassLine()));
    expect(brief({ ...bassLine(), lengthBars: 2 })).not.toBe(brief(bassLine()));
    expect(brief({ ...bassLine(), name: 'Riff' })).not.toBe(brief(bassLine()));
  });
});

// ------------------------------------------------------------- injection ---

describe('the grip in the brief is the one the neck actually has', () => {
  it('gives a bass and a guitar different frets for the same chord', () => {
    const chord = 'C7';
    const onGuitar = brief({ name: 'Comp', instrumentId: 'guitar', chord, lengthBars: 1 });
    const onBass = brief({ name: 'Line', instrumentId: 'bass', chord, lengthBars: 1 });

    const frets = (text: string): readonly string[] =>
      text.match(/stringIndex \d+, fret \d+/g) ?? [];

    expect(frets(onGuitar).length).toBeGreaterThan(0);
    expect(frets(onBass).length).toBeGreaterThan(0);
    expect(frets(onBass)).not.toEqual(frets(onGuitar));
  });

  it('spells the frets the way the app itself voices the chord', () => {
    // ONE path to the frets: the brief calls the same seam function
    // `read_chord_voicings` does, so what is injected is what the tool would
    // have handed back. Asserted against that function rather than against
    // copied numbers, which would go stale the day the voicer improves.
    const grip = chordGrip('F7', 'bass');
    if (!grip.ok) throw new Error(grip.reason);
    const text = brief(bassLine());
    for (const cell of grip.value.cells) {
      expect(text).toContain(`stringIndex ${cell.stringIndex}, fret ${cell.fret}`);
    }
    expect(text).toContain(grip.value.notes.join(', '));
  });

  it('warns that the tones are not lined up with the shape', () => {
    // The misreading `read_chord_voicings` calls out in its own description:
    // cells[2] is not notes[2], and a shape doubles some tones.
    expect(brief(bassLine())).toContain('NOT lined up');
  });
});

// -------------------------------------------------------------- refusals ---

describe('a plan entry that cannot be briefed is refused, not papered over', () => {
  it("refuses a chord symbol the app cannot read, in the seam's own words", () => {
    const result = patternRunInput({ ...bassLine(), chord: 'Zz9' });
    const grip = chordGrip('Zz9', 'bass');
    expect(result.ok).toBe(false);
    expect(grip.ok).toBe(false);
    // Verbatim, so `read_chord_voicings` and this brief cannot describe one
    // mistake two ways.
    if (!result.ok && !grip.ok) expect(result.reason).toBe(grip.reason);
  });

  it('refuses an instrument this app has no neck for', () => {
    const result = patternRunInput({ ...bassLine(), instrumentId: 'sitar' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('sitar');
  });

  it('refuses a length that is not a whole bar, in words true of all three', () => {
    for (const lengthBars of [0, -1, 1.5]) {
      const result = patternRunInput({ ...bassLine(), lengthBars });
      expect(result.ok).toBe(false);
      // Not "there is nothing shorter to ask for": 1.5 bars is not SHORTER than
      // one, it is not a length at all, and one sentence has to be true of every
      // input the guard turns away.
      if (!result.ok) {
        expect(result.reason).toContain('a whole number of bars, at least 1');
        expect(result.reason).toContain(String(lengthBars));
      }
    }
  });

  it('refuses a pattern with no name, since the name is the role', () => {
    // Whitespace, not empty string: the brief interpolates the TRIMMED name, so
    // "   " would otherwise produce `Write "": 1 bar of Bass over F7`.
    for (const name of ['', '   ']) {
      const result = patternRunInput({ ...bassLine(), name });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('no name');
    }
  });

  it('refuses the length in the same words the plan validator refuses it in', () => {
    // ONE account of one mistake. `reviewPlan` turns the same entry away, and a
    // caller that sees both must not get two descriptions of it.
    const bad: PlannedPattern = { ...bassLine(), lengthBars: 0 };
    const review = reviewPlan({
      bars: 4,
      tracks: [{ name: 'Bass', instrumentId: 'bass' }],
      patterns: [bad],
      placements: [{ trackName: 'Bass', patternName: bad.name, atBars: [1] }],
    });
    const planRefusal = review.refusals.find((refusal) => refusal.rule === 'pattern-length');
    const result = patternRunInput(bad);
    expect(planRefusal).toBeDefined();
    expect(result.ok).toBe(false);
    if (planRefusal !== undefined && !result.ok) expect(result.reason).toBe(planRefusal.reason);
  });
});
