import { useEffect, useRef, useState } from 'react';
import { ArrangementGrid, type PatternDragStarter } from './ArrangementGrid';
import type { ArrangementMode } from './arrangementMath';
import { ensureComposition } from './compositionService';
import { PatternLibraryRail } from './PatternLibraryRail';

/**
 * The three modes are one surface, not three pages: the ruler, the track headers
 * and the scroll position never move between them — only what a lane draws and
 * what the rail holds. Drawing all three from the start, with two inert, is what
 * makes that legible before slices 2 and 3 fill them in.
 */
const MODES: readonly {
  id: ArrangementMode;
  label: string;
  /** Stated separately from `pending` so enabling a mode is one edit and losing
   *  its tooltip is not what enables it. */
  disabled?: true;
  pending?: string;
}[] = [
  { id: 'pattern', label: 'Pattern' },
  { id: 'edit', label: 'Edit', disabled: true, pending: 'Edit mode arrives in slice 2' },
  { id: 'voice', label: 'Voice', disabled: true, pending: 'Voice mode arrives in slice 3' },
];

/**
 * The composition page.
 *
 * Deliberately not a `PaneStack`: this page owns fixed regions — mode bar, then
 * a grid and a rail that fill the rest of the viewport — and never scrolls as a
 * page. Two scrollable time grids inside a scrolling page is the pane-layout
 * debt in docs/FOLLOW-UPS.md, and this surface is avoiding it rather than
 * inheriting it.
 *
 * `mode` is owned by `App` for the same reason `referenceView` and
 * `workingVoice` are: state that has to outlive an unmount lives above the thing
 * that unmounts, and this page unmounts every time you visit the pattern page.
 */
export function CompositionPage({
  mode,
  onModeChange,
}: {
  mode: ArrangementMode;
  onModeChange: (mode: ArrangementMode) => void;
}) {
  const [openFailure, setOpenFailure] = useState<string | null>(null);
  /**
   * The grid's drag-to-place entry point, published while the grid is mounted.
   *
   * The rail and the grid are siblings, and only the grid knows where the lanes
   * are, what the zoom is and which element scrolls. Passing the starter down a
   * ref keeps that geometry where it is computed instead of lifting it into
   * this page purely so a context could hand it back.
   */
  const patternDragRef = useRef<PatternDragStarter | null>(null);

  // The lib's `ensureEditingComposition` runs a subscription gate and returns
  // WITHOUT CREATING and WITHOUT ERROR when it is refused, so the seam's
  // `Result` is the only signal that nothing opened. Say so rather than
  // rendering an empty page with no explanation. Re-running (StrictMode's double
  // mount, or a return visit to this page) is a no-op once a composition is open.
  useEffect(() => {
    const opened = ensureComposition();
    setOpenFailure(opened.ok ? null : opened.reason);
  }, []);

  return (
    <div className="grid min-h-0 grid-rows-[auto_1fr]">
      <div className="flex items-center gap-2 border-b border-rim-dark bg-panel px-3 py-1.5">
        <span className="font-mono text-[9px] font-semibold tracking-[0.16em] text-ink-mut uppercase">
          Mode
        </span>
        <div className="flex gap-[3px]" role="group" aria-label="Composition mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              disabled={m.disabled}
              title={m.pending}
              // The page nav also has a button reading "Pattern"; without this
              // the two are indistinguishable in a screen reader's button list
              // or to voice control, and only sighted users get the grouping.
              aria-label={`${m.label} mode`}
              aria-pressed={mode === m.id}
              onClick={() => onModeChange(m.id)}
              className={`pressable rounded-lg px-2.5 py-1 font-mono text-[9px] font-bold tracking-[0.12em] uppercase disabled:opacity-40 ${
                mode === m.id ? 'control-accent' : 'control'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid min-h-0 grid-cols-[1fr_var(--width-rail)]">
        <section
          aria-label="Arrangement"
          className="flex min-h-0 min-w-0 flex-col p-3"
        >
          <div className="tray flex min-h-0 flex-1 flex-col overflow-hidden p-1.5">
            {openFailure ? (
              // A refusal is reported here rather than inside the grid: the grid
              // renders whatever composition is open and has no way to know that
              // opening one was ATTEMPTED and declined — only that there isn't
              // one, which is a different thing to tell the user.
              <div className="well flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 text-center">
                <p role="alert" className="max-w-[36ch] font-mono text-[10px] text-ink">
                  {openFailure}
                </p>
              </div>
            ) : (
              <ArrangementGrid mode={mode} patternDragRef={patternDragRef} />
            )}
          </div>
        </section>

        {/* The rail is what CHANGES between the three modes, along with what a
            lane draws — the ruler, the headers and the scroll position never do
            (tickets/composition-page/README.md). Pattern mode gets the library;
            the note inspector and the voice list are slices 2 and 3. */}
        <aside
          aria-label={mode === 'pattern' ? 'Pattern library' : 'Inspector'}
          className="rail flex min-h-0 flex-col"
        >
          {mode === 'pattern' ? (
            <PatternLibraryRail
              onPatternPointerDown={(patternId, e) =>
                patternDragRef.current?.(patternId, e)
              }
            />
          ) : (
            <div className="flex flex-1 items-center justify-center px-3 text-center">
              <span className="font-mono text-[9px] leading-relaxed tracking-[0.14em] text-ink-mut uppercase">
                {/* TODO(CP-12 / CP-15): the note inspector and the voice list. */}
                {mode === 'edit'
                  ? 'Note inspector arrives in slice 2'
                  : 'Voice list arrives in slice 3'}
              </span>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
