import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ACOUSTIC_GUITAR_PRESET,
  DEFAULT_PATTERNS_STATE,
  PPQ,
  useMetronomeStore,
  usePatternsStore,
  useVoiceStore,
  type Track,
  type VariantRef,
  type VoicePreset,
} from '@fretwork/lib';
import { ArrangementGrid } from '../src/composition/ArrangementGrid';
import {
  addPlacement,
  addTrack,
  getEditingComposition,
  getTracks,
  openBlankComposition,
  selectPlacements,
  selectTrack,
  setTrackInstrument,
  setTrackVoiceRef,
  undo,
} from '../src/composition/compositionService';
import {
  listSelectableVoices,
  readTrackVoiceRef,
  readVoiceRef,
  resolveTrackVoicePreset,
  selectVoice,
  setTrackVoice,
  trackVoiceRefStatus,
  voiceKey,
} from '../src/voice/voiceService';
import { playComposition, useCompositionPlayback } from '../src/audio/playbackService';
import {
  getEditingPattern,
  openBlankPattern,
  stampNote,
} from '../src/patterns/patternService';

/**
 * CP-13 — per-track voices.
 *
 * TWO TRACKS IN EVERY TEST THAT COULD BE FOOLED BY ONE. The failure this ticket
 * exists to prevent is a picker wired to `voiceService.selectVoice`, which writes
 * the editing PATTERN's ref: with a single track on screen, on the fallback, that
 * can read as "the picker works". Anything asserting that a pick landed also
 * asserts that the OTHER track did not move.
 *
 * jsdom has no Web Audio, so the audio surface is mocked at the module boundary
 * exactly as `MultiTrackPlayback.test.tsx` mocks it — never Tone itself. Nothing
 * here claims two guitar tracks SOUND different; that is the ticket's by-ear
 * acceptance. What is asserted on this side of the boundary is that the engine is
 * asked to build each track's voice from that track's own ref, and that a pick
 * mid-playback reaches exactly one track's voice.
 *
 * The fake `MultiTrackPlayback` mirrors `diffTracks`' documented priority
 * (restream > voice > gain) rather than being inert, because LIB-GAP(18) IS that
 * priority: a track whose placements and voiceRef move in the same update gets
 * restreamed and keeps its old voice, and the seam's explicit `setTrackVoice` is
 * what covers it. An inert fake could not tell the two apart.
 */
const lib = vi.hoisted(() => {
  const startAudio = vi.fn(async () => {});
  const metronome = { start: vi.fn(async () => {}), stop: vi.fn(() => {}) };
  const getTransportTicks = vi.fn(() => 0);

  /** Every voice the engine asked for, with the ref it was asked to build from. */
  const built: Array<{ instrumentId: string; voiceRef: unknown }> = [];
  const buildEffectiveVoice = vi.fn(
    (instrumentId: string, options?: { voiceRef?: unknown }) => {
      built.push({ instrumentId, voiceRef: options?.voiceRef ?? null });
      return {
        voice: {
          dispose: vi.fn(),
          ensureBuilt: vi.fn(),
          setRoutingTarget: vi.fn(),
        },
        preset: {},
      };
    },
  );

  type FakeTrack = {
    id: string;
    placements: unknown;
    voiceRef: unknown;
    instrumentId: string;
  };
  type FakeComposition = { id: string; tracks: readonly FakeTrack[] };
  type Opts = {
    composition: FakeComposition;
    tuning: { id: string; strings: readonly string[] };
    capo: number;
    buildVoice: (track: FakeTrack) => unknown;
  };

  class FakeTrackScheduler {
    onComplete() {
      return () => {};
    }
  }

  class FakeMultiTrackPlayback {
    static instances: FakeMultiTrackPlayback[] = [];

    readonly opts: Opts;
    held: FakeComposition;
    readonly schedulers: FakeTrackScheduler[] = [];
    /** Track ids whose voice was swapped, in order. */
    readonly voiceSwaps: string[] = [];
    disposed = false;

    applyTrackState = vi.fn();
    setLoop = vi.fn();
    setTuning = vi.fn();
    restreamAll = vi.fn();

    setTrackVoice = vi.fn((trackId: string) => {
      // The real one rebuilds through the factory, which is how a per-track ref
      // reaches `buildEffectiveVoice` on a LIVE swap rather than only at build.
      const track = this.held.tracks.find((candidate) => candidate.id === trackId);
      if (!track) return;
      this.voiceSwaps.push(trackId);
      this.opts.buildVoice(track);
    });

    updateComposition = vi.fn((next: FakeComposition) => {
      const previous = this.held;
      this.held = next;
      const sameTracks =
        next.tracks.length === previous.tracks.length &&
        next.tracks.every((track, i) => track.id === previous.tracks[i]?.id);
      if (!sameTracks) return true;
      // `diffTracks`, priority and all: ONE action per track, restream first.
      next.tracks.forEach((track, i) => {
        const before = previous.tracks[i];
        if (!before || track.placements !== before.placements) return;
        if (track.voiceRef !== before.voiceRef || track.instrumentId !== before.instrumentId) {
          this.setTrackVoice(track.id);
        }
      });
      this.applyTrackState();
      return false;
    });

    dispose = vi.fn(() => {
      this.disposed = true;
    });

    constructor(opts: Opts) {
      this.opts = opts;
      this.held = opts.composition;
      for (const track of opts.composition.tracks) {
        opts.buildVoice(track);
        this.schedulers.push(new FakeTrackScheduler());
      }
      FakeMultiTrackPlayback.instances.push(this);
    }

    onTrackActive() {
      return () => {};
    }
  }

  class FakeScheduler {
    setStream = vi.fn();
    setLoop = vi.fn();
    setInstrument = vi.fn();
    previewCell = vi.fn();
    dispose = vi.fn();
    onHead() {
      return () => {};
    }
    onActive() {
      return () => {};
    }
    onComplete() {
      return () => {};
    }
  }

  return {
    built,
    startAudio,
    metronome,
    getTransportTicks,
    buildEffectiveVoice,
    FakeMultiTrackPlayback,
    FakeScheduler,
    reset() {
      built.length = 0;
      FakeMultiTrackPlayback.instances.length = 0;
      vi.clearAllMocks();
    },
  };
});

// Only the audio surface is replaced. The voice store, `resolveActiveVoice`, the
// composition store and `composition-ops` all stay real, so a per-track ref is
// resolved here exactly as the app resolves it.
vi.mock('@fretwork/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fretwork/lib')>();
  return {
    ...actual,
    startAudio: lib.startAudio,
    useMetronome: () => ({ metronome: lib.metronome }),
    getTransportTicks: lib.getTransportTicks,
    buildEffectiveVoice: lib.buildEffectiveVoice,
    MultiTrackPlayback: lib.FakeMultiTrackPlayback,
    EventScheduler: lib.FakeScheduler,
  };
});

// ------------------------------------------------------------------ fixtures ---

const BAR = 4 * PPQ;
const MODE = 'pattern' as const;

/** A built-in guitar voice — the picker's own first offer, so the write and the
 *  offer set are the same set by construction. */
function builtInVoice(index = 0): { ref: VariantRef; name: string } {
  const option = listSelectableVoices('guitar').builtIns[index];
  if (!option) throw new Error('the lib offers no built-in guitar voices');
  return { ref: option.ref, name: option.name };
}

/** A user variant, so a track can point at a preset no built-in slot holds. */
function userVoice(name: string, instrumentId: 'guitar' | 'bass' = 'guitar'): VariantRef {
  const preset: VoicePreset = { ...ACOUSTIC_GUITAR_PRESET, name, instrumentId };
  const id = useVoiceStore.getState().addVariant({
    name,
    instrumentId,
    family: ACOUSTIC_GUITAR_PRESET.family,
    collectionId: null,
    preset,
  });
  if (!id) throw new Error('the voice store refused the fixture variant');
  return { kind: 'user', id };
}

function seedPattern(name: string, strings: readonly number[] = [0]): string {
  openBlankPattern(name);
  const pattern = getEditingPattern();
  if (!pattern) throw new Error('pattern seam did not open a pattern');
  for (const stringIndex of strings) {
    stampNote({ stringIndex, fret: 3, tick: 0, durationTicks: BAR });
  }
  return pattern.id;
}

function place(patternId: string, trackId: string, atTick = 0): string {
  const result = addPlacement(patternId, trackId, atTick);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

/** Two tracks on the SAME instrument — the only shape that can catch the
 *  `selectVoice` trap. */
function twoTracks(): readonly Track[] {
  // Idempotent, as the `ensureComposition` this replaced was: a helper that
  // CREATES unconditionally would switch away from a composition the test had
  // already opened, and the switch is silent.
  if (!getEditingComposition()) openBlankComposition('Song');
  addTrack('Rhythm');
  return getTracks();
}

function headerFor(track: Track): HTMLElement {
  const header = document.querySelector<HTMLElement>(`[data-track-header="${track.id}"]`);
  if (!header) throw new Error(`no header rendered for ${track.name}`);
  return header;
}

/** The button that OPENS the picker — the voice control the strip shows when it
 *  is closed, and the one that carries the resolved preset in its title. */
const voiceButton = (track: Track) =>
  within(headerFor(track)).getByRole('button', { name: `Voice for ${track.name}` });

const voicePicker = (track: Track) =>
  within(headerFor(track)).getByRole('combobox', { name: `Voice for ${track.name}` });

const instrumentPicker = (track: Track) =>
  within(headerFor(track)).getByRole('combobox', { name: `Instrument for ${track.name}` });

type User = ReturnType<typeof userEvent.setup>;

/** Two `<select>`s do not fit a 200 px header, so the picker is behind a control
 *  that opens. Closing it FLUSHES the coalescing window, which is what makes
 *  every assertion below deterministic without touching timers. */
async function openVoice(user: User, track: Track): Promise<HTMLElement> {
  await user.click(voiceButton(track));
  return voicePicker(track);
}

async function pickVoice(user: User, track: Track, key: string): Promise<void> {
  const picker = await openVoice(user, track);
  await user.selectOptions(picker, key);
  await user.click(
    within(headerFor(track)).getByRole('button', {
      name: `Close the voice picker for ${track.name}`,
    }),
  );
}

beforeEach(() => {
  sessionStorage.clear();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  useVoiceStore.getState().reset();
  useMetronomeStore.setState({ bpm: 90 });
  selectPlacements([]);
  selectTrack(null);
  lib.reset();
});

// --------------------------------------------------------------- the seam ---

describe('the track path in voiceService', () => {
  it('points one track at a voice and leaves the other where it was', () => {
    const tracks = twoTracks();
    const driven = userVoice('Driven');

    const result = setTrackVoice(tracks[0].id, driven);

    expect(result.ok).toBe(true);
    const after = getTracks();
    expect(readTrackVoiceRef(after[0])).toEqual(driven);
    expect(readTrackVoiceRef(after[1])).toBeNull();
    // The whole point of the ticket: same instrument, different voices.
    expect(resolveTrackVoicePreset(after[0]).name).toBe('Driven');
    expect(resolveTrackVoicePreset(after[1]).name).not.toBe('Driven');
  });

  it('gives two tracks on one instrument two different built-ins', () => {
    const tracks = twoTracks();
    const first = builtInVoice(0);
    const second = builtInVoice(1);
    // The lib could in principle ship two slots with the same preset; the
    // assertion below would then hold for a seam that ignored the ref entirely.
    expect(first.name).not.toBe(second.name);

    setTrackVoice(tracks[0].id, first.ref);
    setTrackVoice(tracks[1].id, second.ref);

    const after = getTracks();
    expect(resolveTrackVoicePreset(after[0]).name).toBe(first.name);
    expect(resolveTrackVoicePreset(after[1]).name).toBe(second.name);
  });

  it('is NOT selectVoice — the pattern write moves no track at all', () => {
    const tracks = twoTracks();
    seedPattern('Riff');
    const driven = userVoice('Driven');

    selectVoice(driven);

    // `selectVoice` writes the EDITING PATTERN's ref. It did something…
    const pattern = getEditingPattern();
    expect(pattern && readVoiceRef(pattern)).toEqual(driven);
    // …and that something was not this. Both tracks, because a one-track
    // assertion here cannot distinguish "wrote the wrong thing" from "wrote
    // nothing", and neither can a single-track picker.
    const after = getTracks();
    expect(after.map(readTrackVoiceRef)).toEqual([null, null]);
    expect(resolveTrackVoicePreset(after[0]).name).not.toBe('Driven');
    expect(tracks).toHaveLength(2);
  });

  it('follows the instrument’s global active voice when the ref is null', () => {
    const tracks = twoTracks();
    const driven = userVoice('Driven');
    const other = builtInVoice(1);
    setTrackVoice(tracks[0].id, other.ref);

    // The lib's documented fallback: a null ref resolves through the global
    // `activeVariants` map, which is what the pattern page writes.
    act(() => useVoiceStore.getState().setActiveVariantRef('guitar', driven));

    const after = getTracks();
    expect(resolveTrackVoicePreset(after[1]).name).toBe('Driven');
    // …and a track that HAS picked is not dragged along by it.
    expect(resolveTrackVoicePreset(after[0]).name).toBe(other.name);
  });

  it('clears back to the fallback', () => {
    const tracks = twoTracks();
    setTrackVoice(tracks[0].id, userVoice('Driven'));

    expect(setTrackVoice(tracks[0].id, null).ok).toBe(true);

    expect(readTrackVoiceRef(getTracks()[0])).toBeNull();
  });

  it('is idempotent by VALUE, not by reference', () => {
    const tracks = twoTracks();
    // Two refs that are equal and are not the same object — which is every ref
    // this seam hands out: `listSelectableVoices` mints fresh ones per call and
    // so does `parseVoiceKey`. `compositionService` guards on reference identity
    // by charter, so the value comparison has to happen here or not at all.
    const once = builtInVoice(1).ref;
    const again = builtInVoice(1).ref;
    expect(once).not.toBe(again);

    setTrackVoice(tracks[0].id, once);
    const written = getTracks()[0];
    expect(setTrackVoice(tracks[0].id, again).ok).toBe(true);

    // The same track object: no store write, so no bumped `updatedAt`, no
    // re-render of every subscriber, and — during playback — no `'voice'` from
    // `diffTracks` and no rebuilt sampler for a change that is not a change.
    expect(getTracks()[0]).toBe(written);
  });

  it('does not write null over a track that never had a ref', () => {
    const tracks = twoTracks();
    // `createEmptyTrack` never sets the field, so a fresh track holds `undefined`
    // and `undefined !== null` is a write the reference guard cannot catch.
    const before = getTracks()[0];

    expect(setTrackVoice(before.id, null).ok).toBe(true);

    expect(getTracks()[0]).toBe(before);
    expect(tracks).toHaveLength(2);
  });

  it('refuses in words rather than throwing', () => {
    const tracks = twoTracks();
    const bassVoice = userVoice('Thumpy', 'bass');

    // A variant for another instrument would resolve to a preset for a neck this
    // track has not got — and the picker never offers it, so a write that landed
    // would set a voice the user cannot see from where they are standing.
    const wrongInstrument = setTrackVoice(tracks[0].id, bassVoice);
    const noTrack = setTrackVoice('not-a-track', builtInVoice().ref);
    act(() => useVoiceStore.getState().deleteVariant((bassVoice as { id: string }).id));
    const gone = setTrackVoice(tracks[0].id, { kind: 'user', id: 'deleted-id' });

    expect(wrongInstrument).toEqual({ ok: false, reason: expect.stringContaining('guitar') });
    expect(noTrack).toEqual({ ok: false, reason: 'No such track.' });
    expect(gone).toEqual({ ok: false, reason: expect.stringContaining('no longer') });
    expect(readTrackVoiceRef(getTracks()[0])).toBeNull();
  });
});

// -------------------------------------------------------------- the picker ---

describe('the per-track voice picker', () => {
  it('picks for the track it belongs to and no other', async () => {
    const user = userEvent.setup();
    const tracks = twoTracks();
    const driven = userVoice('Driven');
    render(<ArrangementGrid mode={MODE} />);

    await pickVoice(user, tracks[1], voiceKey(driven));

    const after = getTracks();
    expect(readTrackVoiceRef(after[1])).toEqual(driven);
    // The trap, from the surface: a picker routed through `selectVoice` would
    // leave BOTH of these null and still look right on a one-track page.
    expect(readTrackVoiceRef(after[0])).toBeNull();
    expect(await openVoice(user, after[0])).toHaveValue('');
    expect(await openVoice(user, after[1])).toHaveValue(voiceKey(driven));
  });

  it('offers the shared library, split into built-ins and yours', async () => {
    const user = userEvent.setup();
    const tracks = twoTracks();
    const driven = userVoice('Driven');
    userVoice('Thumpy', 'bass');
    render(<ArrangementGrid mode={MODE} />);

    const picker = await openVoice(user, tracks[0]);
    expect(within(picker).getByRole('option', { name: 'Auto' })).toBeInTheDocument();
    expect(within(picker).getByRole('option', { name: 'Driven' })).toHaveValue(
      voiceKey(driven),
    );
    // A bass variant offered on a guitar track would play on the wrong neck.
    expect(within(picker).queryByRole('option', { name: 'Thumpy' })).toBeNull();
  });

  it('names a voice that has left the library rather than showing nothing', async () => {
    const user = userEvent.setup();
    const tracks = twoTracks();
    const driven = userVoice('Driven') as { kind: 'user'; id: string };
    setTrackVoice(tracks[0].id, driven);
    // `deleteVoice` repairs the editing PATTERN and leaves other holders to the
    // lib's clean fallback, so a track's ref can dangle from two clicks away.
    act(() => useVoiceStore.getState().deleteVariant(driven.id));
    render(<ArrangementGrid mode={MODE} />);

    const picker = await openVoice(user, getTracks()[0]);
    expect(picker).toHaveValue(voiceKey(driven));
    expect(within(picker).getByRole('option', { name: 'Voice deleted' })).toBeDisabled();
    // The track still plays — a dangling ref falls through to exactly what a
    // track with no ref at all resolves to, which is why this is a label rather
    // than a repair.
    expect(resolveTrackVoicePreset(getTracks()[0])).toBe(
      resolveTrackVoicePreset(getTracks()[1]),
    );
  });

  it('does not call a voice for another instrument a deletion', async () => {
    const user = userEvent.setup();
    const tracks = twoTracks();
    const bass = userVoice('Thumpy', 'bass');
    // Straight past `setTrackVoice`, which refuses this — the shape reaches a
    // document through persistence, a hand edit, or an instrument change under a
    // ref the lib did not clear. The seam has to name it for what it is.
    setTrackVoiceRef(tracks[0].id, bass);
    render(<ArrangementGrid mode={MODE} />);

    expect(trackVoiceRefStatus(getTracks()[0])).toBe('wrong-instrument');
    const picker = await openVoice(user, getTracks()[0]);
    expect(within(picker).queryByRole('option', { name: 'Voice deleted' })).toBeNull();
    expect(
      within(picker).getByRole('option', { name: /another instrument/i }),
    ).toBeDisabled();
  });

  it('goes back to Auto, which is a choice rather than an absence', async () => {
    const user = userEvent.setup();
    const tracks = twoTracks();
    setTrackVoice(tracks[0].id, userVoice('Driven'));
    render(<ArrangementGrid mode={MODE} />);

    await pickVoice(user, tracks[0], '');

    expect(readTrackVoiceRef(getTracks()[0])).toBeNull();
  });

  it('says which voice the track is on without being opened', async () => {
    twoTracks();
    const driven = userVoice('Driven');
    render(<ArrangementGrid mode={MODE} />);

    // Both tracks are on the fallback, so both name the instrument's voice…
    expect(voiceButton(getTracks()[1])).toHaveAttribute(
      'title',
      expect.stringContaining('follows this instrument'),
    );

    // …and this is the ONLY subscription that carries a change to the global
    // active variant into the strip: `useSelectableVoices` watches `variants`,
    // which this does not touch, and the composition store does not move at all.
    act(() => useVoiceStore.getState().setActiveVariantRef('guitar', driven));

    await waitFor(() =>
      expect(voiceButton(getTracks()[1])).toHaveAttribute(
        'title',
        expect.stringContaining('Driven'),
      ),
    );
  });

  it('coalesces a walk through the list into one write', async () => {
    const user = userEvent.setup();
    const tracks = twoTracks();
    const first = builtInVoice(0);
    const second = builtInVoice(1);
    render(<ArrangementGrid mode={MODE} />);
    const picker = await openVoice(user, tracks[0]);

    // `fireEvent` rather than `userEvent`, and both in ONE synchronous block, so
    // the assertion below cannot be a race against the real clock: whatever the
    // machine is doing, these two changes are microseconds apart.
    //
    // A closed `<select>` fires `change` per arrow key, and once the page has
    // played every intermediate value is a whole new sampler-backed `Voice`.
    act(() => {
      fireEvent.change(picker, { target: { value: voiceKey(first.ref) } });
      fireEvent.change(picker, { target: { value: voiceKey(second.ref) } });
    });

    expect(readTrackVoiceRef(getTracks()[0])).toBeNull();
    // The draft is on the control even though nothing has been written, so the
    // rate limit is invisible rather than a control that lags the keyboard.
    expect(picker).toHaveValue(voiceKey(second.ref));

    // One write, of the last value — the trailing edge, as `REBUILD_COALESCE_MS`
    // and `WARM_COALESCE_MS` both are.
    await waitFor(() => expect(readTrackVoiceRef(getTracks()[0])).toEqual(second.ref));
  });

  it('writes the pick when the panel closes rather than waiting out the window', async () => {
    const user = userEvent.setup();
    const tracks = twoTracks();
    const driven = userVoice('Driven');
    render(<ArrangementGrid mode={MODE} />);
    const picker = await openVoice(user, tracks[0]);

    act(() => {
      fireEvent.change(picker, { target: { value: voiceKey(driven) } });
    });
    await user.click(
      within(headerFor(tracks[0])).getByRole('button', {
        name: `Close the voice picker for ${tracks[0].name}`,
      }),
    );

    // Flushed by the gesture, not by the clock: a control that opens has an end,
    // and a pick that had not landed by then would look committed and not be.
    expect(readTrackVoiceRef(getTracks()[0])).toEqual(driven);
  });
});

// ------------------------------------------- the instrument-change decision ---

describe('changing the instrument destroys the voice, and says so first', () => {
  it('asks even when nothing would be stranded', async () => {
    const user = userEvent.setup();
    const tracks = twoTracks();
    // Nothing placed, so `strandedByInstrument` is 0 — before CP-13 this change
    // applied silently, and the voice went with it.
    setTrackVoice(tracks[0].id, userVoice('Driven'));
    render(<ArrangementGrid mode={MODE} />);

    await user.selectOptions(instrumentPicker(tracks[0]), 'bass');

    expect(getTracks()[0].instrumentId).toBe('guitar');
    expect(readTrackVoiceRef(getTracks()[0])).not.toBeNull();
    expect(
      within(headerFor(tracks[0])).getByText(/drops this track's voice for good\?/i),
    ).toBeInTheDocument();
  });

  it('keeps the voice when the question is declined', async () => {
    const user = userEvent.setup();
    const tracks = twoTracks();
    const driven = userVoice('Driven');
    setTrackVoice(tracks[0].id, driven);
    render(<ArrangementGrid mode={MODE} />);

    await user.selectOptions(instrumentPicker(tracks[0]), 'bass');
    await user.click(
      within(headerFor(tracks[0])).getByRole('button', {
        name: `Cancel, keep ${tracks[0].name} as it is`,
      }),
    );

    expect(getTracks()[0].instrumentId).toBe('guitar');
    expect(readTrackVoiceRef(getTracks()[0])).toEqual(driven);
  });

  it('applies straight away when the track has no voice of its own', async () => {
    const user = userEvent.setup();
    const tracks = twoTracks();
    render(<ArrangementGrid mode={MODE} />);

    await user.selectOptions(instrumentPicker(tracks[0]), 'bass');

    // A confirmation for a free action is how people learn to click through
    // confirmations — there is nothing to lose here.
    expect(getTracks()[0].instrumentId).toBe('bass');
  });

  it('does not ask about a voice that is already gone', async () => {
    const user = userEvent.setup();
    const tracks = twoTracks();
    const driven = userVoice('Driven') as { kind: 'user'; id: string };
    setTrackVoice(tracks[0].id, driven);
    // The variant goes; the track fell back to the instrument's voice the moment
    // it did. There is nothing left for the write to destroy, and a confirmation
    // for a free action is how people learn to click through confirmations.
    act(() => useVoiceStore.getState().deleteVariant(driven.id));
    render(<ArrangementGrid mode={MODE} />);

    await user.selectOptions(instrumentPicker(getTracks()[0]), 'bass');

    expect(getTracks()[0].instrumentId).toBe('bass');
    expect(
      within(headerFor(tracks[0])).queryByText(/for good\?/i),
    ).toBeNull();
  });

  it('names both costs when the change strands notes as well', async () => {
    const user = userEvent.setup();
    const tracks = twoTracks();
    const patternId = seedPattern('High riff', [0, 4, 5]);
    place(patternId, tracks[0].id, 0);
    setTrackVoice(tracks[0].id, userVoice('Driven'));
    render(<ArrangementGrid mode={MODE} />);

    await user.selectOptions(instrumentPicker(tracks[0]), 'bass');

    const question = within(headerFor(tracks[0])).getByText(/bass has no string for 2 notes/i);
    expect(question).toHaveTextContent(/drops this voice for good\?/i);
  });

  it('undo does not bring the voice back — the decision, as implemented', async () => {
    const user = userEvent.setup();
    const tracks = twoTracks();
    const patternId = seedPattern('Riff');
    setTrackVoice(tracks[0].id, userVoice('Driven'));
    // An undoable arrangement edit, captured while the override was still set.
    place(patternId, tracks[0].id, 0);
    render(<ArrangementGrid mode={MODE} />);

    await user.selectOptions(instrumentPicker(tracks[0]), 'bass');
    await user.click(
      within(headerFor(tracks[0])).getByRole('button', {
        name: `Confirm instrument change for ${tracks[0].name}`,
      }),
    );
    expect(readTrackVoiceRef(getTracks()[0])).toBeNull();

    act(() => undo());

    // The undo landed…
    expect(getTracks()[0].placements).toHaveLength(0);
    // …and `mergeSettingsForward` carried the CLEARED ref forward over it, which
    // is why the confirmation above has to exist. Removing `voiceRef` from that
    // merge is the rejected alternative — see `setTrackInstrument`.
    expect(readTrackVoiceRef(getTracks()[0])).toBeNull();
    expect(getTracks()[0].instrumentId).toBe('bass');
  });
});

// ------------------------------------------------------------- to the engine ---

function CompositionProbe() {
  useCompositionPlayback();
  return null;
}

const engine = () => lib.FakeMultiTrackPlayback.instances.at(-1)!;

async function start(): Promise<void> {
  await act(async () => {
    const result = await playComposition();
    if (!result.ok) throw new Error(result.reason);
  });
}

describe('per-track voices reach the engine', () => {
  it('builds each track from its OWN ref, and the fallback from null', async () => {
    const tracks = twoTracks();
    const patternId = seedPattern('Riff');
    place(patternId, tracks[0].id, 0);
    place(patternId, tracks[1].id, BAR);
    const driven = userVoice('Driven');
    setTrackVoice(tracks[1].id, driven);
    render(<CompositionProbe />);

    await start();

    // One voice per track, in track order. Track 0 has no ref of its own and so
    // is built with null — the lib's documented fallback, not a missing value.
    expect(lib.built).toEqual([
      { instrumentId: 'guitar', voiceRef: null },
      { instrumentId: 'guitar', voiceRef: driven },
    ]);
  });

  it('swaps exactly one track’s voice when a pick lands mid-playback', async () => {
    const tracks = twoTracks();
    const patternId = seedPattern('Riff');
    place(patternId, tracks[0].id, 0);
    place(patternId, tracks[1].id, BAR);
    render(<CompositionProbe />);
    await start();
    const running = engine();
    const driven = userVoice('Driven');

    await act(async () => {
      setTrackVoice(tracks[1].id, driven);
    });

    // Audible without a restart: the engine rebuilds that one voice and hands it
    // to that one scheduler, and the other track is not touched.
    expect(running.voiceSwaps).toEqual([tracks[1].id]);
    expect(lib.built.at(-1)).toEqual({ instrumentId: 'guitar', voiceRef: driven });
    // Not a rebuild of the whole path, and not a stop.
    expect(lib.FakeMultiTrackPlayback.instances).toHaveLength(1);
    expect(running.disposed).toBe(false);
  });

  it('swaps it even when the same update also moved the track’s blocks', async () => {
    const tracks = twoTracks();
    const patternId = seedPattern('Riff');
    place(patternId, tracks[0].id, 0);
    place(patternId, tracks[1].id, BAR);
    render(<CompositionProbe />);
    await start();
    const running = engine();
    const driven = userVoice('Driven');

    // Two seam writes in ONE React tick, which the agent's tools produce
    // routinely. The engine's own diff picks one action per track and restream
    // outranks voice, so without LIB-GAP(18)'s explicit swap this track would
    // keep playing the old voice with nothing to notice it by.
    await act(async () => {
      place(patternId, tracks[1].id, 2 * BAR);
      setTrackVoice(tracks[1].id, driven);
    });

    expect(running.voiceSwaps).toEqual([tracks[1].id]);
    expect(lib.built.at(-1)).toEqual({ instrumentId: 'guitar', voiceRef: driven });
  });

  it('does not rebuild a voice for a change that left the ref alone', async () => {
    const tracks = twoTracks();
    const patternId = seedPattern('Riff');
    place(patternId, tracks[0].id, 0);
    place(patternId, tracks[1].id, BAR);
    render(<CompositionProbe />);
    await start();
    const running = engine();

    await act(async () => {
      place(patternId, tracks[0].id, 2 * BAR);
    });

    // A rebuild is one `Tone.Sampler` and an HTTP load per bank; doing it for
    // every arrangement edit is how a drag becomes a fetch storm.
    expect(running.voiceSwaps).toEqual([]);
  });

  it('rebuilds a track’s voice when its instrument changes', async () => {
    const tracks = twoTracks();
    const patternId = seedPattern('Riff');
    place(patternId, tracks[0].id, 0);
    place(patternId, tracks[1].id, BAR);
    render(<CompositionProbe />);
    await start();
    const running = engine();

    await act(async () => {
      setTrackInstrument(tracks[1].id, 'bass');
    });

    expect(running.voiceSwaps).toEqual([tracks[1].id]);
    // The lib clears the override as part of that write, so what gets built is
    // the new instrument's fallback.
    expect(lib.built.at(-1)).toEqual({ instrumentId: 'bass', voiceRef: null });
  });

  it('rebuilds it when the instrument moved in the same update as the blocks', async () => {
    const tracks = twoTracks();
    const patternId = seedPattern('Riff');
    place(patternId, tracks[0].id, 0);
    place(patternId, tracks[1].id, BAR);
    render(<CompositionProbe />);
    await start();
    const running = engine();

    // LIB-GAP(18)'s OTHER half, and it needs no override to exist: restream
    // outranks voice in `diffTracks`, so a track that gains a block and changes
    // instrument in one tick keeps the old instrument's voice — a guitar part
    // still playing through a guitar after being moved to a bass.
    await act(async () => {
      place(patternId, tracks[1].id, 2 * BAR);
      setTrackInstrument(tracks[1].id, 'bass');
    });

    expect(running.voiceSwaps).toEqual([tracks[1].id]);
    expect(lib.built.at(-1)).toEqual({ instrumentId: 'bass', voiceRef: null });
  });

  it('does not rebuild for a pick that re-states the voice already set', async () => {
    const tracks = twoTracks();
    const patternId = seedPattern('Riff');
    place(patternId, tracks[0].id, 0);
    place(patternId, tracks[1].id, BAR);
    const driven = userVoice('Driven');
    render(<CompositionProbe />);
    await start();
    const running = engine();

    await act(async () => {
      setTrackVoice(tracks[1].id, driven);
    });
    await act(async () => {
      // Equal by value, a different object — which is what `listSelectableVoices`
      // and `parseVoiceKey` hand out, and what `diffTracks` would read as a
      // change. A second sampler load, and the track silent until it decodes.
      setTrackVoice(tracks[1].id, { ...driven });
    });

    expect(running.voiceSwaps).toEqual([tracks[1].id]);
  });
});
