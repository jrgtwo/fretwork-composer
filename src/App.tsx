import { useEffect, useState } from 'react';
import { AppShell } from './shell/AppShell';
import type { Pane } from './shell/PaneStack';
import { ReferencePane, type ReferenceViewId } from './reference/ReferencePane';
import { ThemeReference } from './theme/ThemeReference';
import { Timeline } from './timeline/Timeline';
import { seedDemoPattern } from './timeline/demoPattern';
import { useEditingPattern } from './patterns/patternService';
import { VoicePane, type WorkingVoice } from './voice/VoicePane';
import type { SectionId } from './voice/paramSchema';

/** Amp and Cabinet — the two stages you actually turn. The source and the output trim
 *  are tuned once and left, so they start folded. */
const DEFAULT_OPEN_SECTIONS: readonly SectionId[] = ['amp', 'cabinet'];

export function App() {
  const pattern = useEditingPattern();
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

  // Seed something to edit until saved patterns exist. The store persists to
  // sessionStorage, so this only fires on a genuinely empty session.
  useEffect(() => {
    if (!pattern) seedDemoPattern();
  }, [pattern]);

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

  // The theme reference stays reachable while we build — it's the living record
  // of the design system.
  if (new URLSearchParams(window.location.search).has('theme')) {
    return <ThemeReference />;
  }

  return (
    <AppShell
      documentName={pattern?.name ?? 'Untitled'}
      documentMeta={
        pattern
          ? `${pattern.timeSignature.numerator}/${pattern.timeSignature.denominator}`
          : undefined
      }
      panes={panes}
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
