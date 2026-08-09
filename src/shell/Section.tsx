import { useId, type ReactNode } from 'react';

/**
 * A collapsible section: ONE disclosure button and ONE region, mounted on
 * whatever chassis the caller hands it.
 *
 * Generalised out of `voice/VoiceSection`, which stated the rule this keeps:
 *
 *   Deliberately NOT a `PaneStack` pane. A pane already drags, resizes and
 *   enforces min/max; a second layer of all three is four more things to
 *   mis-drag plus a height model fighting the pane's own. What a section needs
 *   is a button and a region, which is all this is.
 *
 * THE BODY STAYS MOUNTED WHEN CLOSED (`hidden`), where `PaneStack` unmounts a
 * folded pane's outright. Two reasons, both still true here: `aria-controls`
 * has to point at an element that EXISTS, and there is nothing expensive inside
 * a section — no observers, no measurement. That is the exact opposite of the
 * pane's situation, which is why the two differ.
 *
 * ── What is shared and what is not ───────────────────────────────────────────
 *
 * Shared: the button, the `aria-expanded` / `aria-controls` wiring, the region,
 * and the rule that `note` and `actions` sit OUTSIDE the button.
 *
 * Not shared: the MATERIAL. `VoiceSection` mounts this on `RackFace` — an
 * engraved faceplate with a power lamp — and keeps its three-state
 * `active`/`bypassed`/`absent` vocabulary to itself. A shared component that
 * knew what a bypassed effects branch was would not be shared, it would be
 * relocated. Hence {@link SectionParts}: this builds the pieces, the caller's
 * `chassis` decides what they are bolted to. Callers with nothing particular to
 * say get {@link railChassis}, which is what the pattern page's rail uses.
 *
 * ── `note` and `actions` are outside the button on purpose ───────────────────
 *
 * `actions` first, and it is a correctness point rather than a layout one:
 * pressing an action must not also fold the section it just changed. Nesting a
 * button in a button is invalid anyway, so there is no version of this that
 * "just works" — the chassis has to place them as siblings.
 *
 * `note` for a different reason, inherited from `RackFace`: inside the button a
 * status would be read as part of its NAME ("Amp, not on this preset,
 * collapsed"), and in a rail of sections the name is the only thing telling two
 * disclosures apart.
 *
 * ── FREE-FORM, NOT ACCORDION ─────────────────────────────────────────────────
 *
 * Nothing here holds state, so the policy is the caller's; the pattern page's
 * rail chose FREE-FORM — any number of sections open at once — and the reasoning
 * is recorded on `PatternRail` in `App.tsx`. What makes it affordable is
 * {@link SectionParts.grow}, below, and an earlier draft of this note got that
 * backwards: it claimed the rail had no height to ration because `#root` has
 * none. It does have one. `AppShell` puts the rail in a stretched grid item, so
 * the aside is as tall as the taller COLUMN — the pane stack, in every normal
 * case. Two sections both flexing into that would split it in half regardless of
 * content, which is exactly the rationing an accordion exists to do, arrived at
 * by accident. So growth is opt-in: a section that does not ask for it is as
 * tall as its content, and the one that does absorbs the difference.
 */
export interface SectionParts {
  /** The label the caller gave, for whatever landmark the chassis draws. */
  label: string;
  /** The disclosure button. The ONLY thing in here that folds the section. */
  name: ReactNode;
  /** The caller's `note`, to be placed beside the name and outside the button. */
  note: ReactNode;
  /** The caller's `actions`, likewise outside the button. */
  actions: ReactNode;
  /** The body's region. In the DOM whether the section is open or closed. */
  region: ReactNode;
  /** Open state, for chassis LAYOUT only — a closed section should not claim
   *  height it will not use. The disclosure semantics are already wired. */
  open: boolean;
  /** The caller's `grow`, for chassis LAYOUT only: may this section flex into
   *  the rail's spare height, or is it as tall as its content? */
  grow: boolean;
}

export function Section({
  label,
  buttonLabel,
  open,
  onToggle,
  note,
  actions,
  bodyClassName,
  grow = false,
  chassis = railChassis,
  children,
}: {
  label: string;
  /** Accessible name for the disclosure, when the visible label is not enough to
   *  tell it from another one on the same page — the composition page has a
   *  "Amp" stage per track and up to eight racks on screen. Defaults to `label`. */
  buttonLabel?: string;
  open: boolean;
  onToggle: () => void;
  /** A small status line beside the name — a count, "Bypassed". Not a control. */
  note?: ReactNode;
  /** Controls beside the name. Outside the disclosure button so pressing one
   *  doesn't also fold the section it just changed. */
  actions?: ReactNode;
  /** Classes for the region WHEN OPEN. Ignored when closed — see below. */
  bodyClassName?: string;
  /** May this section flex into the rail's spare height? Opt-in on purpose: two
   *  growing sections split the rail 50/50 whatever their content, which is an
   *  accordion's rationing without an accordion's decision. */
  grow?: boolean;
  chassis?: (parts: SectionParts) => ReactNode;
  children: ReactNode;
}) {
  // Generated, not taken from the caller. The region's id is the ONLY thing a
  // caller-supplied one was for, nothing outside reads it, and a rail of
  // sections is exactly where a copy-pasted id would collide silently: both
  // buttons' `aria-controls` would resolve to the first region and every test
  // would still pass.
  const regionId = `${useId()}-region`;

  return chassis({
    label,
    open,
    grow,
    note,
    actions,
    name: (
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        aria-label={buttonLabel}
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
    ),
    region: (
      // A CLOSED REGION IS GIVEN NOTHING BUT `hidden`, and dropping the caller's
      // classes is the point rather than an economy. The `hidden` attribute's
      // `display: none` comes from the UA stylesheet, so any display utility in
      // `bodyClassName` — `flex`, `grid` — outranks it and the region stays
      // visible. Emitting the caller's classes only while open means the two can
      // never be in the list together, which does not depend on which of them
      // Tailwind happened to emit last.
      <div id={regionId} hidden={!open} className={open ? bodyClassName : 'hidden'}>
        {children}
      </div>
    ),
  });
}

/**
 * The default chassis: a flush section of a rail, separated from the next by a
 * scored rim rather than by being a box of its own.
 *
 * No `.tray`, no `.panel`. The rail is 300px wide and a stack of nested boxes
 * spends most of that on borders and gutters; the rail is already a distinct
 * surface (`.rail` in `styles/index.css`), so its sections are divisions OF it.
 *
 * The landmark is named after the section, which is what makes a rail of them
 * navigable — an unnamed `<section>` is exposed as a plain generic. "Patterns
 * SECTION" and not "Patterns", for `RackFace`'s reason: named identically, the
 * region and the disclosure button nested inside it answer to the same one name,
 * and a rail of two such pairs is four things called two things.
 */
function railChassis({ label, name, note, actions, region, open, grow }: SectionParts) {
  return (
    <section
      aria-label={`${label} section`}
      // Only an OPEN section that asked to grow competes for the rail's height.
      // A folded one is its header and nothing else, with no orphan strip of
      // body under it; an open one that did not ask is as tall as its content.
      className={`flex flex-col border-b border-rim-dark ${
        open && grow ? 'min-h-0 flex-1' : 'flex-none'
      }`}
    >
      {/* The rule under the header is the OPEN section's, not the header's: a
          folded section already has the section's own bottom border an instant
          below this one, and two adjacent 1px rules read as a single fat line
          rather than as a heading. */}
      <div
        className={`flex flex-none items-center gap-2 px-2.5 py-2 ${
          open ? 'border-b border-rim-dark' : ''
        }`}
      >
        {name}
        <span className="flex-1" />
        {note ? (
          <span className="flex-none font-mono text-[9px] text-ink-mut/70">{note}</span>
        ) : null}
        {actions}
      </div>
      {region}
    </section>
  );
}
