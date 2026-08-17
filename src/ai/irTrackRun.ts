/**
 * ONE TRACK OF MUSIC, as JSON — the tool-free writing run that produces the notes.
 *
 * The chart run settles what the harmony IS and what the parts are. This is the
 * step that plays one of them: given a part's name, its role, its instrument and
 * the progression, it returns the events of a single `IRTrack` for
 * `patternService.importIR` to commit.
 *
 * It is not wired to a panel or a command and it sequences nothing. A later card
 * runs the chart, runs one of these per track, and hands the assembled document
 * to the seam.
 *
 * ── WHY IT HAS NO TOOLS ─────────────────────────────────────────────────────
 *
 * The same reason the chart run has none, and it is worth restating because it
 * decides the whole design of this file. The harness sends `outputSchema` to the
 * backend for grammar-enforced decoding ONLY on turns where no tools are offered
 * at all; register one tool and the structured answer degrades to a best-effort
 * `JSON.parse` over the WHOLE reply, with no fence stripping — so a ```json
 * block, the commonest way a chat model returns an object, yields nothing. A
 * step whose entire product is a structure therefore gets an empty tool list.
 * `RunAgentTaskOptions.outputSchema` carries the citation and the verification.
 *
 * ── WHY THE MODEL AUTHORS ONLY `events` ─────────────────────────────────────
 *
 * An `IRTrack` is `{ id, name, instrumentHint, events }`, and three of those four
 * are already known before the run starts: the caller named the part, chose its
 * instrument and owns the id that has to be unique across the document. Asking
 * the model to echo them back is asking it to author facts the app derives, which
 * is the single lesson of the orchestrator deleted at b8582bb — every field the
 * model had to restate was a field it eventually restated wrong. So
 * {@link IR_TRACK_SCHEMA} describes `{ events }` and {@link runIRTrack} puts the
 * identity back on afterwards, from the brief it was given.
 *
 * ── ⚠ `src/ai/**` MAY NOT IMPORT `@fretwork/lib` ────────────────────────────
 *
 * `ImportIR` and its `IRTrack`/`IREvent`/`IRNote` live there, and a tripwire test
 * in `tests/AgentTools.test.ts` fails any file under `src/ai/**` that imports the
 * lib or `composition-ops`. So the shape is declared STRUCTURALLY here and stated
 * to the model as JSON Schema; the seam owns the lib types, and structural
 * agreement is checked where the document crosses it — `patternService.importIR`
 * takes an `ImportIR`, so a track this module builds that does not fit stops the
 * COMPILE at the call site rather than at run time.
 *
 * ⚠ THAT CHECK IS ONLY WORTH ANYTHING IF IT PASSES FOR A GOOD TRACK. An
 * `IRTrack` from {@link runIRTrack} is assignable to the lib's as it stands —
 * `tracks: [track]` with no cast — and every narrowing below exists for that:
 * `instrumentHint` is the instrument-id union rather than `string` (the lib's
 * `InstrumentHint` contains all three), `dynamic` is `DYNAMICS`' own union rather
 * than `string`, and `events`/`notes` are MUTABLE arrays because the lib's are
 * and a `readonly` array is not assignable to one. A shape that fails to compile
 * for every input teaches the next author to write `as ImportIR`, which throws
 * the real check away.
 *
 * ── EMIT ONLY WHAT SURVIVES ─────────────────────────────────────────────────
 *
 * `dynamic` is offered because it demonstrably reaches playback: the mapper
 * back-fills `velocity` through `DYNAMIC_VELOCITY`, pinned in
 * `tests/ImportIR.test.ts`. Nothing else on `IRNote`/`IREvent` is offered — a
 * field the model spends tokens on that reaches nothing is worse than no field —
 * and `keySignatures`/`chords` on the document are discarded by the validator
 * entirely, so no part of this run is asked to produce them.
 *
 * ⚠ ONE OPEN DISAGREEMENT, DELIBERATELY RESOLVED THE NARROW WAY. This card's
 * brief says bends, slides and harmonics do NOT survive ("the mapper's phase-1
 * maps every note as plain"), while `tests/ImportIR.test.ts` — 'carries
 * articulations through to the pattern model, mapper header notwithstanding' —
 * pins that in THIS build they do reach `PatternEvent`. The narrow reading wins
 * here because the cost of each is asymmetric: an unoffered field that would have
 * worked is expressiveness left on the table, and an offered field that quietly
 * reaches nothing is tokens spent on silence plus a brief that lies. Widening is
 * a listening test's call, and the pinned test is the evidence for it.
 *
 * ── ⚠ THE RANGE CHECK IS THE POINT OF THIS FILE ─────────────────────────────
 *
 * The import pipeline does not complain, and this is proven by fixture and by
 * reading `@fretwork/lib/dist/import/{validator,mapper}.js` rather than off a doc
 * comment. ⚠ THE MECHANISMS ARE NOT THE ONES THE PIPELINE'S DOCS IMPLY, and the
 * refusals below name what actually happens:
 *
 *   - an out-of-range `string` is SILENT either way, and which way depends on a
 *     field this module does not author. `validateNote` clamps against
 *     `t.tuning?.length ?? 6` — not against the instrument — so on a bass with no
 *     `tuning` (which is what the assembly job sends) string 5 is not moved at
 *     all: it is stored as `stringIndex` 5 on a four-string pattern, drawn by
 *     nothing and played by nothing. On a guitar, string 7 IS moved, to 5. Only
 *     the per-track and per-document CAPS ever warn.
 *   - an out-of-range `fret` is clamped at 36, not at a neck: 99 becomes 36 in
 *     silence, and 25 to 36 are not touched at all — stored, undrawable, and
 *     dropped from playback by `flattenTrack` (docs/FOLLOW-UPS.md row 12). So the
 *     bound here is the shorter of `MAX_FRET` and THIS instrument's neck.
 *   - a non-integer `atTick` or `durationTicks` DROPS the event, silently. That is
 *     the single likeliest mistake for a model emitting JSON.
 *   - an event whose notes are ALL dropped survives with an empty note list, so a
 *     pattern with no notes in it can commit as a success.
 *
 * So {@link reviewTrack} refuses before the seam ever sees the document, and it
 * names the event it is talking about. Nothing downstream will say any of this.
 *
 * ── ⚠ A CHORD IS ASKED FOR, NOT TRANSCRIBED ─────────────────────────────────
 *
 * The 2026-08-16 run is the evidence and it is unambiguous. The brief was right,
 * the C7 grip was handed over in full — strings 1,2,3,4,5 at frets 3,5,3,5,3 —
 * and across the 24 events of that section the guitar emitted the shape correctly
 * 8 times, every string shifted down by one 8 times, and a third wrong variant 8
 * times. The bass, which composes one note at a time instead of copying five, was
 * right throughout. The model cannot reliably copy five numbers, and no amount of
 * warning it harder changes that: it is the same lesson the orchestrator deleted
 * at b8582bb died of, at a smaller scale.
 *
 * So an event has TWO shapes now. `notes` is unchanged and is what a composed
 * line uses — a bass walking, a melody, a fill — because that path demonstrably
 * works. {@link STRUM_SPANS}' `strum` is the other: it says WHEN, HOW LONG and
 * WHICH PART OF THE SHAPE, and {@link expandStrums} fills the cells in from the
 * grip this module already looked up. The model never types a string or a fret
 * for it, and it never names the chord either — which chord is in force is
 * derived from `atTick` against the progression the brief already carries, since
 * naming it is one more thing to get wrong.
 *
 * `strum` is not a boolean, and that is deliberate: "play the chord" that always
 * hit every string would make every comping part in the app identical, which is
 * the failure the brief's own musical paragraphs exist to prevent. The spans are
 * the bottom or top 2 or 3 strings of the shape, or all of it — the choice a
 * comper actually makes bar to bar.
 *
 * ⚠ EXPANSION HAPPENS BEFORE THE REVIEW, so an expanded event is subject to every
 * check above with no second path around them: a strum that collides with a line
 * already ringing on one of those strings is refused by the same overlap walk
 * that catches two typed notes. And the expansion is 1:1 — one answer event in,
 * one event out, at the same index — so {@link eventLabel} still names the entry
 * where the model wrote it.
 *
 * ⚠ WHICH IS WHY THE BRIEF SAYS HOW LONG A STRUM OCCUPIES ITS STRINGS. The whole
 * point of the span is that the model never learns which strings it just played,
 * so it cannot work out that a chord left ringing for a bar collides with the
 * next stab inside that bar — and the overlap walk would refuse the pair, with no
 * retry, for a figure a guitarist plays every day. A rule the answer is judged by
 * and cannot see has to be stated in the sentence that offers the feature.
 *
 * ── ⚠ AND A TYPED CHORD IS CHECKED AGAINST THAT SHAPE ───────────────────────
 *
 * Not every note in a part is a chord tone — a walking bass is mostly passing
 * notes and must not be refused — but several notes AT ONE INSTANT are a chord,
 * and a chord whose notes are not that chord's is a mistake and not a choice.
 *
 * THE THRESHOLD IS THREE NOTES IN ONE EVENT. Two is a double-stop: a tenth, a
 * sixth, a root-and-fifth are ordinary line writing and carry no harmony of their
 * own. Three is the smallest stack that claims to BE a chord. Notes in SEPARATE
 * events are never gathered, even at one tick — an event is the unit the model
 * wrote and the unit a refusal can name, and a held note under a melody that
 * starts on the same tick is two lines rather than one chord. That leaves a
 * mis-copy split across two entries unjudged, which is the price of not refusing
 * an arpeggio, a let-ring figure or a line against a pedal.
 *
 * THE TOLERANCE IS ONE NOTE. A comper adds a tone the preferred voicing left out;
 * two notes off the shape at one instant is the shape mis-copied, which is
 * exactly what the run above did (four of five, and three of five). The bias is
 * deliberate: passing an odd voicing costs a listening note, refusing a real one
 * costs a run and, if the second attempt goes the same way, the part. (A refused
 * part is asked again ONCE — `irCompositionJob`'s retry — which softens that cost
 * but does not remove it, and is no reason to tighten a bound that was set
 * against real music.)
 *
 * AND ONLY A NEAR MISS IS COUNTED AS OFF THE SHAPE — {@link SLIP_FRETS}. What
 * `chordGrip` hands back is ONE voicing, the preferred one, so "not this fret" is
 * not the same claim as "not this chord": a C7 taken as an E-shape barre five
 * frets higher is the right chord in a different place, and refusing it would
 * refuse real music for the sake of a position nobody promised. A mis-copy does
 * not look like that. Both of the 2026-08-16 wrong variants sit a whole tone off
 * the shape on every string they moved — the same frets, read off the wrong line
 * — so a bound of three frets catches both while a deliberate move up the neck
 * passes. Notes further off than that are otherwise not judged at all, and that is
 * the same limit as the paragraph below: without a tuning, this side of the seam
 * cannot tell a distant voicing of the chord from a distant mistake.
 *
 * WITH ONE EXCEPTION, and it is the only wrong chord that can be NAMED as one: a
 * stack that is, cell for cell, ANOTHER chord of this progression on this neck.
 * That is not a voicing chosen elsewhere on the neck, it is the wrong line copied
 * off the brief's own sheet — the mis-copy the slip bound is blind to, and the one
 * this module holds both halves of the evidence for, since it looked every chord
 * of the progression up to write the brief.
 *
 * ⚠ IT IS LOOKED FOR FIRST, AND THAT ORDER IS EVIDENCE-DRIVEN. It used to be
 * computed only where the slip bound had NOT already fired, which suppressed the
 * most useful diagnosis in this file exactly where it was most needed: the
 * 2026-08-16 'Guitar 2' typed F7's six-string barre at bar 1 over C7, two of whose
 * notes land within {@link SLIP_FRETS} of C7's own shape — so the slip branch
 * claimed it and said "two notes are a fret or two off" about a stack that was a
 * different chord entirely. A model told it played F7 where C7 belongs fixes that
 * in one go. One mistake still costs ONE sentence out of the capped batch: the two
 * branches are exclusive, stale first.
 *
 * ⚠ WHAT "OFF THE SHAPE" CAN AND CANNOT MEAN, and this is a limit rather than a
 * choice. `chordGrip` hands back cells and the chord's TONE NAMES, and the lib's
 * `Grip` (read at `dist/lib/chord-voicing.d.ts`) carries no note per cell — so
 * nothing on this side of the seam can say which tone a given cell is, and the
 * tuning that would answer it is withheld from the seam on purpose (`chordGrip`'s
 * own header). A note's PITCH is therefore unknowable here. What is knowable is
 * the shape: on a string the shape uses, a fret that is neither the shape's nor
 * an octave of it on that same string is a note the model changed. On a string
 * the shape does not use, nothing here can tell a chord tone from a wrong one, so
 * it is never counted against the answer. The 2026-08-16 voicing is caught by the
 * four strings it moved, not by the one it added.
 *
 * ── THE BRIEF IS `patternSubRun`'s, LIFTED ──────────────────────────────────
 *
 * `patternSubRun.patternRunInput` is the only prose in this area the user has
 * verified by hand, and its musical content is exactly right: what the part is
 * for, the grip as MATERIAL rather than as a chord, and the paragraph forbidding
 * the shape dumped whole on the downbeat. Those paragraphs are lifted rather than
 * reworded, and `tests/IrTrackRun.test.ts` pins them against `patternRunInput`
 * character for character so a reword in either file fails there.
 *
 * What changes is what this run is FOR, and only that: it covers a progression
 * instead of one chord, and it answers with JSON instead of calling stamp tools.
 * Two lifted paragraphs carry a one-clause edit each for exactly those two
 * reasons, and the test excuses those two clauses by name and no others.
 *
 * ── A SECOND ATTEMPT IS AN ADDENDUM, NOT A DIFFERENT BRIEF ──────────────────
 *
 * {@link runIRTrack} runs ONCE. When the caller asks again — `irCompositionJob`
 * does, once, and only for a `'review'` stop — it passes `previousRefusal` and
 * {@link addendum} puts that sentence in its own marked section at the END. Every
 * word above it is byte for byte what the first attempt read, so the baseline the
 * musicality ticket will tune against is not quietly two briefs, and the model is
 * told to write the whole part again rather than to patch the one it lost.
 */
import { ticksPerBar } from '../composition/compositionService';
import {
  DYNAMICS,
  MAX_FRET,
  PPQ,
  chordGrip,
  instrumentFretCount,
  instrumentOpenStrings,
  instrumentStringCount,
  listInstruments,
  unknownInstrumentRefusal,
} from '../patterns/patternService';
import { runAgentTask } from './agentService';
import { arr, int, namedRefusals, obj, str, type JsonSchema } from './tools/types';
import type { AgentRunSummary, AgentSpec, RunAgentTaskOptions } from './agentService';
import type { Result } from '../patterns/patternService';

// ----------------------------------------------------------------- shape ---

/**
 * The instruments this app has a neck for, named through the seam's own return
 * type rather than by importing `FretInstrumentId` — the lib type is not
 * re-exported and `src/ai/**` may not reach past the seam for it. It is the same
 * union, and it is a SUBSET of the lib's `InstrumentHint`, which is why
 * {@link IRTrack} can carry it straight into a document.
 */
type InstrumentId = ReturnType<typeof listInstruments>[number]['id'];

/** `DYNAMICS`' own union — the lib's `DynamicMark`, and character for character
 *  the lib import type's `Dynamic`. Derived from the seam's exported VALUE for
 *  the reason above: the type name is not re-exported. */
type DynamicMark = (typeof DYNAMICS)[number];

/**
 * One note of one attack — the lib's `IRNote` reduced to the two fields that
 * survive the mapper as anything but a plain note.
 *
 * ⚠ THE STRING AXIS IS SPELLED `string` HERE and `stringIndex` everywhere else in
 * this app — `chordGrip`'s cells, `PatternEvent`, `pattern_stamp_notes`. Same
 * number, same convention (0 is the physically BOTTOM string, the low E on a
 * guitar — not the lowest-PITCHED one, which a reentrant ukulele's is not),
 * different key. The translation happens in {@link gripLines}, once, so
 * the brief hands the model frets already spelled the way it has to write them
 * back; a model asked to rename a field mid-answer is a model that will sometimes
 * not.
 */
export interface IRNote {
  readonly string: number;
  readonly fret: number;
}

/** One attack: when it starts, how long it rings, and what sounds on it.
 *
 *  ⚠ `notes` IS A MUTABLE ARRAY, deliberately — see the header. The lib's
 *  `IREvent.notes` is `IRNote[]`, and a `readonly IRNote[]` is not assignable to
 *  it, so a `readonly` here would fail the seam's compile check for every track
 *  including the good ones. */
export interface IREvent {
  readonly atTick: number;
  readonly durationTicks: number;
  /** One note is a single line; several at one tick is a chord. */
  readonly notes: IRNote[];
  /** How hard it is played. The one expressive field that reaches playback. */
  readonly dynamic?: DynamicMark;
}

/**
 * Which strings of the chord's shape one strum hits, bottom of the neck first.
 *
 * ⚠ "BOTTOM" IS THE STRING AXIS AND NOT THE PITCH AXIS — `string` 0 upwards, the
 * same convention as everywhere else in this app, which on a reentrant ukulele
 * (G4 C4 E4 A4) is not the lowest note. Saying "lowest" here would be false on an
 * instrument this module explicitly supports.
 *
 * Five values and not a boolean: see the header. A part that can only strum the
 * whole shape is a part that sounds the same on every attack.
 */
export const STRUM_SPANS = ['all', 'bottom-2', 'bottom-3', 'top-2', 'top-3'] as const;

export type StrumSpan = (typeof STRUM_SPANS)[number];

/**
 * One entry as the MODEL may write it: an attack that either carries the notes it
 * composed or asks for the chord already in force at its tick.
 *
 * Both fields are optional because JSON Schema as this app spells it has no
 * `oneOf` (`src/ai/tools/types.ts`'s `JsonSchema`, and that file is another
 * card's), so "exactly one of them" is prose in the brief and a refusal here
 * rather than a grammar. An entry with BOTH is refused by {@link expandStrums};
 * an entry with NEITHER expands to no notes and is refused by
 * {@link reviewTrack}'s existing sentence about an event with nothing in it.
 *
 * {@link IREvent} is what survives expansion, and it is the only shape the
 * document ever sees.
 */
export interface IRAnswerEvent {
  readonly atTick: number;
  readonly durationTicks: number;
  /** The notes it composed. Absent when it asked for the chord instead. */
  readonly notes?: IRNote[];
  /** Play the chord in force at `atTick`, this much of its shape. */
  readonly strum?: StrumSpan;
  readonly dynamic?: DynamicMark;
}

/**
 * One track of an `ImportIR` document.
 *
 * Structural, not imported — see the header, including why `events` is mutable
 * and why `instrumentHint` is the app's own id union rather than `string`: the
 * lib's `InstrumentHint` contains all three of them, so this is assignable to the
 * lib's `IRTrack` as written and the assembly job needs no cast.
 */
export interface IRTrack {
  readonly id: string;
  readonly name: string;
  readonly instrumentHint: InstrumentId;
  readonly events: IREvent[];
}

// ------------------------------------------------------------------ time ---

/**
 * The meter every tick in this file is counted in.
 *
 * ⚠ AN ASSUMPTION, AND THE ONLY ONE IN THIS MODULE. `ArrangementChart` declares
 * `bars` and `bpm` and no time signature, so a bar's length has to come from
 * somewhere; 4/4 is what the chart's own prompt means by "twelve bars" and what
 * the app opens a blank composition in. It is EXPORTED rather than inlined so the
 * job that assembles the document writes the same pair into
 * `ImportIR.timeSignatures` — a brief that told the model a bar was 1920 ticks
 * while the document said 3/4 would put every chord change on the wrong beat with
 * nothing refused anywhere.
 */
export const IR_TIME_SIGNATURE = { numerator: 4, denominator: 4 } as const;

/** Ticks in one bar of {@link IR_TIME_SIGNATURE}.
 *
 *  ⚠ ASKED OF THE SEAM, NOT REWRITTEN. `numerator * PPQ` is right only while the
 *  denominator is 4, and {@link IR_TIME_SIGNATURE} is an editable pair the
 *  assembly job copies into the document — so the rule
 *  (`numerator * PPQ * 4 / denominator`) is the lib's, through
 *  `compositionService`, which is a pure function of the signature and reads no
 *  open document. */
export const TICKS_PER_BAR = ticksPerBar(IR_TIME_SIGNATURE);

// ----------------------------------------------------------------- input ---

/** A chord and the bar it ARRIVES on, counted from 1. It holds until the next
 *  entry — how long it lasts is the distance to the next arrival, and that is
 *  arithmetic this module does so that neither the caller nor the model has to. */
export interface BriefChord {
  readonly bar: number;
  readonly symbol: string;
}

/**
 * Everything one writing run is told, and the whole of this module's input.
 *
 * ⚠ DELIBERATELY LOCAL, for `PatternBrief`'s reason: whatever calls this next
 * declares these facts, it does not get to make this module import its schema.
 * It is nonetheless STRUCTURALLY what a chart hands over — `name`, `instrumentId`
 * and `role` are a `ChartTrack`, `bars` and `chords` are the chart's own — so the
 * sequencing job spreads one into the other without a mapping layer, and neither
 * module has to be rebuilt when the other moves.
 */
export interface TrackBrief {
  /** Unique within the document. The CALLER's — ids are the thing a model must
   *  never be asked to keep unique, and the document has more than one track. */
  readonly id: string;
  /** What this part is called — "Bass", "Rhythm Guitar". */
  readonly name: string;
  readonly instrumentId: string;
  /** What this part DOES, in the chart's words — "walking bass, quarter notes".
   *  It is the ROLE, and the brief hands it to the model as one. */
  readonly role: string;
  /** How long the form is, in bars: a whole number, at least 1. */
  readonly bars: number;
  /** The progression, ascending, with an entry at bar 1. */
  readonly chords: readonly BriefChord[];
}

const isBarCount = (value: number): boolean => Number.isInteger(value) && value >= 1;

const barsPhrase = (count: number): string => `${count} bar${count === 1 ? '' : 's'}`;

/** Where bar N starts, counted FROM 1 — the off-by-one, done once.
 *
 *  ⚠ `barMath.barConverter` is the same off-by-one and takes its signature as an
 *  argument, so it would answer this. It is not used because it answers NULL
 *  where a bar is not a whole number of ticks — a real case for a composition's
 *  4/7 and an impossible one for {@link IR_TIME_SIGNATURE}, which is a literal —
 *  and a nullable converter at module scope costs more than this line does. The
 *  arithmetic that could actually go wrong, ticks per bar, is the seam's above. */
const barStartTick = (bar: number): number => (bar - 1) * TICKS_PER_BAR;

/** Which bar a tick falls in, counted FROM 1 — {@link barStartTick} the other way
 *  round. Only ever asked of a tick that is a whole number at or above 0, which
 *  {@link reviewTrack} has refused and skipped before it gets here. */
const barOf = (tick: number): number => Math.floor(tick / TICKS_PER_BAR) + 1;

/** The bars a chord arrives at, as a person would say them — "bar 5", "bars 5
 *  and 10". A chord that arrives twice is ordinary (a blues turnaround), so
 *  naming only the first would send the model to the wrong bar half the time. */
const barList = (bars: readonly number[]): string => {
  if (bars.length === 0) return 'no bar of this form';
  if (bars.length === 1) return `bar ${bars[0]}`;
  return `bars ${bars.slice(0, -1).join(', ')} and ${bars[bars.length - 1]}`;
};

// ---------------------------------------------------------------- schema ---

/**
 * The events, as JSON Schema — handed to the backend as a grammar.
 *
 * ⚠ PER INSTRUMENT, because BOTH neck bounds are: a bass has four strings and 21
 * frets, a guitar six and 22, a ukulele four and 15. A schema that took the
 * widest of each would let the grammar produce a note the neck has not got, which
 * nothing downstream refuses — see the header for what silently happens to it
 * instead.
 *
 * ⚠ MEMOIZED, and that is not an optimisation. `runAgentTask` hands the schema to
 * the harness by reference precisely because `ajv`'s cache is keyed on the schema
 * OBJECT and never evicted, so a fresh object per run leaves a permanent cache
 * entry per run — and this one runs once per track, repeatedly, for as long as the
 * tab is open. The map is bounded by the instrument catalog, which has three
 * entries.
 *
 * ⚠ THE SCHEMA IS NOT THE VALIDATION. It can say a tick is an integer; it cannot
 * say the event ends inside the form, that two events do not fight over one
 * string, or that the answer has any events at all. Those are {@link reviewTrack}'s
 * — and a grammar is the PROVIDER's to honour, which this app cannot assume of an
 * arbitrary OpenAI-compatible backend.
 */
const SCHEMA_BY_INSTRUMENT = new Map<string, JsonSchema>();

/**
 * The top fret this part may use: the shorter of the app's ceiling and THIS
 * instrument's neck.
 *
 * ⚠ DELIBERATELY STRICTER THAN `patternService`'s `checkFret`, which stops at
 * `MAX_FRET` and tolerates a note above the neck on purpose so that changing a
 * pattern's instrument stays lossless. There is nothing to preserve here: this
 * run is writing the notes from nothing, and a note above the neck is one the
 * fretboard cannot draw and `flattenTrack` drops from playback (the defect
 * docs/FOLLOW-UPS.md row 12 already tracks — cited, not masked, so this is no new
 * LIB-GAP site). Writing one on purpose is writing silence.
 *
 * 0 for an instrument the catalog does not know — {@link irTrackSchema}'s comment
 * on why that schema is unreachable.
 */
const neckFrets = (instrumentId: string): number =>
  Math.min(instrumentFretCount(instrumentId), MAX_FRET);

/**
 * WHAT EACH STRING OF THIS NECK SOUNDS, and which end of the list `string` 0 is
 * — the two sentences the schema and the brief both need, authored ONCE so the
 * grammar's field description and the prose cannot tell the model different
 * things about the same neck in the same request.
 *
 * ⚠ THIS IS THE 2026-08-16 BASS DEFECT'S REPAIR. That run put all 48 notes of a
 * bass part on `string` 3 — the G, the highest string of the four. It had been
 * told only that 0 is the bottom string and that the neck has four, which is a
 * fact about OUR numbering; the player's numbering runs the other way, where the
 * lowest string carries the highest number. Every one of those notes was in
 * range, so nothing downstream caught it and nothing could have: the import
 * pipeline clamps an out-of-range string and drops a fractional tick, and a part
 * played entirely on the wrong string is neither. Naming the PITCHES is what
 * makes the axis checkable by the model instead of memorable, which is the same
 * move `strum` made for chord shapes.
 *
 * ⚠ AND IT NEVER CLAIMS 0 IS THE LOWEST PITCH. On a reentrant ukulele
 * (G4 C4 E4 A4) that is false — the high-G drone sits at the bottom of the neck
 * — so the anchor sentence is chosen off `ascending` rather than assumed, and
 * the reentrant neck is told which index really is the lowest. The old text said
 * "0 is the low E on a guitar" to every instrument, which was a guitar's fact
 * shipped to a bass and a falsehood shipped to a ukulele.
 *
 * Empty for an instrument the catalog does not know — the same unreachable case
 * {@link irTrackSchema} explains, and both callers join on nothing.
 *
 * `namePitches` repeats the pitch beside the index in the REENTRANT anchor, and
 * only there. The brief takes it: that anchor is the one sentence contradicting
 * what the model already believes about string order, and the pitch is what
 * makes it checkable against the list rather than another numbering rule to
 * take on trust. The schema's copy is a field description read beside the field
 * and stays terse. The ascending anchor is one sentence either way — there is no
 * index to disambiguate when 0 is the answer.
 */
function openStringSentences(
  instrumentId: string,
  { namePitches = false }: { readonly namePitches?: boolean } = {},
): readonly string[] {
  const { names, lowestIndex, highestIndex, ascending } = instrumentOpenStrings(instrumentId);
  if (names.length === 0) return [];

  const list = names.map((note, index) => `string ${index} sounds ${note}`).join(', ');
  if (ascending) {
    return [
      `Played open, ${list}.`,
      'String 0 is the lowest-sounding string on this instrument, and each one after it sounds higher.',
    ];
  }
  const at = (index: number): string =>
    namePitches ? `string ${index} (${names[index]})` : `string ${index}`;
  return [
    `Played open, ${list}.`,
    `They do not run low to high on this instrument: ${at(lowestIndex)} is the lowest-sounding, and ${at(highestIndex)} the highest.`,
  ];
}

export function irTrackSchema(instrumentId: string): JsonSchema {
  const cached = SCHEMA_BY_INSTRUMENT.get(instrumentId);
  if (cached !== undefined) return cached;

  // 0 for an instrument the catalog has never heard of. `trackRunInput` refuses
  // that case before a run happens (through `chordGrip`), so what this produces
  // is a schema no caller reaches; `max: -1` is honest about it rather than
  // silently widening to a guitar's six.
  const strings = instrumentStringCount(instrumentId);
  const frets = neckFrets(instrumentId);
  const schema = obj(
    {
      events: arr(
        obj(
          {
            atTick: int(
              `When this attack starts, in ticks from the beginning of the piece. A WHOLE number — ${PPQ} ticks is a quarter note.`,
              { min: 0 },
            ),
            durationTicks: int(
              'How long it rings, in ticks. A WHOLE number, at least 1. Its start plus this must not run past the end of the form.',
              { min: 1 },
            ),
            notes: arr(
              obj(
                {
                  string: int(
                    // ⚠ THIS DESCRIPTION IS PROMPT. These runs are tool-free so
                    // that the harness sends the schema for grammar-enforced
                    // decoding, descriptions and all — so the neck named here
                    // reaches the model in the same request as the brief's prose
                    // and must not contradict it.
                    [
                      `Which string. 0 is the BOTTOM string of the neck — this instrument has ${strings}, so 0 to ${strings - 1}.`,
                      ...openStringSentences(instrumentId),
                    ].join(' '),
                    { min: 0, max: strings - 1 },
                  ),
                  fret: int(
                    `Which fret. 0 is the open string, and this instrument's neck ends at ${frets}.`,
                    { min: 0, max: frets },
                  ),
                },
                ['string', 'fret'],
              ),
              'The notes YOU compose at this instant — a line, a melody, a fill. A string can only ring one note at a time, so no two of them are on the same string. Leave it out and write `strum` instead to play a chord: never copy a shape out by hand.',
            ),
            strum: str(
              `Play the chord already in force at this tick, filled in for you from its shape on this neck — write this INSTEAD of \`notes\` and you never copy a string, a fret or the chord's name. Which strings of the shape it hits: "all" every string the shape uses, "bottom-2"/"bottom-3" the 2 or 3 lowest-numbered strings of it, "top-2"/"top-3" the 2 or 3 highest-numbered.`,
              STRUM_SPANS,
            ),
            dynamic: str(`How hard it is played. Softest to loudest: ${DYNAMICS.join(', ')}.`, DYNAMICS),
          },
          // ⚠ `notes` IS NO LONGER REQUIRED, and it is not a loosening for its own
          // sake: an entry carries `notes` or `strum`, and this dialect of JSON
          // Schema has no `oneOf` to say so. What the grammar can no longer refuse
          // — an entry with neither — {@link reviewTrack} refuses by name, in a
          // sentence the model can act on, which a grammar error is not.
          //
          // `dynamic` is optional for its own reason: a part with none is playable
          // and one dynamic per event, all the same, is worse than none at all.
          ['atTick', 'durationTicks'],
        ),
        'The part, one entry per attack, in time order.',
      ),
    },
    ['events'],
  );

  // Only a REAL neck is cached. `irTrackSchema` is exported, so an id the catalog
  // does not know would otherwise grow this map for the life of the tab — and the
  // memo's whole justification is that it is bounded by a catalog with three
  // entries in it.
  if (strings > 0) SCHEMA_BY_INSTRUMENT.set(instrumentId, schema);
  return schema;
}

// ---------------------------------------------------------------- prompt ---

/**
 * The system prompt.
 *
 * ⚠ IT IS NOT `agentRules`' AND NOT `PATTERN_AGENT`'s, for the reason the chart
 * run states at its own address: `SHARED_RULES` opens on METHOD — "You act only
 * by calling tools. Anything you describe without calling a tool did not happen."
 * — which is precisely false of a run with no tools and is the first thing the
 * model would read. `NECK` sends every run to `read_chord_voicings`, which this
 * run has not got; `LENGTH` is about patterns and placements this run never
 * names. There is no third handle to import a section through and splitting that
 * file is outside this card's fence.
 *
 * What is left is short on purpose: this run's whole instruction set is the
 * per-run brief, because every fact it needs is a fact about THIS part.
 */
const IR_TRACK_PROMPT = `You are a musician writing one part of a piece, as notes on a fretted instrument.

You have no tools. There is nothing to call and nothing to look up: everything you need is in the brief — the progression, where each chord lands in ticks, and how each one sits on your instrument's neck.

ANSWER WITH ONE JSON OBJECT AND NOTHING ELSE. No sentence before it, no code fence around it, no commentary after it. The answer is parsed whole — anything but the bare object is thrown away, and a good part wrapped in a fence is no part at all.`;

/**
 * The spec. ⚠ THE EMPTY TOOL LIST IS THE FEATURE — see the header. A tool added
 * here silently downgrades {@link irTrackSchema} from a grammar the provider
 * decodes against to a hope about what the model happened to write.
 */
export const IR_TRACK_AGENT: AgentSpec = {
  name: 'ir-track',
  systemPrompt: IR_TRACK_PROMPT,
  tools: [],
};

// ----------------------------------------------------------------- brief ---

/** The catalog's entry for an id, or undefined for a neck this app has not got.
 *
 *  Two callers, and they want different halves of it: the prose below wants the
 *  NAME, and {@link runIRTrack} wants the id back as {@link InstrumentId} — a
 *  `string` cannot be a document's `instrumentHint`, and this find is where the
 *  narrowing is earned rather than asserted. */
const knownInstrument = (instrumentId: string): { id: InstrumentId; name: string } | undefined =>
  listInstruments().find((instrument) => instrument.id === instrumentId);

/** The instrument as the catalog names it, for prose.
 *
 *  ⚠ THE FOURTH PLACE this mapping is derived from `listInstruments`, after
 *  `instrumentCatalog.ts`'s `INSTRUMENT_LIST` and `patternSubRun`'s own copy,
 *  which carries the same note. It belongs beside `INSTRUMENT_IDS` as an
 *  `instrumentName(id)`; it is here because this card's fence forbids editing
 *  anything under `src/ai/tools/`. Whoever lifts that fence should move all
 *  three. */
const instrumentName = (instrumentId: string): string =>
  knownInstrument(instrumentId)?.name ?? instrumentId;

/** The shape, one cell a line, in the IR's OWN spelling of the two axes — so
 *  nothing in it has to be renamed before it can be written back. See
 *  {@link IRNote} on why that rename is worth removing.
 *
 *  ⚠ SORTED, for {@link shapeFinder}'s reason and so that one ordering rule
 *  governs both ends: the brief tells the model that "lowest-numbered" is nearest
 *  `string` 0, and {@link STRUM_SUBSET} slices an ascending copy. Both voicing
 *  paths in the lib happen to return ascending cells today, so this changes
 *  nothing now — it stops the printed shape and the strum that fills it in from
 *  disagreeing the day one of them stops. */
const gripLines = (cells: readonly GripCell[]): string =>
  [...cells]
    .sort((a, b) => a.stringIndex - b.stringIndex)
    .map((cell) => `    string ${cell.stringIndex}, fret ${cell.fret}`)
    .join('\n');

/**
 * One chord of the progression, with the arithmetic already done: which bars it
 * covers, which TICKS those bars are, and where it sits on this neck.
 *
 * ⚠ THE TICKS ARE THE WHOLE POINT. Every failure of the deleted orchestrator was
 * the model doing arithmetic to satisfy our shape — a 2-bar pattern at bars
 * [1,2,5,6] read as four starts instead of two, a turnaround that needed two bars
 * in the one that was left. The distance between bar 5 and tick 7680 is one
 * multiplication and the model gets it right most of the time, and "most" over
 * six chords and three parts is a piece with a bar in the wrong place.
 */
function chordSection(
  chord: BriefChord,
  untilBar: number,
  instrument: string,
  cells: readonly { stringIndex: number; fret: number }[],
  notes: readonly string[],
): string {
  const startTick = barStartTick(chord.bar);
  const endTick = barStartTick(untilBar);
  const span =
    untilBar - chord.bar === 1
      ? `bar ${chord.bar}`
      : `bars ${chord.bar} to ${untilBar - 1}`;
  return `${chord.symbol} — ${span}, ticks ${startTick} up to ${endTick}. On ${instrument} it sits here, and its tones are ${notes.join(', ')}:

${gripLines(cells)}`;
}

/**
 * WHAT THE LAST ATTEMPT GOT WRONG, as a paragraph on the end of the brief.
 *
 * ⚠ AN ADDENDUM, AND DELIBERATELY NOT A REWRITE. The prose above it is
 * `patternRunInput`'s, lifted, and is the baseline a deferred musicality ticket
 * will tune against — so feedback goes at the END, marked as feedback, and the
 * part of the brief that works is byte for byte the same on the second attempt as
 * on the first. It is also why the model is told to write the WHOLE part again:
 * the brief it is reading is the same brief, not a patch instruction.
 *
 * The sentence it carries is `runIRTrack`'s own refusal, unedited. That refusal
 * is already written to be acted on — it names the event, prints its notes, prints
 * the shape that belongs there and says to write `strum` instead — so a second
 * account of it here would be the thing this codebase keeps paying for.
 *
 * Empty for the first attempt, and for a refusal that is blank once trimmed: a
 * heading with nothing under it reads as an instruction the model cannot follow.
 *
 * ⚠ IT RESTATES THE BARE-OBJECT RULE, and that clause is not spare prose. This
 * paragraph goes AFTER `# Answer`, so on a second attempt the last thing the
 * model reads is feedback rather than "the object alone" — and an answer that
 * came back as prose is an `'answer'` stop, which is deliberately NOT retried.
 * A retry that regressed into a sentence would lose the part outright.
 */
function addendum(previousRefusal?: string): string {
  const said = previousRefusal?.trim() ?? '';
  if (said === '') return '';
  return `

# Your last answer was refused — this is the second and final attempt

You already wrote this part once and it was sent back. Nothing above has changed and nothing else is wrong with the brief; this is what was wrong with the answer:

${said}

Write the whole part again from the top — every event, not only the ones named above — with that fixed. If the reason names notes you typed out by hand where a chord belongs, that attack wants \`"strum"\` on it instead: you do not name the chord and you do not copy a fret, and it is the one way not to get the harmony wrong twice in a row.

Answer with the object alone, as above: no fence, no preamble, nothing after it.`;
}

/**
 * THE BRIEF — the artefact this module is really about. Everything else in it is
 * plumbing around this string.
 *
 * ⚠ THE MUSICAL PARAGRAPHS ARE `patternRunInput`'s, LIFTED. They are the baseline
 * a deferred musicality ticket will tune against, and `tests/IrTrackRun.test.ts`
 * compares them against that function's output character for character. Word one
 * of them differently and you have moved the baseline and failed that test; do
 * both on purpose or neither.
 *
 * Two carry a one-clause edit, and the test excuses those two clauses BY NAME:
 *   - the MATERIAL paragraph loses "and with what articulation", because this run
 *     has no articulation to give — see the header on what survives the mapper.
 *   - the prohibition says "write" where the original says "stamp", because there
 *     is no stamp tool in this run and a verb naming one is a verb the model will
 *     go looking for.
 *
 * ⚠ THE PROHIBITION IS THE LOAD-BEARING PARAGRAPH, at whatever address it is
 * read. "Do not write the shape once at the top of the bar and stop" is the exact
 * thing the 2026-08-14 rhythm guitar did with a correct grip in hand, and it is
 * invisible to every check this app has, {@link reviewTrack} very much included:
 * the frets are right, the harmony is right, the length is right, the spacing is
 * right. No reply we can design catches it, so it is forbidden in advance.
 *
 * `previousRefusal` is what a SECOND attempt at this part carries: the sentence
 * the first attempt was refused with, appended as its own marked section by
 * {@link addendum} and changing nothing above it. Absent on a first attempt.
 *
 * PURE — a {@link TrackBrief} in, a brief out. `chordGrip` is a lookup over the
 * lib's chord and tuning catalogs and takes nothing from the open document, so the
 * same input gives the same brief with no clock, no randomness and no app state
 * in the answer.
 *
 * REFUSES rather than papering over, in the register the seams refuse in: an
 * unreadable symbol, a neck this app has not got, a blank id, a form that is not
 * a whole number of bars, and a progression that does not fit inside it or does
 * not start at bar 1 are all things the caller can be sent back to fix, and a
 * brief built around "0 bars of Zz9" would spend a whole run finding that out.
 * The chart run refuses most of these earlier; this module is callable on its own
 * and does not assume it ran.
 */
export function trackRunInput(brief: TrackBrief, previousRefusal?: string): Result<string> {
  if (!isBarCount(brief.bars)) {
    return {
      ok: false,
      reason: `The form is ${brief.bars} bars long. A form is a whole number of bars, at least 1 — nothing shorter, and nothing in between.`,
    };
  }
  const name = brief.name.trim();
  if (name === '') {
    return {
      ok: false,
      reason: 'The part has no name, and the name is what says what the part is for.',
    };
  }
  // The id is the CALLER's and never the model's, which is exactly why it is
  // checked here: nothing downstream will. `validateImportIR` replaces a blank one
  // with `track-<n>`, so a document whose tracks all arrived blank silently
  // becomes a document of distinct tracks nobody can match back to a brief.
  if (brief.id.trim() === '') {
    return {
      ok: false,
      reason: `"${name}" has no id. The id is the caller's, not the model's, and it has to be unique across the document — the import pipeline replaces a blank one with a number of its own.`,
    };
  }
  const role = brief.role.trim();
  if (role === '') {
    return {
      ok: false,
      reason: `"${name}" has no role, and the role is the whole of what the run is asked to play. Say what the part DOES — "walking bass, quarter notes", "off-beat comping".`,
    };
  }
  if (brief.chords.length === 0) {
    return {
      ok: false,
      reason: `There is no progression for "${name}" to play over. Name at least one chord, at the bar it arrives on.`,
    };
  }
  // `some` rather than reading the first entry, so this stays true of a
  // progression whose entries are also out of order. Without it a brief starting
  // at bar 3 tells the model to play the whole form while naming no harmony for
  // bars 1 and 2 — a hole nothing else here can see, because every check below is
  // about an entry that IS there. `reviewChart` refuses the same thing in the same
  // sentence; this module is callable on its own and does not assume it ran.
  if (!brief.chords.some((chord) => chord.bar === 1)) {
    return {
      ok: false,
      reason: `The progression for "${name}" has no chord at bar 1. A chord holds until the next one, so bar 1 has to name the chord the piece starts on.`,
    };
  }

  // The progression is walked ONCE, in order, and the first thing wrong with it
  // ends the walk: a brief is either buildable or it is not, and a caller holding
  // a chart has already been given `reviewChart`'s itemised account of a bad one.
  let previous: BriefChord | null = null;
  const sections: string[] = [];
  const instrument = instrumentName(brief.instrumentId);
  for (const [index, chord] of brief.chords.entries()) {
    if (!Number.isInteger(chord.bar) || chord.bar < 1 || chord.bar > brief.bars) {
      return {
        ok: false,
        reason: `"${chord.symbol}" arrives at bar ${chord.bar}, which is outside a form of ${brief.bars} bars. Every chord arrives at a whole bar from 1 to ${brief.bars}.`,
      };
    }
    if (previous !== null && chord.bar <= previous.bar) {
      return {
        ok: false,
        reason: `"${chord.symbol}" arrives at bar ${chord.bar}, at or before "${previous.symbol}" at bar ${previous.bar}. A chord holds until the next one, so the chords are written in ascending bar order with one entry per change.`,
      };
    }
    // The seam's own refusal, verbatim, for both the unreadable symbol and the
    // unknown neck — `read_chord_voicings` passes the same sentences on, so a
    // caller cannot get two accounts of one mistake.
    const grip = chordGrip(chord.symbol, brief.instrumentId);
    if (!grip.ok) return { ok: false, reason: grip.reason };

    // A chord holds until the next one arrives, and the last one runs to the end
    // of the form. `bars + 1` is the bar AFTER the last, which is where the form
    // ends — the one place this file counts a bar that does not exist, and it is
    // only ever turned into a tick.
    const untilBar = brief.chords[index + 1]?.bar ?? brief.bars + 1;
    sections.push(
      // The symbol as the VOICER echoed it rather than as the caller wrote it —
      // insurance, not a live guarantee: `chordGrip` echoes what it was given
      // today, and if the lib ever starts normalising, the chord named in the
      // prose and the frets under it still cannot drift apart.
      chordSection(
        { bar: chord.bar, symbol: grip.value.symbol },
        untilBar,
        instrument,
        grip.value.cells,
        grip.value.notes,
      ),
    );
    previous = chord;
  }

  const bars = barsPhrase(brief.bars);
  const totalTicks = brief.bars * TICKS_PER_BAR;
  const strings = instrumentStringCount(brief.instrumentId);
  const frets = neckFrets(brief.instrumentId);

  return {
    ok: true,
    value: `# What to write

Write "${name}" — ${role} — on ${instrument}, over the whole ${bars} of this piece. That is the whole run: one part, one instrument, the progression below, and nothing else to decide.

Its name and that description are what the part is FOR, and the arrangement was planned around it. The other parts are being written to their own briefs, so play yours and leave theirs alone.

# The shape of the answer

One JSON object, exactly this shape and nothing else in it:

{"events":[{"atTick":0,"durationTicks":${PPQ},"notes":[{"string":0,"fret":3}],"dynamic":"mf"},{"atTick":${PPQ},"durationTicks":${PPQ},"strum":"top-3"}]}

One entry of \`events\` is one attack: \`atTick\` is when it starts and \`durationTicks\` is how long it rings. What sounds on it is written one of the two ways above, and never both in the same entry — \`notes\` is the notes YOU compose at that instant, and \`strum\` plays the chord already in force at that tick, filled in for you. \`dynamic\` is optional on either and says how hard it is played, from ${DYNAMICS[0]} to ${DYNAMICS[DYNAMICS.length - 1]}.

Write the events in time order, earliest first.

EVERY NUMBER IS A WHOLE NUMBER. A tick with a fraction in it is thrown away along with the note that was on it, and nothing tells you — \`"atTick": 480.5\` is a note nobody will ever hear.

# Where the notes go on this neck

\`string\` counts from the BOTTOM string of the neck. This ${instrument} has ${strings}, so \`string\` runs from 0 to ${strings - 1}. ${openStringSentences(brief.instrumentId, { namePitches: true }).join(' ')} Write the part where it belongs on THIS neck, not where the same shape would sit on a guitar. \`fret\` runs from 0, the open string, up to ${frets} — that is where this neck ends, and a fret past it is a note nothing will draw and nothing will play.

A string can only ring one note at a time. Two notes on the same string must not overlap: the second one starts at or after the first one's \`atTick\` plus its \`durationTicks\`, and two notes in the same event are never on the same string.

# Time, already worked out

${PPQ} ticks is a quarter note, so a bar is ${TICKS_PER_BAR} ticks: an eighth is ${PPQ / 2}, a quarter is ${PPQ}, a dotted quarter is ${PPQ + PPQ / 2}, a half is ${PPQ * 2}.

The piece is ${bars} long and runs from tick 0 to tick ${totalTicks}. Every event must END inside it — \`atTick\` plus \`durationTicks\` is at most ${totalTicks}. Start plus duration, not start: a note that begins inside the last bar but rings past its barline is a note past the end of the piece.

Every bar and every chord below is given to you in ticks. Do not work any of it out again.

# The progression, already looked up

${sections.join('\n\n')}

A shape doubles some tones and leaves others out, so the tones named with each chord are NOT lined up one for one with the lines under it.

THERE IS NO CHORD LOOKUP IN THIS RUN. The above is that lookup's answer for this neck, so ignore any standing instruction to go and ask for one — there is no such tool here.

This is MATERIAL, not the part. You choose which of these notes get played, in what order, at which ticks, for how long and how hard — a bass line takes one at a time and walks between them, a comping part spreads them across the bar. Notes outside the shape are yours where the line asks for one: an approach note, a passing note, a chromatic step into the next bar. If you want a tone an octave away, the same string twelve frets up is the same note an octave higher — that is the only fret arithmetic here.

# Playing a chord: ask for it, do not copy it

Never write a shape's strings and frets out into \`notes\`. When this part plays a chord, put \`"strum"\` on the attack instead and the shape above is filled in from the tick you gave — you do not name the chord, you do not copy a number, and you cannot get one wrong. One number wrong in a copied shape is a different chord for the whole bar, and it sounds like a mistake nobody made on purpose.

How much of the shape the attack hits:

    "all"       every string the shape uses
    "bottom-3"  its three lowest-numbered strings, "bottom-2" its two lowest
    "top-3"     its three highest-numbered strings, "top-2" its two highest

Lowest-numbered is nearest \`string\` 0, the bottom of the neck. A player does not hit the same strings every time: the bass end of the shape on the beat, the top of it on the answer, the whole thing where the bar wants weight. \`"all"\` on every attack is one chord banged out over and over.

A strum holds every string it hits for the whole of its \`durationTicks\`, exactly as written-out notes do. So the next attack that touches any of those strings starts at or after this one ends: a chord left ringing for a bar with a second chord struck inside it is two notes on one string at once, and it is refused. Let a chord ring and then play the next thing, or give it the shorter length you actually meant.

\`notes\` is for what you compose — the walking line, the melody, the fill, the note that leads into the next bar. Three or more notes written by hand at one instant are checked against the shape above, on the strings that shape uses, and refused if they are not it, because that is a chord you meant to copy.

# What NOT to write

Do not write the shape once at the top of the bar and stop. A stack of notes on beat 1 with silence behind it is not a part, it is the chord spelled out, and it is the exact failure this brief exists to prevent: the frets are right, the harmony is right, the length is right, and there is nothing to listen to.

A bar has more than one attack in it. Something lands off the downbeat as well as on it, the notes are not all the same length, and the result is something a player would have played on purpose.

Over ${bars} the part goes somewhere: later bars answer earlier ones instead of repeating them note for note, and the bar a chord changes on is the one a listener is waiting for.

Notes all at one volume read as typing, not as playing. Put a \`dynamic\` on what the rhythm leans on and leave the rest alone — a few marks in the right places say more than a mark on every note.

# Answer

The object alone. No fence, no preamble, no explanation after it — there is nobody reading the prose, and a sentence in front of the JSON costs you the whole part.${addendum(previousRefusal)}`,
  };
}

// ---------------------------------------------------------------- review ---

/** One thing wrong, in the shape `namedRefusals` takes: WHICH event, and the
 *  sentence about it. Grouped through that helper rather than joined here so a
 *  part that is wrong end to end costs one capped sentence instead of one per
 *  event — the batch rule every tool in this app already caps by. */
export interface TrackRefusal {
  /** What the refusal is about — `event 3 (tick 1440)`. */
  readonly label: string;
  /** What was wrong, and what would be right instead. */
  readonly reason: string;
}

/** An event names itself by BOTH its position in the array and its tick: the
 *  position is what the model can find in what it wrote, and the tick is what the
 *  sentence is about. A fractional tick prints as itself on purpose — seeing
 *  `480.5` is most of the repair. */
const eventLabel = (index: number, event: { readonly atTick: number }): string =>
  `event ${index + 1} (tick ${event.atTick})`;

// --------------------------------------------------------------- the shape ---

/** One cell of a grip, as the seam spells it. Structural for {@link IRNote}'s
 *  reason and named here so the two callers below agree on it. */
interface GripCell {
  readonly stringIndex: number;
  readonly fret: number;
}

/** A chord and where it sits on THIS neck — the same answer the brief printed,
 *  asked again by tick instead of by bar. */
interface ChordShape {
  readonly symbol: string;
  /** Ascending by string, so "the bottom of the shape" is `slice(0, n)`
   *  whatever order the voicer happened to return. */
  readonly cells: readonly GripCell[];
  /** Every bar this chord arrives at, ascending.
   *
   *  Carried for the ONE refusal that names a chord other than the one in force:
   *  "the shape of F7, which belongs at bar 5" is a sentence the model can check
   *  against its own brief in a second, and "another chord of this progression"
   *  is one it has to go looking for. */
  readonly bars: readonly number[];
}

/**
 * The progression as this neck plays it: which chord is in force at a tick and
 * what shape it has, plus every shape it uses. Memoized per symbol, and the memo
 * is call-scoped.
 *
 * ⚠ THE MODEL IS NEVER ASKED WHICH CHORD IT IS PLAYING. The brief already
 * carries the progression and the tick each chord arrives at, so the chord under
 * an event is a fact this module holds; asking for it back is one more thing to
 * get wrong, which is the whole lesson this card is applying.
 *
 * A chord holds until the next one, so it is the LATEST arrival at or before the
 * tick. Scanned rather than assumed sorted — {@link trackRunInput} refuses an
 * out-of-order progression, but this function is reached from two places and
 * would otherwise be right only because of a check somewhere else.
 *
 * `null` where there is nothing to say: no chord has arrived yet (only reachable
 * for a negative tick, which {@link reviewTrack} refuses on its own account), or
 * the symbol does not voice on this neck (which {@link trackRunInput} refuses
 * before a run happens). Neither case invents a shape.
 */
interface Progression {
  /** The shape of the chord in force at a tick. */
  readonly at: (tick: number) => ChordShape | null;
  /** Every distinct shape the progression uses on this neck, for the stale-copy
   *  half of the chord check — the one thing about a far-off stack this module
   *  CAN say: that it is another bar's chord, spelled exactly. */
  readonly shapes: () => readonly ChordShape[];
}

function shapeFinder(brief: TrackBrief): Progression {
  const bySymbol = new Map<string, ChordShape | null>();
  const lookUp = (symbol: string): ChordShape | null => {
    const cached = bySymbol.get(symbol);
    if (cached !== undefined) return cached;
    const grip = chordGrip(symbol, brief.instrumentId);
    const shape: ChordShape | null = grip.ok
      ? {
          // The symbol as the VOICER echoed it, for `trackRunInput`'s reason: the
          // chord named in a refusal and the frets it is about cannot drift apart.
          symbol: grip.value.symbol,
          cells: [...grip.value.cells].sort((a, b) => a.stringIndex - b.stringIndex),
          // Keyed on the symbol the BRIEF wrote, which is what the model was
          // shown — the voicer's echo is what the refusal prints, and the two are
          // the same string today.
          bars: brief.chords
            .filter((chord) => chord.symbol === symbol)
            .map((chord) => chord.bar)
            .sort((a, b) => a - b),
        }
      : null;
    bySymbol.set(symbol, shape);
    return shape;
  };

  const at = (tick: number): ChordShape | null => {
    let inForce: BriefChord | null = null;
    let arrived = -1;
    for (const chord of brief.chords) {
      const start = barStartTick(chord.bar);
      if (start <= tick && start > arrived) {
        inForce = chord;
        arrived = start;
      }
    }
    if (inForce === null) return null;
    return lookUp(inForce.symbol);
  };

  // Built once per call rather than once per event: the stale check below now
  // runs for EVERY stack of three notes, and rebuilding the array each time would
  // be one array per event for an answer that is mostly chords.
  let all: readonly ChordShape[] | null = null;

  return {
    at,
    shapes: () => {
      all ??= [...new Set(brief.chords.map((chord) => chord.symbol))].map(lookUp).filter(isPresent);
      return all;
    },
  };
}

/** How much of the shape each span takes. A record rather than parsing the name,
 *  so adding a span to {@link STRUM_SPANS} without saying what it means is a
 *  compile error. `slice` past the end is the whole shape, which is what a
 *  "top-3" of a two-cell grip should be. */
const STRUM_SUBSET: Record<StrumSpan, (cells: readonly GripCell[]) => readonly GripCell[]> = {
  all: (cells) => cells,
  'bottom-2': (cells) => cells.slice(0, 2),
  'bottom-3': (cells) => cells.slice(0, 3),
  'top-2': (cells) => cells.slice(-2),
  'top-3': (cells) => cells.slice(-3),
};

/**
 * Fill in every `strum` from the shape this module already looked up.
 *
 * THE POINT OF THE WHOLE CARD, and it is four lines of arithmetic precisely
 * because the alternative — the model copying five numbers per attack — is the
 * defect the header opens on.
 *
 * ⚠ 1:1 AND IN ORDER. One answer entry becomes one event at the same index, so
 * {@link eventLabel} in the review below still names the entry where the model
 * wrote it. An expansion that dropped or merged entries would renumber every
 * refusal after it.
 *
 * ⚠ IT INVENTS NOTHING WHEN IT CANNOT ANSWER. A strum with no shape behind it —
 * a tick before the first chord, a symbol that does not voice — expands to an
 * event with no notes, which {@link reviewTrack} already refuses by name. Both
 * cases are refused earlier by {@link trackRunInput}, so this is the honest
 * behaviour of an exported pure function rather than a path anything reaches.
 *
 * The one refusal it authors is the one only it can see: an entry that carries
 * BOTH. The typed notes are kept so the rest of the review still speaks about the
 * event, but the run is refused either way — an entry that says two things is an
 * entry nobody can say what should sound on.
 */
export function expandStrums(
  events: readonly IRAnswerEvent[],
  brief: TrackBrief,
): { readonly events: readonly IREvent[]; readonly refusals: readonly TrackRefusal[] } {
  const shapeAt = shapeFinder(brief).at;
  const refusals: TrackRefusal[] = [];

  const expanded = events.map((event, index): IREvent => {
    const base = {
      atTick: event.atTick,
      durationTicks: event.durationTicks,
      ...(event.dynamic === undefined ? {} : { dynamic: event.dynamic }),
    };
    if (event.strum === undefined) return { ...base, notes: event.notes ?? [] };
    // ⚠ AN EMPTY `notes` BESIDE A STRUM IS NOT "BOTH". `notes` is still an
    // advertised property, so an entry that asked for the chord and left a
    // vestigial `"notes": []` behind is one that said ONE thing — refusing it for
    // saying two would cost the whole part over an empty array, with no retry.
    if (event.notes !== undefined && event.notes.length > 0) {
      refusals.push({
        label: eventLabel(index, event),
        reason: `It has both a "strum" and its own "notes". An attack is one or the other: "strum" plays the chord in force at that tick and fills the shape in for you, and "notes" is what you composed. Drop whichever one is not what you meant.`,
      });
      return { ...base, notes: event.notes };
    }

    const shape = shapeAt(event.atTick);
    const cells = shape === null ? [] : STRUM_SUBSET[event.strum](shape.cells);
    return {
      ...base,
      notes: cells.map((cell) => ({ string: cell.stringIndex, fret: cell.fret })),
    };
  });

  return { events: expanded, refusals };
}

/** How many notes at one instant are a chord rather than a line. Argued in the
 *  header: two is a double-stop, three is the smallest stack that claims to be a
 *  chord. */
const CHORD_AT_ONCE = 3;

/** How many of them may sit off the shape before the stack is a mis-copy rather
 *  than a voicing with colour in it. Argued in the header, and biased on purpose:
 *  refusing real music costs more than passing an odd voicing, and a part gets one
 *  retry rather than an unlimited number of them. */
const MOVED_TOLERATED = 1;

/**
 * How far off the shape's own fret a note may be and still be read as a MIS-COPY
 * of that cell rather than as a different position on the neck. Argued in the
 * header: `chordGrip` returns one preferred voicing, so a stack five frets away is
 * a chord this module cannot distinguish from the right one taken somewhere else,
 * while both 2026-08-16 variants are a whole tone off every string they moved.
 */
const SLIP_FRETS = 3;

/** Notes as the model would find them in what it wrote. */
const noteList = (notes: readonly IRNote[]): string =>
  notes.map((note) => `string ${note.string} fret ${note.fret}`).join(', ');

/** Is this note exactly one of those cells — same string, same fret? */
const sitsOn = (cells: readonly GripCell[], note: IRNote): boolean =>
  cells.some((cell) => cell.stringIndex === note.string && cell.fret === note.fret);

const cellList = (cells: readonly GripCell[]): string =>
  cells.map((cell) => `string ${cell.stringIndex} fret ${cell.fret}`).join(', ');

/** One note's reach on its string, for the overlap walk. */
interface Sounding {
  readonly from: number;
  readonly until: number;
  readonly label: string;
  readonly fret: number;
}

/**
 * THE WHOLE VALIDATION, and every entry of it is something the import pipeline
 * would otherwise let past IN SILENCE. See the header for which fixture proved
 * which.
 *
 * ⚠ TAKES ITS BRIEF ON TRUST. `bars` is only read to bound the form, and a brief
 * whose `bars` is not a whole count SUPPRESSES that one check rather than
 * blaming every event for one bad number — {@link trackRunInput} refuses such a
 * brief before a run ever happens, so this is the same suppression `reviewChart`
 * applies for the same reason and not a second opinion about the form.
 *
 * DELIBERATELY NOT CHECKED: whether the part is any good, whether a LINE uses the
 * chords it was given, or whether anything lands off the downbeat. All three are
 * a listening test's, the brief forbids the worst of them in advance, and a check
 * here that guessed at them would refuse real music. A stack of three or more
 * notes at ONE instant is the exception and is checked — see the header for the
 * threshold, the tolerance and what "off the shape" can be known to mean.
 */
export function reviewTrack(
  events: readonly IREvent[],
  brief: TrackBrief,
): readonly TrackRefusal[] {
  const refusals: TrackRefusal[] = [];

  if (events.length === 0) {
    // Nothing else here speaks for the empty part: every loop below is over
    // `events`, so an empty list is otherwise a clean pass — and the pipeline
    // would commit it as a pattern with no notes in it.
    return [
      {
        label: `"${brief.name.trim()}"`,
        reason:
          'The run wrote no events at all, so this part has nothing to play. Write the part: at least one attack, and more than one to a bar.',
      },
    ];
  }

  const formed = isBarCount(brief.bars);
  const totalTicks = brief.bars * TICKS_PER_BAR;
  const strings = instrumentStringCount(brief.instrumentId);
  const frets = neckFrets(brief.instrumentId);
  const onString = new Map<number, Sounding[]>();
  const progression = shapeFinder(brief);

  for (const [index, event] of events.entries()) {
    const label = eventLabel(index, event);
    // The two silent DROPS first, and `continue` after either: an event whose
    // tick or duration is not a whole number will not exist by the time anything
    // downstream could complain about where it ends, so a second sentence about
    // its range would be a sentence about nothing.
    if (!Number.isInteger(event.atTick) || event.atTick < 0) {
      refusals.push({
        label,
        reason: `Its atTick is ${event.atTick}. Ticks are whole numbers counted from 0 — an event whose atTick has a fraction in it is thrown away, event and notes together, and nothing says so.`,
      });
      continue;
    }
    if (!Number.isInteger(event.durationTicks) || event.durationTicks < 1) {
      refusals.push({
        label,
        reason: `Its durationTicks is ${event.durationTicks}. A duration is a whole number of ticks, at least 1 — an event whose duration has a fraction in it is thrown away, event and notes together, and nothing says so.`,
      });
      continue;
    }
    if (formed && event.atTick + event.durationTicks > totalTicks) {
      refusals.push({
        label,
        reason: `It starts at ${event.atTick} and rings for ${event.durationTicks}, which ends at ${event.atTick + event.durationTicks} — past the end of a ${barsPhrase(brief.bars)} form at tick ${totalTicks}. Start plus duration, not start.`,
      });
    }
    if (event.notes.length === 0) {
      refusals.push({
        label,
        reason:
          'It has no notes in it, so it is a silence with a duration. An event is an attack — give it the notes you composed, or a "strum" to play the chord in force there, or leave the gap out entirely.',
      });
      continue;
    }

    // The notes that survived the range checks, and only those: a note already
    // refused for the string it is on is a note whose string is not yet known, so
    // it can be neither on nor off the shape.
    const playable: IRNote[] = [];

    for (const note of event.notes) {
      if (!Number.isInteger(note.string) || note.string < 0 || note.string >= strings) {
        refusals.push({
          label,
          reason: `It puts a note on string ${note.string}, which a ${brief.instrumentId} has not got — it has strings 0 to ${strings - 1}, where 0 is the bottom one. Nothing downstream refuses it: depending on the number it is either silently moved onto a different string or stored on a lane this instrument has not got, where nothing draws it and nothing plays it.`,
        });
        continue;
      }
      if (!Number.isInteger(note.fret) || note.fret < 0 || note.fret > frets) {
        refusals.push({
          label,
          reason: `It puts a note on fret ${note.fret}. This neck runs from 0 (open) to ${frets}, and nothing downstream refuses a fret past it — it is stored, drawn by nothing and dropped from playback, so the note is silence with a duration.`,
        });
        continue;
      }

      // Only notes that got this far are worth an overlap answer: a note already
      // refused for the string it is on is a note whose string is not yet known.
      const reach = onString.get(note.string) ?? [];
      reach.push({
        from: event.atTick,
        until: event.atTick + event.durationTicks,
        label,
        fret: note.fret,
      });
      onString.set(note.string, reach);
      playable.push(note);
    }

    // ── THE CHORD CHECK ─────────────────────────────────────────────────────
    // Three notes IN ONE EVENT claim to BE a chord; two are a double-stop and
    // carry no harmony of their own, and stacks spread over separate events are
    // not gathered (header). A note on a string the shape does not use is never
    // counted — nothing here can know its pitch — and neither is one far off that
    // string's own fret, which is a position rather than a slip. What is measured
    // is the shape mis-copied, which is what the 2026-08-16 guitar did.
    const shape = playable.length >= CHORD_AT_ONCE ? progression.at(event.atTick) : null;
    if (shape !== null) {
      // ⚠ THE STALE SHAPE IS LOOKED FOR FIRST, and the order is the whole point.
      // A stack that sits ENTIRELY inside another chord of this progression is the
      // ONE wrong chord this module can name as one — it looked every chord of the
      // progression up to write the brief — and naming it is the diagnosis a model
      // can act on in one go: it copied the wrong line off its own sheet.
      //
      // ⚠ IT IS A SUBSET, NOT AN IDENTITY: three notes that are three cells of a
      // six-cell barre satisfy this, so the sentence below says every note is a
      // cell of that shape rather than that the stack IS that shape.
      //
      // It used to be computed only where the slip bound had NOT fired, which
      // suppressed it exactly where it was most useful. The 2026-08-16 F7-over-C7
      // is the proof: two of its six notes sit within `SLIP_FRETS` of C7's shape,
      // so the slip branch claimed them and the answer came back as "two notes are
      // a fret or two off" about a stack that was a different chord entirely.
      const stale = progression
        .shapes()
        .find(
          (other) =>
            other.symbol !== shape.symbol &&
            playable.every((note) => sitsOn(other.cells, note)) &&
            playable.some((note) => !sitsOn(shape.cells, note)),
        );
      if (stale !== undefined) {
        refusals.push({
          label,
          reason: `It sounds ${playable.length} notes at once in bar ${barOf(event.atTick)}, where ${shape.symbol} is in force — and every one of them is a cell of the ${stale.symbol} shape, which belongs at ${barList(stale.bars)}, rather than of ${shape.symbol}'s: ${noteList(playable)}. That is the wrong chord copied out of the brief. ${shape.symbol} sits at ${cellList(shape.cells)} here — and do not copy that one out either: write "strum" on the attack instead and the chord in force at that tick is filled in for you.`,
        });
      } else {
        const moved = playable.filter((note) => {
          const cell = shape.cells.find((candidate) => candidate.stringIndex === note.string);
          if (cell === undefined) return false;
          const off = note.fret - cell.fret;
          // An octave of the shape's own fret on the SAME string is the same tone
          // — the one piece of fret arithmetic the brief sanctions.
          if (off % 12 === 0) return false;
          // A near miss is the shape mis-read; a note further away than that is a
          // position this module was never told about — see SLIP_FRETS.
          return Math.abs(off) <= SLIP_FRETS;
        });
        if (moved.length > MOVED_TOLERATED) {
          refusals.push({
            label,
            reason: `It sounds ${playable.length} notes at once over ${shape.symbol}, and ${moved.length} of them sit a fret or two off that chord's own shape on the strings it uses: ${noteList(moved)}. The shape here is ${cellList(shape.cells)}, so what sounds is not ${shape.symbol}. Do not copy a shape out by hand — write "strum" on the attack instead and it is filled in from the shape for you.`,
          });
        }
      }
    }
  }

  // The same rule `pattern_stamp_notes` enforces, and for the same reason: a
  // string can only ring one note at a time, so a pair that overlaps is a pair
  // the instrument cannot play — and the import path stores both without a word,
  // where the editor's own seam would have refused the second.
  //
  // Sorted by start, then walked against the FURTHEST-REACHING note so far rather
  // than against the immediate predecessor. A refused note stays in the array and
  // would otherwise shadow the next comparison: with notes at [0,1920), [480,960)
  // and [1440,1920) on one string, the predecessor walk reports the second and
  // misses the third, though it sits wholly inside the first. It never passed a
  // bad part — with sorted starts some adjacent pair always fires — but the
  // itemised list is what the model gets to repair from, and one collision per
  // round trip is one round trip per collision.
  for (const [stringIndex, reach] of onString) {
    const sorted = [...reach].sort((a, b) => a.from - b.from);
    let sounding = sorted[0];
    for (let i = 1; i < sorted.length; i += 1) {
      const current = sorted[i];
      if (current.from < sounding.until) {
        refusals.push({
          label: current.label,
          reason: `Its note on string ${stringIndex} fret ${current.fret} starts at ${current.from}, while the note on that same string from ${sounding.label} is still sounding until ${sounding.until}. A string can only ring one note at a time — move one of them, or shorten the one that is in the way.`,
        });
      }
      if (current.until > sounding.until) sounding = current;
    }
  }

  return refusals;
}

// ------------------------------------------------------------- narrowing ---

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isPresent = <T,>(value: T | null): value is T => value !== null;

const isDynamic = (value: unknown): value is DynamicMark =>
  typeof value === 'string' && (DYNAMICS as readonly string[]).includes(value);

const isStrum = (value: unknown): value is StrumSpan =>
  typeof value === 'string' && (STRUM_SPANS as readonly string[]).includes(value);

/**
 * `AgentRunSummary.structured` — typed `unknown` — as a list of events, or null.
 *
 * ⚠ TYPES ONLY, NEVER VALUES. A fractional tick, a fret of 99, a string a bass
 * has not got: all of those pass here and are {@link reviewTrack}'s to refuse, in
 * the sentences it authored. Re-checking them here would put two accounts of one
 * mistake in circulation, and the refusal this one can give — "that is not a list
 * of events" — is not one a model can act on.
 *
 * The fields are COPIED rather than the reply cast, so a provider that ignored
 * `additionalProperties: false` cannot smuggle an extra key — a `bend`, a
 * `tieToNext` — into a document that will silently do nothing with it.
 *
 * ⚠ `dynamic` IS DROPPED WHEN IT IS NOT ONE OF `DYNAMICS` rather than failing the
 * parse. Everything else is load-bearing and a hole in it changes what sounds; a
 * dynamic is a mark on a note that is otherwise complete, and losing one is a
 * note at the default velocity rather than a note in the wrong place. The
 * membership check is not a second catalog — `DYNAMICS` is the seam's own list,
 * and it is what makes {@link IREvent}'s narrowed `dynamic` type honest rather
 * than a claim about a `string`. `"loud"` would otherwise travel all the way to
 * the mapper to be ignored there, which is the same note at a different address
 * with nobody told.
 */
export function asTrackEvents(value: unknown): readonly IRAnswerEvent[] | null {
  if (!isObject(value)) return null;
  const { events } = value;
  if (!Array.isArray(events)) return null;

  const parsed = events.map((event): IRAnswerEvent | null => {
    if (!isObject(event)) return null;
    if (!isNumber(event.atTick) || !isNumber(event.durationTicks)) return null;
    // ⚠ EACH IS OPTIONAL AND EACH IS ALL-OR-NOTHING. An entry carries `notes` or
    // `strum`; an entry with neither is type-readable and is {@link reviewTrack}'s
    // to name, and an entry with both is {@link expandStrums}'. What is NOT
    // tolerated is a half-read one: a `notes` with an unreadable note in it, or a
    // `strum` that is not one of `STRUM_SPANS`, is content that changes what
    // sounds — unlike `dynamic` below, which is a mark on a note that is
    // otherwise complete.
    if (event.strum !== undefined && !isStrum(event.strum)) return null;
    let notes: IRNote[] | undefined;
    if (event.notes !== undefined) {
      if (!Array.isArray(event.notes)) return null;
      const read = event.notes.map((note): IRNote | null =>
        isObject(note) && isNumber(note.string) && isNumber(note.fret)
          ? { string: note.string, fret: note.fret }
          : null,
      );
      if (!read.every(isPresent)) return null;
      notes = read;
    }
    return {
      atTick: event.atTick,
      durationTicks: event.durationTicks,
      ...(notes === undefined ? {} : { notes }),
      ...(event.strum === undefined ? {} : { strum: event.strum }),
      ...(isDynamic(event.dynamic) ? { dynamic: event.dynamic } : {}),
    };
  });

  // One unreadable event makes the whole reply unusable rather than a part with a
  // hole in it. Dropping one silently is a bar of rest nobody asked for, in a
  // document whose other tracks were written to fill it — and `reviewTrack` would
  // then pass, because what is left is internally consistent.
  //
  // `every` with a predicate rather than `includes(null)` and a cast: the guard
  // and the narrowing are then the same statement.
  if (!parsed.every(isPresent)) return null;
  return parsed;
}

// ------------------------------------------------------------------- run ---

/**
 * The one outside call, injected. A test drives this module with a function that
 * returns what it says it returns — what is being asserted is the brief that goes
 * out, the schema beside it, the narrowing and the review, none of which needs a
 * provider and none of which a test with one could assert.
 */
export interface TrackRunDeps {
  readonly runTask: (
    spec: AgentSpec,
    input: string,
    options?: RunAgentTaskOptions,
  ) => Promise<Result<AgentRunSummary>>;
}

/** Not exported: it is the default for the one parameter below and nothing else
 *  imports it — a caller that wants a different `runTask` passes `deps`. */
const TRACK_RUN_DEPS: TrackRunDeps = { runTask: runAgentTask };

/**
 * WHY A RUN PRODUCED NO PART — typed, because exactly one of the four is worth
 * asking again for and no caller should have to read English to tell which.
 *
 * ⚠ `'review'` IS THE ONLY RETRYABLE ONE, and that is the whole reason this
 * discriminant exists. A review refusal is the one failure where the app has
 * something NEW to say to the model: {@link reviewTrack} names the event, prints
 * its notes and prints the shape that belongs there, and
 * {@link trackRunInput}'s addendum carries that back. The other three have
 * nothing to add — a dead provider is still dead, a brief that will not build
 * will not build a second time, and an answer that was not a structure was not
 * one the model was told to fix.
 */
export type TrackRunStop =
  /** The brief could not be built at all: a neck this app has not got, a form or
   *  a progression that does not add up, a part with no name. The caller's
   *  mistake, not the model's — no run happened. */
  | 'brief'
  /** The run itself never produced an answer: nothing configured, a dead
   *  provider, an error, an abort. The seam's own sentence, passed on. */
  | 'run'
  /** It answered, but not with a readable list of events — prose, a code fence,
   *  a stop before it got there. */
  | 'answer'
  /** It wrote a part and the part breaks a rule the import pipeline would let
   *  past in silence. THE ONE WORTH ASKING AGAIN FOR. */
  | 'review';

/**
 * `Result<IRTrack>`-shaped, plus the discriminant — a caller that only reads `ok`
 * and `reason` works unchanged.
 */
export type TrackRunOutcome =
  | { readonly ok: true; readonly value: IRTrack }
  | { readonly ok: false; readonly stopped: TrackRunStop; readonly reason: string };

/**
 * Ask a model to write one part, and hand back the track it wrote.
 *
 * `options` is passed through to the seam untouched EXCEPT for `outputSchema`,
 * which is this module's and is overwritten: the schema and the brief describe one
 * shape, and a caller substituting another would get events the narrowing cannot
 * read.
 *
 * ⚠ THE EVENTS COME BACK SORTED BY TICK, and that is not tidying. The mapper
 * preserves IR order and never sorts, so an out-of-order document produces a
 * pattern whose `startTick`s run backwards — `patternService.importIR` says so and
 * `tests/ImportIR.test.ts` pins it. Order carries no information here (nothing
 * this run may emit is resolved by walking forward through the array), so it is
 * derivable, and the standing lesson is that a derivable fact is derived rather
 * than demanded. The brief asks for time order anyway: a model that has to be
 * sorted is a model that has lost track of where it is, which is worth seeing in
 * the transcript. Sorted AFTER the review, so a refusal names the event where the
 * model wrote it.
 *
 * ⚠ IT RUNS ONCE AND NEVER TWICE. A second attempt is the CALLER's to make, by
 * calling this again with `previousRefusal` set to the sentence it got back —
 * which is what `irCompositionJob` does, once, for a `'review'` stop and nothing
 * else. Retrying in here would hide the second model call from the caller that
 * pays for it and from the transcript that has to show it.
 *
 * Every failure is a RETURNED refusal, in the register the seams refuse in, and
 * each carries the {@link TrackRunStop} that says which kind it is:
 *   - `'brief'` — the brief cannot be built: an unreadable symbol, a neck this
 *     app has not got, a form or a progression that does not add up;
 *   - `'run'` — the run itself refused: no provider, a dead endpoint, an error,
 *     an abort — and that sentence is the seam's, passed on;
 *   - `'answer'` — it answered without a structure, or with one that is not a
 *     list of events. A real outcome, not a bug;
 *   - `'review'` — an entry both asks for a chord and types its own notes, which
 *     {@link expandStrums} names, or the part breaks a rule {@link reviewTrack}
 *     names. The one a caller can usefully ask again about.
 */
export async function runIRTrack(
  brief: TrackBrief,
  options: RunAgentTaskOptions & {
    readonly deps?: TrackRunDeps;
    /** The sentence a FIRST attempt at this part was refused with. Appended to
     *  the brief as its own section — see {@link addendum}. */
    readonly previousRefusal?: string;
  } = {},
): Promise<TrackRunOutcome> {
  // FIRST, and not only for the refusal: this is where `instrumentId` — a `string`
  // on the brief, because the caller declares its own shape — becomes the id union
  // the document's `instrumentHint` is typed as. `trackRunInput` refuses the same
  // case through `chordGrip` a line later, in the same words.
  const instrument = knownInstrument(brief.instrumentId);
  if (instrument === undefined) {
    return { ok: false, stopped: 'brief', reason: unknownInstrumentRefusal(brief.instrumentId) };
  }

  const { deps = TRACK_RUN_DEPS, previousRefusal, ...runOptions } = options;

  const input = trackRunInput(brief, previousRefusal);
  if (!input.ok) return { ok: false, stopped: 'brief', reason: input.reason };

  const run = await deps.runTask(IR_TRACK_AGENT, input.value, {
    ...runOptions,
    outputSchema: irTrackSchema(brief.instrumentId),
  });
  if (!run.ok) return { ok: false, stopped: 'run', reason: run.reason };

  const events = asTrackEvents(run.value.structured);
  if (events === null) {
    // ⚠ THE SENTENCE BRANCHES ON THE STOP REASON, because the two ways to get here
    // need different repairs and only one of them is a mistake. `answered` means
    // the model wrote prose or fenced its JSON. Anything else — `aborted` above
    // all, which is what `runAgentTask` reports for a run the USER stopped — means
    // it never got to answer, and telling someone who pressed stop about code
    // fences is telling them they did something wrong.
    const detail =
      run.value.stoppedReason === 'answered'
        ? 'it stopped with "answered" and its answer is not an object with a list of events in it. The answer is parsed whole, so a code fence or a sentence in front of the JSON leaves nothing to read.'
        : `it stopped with "${run.value.stoppedReason}" before it answered. Nothing was written, so there is nothing to fix in the part — run it again.`;
    return {
      ok: false,
      stopped: 'answer',
      reason: `The run wrote no usable part for "${brief.name.trim()}" — ${detail}`,
    };
  }

  // ⚠ EXPANDED BEFORE IT IS REVIEWED, so a filled-in chord is subject to every
  // check the model's own notes are — there is no second path into the document.
  const filled = expandStrums(events, brief);
  const refusals = [...filled.refusals, ...reviewTrack(filled.events, brief)];
  if (refusals.length > 0) {
    return {
      ok: false,
      stopped: 'review',
      reason: `"${brief.name.trim()}" cannot be imported as written. ${namedRefusals(refusals)}`,
    };
  }

  return {
    ok: true,
    value: {
      id: brief.id.trim(),
      name: brief.name.trim(),
      // The app's instrument id, which is also one of the lib's `InstrumentHint`
      // values — see {@link IRTrack}.
      instrumentHint: instrument.id,
      events: [...filled.events].sort((a, b) => a.atTick - b.atTick),
    },
  };
}
