import type { ReactNode } from 'react';
import { Section } from '../shell/Section';
import { RackFace } from './rack/RackFace';

/**
 * A collapsible stage of the voice chain — one unit of the rack.
 *
 * The disclosure is `shell/Section`, which was generalised OUT of this file:
 * the button, the `aria-expanded` / `aria-controls` wiring, the region and the
 * rule that a hidden body stays mounted are all there now, along with the
 * reasons for each. What is left here is what is particular to a voice stage,
 * and the split is deliberate — a shared section that knew what a bypassed
 * effects branch was would not be shared, it would be relocated.
 *
 * ONE OF THESE PER STAGE, EVERYWHERE. The composition page used to bolt its own
 * `Section` + `RackFace` together inline, because this file hard-coded the
 * landmark as `${label} stage` and carried the pane's status vocabulary. Both
 * are now the caller's, as `buttonLabel` and `regionName`, and there is one
 * stage chassis for both pages — see `VoiceEditor`, its only caller.
 *
 * So this file keeps exactly two things:
 *
 * THE CHASSIS. `RackFace` — a thin raised faceplate with the unit's name
 * engraved at the left and a power lamp at the right. `Section` builds the
 * pieces and hands them back; where they are bolted is this component's call.
 * The lamp is `lit` when the stage is really in the chain, which is a fact
 * about a voice and about nothing else in the app.
 *
 * THREE STATES, and they are not the same:
 *   `active`   — the branch is on the preset and in the chain.
 *   `bypassed` — the branch is on the preset with `enabled: false`. The tuning is kept.
 *   `absent`   — no branch at all. `ACOUSTIC_GUITAR_PRESET` ships with no `effects`
 *                object whatsoever, so this is reachable from a stock built-in and not
 *                merely a state the editor can create.
 *
 * ⚠ ONLY `bypassed` IS WORDED. An absent stage used to say "Not on this preset"
 * here and say nothing on the composition page; the rack's silence-plus-dark-lamp
 * won, because the body of an absent stage already says so in a sentence and its
 * Add button is the affordance. The note goes to `RackFace`'s own slot rather than
 * through `Section`'s, because `RackFace` places a note to the LEFT of the
 * faceplate where the rail's chassis right-aligns it. Both are outside the
 * disclosure button, which is the part `Section` guarantees and the part that
 * matters.
 */
export type SectionStatus = 'active' | 'bypassed' | 'absent';

export function VoiceSection({
  label,
  buttonLabel,
  regionName,
  status,
  open,
  onToggle,
  actions,
  children,
}: {
  label: string;
  /** Accessible name for the disclosure button. Up to eight racks are on screen
   *  at once and each has an "Amp" stage, so the name has to carry the track
   *  where there is one; with a single holder the visible label is enough. */
  buttonLabel?: string;
  /** The landmark's name — what tells eight racks' identically named controls
   *  apart, for a screen reader and for the tests that scope by it. */
  regionName: string;
  status: SectionStatus;
  open: boolean;
  onToggle: () => void;
  /** Add / Remove — the branch controls. `Section` keeps them outside the
   *  disclosure button so pressing one doesn't also fold the section it just
   *  changed. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Section
      label={label}
      buttonLabel={buttonLabel}
      open={open}
      onToggle={onToggle}
      actions={actions}
      bodyClassName="flex flex-col gap-1 px-1.5 py-1"
      chassis={(parts) => (
        <RackFace
          lit={status === 'active'}
          regionName={regionName}
          // The chassis owns the material, and its engraved names are muted.
          name={<span className="text-ink-mut">{parts.name}</span>}
          // Outside the disclosure button on purpose: inside, the status would be read as
          // part of its name ("Amp, bypassed, collapsed"), and the lamp would be
          // the only thing distinguishing two identically-named buttons in a pane that has
          // thirty controls.
          note={status === 'bypassed' ? 'Bypassed' : null}
          actions={parts.actions}
        >
          {parts.region}
        </RackFace>
      )}
    >
      {children}
    </Section>
  );
}
