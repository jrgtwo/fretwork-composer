/**
 * THE PLANNING RUN — the step that decides what to build and writes nothing.
 *
 * The premise, from the epic: one model call holding the form, the harmony, the
 * fret arithmetic and the placement at once defaults to generic output. The
 * 2026-08-14 run was mechanically perfect — correct spacing, full coverage, no
 * wasted steps — and musically empty: it looked C7/F7/G7 up for guitar and again
 * for bass, wrote ONE repeated cell per part, used none of the grips, and
 * reported a progression that exists nowhere in the document. No reply we can
 * design says "that is musically empty", because we cannot know that. So the job
 * splits, and this is its first phase: decide the form, write nothing, and let
 * the plan be CHECKED AS DATA before a note exists.
 *
 * This module is a spec, a prompt, an input builder and a validator. It is wired
 * to nothing — no panel, no command — and it deliberately owns no run function:
 * `agentService` is imported for its TYPE only, so `reviewPlan` can be exercised
 * with no model and no harness anywhere in the room.
 *
 * ⚠ THAT PURITY IS THE FUNCTION'S, NOT THE MODULE'S. `planRunInput` needs
 * `read_composition`, so `READ_TOOLS` is imported as a VALUE, and that pulls the
 * seams and the lib's stores in at import time. `reviewPlan` itself touches none
 * of it — a plan object in, a review out — but a caller that wants the validator
 * with nothing else loaded needs `planRunInput` moved to its own module first.
 *
 * ── WHY IT HAS NO TOOLS ─────────────────────────────────────────────────────
 *
 * The harness sends `outputSchema` to the backend for grammar-enforced decoding
 * only on turns where NO tools are offered at all; with a registered tool set the
 * structured answer degrades to a best-effort parse of the whole reply. A step
 * whose entire product is a reliable structure therefore gets an empty tool list
 * — see `RunAgentTaskOptions.outputSchema`, which carries the citation and the
 * verification. {@link ARRANGEMENT_PLAN_AGENT} is that empty list, and
 * `ARRANGEMENT_PLAN_SCHEMA` (in `arrangementPlanSchema.ts`) is what a caller
 * passes as `outputSchema`.
 *
 * That costs the run the ability to READ, which is why {@link planRunInput}
 * renders the composition into the prompt instead — and renders it by CALLING
 * `read_composition`, so the document this run sees and the document the writing
 * runs see cannot drift apart.
 *
 * What a plan IS, and why the chord belongs to the pattern rather than to the
 * bar, is in `arrangementPlanSchema.ts` beside the shape it decides.
 *
 * ── WHY THE PROMPT IS ITS OWN AND REUSES NOTHING ────────────────────────────
 *
 * `agentRules` was read first, as the ticket asks. It exports exactly two
 * handles — `SHARED_RULES` and `pagePrompt`, which prepends it — and both open
 * with METHOD: "You act only by calling tools. Anything you describe without
 * calling a tool did not happen." That is precisely false here and it is the
 * first thing the model would read. `TIME` is tick arithmetic, `RESULTS` is how
 * to read a tool result, and `NECK` sends the model to `read_chord_voicings` —
 * none of which this run can do.
 *
 * Two paragraphs of `LENGTH` DO apply word for word — spacing copies by the
 * pattern's own length, and one pattern per chord — but they are embedded in a
 * section about tools and ticks, and splitting `agentRules` into exportable
 * pieces is outside this ticket's file fence. So they are restated below in the
 * plan's own vocabulary (bars and pattern names, no ticks, no tool calls), and
 * the honest reading is: THERE ARE NOW TWO PLACES SAYING A PATTERN'S COPIES ARE
 * SPACED BY ITS LENGTH. Whoever splits `agentRules` should collapse them.
 */
import { MAX_COMPOSITION_TRACKS, TRACK_CAP_REASON } from '../composition/compositionService';
import { READ_TOOLS } from './tools/readTools';
import type {
  ArrangementPlan,
  PlannedPattern,
  PlannedPlacement,
  PlannedTrack,
} from './arrangementPlanSchema';
import type { AgentSpec } from './agentService';
import type { Result } from '../patterns/patternService';

// ----------------------------------------------------------------- prompt ---

/**
 * What the run is told. Headed sections rather than one run of prose, for
 * `agentRules`'s reason: a rule has to be referrable back to mid-answer.
 *
 * The JSON instruction is load-bearing twice. Grammar-enforced decoding makes
 * the object well-formed, but the harness parses the WHOLE final answer with
 * `JSON.parse` and does no fence stripping and no extraction, so a ```json block
 * or a leading sentence yields nothing at all — a fact worth spending three
 * clauses on, because it turns a good plan into no plan.
 *
 * The twelve-bar example is the one `composition_place_pattern`'s own
 * description uses. Copied deliberately: a model that sees two different bar
 * lists for the same form has to decide which is the convention, and this run's
 * output is read by the runs that read that description.
 *
 * ⚠ THE SHAPE IS SPELLED OUT even though `ARRANGEMENT_PLAN_SCHEMA` is handed to
 * the backend as a grammar. The grammar is the PROVIDER's to honour and this app
 * points at arbitrary OpenAI-compatible backends; where one ignores the response
 * format, the harness falls back to parsing whatever was written and validating
 * it, and a model that was never told the field names writes its own. The
 * example costs a dozen lines of prompt and is the difference between a spent
 * run and a plan.
 */
const ARRANGEMENT_PLAN_PROMPT = `# What you are doing

You are PLANNING an arrangement. You are not building it: nothing you say here writes a note. A later run writes each pattern you name, and ordinary code places the blocks where you say. What you decide is the FORM — which parts there are, what harmony each part is over, and which bars each one sits in.

You have no tools. There is nothing to call and nothing to look up; the composition as it stands is given to you below.

ANSWER WITH ONE JSON OBJECT AND NOTHING ELSE. No sentence before it, no code fence around it, no commentary after it. The answer is parsed whole — anything but the bare object is thrown away, and a good plan wrapped in a fence is no plan at all.

# The shape of the answer

Exactly these keys, exactly these names, and nothing else:

{"bars":8,"tracks":[{"name":"Rhythm Guitar","instrumentId":"guitar"}],"patterns":[{"name":"A7 Comp","instrumentId":"guitar","chord":"A7","lengthBars":2}],"placements":[{"patternName":"A7 Comp","trackName":"Rhythm Guitar","atBars":[1,3,5,7]}]}

\`bars\` is how long the form is. \`tracks\` are the parts. \`patterns\` are what will be written, each over one chord. \`placements\` say which pattern goes on which track and at which bars, naming both by the names declared above.

# Bars

Everything is counted in BARS, FROM 1. Bar 1 is the start of the composition. There are no ticks in a plan and no beats: \`bars\` says how long the form is, \`lengthBars\` how long a pattern is, and \`atBars\` which bars a pattern starts on.

# Chords are symbols, never frets

A pattern says which CHORD it is over, as a symbol — "C7", "Fmaj7", "F#m7b5", "G/B". Never a fret and never a string. The run that writes the notes looks that symbol up on the neck of ITS OWN instrument, and that is what makes a bass part a bass part: a shape carried over from a guitar lands on the wrong notes on a bass or a ukulele.

# One pattern per chord

A pattern has ONE chord for the whole of it. Where the harmony moves, that is a different pattern — write one for each chord in the form and place it at every bar its chord covers. A twelve-bar blues in C is THREE patterns over twelve bars: C7 at bars 1, 2, 3, 4, 7, 8 and 11, F7 at bars 5, 6 and 10, G7 at bars 9 and 12. One pattern placed across the whole form is one chord for the whole form, which is the failure this step exists to prevent.

# Space the copies by the pattern's own length

A block plays its pattern ONCE and nothing is ever nudged aside to make room. Two copies closer together than the pattern is long land on top of each other, and the plan is refused before anything is built. Space the bars in \`atBars\` by that pattern's \`lengthBars\`: a two-bar pattern covering bars 1 to 8 starts at bars 1, 3, 5, 7 — four copies, not eight.

# One part per track

A track plays one block at a time. Two parts that sound together are two tracks — a bass line and a rhythm part never share one. Name a track for what it plays ("Bass", "Rhythm Guitar", "Lead"), and give each pattern the same instrument as the track it goes on.

AT MOST ${MAX_COMPOSITION_TRACKS} TRACKS. ${TRACK_CAP_REASON} A plan with more than that cannot be built at all, so an arrangement that wants more parts than ${MAX_COMPOSITION_TRACKS} has to give some of them up.

# Cover the form

Every bar from 1 to \`bars\` should have something on it on the parts that carry the tune. Bars you leave empty are silence in the middle of the arrangement: leave one empty because you MEAN it — a break, an intro nobody plays over, a part that enters late — and never by losing count.

Nothing runs PAST the form either. A copy has to end at bar \`bars\` or before it, so a two-bar pattern in a twelve-bar form starts at bar 11 at the latest.

# Names are the only reference

Nothing you plan exists yet, so there are no ids. Every placement names its pattern and its track by exactly the name you declared for it. A name you did not declare cannot be placed, and two patterns sharing a name cannot be told apart.`;

/**
 * The spec. ⚠ THE EMPTY TOOL LIST IS THE FEATURE — see the header. A tool added
 * here silently downgrades `ARRANGEMENT_PLAN_SCHEMA` from a grammar the provider
 * decodes against to a hope about what the model wrote.
 *
 * ⚠ RUN IT WITH `ARRANGEMENT_PLAN_SCHEMA` AS `outputSchema`. `AgentSpec` has no
 * field to carry that, so the two are joined by this sentence and by the prompt,
 * which states the shape in words for the same reason.
 */
export const ARRANGEMENT_PLAN_AGENT: AgentSpec = {
  name: 'arrangement-plan',
  systemPrompt: ARRANGEMENT_PLAN_PROMPT,
  tools: [],
};

// ------------------------------------------------------------------ input ---

/**
 * The composition read, by NAME, out of the list every other run is handed.
 *
 * Reused rather than re-rendered: `read_composition` already produces exactly
 * the description this run needs — tempo, time signature, tracks, blocks with
 * their bars, what each track is made of, the empty bars — and a second renderer
 * would drift from the one the writing runs read.
 *
 * Looked up in `READ_TOOLS` rather than with `findTool`, which is the house
 * lookup: `findTool` searches `AGENT_TOOLS`, which is every tool in the app
 * wrapped by `asJobWrite`. Nothing here writes, so the wrap buys nothing, and
 * reaching for it would make a module that only reads depend on the composition,
 * pattern and voice tool lists. Neither list exports its tools individually, so
 * either way it is a lookup by name and the guard below is the price.
 */
const READ_COMPOSITION = READ_TOOLS.find((tool) => tool.name === 'read_composition');

/**
 * What to send the planning run: the document, then the ask.
 *
 * REFUSES when no composition is open, with the read's own sentence. A plan for
 * a document that is not there would be a plan against invented tracks, and the
 * refusal is one a caller can act on — the same reason the seams return theirs.
 *
 * The ask goes LAST because it is the thing to be answered and the document is
 * context for it.
 */
export function planRunInput(request: string): Result<string> {
  if (!READ_COMPOSITION) {
    return { ok: false, reason: 'read_composition is missing from the read tools (this is a bug).' };
  }
  const composition = READ_COMPOSITION.run({});
  if (!composition.ok) return { ok: false, reason: composition.reason };
  return {
    ok: true,
    value: `# The composition as it stands\n\n${JSON.stringify(composition.value)}\n\n# What to plan\n\n${request.trim()}`,
  };
}

// ----------------------------------------------------------------- review ---

/** An inclusive stretch of bars, counted from 1. */
export interface BarRange {
  readonly from: number;
  readonly to: number;
}

/**
 * Which rule a refusal is about. TYPED rather than a sentence, because a caller
 * that has to re-plan needs to know WHAT was wrong without reading English:
 * an unknown name is a different repair from a stack, and a stack is a different
 * repair from a form length.
 */
export type PlanRule =
  | 'form-length'
  | 'pattern-length'
  | 'bar-number'
  | 'past-form'
  | 'duplicate-name'
  | 'track-cap'
  | 'unknown-pattern'
  | 'unknown-track'
  | 'self-overlap'
  | 'track-overlap';

export interface PlanRefusal {
  readonly rule: PlanRule;
  /** The sentence, in the register the tools refuse in: what was wrong, where,
   *  and what to do instead. */
  readonly reason: string;
  /** The bar the rule was broken at, where a bar is what broke it. Absent for
   *  the rules that are about a declaration rather than a position. */
  readonly bar?: number;
}

/** The holes in one track, as ranges. Only tracks that HAVE one appear. */
export interface TrackCoverage {
  readonly trackName: string;
  readonly emptyBars: readonly BarRange[];
}

export interface PlanReview {
  /** Empty when the plan is buildable. Every entry is a rule a write tool would
   *  enforce later, at the cost of a round trip or a half-built arrangement. */
  readonly refusals: readonly PlanRefusal[];
  /**
   * Reported, NOT refused. A sparse arrangement can be intended; a twelve-bar
   * form with eight bars of nothing is what four runs in a row produced with
   * nobody told. The caller decides which of those it is looking at.
   */
  readonly emptyBars: readonly TrackCoverage[];
  /** The last bar {@link emptyBars} was measured against — see the note on the
   *  span in {@link reviewPlan}. */
  readonly span: number;
}

/** A stretch of a track a placed copy would occupy, INCLUSIVE at both ends. */
interface Occupied {
  readonly from: number;
  readonly to: number;
  readonly patternName: string;
  readonly lengthBars: number;
}

/** Bars and lengths are whole and count from 1. One predicate for both, because
 *  they are the same claim: a half bar is not a position and not a length. */
const isBarCount = (value: number): boolean => Number.isInteger(value) && value >= 1;

const barsPhrase = (count: number): string => `${count} bar${count === 1 ? '' : 's'}`;

const listed = (names: readonly string[]): string =>
  names.length === 0 ? 'none' : names.map((entry) => `"${entry}"`).join(', ');

/**
 * The gaps in one track's coverage, walked as INTERVALS. A bar covered twice is
 * still covered, so this is fed every resolvable copy — including the ones the
 * overlap walk turned away, since which copy survives is a different question
 * from whether the bar has anything on it.
 *
 * ⚠ THE TWIN OF `gapRanges` IN `readTools.ts`, line for line — deliberately not
 * shared, and that is a debt and not a design. The two differ only in what they
 * are handed (bar spans here, tick placements there), so the walk belongs in one
 * module beside `barMath`, exactly as `barMath` and `instrumentCatalog` were cut
 * out of two disagreeing copies. This ticket's file fence forbids touching
 * `readTools.ts`, and moving the walk while leaving that call site behind would
 * add a module without removing a copy. Whoever collapses them owns both.
 */
function gapsIn(occupied: readonly Occupied[], lastBar: number): BarRange[] {
  if (lastBar < 1) return [];
  const gaps: BarRange[] = [];
  // The first bar not yet accounted for. `Math.max` because a short copy sitting
  // inside a long one must not wind the cursor backwards.
  let cursor = 1;
  for (const block of [...occupied].sort((a, b) => a.from - b.from)) {
    // `Math.min` because a copy running past the declared form is refused, not
    // dropped, so `block.from` can be past `lastBar` and the hole in front of it
    // ends where the form does.
    if (block.from > cursor) gaps.push({ from: cursor, to: Math.min(block.from - 1, lastBar) });
    cursor = Math.max(cursor, block.to + 1);
    if (cursor > lastBar) break;
  }
  if (cursor <= lastBar) gaps.push({ from: cursor, to: lastBar });
  // Belt and braces: every range above is built against `lastBar`, so none can
  // come out inverted. It stays because the day that stops being true, the
  // honest failure is a missing range and not a backwards one.
  return gaps.filter((gap) => gap.from <= gap.to);
}

/**
 * THE POINT OF THE TICKET: check the plan as DATA, against the rules the write
 * tools enforce, before a single note is written. Every one of them cost a
 * failed run to learn.
 *
 *   - a placement names a pattern and a track the plan declares;
 *   - a pattern is at least one whole bar long;
 *   - COPIES DO NOT STACK. A two-bar pattern at bars 1, 2, 3, 4 lands on top of
 *     itself. `composition_place_pattern` refuses that at write time — the whole
 *     call, with nothing placed — and the 2026-08-11 run burned its step budget
 *     discovering it three blocks at a time. Here it is catchable before
 *     anything exists;
 *   - two placements on one track do not overlap each other, given each
 *     pattern's declared length;
 *   - nothing runs past the end of the declared form, and no more tracks are
 *     declared than a composition can hold;
 *   - and the bars each track LEAVES EMPTY are reported rather than refused.
 *
 * PURE. No model, no harness, no DOM, no store — a plan object in, a review out.
 *
 * ⚠ THE SPAN THE GAPS ARE MEASURED AGAINST is the declared form length. Unlike
 * `read_composition` — which has no declared length and so measures against
 * where the arrangement happens to end — a plan says how long the form is, and
 * anything past it is already refused above as `past-form`. Measuring against
 * the furthest bar reached instead would let ONE mistyped bar report every other
 * track empty from bar 13 to bar 40 and bury the report this step exists for.
 * Only where `bars` is itself not a bar count does the span fall back to the
 * furthest bar anything reaches, so the gaps reported are still true.
 *
 * ⚠ WHAT IT DELIBERATELY DOES NOT CHECK is that a pattern's instrument matches
 * the track's. That is a real mismatch and the write path PERMITS it —
 * `read_composition` reports it as a cost (`blocksWrittenForAnotherInstrument`),
 * nothing refuses it — and a plan validator stricter than the tools it is
 * validating for would refuse arrangements that build perfectly well.
 *
 * ⚠ THE SHAPE IS TAKEN ON TRUST, and a malformed object THROWS rather than
 * refusing — the three lists are iterated, not guarded. That is intended: a plan
 * reaching here through the harness was validated against
 * `ARRANGEMENT_PLAN_SCHEMA` by `ajv` before `AgentRunSummary.structured`
 * existed, and `structured` is typed `unknown` precisely so that a caller has to
 * narrow it first. A caller that casts instead has a bug, and a `TypeError`
 * naming the line is a better report of it than a refusal that reads like the
 * model's fault. The numeric floors ARE re-checked, because they are two
 * comparisons and they are what the overlap arithmetic rests on.
 */
export function reviewPlan(plan: ArrangementPlan): PlanReview {
  const refusals: PlanRefusal[] = [];

  if (!isBarCount(plan.bars)) {
    refusals.push({
      rule: 'form-length',
      reason: `The form is ${plan.bars} bars long. Bars count FROM 1, so a form is at least 1 whole bar.`,
    });
  }

  // Declarations first: everything below is a reference into these, and a
  // reference check against a list with two entries of one name answers nothing.
  const patterns = new Map<string, PlannedPattern>();
  for (const pattern of plan.patterns) {
    if (patterns.has(pattern.name)) {
      refusals.push({
        rule: 'duplicate-name',
        reason: `Two patterns are named "${pattern.name}". A placement names its pattern by name, so two patterns sharing one cannot be told apart.`,
      });
    } else {
      patterns.set(pattern.name, pattern);
    }
    if (!isBarCount(pattern.lengthBars)) {
      refusals.push({
        rule: 'pattern-length',
        reason: `Pattern "${pattern.name}" is ${pattern.lengthBars} bars long. A pattern is at least 1 whole bar — that is the shortest thing there is to place.`,
      });
    }
  }

  const tracks = new Map<string, PlannedTrack>();
  for (const track of plan.tracks) {
    if (tracks.has(track.name)) {
      refusals.push({
        rule: 'duplicate-name',
        reason: `Two tracks are named "${track.name}". A placement names its track by name, so two tracks sharing one cannot be told apart.`,
      });
    } else {
      tracks.set(track.name, track);
    }
  }

  // The one rule here that is fatal rather than expensive: `composition_add_track`
  // refuses past the cap, so a plan wanting a ninth part cannot be assembled at
  // all, however well it is spaced. Counted over the DECLARED names, since two
  // tracks sharing one are already refused above and collapse to a single track.
  if (tracks.size > MAX_COMPOSITION_TRACKS) {
    refusals.push({
      rule: 'track-cap',
      reason: `The plan declares ${tracks.size} tracks. ${TRACK_CAP_REASON} Some of these parts have to be given up or combined.`,
    });
  }

  // Keyed by track NAME, which is also what a duplicate track name collapses —
  // the conservative read, and already refused above.
  const byTrack = new Map<string, Occupied[]>();
  for (const placement of plan.placements) {
    const pattern = patterns.get(placement.patternName);
    const track = tracks.get(placement.trackName);
    // The first bar asked for identifies WHICH placement is being talked about,
    // which is all a plan has to point with — there are no ids.
    const at = placement.atBars[0];
    if (!pattern) {
      refusals.push({
        rule: 'unknown-pattern',
        ...(at === undefined ? {} : { bar: at }),
        reason: `${describe(placement)} names pattern "${placement.patternName}", which the plan does not declare. The patterns it declares are ${listed([...patterns.keys()])}.`,
      });
    }
    if (!track) {
      refusals.push({
        rule: 'unknown-track',
        ...(at === undefined ? {} : { bar: at }),
        reason: `${describe(placement)} names track "${placement.trackName}", which the plan does not declare. The tracks it declares are ${listed([...tracks.keys()])}.`,
      });
    }
    // A placement with no bars is not a placement, and it is the one mistake
    // that leaves NO trace: no refusal, no block, and a track that reads as
    // planned-and-empty with nothing saying why. The schema's `minItems: 1`
    // covers the harness path; this covers the rest, like the floors below.
    if (placement.atBars.length === 0) {
      refusals.push({
        rule: 'bar-number',
        reason: `${named(placement)} names no bars. A placement says which bars the pattern starts on, so it needs at least one — otherwise drop the placement.`,
      });
    }
    for (const bar of placement.atBars) {
      if (isBarCount(bar)) continue;
      refusals.push({
        rule: 'bar-number',
        bar,
        reason: `${named(placement)} starts at bar ${bar}. Bars are counted FROM 1 and a block starts on a whole one.`,
      });
    }
    // A copy with no length and no home has no extent, so it can neither collide
    // nor cover anything. Those placements are already refused above; leaving
    // them out is what keeps one mistake from being reported as three.
    if (!pattern || !track || !isBarCount(pattern.lengthBars)) continue;
    const occupied = byTrack.get(placement.trackName) ?? [];
    for (const bar of placement.atBars) {
      if (!isBarCount(bar)) continue;
      const to = bar + pattern.lengthBars - 1;
      // A copy that ends outside the form is a lost count — the very thing this
      // step exists to catch — and it is refused rather than reported, because
      // nothing downstream would know where to put it. It is still counted as
      // occupying its bars: it can still collide, and the bars of the form it
      // does cover are not empty.
      if (isBarCount(plan.bars) && to > plan.bars) {
        const latest = plan.bars - pattern.lengthBars + 1;
        refusals.push({
          rule: 'past-form',
          bar,
          reason: `${named(placement)} starts at bar ${bar} and is ${barsPhrase(pattern.lengthBars)} long, so it runs to bar ${to} — past the end of the form, which is ${barsPhrase(plan.bars)} long. ${
            latest >= 1
              ? `Start it at bar ${latest} at the latest, or make the form longer.`
              : `The pattern is longer than the whole form: shorten it, or make the form longer.`
          }`,
        });
      }
      occupied.push({
        from: bar,
        to,
        patternName: pattern.name,
        lengthBars: pattern.lengthBars,
      });
    }
    byTrack.set(placement.trackName, occupied);
  }

  for (const [trackName, occupied] of byTrack) {
    refusals.push(...stacksOn(trackName, occupied));
  }

  // See the note on the span above: the declared form, and only where there is
  // no usable one does it fall back to what the placements actually reach.
  const span = isBarCount(plan.bars)
    ? plan.bars
    : [...byTrack.values()].flat().reduce((furthest, block) => Math.max(furthest, block.to), 0);

  const emptyBars: TrackCoverage[] = [];
  // In DECLARED order, and over every declared track — including one with no
  // placements at all. `read_composition` stays silent on an empty track because
  // two other fields on it already say so; a plan has no such fields, and a
  // track planned with nothing on it is exactly the thing nobody was told.
  for (const track of tracks.values()) {
    const gaps = gapsIn(byTrack.get(track.name) ?? [], span);
    if (gaps.length > 0) emptyBars.push({ trackName: track.name, emptyBars: gaps });
  }

  return { refusals, emptyBars, span };
}

/** A placement, by what it plays and where — the only handles a plan has. */
function named(placement: PlannedPlacement): string {
  return `The placement of "${placement.patternName}" on "${placement.trackName}"`;
}

/** The same, plus the first bar it asks for — which is what says WHICH of two
 *  placements of one pattern is meant. Left off where a bar is what is wrong. */
function describe(placement: PlannedPlacement): string {
  const at = placement.atBars[0];
  return at === undefined ? named(placement) : `${named(placement)} at bar ${at}`;
}

/**
 * The copies that land on top of something, walked in start order.
 *
 * ⚠ MEASURED AGAINST THE SURVIVORS, not against everything earlier — the same
 * walk `composition_place_pattern`'s own refusal makes, and for the same reason:
 * chaining off a copy that was itself turned away names ground nothing will ever
 * occupy. A two-bar pattern at bars 1, 2, 3, 4 comes back as two refusals (bars
 * 2 and 4) rather than six pairings, and the survivors — bars 1 and 3 — are
 * themselves a placement that would be accepted.
 *
 * ⚠ THE ADVICE BRANCHES ON WHAT IS IN THE WAY, because one recovery is right and
 * the other is a loop. Another copy of the SAME pattern means the copies are too
 * close together and the fix is spacing. A DIFFERENT pattern means two parts
 * meant to sound at once are sharing a track, and spacing them apart would push
 * one of them out of the form instead of onto a track of its own.
 */
function stacksOn(trackName: string, occupied: readonly Occupied[]): PlanRefusal[] {
  const order = [...occupied].sort((a, b) => a.from - b.from || a.to - b.to);
  const refusals: PlanRefusal[] = [];
  const kept: Occupied[] = [];
  for (const block of order) {
    // AT MOST ONE can be in the way: `kept` is pairwise non-overlapping by
    // construction, so two members both reaching this block would have to reach
    // each other. (`composition_place_pattern`'s walk needs the general case
    // because it also compares against blocks already on the track, which this
    // has none of — nothing exists yet.)
    const furthest = kept.find((earlier) => earlier.from <= block.to && earlier.to >= block.from);
    if (!furthest) {
      kept.push(block);
      continue;
    }
    const same = furthest.patternName === block.patternName;
    // Two entries for the SAME bar are not a spacing mistake and no spacing
    // fixes them — a block is placed once per entry, so the second one is a
    // duplicate. Said separately because the spacing sentence would otherwise
    // read "space the copies at bar 1 and bar 1 one bar apart".
    const duplicate = same && furthest.from === block.from;
    refusals.push({
      rule: same ? 'self-overlap' : 'track-overlap',
      bar: block.from,
      reason: duplicate
        ? `On track "${trackName}", bar ${block.from} is listed twice for "${block.patternName}". A copy is placed once per entry and two cannot share a bar, so drop the duplicate.`
        : same
          ? `On track "${trackName}", the copy of "${block.patternName}" at bar ${block.from} lands on top of the copy at bar ${furthest.from}, which is ${barsPhrase(furthest.lengthBars)} long and covers bars ${furthest.from}-${furthest.to}. Nothing is ever nudged aside: space the copies ${barsPhrase(block.lengthBars)} apart.`
          : `On track "${trackName}", "${block.patternName}" at bar ${block.from} lands on top of "${furthest.patternName}", which covers bars ${furthest.from}-${furthest.to}. A track plays one block at a time, so two parts that sound together belong on two tracks.`,
    });
  }
  return refusals;
}
