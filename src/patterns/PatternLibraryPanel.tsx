import { useState } from 'react';
import type { Pattern } from '@fretwork/lib';
import { stop } from '../audio/playbackService';
// A pure tick↔bar helper with no React, no DOM and no store. It is the ONE
// definition of "how many bars is this pattern", shared with the composition
// page's rail — a second copy of `Math.ceil(ticks / ticksPerBar(ts))` over here
// would be a copy that disagrees the first time either rounding rule is touched.
// Taken from `timelineMath` and not from `composition/arrangementMath`, which
// re-exports it: this side of the app must not depend on that one.
import { barsSpanned } from '../timeline/timelineMath';
import {
  deletePattern,
  duplicatePattern,
  openBlankPattern,
  openPattern,
  patternInstrumentId,
  renamePattern,
  useEditingPattern,
  useLibraryPatterns,
  type Result,
} from './patternService';

/**
 * A library row's two lines: the name, then the instrument and the length.
 *
 * SHARED WITH `composition/PatternLibraryRail`, which is the whole reason it is a
 * component rather than inline JSX. The two rails do genuinely different jobs —
 * see the note on {@link PatternLibraryPanel} — but a pattern must describe
 * itself the same way in both, and "4 bars" here against "5 bars" there is the
 * kind of disagreement nobody reports and everybody distrusts.
 *
 * It lives on the patterns side because that is the direction the modules
 * already run: `composition` imports `patternService`, and nothing imports back.
 * The bar count it prints comes from `timelineMath` for the same reason — this
 * file importing `composition/arrangementMath` would be the back-edge that
 * claim denies.
 *
 * The bar count is DERIVED on every render and never stored. `fitPatternDuration`
 * re-fits a pattern's length to its content on every edit, so a cached figure is
 * a figure that goes stale the next time a note moves.
 */
export function PatternRowLabel({ pattern }: { pattern: Pattern }) {
  const bars = barsSpanned(pattern.durationTicks, pattern.timeSignature);
  return (
    <>
      <span className="max-w-full truncate font-mono text-[10.5px] font-bold text-ink">
        {pattern.name}
      </span>
      <span className="flex max-w-full gap-1.5 font-mono text-[8.5px] tracking-[0.12em] text-ink-mut uppercase">
        <span className="truncate">{patternInstrumentId(pattern)}</span>
        <span aria-hidden>·</span>
        <span className="whitespace-nowrap">
          {bars} {bars === 1 ? 'bar' : 'bars'}
        </span>
      </span>
    </>
  );
}

const ROW_ACTION =
  'control pressable flex-1 rounded-md px-1 py-0.5 font-mono text-[8.5px] font-semibold tracking-[0.1em] uppercase';

/**
 * Asked before anything changes which pattern is open.
 *
 * Returns what to run ONCE THE SWITCH HAS ACTUALLY HAPPENED, or null to cancel
 * it — two steps rather than one boolean because the answer costs something.
 * `App`'s guard discards the voice pane's unsaved working copy, and a create can
 * still be refused after it has been asked (the lib's `createPattern` declines at
 * the tier cap), which in one step means unsaved work destroyed for a switch that
 * never took place.
 */
export type SwitchGuard = () => (() => void) | null;

/** No caller above, so nothing to strand and nothing to run afterwards. */
const NO_GUARD: SwitchGuard = () => () => {};

/**
 * How many patterns the library holds, as its own subscriber.
 *
 * A leaf on purpose. It is the rail SECTION's header that shows the count, and
 * the section is composed in `App` — but `useLibraryPatterns` reads
 * `library.patterns`, whose array identity changes on every edit to the pattern
 * being edited, not merely on create and delete. Subscribed in `App` that would
 * re-render the pane stack and the timeline on every note drag. Subscribed here
 * it re-renders a number.
 */
export function PatternLibraryCount() {
  return <>{useLibraryPatterns().length}</>;
}

/**
 * The pattern library, in the pattern page's right rail (PP-01).
 *
 * THE HEADER IS NOT HERE. This is the BODY of a rail section — `shell/Section`
 * draws the disclosure, the name and the count slot, and `App`'s `PatternRail`
 * composes it. The header this file used to draw was the same header
 * `composition/PatternLibraryRail` draws, which is PP-01's copied chrome; the
 * point of the section is that the second copy is now the one that gets deleted
 * rather than a third one written. (That deletion is the composition rail's own
 * change and is not this ticket — nothing on that page is a section yet.)
 *
 * THE TWO HEADERS THEREFORE LOOK DIFFERENT UNTIL THAT LANDS, and it is a debt
 * rather than a decision: this one is `Section`'s `text-[9px]`
 * `tracking-[0.16em]` inheriting `text-ink`, the composition rail's is still its
 * own `text-[10px]` `tracking-[0.18em]` `text-ink-mut`. PP-01's goal is that a
 * pattern library reads the same on both pages, so the divergence is recorded
 * here and closed by moving that rail onto `shell/Section` — not by hand-matching
 * two class strings, which is how the copy got made in the first place.
 *
 * WHY THE RAIL AND NOT A FOURTH PANE. The three panes are all views OF the
 * pattern being edited; this is how you choose WHICH pattern that is. Chrome,
 * not editing — and a fourth pane would put it in the reorder-and-collapse
 * sequence with them, where a long library pushes the timeline off the bottom of
 * the screen and folding it away is a chore rather than a choice. The rail is
 * already 300px of nothing but a label, and it lands the library in the same
 * place on both pages, which is the only reason a user should ever have to
 * remember where it is.
 *
 * WHETHER IT SCROLLS DEPENDS ON THE OTHER COLUMN, which is worth stating plainly
 * because two earlier drafts of this note each got it half right. `#root` has no
 * height, so the pattern page's `h-full` resolves to auto and the row is as tall
 * as its tallest column (see `AppShell`, and the pane-layout debt in
 * docs/FOLLOW-UPS.md). The rail is a stretched grid item of that row. So when the
 * pane stack is the taller one — the normal case — the rail has a definite height
 * and the `min-h-0` / `overflow-y-auto` below really is a scroller; when the
 * library is the taller one it is the whole document that scrolls instead and a
 * thirty-pattern library grows the page. jsdom has no layout, so nothing here can
 * assert either state.
 *
 * NOT A FORK OF `composition/PatternLibraryRail`, which lists the same patterns
 * for a different job. What differs is everything except the row's text:
 *
 *   - a row there is a DRAG SOURCE into a lane, and a press appends a placement
 *     to the focused track; a row here OPENS the pattern for editing;
 *   - that one reads `useTracks` / `selectedTrackId` and writes through
 *     `compositionService.addPlacement`; this one reads `useEditingPattern` and
 *     writes through the pattern seam;
 *   - authoring — new, rename, duplicate, delete — is deliberately absent there
 *     (tickets/composition-page/README.md) and is most of what is here.
 *
 * So what is shared is the part that is actually the same: {@link PatternRowLabel}.
 * A single component switching its click handler, its accessible name, its
 * subtitle and half its children on a mode flag would be the fork with extra
 * steps.
 *
 * PRIOR ART, considered and not taken yet: guitar-tutor's
 * `library/LibraryPickerPanel` is a generic `<T>` shell — items, activeId,
 * onPickItem, onCreateItem, `renderItemRow` — with `PatternPickerPanel` as a
 * 98-line wrapper. The split is the right one and it is where this goes when
 * there is a second kind of thing to pick. It is not this ticket, because its
 * shell is built around `FolderTree`, collections and folder dialogs, and
 * collections are exactly what PP-01 defers. What that leaves duplicated here is
 * chrome — a scroller, an empty state and a row class — between two files, which
 * is a smaller debt than a generic tree with one caller. One line shorter than it
 * was: the header went to `shell/Section`.
 *
 * WHAT SWITCHING COSTS. Nothing in the timeline: every edit is written to the
 * store as it is made, so there is no unsaved pattern state to lose. The one
 * unsaved thing in the app is the voice pane's working preset, which is keyed by
 * pattern id and lives in `App` — `confirmSwitch` is `App`'s chance to ask before
 * it is stranded, and every action here that changes which pattern is open goes
 * through it.
 *
 * IT ALSO COSTS THE TRANSPORT, which is why {@link stop} is called on every
 * action that lands on a different pattern. `play` snapshots the pattern into
 * the scheduler once; nothing re-streams it when the edit target changes, so a
 * switch mid-playback leaves the OLD pattern sounding through the old voice
 * while the timeline draws the new one and no note lights up. Unreachable before
 * this panel existed — there was no way to change the open pattern — and one
 * click away now. It cannot live in `patternService`: `playbackService` imports
 * from there, so the seam calling back would close an ESM cycle. The agent
 * reaching `openPattern` directly does not get this, and cannot until the
 * transport can be told to re-stream (docs/FOLLOW-UPS.md).
 *
 * WHICH ROW IS MARKED OPEN CAN CHANGE ACROSS A RELOAD, and that is accepted
 * rather than fixed. The lib persists `library` but not `editingPatternId`, so a
 * returning session adopts the most recently UPDATED pattern. That is the one you
 * were editing in every case except opening a pattern and touching nothing —
 * editing is what moves `updatedAt` — and persisting a second pointer app-side
 * would buy that edge case at the price of two sources of truth that can
 * disagree about what is open.
 */
export function PatternLibraryPanel({
  confirmSwitch,
}: {
  /** Absent when there is nothing above this that could be stranded. */
  confirmSwitch?: SwitchGuard;
}) {
  const patterns = useLibraryPatterns();
  const open = useEditingPattern();
  const [refusal, setRefusal] = useState<string | null>(null);
  /** Which row has its rename form up. One at a time — two open forms would make
   *  "which name am I typing" a question. */
  const [renamingId, setRenamingId] = useState<string | null>(null);

  /** Say what the seam refused, or clear the last refusal on success. */
  const report = <T,>(result: Result<T>): T | null => {
    setRefusal(result.ok ? null : result.reason);
    return result.ok ? result.value : null;
  };

  const ask = confirmSwitch ?? NO_GUARD;

  /** Everything that follows a change of open pattern, in order: release the
   *  transport (it is still streaming the pattern that WAS open — see the module
   *  note), then let the caller act on the switch it agreed to. */
  const switched = (commit: () => void) => {
    stop();
    commit();
  };

  const create = () => {
    setRefusal(null);
    const commit = ask();
    if (!commit) return;
    const made = report(openBlankPattern());
    if (!made) return;
    switched(commit);
    // A blank pattern arrives named but unnamed-by-you. Opening the rename form
    // on it is how you say what it is while you still know — and it is the same
    // form the Rename button opens, not a second naming flow.
    setRenamingId(made.id);
  };

  const choose = (pattern: Pattern) => {
    setRefusal(null);
    if (pattern.id === open?.id) return;
    const commit = ask();
    if (!commit) return;
    if (report(openPattern(pattern.id))) switched(commit);
  };

  const remove = (pattern: Pattern) => {
    setRefusal(null);
    // Confirmed whatever is in it. An empty pattern still carries a name, an
    // instrument, a tempo and a chosen voice, and there is no undo across a
    // delete — history is per-pattern and goes with it. The message is shorter
    // when there are no notes, because the sentence about losing them would be
    // the false part of the warning.
    const notes = pattern.events.length;
    const message =
      notes === 0
        ? `Delete "${pattern.name}"? This cannot be undone.`
        : `Delete "${pattern.name}"? Its ${notes} ${notes === 1 ? 'note goes' : 'notes go'} with it, and this cannot be undone.`;
    if (!window.confirm(message)) return;
    // Only deleting the OPEN one changes what is open, so only that one can
    // strand the voice pane's working copy.
    const isOpen = pattern.id === open?.id;
    const commit = isOpen ? ask() : null;
    if (isOpen && !commit) return;
    if (renamingId === pattern.id) setRenamingId(null);
    if (report(deletePattern(pattern.id)) && commit) switched(commit);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none px-2 pt-1 pb-1">
        <button
          type="button"
          onClick={create}
          className="control-accent pressable w-full rounded-lg px-2 py-1.5 font-mono text-[9.5px] font-bold tracking-[0.12em] uppercase"
        >
          <span aria-hidden>+ </span>New pattern
        </button>
      </div>

      {refusal && (
        // `role="alert"`: every refusal the seam returns is a case where nothing
        // visibly happens, so silence would be indistinguishable from success.
        <p
          role="alert"
          className="mx-2 mb-1.5 flex-none rounded-md border border-brass/50 px-2 py-1.5 font-mono text-[9px] leading-relaxed text-ink"
        >
          {refusal}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {patterns.length === 0 ? (
          <p className="px-1 py-2 font-mono text-[9px] leading-relaxed tracking-[0.12em] text-ink-mut uppercase">
            No patterns yet — press New pattern to start one.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {patterns.map((pattern) => {
              const isOpen = pattern.id === open?.id;
              return (
                <li key={pattern.id} className="flex flex-col gap-0.5">
                  <button
                    type="button"
                    data-library-pattern={pattern.id}
                    // The row's own text is three unrelated fragments; run
                    // together they read as one nonsense phrase.
                    aria-label={`Open pattern ${pattern.name}`}
                    // The state, said rather than only drawn — the brass outline
                    // below is the same fact for anyone who can see it.
                    aria-current={isOpen ? 'true' : undefined}
                    onClick={() => choose(pattern)}
                    className={`control pressable flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left ${
                      isOpen ? 'outline outline-brass' : ''
                    }`}
                  >
                    <PatternRowLabel pattern={pattern} />
                  </button>

                  {renamingId === pattern.id ? (
                    <form
                      className="flex items-center gap-1"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const value = new FormData(e.currentTarget).get('patternName');
                        if (report(renamePattern(pattern.id, String(value ?? '')))) {
                          setRenamingId(null);
                        }
                      }}
                    >
                      <input
                        name="patternName"
                        defaultValue={pattern.name}
                        autoFocus
                        aria-label={`New name for ${pattern.name}`}
                        className="well min-w-0 flex-1 rounded-md px-1.5 py-1 font-mono text-[10px] text-ink"
                      />
                      <button type="submit" className={ROW_ACTION}>
                        Save
                      </button>
                      <button
                        type="button"
                        // The refusal goes with the form that caused it: a
                        // `role="alert"` left standing after the action it
                        // described was abandoned reads as a live complaint
                        // about whatever the user does next.
                        onClick={() => {
                          setRefusal(null);
                          setRenamingId(null);
                        }}
                        className={ROW_ACTION}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <div className="flex gap-1">
                      <button
                        type="button"
                        aria-label={`Rename ${pattern.name}`}
                        onClick={() => {
                          setRefusal(null);
                          setRenamingId(pattern.id);
                        }}
                        className={ROW_ACTION}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        aria-label={`Duplicate ${pattern.name}`}
                        onClick={() => report(duplicatePattern(pattern.id))}
                        className={ROW_ACTION}
                      >
                        Copy
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${pattern.name}`}
                        onClick={() => remove(pattern)}
                        className={ROW_ACTION}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
