import { pitchClass, type DynamicMark } from '@fretwork/lib';
import { openStrings } from '../reference/tabLayout';
import type { BendKind, NotePitch, SlideIn, SlideOut } from '../patterns/articulations';

/**
 * The pure half of note editing: the tables the controls are generated from,
 * the rules for changing a note's pitch field by field, and what a fret on a
 * string is called.
 *
 * Split out of `./NoteControls` for the reason everything geometric is split
 * out of the components here — jsdom has no layout and no DOM worth trusting,
 * so anything that can be a plain function is one, and is tested as one.
 *
 * ⚠ THIS IS THE ONE COPY OF THE TABLES. `NotePopup` (pattern page) and
 * `NoteInspectorRail` (composition page, edit mode) both render controls
 * generated from these; a second literal list anywhere would drift silently,
 * which is a defect this project has already shipped once.
 * `tests/NoteInspectorRail.test.tsx` renders both surfaces over one note and
 * compares the options they offer.
 */

/** Bend depths guitarists actually use. */
export const DEPTHS = [
  { semitones: 1, label: '½' },
  { semitones: 2, label: 'full' },
  { semitones: 3, label: '1½' },
  { semitones: 4, label: '2' },
] as const;

/** What the marks are called out loud — the abbreviations alone are ambiguous
 *  to anyone who doesn't already read them. */
export const DYNAMIC_NAMES: Record<DynamicMark, string> = {
  ppp: 'pianississimo — barely audible',
  pp: 'pianissimo — very soft',
  p: 'piano — soft',
  mp: 'mezzo-piano — moderately soft',
  mf: 'mezzo-forte — moderately loud',
  f: 'forte — loud',
  ff: 'fortissimo — very loud',
  fff: 'fortississimo — as loud as it goes',
};

/** Technique flags. Independent fields in the lib rather than one choice — a
 *  note can be a palm-muted ghost hammer-on — and the lib keeps hammer-on and
 *  pull-off mutually exclusive for us. */
export const FLAGS = [
  { key: 'hammerOn', label: 'H-on' },
  { key: 'pullOff', label: 'P-off' },
  { key: 'palmMute', label: 'P.Mute' },
  { key: 'ghost', label: 'Ghost' },
  { key: 'dead', label: 'Dead' },
  { key: 'tap', label: 'Tap' },
] as const;

export type FlagKey = (typeof FLAGS)[number]['key'];

export type Vibrato = 'slight' | 'wide';

/**
 * One field of a note's pitch movement, changed.
 *
 * Keyed rather than a whole `NotePitch` so a multi-selection edit can be
 * applied field by field: the rail rebuilds each selected note's own pitch
 * around it, and a note keeps the slide it already had when the user asks for
 * a bend.
 */
export type PitchEdit =
  | { key: 'slideIn'; value: SlideIn | undefined }
  | { key: 'slideOut'; value: SlideOut | undefined }
  /** Depth is OPTIONAL: asking for a bend KIND says nothing about how far, and
   *  a selection that disagrees about the depth has none to send. */
  | { key: 'bend'; value: { kind: BendKind; semitones?: number } | undefined };

export function applyPitchEdit(pitch: NotePitch, edit: PitchEdit): NotePitch {
  switch (edit.key) {
    case 'slideIn':
      return { ...pitch, slideIn: edit.value };
    case 'slideOut':
      return { ...pitch, slideOut: edit.value };
    case 'bend':
      return {
        ...pitch,
        // An omitted depth resolves against THIS note, not against whatever the
        // surface was displaying. A multi-selection that agrees on the kind and
        // not the depth shows no depth, and taking that back would write a
        // 0-semitone bend: a bend glyph on screen and silence at playback.
        bend: edit.value && {
          kind: edit.value.kind,
          semitones: edit.value.semitones ?? pitch.bend?.semitones ?? 2,
        },
      };
  }
}

/**
 * What the pitch controls are given to DRAW, which is not quite a note's pitch:
 * a multi-selection can agree that every note bends and disagree about how far,
 * and that has to read as "bend on, no depth lit" rather than as a depth.
 *
 * `NotePitch` is assignable to it, so the popup passes its event's pitch
 * straight through.
 */
export interface PitchDisplay {
  slideIn?: SlideIn;
  slideOut?: SlideOut;
  bend?: { kind: BendKind; semitones?: number };
}

/**
 * The value shared by every item, or `undefined` when they disagree.
 *
 * This is the whole of what "shows common values" means here: a disagreement
 * reads as unset, which is also how every control draws `undefined`. So a mixed
 * selection shows the option OFF and one click turns it on for all of them —
 * the ordinary multi-edit contract, and the only one toggles can express.
 */
export function commonValue<T, V>(items: readonly T[], read: (item: T) => V): V | undefined {
  if (items.length === 0) return undefined;
  const first = read(items[0]);
  return items.every((item) => read(item) === first) ? first : undefined;
}

/**
 * Sharp spellings, because a fretboard has no key to spell against — and the lib's
 * `noteAt` cannot supply them: Tonal's `Note.fromMidi` returns FLATS (`noteAt('C4',1)`
 * is `'Db4'`), so routing this through the lib would respell every accidental in the
 * editor. `spellInKey` is the lib's answer to spelling and it needs a tonic nothing
 * here has. The typographic `♯` is deliberate: it is what an 8px glyph inside a note
 * block should be, not a hash.
 */
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

/**
 * What a fret on a given string is called, off the instrument's own open strings
 * — a bass or a ukulele names its notes from its own tuning, read through the one
 * resolver `stringLabels` uses so the gutter and the notes beside it can't come
 * from two different tunings.
 *
 * No octave: a note block labels the pitch, not the register.
 *
 * `''` for a string the tuning has no entry for — a blank name is honest where
 * the guitar's would be a confident wrong answer. The tuning is the instrument's
 * declared default, the same choice and the same caveat as `stringLabels`:
 * nothing owns instrument/tuning/capo yet, so these names and the notes you hear
 * agree only as long as both keep landing on the same tuning (FOLLOW-UPS §3).
 */
export function pitchNamer(instrumentId: string, stringCount: number) {
  const opens = openStrings(instrumentId, stringCount);
  return (stringIndex: number, fret: number): string => {
    const open = opens[stringIndex];
    if (open === undefined) return '';
    return NOTE_NAMES[(pitchClass(open) + fret) % 12];
  };
}
