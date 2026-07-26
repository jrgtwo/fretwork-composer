import type { ReactNode } from 'react';
import { PaneStack, type Pane } from './PaneStack';

/**
 * The app frame. Full-bleed on purpose: the app *is* the page, so the header is
 * square and edge-to-edge and only interior elements are rounded and elevated.
 */
export function AppShell({
  documentName,
  documentMeta,
  panes,
  rail,
}: {
  documentName: string;
  documentMeta?: string;
  panes: Pane[];
  rail?: ReactNode;
}) {
  return (
    <div className="grid h-full grid-rows-[48px_1fr]">
      <header className="z-20 flex items-center gap-3 border-b border-rim-dark bg-linear-to-b from-[#383b43] to-[#2e3138] px-3.5 shadow-[0_1px_0_rgb(255_255_255/0.05)_inset,0_3px_12px_rgb(0_0_0/0.3)]">
        <span className="font-display text-[17px] whitespace-nowrap text-ink-hi">
          Fretwork <em className="text-brass">Composer</em>
        </span>
        <nav className="ml-1 flex gap-[3px]" aria-label="Editor">
          <button type="button" aria-current="page" className="control-accent pressable rounded-[7px] px-3 py-[7px] font-mono text-[9.5px] font-bold tracking-[0.12em] uppercase">
            Pattern
          </button>
          <button type="button" className="rounded-[7px] border border-transparent px-3 py-[7px] font-mono text-[9.5px] font-bold tracking-[0.12em] text-ink-mut uppercase hover:text-ink">
            Composition
          </button>
        </nav>
        <span className="mx-0.5 h-5 w-px bg-line" />
        <h1 className="font-display text-[15px] text-ink-hi">{documentName}</h1>
        {documentMeta && (
          <span className="font-mono text-[9.5px] font-semibold tracking-[0.12em] text-ink-mut uppercase">
            {documentMeta}
          </span>
        )}
      </header>

      <div className="grid min-h-0 grid-cols-[1fr_300px]">
        <PaneStack panes={panes} />
        <aside className="flex min-h-0 flex-col border-l border-rim-dark bg-linear-to-b from-[#2b2e35] to-[#25282e]">
          {rail}
        </aside>
      </div>
    </div>
  );
}
