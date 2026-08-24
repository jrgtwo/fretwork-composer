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
 *   - **Undo / redo** — the user's way out of what the agent did. (Both are
 *     inert while a job holds the document, and cancelling the job is the way
 *     out during one; see the job lock in `compositionService`.)
 *   - **`ensureComposition`** — App lifecycle. `composition_open_blank` is how
 *     the agent gets one.
 *   - **The transport** (`playbackService`) — nothing here needs to make a
 *     sound to build an arrangement, and a tool that started playback would do
 *     it in a browser tab the user may not be looking at. AG-06/07 own that.
 */
import {
  MAX_COMPOSITION_TRACKS,
  VOLUME_RANGE_DB,
  PAN_RANGE,
  TRACK_INPUT_GAIN_RANGE_DB,
  setTrackInputGainDb,
  addPlacement,
  addTrack,
  beginEditGesture,
  closePlacementEditing,
  compositionGrooveId,
  duplicatePlacements,
  endEditGesture,
  findPlacement,
  findTrack,
  getEditingComposition,
  getTracks,
  listGrooves,
  listTrackInstruments,
  mismatchedPlacements,
  moveTrack,
  movePlacement,
  openBlankComposition,
  openPlacementForEditing,
  placementEndTick,
  removePlacement,
  removeTrack,
  resizePlacement,
  setCompositionBpm,
  setCompositionGroove,
  setCompositionLoop,
  setCompositionName,
  setCompositionSubdivision,
  setCompositionTimeSignature,
  setMasterVolumeDb,
  setPlacementTranspose,
  setTrackInstrument,
  setTrackMuted,
  setTrackName,
  setTrackSoloed,
  setTrackVolumeDb,
  setTrackPan,
  splitPlacement,
  SUBDIVISION_OPTIONS,
  compositionEndTick,
  deleteComposition,
  duplicateComposition,
  getLibraryCompositions,
  openComposition,
  renameComposition,
  strandedByInstrument,
  ticksPerBar,
  trackInstrumentId,
  type GrooveId,
  type SubdivisionId,
} from '../../composition/compositionService';
import { PPQ, findLibraryPattern } from '../../patterns/patternService';
import { barConverter, type BarConverter } from './barMath';
import {
  arr,
  bool,
  defineTool,
  fail,
  fromResult,
  int,
  name as nameOf,
  namedRefusals,
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
 *
 * ⚠ The JOB-LOCK exemption is deliberately NOT here, though this is the obvious
 * place for it. Only three tools batch (`composition_place_pattern`,
 * `composition_duplicate_placements`, `composition_remove_placements`); the
 * remaining fifteen do not, and each would be refused by its own job's lock. Nor
 * can this wrapper simply be put around all eighteen: bracketing a SETTING makes
 * it undoable, and the mix, the naming and the tempo push no undo step by design.
 * The exemption is applied to every tool the app ships instead — see `jobWrite`
 * in `./index.ts`, which also covers `voice_set_for_track`, the one tool outside
 * this file that reaches the composition seam.
 */
function oneUndoStep<T>(write: () => T): T {
  beginEditGesture();
  try {
    return write();
  } finally {
    endEditGesture();
  }
}

/**
 * The library, so a caller with no pointer can find the other compositions.
 *
 * Reported as ids plus what tells them apart — nothing here can be derived from
 * an id, and `read_composition` answers only for the one that is open. The
 * summary is the same pair the rail's rows show, for the reason the rail shows
 * it: with every blank arriving as "Untitled composition N", the name is the
 * least distinguishing thing about a row until someone renames it.
 */
const listCompositions = defineTool<Record<string, never>>({
  name: 'composition_list',
  description:
    'List every composition in the library, with the one currently open marked. Use it to find a composition to open, rename, copy or delete — every other composition tool works on whatever is open.',
  parameters: obj({}),
  run: () => {
    const openId = getEditingComposition()?.id ?? null;
    return ok({
      openCompositionId: openId,
      compositions: getLibraryCompositions().map((composition) => ({
        compositionId: composition.id,
        name: composition.name,
        isOpen: composition.id === openId,
        trackCount: composition.tracks.length,
        bars: Math.ceil(
          compositionEndTick(composition) / ticksPerBar(composition.timeSignature),
        ),
      })),
    });
  },
});

/**
 * ⚠ REFUSED WHILE A JOB IS RUNNING, and unlike almost everything else here that
 * refusal reaches the AGENT too. Switching composition mid-job destroys the
 * rollback a cancel depends on — the seam says why on `openComposition`. So a
 * run that wants to work on another composition has to be started against it,
 * not switched into halfway.
 */
const openCompositionTool = defineTool<{ compositionId: string }>({
  name: 'composition_open',
  description:
    'Open another composition for arranging, by id from composition_list. Everything else on the composition side then works on it. Refused while a generation job is running.',
  parameters: obj({ compositionId: str('From composition_list.') }, ['compositionId']),
  run: ({ compositionId }) =>
    fromResult(openComposition(compositionId), (composition) => ({
      compositionId: composition.id,
      name: composition.name,
      bpm: composition.bpm,
      trackIds: composition.tracks.map((track) => track.id),
    })),
});

const renameCompositionTool = defineTool<{ compositionId: string; name: string }>({
  name: 'composition_rename',
  description:
    'Rename a composition by id — it need not be the one that is open. Use composition_set_settings to rename the open one without knowing its id.',
  parameters: obj(
    { compositionId: str('From composition_list.'), name: nameOf('The new name.') },
    ['compositionId', 'name'],
  ),
  run: ({ compositionId, name }) =>
    fromResult(renameComposition(compositionId, name), (composition) => ({
      compositionId: composition.id,
      name: composition.name,
    })),
});

/**
 * The copy is NOT opened, which the description says out loud because it is the
 * one thing a caller would otherwise assume: `composition_open_blank` opens what
 * it makes, and two creation tools behaving differently is worth a sentence.
 */
const duplicateCompositionTool = defineTool<{ compositionId: string }>({
  name: 'composition_duplicate',
  description:
    'Copy a composition, its tracks and its blocks. The copy is NOT opened — follow with composition_open if you want to work in it. Useful before a change you may want to undo across a save.',
  parameters: obj({ compositionId: str('From composition_list.') }, ['compositionId']),
  run: ({ compositionId }) =>
    fromResult(duplicateComposition(compositionId), (composition) => ({
      compositionId: composition.id,
      name: composition.name,
    })),
});

/**
 * Deleting the OPEN composition leaves nothing open, deliberately — the page has
 * an empty state for it and the seam does not chase a successor. Said in the
 * description because a caller that assumed otherwise would follow this with a
 * write and get "No composition is open", which reads as the delete having
 * broken something.
 */
const deleteCompositionTool = defineTool<{ compositionId: string }>({
  name: 'composition_delete',
  description:
    'Delete a composition and its blocks. The patterns its blocks were cut from are NOT deleted. Cannot be undone. If it was the open one, nothing is open afterwards — open another first if you need one. Refused while a generation job is running.',
  parameters: obj({ compositionId: str('From composition_list.') }, ['compositionId']),
  run: ({ compositionId }) =>
    fromResult(deleteComposition(compositionId), (composition) => ({
      compositionId: composition.id,
      name: composition.name,
      openCompositionId: getEditingComposition()?.id ?? null,
    })),
});

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

/**
 * The tracks that were already there, on this instrument, with nothing on them.
 *
 * ⚠ A REPLY FIELD, NOT A REFUSAL. Two tracks on one instrument is a real
 * arrangement — a clean rhythm and a distorted lead are exactly that — so this
 * stays on the line the placement and stamp checks draw: a refusal is for what
 * is provably impossible, and a fact the caller could not otherwise see at the
 * moment it matters is what a reply is for.
 *
 * The 2026-08-11 backing-track run is what it is for. The composition held ONE
 * track — named 'Guitar 1', on guitar, empty — and the run left it alone and
 * added a SECOND 'Guitar 1' on guitar. The finished arrangement has two tracks
 * of that name, one of them empty, and the next run to read it has to work out
 * which is which. Nothing said so while there was still a cheap way out.
 *
 * The instrument is compared as `trackInstrumentId` RESOLVES it — the id
 * `read_composition` reports — so a loaded track carrying an id the lib no
 * longer has is matched by what the caller was told it is, not by what is
 * stored, and the two replies cannot disagree about which instrument a track is
 * on.
 */
const addTrackTool = defineTool<{ name?: string; instrumentId?: string }>({
  name: 'composition_add_track',
  description: `Add a track to the open composition. At most ${MAX_COMPOSITION_TRACKS} tracks — that is a memory limit, not a preference: each track loads its own sample bank. The reply says how many slots are left, and names an empty track already on the same instrument if there is one.`,
  parameters: obj({
    name: nameOf('What to call it. Omit for the next free "Track n".'),
    instrumentId: str(INSTRUMENT_LIST, INSTRUMENT_IDS),
  }),
  run: ({ name, instrumentId }) => {
    const result = addTrack(name, instrumentId as (typeof INSTRUMENT_IDS)[number] | undefined);
    if (!result.ok) return fail(result.reason);
    const track = result.value;
    // Read the whole composition BACK rather than reasoning from the argument:
    // `instrumentId` is optional here and the seam picks the default when it is
    // omitted, so the instrument to compare against is the one the new track
    // actually got.
    const tracks = getTracks();
    const instrument = trackInstrumentId(track);
    const twins = tracks.filter(
      (other) =>
        other.id !== track.id &&
        other.placements.length === 0 &&
        trackInstrumentId(other) === instrument,
    );
    // Only the FIRST is named, the way a stacking refusal names the block in the
    // way: the point is that one exists and can be reached by id, and a list of
    // up to seven ids is prompt budget spent re-reporting a read. The COUNT is
    // what carries the rest, and it is worded from one number rather than from
    // two — "a second empty guitar track" followed by "1 other empty guitar
    // track as well" was a reply disagreeing with itself in consecutive
    // sentences, which is the failure the rest of this layer exists to stop.
    const empty = twins.length + 1;
    const tally =
      empty === 2
        ? `so this is a second empty ${instrument} track`
        : `so this composition now has ${empty} empty ${instrument} tracks`;
    return ok({
      trackId: track.id,
      name: track.name,
      instrumentId: track.instrumentId,
      // One number, and it answers the question the cap's refusal otherwise
      // answers a round trip too late — a job planning parts can see the budget
      // before it spends the slot rather than after. No clamp: the write above
      // succeeded, so the seam had a slot free and `tracks` is at most the cap.
      // `max(…, 1)` is about the other end — a document that vanished between
      // the write and this read must not report every slot free.
      tracksRemaining: MAX_COMPOSITION_TRACKS - Math.max(tracks.length, 1),
      ...(twins.length === 0
        ? {}
        : {
            warning: `Track "${twins[0].name}" (${twins[0].id}) was already on ${instrument} with nothing on it, ${tally}. Two ${instrument} tracks are a real arrangement where they are two different parts — but if this is THAT part, put the blocks on ${twins[0].id}, carry this name over to it with composition_rename_track, and remove this one with composition_remove_track.`,
          }),
    });
  },
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
  pan?: number;
  /** Drive into the track's own instrument, ahead of its amp — not loudness. */
  inputGainDb?: number;
  muted?: boolean;
  soloed?: boolean;
}

const setTrackMix = defineTool<MixArgs>({
  name: 'composition_set_track_mix',
  description: `A track's level, how hard it drives its own instrument, its place in the stereo field, and its mute/solo state. Volume is in dB — 0 is unity, not a midpoint — and is clamped to ${VOLUME_RANGE_DB.min}..${VOLUME_RANGE_DB.max}. Pan runs ${PAN_RANGE.min} (hard left) to ${PAN_RANGE.max} (hard right), 0 centre; spreading parts across it is what keeps several tracks from piling up on the same spot. inputGainDb is NOT loudness: it sits at the front of the instrument's chain, ahead of its amp, so it changes how hard the amp is driven and therefore how distorted the track sounds — turning volumeDb down on a track that is distorting gives you a quieter copy of the same distortion, and inputGainDb is the one that cleans it up. Any soloed track anywhere silences every un-soloed track, and mute beats solo: a track that is both is silent. The mix is not part of undo.`,
  parameters: obj(
    {
      trackId: str('From read_composition.'),
      volumeDb: num('0 is unity gain.', { min: VOLUME_RANGE_DB.min, max: VOLUME_RANGE_DB.max }),
      pan: num('-1 hard left, 0 centre, +1 hard right.', {
        min: PAN_RANGE.min,
        max: PAN_RANGE.max,
      }),
      inputGainDb: num(
        'How hard this track drives its instrument, in dB, before the amp. 0 is unity. Negative cleans up a distorting track; positive pushes it harder.',
        { min: TRACK_INPUT_GAIN_RANGE_DB.min, max: TRACK_INPUT_GAIN_RANGE_DB.max },
      ),
      muted: bool('Silence this track.'),
      soloed: bool('Silence every track that is not soloed.'),
    },
    ['trackId'],
  ),
  run: ({ trackId, volumeDb, pan, inputGainDb, muted, soloed }) => {
    // No gesture: none of the three pushes an undo step by design (they are
    // settings, not arrangement content), so bracketing them would be a bracket
    // around nothing.
    let storedVolume: number | null = null;
    if (volumeDb !== undefined) {
      const result = setTrackVolumeDb(trackId, volumeDb);
      if (!result.ok) return fail(result.reason);
      storedVolume = result.value;
    }
    // Reported like the volume and for the same reason: the seam clamps, and a
    // caller that asked for 2 needs to be told it got 1 rather than discover it
    // by ear it cannot use.
    let storedPan: number | null = null;
    if (pan !== undefined) {
      const result = setTrackPan(trackId, pan);
      if (!result.ok) return fail(result.reason);
      storedPan = result.value;
    }
    // Reported like the volume and the pan, for the same reason: the seam
    // clamps, and a caller that asked for +30 needs to be told it got +24.
    let storedInputGain: number | null = null;
    if (inputGainDb !== undefined) {
      const result = setTrackInputGainDb(trackId, inputGainDb);
      if (!result.ok) return fail(result.reason);
      storedInputGain = result.value;
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
      // `?? 0` before `?? null`: a track that has never been panned reads as
      // centred, which is where it is, rather than as unknown.
      pan: storedPan ?? track?.pan ?? 0,
      // `?? 0` before `?? null` for pan's reason — a track that has never had an
      // input gain set is running at unity, which is a fact, not an unknown.
      inputGainDb: storedInputGain ?? track?.inputGainDb ?? 0,
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

/**
 * `atBars` vs `atTicks` — exactly one, enforced HERE and not in the schema.
 *
 * `JsonSchema` has no `oneOf`/`anyOf` on purpose (see its header): a schema the
 * validator cannot check is not enforcing anything, and widening the subset for
 * one tool would make that guarantee conditional. So the exclusivity is a
 * returned refusal like any other seam refusal — and, like any other, it names
 * the argument it wants rather than reporting that something was wrong.
 *
 * Both forms stay. A placement that does not begin on a barline is legitimate —
 * a pickup, a part entering on the and-of-four — and is unsayable in bars.
 */
const PICK_ONE_POSITION =
  'You sent neither `atBars` nor `atTicks`, so there is nowhere to put this. Send exactly one: `atBars` for blocks that start on barlines, or `atTicks` for a start that falls between them.';
const NOT_BOTH_POSITIONS =
  'You sent both `atBars` and `atTicks`. Send exactly one: `atBars` if the blocks start on barlines, `atTicks` if they do not.';

/** The unit the caller asked in, which every sentence below answers in. */
type Unit = 'bar' | 'tick';

/** A stretch of a track that is already spoken for, named as a refusal names it. */
interface Occupied {
  readonly label: string;
  readonly start: number;
  readonly end: number;
  /** Whether this block is another COPY of the pattern being placed. It decides
   *  which advice the refusal gives, and it is knowable exactly: a block carries
   *  the id of the pattern it was cut from. */
  readonly samePattern: boolean;
}

/** The earliest tick at or after this one that the caller can actually SAY. A
 *  bar-form caller can only start on a barline, so a tick part-way through a bar
 *  costs the whole of it — the bar the previous block is still sounding in is
 *  not an answer to "where next". */
function sayableStart(tick: number, unit: Unit, bars: BarConverter | null): number {
  if (unit === 'tick' || !bars) return tick;
  const into = bars.ticksIntoBar(tick);
  return into === 0 ? tick : tick + (bars.ticksPerBar - into);
}

/** When a block ending at `endTick` frees the ground up, in the caller's unit. */
function freesUpAt(endTick: number, unit: Unit, bars: BarConverter | null): number {
  const tick = sayableStart(endTick, unit, bars);
  return unit === 'bar' && bars ? bars.toBar(tick) : tick;
}

/**
 * Where the next copy may actually go, in the caller's unit: past the copy in
 * front of it, past anything ALREADY on the track, and on a barline if the
 * caller is counting in bars.
 *
 * ⚠ The track is WALKED, not stepped over once. Advice that clears the copies
 * and then lands on an existing block is a second refusal — it costs the exact
 * round trip this whole feature exists to save, and it is the common case: a
 * track being filled with a second pattern. (The lib walks the same gaps in
 * `clampStartToFreeSlot`, which is `movePlacement`'s and is not re-exported
 * through the seams, so this is hand-rolled because it has to be.)
 */
function nextFreeSlot(
  from: number,
  length: number,
  // Only the extent matters here — the label and the provenance are the reason
  // sentence's business — so this takes the narrower shape and the caller can
  // hand it the copies THIS call is keeping alongside what is already down.
  occupied: readonly { readonly start: number; readonly end: number }[],
  unit: Unit,
  bars: BarConverter | null,
): number {
  let tick = sayableStart(from, unit, bars);
  // Each pass jumps to the end of a block strictly later than the last, so one
  // pass per block is the most this can need and it cannot cycle.
  for (let i = 0; i <= occupied.length; i += 1) {
    const blocking = occupied.find((block) => block.start < tick + length && block.end > tick);
    if (!blocking) break;
    tick = sayableStart(blocking.end, unit, bars);
  }
  return unit === 'bar' && bars ? bars.toBar(tick) : tick;
}

/** The pattern's length as a SPACING — the number the caller has to step BY, in
 *  the unit it is stepping in. Null where that unit cannot say it: a 1920-tick
 *  pattern in 1440-tick bars is a bar and a third, and "space the copies 1920
 *  ticks apart" is not actionable by a caller whose only vocabulary is `atBars`.
 *  The free-slot half of the sentence is bar-valued either way and carries it
 *  alone there. */
function spacingPhrase(length: number, unit: Unit, bars: BarConverter | null): string | null {
  if (unit === 'tick') return `${length} ticks`;
  if (!bars || length % bars.ticksPerBar !== 0) return null;
  const inBars = length / bars.ticksPerBar;
  return `${inBars} bar${inBars === 1 ? '' : 's'}`;
}

/** The pattern's length as a STATEMENT. A tick count is honest even for a caller
 *  that cannot step by it, which is why this has no null. */
function lengthPhrase(length: number, unit: Unit, bars: BarConverter | null): string {
  return spacingPhrase(length, unit, bars) ?? `${length} ticks`;
}

/**
 * The refusal a placement can PROVE from its own arguments — or null, the
 * normal answer.
 *
 * ⚠ RUNS BEFORE `oneUndoStep` OPENS ITS BRACKET, for `unplayableAsSent`'s
 * reason in `patternTools`: nothing is written, so there is nothing to restore
 * and no step to push. Same category, too — `addPlacementToTrack` writes
 * `startTick` verbatim and only re-sorts (`clampStartToFreeSlot` is
 * `movePlacement`'s behaviour and is not on this path), so where a block will
 * land is known before the call, and so is the length of everything already on
 * the track. Both collisions are therefore decidable up front, unlike the
 * stamp's collisions with notes ALREADY in the pattern.
 *
 * The 2026-08-11 run is what this is for. It sent a four-bar pattern to bars
 * [1, 2, 3, 4], got four stacked blocks and an after-the-fact warning, removed
 * every block on the track and thought again — three to five steps a cycle,
 * twice, and it ran out of budget. The warning was true and too late: the fix
 * is a sentence that says what to do BEFORE the mess exists, in the units the
 * caller used and with the pattern's own length in it.
 *
 * ⚠ THE ADVICE BRANCHES ON *WHAT* IS IN THE WAY, because one recovery is right
 * and the other is a loop. Spacing the copies apart is the answer when the
 * obstacle is another copy of the same pattern — the caller asked for the same
 * thing twice too close together. It is the WRONG answer when the obstacle is a
 * different pattern: those are two PARTS, they are meant to sound at the same
 * time, and moving one later does not make it play with the other. The same
 * 2026-08-11 run ended with a twelve-bar rhythm pattern laid over four one-bar
 * chord blocks on one track — told to space them, it would have pushed the
 * chords to bar 13 and destroyed the arrangement rather than putting the second
 * part on a second track. We can always tell the two apart: every block carries
 * the id of the pattern it was cut from, and the call names the pattern being
 * placed.
 *
 * NOT a LIB-GAP. Placements have to be expressible anywhere the caller points
 * and the arrangement grid relies on that; this refuses a CALL, it does not
 * mask a defect, so there is no deletion condition to write down.
 */
function wouldStack(
  asked: readonly { asked: number; tick: number }[],
  occupied: readonly Occupied[],
  length: number,
  unit: Unit,
  bars: BarConverter | null,
  roomForAnotherTrack: boolean,
): string | null {
  // Sorted so "what is in front of this one" is the question the loop asks. The
  // caller's order is not touched anywhere else — the labels below carry the
  // numbers it sent, not indices into a list it did not sort.
  const order = [...asked].sort((a, b) => a.tick - b.tick);
  const collisions: { label: string; reason: string }[] = [];
  // The copies still standing, which is what a later copy is measured against.
  // ⚠ Chaining off a REJECTED one names ground nothing will ever occupy: for
  // bars [1, 2, 3, 4] under a four-bar pattern, bar 3 measured against bar 2
  // reads "not free until bar 6", and bar 2 is never placed. Measured against
  // what survives instead, every reason points at a copy that will really be
  // there — and the surviving subset is itself a placement that would be
  // accepted, so following the list is progress rather than another guess.
  const kept: { asked: number; tick: number }[] = [];
  // The EARLIEST position that was turned away, which is the one the advice has
  // to find a home for. Distinct from `kept[0]` and the difference matters: a
  // survivor is ground the caller already had right.
  let refused: { asked: number; tick: number } | null = null;
  let selfCollisions = 0;
  let trackCollisions = 0;
  // Split by WHAT was in the way, not just how often: a call can be blocked by
  // an earlier copy of itself at one position and by somebody else's part at
  // another, and both recoveries then apply.
  let sameOnTrack = 0;
  let otherOnTrack = 0;
  for (const position of order) {
    const start = position.tick;
    const end = start + length;
    const reasons: string[] = [];
    // Against the surviving copies in THIS call: every copy is the same length,
    // so the nearest earlier one also reaches furthest, but the filter compares
    // against all of them rather than resting on that.
    const covering = kept.filter((earlier) => earlier.tick + length > start);
    if (covering.length > 0) {
      const worst = covering[covering.length - 1];
      selfCollisions += 1;
      reasons.push(
        `the copy you asked for at ${unit} ${worst.asked} is not free until ${unit} ${freesUpAt(worst.tick + length, unit, bars)}`,
      );
    }
    // …and then against what is already there — BOTH, never one or the other. A
    // position told only about the copy in front of it re-spaces, lands on the
    // block it was never told about and is refused a second time, for something
    // that was decidable in the first call. Overlap is STRICT on both sides: a
    // block that starts exactly where another ends abuts it, which is what a
    // normal arrangement is made of.
    // EVERY block under this position is classified, not just the first. One
    // position can sit over several — that is the exact shape of the
    // 2026-08-11 track, one long block over four short ones — and `find`
    // returns the earliest-starting of them, so a copy of this pattern lying in
    // front of somebody else's part would swallow the second-track advice this
    // branch exists to give.
    const blocking = occupied.filter((block) => block.start < end && block.end > start);
    if (blocking.length > 0) {
      trackCollisions += 1;
      if (blocking.some((block) => block.samePattern)) sameOnTrack += 1;
      if (blocking.some((block) => !block.samePattern)) otherOnTrack += 1;
      // The block named is the one that ends LAST, not the one that starts
      // first. The sentence's number is when this ground frees up, and the
      // earliest-starting block need not be the one holding it longest: a
      // one-bar block at bar 1 under a ten-bar block at bar 2 would otherwise
      // read "until bar 2" in the same reply whose advice says bar 12 — two
      // numbers, one wrong, which is the shape this whole refusal exists to
      // stop producing.
      const furthest = blocking.reduce((worst, block) => (block.end > worst.end ? block : worst));
      reasons.push(
        `${furthest.label} is already on this track until ${unit} ${freesUpAt(furthest.end, unit, bars)}`,
      );
    }
    if (reasons.length === 0) {
      kept.push(position);
      continue;
    }
    if (refused === null) refused = position;
    collisions.push({ label: `${unit} ${position.asked}`, reason: `${reasons.join(', and ')}.` });
  }
  if (collisions.length === 0 || refused === null) return null;

  const size = lengthPhrase(length, unit, bars);
  // Phrased so it reads for one collision as well as for twenty — the sentence
  // is the product here, and a plural that does not agree with the list under
  // it is the kind of thing a reader stops trusting the rest of.
  const what =
    trackCollisions === 0
      ? 'the copies you asked for would land on top of each other'
      : selfCollisions === 0
        ? 'what you asked for would land on top of a block already on this track'
        : 'the copies you asked for would land on top of each other and on top of blocks already on this track';
  // The spacing is worth saying exactly when the obstacle is THIS pattern —
  // another copy in this call, or a copy already on the track. Told to space a
  // list whose obstacle was somebody else's part, a caller re-spaces something
  // that was already correctly spaced and is refused again.
  const step = spacingPhrase(length, unit, bars);
  // ⚠ ANCHORED ON WHAT WAS ACTUALLY REFUSED, except in the one case where a
  // survivor is the better answer. A self collision means the caller sent two
  // copies too close together: the earliest SURVIVOR is where the run of copies
  // really starts, and the next one belongs a length past it. A collision with
  // a copy already on the track says nothing about the survivors — `kept[0]`
  // there is a position that was accepted, and stepping off it names ground
  // that has nothing to do with the position turned away. (Bar 2 refused and
  // bar 8 kept under a four-bar pattern would have answered "from bar 8 the
  // next free bar is 12" while the same refusal said bar 2 frees up at 5: two
  // numbers, one wrong, in one reply.)
  const anchor =
    selfCollisions > 0 && kept.length > 0
      ? { asked: kept[0].asked, from: kept[0].tick + length }
      : { asked: refused.asked, from: refused.tick };
  // ⚠ WALKED OVER THE SURVIVORS TOO, not only over what was already down. The
  // refusal says nothing was placed, so the caller's next move is to re-send the
  // positions that survived — and a free slot that names one of those is a bar
  // the caller is about to occupy itself, which is the second refusal this
  // sentence exists to save. (One-bar pattern, `atBars: [1, 1, 2]`: bars 1 and 2
  // survive, the duplicate bar 1 is refused, and walking `occupied` alone —
  // empty here — answers "bar 2".)
  const standing = [
    ...occupied,
    ...kept.map((position) => ({ start: position.tick, end: position.tick + length })),
  ];
  const slot = nextFreeSlot(anchor.from, length, standing, unit, bars);
  const free = `from ${unit} ${anchor.asked} the next free ${unit} is ${slot}`;
  let spacing = '';
  if (selfCollisions > 0 || sameOnTrack > 0) {
    // Without a step the caller can take, the free slot carries the sentence on
    // its own — see `spacingPhrase`.
    spacing =
      step === null
        ? ` ${free.charAt(0).toUpperCase()}${free.slice(1)}.`
        : selfCollisions > 0
          ? ` Space the copies ${step} apart: ${free}.`
          : // No copies in THIS call to space — the obstacle is a copy already
            // down — so the spacing is stated as a property of the pattern
            // rather than as an instruction about a list of one.
            ` Copies of this pattern have to be ${step} apart: ${free}.`;
  }
  // A DIFFERENT pattern in the way is a different problem with a different
  // answer, and it gets its own sentence rather than a variation on the spacing
  // one. The cap is checked rather than assumed: advice to add a track on a
  // composition that cannot hold another is a second refusal the caller pays a
  // round trip to discover.
  //
  // ⚠ THE FREE SLOT COMES WITH IT where no spacing sentence already carried it,
  // because "add a track" is only right for a part meant to sound WITH what is
  // there. The commonest foreign collision is not that at all — it is a
  // sequential off-by-one, a chorus sent to bar 4 of a verse that runs to bar 5
  // — and a second track is the one answer that makes those two play over each
  // other. Both readings get their number, and the caller picks.
  const follows = spacing === '' ? ` If it is meant to FOLLOW instead, ${free}.` : '';
  const secondTrack =
    otherOnTrack === 0
      ? ''
      : roomForAnotherTrack
        ? ` A block in the way is a different pattern, not another copy of this one — two parts that sound at the same time belong on two tracks, so add one with composition_add_track and place this there.${follows}`
        : ` A block in the way is a different pattern, not another copy of this one — two parts that sound at the same time belong on two tracks, but this composition is already at the ${MAX_COMPOSITION_TRACKS}-track cap, so one of them has to move to another track or go.${follows}`;
  return `This pattern is ${size} long and a block is never nudged aside, so ${what}. Nothing was placed.${spacing}${secondTrack} ${namedRefusals(collisions)}`;
}

/**
 * Blocks placed on top of each other, reported after the fact — the ONE call
 * `wouldStack` cannot see coming.
 *
 * A built-in pattern. The lib's `addPlacementToTrack` resolves an id against
 * the user's library and then against `BUILTIN_PATTERNS`, while `patternService`
 * deliberately does not merge the built-ins into `getLibraryPatterns` (see its
 * header), so a built-in id places successfully and has no length this layer
 * can read — and with no length there is no overlap to compute. No tool hands
 * such an id out (`read_pattern_library` says so in as many words), so the
 * agent cannot reach this; a caller holding one can, and a placement whose
 * length is unknown is exactly where a silent stack would go unreported.
 *
 * ⚠ SCOPED TO THIS CALL, via `newIds`. Counting every overlap on the track
 * would blame a correct call for a collision that was already there — and,
 * since the blocks stay put, blame every later call to that track for it too.
 * A model told a true reply is a lie stops trusting replies, which is the
 * failure this whole feature exists to prevent.
 *
 * Compared against EVERY earlier block rather than the immediate predecessor:
 * one long block can bury several later ones, and pairwise-adjacent counting
 * sees that as a single overlap.
 */
function overlapsInvolving(trackId: string, newIds: ReadonlySet<string>): number {
  const placements = findTrack(trackId)?.placements ?? [];
  let overlapping = 0;
  for (let i = 1; i < placements.length; i += 1) {
    const covering = placements
      .slice(0, i)
      .filter((earlier) => placementEndTick(earlier) > placements[i].startTick);
    if (covering.length === 0) continue;
    if (newIds.has(placements[i].id) || covering.some((earlier) => newIds.has(earlier.id))) {
      overlapping += 1;
    }
  }
  return overlapping;
}

const placePattern = defineTool<{
  patternId: string;
  trackId: string;
  atTicks?: readonly number[];
  atBars?: readonly number[];
}>({
  name: 'composition_place_pattern',
  description:
    'Place a library pattern onto a track, at one or more points in time — all of it one undo step. Say where with `atBars` or with `atTicks`, exactly one of the two. BARS ARE COUNTED FROM 1 — bar 1 is the start of the composition — and `atBars` is how a pattern is laid out over a form: the seven bars a C7 covers in a twelve-bar blues are one call, `atBars: [1, 2, 3, 4, 7, 8, 11]`. Bar length comes from the composition\'s own time signature, so a 6/8 bar is not a 4/4 one. `atTicks` is for a start that is not on a barline — a pickup, a part entering on the and-of-four. A block starts exactly where it is put and is as long as its pattern; nothing is ever nudged aside to make room. Two positions closer together than the pattern is long, or one landing on a block already on the track, refuse the WHOLE call before anything is written — the refusal names the length, the block in the way and what to do: a spacing that works when what is in the way is another copy of this same pattern, a SECOND TRACK when it is a different pattern, because two parts that sound at the same time cannot share a track. Blocks that merely touch are fine: one may start exactly where the one before it ends. Each block is a deep COPY of the pattern taken at placement time: editing the pattern afterwards does not change the blocks, and editing a block does not change the pattern. Every block that lands comes back with its tick and the `endTick` to space the next one from, plus its bar wherever bars convert exactly in this signature.',
  parameters: obj(
    {
      patternId: str('From read_pattern_library.'),
      trackId: str('From read_composition.'),
      atTicks: arr(
        int(`Where the block starts. ${TICKS}`, { min: 0 }),
        'One entry per copy, for starts that are not on barlines — use atBars for the ones that are. The block starts exactly here; it is never nudged aside to avoid a block already there, so a start that would land on one is refused along with the whole call.',
      ),
      atBars: arr(
        int('Which bar the block starts on, counted FROM 1.', { min: 1 }),
        'One entry per copy — the bars this pattern STARTS on, which for a pattern longer than a bar is not every bar it covers. A two-bar pattern filling bars 1 to 8 is [1, 3, 5, 7]; sending [1, 2, 3, 4] would stack four two-bar blocks a bar apart, so the whole call is refused and nothing is placed.',
      ),
    },
    ['patternId', 'trackId'],
  ),
  run: ({ patternId, trackId, atTicks, atBars }) => {
    // Exclusivity FIRST. `positions` below prefers `atBars`, so an empty
    // `atBars` alongside a full `atTicks` would otherwise be answered "you sent
    // neither" — a sentence that is simply untrue, from the one check whose
    // whole job is naming the argument it wants.
    if (atBars !== undefined && atTicks !== undefined) return fail(NOT_BOTH_POSITIONS);
    const positions = atBars ?? atTicks;
    // `minItems: 1` in the schema stops an empty list reaching here in the app;
    // a direct call can still make one, and a silent `ok({ placed: [] })` is the
    // one reply shape this feature exists to abolish.
    if (positions === undefined || positions.length === 0) return fail(PICK_ONE_POSITION);
    // Hoisted out of the loop, and out of the gesture, for the bar maths: the
    // conversion needs the OPEN composition's signature, and the sentence is the
    // seam's own — `addPlacement` returns this exact one, because the lib gives
    // the same null for an empty editor as for an id that does not exist.
    const composition = getEditingComposition();
    if (!composition) return fail('No composition is open.');
    const bars = barConverter(composition.timeSignature);
    const inBars = atBars !== undefined;
    // `composition_set_settings` takes ANY denominator from 1 to 32, not just the
    // powers of two that are real note values, and `ticksPerBar` is
    // `numerator * (PPQ * 4 / denominator)` — so a 4/7 bar is 1097.142... ticks
    // and no bar after the first starts on one, which is the null `barConverter`
    // returns. Refused rather than rounded, because rounding poisons the reply as
    // well as the write: bar 3 rounded DOWN to 2194 sits a fraction short of the
    // barline and reads back as bar 2 almost-ended. Only the BAR INPUT is
    // refused — a tick is a tick in any signature — but the bar fields of the
    // REPLY go with it, below, or the tick form would answer in a unit this
    // signature has just been told does not convert.
    if (inBars && !bars) {
      const { numerator, denominator } = composition.timeSignature;
      const barTicks = ticksPerBar(composition.timeSignature);
      return fail(
        `A ${numerator}/${denominator} bar is ${barTicks.toFixed(3)} ticks, which is not a whole number, so bar numbers do not convert exactly here. Say where in ticks with \`atTicks\`.`,
      );
    }

    // Bar N starts at (N - 1) x barTicks — exact, given the guard above. This is
    // the off-by-one `agentRules` spends a section warning about, done once here
    // instead of by eye.
    const asked = positions.map((n) => ({
      asked: n,
      tick: inBars && bars ? bars.toTick(n) : n,
    }));

    // BEFORE the bracket, and before any write: a call whose blocks would sit on
    // top of each other, or on top of what is already there, is refused whole
    // and leaves no undo step. See `wouldStack`.
    //
    // Both lookups have to succeed or there is nothing to check against, and
    // failing THEM is not this refusal's business: an unknown track or a
    // built-in pattern (no length here — see `overlapsInvolving`) falls through
    // to the seam, which either places it or names the id it could not resolve.
    const source = findLibraryPattern(patternId);
    const blockLength = source && source.durationTicks > 0 ? source.durationTicks : null;
    const track = findTrack(trackId);
    if (blockLength !== null && track) {
      const stacked = wouldStack(
        asked,
        track.placements.map((placement) => ({
          label: placement.id,
          start: placement.startTick,
          end: placementEndTick(placement),
          // The snapshot keeps the SOURCE pattern's id (the lib's
          // `snapshotPatternForPlacement` spreads it), so this is the same
          // provenance `read_composition` reports as `fromPatternId` — a block
          // cut from this very pattern, however much its copy has been edited
          // since.
          samePattern: placement.patternSnapshot.id === patternId,
        })),
        blockLength,
        inBars ? 'bar' : 'tick',
        bars,
        composition.tracks.length < MAX_COMPOSITION_TRACKS,
      );
      if (stacked !== null) return fail(stacked);
    }

    return oneUndoStep(() => {
      const placed: JsonValue[] = [];
      const refused: { reason: string }[] = [];
      const newIds = new Set<string>();
      for (const position of asked) {
        const result = addPlacement(patternId, trackId, position.tick);
        if (result.ok) {
          // Read the START BACK rather than echoing what was asked for. Purely
          // defensive, and no test can tell it from an echo: `addPlacementToTrack`
          // writes `startTick` verbatim, so `landed` always IS what was asked.
          // It stays because the reply's job is to report the position the
          // document holds and not the one the caller intended.
          const found = findPlacement(result.value);
          const landed = found?.placement.startTick ?? position.tick;
          newIds.add(result.value);
          // ⚠ `atBar`/`atTick` here, `startBar`/`startTick` in `read_composition`
          // for the same number. The keys deliberately echo the ARGUMENT the
          // caller just used (`atBars` → `atBar`), which is the association that
          // matters at the moment of use; a read of the whole document has no
          // such argument behind it and says `start…` instead. Renaming either
          // side would break the echo or the read; the divergence is noted here
          // so nobody has to discover it by correlating two replies.
          placed.push({
            placementId: result.value,
            // Omitted entirely where a bar is not a whole number of ticks —
            // `read_composition` makes the same call about the same block, and
            // two replies that disagree about whether bars exist are worse than
            // one that says nothing.
            ...(bars
              ? {
                  atBar: bars.toBar(landed),
                  // 0 means on the barline. Without it `atTicks: [0]` and
                  // `atTicks: [1440]` both come back `atBar: 1`, and a caller
                  // cannot tell a downbeat from a pickup — which is the one
                  // direction the tick form exists for.
                  ticksIntoBar: bars.ticksIntoBar(landed),
                }
              : {}),
            atTick: landed,
            // Where the next block may start. `wouldStack` refuses a call that
            // ignores it, but a refusal costs a round trip and this is the
            // number that saves it.
            endTick: found ? placementEndTick(found.placement) : landed,
          });
        } else {
          refused.push({ reason: result.reason });
        }
      }
      if (placed.length === 0 && refused.length > 0) {
        // Every refusal `addPlacement` can return is position-INDEPENDENT — the
        // job lock, nothing open, an unknown pattern or track — so `refused` is
        // all-or-nothing and this is the only branch a caller ever sees. The
        // positions go into the sentence in the units the CALLER used: a refusal
        // about tick 21120 sent to a caller that asked for bar 12 has to be
        // converted backwards before it can be acted on.
        const unit = inBars ? 'bar' : 'tick';
        const where = asked.map((position) => position.asked).join(', ');
        return fail(
          `${refused[0].reason} Nothing was placed, at ${unit}${asked.length === 1 ? '' : 's'} ${where} or anywhere else.`,
        );
      }
      // Only where the up-front check could not run — see `overlapsInvolving`.
      // Everywhere else it is provably 0, and computing it would be a second
      // answer to a question already settled before the write.
      const overlapping = blockLength === null ? overlapsInvolving(trackId, newIds) : 0;
      return ok({
        placed,
        // Only when it has something in it. By the argument above `refused` is
        // empty in every reachable ok reply, so a field that is always `[]`
        // would be prompt budget spent on nothing — but it is emitted rather
        // than dropped, because "all-or-nothing" is an argument about today's
        // seam and a silently discarded refusal would be the worst way to learn
        // it had changed.
        ...(refused.length === 0 ? {} : { refused }),
        ...(overlapping === 0
          ? {}
          : {
              warning: `${overlapping} block${overlapping === 1 ? '' : 's'} on this track now start${overlapping === 1 ? 's' : ''} before the one in front of it has finished, so they sound on top of each other. Nothing moves blocks apart — space each copy by the one before it, from its \`endTick\`.`,
            }),
      });
    });
  },
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
    'Copy blocks to a later (or earlier) point, as one undo step — how a section is repeated. UNLIKE composition_place_pattern, a copy does not necessarily land at `startTick + deltaTicks`: copies never overlap, so one that would lands in the nearest free slot instead. Each new block therefore comes back in `copies` with the start and end it ACTUALLY has — check them against the offset you asked for. They arrive in the arrangement\'s own order (track by track, then by time) rather than the order you listed the originals in, so pair them by position and not by index.',
  parameters: obj(
    {
      placementIds: arr(str('A block id from read_composition.'), 'The blocks to copy.'),
      deltaTicks: int(`How far to offset the copies. ${TICKS}`),
      trackId: str('Send every copy to this track. Omit to copy each within its own track.'),
    },
    ['placementIds', 'deltaTicks'],
  ),
  // The lib's `duplicatePlacements` inserts each clone and then routes it
  // through `movePlacement`, which runs `clampStartToFreeSlot` — so a copy
  // offset onto occupied ground is silently relocated. The op reports only the
  // ids, so the position it actually took is read back here: without it the
  // reply is unfalsifiable, and `RESULTS` ("compare what stuck against what you
  // asked for") has nothing to compare.
  run: ({ placementIds, deltaTicks, trackId }) =>
    oneUndoStep(() =>
      fromResult(duplicatePlacements(placementIds, deltaTicks, trackId), (ids) => ({
        copies: ids.map((id): JsonValue => {
          const found = findPlacement(id);
          return {
            placementId: id,
            startTick: found?.placement.startTick ?? null,
            endTick: found ? placementEndTick(found.placement) : null,
          };
        }),
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
  subdivision?: SubdivisionId;
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
    // ⚠ CP-18 narrowed what the SEAM accepts to the lib's catalog, and the
    // schema still describes the wider shape on purpose: a numerator/denominator
    // pair is what the model naturally writes, and the refusal it gets back names
    // every meter that IS allowed. A closed enum of ids here would refuse at the
    // grammar with no sentence attached, which is the one thing that teaches
    // nothing. The bounds stay as the outer guard.
    timeSignature: obj(
      {
        numerator: int('Beats per bar.', { min: 1, max: 32 }),
        denominator: int('What kind of note gets the beat.', { min: 1, max: 32 }),
      },
      ['numerator', 'denominator'],
    ),
    subdivision: str(
      `What the click divides the beat into: ${SUBDIVISION_OPTIONS.join(', ')}. Saved on the composition and heard on the next beat.`,
      SUBDIVISION_OPTIONS as unknown as readonly string[],
    ),
    loop: bool('Whether arrangement playback repeats.'),
    groove: str(
      `Feel: ${listGrooves()
        .map((groove) => `${groove.id} (${groove.name})`)
        .join(', ')}.`,
      GROOVE_IDS,
    ),
  }),
  run: ({ name, bpm, timeSignature, subdivision, loop, groove }) => {
    const named = name === undefined ? null : setCompositionName(name);
    const writes = [
      named,
      bpm === undefined ? null : setCompositionBpm(bpm),
      timeSignature === undefined ? null : setCompositionTimeSignature(timeSignature),
      subdivision === undefined ? null : setCompositionSubdivision(subdivision),
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
      subdivision: subdivision ?? null,
      loop: loop ?? null,
      groove: compositionGrooveId(),
    });
  },
});

export const COMPOSITION_TOOLS: readonly AgentTool[] = [
  openBlank,
  listCompositions,
  openCompositionTool,
  renameCompositionTool,
  duplicateCompositionTool,
  deleteCompositionTool,
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
