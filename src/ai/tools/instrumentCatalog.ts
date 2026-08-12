/**
 * The instruments there is a neck to talk about, in ONE place.
 *
 * `barMath`'s reason, at a different address: two tool modules built this list
 * from the seam independently — `patternTools` for the schemas that SET an
 * instrument, `readTools` for the one that asks about a neck — and an exact copy
 * of a list is a copy that goes stale in one file only.
 *
 * ⚠ NEVER a literal list. Both copies already took it from `listInstruments`,
 * which takes it from the lib's own catalog, and that is the part worth keeping:
 * an instrument the lib adds is askable on day one, and a hand-written enum is
 * the model being told a real instrument is invalid.
 *
 * `compositionTools` deliberately does NOT share this — a track's instrument
 * comes from `listTrackInstruments`, which is a different catalog, and merging
 * the two would be one list claiming to answer two questions.
 */
import { listInstruments } from '../../patterns/patternService';

/** The ids, for a schema's `enum`. */
export const INSTRUMENT_IDS = listInstruments().map((instrument) => instrument.id);

/** The same catalog as a sentence, for the schemas that name the choices inline. */
export const INSTRUMENT_LIST = listInstruments()
  .map((instrument) => `${instrument.id} (${instrument.name})`)
  .join(', ');
