/**
 * ASSEMBLY — the step that builds the arrangement, with no model in it at all.
 *
 * The plan step decided the form and wrote nothing; a sub-run wrote each pattern
 * over its one chord. What is left is tracks, bars and blocks: create the parts,
 * convert the bars, place the copies, and say what got built against what was
 * asked for. Every one of those is arithmetic and lookup, so none of it is a
 * model's job — and the epic's whole case is that it was a model's job until now
 * and each defect cost a failed run to find:
 *
 *   - a four-bar pattern placed at bars 1, 2, 3 and 4, four copies stacked;
 *   - a twelve-bar block dropped over four one-bar blocks on the same track, the
 *     overlap warning fired twice and the run shipped it anyway;
 *   - a one-bar pattern at bars 1, 4, 7 and 10 of a twelve-bar form, eight bars
 *     of nothing and no report of it;
 *   - a second 'Guitar 1' created beside an empty track of that very name.
 *
 * The tool refusals that caught those stay exactly where they are — they are the
 * guard rails for a model reaching the same seam. Nothing here walks them.
 *
 * Wired to nothing, like the two steps before it: a module and its tests.
 *
 * ── WHY THE SEAM AND NOT THE TOOLS ──────────────────────────────────────────
 *
 * `src/ai/tools/*` exists to adapt `compositionService` FOR A MODEL: JSON
 * schemas, prose refusals, `asJobWrite`, `ToolResult`. This is our own code and
 * wants typed values, so it calls the seam. The rules the tools' refusals encode
 * are enforced here by {@link reviewPlan} plus the walk in {@link placeOnTrack},
 * both of them BEFORE the first write rather than one round trip per mistake.
 *
 * ── WHAT `reviewPlan` DOES NOT COVER, and is checked here instead ───────────
 *
 * `reviewPlan` grades a plan against ITSELF — it has no document. Four rules a
 * write would enforce are therefore invisible to it, and a plan can pass review
 * and still be unbuildable. Each is checked below, in the order the constants
 * appear:
 *
 *   1. **The cap counts the tracks ALREADY THERE.** `reviewPlan` refuses a plan
 *      declaring more than `MAX_COMPOSITION_TRACKS`; a plan declaring exactly
 *      that many, assembled into a composition that already has one track, is
 *      one add past the cap and `addTrack` refuses the last one. Counted here
 *      over what the composition holds plus what has to be added.
 *   2. **Bars have to convert.** `composition_set_settings` takes any
 *      denominator from 1 to 32, so a 4/7 bar is 1097.142… ticks and no bar
 *      after the first starts on one. A plan is written in bars and only bars,
 *      and `barConverter` returns null there — see `barMath`, which owns this
 *      and must not be rebuilt a third time. Refused whole, never rounded.
 *   3. **The instrument catalogs are two.** `ARRANGEMENT_PLAN_SCHEMA` constrains
 *      instruments to `instrumentCatalog`'s list, which comes from
 *      `listInstruments` (the PATTERN catalog); a track's comes from
 *      `listTrackInstruments`. Both read the lib's one catalog today, and the
 *      plan schema's header says in as many words that assembly is where a
 *      divergence would show up. So it is asked here.
 *   4. **A track name has to be non-blank after trimming.** The schema's
 *      `minLength: 1` stops `""` and passes `"   "`; `addTrack` refuses it,
 *      because every accessible name on the track is built out of it.
 *
 * A fifth is not checkable at all before the sub-runs have run, and it is the
 * one with teeth — see below.
 *
 * ── THE DECLARED LENGTH IS NOT THE WRITTEN LENGTH ───────────────────────────
 *
 * ⚠ THE PLAN'S `lengthBars` IS A REQUEST. Pattern length auto-fits to content on
 * every edit (`fitPatternDuration`, rounded UP to the bar, one-bar minimum), so
 * a sub-run briefed for two bars whose last note rings over the barline hands
 * back a THREE-bar pattern — the brief in `patternSubRun` spends a paragraph on
 * exactly that hazard, which is the admission that it happens. `reviewPlan`
 * spaced the copies by the declared length and cannot know any better.
 *
 * And the lib will not catch it: `addPlacementToTrack` writes `startTick`
 * verbatim with no collision check of any kind (verified in the lib's
 * `composition-ops.js`, not assumed — it is `composition_place_pattern`'s
 * `wouldStack` that refuses, and that is a TOOL). So a plan that passed review
 * would silently produce overlapping blocks, which is the second failure in the
 * list at the top of this file.
 *
 * So every copy is measured with the length the pattern ACTUALLY came out. One
 * that now runs past the end of the form is dropped (`reviewPlan` refuses that
 * shape outright when the DECLARED lengths reach it, and assembly is not laxer
 * about the same mistake for having found it later); the rest are walked in
 * start order and one that would land on top of a survivor is dropped too. The
 * invariant is therefore blunt and worth stating: **nothing this module writes
 * ever overlaps anything else it writes, or runs past the form.**
 *
 * ⚠ THE SENTENCE BLAMES THE BLOCK THAT OVERRAN, WHICH IS NEVER THE DROPPED ONE.
 * The survivor always starts earlier and has to reach INTO the dropped copy to
 * clash with it, so if it were the length the plan declared, `reviewPlan` would
 * have refused the spacing before anything got here — the obstruction is the
 * pattern that came out long, every time. An earlier wording named the dropped
 * copy's length and told the reader to "re-write the pattern shorter", which for
 * two different patterns points at the innocent one and at a repair that changes
 * nothing. Both numbers of the OBSTRUCTION are named instead: planned N, came
 * out M, covers bars X-Y.
 *
 * ── AN EMPTY TRACK IS REUSED, NEVER DUPLICATED ──────────────────────────────
 *
 * A fresh composition arrives with one empty 'Track 1' on the default
 * instrument, so "add every track the plan names" leaves a dead lane on every
 * first run — and on 2026-08-11 it left a second 'Guitar 1' beside an empty one
 * of the same name. `composition_add_track`'s reply already names such a track
 * after the fact; here it is found BEFORE the add, on the same criterion that
 * reply uses (no placements, same resolved instrument), with the plan's name
 * carried over — which is the recovery that reply spells out, done up front.
 *
 * ⚠ ONLY EMPTY TRACKS ARE TOUCHED, and that is load-bearing rather than polite:
 * every track this module writes to is empty when it starts, so the collision
 * walk has nothing pre-existing to account for and cannot blame this run for a
 * block that was already there. A non-empty track of the same name is left
 * alone and a new track is added beside it — with a numbered name, because two
 * tracks sharing one make two headers indistinguishable to a screen reader and
 * to any by-name query (`nextTrackName`'s reasoning, at this address).
 *
 * A NAME MATCH IS CLAIMED BEFORE MERE AVAILABILITY, across the whole plan and
 * not per planned track in turn: greedily, an earlier part with no match takes
 * the free track a later part is named after, and both of the user's lanes end
 * up shuffled — the outcome the rule exists to prevent. Two passes, therefore.
 *
 * ⚠ A REUSED TRACK IS TAKEN AS THE USER LEFT IT — its volume, its mute and solo,
 * and its `voiceRef`. Considered and kept: `addPlacementToTrack` gives a track's
 * own `voiceRef` precedence over the pattern's, so a lane the user voiced sounds
 * different from a fresh one, and normalising the settings on take-over would
 * silently undo the setup that made the track worth reusing in the first place.
 * Dropping such a track from reuse instead would leave the dead lane this whole
 * section exists to delete. Every one of those settings is visible in the track
 * header and reversible in one click, and a block dropped on that track BY HAND
 * behaves identically — assembly matching the hand gesture is the point.
 *
 * The rename of a reused track PUSHES NO UNDO STEP (`setTrackName` does not
 * commit, and `mergeSettingsForward` carries names forward over a restored
 * snapshot). So the undo bracket the next card wraps this in will restore the
 * tracks and the blocks and leave the rename standing. Worth knowing before it
 * is discovered; `abortEditGesture` restores verbatim and is unaffected.
 *
 * ── PARTIAL FAILURE: pre-flight is all-or-nothing, the write is not ─────────
 *
 * The precedent in this codebase is split deliberately — stamping notes applies
 * what it can and names the casualties, because its refusals are only
 * discoverable AFTER the write; deleting is all-or-nothing, because a missing id
 * is checkable up front. Assembly is both, in two phases, and the line is drawn
 * where the checkability is:
 *
 *   - **Before anything is written**, everything checkable is checked — the
 *     review, the JOB LOCK, the four rules above, the pattern lengths, the
 *     collision walk — and any failure refuses the WHOLE assembly with nothing
 *     written. A plan that cannot be built is worth nothing half-built, and this
 *     phase is where every failure lands that is not upstream's.
 *   - **During the write**, a seam refusal is a casualty and not a rollback. Two
 *     reasons, and the second is the honest one. It should not happen at all:
 *     the lock, the ids, the cap, the names and the geometry were all settled a
 *     moment ago, so a refusal here means the document moved under us — and
 *     nothing can, since the whole pass is synchronous. And there is no rollback
 *     to reach for — the undo bracket belongs to the next card, and
 *     hand-unwinding through the seam cannot restore the starting state anyway
 *     (`removeTrack` refuses the last remaining track). Half an arrangement plus
 *     an exact list of what is missing is recoverable; a silent half is not.
 *     ⚠ `cause: 'refused'` is therefore defensive and unreachable by any test:
 *     every refusal the seam has left for us here is pre-flighted above. If one
 *     ever fires, the document changed under a synchronous pass and that is the
 *     news. The same goes for a planned track whose ADD refuses with nothing
 *     planned for it: it appears in no report field, because there is no copy to
 *     be a casualty and no track to report — and it cannot happen for the same
 *     reason. Neither is worth a report field no test can drive.
 *
 * A PATTERN WITH NO ID is the third case and it is neither: it is not a defect
 * in the plan but a report from upstream that one sub-run failed. Its copies are
 * skipped, named as holes with the bars they would have covered, and the rest of
 * the arrangement is built — because the user's next move is to re-run that one
 * pattern, and they can only see that if the other eleven bars exist. That is
 * the ticket's "a hole in the arrangement and the user has to be told".
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 *
 *   - **No undo bracket, and it does not TAKE the job lock** — both are the next
 *     card's, where they have something to wrap. It does OBEY the lock: these
 *     writes are the USER's as far as the seam is concerned, so a caller holding
 *     `beginJob()` must run this inside `asJobWrite`, and one that forgets is
 *     refused up front (`writesLockedOut`) rather than handed a whole
 *     arrangement's worth of casualties for a lock that was checkable before the
 *     first write. `isJobRunning` is the wrong question here and would break the
 *     supported path: a job's own writes run with the job running.
 *   - **No control of the selection.** `addPlacement` selects what it places, so
 *     the user's selection ends up on the last block of the last track — the
 *     seam's behaviour, applying to every caller, and re-selecting afterwards
 *     belongs to whoever owns the gesture rather than to the arithmetic.
 *   - **No coverage of its own.** `emptyBars` is forwarded from `reviewPlan`
 *     verbatim and is therefore measured against the DECLARED lengths. Recomputing
 *     it from what was placed would mean a third copy of the interval walk that
 *     `arrangementPlan.gapsIn` and `readTools.gapRanges` already are two of, and
 *     that file's own header says whoever collapses them owns both. This card's
 *     fence forbids touching either, and a third copy is how `barMath` and
 *     `instrumentCatalog` came to exist. `holes` is what says where the two
 *     accounts differ.
 *   - **No instrument check between a pattern and the track it goes on.** The
 *     write path permits the mismatch and `read_composition` reports it as a
 *     cost; `reviewPlan` declines to refuse it for that reason, and assembly
 *     being stricter than the tools it assembles for would refuse arrangements
 *     that build perfectly well.
 */
import { barConverter } from './tools/barMath';
import { namedRefusals } from './tools/types';
import { reviewPlan } from './arrangementPlan';
import {
  JOB_LOCK_REASON,
  MAX_COMPOSITION_TRACKS,
  TRACK_CAP_REASON,
  addPlacement,
  addTrack,
  findPlacement,
  getEditingComposition,
  getTracks,
  listTrackInstruments,
  placementEndTick,
  setTrackName,
  trackInstrumentId,
  writesLockedOut,
  type Result,
} from '../composition/compositionService';
import { findLibraryPattern } from '../patterns/patternService';
import type { TrackCoverage } from './arrangementPlan';
import type { ArrangementPlan, PlannedPlacement, PlannedTrack } from './arrangementPlanSchema';

/** A track of the open composition, as the seam hands it over. Derived rather
 *  than imported: `src/ai/**` may not reach `@fretwork/lib`, and a tripwire test
 *  enforces it. */
type CompositionTrack = ReturnType<typeof getTracks>[number];

/** The TRACK instrument vocabulary — see rule 3 in the header. Also derived, for
 *  the same reason. */
type TrackInstrumentId = ReturnType<typeof listTrackInstruments>[number]['id'];

// ----------------------------------------------------------------- report ---

/**
 * Why a planned copy is not in the document. Typed rather than left to the
 * sentence, because the three have three different repairs: re-run one sub-run,
 * re-plan the spacing, or look at what the document did while we were writing.
 */
export type HoleCause =
  /** No sub-run produced a pattern for this name, or what it produced is not in
   *  the library. Upstream's report, passed on. */
  | 'unwritten'
  /** The pattern came out longer than the plan spaced its copies by, so this one
   *  would have landed on top of a block this same run placed. */
  | 'would-overlap'
  /** The pattern came out longer than planned, so this copy would have run past
   *  the end of the form. `reviewPlan` refuses the same shape when the DECLARED
   *  lengths reach that far; this is the half only the written length shows. */
  | 'past-form'
  /** The seam refused the write. Defensive — see the header. */
  | 'refused';

/**
 * One pattern's missing copies on one track. Grouped per pattern per track per
 * cause, so a two-bar pattern that overran in a twelve-bar form is one sentence
 * and not six — and per OBSTRUCTION for `would-overlap`, per REASON for
 * `refused`, because one sentence can only name one of either and the copies
 * that hit a different obstruction would otherwise be counted under a sentence
 * that does not describe them.
 */
export interface AssemblyHole {
  readonly patternName: string;
  /** The track as the PLAN names it — the only handle a plan has. */
  readonly trackName: string;
  /** The bars this pattern was to start on and does not. */
  readonly bars: readonly number[];
  readonly cause: HoleCause;
  /** What happened, in the register the seams refuse in. */
  readonly reason: string;
}

/** A track the plan asked for, and what it turned out to be in the document. */
export interface AssembledTrack {
  /** The name the plan gave it, which is what its placements refer to. */
  readonly plannedName: string;
  /** The name the track actually carries — numbered where the planned one was
   *  already taken by a track this run did not touch. */
  readonly name: string;
  readonly trackId: string;
  readonly instrumentId: string;
  /** True when an empty track already on the composition was used rather than a
   *  new one added. */
  readonly reused: boolean;
}

/** One block, where the document holds it — read BACK rather than echoed. */
export interface AssembledBlock {
  readonly patternName: string;
  readonly trackName: string;
  readonly trackId: string;
  readonly placementId: string;
  /** The bar it starts on, counted FROM 1. */
  readonly bar: number;
  readonly startTick: number;
  /** Where the next block on this track may start. */
  readonly endTick: number;
}

/** What was built, against what was planned. */
export interface ArrangementAssembly {
  /** The form's length, as the plan declared it. */
  readonly bars: number;
  readonly tracks: readonly AssembledTrack[];
  /**
   * In PLAN order: track by track as the plan declares them, then by start tick
   * within a track. Not document order, and the two differ the moment a later
   * planned track reuses an earlier existing one — the plan's order is the one
   * the report is read against, since a plan has no other handle on a track.
   */
  readonly blocks: readonly AssembledBlock[];
  readonly holes: readonly AssemblyHole[];
  /**
   * How many copies the plan asked for in all.
   *
   * ⚠ THE ARITHMETIC IS EXACT AND IS THE POINT: every planned copy is either a
   * block or a hole, so `blocks.length` plus the bars named across `holes` is
   * always this number. A caller can therefore report "11 of 12 placed" without
   * re-walking the plan, and a copy that vanished with nothing said about it
   * would break the identity rather than pass unnoticed.
   */
  readonly plannedBlocks: number;
  /**
   * The bars each track leaves empty, forwarded from `reviewPlan` — measured
   * against the DECLARED pattern lengths, and so a statement about the PLAN.
   * `holes` is what the document lost on top of it. See the header.
   */
  readonly emptyBars: readonly TrackCoverage[];
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const refuse = (reason: string): Result<never> => ({ ok: false, reason });

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

// ------------------------------------------------------------------ tracks ---

/** A planned track and the existing empty track it will take over, if any. */
interface TrackPlan {
  readonly planned: PlannedTrack;
  readonly reuse: CompositionTrack | null;
}

/**
 * Which planned track takes over which existing empty one.
 *
 * Claims are exclusive — an empty track is taken by at most one planned track,
 * or a plan naming two guitar parts would put both on the same lane and the
 * second would overlap the first. In plan order, so which of two identical empty
 * tracks is claimed is decided by the plan and not by the iteration.
 *
 * A NAME MATCH WINS over mere availability. Two empty guitar tracks, one already
 * called "Rhythm Guitar", is a composition somebody set up for this arrangement;
 * claiming the other one and renaming it would shuffle both names for nothing.
 *
 * ⚠ IN TWO PASSES, because one greedy pass does not implement that rule: every
 * name match in the plan is claimed FIRST, and only then are the leftovers
 * handed out in plan order. Greedily, empty tracks "Lead" and "Rhythm Guitar"
 * with a plan of "Slide" then "Lead" put Slide on the Lead track and Lead on the
 * Rhythm Guitar track — both of the user's lanes shuffled, which is exactly what
 * the rule is here to prevent.
 */
function resolveTracks(
  planned: readonly PlannedTrack[],
  existing: readonly CompositionTrack[],
): readonly TrackPlan[] {
  // `composition_add_track`'s own criterion for the twin it warns about: nothing
  // on it, and the same instrument once resolved — a track's `instrumentId` is a
  // free-form string and `trackInstrumentId` is what the rest of the app
  // resolves it with.
  const free = existing.filter((candidate) => candidate.placements.length === 0);
  const fits = (candidate: CompositionTrack, track: PlannedTrack): boolean =>
    trackInstrumentId(candidate) === track.instrumentId;

  const claimed = new Set<string>();
  const byName = new Map<number, CompositionTrack>();
  planned.forEach((track, index) => {
    const match = free.find(
      (candidate) =>
        !claimed.has(candidate.id) && candidate.name === track.name && fits(candidate, track),
    );
    if (match) {
      claimed.add(match.id);
      byName.set(index, match);
    }
  });

  return planned.map((track, index) => {
    const named = byName.get(index);
    if (named) return { planned: track, reuse: named };
    // In plan order, so which of two identical empty tracks is claimed is
    // decided by the plan and not by the iteration.
    const spare =
      free.find((candidate) => !claimed.has(candidate.id) && fits(candidate, track)) ?? null;
    if (spare) claimed.add(spare.id);
    return { planned: track, reuse: spare };
  });
}

/** The plan's name where it is free, and "<name> 2" where it is not. Taken names
 *  are consumed as they are handed out, so two planned tracks cannot be given
 *  one name either. */
function freeName(wanted: string, taken: Set<string>): string {
  if (!taken.has(wanted)) {
    taken.add(wanted);
    return wanted;
  }
  let n = 2;
  while (taken.has(`${wanted} ${n}`)) n += 1;
  const chosen = `${wanted} ${n}`;
  taken.add(chosen);
  return chosen;
}

// -------------------------------------------------------------- placements ---

/** One copy of one pattern, with the length the pattern ACTUALLY came out —
 *  never the length the plan asked for. See the header. */
interface Copy {
  readonly patternName: string;
  readonly patternId: string;
  /** What the plan asked the sub-run for. Carried ONLY for the wording: naming
   *  the planned length beside the written one is what points at the sub-run
   *  that overran, rather than at whichever copy happened to be dropped. */
  readonly declaredBars: number;
  readonly bar: number;
  readonly startTick: number;
  readonly endTick: number;
}

/** "bar 3", or "bars 2, 4, 6" — the bars of one hole, as a sentence reads them. */
const barsList = (bars: readonly number[]): string =>
  bars.length === 1 ? `bar ${bars[0]}` : `bars ${bars.join(', ')}`;

const copies = (count: number): string => plural(count, 'copy', 'copies');

/** A pattern's length in the composition's bars where it divides exactly, and in
 *  ticks where it does not — a pattern carries its own time signature, so the
 *  bar form is not always available and a rounded one would be a lie. */
function lengthPhrase(ticks: number, ticksPerBar: number): string {
  return ticks % ticksPerBar === 0 ? plural(ticks / ticksPerBar, 'bar') : `${ticks} ticks`;
}

/**
 * The copies that would land on top of an earlier one, walked in start order.
 *
 * ⚠ MEASURED AGAINST THE SURVIVORS, which is `reviewPlan.stacksOn`'s rule and
 * `composition_place_pattern`'s: chaining off a copy that was itself dropped
 * names ground nothing will ever occupy. At most one survivor can be in the way,
 * since `kept` is pairwise non-overlapping by construction and the track was
 * empty before this run touched it.
 *
 * Blocks that merely TOUCH are fine — one may start exactly where the one before
 * it ends — which is why the comparison is strict at both ends.
 */
function withoutOverlaps(candidates: readonly Copy[]): {
  kept: readonly Copy[];
  dropped: readonly { copy: Copy; clash: Copy }[];
} {
  const kept: Copy[] = [];
  const dropped: { copy: Copy; clash: Copy }[] = [];
  for (const copy of [...candidates].sort((a, b) => a.startTick - b.startTick)) {
    const clash = kept.find(
      (earlier) => earlier.startTick < copy.endTick && earlier.endTick > copy.startTick,
    );
    if (clash) dropped.push({ copy, clash });
    else kept.push(copy);
  }
  return { kept, dropped };
}

// ---------------------------------------------------------------- assembly ---

/**
 * BUILD THE ARRANGEMENT. A validated plan plus the patterns the sub-runs wrote,
 * in; tracks, blocks and an account of both, out.
 *
 * `patternIds` maps a planned pattern's NAME — the only handle a plan has — to
 * the library pattern a sub-run produced for it. A name it does not carry is a
 * sub-run that failed, and its copies come back as holes rather than as a
 * refusal; see the header on partial failure.
 *
 * REFUSES, having written nothing, when the plan does not pass `reviewPlan`,
 * when nothing is open, when bars do not convert in this signature, when an
 * instrument or a track name is one the seam will not take, or when the
 * composition cannot hold the tracks the plan needs.
 *
 * ⚠ A caller that wants the refusals TYPED calls `reviewPlan` itself — it is
 * pure and cheap, and re-running it costs nothing. The sentence returned here
 * carries the same wording, because those sentences are the plan step's product
 * and re-authoring them would put two accounts of one mistake in circulation.
 */
export function assembleArrangement(
  plan: ArrangementPlan,
  patternIds: ReadonlyMap<string, string>,
): Result<ArrangementAssembly> {
  const review = reviewPlan(plan);
  if (review.refusals.length > 0) {
    return refuse(
      `This plan cannot be built as it stands, so nothing was written. ${namedRefusals(
        review.refusals.map((entry) => ({ label: entry.rule, reason: entry.reason })),
      )}`,
    );
  }

  const composition = getEditingComposition();
  if (!composition) return refuse('No composition is open.');

  // The lock, before the first write rather than once per write. The pass is
  // synchronous, so the answer cannot change halfway: discovering it inside the
  // loop would mean reporting a whole arrangement as casualties of something
  // that was knowable here. See the header on what this is NOT (`isJobRunning`).
  if (writesLockedOut()) return refuse(`${JOB_LOCK_REASON} Nothing was written.`);

  // Rule 2. ONE conversion for the whole assembly, from the module that owns it.
  const bars = barConverter(composition.timeSignature);
  if (!bars) {
    const { numerator, denominator } = composition.timeSignature;
    return refuse(
      `A ${numerator}/${denominator} bar is not a whole number of ticks, so the bars this plan is written in do not convert exactly here. Nothing was written. Change the composition's time signature, or place the blocks by tick.`,
    );
  }

  // Rules 3 and 4, over the DECLARED tracks — checked before the first write so
  // a plan naming one unknown instrument does not leave half an arrangement.
  const known = new Set<string>(listTrackInstruments().map((instrument) => instrument.id));
  for (const track of plan.tracks) {
    if (!known.has(track.instrumentId)) {
      return refuse(
        `Track "${track.name}" is planned for instrument "${track.instrumentId}", which a track cannot be on. Nothing was written.`,
      );
    }
    if (track.name.trim() === '') {
      return refuse('A track needs a name, and one of the planned tracks has a blank one. Nothing was written.');
    }
  }

  const existing = getTracks();
  const trackPlans = resolveTracks(plan.tracks, existing);

  // Rule 1. The cap counts what is already here, which is the half `reviewPlan`
  // cannot see.
  const adding = trackPlans.filter((entry) => entry.reuse === null).length;
  if (existing.length + adding > MAX_COMPOSITION_TRACKS) {
    return refuse(
      `This arrangement needs ${plural(adding, 'new track')} beside the ${plural(
        existing.length,
        'track',
      )} already here, which is ${existing.length + adding} in all. ${TRACK_CAP_REASON} Nothing was written.`,
    );
  }

  // Names not up for grabs: everything already in the document except the empty
  // tracks this run is taking over, which are about to be renamed.
  const reused = new Set(trackPlans.flatMap((entry) => (entry.reuse ? [entry.reuse.id] : [])));
  const taken = new Set(
    existing.filter((track) => !reused.has(track.id)).map((track) => track.name),
  );

  const tracks: AssembledTrack[] = [];
  const blocks: AssembledBlock[] = [];
  const holes: AssemblyHole[] = [];

  for (const entry of trackPlans) {
    const placements = plan.placements.filter(
      (placement) => placement.trackName === entry.planned.name,
    );
    const name = freeName(entry.planned.name.trim(), taken);
    const resolved = openTrack(entry, name);
    if (!resolved.ok) {
      // Everything meant for this track is a casualty, named with the seam's own
      // sentence. Nothing else in the plan is affected — the other tracks are
      // separate writes with separate ids.
      for (const placement of placements) {
        holes.push({
          patternName: placement.patternName,
          trackName: placement.trackName,
          bars: [...placement.atBars],
          cause: 'refused',
          reason: `Track "${name}" could not be created, so nothing was placed on it. ${resolved.reason}`,
        });
      }
      continue;
    }

    const track = resolved.value;
    tracks.push(track);
    const written = placeOnTrack(track, plan, placements, patternIds, bars);
    blocks.push(...written.blocks);
    holes.push(...written.holes);
  }

  return ok({
    bars: plan.bars,
    tracks,
    blocks,
    holes,
    plannedBlocks: plan.placements.reduce((total, placement) => total + placement.atBars.length, 0),
    emptyBars: review.emptyBars,
  });
}

/**
 * The track a planned part goes on: the empty one it took over, renamed, or a
 * new one.
 *
 * The rename is attempted and its result is not a failure of the assembly — the
 * name is read BACK off the document either way, so a track that kept its old
 * one is reported as it is rather than as it was asked to be. A refusal here
 * cannot lose a block; a refused ADD can, which is why only that one propagates.
 */
function openTrack(entry: TrackPlan, name: string): Result<AssembledTrack> {
  if (entry.reuse) {
    if (entry.reuse.name !== name) setTrackName(entry.reuse.id, name);
    const live = getTracks().find((track) => track.id === entry.reuse?.id);
    return ok({
      plannedName: entry.planned.name,
      name: live?.name ?? entry.reuse.name,
      trackId: entry.reuse.id,
      // Read back like the name, and for the same reason. Equal to the plan's by
      // construction — `resolveTracks` matched on it — but a track's stored
      // `instrumentId` is a free-form string that RESOLVES to this, so the
      // report says what the app plays it as rather than what the plan asked.
      instrumentId: trackInstrumentId(live ?? entry.reuse),
      reused: true,
    });
  }
  // The cast is the catalog check above, cashed in: `listTrackInstruments` was
  // asked whether this id is one a track can be on, and refused the whole
  // assembly if it was not.
  const added = addTrack(name, entry.planned.instrumentId as TrackInstrumentId);
  if (!added.ok) return refuse(added.reason);
  return ok({
    plannedName: entry.planned.name,
    name: added.value.name,
    trackId: added.value.id,
    instrumentId: added.value.instrumentId,
    reused: false,
  });
}

/**
 * Every copy the plan wants on ONE track: measured, de-overlapped, written.
 *
 * The track is empty when this starts — assembly only ever reuses an EMPTY track
 * or adds a new one — so the walk has nothing pre-existing to account for and no
 * block it did not place itself can be blamed on it.
 */
function placeOnTrack(
  track: AssembledTrack,
  plan: ArrangementPlan,
  placements: readonly PlannedPlacement[],
  patternIds: ReadonlyMap<string, string>,
  bars: NonNullable<ReturnType<typeof barConverter>>,
): { blocks: readonly AssembledBlock[]; holes: readonly AssemblyHole[] } {
  const blocks: AssembledBlock[] = [];
  const holes: AssemblyHole[] = [];
  const wanted: Copy[] = [];
  const pastForm: Copy[] = [];
  // The first tick that is NOT in the form. `plan.bars` is a whole bar count —
  // `reviewPlan`'s `form-length` rule refused the plan otherwise.
  const formEndTick = bars.toTick(plan.bars + 1);
  const declared = new Map(plan.patterns.map((pattern) => [pattern.name, pattern.lengthBars]));

  for (const placement of placements) {
    const patternId = patternIds.get(placement.patternName);
    // Resolved against the LIBRARY, which is where a sub-run's pattern lands. An
    // id the library has not got is treated as unwritten rather than handed to
    // the seam: a built-in id would place successfully and report no length,
    // and a block whose length is unknown is exactly where a silent overlap
    // would go (`composition_place_pattern` names the same hazard).
    const pattern = patternId === undefined ? undefined : findLibraryPattern(patternId);
    if (!pattern || pattern.durationTicks <= 0) {
      holes.push({
        patternName: placement.patternName,
        trackName: placement.trackName,
        bars: [...placement.atBars],
        cause: 'unwritten',
        // The COPIES are counted, not the bars: a three-bar pattern planned at
        // bars 1, 4 and 7 leaves nine bars empty and saying "3 bars" would be
        // the one number in the sentence that is wrong.
        reason:
          patternId === undefined
            ? `No pattern was written for "${placement.patternName}", so the ${copies(placement.atBars.length)} of it planned for "${track.name}" at ${barsList(placement.atBars)} are not there.`
            : `The pattern written for "${placement.patternName}" (${patternId}) is not in the library or has no length, so the ${copies(placement.atBars.length)} of it planned for "${track.name}" at ${barsList(placement.atBars)} are not there.`,
      });
      continue;
    }
    for (const bar of placement.atBars) {
      const startTick = bars.toTick(bar);
      const copy: Copy = {
        patternName: placement.patternName,
        patternId: pattern.id,
        declaredBars: declared.get(placement.patternName) ?? 0,
        bar,
        startTick,
        endTick: startTick + pattern.durationTicks,
      };
      // Sorted here rather than after the walk: a copy that runs off the end of
      // the form is never written, so it occupies nothing and must not be the
      // reason a later copy is dropped as well.
      if (copy.endTick > formEndTick) pastForm.push(copy);
      else wanted.push(copy);
    }
  }

  // One hole per pattern, not one per bar: a one-bar pattern that came out two
  // bars long runs off the end from every copy near it for the same reason.
  for (const [, group] of groupBy(pastForm, (copy) => copy.patternName)) {
    const first = group[0];
    const bar = group.map((copy) => copy.bar);
    holes.push({
      patternName: first.patternName,
      trackName: track.plannedName,
      bars: bar,
      cause: 'past-form',
      reason: `"${first.patternName}" was planned ${plural(first.declaredBars, 'bar')} long and came out ${lengthPhrase(first.endTick - first.startTick, bars.ticksPerBar)}, so its ${copies(group.length)} at ${barsList(bar)} would run past bar ${plan.bars}, the end of the form. ${group.length === 1 ? 'It was' : 'They were'} left out — re-write the pattern to the ${plural(first.declaredBars, 'bar')} it was planned for, or make the form longer.`,
    });
  }

  const { kept, dropped } = withoutOverlaps(wanted);

  // One hole per pattern PER OBSTRUCTION, not one per bar: a two-bar pattern
  // that came out three bars long drops every copy after the first for the same
  // reason, and six sentences saying it is six times the same report. Two
  // different obstructions are two reports, though — one sentence can only name
  // one of them, and the copies it does not describe would be filed under it.
  for (const [, group] of groupBy(
    dropped,
    (entry) => `${entry.copy.patternName} ${entry.clash.patternName}@${entry.clash.bar}`,
  )) {
    const { copy, clash } = group[0];
    const bar = group.map((entry) => entry.copy.bar);
    // THE CLASH IS THE ONE THAT OVERRAN, always — see the header. It starts
    // earlier and has to reach into this copy, which at its declared length
    // `reviewPlan` would have refused before anything got here.
    const covers = `${bars.toBar(clash.startTick)}-${bars.toBar(clash.endTick - 1)}`;
    holes.push({
      patternName: copy.patternName,
      trackName: track.plannedName,
      bars: bar,
      cause: 'would-overlap',
      reason: `On "${track.name}", "${clash.patternName}" at bar ${clash.bar} was planned ${plural(clash.declaredBars, 'bar')} long but came out ${lengthPhrase(clash.endTick - clash.startTick, bars.ticksPerBar)} and covers bars ${covers}, leaving no room for the ${copies(group.length)} of "${copy.patternName}" at ${barsList(bar)}. A block is never nudged aside, so ${group.length === 1 ? 'it was' : 'they were'} left out — re-write "${clash.patternName}" to the ${plural(clash.declaredBars, 'bar')} it was planned for, or re-plan the spacing around the length it came out.`,
    });
  }

  const refused: { copy: Copy; reason: string }[] = [];
  for (const copy of kept) {
    const placed = addPlacement(copy.patternId, track.trackId, copy.startTick);
    if (!placed.ok) {
      refused.push({ copy, reason: placed.reason });
      continue;
    }
    // Read the block BACK rather than echoing the tick it was asked for, for the
    // reason every reply in this app does: the report's job is to say what the
    // document holds.
    const found = findPlacement(placed.value);
    blocks.push({
      patternName: copy.patternName,
      trackName: track.plannedName,
      trackId: track.trackId,
      placementId: placed.value,
      bar: found ? bars.toBar(found.placement.startTick) : copy.bar,
      startTick: found?.placement.startTick ?? copy.startTick,
      endTick: found ? placementEndTick(found.placement) : copy.endTick,
    });
  }

  // Grouped per pattern PER REASON, for the reason the holes above are: every
  // refusal `addPlacement` has left to give here is position-independent, so
  // when one copy is turned away all of them are, and a twelve-bar form would
  // otherwise carry twelve copies of one identical sentence.
  for (const [, group] of groupBy(refused, (entry) => `${entry.copy.patternName} ${entry.reason}`)) {
    const bar = group.map((entry) => entry.copy.bar);
    holes.push({
      patternName: group[0].copy.patternName,
      trackName: track.plannedName,
      bars: bar,
      cause: 'refused',
      reason: `"${group[0].copy.patternName}" could not be placed on "${track.name}" at ${barsList(bar)}: ${group[0].reason}`,
    });
  }

  return { blocks, holes };
}

/** Group in FIRST-SEEN order — the plan's own, which is what the report is read
 *  against. */
function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}
