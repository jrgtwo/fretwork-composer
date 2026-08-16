import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PATTERNS_STATE, PPQ, usePatternsStore } from '@fretwork/lib';
import { assembleArrangement } from '../src/ai/arrangementAssembly';
import { reviewPlan } from '../src/ai/arrangementPlan';
import type { ArrangementAssembly } from '../src/ai/arrangementAssembly';
import type { ArrangementPlan } from '../src/ai/arrangementPlanSchema';
import {
  JOB_LOCK_REASON,
  MAX_COMPOSITION_TRACKS,
  TRACK_CAP_REASON,
  addTrack,
  beginJob,
  clearHistory as clearCompositionHistory,
  endEditGesture as endCompositionGesture,
  endJob,
  getTracks,
  openBlankComposition,
  setCompositionTimeSignature,
  setTrackName,
} from '../src/composition/compositionService';
import {
  clearHistory as clearPatternHistory,
  endEditGesture as endPatternGesture,
  openBlankPattern,
  stampNote,
} from '../src/patterns/patternService';

/**
 * OR-04 — assembly: the arrangement built in plain code.
 *
 * ⚠ THERE IS NO MODEL IN THIS FILE and there cannot be one. The whole claim of
 * the ticket is that the mechanical half of the job — bars to ticks, copies to
 * blocks, tracks to lanes — is arithmetic, and every defect the last four rounds
 * paid a failed run to find lives in it. So each test below is the plan step's
 * output plus a map of pattern ids, driven straight through the seam.
 *
 * The store underneath is REAL, for `AgentTools.test.ts`'s reason: a mock would
 * assert away the only thing worth asserting, which is that the write lands
 * where the UI's write lands — including the track cap, the empty-name rule and
 * the deep-copied snapshot.
 */

/** 4/4, which is what `createEmptyComposition` seeds. Written out rather than
 *  imported so a change to the lib's default fails the fixtures loudly instead
 *  of silently re-basing every bar number below. */
const TICKS_PER_BAR = PPQ * 4;

beforeEach(() => {
  sessionStorage.clear();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  // Module state on the seams: a job left open, or a bracket left nested, would
  // refuse or mis-record every write in every test after it.
  endJob();
  for (let i = 0; i < 8; i += 1) endCompositionGesture(false);
  for (let i = 0; i < 8; i += 1) endPatternGesture(false);
  clearPatternHistory();
  clearCompositionHistory();
  const opened = openBlankComposition('Arrangement');
  if (!opened.ok) throw new Error(opened.reason);
});

// --------------------------------------------------------------- fixtures ---

/**
 * A pattern in the library, exactly `lengthBars` long.
 *
 * The length is ASSERTED rather than assumed: `fitPatternDuration` rounds a
 * pattern UP to the bar its last note ends in with a one-bar minimum, so a
 * fixture that stamped the wrong duration would quietly be a different length
 * than the plan it is placed from — which is the very hazard two of the tests
 * below are about, and it must not reach them by accident.
 */
function seedPattern(name: string, lengthBars = 1): string {
  const opened = openBlankPattern(name);
  if (!opened.ok) throw new Error(opened.reason);
  const stamped = stampNote({
    stringIndex: 0,
    fret: 5,
    tick: 0,
    durationTicks: TICKS_PER_BAR * lengthBars,
  });
  if (!stamped.ok) throw new Error(stamped.reason);
  const pattern = usePatternsStore
    .getState()
    .library.patterns.find((candidate) => candidate.id === opened.value.id);
  expect(pattern?.durationTicks).toBe(TICKS_PER_BAR * lengthBars);
  return opened.value.id;
}

/** The map assembly takes: every planned pattern name to a pattern of the
 *  planned length, unless `except` says a sub-run failed to write it. */
function buildPatterns(plan: ArrangementPlan, except: readonly string[] = []): Map<string, string> {
  const built = new Map<string, string>();
  for (const pattern of plan.patterns) {
    if (except.includes(pattern.name)) continue;
    built.set(pattern.name, seedPattern(pattern.name, pattern.lengthBars));
  }
  return built;
}

/**
 * A twelve-bar blues in C, as a plan — the same form `ArrangementPlan.test.ts`
 * grades, so the two steps are exercised against one fixture. One pattern per
 * chord, each placed at every bar its chord covers: C7 over 1-4, 7-8 and 11,
 * F7 over 5-6 and 10, G7 over 9 and 12.
 *
 * ⚠ EACH PATTERN IS PLACED ON BOTH TRACKS — one pattern used twice is two
 * placement entries, which is the plan's own rule and worth having in the
 * fixture. That it puts a guitar pattern on a bass track is deliberate too:
 * `reviewPlan` declines to police the instrument match because the write path
 * permits it, and assembly is not stricter than the tools it assembles for.
 */
const bluesPlan = (): ArrangementPlan => ({
  bars: 12,
  tracks: [
    { name: 'Rhythm Guitar', instrumentId: 'guitar' },
    { name: 'Bass', instrumentId: 'bass' },
  ],
  patterns: [
    { name: 'C7 Comp', instrumentId: 'guitar', chord: 'C7', lengthBars: 1 },
    { name: 'F7 Comp', instrumentId: 'guitar', chord: 'F7', lengthBars: 1 },
    { name: 'G7 Comp', instrumentId: 'guitar', chord: 'G7', lengthBars: 1 },
  ],
  placements: [
    { patternName: 'C7 Comp', trackName: 'Rhythm Guitar', atBars: [1, 2, 3, 4, 7, 8, 11] },
    { patternName: 'F7 Comp', trackName: 'Rhythm Guitar', atBars: [5, 6, 10] },
    { patternName: 'G7 Comp', trackName: 'Rhythm Guitar', atBars: [9, 12] },
    { patternName: 'C7 Comp', trackName: 'Bass', atBars: [1, 2, 3, 4, 7, 8, 11] },
    { patternName: 'F7 Comp', trackName: 'Bass', atBars: [5, 6, 10] },
    { patternName: 'G7 Comp', trackName: 'Bass', atBars: [9, 12] },
  ],
});

// ---------------------------------------------------------------- helpers ---

const built = (result: ReturnType<typeof assembleArrangement>): ArrangementAssembly => {
  if (!result.ok) throw new Error(`assembly refused: ${result.reason}`);
  return result.value;
};

const reason = (result: ReturnType<typeof assembleArrangement>): string => {
  if (result.ok) throw new Error('expected a refusal');
  return result.reason;
};

/** Every block in the document, as `trackName@bar`, in document order — the
 *  shape a wrong bar or a missing copy is legible in. */
function documentBlocks(): string[] {
  return getTracks().flatMap((track) =>
    track.placements.map(
      (placement) => `${track.name}@${placement.startTick / TICKS_PER_BAR + 1}`,
    ),
  );
}

/** The bars a track's blocks cover, so "no gaps" can be asserted as a set rather
 *  than as a count that agrees with itself. */
function coveredBars(trackName: string): number[] {
  const track = getTracks().find((candidate) => candidate.name === trackName);
  if (!track) throw new Error(`no such track: ${trackName}`);
  const bars = new Set<number>();
  for (const placement of track.placements) {
    const from = placement.startTick / TICKS_PER_BAR;
    const length = placement.patternSnapshot.durationTicks / TICKS_PER_BAR;
    for (let bar = from; bar < from + length; bar += 1) bars.add(bar + 1);
  }
  return [...bars].sort((a, b) => a - b);
}

/** Any two blocks on one track that share a tick. The named failure from
 *  2026-08-11, asserted directly against the document rather than trusted to the
 *  report. */
function overlaps(): string[] {
  const found: string[] = [];
  for (const track of getTracks()) {
    const sorted = [...track.placements].sort((a, b) => a.startTick - b.startTick);
    for (let i = 1; i < sorted.length; i += 1) {
      const before = sorted[i - 1];
      if (before.startTick + before.patternSnapshot.durationTicks > sorted[i].startTick) {
        found.push(`${track.name}: ${before.id} over ${sorted[i].id}`);
      }
    }
  }
  return found;
}

/** THE IDENTITY the report offers: every planned copy is a block or a hole. */
function accountsForEveryCopy(assembly: ArrangementAssembly): boolean {
  const missing = assembly.holes.reduce((total, hole) => total + hole.bars.length, 0);
  return assembly.blocks.length + missing === assembly.plannedBlocks;
}

// -------------------------------------------------------------- assembling ---

describe('assembling a validated plan', () => {
  it('builds the twelve-bar blues: two tracks, twelve bars each, no gaps, no overlaps', () => {
    const plan = bluesPlan();
    const assembly = built(assembleArrangement(plan, buildPatterns(plan)));

    // The tracks the plan named, and NOT one more: the composition arrived with
    // an empty guitar 'Track 1', which the guitar part takes over.
    expect(getTracks().map((track) => track.name)).toEqual(['Rhythm Guitar', 'Bass']);
    expect(assembly.tracks.map((track) => `${track.plannedName}/${track.instrumentId}`)).toEqual([
      'Rhythm Guitar/guitar',
      'Bass/bass',
    ]);

    // Every copy the plan asked for, at the bar it asked for. Twelve per track,
    // and the bar numbers are the FORM's — the off-by-one in bar 1 → tick 0 is
    // the single most expensive arithmetic mistake in this epic's history.
    expect(assembly.blocks).toHaveLength(24);
    expect(assembly.holes).toEqual([]);
    expect(accountsForEveryCopy(assembly)).toBe(true);
    expect(coveredBars('Rhythm Guitar')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(coveredBars('Bass')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(overlaps()).toEqual([]);

    // Bar 1 is tick 0 and bar 12 is eleven bars in — stated as ticks so the
    // conversion is pinned and not merely round-tripped through itself.
    const firstC7 = assembly.blocks.find((block) => block.bar === 1);
    expect(firstC7?.startTick).toBe(0);
    expect(firstC7?.endTick).toBe(TICKS_PER_BAR);
    expect(assembly.blocks.find((block) => block.bar === 12)?.startTick).toBe(TICKS_PER_BAR * 11);

    // The right PATTERN in the right bar, not merely the right number of them:
    // the 2026-08-11 run reported a I7-IV7 progression over one pattern placed
    // four times.
    const guitar = assembly.blocks.filter((block) => block.trackName === 'Rhythm Guitar');
    expect(guitar.filter((block) => block.patternName === 'F7 Comp').map((b) => b.bar)).toEqual([
      5, 6, 10,
    ]);
    expect(guitar.filter((block) => block.patternName === 'G7 Comp').map((b) => b.bar)).toEqual([
      9, 12,
    ]);

    expect(assembly.bars).toBe(12);
    // A plan that covers its form reports no empty bars — forwarded from the
    // review, so this also pins that the two steps agree about this fixture.
    expect(assembly.emptyBars).toEqual([]);
  });

  it('reports blocks in PLAN order, not document order, each starting where it says', () => {
    // The two orders come apart exactly when a later planned track reuses an
    // earlier existing one: 'Track 1' arrived empty and on guitar, so the guitar
    // part — declared SECOND here — takes it over at document index 0 while the
    // bass part is appended after it.
    const plan: ArrangementPlan = {
      ...bluesPlan(),
      tracks: [
        { name: 'Bass', instrumentId: 'bass' },
        { name: 'Rhythm Guitar', instrumentId: 'guitar' },
      ],
    };
    const assembly = built(assembleArrangement(plan, buildPatterns(plan)));

    expect(getTracks().map((track) => track.name)).toEqual(['Rhythm Guitar', 'Bass']);
    const order = [...new Set(assembly.blocks.map((block) => block.trackName))];
    expect(order).toEqual(['Bass', 'Rhythm Guitar']);
    // …and by start tick within a track, which is what a reader scanning the
    // report down a lane is entitled to assume.
    for (const trackName of order) {
      const bars = assembly.blocks
        .filter((block) => block.trackName === trackName)
        .map((block) => block.bar);
      expect(bars).toEqual([...bars].sort((a, b) => a - b));
    }

    // The report is read back off the document, so the two cannot disagree —
    // asserted because "reported placed" and "is in the arrangement" came apart
    // in every failed run this epic is answering.
    for (const block of assembly.blocks) {
      const track = getTracks().find((candidate) => candidate.id === block.trackId);
      const placement = track?.placements.find((p) => p.id === block.placementId);
      expect(placement?.startTick).toBe(block.startTick);
    }
    expect(documentBlocks()).toHaveLength(24);
  });

  it('forwards the empty bars the plan step measured, rather than an empty list', () => {
    // The 2026-08-11 failure was eight bars of nothing that nothing reported. The
    // field is the plan step's measurement, forwarded — so what is pinned here is
    // that it is forwarded AT ALL, and that it says the same as the review does.
    const plan: ArrangementPlan = {
      bars: 8,
      tracks: [{ name: 'Rhythm', instrumentId: 'guitar' }],
      patterns: [{ name: 'Cell', instrumentId: 'guitar', chord: 'A7', lengthBars: 1 }],
      placements: [{ patternName: 'Cell', trackName: 'Rhythm', atBars: [1, 2] }],
    };
    expect(reviewPlan(plan).refusals).toEqual([]);
    const assembly = built(assembleArrangement(plan, buildPatterns(plan)));

    expect(assembly.emptyBars).toEqual([{ trackName: 'Rhythm', emptyBars: [{ from: 3, to: 8 }] }]);
    expect(assembly.emptyBars).toEqual(reviewPlan(plan).emptyBars);
    // And it is a statement about the PLAN: the blocks really are only in bars 1
    // and 2, so the two accounts agree here and `holes` is empty.
    expect(coveredBars('Rhythm')).toEqual([1, 2]);
    expect(assembly.holes).toEqual([]);
  });
});

// ---------------------------------------------------------------- refusals ---

describe('a plan that cannot be built', () => {
  it('refuses what reviewPlan refuses, and writes nothing at all', () => {
    // The 2026-08-11 failure exactly: a two-bar pattern at four consecutive
    // bars, four copies stacked.
    const plan: ArrangementPlan = {
      bars: 8,
      tracks: [{ name: 'Riff', instrumentId: 'guitar' }],
      patterns: [{ name: 'Riff A', instrumentId: 'guitar', chord: 'A7', lengthBars: 2 }],
      placements: [{ patternName: 'Riff A', trackName: 'Riff', atBars: [1, 2, 3, 4] }],
    };
    const patterns = buildPatterns(plan);
    // The premise: the plan step turns this away, so assembly must too rather
    // than discovering it a write at a time.
    expect(reviewPlan(plan).refusals.length).toBeGreaterThan(0);

    const refusal = reason(assembleArrangement(plan, patterns));
    expect(refusal).toContain('nothing was written');
    // The plan step's own sentence, passed on rather than re-authored.
    expect(refusal).toContain(reviewPlan(plan).refusals[0].reason);

    // NOTHING WRITTEN: not a block, and not the track either. The composition is
    // exactly as it arrived.
    expect(getTracks().map((track) => track.name)).toEqual(['Track 1']);
    expect(documentBlocks()).toEqual([]);
  });

  it('refuses a plan that needs more tracks than the composition can hold, naming the cap', () => {
    // One MORE than the cap allows, counting the empty 'Track 1' already there —
    // which is the half `reviewPlan` cannot see, since it grades the plan alone.
    const tracks = Array.from({ length: MAX_COMPOSITION_TRACKS }, (_, i) => ({
      name: `Part ${i + 1}`,
      instrumentId: 'bass',
    }));
    const plan: ArrangementPlan = {
      bars: 1,
      tracks,
      patterns: [{ name: 'Note', instrumentId: 'bass', chord: 'A7', lengthBars: 1 }],
      placements: tracks.map((track) => ({
        patternName: 'Note',
        trackName: track.name,
        atBars: [1],
      })),
    };
    // The plan itself is legal — it declares exactly the cap, so the review
    // passes and the refusal below is assembly's own.
    expect(reviewPlan(plan).refusals).toEqual([]);

    const refusal = reason(assembleArrangement(plan, buildPatterns(plan)));
    expect(refusal).toContain(TRACK_CAP_REASON);
    // The ARITHMETIC, which is the part that could be wrong — `TRACK_CAP_REASON`
    // already carries the cap's own number twice, so asserting that alone
    // asserts nothing this module computed.
    expect(refusal).toContain(
      `${MAX_COMPOSITION_TRACKS} new tracks beside the 1 track already here, which is ${
        MAX_COMPOSITION_TRACKS + 1
      } in all`,
    );
    expect(refusal).toContain('Nothing was written');
    // Nothing written, again — the cap is checked before the first add, not
    // discovered on the eighth.
    expect(getTracks()).toHaveLength(1);
  });

  it('refuses a signature whose bars are not a whole number of ticks', () => {
    // 4/7 — `composition_set_settings` takes any denominator from 1 to 32, and a
    // plan is written in bars and only bars. `barMath` returns no converter, and
    // rounding would put a block a fraction short of its own barline.
    const set = setCompositionTimeSignature({ numerator: 4, denominator: 7 });
    expect(set.ok).toBe(true);
    const plan = bluesPlan();
    const refusal = reason(assembleArrangement(plan, buildPatterns(plan)));
    expect(refusal).toContain('4/7');
    expect(refusal).toContain('Nothing was written');
    expect(documentBlocks()).toEqual([]);
  });

  it('refuses a track planned for an instrument a track cannot be on', () => {
    // Rule 3: the plan schema constrains instruments to the PATTERN catalog and a
    // track's comes from `listTrackInstruments`. `reviewPlan` has no document and
    // cannot ask, so a divergence between the two lands here — before the first
    // write, rather than as a track that failed to add halfway through.
    const plan: ArrangementPlan = {
      bars: 1,
      tracks: [{ name: 'Horns', instrumentId: 'trumpet' }],
      patterns: [{ name: 'Stab', instrumentId: 'guitar', chord: 'A7', lengthBars: 1 }],
      placements: [{ patternName: 'Stab', trackName: 'Horns', atBars: [1] }],
    };
    expect(reviewPlan(plan).refusals).toEqual([]);

    const refusal = reason(assembleArrangement(plan, buildPatterns(plan)));
    expect(refusal).toContain('trumpet');
    expect(refusal).toContain('Nothing was written');
    expect(getTracks().map((track) => track.name)).toEqual(['Track 1']);
    expect(documentBlocks()).toEqual([]);
  });

  it('refuses a track whose planned name is blank once trimmed', () => {
    // Rule 4: the schema's `minLength: 1` stops "" and passes "   ", which
    // `addTrack` refuses — every accessible name in the track header is built
    // from it.
    const plan: ArrangementPlan = {
      bars: 1,
      tracks: [{ name: '   ', instrumentId: 'guitar' }],
      patterns: [{ name: 'Stab', instrumentId: 'guitar', chord: 'A7', lengthBars: 1 }],
      placements: [{ patternName: 'Stab', trackName: '   ', atBars: [1] }],
    };
    expect(reviewPlan(plan).refusals).toEqual([]);

    const refusal = reason(assembleArrangement(plan, buildPatterns(plan)));
    expect(refusal).toContain('A track needs a name');
    expect(refusal).toContain('Nothing was written');
    expect(getTracks().map((track) => track.name)).toEqual(['Track 1']);
    expect(documentBlocks()).toEqual([]);
  });

  it('refuses the whole assembly when a job holds the document, rather than reporting holes', () => {
    // ⚠ THE FAILURE THIS EXISTS FOR: the pass is synchronous, so a lock held when
    // it starts is held for all of it. Discovering it one write at a time
    // returned `ok` with every block in the plan listed as a casualty — "reported
    // success, nothing in the document", which is the class this epic deletes.
    const plan = bluesPlan();
    const patterns = buildPatterns(plan);
    const release = beginJob();
    expect(release.ok).toBe(true);

    const refusal = reason(assembleArrangement(plan, patterns));
    expect(refusal).toContain(JOB_LOCK_REASON);
    expect(refusal).toContain('Nothing was written');
    // Not renamed, not added to, not written to — the reuse path renames a track
    // before it places anything, and a discarded rename refusal used to leave the
    // document changed by an assembly that reported nothing built.
    expect(getTracks().map((track) => track.name)).toEqual(['Track 1']);
    expect(documentBlocks()).toEqual([]);

    // …and the same plan builds once the job hands the document back, so what is
    // pinned is the LOCK and not some other defect in the fixture.
    endJob();
    expect(built(assembleArrangement(plan, patterns)).blocks).toHaveLength(24);
  });
});

// ------------------------------------------------------------ empty tracks ---

describe('an empty track already on the composition', () => {
  it('is reused rather than duplicated, and carries the planned name', () => {
    const plan = bluesPlan();
    const assembly = built(assembleArrangement(plan, buildPatterns(plan)));

    // 'Track 1' arrived empty and on guitar, so the guitar part took it over —
    // the 2026-08-11 failure was a second 'Guitar 1' beside exactly such a
    // track. The bass part had no empty bass track to take, so it was added.
    const guitar = assembly.tracks.find((track) => track.plannedName === 'Rhythm Guitar');
    expect(guitar?.reused).toBe(true);
    expect(guitar?.name).toBe('Rhythm Guitar');
    expect(assembly.tracks.find((track) => track.plannedName === 'Bass')?.reused).toBe(false);
    expect(getTracks()).toHaveLength(2);
    expect(getTracks().filter((track) => track.placements.length === 0)).toEqual([]);
  });

  it('is claimed by at most one planned part', () => {
    // Two empty guitar tracks and two guitar parts: each takes one, and neither
    // ends up sharing a lane — which would put every block of one part on top of
    // the other's.
    const second = addTrack('Spare', 'guitar');
    expect(second.ok).toBe(true);
    const plan: ArrangementPlan = {
      bars: 2,
      tracks: [
        { name: 'Rhythm', instrumentId: 'guitar' },
        { name: 'Lead', instrumentId: 'guitar' },
      ],
      patterns: [{ name: 'Cell', instrumentId: 'guitar', chord: 'A7', lengthBars: 1 }],
      placements: [
        { patternName: 'Cell', trackName: 'Rhythm', atBars: [1, 2] },
        { patternName: 'Cell', trackName: 'Lead', atBars: [1, 2] },
      ],
    };
    const assembly = built(assembleArrangement(plan, buildPatterns(plan)));
    expect(assembly.tracks.every((track) => track.reused)).toBe(true);
    expect(new Set(assembly.tracks.map((track) => track.trackId)).size).toBe(2);
    expect(getTracks()).toHaveLength(2);
    expect(overlaps()).toEqual([]);
  });

  it('gives each planned part the empty track of its own name, whatever order the plan lists them in', () => {
    // A NAME MATCH WINS over mere availability, and one greedy pass does not
    // implement that: 'Slide' is declared first, so it would take the empty
    // 'Lead' track and push 'Lead' onto 'Rhythm Guitar' — both of the user's
    // lanes shuffled, which is the outcome the rule exists to prevent.
    const renamed = setTrackName(getTracks()[0].id, 'Lead');
    expect(renamed.ok).toBe(true);
    const spare = addTrack('Rhythm Guitar', 'guitar');
    if (!spare.ok) throw new Error(spare.reason);
    const lead = getTracks().find((track) => track.name === 'Lead');
    expect(lead).toBeDefined();

    const plan: ArrangementPlan = {
      bars: 1,
      tracks: [
        { name: 'Slide', instrumentId: 'guitar' },
        { name: 'Lead', instrumentId: 'guitar' },
      ],
      patterns: [{ name: 'Cell', instrumentId: 'guitar', chord: 'A7', lengthBars: 1 }],
      placements: [
        { patternName: 'Cell', trackName: 'Slide', atBars: [1] },
        { patternName: 'Cell', trackName: 'Lead', atBars: [1] },
      ],
    };
    const assembly = built(assembleArrangement(plan, buildPatterns(plan)));

    expect(assembly.tracks.find((track) => track.plannedName === 'Lead')?.trackId).toBe(lead?.id);
    expect(assembly.tracks.find((track) => track.plannedName === 'Slide')?.trackId).toBe(
      spare.value.id,
    );
    expect(assembly.tracks.every((track) => track.reused)).toBe(true);
    expect(getTracks().map((track) => track.name)).toEqual(['Lead', 'Slide']);
  });

  it('leaves a track that has blocks on it alone, and numbers the name it would have taken', () => {
    // A 'Bass' track the user has already arranged is not a lane to write into:
    // the blocks there are theirs, and anything placed on top of them would be
    // an overlap this run cannot see coming. So a new track is added — with a
    // numbered name, because two tracks called 'Bass' make two headers
    // indistinguishable to a screen reader and to any by-name query.
    const existing = addTrack('Bass', 'bass');
    if (!existing.ok) throw new Error(existing.reason);
    const plan: ArrangementPlan = {
      bars: 1,
      tracks: [{ name: 'Bass', instrumentId: 'bass' }],
      patterns: [{ name: 'Walk', instrumentId: 'bass', chord: 'A7', lengthBars: 1 }],
      placements: [{ patternName: 'Walk', trackName: 'Bass', atBars: [1] }],
    };
    const patterns = buildPatterns(plan);
    // Give the user's track a block, so it is not an empty one to be reused —
    // this first pass takes over the empty 'Bass' track by name.
    const seeded = assembleArrangement(plan, patterns);
    expect(seeded.ok).toBe(true);
    expect(getTracks().find((track) => track.name === 'Bass')?.placements).toHaveLength(1);

    const assembly = built(assembleArrangement(plan, patterns));
    expect(assembly.tracks[0].plannedName).toBe('Bass');
    expect(assembly.tracks[0].name).toBe('Bass 2');
    expect(assembly.tracks[0].reused).toBe(false);
    expect(getTracks().map((track) => track.name)).toEqual(['Track 1', 'Bass', 'Bass 2']);
    expect(overlaps()).toEqual([]);
  });
});

// ------------------------------------------------------------------- holes ---

describe('what the sub-runs did not write', () => {
  it('reports a pattern with no built id as a hole and assembles the rest', () => {
    const plan = bluesPlan();
    // F7 is the sub-run that failed: nothing in the map for it.
    const assembly = built(assembleArrangement(plan, buildPatterns(plan, ['F7 Comp'])));

    // The rest is built — which is the decision, and the reason for it: the
    // user's next move is to re-run one pattern, and they can only see that if
    // the other nine bars are there to hear.
    expect(assembly.blocks).toHaveLength(18);
    expect(assembly.blocks.some((block) => block.patternName === 'F7 Comp')).toBe(false);
    expect(coveredBars('Rhythm Guitar')).toEqual([1, 2, 3, 4, 7, 8, 9, 11, 12]);

    // And the holes are NAMED — the bars, the track and the pattern. Eight bars
    // of nothing reported by nothing is the 2026-08-11 failure.
    expect(assembly.holes).toHaveLength(2);
    for (const hole of assembly.holes) {
      expect(hole.patternName).toBe('F7 Comp');
      expect(hole.cause).toBe('unwritten');
      expect(hole.bars).toEqual([5, 6, 10]);
      expect(hole.reason).toContain('F7 Comp');
      // COPIES, not bars: a three-bar pattern at three bars leaves nine empty,
      // and the count in the sentence is of the copies that are missing.
      expect(hole.reason).toContain('the 3 copies of it planned for');
      expect(hole.reason).toContain('at bars 5, 6, 10');
    }
    // Forwarded from the review, so it is a statement about the PLAN and stays
    // empty even though bars 5, 6 and 10 really are silent — `holes` is what
    // says where the two accounts differ. Pinned so nobody "fixes" the
    // forwarding into a recomputation that the header rules out.
    expect(assembly.emptyBars).toEqual([]);
    expect(assembly.holes.map((hole) => hole.trackName)).toEqual(['Rhythm Guitar', 'Bass']);
    expect(accountsForEveryCopy(assembly)).toBe(true);
    expect(overlaps()).toEqual([]);
  });

  it('reports an id that is not in the library as unwritten rather than placing it blind', () => {
    const plan = bluesPlan();
    const patterns = buildPatterns(plan, ['G7 Comp']);
    // A built-in id, or one from a pattern that was deleted: it may well place,
    // and its length cannot be read — which is exactly where a silent overlap
    // would go.
    patterns.set('G7 Comp', 'pat_does_not_exist');
    const assembly = built(assembleArrangement(plan, patterns));
    expect(assembly.holes.every((hole) => hole.cause === 'unwritten')).toBe(true);
    expect(assembly.holes[0].reason).toContain('pat_does_not_exist');
    expect(assembly.blocks.some((block) => block.patternName === 'G7 Comp')).toBe(false);
    expect(accountsForEveryCopy(assembly)).toBe(true);
  });

  it('drops the copies of a pattern that came out longer than planned, and says so', () => {
    // THE RULE `reviewPlan` CANNOT KNOW: pattern length auto-fits to content, so
    // a sub-run briefed for one bar whose last note rings over the barline hands
    // back a two-bar pattern. The plan spaced the copies a bar apart and the lib
    // writes `startTick` verbatim with no collision check, so without this walk
    // the arrangement ships with every copy on top of the last.
    const plan: ArrangementPlan = {
      bars: 4,
      tracks: [{ name: 'Rhythm', instrumentId: 'guitar' }],
      patterns: [{ name: 'Cell', instrumentId: 'guitar', chord: 'A7', lengthBars: 1 }],
      placements: [{ patternName: 'Cell', trackName: 'Rhythm', atBars: [1, 2, 3, 4] }],
    };
    expect(reviewPlan(plan).refusals).toEqual([]);
    // Two bars long, not the one the plan spaced by.
    const overran = new Map([['Cell', seedPattern('Cell', 2)]]);

    const assembly = built(assembleArrangement(plan, overran));
    // Bar 1 survives and bar 2 is inside it; bar 3 survives and ends exactly on
    // the form's last barline; bar 4 would run a bar past the end of the form,
    // which is a different mistake with a different repair.
    expect(assembly.blocks.map((block) => block.bar)).toEqual([1, 3]);
    expect(overlaps()).toEqual([]);
    expect(assembly.holes.map((hole) => hole.cause)).toEqual(['past-form', 'would-overlap']);

    const past = assembly.holes[0];
    expect(past.bars).toEqual([4]);
    expect(past.reason).toContain('planned 1 bar long and came out 2 bars');
    expect(past.reason).toContain('past bar 4, the end of the form');

    const clash = assembly.holes[1];
    expect(clash.bars).toEqual([2]);
    // BOTH NUMBERS, and both of them the OBSTRUCTION's: naming only the length
    // the pattern came out leaves the reader unable to tell which end was wrong,
    // and naming the dropped copy's length points at the wrong sub-run.
    expect(clash.reason).toContain('"Cell" at bar 1 was planned 1 bar long but came out 2 bars');
    expect(clash.reason).toContain('covers bars 1-2');
    expect(accountsForEveryCopy(assembly)).toBe(true);
  });

  it('blames the pattern that overran, not the copy it displaced', () => {
    // ⚠ THE SURVIVOR IS ALWAYS THE OVERRUNNER: it starts earlier and has to reach
    // INTO the dropped copy, which at its declared length `reviewPlan` would have
    // refused. Wording that reported the dropped copy's length told the user to
    // re-write a pattern that is exactly the length it was asked for — a repair
    // that changes nothing.
    const plan: ArrangementPlan = {
      bars: 4,
      tracks: [{ name: 'Rhythm', instrumentId: 'guitar' }],
      patterns: [
        { name: 'PatA', instrumentId: 'guitar', chord: 'A7', lengthBars: 1 },
        { name: 'PatB', instrumentId: 'guitar', chord: 'D7', lengthBars: 1 },
      ],
      placements: [
        { patternName: 'PatA', trackName: 'Rhythm', atBars: [1] },
        { patternName: 'PatB', trackName: 'Rhythm', atBars: [2] },
      ],
    };
    expect(reviewPlan(plan).refusals).toEqual([]);
    // A came out two bars; B is exactly what it was asked for.
    const patterns = new Map([
      ['PatA', seedPattern('PatA', 2)],
      ['PatB', seedPattern('PatB', 1)],
    ]);

    const assembly = built(assembleArrangement(plan, patterns));
    expect(assembly.blocks.map((block) => block.patternName)).toEqual(['PatA']);
    expect(assembly.holes).toHaveLength(1);
    expect(assembly.holes[0].patternName).toBe('PatB');
    expect(assembly.holes[0].reason).toContain('"PatA" at bar 1 was planned 1 bar long but came');
    expect(assembly.holes[0].reason).toContain('re-write "PatA"');
    expect(assembly.holes[0].reason).not.toContain('re-write "PatB"');
    expect(overlaps()).toEqual([]);
  });

  it('names each obstruction separately when one pattern is dropped against two', () => {
    // One hole per pattern per OBSTRUCTION. Keyed on the pattern alone, the two
    // drops collapse into one sentence that names A and silently files the copy
    // that hit B underneath it.
    const plan: ArrangementPlan = {
      bars: 4,
      tracks: [{ name: 'Rhythm', instrumentId: 'guitar' }],
      patterns: [
        { name: 'PatA', instrumentId: 'guitar', chord: 'A7', lengthBars: 1 },
        { name: 'PatB', instrumentId: 'guitar', chord: 'D7', lengthBars: 1 },
        { name: 'Fill', instrumentId: 'guitar', chord: 'E7', lengthBars: 1 },
      ],
      placements: [
        { patternName: 'PatA', trackName: 'Rhythm', atBars: [1] },
        { patternName: 'PatB', trackName: 'Rhythm', atBars: [3] },
        { patternName: 'Fill', trackName: 'Rhythm', atBars: [2, 4] },
      ],
    };
    expect(reviewPlan(plan).refusals).toEqual([]);
    const patterns = new Map([
      ['PatA', seedPattern('PatA', 2)],
      ['PatB', seedPattern('PatB', 2)],
      ['Fill', seedPattern('Fill', 1)],
    ]);

    const assembly = built(assembleArrangement(plan, patterns));
    expect(assembly.blocks.map((block) => block.patternName)).toEqual(['PatA', 'PatB']);
    expect(assembly.holes).toHaveLength(2);
    expect(assembly.holes.map((hole) => hole.bars)).toEqual([[2], [4]]);
    expect(assembly.holes[0].reason).toContain('"PatA" at bar 1');
    expect(assembly.holes[1].reason).toContain('"PatB" at bar 3');
    expect(accountsForEveryCopy(assembly)).toBe(true);
    expect(overlaps()).toEqual([]);
  });

  it('states a length in ticks when the pattern does not divide into the bar', () => {
    // A pattern carries its own time signature, so its length is not always a
    // whole number of the COMPOSITION's bars — and a rounded bar count would be
    // a lie in the one sentence the reader has to work from. Two 4/4 bars is
    // 3840 ticks, which is 2⅔ bars of 3/4.
    const set = setCompositionTimeSignature({ numerator: 3, denominator: 4 });
    expect(set.ok).toBe(true);
    const plan: ArrangementPlan = {
      bars: 8,
      tracks: [{ name: 'Rhythm', instrumentId: 'guitar' }],
      patterns: [{ name: 'Cell', instrumentId: 'guitar', chord: 'A7', lengthBars: 1 }],
      placements: [{ patternName: 'Cell', trackName: 'Rhythm', atBars: [1, 2] }],
    };
    expect(reviewPlan(plan).refusals).toEqual([]);

    const assembly = built(assembleArrangement(plan, new Map([['Cell', seedPattern('Cell', 2)]])));
    expect(assembly.blocks.map((block) => block.bar)).toEqual([1]);
    expect(assembly.holes).toHaveLength(1);
    expect(assembly.holes[0].reason).toContain('came out 3840 ticks');
    expect(assembly.holes[0].reason).not.toContain('came out 2 bars');
  });
});
