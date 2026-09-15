import { useEffect, useRef, useState } from 'react';
import { useCompositionPlayback } from '../audio/playbackService';
import { ArrangementGrid, type PatternDragStarter } from './ArrangementGrid';
import {
  selectedTrackView,
  setTrackView,
  type ArrangementMode,
  type CompositionTrackViews,
} from './arrangementMath';
import {
  ensureComposition,
  useEditingComposition,
  useIsJobRunning,
  useSelectedTrackId,
  useTracks,
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
 * The rail's foldable sections, and CP-17 made this a union of three.
 *
 * A list rather than a boolean for the reason `App` holds the pattern page's:
 * the next section added must not have to change the shape of the state, and
 * open-ids rather than collapsed-ids means a section nobody asked for is not
 * open by default.
 *
 * ⚠ 'patterns' and 'compositions' belong to the PATTERN RAIL — the rail a
 * SELECTED TRACK ON PATTERN gets (there is no page mode any more; see the
 * component). A selected Edit track swaps in the note inspector and a selected
 * Voice track the voice rail, neither of which is a section. That asymmetry is
 * knowingly temporary: a document switcher living inside the pattern rail is the
 * wrong home, and the alternatives (a top-bar document menu, or the whole rail
 * as sections with no swap at all) were both deferred rather than rejected. See
 * CP-17 on the board.
 */
export type CompositionRailSectionId = 'commands' | 'patterns' | 'compositions';

/** What an uncontrolled render opens: nothing. Which sections START open is the
 *  owner's policy and it lives with the owner, in `App` — see
 *  `DEFAULT_OPEN_COMPOSITION_RAIL_SECTIONS` there. A module constant rather than
 *  a `[]` in the parameter list, so a caller that passes nothing does not get a
 *  new array identity on every render. */
const NONE_OPEN: readonly CompositionRailSectionId[] = [];

/** What an uncontrolled render starts with: every track on Pattern. A module
 *  constant so an uncontrolled page does not get a new empty map per render. */
const NO_VIEWS: CompositionTrackViews = {};

/**
 * The page's audio lifecycle, mounted as a leaf that renders nothing.
 *
 * Not called from `CompositionPage` itself, and that is not a style choice:
 * `useCompositionPlayback` calls `usePlaybackEngine`, which reads the beat
 * counters out of the lib's metronome store — so its CALLER re-renders on every
 * beat and subdivision for as long as the transport runs. From the page that
 * would reconcile the whole grid (re-running the ruler marks, the lane rects,
 * every header and every block) and the rail four to eight times a bar,
 * competing with the 60 Hz playhead. Here the re-render reconciles nothing.
 */
function CompositionAudio() {
  useCompositionPlayback();
  return null;
}

/**
 * The composition page.
 *
 * Deliberately not a `PaneStack`: this page owns fixed regions — a transport
 * strip, then a grid and a rail that fill the rest of the viewport — and never
 * scrolls as a page. Two scrollable time grids inside a scrolling page is the
 * pane-layout debt in docs/FOLLOW-UPS.md, and this surface is avoiding it rather
 * than inheriting it.
 *
 * ⚠ THERE IS NO PAGE MODE ANY MORE. COMPS-TRACK-TABS milestone 4 removed the
 * three-button bar: each TRACK carries its own view (`views`), and the rail
 * follows the SELECTED track's. What used to be a page-wide statement is now
 * always one of two questions — "what is this lane showing" (the grid asks
 * `viewOf` per lane) or "what is the selected track showing" (this page, for the
 * rail). A third spelling of it here would be the competing authority the
 * milestone exists to delete.
 *
 * `views` is owned by `App` for the same reason `referenceView` and the
 * collapsed racks are: state that has to outlive an unmount lives above the
 * thing that unmounts, and this page unmounts every time you visit the pattern
 * page.
 */
export function CompositionPage({
  views,
  onTrackViewChange,
  collapsedRacks,
  onCollapsedRacksChange,
  collapsedRackSections,
  onCollapsedRackSectionsChange,
  openRailSections,
  onOpenRailSectionsChange,
}: {
  /**
   * Which view each track of each composition is showing — keyed by composition
   * id, then track id, a MISSING entry meaning Pattern (`arrangementMath`).
   *
   * Optional, with local state behind it, exactly as the rail sections are: an
   * uncontrolled render is a working page whose view buttons work locally, which
   * is what a test rendering this component directly gets.
   */
  views?: CompositionTrackViews;
  onTrackViewChange?: (
    compositionId: string,
    trackId: string,
    view: ArrangementMode,
  ) => void;
  /**
   * Which voice racks are folded, owned by `App` for the reason `views` is —
   * this page unmounts on every visit to the pattern page. The UNSAVED edits
   * those racks hold are a different problem with a different answer: they are
   * in `voice/voiceDrafts`, above every component, because the engine has
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
  /** Which rail sections are unfolded — owned by `App` for the reason `views`
   *  is: this page unmounts on every visit to the pattern page, and a section
   *  that refolded itself on the way back is the same broken promise as a view
   *  that forgets itself. */
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
  /**
   * The same uncontrolled fallback, for the view map — see the rail sections
   * above. `App` passes both halves; a caller that passes neither gets a page
   * whose per-track view buttons work locally rather than a row of dead controls.
   *
   * A PASSED MAP WINS, exactly as a passed section list does — see the same
   * fallback in `ArrangementGrid`.
   */
  const [ownViews, setOwnViews] = useState<CompositionTrackViews>(NO_VIEWS);
  const trackViews = views ?? ownViews;
  const changeTrackView = (
    compositionId: string,
    trackId: string,
    view: ArrangementMode,
  ) => {
    if (onTrackViewChange) onTrackViewChange(compositionId, trackId, view);
    // Only when UNCONTROLLED — a caller that passes a map and no handler owns it
    // and does not want it written from in here. Same guard as the grid's.
    else if (views === undefined) {
      setOwnViews((was) => setTrackView(was, compositionId, trackId, view));
    }
  };
  /** A generation job owns the document. The per-track view buttons go with it —
   *  see `TrackHeader`, which disables them for the reason the mode bar used to
   *  be disabled: a view change can close an open block, and the agent may be
   *  inside one. */
  const jobRunning = useIsJobRunning();
  /**
   * ── THE RAIL FOLLOWS THE SELECTED TRACK'S VIEW (§1, §2) ────────────────────
   *
   * Not the page's — there is no page view. Three tracks can be in three
   * different views at once, and the one in the rail is the one whose track is
   * SELECTED.
   *
   * `arrangementMath.selectedTrackView`, which is the SAME function
   * `ArrangementGrid` routes ⌘Z and the toolbar's twins through. The membership
   * check and the no-selection Pattern fallback live there, in one place, so the
   * rail and the keyboard cannot end up disagreeing about which document the
   * user is pointed at.
   *
   * These three subscriptions cost nothing extra: `CompositionShell` — this
   * component's parent, which does not memoise it — already reads the
   * composition to title the page, so this subtree reconciles on every store
   * write either way.
   */
  const composition = useEditingComposition();
  const tracks = useTracks();
  const selectedTrackId = useSelectedTrackId();
  const railView: ArrangementMode = selectedTrackView(
    trackViews,
    composition?.id ?? null,
    selectedTrackId,
    tracks,
  );
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
   * ⚠ THE CROSS-PAGE LEAK, AND WHERE IT IS GUARDED NOW.
   *
   * Edit points the lib's ONE editing pointer at a placement, and
   * `selectEditingPattern` **is** that pointer's target — so while a block is
   * open the PATTERN PAGE would draw that block's snapshot, and
   * `openPlacementForEditing` nulls `editingPatternId` outright, so the library
   * pattern is closed rather than merely shadowed. `App`'s `ensurePattern` would
   * then adopt whatever was updated most recently on the way back. Same family
   * as the CP-02 defect where `openBlankComposition` nulled the same pointer and
   * `App` answered by creating a junk pattern on every call.
   *
   * This page used to carry the whole guard as one effect keyed on `mode`, whose
   * cleanup closed the placement. There is no page mode to key it on any more,
   * and §4 is explicit that the replacement must NOT be an unconditional cleanup
   * keyed on the view map — that fires on every unrelated track's view change,
   * closing a block the user is editing on some other track because a third
   * track switched to Voice. `ArrangementGrid` splits the two halves instead:
   *
   *  - LEAVING EDIT closes that track's block, in the grid's own reconciler —
   *    per TRACK, which is the granularity the condition actually has
   *    (`viewOfTrack(editingTrackId) !== 'edit'`), and synchronously in the view
   *    button's own handler so no frame draws a live block on a lane that has
   *    stopped drawing one.
   *  - PAGE EXIT closes whatever is left, in the grid's unmount effect — keyed
   *    only on stable callbacks, so it fires on unmount and on nothing else.
   *
   * Both run `endOutgoingWork()` first, and both are idempotent. The regression
   * for the leak itself is tests/EditMode.test.tsx, against the page.
   */

  return (
    <div className="grid min-h-0 grid-rows-[auto_1fr]">
      {/* The audio lifecycle for this page — the shared metronome, the
          multi-track engine, and the store subscription that makes a mute, a
          solo or a fader audible mid-playback. A sibling of the grid rather
          than something inside it for the reason `App` holds the view map: the
          grid is replaced by a failure message when a composition can't be
          opened, and the transport must not be torn down and rebuilt by that. */}
      <CompositionAudio />
      {/* What is left of the mode bar: the strip and its rule, holding the
          transport alone. The three view buttons moved into the track headers,
          where the view now lives (COMPS-TRACK-TABS milestone 4). The inline
          separator went with them — it divided the buttons from the transport
          and there is nothing left on its left to divide.

          The transport itself is in the page chrome rather than the grid's
          toolbar, and this milestone is where that pays: it is the one control
          here that is about the WHOLE composition and stays true whatever mix of
          views the stack is in, where everything in the grid's strip (zoom,
          snap, the selection's actions) is about the surface you are looking at.
          (It renders nothing when no composition is open, which is also the
          failed-open state — there is no transport for a document that doesn't
          exist.) */}
      <div className="flex items-center gap-2 border-b border-rim-dark bg-panel px-3 py-1.5">
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
                views={trackViews}
                onTrackViewChange={changeTrackView}
                collapsedRacks={collapsedRacks}
                onCollapsedRacksChange={onCollapsedRacksChange}
                collapsedRackSections={collapsedRackSections}
                onCollapsedRackSectionsChange={onCollapsedRackSectionsChange}
                patternDragRef={patternDragRef}
              />
            )}
          </div>
        </section>

        {/* The rail is what CHANGES with the SELECTED TRACK'S view, along with
            what that track's lane draws — the ruler, the headers and the scroll
            position never do (tickets/composition-page/README.md). A Pattern
            track gets the library, an Edit track the note inspector, a Voice
            track the voice list; no valid selection gets the library. */}
        <aside
          aria-label={
            railView === 'pattern'
              ? 'Pattern library'
              : railView === 'voice'
                ? 'Voices'
                : 'Inspector'
          }
          className="rail flex min-h-0 flex-col"
        >
          {/* COMMANDS, ALWAYS — then whatever the selected track's view holds.
              The section is persistent and sits above the swapped region on
              purpose: a generation job runs for minutes across view and
              selection changes, and its progress and its Cancel button cannot
              live in a region that is replaced when the user goes to look at
              what the agent just built. Its contents ARE split, into a
              composition group and a track group named after the selected track
              (milestone 5) — two lists over one runner, which is why the split
              did not become two panels.
              No `grow`: it is as tall as its content, so opening it costs the
              rail below it rows rather than half the column (see `PatternRail`
              in `App.tsx` for the whole argument). */}
          <Section
            label="Commands"
            open={railSections.includes('commands')}
            onToggle={() => toggleRailSection('commands')}
            // Visible whether the section is folded or not, because a folded
            // section's body is `hidden` — this is the only thing telling a user
            // who folded it that the agent is still working, and the headers'
            // view buttons being dead is otherwise unexplained.
            note={jobRunning ? 'Running…' : undefined}
            // The rail is a flex column with no scroller of its own and this
            // section is `flex-none`, so anything unbounded inside it squeezes
            // the view-specific region below towards zero and overflows the
            // aside. The
            // panel bounds its own tallest region (the tool trace) and this is
            // the belt: at worst the commands scroll rather than the column.
            // Not assertable in jsdom, which has no layout.
            bodyClassName="max-h-[50vh] overflow-y-auto"
          >
            {/* The SELECTED TRACK'S view — and since milestone 5 the panel uses
                it for ONE of its two lists. Its composition group does not read
                it at all and is offered here in every view and with nothing
                selected, which is what stops "Create a backing track" vanishing
                behind a Voice track. The prop is `view` and not `mode` because
                that is what it is: there is no page mode to pass. */}
            <CompositionCommandPanel view={railView} />
          </Section>

          {railView === 'pattern' ? (
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
          ) : railView === 'edit' ? (
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
