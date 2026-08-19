import { useEffect, useState } from 'react';
import { AppShell, type PageId } from './shell/AppShell';
import type { Pane } from './shell/PaneStack';
import { applyVoicePreset, stop } from './audio/playbackService';
import { CompositionPage, type CompositionRailSectionId } from './composition/CompositionPage';
import type { ArrangementMode } from './composition/arrangementMath';
import { useEditingComposition } from './composition/compositionService';
import { ReferencePane, type ReferenceViewId } from './reference/ReferencePane';
import { ThemeReference } from './theme/ThemeReference';
import { Timeline } from './timeline/Timeline';
import { seedDemoPattern } from './timeline/demoPattern';
import { ensurePattern, getLibraryPatterns, useEditingPattern } from './patterns/patternService';
import {
  PatternLibraryCount,
  PatternLibraryPanel,
  type SwitchGuard,
} from './patterns/PatternLibraryPanel';
import { Section } from './shell/Section';
import { CommandPanel } from './ai/CommandPanel';
import { VoicePane, type WorkingVoice } from './voice/VoicePane';
// The default lives with the schema it indexes, so the pattern page's pane and the
// composition page's racks cannot open on different stages (see `paramSchema`).
import { DEFAULT_OPEN_SECTIONS, type SectionId } from './voice/paramSchema';

/** The stack's starting order. Which panes exist is decided below; this is only
 *  the order they open in, and the stack reconciles the two. */
const DEFAULT_PANE_ORDER: readonly string[] = ['reference', 'amp', 'timeline'];

/**
 * The pattern page's rail sections, top to bottom.
 *
 * The rail is shared between the library and the agent as collapsible sections
 * rather than the agent taking a fourth pane, for the reason a fourth pane was
 * refused for the library itself (see the note on `PatternLibraryPanel`): these
 * are chrome, not views of the pattern.
 */
type RailSectionId = 'library' | 'commands';

/** Open ids, not collapsed ones — the opposite of `collapsedPanes` and for a
 *  reason: a section a user has not asked for must not be open by default, and
 *  a collapsed-list default would have to be edited every time one is added.
 *
 *  Commands is therefore CLOSED on arrival. It is the second surface competing
 *  for a 300px column, and the library is the one you need to have a pattern to
 *  run a command against at all. */
const DEFAULT_OPEN_RAIL_SECTIONS: readonly RailSectionId[] = ['library'];

/**
 * The COMPOSITION page's rail, whose one section opens OPEN — the opposite of
 * the rule above, and deliberately.
 *
 * There, Commands is the second surface competing for a 300px column and the
 * library is the one you need before a command has anything to act on. On the
 * composition page the rail's other content is a per-selection detail view (the
 * note inspector, the voice rack) and the commands are the only entry to a
 * generation job. The deciding reason is the JOB: a run's Cancel button lives
 * inside that section, and a section that starts folded is a job the user cannot
 * stop without first discovering where it lives.
 */
// Patterns open because it is the grid's drag source and was the whole rail
// before CP-17 folded it into a section — arriving with it shut would read as
// the library having gone. Compositions shut: the page's own empty state carries
// a New button, so the feature is reachable without spending rail height on a
// list most sessions never touch.
const DEFAULT_OPEN_COMPOSITION_RAIL_SECTIONS: readonly CompositionRailSectionId[] = [
  'commands',
  'patterns',
];

/** A switch that costs nothing: go ahead, and there is nothing to run after. */
const NOTHING_STRANDED = () => {};

export function App() {
  const pattern = useEditingPattern();

  // Which page is open is app state, not a URL: there is no router here and this
  // is a single editor with two surfaces, not two documents you can link to.
  const [page, setPage] = useState<PageId>('pattern');

  // The composition page's mode, held here for exactly the reason the two pieces
  // of pane state below are: `CompositionPage` unmounts whenever you step over to
  // the pattern page, and a mode that forgets itself on every visit is the same
  // bug as a pane that forgets its view on every collapse.
  const [mode, setMode] = useState<ArrangementMode>('pattern');

  // Which voice racks are folded — the same rule again, one level deeper: the
  // racks are drawn by lanes that are replaced on every mode switch, inside a
  // page that unmounts on every visit to the pattern page. The UNSAVED EDITS
  // those racks hold are deliberately NOT here, and that is not an
  // inconsistency: `playbackService` builds each track's voice from them, so
  // they have to be readable without a render — see `voice/trackVoiceDrafts`,
  // which is above every component for both reasons at once.
  const [collapsedRacks, setCollapsedRacks] = useState<readonly string[]>([]);

  // And which STAGES are folded inside those racks — CP-16's second level of
  // disclosure, held here for the same reason and keyed by track id because that
  // is the axis it varies on. Folding Amp on the Lead rack and coming back to
  // find it open again is the same broken promise as a rack that unfolds itself.
  // A track with NO ENTRY is one nobody has folded yet, and opens on
  // `DEFAULT_OPEN_SECTIONS` like the pattern page does. Absent and empty are
  // therefore different states — empty means "every stage open, and the user
  // said so" — which is why the grid stores an empty list rather than dropping it.
  const [collapsedRackSections, setCollapsedRackSections] = useState<
    Readonly<Record<string, readonly SectionId[]>>
  >({});

  // Which reference view is showing is pane state, but it can't live in the pane:
  // `PaneStack` unmounts a collapsed pane's body — deliberately, so a folded-away pane
  // runs no observers — and that unmount would forget it. Anything that has to outlive
  // a collapse belongs above the stack, which is here.
  const [referenceView, setReferenceView] = useState<ReferenceViewId>('fretboard');

  // Same reason, and it matters more here: this is the voice editor's UNSAVED work. Held
  // inside the pane it would be destroyed by a collapse — silently, and with the engine
  // still playing the edit, since `playbackService` keeps its own tagged copy. Which
  // sections are unfolded is the same kind of state, one degree less costly to lose.
  const [workingVoice, setWorkingVoice] = useState<WorkingVoice | null>(null);
  const [openSections, setOpenSections] = useState<readonly SectionId[]>(DEFAULT_OPEN_SECTIONS);

  // And the same again for the stack itself: `PaneStack` is unmounted outright
  // when the composition page takes the body, so a collapse or a reorder held
  // inside it would be undone by every page round trip.
  const [paneOrder, setPaneOrder] = useState<readonly string[]>(DEFAULT_PANE_ORDER);
  const [collapsedPanes, setCollapsedPanes] = useState<readonly string[]>([]);

  // And once more for the rail's sections. The rail only exists on the pattern
  // page, so it is unmounted by every visit to the composition page — a section
  // folded away would silently unfold itself on the way back. Same rule as the
  // panes above, one surface across.
  const [openRailSections, setOpenRailSections] =
    useState<readonly RailSectionId[]>(DEFAULT_OPEN_RAIL_SECTIONS);

  // And once more for the COMPOSITION page's rail, which is a different rail
  // with a different section list — `CompositionPage` unmounts on every visit to
  // the pattern page, so a folded Commands section would unfold itself on the
  // way back. Held here rather than in `CompositionShell` for the same reason
  // `mode` is: the shell is unmounted by the same round trip.
  const [openCompositionRailSections, setOpenCompositionRailSections] = useState<
    readonly CompositionRailSectionId[]
  >(DEFAULT_OPEN_COMPOSITION_RAIL_SECTIONS);

  // Seed something to edit until saved patterns exist.
  //
  // The emptiness check is the whole point, and it is not paranoia: the lib
  // persists `library` but NOT `editingPatternId` (`partialize` in
  // `usePatternsStore`), so every reload arrives holding all the saved patterns
  // and no pointer at one. Seeding on `!pattern` alone therefore appended a
  // fresh "A major arpeggio" on each load — which nothing displayed until the
  // library rail landed, by which point there were eight.
  //
  // `ensurePattern` adopts the most recently updated pattern, so a returning
  // session reopens what it was last editing rather than the demo.
  //
  // The DEMO branch is a first-run affordance and nothing else. Deleting the
  // last pattern does not reach it: `patternService.deletePattern` leaves
  // something open (the lib's blank "Untitled pattern" when it has emptied the
  // library), so `pattern` is not null here on the way back from a delete.
  // Resurrecting a demo riff the user did not write, immediately after they
  // deleted everything, would read as the delete having failed.
  //
  // With one degenerate exception, stated where it arises (`deletePattern`):
  // the lib's `ensureEditingPattern` skips its auto-seed when a single pattern
  // would exceed the tier cap, which needs a cap of zero and no such tier
  // exists. Should one ever ship, this branch runs after a delete and the demo
  // is what comes back.
  useEffect(() => {
    if (pattern) return;
    if (getLibraryPatterns().length === 0) seedDemoPattern();
    else ensurePattern();
  }, [pattern]);

  // Leaving the pattern page unmounts `Timeline`, and with it the only transport
  // controls in the app. `playbackService` holds its engine at module level, so
  // without this the metronome keeps running with nothing on screen able to stop
  // it. It belongs here rather than in `Timeline`'s unmount cleanup: that would
  // also fire on a remount of the pane, killing playback on a mere collapse.
  useEffect(() => {
    if (page !== 'pattern') stop();
  }, [page]);

  /**
   * Asked before the library panel changes which pattern is open.
   *
   * SWITCHING COSTS NOTHING IN THE TIMELINE — every edit there is written to the
   * store as it is made. The app's one piece of unsaved work is the voice pane's
   * working preset, and it is keyed by pattern id (`workingKey` in `VoicePane`),
   * so the instant another pattern opens the edit stops applying to anything.
   *
   * The clear has to happen HERE rather than being left to `VoicePane`'s own
   * retire-a-stranded-copy effect, for the reason the state is here at all:
   * `PaneStack` unmounts a collapsed pane's body, so with Instrument & Amp folded
   * away that effect does not run — and `playbackService` keeps its own tagged
   * copy, which goes on sounding until something consults it. Hence
   * `applyVoicePreset(null)` too, exactly as the pane does it.
   *
   * The key is split rather than matched whole because only its first field —
   * the pattern id — decides whether THIS switch is what strands the copy; a copy
   * already stranded by something else has nothing left to lose.
   *
   * ASKING AND DISCARDING ARE TWO STEPS ({@link SwitchGuard}): this returns what
   * to run once the switch has actually happened. A create can still be refused
   * after the question has been answered — the lib's `createPattern` declines at
   * the tier cap — and discarding the user's tone for a pattern that was never
   * made is the one outcome nothing can put back.
   *
   * `window.confirm` and this wording are `VoicePane`'s, kept verbatim: the same
   * loss should not be described two ways depending on which control caused it.
   */
  const confirmPatternSwitch: SwitchGuard = () => {
    if (!workingVoice || !pattern) return NOTHING_STRANDED;
    if (workingVoice.key.split('|')[0] !== pattern.id) return NOTHING_STRANDED;
    if (!window.confirm('Discard unsaved changes to this voice?')) return null;
    return () => {
      setWorkingVoice(null);
      applyVoicePreset(null);
    };
  };

  // The theme reference stays reachable while we build — it's the living record
  // of the design system.
  if (new URLSearchParams(window.location.search).has('theme')) {
    return <ThemeReference />;
  }

  if (page === 'composition') {
    return (
      <CompositionShell
        onPageChange={setPage}
        mode={mode}
        onModeChange={setMode}
        collapsedRacks={collapsedRacks}
        onCollapsedRacksChange={setCollapsedRacks}
        collapsedRackSections={collapsedRackSections}
        onCollapsedRackSectionsChange={setCollapsedRackSections}
        openRailSections={openCompositionRailSections}
        onOpenRailSectionsChange={setOpenCompositionRailSections}
      />
    );
  }

  // No heights here on purpose. Every pane is as tall as its content needs and the
  // stack scrolls; collapse is the only size control. The `min`/`max`/`canFill` these
  // specs used to carry described a resize system that has been removed — see the note
  // at the top of `shell/paneLayout.ts` for why it went.
  const panes: Pane[] = [
    {
      id: 'reference',
      title: 'Reference',
      children: <ReferencePane view={referenceView} onViewChange={setReferenceView} />,
    },
    {
      id: 'amp',
      title: 'Instrument & Amp',
      children: (
        <VoicePane
          working={workingVoice}
          onWorkingChange={setWorkingVoice}
          openSections={openSections}
          onOpenSectionsChange={setOpenSections}
        />
      ),
    },
    {
      id: 'timeline',
      title: 'Timeline',
      children: <Timeline />,
    },
  ];

  return (
    <AppShell
      documentName={pattern?.name ?? 'Untitled'}
      documentMeta={
        pattern
          ? `${pattern.timeSignature.numerator}/${pattern.timeSignature.denominator}`
          : undefined
      }
      page={page}
      onPageChange={setPage}
      panes={panes}
      paneLayout={{
        order: paneOrder,
        onOrderChange: setPaneOrder,
        collapsed: collapsedPanes,
        onCollapsedChange: setCollapsedPanes,
      }}
      rail={
        <PatternRail
          confirmSwitch={confirmPatternSwitch}
          open={openRailSections}
          onOpenChange={setOpenRailSections}
        />
      }
    />
  );
}

/**
 * The pattern page's right rail: a stack of collapsible sections on the one
 * shared `shell/Section`, the library being the first of them.
 *
 * FREE-FORM, NOT ACCORDION — any number of sections open at once.
 *
 * The accordion case is that `--width-rail` is 300px and does not grow, so two
 * open sections split one narrow column. That premise is about WIDTH, and it is
 * height an accordion rations — but the height is real, and an earlier draft of
 * this note wrongly said it was not. `AppShell` hands the rail a stretched grid
 * item, so the aside is as tall as the taller COLUMN, which is the pane stack in
 * every normal case. What keeps that from becoming an accordion by accident is
 * `Section`'s opt-in `grow`: the LIBRARY is the one section that flexes and the
 * one that scrolls, so a second open section costs it rows rather than half the
 * rail, and closing that section gives them straight back.
 *
 * With the cost that shape, the accordion's own costs are the deciding ones — a
 * header press that cannot close the last section without leaving the rail
 * empty, and losing your place in the library every time you open a command.
 *
 * The one-at-a-time instinct is honoured in the DEFAULT instead:
 * `DEFAULT_OPEN_RAIL_SECTIONS` opens the library alone. Two open sections is
 * something a user asked for on a screen tall enough to want it, rather than the
 * state the app ships in.
 */
function PatternRail({
  confirmSwitch,
  open,
  onOpenChange,
}: {
  confirmSwitch: SwitchGuard;
  open: readonly RailSectionId[];
  /** An updater rather than a value, for the reason the panes' is one: two
   *  toggles batched into a single render must not lose the first. */
  onOpenChange: (next: (open: readonly RailSectionId[]) => readonly RailSectionId[]) => void;
}) {
  const toggle = (id: RailSectionId) =>
    onOpenChange((was) => (was.includes(id) ? was.filter((s) => s !== id) : [...was, id]));

  return (
    <>
      <Section
        label="Patterns"
        open={open.includes('library')}
        onToggle={() => toggle('library')}
        // A leaf subscriber rather than a number read here — see the note on
        // `PatternLibraryCount`. Reading the library in `App` re-renders the
        // timeline on every note edit.
        note={<PatternLibraryCount />}
        bodyClassName="flex min-h-0 flex-1 flex-col"
        // The rail's one growing section, and the only one with a scroller to
        // absorb what it is given. See the free-form note above.
        grow
      >
        <PatternLibraryPanel confirmSwitch={confirmSwitch} />
      </Section>

      {/* No `grow` — see the free-form note above. This section is as tall as
          its content, so opening it costs the library rows rather than half the
          rail, and closing it gives them straight back. */}
      <Section
        label="Commands"
        open={open.includes('commands')}
        onToggle={() => toggle('commands')}
      >
        <CommandPanel />
      </Section>
    </>
  );
}

/**
 * The composition page's frame.
 *
 * Split out of `App` so the composition subscription only exists while the page
 * is open. Read in `App` it would re-render the whole tree — panes, timeline and
 * all — on every arrangement write, including the ones CP-06's drags will fire
 * per pointer move while the pattern page is the one on screen.
 */
function CompositionShell({
  onPageChange,
  mode,
  onModeChange,
  collapsedRacks,
  onCollapsedRacksChange,
  collapsedRackSections,
  onCollapsedRackSectionsChange,
  openRailSections,
  onOpenRailSectionsChange,
}: {
  onPageChange: (page: PageId) => void;
  mode: ArrangementMode;
  onModeChange: (mode: ArrangementMode) => void;
  collapsedRacks: readonly string[];
  onCollapsedRacksChange: (collapsed: readonly string[]) => void;
  collapsedRackSections: Readonly<Record<string, readonly SectionId[]>>;
  onCollapsedRackSectionsChange: (
    collapsed: Readonly<Record<string, readonly SectionId[]>>,
  ) => void;
  openRailSections: readonly CompositionRailSectionId[];
  /** An updater rather than a value, for the reason the panes' is one: two
   *  toggles batched into a single render must not lose the first. */
  onOpenRailSectionsChange: (
    next: (open: readonly CompositionRailSectionId[]) => readonly CompositionRailSectionId[],
  ) => void;
}) {
  const composition = useEditingComposition();

  return (
    <AppShell
      // Not 'Untitled composition': that is byte-identical to the name the lib
      // gives an auto-created draft, so a refusal to open one would read in the
      // header exactly like success.
      documentName={composition?.name ?? '—'}
      documentMeta={
        composition
          ? `${composition.timeSignature.numerator}/${composition.timeSignature.denominator}`
          : undefined
      }
      page="composition"
      onPageChange={onPageChange}
    >
      <CompositionPage
        mode={mode}
        onModeChange={onModeChange}
        collapsedRacks={collapsedRacks}
        onCollapsedRacksChange={onCollapsedRacksChange}
        collapsedRackSections={collapsedRackSections}
        onCollapsedRackSectionsChange={onCollapsedRackSectionsChange}
        openRailSections={openRailSections}
        onOpenRailSectionsChange={onOpenRailSectionsChange}
      />
    </AppShell>
  );
}
