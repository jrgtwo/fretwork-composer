import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_PATTERNS_STATE, PPQ, usePatternsStore, type Placement } from '@fretwork/lib';
import { CompositionPage } from '../src/composition/CompositionPage';
import { NoteInspectorRail } from '../src/composition/NoteInspectorRail';
import { NotePopup } from '../src/timeline/NotePopup';
import { DEPTHS, DYNAMIC_NAMES, FLAGS } from '../src/timeline/noteModel';
import { readNotePitch } from '../src/patterns/articulations';
import {
  addPlacement,
  closePlacementEditing,
  getTracks,
  openBlankComposition,
  openPlacementForEditing,
} from '../src/composition/compositionService';
import {
  clearHistory,
  findLibraryPattern,
  getEditingPattern,
  openBlankPattern,
  selectNotes,
  setArticulations,
  setNoteDynamic,
  setNotePitch,
  stampNote,
  undo,
} from '../src/patterns/patternService';

/**
 * CP-12 — the note inspector in the composition page's rail.
 *
 * jsdom has NO LAYOUT, so nothing here asserts that the rail LOOKS like
 * anything; every assertion is about what it offers and what it writes. Two
 * things are worth naming about how these are written:
 *
 *   - The rail reads the store through `patternService`, so a click re-renders
 *     it without any `rerender()` — unlike `NotePopup`, which is handed its
 *     event as a prop. Where a test edits the store directly it does so BEFORE
 *     rendering, or inside `act`.
 *   - Multi-select undo is asserted by undoing TWICE: one press has to put
 *     every touched note back, and the second press must find nothing left.
 *     That is the only way to tell one undo step from several without reaching
 *     into `history`.
 */

const notes = () => getEditingPattern()!.events;
const at = (startTick: number, stringIndex: number) =>
  notes().find((e) => e.startTick === startTick && e.stringIndex === stringIndex)!;

/** The two notes every test starts with: same tick, different strings. */
const LOW = () => at(0, 4);
const HIGH = () => at(0, 3);

const showRail = (ids: string[]) => {
  selectNotes(ids);
  return { user: userEvent.setup(), ...render(<NoteInspectorRail />) };
};

/** Every toggleable option a surface offers, by its label. `aria-pressed` is
 *  what makes a Choice a choice, so this catches exactly the articulation
 *  controls and none of the fret stepper / close / footer buttons. */
const optionsOf = (container: HTMLElement) =>
  [...container.querySelectorAll('[aria-pressed]')]
    .map((el) => el.textContent?.trim() ?? '')
    .sort();

beforeEach(() => {
  sessionStorage.clear();
  // `compositionService` remembers the placement it opened in MODULE state,
  // which `setState` cannot reach — the placement test below would otherwise
  // leave a stale id pointing at whichever test ran next.
  closePlacementEditing();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  openBlankPattern('Test');
  stampNote({ stringIndex: 4, fret: 5, tick: 0, durationTicks: PPQ });
  stampNote({ stringIndex: 3, fret: 7, tick: 0, durationTicks: PPQ });
  clearHistory();
});

describe('NoteInspectorRail — nothing selected', () => {
  // The rail is always mounted in edit mode, so an empty one has to read as
  // "nothing selected" rather than as broken.
  it('says nothing is selected', () => {
    render(<NoteInspectorRail />);
    expect(screen.getByText('No note selected')).toBeInTheDocument();
    expect(screen.getByText(/click a note in a lane/i)).toBeInTheDocument();
  });

  it('offers no note controls at all', () => {
    const { container } = render(<NoteInspectorRail />);
    expect(optionsOf(container)).toEqual([]);
  });

  it("is what edit mode's rail shows, in place of the CP-12 placeholder", () => {
    render(<CompositionPage mode="edit" onModeChange={() => {}} />);

    const rail = screen.getByRole('complementary', { name: 'Inspector' });
    expect(rail).toHaveTextContent('No note selected');
    expect(screen.queryByText(/arrives in CP-12/)).not.toBeInTheDocument();
  });
});

describe('NoteInspectorRail — one note', () => {
  it('names the note it is inspecting', () => {
    showRail([LOW().id]);
    expect(screen.getByText('Fret 5')).toBeInTheDocument();
  });

  it('nudges the fret', async () => {
    const { user } = showRail([LOW().id]);
    await user.click(screen.getByRole('button', { name: 'Increase fret' }));
    expect(LOW().fret).toBe(6);
  });

  it('slides into the note from below', async () => {
    const { user } = showRail([LOW().id]);
    await user.click(screen.getByRole('button', { name: '↗ below' }));
    expect(readNotePitch(LOW()).slideIn).toBe('below');
  });

  it('bends, then sets the depth in musical steps', async () => {
    const { user } = showRail([LOW().id]);

    await user.click(screen.getByRole('button', { name: '⤴ bend' }));
    expect(readNotePitch(LOW()).bend).toEqual({ kind: 'bend', semitones: 2 });

    await user.click(screen.getByRole('button', { name: '1½' }));
    expect(readNotePitch(LOW()).bend!.semitones).toBe(3);
  });

  it('only offers the depth row once a bend is on', async () => {
    const { user } = showRail([LOW().id]);
    expect(screen.queryByRole('button', { name: '1½' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '⤴ bend' }));
    expect(screen.getByRole('button', { name: '1½' })).toBeInTheDocument();
  });

  it('sets vibrato', async () => {
    const { user } = showRail([LOW().id]);
    await user.click(screen.getByRole('button', { name: 'wide' }));
    expect(LOW().vibrato).toBe('wide');
  });

  it('sets a technique flag and toggles it back off', async () => {
    const { user } = showRail([LOW().id]);

    await user.click(screen.getByRole('button', { name: 'P.Mute' }));
    expect(LOW().palmMute).toBe(true);

    await user.click(screen.getByRole('button', { name: 'P.Mute' }));
    expect(LOW().palmMute).toBeUndefined();
  });

  // `dynamic` is display-only in the lib and `velocity` is what the engine
  // reads, so both are asserted — a label that doesn't match what plays is the
  // whole failure mode.
  it('writes a dynamic and its velocity', async () => {
    const { user } = showRail([LOW().id]);
    await user.click(screen.getByRole('button', { name: 'ff' }));

    expect(LOW().dynamic).toBe('ff');
    expect(LOW().velocity).toBe(0.92);
    expect(screen.getByText(DYNAMIC_NAMES.ff)).toBeInTheDocument();
  });

  it('clears all pitch movement', async () => {
    const { user } = showRail([LOW().id]);
    await user.click(screen.getByRole('button', { name: '↗ below' }));

    await user.click(screen.getByRole('button', { name: 'Clear pitch' }));
    expect(readNotePitch(LOW())).toEqual({});
  });
});

describe('NoteInspectorRail — several notes', () => {
  it('shows a shared value as on, and a disagreement as off', async () => {
    setArticulations(LOW().id, { palmMute: true });
    const { user } = showRail([LOW().id, HIGH().id]);

    // One of the two — no common value, so the control reads unset.
    expect(screen.getByRole('button', { name: 'P.Mute' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    // …and one press brings the whole selection up to it.
    await user.click(screen.getByRole('button', { name: 'P.Mute' }));
    expect(LOW().palmMute).toBe(true);
    expect(HIGH().palmMute).toBe(true);
    expect(screen.getByRole('button', { name: 'P.Mute' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('reports a dynamic the selection disagrees about as mixed', () => {
    setNoteDynamic(LOW().id, 'pp');
    setNoteDynamic(HIGH().id, 'ff');
    showRail([LOW().id, HIGH().id]);

    expect(screen.getByText('mixed across the selection')).toBeInTheDocument();
  });

  it('applies a flag to every selected note in ONE undo step', async () => {
    const { user } = showRail([LOW().id, HIGH().id]);

    await user.click(screen.getByRole('button', { name: 'Ghost' }));
    expect([LOW().ghost, HIGH().ghost]).toEqual([true, true]);

    act(() => undo());
    expect([LOW().ghost, HIGH().ghost]).toEqual([undefined, undefined]);

    // A second press finds nothing: the two writes were one step, not two.
    act(() => undo());
    expect([LOW().ghost, HIGH().ghost]).toEqual([undefined, undefined]);
  });

  it('applies a dynamic to every selected note in ONE undo step', async () => {
    const { user } = showRail([LOW().id, HIGH().id]);

    await user.click(screen.getByRole('button', { name: 'mf' }));
    expect([LOW().dynamic, HIGH().dynamic]).toEqual(['mf', 'mf']);
    expect([LOW().velocity, HIGH().velocity]).toEqual([0.65, 0.65]);

    act(() => undo());
    expect([LOW().dynamic, HIGH().dynamic]).toEqual([undefined, undefined]);
    act(() => undo());
    expect([LOW().dynamic, HIGH().dynamic]).toEqual([undefined, undefined]);
  });

  // The pitch edit is rebuilt around each note's OWN movement. Applying the
  // displayed (common) pitch wholesale would silently flatten the selection.
  it('changes one pitch field without discarding the others each note had', async () => {
    setNotePitch(LOW().id, { slideIn: 'below' });
    setNotePitch(HIGH().id, { bend: { kind: 'bend', semitones: 2 } });
    const { user } = showRail([LOW().id, HIGH().id]);

    await user.click(screen.getByRole('button', { name: 'out ↘' }));

    expect(readNotePitch(LOW())).toMatchObject({ slideIn: 'below', slideOut: 'down' });
    expect(readNotePitch(HIGH())).toMatchObject({
      bend: { kind: 'bend' },
      slideOut: 'down',
    });
  });

  /**
   * The depth of a bend is a SEPARATE question from its kind, and a selection
   * can agree on one and not the other. Taking the displayed depth back out
   * would write whatever stood in for "they disagree" — a bend drawn on screen
   * and nothing audible, which is precisely what trap 1 forbids.
   */
  it('changes the bend kind without touching the depths the notes disagree about', async () => {
    setNotePitch(LOW().id, { bend: { kind: 'bend', semitones: 2 } });
    setNotePitch(HIGH().id, { bend: { kind: 'bend', semitones: 3 } });
    const { user } = showRail([LOW().id, HIGH().id]);

    // The bend is common, so it reads as on; the depth is not, so nothing lights.
    expect(screen.getByRole('button', { name: '⤴ bend' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    for (const { label } of DEPTHS) {
      expect(screen.getByRole('button', { name: label })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    }

    await user.click(screen.getByRole('button', { name: '⤴⤵ release' }));

    expect(readNotePitch(LOW()).bend).toEqual({ kind: 'bend-release', semitones: 2 });
    expect(readNotePitch(HIGH()).bend).toEqual({ kind: 'bend-release', semitones: 3 });
  });

  it('gives a note with no bend the default depth rather than none', async () => {
    const { user } = showRail([LOW().id, HIGH().id]);
    await user.click(screen.getByRole('button', { name: 'pre-bend' }));

    expect([readNotePitch(LOW()).bend, readNotePitch(HIGH()).bend]).toEqual([
      { kind: 'pre-bend', semitones: 2 },
      { kind: 'pre-bend', semitones: 2 },
    ]);
  });

  // `commonValue` cannot tell "they disagree" from "they agree there is no
  // mark", so `mixed` is asked separately. Deriving it from the common value
  // would call two unmarked notes mixed.
  it('does not call two unmarked notes mixed', () => {
    showRail([LOW().id, HIGH().id]);

    expect(screen.queryByText('mixed across the selection')).not.toBeInTheDocument();
    expect(screen.getByText('unset — plays at full')).toBeInTheDocument();
  });

  it('nudges the whole selection', async () => {
    const { user } = showRail([LOW().id, HIGH().id]);
    await user.click(screen.getByRole('button', { name: 'Increase fret' }));
    expect([LOW().fret, HIGH().fret]).toEqual([6, 8]);
  });

  it('counts the selection instead of claiming a fret they do not share', () => {
    showRail([LOW().id, HIGH().id]);
    expect(screen.getByText('2 notes')).toBeInTheDocument();
  });
});

/**
 * LIB-GAP(2): `mergeTies` keeps the leader and DROPS the follower event, so a
 * tie the lib cannot merge does nothing at all and articulations on the tied
 * note never sound. Neither may be offered as if it worked.
 */
describe('NoteInspectorRail — ties that cannot sound are not offered', () => {
  it('disables the tie when nothing starts where this note ends', () => {
    showRail([LOW().id]);

    expect(screen.getByRole('button', { name: '⌒ tie' })).toBeDisabled();
    expect(screen.getByText('no adjacent note')).toBeInTheDocument();
  });

  it('disables the tie when the next note is a different fret', () => {
    stampNote({ stringIndex: 4, fret: 9, tick: PPQ, durationTicks: PPQ });
    showRail([LOW().id]);

    expect(screen.getByRole('button', { name: '⌒ tie' })).toBeDisabled();
  });

  it('enables it once a note starts exactly where this one ends', async () => {
    stampNote({ stringIndex: 4, fret: 5, tick: PPQ, durationTicks: PPQ });
    const { user } = showRail([LOW().id]);

    const tie = screen.getByRole('button', { name: '⌒ tie' });
    expect(tie).toBeEnabled();

    await user.click(tie);
    expect(LOW().tieToNext).toBe(true);
  });

  // Half a selection that can tie is not a tie control that half works.
  it('disables it when only some of the selection has anywhere to tie to', () => {
    stampNote({ stringIndex: 4, fret: 5, tick: PPQ, durationTicks: PPQ });
    showRail([LOW().id, HIGH().id]);

    expect(screen.getByRole('button', { name: '⌒ tie' })).toBeDisabled();
  });

  it('names the articulations the merge will throw away', async () => {
    stampNote({ stringIndex: 4, fret: 5, tick: PPQ, durationTicks: PPQ });
    setArticulations(at(PPQ, 4).id, { vibrato: 'wide' });
    const { user } = showRail([LOW().id]);

    await user.click(screen.getByRole('button', { name: '⌒ tie' }));

    expect(screen.getByText(/vibrato won't sound/)).toBeInTheDocument();
  });

  /**
   * A tie can go stale under the user: the flag stays on the leader while an
   * edit anywhere else moves the follower out of reach. Turning a tie ON is
   * what the gap forbids, not turning one off — a flag that neither surface can
   * clear is unreachable state, and the rail's own fret stepper can create it.
   */
  it('still lets a tie that has gone stale be cleared', async () => {
    stampNote({ stringIndex: 4, fret: 5, tick: PPQ, durationTicks: PPQ });
    const { user } = showRail([LOW().id]);
    await user.click(screen.getByRole('button', { name: '⌒ tie' }));

    // The rail's own stepper is enough to strand it: the frets no longer match.
    await user.click(screen.getByRole('button', { name: 'Increase fret' }));

    const tie = screen.getByRole('button', { name: '⌒ tie' });
    expect(tie).toBeEnabled();
    expect(tie).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('stale tie — nothing to join')).toBeInTheDocument();

    await user.click(tie);
    expect(LOW().tieToNext).toBeUndefined();
  });

  it('leaves the tie disabled when it is off and has nowhere to go', () => {
    showRail([LOW().id]);
    expect(screen.getByRole('button', { name: '⌒ tie' })).toBeDisabled();
  });

  // The other half of the gap: the FOLLOWER is the event `mergeTies` discards,
  // so nothing set on it sounds — including everything else in this rail.
  it('warns that a tied follower merges into the note before it', () => {
    stampNote({ stringIndex: 4, fret: 5, tick: PPQ, durationTicks: PPQ });
    setArticulations(LOW().id, { tieToNext: true });
    showRail([at(PPQ, 4).id]);

    expect(screen.getByText(/merges into it/)).toBeInTheDocument();
  });

  // `mergeTies` ignores a tie whose adjacency does not hold and lets both notes
  // play, so the warning has to be about a merge that will actually happen.
  it('does not warn when the leader’s tie is one the lib will not merge', () => {
    stampNote({ stringIndex: 4, fret: 9, tick: PPQ, durationTicks: PPQ });
    setArticulations(LOW().id, { tieToNext: true });
    showRail([at(PPQ, 4).id]);

    expect(screen.queryByText(/merges into it/)).not.toBeInTheDocument();
  });
});

/**
 * WHERE THE WRITES LAND.
 *
 * The rail adds no routing of its own: CP-11's `openPlacementForEditing` points
 * the lib's edit target at the focused placement, and every `patternService`
 * call follows it. That claim is the whole reason this file has no redirection
 * in it, so it is asserted HERE rather than left to `tests/EditMode.test.tsx`,
 * which exercises the other callers.
 *
 * The snapshot copies the library pattern's event IDS verbatim, so "landed on
 * the placement" and "did not land on the library pattern" are two different
 * assertions over the same id.
 */
describe('NoteInspectorRail — inside an open placement', () => {
  const openPlacement = () => {
    const patternId = getEditingPattern()!.id;
    const composition = openBlankComposition('Song');
    if (!composition.ok) throw new Error(composition.reason);
    const placed = addPlacement(patternId, getTracks()[0].id, 0);
    if (!placed.ok) throw new Error(placed.reason);
    const opened = openPlacementForEditing(placed.value);
    if (!opened.ok) throw new Error(opened.reason);
    return { patternId, placementId: placed.value };
  };

  const snapshotOf = (placementId: string): Placement['patternSnapshot'] => {
    const found = getTracks()
      .flatMap((track) => [...track.placements])
      .find((placement) => placement.id === placementId);
    if (!found) throw new Error(`no placement ${placementId}`);
    return found.patternSnapshot;
  };

  it('writes to the placement’s snapshot and leaves the library pattern alone', async () => {
    const { patternId, placementId } = openPlacement();

    // `getEditingPattern` now resolves to the snapshot, so this is a snapshot note.
    const noteId = LOW().id;
    const { user } = showRail([noteId]);
    await user.click(screen.getByRole('button', { name: 'P.Mute' }));

    expect(snapshotOf(placementId).events.find((e) => e.id === noteId)?.palmMute).toBe(true);

    // Not `?.palmMute` — the snapshot copies event ids verbatim, so the library
    // note IS findable by the same id, and an undefined from a missed lookup
    // would pass this vacuously.
    const inLibrary = findLibraryPattern(patternId)!.events.find((e) => e.id === noteId);
    expect(inLibrary).toBeDefined();
    expect(inLibrary!.palmMute).toBeUndefined();
  });

  it('sends a multi-note edit to the same snapshot, in one undo step', async () => {
    const { patternId, placementId } = openPlacement();
    const ids = [LOW().id, HIGH().id];
    const { user } = showRail(ids);

    await user.click(screen.getByRole('button', { name: 'ff' }));
    const marks = () =>
      ids.map((id) => snapshotOf(placementId).events.find((e) => e.id === id)?.dynamic);
    expect(marks()).toEqual(['ff', 'ff']);
    expect(
      findLibraryPattern(patternId)!.events.some((e) => e.dynamic !== undefined),
    ).toBe(false);

    act(() => undo());
    expect(marks()).toEqual([undefined, undefined]);
    act(() => undo());
    expect(marks()).toEqual([undefined, undefined]);
  });
});

/**
 * THE DIVERGENCE TRIPWIRE.
 *
 * The rail and the popup are two surfaces over ONE set of controls
 * (`src/timeline/NoteControls.tsx`). This project has already shipped a
 * duplicated constant once, and a second copy of an articulation list drifts
 * silently — nothing else in the suite would notice a bend depth added to one
 * surface and not the other, or a technique flag quietly dropped from the rail.
 *
 * So: put one note in a state where every conditional control is showing (a
 * bend, for the depth row; a note to tie to, for the tie), render both surfaces
 * over it, and compare what they offer.
 */
describe('NotePopup and NoteInspectorRail do not diverge', () => {
  const configured = () => {
    stampNote({ stringIndex: 4, fret: 5, tick: PPQ, durationTicks: PPQ });
    setNotePitch(LOW().id, { bend: { kind: 'bend', semitones: 2 } });
    return LOW();
  };

  it('offers exactly the same set of options over the same note', () => {
    const event = configured();

    const popup = render(
      <NotePopup event={event} events={notes()} pitchName="A" onClose={() => {}} />,
    );
    const fromPopup = optionsOf(popup.container);
    popup.unmount();

    selectNotes([event.id]);
    const { container } = render(<NoteInspectorRail />);

    expect(optionsOf(container)).toEqual(fromPopup);
  });

  // Belt and braces on the above: a set equality would still hold if BOTH
  // surfaces lost the same control, so the options are also checked against the
  // tables they are supposed to be generated from.
  it('offers the options the shared tables describe', () => {
    const event = configured();
    selectNotes([event.id]);
    const { container } = render(<NoteInspectorRail />);
    const options = optionsOf(container);

    for (const { label } of FLAGS) expect(options).toContain(label);
    for (const { label } of DEPTHS) expect(options).toContain(label);
    for (const mark of Object.keys(DYNAMIC_NAMES)) expect(options).toContain(mark);
  });
});
