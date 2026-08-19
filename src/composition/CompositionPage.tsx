import { useEffect, useRef, useState } from 'react';
import { useCompositionPlayback } from '../audio/playbackService';
import { ArrangementGrid, type PatternDragStarter } from './ArrangementGrid';
import type { ArrangementMode } from './arrangementMath';
import {
  closePlacementEditing,
  ensureComposition,
  JOB_LOCK_REASON,
  useIsJobRunning,
} from './compositionService';
import { NoteInspectorRail } from './NoteInspectorRail';
import { CompositionLibraryRail } from './CompositionLibraryRail';
import { PatternLibraryRail } from './PatternLibraryRail';
import { TransportBar } from './TransportBar';
import { VoiceRail } from './VoiceRail';
import { CompositionCommandPanel } from '../ai/CompositionCommandPanel';
import { Section } from '../shell/Section';
import type { SectionId } from '../voice/paramSchema';

/**
 * The composition rail's sections, of which there is currently one.
 *
 * A list rather than a boolean for the reason `App` holds the pattern page's:
 * the next section added must not have to change the shape of the state, and
 * open-ids rather than collapsed-ids means a section nobody asked for is not
 * open by default.
 */
/**
 * The rail's foldable sections, and CP-17 made this a union of three.
 *
 * ⚠ 'patterns' and 'compositions' are PATTERN MODE's, not the page's — edit mode
 * still swaps in the note inspector and voice mode the voice rail, neither of
 * which is a section. That asymmetry is knowingly temporary: a document switcher
 * living inside pattern mode is the wrong home, and the alternatives (a top-bar
 * document menu, or the whole rail as sections with no mode swap) were both
 * deferred rather than rejected. See CP-17 on the board.
 */
export type CompositionRailSectionId = 'commands' | 'patterns' | 'compositions';

/** What an uncontrolled render opens: nothing. Which sections START open is the
 *  owner's policy and it lives with the owner, in `App` — see
 *  `DEFAULT_OPEN_COMPOSITION_RAIL_SECTIONS` there. A module constant rather than
 *  a `[]` in the parameter list, so a caller that passes nothing does not get a
 *  new array identity on every render. */
const NONE_OPEN: readonly CompositionRailSectionId[] = [];

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
  { id: 'voice', label: 'Voice' },
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
  collapsedRacks,
  onCollapsedRacksChange,
  collapsedRackSections,
  onCollapsedRackSectionsChange,
  openRailSections,
  onOpenRailSectionsChange,
}: {
  mode: ArrangementMode;
  onModeChange: (mode: ArrangementMode) => void;
  /**
   * Which voice racks are folded, owned by `App` for the reason `mode` is —
   * this page unmounts on every visit to the pattern page. The UNSAVED edits
   * those racks hold are a different problem with a different answer: they are
   * in `voice/trackVoiceDrafts`, above every component, because the engine has
   * to read them too. See that module.
   */
  collapsedRacks?: readonly string[];
  onCollapsedRacksChange?: (collapsed: readonly string[]) => void;
  /** Which STAGES are folded inside those racks, per track — the same rule one
   *  level deeper (CP-16). Passed straight through for the same reason. */
  collapsedRackSections?: Readonly<Record<string, readonly SectionId[]>>;
  onCollapsedRackSectionsChange?: (
    collapsed: Readonly<Record<string, readonly SectionId[]>>,
  ) => void;
  /** Which rail sections are unfolded — owned by `App` for the reason `mode` is:
   *  this page unmounts on every visit to the pattern page, and a section that
   *  refolded itself on the way back is the same broken promise as a mode that
   *  forgets itself. */
  openRailSections?: readonly CompositionRailSectionId[];
  onOpenRailSectionsChange?: (
    next: (open: readonly CompositionRailSectionId[]) => readonly CompositionRailSectionId[],
  ) => void;
}) {
  const [openFailure, setOpenFailure] = useState<string | null>(null);
  /**
   * The fallback for an UNCONTROLLED render — a caller that passes neither half
   * of the pair.
   *
   * Without it the disclosure is dead: `openRailSections` would default to a
   * constant and the toggle would call an absent handler, leaving a button that
   * reports `aria-expanded="false"` forever and a section nothing can open. The
   * optional pair is not just for tests — `App` passes both, but the props are
   * optional the way `collapsedRacks` is, and an optional prop that silently
   * breaks the control it names is worse than one that works locally.
   */
  const [ownRailSections, setOwnRailSections] =
    useState<readonly CompositionRailSectionId[]>(NONE_OPEN);
  const railSections = openRailSections ?? ownRailSections;
  const toggleRailSection = (id: CompositionRailSectionId) => {
    const next = (was: readonly CompositionRailSectionId[]) =>
      was.includes(id) ? was.filter((open) => open !== id) : [...was, id];
    if (onOpenRailSectionsChange) onOpenRailSectionsChange(next);
    else setOwnRailSections(next);
  };
  /** A generation job owns the document — the mode bar goes with it. See the
   *  buttons for why this one control is disabled rather than left to refuse. */
  const jobRunning = useIsJobRunning();
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
              // ⚠ AND while a generation job holds the composition. The effect
              // below closes an open placement on EVERY mode change, and the
              // agent may be inside one — a switch would repoint the lib's one
              // pattern pointer out from under it and land the job's next notes
              // in the user's library pattern, which a cancel does not restore.
              // The seam refuses `openPlacementForEditing` for the same reason,
              // but `mode` lives in `App` and reaches no seam, so this is the
              // only place it can be refused.
              disabled={m.disabled || jobRunning}
              title={m.pending ?? (jobRunning ? JOB_LOCK_REASON : undefined)}
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
              <ArrangementGrid
                mode={mode}
                collapsedRacks={collapsedRacks}
                onCollapsedRacksChange={onCollapsedRacksChange}
                collapsedRackSections={collapsedRackSections}
                onCollapsedRackSectionsChange={onCollapsedRackSectionsChange}
                patternDragRef={patternDragRef}
              />
            )}
          </div>
        </section>

        {/* The rail is what CHANGES between the three modes, along with what a
            lane draws — the ruler, the headers and the scroll position never do
            (tickets/composition-page/README.md). Pattern mode gets the library,
            edit mode the note inspector, voice mode the voice list. */}
        <aside
          aria-label={
            mode === 'pattern' ? 'Pattern library' : mode === 'voice' ? 'Voices' : 'Inspector'
          }
          className="rail flex min-h-0 flex-col"
        >
          {/* COMMANDS, ALWAYS — then whatever the mode holds. The section is
              persistent and sits above the mode-swapped region on purpose: a
              generation job runs for minutes across mode switches, and its
              progress and its Cancel button cannot live in a region that is
              replaced when the user goes to look at what the agent just built.
              No `grow`: it is as tall as its content, so opening it costs the
              rail below it rows rather than half the column (see `PatternRail`
              in `App.tsx` for the whole argument). */}
          <Section
            label="Commands"
            open={railSections.includes('commands')}
            onToggle={() => toggleRailSection('commands')}
            // Visible whether the section is folded or not, because a folded
            // section's body is `hidden` — this is the only thing telling a user
            // who folded it that the agent is still working, and the mode bar
            // being dead is otherwise unexplained.
            note={jobRunning ? 'Running…' : undefined}
            // The rail is a flex column with no scroller of its own and this
            // section is `flex-none`, so anything unbounded inside it squeezes
            // the mode rail below towards zero and overflows the aside. The
            // panel bounds its own tallest region (the tool trace) and this is
            // the belt: at worst the commands scroll rather than the column.
            // Not assertable in jsdom, which has no layout.
            bodyClassName="max-h-[50vh] overflow-y-auto"
          >
            <CompositionCommandPanel mode={mode} />
          </Section>

          {mode === 'pattern' ? (
            <>
              {/* `grow`, and the only section here that has it: the pattern list
                  is what the grid is filled FROM, so it keeps the whole-rail
                  behaviour it had before CP-17 wrapped it in a disclosure. */}
              <Section
                label="Patterns"
                open={railSections.includes('patterns')}
                onToggle={() => toggleRailSection('patterns')}
                grow
              >
                <PatternLibraryRail
                  onPatternPointerDown={(patternId, e) =>
                    patternDragRef.current?.(patternId, e)
                  }
                />
              </Section>
              {/* Bounded rather than grown, for the reason the Commands section
                  gives: the rail is a flex column with no scroller of its own, so
                  an unbounded list would squeeze whatever sits above it towards
                  zero. A library of any size scrolls inside its own section. */}
              <Section
                label="Compositions"
                open={railSections.includes('compositions')}
                onToggle={() => toggleRailSection('compositions')}
                bodyClassName="max-h-[45vh] overflow-y-auto"
              >
                <CompositionLibraryRail />
              </Section>
            </>
          ) : mode === 'edit' ? (
            // Follows the NOTE selection, not the placement selection — see the
            // header of NoteInspectorRail. It is always mounted here, empty
            // state included, because a rail that appeared and vanished with the
            // selection would move the grid beside it on every click.
            <NoteInspectorRail />
          ) : (
            // Follows the TRACK selection — the third one on this page, and
            // neither of the two above. Always mounted for the same reason, with
            // its own empty states. See the header of VoiceRail.
            <VoiceRail />
          )}
        </aside>
      </div>
    </div>
  );
}
