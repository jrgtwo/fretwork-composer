import { useEffect, useState } from 'react';
import { AppShell } from './shell/AppShell';
import type { Pane } from './shell/PaneStack';
import { ReferencePane, type ReferenceViewId } from './reference/ReferencePane';
import { ThemeReference } from './theme/ThemeReference';
import { Timeline } from './timeline/Timeline';
import { seedDemoPattern } from './timeline/demoPattern';
import { useEditingPattern } from './patterns/patternService';

/** Placeholder until the real surface lands in a later slice. */
function Placeholder({ label }: { label: string }) {
  return (
    <div className="well flex flex-1 items-center justify-center">
      <span className="font-mono text-[10px] font-semibold tracking-[0.18em] text-ink-mut uppercase">
        {label}
      </span>
    </div>
  );
}

export function App() {
  const pattern = useEditingPattern();
  // Which reference view is showing is pane state, but it can't live in the pane:
  // `PaneStack` unmounts a collapsed pane's body — deliberately, so a folded-away pane
  // runs no observers — and that unmount would forget it. Anything that has to outlive
  // a collapse belongs above the stack, which is here.
  const [referenceView, setReferenceView] = useState<ReferenceViewId>('fretboard');

  // Seed something to edit until saved patterns exist. The store persists to
  // sessionStorage, so this only fires on a genuinely empty session.
  useEffect(() => {
    if (!pattern) seedDemoPattern();
  }, [pattern]);

  // "Instrument & Amp" carries `canFill`: it's the pane allowed to absorb slack,
  // so the other two stay capped and can never stretch into empty space.
  const panes: Pane[] = [
    {
      id: 'reference',
      title: 'Reference',
      // Both bounds come from the fretboard's natural height, which is fixed by the
      // lib: it draws into a 1202×280 viewBox with `w-full min-w-[820px] h-auto`, so
      // the board is 280px tall at a 1202px-wide pane and never shorter than ~191px
      // however narrow the pane gets (the min-width takes over and it scrolls
      // sideways instead).
      //
      // Both numbers are the whole `<section>`, header included: that is what
      // `PaneStack` writes to `style.height` and what `clampHeight` clamps.
      //
      // `min` is the 191px floor plus everything stacked around it — 31 header,
      // 12 body padding, ~17 switch row, 4 gap, 12 figure padding, ~13 caption ≈ 280,
      // taken to 285 for rounding. Below it the neck is cropped rather than merely
      // small, and the pane is also *opened* at its `min` (PaneStack has no separate
      // initial height), so a token 60px here would mean the pane starts as a sliver of
      // an unreadable board. Squashing it further isn't a real use: collapsing is how
      // you get it out of the way. Wider than ~1000px the board grows past 191 and the
      // figure scrolls, which is the honest answer — a `min` that tracked the pane's
      // width would fight the user's own drag.
      //
      // `max` covers the 280px board (369 with the same chrome) plus headroom for tab,
      // which wraps into a taller stack the narrower the pane gets. Both views scroll
      // vertically past the cap rather than hiding the low strings or the last system.
      min: 285,
      max: 460,
      children: <ReferencePane view={referenceView} onViewChange={setReferenceView} />,
    },
    {
      id: 'amp',
      title: 'Instrument & Amp',
      canFill: true,
      children: <Placeholder label="Instrument & amp rack" />,
    },
    {
      id: 'timeline',
      title: 'Timeline',
      min: 150,
      max: 700,
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
