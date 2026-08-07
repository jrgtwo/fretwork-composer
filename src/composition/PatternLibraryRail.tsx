import { useRef, useState } from 'react';
import type { Pattern } from '@fretwork/lib';
import { useLibraryPatterns } from '../patterns/patternService';
import { PatternRowLabel } from '../patterns/PatternLibraryPanel';
import { useSelectedTrackId, useTracks } from './compositionService';
import { DRAG_THRESHOLD_PX, appendPatternToTrack } from './useArrangementGestures';

/**
 * The pattern library, in the composition page's right rail.
 *
 * READ AND DRAG ONLY. No create, rename, delete or foldering — authoring a
 * pattern stays on the pattern page, which is the whole reason that page keeps
 * its Reference pane (tickets/composition-page/README.md). What arrives here is
 * whatever `library.patterns` holds, live: a pattern written on the other page
 * is listed the next time this renders, with no reload and no import step.
 *
 * Two ways to place the same pattern, both landing on
 * `compositionService.addPlacement`:
 *
 *   - DRAG a row onto a lane — `onPatternPointerDown` hands the press to the
 *     grid's gesture machinery, which owns the snap, the drop preview and the
 *     edge auto-scroll (`useArrangementGestures`).
 *   - PRESS a row — `appendPatternToTrack` puts it at the end of the focused
 *     track. Not a convenience: a drag is unreachable from a keyboard, and a
 *     capability with no keyboard route is one a keyboard user simply does not
 *     have. Same reasoning that makes every capability a function first.
 *
 * A row's TEXT is `PatternRowLabel`, shared with the pattern page's library panel
 * (PP-01) so that a pattern describes itself — name, instrument and derived
 * length — identically on both pages. Only the text is shared; what a row DOES
 * here has nothing in common with what it does there, and the note on
 * `PatternLibraryPanel` says exactly what differs.
 */
export function PatternLibraryRail({
  onPatternPointerDown,
}: {
  /** Begins a drag-to-place. Absent while no arrangement is mounted to drop
   *  onto, in which case rows still place by press. */
  onPatternPointerDown?: (patternId: string, e: React.PointerEvent) => void;
}) {
  const patterns = useLibraryPatterns();
  const tracks = useTracks();
  const selectedTrackId = useSelectedTrackId();
  const [refusal, setRefusal] = useState<string | null>(null);
  /** Where the press that is about to become a click began. Null for a click
   *  with no pointer behind it — Enter or Space on a focused row. */
  const pressAt = useRef<{ x: number; y: number } | null>(null);

  const target = tracks.find((track) => track.id === selectedTrackId) ?? tracks[0];

  const place = (pattern: Pattern) => {
    const result = appendPatternToTrack(pattern.id, target?.id);
    setRefusal(result.ok ? null : result.reason);
  };

  /**
   * A row's rows are buttons, so a DRAG that starts and ends on one still fires
   * `click` — and placing on both the drop and the click puts the pattern down
   * twice. The threshold is the gesture module's own, so the two can't disagree
   * about where a click stops and a drag starts.
   */
  const wasDrag = (e: React.MouseEvent) => {
    const from = pressAt.current;
    pressAt.current = null;
    if (!from) return false;
    return (
      Math.abs(e.clientX - from.x) >= DRAG_THRESHOLD_PX ||
      Math.abs(e.clientY - from.y) >= DRAG_THRESHOLD_PX
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-baseline justify-between gap-2 border-b border-rim-dark px-3 py-2">
        <span className="font-mono text-[10px] font-semibold tracking-[0.18em] text-ink-mut uppercase">
          Patterns
        </span>
        <span className="font-mono text-[9px] text-ink-mut/70">{patterns.length}</span>
      </div>

      {/* Stated once, above the list, rather than as a tooltip per row: it names
          where a press puts the block, which is the one thing a press does that
          isn't obvious from pressing it. */}
      <p className="flex-none px-3 py-1.5 font-mono text-[8.5px] leading-relaxed tracking-[0.1em] text-ink-mut/70 uppercase">
        {target
          ? `Drag onto a lane, or press to append to ${target.name}`
          : 'Drag onto a lane'}
      </p>

      {refusal && (
        // `role="alert"`: a refused placement is the one case where nothing
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
            No patterns yet — write one on the pattern page and it appears here.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {patterns.map((pattern) => {
              // The length `PatternRowLabel` prints is in the PATTERN's own
              // meter, not the composition's: the row describes the pattern as
              // written, and a 3/4 riff is two of its bars whichever arrangement
              // it is dropped into. It does mean a cross-meter drop occupies a
              // different number of ARRANGEMENT bars than the row states.
              return (
                <li key={pattern.id}>
                  <button
                    type="button"
                    data-library-pattern={pattern.id}
                    // The row's own text is three unrelated fragments; run
                    // together they read as one nonsense phrase.
                    aria-label={`Place pattern ${pattern.name}`}
                    // `touch-none`: a horizontal drag off the rail would
                    // otherwise be claimed by the page's native pan, which fires
                    // pointercancel and kills the gesture before it reaches a
                    // lane. `preventDefault` on pointerdown cannot stop that.
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      pressAt.current = { x: e.clientX, y: e.clientY };
                      onPatternPointerDown?.(pattern.id, e);
                    }}
                    onClick={(e) => {
                      if (wasDrag(e)) return;
                      place(pattern);
                    }}
                    className="control pressable flex w-full touch-none cursor-grab flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left select-none"
                  >
                    <PatternRowLabel pattern={pattern} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
