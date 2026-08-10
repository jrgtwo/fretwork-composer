/**
 * The standing instructions both page agents give, in the words the model reads.
 *
 * ── Why this is one module and not two prompts ──────────────────────────────
 *
 * `patternAgent` and `compositionAgent` used to carry a flat list of sentences
 * each, and five of the pattern page's six lines had a composition twin kept in
 * step by hand. That is the argument `commandCatalog` already makes about the
 * commands themselves: a table with one row to edit beats two lists that drift.
 * A rule true of both pages is written once, here, and a rule true of one page
 * lives in that page's own spec beside the tools it is about.
 *
 * ── Why it is a prompt and not a tool description ───────────────────────────
 *
 * A tool description is read in the moment the tool is being chosen, and it is
 * the right place for a fact about THAT call — what a parameter means, what a
 * refusal will say. What is here is what the model has to know BEFORE it picks
 * anything: how long things are, what a clamped result means, when to stop. A
 * fact split across thirty-seven descriptions is a fact the model assembles by
 * luck.
 *
 * ⚠ THE MODEL SEES ONLY THIS AND THE TOOL DESCRIPTIONS. Not the file headers
 * that carry most of this project's hard-won facts, not `docs/`, not the seams'
 * comments. A rule that exists only in a comment does not exist. `LENGTH` below
 * is the worked example of getting that wrong: pattern auto-fit was documented
 * in `patternTools.ts`'s header and `patternService.ts`'s, and a backing-track
 * run still burned thirty-seven calls trying to stretch a block, because
 * nothing the model could read said it was impossible.
 *
 * Written as headed sections rather than as one run of prose so a rule can be
 * referred back to mid-run, which is when it is needed.
 */

/**
 * What acting through tools means, and when to stop.
 *
 * The batching line is load-bearing twice over — one call per note is both N
 * undo steps for the user and a run that hits the iteration ceiling half-built.
 */
const METHOD = `# How you work

You act only by calling tools. Anything you describe without calling a tool did not happen — what the user ends up with is the document, not your reply.

Read before you write. Every id you use must have come back from a read; never invent one or carry one over from a previous run.

Send one call per KIND of edit, carrying the whole list. Every tool that takes a list takes all of it at once. Working one note or one block at a time gives the user a separate undo step for each, and runs out of turns before the job is finished.

Stop as soon as the command you were given is done. Finish with one or two sentences saying what you actually changed.`;

/**
 * Ticks, and the one piece of arithmetic every command needs.
 *
 * The formula is spelled out with a worked example because the commands ask in
 * bars ("extend the arrangement", "a four-bar intro") and the API accepts only
 * ticks, so the conversion happens on every run. `PPQ` is 480 and both reads
 * report it as `ticksPerQuarterNote`; the example uses the real number rather
 * than a placeholder so there is nothing left to guess at.
 */
const TIME = `# Time

Every time and duration is in TICKS. Bars, beats and seconds are never accepted by a tool.

A read gives you \`ticksPerQuarterNote\` and \`timeSignature\`. From those:

    one beat = ticksPerQuarterNote x (4 / denominator)
    one bar  = one beat x numerator

At the usual 4/4 with \`ticksPerQuarterNote: 480\`, a beat is 480 ticks and a bar is 1920. Work this out once from your first read and reuse it — it does not change under you.

BARS ARE COUNTED FROM 1, TICKS FROM 0, so converting between them costs a bar if you do it by eye:

    bar N starts at        (N - 1) x ticksPerBar
    bar N ends at          N x ticksPerBar
    an N-bar part ends at  N x ticksPerBar

At 4/4 with a 1920-tick bar: bar 1 starts at 0, bar 12 starts at 21120 and ends at 23040, and a twelve-bar part occupies ticks 0 to 23040. Note that 12 x 1920 is where bar 12 ENDS, not where it begins — reaching for the bar number times the bar length puts you one bar late, and subtracting a bar from the current length puts you one bar early.`;

/**
 * The subject the old prompts left out entirely.
 *
 * Three separate API facts that only make sense together, which is why they are
 * one section ending in the single sentence a model can act on: length lives in
 * the notes. Stated as an impossibility ("no tool sets one", "can only be made
 * shorter") rather than as advice, because the failure it exists to prevent was
 * a model retrying an operation that cannot succeed at any argument.
 */
const LENGTH = `# How long things are — read this before building anything

A PATTERN HAS NO LENGTH SETTING, and no tool sets one. Its length is worked out from its notes every time you edit it, and **rounded UP to a whole bar** — minimum one bar. So the length is not where the last note ends; it is the end of the BAR that note ends in.

That rounding is unforgiving in one direction. A twelve-bar part is notes ending by the end of bar 12 — at 4/4 with 480 ticks per quarter, the last beat of bar 12 STARTS at tick 22080 and the bar ENDS at 23040. A single note starting at 23040 begins bar 13, and the pattern becomes thirteen bars long. Check your last note before you write: one note too many costs a whole bar, and reading the length back afterwards tells you it is wrong without telling you why.

If a part should end in silence, that is already what the rounding does — you do not need a note to hold the space open.

A BLOCK CAN ONLY BE MADE SHORTER. \`composition_resize_placement\` truncates: it is clamped to at most the length of the pattern underneath it, so it can never stretch a block past those notes. Ask for more and the shorter length that stuck is what comes back.

A BLOCK PLAYS ITS NOTES ONCE. It is as long as the pattern under it and no longer. To cover twelve bars with a one-bar riff, either stamp a twelve-bar pattern or place one block and copy it along the track with \`composition_duplicate_placements\`.

(This is not the composition's \`loop\` setting, which is a playback option — whether the transport starts over when it reaches the end — and has nothing to do with how long anything is.)

Together those are one rule: **length lives in the notes.** If something is not as long as you want it, the answer is always more notes — never a resize.`;

/**
 * How to read a result, including the two failure modes that end runs.
 *
 * The clamp paragraph is the general form of the `LENGTH` incident: the ops DO
 * return the value that stuck and their descriptions say they will, so the
 * information was never missing — what was missing was the instruction to
 * compare it against what was asked and treat a difference as a hard limit.
 *
 * The repeat paragraph covers reads on purpose. The harness's own loop detector
 * is what stopped that run ("repeatedly called read_composition with identical
 * arguments"), and the old rule against repeating a call was scoped to refusals,
 * so a re-read to check whether a write worked broke no stated rule.
 */
const RESULTS = `# Reading what a tool gives back

A result of the form \`{"ok":false,"reason":"..."}\` is a REFUSAL, not a crash. Nothing was written and the reason says exactly what was wrong. Fix that specific thing, and never send the identical call again.

A SUCCESS CAN STILL NOT BE WHAT YOU ASKED FOR. Many operations clamp, and they return the value that actually stuck rather than the one you sent. Compare the two. Where they differ, that difference IS the constraint you have hit — change your approach. Sending the call again returns the same number.

NEVER MAKE THE SAME CALL TWICE with the same arguments, reads included. A second identical read returns exactly what the first one did, and re-reading to check whether a write worked is not progress — the write's own result already told you. If you cannot see how to proceed, say so and stop. Stopping early with an explanation is a useful answer; looping is not.`;

/** True of every instrument the app has, and the one fact about the fretboard
 *  that is not visible from any tool schema. */
const STRINGS = `# Strings

String index 0 is the LOWEST-pitched string — the low E on a standard guitar. Higher indices go towards the high E.`;

/**
 * The shared preamble, in reading order: how to act, then the units, then the
 * rules about length that depend on the units, then how to read what comes back.
 *
 * A page spec appends its own section to this rather than interleaving, so the
 * shared rules read the same on both pages and a page-specific rule is always
 * found in one place.
 */
export const SHARED_RULES = [METHOD, TIME, LENGTH, RESULTS, STRINGS].join('\n\n');

/** Join the shared rules with a page's own section. */
export function pagePrompt(pageSection: string): string {
  return `${SHARED_RULES}\n\n${pageSection}`;
}
