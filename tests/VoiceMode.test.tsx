import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_PATTERNS_STATE,
  PPQ,
  useMetronomeStore,
  usePatternsStore,
  useVoiceStore,
  type Track,
} from '@fretwork/lib';
import { App } from '../src/App';
import { ArrangementGrid } from '../src/composition/ArrangementGrid';
import {
  addPlacement,
  addTrack,
  getEditingComposition,
  getTracks,
  openBlankComposition,
  selectPlacements,
  selectTrack,
} from '../src/composition/compositionService';
import { listSelectableVoices, setTrackVoice } from '../src/voice/voiceService';
import {
  DEFAULT_OPEN_SECTIONS,
  PARAM_SECTIONS,
  type SectionId,
} from '../src/voice/paramSchema';
import {
  addTrackVoiceSection,
  clearTrackVoiceDrafts,
  discardTrackVoiceDraft,
  isTrackVoiceDirty,
  removeTrackVoiceSection,
  setTrackVoiceParam,
  trackVoicePreset,
} from '../src/voice/trackVoiceDrafts';
import { playComposition, useCompositionPlayback } from '../src/audio/playbackService';
import { getAtPath } from '../src/voice/presetPaths';
import {
  getEditingPattern,
  openBlankPattern,
  stampNote,
} from '../src/patterns/patternService';

/**
 * CP-14 — voice mode: a rack per track.
 *
 * TWO TRACKS EVERYWHERE, for CP-13's reason and one more. A rack wired to a
 * single shared working copy — the shape the pattern page has — would look
 * entirely correct on a one-track page and would move both tracks' tone with one
 * knob on a two-track one. Anything asserting that an edit landed also asserts
 * that the other track did not move.
 *
 * jsdom has no Web Audio, so the audio surface is mocked at the module boundary
 * exactly as `MultiTrackPlayback.test.tsx` and `PerTrackVoices.test.tsx` do —
 * never Tone itself. `Voice` is faked HERE and is not in those files, because a
 * draft is a preset no variant holds: `playbackService.buildTrackVoice`
 * constructs it directly rather than through `buildEffectiveVoice`, and the two
 * recorders below are what tell "built from this track's unsaved edit" apart
 * from "built from its stored ref".
 *
 * jsdom also has no LAYOUT — every box is 0×0 and nothing scrolls — so nothing
 * here asserts that a rack fits its row or that two are visible at once. CP-16
 * is largely a BY-EYE ticket for that reason, and it deleted the arithmetic that
 * used to stand in for the eye (`DEFAULT_LANE_HEIGHTS.voice`), because that
 * number was ~40 px short of the real content and no test could say so. What is
 * asserted below is the STRUCTURE that makes the layout right — the stages are
 * siblings in one column in schema order, a row holds its own header, per-section
 * folds round-trip — and, for the mode this risks regressing, that pattern mode's
 * two clipped viewports still come back in step.
 */
const lib = vi.hoisted(() => {
  const startAudio = vi.fn(async () => {});
  const metronome = { start: vi.fn(async () => {}), stop: vi.fn(() => {}) };
  const getTransportTicks = vi.fn(() => 0);

  /** Voices built from a stored REF, through the lib's own builder. */
  const builtFromRef: Array<{ instrumentId: string; voiceRef: unknown }> = [];
  /** Voices built from an unsaved DRAFT, constructed directly. */
  const builtFromPreset: unknown[] = [];

  const fakeVoice = () => ({
    dispose: vi.fn(),
    ensureBuilt: vi.fn(),
    setRoutingTarget: vi.fn(),
    swapPreset: vi.fn(),
  });

  const buildEffectiveVoice = vi.fn((instrumentId: string, options?: { voiceRef?: unknown }) => {
    builtFromRef.push({ instrumentId, voiceRef: options?.voiceRef ?? null });
    return { voice: fakeVoice(), preset: {} };
  });

  class FakeVoice {
    constructor(preset: unknown) {
      builtFromPreset.push(preset);
      Object.assign(this, fakeVoice());
    }
  }

  type FakeTrack = { id: string; placements: unknown; voiceRef: unknown; instrumentId: string };
  type FakeComposition = { id: string; tracks: readonly FakeTrack[] };
  type Opts = {
    composition: FakeComposition;
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
    /** Track ids whose voice was rebuilt, in order. */
    readonly voiceSwaps: string[] = [];

    applyTrackState = vi.fn();
    setLoop = vi.fn();
    setTuning = vi.fn();
    restreamAll = vi.fn();
    dispose = vi.fn();

    setTrackVoice = vi.fn((trackId: string) => {
      const track = this.held.tracks.find((candidate) => candidate.id === trackId);
      if (!track) return;
      this.voiceSwaps.push(trackId);
      // The real one rebuilds through the factory, which is the only way a
      // draft reaches a LIVE voice — there is no in-place retune on this path
      // (LIB-GAP(19)).
      this.opts.buildVoice(track);
    });

    updateComposition = vi.fn((next: FakeComposition) => {
      const previous = this.held;
      this.held = next;
      const sameTracks =
        next.tracks.length === previous.tracks.length &&
        next.tracks.every((track, i) => track.id === previous.tracks[i]?.id);
      if (!sameTracks) return true;
      next.tracks.forEach((track, i) => {
        const before = previous.tracks[i];
        if (!before || track.placements !== before.placements) return;
        if (track.voiceRef !== before.voiceRef || track.instrumentId !== before.instrumentId) {
          this.setTrackVoice(track.id);
        }
      });
      return false;
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
    builtFromRef,
    builtFromPreset,
    startAudio,
    metronome,
    getTransportTicks,
    buildEffectiveVoice,
    FakeVoice,
    FakeMultiTrackPlayback,
    FakeScheduler,
    reset() {
      builtFromRef.length = 0;
      builtFromPreset.length = 0;
      FakeMultiTrackPlayback.instances.length = 0;
      vi.clearAllMocks();
    },
  };
});

// Only the audio surface is replaced. The voice store, `resolveActiveVoice`, the
// param schema and the composition store all stay real, so a draft is resolved,
// validated and rendered here exactly as the app does it.
vi.mock('@fretwork/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fretwork/lib')>();
  return {
    ...actual,
    startAudio: lib.startAudio,
    useMetronome: () => ({ metronome: lib.metronome }),
    getTransportTicks: lib.getTransportTicks,
    buildEffectiveVoice: lib.buildEffectiveVoice,
    Voice: lib.FakeVoice,
    MultiTrackPlayback: lib.FakeMultiTrackPlayback,
    EventScheduler: lib.FakeScheduler,
  };
});

// ------------------------------------------------------------------ fixtures ---

const BAR = 4 * PPQ;

/** The parameter every test turns. `level` is required on every preset, so this
 *  path resolves against any voice the lib hands back — no fixture can make the
 *  Level stage absent, which is what makes it the safe one to assert on. */
const VOLUME_PATH = 'level.volumeDb';

function twoTracks(): readonly Track[] {
  // Idempotent, as the `ensureComposition` this replaced was: a helper that
  // CREATES unconditionally would switch away from a composition the test had
  // already opened, and the switch is silent.
  if (!getEditingComposition()) openBlankComposition('Song');
  addTrack('Rhythm');
  return getTracks();
}

function seedPattern(name: string): string {
  openBlankPattern(name);
  const pattern = getEditingPattern();
  if (!pattern) throw new Error('pattern seam did not open a pattern');
  stampNote({ stringIndex: 0, fret: 3, tick: 0, durationTicks: BAR });
  return pattern.id;
}

function place(patternId: string, trackId: string, atTick = 0): void {
  const result = addPlacement(patternId, trackId, atTick);
  if (!result.ok) throw new Error(result.reason);
}

const volumeOf = (track: Track): unknown => getAtPath(trackVoicePreset(track), VOLUME_PATH);

/** One stage of one track's rack. The landmark IS the disambiguation: eight
 *  racks put eight sliders called "Volume" on the page, and `RackFace`'s region
 *  name is what tells them apart — for a screen reader and for this file. */
const stage = (track: Track, section: string) =>
  within(screen.getByRole('region', { name: `${track.name} ${section}` }));

const knob = (track: Track, section: string, name: string) =>
  stage(track, section).getByRole('slider', { name });

/**
 * What a rack nobody has touched has FOLDED: everything the schema does not name
 * in `DEFAULT_OPEN_SECTIONS`. Derived rather than listed for the same reason the
 * rack derives it — a fifth `ParamSection` must not need this file edited.
 */
const DEFAULT_FOLDED = PARAM_SECTIONS.filter(
  (section) => !DEFAULT_OPEN_SECTIONS.includes(section.id),
).map((section) => section.id);

/**
 * Unfold one stage of one rack, idempotently.
 *
 * A rack opens on Amp and Cabinet, exactly as the pattern page's pane does, so
 * Samples and Level start folded — and a folded stage's controls are `hidden`,
 * which puts them out of reach of a role query ON PURPOSE. `Level` is the stage
 * most of this file turns a knob on (it is the one no preset can be missing), so
 * most of them go through here first.
 *
 * `fireEvent` rather than `userEvent` because half the callers are synchronous:
 * this is a plain button and one click is the whole gesture.
 */
/**
 * Voice mode with the per-stage folds actually WIRED.
 *
 * `TrackVoiceRack` is controlled all the way up — `App` holds the folds, because
 * the rack unmounts on every mode switch and every visit to the pattern page —
 * so a bare `<ArrangementGrid mode="voice" />` has disclosure buttons that
 * report and do nothing. This is the smallest stand-in for `App`, for the tests
 * that need to open a stage before turning something inside it.
 */
function VoiceGrid() {
  const [sections, setSections] = useState<Readonly<Record<string, readonly SectionId[]>>>(
    {},
  );
  return (
    <ArrangementGrid
      mode="voice"
      collapsedRackSections={sections}
      onCollapsedRackSectionsChange={setSections}
    />
  );
}

function openStage(track: Track, section: string): void {
  const button = screen.getByRole('button', {
    name: `${section} stage for ${track.name}`,
  });
  if (button.getAttribute('aria-expanded') === 'false') fireEvent.click(button);
}

/** A rack's own header strip — the disclosure button's row, which carries the
 *  voice name and the Unsaved/Saved word. Not a landmark, so it is reached
 *  through the one named thing in it. */
const strip = (track: Track) =>
  within(
    screen.getByRole('button', { name: `Voice rack for ${track.name}` })
      .parentElement as HTMLElement,
  );

/** The built-in voice with this name. The default guitar voice is `Acoustic
 *  Guitar`, which has no `effects` at all, so any test about an amp or a cabinet
 *  has to put the track on a voice that HAS one rather than assume. */
function voiceNamed(name: string) {
  const found = listSelectableVoices('guitar').builtIns.find(
    (voice) => voice.name === name,
  );
  if (!found) throw new Error(`no built-in guitar voice called ${name}`);
  return found;
}

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  useVoiceStore.getState().reset();
  useMetronomeStore.setState({ bpm: 90 });
  selectPlacements([]);
  selectTrack(null);
  // A module that outlives every unmount also outlives every test in this file.
  clearTrackVoiceDrafts();
  lib.reset();
});

// --------------------------------------------------------------- the seam ---

describe('the per-track voice draft seam', () => {
  it('edits one track and leaves the other exactly where it was', () => {
    const tracks = twoTracks();
    const before = trackVoicePreset(tracks[1]);

    expect(setTrackVoiceParam(tracks[0].id, VOLUME_PATH, -6).ok).toBe(true);

    expect(volumeOf(getTracks()[0])).toBe(-6);
    expect(isTrackVoiceDirty(getTracks()[0])).toBe(true);
    // The failure this ticket is most likely to ship: one working copy shared by
    // every rack. Both halves are asserted — the value AND the dirty flag.
    expect(trackVoicePreset(getTracks()[1])).toBe(before);
    expect(isTrackVoiceDirty(getTracks()[1])).toBe(false);
  });

  it('gives two tracks two independent unsaved tones', () => {
    const tracks = twoTracks();

    setTrackVoiceParam(tracks[0].id, VOLUME_PATH, -6);
    setTrackVoiceParam(tracks[1].id, VOLUME_PATH, 3);

    expect(volumeOf(getTracks()[0])).toBe(-6);
    expect(volumeOf(getTracks()[1])).toBe(3);
  });

  it('refuses in words rather than throwing, and writes nothing', () => {
    const tracks = twoTracks();
    const before = trackVoicePreset(tracks[0]);

    // A number past the schema's declared range. A knob clamps itself; a caller
    // with no pointer hands over whatever it computed, which is the case this
    // guard exists for.
    const tooLoud = setTrackVoiceParam(tracks[0].id, VOLUME_PATH, 900);
    const notAParam = setTrackVoiceParam(tracks[0].id, 'effects.reverb.wet', 0.5);
    const wrongKind = setTrackVoiceParam(tracks[0].id, VOLUME_PATH, 'loud');
    const noTrack = setTrackVoiceParam('not-a-track', VOLUME_PATH, 0);
    const noSuchPack = setTrackVoiceParam(tracks[0].id, 'source.samples', 'nope');

    expect(tooLoud).toEqual({ ok: false, reason: expect.stringContaining('Volume') });
    // Per-voice reverb is deliberately undeclared in `paramSchema`, so the path
    // is refused rather than silently widening the preset with a field the
    // editor cannot honour.
    expect(notAParam).toEqual({ ok: false, reason: expect.stringContaining('not an editable') });
    expect(wrongKind).toEqual({ ok: false, reason: expect.stringContaining('number') });
    expect(noTrack).toEqual({ ok: false, reason: 'No such track.' });
    expect(noSuchPack).toEqual({ ok: false, reason: expect.stringContaining('sample pack') });
    expect(trackVoicePreset(getTracks()[0])).toBe(before);
    expect(isTrackVoiceDirty(getTracks()[0])).toBe(false);
  });

  it('does not mark a track dirty for a control reporting its own value', () => {
    const tracks = twoTracks();
    const current = getAtPath(trackVoicePreset(tracks[0]), VOLUME_PATH);

    expect(setTrackVoiceParam(tracks[0].id, VOLUME_PATH, current).ok).toBe(true);

    // `setAtPath` returns the same object for a no-op write, and a rack that
    // marked itself unsaved on mount would offer a Revert with nothing to
    // revert — and would rebuild a sampler for a change that is not one.
    expect(isTrackVoiceDirty(getTracks()[0])).toBe(false);
  });

  it('retires a draft when the track is pointed at a different voice', () => {
    const tracks = twoTracks();
    const other = listSelectableVoices('guitar').builtIns[1];
    setTrackVoiceParam(tracks[0].id, VOLUME_PATH, -6);
    expect(isTrackVoiceDirty(getTracks()[0])).toBe(true);

    expect(setTrackVoice(tracks[0].id, other.ref).ok).toBe(true);

    // A draft is an edit OF a voice. Following the user onto the next one is how
    // an abandoned edit resurrects — and it would be showing the wrong amp's
    // numbers while doing it.
    expect(isTrackVoiceDirty(getTracks()[0])).toBe(false);
    expect(trackVoicePreset(getTracks()[0]).name).toBe(other.name);
  });

  it('discards back to the stored voice', () => {
    const tracks = twoTracks();
    const stored = trackVoicePreset(tracks[0]);
    setTrackVoiceParam(tracks[0].id, VOLUME_PATH, -6);

    expect(discardTrackVoiceDraft(tracks[0].id).ok).toBe(true);

    expect(trackVoicePreset(getTracks()[0])).toBe(stored);
    expect(isTrackVoiceDirty(getTracks()[0])).toBe(false);
  });

  it('adds a missing stage by seeding the schema’s own fallbacks, and removes it whole', () => {
    const tracks = twoTracks();
    // Whatever the fixture voice ships with, both ends of the round trip are
    // asserted rather than the starting state — `ACOUSTIC_GUITAR_PRESET` has no
    // `effects` object at all, and other built-ins do.
    expect(removeTrackVoiceSection(tracks[0].id, 'amp').ok).toBe(true);
    expect(getAtPath(trackVoicePreset(getTracks()[0]), 'effects.amp')).toBeUndefined();

    expect(addTrackVoiceSection(tracks[0].id, 'amp').ok).toBe(true);

    // Required params only: the optional ones are left out on purpose, because
    // the lib documents its own default for each and writing our guess would
    // turn "unspecified" into a value the user never chose.
    const amp = trackVoicePreset(getTracks()[0]);
    expect(getAtPath(amp, 'effects.amp.preDrive')).toBe(0.3);
    expect(getAtPath(amp, 'effects.amp.bass')).toBe(0);
    expect(getAtPath(amp, 'effects.amp.enabled')).toBeUndefined();
  });

  it('refuses to remove a stage the schema does not mark removable', () => {
    const tracks = twoTracks();

    // `source` is not a branch a voice can be without — changing the source kind
    // is a later slice, and `Samples` declares no `removableBranch`.
    expect(removeTrackVoiceSection(tracks[0].id, 'samples')).toEqual({
      ok: false,
      reason: expect.stringContaining('cannot be removed'),
    });
  });
});

// --------------------------------------------------------------- the racks ---

describe('the rack in a lane', () => {
  it('draws one rack per track, each on its own voice', () => {
    const tracks = twoTracks();
    const mineVoice = listSelectableVoices('guitar').builtIns[0];
    const theirsVoice = listSelectableVoices('guitar').builtIns[1];
    setTrackVoice(tracks[0].id, mineVoice.ref);
    setTrackVoice(tracks[1].id, theirsVoice.ref);
    // The fixture is only a real test of "each on its OWN voice" if the two are
    // different — otherwise every assertion below passes on a shared one.
    expect(theirsVoice.name).not.toBe(mineVoice.name);

    render(<ArrangementGrid mode="voice" />);

    for (const track of getTracks()) {
      expect(
        screen.getByRole('button', { name: `Voice rack for ${track.name}` }),
      ).toBeInTheDocument();
      // Every stage of every track is its own landmark, named for the track.
      for (const section of ['Samples', 'Amp', 'Cabinet', 'Level']) {
        expect(
          screen.getByRole('region', { name: `${track.name} ${section}` }),
        ).toBeInTheDocument();
      }
    }
    // The half of this test's own name that the landmarks cannot carry: the
    // regions follow from the `track` prop alone, and the STORED voice behind
    // each rack is what a single shared working copy would have got wrong.
    // Each name is asked of its OWN strip, so neither can be satisfied by the
    // other rack's.
    expect(strip(tracks[0]).getByText(mineVoice.name)).toBeInTheDocument();
    expect(strip(tracks[1]).getByText(theirsVoice.name)).toBeInTheDocument();
  });

  it('scopes every control id by track, so eight racks keep their labels', () => {
    twoTracks();
    // `Acoustic Guitar` — the default — has no `effects` at all, so both tracks
    // go on a voice that really has a cabinet before asking about its picker.
    const cabbed = voiceNamed('Crunch');
    getTracks().forEach((track) => setTrackVoice(track.id, cabbed.ref));

    render(<ArrangementGrid mode="voice" />);

    // `<label htmlFor>` resolves to whichever element with that id mounted
    // FIRST, so an id built from the schema path alone leaves every rack after
    // the first with nameless toggles and selects — and every other query in
    // this file goes through a region name or an `ariaLabel` and would not
    // notice. Asked of the SECOND rack, by label text, inside its own landmark.
    const first = stage(getTracks()[0], 'Cabinet');
    const second = stage(getTracks()[1], 'Cabinet');
    expect(second.getByLabelText('Cabinet')).toBe(
      second.getByRole('combobox', { name: 'Cabinet' }),
    );
    expect(first.getByLabelText('Cabinet')).not.toBe(second.getByLabelText('Cabinet'));
    // Said again as the ids themselves, because that is the mechanism and a
    // label query can be satisfied by an accessible name that came from
    // somewhere else.
    expect(first.getByRole('combobox', { name: 'Cabinet' }).id).not.toBe(
      second.getByRole('combobox', { name: 'Cabinet' }).id,
    );
    expect(second.getByRole('combobox', { name: 'Cabinet' }).id).toContain(
      getTracks()[1].id,
    );
  });

  it('adds and removes a stage from the rack’s own buttons', async () => {
    const user = userEvent.setup();
    const tracks = twoTracks();
    setTrackVoice(tracks[0].id, voiceNamed('Crunch').ref);
    render(<ArrangementGrid mode="voice" />);

    await user.click(
      screen.getByRole('button', { name: `Remove Amp for ${getTracks()[0].name}` }),
    );

    expect(getAtPath(trackVoicePreset(getTracks()[0]), 'effects.amp')).toBeUndefined();
    // Absent, not bypassed: the branch is gone and the stage says so in words
    // rather than merely going dark.
    expect(stage(getTracks()[0], 'Amp').getByText(/No amp stage/i)).toBeInTheDocument();
    // The other rack took no edit — the buttons are per track, like everything
    // else here.
    expect(isTrackVoiceDirty(getTracks()[1])).toBe(false);

    await user.click(
      screen.getByRole('button', { name: `Add Amp for ${getTracks()[0].name}` }),
    );

    // Seeded from the SCHEMA's own fallbacks, which is what makes the button a
    // way of calling `addTrackVoiceSection` rather than a second authority on
    // what an amp starts as.
    expect(getAtPath(trackVoicePreset(getTracks()[0]), 'effects.amp.preDrive')).toBe(0.3);
  });

  it('turns a knob on one rack without moving the other', () => {
    const tracks = twoTracks();
    render(<VoiceGrid />);
    openStage(tracks[0], 'Level');
    openStage(tracks[1], 'Level');
    const mine = knob(tracks[0], 'Level', 'Volume');
    const theirs = knob(tracks[1], 'Level', 'Volume');
    // Read rather than assumed: the built-in this fixture resolves to is the
    // lib's to change, and a hard-coded start would fail for a reason that has
    // nothing to do with the rack.
    const before = volumeOf(tracks[0]) as number;
    const theirsBefore = theirs.getAttribute('aria-valuenow');

    // Keyboard rather than a drag: jsdom reports every box as 0×0, so a
    // pointer-driven knob turn would be asserting against no geometry at all.
    fireEvent.keyDown(mine, { key: 'ArrowUp' });

    // One arrow key is one `step`, which the SCHEMA declares — the rack knows no
    // ranges of its own.
    expect(volumeOf(getTracks()[0])).toBe(before + 0.5);
    expect(knob(getTracks()[0], 'Level', 'Volume')).toHaveAttribute(
      'aria-valuenow',
      String(before + 0.5),
    );
    expect(knob(getTracks()[1], 'Level', 'Volume')).toHaveAttribute(
      'aria-valuenow',
      theirsBefore,
    );
    expect(isTrackVoiceDirty(getTracks()[1])).toBe(false);
  });

  it('does not let a knob key also transpose the block selection', () => {
    const tracks = twoTracks();
    const patternId = seedPattern('Riff');
    place(patternId, tracks[0].id, 0);
    const placementId = getTracks()[0].placements[0].id;
    // A selection made in pattern mode and still standing — the arrangement's
    // key handler is on `window`, so it hears every key a rack does.
    selectPlacements([placementId]);
    render(<VoiceGrid />);

    openStage(getTracks()[0], 'Level');
    fireEvent.keyDown(knob(getTracks()[0], 'Level', 'Volume'), { key: 'ArrowUp' });

    // ArrowUp transposes the selection a semitone in pattern mode. One press
    // doing two things is the bug `gestures.enabled` exists to prevent, and
    // voice mode needs the same lock edit mode already had.
    expect(getTracks()[0].placements[0].transposeSemitones ?? 0).toBe(0);
    expect(isTrackVoiceDirty(getTracks()[0])).toBe(true);
  });

  it('says which rack is unsaved, and reverts only that one', async () => {
    const user = userEvent.setup();
    const tracks = twoTracks();
    render(<VoiceGrid />);

    openStage(tracks[0], 'Level');
    fireEvent.keyDown(knob(tracks[0], 'Level', 'Volume'), { key: 'ArrowUp' });
    const revert = await screen.findByRole('button', {
      name: `Discard voice changes for ${tracks[0].name}`,
    });
    // Only the edited rack offers one — a Revert on a rack with nothing to
    // revert is a control that cannot say what it would do.
    expect(
      screen.queryByRole('button', { name: `Discard voice changes for ${tracks[1].name}` }),
    ).toBeNull();

    await user.click(revert);

    expect(isTrackVoiceDirty(getTracks()[0])).toBe(false);
  });

  it('hides the ruler and every other statement about time', () => {
    const tracks = twoTracks();
    const patternId = seedPattern('Riff');
    place(patternId, tracks[0].id, 0);
    // A selection standing from pattern mode: its toolbar actions are block
    // edits whose keyboard twins are switched off here with the gesture layer.
    selectPlacements([getTracks()[0].placements[0].id]);

    const view = render(<ArrangementGrid mode="voice" />);
    expect(screen.queryByTestId('arrangement-ruler')).toBeNull();
    // Zoom, snap and the bar count are all quantities of TIME, and so is undo —
    // not because a history is temporal but because ⌘Z is dead in voice mode
    // (`gestures.enabled`), and a live button with no working shortcut is the
    // second, contradicting code path the grid's comment forbids.
    expect(screen.queryByRole('button', { name: 'Zoom in' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Arrangement snap' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Redo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Split at cursor' })).toBeNull();
    expect(screen.queryByText(/bar/)).toBeNull();
    view.unmount();

    // …and every one of them comes back in a mode that has an axis, so this is
    // an assertion about voice mode rather than about the grid being broken.
    render(<ArrangementGrid mode="pattern" />);
    expect(screen.getByTestId('arrangement-ruler')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Arrangement snap' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Split at cursor' })).toBeInTheDocument();
    expect(screen.getByText(/1 bar|bars/)).toBeInTheDocument();
  });

  it('collapses one rack at a time', async () => {
    const user = userEvent.setup();
    const tracks = twoTracks();
    const collapsed: string[][] = [];
    render(
      <ArrangementGrid
        mode="voice"
        collapsedRacks={[]}
        onCollapsedRacksChange={(next) => collapsed.push([...next])}
      />,
    );

    const disclosure = screen.getByRole('button', { name: `Voice rack for ${tracks[0].name}` });
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await user.click(disclosure);

    // Reported UP rather than folded here: the lane's HEIGHT follows this, and
    // only `laneRects` may decide where the next lane starts.
    expect(collapsed).toEqual([[tracks[0].id]]);
  });

  it('shows a folded rack’s strip and nothing else', () => {
    const tracks = twoTracks();

    render(<ArrangementGrid mode="voice" collapsedRacks={[tracks[0].id]} />);

    expect(
      screen.getByRole('button', { name: `Voice rack for ${tracks[0].name}` }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: `${tracks[0].name} Amp` })).toBeNull();
    // Per TRACK: the other rack is untouched by its neighbour folding.
    expect(screen.getByRole('region', { name: `${tracks[1].name} Amp` })).toBeInTheDocument();
  });
});

// ------------------------------------------------------------ CP-16 layout ---

/** The row a track occupies in voice mode — its header AND its rack. The one
 *  thing CP-16 changed structurally: these used to be in two separately-clipped
 *  columns locked together by `style.transform`. */
const row = (track: Track) => {
  const el = document.querySelector<HTMLElement>(`[data-lane-track="${track.id}"]`);
  if (!el) throw new Error(`no row rendered for ${track.name}`);
  return el;
};

describe('the stages stack, and the row fits them', () => {
  it('draws the four stages as siblings in one column, in schema order', () => {
    const tracks = twoTracks();
    render(<ArrangementGrid mode="voice" />);

    const stages = PARAM_SECTIONS.map((section) =>
      screen.getByRole('region', { name: `${tracks[0].name} ${section.label}` }),
    );
    // SIBLINGS, in one parent: CP-14 had them in a horizontally scrolling flex
    // row, and the fix is that they are stacked the way `VoicePane` stacks the
    // same four on the pattern page.
    const column = stages[0].parentElement;
    expect(column).not.toBeNull();
    for (const stage of stages) expect(stage.parentElement).toBe(column);
    // …and in the descriptor table's order, which is the order the pattern page
    // reads in. Asserted as DOM order rather than by index, so a stage moved in
    // the markup fails here.
    expect([...column!.children]).toEqual(stages);

    // jsdom computes no layout, so which WAY that column runs is observable only
    // as the class that decides it. Stated explicitly rather than left implied:
    // this is the assertion that would have caught CP-14, and it is also the one
    // that proves nothing about pixels.
    expect(column!.className).toContain('flex-col');
    expect(column!.className).not.toContain('overflow-auto');
  });

  it('puts a track’s header in the same row as its rack, with no computed height', () => {
    const tracks = twoTracks();
    render(<ArrangementGrid mode="voice" />);

    for (const track of tracks) {
      const mine = row(track);
      // The header is INSIDE the row, not in a separate viewport translated to
      // match it — which is what lets the row be as tall as its content without
      // anything measuring the content.
      expect(mine.querySelector(`[data-track-header="${track.id}"]`)).not.toBeNull();
      expect(
        within(mine).getByRole('button', { name: `Voice rack for ${track.name}` }),
      ).toBeInTheDocument();
      // Normal flow: nothing writes a height, so nothing can disagree with the
      // height the browser gives it.
      expect(mine.style.height).toBe('');
    }

    // The timed layout's machinery is ABSENT rather than hidden: no ruler, no
    // second header column, and no horizontally scrolling lane area — there is
    // no time axis to scroll along.
    expect(screen.queryByTestId('arrangement-ruler')).toBeNull();
    expect(screen.queryByTestId('track-header-column')).toBeNull();
    expect(screen.queryByTestId('arrangement-lanes-scroller')).toBeNull();
    // …and the stack that replaces it answers to the same name, so the lane area
    // is still reachable without a pointer.
    const stack = screen.getByRole('group', { name: 'Arrangement lanes' });
    expect(stack).toBe(screen.getByTestId('arrangement-voice-stack'));
    expect(stack.className).toContain('overflow-x-hidden');
    stack.focus();
    expect(stack).toHaveFocus();
  });

  it('folds one stage of one rack, and says which fold is which', async () => {
    const user = userEvent.setup();
    const tracks = twoTracks();
    const folded: Record<string, readonly SectionId[]>[] = [];
    render(
      <ArrangementGrid
        mode="voice"
        collapsedRackSections={{}}
        onCollapsedRackSectionsChange={(next) => folded.push({ ...next })}
      />,
    );

    // Two levels of disclosure on one page, and the names have to tell them
    // apart — "Voice rack for Rhythm" is the whole rack, this is one stage of it.
    const disclosure = screen.getByRole('button', {
      name: `Amp stage for ${tracks[0].name}`,
    });
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByRole('button', { name: `Voice rack for ${tracks[0].name}` }),
    ).not.toBe(disclosure);

    await user.click(disclosure);

    // Reported UP rather than folded here, for the reason the rack's own
    // collapse is: this outlives the mode switch that unmounts the rack. What
    // travels is the WHOLE folded set, which starts as the schema's default —
    // the caller stores a list, not a diff.
    expect(folded).toEqual([{ [tracks[0].id]: [...DEFAULT_FOLDED, 'amp'] }]);
  });

  it('opens on the same stages the pattern page does', () => {
    const tracks = twoTracks();
    render(<ArrangementGrid mode="voice" collapsedRackSections={{}} />);

    // A rack nobody has touched shows Amp and Cabinet and folds the rest, which
    // is what `VoicePane` has always done with the same four sections. CP-14
    // opened all four, and one open rack is then about a viewport tall — which
    // denies voice mode its own design argument, that TWO tracks' settings are
    // visible at once. jsdom has no layout, so the count is the only part of
    // that an assertion can reach.
    for (const section of PARAM_SECTIONS) {
      expect(
        screen.getByRole('button', { name: `${section.label} stage for ${tracks[0].name}` }),
      ).toHaveAttribute('aria-expanded', String(DEFAULT_OPEN_SECTIONS.includes(section.id)));
    }
  });

  it('remembers a rack whose every stage the user opened', async () => {
    const user = userEvent.setup();
    const tracks = twoTracks();
    let sections: Readonly<Record<string, readonly SectionId[]>> = {};
    const view = render(
      <ArrangementGrid
        mode="voice"
        collapsedRackSections={sections}
        onCollapsedRackSectionsChange={(next) => {
          sections = next;
        }}
      />,
    );

    // Unfolding the LAST folded stage reports an empty list, and empty is not
    // the same as absent: absent means "nobody has touched this rack" and opens
    // on the default. Dropping the empty one would re-fold Samples and Level the
    // moment the user finished opening them.
    for (const id of DEFAULT_FOLDED) {
      const label = PARAM_SECTIONS.find((section) => section.id === id)?.label;
      await user.click(
        screen.getByRole('button', { name: `${label} stage for ${tracks[0].name}` }),
      );
      view.rerender(
        <ArrangementGrid
          mode="voice"
          collapsedRackSections={sections}
          onCollapsedRackSectionsChange={(next) => {
            sections = next;
          }}
        />,
      );
    }

    expect(sections).toEqual({ [tracks[0].id]: [] });
    for (const section of PARAM_SECTIONS) {
      expect(
        screen.getByRole('button', { name: `${section.label} stage for ${tracks[0].name}` }),
      ).toHaveAttribute('aria-expanded', 'true');
    }
  });

  it('hides a folded stage’s controls and keeps the region its button points at', () => {
    const tracks = twoTracks();
    setTrackVoice(tracks[0].id, voiceNamed('Crunch').ref);
    setTrackVoice(tracks[1].id, voiceNamed('Crunch').ref);

    render(
      <ArrangementGrid
        mode="voice"
        collapsedRackSections={{ [getTracks()[0].id]: ['amp'] }}
      />,
    );

    const button = screen.getByRole('button', {
      name: `Amp stage for ${getTracks()[0].name}`,
    });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    // The region stays mounted — `aria-controls` has to point at something that
    // exists — but its controls leave the accessibility tree with it.
    const region = screen.getByRole('region', { name: `${getTracks()[0].name} Amp` });
    expect(document.getElementById(button.getAttribute('aria-controls') ?? '')).not.toBeNull();
    expect(within(region).queryByRole('slider', { name: 'Drive' })).toBeNull();
    // Per TRACK and per STAGE: the neighbour's amp is open, and this rack's own
    // Level stage is untouched.
    expect(stage(getTracks()[1], 'Amp').getByRole('slider', { name: 'Drive' })).toBeInTheDocument();
    expect(knob(getTracks()[0], 'Level', 'Volume')).toBeInTheDocument();
  });
});

// -------------------------------------------------------- what must survive ---

const nav = () => within(screen.getByRole('navigation', { name: 'Editor' }));
const modes = () => within(screen.getByRole('group', { name: 'Composition mode' }));

describe('unsaved tone survives the things that unmount it', () => {
  /** Go to the composition page and into voice mode.
   *
   *  Seeds the composition first: CP-17 stopped the page creating one on
   *  arrival, so these tests would otherwise reach voice mode with no track to
   *  hold a rack. Before `render` would be equivalent — this is where the App's
   *  own navigation starts, so it reads with the thing it enables. */
  async function intoVoiceMode(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    if (getTracks().length === 0) openBlankComposition('Song');
    await user.click(nav().getByRole('button', { name: 'Composition' }));
    await user.click(modes().getByRole('button', { name: 'Voice mode' }));
  }

  it('survives a mode switch and a page round trip', async () => {
    const user = userEvent.setup();
    render(<App />);
    await intoVoiceMode(user);
    const track = getTracks()[0];
    const tuned = (volumeOf(track) as number) + 0.5;

    openStage(track, 'Level');
    fireEvent.keyDown(knob(track, 'Level', 'Volume'), { key: 'ArrowUp' });
    expect(volumeOf(getTracks()[0])).toBe(tuned);

    // (1) A mode switch. Every lane is replaced, so every rack unmounts.
    await user.click(modes().getByRole('button', { name: 'Pattern mode' }));
    expect(screen.queryByRole('region', { name: `${track.name} Level` })).toBeNull();
    await user.click(modes().getByRole('button', { name: 'Voice mode' }));
    expect(volumeOf(getTracks()[0])).toBe(tuned);
    expect(knob(getTracks()[0], 'Level', 'Volume')).toHaveAttribute(
      'aria-valuenow',
      String(tuned),
    );

    // (2) A page round trip. `CompositionPage` unmounts outright, which is the
    // unmount the pattern page's working copy is held in `App` to survive —
    // there are up to eight of these and the engine reads them, so they are held
    // higher still.
    await user.click(nav().getByRole('button', { name: 'Pattern' }));
    await user.click(nav().getByRole('button', { name: 'Composition' }));

    // The mode came back too, which is `App`'s existing rule and the reason a
    // rack is on screen to assert against at all.
    expect(modes().getByRole('button', { name: 'Voice mode' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(volumeOf(getTracks()[0])).toBe(tuned);
    expect(knob(getTracks()[0], 'Level', 'Volume')).toHaveAttribute(
      'aria-valuenow',
      String(tuned),
    );
  });

  it('keeps a folded rack folded across both', async () => {
    const user = userEvent.setup();
    render(<App />);
    await intoVoiceMode(user);
    const track = getTracks()[0];

    await user.click(screen.getByRole('button', { name: `Voice rack for ${track.name}` }));
    expect(screen.queryByRole('region', { name: `${track.name} Amp` })).toBeNull();

    await user.click(modes().getByRole('button', { name: 'Pattern mode' }));
    await user.click(modes().getByRole('button', { name: 'Voice mode' }));
    expect(screen.queryByRole('region', { name: `${track.name} Amp` })).toBeNull();

    await user.click(nav().getByRole('button', { name: 'Pattern' }));
    await user.click(nav().getByRole('button', { name: 'Composition' }));

    expect(
      screen.getByRole('button', { name: `Voice rack for ${track.name}` }),
    ).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps a folded STAGE folded across both', async () => {
    const user = userEvent.setup();
    render(<App />);
    await intoVoiceMode(user);
    const track = getTracks()[0];
    const amp = () => screen.getByRole('button', { name: `Amp stage for ${track.name}` });

    await user.click(amp());
    expect(amp()).toHaveAttribute('aria-expanded', 'false');

    // (1) A mode switch — every row is replaced, so every rack unmounts.
    await user.click(modes().getByRole('button', { name: 'Pattern mode' }));
    await user.click(modes().getByRole('button', { name: 'Voice mode' }));
    expect(amp()).toHaveAttribute('aria-expanded', 'false');

    // (2) A page round trip — `CompositionPage` unmounts outright. The rack's
    // own collapse already had to survive both; a stage inside it is the same
    // promise one level deeper, which is why it is held in the same place.
    await user.click(nav().getByRole('button', { name: 'Pattern' }));
    await user.click(nav().getByRole('button', { name: 'Composition' }));

    expect(amp()).toHaveAttribute('aria-expanded', 'false');
    // The rack around it did NOT fold: two levels of disclosure, two pieces of
    // state, and folding one must not fold the other.
    expect(
      screen.getByRole('button', { name: `Voice rack for ${track.name}` }),
    ).toHaveAttribute('aria-expanded', 'true');
  });

  /**
   * ⚠ THE REGRESSION CP-16 RISKS. Voice mode used to share the timed layout's
   * scroller; now it replaces it, so a visit UNMOUNTS the element the scroll
   * position lives on and a new one is mounted on the way back — and a new
   * element starts at 0 on BOTH axes.
   *
   * `timedScrollLeftRef` carries the time axis across; without it, tuning a rack
   * at bar 40 returns you to bar 1. `timedScrollTopRef` carries WHICH TRACKS were
   * in view; without it, eight edit lanes (8 × 192 px) means tuning track 8's amp
   * returns you to track 1 — and `syncViewports` then translates the header
   * column to agree with it, which is the silent discard `EditMode.test.tsx`
   * guards the pattern↔edit switch against.
   *
   * jsdom neither scrolls nor clamps, so the offsets here are written onto the
   * element by hand and the scroll event raised explicitly — which is exactly
   * what the app's own writes do, and the two viewport transforms are the
   * observable that proves they came back in step.
   */
  it('comes back to the bar AND the track it left, with both viewports on it', () => {
    twoTracks();
    const rulerContent = () => screen.getByTestId('arrangement-ruler-content');
    const headerStack = () => screen.getByTestId('track-header-stack');

    const view = render(<ArrangementGrid mode="pattern" />);
    const before = screen.getByTestId('arrangement-lanes-scroller');
    before.scrollLeft = 480;
    before.scrollTop = 176;
    fireEvent.scroll(before);
    expect(rulerContent().style.transform).toBe('translateX(-480px)');
    expect(headerStack().style.transform).toBe('translateY(-176px)');

    view.rerender(<ArrangementGrid mode="voice" />);
    expect(screen.queryByTestId('arrangement-lanes-scroller')).toBeNull();

    view.rerender(<ArrangementGrid mode="pattern" />);

    const after = screen.getByTestId('arrangement-lanes-scroller');
    // A genuinely new element, or this test would pass on an offset that was
    // never lost — which is the whole thing it exists to check.
    expect(after).not.toBe(before);
    expect(after.scrollLeft).toBe(480);
    expect(after.scrollTop).toBe(176);
    expect(rulerContent().style.transform).toBe('translateX(-480px)');
    expect(headerStack().style.transform).toBe('translateY(-176px)');
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

describe('a rack edit reaches the engine', () => {
  function twoPlayableTracks(): readonly Track[] {
    const tracks = twoTracks();
    const patternId = seedPattern('Riff');
    place(patternId, tracks[0].id, 0);
    place(patternId, tracks[1].id, BAR);
    return getTracks();
  }

  it('builds a track’s voice from its unsaved edit, not from its stored ref', async () => {
    const tracks = twoPlayableTracks();
    setTrackVoiceParam(tracks[0].id, VOLUME_PATH, -6);
    render(<CompositionProbe />);

    await start();

    // Track 0 was constructed directly from the draft — the lib's resolver
    // cannot see a preset no variant holds — and track 1 still went through the
    // lib's builder with its own (null) ref.
    expect(lib.builtFromPreset).toHaveLength(1);
    expect(getAtPath(lib.builtFromPreset[0], VOLUME_PATH)).toBe(-6);
    expect(lib.builtFromRef).toEqual([{ instrumentId: 'guitar', voiceRef: null }]);
  });

  it('retunes exactly one track when a knob moves, and coalesces the drag', async () => {
    const tracks = twoPlayableTracks();
    render(<CompositionProbe />);
    await start();
    const running = engine();

    // Two writes microseconds apart, which is what one knob drag is. A rebuild
    // is a `Tone.Sampler` and an HTTP load per bank (LIB-GAP(19)), so the window
    // has to collapse them into the last value rather than build twice.
    await act(async () => {
      setTrackVoiceParam(tracks[0].id, VOLUME_PATH, -3);
      setTrackVoiceParam(tracks[0].id, VOLUME_PATH, -6);
    });

    await waitFor(() => expect(running.voiceSwaps).toEqual([tracks[0].id]));
    expect(getAtPath(lib.builtFromPreset.at(-1), VOLUME_PATH)).toBe(-6);
    // Not the whole path, and not the other track: the point of the design.
    expect(lib.FakeMultiTrackPlayback.instances).toHaveLength(1);
  });

  it('keeps two tracks’ rebuilds apart inside one coalescing window', async () => {
    const tracks = twoPlayableTracks();
    render(<CompositionProbe />);
    await start();
    const running = engine();

    // Both racks edited inside one window — two knobs under two hands, or an
    // agent setting a pair. A single module-level timer would let the second
    // write cancel the first's rebuild and the first track would keep sounding
    // its old voice, silently and until something else forced a build. The
    // per-track keying is the whole reason `pendingTrackRebuilds` is a Map.
    await act(async () => {
      setTrackVoiceParam(tracks[0].id, VOLUME_PATH, -3);
      setTrackVoiceParam(tracks[1].id, VOLUME_PATH, -9);
    });

    await waitFor(() =>
      expect([...running.voiceSwaps].sort()).toEqual([tracks[0].id, tracks[1].id].sort()),
    );
    const presets = lib.builtFromPreset
      .slice(-2)
      .map((p) => getAtPath(p, VOLUME_PATH) as number);
    expect(presets.slice().sort((a, b) => a - b)).toEqual([-9, -3]);
  });

  it('honours an edit made with no engine standing, on the next build', async () => {
    const tracks = twoPlayableTracks();
    const probe = render(<CompositionProbe />);
    await start();
    // Leaving the composition page stops playback and disposes both engines,
    // deliberately (see `usePlaybackEngine`). So the retune has nothing to
    // retune…
    probe.unmount();

    await act(async () => {
      setTrackVoiceParam(tracks[0].id, VOLUME_PATH, -6);
    });
    // …and must not throw or lose the edit for it. `setTrackVoiceParam` is
    // reachable by id and value with no pointer and no page on screen, so it
    // cannot require one.
    expect(isTrackVoiceDirty(getTracks()[0])).toBe(true);
    lib.builtFromPreset.length = 0;

    render(<CompositionProbe />);
    await start();

    // The next engine is built FROM the draft, which is what makes the drafts
    // store the one source of truth rather than a mirror the engine keeps.
    expect(lib.builtFromPreset).toHaveLength(1);
    expect(getAtPath(lib.builtFromPreset[0], VOLUME_PATH)).toBe(-6);
  });

  it('draws no playhead in voice mode, and one in a mode that has an axis', async () => {
    twoPlayableTracks();
    render(<CompositionProbe />);
    await start();

    // Driven rather than asserted against a stopped transport: `ArrangementPlayhead`
    // returns null whenever `useHeadTick()` is null, so with nothing playing the
    // absence proves nothing and an unconditional playhead would pass.
    const timed = render(<ArrangementGrid mode="pattern" />);
    expect(await screen.findByTestId('arrangement-playhead')).toBeInTheDocument();
    timed.unmount();

    render(<ArrangementGrid mode="voice" />);
    expect(screen.queryByTestId('arrangement-playhead')).toBeNull();
  });

  it('puts the track back on its stored voice when the edit is discarded', async () => {
    const tracks = twoPlayableTracks();
    render(<CompositionProbe />);
    await start();
    const running = engine();
    await act(async () => {
      setTrackVoiceParam(tracks[0].id, VOLUME_PATH, -6);
    });
    await waitFor(() => expect(running.voiceSwaps).toEqual([tracks[0].id]));
    lib.builtFromRef.length = 0;

    await act(async () => {
      discardTrackVoiceDraft(tracks[0].id);
    });

    // The engine is holding a `Voice` built FROM the draft; nothing else would
    // ever tell it to go back, which is why a discard notifies rather than
    // merely deleting.
    await waitFor(() =>
      expect(lib.builtFromRef).toEqual([{ instrumentId: 'guitar', voiceRef: null }]),
    );
  });

  it('does not rebuild anything for an edit that changed no value', async () => {
    const tracks = twoPlayableTracks();
    render(<CompositionProbe />);
    await start();
    const running = engine();
    const current = getAtPath(trackVoicePreset(tracks[0]), VOLUME_PATH) as number;

    await act(async () => {
      setTrackVoiceParam(tracks[0].id, VOLUME_PATH, current);
    });
    // Long enough that a scheduled rebuild would have fired.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(running.voiceSwaps).toEqual([]);
  });
});

/**
 * The pattern page's voice editor shares `paramSchema`, `presetPaths` and every
 * rack component with the racks above, and CP-14 moved two helpers out of it.
 * This is the tripwire for that move: `VoicePane` is a different surface with a
 * different working copy, and it must not have acquired the composition page's.
 */
describe('the pattern page’s voice pane is untouched', () => {
  it('still edits the pattern’s voice and marks itself unsaved', async () => {
    const user = userEvent.setup();
    twoTracks();
    render(<App />);

    // `Level` starts folded on the pattern page — the same section the racks
    // above edit, which is what makes this a real crossing test.
    await user.click(screen.getByRole('button', { name: /Level/ }));
    const slider = screen.getByRole('slider', { name: 'Volume' });
    fireEvent.change(slider, { target: { value: '-6' } });

    expect(screen.getByText('Unsaved')).toBeInTheDocument();
    // …and no track's voice moved with it. `selectVoice` and the working copy
    // are the pattern's; a rack edit is a track's.
    expect(isTrackVoiceDirty(getTracks()[0])).toBe(false);
    expect(isTrackVoiceDirty(getTracks()[1])).toBe(false);
  });

  it('is not moved by a rack edit, and no rack touches the active variant', async () => {
    const user = userEvent.setup();
    twoTracks();
    // The GLOBAL active-variant setter the pattern page's picker drives. A rack
    // must never reach it: a track's voice is a `voiceRef` on the track, and a
    // knob that retuned the instrument's active variant would move the pattern
    // page and every other track pointing at it.
    const activeBefore = useVoiceStore.getState().activeVariants;
    const variantsBefore = useVoiceStore.getState().variants;

    render(<App />);
    await user.click(nav().getByRole('button', { name: 'Composition' }));
    await user.click(modes().getByRole('button', { name: 'Voice mode' }));
    openStage(getTracks()[0], 'Level');
    fireEvent.keyDown(knob(getTracks()[0], 'Level', 'Volume'), { key: 'ArrowUp' });
    expect(isTrackVoiceDirty(getTracks()[0])).toBe(true);

    expect(useVoiceStore.getState().activeVariants).toEqual(activeBefore);
    // Nothing was saved either: a draft is unsaved by definition, and writing
    // one to a variant is CP-15's deliberate act rather than a side effect of
    // turning a knob.
    expect(useVoiceStore.getState().variants).toBe(variantsBefore);

    // …and the pattern page's own editor is where it was left.
    await user.click(nav().getByRole('button', { name: 'Pattern' }));
    await user.click(screen.getByRole('button', { name: /Level/ }));
    expect(screen.queryByText('Unsaved')).toBeNull();
  });
});
