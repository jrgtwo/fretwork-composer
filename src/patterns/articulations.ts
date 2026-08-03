/**
 * Pitch articulation as a curve.
 *
 * The playback engine reduces every bend and slide to one thing: a list of
 * `{at, semitones}` points spanning the note (`at` is 0–1 across its duration),
 * stepped through a PitchShift node. `bend.points` is passed through verbatim
 * when present, so authoring the curve directly gives us what the typed fields
 * can't:
 *
 *   - which side of the note the movement happens on (`at` near 0 vs 1)
 *   - how long it takes (the span between points)
 *   - a slide *into* and *out of* the same note — the lib's `slide` field holds
 *     only one direction, but a curve can hold both
 *
 * We therefore treat the curve as the source of truth and read our editing model
 * back out of it, rather than keeping shadow state alongside the event.
 *
 * Not covered here: vibrato. It's a separate Tone node whose envelope is pinned
 * to the whole note, so it can't be positioned or resized. See docs/FOLLOW-UPS.md.
 */

export interface PitchPoint {
  at: number;
  semitones: number;
}

/** Movement into the note: start `semitones` away, arrive at pitch by `at`. */
export interface PitchIn {
  semitones: number;
  at: number;
}

/** Movement out of the note: hold pitch until `at`, then depart by `semitones`. */
export interface PitchOut {
  semitones: number;
  at: number;
}

/** A bend within the note, optionally released back to pitch before it ends. */
export interface PitchBend {
  semitones: number;
  start: number;
  end: number;
  release?: boolean;
}

export interface PitchSpec {
  in?: PitchIn;
  out?: PitchOut;
  bend?: PitchBend;
}

export const EMPTY_PITCH: PitchSpec = { in: undefined, out: undefined, bend: undefined };

const round = (n: number) => Math.round(n * 1000) / 1000;

export function hasPitchMovement(spec: PitchSpec): boolean {
  return Boolean(spec.in || spec.out || spec.bend);
}

/**
 * Flatten the spec into the engine's curve. Points are emitted in ascending
 * order and de-duplicated, since the scheduler steps through them in sequence.
 */
export function buildCurve(spec: PitchSpec): PitchPoint[] | undefined {
  if (!hasPitchMovement(spec)) return undefined;

  const points: PitchPoint[] = [];
  const add = (at: number, semitones: number) =>
    points.push({ at: round(Math.min(1, Math.max(0, at))), semitones: round(semitones) });

  // leading edge
  if (spec.in) {
    add(0, spec.in.semitones);
    add(spec.in.at, 0);
  } else {
    add(0, 0);
  }

  // the bend body
  if (spec.bend) {
    add(spec.bend.start, 0);
    add(spec.bend.end, spec.bend.semitones);
    if (spec.bend.release) add(1, 0);
  }

  // trailing edge
  if (spec.out) {
    add(spec.out.at, 0);
    add(1, spec.out.semitones);
  }

  // Nothing has pinned the end yet — hold whatever the last value was.
  if (points.at(-1)!.at !== 1) add(1, points.at(-1)!.semitones);

  return points
    .sort((a, b) => a.at - b.at)
    .filter((p, i, all) => i === 0 || p.at !== all[i - 1].at || p.semitones !== all[i - 1].semitones);
}

/** Recover the editing model from a stored curve. */
export function parseCurve(points: readonly PitchPoint[] | undefined): PitchSpec {
  if (!points || points.length < 2) return EMPTY_PITCH;

  const first = points[0];
  const last = points.at(-1)!;
  const spec: PitchSpec = { ...EMPTY_PITCH };

  // A non-zero opening value means the note is slid into.
  if (first.semitones !== 0) {
    const arrival = points.find((p) => p.at > 0 && p.semitones === 0);
    if (arrival) spec.in = { semitones: first.semitones, at: arrival.at };
  }

  // A non-zero closing value is a departure only if the note was still at pitch
  // immediately before the end. If it had already moved, this is a bend being
  // held to the end rather than a slide out of the note.
  const beforeLast = points.at(-2);
  if (last.semitones !== 0 && last.at === 1 && beforeLast?.semitones === 0) {
    spec.out = { semitones: last.semitones, at: beforeLast.at };
  }

  // Whatever movement remains between the two edges is a bend. Its `end` is where
  // the peak is first reached — anything after that is a hold.
  const inAt = spec.in?.at ?? 0;
  const outAt = spec.out?.at ?? 1;
  const interior = points.filter((p) => p.at > inAt && p.at <= outAt && p.semitones !== 0);

  if (interior.length > 0) {
    const depth = interior.reduce((a, b) => (Math.abs(b.semitones) > Math.abs(a.semitones) ? b : a));
    const reached = interior.find((p) => p.semitones === depth.semitones)!;
    const rise = [...points].reverse().find((p) => p.at < reached.at && p.semitones === 0);
    spec.bend = {
      semitones: depth.semitones,
      start: rise?.at ?? inAt,
      end: reached.at,
      ...(last.semitones === 0 && reached.at < 1 ? { release: true } : {}),
    };
  }

  return spec;
}

/**
 * The patch to hand `updateEventArticulations`.
 *
 * Always written as `bend.points` because that's the one path the engine passes
 * through untouched — the typed `slide` shapes are fixed-length and single-sided.
 * `type` is set to the nearest standard shape so anything reading it for notation
 * still gets a sensible answer.
 */
export function toEventPatch(spec: PitchSpec): {
  bend: { type: 'bend' | 'release' | 'pre-bend' | 'bend-release'; semitones: number; points: PitchPoint[] } | undefined;
} {
  const points = buildCurve(spec);
  if (!points) return { bend: undefined };

  const peak = points.reduce((a, b) => (Math.abs(b.semitones) > Math.abs(a.semitones) ? b : a));
  const type = spec.bend?.release
    ? 'bend-release'
    : points[0].semitones !== 0 && points.at(-1)!.semitones === 0
      ? 'release'
      : 'bend';

  return { bend: { type, semitones: peak.semitones, points } };
}

/** Read the spec back off an event. */
export function readPitchSpec(event: {
  bend?: { points?: readonly PitchPoint[] } | undefined;
}): PitchSpec {
  return parseCurve(event.bend?.points);
}

// ---------------------------------------------------------------------------
// The musical layer.
//
// Guitarists think in tab: "slide into it from below", "bend a full step",
// "slide off the end" — not in curve positions. The lib's typed `slide`/`bend`
// fields already speak that language and are what notation would read, so we
// use them wherever they can express what the user asked for.
//
// They can't express two things: a slide *into* and *out of* the same note (one
// `slide` field), or a bend combined with a slide (playback drops the slide —
// "bend takes priority"). For those we fall back to an explicit curve, which
// composes both. That keeps the common cases clean and the rare ones possible.
// ---------------------------------------------------------------------------

// --------------------------------------------------------------------- ties ---

/** The fields a tied follower would lose when it's folded into its leader.
 *  `velocity` is deliberately absent even though it is lost too: it is only ever
 *  written alongside `dynamic`, so listing both would report the same loss twice. */
const MERGED_AWAY = ['vibrato', 'bend', 'slide', 'hammerOn', 'pullOff', 'palmMute', 'ghost', 'dead', 'tap', 'dynamic'] as const;

interface TieCandidate {
  id: string;
  stringIndex: number;
  fret: number;
  startTick: number;
  durationTicks: number;
}

/**
 * The note a tie would join to, if any.
 *
 * The lib merges tied chains only on strict adjacency — same string, same fret,
 * and the follower starting exactly where the leader ends. Anything else and the
 * tie is silently ignored at playback, so the UI shouldn't offer it.
 */
export function tieTargetFor<T extends TieCandidate>(
  events: readonly T[],
  event: TieCandidate,
): T | undefined {
  const end = event.startTick + event.durationTicks;
  return events.find(
    (candidate) =>
      candidate.id !== event.id &&
      candidate.stringIndex === event.stringIndex &&
      candidate.fret === event.fret &&
      candidate.startTick === end,
  );
}

/**
 * Articulations on a tied follower that playback will discard.
 *
 * `mergeTies` keeps the leader and skips the follower, so anything expressive on
 * the second note is lost — including the "tie a second note to add vibrato at
 * the end" trick, which looks reasonable but does nothing.
 */
/**
 * The note this one is tied FROM — i.e. the leader that will swallow it.
 *
 * The other half of the same gap: `articulationsLostToTie` asks "what does the
 * follower lose", this asks "am I the follower". Only a tie the lib will
 * actually merge counts, because `mergeTies` ignores a `tieToNext` whose
 * adjacency doesn't hold and lets both notes play normally — a warning there
 * would be a lie.
 */
export function tieLeaderOf<T extends TieCandidate & { tieToNext?: boolean }>(
  events: readonly T[],
  event: TieCandidate,
): T | undefined {
  return events.find(
    (candidate) => candidate.tieToNext && tieTargetFor(events, candidate)?.id === event.id,
  );
}

export function articulationsLostToTie(
  follower: Partial<Record<(typeof MERGED_AWAY)[number], unknown>> | undefined,
): string[] {
  if (!follower) return [];
  return MERGED_AWAY.filter((key) => follower[key] !== undefined && follower[key] !== false);
}

export type SlideIn = 'below' | 'above';
export type SlideOut = 'down' | 'up';
export type BendKind = 'bend' | 'bend-release' | 'pre-bend' | 'release';

export interface NotePitch {
  slideIn?: SlideIn;
  slideOut?: SlideOut;
  bend?: { kind: BendKind; semitones: number };
}

export const NO_PITCH: NotePitch = {};

/** How far a grace slide travels, in semitones. Matches the lib's own shapes. */
const SLIDE_IN_DEPTH = 2;
const SLIDE_OUT_DEPTH = 3;

const needsCurve = (pitch: NotePitch) =>
  (!!pitch.slideIn && !!pitch.slideOut) || (!!pitch.bend && (!!pitch.slideIn || !!pitch.slideOut));

function toSpec(pitch: NotePitch): PitchSpec {
  const spec: PitchSpec = { ...EMPTY_PITCH };
  if (pitch.slideIn) {
    spec.in = { semitones: pitch.slideIn === 'below' ? -SLIDE_IN_DEPTH : SLIDE_IN_DEPTH, at: 0.15 };
  }
  if (pitch.slideOut) {
    spec.out = {
      semitones: pitch.slideOut === 'down' ? -SLIDE_OUT_DEPTH : SLIDE_OUT_DEPTH,
      at: 0.85,
    };
  }
  if (pitch.bend) {
    const { kind, semitones } = pitch.bend;
    spec.bend =
      kind === 'pre-bend'
        ? { semitones, start: 0, end: 0 }
        : kind === 'release'
          ? { semitones, start: 0, end: 0, release: true }
          : { semitones, start: 0.1, end: 0.6, release: kind === 'bend-release' };
  }
  return spec;
}

/** The articulation patch for a note's pitch movement. */
export function toPitchPatch(pitch: NotePitch): {
  slide?: { type: string; toFret?: number } | undefined;
  bend?: unknown;
} {
  if (!pitch.slideIn && !pitch.slideOut && !pitch.bend) {
    return { slide: undefined, bend: undefined };
  }

  if (needsCurve(pitch)) {
    // One curve carries everything; the typed slide would be ignored anyway.
    return { slide: undefined, ...toEventPatch(toSpec(pitch)) };
  }

  if (pitch.bend) {
    const type = pitch.bend.kind === 'bend-release' ? 'bend-release' : pitch.bend.kind;
    return { slide: undefined, bend: { type, semitones: pitch.bend.semitones } };
  }

  const type = pitch.slideIn
    ? pitch.slideIn === 'below'
      ? 'slide-in-below'
      : 'slide-in-above'
    : pitch.slideOut === 'down'
      ? 'slide-out-down'
      : 'slide-out-up';
  return { slide: { type }, bend: undefined };
}

/** Read the musical model back off an event, from whichever form it was stored in. */
export function readNotePitch(event: {
  slide?: { type: string } | undefined;
  bend?: { type?: string; semitones?: number; points?: readonly PitchPoint[] } | undefined;
}): NotePitch {
  // Stored as a curve — recover the shape from it.
  if (event.bend?.points && event.bend.points.length >= 2) {
    const spec = parseCurve(event.bend.points);
    const pitch: NotePitch = {};
    if (spec.in) pitch.slideIn = spec.in.semitones < 0 ? 'below' : 'above';
    if (spec.out) pitch.slideOut = spec.out.semitones < 0 ? 'down' : 'up';
    if (spec.bend) {
      pitch.bend = {
        kind: spec.bend.release ? 'bend-release' : 'bend',
        semitones: spec.bend.semitones,
      };
    }
    return pitch;
  }

  if (event.bend?.type) {
    return {
      bend: {
        kind: event.bend.type as BendKind,
        semitones: event.bend.semitones ?? 2,
      },
    };
  }

  switch (event.slide?.type) {
    case 'slide-in-below':
      return { slideIn: 'below' };
    case 'slide-in-above':
      return { slideIn: 'above' };
    case 'slide-out-down':
      return { slideOut: 'down' };
    case 'slide-out-up':
      return { slideOut: 'up' };
    default:
      return NO_PITCH;
  }
}
