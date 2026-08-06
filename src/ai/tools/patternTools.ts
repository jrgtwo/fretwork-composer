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
        // carries the first reason — an empty "ok" is the unrecoverable answer
        // this whole layer exists to avoid.
        return placed.length === 0 && refused.length > 0
          ? fail(`No note could be placed. ${refused[0].reason}`)
          : ok({ placed, refused });
      },
      (result) => result.ok,
    ),
});

const moveNoteTool = defineTool<{ noteId: string; tick: number; stringIndex?: number }>({
  name: 'pattern_move_note',
  description:
    'Move one note in time, and optionally to another string. Reports where it actually ended up — a move onto a string that is already sounding at that moment is refused and the note stays put.',
  parameters: obj(
    {
      noteId: str('The note to move, from read_pattern.'),
      tick: int(`Where the note should start. ${TICKS}`, { min: 0 }),
      stringIndex: int(`${STRING_INDEX} Omit to keep the note on its string.`, { min: 0 }),
    },
    ['noteId', 'tick'],
  ),
  // Bracketed like the batching tools even though it is one write: the seam
  // snapshots BEFORE it knows the lib will reject the move, so an unbracketed
  // refusal would hand back `{ok:false}` and still grow the user's undo stack
  // with a step that restores the state it never left.
  run: ({ noteId, tick, stringIndex }) =>
    oneUndoStep(
      () => fromResult(moveNote(noteId, tick, stringIndex), (at) => ({ ...at })),
      (result) => result.ok,
    ),
});

const resizeNoteTool = defineTool<{ noteId: string; durationTicks: number }>({
  name: 'pattern_resize_note',
  description:
    'Change how long one note sounds. The value that stuck comes back — a note is clamped so it cannot run into the next one on its string.',
  parameters: obj(
    {
      noteId: str('The note to resize, from read_pattern.'),
      durationTicks: int(TICKS, { min: 1 }),
    },
    ['noteId', 'durationTicks'],
  ),
  run: ({ noteId, durationTicks }) =>
    oneUndoStep(
      // An object, like every other reply here: a bare number gives the model
      // nothing to check it against.
      () =>
        fromResult(resizeNote(noteId, durationTicks), (applied) => ({
          noteId,
          durationTicks: applied,
        })),
      (result) => result.ok,
    ),
});

const setNoteFretTool = defineTool<{ noteId: string; fret: number }>({
  name: 'pattern_set_note_fret',
  description:
    "Change which fret one note is played at — its pitch on its own string. A fret past the end of this instrument's neck is accepted and comes back marked aboveTheNeck, which means the note will never sound.",
  parameters: obj(
    {
      noteId: str('The note to change, from read_pattern.'),
      fret: int(FRET, { min: 0, max: MAX_FRET }),
    },
    ['noteId', 'fret'],
  ),
  run: ({ noteId, fret }) =>
    oneUndoStep(
      () =>
        fromResult(setNoteFret(noteId, fret), (applied) => ({
          noteId,
          fret: applied,
          ...neckReport(applied),
        })),
      (result) => result.ok,
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

interface ArticulationArgs {
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

const setArticulationsTool = defineTool<ArticulationArgs>({
  name: 'pattern_set_articulations',
  description:
    'Set how one note is played. Send only the fields you want to change; send null to clear one. Hammer-on and pull-off are kept mutually exclusive. NOTE about tieToNext: tying a note DISCARDS the following note entirely, so anything set on that note — its articulations, its dynamic — stops sounding.',
  parameters: obj(
    {
      noteId: str('The note to change, from read_pattern.'),
      hammerOn: nullable(bool('Hammered on from the previous note.')),
      pullOff: nullable(bool('Pulled off from the previous note.')),
      palmMute: nullable(bool('Muted with the palm at the bridge.')),
      ghost: nullable(bool('Ghost note — felt, barely pitched.')),
      dead: nullable(bool('Dead / muted string click.')),
      tap: nullable(bool('Tapped with the fretting hand.')),
      vibrato: nullable(str('Vibrato width.', VIBRATOS)),
      tieToNext: nullable(
        bool('Tie into the next note on this string. The next note is discarded, not merged.'),
      ),
    },
    ['noteId'],
  ),
  // An ABSENT key leaves the field alone; a key present with `undefined` clears
  // it — that is the lib's `key in patch` rule, and it is why each field is
  // spread conditionally instead of being written as `field ?? undefined`
  // unconditionally, which would clear every field the model didn't send.
  run: ({ noteId, ...fields }) =>
    fromResult(
      setArticulations(noteId, {
        ...(fields.hammerOn !== undefined && { hammerOn: fields.hammerOn ?? undefined }),
        ...(fields.pullOff !== undefined && { pullOff: fields.pullOff ?? undefined }),
        ...(fields.palmMute !== undefined && { palmMute: fields.palmMute ?? undefined }),
        ...(fields.ghost !== undefined && { ghost: fields.ghost ?? undefined }),
        ...(fields.dead !== undefined && { dead: fields.dead ?? undefined }),
        ...(fields.tap !== undefined && { tap: fields.tap ?? undefined }),
        ...(fields.vibrato !== undefined && { vibrato: fields.vibrato ?? undefined }),
        ...(fields.tieToNext !== undefined && { tieToNext: fields.tieToNext ?? undefined }),
      }),
      () => ({ noteId }),
    ),
});

const setDynamicTool = defineTool<{ noteId: string; dynamic: string | null }>({
  name: 'pattern_set_dynamic',
  description:
    'Set how hard one note is struck, or null to leave it at the default. The mark and the velocity playback reads are written together, so they cannot disagree.',
  parameters: obj(
    {
      noteId: str('The note to change, from read_pattern.'),
      // The list is `DYNAMIC_VELOCITY`'s own keys, ordered softest to loudest by
      // the curve rather than by how the lib's literal happens to be written.
      dynamic: nullable(
        str(`Softest to loudest: ${DYNAMICS.join(', ')}. Null clears it.`, DYNAMICS),
      ),
    },
    ['noteId', 'dynamic'],
  ),
  run: ({ noteId, dynamic }) =>
    fromResult(
      setNoteDynamic(
        noteId,
        dynamic === null ? undefined : (dynamic as (typeof DYNAMICS)[number]),
      ),
      () => ({ noteId, dynamic }),
    ),
});

// No `| null` anywhere: this tool REPLACES the note's movement, so an omitted
// field already means "not this one" and a clear is the call with no fields.
// Declaring a null the schema does not allow would only produce a validation
// error the model cannot act on.
interface PitchArgs {
  noteId: string;
  slideIn?: SlideIn;
  slideOut?: SlideOut;
  bend?: { kind: BendKind; semitones: number };
}

const setPitchTool = defineTool<PitchArgs>({
  name: 'pattern_set_pitch',
  description:
    "Set a note's pitch movement — slides into or out of it, and bends. This REPLACES whatever movement the note had; send it with no movement fields to clear.",
  parameters: obj(
    {
      noteId: str('The note to change, from read_pattern.'),
      slideIn: str('Slide into the note from below or above.', SLIDE_INS),
      slideOut: str('Slide off the note downward or upward.', SLIDE_OUTS),
      bend: obj(
        {
          kind: str('Bend shape.', BEND_KINDS),
          // The depths the editor offers, and the only ones it can DRAW: it
          // matches a note's depth against this exact list, so 1.5 renders as a
          // bend with no depth selected. A range with invented ends is the
          // free-text mistake these schemas exist to prevent.
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
  run: ({ noteId, slideIn, slideOut, bend }) => {
    const pitch: NotePitch = {
      ...(slideIn ? { slideIn } : {}),
      ...(slideOut ? { slideOut } : {}),
      ...(bend ? { bend } : {}),
    };
    return fromResult(setNotePitch(noteId, pitch), () => ({ noteId }));
  },
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
  moveNoteTool,
  resizeNoteTool,
  setNoteFretTool,
  deleteNotesTool,
  setArticulationsTool,
  setDynamicTool,
  setPitchTool,
  setPlayback,
  setInstrument,
];
