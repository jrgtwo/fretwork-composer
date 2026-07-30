import { CABINET_IRS } from '@fretwork/lib';
import { describe, expect, it } from 'vitest';
import {
  PLACED_CABINET_IRS,
  PLACEMENT_IDS,
  micPositionFor,
  nearestIrAt,
  type MicPosition,
} from './micPositions';

/** Below this, two dots overlap closely enough on any plausible baffle size that
 *  a drag cannot reliably land on the nearer one — so one of the pair becomes
 *  unreachable. The layout's tightest pair is `gods-bright-57` /
 *  `gods-crunch-57-ts`, deliberately on the same radius; this is the floor that
 *  keeps even them separable. */
const MIN_SEPARATION = 0.1;

const distance = (a: MicPosition, b: MicPosition): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

const positionOf = (id: string): MicPosition => {
  const position = micPositionFor(id);
  if (position === null) throw new Error(`unplaced: ${id}`);
  return position;
};

describe('the placement covers the registry', () => {
  // Iterating CABINET_IRS rather than a local list is the point: an IR added to
  // the lib fails here until someone decides where on the baffle it belongs.
  it.each(CABINET_IRS.map((ir) => [ir.id]))('places %s', (id) => {
    expect(micPositionFor(id)).not.toBeNull();
  });

  it('exposes every registered IR in the placed set, in registry order', () => {
    expect(PLACED_CABINET_IRS).toHaveLength(CABINET_IRS.length);
    expect(PLACED_CABINET_IRS.map((placed) => placed.ir.id)).toEqual(
      CABINET_IRS.map((ir) => ir.id),
    );
  });

  // The placed set can't catch these: a stale id and a duplicated id both just
  // vanish from it (one misses the registry, the other is swallowed by the Map),
  // leaving an IR silently unreachable rather than failing.
  it('places only ids the registry actually knows', () => {
    const registered = new Set(CABINET_IRS.map((ir) => ir.id));
    expect(PLACEMENT_IDS.filter((id) => !registered.has(id))).toEqual([]);
  });

  it('places each id exactly once', () => {
    expect(PLACEMENT_IDS).toHaveLength(new Set(PLACEMENT_IDS).size);
  });

  it('is null for an id the registry does not know', () => {
    expect(micPositionFor('no-such-cab')).toBeNull();
    expect(micPositionFor('')).toBeNull();
  });
});

describe('positions', () => {
  it.each(PLACED_CABINET_IRS.map((placed) => [placed.ir.id, placed.position]))(
    '%s sits inside the baffle',
    (_id, position) => {
      expect(position.x).toBeGreaterThanOrEqual(0);
      expect(position.x).toBeLessThanOrEqual(1);
      expect(position.y).toBeGreaterThanOrEqual(0);
      expect(position.y).toBeLessThanOrEqual(1);
    },
  );

  it('keeps every pair far enough apart to be reachable by drag', () => {
    let closest = { gap: Infinity, pair: '(none)' };
    PLACED_CABINET_IRS.forEach((a, i) => {
      PLACED_CABINET_IRS.slice(i + 1).forEach((b) => {
        const gap = distance(a.position, b.position);
        if (gap < closest.gap) closest = { gap, pair: `${a.ir.id} ↔ ${b.ir.id}` };
      });
    });
    // The measured minimum is named in the failure, not just thresholded: the
    // margin is thin by design (the two cap SM57s sit on one radius), so a
    // cosmetic tweak that nearly collides should say which pair it was.
    expect(closest.gap, `closest pair: ${closest.pair}`).toBeGreaterThanOrEqual(MIN_SEPARATION);
  });

  // Nothing else pins the sign of the y term: reflecting the whole layout about
  // the horizontal is an isometry, so bounds, separations and round-trips all
  // survive it. These two anchors are what say "y is DOWN".
  it('reads 90° as up the screen, SVG-style', () => {
    const twin = positionOf('twin-clean');
    expect(twin.x).toBeCloseTo(0.5, 10);
    expect(twin.y).toBeCloseTo(0.34, 10);
  });

  it('puts the 155° cap mic above the cap and its 205° mirror below', () => {
    const bright = positionOf('gods-bright-57');
    const crunch = positionOf('gods-crunch-57-ts');
    expect(bright.y).toBeLessThan(0.5);
    expect(crunch.y).toBeGreaterThan(0.5);
    expect((bright.y + crunch.y) / 2).toBeCloseTo(0.5, 10);
  });

  it('marks only the room capture as off the baffle', () => {
    expect(PLACED_CABINET_IRS.filter((placed) => placed.distant).map((p) => p.ir.id)).toEqual([
      'gods-room-87',
    ]);
  });
});

describe('nearestIrAt', () => {
  // The round trip is what makes the dot a picker rather than a display: clicking
  // exactly on a rendered dot must select the IR that dot represents.
  it.each(CABINET_IRS.map((ir) => [ir.id]))('round-trips %s', (id) => {
    expect(nearestIrAt(positionOf(id)).id).toBe(id);
  });

  it('still round-trips when the drag lands just off the exact dot', () => {
    // Half the minimum separation is the worst nudge that must still resolve to
    // the same IR — beyond that another dot is legitimately closer.
    const nudge = MIN_SEPARATION / 2 - 1e-6;
    expect(PLACED_CABINET_IRS).not.toHaveLength(0);
    for (const { ir, position } of PLACED_CABINET_IRS) {
      for (const [dx, dy] of [
        [nudge, 0],
        [-nudge, 0],
        [0, nudge],
        [0, -nudge],
      ]) {
        expect(nearestIrAt({ x: position.x + dx, y: position.y + dy }).id).toBe(ir.id);
      }
    }
  });

  it('answers for points outside the baffle instead of clamping or failing', () => {
    // A drag can run past the edge of the graphic; the nearest placement is still
    // the right answer, so there is no clamp and no null return to handle.
    expect(nearestIrAt({ x: -5, y: 0.5 }).id).toBe('gods-room-87');
    expect(nearestIrAt({ x: 5, y: 0.5 }).id).toBe('catharsis-mellow');
    // One baffle-height above the top edge, not five: far enough out and the
    // answer is dominated by x, where the room mic is the extreme.
    expect(nearestIrAt({ x: 0.5, y: -1 }).id).toBe('twin-clean');
  });

  // A pointer handler dividing by a 0×0 baffle rect hands us NaN. Every distance
  // comparison against NaN is false, so without the guard this silently returns
  // whichever IR is first in the registry.
  it.each([
    ['NaN', { x: Number.NaN, y: Number.NaN }],
    ['Infinity', { x: Number.POSITIVE_INFINITY, y: Number.NEGATIVE_INFINITY }],
    ['one bad axis', { x: 0.5, y: Number.NaN }],
  ])('refuses a %s point rather than guessing', (_label, point) => {
    expect(() => nearestIrAt(point)).toThrow(/not finite/);
  });
});

describe('the brightness claim the layout makes', () => {
  const radiusOf = (id: string): number => {
    const position = positionOf(id);
    return Math.hypot(position.x - 0.5, position.y - 0.5);
  };

  // Radius is the load-bearing axis: outward from the dust cap reads darker and
  // warmer. These orderings are the header comment's claim, asserted.
  it('walks the God’s Cab mics outward as they darken', () => {
    expect(radiusOf('gods-bright-57')).toBeLessThan(radiusOf('gods-warm-421'));
    expect(radiusOf('gods-warm-421')).toBeLessThan(radiusOf('gods-dark-421'));
  });

  it('walks the Catharsis presences outward as they mellow', () => {
    expect(radiusOf('catharsis-bright')).toBeLessThan(radiusOf('catharsis-balanced'));
    expect(radiusOf('catharsis-balanced')).toBeLessThan(radiusOf('catharsis-mellow'));
  });

  // The header's bands are a *global* claim, so the cross-family entries have to
  // be pinned too — twin-clean is the registry's brightest description and must
  // not drift out of the cap band into cone territory.
  it('keeps the whole cap band inside every cone radius', () => {
    const capBand = ['gods-bright-57', 'gods-crunch-57-ts', 'catharsis-bright', 'twin-clean'];
    const coneBand = [
      'gods-warm-421',
      'catharsis-balanced',
      'gods-dark-421',
      'catharsis-mellow',
      'gods-room-87',
    ];
    const brightest = Math.max(...capBand.map(radiusOf));
    const nearestCone = Math.min(...coneBand.map(radiusOf));
    expect(brightest).toBeLessThan(nearestCone);
  });

  it('puts the room mic furthest out of anything on the baffle', () => {
    const roomRadius = radiusOf('gods-room-87');
    for (const { ir } of PLACED_CABINET_IRS) {
      if (ir.id === 'gods-room-87') continue;
      expect(radiusOf(ir.id)).toBeLessThan(roomRadius);
    }
  });

  it('keeps the two SM57 cap captures on the same radius', () => {
    // Same physical placement, differing only by a pedal in front — the layout
    // cannot say "same spot", so it says "same brightness" instead.
    expect(radiusOf('gods-crunch-57-ts')).toBeCloseTo(radiusOf('gods-bright-57'), 10);
  });
});
