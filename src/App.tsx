import { useEffect, useState } from 'react';
import { AppShell, type PageId } from './shell/AppShell';
import type { Pane } from './shell/PaneStack';
import { stop } from './audio/playbackService';
import { CompositionPage } from './composition/CompositionPage';
import type { ArrangementMode } from './composition/arrangementMath';
import { useEditingComposition } from './composition/compositionService';
import { ReferencePane, type ReferenceViewId } from './reference/ReferencePane';
import { ThemeReference } from './theme/ThemeReference';
import { Timeline } from './timeline/Timeline';
import { seedDemoPattern } from './timeline/demoPattern';
import { ensurePattern, getLibraryPatterns, useEditingPattern } from './patterns/patternService';
import { VoicePane, type WorkingVoice } from './voice/VoicePane';
import type { SectionId } from './voice/paramSchema';

/** Amp and Cabinet — the two stages you actually turn. The source and the output trim
 *  are tuned once and left, so they start folded. */
const DEFAULT_OPEN_SECTIONS: readonly SectionId[] = ['amp', 'cabinet'];

/** The stack's starting order. Which panes exist is decided below; this is only
 *  the order they open in, and the stack reconciles the two. */
const DEFAULT_PANE_ORDER: readonly string[] = ['reference', 'amp', 'timeline'];

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

  // The theme reference stays reachable while we build — it's the living record
  // of the design system.
  if (new URLSearchParams(window.location.search).has('theme')) {
    return <ThemeReference />;
  }

  if (page === 'composition') {
    return <CompositionShell onPageChange={setPage} mode={mode} onModeChange={setMode} />;
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
        <div className="flex flex-1 items-center justify-center">
          <span className="font-mono text-[10px] font-semibold tracking-[0.18em] text-ink-mut uppercase">
            Composer
          </span>
        </div>
      }
    />
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
}: {
  onPageChange: (page: PageId) => void;
  mode: ArrangementMode;
  onModeChange: (mode: ArrangementMode) => void;
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
      <CompositionPage mode={mode} onModeChange={onModeChange} />
    </AppShell>
  );
}
