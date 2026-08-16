/**
 * ONE PATTERN, ONE CHORD, ONE INSTRUMENT — the narrow writing run, briefed from
 * a {@link PatternBrief} and nothing else.
 *
 * ⚠ THIS IS THE ONE THING IN THIS AREA THAT DEMONSTRABLY WORKS, which is why it
 * outlived everything around it. The orchestrated composition job that was meant
 * to call it — a plan run, one of these per pattern, assembly in code — was
 * deleted on 2026-08-16 having never produced a composition. This module was
 * kept: asked for one part over one chord on one instrument, it reliably
 * produces one, verified by hand through the pattern page's
 * `pattern-write-over-a-chord` command, which is {@link patternRunInput}'s brief
 * QUOTED with a test pinning the two together.
 *
 * So it has no caller in the app today. It is a spec, a brief and its tests, and
 * the design replacing the orchestrator will hand it the same four facts.
 *
 * The premise it was written on is that a run holding a whole composition
 * defaults to generic output. The 2026-08-14 backing track is the exhibit:
 * mechanically perfect — correct spacing, full coverage, no wasted steps — and
 * musically empty. It asked `read_chord_voicings` for C7/F7/G7 on guitar and
 * again on bass, got correct grips both times, used neither, and wrote one
 * repeated cell per part: four notes at fret 3 on one downbeat for the rhythm
 * guitar, a two-note ostinato for the bass. A run asked for ONE bar of ONE
 * chord on ONE instrument has almost nowhere to put that filler — the whole of
 * its output is the bar being judged. That claim is what the listening test is
 * for, so what is built here is the thing that will actually ship rather than a
 * rig for the test.
 *
 * ── THE GRIP IS INJECTED, and here is the reasoning the card left open ──────
 *
 * `read_chord_voicings` was read before deciding. It is a batch lookup over a
 * named neck, its `cells` are already `{stringIndex, fret}` — the exact spelling
 * `pattern_stamp_notes` takes — and its own description ends by telling the
 * model the shape is material to compose from and not a chord to drop on the
 * downbeat. Every one of those properties survives being pasted into a prompt,
 * and one does not survive being a tool call: a fact in the brief is read BEFORE
 * any tool is chosen, which is the lever this project has repeatedly found to
 * work, whereas a tool is only read once it has been chosen. On 2026-08-14 the
 * tool WAS chosen, twice, and the grips still went unused — so the round trip
 * bought nothing that a paragraph would not have bought.
 *
 * The objection to injecting is that it opens a second path to the frets. It
 * does not: {@link patternRunInput} calls `chordGrip`, the seam function
 * `read_chord_voicings` itself calls, so there is one voicer and one answer, and
 * the sub-run sees exactly what the tool would have handed it. What injecting
 * genuinely costs is a turn's worth of step budget saved and one inconsistency
 * introduced — `agentRules`' NECK section tells every run on this prompt to ask
 * `read_chord_voicings`, and this run has not got it. That is countered in the
 * brief, in the section that carries the frets, in as many words. A brief that
 * hands over the answer and leaves the instruction to go looking for it standing
 * is a brief that spends a turn on a tool call that fails.
 *
 * ⚠ THE REAL COST OF INJECTING is that the frets become neck-specific BEFORE the
 * run starts, while the pattern they land in was opened by somebody else. A grip
 * voiced for a bass dropped into a guitar pattern by mistake stamps cleanly —
 * `stringIndex` 0-3 exist on both necks — and sounds like a different chord with
 * nothing refused anywhere. (The reverse is loud: a guitar grip on a bass gets
 * `stringIndex` 4 and 5 refused.) The run cannot fix that, having no
 * `pattern_set_instrument`, but it CAN notice it: `read_pattern` reports the
 * instrument, and the brief tells it to check that report against the neck the
 * frets were voiced for and to write nothing if they disagree.
 *
 * ── THE TOOL LIST IS THE GUARANTEE ─────────────────────────────────────────
 *
 * Every COMMAND in the app today hands over its whole page's tool list;
 * `commandTypes.ts` says the per-command `tools` array is documentation and not
 * enforcement, and it is right about the commands. Narrowing per PAGE is already
 * done and argued — `PATTERN_AGENT` is `[...READ_TOOLS, ...PATTERN_TOOLS]` and
 * not all of `AGENT_TOOLS`. What is new here is narrowing per RUN, below the
 * page, and it is enforcement in the literal sense — `toHarnessAgent` builds the
 * registry from `AgentSpec.tools`, so a tool that is not below cannot be called,
 * only hallucinated.
 *
 * What is in, and why each:
 *
 *   - `read_pattern` — the only source of the ticks per quarter note, the time
 *     signature and the note ids the two marking tools need.
 *   - `pattern_stamp_notes` — the part itself.
 *   - `pattern_set_dynamics`, `pattern_set_articulations` — a bar of notes all
 *     at one volume with no accent, mute or ghost is half of what "musically
 *     empty" meant on 2026-08-14. These are how the run says the other half.
 *   - `pattern_delete_notes` — the only recovery from a note it wishes it had
 *     not written. Without it a wrong note is permanent for the rest of the run.
 *
 * What is deliberately out:
 *
 *   - `pattern_open_blank` (and `pattern_open`, which this build has not got —
 *     asserted by name anyway, because the day it exists is the day it must not
 *     be in this list). THE CALLER OWNS THE POINTER: the app has ONE open
 *     pattern, it was opened for this run, and a run that could open another
 *     would move it out from under whatever the caller does with the result.
 *   - every `composition_*` and every `voice_*` tool. This run is not building
 *     an arrangement and cannot see one; where this pattern goes was settled
 *     before it started.
 *   - `pattern_set_instrument` — the instrument is the caller's, and the grip
 *     below was voiced for it. A run that changed it would leave the frets in
 *     its own brief describing a different neck.
 *   - `read_chord_voicings` — see the decision above.
 *   - `pattern_move_notes`, `pattern_resize_notes`, `pattern_set_note_frets`,
 *     `pattern_set_pitches`, `read_pattern_library`, `read_composition`,
 *     `pattern_set_playback`. Not forbidden on principle, just not earned: a
 *     one-bar write from scratch has nothing to nudge, and every extra schema is
 *     prompt budget spent making the choice harder (`patternAgent`'s argument,
 *     at a narrower address). Slides and bends are the one omission a listening
 *     test might argue back — add `pattern_set_pitches` if a run visibly reaches
 *     for one.
 *
 * ⚠ Built by filtering `AGENT_TOOLS`, so the writes carry `asJobWrite` and will
 * pass the composition job lock the day a caller holds one. The price is that a
 * rename in a tool module has to be repeated in the list below, which is why
 * {@link subRunTools} throws rather than quietly running short.
 *
 * ── THE SYSTEM PROMPT IS THE PATTERN PAGE'S, VERBATIM ──────────────────────
 *
 * `PATTERN_AGENT.systemPrompt` is `pagePrompt(...)` already applied — the shared
 * rules plus the pattern page's own section — and that PAGE section is true of
 * this run word for word: one open pattern, no tool that opens another,
 * `read_pattern` is what says which. Restating it here would be the second copy
 * `agentRules` exists to prevent. What is NOT true of this run goes in the
 * brief, which is per-run text and is where a per-run fact belongs. (The
 * composition page's prompt is largely about tools this run has not got, which
 * is why it is not this one. Noted in passing and not fixed, this ticket owning
 * neither file: `PATTERN_PAGE` opens "You are editing ONE guitar pattern"
 * whatever the neck — the brief names the instrument, so the model is not left
 * guessing.)
 *
 * ⚠ THE SHARED RULES ARE NOT ALL TRUE HERE, and the brief counters each place
 * they are not. `pagePrompt` prepends `SHARED_RULES` to every page, and two of
 * its sections were written for a run that can reach the whole app:
 *
 *   - NECK sends every run to `read_chord_voicings`. Countered by the section
 *     that carries the injected grip.
 *   - LENGTH is half about the composition: `composition_place_pattern` with
 *     `atBars`, block spacing, `composition_resize_placement`,
 *     `composition_duplicate_placements` — and it ends on "write ONE PATTERN PER
 *     CHORD and place each at every bar its chord covers … a twelve-bar blues is
 *     three patterns spread over twelve bars". A run that can write exactly one
 *     pattern, cannot open a second and has been briefed on one chord is being
 *     told by its own system prompt to produce three and place them. Countered
 *     in the brief's "This run is one pattern" section, in the same register.
 *
 * Not fixed in `agentRules` itself: those paragraphs are correct for the two
 * page agents that ship today, and a shared file cannot be edited for a run that
 * is wired to nothing yet. If a caller lands and this list grows, the honest
 * move is to split `LENGTH` into the pattern half and the arrangement half — the
 * counter below is a per-run patch over a shared file's assumption and it should
 * stay small enough to be read as one.
 */
import { chordGrip, listInstruments } from '../patterns/patternService';
import { AGENT_TOOLS } from './tools';
import { PATTERN_AGENT } from './patternAgent';
import type { AgentSpec } from './agentService';
import type { AgentTool } from './tools/types';
import type { Result } from '../patterns/patternService';

// ------------------------------------------------------------------ input ---

/**
 * The four facts a brief is built out of, and the whole of this module's input.
 *
 * ⚠ DELIBERATELY LOCAL. It was a `PlannedPattern` off an arrangement plan until
 * that plan was deleted, and the lesson of the deletion was that these four are
 * the only ones that ever mattered: what the part is for, over which chord, on
 * which neck, for how long. Whatever calls this next declares those four; it
 * does not get to make this module import its schema.
 */
export interface PatternBrief {
  /** What the part is FOR — "Walking Bass", "Comping". It is the ROLE, and the
   *  brief hands it to the model as one. */
  readonly name: string;
  readonly instrumentId: string;
  /** The chord SYMBOL this pattern is over — "C7", "Fmaj7", "G/B". */
  readonly chord: string;
  /** How many bars long it is: a whole number, at least 1. */
  readonly lengthBars: number;
}

/** A whole number of bars, at least 1 — the only lengths a pattern has. */
const isBarCount = (value: number): boolean => Number.isInteger(value) && value >= 1;

const barsPhrase = (count: number): string => `${count} bar${count === 1 ? '' : 's'}`;

/** Worded to be true of every input that fails {@link isBarCount} — 0, -1 and
 *  1.5 are all wrong, and only one of them is "shorter than a bar". */
const patternLengthRefusal = (name: string, lengthBars: number): string =>
  `Pattern "${name}" is ${lengthBars} bars long. A pattern is a whole number of bars, at least 1 — nothing shorter, and nothing in between.`;

// ------------------------------------------------------------------ tools ---

/** The allow-list. Reads first, for `AGENT_TOOLS`' reason — a model reaches for
 *  the first tool that fits, and the marking tools need ids a read hands out.
 *
 *  ⚠ EXPORTED so a test can pin the built list against it EXACTLY, which is what
 *  makes widening this array a deliberate act rather than an edit that passes.
 *  The by-name prohibitions in that test are what stop the constant simply
 *  agreeing with whatever it was widened to. */
export const SUB_RUN_TOOL_NAMES: readonly string[] = [
  'read_pattern',
  'pattern_stamp_notes',
  'pattern_set_dynamics',
  'pattern_set_articulations',
  'pattern_delete_notes',
];

/**
 * The allow-list resolved against the app's own tools.
 *
 * THROWS on a name that no longer exists, at import. A run silently short of
 * `pattern_stamp_notes` answers "done" having written nothing, and that failure
 * would be read as the model's — a renamed tool is ours, and it should stop the
 * tests rather than the run.
 */
function subRunTools(): readonly AgentTool[] {
  const wanted = new Set(SUB_RUN_TOOL_NAMES);
  // Filtered rather than mapped, so the order is `AGENT_TOOLS`' own.
  const tools = AGENT_TOOLS.filter((tool) => wanted.has(tool.name));
  // The names, not the counts. A count comparison also fires when `AGENT_TOOLS`
  // holds two tools of one name, and in that direction there is nothing missing
  // — the throw would read "names tools that do not exist: " and name none.
  const found = new Set(tools.map((tool) => tool.name));
  const missing = SUB_RUN_TOOL_NAMES.filter((tool) => !found.has(tool));
  if (missing.length > 0) {
    throw new Error(`patternSubRun names tools that do not exist: ${missing.join(', ')}`);
  }
  return tools;
}

/** The restricted agent. ⚠ THE LIST IS THE POINT — see the header before adding
 *  to it, and never add anything that opens a pattern. */
export const PATTERN_SUB_RUN_AGENT: AgentSpec = {
  name: 'pattern-sub-run',
  systemPrompt: PATTERN_AGENT.systemPrompt,
  tools: subRunTools(),
};

// ------------------------------------------------------------------ brief ---

/** The instrument as the catalog names it, for prose. The id is never reached
 *  for here — no tool in this run takes one.
 *
 *  ⚠ THE THIRD PLACE this mapping is derived from `listInstruments`, after
 *  `instrumentCatalog.ts`'s `INSTRUMENT_LIST`, and it belongs there beside it as
 *  an `instrumentName(id)`. It is here because this card's fence forbids editing
 *  anything under `src/ai/tools/`. Whoever lifts the fence should move it.
 *
 *  The `??` is unreachable today — {@link patternRunInput} calls `chordGrip`
 *  first, which refuses an id `getInstrument` does not know, and both sides read
 *  the lib's one catalog. It stays as the answer to "what if those two catalogs
 *  ever diverge", where naming the id beats rendering `undefined`. */
const instrumentName = (instrumentId: string): string =>
  listInstruments().find((instrument) => instrument.id === instrumentId)?.name ?? instrumentId;

/** The shape, one cell a line, in `pattern_stamp_notes`' own spelling of the two
 *  axes — so nothing in it has to be translated before it can be stamped. */
const gripLines = (cells: readonly { stringIndex: number; fret: number }[]): string =>
  cells.map((cell) => `    stringIndex ${cell.stringIndex}, fret ${cell.fret}`).join('\n');

/**
 * THE BRIEF — the artefact this module is really about. Everything else in it is
 * plumbing around this string.
 *
 * ⚠ THE PROSE IS A BASELINE. It is what a deferred musicality ticket will tune
 * against, and `commandCatalog`'s `pattern-write-over-a-chord` is these
 * paragraphs QUOTED with a test comparing the two paragraph for paragraph. Word
 * it differently and you have moved the baseline and failed that test; do both
 * on purpose or neither.
 *
 * It asks for MUSIC and not for a structure: what the part is for, over which
 * chord, how long, on which instrument, and then what a bar of music is not.
 * The role comes from the caller's own `name` rather than from a guess off the
 * instrument id, because "bass instrument therefore bass line" is a heuristic
 * that would contradict the caller the first time a guitar is asked for a bass
 * figure or a bass for a melody. The caller named the part; the name is the role.
 *
 * ⚠ THE PROHIBITION IS THE LOAD-BEARING PARAGRAPH. "Do not stamp the shape once
 * on the downbeat and stop" is the exact thing the 2026-08-14 rhythm guitar did
 * with a correct grip in hand, and it is invisible to every check this app has:
 * the frets are right, the harmony is right, the length is right, the spacing is
 * right. No reply we can design catches it, so it is forbidden in advance.
 *
 * PURE — a {@link PatternBrief} in, a brief out. `chordGrip` is a lookup over
 * the lib's chord and tuning catalogs and takes nothing from the open document,
 * so the same input gives the same brief with no clock, no randomness and no app
 * state in the answer.
 *
 * ⚠ THE ARRANGEMENT PARAGRAPH IS AN INSTRUCTION, NOT A CAPABILITY CLAIM — "you
 * must not make a second pattern", not "there is no tool here that does it" —
 * even though the tool list above makes the stronger form true of THIS run.
 * `commandCatalog`'s `pattern-write-over-a-chord` quotes that paragraph verbatim
 * so a person can hear what this writes, and it runs on the pattern page, where
 * `pattern_open_blank` and `read_composition` are both in reach. A claim the
 * model can disprove mid-run is a paragraph it can then discount, and the tool
 * it would disprove it with replaces the single open pattern. The list above
 * still enforces it here; the wording is what has to be true in both places.
 *
 * REFUSES rather than papering over, in the register the seams refuse in: an
 * unreadable symbol, a neck this app has not got and a length that is not a
 * whole bar are all things the caller can be sent back to fix, and a brief
 * built around "0 bars of Zz9" would spend a whole run finding that out.
 */
export function patternRunInput(pattern: PatternBrief): Result<string> {
  if (!isBarCount(pattern.lengthBars)) {
    return { ok: false, reason: patternLengthRefusal(pattern.name, pattern.lengthBars) };
  }
  const name = pattern.name.trim();
  if (name === '') {
    return {
      ok: false,
      reason: 'The pattern has no name, and the name is what says what the part is for.',
    };
  }
  // The seam's own refusal, verbatim, for both the unreadable symbol and the
  // unknown neck — `read_chord_voicings` passes the same sentences on, so a
  // caller cannot get two accounts of one mistake.
  const grip = chordGrip(pattern.chord, pattern.instrumentId);
  if (!grip.ok) return { ok: false, reason: grip.reason };

  // The symbol as the VOICER echoed it rather than as the caller wrote it. Those
  // are the same string today — `chordGrip` echoes what it was given and refuses
  // what it cannot read, rather than normalising — so this is insurance and not
  // a live guarantee: if the lib ever starts normalising, the chord named in the
  // prose and the frets under it still cannot drift apart.
  const chord = grip.value.symbol;
  const instrument = instrumentName(pattern.instrumentId);
  const bars = barsPhrase(pattern.lengthBars);
  const lastBar = pattern.lengthBars;

  return {
    ok: true,
    value: `# What to write

Write "${name}": ${bars} of ${instrument} over ${chord}. That is the whole run — one part, one chord, one instrument, and nothing else to decide.

Its name is what the part is FOR — a comping figure, a walking bass line, a lead line, a riff — and the arrangement was planned around it. Write music that does that job for ${bars} over ${chord}.

# This run is one pattern, not an arrangement

THERE IS NO ARRANGEMENT IN THIS RUN. You are not looking at one, you are not placing anything into one, and you must not make a second pattern — nothing in this run is for any of it. So ignore every standing instruction about laying parts out: nothing here places a block at a list of bars, nothing spaces blocks, nothing resizes or duplicates them, and the rule about writing ONE PATTERN PER CHORD and placing each where its chord runs is somebody else's job, already done.

That decision is what put you here. Which chord this pattern is over, how long it is and how often it comes round again were all settled before this run started. One pattern, ${bars} of it, over ${chord}. Writing a second chord into it would contradict the plan the rest of the piece is being built from.

# The chord, already looked up

${chord} on ${instrument} sits here:

${gripLines(grip.value.cells)}

That is one hand position, and those are the stringIndex and fret numbers \`pattern_stamp_notes\` takes — use them as they stand rather than re-voicing them onto other strings. The chord's tones are ${grip.value.notes.join(', ')}; they are NOT lined up with the lines above, because a shape doubles some tones and may leave one out.

THERE IS NO CHORD LOOKUP IN THIS RUN. This is that lookup's answer for this neck, so ignore any standing instruction to go and ask for one — there is no such tool here and a call spent on it is a bar you did not write.

This is MATERIAL, not the part. You choose which of these notes get played, in what order, at which ticks, for how long, how hard and with what articulation — a bass line takes one at a time and walks between them, a comping part spreads them across the bar. Notes outside the shape are yours where the line asks for one: an approach note, a passing note, a chromatic step into the next bar. If you want a tone an octave away, the same string twelve frets up is the same note an octave higher — that is the only fret arithmetic here.

# What NOT to write

Do not stamp the shape once at the top of the bar and stop. A stack of notes on beat 1 with silence behind it is not a part, it is the chord spelled out, and it is the exact failure this brief exists to prevent: the frets are right, the harmony is right, the length is right, and there is nothing to listen to.

A bar has more than one attack in it. Something lands off the downbeat as well as on it, the notes are not all the same length, and the result is something a player would have played on purpose.${
      lastBar > 1
        ? `\n\nOver ${bars} the part goes somewhere: later bars answer earlier ones instead of repeating them note for note. \`repeat\` is for a figure that genuinely recurs — use it because the part IS an ostinato, not because ${bars} was more than you felt like writing. It also costs you the marks below: a repeated stamp reports counts and hands back no note ids, so a figure you mean to accent, mute or ghost is one you write out bar by bar in the same single call.`
        : ''
    }

# The marks

Notes all at one volume with no articulation read as typing, not as playing. \`pattern_stamp_notes\` lists the notes it placed one by one and hands back an id for each — EXCEPT on a call that used \`repeat\`, which reports counts only and no ids at all. The marks need those ids, so anything you mean to mark is stamped out rather than repeated. Then accent what the rhythm leans on with \`pattern_set_dynamics\`, and use \`pattern_set_articulations\` where the part calls for it — palm mutes under a chugging figure, ghost notes between the ones that count, a hammer-on or a pull-off where two notes are one gesture of the hand. A few marks in the right places say more than a mark on every note.

# How long it is

${bars}, and length is not something you set: the pattern is as long as the notes left in it, rounded UP to the end of the bar the last one finishes in. So every note must END by the end of bar ${lastBar} — start plus duration, not start. A note that begins inside bar ${lastBar} but rings past its barline makes this ${barsPhrase(lastBar + 1)} long just as surely as one that starts late, and everything downstream was planned around ${bars}. Check the last note of every string before you send it: a long final note is the easy way to buy a bar you did not want.

# How to work

Read the pattern once first: it gives the ticks per quarter note and the time signature, which is what one bar is worth in ticks, and it gives the ids of anything already in it. It also says which instrument the open pattern is on, and that must be ${instrument} — the frets above were voiced for that neck and no other, and on a different one they are a different chord with nothing to warn you. If it is not ${instrument}, write nothing and say so. Then send the whole ${bars} in ONE stamp call, the dynamics in one call and the articulations in one call.

Finish with a sentence or two on what you actually wrote — the rhythm, and which notes of ${chord} you used where. Not how it will sound.`,
  };
}
