/**
 * The agent's capabilities over the COMPOSITION seam — tracks, the mixer, and
 * the blocks placed on the arrangement grid.
 *
 * Every one of these is `compositionService`. Nothing here touches
 * `composition-ops` or the lib's store: the pure ops write nothing (they return
 * a new `Composition` and drop it on the floor), which passes a unit test and
 * silently loses the user's arrangement in the running app.
 *
 * ── Facts these tools have to state, because they are invisible from here ────
 *
 *   - **A placement is a deep COPY.** Editing a block never touches the library
 *     pattern it was cut from, and editing that pattern never reaches the block.
 *   - **A track has no tuning** — only the composition does (LIB-GAP(15)). A
 *     track's `instrumentId` picks its VOICE, not its string set or its pitch,
 *     so the diagnostics below count STRINGS and never promise audibility.
 *   - **Transposing drops notes off the neck silently** (LIB-GAP(12)), so the
 *     transpose tool reports what it cost.
 *   - **The track cap is a MEMORY limit**, refused at the seam (each track loads
 *     its own sample bank), which is why the refusal says so.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 *
 *   - **Selection** (`selectPlacements`, `selectTrack`) — every write below is
 *     by id; a selection is what a pointer needs instead of ids. The seam
 *     already selects a block it just created, so the user's view follows the
 *     agent without the agent aiming it.
 *   - **Undo / redo** — the user's way out of what the agent did.
 *   - **`ensureComposition`** — App lifecycle. `composition_open_blank` is how
 *     the agent gets one.
 *   - **The transport** (`playbackService`) — nothing here needs to make a
 *     sound to build an arrangement, and a tool that started playback would do
 *     it in a browser tab the user may not be looking at. AG-06/07 own that.
 */
import {
  MAX_COMPOSITION_TRACKS,
  VOLUME_RANGE_DB,
  addPlacement,
  addTrack,
  beginEditGesture,
  closePlacementEditing,
  compositionGrooveId,
  duplicatePlacements,
  endEditGesture,
  listGrooves,
  listTrackInstruments,
  mismatchedPlacements,
  moveTrack,
  movePlacement,
  openBlankComposition,
  openPlacementForEditing,
  removePlacement,
  removeTrack,
  resizePlacement,
  setCompositionBpm,
  setCompositionGroove,
  setCompositionLoop,
  setCompositionName,
  setCompositionTimeSignature,
  setMasterVolumeDb,
  setPlacementTranspose,
  setTrackInstrument,
  setTrackMuted,
  setTrackName,
  setTrackSoloed,
  setTrackVolumeDb,
  splitPlacement,
  strandedByInstrument,
  findTrack,
  type GrooveId,
} from '../../composition/compositionService';
import { PPQ } from '../../patterns/patternService';
import {
  arr,
  bool,
  defineTool,
  fail,
  fromResult,
  int,
  name as nameOf,
  num,
  obj,
  ok,
  str,
  type AgentTool,
  type JsonValue,
} from './types';

const INSTRUMENT_IDS = listTrackInstruments().map((instrument) => instrument.id);
const INSTRUMENT_LIST = listTrackInstruments()
  .map((instrument) => `${instrument.id} (${instrument.name})`)
  .join(', ');
const GROOVE_IDS = listGrooves().map((groove) => groove.id);

const TICKS = `Ticks. ${PPQ} ticks = one quarter note.`;

/**
 * Run several seam writes as ONE undo step.
 *
 * `compositionService` counts bracket depth, so this nests. `endEditGesture` is
 * called with no argument on purpose: the seam's own default is a reference test
 * against the composition it snapshotted, which is a better answer than anything
 * this layer could compute — a batch where every write was refused wrote
 * nothing, and pushes nothing.
 */
function oneUndoStep<T>(write: () => T): T {
  beginEditGesture();
  try {
    return write();
  } finally {
    endEditGesture();
  }
}

// ----------------------------------------------------------------- tracks ---

const openBlank = defineTool<{ name?: string }>({
  name: 'composition_open_blank',
  description:
    'Create an empty composition and open it for arranging. It starts with one track; everything else on the composition side works on whatever composition is open.',
  parameters: obj({ name: nameOf('What to call it.') }),
  run: ({ name }) =>
    fromResult(openBlankComposition(name), (composition) => ({
      compositionId: composition.id,
      name: composition.name,
      bpm: composition.bpm,
      trackIds: composition.tracks.map((track) => track.id),
    })),
});

const addTrackTool = defineTool<{ name?: string; instrumentId?: string }>({
  name: 'composition_add_track',
  description: `Add a track to the open composition. At most ${MAX_COMPOSITION_TRACKS} tracks — that is a memory limit, not a preference: each track loads its own sample bank.`,
  parameters: obj({
    name: nameOf('What to call it. Omit for the next free "Track n".'),
    instrumentId: str(INSTRUMENT_LIST, INSTRUMENT_IDS),
  }),
  run: ({ name, instrumentId }) =>
    fromResult(
      addTrack(name, instrumentId as (typeof INSTRUMENT_IDS)[number] | undefined),
      (track) => ({
        trackId: track.id,
        name: track.name,
        instrumentId: track.instrumentId,
      }),
    ),
});

const removeTrackTool = defineTool<{ trackId: string }>({
  name: 'composition_remove_track',
  description:
    'Remove a track and every block on it. A composition cannot have zero tracks, so removing the last one is refused.',
  parameters: obj({ trackId: str('From read_composition.') }, ['trackId']),
  run: ({ trackId }) => fromResult(removeTrack(trackId), () => ({ trackId })),
});

const renameTrackTool = defineTool<{ trackId: string; name: string }>({
  name: 'composition_rename_track',
  description:
    'Rename a track. The name is what every control on that track is labelled with, so it cannot be blank.',
  parameters: obj({ trackId: str('From read_composition.'), name: nameOf('The new name.') }, [
    'trackId',
    'name',
  ]),
  run: ({ trackId, name }) => fromResult(setTrackName(trackId, name), () => ({ trackId, name })),
});

const moveTrackTool = defineTool<{ trackId: string; toIndex: number }>({
  name: 'composition_move_track',
  description:
    'Move a track to another position in the stack. An index past the end means "put it last".',
  parameters: obj(
    {
      trackId: str('From read_composition.'),
      toIndex: int('0 is the top track.', { min: 0 }),
    },
    ['trackId', 'toIndex'],
  ),
  run: ({ trackId, toIndex }) =>
    fromResult(moveTrack(trackId, toIndex), (index) => ({ trackId, index })),
});

const setTrackInstrumentTool = defineTool<{ trackId: string; instrumentId: string }>({
  name: 'composition_set_track_instrument',
  description:
    "Put a track on another instrument. This chooses the track's VOICE — it does not retune the notes already placed on it, and it CLEARS any voice this track was pointed at. Blocks written for another instrument keep their own strings, so the reply reports how many notes now sit on strings this instrument has not got.",
  parameters: obj(
    { trackId: str('From read_composition.'), instrumentId: str(INSTRUMENT_LIST, INSTRUMENT_IDS) },
    ['trackId', 'instrumentId'],
  ),
  run: ({ trackId, instrumentId }) => {
    const id = instrumentId as (typeof INSTRUMENT_IDS)[number];
    const result = setTrackInstrument(trackId, id);
    if (!result.ok) return fail(result.reason);
    // Read back through the seam, after the write: `strandedByInstrument` is the
    // count the track HOLDS, and the honest phrasing is about strings and not
    // about audibility — LIB-GAP(15), a track has no tuning of its own for
    // anything to be predicted from.
    const track = findTrack(trackId);
    return ok({
      trackId,
      instrumentId,
      notesOnStringsThisInstrumentLacks: track ? strandedByInstrument(track, id) : 0,
      blocksWrittenForAnotherInstrument: track ? mismatchedPlacements(track) : 0,
    });
  },
});

interface MixArgs {
  trackId: string;
  volumeDb?: number;
  muted?: boolean;
  soloed?: boolean;
}

const setTrackMix = defineTool<MixArgs>({
  name: 'composition_set_track_mix',
  description: `A track's level and its mute/solo state. Volume is in dB — 0 is unity, not a midpoint — and is clamped to ${VOLUME_RANGE_DB.min}..${VOLUME_RANGE_DB.max}. Any soloed track anywhere silences every un-soloed track, and mute beats solo: a track that is both is silent. The mix is not part of undo.`,
  parameters: obj(
    {
      trackId: str('From read_composition.'),
      volumeDb: num('0 is unity gain.', { min: VOLUME_RANGE_DB.min, max: VOLUME_RANGE_DB.max }),
      muted: bool('Silence this track.'),
      soloed: bool('Silence every track that is not soloed.'),
    },
    ['trackId'],
  ),
  run: ({ trackId, volumeDb, muted, soloed }) => {
    // No gesture: none of the three pushes an undo step by design (they are
    // settings, not arrangement content), so bracketing them would be a bracket
    // around nothing.
    let storedVolume: number | null = null;
    if (volumeDb !== undefined) {
      const result = setTrackVolumeDb(trackId, volumeDb);
      if (!result.ok) return fail(result.reason);
      storedVolume = result.value;
    }
    if (muted !== undefined) {
      const result = setTrackMuted(trackId, muted);
      if (!result.ok) return fail(result.reason);
    }
    if (soloed !== undefined) {
      const result = setTrackSoloed(trackId, soloed);
      if (!result.ok) return fail(result.reason);
    }
    // Read back, not echoed: the reply is the track's state, which includes the
    // two fields this call did not touch.
    const track = findTrack(trackId);
    return ok({
      trackId,
      volumeDb: storedVolume ?? track?.volumeDb ?? null,
      muted: track?.muted ?? null,
      soloed: track?.soloed ?? null,
    });
  },
});

const setMasterVolume = defineTool<{ volumeDb: number }>({
  name: 'composition_set_master_volume',
  description: `The composition's output level in dB, which every track passes through. 0 is unity; clamped to ${VOLUME_RANGE_DB.min}..${VOLUME_RANGE_DB.max}.`,
  parameters: obj(
    {
      volumeDb: num('0 is unity gain.', { min: VOLUME_RANGE_DB.min, max: VOLUME_RANGE_DB.max }),
    },
    ['volumeDb'],
  ),
  run: ({ volumeDb }) => fromResult(setMasterVolumeDb(volumeDb), (stored) => ({ volumeDb: stored })),
});

// ------------------------------------------------------------- placements ---

const placePattern = defineTool<{
  patternId: string;
  trackId: string;
  atTicks: readonly number[];
}>({
  name: 'composition_place_pattern',
  description:
    'Place a library pattern onto a track, at one or more points in time — all of it one undo step. Each block is a deep COPY of the pattern taken at placement time: editing the pattern afterwards does not change the blocks, and editing a block does not change the pattern.',
  parameters: obj(
    {
      patternId: str('From read_pattern_library.'),
      trackId: str('From read_composition.'),
      atTicks: arr(
        int(`Where the block starts. ${TICKS}`, { min: 0 }),
        'One entry per copy. A block that will not fit at the tick asked for lands in the nearest free slot.',
      ),
    },
    ['patternId', 'trackId', 'atTicks'],
  ),
  run: ({ patternId, trackId, atTicks }) =>
    oneUndoStep(() => {
      const placed: JsonValue[] = [];
      const refused: { atTick: number; reason: string }[] = [];
      for (const atTick of atTicks) {
        const result = addPlacement(patternId, trackId, atTick);
        if (result.ok) placed.push({ placementId: result.value, atTick });
        else refused.push({ atTick, reason: result.reason });
      }
      return placed.length === 0 && refused.length > 0
        ? fail(refused[0].reason)
        : ok({ placed, refused });
    }),
});

const movePlacementTool = defineTool<{
  placementId: string;
  trackId: string;
  atTick: number;
}>({
  name: 'composition_move_placement',
  description:
    'Move a block, possibly to another track. Blocks never overlap or push each other, so a block lands in the free slot nearest the tick asked for — the reply says where it actually is.',
  parameters: obj(
    {
      placementId: str('From read_composition.'),
      trackId: str('The track it should end up on — its own is fine.'),
      atTick: int(TICKS, { min: 0 }),
    },
    ['placementId', 'trackId', 'atTick'],
  ),
  run: ({ placementId, trackId, atTick }) =>
    fromResult(movePlacement(placementId, trackId, atTick), (landed) => ({
      placementId,
      ...landed,
    })),
});

const resizePlacementTool = defineTool<{ placementId: string; lengthTicks: number }>({
  name: 'composition_resize_placement',
  description:
    "Truncate a block. It plays only its first `lengthTicks`; the copy underneath is untouched, so this reverses. Clamped to at least a beat, at most the pattern's own length, and at most the gap before the next block — the length that stuck comes back.",
  parameters: obj(
    { placementId: str('From read_composition.'), lengthTicks: int(TICKS, { min: 1 }) },
    ['placementId', 'lengthTicks'],
  ),
  run: ({ placementId, lengthTicks }) =>
    fromResult(resizePlacement(placementId, lengthTicks), (applied) => ({
      placementId,
      lengthTicks: applied,
    })),
});

const splitPlacementTool = defineTool<{ placementId: string; atTick: number }>({
  name: 'composition_split_placement',
  description:
    'Cut a block in two at a point in time. BOTH halves are new blocks with new ids and the original id stops existing — the new ids come back, so use those from then on. The cut has to fall inside the block.',
  parameters: obj(
    {
      placementId: str('From read_composition.'),
      atTick: int(`Where to cut, in composition time. ${TICKS}`, { min: 0 }),
    },
    ['placementId', 'atTick'],
  ),
  run: ({ placementId, atTick }) =>
    fromResult(splitPlacement(placementId, atTick), (ids) => ({ placementIds: ids })),
});

const transposePlacementTool = defineTool<{ placementId: string; semitones: number }>({
  name: 'composition_transpose_placement',
  description:
    'Shift a block up or down at play time, without rewriting its notes. Clamped to ±24. A note pushed off the end of the neck is DROPPED from playback with nothing on screen to show it — the reply says how many, so check it.',
  parameters: obj(
    {
      placementId: str('From read_composition.'),
      semitones: int('Positive is up. 12 is an octave.', { min: -24, max: 24 }),
    },
    ['placementId', 'semitones'],
  ),
  run: ({ placementId, semitones }) =>
    fromResult(setPlacementTranspose(placementId, semitones), (applied) => ({
      placementId,
      semitones: applied.semitones,
      notesDroppedFromPlayback: applied.droppedNotes,
    })),
});

const duplicatePlacementsTool = defineTool<{
  placementIds: readonly string[];
  deltaTicks: number;
  trackId?: string;
}>({
  name: 'composition_duplicate_placements',
  description:
    'Copy blocks to a later (or earlier) point, as one undo step — how a section is repeated. The new ids come back, but in the arrangement\'s own order (track by track, then by time) rather than the order you listed the originals in, so pair them by position and not by index.',
  parameters: obj(
    {
      placementIds: arr(str('A block id from read_composition.'), 'The blocks to copy.'),
      deltaTicks: int(`How far to offset the copies. ${TICKS}`),
      trackId: str('Send every copy to this track. Omit to copy each within its own track.'),
    },
    ['placementIds', 'deltaTicks'],
  ),
  run: ({ placementIds, deltaTicks, trackId }) =>
    oneUndoStep(() =>
      fromResult(duplicatePlacements(placementIds, deltaTicks, trackId), (ids) => ({
        placementIds: ids,
      })),
    ),
});

const removePlacementsTool = defineTool<{ placementIds: readonly string[] }>({
  name: 'composition_remove_placements',
  description: 'Delete blocks from the arrangement, as one undo step.',
  parameters: obj(
    { placementIds: arr(str('A block id from read_composition.'), 'The blocks to delete.') },
    ['placementIds'],
  ),
  run: ({ placementIds }) =>
    oneUndoStep(() => {
      const removed: string[] = [];
      const refused: { placementId: string; reason: string }[] = [];
      for (const placementId of placementIds) {
        const result = removePlacement(placementId);
        if (result.ok) removed.push(placementId);
        else refused.push({ placementId, reason: result.reason });
      }
      return removed.length === 0 && refused.length > 0
        ? fail(refused[0].reason)
        : ok({ removed, refused });
    }),
});

// ------------------------------------------------------- placement editing ---

const editPlacement = defineTool<{ placementId: string }>({
  name: 'composition_edit_placement',
  description:
    "Point the note tools at ONE block, so pattern_stamp_notes and the rest edit that block's own copy instead of a library pattern. Nothing else in the composition is affected, and the library pattern the block was cut from is not touched. Call composition_stop_editing_placement when done.",
  parameters: obj({ placementId: str('From read_composition.') }, ['placementId']),
  run: ({ placementId }) =>
    fromResult(openPlacementForEditing(placementId), (id) => ({ placementId: id })),
});

const stopEditingPlacement = defineTool<Record<string, never>>({
  name: 'composition_stop_editing_placement',
  description:
    'Stop editing a block and put the note tools back on the pattern that was open before. Safe to call when no block is open.',
  parameters: obj({}),
  run: () => fromResult(closePlacementEditing(), () => ({ editing: null })),
});

// ---------------------------------------------------------------- settings ---

interface SettingsArgs {
  name?: string;
  bpm?: number;
  timeSignature?: { numerator: number; denominator: number };
  loop?: boolean;
  groove?: GrooveId;
}

const setSettings = defineTool<SettingsArgs>({
  name: 'composition_set_settings',
  description:
    "The whole composition's name, tempo, time signature, loop and feel. Send only what you want to change. None of these is part of undo.",
  parameters: obj({
    name: nameOf('What to call the composition.'),
    bpm: num('Tempo, pushed into the metronome when playback starts.', { min: 20, max: 400 }),
    timeSignature: obj(
      {
        numerator: int('Beats per bar.', { min: 1, max: 32 }),
        denominator: int('What kind of note gets the beat.', { min: 1, max: 32 }),
      },
      ['numerator', 'denominator'],
    ),
    loop: bool('Whether arrangement playback repeats.'),
    groove: str(
      `Feel: ${listGrooves()
        .map((groove) => `${groove.id} (${groove.name})`)
        .join(', ')}.`,
      GROOVE_IDS,
    ),
  }),
  run: ({ name, bpm, timeSignature, loop, groove }) => {
    const named = name === undefined ? null : setCompositionName(name);
    const writes = [
      named,
      bpm === undefined ? null : setCompositionBpm(bpm),
      timeSignature === undefined ? null : setCompositionTimeSignature(timeSignature),
      loop === undefined ? null : setCompositionLoop(loop),
      groove === undefined ? null : setCompositionGroove(groove),
    ];
    const refused = writes.find((result) => result !== null && !result.ok);
    // Reported rather than swallowed even though earlier writes in the same call
    // may have landed: the alternative is a partial application the caller
    // believes is total.
    if (refused && !refused.ok) return fail(refused.reason);
    return ok({
      // The seam TRIMS the name, so the stored one is what comes back — echoing
      // the argument would report a value the document does not hold.
      name: named?.ok ? named.value : null,
      bpm: bpm ?? null,
      timeSignature: timeSignature ? { ...timeSignature } : null,
      loop: loop ?? null,
      groove: compositionGrooveId(),
    });
  },
});

export const COMPOSITION_TOOLS: readonly AgentTool[] = [
  openBlank,
  addTrackTool,
  removeTrackTool,
  renameTrackTool,
  moveTrackTool,
  setTrackInstrumentTool,
  setTrackMix,
  setMasterVolume,
  placePattern,
  movePlacementTool,
  resizePlacementTool,
  splitPlacementTool,
  transposePlacementTool,
  duplicatePlacementsTool,
  removePlacementsTool,
  editPlacement,
  stopEditingPlacement,
  setSettings,
];
