/**
 * The agent's capabilities over the VOICE seam — which voice a track plays
 * through, and the user's own saved voices.
 *
 * ⚠ THE TRACK PATH, never the pattern one. `voiceService.selectVoice` is the
 * function that looks right and is wrong here: it writes the EDITING PATTERN's
 * ref, so from a composition it would retune whichever pattern happens to be
 * open and leave every track exactly as it was — which, with one track on the
 * fallback, can even look like it worked. `setTrackVoice` is the track write,
 * and it is the only one wrapped below.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 *
 *   - **Save-over** (`saveTrackVoice`), and voice PARAMETERS generally. Both
 *     take a whole `VoicePreset` — an amp model, a cabinet IR, a sample pack, an
 *     effects chain — which is a synth-design surface, not a musical one, and
 *     nothing a model can author from a schema without inventing values that do
 *     not exist. `voice_save_as` is here because it needs no authored preset: it
 *     saves what the track ALREADY sounds like, read back through the seam.
 *     There is no "make this dirtier" tool because there is no seam write to
 *     make one out of — the parameter drafts live in the voice rack's own UI
 *     state, which is a gap recorded in the ticket rather than papered over
 *     here.
 *   - **The global active variant** (`selectVoice` and the `activeVariants`
 *     map). It is the instrument-wide default shared by every pattern with no
 *     explicit ref, so writing it retunes documents the user never mentioned.
 *   - **The pattern's own voice.** Same function, same trap; a pattern-side
 *     voice tool can be added when a pattern-side command needs one.
 */
import {
  deleteTrackVoice,
  describeVoiceRefusal,
  listSelectableVoices,
  parseVoiceKey,
  readTrackVoiceRef,
  renameVoice,
  resolveTrackVoicePreset,
  saveTrackVoiceAs,
  setTrackVoice,
  trackVoiceRefStatus,
  variantIdFromKey,
  voiceKey,
} from '../../voice/voiceService';
import { findTrack, trackInstrumentId } from '../../composition/compositionService';
import {
  defineTool,
  fail,
  nullable,
  obj,
  ok,
  str,
  type AgentTool,
  type JsonValue,
} from './types';

const listForTrack = defineTool<{ trackId: string }>({
  name: 'voice_list_for_track',
  description:
    "Every voice one track can be set to — the built-in voices for its instrument plus the user's own saved ones for that instrument. Built-in voices cannot be overwritten or deleted. A voice for another instrument is never offered, because it would resolve to a preset for a neck this track has not got.",
  parameters: obj({ trackId: str('From read_composition.') }, ['trackId']),
  run: ({ trackId }) => {
    const track = findTrack(trackId);
    if (!track) return fail('No such track.');
    const instrumentId = trackInstrumentId(track);
    const offered = listSelectableVoices(instrumentId);
    const describe = (
      option: (typeof offered.builtIns)[number],
    ): JsonValue => ({
      voiceKey: option.key,
      name: option.name,
      builtIn: option.builtIn,
    });
    const current = readTrackVoiceRef(track);
    return ok({
      trackId,
      instrumentId,
      // 'none' means the track has no voice of its own and follows the
      // instrument's active voice — the lib's documented fallback, and a
      // legitimate state rather than a missing value.
      currentVoiceKey: current ? voiceKey(current) : null,
      currentVoiceStatus: trackVoiceRefStatus(track),
      voices: [...offered.builtIns, ...offered.userVariants].map(describe),
    });
  },
});

const setForTrack = defineTool<{ trackId: string; voiceKey: string | null }>({
  name: 'voice_set_for_track',
  description:
    "Point one track at a voice, or null to put it back on its instrument's default voice. This is audible immediately, including mid-playback, and it changes nothing else in the mix.",
  parameters: obj(
    {
      trackId: str('From read_composition.'),
      voiceKey: nullable(str('From voice_list_for_track. Null clears the choice.')),
    },
    ['trackId', 'voiceKey'],
  ),
  run: ({ trackId, voiceKey: key }) => {
    // `null` clears; anything else has to parse into a real ref before the seam
    // sees it, and an unparseable key is refused HERE rather than being coerced
    // into "no voice" — silently clearing a track because a key was misspelt is
    // the failure this whole layer is built to avoid.
    const ref = key === null ? null : parseVoiceKey(key);
    if (key !== null && ref === null) return fail(`Not a voice key: ${key}.`);
    const result = setTrackVoice(trackId, ref);
    return result.ok ? ok({ trackId, voiceKey: key }) : fail(result.reason);
  },
});

const saveAsForTrack = defineTool<{ trackId: string; name: string }>({
  name: 'voice_save_as',
  description:
    "Save what a track currently sounds like as a new voice of the user's own, under a name, and point the track at it. This is how a built-in voice becomes something that can be renamed or kept — the built-ins themselves are read-only.",
  parameters: obj(
    { trackId: str('From read_composition.'), name: str('What to call the new voice.') },
    ['trackId', 'name'],
  ),
  run: ({ trackId, name }) => {
    const track = findTrack(trackId);
    if (!track) return fail('No such track.');
    // The preset is READ from the track rather than authored here: a
    // `VoicePreset` is an amp model, a cabinet IR, a sample pack and an effects
    // chain, and a caller inventing those would be inventing values that do not
    // exist. "Save what this already sounds like" is the whole capability.
    const result = saveTrackVoiceAs(trackId, name, resolveTrackVoicePreset(track));
    return result.ok
      // Built through `voiceKey` and not by hand: the key format is authored in
      // one place on purpose, which is the same argument `variantIdFromKey`
      // makes for the way back.
      ? ok({ trackId, name, voiceKey: voiceKey({ kind: 'user', id: result.id }) })
      : fail(describeVoiceRefusal(result.reason));
  },
});

const rename = defineTool<{ voiceKey: string; name: string }>({
  name: 'voice_rename',
  description:
    'Rename one of the saved voices. A voice is SHARED: the new name shows everywhere it is used. The built-in voices cannot be renamed.',
  parameters: obj(
    { voiceKey: str('From voice_list_for_track.'), name: str('The new name.') },
    ['voiceKey', 'name'],
  ),
  run: ({ voiceKey: key, name }) => {
    // Keys in, keys out: everything that OFFERS a voice hands out keys, so the
    // write path takes one too. The seam turns it into a variant id and refuses
    // a built-in as `built-in` rather than as "unknown" — which is why this is
    // not a `key.split(':')` here.
    const variant = variantIdFromKey(key);
    if (!variant.ok) return fail(describeVoiceRefusal(variant.reason));
    const result = renameVoice(variant.id, name);
    // The seam's refusals are enum CODES so a pane can render each state its own
    // way; `describeVoiceRefusal` is the one authoring of the sentence, and it
    // lives at the seam so this layer cannot invent a second wording.
    return result.ok ? ok({ voiceKey: key, name }) : fail(describeVoiceRefusal(result.reason));
  },
});

const deleteForTrack = defineTool<{ trackId: string; voiceKey: string }>({
  name: 'voice_delete',
  description:
    "Delete one of the saved voices and put the track named here back on its instrument's default. A voice is SHARED: only the named track is repaired, so any OTHER track pointing at the same voice is left with a dangling reference (read_composition still shows its key, and voice_list_for_track reports it as deleted) — set those tracks yourself. The built-in voices cannot be deleted.",
  parameters: obj(
    {
      trackId: str('The track to repair afterwards, from read_composition.'),
      voiceKey: str('From voice_list_for_track.'),
    },
    ['trackId', 'voiceKey'],
  ),
  run: ({ trackId, voiceKey: key }) => {
    const variant = variantIdFromKey(key);
    if (!variant.ok) return fail(describeVoiceRefusal(variant.reason));
    const result = deleteTrackVoice(trackId, variant.id);
    return result.ok ? ok({ voiceKey: key }) : fail(describeVoiceRefusal(result.reason));
  },
});

export const VOICE_TOOLS: readonly AgentTool[] = [
  listForTrack,
  setForTrack,
  saveAsForTrack,
  rename,
  deleteForTrack,
];
