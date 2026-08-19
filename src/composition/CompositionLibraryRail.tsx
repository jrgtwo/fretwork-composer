import { useState } from 'react';
import type { Composition } from '@fretwork/lib';
import { stop } from '../audio/playbackService';
import {
  compositionEndTick,
  deleteComposition,
  duplicateComposition,
  openBlankComposition,
  openComposition,
  renameComposition,
  ticksPerBar,
  useEditingComposition,
  useLibraryCompositions,
  type Result,
} from './compositionService';

/**
 * The composition library, in the composition page's rail (CP-17).
 *
 * `PatternLibraryPanel`'s sibling, and deliberately its mirror: create, switch,
 * rename, duplicate, delete, each one a call to a seam function that already
 * refuses in words. Every capability here is a function first and a button
 * second — the agent reaches the same five through `compositionTools`, so
 * nothing about this file is the only way to do anything.
 *
 * What is NOT shared with the pattern panel, and why there is no common
 * component: a pattern row is a drag source for the grid beside it and switching
 * one changes what a single pane draws. A composition row switches the document
 * the WHOLE PAGE is looking at — the grid, the transport, the audio engine and
 * three kinds of selection. The two lists look alike and mean different things,
 * and `PatternLibraryRail` says the same about its own relationship to
 * `PatternLibraryPanel`.
 *
 * ⚠ `stop()` BEFORE A SWITCH. The composition engine is built for one document
 * and is still streaming the one that was open; `syncComposition` does dispose
 * it on an id change, so this is belt rather than the only guard, but a page
 * that swaps documents while audio runs should release the transport where the
 * user asked for the swap rather than as a side effect two layers down.
 */

const ROW_ACTION =
  'control pressable flex-1 rounded-md px-1.5 py-1 font-mono text-[8.5px] font-bold tracking-[0.1em] uppercase';

/**
 * What a row says about itself.
 *
 * Tracks and bars rather than a name alone: with every blank arriving as
 * "Untitled composition N", the name is the least distinguishing thing about a
 * row until someone renames it. Bars come from the seam's `compositionEndTick`
 * rather than the lib's `totalDurationTicks`, which LIB-GAP(11) makes over-long
 * for a truncated block — the seam already owns that correction, and summing it
 * again here would be a second copy of the workaround.
 */
function CompositionRowLabel({ composition }: { composition: Composition }) {
  const trackCount = composition.tracks.length;
  const barTicks = ticksPerBar(composition.timeSignature);
  const bars = barTicks > 0 ? Math.ceil(compositionEndTick(composition) / barTicks) : 0;
  return (
    <>
      <span className="w-full truncate font-mono text-[10px] text-ink">{composition.name}</span>
      <span className="font-mono text-[8.5px] tracking-[0.1em] text-ink-mut uppercase">
        {trackCount} {trackCount === 1 ? 'track' : 'tracks'} · {bars}{' '}
        {bars === 1 ? 'bar' : 'bars'}
      </span>
    </>
  );
}

export function CompositionLibraryRail() {
  const compositions = useLibraryCompositions();
  const open = useEditingComposition();
  const [refusal, setRefusal] = useState<string | null>(null);
  /** Which row has its rename form up. One at a time — two open forms would make
   *  "which name am I typing" a question. */
  const [renamingId, setRenamingId] = useState<string | null>(null);

  /** Say what the seam refused, or clear the last refusal on success. */
  const report = <T,>(result: Result<T>): T | null => {
    setRefusal(result.ok ? null : result.reason);
    return result.ok ? result.value : null;
  };

  const create = () => {
    const made = report(openBlankComposition());
    if (!made) return;
    // A blank composition arrives named but unnamed-by-you. Opening the rename
    // form on it is how you say what it is while you still know — and it is the
    // same form the Rename button opens, not a second naming flow.
    setRenamingId(made.id);
  };

  const choose = (composition: Composition) => {
    setRefusal(null);
    if (composition.id === open?.id) return;
    stop();
    report(openComposition(composition.id));
  };

  const remove = (composition: Composition) => {
    setRefusal(null);
    // Confirmed whatever is in it, and counted rather than described vaguely:
    // there is no undo across a delete, because history is per-composition and
    // goes with the document. The sentence names blocks rather than notes —
    // notes live in the patterns, which the delete does not touch.
    const blocks = composition.tracks.reduce(
      (total, track) => total + track.placements.length,
      0,
    );
    const what =
      blocks === 0
        ? `Delete "${composition.name}"? This cannot be undone.`
        : `Delete "${composition.name}"? Its ${blocks} ${blocks === 1 ? 'block goes' : 'blocks go'} with it, and this cannot be undone. The patterns they were cut from are not deleted.`;
    if (!window.confirm(what)) return;
    if (renamingId === composition.id) setRenamingId(null);
    // Only the OPEN one leaves the page with nothing to draw, and the seam
    // deliberately does not chase a successor — the empty state is where you
    // land, and it has a New of its own.
    if (composition.id === open?.id) stop();
    report(deleteComposition(composition.id));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none px-2 pt-1 pb-1">
        <button
          type="button"
          onClick={create}
          className="control-accent pressable w-full rounded-lg px-2 py-1.5 font-mono text-[9.5px] font-bold tracking-[0.12em] uppercase"
        >
          <span aria-hidden>+ </span>New composition
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
        {compositions.length === 0 ? (
          <p className="px-1 py-2 font-mono text-[9px] leading-relaxed tracking-[0.12em] text-ink-mut uppercase">
            No compositions yet — press New composition to start one.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {compositions.map((composition) => {
              const isOpen = composition.id === open?.id;
              return (
                <li key={composition.id} className="flex flex-col gap-0.5">
                  <button
                    type="button"
                    // The row's own text is two unrelated fragments; run together
                    // they read as one nonsense phrase.
                    aria-label={`Open composition ${composition.name}`}
                    // The state, said rather than only drawn — the brass outline
                    // is the same fact for anyone who can see it.
                    aria-current={isOpen ? 'true' : undefined}
                    onClick={() => choose(composition)}
                    className={`control pressable flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left ${
                      isOpen ? 'outline outline-brass' : ''
                    }`}
                  >
                    <CompositionRowLabel composition={composition} />
                  </button>

                  {renamingId === composition.id ? (
                    <form
                      className="flex items-center gap-1"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const value = new FormData(e.currentTarget).get('compositionName');
                        if (report(renameComposition(composition.id, String(value ?? '')))) {
                          setRenamingId(null);
                        }
                      }}
                    >
                      <input
                        name="compositionName"
                        defaultValue={composition.name}
                        autoFocus
                        aria-label={`New name for ${composition.name}`}
                        className="well min-w-0 flex-1 rounded-md px-1.5 py-1 font-mono text-[10px] text-ink"
                      />
                      <button type="submit" className={ROW_ACTION}>
                        Save
                      </button>
                      <button
                        type="button"
                        // The refusal goes with the form that caused it: a
                        // `role="alert"` left standing after the action it
                        // described was abandoned reads as a live complaint about
                        // whatever the user does next.
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
                        aria-label={`Rename ${composition.name}`}
                        onClick={() => {
                          setRefusal(null);
                          setRenamingId(composition.id);
                        }}
                        className={ROW_ACTION}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        aria-label={`Duplicate ${composition.name}`}
                        onClick={() => report(duplicateComposition(composition.id))}
                        className={ROW_ACTION}
                      >
                        Copy
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${composition.name}`}
                        onClick={() => remove(composition)}
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
