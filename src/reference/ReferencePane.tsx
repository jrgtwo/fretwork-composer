/**
 * The Reference pane: one pattern, two ways of reading it — the shape on the neck or
 * the notes in time — with a switch between them.
 *
 * Switched rather than stacked because both views want the pane's whole height: the
 * lib's board draws into a 1202×280 viewBox and a wrapped staff grows a system every
 * time the pane narrows, so showing both at once would crop both.
 *
 * The switch renders in the pane body rather than in the pane header's `actions` slot
 * because the header survives a collapse: a switch you can still press while the views
 * it switches between aren't drawn is a control that does nothing you can see.
 */
import { FretboardView } from './FretboardView';
import { TablatureView } from './TablatureView';

const VIEWS = [
  { id: 'fretboard', label: 'Fretboard' },
  { id: 'tab', label: 'Tab' },
] as const;

export type ReferenceViewId = (typeof VIEWS)[number]['id'];

/**
 * Controlled rather than self-owning, and the reason is the pane it lives in:
 * `PaneStack` unmounts a collapsed pane's body outright. That unmount is wanted — it's
 * what stops the tab view's `ResizeObserver` measuring a pane that's folded away — but
 * it also means state held here is forgotten every time the pane is collapsed, which
 * would quietly drop you back on the fretboard. So the choice lives above the stack,
 * in `App`, and this component only says which button was pressed.
 */
export function ReferencePane({
  view,
  onViewChange,
}: {
  view: ReferenceViewId;
  onViewChange: (view: ReferenceViewId) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div role="group" aria-label="Reference view" className="flex flex-none items-center gap-1">
        {VIEWS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={view === option.id}
            onClick={() => onViewChange(option.id)}
            className={`pressable rounded-lg px-2 py-0.5 font-mono text-[9px] font-bold tracking-[0.06em] uppercase ${
              view === option.id ? 'control-accent' : 'control'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {/* Unmounted rather than hidden: the tab view measures itself with a
          ResizeObserver, and a display:none staff measures 0 and re-wraps to one bar
          per system — so keeping the inactive view mounted would cost a re-wrap on
          every switch for nothing. */}
      {view === 'fretboard' ? <FretboardView /> : <TablatureView />}
    </div>
  );
}
