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
import { defineTool, fail, noArgs, ok, type AgentTool, type JsonValue } from './types';

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
      // Stated on every read because getting it backwards is the mistake that
      // still looks plausible: index 0 is the LOW string, and the editor draws
      // the high one on top.
      strings: `${stringCount()} strings, index 0 = lowest (low E on a guitar)`,
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

export const READ_TOOLS: readonly AgentTool[] = [readPattern, readLibrary, readComposition];
