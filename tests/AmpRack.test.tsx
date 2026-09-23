import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CABINET_IRS,
  CIRCUIT_AMPS,
  DEFAULT_CIRCUIT_AMP_ID,
  getCabinetIR,
  getCircuitAmp,
  getDefaultPresetForSlot,
  useFretworkStore,
  useVoiceStore,
} from '@fretwork/lib';
import { AmpHead } from '../src/voice/rack/AmpHead';
import { CabinetGraphic } from '../src/voice/rack/CabinetGraphic';
import { VoicePane } from '../src/voice/VoicePane';
import { PARAM_SECTIONS, paramApplies, type SectionId } from '../src/voice/paramSchema';
import { voicePreset } from '../src/voice/voiceDrafts';
import { getEditingPattern } from '../src/patterns/patternService';
import { PLACED_CABINET_IRS } from '../src/voice/micPositions';
import { openBlankPattern } from '../src/patterns/patternService';
import { clearVoiceDrafts } from '../src/voice/voiceDrafts';
import { selectVoice } from '../src/voice/voiceService';

/**
 * The graphic rack — `AmpHead`, `CabinetGraphic` and the pane wiring that renders the
 * amp and cabinet stages as gear instead of as slider rows.
 *
 * WHAT JSDOM CANNOT ANSWER, so nobody writes it:
 *
 *   - **Nothing about how any of this looks.** No CSS, no layout. That the plate stands
 *     proud of the shell, that the cones read as sunken, that the grille reads as scored
 *     rather than printed — all by eye. What is assertable is the structure and the
 *     accessibility, which is exactly where a slider→knob swap silently regresses.
 *   - **Every rect is 0×0.** `CabinetGraphic` refuses to place a mic against a
 *     zero-sized baffle rather than hand `nearestIrAt` a `NaN`, so the pointer path here
 *     only exists because the test stubs the rect. The stub is the environment, not the
 *     assertion — the maths under it is `micPositions`' own, and tested there.
 *   - **No Web Audio.** Nothing here is audible; the draft notification finds no engine.
 */

/** A baffle with a size, since jsdom gives every element none. 200×200 at the origin,
 *  so a client coordinate is just the normalized one ×200. */
const BAFFLE = 200;
function sizeBaffle(): HTMLElement {
  const baffle = screen.getByRole('radiogroup').parentElement!;
  baffle.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: BAFFLE,
      bottom: BAFFLE,
      width: BAFFLE,
      height: BAFFLE,
      toJSON: () => ({}),
    }) as DOMRect;
  return baffle;
}

/**
 * jsdom ships no `PointerEvent`, so `fireEvent.pointerDown` degrades to a bare `Event`
 * and drops `pointerId` and the coordinates. A `MouseEvent` carries them, and React reads
 * `pointerId` straight off the native event — the same shim `Knob.test.tsx` uses.
 */
function pointerEvent(
  type: string,
  init: { pointerId?: number; clientX?: number; clientY?: number; button?: number } = {},
) {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    button: init.button ?? 0,
  });
  Object.defineProperty(ev, 'pointerId', { value: init.pointerId ?? 1 });
  return ev;
}

/** The client point of a placed IR's mic, on the stubbed baffle. */
function pointOf(id: string) {
  const placed = PLACED_CABINET_IRS.find((p) => p.ir.id === id);
  if (!placed) throw new Error(`no placement for ${id}`);
  return { clientX: placed.position.x * BAFFLE, clientY: placed.position.y * BAFFLE };
}

const irUrl = (id: string) => getCabinetIR(id)!.url;

/**
 * THE AMP IS THE CIRCUIT AMP. The five-model classic stage came out of the app on
 * 2026-09-23 and the amp-head face moved onto the one that survived, so this file
 * follows the face rather than the models — what it is about (the plate, the lamp,
 * the switch, the knob row, bypass-is-not-dimmed) is the same thing it always was.
 */
const AMP_SECTION = PARAM_SECTIONS.find((s) => s.id === 'circuit-amp')!;
const AMP_STAGE_LABEL = AMP_SECTION.label;
const DEFAULT_AMP = getCircuitAmp(DEFAULT_CIRCUIT_AMP_ID);
const CABINET_SECTION = PARAM_SECTIONS.find((s) => s.id === 'cabinet')!;

/**
 * The amp section's rows that apply to the preset actually on screen.
 *
 * Needed here and not for the Cabinet because a circuit amp's knobs are the AMP'S,
 * not the section's: every control row is gated with `appliesWhen` on the amps that
 * declare it, so walking `section.params` blind would look for a Deluxe's Bright
 * switch on a Princeton and fail on a control that is correctly not there.
 */
const openPreset = () => voicePreset('pattern', getEditingPattern()!.id)!;
const applicableParams = (section: typeof AMP_SECTION) =>
  section.params.filter((param) => paramApplies(openPreset(), param));

/** A stage's own landmark, so a query says which stage it means. */
const stage = (section: typeof AMP_SECTION) =>
  within(screen.getByRole('region', { name: `${section.label} stage` }));

/**
 * What a knob on the AMP'S PLATE answers to.
 *
 * ⚠ The amp is the one section whose knobs are scoped by the stage. Its own
 * "Input gain" and "Volume" are word-for-word the IN/OUT bar's two, and the bar
 * sits outside every section — so on the pattern page, where there is a single
 * holder and nothing else to scope by, both pairs would answer to one name.
 * `renderAmp` puts the stage in the name; the cabinet's knobs collide with
 * nothing and carry none.
 */
const plateName = (label: string) => `${AMP_STAGE_LABEL} ${label}`;

describe('AmpHead', () => {
  it('engraves the model and puts every knob it is handed on the plate', () => {
    render(
      <AmpHead model="Princeton 5F2-A" enabled power={{ label: 'Amp Enabled', onChange: vi.fn() }}>
        <button type="button">Bass</button>
        <button type="button">Treble</button>
      </AmpHead>,
    );

    expect(screen.getByText('Princeton 5F2-A')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bass' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Treble' })).toBeInTheDocument();
  });

  it('carries bypass on a named switch, not on the lamp alone', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <AmpHead model="5F2-A" enabled power={{ label: 'Amp Enabled', onChange }} />,
    );

    const power = screen.getByRole('switch', { name: 'Amp Enabled' });
    expect(power).toHaveAttribute('aria-checked', 'true');
    // The lamp is a luminance cue and cannot be the only one.
    expect(power).toHaveTextContent('On');

    await userEvent.click(power);
    expect(onChange).toHaveBeenCalledWith(false);

    rerender(<AmpHead model="5F2-A" enabled={false} power={{ label: 'Amp Enabled', onChange }} />);
    // The name is the same in both states: the word is the value, `aria-checked` carries
    // it, and a name that moves with the value is not a name.
    const off = screen.getByRole('switch', { name: 'Amp Enabled' });
    expect(off).toHaveAttribute('aria-checked', 'false');
    expect(off).toHaveTextContent('Off');
  });

  it('drops the switch for a stage with no bypass, the way a rack unit does', () => {
    render(<AmpHead model="5F2-A" enabled />);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});

/** A `CabinetGraphic` whose `url` actually follows what it reports, so a test can watch
 *  the selection and the roving tab stop move rather than only the callback fire. */
function CabHost({ initial, onChange }: { initial: string; onChange?: (url: string) => void }) {
  const [url, setUrl] = useState(initial);
  return (
    <CabinetGraphic
      url={url}
      onChange={(next) => {
        onChange?.(next);
        setUrl(next);
      }}
    />
  );
}

describe('CabinetGraphic', () => {
  it('offers one named dot per placed capture, and checks the loaded one', () => {
    render(<CabinetGraphic url={irUrl('gods-warm-421')} onChange={vi.fn()} />);

    const group = screen.getByRole('radiogroup', { name: 'Cabinet mic position' });
    const dots = within(group).getAllByRole('radio');
    expect(dots).toHaveLength(PLACED_CABINET_IRS.length);
    // Named for the capture, not for a coordinate — the label is what a screen reader
    // has to pick a cabinet from.
    for (const { ir } of PLACED_CABINET_IRS) {
      expect(within(group).getByRole('radio', { name: ir.label })).toBeInTheDocument();
    }

    const active = within(group).getByRole('radio', { name: getCabinetIR('gods-warm-421')!.label });
    expect(active).toHaveAttribute('aria-checked', 'true');
    expect(active).toHaveAttribute('tabindex', '0');
    expect(dots.filter((dot) => dot.getAttribute('aria-checked') === 'true')).toHaveLength(1);
  });

  it('checks nothing at all for a URL the registry does not know', () => {
    // `paramSchema`'s cab enum resolves an unregistered URL to `null` rather than to the
    // first cab, and the graphic has to keep that promise: a dot sitting on a capture
    // that is not loaded is the same lie, drawn.
    render(<CabinetGraphic url={null} onChange={vi.fn()} />);

    const dots = screen.getAllByRole('radio');
    expect(dots.every((dot) => dot.getAttribute('aria-checked') === 'false')).toBe(true);
    // One way in, still — otherwise the group is unreachable by keyboard in exactly the
    // state where the user most needs to pick something.
    expect(dots.filter((dot) => dot.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  it('draws each dot where its placement says, since the drag maths measures the same points', () => {
    render(<CabinetGraphic url={irUrl('twin-clean')} onChange={vi.fn()} />);

    // The drag path derives its client coordinates from `PLACED_CABINET_IRS` directly, so
    // without this the graphic could disagree with its own hit-testing — dots drawn in
    // the wrong place, dragging still "correct" — and every other test would stay green.
    for (const { ir, position } of PLACED_CABINET_IRS) {
      const dot = screen.getByRole('radio', { name: ir.label });
      expect(dot.style.left).toBe(`${position.x * 100}%`);
      expect(dot.style.top).toBe(`${position.y * 100}%`);
    }
  });

  it('gives the one off-baffle capture a depth cue the on-cone ones do not get', () => {
    render(<CabinetGraphic url={irUrl('twin-clean')} onChange={vi.fn()} />);

    // `PlacedCabinetIR.distant` asks the graphic for this: a capture made in front of the
    // cab encodes its distance as radius like every other, so drawn plainly it reads as
    // one more on-cone mic.
    for (const { ir, distant } of PLACED_CABINET_IRS) {
      const dot = screen.getByRole('radio', { name: ir.label });
      expect(dot.className.includes('ring-2')).toBe(distant);
    }
  });

  it('tracks a drag on the dot but commits once, at the end', () => {
    const onChange = vi.fn();
    render(<CabinetGraphic url={irUrl('twin-clean')} onChange={onChange} />);
    const baffle = sizeBaffle();
    const checked = () =>
      screen.getAllByRole('radio').find((dot) => dot.getAttribute('aria-checked') === 'true');

    // Press on one capture's spot. The dot moves…
    fireEvent(baffle, pointerEvent('pointerdown', pointOf('catharsis-bright')));
    expect(checked()).toBe(
      screen.getByRole('radio', { name: getCabinetIR('catharsis-bright')!.label }),
    );
    // …but nothing is committed yet: every cab URL change tears down and rebuilds the
    // whole Tone effects chain and refetches an IR, so a drag that emitted per crossing
    // would be four to six rebuilds with the cab silent through each.
    expect(onChange).not.toHaveBeenCalled();

    // Drag across the baffle to another. `gods-room-87` is the furthest out of all nine,
    // so nothing else is nearer to its spot.
    fireEvent(window, pointerEvent('pointermove', pointOf('gods-room-87')));
    const room = pointOf('gods-room-87');
    fireEvent(window, pointerEvent('pointermove', { ...room, clientX: room.clientX + 1 }));
    expect(checked()).toBe(screen.getByRole('radio', { name: getCabinetIR('gods-room-87')!.label }));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent(window, pointerEvent('pointerup', room));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(irUrl('gods-room-87'));

    // The gesture is over, so a stray move is nobody's.
    fireEvent(window, pointerEvent('pointermove', pointOf('twin-clean')));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('commits nothing when a drag ends back where it started', () => {
    const onChange = vi.fn();
    render(<CabHost initial={irUrl('twin-clean')} onChange={onChange} />);
    const baffle = sizeBaffle();

    fireEvent(baffle, pointerEvent('pointerdown', pointOf('twin-clean')));
    fireEvent(window, pointerEvent('pointermove', pointOf('gods-room-87')));
    fireEvent(window, pointerEvent('pointermove', pointOf('twin-clean')));
    fireEvent(window, pointerEvent('pointerup', pointOf('twin-clean')));

    // The value never moved, so there is no edit — and crucially the dot is back where
    // the gesture began rather than stranded on the last territory it crossed.
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: getCabinetIR('twin-clean')!.label })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('drops the gesture on pointercancel — a touch taken away is not a choice', () => {
    const onChange = vi.fn();
    render(<CabinetGraphic url={irUrl('twin-clean')} onChange={onChange} />);
    const baffle = sizeBaffle();

    fireEvent(baffle, pointerEvent('pointerdown', pointOf('catharsis-bright')));
    fireEvent(window, pointerEvent('pointercancel', pointOf('catharsis-bright')));
    expect(onChange).not.toHaveBeenCalled();
    // …and the listeners went with it.
    fireEvent(window, pointerEvent('pointermove', pointOf('gods-room-87')));
    fireEvent(window, pointerEvent('pointerup', pointOf('gods-room-87')));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: getCabinetIR('twin-clean')!.label })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('does not keep steering after it is unmounted mid-drag', () => {
    const onChange = vi.fn();
    const { unmount } = render(<CabinetGraphic url={irUrl('twin-clean')} onChange={onChange} />);
    const baffle = sizeBaffle();

    fireEvent(baffle, pointerEvent('pointerdown', pointOf('catharsis-bright')));
    unmount();
    fireEvent(window, pointerEvent('pointermove', pointOf('gods-room-87')));
    fireEvent(window, pointerEvent('pointerup', pointOf('gods-room-87')));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('leaves a press that lands on a dot to that dot', async () => {
    // Near a dot's edge the nearest capture can be a different one, so a baffle that
    // answered too would commit that one on pointerup and then the pressed one on click.
    const onChange = vi.fn();
    render(<CabinetGraphic url={irUrl('twin-clean')} onChange={onChange} />);
    sizeBaffle();

    const mellow = getCabinetIR('catharsis-mellow')!;
    await userEvent.click(screen.getByRole('radio', { name: mellow.label }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(mellow.url);
  });

  it('ignores a second pointer mid-drag', () => {
    const onChange = vi.fn();
    render(<CabinetGraphic url={irUrl('twin-clean')} onChange={onChange} />);
    const baffle = sizeBaffle();

    fireEvent(baffle, pointerEvent('pointerdown', { ...pointOf('catharsis-bright'), pointerId: 1 }));
    // A second finger anywhere on the page must not steer this dot, and must not end the
    // gesture either.
    fireEvent(window, pointerEvent('pointermove', { ...pointOf('gods-room-87'), pointerId: 2 }));
    fireEvent(window, pointerEvent('pointerup', { ...pointOf('gods-room-87'), pointerId: 2 }));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent(window, pointerEvent('pointerup', { ...pointOf('catharsis-bright'), pointerId: 1 }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(irUrl('catharsis-bright'));
  });

  it('is fully operable from the keyboard — the dot is not a pointer-only control', () => {
    const onChange = vi.fn();
    render(<CabHost initial={irUrl('twin-clean')} onChange={onChange} />);

    const first = PLACED_CABINET_IRS[0];
    const second = PLACED_CABINET_IRS[1];
    const third = PLACED_CABINET_IRS[2];
    const last = PLACED_CABINET_IRS[PLACED_CABINET_IRS.length - 1];
    expect(first.ir.id).toBe('twin-clean'); // the checked dot, and the group's tab stop

    const dotFor = (label: string) => screen.getByRole('radio', { name: label });
    dotFor(first.ir.label).focus();

    fireEvent.keyDown(dotFor(first.ir.label), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(second.ir.url);
    // Focus follows the selection, the way it does in any radio group — and so does the
    // single tab stop, or a second Tab into the pane would land on the old dot.
    expect(document.activeElement).toBe(dotFor(second.ir.label));
    expect(dotFor(second.ir.label)).toHaveAttribute('tabindex', '0');
    expect(dotFor(first.ir.label)).toHaveAttribute('tabindex', '-1');

    // Every key is fired from wherever the last one left focus, so the non-wrapping
    // branches are exercised too and not only the wrap.
    fireEvent.keyDown(dotFor(second.ir.label), { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith(third.ir.url);
    fireEvent.keyDown(dotFor(third.ir.label), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(second.ir.url);

    // Wraps, so the whole registry is reachable from wherever the user starts.
    fireEvent.keyDown(dotFor(second.ir.label), { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith(first.ir.url);
    fireEvent.keyDown(dotFor(first.ir.label), { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith(last.ir.url);
    fireEvent.keyDown(dotFor(last.ir.label), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(first.ir.url);
    fireEvent.keyDown(dotFor(first.ir.label), { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith(last.ir.url);
  });

  it('a click on a dot picks that capture, with no drag involved', async () => {
    const onChange = vi.fn();
    render(<CabinetGraphic url={irUrl('twin-clean')} onChange={onChange} />);
    // Deliberately NOT sized: a click is not a placement, so it must not depend on the
    // baffle having a rect. (It is also how a screen reader activates the radio.)
    const mellow = getCabinetIR('catharsis-mellow')!;
    await userEvent.click(screen.getByRole('radio', { name: mellow.label }));
    expect(onChange).toHaveBeenLastCalledWith(irUrl('catharsis-mellow'));
  });

  it('says on the cab itself when the cab is out of the chain', () => {
    const { rerender } = render(<CabinetGraphic url={irUrl('twin-clean')} onChange={vi.fn()} />);
    expect(screen.getByText('In chain')).toBeInTheDocument();
    expect(screen.queryByText('Bypassed')).not.toBeInTheDocument();

    rerender(<CabinetGraphic url={irUrl('twin-clean')} onChange={vi.fn()} bypassed />);
    // A word, not just an unlit lamp: lit-versus-dark is a luminance cue, and a bypassed
    // cabinet that draws identically to a live one states nothing at all.
    expect(screen.getByText('Bypassed')).toBeInTheDocument();
    // Bypassed keeps the tuning editable — that is the whole difference between bypassing
    // a stage and removing it.
    expect(screen.getAllByRole('radio')[0]).toBeEnabled();
  });
});

/** Which sections are unfolded lives in `App` in the real app; a host stands in for
 *  it. The unsaved edit does NOT — it is in `voice/voiceDrafts`, keyed by pattern. */
function Host() {
  // `undefined` rather than a list: nobody has folded anything yet, which is the
  // state `App` starts in and is NOT the same as an empty list (every stage open,
  // and the user said so). The pane opens on the schema's default either way.
  const [collapsed, setCollapsed] = useState<readonly SectionId[] | undefined>(undefined);
  return <VoicePane collapsedSections={collapsed} onCollapsedSectionsChange={setCollapsed} />;
}

describe('the rack, wired into the pane', () => {
  beforeEach(() => {
    // A module that outlives every unmount also outlives every test in this file.
    clearVoiceDrafts();
    useFretworkStore.getState().setInstrumentId('guitar');
    useVoiceStore.getState().reset();
    openBlankPattern('Amp rack test');
  });

  it('renders one accessible control per declared param, whatever the renderer', async () => {
    render(<Host />);
    // The stock acoustic guitar has no `effects` at all, so both stages start absent.
    await userEvent.click(screen.getByRole('button', { name: `Add ${AMP_STAGE_LABEL}` }));
    await userEvent.click(screen.getByRole('button', { name: 'Add Cabinet' }));
    // The room is the cabinet section's SUB-BRANCH, added by its own gesture:
    // `addVoiceSection` skips every row under a section's sub-branch outright, so
    // Add Cabinet alone can never create one however the preset looks. Without
    // this click the loop below would walk three rows that are legitimately
    // absent.
    await userEvent.click(screen.getByRole('button', { name: 'Add Room' }));

    for (const section of [AMP_SECTION, CABINET_SECTION]) {
      for (const param of applicableParams(section)) {
        // A sub-branch's rows are named for the BRANCH, not the section:
        // `renderParam`'s `nameScope`, which is what keeps "Size" and "Mix" from
        // being ambiguous against a second stage that has them. The section's own
        // rows carry no scope on the pattern page, where there is one holder.
        const sub = section.subBranch;
        const inSub = sub ? param.path.startsWith(`${sub.branch}.`) : false;
        const scoped = (label: string) =>
          inSub ? `${sub!.label} ${label}` : `${section.label} ${label}`;
        // The amp's plate scopes its knobs by the stage; the cabinet's do not.
        // See `plateName`.
        const knobName = (label: string) =>
          inSub || section.id === 'circuit-amp' ? scoped(label) : label;
        switch (param.kind) {
          case 'slider':
            // A knob, not a range row — but still one `role="slider"` with the
            // descriptor's label as its name.
            expect(
              stage(section).getByRole('slider', { name: knobName(param.label) }),
            ).toBeInTheDocument();
            break;
          case 'toggle':
            expect(
              stage(section).getByRole('switch', { name: scoped(param.label) }),
            ).toBeInTheDocument();
            break;
          case 'enum':
            expect(
              stage(section).getByLabelText(inSub ? scoped(param.label) : param.label),
            ).toBeInTheDocument();
            break;
          case 'sample-pack':
            throw new Error('unexpected sample-pack param in an amp/cabinet section');
        }
      }
    }
  });

  it('keeps the knobs reading their range from the descriptor', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: `Add ${AMP_STAGE_LABEL}` }));

    for (const param of applicableParams(AMP_SECTION)) {
      if (param.kind !== 'slider') continue;
      const knob = stage(AMP_SECTION).getByRole('slider', { name: plateName(param.label) });
      expect(knob).toHaveAttribute('aria-valuemin', String(param.min));
      expect(knob).toHaveAttribute('aria-valuemax', String(param.max));
    }

    // ⚠ AN INDEPENDENT ANCHOR, because everything above walks `paramApplies` —
    // the same predicate the renderer filters on — so on its own it only says the
    // renderer agrees with itself. The Princeton's two pots by NAME, and a control
    // no amp but the Deluxe declares, from the registry rather than from the gate.
    for (const control of DEFAULT_AMP.controls) {
      expect(
        stage(AMP_SECTION).getByLabelText(plateName(control.label)),
        control.id,
      ).toBeInTheDocument();
    }
    const elsewhere = CIRCUIT_AMPS.flatMap((amp) =>
      amp.id === DEFAULT_AMP.id
        ? []
        : amp.controls.filter((c) => !DEFAULT_AMP.controls.some((own) => own.id === c.id)),
    );
    // Guards the guard: with one amp registered there is nothing to be absent.
    expect(elsewhere.length).toBeGreaterThan(0);
    for (const control of elsewhere) {
      expect(
        stage(AMP_SECTION).queryByLabelText(plateName(control.label)),
        control.id,
      ).toBeNull();
    }
  });

  it('drives the cabinet from the mic dot, and keeps the select as the text route', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Add Cabinet' }));

    // Seeded from the schema fallback: the first registered IR.
    const picker = screen.getByLabelText('Cabinet') as HTMLSelectElement;
    expect(picker.value).toBe(CABINET_IRS[0].url);

    const target = getCabinetIR('gods-dark-421')!;
    await userEvent.click(screen.getByRole('radio', { name: target.label }));

    // One value, two views of it: the dot moved and the select followed.
    expect((screen.getByLabelText('Cabinet') as HTMLSelectElement).value).toBe(target.url);
    expect(screen.getByRole('radio', { name: target.label })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // …and the registry's description of the capture, which no dot can carry.
    expect(screen.getByText(target.description)).toBeInTheDocument();
  });

  it('picks a cabinet from the select as well, with the dot following', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Add Cabinet' }));

    // The brief's text-level fallback has to work in the direction that makes it a
    // fallback: selectable without ever touching the graphic.
    const target = getCabinetIR('catharsis-balanced')!;
    await userEvent.selectOptions(screen.getByLabelText('Cabinet'), target.url);

    expect(screen.getByRole('radio', { name: target.label })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('restores the starting value when a knob is dragged away and back', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: `Add ${AMP_STAGE_LABEL}` }));

    // `commit` compares the incoming preset against the live one. The drag transport runs
    // on `window` listeners captured at pointerdown, so comparing against the *captured*
    // preset would make the one edit that returns the knob to where it started — and
    // therefore produces that captured object verbatim — the one edit silently dropped.
    const gain = stage(AMP_SECTION).getByRole('slider', { name: plateName('Input gain') });
    expect(gain).toHaveAttribute('aria-valuenow', '0');

    fireEvent(gain, pointerEvent('pointerdown', { clientY: 100 }));
    fireEvent(window, pointerEvent('pointermove', { clientY: 80 }));
    // EXACT, not merely "moved": `Knob.DRAG_RANGE_PX` is 100 for the whole
    // min→max sweep, so 20 px of a -24..24 range at a 0.5 step lands on 9.5 and
    // nowhere else. An inequality here passes for an inverted drag direction and
    // for a halved range mapping alike.
    expect(gain).toHaveAttribute('aria-valuenow', '9.5');

    fireEvent(window, pointerEvent('pointermove', { clientY: 100 }));
    expect(gain).toHaveAttribute('aria-valuenow', '0');
    fireEvent(window, pointerEvent('pointerup', { clientY: 100 }));
    expect(
      stage(AMP_SECTION).getByRole('slider', { name: plateName('Input gain') }),
    ).toHaveAttribute('aria-valuenow', '0');
  });

  it('names each stage of the rack, so the four sections are landmarks', () => {
    render(<Host />);
    // A `<section>` with no accessible name is exposed as a plain generic.
    for (const section of PARAM_SECTIONS) {
      expect(screen.getByRole('region', { name: `${section.label} stage` })).toBeInTheDocument();
    }
  });

  it("lays the plate out in the AMP'S panel order, not the schema's", async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: `Add ${AMP_STAGE_LABEL}` }));

    for (const amp of CIRCUIT_AMPS) {
      await userEvent.selectOptions(stage(AMP_SECTION).getByLabelText('Amp'), amp.id);

      // Document order, which is what a faceplate is read in. The schema's rows
      // are the union of every amp's controls GROUPED BY ID — with the Princeton
      // registered first, a Deluxe's Tone is declared before its two volumes,
      // because Tone is the id they share — so declaration order is a grouping
      // and not any one amp's layout.
      const drawn = stage(AMP_SECTION)
        .getAllByRole('slider')
        .map((el) => el.getAttribute('aria-label'));
      const expected = [
        // The section's own row first: it belongs to no circuit and sits where a
        // boost pedal would, in front of the amp.
        plateName('Input gain'),
        ...amp.controls.filter((c) => c.kind === 'pot').map((c) => plateName(c.label)),
      ];
      expect(drawn, amp.id).toEqual(expected);
    }
  });

  it('falls back to the default circuit — on the plate AND on the knobs', async () => {
    // ⚠ AUTHORED PAST THE GESTURES ON PURPOSE. `addVoiceSection` always seeds
    // `ampId`, so nothing a user can do from this app reaches the fallback arm
    // the faceplate line exists for. What does reach it is a STORED preset
    // naming an amp the registry no longer has — a variant saved by an older
    // build, and `useVoiceStore` persists variants.
    const source = getDefaultPresetForSlot('acoustic-guitar');
    const name = 'Amp that left the registry';
    const variantId = useVoiceStore.getState().addVariant({
      name,
      instrumentId: source.instrumentId,
      family: source.family,
      collectionId: null,
      preset: {
        ...source,
        name,
        effects: { circuitAmp: { ampId: 'no-such-amp', inputGainDb: 0, controls: {} } },
      },
    });
    expect(variantId).not.toBe('');
    expect(
      selectVoice('pattern', getEditingPattern()!.id, { kind: 'user', id: variantId }).ok,
    ).toBe(true);

    render(<Host />);

    // The engraving names what `wireChain` will really build.
    expect(
      stage(AMP_SECTION).getByText(DEFAULT_AMP.name, { selector: 'span' }),
    ).toBeInTheDocument();
    // …and so do the knobs, through the same resolver. A plate engraved
    // "Princeton 5F2-A" holding none of the Princeton's knobs — which is what a
    // gate comparing the RAW id gives — is the same lie one level down, while the
    // lib builds a Princeton with every control at its default.
    for (const control of DEFAULT_AMP.controls) {
      expect(
        stage(AMP_SECTION).getByLabelText(plateName(control.label)),
        control.id,
      ).toBeInTheDocument();
    }
  });

  it('names the amp on the plate as the one the chain would really build', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: `Add ${AMP_STAGE_LABEL}` }));

    // The lib resolves an unknown or missing `ampId` to its default circuit, so the
    // faceplate has to say what will be heard rather than nothing — which is why the
    // name goes through `getCircuitAmp` and not through a lookup beside the picker.
    const picker = stage(AMP_SECTION).getByLabelText('Amp') as HTMLSelectElement;
    expect(picker.value).toBe(DEFAULT_CIRCUIT_AMP_ID);
    // By selector, because the picker's own `<option>` carries the same words: the
    // engraving is the plate's, and it is the one this test is about.
    expect(stage(AMP_SECTION).getByText(DEFAULT_AMP.name, { selector: 'span' })).toBeInTheDocument();
  });
});
