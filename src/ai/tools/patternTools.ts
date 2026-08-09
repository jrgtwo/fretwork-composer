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
 *     duration to its content on every edit (`fitPatternDuration`).
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
import {
  arr,
  bool,
  defineTool,
  fail,
  fromResult,
  int,
  name as nameOf,
  nullable,
  num,
  numFrom,
  obj,
  ok,
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

/** A note the instrument's neck cannot reach — kept, edited, never heard. Worth
 *  one field on the way out, because nothing else will ever mention it. */
const neckReport = (fret: number): { aboveTheNeck?: true } =>
  fret > fretCount() ? { aboveTheNeck: true } : {};

/** How many refusals a refusal sentence names before it stops. A 200-entry
 *  batch that fails end to end is one sentence per note otherwise, which is
 *  prompt budget spent restating the same thing. */
const REFUSALS_NAMED = 10;

/**
 * The refusals, named. A model can only recover from a refusal it can act on,
 * and "some of them are wrong" is not one — these sentences are the seam's
 * product and are passed on verbatim, one per entry.
 */
function namedRefusals(refused: readonly { label: string; reason: string }[]): string {
  const named = refused
    .slice(0, REFUSALS_NAMED)
    .map((entry) => `${entry.label}: ${entry.reason}`)
    .join(' ');
  const rest = refused.length - REFUSALS_NAMED;
  return rest > 0 ? `${named} …and ${rest} more.` : named;
}

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
}

const stampNotes = defineTool<StampArgs>({
  name: 'pattern_stamp_notes',
  description:
    'Add notes to the open pattern. Send a whole phrase in one call — it lands as a single undo step, and each note is reported separately so a note that could not be placed does not cost you the rest. A string can only ring one note at a time, so a note that overlaps an existing one on the same string is refused. A note past the end of this instrument\'s neck is placed but comes back marked aboveTheNeck, which means it will never sound. The pattern grows to fit its content by itself; there is no length to set.',
  parameters: obj(
    {
      notes: arr(
        obj(
          {
            stringIndex: int(STRING_INDEX, { min: 0 }),
            fret: int(`Fret. ${FRET}`, { min: 0, max: MAX_FRET }),
            tick: int(`Where the note starts. ${TICKS}`, { min: 0 }),
            durationTicks: int(
              `How long the note sounds. ${TICKS} May be shortened so it does not run into the next note on the same string; the value that stuck comes back.`,
              { min: 1 },
            ),
          },
          ['stringIndex', 'fret', 'tick', 'durationTicks'],
        ),
        'The notes to add.',
      ),
    },
    ['notes'],
  ),
  run: ({ notes }) =>
    oneUndoStep(
      () => {
        // `durationTicks` is passed explicitly for every note and the schema
        // requires it: the seam's parameter is optional, and omitting it makes
        // the lib fall back to the pattern PAGE's current step-length setting —
        // "whatever the user last picked" is not something a caller by value can
        // mean.
        const placed: JsonValue[] = [];
        const refused: { index: number; reason: string }[] = [];
        for (const [index, note] of notes.entries()) {
          const result = stampNote(note);
          if (result.ok) {
            placed.push({
              noteId: result.value.id,
              stringIndex: result.value.stringIndex,
              fret: result.value.fret,
              tick: result.value.startTick,
              durationTicks: result.value.durationTicks,
              ...neckReport(result.value.fret),
            });
          } else {
            refused.push({ index, reason: result.reason });
          }
        }
        // Partial success is reported as success WITH the casualties, because
        // half a phrase that landed is a state the model has to know about
        // before it tries again. Nothing landing at all is a refusal, and it
        // carries EVERY reason — an empty "ok" is the unrecoverable answer this
        // whole layer exists to avoid, and one reason out of twenty leaves the
        // model re-sending blind. A stamp has no id yet, so an entry is named by
        // the string and tick the model itself sent.
        return placed.length === 0 && refused.length > 0
          ? fail(
              `No note could be placed. ${namedRefusals(
                refused.map((entry) => ({
                  label: `string ${notes[entry.index].stringIndex} tick ${notes[entry.index].tick}`,
                  reason: entry.reason,
                })),
              )}`,
            )
          : ok({ placed, refused });
      },
      (result) => result.ok,
    ),
});

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
      () => fromResult(deleteNotes(noteIds), (count) => ({ deleted: count })),
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

const openBlank = defineTool<{ name?: string }>({
  name: 'pattern_open_blank',
  description:
    'Create an empty pattern and open it for editing. Everything else on the pattern side works on whatever pattern is open.',
  parameters: obj({ name: nameOf('What to call it.') }),
  run: ({ name }) =>
    fromResult(openBlankPattern(name), (pattern) => ({
      patternId: pattern.id,
      name: pattern.name,
      instrumentId: pattern.instrumentId,
    })),
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
