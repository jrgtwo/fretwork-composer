/**
 * The agent's capabilities over the PATTERN seam — notes, articulations and the
 * pattern's own playback settings.
 *
 * Every one of these is `patternService` and nothing else. That module's header
 * has said since before the agent existed that "the agent's tools will need
 * exactly this surface, and must reach the same code path as the UI rather than
 * a parallel one"; this file is that sentence cashed in.
 *
 * ── What is deliberately NOT here ──────────────────────────────────────────
 *
 * An unused tool is prompt budget spent on nothing, so the omissions are as
 * considered as the inclusions:
 *
 *   - **Selection** (`selectNotes`, `setSelectedFret`, `nudgeSelectedFret`,
 *     `moveNotesBy`, `resizeNotesBy`, `snapshotForDrag/Resize`). Every tool here
 *     addresses notes BY ID, which is the whole constraint; a selection is a
 *     pointer's way of saying "these ones" and the agent already has a better
 *     one. The group ops exist for drag semantics (clamping a chord against
 *     obstacles) that a batch of id-addressed writes does not need.
 *   - **Undo / redo.** The user's escape hatch from what the agent did, not a
 *     move the agent gets to make. A tool that could undo could undo the user.
 *   - **`ensurePattern`.** App lifecycle — `App.tsx` owns when a pattern is
 *     open. `pattern_open_blank` is the agent's way to get one.
 *   - **Pattern length.** There is none to set: the lib auto-fits a pattern's
 *     duration to its content on every edit (`fitPatternDuration`), and fits it
 *     UP TO A WHOLE BAR — `Math.max(ticksPerBar, ceil(lastEnd / ticksPerBar) *
 *     ticksPerBar)`. One note past the end of the last bar therefore costs a
 *     whole extra bar, which a run on 2026-08-09 hit and could not diagnose: it
 *     stamped 49 quarter notes for a 12-bar part, the 49th landed on bar 13's
 *     downbeat, and the library reported 13 bars. Said in `pattern_stamp_notes`'
 *     description and in `agentRules` because it is invisible from here.
 *
 * ── Every write here is a BATCH, and why ───────────────────────────────────
 *
 * There is no singular `pattern_move_note`. A corrective command — "fix the
 * timing", "fit this to a key" — has to touch EVERY note, and one tool call per
 * note runs a twenty-note pattern into `runAgentTask`'s iteration ceiling and
 * stops half-done reporting `max_iters`, which reads as a model failure and is
 * not one. `pattern_delete_notes` was already plural; the singular tools were
 * the inconsistency, and they are gone rather than doubled up — two tools that
 * do one thing is a worse surface for a model, not a better one.
 *
 * ── Partial failure: APPLY WHAT CAN BE APPLIED, and name what could not ────
 *
 * When 3 of 20 edits are refused, the other 17 land and the reply carries the
 * three by note id with the seam's own sentence for each. The alternative —
 * refusing the whole call — was rejected for three reasons:
 *
 *   1. It would cost the round trips this batching exists to save. The model's
 *      only recovery from an all-or-nothing refusal is to re-send nineteen
 *      identical edits with one changed, which is the loop we started from.
 *   2. Refusing whole is not even *cheap* here. Every refusal these seams
 *      produce is discoverable only AFTER the write (LIB-GAP(20): the lib's ops
 *      decline by returning the pattern unchanged), so "all or nothing" would
 *      mean writing and then rolling back, and this layer has no rollback that
 *      is not the user's own undo. Contrast `pattern_delete_notes`, which stays
 *      all-or-nothing precisely because a missing id IS checkable up front.
 *   3. Each edit here is independent. One note that will not move says nothing
 *      about the other nineteen — unlike a delete, where a caller that cannot
 *      see the pattern must not be left guessing which half went.
 *
 * ONE EXCEPTION, and it is reason 2 read the other way round. `pattern_stamp_notes`
 * refuses WHOLE, before it writes anything, when the notes it was SENT cannot
 * all be placed — either because two of them want the same string at the same
 * moment, or because a `repeat` starts each pass before the pass before it has
 * finished. See `unplayableAsSent`. That refusal is not the seam's, discovered
 * after the write: it is the stamp order replayed on the arguments, so it costs
 * no write and no rollback and lands in the same category as
 * `pattern_delete_notes`' missing id.
 *
 * It is NOT the claim that the lib could not place two overlapping notes — it
 * often can, by clamping, and `blockedByThisCall` models that exactly rather
 * than assuming otherwise. It is a claim about the CALL: a call whose own notes
 * shut each other out is not the call its author meant to make, and stamping
 * the survivors of it produces a pattern nobody asked for. Collisions with notes
 * ALREADY in the pattern are not checkable up front and stay exactly as
 * described above: per note, partial, itemised.
 *
 * A batch in which NOTHING applied is a refusal, not an empty success: `ok`
 * with zero applied is the unrecoverable answer this layer exists to avoid, so
 * that case comes back as `{ok:false}` naming every note and reason.
 *
 * ── And ORDER is not the model's problem ───────────────────────────────────
 *
 * Some refusals are about the pattern at that instant rather than about the
 * edit: the lib rejects a move onto a slot a note LATER in the same batch is
 * about to vacate. Left alone, a phrase nudged later on one string — the exact
 * job `pattern-fix-timing` sends, in the exact order `read_pattern` returns —
 * would refuse every note but the last, and the model's only recovery would be
 * the re-send this batching exists to remove. So `eachNote` retries the refused
 * entries while a pass keeps unblocking something. Sorting by target tick would
 * not do: it breaks on swaps.
 */
import {
  DYNAMICS,
  MAX_FRET,
  PPQ,
  beginEditGesture,
  deleteNotes,
  endEditGesture,
  fretCount,
  getEditingPattern,
  stringCount,
  listGrooves,
  listInstruments,
  moveNote,
  openBlankPattern,
  patternGrooveId,
  resizeNote,
  setArticulations,
  setEditingPatternInstrument,
  setNoteDynamic,
  setNoteFret,
  setNotePitch,
  setPatternBpm,
  setPatternGroove,
  setPatternLoop,
  stampNote,
  type GrooveId,
} from '../../patterns/patternService';
import {
  BEND_KINDS,
  BEND_SEMITONES,
  SLIDE_INS,
  SLIDE_OUTS,
  VIBRATOS,
  type BendKind,
  type NotePitch,
  type SlideIn,
  type SlideOut,
} from '../../patterns/articulations';
// The one reach past this file's own seam, and it is a read. `editingPlacementId`
// lives in the pattern store but it is a COMPOSITION concept — which block the
// note editor is aimed at — and `compositionService` is the module that owns
// saying so. See `openBlank` for what it is for.
import { getEditingPlacementId } from '../../composition/compositionService';
import {
  arr,
  bool,
  defineTool,
  fail,
  fromResult,
  int,
  name as nameOf,
  namedRefusals,
  nullable,
  num,
  numFrom,
  obj,
  ok,
  REFUSALS_NAMED,
  str,
  type AgentTool,
  type JsonValue,
  type ToolResult,
} from './types';

// The enumerable values, taken from the seam (which takes them from the lib's
// own catalogs) and NEVER written out here. A literal list is a list that
// silently omits the instrument the lib added last week — and in a schema, that
// is the model being told a real value is invalid.
const INSTRUMENT_IDS = listInstruments().map((instrument) => instrument.id);
/** The same catalog as a sentence, for the two schemas that name the choices
 *  inline. Built once — `listInstruments` reads the lib's catalog. */
const INSTRUMENT_LIST = listInstruments()
  .map((instrument) => `${instrument.id} (${instrument.name})`)
  .join(', ');
const GROOVE_IDS = listGrooves().map((groove) => groove.id);

const TICKS = `Ticks. ${PPQ} ticks = one quarter note.`;
// `MAX_FRET` is the APP's ceiling and is the same for every instrument; a real
// neck is shorter (guitar 22, bass 21, ukulele 15). A note in between is legal
// and editable but is drawn by nothing and played by nothing, so the schema
// takes the wide bound — which is what the seam enforces — and the tools REPORT
// the narrow one instead of pretending it is a validation error.
const FRET = `0 is the open string. Up to ${MAX_FRET}, but this instrument's neck may be shorter — read_pattern says how long it is, and a note past its end is kept and edited but never sounds.`;
const STRING_INDEX =
  'String index. 0 is the LOWEST string (low E on a guitar) — display order is the reverse of this, so a pattern that reads right on screen can still be upside down here. read_pattern reports how many strings this instrument has.';

/**
 * Run several seam writes as ONE undo step.
 *
 * `patternService` counts bracket depth (AG-04 added it), so this nests safely —
 * a tool that calls another tool's helper still collapses to one step. `changed`
 * decides whether a step is pushed at all: a batch that was refused end to end
 * must not leave an undo step that restores the state it never left, and a throw
 * (which `defineTool` catches) must not either.
 */
function oneUndoStep<T>(write: () => T, changed: (value: T) => boolean): T {
  beginEditGesture();
  let didChange = false;
  try {
    const value = write();
    didChange = changed(value);
    return value;
  } catch (error) {
    // A throw mid-batch has already written something. Pushing the step is the
    // only answer that leaves undo able to reach it — dropping it would make the
    // next undo skip STRAIGHT PAST the partial edit into whatever came before.
    didChange = true;
    throw error;
  } finally {
    endEditGesture(didChange);
  }
}

/** A note the instrument's neck cannot reach — kept, edited, never heard. */
const isAboveTheNeck = (fret: number): boolean => fret > fretCount();

/** Worth one field on the way out, because nothing else will ever mention it. */
const neckReport = (fret: number): { aboveTheNeck?: true } =>
  isAboveTheNeck(fret) ? { aboveTheNeck: true } : {};

/**
 * Apply one id-addressed edit per note, as ONE undo step, reporting each
 * outcome separately. The partial-failure rule this implements is argued at the
 * top of the file.
 *
 * PASSES, not one loop. Some of these refusals are about the pattern as it
 * stands at that instant rather than about the edit: the lib REJECTS a move
 * onto a slot still held by a note that a later entry in the same batch is
 * about to vacate, so a phrase nudged later on one string would refuse every
 * note but the last — exactly the job `pattern-fix-timing` sends. Retrying only
 * what was refused, and only while a pass unblocks something, makes array order
 * irrelevant and handles swaps, which sorting by target tick does not. It is
 * bounded by `edits.length` passes and it happens inside the one bracket, so
 * undo is unaffected. Entries that already applied are never re-run.
 *
 * The `applied` list rather than a count decides whether an undo step is
 * pushed. A batch every entry of which was refused wrote nothing worth
 * restoring — not because the refusals all precede the snapshot (they do not:
 * `moveNote` learns of an overlap only by reading the note back AFTER
 * `capture()`), but because `history.capture` is a no-op while a gesture is
 * open, so the bracket swallows it either way and the lib's op left the pattern
 * unchanged.
 */
function eachNote<E extends { readonly noteId: string }>(
  edits: readonly E[],
  apply: (edit: E) => ToolResult,
): ToolResult {
  return oneUndoStep(
    () => {
      const applied: JsonValue[] = [];
      let pending: readonly E[] = edits;
      let refused: { noteId: string; reason: string }[] = [];
      while (pending.length > 0) {
        const stillPending: E[] = [];
        const reasons: { noteId: string; reason: string }[] = [];
        for (const edit of pending) {
          const result = apply(edit);
          if (result.ok) applied.push(result.value);
          else {
            stillPending.push(edit);
            reasons.push({ noteId: edit.noteId, reason: result.reason });
          }
        }
        refused = reasons;
        // No progress: every entry still refused is refused for its own sake,
        // and running it again would only produce the same sentence.
        pending = stillPending.length < pending.length ? stillPending : [];
      }
      if (applied.length > 0) return ok({ applied, refused });
      return fail(
        refused.length === 0
          ? 'No edits were sent.'
          : `Nothing changed. ${namedRefusals(
              refused.map((entry) => ({ label: entry.noteId, reason: entry.reason })),
            )}`,
      );
    },
    (result) => result.ok,
  );
}

const NOTE_ID =
  'The note to change, from read_pattern. One entry per note — a note named twice is edited twice.';

// ------------------------------------------------------------------ notes ---

interface StampArgs {
  notes: readonly {
    stringIndex: number;
    fret: number;
    tick: number;
    durationTicks: number;
  }[];
  repeat?: { times: number; everyTicks: number };
}

type StampNote = StampArgs['notes'][number];

const endsAt = (note: StampNote): number => note.tick + note.durationTicks;

/** One note of the call as it is actually attempted: which entry of `notes` it
 *  came from, which pass it belongs to, and the tick that pass puts it at. */
interface Attempt {
  readonly index: number;
  readonly pass: number;
  readonly tick: number;
}

/** An attempt another note in the SAME CALL is already sounding through. */
interface Blocked {
  readonly attempt: Attempt;
  readonly blocker: Attempt;
  /** How far the blocker reaches once the lib has clamped it — the number one
   *  end of the pair has to be moved past, and not always its `durationTicks`. */
  readonly soundingUntil: number;
}

/**
 * The notes of a stamp that another note IN THE SAME CALL will keep out, worked
 * out from the arguments alone.
 *
 * ⚠ THIS MODELS THE LIB, so it has to match it rather than merely resemble it,
 * and the obvious rule — "two notes that overlap on one string cannot both be
 * placed" — IS WRONG. `stampEvent` declines only a note whose START TICK an
 * existing note's interval already covers; anything else it places and CLAMPS,
 * shortening it so it stops at the next note on that string. `patternService`
 * says the same from the app's side ("the lib clamps a note so it cannot run
 * into the next one on its string") and applies the clamp a second time through
 * `resizeEvent`. So a long note sent AFTER the short one it would have swallowed
 * lands, shortened — an ordinary shape, and refusing it would be this layer
 * lying about what the seam does.
 *
 * Hence a replay rather than a comparison: the call is walked in the order `run`
 * stamps it — pass by pass, array order within a pass — against a string with
 * nothing else on it, and only what that walk actually declines is reported.
 * Notes already in the PATTERN are deliberately not modelled: those refusals are
 * the seam's, discoverable only after the write, and they stay per-note and
 * partial (see the file header). Leaving them out is what keeps this an answer
 * about the arguments.
 *
 * Each string's placed notes stay sorted by tick and, because of the clamp,
 * never overlap one another — which is why one binary search answers both of the
 * lib's questions: the entry before the insertion point is the only one that can
 * be covering this tick, and the entry after it is the clamp.
 */
function blockedByThisCall(
  notes: readonly StampNote[],
  times: number,
  everyTicks: number,
): Blocked[] {
  const blocked: Blocked[] = [];
  const placed = new Map<number, { tick: number; endsAt: number; attempt: Attempt }[]>();
  for (let pass = 0; pass < times; pass += 1) {
    for (const [index, note] of notes.entries()) {
      const tick = note.tick + pass * everyTicks;
      const attempt: Attempt = { index, pass, tick };
      let onString = placed.get(note.stringIndex);
      if (onString === undefined) {
        onString = [];
        placed.set(note.stringIndex, onString);
      }
      // The first note starting strictly after this one — by binary search,
      // because a long phrase repeated 64 times walks this list tens of
      // thousands of times.
      let low = 0;
      let high = onString.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (onString[mid].tick > tick) high = mid;
        else low = mid + 1;
      }
      const covering = onString[low - 1];
      if (covering !== undefined && covering.endsAt > tick) {
        blocked.push({ attempt, blocker: covering.attempt, soundingUntil: covering.endsAt });
        continue;
      }
      const next = onString[low];
      const room =
        next === undefined ? note.durationTicks : Math.min(note.durationTicks, next.tick - tick);
      onString.splice(low, 0, { tick, endsAt: tick + Math.max(1, room), attempt });
    }
  }
  return blocked;
}

/** How far the notes on one string reach, first start to last end — which is the
 *  spacing a repeat of them needs. Written as a fold rather than
 *  `Math.max(...notes.map(…))`: `notes` has no ceiling here (AG-12 is a separate
 *  ticket) and a spread long enough overflows the argument list. */
function spanOnString(notes: readonly StampNote[], stringIndex: number): number {
  let first = Infinity;
  let last = 0;
  for (const note of notes) {
    if (note.stringIndex !== stringIndex) continue;
    if (note.tick < first) first = note.tick;
    if (endsAt(note) > last) last = endsAt(note);
  }
  return last - first;
}

/**
 * The phrase is in its own way. The mistake a real run made on 2026-08-10: it
 * wrote every bar of a twelve-bar line into ONE `notes` array, each bar at
 * bar-local ticks 0/480/960/1440, and expected `repeat` to walk the groups
 * forward a bar at a time. Twenty-seven of its thirty-three notes started where
 * another note it had sent in the same call was already sounding; we stamped
 * seventy-eight of the four hundred and twenty-nine attempts and answered `ok`.
 */
function crowdedPhrase(
  notes: readonly StampNote[],
  samePass: readonly Blocked[],
  times: number,
): string {
  // ONE pair per note of the phrase, however many passes repeat it. The same
  // mistake named twelve times is twelve times the tokens and not one more fact
  // — and what is left is capped like every other refusal sentence.
  const firstPerNote = new Map<number, Blocked>();
  for (const entry of samePass) {
    if (!firstPerNote.has(entry.attempt.index)) firstPerNote.set(entry.attempt.index, entry);
  }
  const pairs = [...firstPerNote.values()].map((entry) => ({
    // Named by string and tick, because a note being sent has no id yet, and
    // BOTH ends of the pair, so the model can see which of the two it meant to
    // put somewhere else.
    label: `string ${notes[entry.attempt.index].stringIndex} tick ${entry.attempt.tick}`,
    reason:
      entry.blocker.tick === entry.attempt.tick
        ? 'you sent another note at that same tick on that string.'
        : `the note you sent at tick ${entry.blocker.tick} on that string is still sounding until ${entry.soundingUntil}.`,
  }));
  // The recovery is not the same sentence with a repeat and without one, because
  // the mistake is not: bar-local ticks are what a repeat is FOR, and are simply
  // wrong without one. Steering a model towards a parameter it did not use hides
  // the fault it did make.
  const steer =
    times > 1
      ? 'If those are meant to be successive bars, send ONE bar and let repeat lay the rest down — repeat copies the whole list forward by everyTicks, it does not deal your notes out a bar at a time.'
      : 'If those are meant to be successive bars, their ticks count from the start of the PATTERN and not from the start of each bar — or send one bar and add a repeat.';
  return `These notes land on top of each other: ${firstPerNote.size} of the ${notes.length} you sent start where another note in the same list is still sounding, on the same string, and a string can only ring one note at a time. Nothing was written. ${steer} ${namedRefusals(pairs)}`;
}

/** Each pass starts before the one before it has finished. `everyTicks`' own
 *  description warns about this in prose; this is it as a refusal. */
function passesTooClose(
  notes: readonly StampNote[],
  blocked: readonly Blocked[],
  everyTicks: number,
): string {
  // The WIDEST of the strings that actually collide, not the span of the call:
  // a wider gap can only ever move passes further apart, so clearing the worst
  // colliding string clears every one of them, while a string that does not
  // collide cannot be made to by a bigger gap however far its own notes reach.
  // Quoting the whole call's span instead would inflate `everyTicks`, and the
  // pattern's length auto-fits, so that lands as bars the model then has to
  // diagnose.
  let span = 0;
  let widest = -1;
  for (const entry of blocked) {
    const stringIndex = notes[entry.attempt.index].stringIndex;
    const onString = spanOnString(notes, stringIndex);
    if (onString > span) {
      span = onString;
      widest = stringIndex;
    }
  }
  return `Every pass would land on the one before it: on string ${widest} these notes span ${span} ticks but repeat starts a pass every ${everyTicks}. Nothing was written. Send an everyTicks of at least ${span}, or make the phrase shorter.`;
}

/**
 * The refusal a stamp can PROVE from its own arguments — or null, which is the
 * normal answer.
 *
 * ⚠ RUNS BEFORE `oneUndoStep` OPENS ITS BRACKET. Nothing is written, so nothing
 * is there to restore, and a step pushed here would be one that undoes a state
 * the pattern never left — the defect `oneUndoStep`'s `changed` predicate exists
 * to prevent. (The predicate would in fact swallow it either way, so the
 * ordering is not observable from outside; it is still the construction that
 * makes the rule true rather than incidentally satisfied.)
 *
 * The two cases are different mistakes with different recoveries, so they get
 * different sentences, and which one it is falls straight out of the replay:
 * a note kept out by a note from its OWN pass is a phrase that overlaps itself,
 * and one kept out by an earlier pass is a `repeat` spaced too tightly.
 */
function unplayableAsSent(
  notes: readonly StampNote[],
  times: number,
  everyTicks: number,
): string | null {
  const blocked = blockedByThisCall(notes, times, everyTicks);
  if (blocked.length === 0) return null;
  const samePass = blocked.filter((entry) => entry.blocker.pass === entry.attempt.pass);
  return samePass.length > 0
    ? crowdedPhrase(notes, samePass, times)
    : passesTooClose(notes, blocked, everyTicks);
}

const stampNotes = defineTool<StampArgs>({
  name: 'pattern_stamp_notes',
  description:
    'Add notes to the open pattern. Send a whole phrase in one call — it lands as a single undo step, and each note is reported separately so a note that could not be placed does not cost you the rest. To lay the same phrase down again and again, send it ONCE with `repeat` rather than typing out every copy: a twelve-bar ostinato is four notes and a repeat, not forty-eight notes. A string can only ring one note at a time, so a note that overlaps one ALREADY in the pattern is refused on its own and the rest of the call still lands — but if the notes you send would land on top of EACH OTHER on one string, or a repeat would start a pass before the pass before it had finished, the WHOLE call is refused and nothing at all is written, because that much is provable from what you sent. A note past the end of this instrument\'s neck is placed but comes back marked aboveTheNeck, which means it will never sound; a repeat only COUNTS those rather than naming them. The pattern grows to fit its content by itself and there is no length to set — but it grows to a WHOLE BAR, so a single note starting one beat past the end of the last bar you meant makes the pattern a bar longer. The reply gives placedCount, refusedCount and the length that resulted; check the length against the length you intended. Every note is listed individually, EXCEPT when you repeat: then the counts come back without the list, because one entry per copy would hand straight back the tokens the repeat just saved, and refused names only the first ten casualties while refusedCount still counts them all. read_pattern has the ids, the durations that stuck and the notes above the neck whenever you need them.',
  parameters: obj(
    {
      notes: arr(
        obj(
          {
            stringIndex: int(STRING_INDEX, { min: 0 }),
            fret: int(`Fret. ${FRET}`, { min: 0, max: MAX_FRET }),
            tick: int(`Where the note starts. ${TICKS}`, { min: 0 }),
            durationTicks: int(
              `How long the note sounds. ${TICKS} May be shortened so it does not run into a note that is already there — one already in the pattern, or one earlier in this same call; the value that stuck comes back, except with a repeat, which reports no per-note detail, so read_pattern is where to check it.`,
              { min: 1 },
            ),
          },
          ['stringIndex', 'fret', 'tick', 'durationTicks'],
        ),
        'The notes to add. With a repeat this is ONE pass and nothing more — a single copy of the phrase, which repeat then lays down again and again; do not write the other copies out here as well.',
      ),
      repeat: obj(
        {
          // `obj()` carries no description of its own, and the container is the
          // first thing a model reads, so what a repeat IS is stated here.
          times: int(
            'A repeat stamps the notes you sent again and again, each pass a fixed distance after the one before it. This is how many passes there are in total, COUNTING the first one. 1 means no repeat at all. Twelve bars of a one-bar riff is 12, not 11.',
            { min: 1, max: 64 },
          ),
          everyTicks: int(
            `How far apart the passes are: the gap from the START of one pass to the start of the next, which for a one-bar phrase is one bar. ${TICKS} Say it explicitly — it is NEVER worked out from the notes you sent, because a phrase whose last note is short does not reach the end of its bar, and the pattern's length rounds up to whole bars afterwards, so a spacing guessed from the notes would give you a different rhythm from the one you meant. Make it at least as long as the phrase itself spans: a shorter one lands each pass on top of the one before it, and the whole call is refused before anything is written.`,
            { min: 1 },
          ),
        },
        ['times', 'everyTicks'],
      ),
    },
    ['notes'],
  ),
  run: ({ notes, repeat }) => {
    const times = repeat?.times ?? 1;
    const everyTicks = repeat?.everyTicks ?? 0;
    // BEFORE the bracket, and before any write: a call whose own notes cannot
    // coexist is refused whole and leaves no undo step. See `unplayableAsSent`.
    const impossible = unplayableAsSent(notes, times, everyTicks);
    if (impossible !== null) return fail(impossible);
    /**
     * ITEMISE ONLY WHEN THERE IS NOTHING TO REPEAT.
     *
     * Listing 48 placed notes hands back most of the tokens `repeat` exists to
     * save. The model does not need 48 ids to build an ostinato — it needs the
     * count, the length that resulted and the casualties — and `read_pattern`
     * gives out ids on demand for the rare case where it does. Keeping the list
     * for `times: 1` is what makes "times: 1 is no repeat" literally true:
     * identical reply, plus a redundant count.
     */
    const itemise = times === 1;
    return oneUndoStep(
      () => {
        // `durationTicks` is passed explicitly for every note and the schema
        // requires it: the seam's parameter is optional, and omitting it makes
        // the lib fall back to the pattern PAGE's current step-length setting —
        // "whatever the user last picked" is not something a caller by value can
        // mean.
        const placed: JsonValue[] = [];
        let placedCount = 0;
        // Counted even when the notes are itemised, because with `placed` gone
        // this is the ONLY mention a silent note gets, and a count that appears
        // only sometimes is a shape the model has to learn twice.
        let aboveTheNeck = 0;
        const refused: {
          index: number;
          repeatIndex?: number;
          tick: number;
          reason: string;
        }[] = [];
        // Pass by pass, in order, so a collision is reported where it actually
        // happened rather than against the phrase as it was sent.
        for (let pass = 0; pass < times; pass += 1) {
          const offset = pass * everyTicks;
          for (const [index, note] of notes.entries()) {
            const result = stampNote({ ...note, tick: note.tick + offset });
            if (result.ok) {
              placedCount += 1;
              if (isAboveTheNeck(result.value.fret)) aboveTheNeck += 1;
              if (itemise) {
                placed.push({
                  noteId: result.value.id,
                  stringIndex: result.value.stringIndex,
                  fret: result.value.fret,
                  tick: result.value.startTick,
                  durationTicks: result.value.durationTicks,
                  ...neckReport(result.value.fret),
                });
              }
            } else {
              refused.push({
                index,
                // 1-based, like the bar numbers in `agentRules` — a model
                // holding two counting conventions at once mis-locates the
                // pass. ABSENT without a repeat: a `repeatIndex: 1` on a call
                // that sent no `repeat` names a dimension the model never used.
                ...(itemise ? {} : { repeatIndex: pass + 1 }),
                // Where the note was ACTUALLY attempted, which for a repeat is
                // not the tick that was sent. Without it, and with `placed`
                // gone, locating a casualty is arithmetic in a reply whose
                // whole point is to spare the model arithmetic.
                tick: note.tick + offset,
                reason: result.reason,
              });
            }
          }
        }
        // Partial success is reported as success WITH the casualties, because
        // half a phrase that landed is a state the model has to know about
        // before it tries again — and with a repeat, a pass that collided says
        // WHICH pass rather than costing the eleven that did not. Nothing
        // landing at all is a refusal, and it carries EVERY reason — an empty
        // "ok" is the unrecoverable answer this whole layer exists to avoid, and
        // one reason out of twenty leaves the model re-sending blind. A stamp
        // has no id yet, so an entry is named by the string and the tick it was
        // actually attempted at, which for a repeat is not the tick that was
        // sent.
        return placedCount === 0 && refused.length > 0
          ? fail(
              `No note could be placed. ${namedRefusals(
                refused.map((entry) => ({
                  label: `${
                    entry.repeatIndex === undefined ? '' : `repeat ${entry.repeatIndex} `
                  }string ${notes[entry.index].stringIndex} tick ${entry.tick}`,
                  reason: entry.reason,
                })),
              )}`,
            )
          : ok({
              ...(itemise ? { placed } : {}),
              placedCount,
              // CAPPED with a repeat. `refused` is `notes.length × times` here —
              // up to 64 times the array the model sent — and every entry
              // carries a whole seam sentence, which would hand back the tokens
              // the repeat was called to save. Without a repeat it stays whole:
              // it is bounded by the array the model typed out itself, and that
              // has always been the deal.
              refused: itemise ? refused : refused.slice(0, REFUSALS_NAMED),
              refusedCount: refused.length,
              // Silent notes. Named per note when itemising and only counted
              // otherwise, but never left out — read_pattern names which.
              aboveTheNeck,
              // Unchanged by the repeat, and with one it is the ONLY way the
              // model learns how long the thing it just built actually is.
              ...patternLength(),
            });
      },
      (result) => result.ok,
    );
  },
});

/**
 * How long the pattern is NOW, in ticks and in bars.
 *
 * Returned by every tool that adds or removes notes, because the length is not
 * something the caller can work out from what it sent: `fitPatternDuration`
 * rounds the content UP to a whole bar, so a phrase ending one beat into a new
 * bar produces a pattern a whole bar longer than the phrase.
 *
 * That gap cost a whole run. A job stamped 49 quarter notes for a twelve-bar
 * bass part — one too many, the 49th landing on bar 13's downbeat — got back a
 * plain `{placed, refused}` saying all 49 were fine, and only found out from a
 * later library read that the pattern was thirteen bars. It could see it was
 * wrong and not why, so it deleted everything and stamped the identical notes
 * again. Reporting the length here closes that loop at the call that caused it.
 *
 * `bars` is given alongside the ticks rather than left as arithmetic: bars are
 * what the command asked for, and the rounding is a statement ABOUT bars.
 */
function patternLength(): { durationTicks: number; bars: number } {
  const pattern = getEditingPattern();
  if (!pattern) return { durationTicks: 0, bars: 0 };
  const { numerator, denominator } = pattern.timeSignature;
  const ticksPerBar = numerator * ((4 / denominator) * PPQ);
  return {
    durationTicks: pattern.durationTicks,
    bars: pattern.durationTicks / ticksPerBar,
  };
}

interface MoveEdit {
  noteId: string;
  tick: number;
  stringIndex?: number;
}

const moveNotesTool = defineTool<{ moves: readonly MoveEdit[] }>({
  name: 'pattern_move_notes',
  description:
    'Move notes in time, and optionally onto other strings. Send every move you want in one call — they land as a single undo step, and the order you list them in does not matter: a move blocked by a note that another move in the same call clears out of the way is retried once that note has gone. Each note reports where it actually ended up; a move onto a string that is still sounding at that moment when nothing else can free it is refused, that note stays put, and the rest of the batch still applies.',
  parameters: obj(
    {
      moves: arr(
        obj(
          {
            noteId: str(NOTE_ID),
            tick: int(`Where the note should start. ${TICKS}`, { min: 0 }),
            stringIndex: int(`${STRING_INDEX} Omit to keep the note on its string.`, { min: 0 }),
          },
          ['noteId', 'tick'],
        ),
        'The moves to make.',
      ),
    },
    ['moves'],
  ),
  // The bracket is `eachNote`'s, and it matters even for a batch of one: the
  // seam snapshots BEFORE it knows the lib will reject the move, so an
  // unbracketed refusal would hand back `{ok:false}` and still grow the user's
  // undo stack with a step that restores the state it never left.
  run: ({ moves }) =>
    eachNote(moves, (move) =>
      fromResult(moveNote(move.noteId, move.tick, move.stringIndex), (at) => ({
        noteId: move.noteId,
        ...at,
      })),
    ),
});

interface ResizeEdit {
  noteId: string;
  durationTicks: number;
}

const resizeNotesTool = defineTool<{ resizes: readonly ResizeEdit[] }>({
  name: 'pattern_resize_notes',
  description:
    'Change how long notes sound. Send every length you want in one call — they land as a single undo step. The value that stuck comes back for each note, because a note is clamped so it cannot run into the next one on its string.',
  parameters: obj(
    {
      resizes: arr(
        obj({ noteId: str(NOTE_ID), durationTicks: int(TICKS, { min: 1 }) }, [
          'noteId',
          'durationTicks',
        ]),
        'The new lengths.',
      ),
    },
    ['resizes'],
  ),
  run: ({ resizes }) =>
    eachNote(resizes, (resize) =>
      // An object, like every other reply here: a bare number gives the model
      // nothing to check it against.
      fromResult(resizeNote(resize.noteId, resize.durationTicks), (applied) => ({
        noteId: resize.noteId,
        durationTicks: applied,
      })),
    ),
});

interface FretEdit {
  noteId: string;
  fret: number;
}

const setNoteFretsTool = defineTool<{ frets: readonly FretEdit[] }>({
  name: 'pattern_set_note_frets',
  description:
    "Change which fret notes are played at — their pitch on the strings they are already on. Send the whole re-fretting in one call; it lands as a single undo step. A fret past the end of this instrument's neck is accepted and that note comes back marked aboveTheNeck, which means it will never sound.",
  parameters: obj(
    {
      frets: arr(
        obj({ noteId: str(NOTE_ID), fret: int(FRET, { min: 0, max: MAX_FRET }) }, [
          'noteId',
          'fret',
        ]),
        'The frets to set.',
      ),
    },
    ['frets'],
  ),
  run: ({ frets }) =>
    eachNote(frets, (edit) =>
      fromResult(setNoteFret(edit.noteId, edit.fret), (applied) => ({
        noteId: edit.noteId,
        fret: applied,
        ...neckReport(applied),
      })),
    ),
});

const deleteNotesTool = defineTool<{ noteIds: readonly string[] }>({
  name: 'pattern_delete_notes',
  description:
    'Delete notes from the open pattern, as one undo step. All or nothing: if any id names no note, nothing is deleted.',
  parameters: obj(
    { noteIds: arr(str('A note id from read_pattern.'), 'The notes to delete.') },
    ['noteIds'],
  ),
  run: ({ noteIds }) =>
    oneUndoStep(
      // The length comes back here too: deleting the last note in a bar shortens
      // the pattern by a whole bar, which is the same rounding seen from the
      // other side and just as invisible from the arguments.
      () => fromResult(deleteNotes(noteIds), (count) => ({ deleted: count, ...patternLength() })),
      (result) => result.ok,
    ),
});

// ---------------------------------------------------------- articulations ---

interface ArticulationEdit {
  noteId: string;
  hammerOn?: boolean | null;
  pullOff?: boolean | null;
  palmMute?: boolean | null;
  ghost?: boolean | null;
  dead?: boolean | null;
  tap?: boolean | null;
  vibrato?: 'slight' | 'wide' | null;
  tieToNext?: boolean | null;
}

/**
 * An ABSENT key leaves the field alone; a key present with `undefined` clears
 * it — that is the lib's `key in patch` rule, and it is why each field is
 * spread conditionally instead of being written as `field ?? undefined`
 * unconditionally, which would clear every field the model didn't send.
 */
const articulationPatch = (edit: ArticulationEdit) => ({
  ...(edit.hammerOn !== undefined && { hammerOn: edit.hammerOn ?? undefined }),
  ...(edit.pullOff !== undefined && { pullOff: edit.pullOff ?? undefined }),
  ...(edit.palmMute !== undefined && { palmMute: edit.palmMute ?? undefined }),
  ...(edit.ghost !== undefined && { ghost: edit.ghost ?? undefined }),
  ...(edit.dead !== undefined && { dead: edit.dead ?? undefined }),
  ...(edit.tap !== undefined && { tap: edit.tap ?? undefined }),
  ...(edit.vibrato !== undefined && { vibrato: edit.vibrato ?? undefined }),
  ...(edit.tieToNext !== undefined && { tieToNext: edit.tieToNext ?? undefined }),
});

const setArticulationsTool = defineTool<{ notes: readonly ArticulationEdit[] }>({
  name: 'pattern_set_articulations',
  description:
    'Set how notes are played. Send a whole articulation pass in one call — it lands as a single undo step. For each note send only the fields you want to change; send null to clear one. Hammer-on and pull-off are kept mutually exclusive. NOTE about tieToNext: tying a note DISCARDS the following note entirely, so anything set on that note — its articulations, its dynamic — stops sounding.',
  parameters: obj(
    {
      notes: arr(
        obj(
          {
            noteId: str(NOTE_ID),
            hammerOn: nullable(bool('Hammered on from the previous note.')),
            pullOff: nullable(bool('Pulled off from the previous note.')),
            palmMute: nullable(bool('Muted with the palm at the bridge.')),
            ghost: nullable(bool('Ghost note — felt, barely pitched.')),
            dead: nullable(bool('Dead / muted string click.')),
            tap: nullable(bool('Tapped with the fretting hand.')),
            vibrato: nullable(str('Vibrato width.', VIBRATOS)),
            tieToNext: nullable(
              bool(
                'Tie into the next note on this string. The next note is discarded, not merged.',
              ),
            ),
          },
          ['noteId'],
        ),
        'The notes to mark, one entry each.',
      ),
    },
    ['notes'],
  ),
  run: ({ notes }) =>
    eachNote(notes, (edit) =>
      fromResult(setArticulations(edit.noteId, articulationPatch(edit)), () => ({
        noteId: edit.noteId,
      })),
    ),
});

interface DynamicEdit {
  noteId: string;
  dynamic: string | null;
}

const setDynamicsTool = defineTool<{ dynamics: readonly DynamicEdit[] }>({
  name: 'pattern_set_dynamics',
  description:
    'Set how hard notes are struck, or null to leave one at the default. Send the whole shape of a phrase in one call — it lands as a single undo step. The mark and the velocity playback reads are written together, so they cannot disagree.',
  parameters: obj(
    {
      dynamics: arr(
        obj(
          {
            noteId: str(NOTE_ID),
            // The list is `DYNAMIC_VELOCITY`'s own keys, ordered softest to
            // loudest by the curve rather than by how the lib's literal happens
            // to be written.
            dynamic: nullable(
              str(`Softest to loudest: ${DYNAMICS.join(', ')}. Null clears it.`, DYNAMICS),
            ),
          },
          ['noteId', 'dynamic'],
        ),
        'The dynamics to set.',
      ),
    },
    ['dynamics'],
  ),
  run: ({ dynamics }) =>
    eachNote(dynamics, (edit) =>
      fromResult(
        setNoteDynamic(
          edit.noteId,
          edit.dynamic === null ? undefined : (edit.dynamic as (typeof DYNAMICS)[number]),
        ),
        () => ({ noteId: edit.noteId, dynamic: edit.dynamic }),
      ),
    ),
});

// No `| null` anywhere: this tool REPLACES the note's movement, so an omitted
// field already means "not this one" and a clear is the call with no fields.
// Declaring a null the schema does not allow would only produce a validation
// error the model cannot act on.
interface PitchEdit {
  noteId: string;
  slideIn?: SlideIn;
  slideOut?: SlideOut;
  bend?: { kind: BendKind; semitones: number };
}

const setPitchesTool = defineTool<{ pitches: readonly PitchEdit[] }>({
  name: 'pattern_set_pitches',
  description:
    "Set notes' pitch movement — slides into or out of them, and bends. Send them all in one call; it lands as a single undo step. Each entry REPLACES whatever movement that note had, so an entry with no movement fields clears it.",
  parameters: obj(
    {
      pitches: arr(
        obj(
          {
            noteId: str(NOTE_ID),
            slideIn: str('Slide into the note from below or above.', SLIDE_INS),
            slideOut: str('Slide off the note downward or upward.', SLIDE_OUTS),
            bend: obj(
              {
                kind: str('Bend shape.', BEND_KINDS),
                // The depths the editor offers, and the only ones it can DRAW:
                // it matches a note's depth against this exact list, so 1.5
                // renders as a bend with no depth selected. A range with
                // invented ends is the free-text mistake these schemas exist to
                // prevent.
                semitones: numFrom(
                  `How far the bend travels: ${BEND_SEMITONES.join(', ')} semitones (2 is a full step).`,
                  BEND_SEMITONES,
                ),
              },
              ['kind', 'semitones'],
            ),
          },
          ['noteId'],
        ),
        'The movements to set, one entry per note.',
      ),
    },
    ['pitches'],
  ),
  run: ({ pitches }) =>
    eachNote(pitches, (edit) => {
      const pitch: NotePitch = {
        ...(edit.slideIn ? { slideIn: edit.slideIn } : {}),
        ...(edit.slideOut ? { slideOut: edit.slideOut } : {}),
        ...(edit.bend ? { bend: edit.bend } : {}),
      };
      return fromResult(setNotePitch(edit.noteId, pitch), () => ({ noteId: edit.noteId }));
    }),
});

// --------------------------------------------------------------- pattern ---

const openBlank = defineTool<{ name?: string; instrumentId?: string }>({
  name: 'pattern_open_blank',
  description: `Create an empty pattern and open it for editing. Everything else on the pattern side works on whatever pattern is open. Give the instrument here — a new pattern is a guitar otherwise, and it decides how many strings you have to write on. ${INSTRUMENT_LIST}`,
  parameters: obj({
    name: nameOf('What to call it.'),
    instrumentId: str(INSTRUMENT_LIST, INSTRUMENT_IDS),
  }),
  run: ({ name, instrumentId }) => {
    /**
     * ⚠ REFUSED WHILE A COMPOSITION BLOCK IS OPEN, and this is the one place it
     * can be.
     *
     * The lib keeps ONE pattern-editing pointer and `openPatternForEditing`
     * nulls `editingPlacementId` outright, so opening a new pattern while a
     * block is open silently repoints the editor: `writePatternBack` stops
     * routing to the placement's snapshot, every later stamp lands in a library
     * pattern the user is not looking at, and none of it is reached by the
     * composition rollback. The commands the composition page's EDIT mode offers
     * are the pattern page's, so this is a run away from happening —
     * `pattern-generate` is withheld there for exactly this reason, and
     * `Command.tools` is documented as not enforcement, so a model reaching for
     * this tool from any of the other five has to be answered here too.
     *
     * The SEAM stays permissive: a user starting a new pattern with a block open
     * is a legitimate move and `patternService` handles it (tests/EditMode).
     * This is a rule about agent runs, so it lives with the agent's capability.
     */
    if (getEditingPlacementId() !== null) {
      return fail(
        'A composition block is open for editing — stamp your notes into the pattern that is already open rather than starting a new one.',
      );
    }
    return fromResult(openBlankPattern(name), (pattern) => {
      /**
       * ── WHY THE INSTRUMENT IS SET HERE AND NOT LEFT TO A SECOND CALL ───────
       *
       * A new pattern is a guitar, so authoring any other part used to be two
       * calls whose second was `pattern_set_instrument {"instrumentId":"bass"}`
       * — BYTE-IDENTICAL every time, because there is only one thing to say. A
       * job that writes three bass parts made that exact call three times, and
       * the harness's loop detector reads identical arguments with no progress
       * as a stuck model and cuts the run short. It was not stuck; the run log
       * for 2026-08-09 shows it changing strategy between each one. The repeat
       * was forced by this tool taking no instrument.
       *
       * So this is not a convenience. Neither is it a new capability: both
       * halves are seam functions already, and the app's own New Pattern button
       * wants the two-step. What is fixed is the AGENT's surface.
       *
       * A refusal here is dropped on purpose — the pattern is open and usable,
       * and the reply says which instrument it actually has. Failing the whole
       * call would strand a created pattern in the library to make a point
       * about its instrument.
       */
      if (instrumentId !== undefined) {
        setEditingPatternInstrument(instrumentId as (typeof INSTRUMENT_IDS)[number]);
      }
      const opened = getEditingPattern() ?? pattern;
      return {
        patternId: opened.id,
        name: opened.name,
        instrumentId: opened.instrumentId,
        strings: stringCount(),
      };
    });
  },
});

interface PlaybackArgs {
  bpm?: number | null;
  loop?: boolean;
  groove?: GrooveId;
}

const setPlayback = defineTool<PlaybackArgs>({
  name: 'pattern_set_playback',
  description:
    "How the open pattern is played back: its preferred tempo, whether the editor loops it, and its feel. These are the author's intent stored on the pattern, not the transport — they are not part of undo, and changing them does not start anything.",
  parameters: obj({
    bpm: nullable(num('Preferred tempo. Null means no preference.', { min: 20, max: 400 })),
    loop: bool('Whether the editor repeats this pattern.'),
    groove: str(
      `Feel: ${listGrooves()
        .map((groove) => `${groove.id} (${groove.name})`)
        .join(', ')}.`,
      GROOVE_IDS,
    ),
  }),
  run: ({ bpm, loop, groove }) => {
    // Several writes, no gesture: none of the three is part of the arrangement's
    // content, so none of them pushes an undo step in the first place — the same
    // rule the seam applies to the pattern's voice.
    if (bpm !== undefined) {
      const result = setPatternBpm(bpm);
      if (!result.ok) return fail(result.reason);
    }
    if (loop !== undefined) {
      const result = setPatternLoop(loop);
      if (!result.ok) return fail(result.reason);
    }
    if (groove !== undefined) {
      const result = setPatternGroove(groove);
      if (!result.ok) return fail(result.reason);
    }
    // Read back rather than echoed: the reply is what the pattern now HOLDS, so
    // a caller can tell a cleared tempo from one it never sent, and can see the
    // feel it did not change.
    const pattern = getEditingPattern();
    return ok({
      bpm: pattern?.suggestedBpm ?? null,
      loop: pattern?.loop ?? null,
      groove: patternGrooveId(),
    });
  },
});

const setInstrument = defineTool<{ instrumentId: string }>({
  name: 'pattern_set_instrument',
  description:
    "Put the open pattern on another instrument — which decides how many strings it has and which voices it can play. Notes on strings the new instrument has not got are KEPT but stop being drawn and stop sounding; switching back restores them.",
  parameters: obj(
    {
      instrumentId: str(
        listInstruments()
          .map((instrument) => `${instrument.id} (${instrument.name})`)
          .join(', '),
        INSTRUMENT_IDS,
      ),
    },
    ['instrumentId'],
  ),
  run: ({ instrumentId }) =>
    fromResult(
      setEditingPatternInstrument(instrumentId as (typeof INSTRUMENT_IDS)[number]),
      () => ({ instrumentId }),
    ),
});

export const PATTERN_TOOLS: readonly AgentTool[] = [
  openBlank,
  stampNotes,
  moveNotesTool,
  resizeNotesTool,
  setNoteFretsTool,
  deleteNotesTool,
  setArticulationsTool,
  setDynamicsTool,
  setPitchesTool,
  setPlayback,
  setInstrument,
];
