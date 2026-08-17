/**
 * THE CHART RUN — one tool-free model call that fixes the HARMONY and the PARTS,
 * and writes nothing.
 *
 * Something has to settle the progression once. Without it every part is written
 * over a progression of its own and three tracks disagree about what they are
 * playing over, which no check downstream can notice: each part is internally
 * correct, in range, the right length, and the piece is mush.
 *
 * ⚠ IT IS DELIBERATELY TINY, AND THAT IS THE WHOLE DESIGN DECISION. A much
 * bigger version of this step — pattern names, pattern lengths, and a list of the
 * bars each pattern covered — was built, tested, reviewed and DELETED on
 * 2026-08-16 (b8582bb, -4,549 lines) having produced zero compositions across
 * three end-to-end runs. Each died on bookkeeping with a musically reasonable
 * plan underneath: four patterns named "Bass Line" over four chords, which is how
 * you name a blues; a 2-bar pattern at bars [1,2,5,6,9,10] meaning "covers those
 * bars" read as "starts at those bars"; a turnaround needing a 2-bar pattern in
 * the one bar left. The root cause was that the schema made the model author
 * facts the app derives — `fitPatternDuration` sets a pattern's length from its
 * notes, `addPlacementToTrack` defaults a block to butting up against the
 * previous one — and every time the arithmetic moved into code it stayed fixed.
 *
 * So: NO IDS, NO LENGTHS, NO PLACEMENTS, NO POSITIONS. If a field could be
 * derived, it is not here. A chord holds until the next one, which is how a chart
 * has always worked and is exactly why there is no length to declare.
 *
 * ── WHY IT HAS NO TOOLS ─────────────────────────────────────────────────────
 *
 * The harness sends `outputSchema` to the backend for grammar-enforced decoding
 * ONLY on turns where no tools are offered at all; register one tool and the
 * structured answer degrades to a best-effort `JSON.parse` over the WHOLE reply,
 * with no fence stripping — so a ```json block, the commonest way a chat model
 * returns an object, yields nothing. A step whose entire product is a reliable
 * structure therefore gets an empty tool list. `RunAgentTaskOptions.outputSchema`
 * carries the citation and the verification; {@link ARRANGEMENT_CHART_AGENT} is
 * that empty list and {@link ARRANGEMENT_CHART_SCHEMA} is what this module hands
 * over as the schema. The prompt states the shape in words as well, because the
 * grammar is the PROVIDER's to honour and this app points at arbitrary
 * OpenAI-compatible backends.
 *
 * ── WHY THE PROMPT REUSES NOTHING FROM `agentRules` ─────────────────────────
 *
 * `agentRules` was read first. It exports exactly two handles — `SHARED_RULES`
 * and `pagePrompt`, which prepends it — and both open on METHOD: "You act only by
 * calling tools. Anything you describe without calling a tool did not happen."
 * That is precisely false here and it is the first thing the model would read.
 * `TIME` is tick arithmetic this run never does, `LENGTH` is about patterns and
 * blocks this run never names, `RESULTS` is how to read a tool result, and `NECK`
 * sends the model to `read_chord_voicings`. There is no third handle to import a
 * section through, and splitting that file is outside this card's fence. The one
 * idea genuinely worth carrying over — chords are SYMBOLS, never frets, because
 * the writing run looks them up on its own neck — is restated below in this run's
 * own vocabulary, and it is one sentence rather than a copied section.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 *
 * It is not wired to a panel or a command, and it does not sequence anything. A
 * later card runs this, then the per-track step, then `patternService.importIR`.
 */
import { MAX_COMPOSITION_TRACKS, TRACK_CAP_REASON } from '../composition/compositionService';
import { chordGrip, unknownInstrumentRefusal } from '../patterns/patternService';
import { INSTRUMENT_IDS, INSTRUMENT_LIST } from './tools/instrumentCatalog';
import { runAgentTask } from './agentService';
import {
  arr,
  int,
  name as nameField,
  namedRefusals,
  num,
  obj,
  str,
  type JsonSchema,
} from './tools/types';
import type { AgentRunSummary, AgentSpec, RunAgentTaskOptions } from './agentService';
import type { Result } from '../patterns/patternService';

// ----------------------------------------------------------------- shape ---

/** One part: what it is called, what it plays, and what it is FOR. */
export interface ChartTrack {
  readonly name: string;
  readonly instrumentId: string;
  /**
   * What this part DOES, in the model's own words — "walking bass", "off-beat
   * comping", "lead fills". It is the brief the per-track run gets, which is why
   * it is prose and not an enum: an enum would be this app's vocabulary handed
   * back to the model as its only choice, and the whole point of asking is to get
   * something more specific than "bass".
   */
  readonly role: string;
}

/**
 * A chord and the bar it ARRIVES on, counted from 1. It holds until the next
 * entry — there is no length here and there must not be one; how long a chord
 * lasts is the distance to the next arrival, and that is arithmetic the app can
 * do and the model got wrong every time it was asked to.
 */
export interface ChartChord {
  readonly bar: number;
  readonly symbol: string;
}

export interface ArrangementChart {
  /** How long the form is, in bars. Bars count FROM 1, so this is also the
   *  number of the last bar. */
  readonly bars: number;
  readonly bpm: number;
  readonly tracks: readonly ChartTrack[];
  readonly chords: readonly ChartChord[];
}

/**
 * ONE instrument vocabulary, and it is the PATTERN catalog's — `instrumentCatalog`
 * exists because two tool modules built the same list from the seam
 * independently. `compositionTools` deliberately keeps its own, off
 * `listTrackInstruments`; the two are the same lib catalog today and the import
 * step is where a divergence would show. A chart naming an instrument two ways in
 * one object would be a distinction the model has to maintain for no gain it can
 * see, and this is the same catalog `patternRunInput` voices against later.
 */
const instrument = (what: string): JsonSchema =>
  str(`${what} One of: ${INSTRUMENT_LIST}.`, INSTRUMENT_IDS);

/**
 * The tempo this run may ask for, in ONE place — the schema advertises it and
 * {@link reviewChart} enforces it, so the grammar and the refusal cannot drift
 * apart within this module.
 *
 * ⚠ IT IS ENFORCED HERE BECAUSE NOTHING DOWNSTREAM ENFORCES IT.
 * `compositionService.setCompositionBpm` refuses only a non-finite or
 * non-positive tempo; the 20..400 pair exists solely in the tool schemas of
 * `composition_set_settings` and `pattern_set_playback`, which is provider-
 * honoured advice rather than a check. So `bpm: 0` and `bpm: 100000` would both
 * be stored, and a chart is the one place the whole piece's tempo is decided.
 *
 * The pair is not shared with those two tool modules: hoisting it would mean
 * authoring a bound on `compositionService` that the store does not actually
 * hold callers to, which is a bigger claim than this card gets to make.
 */
const BPM_BOUNDS = { min: 20, max: 400 } as const;

/**
 * The chart, as JSON Schema — handed to the backend as a grammar.
 *
 * `additionalProperties: false` throughout (`obj` does it) so a field the model
 * invents is a decoding failure rather than a silently dropped instruction, and
 * every array is `minItems: 1` (`arr` does it) because a chart with no parts or
 * no chords is not a chart.
 *
 * ⚠ THE SCHEMA IS NOT THE VALIDATION. It can say a bar is an integer ≥ 1; it
 * cannot say the bar is inside THIS form, that the entries ascend, that bar 1 is
 * spoken for, or that a symbol is one the app can read. Those are
 * {@link reviewChart}'s.
 *
 * The bpm bounds are {@link BPM_BOUNDS}, the same pair {@link reviewChart}
 * refuses by — see there for why this module holds the tempo to them itself.
 */
export const ARRANGEMENT_CHART_SCHEMA: JsonSchema = obj(
  {
    bars: int(
      'How long the form is, in bars — 12 for a twelve-bar blues. Bars count FROM 1, so this is also the number of the last bar.',
      { min: 1 },
    ),
    bpm: num('The tempo the whole piece is played at.', BPM_BOUNDS),
    tracks: arr(
      obj(
        {
          name: nameField(
            'What this part is called. Name it for the instrument it is on — "Bass", "Rhythm Guitar", "Lead Guitar", "Ukulele".',
          ),
          instrumentId: instrument('The instrument this part plays.'),
          role: nameField(
            'What this part DOES, in your own words and in a few — "walking bass, quarter notes", "off-beat comping", "lead fills over the changes". This is the whole brief the run that writes it gets.',
          ),
        },
        ['name', 'instrumentId', 'role'],
      ),
      'The parts. One per track: two things that sound at the same time cannot share one. Few and distinct.',
    ),
    chords: arr(
      obj(
        {
          bar: int('The bar this chord ARRIVES on, counted from 1.', { min: 1 }),
          symbol: nameField(
            'The chord, as a SYMBOL — "C7", "Fmaj7", "F#m7b5", "G/B". Never frets: the run that writes each part looks the symbol up on its own instrument\'s neck.',
          ),
        },
        ['bar', 'symbol'],
      ),
      'The progression. A chord holds until the next entry, so write each change ONCE, at the bar it arrives on. There must be one at bar 1 and they must ascend.',
    ),
  },
  ['bars', 'bpm', 'tracks', 'chords'],
);

// ---------------------------------------------------------------- prompt ---

/**
 * What the run is told. Headed sections rather than one run of prose, for
 * `agentRules`' reason: a rule has to be referrable back to mid-answer.
 *
 * The JSON instruction is load-bearing twice over. Grammar-enforced decoding
 * makes the object well-formed, but the harness parses the WHOLE final answer
 * with `JSON.parse` and does no fence stripping and no extraction, so a fence or
 * a leading sentence yields nothing at all — a fact worth three clauses, because
 * it turns a good chart into no chart.
 *
 * ⚠ THE LAST SECTION IS THE INOCULATION, and it is why this prompt names things
 * it does not ask for. The deleted step's failures were all the model doing
 * arithmetic to satisfy a shape; a model that has ever seen an arranging schema
 * will reach for pattern names and bar lists unprompted, and
 * `additionalProperties: false` turns that reach into a decoding failure rather
 * than into an answer. Telling it those are somebody else's costs four lines.
 *
 * ⚠ AND `The parts` STATES A RELATION BETWEEN TWO FIELDS RATHER THAN A RULE ABOUT
 * A SET. That is the second attempt at one repair, and the first attempt is why.
 *
 * The 2026-08-16 run planned Bass, Guitar and a part called DRUMS whose
 * `instrumentId` was `bass`. The instrument check did its job — `drums` is not in
 * the catalog and never got through — so what arrived was a legal bass with a
 * drummer's brief on it, and the piece shipped with two bass tracks. The repair
 * was a paragraph saying this app plays fretted strings and nothing else. THE NEXT
 * RUN PLANNED A PART CALLED PIANO WHOSE `instrumentId` WAS `ukulele`, role "light
 * comping, inner voice fills". The model had obeyed the letter and kept the
 * intent: it changed the id it SENT and not the part it IMAGINED, and the user got
 * a ukulele track called Piano playing piano-shaped comping.
 *
 * So the sentence about what the app has not got is DEMOTED TO A PREMISE — it is
 * still there, because the model has to know which necks exist, but it is no longer
 * the rule. A constraint over a set the model must recall and then apply is the
 * shape this pipeline has lost at every time — it is what the step deleted at
 * b8582bb was made of. A relation between fields the model is writing on the same
 * object is the shape that has stuck every time; `strum`, over a grip the brief
 * already carries, is the same move. The rule is therefore THE PART IS THE
 * INSTRUMENT IT IS ON: the `name` and the `role` are the ones for the
 * `instrumentId` beside them.
 *
 * ⚠ AND THE REASON OFFERED FOR IT IS THE TRUE MECHANISM, WHICH IS ALSO THE
 * STRONGER ONE. A first draft of this paragraph told the model the `name` is a
 * label that changes nothing that sounds. That is FALSE — `irCompositionJob`'s
 * `briefFor` copies the name straight through and `trackRunInput` opens the
 * writing brief with `Write "<name>" — <role> — on <instrument>`, then says in the
 * next line that the name and the role are what the part is FOR. So the name is
 * the first thing the writing model reads, and the false version argued the wrong
 * way besides: a model told the name is inert has been told that calling the part
 * Piano is free, which is the permission it already took. The true chain is the
 * one that explains the observed defect — `name: "Piano"` plus a comping role went
 * into the brief AS THE PART'S PURPOSE, and a ukulele came back playing keyboard
 * music. A mechanical reason is one the model can check its own answer against;
 * a mechanical reason that is not true of the pipeline is worse than none.
 *
 * The catalog is SUBSTITUTED, never typed out — `instrumentCatalog`'s own rule.
 * An instrument the lib adds is one this prompt offers the same day, and a
 * hand-written list here would be a model told a real instrument does not exist.
 * The two WRONG PAIRINGS named as examples are safe from that staleness for a
 * different reason: what makes each wrong is the MISMATCH between the name and the
 * id, which stays wrong whatever the catalog grows to.
 *
 * ⚠ AND THE `role` EXAMPLES NAME ONLY PARTS THAT CAN BE ON THE CHART. A role is
 * the ENTIRE brief the writing run gets, so an exemplar mentioning a part this
 * app has no neck for — "fills between the vocal lines" was one — asks for a
 * guitar written around a silence, which is this same defect one field over.
 */
const ARRANGEMENT_CHART_PROMPT = `# What you are doing

You are writing a CHART for a piece nobody has played yet: how long it is, how fast it goes, what the harmony does, and which parts play it. You write no notes here — a later run writes each part, and ordinary code builds the piece from what you say.

You have no tools. There is nothing to call and nothing to look up.

ANSWER WITH ONE JSON OBJECT AND NOTHING ELSE. No sentence before it, no code fence around it, no commentary after it. The answer is parsed whole — anything but the bare object is thrown away, and a good chart wrapped in a fence is no chart at all.

# The shape of the answer

Exactly these keys, exactly these names, and nothing else:

{"bars":12,"bpm":120,"tracks":[{"name":"Bass","instrumentId":"bass","role":"walking bass, quarter notes, root to root"}],"chords":[{"bar":1,"symbol":"C7"},{"bar":5,"symbol":"F7"}]}

# The form and the harmony

\`bars\` is how long the form is. Bars are counted FROM 1: bar 1 is the start, and \`bars\` is the number of the last bar. \`bpm\` is the tempo the whole piece is played at.

\`chords\` is the progression, written the way a chart is written: a chord SYMBOL and the BAR it arrives on. A CHORD HOLDS UNTIL THE NEXT ONE. You do not say how long it lasts and you do not repeat it on every bar it covers — the next entry is what ends it, and the last one runs to the end of the form. A twelve-bar blues in C is six entries: C7 at bar 1, F7 at 5, C7 at 7, G7 at 9, F7 at 10, C7 at 11.

There must be a chord at bar 1 — the form has to start somewhere. Every entry after it arrives at a LATER bar than the one before, and no entry arrives past bar \`bars\`.

Chords are SYMBOLS, never frets: "C7", "Fmaj7", "F#m7b5", "G/B". The run that writes each part looks that symbol up on the neck of ITS OWN instrument, and that is what makes a bass part a bass part rather than a guitar shape moved across.

# The parts

EVERY PART IS PLAYED ON A FRETTED NECK, AND THESE ARE THE ONLY NECKS THERE ARE: ${INSTRUMENT_LIST}. If an instrument is not on that list, this app does not have it and cannot get it.

SO A PART IS THE INSTRUMENT IT IS ON. Pick the neck first, then say what THAT neck does: name the part for the neck you picked, and write its \`role\` for that neck — its strings, its register, its attack.

The run that writes the part is handed your \`name\`, your \`role\` and that neck, and it is told the name and the role are WHAT THE PART IS FOR. It reads them and writes notes. So "Piano" on a \`ukulele\` does not get a piano: it gets a player reading "Write Piano — light comping, inner voice fills — on Ukulele" and writing keyboard music onto four strings that have not got the range for it, and the piece is a part short. "Drums" on a \`bass\` is a second bass reading a drummer's brief.

If the arrangement in your head wants a part there is no neck for, do not dress another instrument in its name. Give that job to the necks there are, or leave it out.

PARTS MAY SHARE A NECK, and that is how a band gets another voice rather than by reaching for a different instrument. Two guitars playing different jobs — one comping, one answering it — is the ordinary shape of a rhythm section, and three is not unusual. Pick a second guitar over a first ukulele every time, unless the piece asks for that ukulele: a neck chosen for variety, when the part could have been played on one already in the arrangement, is a colour nobody asked for.

\`tracks\` are the parts, one per track: two things that sound at the same time cannot share one. Each has a \`name\`, the \`instrumentId\` it plays, and a \`role\` — a short phrase in your own words saying what that part DOES. "Walking bass, quarter notes." "Off-beat comping, upper strings." "Sparse lead fills in the gaps between the other parts." The role is the entire brief the run that writes that part is given, so it has to say something a player could act on.

FEW AND DISTINCT. Three parts each doing a different job beat six that double each other, and a part with no job of its own is a part that will be written as filler.

AT MOST ${MAX_COMPOSITION_TRACKS} TRACKS. ${TRACK_CAP_REASON} A chart with more than that cannot be built at all.

# What is not yours to decide

Nothing beyond the four keys above. No pattern names, no lengths, no bar lists, no positions, no ids — every one of those is worked out from what you write here, and a chart that tried to declare them would be refused for the key it invented. Say what the piece IS; the arithmetic is somebody else's.`;

/**
 * The spec. ⚠ THE EMPTY TOOL LIST IS THE FEATURE — see the header. A tool added
 * here silently downgrades {@link ARRANGEMENT_CHART_SCHEMA} from a grammar the
 * provider decodes against to a hope about what the model happened to write.
 */
export const ARRANGEMENT_CHART_AGENT: AgentSpec = {
  name: 'arrangement-chart',
  systemPrompt: ARRANGEMENT_CHART_PROMPT,
  tools: [],
};

// ---------------------------------------------------------------- review ---

/**
 * One thing wrong, in the shape `namedRefusals` takes: WHERE it went wrong and
 * the sentence about it. Grouped through that helper rather than joined here so
 * a chart that is wrong end to end costs one capped sentence instead of one per
 * entry — the batch rule every tool in this app already caps by.
 */
export interface ChartRefusal {
  /** What the refusal is about — `bar 13`, `track "Horns"`. */
  readonly label: string;
  /** What was wrong, and what would be right instead. */
  readonly reason: string;
}

/**
 * The instruments in the chart that this app has a neck for, de-duplicated and
 * in declaration order.
 *
 * Split out because it answers two questions: which tracks are refusable, and
 * which necks a chord can be asked about. An unknown instrument is reported ONCE
 * as a track problem and then excluded — asking `chordGrip` about it would get
 * back the same "no neck for that" sentence once per chord, which is one mistake
 * with thirteen accounts of it.
 */
function knownInstruments(tracks: readonly ChartTrack[]): readonly string[] {
  const known = new Set(INSTRUMENT_IDS as readonly string[]);
  return [...new Set(tracks.map((track) => track.instrumentId))].filter((id) => known.has(id));
}

/**
 * ⚠ EVERY CHORD IS ASKED ABOUT ON EVERY NECK IN THE CHART, not on one arbitrary
 * one, and that is a decision rather than thoroughness.
 *
 * ⚠ AND IT IS BROADER THAN A PARSE CHECK, ON PURPOSE. `chordGrip` refuses for
 * three things, not one: a symbol it cannot read, an instrument whose tuning is
 * missing from the lib catalog, and a chord no shape on that neck can reach. All
 * three are passed on. A symbol that parses but cannot be voiced is still a
 * chord the writing run cannot be handed a grip for on that instrument, so it is
 * a chart that does not build, and the sentence `chordGrip` authors says which of
 * the three it was. None of the two extra cases is reachable today — every root
 * and quality voices on all three necks in the catalog, and every catalog
 * instrument has its tuning — so what this buys is that the day one of them
 * stops being true, the refusal arrives here rather than three sub-runs later.
 *
 * The check the card names is "a symbol `parseChordSymbol` cannot read", and the
 * only door to it from this side of the wall is `chordGrip` — the tripwire in
 * `tests/AgentTools.test.ts` forbids `src/ai/**` importing `@fretwork/lib`, so
 * the parser is not reachable directly. `chordGrip` takes an instrument, which
 * means a neck has to be chosen, and there are only two ways to choose one: pick
 * a fixed id, or use the ones the chart declares.
 *
 * The chart's own necks win because they are the necks the question will actually
 * be asked on: `patternRunInput` calls this same function with this same pair
 * before it briefs the writing run, and refuses on its answer. A symbol that
 * passed against a hardcoded guitar and then failed on the ukulele would be a
 * refusal arriving three sub-runs later, with a part already written. A fixed id
 * would also be a lib catalog value written out by hand here, which is the thing
 * `instrumentCatalog` exists to stop.
 *
 * It stops at the FIRST neck that refuses, so one bad symbol is one sentence.
 * Where every track named an instrument this app has not got there is no neck to
 * ask on and the symbols go unchecked — the track refusals are what that chart
 * gets, and they are the repair.
 */
function chordRefusal(chord: ChartChord, instruments: readonly string[]): ChartRefusal | null {
  for (const instrumentId of instruments) {
    const grip = chordGrip(chord.symbol, instrumentId);
    // The seam's own sentence, verbatim — `fromResult`'s rule. It already names
    // the symbol and, where the neck is what could not carry it, the neck.
    if (!grip.ok) return { label: `bar ${chord.bar}`, reason: grip.reason };
  }
  return null;
}

/**
 * THE WHOLE VALIDATION, and it is short on purpose.
 *
 * Nothing here duplicates a fact the app derives, and nothing re-checks the
 * schema for its own sake — every entry is something a provider that ignored the
 * grammar would otherwise get past us:
 *
 *   - a form that is not a whole number of bars from 1;
 *   - a tempo outside {@link BPM_BOUNDS};
 *   - no parts at all, or more than a composition can hold;
 *   - a part on an instrument this app has no neck for;
 *   - no chord at bar 1, because the form has to start somewhere;
 *   - a chord arriving outside 1..`bars`, or not after the one before it;
 *   - a symbol the chord parser cannot read.
 *
 * ⚠ THE SCHEMA IS NOT A CHECK. `bars`, `bpm` and the array minimums are declared
 * in {@link ARRANGEMENT_CHART_SCHEMA} and honoured only by a provider that
 * decodes against the grammar, which this app cannot assume of an arbitrary
 * OpenAI-compatible backend; {@link asChart} narrows TYPES and deliberately
 * refuses no value. So this is the only place a fractional `bars`, a tempo of
 * zero, or a chart with no parts is stopped, and each of those is a fact every
 * later step derives from rather than a detail.
 *
 * DELIBERATELY NOT CHECKED: a floor of two parts, duplicate track names, and
 * whether the harmony is any good. A one-part chart is a real thing to ask for —
 * it maps to a single pattern rather than a composition, which is a usable
 * outcome and not a mistake to refuse; duplicate names are a later step's to
 * derive around; the last is a listening test's and no reply we can design
 * catches it. Nor is there a CEILING on `bars`: nothing downstream has one, and
 * a limit invented here would be this module refusing a form for a reason no
 * other part of the app holds.
 *
 * ⚠ AND — THE CHECK THIS FUNCTION HAS NOW BEEN ASKED FOR TWICE AND DECLINED
 * TWICE — A PART FOR AN INSTRUMENT THIS APP HAS NOT GOT. "Drums" on a `bass`
 * (2026-08-16) and "Piano" on a `ukulele` (the run after it) are the two cases,
 * and the only check on offer is a blocklist of names: Drums, Piano, Keys, Organ,
 * Vocals, Horns.
 *
 * THE CASE FOR IT IS BETTER THAN IT WAS, AND SAYING OTHERWISE WOULD BE DISHONEST.
 * Twice, with two different imagined instruments, is not one anecdote; five of
 * those six words are names nobody gives a guitar or a bass part; and "it passes
 * the moment the model writes Kit" is an argument against a check being COMPLETE,
 * which no check in this file is. The old objection — that a percussive
 * muted-string figure holding the pulse is a real part a player would nickname
 * "Drums" — survives, but it covers one word of six.
 *
 * IT IS DECLINED ON WHERE IT WOULD FIRE, NOT ON WHETHER IT WOULD BE RIGHT.
 * `irCompositionJob` retries a PART, once, with the refusal fed back, and imports
 * what survived when one fails for good. THE CHART HAS NEITHER: it is never
 * re-asked, so a refusal here ends the job with nothing imported and nothing
 * written, and the sentence is read by a person who can only run the whole thing
 * again. So the arithmetic is that a WRONG refusal costs the entire composition
 * and a RIGHT one costs the entire composition too — because what it catches is a
 * chart that BUILDS. The Piano run is the measurement: a correct twelve-bar blues,
 * 323 notes, three parts that played, and the verdict on it was that this is a much
 * better path. A name check would have deleted all of that to avoid one ukulele
 * track called Piano. A refusal has to be cheaper than the defect it prevents, and
 * at this step, uniquely, nothing is.
 *
 * The right shape here would be a NOTE — build the piece, and say the track looks
 * misnamed. There is no note channel: this function returns refusals, the job turns
 * any of them into a dead run, and inventing a third outcome would be this module
 * authoring a concept the job it feeds does not have.
 *
 * SO THE REPAIR IS THE PROMPT AGAIN — but a DIFFERENT prompt, not a louder one.
 * The header says why: the paragraph that failed stated a rule about the set of
 * instruments the app lacks, and the model satisfied it by changing the id it sent;
 * the paragraph that replaced it states a relation between the `name`, the `role`
 * and the `instrumentId` sitting beside them, which is the only shape of
 * instruction this pipeline has ever made stick. IF IT FAILS A THIRD TIME the next
 * move is still not a blocklist. It is to stop the model choosing the name at all
 * and derive it from the instrument, leaving the model only what distinguishes two
 * parts on one neck — the deleted step's lesson pointed the other way, taking the
 * field away rather than policing what goes into it. Note what that costs, because
 * it is not free: the name is NOT inert downstream. `trackRunInput` opens the
 * writing brief with it and calls it what the part is FOR, so deriving it would
 * change what every writing run reads, not just what the finished track is
 * labelled. That is a schema change AND a change to the other prompt, and it is a
 * bigger claim than a rewritten prompt is owed before it has been tried once.
 *
 * ⚠ TAKES ITS ARGUMENT ON TRUST. The lists are iterated, not guarded — a caller
 * holding an `unknown` narrows it with {@link asChart} first, which is why that
 * function exists.
 */
export function reviewChart(chart: ArrangementChart): readonly ChartRefusal[] {
  const refusals: ChartRefusal[] = [];

  // The call-wide facts first, for `chordGrip`'s reason: a chart that cannot be
  // built at all should hear about that rather than about its first chord.
  //
  // A form length that is not a whole bar from 1 also SUPPRESSES the per-chord
  // range test below: `bar > chart.bars` against a bound of 12.5 would blame
  // every chord for one bad number and print the bad number in each sentence.
  const formed = Number.isInteger(chart.bars) && chart.bars >= 1;
  if (!formed) {
    refusals.push({
      label: `${chart.bars} bars`,
      reason: `A form is a whole number of bars, at least 1 — ${chart.bars} is not a length a piece can have. Bars count FROM 1, so \`bars\` is also the number of the last bar.`,
    });
  }
  if (chart.bpm < BPM_BOUNDS.min || chart.bpm > BPM_BOUNDS.max) {
    refusals.push({
      label: `${chart.bpm} bpm`,
      reason: `The tempo is ${chart.bpm}, which is not a tempo this app plays. Give a tempo from ${BPM_BOUNDS.min} to ${BPM_BOUNDS.max}.`,
    });
  }

  if (chart.tracks.length === 0) {
    // Nothing else in this function speaks for the empty chart: no track is
    // refusable, and `knownInstruments([])` is empty, so the chord lookup has no
    // neck to ask on and every symbol goes unchecked. Left alone it is an `ok`
    // carrying a piece with no parts in it.
    refusals.push({
      label: 'no parts',
      reason:
        'The chart names no parts, so there is nothing for anyone to play and nothing for the next run to write. Name at least one track: what it is called, what it plays, and what it does.',
    });
  }
  if (chart.tracks.length > MAX_COMPOSITION_TRACKS) {
    refusals.push({
      label: `${chart.tracks.length} parts`,
      reason: `${TRACK_CAP_REASON} Give up ${chart.tracks.length - MAX_COMPOSITION_TRACKS} of them.`,
    });
  }
  for (const track of chart.tracks) {
    if (!(INSTRUMENT_IDS as readonly string[]).includes(track.instrumentId)) {
      // The seam's authoring of it, so the agent and the UI cannot get two
      // accounts of one missing neck.
      refusals.push({
        label: `track "${track.name}"`,
        reason: unknownInstrumentRefusal(track.instrumentId),
      });
    }
  }

  // `some` rather than reading the first entry, so this stays true of a chart
  // whose entries are also out of order — two mistakes, two sentences.
  if (!chart.chords.some((chord) => chord.bar === 1)) {
    refusals.push({
      label: 'bar 1',
      reason:
        'The chart has no chord at bar 1. A chord holds until the next one, so bar 1 has to name the chord the piece starts on.',
    });
  }

  const instruments = knownInstruments(chart.tracks);
  let previous: ChartChord | null = null;
  for (const chord of chart.chords) {
    if (!Number.isInteger(chord.bar) || chord.bar < 1 || (formed && chord.bar > chart.bars)) {
      refusals.push({
        label: `bar ${chord.bar}`,
        reason: `"${chord.symbol}" arrives at bar ${chord.bar}, which is outside a form of ${chart.bars} bars. Every chord arrives at a whole bar from 1 to ${chart.bars}.`,
      });
    } else if (previous !== null && chord.bar <= previous.bar) {
      // `else if` because a bar outside the form has already been reported and
      // its ordering is not a second thing to fix.
      refusals.push({
        label: `bar ${chord.bar}`,
        reason: `"${chord.symbol}" arrives at bar ${chord.bar}, at or before "${previous.symbol}" at bar ${previous.bar}. A chord holds until the next one, so the chords are written in ascending bar order with one entry per change.`,
      });
    } else {
      previous = chord;
      // The symbol is looked up only for an entry that is otherwise sound, for
      // the reason the `else if` above exists: one entry gets one sentence. An
      // entry already refused for WHERE it arrives does not also need telling
      // that its symbol is unreadable, and with a handful of them the
      // `REFUSALS_NAMED` cap would fill with two accounts of each before it
      // reached the later chords.
      const unreadable = chordRefusal(chord, instruments);
      if (unreadable) refusals.push(unreadable);
    }
  }

  return refusals;
}

// ------------------------------------------------------------- narrowing ---

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === 'string';

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isPresent = <T,>(value: T | null): value is T => value !== null;

/**
 * `AgentRunSummary.structured` — typed `unknown` — as a chart, or null.
 *
 * ⚠ NOT BELT AND BRACES. `structured` is `unknown` precisely because this seam
 * did not author the schema and cannot promise the shape; {@link reviewChart}
 * iterates its lists rather than guarding them. So the narrowing happens here,
 * once, and a reply that is not a chart is a typed refusal rather than a
 * `TypeError` out of the validator.
 *
 * ⚠ TYPES ONLY, NEVER VALUES. `bars: 0`, a bar past the form, an instrument that
 * does not exist — all of those pass here and are `reviewChart`'s to refuse, in
 * the sentences it authored. Re-checking them here would put two accounts of one
 * mistake in circulation.
 *
 * The fields are COPIED rather than the reply cast, so a provider that ignored
 * `additionalProperties: false` cannot smuggle an extra key into the chart the
 * rest of the job is built from.
 */
export function asChart(value: unknown): ArrangementChart | null {
  if (!isObject(value)) return null;
  const { bars, bpm, tracks, chords } = value;
  if (!isNumber(bars) || !isNumber(bpm)) return null;
  if (!Array.isArray(tracks) || !Array.isArray(chords)) return null;

  const parts = tracks.map((track) =>
    isObject(track) && isText(track.name) && isText(track.instrumentId) && isText(track.role)
      ? { name: track.name, instrumentId: track.instrumentId, role: track.role }
      : null,
  );
  const progression = chords.map((chord) =>
    isObject(chord) && isNumber(chord.bar) && isText(chord.symbol)
      ? { bar: chord.bar, symbol: chord.symbol }
      : null,
  );

  // One bad entry makes the whole reply unusable rather than a chart with a hole
  // in it: dropping a chord entry silently EXTENDS the one before it, because a
  // chord holds until the next one — a decoding failure would become a piece
  // sitting on the wrong harmony for four bars with nobody told.
  //
  // `every` with a predicate rather than `includes(null)` and a cast: the guard
  // and the narrowing are then the same statement, so a later edit cannot drop
  // one and leave the other asserting a shape nothing checks — `reviewChart`
  // dereferences `track.instrumentId` and would throw on the null that got past.
  if (!parts.every(isPresent) || !progression.every(isPresent)) return null;

  return { bars, bpm, tracks: parts, chords: progression };
}

// ------------------------------------------------------------------- run ---

/**
 * The one outside call, injected. A test drives this module with a function that
 * returns what it says it returns — what is being asserted is the schema that
 * goes out, the narrowing and the review, none of which needs a provider and none
 * of which a test with one could assert.
 */
export interface ChartRunDeps {
  readonly runTask: (
    spec: AgentSpec,
    input: string,
    options?: RunAgentTaskOptions,
  ) => Promise<Result<AgentRunSummary>>;
}

/** Not exported: it is the default for the one parameter below and nothing else
 *  imports it — a caller that wants a different `runTask` passes `deps`. */
const CHART_RUN_DEPS: ChartRunDeps = { runTask: runAgentTask };

/**
 * Ask a model for a chart.
 *
 * `options` is passed through to the seam untouched EXCEPT for `outputSchema`,
 * which is this module's and is overwritten: the schema and the prompt describe
 * one shape and a caller substituting another would get a chart the narrowing
 * below cannot read.
 *
 * Every failure is a RETURNED refusal, in the register the seams refuse in:
 *   - nothing was asked for;
 *   - the run itself refused — no provider, a dead endpoint, an error — and that
 *     sentence is the seam's, passed on;
 *   - the run answered without a structure, which is a real outcome and not a bug
 *     (`structured` exists only on `stoppedReason: 'answered'`, and only when the
 *     whole reply parsed and validated);
 *   - the structure is not a chart;
 *   - the chart breaks a rule {@link reviewChart} names.
 */
export async function runArrangementChart(
  request: string,
  options: RunAgentTaskOptions & { readonly deps?: ChartRunDeps } = {},
): Promise<Result<ArrangementChart>> {
  const ask = request.trim();
  if (ask === '') {
    return { ok: false, reason: 'There is nothing to write a chart for — say what the piece is.' };
  }

  const { deps = CHART_RUN_DEPS, ...runOptions } = options;
  const run = await deps.runTask(ARRANGEMENT_CHART_AGENT, ask, {
    ...runOptions,
    outputSchema: ARRANGEMENT_CHART_SCHEMA,
  });
  if (!run.ok) return run;

  const chart = asChart(run.value.structured);
  if (chart === null) {
    // The stop reason is named because it separates the two ways to get here
    // that need different repairs: `answered` means the model wrote prose or
    // fenced its JSON, anything else means the run never got to answer at all.
    return {
      ok: false,
      reason: `The chart run produced no usable chart — it stopped with "${run.value.stoppedReason}" and its answer is not an object with bars, bpm, tracks and chords. The answer is parsed whole, so a code fence or a sentence in front of the JSON leaves nothing to read.`,
    };
  }

  const refusals = reviewChart(chart);
  if (refusals.length > 0) {
    return { ok: false, reason: `The chart cannot be built. ${namedRefusals(refusals)}` };
  }

  return { ok: true, value: chart };
}
