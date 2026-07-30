/**
 * Two-way mapping between a normalized point on the cabinet baffle and a cabinet IR.
 *
 * guitar-tutor's `Cabinet.tsx` drew a mic dot and labelled it "Cosmetic for now",
 * because its IR set had no positional meaning. Ours does: `CABINET_IRS` encodes
 * mic model and placement in every id and description, so the dot can be the
 * picker rather than a decoration. Dragging it snaps to whichever IR was captured
 * nearest that spot.
 *
 * This module keys on IR **id**, but presets store `effects.cabIR.url`. The entry
 * point from a preset is therefore `detectCabinetIR(url)?.id` — never
 * `getCabinetIR(url)`. An unregistered URL yields no id and so must render NO dot
 * at all, matching `paramSchema.ts`'s cab enum, which resolves an unknown URL to
 * `null` rather than falsely reporting the first cab.
 *
 * ── THE LAYOUT IS A DESIGNED CLAIM, NOT AN ARBITRARY SCATTER ───────────────────
 *
 * Coordinates are normalized 0..1 over the baffle, x rightward, y DOWNWARD (SVG
 * convention, so the renderer can use them directly). `(0.5, 0.5)` is the dust cap
 * of the REFERENCE CONE, and the layout is polar about it.
 *
 * WHAT THAT REQUIRES OF THE GRAPHIC: the renderer must draw one reference cone
 * centred on the baffle. If it also draws the surrounding cones of a 4×12, those
 * are decorative — no mic here is positioned relative to them. (A 2×2 cone grid
 * like guitar-tutor's puts (0.5, 0.5) in the gap *between* four cones, which would
 * make every "cap" mic land in the crack; don't do that without re-deriving every
 * radius below, since re-anchoring is not a translation — `gods-room-87` at
 * r = 0.45 from a corner cone falls off the baffle entirely.)
 *
 *   RADIUS = brightness. On a real cab, a mic on the dust cap is brightest and
 *   most present; walking it out across the cone toward the surround loses treble
 *   and gains body; backing it off the baffle entirely trades bite for air and
 *   room. So radius reads darker as it grows, in four bands:
 *
 *     r 0.13–0.16  cap / brightest   bright-57 .13, crunch-57-ts .13,
 *                                    catharsis-bright .15, twin-clean .16
 *     r 0.26–0.28  cone-near         warm-421 .26, catharsis-balanced .28
 *     r 0.37–0.41  cone-far/off-axis dark-421 .37, catharsis-mellow .41
 *     r 0.45       off the baffle    room-87 — deliberately the largest of all
 *
 *   The BANDS are a global claim: anything in the cap band is brighter than
 *   anything in the cone-near band, and so on. The fine ordering *within* a band
 *   is only meaningful within one source family — a Recto sum and a Twin combo
 *   are different cabinets, and 0.02 of radius between them asserts nothing.
 *
 *   ANGLE = which capture, and carries no tonal claim. It only keeps the three
 *   sources from stacking on top of each other so every one stays reachable by
 *   drag:
 *
 *     left half  (155°–205°)  God's Cab — the multi-mic Mesa V30 4×12 pack
 *     right      (0°)         Catharsis — one spoke, presence rising toward the cap
 *     up         (90°)        Twin — a different cabinet entirely
 *
 * Two places the physical metaphor is knowingly imperfect, both preferred to the
 * alternative of dropping the metaphor:
 *
 *   - `gods-crunch-57-ts` is the SAME SM57-on-cap placement as `gods-bright-57`
 *     with a Tube Screamer baked in front. A pedal is not a position, so no
 *     honest coordinate exists. It is mirrored across the cap onto the same
 *     radius: equally bright (true), at a distinct point (necessary).
 *   - `twin-clean` is a Fender Twin 2×12 combo and the three `catharsis-*` are
 *     pre-mixed multi-mic sums, so neither has a single real mic position. They
 *     are placed by the tone their descriptions claim — the same brightness rule,
 *     read backwards from the result instead of forwards from the mic. Twin sits
 *     in the cap band because "pristine headroom, glassy top" is the brightest
 *     description in the registry; it gets its own spoke because it is not a
 *     position on this cab at all.
 *
 * `twin-clean` also means one of nine entries is not a 4×12, so a hardcoded 4×12
 * graphic is slightly wrong for it. Noted rather than solved.
 */

import { CABINET_IRS, getCabinetIR, type CabinetIR } from '@fretwork/lib';

/** A point on the baffle, normalized 0..1. y is DOWNWARD, matching SVG. */
export interface MicPosition {
  readonly x: number;
  readonly y: number;
}

/** A registry IR paired with where it sits on the baffle. */
export interface PlacedCabinetIR {
  readonly ir: CabinetIR;
  readonly position: MicPosition;
  /** True when the capture is in front of the cab rather than on it. Its radius
   *  encodes distance-from-cap like every other, so drawn plainly it would read
   *  as one more on-cone mic; the graphic should give it a depth cue instead. */
  readonly distant: boolean;
}

/** Dust cap of the reference cone — the origin the whole layout is polar about. */
const CAP = { x: 0.5, y: 0.5 } as const;

/** Polar about the cap. `angleDeg` is the usual maths convention (0° = right,
 *  90° = up), flipped into screen space here so the constants below read the way
 *  a person describes a mic position rather than the way SVG stores one. */
function fromCap(angleDeg: number, radius: number): MicPosition {
  const radians = (angleDeg * Math.PI) / 180;
  // Frozen because the same object is handed to every caller of `micPositionFor`
  // and is what `nearestIrAt` measures against — a stray mutation would move the
  // dot for everyone afterwards.
  return Object.freeze({
    x: CAP.x + radius * Math.cos(radians),
    y: CAP.y - radius * Math.sin(radians),
  });
}

/** id → placement, in registry order. An entry here for an id the lib does not
 *  register is silently dropped; a registry entry missing from here is a test
 *  failure, which is the direction that matters — the lib gaining an IR must not
 *  quietly produce a cab the dot cannot reach. */
const PLACEMENTS: readonly (readonly [id: string, angleDeg: number, radius: number])[] = [
  // Its own spoke: a different cabinet, not a position on this one. Cap-band
  // radius for the glassiest top in the registry.
  ['twin-clean', 90, 0.16],

  // God's Cab — the only genuinely positional family, spread over the left half.
  ['gods-warm-421', 180, 0.26], // "cone-near", warm and balanced
  ['gods-dark-421', 205, 0.37], // "cone-far", off-axis, softer attack
  ['gods-bright-57', 155, 0.13], // "cap", the brightest capture in the set
  ['gods-room-87', 155, 0.45], // 2 ft back — furthest out by construction
  ['gods-crunch-57-ts', 205, 0.13], // same cap ring as bright-57, mirrored (see header)

  // Catharsis — one spoke, presence falling as it walks off the cap.
  ['catharsis-mellow', 0, 0.41],
  ['catharsis-balanced', 0, 0.28],
  ['catharsis-bright', 0, 0.15],
];

/** Exported so the test can check the placement list against the registry in the
 *  direction `PLACED_CABINET_IRS` cannot: a stale or duplicated id here is
 *  invisible in the placed set, because both just drop out. */
export const PLACEMENT_IDS: readonly string[] = PLACEMENTS.map(([id]) => id);

/** Captures made in front of the cab rather than on the baffle. See `distant`. */
const DISTANT_IDS: ReadonlySet<string> = new Set(['gods-room-87']);

const POSITIONS_BY_ID: ReadonlyMap<string, MicPosition> = new Map(
  PLACEMENTS.map(([id, angleDeg, radius]) => [id, fromCap(angleDeg, radius)]),
);

/** Every registered IR that has a position, in registry order. The graphic renders
 *  one candidate dot per entry. */
export const PLACED_CABINET_IRS: readonly PlacedCabinetIR[] = CABINET_IRS.flatMap((ir) => {
  const position = POSITIONS_BY_ID.get(ir.id);
  return position === undefined ? [] : [{ ir, position, distant: DISTANT_IDS.has(ir.id) }];
});

/** Where an IR's mic sits on the baffle. `null` for an id the registry does not
 *  know, or a known id this module has not placed. */
export function micPositionFor(irId: string): MicPosition | null {
  if (getCabinetIR(irId) === undefined) return null;
  return POSITIONS_BY_ID.get(irId) ?? null;
}

const distanceSquared = (a: MicPosition, b: MicPosition): number =>
  (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/** The IR a dragged dot snaps to. Nearest by straight-line distance; points
 *  outside 0..1 are not clamped, since the nearest placement is still the right
 *  answer for them. Points off the number line are not: a drag handler dividing
 *  by a zero-sized baffle rect (a collapsed-but-mounted pane, or anything in
 *  jsdom) produces `NaN`, every comparison against it is false, and a silent
 *  "nearest" answer would be whichever IR happens to be first. Loud instead. */
export function nearestIrAt(point: MicPosition): CabinetIR {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error(`nearestIrAt: point is not finite (${point.x}, ${point.y})`);
  }
  let best: PlacedCabinetIR | undefined;
  let bestDistance = Infinity;
  for (const candidate of PLACED_CABINET_IRS) {
    const distance = distanceSquared(point, candidate.position);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  if (best === undefined) {
    // Unreachable while any registry entry is placed, and `micPositions.test.ts`
    // fails the moment one is not. Thrown rather than widened to `| null` so
    // callers do not carry a branch for a state the test forbids.
    throw new Error('nearestIrAt: no cabinet IR has a mic position');
  }
  return best.ir;
}
