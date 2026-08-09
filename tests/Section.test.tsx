import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_PATTERNS_STATE, usePatternsStore } from '@fretwork/lib';
import { useState } from 'react';
import { App } from '../src/App';
import { Section, type SectionParts } from '../src/shell/Section';

/**
 * The shared disclosure shell, and the pattern page's rail built out of it.
 *
 * WHAT IS ASSERTED HERE IS SEMANTICS, NOT LAYOUT. jsdom has no layout — every
 * box is 0x0 — so "a closed section takes no height" and "two open sections
 * share the column" are by-eye checks and no test here pretends otherwise. What
 * IS assertable is the wiring a screen reader and a keyboard depend on:
 * `aria-expanded`, an `aria-controls` that resolves to a real element, and a
 * body that is present but hidden rather than unmounted.
 *
 * The present-but-hidden pair is checked BOTH ways on purpose. The attribute
 * carries the semantics and a display utility class outranks it — that is the
 * whole reason `Section` drops `bodyClassName` while closed — so asserting only
 * `toBeInTheDocument` would pass on a section that never hides, and asserting
 * only `not.toBeVisible` would pass on one that unmounts.
 */

/** A section whose open state it owns, so a click can be observed end to end. */
function Standalone({
  label = 'Widgets',
  buttonLabel,
  bodyClassName,
  chassis,
  actions,
  grow,
  body = 'body content',
}: {
  label?: string;
  buttonLabel?: string;
  bodyClassName?: string;
  chassis?: (parts: SectionParts) => React.ReactNode;
  actions?: React.ReactNode;
  grow?: boolean;
  body?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Section
      label={label}
      buttonLabel={buttonLabel}
      open={open}
      onToggle={() => setOpen(!open)}
      note={<span data-testid="note">7</span>}
      actions={actions}
      bodyClassName={bodyClassName}
      grow={grow}
      chassis={chassis}
    >
      <p>{body}</p>
    </Section>
  );
}

const toggle = () => screen.getByRole('button', { name: 'Widgets' });
/** The region a given button names, not the one the test guesses. */
const controlledBy = (button: HTMLElement) =>
  document.getElementById(button.getAttribute('aria-controls') ?? '');
const controlled = () => controlledBy(toggle());

describe('Section disclosure', () => {
  it('wires aria-expanded and aria-controls to a region that exists', async () => {
    render(<Standalone />);

    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    // The id is derived, so this is the assertion that catches a typo'd or
    // duplicated derivation: whatever the button points at has to be real.
    expect(controlled()).not.toBeNull();
    expect(controlled()).toHaveTextContent('body content');

    await userEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps the body mounted but hidden when closed', async () => {
    render(<Standalone bodyClassName="flex flex-col gap-1.5" />);

    // Mounted — `aria-controls` has to point at an element that exists.
    expect(screen.getByText('body content')).toBeInTheDocument();
    expect(controlled()).not.toBeVisible();
    // A display utility beats the `hidden` attribute's UA rule, so a closed
    // region must not be carrying one. This is the class-order trap, asserted.
    expect(controlled()?.className).toBe('hidden');

    await userEvent.click(toggle());
    expect(controlled()).toBeVisible();
    expect(controlled()?.className).toContain('flex');
  });

  it('does not fold the section when an action is pressed', async () => {
    const act = vi.fn();
    render(
      <Standalone
        actions={
          <button type="button" onClick={act}>
            Remove
          </button>
        }
      />,
    );

    await userEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(act).toHaveBeenCalledOnce();
    // The action is a sibling of the disclosure, not a child of it. Nested, the
    // click would bubble to the toggle and fold the section it just changed.
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(toggle()).not.toContainElement(screen.getByRole('button', { name: 'Remove' }));
  });

  it('names its landmark apart from its button, and keeps note and actions out of it', () => {
    render(<Standalone actions={<button type="button">Remove</button>} />);

    // "Widgets section", not "Widgets": named identically, the landmark and the
    // disclosure nested inside it answer to the same one name — `RackFace`
    // rejects exactly that for its own region.
    const region = screen.getByRole('region', { name: 'Widgets section' });
    expect(screen.queryByRole('region', { name: 'Widgets' })).not.toBeInTheDocument();
    expect(within(region).getByTestId('note')).toBeInTheDocument();
    // The status must not be read as part of the button's name.
    expect(toggle()).toHaveAccessibleName('Widgets');
    expect(toggle()).not.toContainElement(screen.getByTestId('note'));
  });

  it('takes an accessible name for the button apart from the visible label', () => {
    // The composition page's stages need this: eight racks put eight buttons
    // labelled "Amp" on screen, and only the track tells them apart.
    render(<Standalone buttonLabel="Widgets stage for Lead" />);

    expect(screen.getByRole('button', { name: 'Widgets stage for Lead' })).toHaveTextContent(
      'Widgets',
    );
    expect(screen.queryByRole('button', { name: 'Widgets' })).not.toBeInTheDocument();
  });

  it('gives two sections in one container distinct regions, both openable at once', async () => {
    // FREE-FORM at the component level: a section does not fold its siblings.
    // Every other test here renders one, and one section can prove neither this
    // nor that two `aria-controls` resolve to two different elements.
    //
    // `App`'s rail-level policy is NOT covered and cannot be until AG-07 adds
    // the second section — with one id in `RailSectionId` an accordion and a
    // free-form toggle are the same function. That test belongs to that ticket.
    render(
      <>
        <Standalone label="Widgets" body="widget body" />
        <Standalone label="Gadgets" body="gadget body" />
      </>,
    );

    const widgets = screen.getByRole('button', { name: 'Widgets' });
    const gadgets = screen.getByRole('button', { name: 'Gadgets' });
    expect(controlledBy(widgets)).not.toBeNull();
    expect(controlledBy(gadgets)).not.toBeNull();
    expect(controlledBy(widgets)).not.toBe(controlledBy(gadgets));
    expect(controlledBy(widgets)).toHaveTextContent('widget body');
    expect(controlledBy(gadgets)).toHaveTextContent('gadget body');

    await userEvent.click(widgets);
    await userEvent.click(gadgets);
    // Free-form: opening the second does not fold the first.
    expect(widgets).toHaveAttribute('aria-expanded', 'true');
    expect(gadgets).toHaveAttribute('aria-expanded', 'true');
    expect(controlledBy(widgets)).toBeVisible();
    expect(controlledBy(gadgets)).toBeVisible();
  });

  it('flexes into the rail only when asked to', async () => {
    // jsdom has no layout, so this pins the CLASS and not the pixels — but the
    // class is the whole finding: the rail is a stretched grid item with a
    // definite height, so two sections both flexing would split it 50/50
    // whatever their content. Growth is opt-in for that reason.
    render(
      <>
        <Standalone label="Widgets" grow />
        <Standalone label="Gadgets" />
      </>,
    );

    const box = (name: string) => screen.getByRole('region', { name }).className;
    await userEvent.click(screen.getByRole('button', { name: 'Widgets' }));
    await userEvent.click(screen.getByRole('button', { name: 'Gadgets' }));

    expect(box('Widgets section')).toContain('flex-1');
    expect(box('Gadgets section')).toContain('flex-none');
    expect(box('Gadgets section')).not.toContain('flex-1');
  });

  it('lets a caller mount the disclosure on its own chassis', async () => {
    // The boundary this file exists to hold: `Section` builds the pieces and the
    // caller decides what they are bolted to. `VoiceSection` uses this to keep
    // `RackFace` — and its voice-only vocabulary — out of the shared component.
    render(
      <Standalone
        chassis={(parts) => (
          <div data-testid="custom-chassis">
            {parts.name}
            <span data-testid="chassis-open">{String(parts.open)}</span>
            {parts.actions}
            {parts.region}
          </div>
        )}
        actions={<span data-testid="custom-actions" />}
      />,
    );

    const chassis = screen.getByTestId('custom-chassis');
    expect(within(chassis).getByRole('button', { name: 'Widgets' })).toBeInTheDocument();
    expect(within(chassis).getByTestId('custom-actions')).toBeInTheDocument();
    expect(screen.getByTestId('chassis-open')).toHaveTextContent('false');
    // No landmark: the chassis drew none, and `Section` did not draw one behind
    // its back.
    expect(screen.queryByRole('region', { name: 'Widgets' })).not.toBeInTheDocument();

    await userEvent.click(toggle());
    expect(screen.getByTestId('chassis-open')).toHaveTextContent('true');
    expect(controlled()).toBeVisible();
  });
});

describe('the pattern page rail', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, '', '/');
    usePatternsStore.setState({
      ...DEFAULT_PATTERNS_STATE,
      library: { patterns: [], compositions: [], collections: [] },
    });
  });

  it('renders the library inside a section, open, with a live count', async () => {
    render(<App />);

    const rail = within(screen.getByRole('complementary'));
    const library = rail.getByRole('region', { name: 'Patterns section' });
    // The disclosure is the section's; the library body is inside the region it
    // controls, not beside it.
    expect(within(library).getByRole('button', { name: 'Patterns' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    // `App` seeds one demo pattern into an empty library on first render.
    expect(within(library).getAllByRole('button', { name: /^Open pattern / })).toHaveLength(1);
    expect(within(library).getByText('1')).toBeInTheDocument();

    // The count's whole justification is that it is a live leaf subscriber, and
    // a one-pattern library cannot tell a subscription from a constant.
    await userEvent.click(within(library).getByRole('button', { name: 'New pattern' }));
    expect(within(library).getAllByRole('button', { name: /^Open pattern / })).toHaveLength(2);
    expect(within(library).getByText('2')).toBeInTheDocument();
  });

  it('folds the library away and back', async () => {
    render(<App />);

    const rail = within(screen.getByRole('complementary'));
    const header = rail.getByRole('button', { name: 'Patterns' });

    await userEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    // Hidden, not gone — the same present-but-hidden contract as above, checked
    // through the real rail because that is where a stray `flex` would come from.
    const body = rail.getByRole('button', { name: 'New pattern', hidden: true });
    expect(body).toBeInTheDocument();
    expect(body).not.toBeVisible();

    await userEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(rail.getByRole('button', { name: 'New pattern' })).toBeVisible();
  });

  it('remembers a folded section across a visit to the composition page', async () => {
    // Why the open state is `App`'s and not `PatternRail`'s: the rail is
    // unmounted by every visit to the composition page, so state held below
    // would silently unfold itself on the way back.
    render(<App />);

    const railHeader = () =>
      within(screen.getByRole('complementary')).getByRole('button', { name: 'Patterns' });
    const nav = () => within(screen.getByRole('navigation', { name: 'Editor' }));

    await userEvent.click(railHeader());
    expect(railHeader()).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(nav().getByRole('button', { name: 'Composition' }));
    await userEvent.click(nav().getByRole('button', { name: 'Pattern' }));

    expect(railHeader()).toHaveAttribute('aria-expanded', 'false');
  });
});
