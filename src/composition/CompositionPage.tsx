import { useEffect, useRef, useState } from 'react';
import { useCompositionPlayback } from '../audio/playbackService';
import { ArrangementGrid, type PatternDragStarter } from './ArrangementGrid';
import type { ArrangementMode } from './arrangementMath';
import { closePlacementEditing, ensureComposition } from './compositionService';
import { PatternLibraryRail } from './PatternLibraryRail';
import { TransportBar } from './TransportBar';

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
  { id: 'edit', label: 'Edit' },
  { id: 'voice', label: 'Voice', disabled: true, pending: 'Voice mode arrives in slice 3' },
];

/**
 * The page's audio lifecycle, mounted as a leaf that renders nothing.
 *
 * Not called from `CompositionPage` itself, and that is not a style choice:
 * `useCompositionPlayback` calls `usePlaybackEngine`, which reads the beat
 * counters out of the lib's metronome store — so its CALLER re-renders on every
 * beat and subdivision for as long as the transport runs. From the page that
 * would reconcile the mode bar, the whole grid (re-running the ruler marks, the
 * lane rects and every block) and the rail four to eight times a bar, competing
 * with the 60 Hz playhead. Here the re-render reconciles nothing.
 */
function CompositionAudio() {
  useCompositionPlayback();
  return null;
}

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

  /**
   * ⚠ THE CROSS-PAGE LEAK. Edit mode points the lib's ONE editing pointer at a
   * placement, and `selectEditingPattern` **is** that pointer's target — so
   * while a block is open the PATTERN PAGE would draw that block's snapshot, and
   * `openPlacementForEditing` nulls `editingPatternId` outright, so the library
   * pattern is closed rather than merely shadowed. `App`'s `ensurePattern` would
   * then adopt whatever was updated most recently on the way back.
   *
   * All three exits are covered by this one effect: the cleanup runs when `mode`
   * changes (leaving edit mode) and when this page unmounts (leaving the
   * composition page, which is also every visit to the pattern page). The
   * leading call covers arriving in a non-edit mode with a block still open —
   * which a remembered `mode` in `App` makes reachable. `closePlacementEditing`
   * is a no-op when nothing is open, which is why it can be wired this bluntly.
   *
   * Same family as the CP-02 defect where `openBlankComposition` nulled the same
   * pointer and `App` answered by creating a junk pattern on every call. Covered
   * by a regression test, not a manual check — tests/EditMode.test.tsx.
   */
  useEffect(() => {
    if (mode !== 'edit') closePlacementEditing();
    return () => {
      closePlacementEditing();
    };
  }, [mode]);

  return (
    <div className="grid min-h-0 grid-rows-[auto_1fr]">
      {/* The audio lifecycle for this page — the shared metronome, the
          multi-track engine, and the store subscription that makes a mute, a
          solo or a fader audible mid-playback. A sibling of the grid rather
          than something inside it for the reason `App` holds `mode`: the grid
          is replaced by a failure message when a composition can't be opened,
          and the transport must not be torn down and rebuilt by that. */}
      <CompositionAudio />
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

        <span className="mx-1 h-4 w-px bg-line" />

        {/* In the page chrome rather than the grid's toolbar: the transport is
            the one control here that is about the WHOLE composition and stays
            true in all three modes, where everything in the grid's strip (zoom,
            snap, the selection's actions) is about the surface you are looking
            at. (It renders nothing when no composition is open, which is also
            the failed-open state — there is no transport for a document that
            doesn't exist.) */}
        <TransportBar />
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
                {/* TODO(CP-12 / CP-15): the note inspector and the voice list.
                    Edit mode's lanes are live — this is the rail that is not,
                    which is why the wording says what is missing rather than
                    what has not been built. */}
                {mode === 'edit'
                  ? 'Note inspector arrives in CP-12'
                  : 'Voice list arrives in slice 3'}
              </span>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
