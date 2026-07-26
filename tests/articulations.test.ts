import { describe, it, expect } from 'vitest';
import {
  buildCurve,
  parseCurve,
  toEventPatch,
  readPitchSpec,
  EMPTY_PITCH,
  type PitchSpec,
} from '../src/patterns/articulations';

const at = (points: { at: number; semitones: number }[], position: number) =>
  points.find((p) => p.at === position)?.semitones;

describe('buildCurve', () => {
  it('returns nothing when the note has no pitch movement', () => {
    expect(buildCurve(EMPTY_PITCH)).toBeUndefined();
  });

  it('ramps into the note from below', () => {
    const points = buildCurve({ ...EMPTY_PITCH, in: { semitones: -2, at: 0.15 } })!;

    expect(at(points, 0)).toBe(-2);
    expect(at(points, 0.15)).toBe(0);
    expect(points.at(-1)).toEqual({ at: 1, semitones: 0 });
  });

  it('ramps out of the note upward', () => {
    const points = buildCurve({ ...EMPTY_PITCH, out: { semitones: 3, at: 0.85 } })!;

    expect(at(points, 0)).toBe(0);
    expect(at(points, 0.85)).toBe(0);
    expect(at(points, 1)).toBe(3);
  });

  // The lib's typed `slide` field only holds one direction — as a curve, both fit.
  it('combines a slide in and a slide out on the same note', () => {
    const points = buildCurve({
      in: { semitones: -2, at: 0.15 },
      out: { semitones: 3, at: 0.85 },
      bend: undefined,
    })!;

    expect(at(points, 0)).toBe(-2);
    expect(at(points, 0.15)).toBe(0);
    expect(at(points, 0.85)).toBe(0);
    expect(at(points, 1)).toBe(3);
  });

  it('bends across an arbitrary span of the note', () => {
    const points = buildCurve({
      ...EMPTY_PITCH,
      bend: { semitones: 2, start: 0.25, end: 0.6 },
    })!;

    expect(at(points, 0)).toBe(0);
    expect(at(points, 0.25)).toBe(0);
    expect(at(points, 0.6)).toBe(2);
    expect(points.at(-1)).toEqual({ at: 1, semitones: 2 }); // holds to the end
  });

  it('releases a bend back to pitch when asked', () => {
    const points = buildCurve({
      ...EMPTY_PITCH,
      bend: { semitones: 2, start: 0.2, end: 0.5, release: true },
    })!;

    expect(at(points, 0.5)).toBe(2);
    expect(points.at(-1)).toEqual({ at: 1, semitones: 0 });
  });

  it('keeps points in ascending order', () => {
    const points = buildCurve({
      in: { semitones: -2, at: 0.15 },
      out: { semitones: 3, at: 0.8 },
      bend: { semitones: 1, start: 0.3, end: 0.5 },
    })!;

    const positions = points.map((p) => p.at);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe('round-tripping through the event', () => {
  const cases: Array<[string, PitchSpec]> = [
    ['slide in', { ...EMPTY_PITCH, in: { semitones: -2, at: 0.15 } }],
    ['slide out', { ...EMPTY_PITCH, out: { semitones: 3, at: 0.85 } }],
    ['in and out', { in: { semitones: -2, at: 0.2 }, out: { semitones: 2, at: 0.8 }, bend: undefined }],
    ['bend', { ...EMPTY_PITCH, bend: { semitones: 2, start: 0.25, end: 0.6 } }],
    [
      'bend with release',
      { ...EMPTY_PITCH, bend: { semitones: 2, start: 0.2, end: 0.5, release: true } },
    ],
  ];

  it.each(cases)('survives a write/read cycle: %s', (_label, spec) => {
    const patch = toEventPatch(spec);
    expect(parseCurve(patch.bend?.points)).toEqual(spec);
  });

  it('clears the bend field when there is no movement', () => {
    expect(toEventPatch(EMPTY_PITCH).bend).toBeUndefined();
  });

  it('reads an empty spec from an event with no articulation', () => {
    expect(readPitchSpec({})).toEqual(EMPTY_PITCH);
  });
});
