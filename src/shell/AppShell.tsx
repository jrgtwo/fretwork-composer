import type { ReactNode } from 'react';
import { ConnectorControl } from '../ai/ConnectorPanel';
import { PaneStack, type Pane, type PaneLayoutControl } from './PaneStack';

export type PageId = 'pattern' | 'composition';

const PAGES: readonly { id: PageId; label: string }[] = [
  { id: 'pattern', label: 'Pattern' },
  { id: 'composition', label: 'Composition' },
];

/**
 * A page either hands the shell a pane list — the pattern page's stack plus the
 * right rail — or takes the whole body and lays itself out. The two are mutually
 * exclusive: a page that owns its regions (the composition page's fixed grid)
 * has no use for a pane stack, and mixing them would put a scrolling stack
 * inside a page that must not scroll.
 *
 * `children` is handed a grid row of the viewport box and nothing else. The
 * shell wraps it in `min-h-0` so the no-scroll chain can't be broken by
 * forgetting it, but everything below that — including the right rail, which a
 * self-laying-out page may want above, beside or below its own chrome — is the
 * page's to place. Use the `.rail` class for it so both pages' rails match.
 */
type ShellBody =
  | { panes: Pane[]; paneLayout: PaneLayoutControl; rail?: ReactNode; children?: never }
  | { panes?: never; paneLayout?: never; rail?: never; children: ReactNode };

type AppShellProps = {
  documentName: string;
  documentMeta?: string;
  page: PageId;
  onPageChange: (page: PageId) => void;
} & ShellBody;

/**
 * The app frame. Full-bleed on purpose: the app *is* the page, so the header is
 * square and edge-to-edge and only interior elements are rounded and elevated.
 */
export function AppShell({
  documentName,
  documentMeta,
  page,
  onPageChange,
  panes,
  paneLayout,
  rail,
  children,
}: AppShellProps) {
  // `#root` has no height, so `h-full` resolves to auto: the pane stack is as
  // tall as its content and the document scrolls. That is the pane-layout debt
  // in docs/FOLLOW-UPS.md and the pattern page keeps living with it. A body that
  // lays itself out is here precisely to avoid it, so it gets a real viewport
  // box to fill instead.
  const height = panes ? 'h-full' : 'h-screen';

  return (
    <div className={`grid ${height} grid-rows-[48px_1fr]`}>
      <header className="z-20 flex items-center gap-3 border-b border-rim-dark bg-linear-to-b from-[#383b43] to-[#2e3138] px-3.5 shadow-[0_1px_0_rgb(255_255_255/0.05)_inset,0_3px_12px_rgb(0_0_0/0.3)]">
        <span className="font-display text-[17px] whitespace-nowrap text-ink-hi">
          Fretwork <em className="text-brass">Composer</em>
        </span>
        <nav className="ml-1 flex gap-[3px]" aria-label="Editor">
          {PAGES.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-current={p.id === page ? 'page' : undefined}
              onClick={() => onPageChange(p.id)}
              className={`rounded-[7px] px-3 py-[7px] font-mono text-[9.5px] font-bold tracking-[0.12em] uppercase ${
                p.id === page
                  ? 'control-accent pressable'
                  : 'border border-transparent text-ink-mut hover:text-ink'
              }`}
            >
              {p.label}
            </button>
          ))}
        </nav>
        <span className="mx-0.5 h-5 w-px bg-line" />
        <h1 className="font-display text-[15px] text-ink-hi">{documentName}</h1>
        {documentMeta && (
          <span className="font-mono text-[9.5px] font-semibold tracking-[0.12em] text-ink-mut uppercase">
            {documentMeta}
          </span>
        )}

        <span className="flex-1" />

        {/* App-level CONFIG, so it belongs to the frame both pages share rather
            than to either page's rail — see the note in `ai/ConnectorPanel`.
            Running an agent is not app-level and is not here: the command panel
            in the pattern page's rail is scoped to the page whose state it
            edits. */}
        <ConnectorControl />
      </header>

      {panes && paneLayout ? (
        <div className="grid min-h-0 grid-cols-[1fr_var(--width-rail)]">
          <PaneStack panes={panes} {...paneLayout} />
          <aside className="rail flex min-h-0 flex-col">{rail}</aside>
        </div>
      ) : (
        <div className="grid min-h-0">{children}</div>
      )}
    </div>
  );
}
