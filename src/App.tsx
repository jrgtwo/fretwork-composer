import { AppShell } from './shell/AppShell';
import type { Pane } from './shell/PaneStack';
import { ThemeReference } from './theme/ThemeReference';

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

// "Instrument & Amp" carries `canFill`: it's the pane allowed to absorb slack, so
// the other two stay capped and can never stretch into empty space.
const PANES: Pane[] = [
  {
    id: 'reference',
    title: 'Reference',
    min: 60,
    max: 220,
    children: <Placeholder label="Fretboard / Tablature" />,
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
    children: <Placeholder label="Beat grid + transport" />,
  },
];

export function App() {
  // The theme reference stays reachable while we build — it's the living record
  // of the design system.
  if (new URLSearchParams(window.location.search).has('theme')) {
    return <ThemeReference />;
  }

  return (
    <AppShell
      documentName="A major arpeggio"
      documentMeta="A · Major · 4/4"
      panes={PANES}
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
