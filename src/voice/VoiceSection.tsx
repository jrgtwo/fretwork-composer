import type { ReactNode } from 'react';
import { RackFace } from './rack/RackFace';

/**
 * A collapsible stage of the voice chain — one unit of the rack.
 *
 * The chassis is `RackFace`; this owns the disclosure and the three-state vocabulary
 * that is particular to a voice stage. It used to draw its own `.well` with a brass dot
 * for "active"; that dot is now the unit's power lamp, which is the same fact in the
 * idiom the rest of the pane has moved to.
 *
 * Deliberately NOT `PaneStack`. These nest inside a pane that already drags, resizes
 * and enforces min/max; a second layer of all three would be four more things to
 * mis-drag and a height model fighting the pane's own. What a section needs is one
 * disclosure button and a region, which is all this is.
 *
 * The body stays mounted when closed (`hidden`) rather than being unmounted the way
 * `PaneStack` unmounts a pane's. Two reasons: `aria-controls` has to point at an element
 * that exists, and there is nothing expensive in here to unmount — no observers, no
 * measurement, ~30 inert form controls. That is exactly the opposite of the pane's
 * situation, which is why the two differ.
 *
 * THREE STATES, and they are not the same:
 *   `active`   — the branch is on the preset and in the chain.
 *   `bypassed` — the branch is on the preset with `enabled: false`. The tuning is kept.
 *   `absent`   — no branch at all. `ACOUSTIC_GUITAR_PRESET` ships with no `effects`
 *                object whatsoever, so this is reachable from a stock built-in and not
 *                merely a state the editor can create.
 */
export type SectionStatus = 'active' | 'bypassed' | 'absent';

const STATUS_NOTE: Record<SectionStatus, string | null> = {
  active: null,
  bypassed: 'Bypassed',
  absent: 'Not on this preset',
};

export function VoiceSection({
  id,
  label,
  status,
  open,
  onToggle,
  actions,
  children,
}: {
  id: string;
  label: string;
  status: SectionStatus;
  open: boolean;
  onToggle: () => void;
  /** Add / Remove — the branch controls. Outside the disclosure button so pressing
   *  one doesn't also fold the section it just changed. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const regionId = `${id}-region`;
  const note = STATUS_NOTE[status];

  return (
    <RackFace
      lit={status === 'active'}
      regionName={`${label} stage`}
      // Outside the disclosure button on purpose: inside, the status would be read as
      // part of its name ("Amp, not on this preset, collapsed"), and the lamp would be
      // the only thing distinguishing two identically-named buttons in a pane that has
      // thirty controls.
      note={note}
      actions={actions}
      name={
        <button
          type="button"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={onToggle}
          className="-mx-1 flex flex-none items-center gap-1.5 rounded-md px-1 py-0.5 text-left hover:text-brass-hi"
        >
          <span aria-hidden className="flex-none font-mono text-[9px] text-ink-mut">
            {open ? '▾' : '▸'}
          </span>
          <span className="font-mono text-[9px] font-semibold tracking-[0.16em] uppercase">
            {label}
          </span>
        </button>
      }
    >
      {/* `hidden` alone is not enough: the attribute's `display: none` comes from the UA
          stylesheet, so a `flex` utility class outranks it and the region would stay
          visible. The class carries the hiding; the attribute carries the semantics. */}
      <div
        id={regionId}
        hidden={!open}
        className={`flex-col gap-1.5 px-2 py-1.5 ${open ? 'flex' : 'hidden'}`}
      >
        {children}
      </div>
    </RackFace>
  );
}
