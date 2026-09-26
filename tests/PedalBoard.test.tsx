import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  getDefaultPresetForSlot,
  getInstrumentFirstDefaultSlotId,
  makeDefaultActiveVariants,
  useFretworkStore,
  useVoiceStore,
  VOICE_STORAGE_KEY,
  type LegacyVoicePreset,
  type VoicePreset,
} from '@fretwork/lib';
import { VoicePane } from '../src/voice/VoicePane';
import type { SectionId } from '../src/voice/paramSchema';
import { clearVoiceDrafts, readVoiceDraft } from '../src/voice/voiceDrafts';
import { removeAtPath } from '../src/voice/presetPaths';
import { selectVoice } from '../src/voice/voiceService';
import { clearPendingWarms } from '../src/voice/sampleWarm';
import { getEditingPattern, openBlankPattern } from '../src/patterns/patternService';
import { PaneStack, type Pane } from '../src/shell/PaneStack';

/**
 * The pedalboard as a list the user assembles (`docs/PLAN-voice.md` §7): the type
 * picker appends, Remove deletes, and the order on screen is the signal order.
 *
 * Driven on the pattern page's pane. The track rack is the same component
 * (`VoiceEditor`) and `VoiceMode.test.tsx` covers its per-track naming and seam.
 *
 * ⚠ WHAT JSDOM CANNOT SHOW. It has no layout — every rect is 0×0 — so a drag can
 * only ever resolve to the slot past the last item (the pointer is always below
 * every midline). The reorder those tests assert is therefore "to the end", and
 * the midline arithmetic that picks any other slot is a browser check. The
 * keyboard path (Move up / Move down) is what the ordering tests drive.
 */

function Host() {
  const [collapsed, setCollapsed] = useState<readonly SectionId[] | undefined>(undefined);
  return <VoicePane collapsedSections={collapsed} onCollapsedSectionsChange={setCollapsed} />;
}

const draftPreset = (): VoicePreset => {
  const pattern = getEditingPattern();
  if (!pattern) throw new Error('no pattern open');
  const draft = readVoiceDraft('pattern', pattern.id);
  if (!draft) throw new Error('no unsaved edit — the pane recorded none');
  return draft;
};

const openBoard = () => userEvent.click(screen.getByRole('button', { name: 'Pedals' }));
const board = () => within(screen.getByRole('region', { name: 'Pedals stage' }));
/** The type picker only chooses; Add appends. */
const addPedal = async (label: string) => {
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Pedal type' }), label);
  await userEvent.click(screen.getByRole('button', { name: 'Add pedal' }));
};
/** The cards, top to bottom, by accessible name. */
const cards = () =>
  board()
    .queryAllByRole('group')
    .map((group) => group.getAttribute('aria-label'));
/** The kinds on the draft's board, in its order. */
const draftKinds = () => {
  const pedals = draftPreset().pedals;
  return pedals?.order.map((id) => pedals.byId[id].kind) ?? [];
};

/**
 * A voice as saved before the pedals became a board: the named fields, which the
 * engine wired compressor → distortion → chorus → delay → auto-wah → graphic EQ
 * whatever order they were written in. Declared out of that order on purpose.
 */
const legacyPreset = (): LegacyVoicePreset => {
const base = getDefaultPresetForSlot(getInstrumentFirstDefaultSlotId('guitar'));
return {
    ...removeAtPath(base, 'pedals'),
    name: 'Old tone',
    effects: {
      ...base.effects,
      graphicEq: {
        band100Hz: 0,
        band200Hz: 0,
        band400Hz: 0,
        band800Hz: 0,
        band1_6kHz: 0,
        band3_2kHz: 0,
        band6_4kHz: 0,
        levelDb: 0,
      },
      chorus: {
        frequency: 1.5,
        depth: 0.7,
        wet: 0.5,
        type: 'sine',
        feedback: 0,
        delayTime: 0.0035,
        spread: 180,
      },
      distortion: { enabled: false, drive: 0.4, wet: 1, oversample: 'none' },
    },
    compressor: { threshold: -24, ratio: 12, attack: 0.003, release: 0.25, knee: 30 },
  };
};

beforeEach(() => {
  clearVoiceDrafts();
  clearPendingWarms();
  useFretworkStore.getState().setInstrumentId('guitar');
  useVoiceStore.getState().reset();
  sessionStorage.clear();
  openBlankPattern('Pedal test');
});

afterEach(() => {
  sessionStorage.clear();
});

describe('the pedal board', () => {
  it('appends each pick at the end, and a second of a kind is a second pedal', async () => {
    render(<Host />);
    await openBoard();

    await addPedal('Distortion');
    await addPedal('Delay');
    await addPedal('Distortion');

    // Numbered past the first of its kind, so two identical cards are two names.
    expect(cards()).toEqual(['Distortion', 'Delay', 'Distortion 2']);
    expect(draftKinds()).toEqual(['distortion', 'delay', 'distortion']);
    const [first, , second] = draftPreset().pedals?.order ?? [];
    expect(first).not.toBe(second);

    // Each card's controls reach its own pedal and not the other one.
    expect(board().getByRole('slider', { name: 'Distortion 2 Drive' })).toBeInTheDocument();
    await userEvent.click(board().getByRole('switch', { name: 'Distortion 2 Enabled' }));
    expect(draftPreset().pedals?.byId[second].enabled).toBe(false);
    expect(draftPreset().pedals?.byId[first].enabled).toBeUndefined();
  });

  it('removes one pedal outright, and nothing keeps its slot', async () => {
    render(<Host />);
    await openBoard();
    await addPedal('Chorus');
    await addPedal('Chorus');
    const second = draftPreset().pedals?.order[1];

    await userEvent.click(board().getByRole('button', { name: 'Remove Chorus' }));
    // The survivor is the first of its kind now, and is named so.
    expect(cards()).toEqual(['Chorus']);
    expect(draftPreset().pedals?.order).toEqual([second]);

    await addPedal('Delay');
    expect(draftKinds()).toEqual(['chorus', 'delay']);

    await userEvent.click(board().getByRole('button', { name: 'Remove Chorus' }));
    await userEvent.click(board().getByRole('button', { name: 'Remove Delay' }));
    expect(cards()).toEqual([]);
    expect(board().getByText('No pedals on this voice.')).toBeInTheDocument();
    expect(draftPreset().pedals).toBeUndefined();
  });

  it('moves a pedal with no pointer, and the ends cannot move further', async () => {
    render(<Host />);
    await openBoard();
    await addPedal('Compressor');
    await addPedal('Delay');
    await addPedal('Chorus');

    expect(board().getByRole('button', { name: 'Move Compressor up' })).toBeDisabled();
    expect(board().getByRole('button', { name: 'Move Chorus down' })).toBeDisabled();

    await userEvent.click(board().getByRole('button', { name: 'Move Chorus up' }));
    expect(cards()).toEqual(['Compressor', 'Chorus', 'Delay']);
    expect(draftKinds()).toEqual(['compressor', 'chorus', 'delay']);

    await userEvent.click(board().getByRole('button', { name: 'Move Compressor down' }));
    expect(draftKinds()).toEqual(['chorus', 'compressor', 'delay']);
  });

  it('adds nothing until Add is pressed, however many kinds the picker passes', async () => {
    // Arrowing through a focused closed <select> fires `change` per keypress on
    // Windows; a picker that appended on change added a pedal per kind browsed.
    render(<Host />);
    await openBoard();
    const picker = screen.getByRole('combobox', { name: 'Pedal type' });
    for (const label of ['Distortion', 'Chorus', 'Delay']) {
      await userEvent.selectOptions(picker, label);
    }
    expect(cards()).toEqual([]);
    expect(readVoiceDraft('pattern', getEditingPattern()!.id)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Add pedal' }));
    expect(draftKinds()).toEqual(['delay']);
  });

  it('hands focus to the other Move button when a move reaches an end', async () => {
    // The button just pressed disables itself at the end of the board, and a
    // disabled button drops focus to the body.
    render(<Host />);
    await openBoard();
    await addPedal('Distortion');
    await addPedal('Delay');
    await addPedal('Distortion');

    await userEvent.click(board().getByRole('button', { name: 'Move Distortion 2 up' }));
    expect(cards()).toEqual(['Distortion', 'Distortion 2', 'Delay']);
    // Not an end: focus stays where it was, on a button that is still live.
    expect(document.activeElement).toBe(
      board().getByRole('button', { name: 'Move Distortion 2 up' }),
    );

    await userEvent.click(board().getByRole('button', { name: 'Move Distortion 2 up' }));
    // The moved pedal is the first of its kind now, so it is named so.
    expect(cards()).toEqual(['Distortion', 'Distortion 2', 'Delay']);
    expect(document.activeElement).toBe(board().getByRole('button', { name: 'Move Distortion down' }));

    await userEvent.click(board().getByRole('button', { name: 'Move Delay up' }));
    await userEvent.click(board().getByRole('button', { name: 'Move Delay down' }));
    expect(cards()).toEqual(['Distortion', 'Distortion 2', 'Delay']);
    expect(document.activeElement).toBe(board().getByRole('button', { name: 'Move Delay up' }));
  });

  it('drags a pedal by its header to reorder the board', async () => {
    // See the header: in jsdom every drag lands past the last card.
    const user = userEvent.setup();
    render(<Host />);
    await openBoard();
    await addPedal('Compressor');
    await addPedal('Delay');

    const handle = board().getByText('Compressor', { selector: 'span' });
    await user.pointer([
      { target: handle, keys: '[MouseLeft>]', coords: { clientY: 100 } },
      { target: handle, coords: { clientY: 102 } }, // under the threshold: a click, not a drag
      { keys: '[/MouseLeft]' },
    ]);
    expect(draftKinds()).toEqual(['compressor', 'delay']);

    await user.pointer([
      { target: handle, keys: '[MouseLeft>]', coords: { clientY: 100 } },
      { target: handle, coords: { clientY: 140 } },
    ]);
    // Mid-gesture: the dragged card is marked, and the drop line sits past the
    // last card — the only slot jsdom's 0×0 rects can resolve to.
    const dragged = screen.getByRole('group', { name: 'Compressor' });
    expect(dragged).toHaveClass('outline-dashed');
    const lines = screen.getAllByTestId('dropline');
    expect(lines).toHaveLength(1);
    expect(lines[0].parentElement?.lastElementChild).toBe(lines[0]);

    await user.pointer({ keys: '[/MouseLeft]' });
    expect(draftKinds()).toEqual(['delay', 'compressor']);
    expect(cards()).toEqual(['Delay', 'Compressor']);
    expect(screen.queryByTestId('dropline')).not.toBeInTheDocument();
  });

  it('ends a drag without dropping when the window loses focus', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await openBoard();
    await addPedal('Compressor');
    await addPedal('Delay');

    const handle = board().getByText('Compressor', { selector: 'span' });
    await user.pointer([
      { target: handle, keys: '[MouseLeft>]', coords: { clientY: 100 } },
      { target: handle, coords: { clientY: 140 } },
    ]);
    fireEvent.blur(window);
    expect(screen.queryByTestId('dropline')).not.toBeInTheDocument();
    await user.pointer({ keys: '[/MouseLeft]' });
    expect(draftKinds()).toEqual(['compressor', 'delay']);
  });

  it('drops nothing from a drag whose board unmounted mid-gesture', async () => {
    // Otherwise the gesture's window listeners outlive the board and the next
    // mouseup anywhere moves a pedal on a holder nobody is looking at.
    const user = userEvent.setup();
    const { unmount } = render(<Host />);
    await openBoard();
    await addPedal('Compressor');
    await addPedal('Delay');

    const handle = board().getByText('Compressor', { selector: 'span' });
    await user.pointer([
      { target: handle, keys: '[MouseLeft>]', coords: { clientY: 100 } },
      { target: handle, coords: { clientY: 140 } },
    ]);
    unmount();
    fireEvent.mouseUp(window);
    expect(draftKinds()).toEqual(['compressor', 'delay']);
  });

  it('saves the order into the voice', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Save as…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await openBoard();
    await addPedal('Delay');
    await addPedal('Distortion');
    await userEvent.click(board().getByRole('button', { name: 'Move Distortion up' }));

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const saved = useVoiceStore.getState().variants[0].preset.pedals;
    expect(saved?.order.map((id) => saved.byId[id].kind)).toEqual(['distortion', 'delay']);
  });

  it('draws a voice saved in the old shape with its pedals in the old wiring order', async () => {
    // A v2 voice store, as a user saved it before the pedals became a board: the
    // named fields, which the engine used to wire compressor → distortion →
    // chorus → delay → auto-wah → graphic EQ whatever order they were written in.
    const base = getDefaultPresetForSlot(getInstrumentFirstDefaultSlotId('guitar'));
    const legacy = legacyPreset();
    const variantId = 'legacy-variant';
    sessionStorage.setItem(
      VOICE_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 2,
        variants: [
          {
            id: variantId,
            name: 'Old tone',
            instrumentId: 'guitar',
            family: base.family,
            collectionId: null,
            preset: legacy,
            forkedFromId: null,
            forkedFromCreatorName: null,
          },
        ],
        activeVariants: makeDefaultActiveVariants(),
        reverb: null,
      }),
    );
    useVoiceStore.getState().rehydrateFromStorage();
    const pattern = getEditingPattern();
    if (!pattern) throw new Error('no pattern open');
    expect(selectVoice('pattern', pattern.id, { kind: 'user', id: variantId }).ok).toBe(true);

    render(<Host />);
    await openBoard();
    expect(cards()).toEqual(['Compressor', 'Distortion', 'Chorus', 'Graphic EQ']);
    // The bypassed distortion came across bypassed, not dropped.
    expect(board().getByRole('switch', { name: 'Distortion Enabled' })).toHaveTextContent(
      'Bypassed',
    );
  });

  it('keeps a legacy-shaped voice`s pedals when one is added to it', async () => {
    // A legacy preset that reached the editor WITHOUT the store's storage read —
    // the one place the lib converts on its way in. The editor still draws its
    // board, and an add lands after those pedals instead of beside the named
    // fields, where `legacyToPedals` would take the board as authoritative and
    // drop them.
    const base = getDefaultPresetForSlot(getInstrumentFirstDefaultSlotId('guitar'));
    const variantId = 'legacy-in-memory';
    useVoiceStore.setState({
      variants: [
        {
          id: variantId,
          name: 'Old tone',
          instrumentId: 'guitar',
          family: base.family,
          collectionId: null,
          preset: legacyPreset() as VoicePreset,
          forkedFromId: null,
          forkedFromCreatorName: null,
        },
      ],
    });
    const pattern = getEditingPattern();
    if (!pattern) throw new Error('no pattern open');
    expect(selectVoice('pattern', pattern.id, { kind: 'user', id: variantId }).ok).toBe(true);

    render(<Host />);
    await openBoard();
    expect(cards()).toEqual(['Compressor', 'Distortion', 'Chorus', 'Graphic EQ']);

    await addPedal('Delay');
    expect(draftKinds()).toEqual(['compressor', 'distortion', 'chorus', 'graphicEq', 'delay']);
    const draft = draftPreset() as LegacyVoicePreset;
    expect(draft.compressor).toBeUndefined();
    expect(draft.effects?.chorus).toBeUndefined();
  });
});

describe('the shared drag gesture, on the pane stack', () => {
  // The pedal board's drag is `PaneStack`'s, lifted into `useDragReorder`. The
  // stack's own tests cover the threshold and the drop line; this is the
  // completed drop, which they do not make.
  const PANES: Pane[] = [
    { id: 'reference', title: 'Reference', children: <p>fretboard</p> },
    { id: 'amp', title: 'Instrument & Amp', children: <p>amp rack</p> },
    { id: 'timeline', title: 'Timeline', children: <p>beat grid</p> },
  ];

  function Stack() {
    const [order, setOrder] = useState<readonly string[]>(PANES.map((p) => p.id));
    const [collapsed, setCollapsed] = useState<readonly string[]>([]);
    return (
      <PaneStack
        panes={PANES}
        order={order}
        onOrderChange={setOrder}
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
      />
    );
  }

  it('drops a dragged pane where the reorder puts it', async () => {
    const user = userEvent.setup();
    render(<Stack />);
    const header = screen.getByText('Reference');
    await user.pointer([
      { target: header, keys: '[MouseLeft>]', coords: { clientY: 100 } },
      { target: header, coords: { clientY: 140 } },
      { keys: '[/MouseLeft]' },
    ]);
    expect(
      [...document.querySelectorAll('[data-pane]')].map((el) => el.getAttribute('data-pane')),
    ).toEqual(['amp', 'timeline', 'reference']);
  });
});
