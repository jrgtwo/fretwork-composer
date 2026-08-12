/**
 * What the agent can SEE.
 *
 * The point of these is that the model acts on the state the app is actually in
 * rather than on what it assumed two calls ago — every write tool addresses
 * things by the ids these return. They are also where the facts a tool author
 * gets wrong are stated in the model's own terms: which end of `stringIndex` is
 * the low E, that a block is a copy, that a count of stranded notes is about
 * strings and not about what will be heard.
 *
 * Reads go through the seams too. There is no cheaper path — `getEditingPattern`
 * and `getEditingComposition` ARE the store reads, and a tool reaching for the
 * store directly to save a hop would be the one privileged path this design
 * exists to prevent.
 *
 * Kept DELIBERATELY thin. Every field here is a field the model pays for on
 * every call that reads, so this is the arrangement's shape and its ids, not the
 * whole document: no per-track voice parameters (`voice_list_for_track` asks for
 * one track), no collections, no timestamps, no tags.
 */
import {
  PPQ,
  chordGrip,
  fretCount,
  getEditingPattern,
  getLibraryPatterns,
  instrumentStringCount,
  notesAboveNeck,
  patternGrooveId,
  patternInstrumentId,
  stringCount,
  unknownInstrumentRefusal,
} from '../../patterns/patternService';
import { readNotePitch } from '../../patterns/articulations';
import {
  compositionGrooveId,
  droppedByTranspose,
  getEditingComposition,
  getEditingPlacementId,
  getTracks,
  isTrackAudible,
  mismatchedPlacements,
  placementEffectiveLength,
  placementEndTick,
  strandedByInstrument,
  totalDurationTicks,
  trackInstrumentId,
} from '../../composition/compositionService';
import { readTrackVoiceRef, voiceKey } from '../../voice/voiceService';
import { barConverter } from './barMath';
import { INSTRUMENT_IDS, INSTRUMENT_LIST } from './instrumentCatalog';
import {
  arr,
  defineTool,
  fail,
  namedRefusals,
  noArgs,
  obj,
  ok,
  str,
  type AgentTool,
  type JsonValue,
} from './types';

/**
 * Which end of the string axis this is, in one sentence, on every read that
 * hands back a `stringIndex`. Getting it backwards is the mistake that still
 * looks plausible: index 0 is the string drawn at the BOTTOM, and the editor
 * draws the high one on top.
 *
 * Written once and shared because two copies of a claim about pitch drift, and
 * the claim is not quite the obvious one: `TuningDef` orders strings physically,
 * so on a REENTRANT tuning (the standard ukulele's high G) the bottom string is
 * not the lowest-pitched one. `read_chord_voicings` is what makes that load
 * bearing — a model told "index 0 is the lowest" reaches for cell 0 when it
 * wants the root of a shape under a bass line, and on a ukulele that is the top
 * note of the chord.
 *
 * The count is passed IN rather than read here: `read_chord_voicings` answers
 * about the instrument it was given and `stringCount()` answers about the open
 * pattern, and those are no longer the same neck.
 */
const stringsLine = (strings: number): string =>
  `${strings} strings, index 0 = the bottom string — the lowest-pitched one (low E on a guitar), EXCEPT on a reentrant ukulele, where the bottom string is the high G.`;

/** The flags a note can carry, as a list of the ones it does. Cheaper for the
 *  model to read than eleven booleans that are almost all absent. */
function articulationsOf(event: NonNullable<ReturnType<typeof getEditingPattern>>['events'][number]): readonly string[] {
  const flags: string[] = [];
  if (event.hammerOn) flags.push('hammerOn');
  if (event.pullOff) flags.push('pullOff');
  if (event.palmMute) flags.push('palmMute');
  if (event.ghost) flags.push('ghost');
  if (event.dead) flags.push('dead');
  if (event.tap) flags.push('tap');
  if (event.tieToNext) flags.push('tieToNext');
  if (event.vibrato) flags.push(`vibrato:${event.vibrato}`);
  const pitch = readNotePitch(event);
  if (pitch.slideIn) flags.push(`slideIn:${pitch.slideIn}`);
  if (pitch.slideOut) flags.push(`slideOut:${pitch.slideOut}`);
  if (pitch.bend) flags.push(`bend:${pitch.bend.kind}`);
  return flags;
}

const readPattern = defineTool<Record<string, never>>({
  name: 'read_pattern',
  description:
    'The pattern currently open for note editing, with every note and its id. If a composition block is open for editing (composition_edit_placement), this is that block\'s own copy — not the library pattern it came from.',
  parameters: noArgs,
  run: () => {
    const pattern = getEditingPattern();
    if (!pattern) return fail('No pattern is open.');
    return ok({
      patternId: pattern.id,
      name: pattern.name,
      instrumentId: patternInstrumentId(pattern),
      strings: stringsLine(stringCount()),
      // The neck is SHORTER than the fret a note may legally carry (the editor
      // keeps one above it so changing instrument stays lossless), and a note
      // past the end is drawn by nothing and played by nothing — so both numbers
      // are reported rather than just the one that reads like a limit.
      frets: fretCount(),
      notesAboveTheNeck: notesAboveNeck(),
      ticksPerQuarterNote: PPQ,
      // The lib fits this to the content on every edit — it is a readout, not a
      // setting, and there is no tool that changes it.
      durationTicks: pattern.durationTicks,
      timeSignature: { ...pattern.timeSignature },
      suggestedBpm: pattern.suggestedBpm,
      loop: pattern.loop,
      // 'custom' for a feel that matches no named preset — a document made
      // elsewhere can hold one, and pattern_set_playback only offers the presets.
      groove: patternGrooveId(),
      editingCompositionBlock: getEditingPlacementId(),
      notes: pattern.events.map((event): JsonValue => {
        const flags = articulationsOf(event);
        return {
          noteId: event.id,
          stringIndex: event.stringIndex,
          fret: event.fret,
          tick: event.startTick,
          durationTicks: event.durationTicks,
          dynamic: event.dynamic ?? null,
          ...(flags.length > 0 ? { articulations: flags } : {}),
        };
      }),
    });
  },
});

const readLibrary = defineTool<Record<string, never>>({
  name: 'read_pattern_library',
  description:
    "The user's saved patterns — the ones composition_place_pattern can place. Built-in patterns are not listed.",
  parameters: noArgs,
  run: () =>
    ok({
      ticksPerQuarterNote: PPQ,
      patterns: getLibraryPatterns().map((pattern): JsonValue => ({
        patternId: pattern.id,
        name: pattern.name,
        instrumentId: pattern.instrumentId,
        durationTicks: pattern.durationTicks,
        noteCount: pattern.events.length,
      })),
    }),
});

/**
 * WHAT A TRACK IS MADE OF, as opposed to where its blocks are.
 *
 * The 2026-08-11 backing-track run built a twelve-bar blues in which every part
 * was one bar stamped twelve times. It had already looked up C7, F7 and G7 and
 * got all three right; it then played one of them for the whole form. Nothing in
 * the system could have told it: the stamp replied `bars: 12, refusedCount: 0`,
 * and this read listed twelve blocks by tick — which is what THREE patterns over
 * twelve bars looks like too. The two arrangements were indistinguishable
 * without counting distinct `fromPatternId`s across a list of ticks, and a model
 * that does not suspect the defect never counts.
 *
 * So the distinction is stated rather than left derivable: `distinctPatterns: 1`
 * beside twelve bars IS the diagnosis, at a glance, with no arithmetic.
 *
 * Grouped by the SNAPSHOT's id — the pattern each block was cut from — because
 * that is what "how many different things does this track play" means. Two
 * blocks cut from one pattern hold two independent copies which may since have
 * been edited apart (`composition_edit_placement`), so this counts sources and
 * not contents; that is the cheap approximation, and it is the one that catches
 * the failure, since a part stamped from one pattern and never edited is the
 * failure.
 *
 * ⚠ THE COUNT IS TRUSTWORTHY IN ONE DIRECTION ONLY, and the field name promises
 * more than it can deliver in the other. `1` really does mean one thing played
 * over and over. Anything ABOVE 1 is not evidence of harmonic motion: twelve
 * one-bar patterns whose notes are identical read as 12, which is exactly the
 * shape a model told "one pattern per chord" could produce by accident. Making
 * it honest upwards means fingerprinting each snapshot's sorted events rather
 * than its id, which is real work for a signal nothing yet acts on; until then
 * this is a detector for the static case and not a score.
 *
 * The parameter type is DERIVED from the seam rather than written out, so a
 * rename inside the lib's `Placement` fails the build here instead of silently
 * matching a structural type that no longer describes anything.
 */
type Placements = ReturnType<typeof getTracks>[number]['placements'];

function trackMadeOf(placements: Placements, barOf: ((tick: number) => number) | null): JsonValue[] {
  const groups = new Map<string, { name: string; positions: number[] }>();
  // Source order is start order — the seam keeps `placements` sorted by
  // `startTick` — so both the groups and the positions inside them come out in
  // the order the track is heard.
  for (const placement of placements) {
    const key = placement.patternSnapshot.id;
    const group = groups.get(key) ?? { name: placement.patternSnapshot.name, positions: [] };
    group.positions.push(barOf ? barOf(placement.startTick) : placement.startTick);
    groups.set(key, group);
  }
  return [...groups].map(([fromPatternId, group]): JsonValue => ({
    fromPatternId,
    name: group.name,
    // Bars, in the units the form is thought in — falling back to ticks only in
    // the signatures where a bar is not a whole number of ticks. Repeats are
    // left in: a pattern at bars [1, 1] is two blocks sounding at once, which is
    // a fact about the arrangement and not a duplicate to collapse.
    ...(barOf ? { atBars: group.positions } : { atTicks: group.positions }),
  }));
}

const readComposition = defineTool<Record<string, never>>({
  name: 'read_composition',
  description:
    'The open composition: its tracks, its mix, and every block placed on it with its id, and the bars it starts and ends in as well as the ticks. Each track also says what it is MADE OF — `distinctPatterns`, how many different patterns it plays (counted by the pattern each block was CUT FROM, so blocks edited apart afterwards still count as one), and `madeOf`, which bars each of them sits at — so a part that follows the changes can be told apart from one pattern repeated across the whole form. `distinctPatterns: 1` against a twelve-bar track is one chord for twelve bars. Also reports what the arrangement is COSTING — notes on strings a track\'s instrument has not got, blocks written for another instrument, and notes a transposition has pushed off the neck (which are dropped from playback with nothing on screen to show it).',
  parameters: noArgs,
  run: () => {
    const composition = getEditingComposition();
    if (!composition) return fail('No composition is open.');
    const tracks = getTracks();
    // Bar numbers, counted FROM 1, alongside every tick — a reply is where a
    // unit conversion is confirmed rather than assumed, and the form the command
    // asked for is in bars. `barConverter` is null exactly where a bar is not a
    // whole number of ticks (a 4/7 bar is 1097.142...), and there the read
    // reports ticks alone rather than bar numbers that are a fraction out. It is
    // the SAME function `composition_place_pattern` decides by, so the write
    // reply and this one can never disagree about whether bars exist.
    const bars = barConverter(composition.timeSignature);
    const barOf = bars ? bars.toBar : null;
    return ok({
      compositionId: composition.id,
      name: composition.name,
      bpm: composition.bpm,
      timeSignature: { ...composition.timeSignature },
      loop: composition.loop,
      groove: compositionGrooveId(),
      masterVolumeDb: composition.masterVolumeDb,
      ticksPerQuarterNote: PPQ,
      totalDurationTicks: totalDurationTicks(),
      editingBlockId: getEditingPlacementId(),
      tracks: tracks.map((track): JsonValue => {
        const instrumentId = trackInstrumentId(track);
        const voice = readTrackVoiceRef(track);
        const madeOf = trackMadeOf(track.placements, barOf);
        return {
          trackId: track.id,
          name: track.name,
          // Picks the track's VOICE and nothing else — not its string set, not
          // its pitch (LIB-GAP(15): only the composition has a tuning).
          instrumentId,
          volumeDb: track.volumeDb,
          muted: track.muted,
          soloed: track.soloed,
          audible: isTrackAudible(track, tracks),
          voiceKey: voice ? voiceKey(voice) : null,
          notesOnStringsThisInstrumentLacks: strandedByInstrument(track, instrumentId),
          blocksWrittenForAnotherInstrument: mismatchedPlacements(track),
          // The count first, because it is the whole answer to "does this part
          // move with the harmony": 1 against a twelve-bar form is one chord for
          // twelve bars, whatever the block list underneath says. Taken FROM the
          // grouping rather than counted separately, so the two can never
          // disagree about what counts as one pattern.
          distinctPatterns: madeOf.length,
          madeOf,
          blocks: track.placements.map((placement): JsonValue => {
            const endTick = placementEndTick(placement);
            return {
              placementId: placement.id,
              // The pattern it was CUT FROM. The block holds its own copy, so
              // this is provenance and not a link. Its NAME is not repeated
              // here — `madeOf` gives it once per pattern instead of once per
              // block, and on an eight-track arrangement that is the difference
              // between a dozen strings and a hundred.
              fromPatternId: placement.patternSnapshot.id,
              // Both ENDS in bars, not just the start. One twelve-bar pattern
              // placed once is `distinctPatterns: 1` over bars 1 to 12 — the
              // static case in its other shape — and with a start bar alone the
              // only way to see the twelve is to divide `endTick` by the bar
              // length, which is the arithmetic this read exists to remove.
              // INCLUSIVE: `endTick` is exclusive, so the last bar the block
              // sounds in is the bar the tick before it falls in.
              ...(barOf
                ? {
                    startBar: barOf(placement.startTick),
                    endBar: barOf(Math.max(placement.startTick, endTick - 1)),
                  }
                : {}),
              startTick: placement.startTick,
              lengthTicks: placementEffectiveLength(placement),
              endTick,
              transposeSemitones: placement.transposeSemitones ?? 0,
              notesDroppedFromPlayback: droppedByTranspose(placement),
            };
          }),
        };
      }),
    });
  },
});

/**
 * AG-09. A READ, and that is the whole point of it.
 *
 * The failure this answers is arithmetic, not judgement: a twelve-bar part over
 * five changes is some seventy fret numbers worked out by hand, on a neck whose
 * tuning the model has to remember, and that pressure is what produced the
 * 1002-note run on 2026-08-09. Handing back the grip removes the KNOWLEDGE
 * burden and leaves the AUTHORSHIP — which of those notes get played, when, for
 * how long and with what articulation is still the model's to decide, and a
 * `pattern_stamp_chord` that decided it would turn every backing track into
 * block chords on the downbeat. There is no write path here on purpose.
 *
 * A BATCH, for `patternTools.ts`'s standing reason: one call per KIND of
 * question carrying the whole list. A twelve-bar blues is one call.
 *
 * ⚠ ONE INSTRUMENT, NAMED IN THE ARGUMENTS, and no pattern need be open. It used
 * to answer for whichever pattern was, and the 2026-08-11 run died of it: three
 * patterns opened first, then `{symbols:['C7','F7','G7']}` three times expecting
 * a guitar, a bass and a ukulele back, and three ukulele answers because only
 * the last-opened pattern is the open one. The harness ended the run on the
 * third — "repeatedly called read_chord_voicings with identical arguments" — and
 * it was right to: the arguments WERE identical, and a loop detector reads
 * arguments, not answers. Three necks is now three calls that differ, which is
 * the property that satisfies it. Many symbols and one neck rather than a list
 * of instruments, because an array of necks buys nothing over three calls and
 * costs the reply its shape.
 *
 * What it deliberately does NOT claim is what any of it will SOUND like.
 * LIB-GAP(15) — a track carries no tuning, only the composition does — is why
 * `compositionAgent`'s prompt forbids the model saying so, and a tool handing
 * back pitch names beside the frets would read as permission to contradict it.
 * The note names here are the CHORD's, which is a fact about the symbol.
 */
const readChordVoicings = defineTool<{ symbols: readonly string[]; instrumentId: string }>({
  name: 'read_chord_voicings',
  description:
    "Where named chords sit on the neck of the instrument you name: for each symbol, the strings and frets of one playable shape. `instrumentId` is required and a bass, a ukulele and a guitar answer differently — asking for a different instrument is a different question, not a repeated call, so a backing track is one call per instrument. Nothing needs to be open: ask before you create anything. Ask for the whole progression in one call. This is MATERIAL TO COMPOSE FROM, not a chord to drop on the downbeat: choose which of the notes to play, in what order, at which ticks, for how long and with what articulation — a bass line takes one note of it at a time, a strummed part spreads it across a bar. `cells` IS the shape — one entry per string it uses, in the same stringIndex/fret spelling pattern_stamp_notes takes. `notes` names the chord's tones and is NOT lined up with `cells`: a shape doubles some tones and may leave one out, so cells[2] is not notes[2] and there is no reading of the reply that makes it so. Nothing here says what pitch will be HEARD once a pattern is placed in a composition, because a track carries no tuning of its own; describe what you WROTE, never how it will sound. A symbol that cannot be read comes back named, and the others still answer.",
  parameters: obj(
    {
      symbols: arr(
        str('A chord symbol — a root and a quality, like "A7", "Cmaj7", "F#m7b5", "G/B".'),
        'The chords to look up, in the order you want them back.',
      ),
      instrumentId: str(
        `Which neck to answer about: ${INSTRUMENT_LIST}. One per call — ask again with a different instrument for the same chords on a different neck.`,
        INSTRUMENT_IDS,
      ),
    },
    ['symbols', 'instrumentId'],
  ),
  run: ({ symbols, instrumentId }) => {
    // Asked once here rather than left to the seam, which refuses per symbol:
    // twelve copies of the same sentence is twelve times the tokens for one
    // fact, and a whole progression refused for a reason that has nothing to do
    // with the chords reads as the chords being at fault.
    //
    // `typeof` rather than a comparison against undefined because the schema
    // says this is a required string and the model can still leave it out — the
    // one argument whose absence used to be answered by guessing.
    const named = typeof instrumentId === 'string' ? instrumentId : '';
    // MEMBERSHIP, asked directly. It used to be inferred from a string count of
    // zero, which conflates "the catalog has never heard of this" with "this
    // instrument has no strings" — and the second is a lib fact this module has
    // no business asserting. The unknown-instrument sentence is the SEAM's, word
    // for word, so the two paths into `chordGrip` cannot describe the same
    // mistake two ways.
    if (named === '' || !INSTRUMENT_IDS.some((known) => known === named)) {
      return fail(
        named === ''
          ? `No instrument was named. This answers about one neck at a time — send instrumentId as one of ${INSTRUMENT_IDS.join(', ')}.`
          : unknownInstrumentRefusal(named),
      );
    }
    const strings = instrumentStringCount(named);

    const voicings: JsonValue[] = [];
    const refused: { label: string; reason: string }[] = [];
    for (const symbol of symbols) {
      const result = chordGrip(symbol, named);
      if (result.ok) {
        voicings.push({
          symbol: result.value.symbol,
          root: result.value.root,
          quality: result.value.type,
          notes: result.value.notes,
          // The same field names `pattern_stamp_notes` takes, so a cell can be
          // carried straight into a note without being translated — translation
          // between two spellings of the string axis being the mistake that
          // still produces a plausible-looking pattern.
          cells: result.value.cells.map((cell): JsonValue => ({
            stringIndex: cell.stringIndex,
            fret: cell.fret,
          })),
        });
      } else {
        // Itemised, in place, so the model can see WHICH chord of the
        // progression it has to respell rather than which position in a list.
        voicings.push({ symbol, refused: result.reason });
        refused.push({ label: symbol, reason: result.reason });
      }
    }
    // Nothing at all answered is a refusal carrying every reason — the same rule
    // `pattern_stamp_notes` follows and `patternTools.ts` argues: a success with
    // no content is the one reply a model cannot recover from. CAPPED through
    // the same helper, for the same reason: a progression of nonsense would
    // otherwise be one full sentence per symbol, and the tenth says nothing the
    // first nine did not. The empty call is the same answer, and is reachable
    // only past the schema's `minItems`.
    if (voicings.length === refused.length) {
      return fail(refused.length === 0 ? 'No chords were sent.' : namedRefusals(refused));
    }
    return ok({
      // Echoed back so the answer says which neck it is about, not just which
      // chords — the fact the old shape left the caller to infer.
      instrumentId: named,
      strings: stringsLine(strings),
      voicings,
    });
  },
});

export const READ_TOOLS: readonly AgentTool[] = [
  readPattern,
  readLibrary,
  readComposition,
  readChordVoicings,
];
