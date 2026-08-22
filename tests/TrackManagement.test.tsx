import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PATTERNS_STATE,
  MAX_COMPOSITION_TRACKS,
  PPQ,
  usePatternsStore,
  type Track,
} from '@fretwork/lib';
import { ArrangementGrid } from '../src/composition/ArrangementGrid';
import {
  TRACK_CAP_REASON,
  addPlacement,
  addTrack,

  getEditingComposition,
  getSelectedTrackId,
  getTracks,
  isTrackAudible,
  mismatchedPlacements,
  moveTrack,
  openBlankComposition,
  removeTrack,
  resizePlacement,
  selectPlacements,
  selectTrack,
  setMasterVolumeDb,
  setTrackMuted,
  setTrackName,
  setTrackSoloed,
  setTrackVolumeDb,
  setTrackPan,
  strandedByInstrument,
  undo,
} from '../src/composition/compositionService';
import { getEditingPattern, openBlankPattern, stampNote } from '../src/patterns/patternService';

/**
 * CP-07 — track management: add, remove, rename, reorder, the per-track
 * instrument, the mixer strip and the composition's master fader.
 *
 * What is asserted here is the STATE MACHINE and the seam round-trip, because
 * that is what this environment can actually see. jsdom has no layout, no
 * scrolling and no Web Audio, so nothing below claims a fader "sounds quieter"
 * or that a header "fits its lane" — the audible half of this ticket's
 * acceptance is CP-08's and is checked by ear. `isTrackAudible` is the seam
 * between the two: it is the same predicate the engine applies
 * (`MultiTrackPlayback.applyTrackState`), so testing it here is testing what
 * playback will do without needing an audio context to do it.
 *
 * Every write goes through `compositionService` in both directions: a control
 * is pressed and the STORE is read back, or the seam is called and the SCREEN is
 * read back. A test that only checked the component's own state would pass
 * against a header that had quietly stopped writing anything.
 */

const MODE = 'pattern' as const;

beforeEach(() => {
  sessionStorage.clear();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  selectPlacements([]);
  selectTrack(null);
});

/** A library pattern one bar long. A pattern with no events has no duration,
 *  and a zero-length placement is not a block anyone could point at. */
function seedPattern(name: string, strings: readonly number[] = [0]): string {
  openBlankPattern(name);
  const pattern = getEditingPattern();
  if (!pattern) throw new Error('pattern seam did not open a pattern');
  for (const stringIndex of strings) {
    stampNote({ stringIndex, fret: 3, tick: 0, durationTicks: 4 * PPQ });
  }
  return pattern.id;
}

function tracksNow(): readonly Track[] {
  return getTracks();
}

function headerFor(track: Track): HTMLElement {
  const header = document.querySelector<HTMLElement>(`[data-track-header="${track.id}"]`);
  if (!header) throw new Error(`no header rendered for ${track.name}`);
  return header;
}

/**
 * The TRACK strip, by name.
 *
 * The grid keeps two alert strips — one for gestures, one for track writes —
 * and they are designed to be on screen at once, so an unnamed
 * `getByRole('alert')` is ambiguous the moment both are up. Naming them is
 * what makes "both, together" testable at all.
 */
function trackAlert(): HTMLElement {
  return screen.getByRole('alert', { name: 'Track message' });
}

function place(patternId: string, trackId: string, atTick = 0): string {
  const result = addPlacement(patternId, trackId, atTick);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

// ------------------------------------------------------------ the mix rule ---

describe('mute and solo', () => {
  beforeEach(() => {
    openBlankComposition('Song');
    addTrack('Rhythm');
    addTrack('Lead');
  });

  it('silences a muted track and nothing else', () => {
    const tracks = tracksNow();
    setTrackMuted(tracks[1].id, true);

    const after = tracksNow();
    expect(after.map((t) => isTrackAudible(t, after))).toEqual([true, false, true]);
  });

  it('sounds exactly the soloed tracks when two are soloed', () => {
    // The classic mixer bug is implementing solo as "mute the others", which
    // makes the SECOND solo silence the first. Both must sound.
    const tracks = tracksNow();
    setTrackSoloed(tracks[0].id, true);
    setTrackSoloed(tracks[2].id, true);

    const after = tracksNow();
    expect(after.map((t) => isTrackAudible(t, after))).toEqual([true, false, true]);
    // And nothing was written to the un-soloed track — un-soloing has to give
    // back the mix that was there, which is the whole difference from muting
    // the others by hand.
    expect(after[1].muted).toBe(false);
  });

  it('restores the whole mix when the last solo is released', () => {
    const tracks = tracksNow();

    setTrackSoloed(tracks[0].id, true);

    // The MID-state is the half that can fail: end-state-only, this test would
    // hold for `setTrackSoloed = () => ok(undefined)` — nothing soloed and
    // nothing muted is audible under any implementation.
    const soloed = tracksNow();
    expect(soloed.map((t) => isTrackAudible(t, soloed))).toEqual([true, false, false]);
    // ...and it got there without WRITING to the others, which is the whole
    // difference between solo and muting them by hand.
    expect(soloed.map((t) => t.muted)).toEqual([false, false, false]);

    setTrackSoloed(tracks[0].id, false);

    const after = tracksNow();
    expect(after.map((t) => isTrackAudible(t, after))).toEqual([true, true, true]);
    expect(after.map((t) => t.muted)).toEqual([false, false, false]);
  });

  it('keeps a muted track muted through a solo that comes and goes', () => {
    // The other half of the precedence: solo must not clear an existing mute on
    // its way past, or releasing the solo hands back a mix the user never set.
    const tracks = tracksNow();
    setTrackMuted(tracks[1].id, true);
    setTrackSoloed(tracks[0].id, true);
    setTrackSoloed(tracks[0].id, false);

    const after = tracksNow();
    expect(after.map((t) => t.muted)).toEqual([false, true, false]);
    expect(after.map((t) => isTrackAudible(t, after))).toEqual([true, false, true]);
  });

  it('lets mute win over solo on the same track', () => {
    // The precedence decided in `isTrackAudible`: mute is a statement about
    // THIS track, solo is a statement about the others, and the specific one
    // wins. Stated here as a test because a mixer whose buttons imply the other
    // order is wrong in a way you only find out by ear.
    const tracks = tracksNow();
    setTrackSoloed(tracks[0].id, true);
    setTrackMuted(tracks[0].id, true);

    const after = tracksNow();
    expect(isTrackAudible(after[0], after)).toBe(false);
    // ...and the solo still silences the others, so this is not "no solo at
    // all" — it is a soloed track that is also muted.
    expect(after.map((t) => isTrackAudible(t, after))).toEqual([false, false, false]);
  });

  it('says on screen which tracks are silent, not just which buttons are down', async () => {
    const user = userEvent.setup();
    render(<ArrangementGrid mode={MODE} />);
    const [first, second] = tracksNow();

    await user.click(
      within(headerFor(first)).getByRole('button', { name: `Solo ${first.name}` }),
    );

    // Round-tripped through the seam, not held in the component.
    expect(tracksNow()[0].soloed).toBe(true);
    expect(within(headerFor(first)).queryByText(/silent/i)).not.toBeInTheDocument();
    expect(within(headerFor(second)).getByText(/silent/i)).toBeInTheDocument();
  });

  it('drives mute and solo from the header through the seam', async () => {
    const user = userEvent.setup();
    render(<ArrangementGrid mode={MODE} />);
    const [track] = tracksNow();

    const mute = () =>
      within(headerFor(track)).getByRole('button', { name: `Mute ${track.name}` });
    expect(mute()).toHaveAttribute('aria-pressed', 'false');

    await user.click(mute());

    expect(tracksNow()[0].muted).toBe(true);
    expect(mute()).toHaveAttribute('aria-pressed', 'true');

    await user.click(mute());

    expect(tracksNow()[0].muted).toBe(false);
  });
});

// ------------------------------------------------------------------- pan ---

describe('pan (CP-19)', () => {
  beforeEach(() => openBlankComposition('Song'));

  function panFor(track: Track) {
    return within(headerFor(track)).getByRole('slider', { name: `Pan for ${track.name}` });
  }

  it('is its own control on the strip, spanning hard left to hard right', () => {
    render(<ArrangementGrid mode={MODE} />);
    const [track] = tracksNow();

    const pan = panFor(track);
    expect(pan).toHaveAttribute('min', '-1');
    expect(pan).toHaveAttribute('max', '1');
    expect((pan as HTMLInputElement).value).toBe('0');

    fireEvent.change(pan, { target: { value: '-0.5' } });

    expect(tracksNow()[0].pan).toBe(-0.5);
  });

  it('says where it is the way a mixer says it, not as a signed fraction', () => {
    render(<ArrangementGrid mode={MODE} />);
    const [track] = tracksNow();

    // `-0.35` is the value and tells a listener nothing. This is what both the
    // readout and `aria-valuetext` carry.
    expect(panFor(track)).toHaveAttribute('aria-valuetext', 'C');
    fireEvent.change(panFor(track), { target: { value: '-0.35' } });
    expect(panFor(tracksNow()[0])).toHaveAttribute('aria-valuetext', 'L35');
    fireEvent.change(panFor(tracksNow()[0]), { target: { value: '0.2' } });
    expect(panFor(tracksNow()[0])).toHaveAttribute('aria-valuetext', 'R20');
  });

  it('has a detent — a drag that lands near the middle lands ON it', () => {
    // A pan pot has a physical centre you can feel; a range input has none.
    // Without this, "put it back in the middle" is a fiddle rather than a drag.
    render(<ArrangementGrid mode={MODE} />);
    const [track] = tracksNow();

    fireEvent.change(panFor(track), { target: { value: '0.05' } });

    expect(tracksNow()[0].pan).toBe(0);
  });

  it('re-centres on a double-click', () => {
    render(<ArrangementGrid mode={MODE} />);
    const [track] = tracksNow();
    fireEvent.change(panFor(track), { target: { value: '-0.8' } });
    expect(tracksNow()[0].pan).toBe(-0.8);

    fireEvent.doubleClick(panFor(tracksNow()[0]));

    expect(tracksNow()[0].pan).toBe(0);
  });

  it('clamps an out-of-range value at the seam and reports what it stored', () => {
    // The slider cannot produce this; the agent can.
    const [track] = tracksNow();

    expect(setTrackPan(track.id, 5)).toEqual({ ok: true, value: 1 });
    expect(tracksNow()[0].pan).toBe(1);
  });

  it('refuses a pan that is not a number, rather than storing NaN', () => {
    // A NaN reaching `Panner.pan` is not an error — the node keeps its last
    // value and the track silently stops answering the control.
    const [track] = tracksNow();

    expect(setTrackPan(track.id, Number.NaN)).toEqual({
      ok: false,
      reason: 'That is not a pan position.',
    });
    expect(tracksNow()[0].pan).toBe(0);
  });

  it('shows centred for a track stored before pan existed', () => {
    // `pan` is optional on the model and nothing backfills it, so the control
    // meets `undefined` on any composition saved before this shipped. An
    // uncontrolled range is the failure this prevents.
    const comp = getEditingComposition();
    expect(comp).toBeTruthy();
    if (!comp) return;
    usePatternsStore.setState((state) => ({
      library: {
        ...state.library,
        compositions: state.library.compositions.map((c) =>
          c.id === comp.id
            ? {
                ...c,
                tracks: c.tracks.map((t) => {
                  // Deleted rather than destructured-around: the field has to be
                  // ABSENT, not undefined, to stand in for a track written
                  // before it existed.
                  const stripped = { ...t };
                  delete (stripped as { pan?: number }).pan;
                  return stripped;
                }),
              }
            : c,
        ),
      },
    }));

    render(<ArrangementGrid mode={MODE} />);
    const [track] = tracksNow();

    expect((panFor(track) as HTMLInputElement).value).toBe('0');
    expect(panFor(track)).toHaveAttribute('aria-valuetext', 'C');
  });
});

// ---------------------------------------------------------------- volume ---

describe('volume', () => {
  beforeEach(() => openBlankComposition('Song'));

  it('is a dB fader, not a percentage', () => {
    render(<ArrangementGrid mode={MODE} />);
    const [track] = tracksNow();

    const fader = within(headerFor(track)).getByRole('slider', {
      name: `Volume for ${track.name} in decibels`,
    });
    // The model, the lib's clamp and the gain node are all dB. A 0–100 slider
    // converted on the way in is a second unit to get wrong.
    expect(fader).toHaveAttribute('min', '-60');
    expect(fader).toHaveAttribute('max', '6');
    expect((fader as HTMLInputElement).value).toBe('0');

    // `fireEvent` rather than `userEvent`: dragging a range needs layout, and
    // there is none here. The value change is the part that matters.
    fireEvent.change(fader, { target: { value: '-12' } });

    expect(tracksNow()[0].volumeDb).toBe(-12);
  });

  it('moves the composition master through the seam', () => {
    render(<ArrangementGrid mode={MODE} />);

    const master = screen.getByRole('slider', { name: 'Master volume in decibels' });
    fireEvent.change(master, { target: { value: '-6' } });

    expect(getEditingComposition()?.masterVolumeDb).toBe(-6);
  });

  it('clamps an out-of-range dB at the seam and reports what it stored', () => {
    // The slider cannot produce this; the agent can, and it is the caller least
    // able to notice a silent coercion. The lib clamps and says nothing.
    const [track] = tracksNow();

    expect(setTrackVolumeDb(track.id, -100)).toEqual({ ok: true, value: -60 });
    expect(tracksNow()[0].volumeDb).toBe(-60);
    expect(setMasterVolumeDb(99)).toEqual({ ok: true, value: 6 });
    expect(getEditingComposition()?.masterVolumeDb).toBe(6);
  });

  it('does not re-write when the clamped value is already stored', () => {
    // The guard compares the CLAMPED value, not the request. Comparing the
    // request would make a repeated out-of-range write churn `updatedAt` and
    // re-render every subscriber, forever, while reporting plain `ok`.
    const [track] = tracksNow();
    setTrackVolumeDb(track.id, -100);
    const settled = getEditingComposition();

    expect(setTrackVolumeDb(track.id, -100)).toEqual({ ok: true, value: -60 });

    expect(getEditingComposition()).toBe(settled);
  });

  it('refuses a volume that is not a number, rather than storing NaN', () => {
    const [track] = tracksNow();

    expect(setTrackVolumeDb(track.id, Number.NaN)).toEqual({
      ok: false,
      reason: 'That is not a volume.',
    });
    expect(setMasterVolumeDb(Number.NaN)).toEqual({
      ok: false,
      reason: 'That is not a volume.',
    });
    expect(tracksNow()[0].volumeDb).toBe(0);
  });

  it('reports a missing composition rather than no-opping into it', () => {
    usePatternsStore.setState({
      ...DEFAULT_PATTERNS_STATE,
      library: { patterns: [], compositions: [], collections: [] },
    });

    expect(setMasterVolumeDb(-3)).toEqual({ ok: false, reason: 'No composition is open.' });
    expect(moveTrack('anything', 0)).toEqual({
      ok: false,
      reason: 'No composition is open.',
    });
    expect(addTrack()).toEqual({ ok: false, reason: 'No composition is open.' });
  });
});

// ------------------------------------------------------------------- cap ---

describe('the track cap', () => {
  beforeEach(() => openBlankComposition('Song'));

  it('refuses the ninth track at the seam, with the memory reason', () => {
    while (tracksNow().length < MAX_COMPOSITION_TRACKS) {
      expect(addTrack().ok).toBe(true);
    }

    const ninth = addTrack();

    expect(ninth.ok).toBe(false);
    if (ninth.ok) return;
    expect(ninth.reason).toContain(String(MAX_COMPOSITION_TRACKS));
    // Not merely "no": the number is a MEMORY budget, and a limit that says why
    // is one the caller — including the agent — can plan around.
    expect(ninth.reason).toMatch(/sample bank/i);
    expect(tracksNow()).toHaveLength(MAX_COMPOSITION_TRACKS);
  });

  it('adds through the button and states the reason when it cannot', async () => {
    const user = userEvent.setup();
    render(<ArrangementGrid mode={MODE} />);

    const add = () => screen.getByRole('button', { name: 'Add track' });
    await user.click(add());

    expect(tracksNow()).toHaveLength(2);
    expect(screen.getByText(/2\/8 tracks/)).toBeInTheDocument();

    while (tracksNow().length < MAX_COMPOSITION_TRACKS) {
      await user.click(add());
    }

    // Marked unavailable but still reachable: `disabled` would take it out of
    // the tab order and answer nothing when pressed.
    expect(add()).toHaveAttribute('aria-disabled', 'true');
    expect(add()).toBeEnabled();

    await user.click(add());

    expect(tracksNow()).toHaveLength(MAX_COMPOSITION_TRACKS);
    expect(trackAlert()).toHaveTextContent(/sample bank/i);
    // The tooltip before the press is the SEAM's sentence, not a paraphrase of
    // it that can drift from the one the agent gets.
    expect(add()).toHaveAttribute('title', TRACK_CAP_REASON);
  });

  it('names every added track distinctly, even after a middle one goes', () => {
    // The lib names by `tracks.length + 1`, which repeats itself as soon as a
    // middle track is removed. Two tracks with one name is not cosmetic: every
    // control's accessible name is built from it.
    addTrack();
    addTrack();
    const [, second] = tracksNow();
    removeTrack(second.id);
    addTrack();

    const names = tracksNow().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps a track focused after adding it, without clearing an unread notice', async () => {
    const user = userEvent.setup();
    render(<ArrangementGrid mode={MODE} />);
    const [only] = tracksNow();

    // Something already on the strip and possibly unread.
    await user.click(
      within(headerFor(only)).getByRole('button', { name: `Remove ${only.name}` }),
    );
    expect(trackAlert()).toHaveTextContent(/zero tracks/i);

    await user.click(screen.getByRole('button', { name: 'Add track' }));

    // The new track is where the next drop will land, so it takes focus...
    expect(getSelectedTrackId()).toBe(tracksNow()[1].id);
    // ...and a success does not wipe a message it has nothing to do with.
    expect(trackAlert()).toHaveTextContent(/zero tracks/i);

    await user.click(screen.getByRole('button', { name: 'Dismiss track message' }));

    expect(screen.queryByRole('alert', { name: 'Track message' })).not.toBeInTheDocument();
  });

  it('forgets a track notice when another composition is opened', async () => {
    const user = userEvent.setup();
    render(<ArrangementGrid mode={MODE} />);
    const [only] = tracksNow();

    await user.click(
      within(headerFor(only)).getByRole('button', { name: `Remove ${only.name}` }),
    );
    expect(trackAlert()).toBeInTheDocument();

    // A refusal from a document that is no longer on screen explains nothing
    // about the one that is.
    act(() => {
      openBlankComposition('Another');
    });

    expect(screen.queryByRole('alert', { name: 'Track message' })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- remove ---

describe('removing a track', () => {
  beforeEach(() => openBlankComposition('Song'));

  it('confirms first when there are blocks to destroy, and undoes as one step', async () => {
    const user = userEvent.setup();
    const patternId = seedPattern('Riff');
    const added = addTrack('Lead');
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    place(patternId, added.value.id, 0);
    place(patternId, added.value.id, 8 * PPQ);
    render(<ArrangementGrid mode={MODE} />);
    const track = tracksNow()[1];

    await user.click(
      within(headerFor(track)).getByRole('button', { name: `Remove ${track.name}` }),
    );

    // Nothing destroyed yet — the press asked.
    expect(tracksNow()).toHaveLength(2);
    expect(within(headerFor(track)).getByText(/delete 2 blocks\?/i)).toBeInTheDocument();

    await user.click(
      within(headerFor(track)).getByRole('button', {
        name: `Confirm removing ${track.name}`,
      }),
    );

    expect(tracksNow()).toHaveLength(1);

    undo();

    const restored = tracksNow();
    expect(restored).toHaveLength(2);
    // The placements came back with it. One gesture, one step: a second undo
    // must not be needed to get the blocks.
    expect(restored[1].placements).toHaveLength(2);
    expect(restored[1].name).toBe('Lead');
  });

  it('cancels without touching the track', async () => {
    const user = userEvent.setup();
    const patternId = seedPattern('Riff');
    const added = addTrack('Lead');
    if (!added.ok) throw new Error(added.reason);
    place(patternId, added.value.id, 0);
    render(<ArrangementGrid mode={MODE} />);
    const track = tracksNow()[1];

    await user.click(
      within(headerFor(track)).getByRole('button', { name: `Remove ${track.name}` }),
    );
    await user.click(
      within(headerFor(track)).getByRole('button', {
        name: `Cancel, keep ${track.name} as it is`,
      }),
    );

    expect(tracksNow()).toHaveLength(2);
    expect(tracksNow()[1].placements).toHaveLength(1);
  });

  it('removes an empty track without asking — there is nothing to lose', async () => {
    const user = userEvent.setup();
    addTrack('Scratch');
    render(<ArrangementGrid mode={MODE} />);
    const track = tracksNow()[1];

    await user.click(
      within(headerFor(track)).getByRole('button', { name: `Remove ${track.name}` }),
    );

    expect(tracksNow()).toHaveLength(1);
  });

  it('states why the last remaining track cannot go', async () => {
    const user = userEvent.setup();
    render(<ArrangementGrid mode={MODE} />);
    const [track] = tracksNow();

    await user.click(
      within(headerFor(track)).getByRole('button', { name: `Remove ${track.name}` }),
    );

    expect(tracksNow()).toHaveLength(1);
    expect(trackAlert()).toHaveTextContent(/zero tracks/i);
  });

  it('asks nothing when the last track is also the one with blocks on it', async () => {
    // The press goes STRAIGHT to the seam: a confirmation whose only honest
    // answer is "no" teaches people to click through confirmations. The
    // sentence rendered is the seam's own, not a second authoring of it.
    const user = userEvent.setup();
    const patternId = seedPattern('Riff');
    place(patternId, tracksNow()[0].id, 0);
    render(<ArrangementGrid mode={MODE} />);
    const [track] = tracksNow();

    await user.click(
      within(headerFor(track)).getByRole('button', { name: `Remove ${track.name}` }),
    );

    expect(
      within(headerFor(track)).queryByText(/delete 1 block\?/i),
    ).not.toBeInTheDocument();
    expect(tracksNow()[0].placements).toHaveLength(1);
    expect(trackAlert()).toHaveTextContent(/zero tracks/i);
  });

  it('refuses at the seam too, not only at the button', () => {
    const [track] = tracksNow();

    const refused = removeTrack(track.id);

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toMatch(/zero tracks/i);
    expect(removeTrack('no-such-track')).toEqual({ ok: false, reason: 'No such track.' });
  });
});

// --------------------------------------------------------------- reorder ---

describe('reordering', () => {
  beforeEach(() => {
    openBlankComposition('Song');
    addTrack('Second');
    addTrack('Third');
  });

  it('moves a track by id and index, without a pointer anywhere near it', () => {
    // The agent's route. If reorder were drag-only it could not rearrange
    // tracks at all, which is a defect rather than a style question.
    const [first, second, third] = tracksNow();

    expect(moveTrack(third.id, 0)).toEqual({ ok: true, value: 0 });

    expect(tracksNow().map((t) => t.id)).toEqual([third.id, first.id, second.id]);
  });

  it('clamps an index past the end rather than refusing it', () => {
    const [first] = tracksNow();

    expect(moveTrack(first.id, 99)).toEqual({ ok: true, value: 2 });

    expect(tracksNow().map((t) => t.name)).toEqual(['Second', 'Third', first.name]);
  });

  it('clamps a negative index to the top rather than splicing from the end', () => {
    // Without the lower clamp `splice(-5, 0, …)` counts BACK from the end, so a
    // negative index lands the track at an arbitrary position and still reports
    // success. The name is the assertion: `-5` means "the top".
    const [first, , third] = tracksNow();

    expect(moveTrack(third.id, -5)).toEqual({ ok: true, value: 0 });

    expect(tracksNow().map((t) => t.name)).toEqual(['Third', first.name, 'Second']);
  });

  it('reports an unknown track and an unusable index', () => {
    expect(moveTrack('nope', 0)).toEqual({ ok: false, reason: 'No such track.' });
    const [first] = tracksNow();
    expect(moveTrack(first.id, Number.NaN)).toEqual({
      ok: false,
      reason: 'That is not a track position.',
    });
  });

  it('writes no undo step for a move that changes nothing', () => {
    const patternId = seedPattern('Riff');
    const [first] = tracksNow();
    place(patternId, first.id, 0);

    expect(moveTrack(first.id, 0)).toEqual({ ok: true, value: 0 });
    undo();

    // The undo landed on the placement, not on a phantom reorder step.
    expect(tracksNow()[0].placements).toHaveLength(0);
  });

  it('drives the header buttons through the seam, and undoes', async () => {
    const user = userEvent.setup();
    render(<ArrangementGrid mode={MODE} />);
    const before = tracksNow().map((t) => t.name);
    const track = tracksNow()[2];

    await user.click(
      within(headerFor(track)).getByRole('button', { name: `Move ${track.name} up` }),
    );

    expect(tracksNow().map((t) => t.name)).toEqual([before[0], before[2], before[1]]);

    undo();

    expect(tracksNow().map((t) => t.name)).toEqual(before);
  });

  it('disables the arrows at the ends of the stack', () => {
    render(<ArrangementGrid mode={MODE} />);
    const tracks = tracksNow();

    const top = within(headerFor(tracks[0]));
    expect(top.getByRole('button', { name: `Move ${tracks[0].name} up` })).toBeDisabled();
    expect(top.getByRole('button', { name: `Move ${tracks[0].name} down` })).toBeEnabled();

    const bottom = within(headerFor(tracks[2]));
    expect(bottom.getByRole('button', { name: `Move ${tracks[2].name} down` })).toBeDisabled();
  });

  it('carries the placements with the track it moves', () => {
    const patternId = seedPattern('Riff');
    const [, second] = tracksNow();
    place(patternId, second.id, 4 * PPQ);

    moveTrack(second.id, 0);

    const moved = tracksNow()[0];
    expect(moved.id).toBe(second.id);
    expect(moved.placements).toHaveLength(1);
    expect(moved.placements[0].startTick).toBe(4 * PPQ);
  });
});

// ---------------------------------------------------------------- rename ---

describe('renaming', () => {
  beforeEach(() => openBlankComposition('Song'));

  it('commits a draft to the seam on Enter', async () => {
    const user = userEvent.setup();
    render(<ArrangementGrid mode={MODE} />);
    const track = tracksNow()[0];

    await user.click(
      within(headerFor(track)).getByRole('button', { name: `Rename track ${track.name}` }),
    );
    const field = within(headerFor(track)).getByRole('textbox', {
      name: `Rename ${track.name}`,
    });
    await user.clear(field);
    await user.type(field, 'Rhythm{Enter}');

    expect(tracksNow()[0].name).toBe('Rhythm');
    // Back to the plate, which now names the track it was renamed to.
    expect(
      screen.getByRole('button', { name: 'Select track Rhythm' }),
    ).toBeInTheDocument();
  });

  it('abandons the draft on Escape, and writes nothing', async () => {
    const user = userEvent.setup();
    render(<ArrangementGrid mode={MODE} />);
    const track = tracksNow()[0];
    const original = track.name;

    await user.click(
      within(headerFor(track)).getByRole('button', { name: `Rename track ${original}` }),
    );
    await user.type(
      within(headerFor(track)).getByRole('textbox', { name: `Rename ${original}` }),
      'Junk{Escape}',
    );

    expect(tracksNow()[0].name).toBe(original);
    expect(
      screen.getByRole('button', { name: `Select track ${original}` }),
    ).toBeInTheDocument();
  });

  it('drops an empty name instead of writing one', async () => {
    const user = userEvent.setup();
    render(<ArrangementGrid mode={MODE} />);
    const track = tracksNow()[0];
    const original = track.name;

    await user.click(
      within(headerFor(track)).getByRole('button', { name: `Rename track ${original}` }),
    );
    const field = within(headerFor(track)).getByRole('textbox', {
      name: `Rename ${original}`,
    });
    await user.clear(field);
    await user.type(field, '   {Enter}');

    // A nameless track is a blank plate and an unlabelled lane. Clearing a
    // field and pressing Enter does not mean "call it nothing".
    expect(tracksNow()[0].name).toBe(original);
  });

  it('refuses a blank name at the seam, where the agent reaches it', () => {
    // The field DROPS an emptied draft; the rule itself lives at the seam, for
    // `addTrack`'s reason — a rule only a control enforces is one the agent
    // walks straight past, and a blank name blanks every accessible name in the
    // header along with the plate.
    const [track] = tracksNow();

    expect(setTrackName(track.id, '   ')).toEqual({ ok: false, reason: 'A track needs a name.' });
    expect(tracksNow()[0].name).toBe(track.name);
    expect(setTrackName('nope', 'Rhythm')).toEqual({ ok: false, reason: 'No such track.' });
  });

  it('trims the name it stores', () => {
    const [track] = tracksNow();

    expect(setTrackName(track.id, '  Rhythm  ')).toEqual({ ok: true, value: undefined });

    expect(tracksNow()[0].name).toBe('Rhythm');
  });

  it('commits a draft on blur, not only on Enter', async () => {
    const user = userEvent.setup();
    render(<ArrangementGrid mode={MODE} />);
    const track = tracksNow()[0];

    await user.click(
      within(headerFor(track)).getByRole('button', { name: `Rename track ${track.name}` }),
    );
    const field = within(headerFor(track)).getByRole('textbox', {
      name: `Rename ${track.name}`,
    });
    await user.clear(field);
    await user.type(field, 'Rhythm');
    await user.tab();

    expect(tracksNow()[0].name).toBe('Rhythm');
  });

  it('takes the rename button away while the field is open', async () => {
    const user = userEvent.setup();
    render(<ArrangementGrid mode={MODE} />);
    const track = tracksNow()[0];

    await user.click(
      within(headerFor(track)).getByRole('button', { name: `Rename track ${track.name}` }),
    );

    // Not merely inert: pressing it mid-edit would blur-commit the draft and
    // then reopen the field on the name it had BEFORE that commit, which is a
    // rename that silently undoes itself.
    expect(
      within(headerFor(track)).queryByRole('button', { name: `Rename track ${track.name}` }),
    ).not.toBeInTheDocument();
  });
});

// ------------------------------------------------------------ instrument ---

describe('changing a track’s instrument', () => {
  beforeEach(() => openBlankComposition('Song'));

  it('applies straight away when nothing would be stranded', async () => {
    const user = userEvent.setup();
    // A riff written on the bottom four strings fits a bass. Nothing is lost,
    // so nothing is asked.
    const patternId = seedPattern('Low riff', [0, 1, 2, 3]);
    place(patternId, tracksNow()[0].id, 0);
    render(<ArrangementGrid mode={MODE} />);
    const track = tracksNow()[0];

    await user.selectOptions(
      within(headerFor(track)).getByRole('combobox', {
        name: `Instrument for ${track.name}`,
      }),
      'bass',
    );

    expect(tracksNow()[0].instrumentId).toBe('bass');
  });

  it('asks before stranding notes on strings the new instrument hasn’t got', async () => {
    const user = userEvent.setup();
    // Two notes on strings 4 and 5 — a bass has neither.
    const patternId = seedPattern('High riff', [0, 4, 5]);
    place(patternId, tracksNow()[0].id, 0);
    render(<ArrangementGrid mode={MODE} />);
    const track = tracksNow()[0];

    await user.selectOptions(
      within(headerFor(track)).getByRole('combobox', {
        name: `Instrument for ${track.name}`,
      }),
      'bass',
    );

    // Not applied yet. Silently allowing it is the one wrong answer.
    expect(tracksNow()[0].instrumentId).toBe('guitar');
    // The confirmation NAMES the instrument being confirmed: the picker is
    // controlled on the stored value, so it has already snapped back to
    // "Guitar", and a bare count would be a question about nothing on screen.
    expect(
      within(headerFor(track)).getByText(/bass has no string for 2 notes\?/i),
    ).toBeInTheDocument();

    await user.click(
      within(headerFor(track)).getByRole('button', {
        name: `Confirm instrument change for ${track.name}`,
      }),
    );

    // Allowed, because "guitar part, actually wanted it on bass" is a real
    // intent — but never without saying what it costs.
    expect(tracksNow()[0].instrumentId).toBe('bass');
    expect(trackAlert()).toHaveTextContent(/written for another instrument/i);
    // Named there too — "1 block was written for another instrument" is not
    // actionable without knowing which instrument the track is now on.
    expect(trackAlert()).toHaveTextContent(/on bass/i);
  });

  it('leaves the track alone when the confirmation is declined', async () => {
    const user = userEvent.setup();
    const patternId = seedPattern('High riff', [0, 4, 5]);
    place(patternId, tracksNow()[0].id, 0);
    render(<ArrangementGrid mode={MODE} />);
    const track = tracksNow()[0];

    await user.selectOptions(
      within(headerFor(track)).getByRole('combobox', {
        name: `Instrument for ${track.name}`,
      }),
      'bass',
    );
    await user.click(
      within(headerFor(track)).getByRole('button', {
        name: `Cancel, keep ${track.name} as it is`,
      }),
    );

    expect(tracksNow()[0].instrumentId).toBe('guitar');
    // The picker shows what will actually be heard again, not the abandoned
    // choice: it renders the RESOLVED instrument rather than local state.
    expect(
      within(headerFor(track)).getByRole('combobox', {
        name: `Instrument for ${track.name}`,
      }),
    ).toHaveValue('guitar');
  });

  it('keeps saying so afterwards, rather than only at the moment of change', async () => {
    const user = userEvent.setup();
    const patternId = seedPattern('Low riff', [0, 1]);
    place(patternId, tracksNow()[0].id, 0);
    render(<ArrangementGrid mode={MODE} />);
    const track = tracksNow()[0];

    await user.selectOptions(
      within(headerFor(track)).getByRole('combobox', {
        name: `Instrument for ${track.name}`,
      }),
      'bass',
    );

    // A standing fact, not an event: those blocks were authored for a guitar
    // and are now playing through a bass tuning.
    expect(mismatchedPlacements(tracksNow()[0])).toBe(1);
    expect(within(headerFor(track)).getByText(/1 mismatched/i)).toBeInTheDocument();
  });

  it('counts stranded notes against the target instrument’s string count', () => {
    const patternId = seedPattern('Wide riff', [0, 3, 4, 5]);
    place(patternId, tracksNow()[0].id, 0);
    const track = tracksNow()[0];

    // A bass has four strings, so indices 4 and 5 have nowhere to sound.
    expect(strandedByInstrument(track, 'bass')).toBe(2);
    expect(strandedByInstrument(track, 'ukulele')).toBe(2);
    expect(strandedByInstrument(track, 'guitar')).toBe(0);
  });

  it('ignores notes past a truncated block’s own end', () => {
    // A resized placement plays only up to `lengthTicks` — `flattenTrack` cuts
    // there exclusively — so a note beyond the cut is already inaudible and
    // counting it would over-report the cost of a change that costs nothing.
    openBlankPattern('Long riff');
    const pattern = getEditingPattern();
    if (!pattern) throw new Error('pattern seam did not open a pattern');
    stampNote({ stringIndex: 0, fret: 3, tick: 0, durationTicks: PPQ });
    // On a string a bass has not got, but after the first beat.
    stampNote({ stringIndex: 5, fret: 3, tick: 2 * PPQ, durationTicks: PPQ });
    const placementId = place(pattern.id, tracksNow()[0].id, 0);

    expect(strandedByInstrument(tracksNow()[0], 'bass')).toBe(1);

    resizePlacement(placementId, PPQ);

    expect(strandedByInstrument(tracksNow()[0], 'bass')).toBe(0);
  });

  it('keeps a standing badge for notes stranded by any route, not only the picker', async () => {
    // The confirmation is not the only way into a stranded state: dropping a
    // six-string pattern onto a bass track strands two strings and asks
    // nothing. Stranded is the DURABLE defect, so it is a badge — and it takes
    // the status slot from the milder mismatch count.
    const user = userEvent.setup();
    const lowPatternId = seedPattern('Low riff', [0, 1]);
    place(lowPatternId, tracksNow()[0].id, 0);
    render(<ArrangementGrid mode={MODE} />);
    const track = tracksNow()[0];

    await user.selectOptions(
      within(headerFor(track)).getByRole('combobox', {
        name: `Instrument for ${track.name}`,
      }),
      'bass',
    );

    // Nothing stranded yet — a mismatch only.
    expect(within(headerFor(track)).getByText(/1 mismatched/i)).toBeInTheDocument();

    // Now a six-string pattern lands on the bass track, through the placement
    // path rather than the picker.
    const widePatternId = seedPattern('Wide riff', [0, 4, 5]);
    act(() => {
      place(widePatternId, tracksNow()[0].id, 8 * PPQ);
    });

    expect(within(headerFor(track)).getByText(/2 off-instrument/i)).toBeInTheDocument();
    expect(within(headerFor(track)).queryByText(/mismatched/i)).not.toBeInTheDocument();
  });
});

// -------------------------------------------------------- the two strips ---

describe('the message strips', () => {
  beforeEach(() => openBlankComposition('Song'));

  it('shows a gesture refusal and a track refusal at the same time', async () => {
    // They are unrelated events with unrelated causes, and the second must not
    // overwrite the first — which is only checkable because each strip is
    // named. An unnamed pair is two indistinguishable alerts.
    const user = userEvent.setup();
    const patternId = seedPattern('Riff');
    place(patternId, tracksNow()[0].id, 0);
    render(<ArrangementGrid mode={MODE} />);
    const [track] = tracksNow();

    // A split with no cursor anywhere — the gesture strip.
    await user.click(screen.getByRole('button', { name: 'Split at cursor' }));
    // Removing the only track — the track strip.
    await user.click(
      within(headerFor(track)).getByRole('button', { name: `Remove ${track.name}` }),
    );

    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(screen.getByRole('alert', { name: 'Gesture message' })).toHaveTextContent(
      /move the cursor/i,
    );
    expect(trackAlert()).toHaveTextContent(/zero tracks/i);
  });
});
