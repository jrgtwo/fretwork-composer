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
 */
import { ticksPerBar } from '../composition/compositionService';
import {
  DYNAMICS,
  MAX_FRET,
  PPQ,
  chordGrip,
  instrumentFretCount,
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
                    `Which string. 0 is the BOTTOM string (the low E on a guitar) — this instrument has ${strings}, so 0 to ${strings - 1}.`,
                    { min: 0, max: strings - 1 },
                  ),
                  fret: int(
                    `Which fret. 0 is the open string, and this instrument's neck ends at ${frets}.`,
                    { min: 0, max: frets },
                  ),
                },
                ['string', 'fret'],
              ),
              'What sounds at this instant: one note for a single line, several for a chord. A string can only ring one note at a time, so no two of them are on the same string.',
            ),
            dynamic: str(`How hard it is played. Softest to loudest: ${DYNAMICS.join(', ')}.`, DYNAMICS),
          },
          // `dynamic` is the one optional field — a part with none is playable and
          // one dynamic per event, all the same, is worse than none at all.
          ['atTick', 'durationTicks', 'notes'],
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
 *  {@link IRNote} on why that rename is worth removing. */
const gripLines = (cells: readonly { stringIndex: number; fret: number }[]): string =>
  cells.map((cell) => `    string ${cell.stringIndex}, fret ${cell.fret}`).join('\n');

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
export function trackRunInput(brief: TrackBrief): Result<string> {
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

{"events":[{"atTick":0,"durationTicks":${PPQ},"notes":[{"string":0,"fret":3}],"dynamic":"mf"}]}

One entry of \`events\` is one attack: \`atTick\` is when it starts, \`durationTicks\` is how long it rings, and \`notes\` is what sounds at that instant — one note for a single line, several for a chord. \`dynamic\` is optional and says how hard it is played, from ${DYNAMICS[0]} to ${DYNAMICS[DYNAMICS.length - 1]}.

Write the events in time order, earliest first.

EVERY NUMBER IS A WHOLE NUMBER. A tick with a fraction in it is thrown away along with the note that was on it, and nothing tells you — \`"atTick": 480.5\` is a note nobody will ever hear.

# Where the notes go on this neck

\`string\` counts from the BOTTOM string: 0 is the low E on a guitar. This ${instrument} has ${strings}, so \`string\` runs from 0 to ${strings - 1}. \`fret\` runs from 0, the open string, up to ${frets} — that is where this neck ends, and a fret past it is a note nothing will draw and nothing will play.

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

# What NOT to write

Do not write the shape once at the top of the bar and stop. A stack of notes on beat 1 with silence behind it is not a part, it is the chord spelled out, and it is the exact failure this brief exists to prevent: the frets are right, the harmony is right, the length is right, and there is nothing to listen to.

A bar has more than one attack in it. Something lands off the downbeat as well as on it, the notes are not all the same length, and the result is something a player would have played on purpose.

Over ${bars} the part goes somewhere: later bars answer earlier ones instead of repeating them note for note, and the bar a chord changes on is the one a listener is waiting for.

Notes all at one volume read as typing, not as playing. Put a \`dynamic\` on what the rhythm leans on and leave the rest alone — a few marks in the right places say more than a mark on every note.

# Answer

The object alone. No fence, no preamble, no explanation after it — there is nobody reading the prose, and a sentence in front of the JSON costs you the whole part.`,
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
const eventLabel = (index: number, event: IREvent): string =>
  `event ${index + 1} (tick ${event.atTick})`;

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
 * DELIBERATELY NOT CHECKED: whether the part is any good, whether it uses the
 * chords it was given, or whether anything lands off the downbeat. All three are
 * a listening test's, the brief forbids the worst of them in advance, and a check
 * here that guessed at them would refuse real music.
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
          'It has no notes in it, so it is a silence with a duration. An event is an attack — give it at least one note, or leave the gap out entirely.',
      });
      continue;
    }

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
export function asTrackEvents(value: unknown): readonly IREvent[] | null {
  if (!isObject(value)) return null;
  const { events } = value;
  if (!Array.isArray(events)) return null;

  const parsed = events.map((event): IREvent | null => {
    if (!isObject(event)) return null;
    if (!isNumber(event.atTick) || !isNumber(event.durationTicks)) return null;
    if (!Array.isArray(event.notes)) return null;
    const notes = event.notes.map((note): IRNote | null =>
      isObject(note) && isNumber(note.string) && isNumber(note.fret)
        ? { string: note.string, fret: note.fret }
        : null,
    );
    if (!notes.every(isPresent)) return null;
    return {
      atTick: event.atTick,
      durationTicks: event.durationTicks,
      notes,
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
 * Every failure is a RETURNED refusal, in the register the seams refuse in:
 *   - the brief cannot be built — an unreadable symbol, a neck this app has not
 *     got, a form or a progression that does not add up;
 *   - the run itself refused — no provider, a dead endpoint, an error — and that
 *     sentence is the seam's, passed on;
 *   - the run answered without a structure, which is a real outcome and not a bug;
 *   - the structure is not a list of events;
 *   - the part breaks a rule {@link reviewTrack} names.
 */
export async function runIRTrack(
  brief: TrackBrief,
  options: RunAgentTaskOptions & { readonly deps?: TrackRunDeps } = {},
): Promise<Result<IRTrack>> {
  // FIRST, and not only for the refusal: this is where `instrumentId` — a `string`
  // on the brief, because the caller declares its own shape — becomes the id union
  // the document's `instrumentHint` is typed as. `trackRunInput` refuses the same
  // case through `chordGrip` a line later, in the same words.
  const instrument = knownInstrument(brief.instrumentId);
  if (instrument === undefined) {
    return { ok: false, reason: unknownInstrumentRefusal(brief.instrumentId) };
  }

  const input = trackRunInput(brief);
  if (!input.ok) return input;

  const { deps = TRACK_RUN_DEPS, ...runOptions } = options;
  const run = await deps.runTask(IR_TRACK_AGENT, input.value, {
    ...runOptions,
    outputSchema: irTrackSchema(brief.instrumentId),
  });
  if (!run.ok) return run;

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
      reason: `The run wrote no usable part for "${brief.name.trim()}" — ${detail}`,
    };
  }

  const refusals = reviewTrack(events, brief);
  if (refusals.length > 0) {
    return {
      ok: false,
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
      events: [...events].sort((a, b) => a.atTick - b.atTick),
    },
  };
}
