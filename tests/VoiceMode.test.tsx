import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_PATTERNS_STATE,
  PPQ,
  useMetronomeStore,
  usePatternsStore,
  sourceTrimDb,
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
  setTrackInstrument,
} from '../src/composition/compositionService';
import { listSelectableVoices, setTrackVoice } from '../src/voice/voiceService';
import {
  DEFAULT_OPEN_SECTIONS,
  PARAM_SECTIONS,
  type SectionId,
} from '../src/voice/paramSchema';
import {
  addTrackVoiceSection,
  addTrackVoiceSubBranch,
  clearTrackVoiceDrafts,
  discardTrackVoiceDraft,
  isTrackVoiceDirty,
  removeTrackVoiceSection,
  removeTrackVoiceSubBranch,
  setTrackVoiceParam,
  setTrackVoiceSubBranchKind,
  trackVoicePreset,
} from '../src/voice/trackVoiceDrafts';
import { playComposition, useCompositionPlayback } from '../src/audio/playbackService';
import { getAtPath } from '../src/voice/presetPaths';
import { SEED_BODY_FILTER_ENVELOPE } from '../src/voice/sourceDefaults';
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
 * Source and Level start folded — and a folded stage's controls are `hidden`,
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

    // `source` is not a branch a voice can be without: switching KIND is the
    // operation, and `Source` declares no `removableBranch`.
    expect(removeTrackVoiceSection(tracks[0].id, 'source')).toEqual({
      ok: false,
      reason: expect.stringContaining('cannot be removed'),
    });
  });

  it('switches the source kind by replacing the whole branch', () => {
    // The seam is the agent-reachable route, so this is the case a caller with
    // no pointer hits: `source.kind` is a path like any other from the outside,
    // and the seam has to know it is not a `setAtPath`. Writing the discriminant
    // alone would leave the sampler's `samples` beside an `fm-synth` tag.
    const tracks = twoTracks();
    expect(trackVoicePreset(tracks[0]).source.kind).toBe('sampler');

    expect(setTrackVoiceParam(tracks[0].id, 'source.kind', 'fm-synth')).toEqual({
      ok: true,
      value: undefined,
    });

    const source = trackVoicePreset(getTracks()[0]).source;
    expect(source.kind).toBe('fm-synth');
    expect(Object.keys(source).sort()).toEqual(['kind', 'params']);
    expect(getAtPath(trackVoicePreset(getTracks()[0]), 'source.samples')).toBeUndefined();
    // Tone's documented FMSynth default, so the voice plays before anything is
    // turned. And the OTHER track is untouched, as with every write here.
    expect(getAtPath(trackVoicePreset(getTracks()[0]), 'source.params.harmonicity')).toBe(3);
    expect(trackVoicePreset(getTracks()[1]).source.kind).toBe('sampler');
  });

  it('refuses a param the current source does not have', () => {
    // `paramApplies` is a gate on the SEAM and not only on the pane: an FM row
    // written onto a sampler would widen the preset with a field `Voice` never
    // reads, and the caller would be told nothing.
    const tracks = twoTracks();
    expect(trackVoicePreset(tracks[0]).source.kind).toBe('sampler');

    const wrongKind = setTrackVoiceParam(tracks[0].id, 'source.params.harmonicity', 2);
    expect(wrongKind).toEqual({ ok: false, reason: expect.stringContaining('source') });
    expect(getAtPath(trackVoicePreset(getTracks()[0]), 'source.params')).toBeUndefined();

    // Switch, and the same write is now accepted — an encoder takes any finite
    // number, because Tone publishes no bound for harmonicity.
    setTrackVoiceParam(tracks[0].id, 'source.kind', 'fm-synth');
    expect(setTrackVoiceParam(tracks[0].id, 'source.params.harmonicity', 12.5)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(getAtPath(trackVoicePreset(getTracks()[0]), 'source.params.harmonicity')).toBe(12.5);
    // …and still refuses a non-number, which is the only thing an encoder checks.
    expect(setTrackVoiceParam(tracks[0].id, 'source.params.harmonicity', 'more')).toEqual({
      ok: false,
      reason: expect.stringContaining('number'),
    });
  });

  it('refuses a source kind that is not one of the three', () => {
    const tracks = twoTracks();
    // `'toString'` rather than `'nonsense'`: an `in` check on the kind table
    // would answer yes to it through the prototype chain, and the seam would
    // then hand `defaultSourceFor` a kind its switch has no case for.
    for (const bogus of ['wavetable', 'toString', 7]) {
      expect(setTrackVoiceParam(tracks[0].id, 'source.kind', bogus)).toEqual({
        ok: false,
        reason: expect.stringContaining('options'),
      });
    }
    expect(trackVoicePreset(getTracks()[0]).source.kind).toBe('sampler');
  });
});

// ---------------------------------------- the second source and body filter ---

/**
 * Both of the optional branches nested inside a stage, from the composition side.
 *
 * TWO THINGS ARE BEING PINNED HERE and they pull in opposite directions. Their
 * ROWS have to work through the seam like any other row — that is the whole
 * reason they are declared in `section.params` rather than hanging off the
 * sub-branch descriptor. And the seam has to REFUSE them on a preset that has no
 * such branch, because a lone `bodyFilter.envelope.attack` write would mint
 * `{ attack: 0.1 }` where a whole `BodyFilterEnvelope` belongs and `buildChain`
 * would hand Tone five `undefined`s.
 */
function bassTrackWithLayer(): Track {
  const tracks = twoTracks();
  expect(setTrackInstrument(tracks[0].id, 'bass').ok).toBe(true);
  const bass = listSelectableVoices('bass').builtIns.find(
    (voice) => voice.name === 'Acoustic Bass',
  );
  if (!bass) throw new Error('no built-in bass voice called Acoustic Bass');
  expect(setTrackVoice(tracks[0].id, bass.ref).ok).toBe(true);
  return getTracks()[0];
}

describe('the second source and the body filter, through the track seam', () => {
  it('accepts a second source row on a voice that has one', () => {
    const track = bassTrackWithLayer();
    // The built-in's real values, not the schema's fallbacks.
    expect(getAtPath(trackVoicePreset(track), 'layer.gainDb')).toBe(-8);
    expect(getAtPath(trackVoicePreset(track), 'layer.octaveOffset')).toBe(-1);

    expect(setTrackVoiceParam(track.id, 'layer.gainDb', -5)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(getAtPath(trackVoicePreset(getTracks()[0]), 'layer.gainDb')).toBe(-5);
    // The layer's synth is addressable too, and it is a different path from the
    // primary's — the same descriptor generated under two branches.
    expect(setTrackVoiceParam(track.id, 'layer.source.params.harmonicity', 1.25).ok).toBe(true);
    const preset = trackVoicePreset(getTracks()[0]);
    expect(getAtPath(preset, 'layer.source.params.harmonicity')).toBe(1.25);
    expect(getAtPath(preset, 'source.params.harmonicity')).not.toBe(1.25);
  });

  it('refuses a second source row on a voice with no second source', () => {
    // `requiresBranch`, enforced where it matters most: an agent has no pointer
    // and nothing on screen to tell it the branch is absent. Without the gate this
    // write would create `layer: { gainDb: -5 }` — a `VoiceLayer` with no
    // `source`, which is what `Voice._buildLayer` calls `buildSynth(undefined)` on.
    const tracks = twoTracks();
    expect(trackVoicePreset(tracks[0]).layer).toBeUndefined();

    expect(setTrackVoiceParam(tracks[0].id, 'layer.gainDb', -5).ok).toBe(false);
    expect(trackVoicePreset(getTracks()[0]).layer).toBeUndefined();
  });

  it('refuses to re-kind a second source, rather than re-kinding the primary', () => {
    // ⚠ THE MIS-ROUTE. `setTrackVoiceParam` resolves ANY `source-kind` row through
    // `withSourceKind`, which takes no path and always replaces `preset.source` —
    // so a `layer.source.kind` row in `section.params` would let this call swap the
    // PRIMARY while the caller pointed at the layer, silently and audibly. The
    // picker is declared on `ParamSubBranch.kindRow` instead, which keeps the path
    // out of the seam's map: refused, and the primary is where it was.
    const track = bassTrackWithLayer();
    const before = trackVoicePreset(track);
    expect(before.source.kind).toBe('fm-synth');
    expect(before.layer?.source.kind).toBe('fm-synth');

    const refused = setTrackVoiceParam(track.id, 'layer.source.kind', 'pluck-synth');
    expect(refused.ok).toBe(false);

    const after = trackVoicePreset(getTracks()[0]);
    expect(after.source.kind).toBe('fm-synth');
    expect(after.layer?.source.kind).toBe('fm-synth');
    expect(after.source).toBe(before.source);
  });

  it('adds a body filter as a static one, and refuses envelope rows until there is an envelope', () => {
    const tracks = twoTracks();
    expect(trackVoicePreset(tracks[0]).bodyFilter).toBeUndefined();

    expect(addTrackVoiceSection(tracks[0].id, 'body-filter').ok).toBe(true);
    const filter = trackVoicePreset(getTracks()[0]).bodyFilter;
    expect(filter).toBeDefined();
    // `addTrackVoiceSection` seeds every REQUIRED row and skips the optional ones,
    // and every envelope row is gated on a branch that does not exist yet — so what
    // it produces is a fixed cutoff, which is a sound of its own.
    expect(filter?.envelope).toBeUndefined();
    expect(Object.keys(filter!).sort()).toEqual(['cutoff', 'q']);

    // …and the envelope's rows are refused rather than minting a partial one.
    expect(setTrackVoiceParam(tracks[0].id, 'bodyFilter.envelope.attack', 0.1).ok).toBe(false);
    expect(trackVoicePreset(getTracks()[0]).bodyFilter?.envelope).toBeUndefined();

    // The filter's own rows are live, and removing the stage takes all of it.
    expect(setTrackVoiceParam(tracks[0].id, 'bodyFilter.cutoff', 4000).ok).toBe(true);
    expect(getAtPath(trackVoicePreset(getTracks()[0]), 'bodyFilter.cutoff')).toBe(4000);
    expect(removeTrackVoiceSection(tracks[0].id, 'body-filter').ok).toBe(true);
    expect(trackVoicePreset(getTracks()[0]).bodyFilter).toBeUndefined();
    // The other track never had one.
    expect(trackVoicePreset(getTracks()[1]).bodyFilter).toBeUndefined();
  });

  // REMOVED 2026-09-01, see docs/HANDOFF.md — it reached for Electric Guitar because
  // that was the only shipped voice carrying a body filter with an envelope.

  it('adds, re-kinds and removes a second source with no pointer at all', () => {
    // ⚠ THE AGENT'S ROUTE IN. `addTrackVoiceSection` is `SectionId`-keyed and a
    // sub-branch is not a section; every `layer.*` write is refused while the
    // branch is absent. So without these three, a track with no second source
    // could never gain one from anything but a mouse, and every feature here is
    // supposed to be callable without one.
    const tracks = twoTracks();
    expect(trackVoicePreset(tracks[0]).layer).toBeUndefined();

    expect(addTrackVoiceSubBranch(tracks[0].id, 'layer')).toEqual({
      ok: true,
      value: undefined,
    });
    const added = trackVoicePreset(getTracks()[0]).layer;
    // A whole `VoiceSource`, which is the reason `seed` exists — `_buildLayer`
    // calls `buildSynth(layer.source)` and reads `.kind` off it.
    expect(added?.source.kind).toBe('fm-synth');
    expect(added?.source).toHaveProperty('params.envelope.attack');
    expect(added?.octaveOffset).toBe(0);
    // Under the primary at the mixer, whichever family the primary is.
    const primarySource = trackVoicePreset(getTracks()[0]).source;
    expect(
      added!.gainDb + sourceTrimDb(added!.source) - sourceTrimDb(primarySource),
    ).toBeLessThanOrEqual(-6);
    // Idempotent, like `addTrackVoiceSection`: a caller that cannot see the rack
    // must not have to look first.
    expect(addTrackVoiceSubBranch(tracks[0].id, 'layer').ok).toBe(true);
    expect(trackVoicePreset(getTracks()[0]).layer?.gainDb).toBe(added?.gainDb);

    // …and now the rows it gates are accepted, where they were refused before.
    expect(setTrackVoiceParam(tracks[0].id, 'layer.octaveOffset', -1).ok).toBe(true);
    expect(getAtPath(trackVoicePreset(getTracks()[0]), 'layer.octaveOffset')).toBe(-1);

    // The kind swap is the branch-aware one, and never touches the primary.
    const primaryBefore = trackVoicePreset(getTracks()[0]).source;
    expect(setTrackVoiceSubBranchKind(tracks[0].id, 'layer', 'pluck-synth').ok).toBe(true);
    let preset = trackVoicePreset(getTracks()[0]);
    expect(preset.layer?.source.kind).toBe('pluck-synth');
    expect(preset.layer?.source).toHaveProperty('params.attackNoise');
    expect(preset.layer?.source).not.toHaveProperty('params.harmonicity');
    expect(preset.source).toBe(primaryBefore);
    // The layer's own tuning outside `source` survives the swap.
    expect(preset.layer?.octaveOffset).toBe(-1);

    expect(removeTrackVoiceSubBranch(tracks[0].id, 'layer').ok).toBe(true);
    preset = trackVoicePreset(getTracks()[0]);
    expect(preset.layer).toBeUndefined();
    expect(Object.hasOwn(preset, 'layer')).toBe(false);
    // The other track was never touched by any of it.
    expect(trackVoicePreset(getTracks()[1]).layer).toBeUndefined();
  });

  it('refuses the sub-branch seams in words rather than doing nothing', () => {
    const tracks = twoTracks();
    // A branch the table does not declare.
    expect(addTrackVoiceSubBranch(tracks[0].id, 'reverb').ok).toBe(false);
    expect(removeTrackVoiceSubBranch(tracks[0].id, 'reverb').ok).toBe(false);
    // A sub-branch with no source of its own — the cutoff envelope carries no
    // `kindRow`, so there is nothing for a kind to name.
    expect(setTrackVoiceSubBranchKind(tracks[0].id, 'body-filter-envelope', 'fm-synth').ok).toBe(
      false,
    );
    // ⚠ AND: re-kinding a layer that is not there is refused, not reported as a
    // success that changed nothing. `withLayerSourceKind` returns the preset
    // untouched when `preset.layer` is undefined, so without the guard this call
    // would answer `ok` and leave no layer behind.
    expect(trackVoicePreset(tracks[0]).layer).toBeUndefined();
    expect(setTrackVoiceSubBranchKind(tracks[0].id, 'layer', 'fm-synth').ok).toBe(false);
    expect(trackVoicePreset(getTracks()[0]).layer).toBeUndefined();
    // A kind the picker does not offer, on a layer that does exist.
    expect(addTrackVoiceSubBranch(tracks[0].id, 'layer').ok).toBe(true);
    expect(setTrackVoiceSubBranchKind(tracks[0].id, 'layer', 'sampler').ok).toBe(false);
    expect(setTrackVoiceSubBranchKind(tracks[0].id, 'layer', 'wavetable').ok).toBe(false);
    expect(trackVoicePreset(getTracks()[0]).layer?.source.kind).toBe('fm-synth');
  });

  it('refuses a frequency of zero and a fractional octave, which are silence and a rounding', () => {
    // ⚠ TWO HOLES THE ENCODER AND SLIDER POLICIES LEFT, and they are only
    // reachable without a pointer. An encoder is range-checked for finiteness
    // alone, on purpose — Tone publishes no bound for these fields. But
    // `bodyFilter.cutoff = 0` is a lowpass that passes nothing and
    // `baseFrequency = 0` pins the whole sweep at DC, so one call yields a track
    // that plays silence with every control reading normally.
    const tracks = twoTracks();
    expect(addTrackVoiceSection(tracks[0].id, 'body-filter').ok).toBe(true);

    expect(setTrackVoiceParam(tracks[0].id, 'bodyFilter.cutoff', 0).ok).toBe(false);
    expect(setTrackVoiceParam(tracks[0].id, 'bodyFilter.cutoff', -400).ok).toBe(false);
    expect(setTrackVoiceParam(tracks[0].id, 'bodyFilter.q', -1).ok).toBe(false);
    // …while the encoder itself is still unbounded ABOVE, which is the whole
    // point of it being an encoder: nothing here invented a maximum.
    expect(setTrackVoiceParam(tracks[0].id, 'bodyFilter.cutoff', 19000).ok).toBe(true);
    expect(getAtPath(trackVoicePreset(getTracks()[0]), 'bodyFilter.cutoff')).toBe(19000);

    expect(addTrackVoiceSubBranch(tracks[0].id, 'body-filter-envelope').ok).toBe(true);
    expect(setTrackVoiceParam(tracks[0].id, 'bodyFilter.envelope.baseFrequency', 0).ok).toBe(
      false,
    );
    expect(getAtPath(trackVoicePreset(getTracks()[0]), 'bodyFilter.envelope.baseFrequency')).toBe(
      SEED_BODY_FILTER_ENVELOPE.baseFrequency,
    );

    // The fractional octave: `Voice.play` hands `octaveOffset * 12` to
    // `transposeNote`, so 0.3 is 3.6 semitones and an arbitrary rounded note.
    // In range, on the step grid of no fader — the check the slider arm did not
    // have, because this is the table's first integral field.
    expect(addTrackVoiceSubBranch(tracks[0].id, 'layer').ok).toBe(true);
    expect(setTrackVoiceParam(tracks[0].id, 'layer.octaveOffset', 0.3).ok).toBe(false);
    expect(getAtPath(trackVoicePreset(getTracks()[0]), 'layer.octaveOffset')).toBe(0);
    expect(setTrackVoiceParam(tracks[0].id, 'layer.octaveOffset', -1).ok).toBe(true);
    // …and a fractional value on a NON-integral slider is still fine: a step is a
    // detent, not a grid the preset has to sit on.
    expect(addTrackVoiceSection(tracks[0].id, 'amp').ok).toBe(true);
    expect(setTrackVoiceParam(tracks[0].id, 'effects.amp.preGainDb', 3.7).ok).toBe(true);
    expect(getAtPath(trackVoicePreset(getTracks()[0]), 'effects.amp.preGainDb')).toBe(3.7);
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
      for (const section of ['Source', 'Amp', 'Cabinet', 'Level']) {
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

  it('draws a track`s second source as its own group, and turns its knobs', () => {
    // ⚠ THE NAMING PROBLEM, on the surface that has both axes of it. The layer's
    // rows are the primary's descriptors generated under a second branch, so
    // "Harmonicity" is in the Source stage TWICE; the landmark name that tells
    // eight racks apart cannot tell those two apart, because they are in ONE
    // rack, and `role="group"` does not name its descendants — a group is
    // announced on entering it. So the rows carry the branch in their own names.
    const track = bassTrackWithLayer();
    const name = getTracks()[0].name;
    render(<VoiceGrid />);
    openStage(getTracks()[0], 'Source');

    const source = stage(getTracks()[0], 'Source');
    const primary = source.getByRole('spinbutton', { name: 'Harmonicity' });
    const second = source.getByRole('spinbutton', { name: `${name} Second source Harmonicity` });
    expect(primary).not.toBe(second);

    const layer = within(screen.getByRole('group', { name: `${name} Second source` }));
    // The built-in's real values, not the schema's fallbacks (-12 / 0).
    expect(layer.getByRole('spinbutton', { name: `${name} Second source Mix` })).toHaveAttribute(
      'aria-valuenow',
      '-8',
    );
    // A `Knob`, not a range input: every slider row in the table is drawn as a
    // rotary here, so the value is on `aria-valuenow`.
    expect(
      layer.getByRole('slider', { name: `${name} Second source Octave` }),
    ).toHaveAttribute('aria-valuenow', '-1');

    fireEvent.keyDown(layer.getByRole('spinbutton', { name: `${name} Second source Mix` }), {
      key: 'ArrowUp',
    });
    expect(getAtPath(trackVoicePreset(getTracks()[0]), 'layer.gainDb')).toBeCloseTo(-7.5, 6);
    // The other rack never had a layer and still does not.
    expect(trackVoicePreset(getTracks()[1]).layer).toBeUndefined();
    expect(track.id).toBe(getTracks()[0].id);
  });

  it('offers an Add on a voice with no second source, and no rows until it is pressed', () => {
    // The group is drawn either way now, because there IS a seam that creates a
    // branch by path — `addTrackVoiceSubBranch`. What is absent when the branch
    // is, is the branch's rows.
    const tracks = twoTracks();
    render(<VoiceGrid />);
    openStage(getTracks()[0], 'Source');

    expect(trackVoicePreset(getTracks()[0]).layer).toBeUndefined();
    const layer = within(
      screen.getByRole('group', { name: `${tracks[0].name} Second source` }),
    );
    expect(
      layer.getByRole('button', { name: `Add Second source for ${tracks[0].name}` }),
    ).toBeInTheDocument();
    expect(
      layer.queryByRole('spinbutton', { name: `${tracks[0].name} Second source Mix` }),
    ).not.toBeInTheDocument();
  });

  it('adds, re-kinds and removes a second source from the rack`s own buttons', async () => {
    // ⚠ THE CAPABILITY, END TO END, on the surface that had none of it. Every
    // assertion reads the DRAFT rather than the DOM: a button that renders and
    // writes nothing is exactly what a "the control exists" check passes on.
    const user = userEvent.setup();
    const tracks = twoTracks();
    const name = tracks[0].name;
    render(<VoiceGrid />);
    openStage(getTracks()[0], 'Source');

    await user.click(screen.getByRole('button', { name: `Add Second source for ${name}` }));
    const added = trackVoicePreset(getTracks()[0]).layer;
    expect(added).toBeDefined();
    // A whole `VoiceSource`, which no row fallback could be — `_buildLayer` reads
    // `.kind` off it and `buildSynth(undefined)` is a TypeError, not a mistuning.
    expect(added!.source.kind).toBe('fm-synth');
    expect(added!.source).toHaveProperty('params.harmonicity');
    expect(added!.octaveOffset).toBe(0);
    // Under the primary AT THE MIXER — this track's voice is a sampler, whose own
    // trim the layer does not share. See `sourceDefaults.seedLayerFor`.
    const primarySource = trackVoicePreset(getTracks()[0]).source;
    expect(primarySource.kind).toBe('sampler');
    expect(
      added!.gainDb + sourceTrimDb(added!.source) - sourceTrimDb(primarySource),
    ).toBeLessThanOrEqual(-6);
    // The other rack took no edit — every button here is per track.
    expect(trackVoicePreset(getTracks()[1]).layer).toBeUndefined();

    // Re-kind, in both directions, and never the primary — the mis-route the
    // `kindRow` exists to prevent, now through the composition surface's own
    // picker rather than through `setTrackVoiceParam`.
    await user.selectOptions(
      screen.getByRole('combobox', { name: `${name} Second source Source` }),
      'pluck-synth',
    );
    let preset = trackVoicePreset(getTracks()[0]);
    expect(preset.layer?.source.kind).toBe('pluck-synth');
    expect(preset.layer?.source).toHaveProperty('params.attackNoise');
    expect(preset.layer?.source).not.toHaveProperty('params.harmonicity');
    expect(preset.source.kind).toBe('sampler');

    await user.selectOptions(
      screen.getByRole('combobox', { name: `${name} Second source Source` }),
      'fm-synth',
    );
    preset = trackVoicePreset(getTracks()[0]);
    expect(preset.layer?.source.kind).toBe('fm-synth');
    expect(preset.source.kind).toBe('sampler');

    await user.click(screen.getByRole('button', { name: `Remove Second source for ${name}` }));
    // Absent, not `{}` — a hollow branch reads as present to `hasBranchAtPath`.
    preset = trackVoicePreset(getTracks()[0]);
    expect(preset.layer).toBeUndefined();
    expect(Object.hasOwn(preset, 'layer')).toBe(false);
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

  it('shows the same Source rows the pattern pane does, and switches from them', async () => {
    // The two editors render one table, and they have drifted before — that is
    // why `DEFAULT_OPEN_SECTIONS` lives in the schema. So the composition side
    // gets the same three assertions the pane's own test makes: the section is
    // there on every voice, only the current kind's rows are, and the picker
    // replaces the whole branch rather than the discriminant.
    const user = userEvent.setup();
    const tracks = twoTracks();
    render(<VoiceGrid />);
    openStage(tracks[0], 'Source');

    const source = stage(tracks[0], 'Source');
    expect((source.getByLabelText('Source') as HTMLSelectElement).value).toBe('sampler');
    expect(source.getByLabelText('Pack')).toBeInTheDocument();
    expect(source.queryByRole('spinbutton', { name: 'Resonance' })).toBeNull();

    await user.selectOptions(source.getByLabelText('Source'), 'fm-synth');

    const swapped = trackVoicePreset(getTracks()[0]).source;
    expect(swapped.kind).toBe('fm-synth');
    expect(Object.keys(swapped).sort()).toEqual(['kind', 'params']);

    const after = stage(getTracks()[0], 'Source');
    // Bounded rows draw as knobs on a rack face; unbounded ones as encoders.
    expect(after.getByRole('slider', { name: 'Env attack' })).toBeInTheDocument();
    expect(after.getByRole('spinbutton', { name: 'Harmonicity' })).toBeInTheDocument();
    expect(after.queryByLabelText('Pack')).toBeNull();
    // The other rack is still a sampler and still not dirty.
    expect(trackVoicePreset(getTracks()[1]).source.kind).toBe('sampler');
    expect(isTrackVoiceDirty(getTracks()[1])).toBe(false);
  });

  it('turns an encoder on one rack and the value reaches the draft', () => {
    // Same silent-failure guard as the pane's: an encoder is a `role="spinbutton"`
    // `<div>` with no form value, so only the draft can say the write landed.
    const tracks = twoTracks();
    setTrackVoiceParam(tracks[0].id, 'source.kind', 'pluck-synth');
    render(<VoiceGrid />);
    openStage(getTracks()[0], 'Source');

    const dial = stage(getTracks()[0], 'Source').getByRole('spinbutton', { name: 'Resonance' });
    const before = getAtPath(trackVoicePreset(getTracks()[0]), 'source.params.resonance') as number;
    fireEvent.keyDown(dial, { key: 'ArrowUp' });

    // One arrow key is one `step`, and the step is the SCHEMA's — the rack knows
    // no increments of its own.
    expect(getAtPath(trackVoicePreset(getTracks()[0]), 'source.params.resonance')).toBeCloseTo(
      before + 0.01,
      6,
    );
    expect(isTrackVoiceDirty(getTracks()[1])).toBe(false);
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
    // on the default. Dropping the empty one would re-fold Source and Level the
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
