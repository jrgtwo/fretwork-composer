/**
 * WHAT A PLAN IS — the shape the planning run answers in, and the shape
 * `arrangementPlan.ts` grades.
 *
 * A plan is three lists and a length: the TRACKS the arrangement wants, the
 * PATTERNS that will be written for it, and where each of those patterns is
 * PLACED. Nothing in it is a note, a fret or a tick. It is the whole product of
 * a run that writes nothing, and it exists because one model call holding the
 * form, the harmony, the fret arithmetic and the placement at once defaults to
 * generic output — the 2026-08-14 run looked three chords up, wrote one repeated
 * cell per part, used none of them, and was mechanically perfect throughout.
 *
 * ── Why this is a SCHEMA and not just a type ────────────────────────────────
 *
 * The planning run is handed this as `RunAgentTaskOptions.outputSchema`, which
 * is grammar-enforced decoding at the provider and an `ajv` validation in the
 * harness — but ONLY on a run whose tool list is empty (the seam's own comment
 * on that option is the citation). That is the whole reason the plan step has no
 * tools: a step whose entire product is a reliable structure cannot also be a
 * step that reads. What it therefore cannot do is look anything up, so the
 * composition is rendered INTO its prompt instead — see `planRunInput`.
 *
 * ── A CHORD PER PATTERN, NOT PER BAR ────────────────────────────────────────
 *
 * The opposite choice is defensible and the next reader will wonder, so: a
 * pattern is the unit that gets PLACED and the unit a later sub-run is BRIEFED
 * on. "Write two bars of walking bass over F7" is a brief narrow enough to be
 * hard to fill with generic material; "write the bass for bars 5 and 6" is not,
 * because the writer would have to be told the harmony anyway. The chord
 * therefore belongs to the pattern. Chord-per-BAR falls out of that for free —
 * `placements` says which pattern sits in which bar, so the bar's chord is the
 * chord of whatever covers it — whereas the other direction does not: a harmony
 * grid alone never says how many patterns to write or where they repeat.
 *
 * ⚠ SYMBOLS, NEVER FRETS. A plan names "C7", not a shape. The run that writes
 * the pattern asks `read_chord_voicings` for that symbol on ITS OWN instrument,
 * which is the only thing that makes a bass part a bass part rather than a
 * guitar grip transposed onto four strings.
 *
 * ⚠ BARS, NEVER TICKS, counted FROM 1. `barMath` owns tick↔bar and the assembly
 * step is where a plan meets it; nothing here converts anything.
 *
 * ── The one field the ticket's three bullets do not name ────────────────────
 *
 * `bars` — how long the form is. Coverage is the point of validating a plan at
 * all ("a twelve-bar form with eight bars of nothing is what the last four runs
 * produced and nobody was told"), and there is no way to ask whether the form is
 * covered without knowing how long it is. It cannot be inferred from the
 * placements, since a plan that stops at bar 4 of a twelve-bar blues is exactly
 * the failure being looked for, and it cannot come from the composition, which
 * is usually empty when the planning happens.
 */
import { INSTRUMENT_IDS, INSTRUMENT_LIST } from './tools/instrumentCatalog';
import { arr, int, name, obj, str, type JsonSchema } from './tools/types';

/** A track the arrangement wants. Named, because a plan has no ids — nothing it
 *  describes exists yet. */
export interface PlannedTrack {
  readonly name: string;
  readonly instrumentId: string;
}

/** A pattern to be written, and the brief a later run gets. */
export interface PlannedPattern {
  readonly name: string;
  readonly instrumentId: string;
  /** The chord SYMBOL this pattern is over — "C7", "Fmaj7", "G/B". */
  readonly chord: string;
  /** How many bars long it is, at least 1. This is what its copies have to be
   *  spaced by; see `reviewPlan`. */
  readonly lengthBars: number;
}

/** One pattern, on one track, at the bars it STARTS on. */
export interface PlannedPlacement {
  readonly patternName: string;
  readonly trackName: string;
  readonly atBars: readonly number[];
}

export interface ArrangementPlan {
  /** How long the whole form is, in bars. */
  readonly bars: number;
  readonly tracks: readonly PlannedTrack[];
  readonly patterns: readonly PlannedPattern[];
  readonly placements: readonly PlannedPlacement[];
}

/**
 * ONE instrument vocabulary, and it is the PATTERN catalog's.
 *
 * `compositionTools` builds its own from `listTrackInstruments` and
 * `instrumentCatalog`'s header explains why the two lists are kept apart — they
 * answer different questions. Both are today the same lib catalog mapped the
 * same way, and a plan naming an instrument two ways in one object would be a
 * distinction the model has to maintain for no gain it can see. The assembly
 * step is where a track's instrument is set, and it is the place to notice if
 * the two catalogs ever diverge.
 */
const instrument = (what: string): JsonSchema =>
  str(`${what} One of: ${INSTRUMENT_LIST}.`, INSTRUMENT_IDS);

/**
 * The plan, as JSON Schema. `additionalProperties: false` throughout (`obj`
 * does it) so a field the model invents is a decoding failure rather than a
 * silently dropped instruction, and every array is `minItems: 1` (`arr` does it)
 * because a plan with no tracks, no patterns or no placements is not a plan.
 *
 * ⚠ THE SCHEMA IS NOT THE VALIDATION. It can say a bar is an integer ≥ 1; it
 * cannot say that a placement names a pattern that exists, that two copies of a
 * two-bar pattern a bar apart land on top of each other, or that eight bars of
 * the form have nothing on them. Those are `reviewPlan`'s, and they are the ones
 * that cost a failed run each to learn.
 */
export const ARRANGEMENT_PLAN_SCHEMA: JsonSchema = obj(
  {
    bars: int(
      'How long the whole form is, in bars — 12 for a twelve-bar blues. Bars count FROM 1, so this is also the number of the last bar.',
      { min: 1 },
    ),
    tracks: arr(
      obj(
        {
          name: name('What this part is called — "Bass", "Rhythm Guitar". Placements refer to it by exactly this.'),
          instrumentId: instrument('The instrument this track plays.'),
        },
        ['name', 'instrumentId'],
      ),
      'The tracks the arrangement needs. One part per track: two parts that sound at the same time cannot share one.',
    ),
    patterns: arr(
      obj(
        {
          name: name('What this pattern is called. Placements refer to it by exactly this, so no two patterns may share a name.'),
          instrumentId: instrument('The instrument this pattern is written for — the same one as the track it goes on.'),
          chord: name(
            'The chord this pattern is over, as a SYMBOL — "C7", "Fmaj7", "F#m7b5", "G/B". Never frets: the run that writes the notes looks the symbol up on its own instrument\'s neck.',
          ),
          lengthBars: int(
            'How many bars long this pattern is. Its copies have to be spaced this far apart — a 2-bar pattern covering bars 1 to 8 starts at bars 1, 3, 5, 7.',
            { min: 1 },
          ),
        },
        ['name', 'instrumentId', 'chord', 'lengthBars'],
      ),
      'The patterns to be written. One chord each: where the harmony moves, that is another pattern.',
    ),
    placements: arr(
      obj(
        {
          patternName: name('Which pattern, by the name declared in `patterns`.'),
          trackName: name('Which track, by the name declared in `tracks`.'),
          atBars: arr(
            int('A bar this pattern STARTS on, counted from 1.', { min: 1 }),
            'Every bar this pattern starts on, on this track. For a pattern longer than one bar these are not consecutive: space them by `lengthBars`.',
          ),
        },
        ['patternName', 'trackName', 'atBars'],
      ),
      'Where each pattern goes. A pattern used on two tracks is two entries.',
    ),
  },
  ['bars', 'tracks', 'patterns', 'placements'],
);
