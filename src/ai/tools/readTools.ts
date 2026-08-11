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
  notesAboveNeck,
  patternGrooveId,
  patternInstrumentId,
  stringCount,
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
 */
const stringsLine = (): string =>
  `${stringCount()} strings, index 0 = the bottom string — the lowest-pitched one (low E on a guitar), EXCEPT on a reentrant ukulele, where the bottom string is the high G.`;

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
      strings: stringsLine(),
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

const readComposition = defineTool<Record<string, never>>({
  name: 'read_composition',
  description:
    'The open composition: its tracks, its mix, and every block placed on it with its id. Also reports what the arrangement is COSTING — notes on strings a track\'s instrument has not got, blocks written for another instrument, and notes a transposition has pushed off the neck (which are dropped from playback with nothing on screen to show it).',
  parameters: noArgs,
  run: () => {
    const composition = getEditingComposition();
    if (!composition) return fail('No composition is open.');
    const tracks = getTracks();
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
          blocks: track.placements.map((placement): JsonValue => ({
            placementId: placement.id,
            // The pattern it was CUT FROM. The block holds its own copy, so
            // this is provenance and not a link.
            fromPatternId: placement.patternSnapshot.id,
            name: placement.patternSnapshot.name,
            startTick: placement.startTick,
            lengthTicks: placementEffectiveLength(placement),
            endTick: placementEndTick(placement),
            transposeSemitones: placement.transposeSemitones ?? 0,
            notesDroppedFromPlayback: droppedByTranspose(placement),
          })),
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
 * What it deliberately does NOT claim is what any of it will SOUND like.
 * LIB-GAP(15) — a track carries no tuning, only the composition does — is why
 * `compositionAgent`'s prompt forbids the model saying so, and a tool handing
 * back pitch names beside the frets would read as permission to contradict it.
 * The note names here are the CHORD's, which is a fact about the symbol.
 */
const readChordVoicings = defineTool<{ symbols: readonly string[] }>({
  name: 'read_chord_voicings',
  description:
    "Where named chords sit on the open pattern's neck: for each symbol, the strings and frets of one playable shape, on the neck of THIS pattern's instrument as it stands right now — a bass and a ukulele answer differently from a guitar, so open the pattern and set its instrument BEFORE you ask. Ask for the whole progression in one call. This is MATERIAL TO COMPOSE FROM, not a chord to drop on the downbeat: choose which of the notes to play, in what order, at which ticks, for how long and with what articulation — a bass line takes one note of it at a time, a strummed part spreads it across a bar. `cells` IS the shape — one entry per string it uses, in the same stringIndex/fret spelling pattern_stamp_notes takes. `notes` names the chord's tones and is NOT lined up with `cells`: a shape doubles some tones and may leave one out, so cells[2] is not notes[2] and there is no reading of the reply that makes it so. Nothing here says what pitch will be HEARD once a pattern is placed in a composition, because a track carries no tuning of its own; describe what you WROTE, never how it will sound. A symbol that cannot be read comes back named, and the others still answer.",
  parameters: obj(
    {
      symbols: arr(
        str('A chord symbol — a root and a quality, like "A7", "Cmaj7", "F#m7b5", "G/B".'),
        'The chords to look up, in the order you want them back.',
      ),
    },
    ['symbols'],
  ),
  run: ({ symbols }) => {
    // Asked once here rather than left to the seam, which refuses per symbol:
    // twelve copies of the same sentence is twelve times the tokens for one
    // fact, and `read_pattern` already answers this case in these words.
    const pattern = getEditingPattern();
    if (!pattern) return fail('No pattern is open.');

    const voicings: JsonValue[] = [];
    const refused: { label: string; reason: string }[] = [];
    for (const symbol of symbols) {
      const result = chordGrip(symbol);
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
      instrumentId: patternInstrumentId(pattern),
      strings: stringsLine(),
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
