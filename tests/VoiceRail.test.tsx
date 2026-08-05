import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_PATTERNS_STATE,
  usePatternsStore,
  useVoiceStore,
  type Track,
  type VoicePreset,
} from '@fretwork/lib';
import { CompositionPage } from '../src/composition/CompositionPage';
import { VoiceRail } from '../src/composition/VoiceRail';
import {
  addTrack,
  ensureComposition,
  getTracks,
  selectTrack,
  setTrackInstrument,
  setTrackVoiceRef,
} from '../src/composition/compositionService';
import {
  deleteTrackVoice,
  listSelectableVoices,
  readTrackVoiceRef,
  readVoiceRef,
  saveTrackVoice,
  saveTrackVoiceAs,
  setTrackVoice,
} from '../src/voice/voiceService';
import {
  clearTrackVoiceDrafts,
  isTrackVoiceDirty,
  setTrackVoiceParam,
  trackVoicePreset,
} from '../src/voice/trackVoiceDrafts';
import { getAtPath } from '../src/voice/presetPaths';
import { getEditingPattern, openBlankPattern } from '../src/patterns/patternService';

/**
 * CP-15 — the voice rail: the list a track's voice is picked from and saved into.
 *
 * TWO TRACKS IN EVERY TEST THAT COULD BE FOOLED BY ONE, for CP-13's reason. The
 * failure this ticket is most likely to ship is a rail wired to
 * `voiceService.selectVoice` / `saveVoice`, which address the editing PATTERN:
 * with a single track on the fallback that reads as "the picker works". Anything
 * asserting that a pick or a save landed also asserts that the OTHER track did
 * not move, and — because that is the specific trap — that the open PATTERN did
 * not move either.
 *
 * jsdom has no Web Audio, so the audio surface is mocked at the module boundary
 * exactly as `VoiceMode.test.tsx` and `PerTrackVoices.test.tsx` do — never Tone
 * itself. `Voice` is faked here because the audition path builds one directly
 * from a preset: that fake is the only thing that can tell "auditioned the
 * selected track's unsaved edit" apart from "auditioned whatever pattern was
 * open", which is the correction this ticket was re-planned for.
 *
 * jsdom also has no LAYOUT, so nothing here asserts that the rail is 300 px wide
 * or that a list scrolls. Every assertion is about what the rail offers, what it
 * writes and what it says.
 */
const lib = vi.hoisted(() => {
  /** Every note the audition rig played, with the preset it was holding at the
   *  time — which is the whole question the track audition path exists to get
   *  right. */
  const played: Array<{ note: string; preset: unknown }> = [];

  class FakeVoice {
    preset: unknown;
    ensureBuilt = vi.fn();
    ready = vi.fn(async () => {});
    dispose = vi.fn();
    setRoutingTarget = vi.fn();
    swapPreset = vi.fn((next: unknown) => {
      this.preset = next;
    });
    play = vi.fn((note: string) => {
      played.push({ note, preset: this.preset });
    });

    constructor(preset: unknown) {
      this.preset = preset;
      built.push(this);
    }
  }

  /** Every `Voice` CONSTRUCTED, which is a different question from every note
   *  played: the rig is meant to be ONE voice re-pointed by `swapPreset`, so a
   *  second entry here is a rebuild that should not have happened — and an entry
   *  that never gets `dispose`d is a voice stranded on the shared master bus.
   *
   *  ⚠ The rig is a MODULE-level singleton in `playbackService`, so it outlives a
   *  test the way it outlives an unmount. Every audition test below therefore
   *  mounts the whole `CompositionPage`, whose `usePlaybackEngine` teardown is what
   *  disposes it — which is both how these tests stay isolated from each other and
   *  the reason `disposeAuditionRig` has to run even when Play was never pressed. */
  const built: FakeVoice[] = [];

  return {
    played,
    built,
    FakeVoice,
    startAudio: vi.fn(async () => {}),
    MasterBus: { warmup: vi.fn(async () => {}) },
    audioNow: vi.fn(() => 0),
    reset() {
      played.length = 0;
      built.length = 0;
      vi.clearAllMocks();
    },
  };
});

// Only the audio surface is replaced. The voice store, `resolveActiveVoice`, the
// param schema and the composition store all stay real, so the list, the refusals
// and the drafts are resolved here exactly as the app resolves them.
vi.mock('@fretwork/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fretwork/lib')>();
  return {
    ...actual,
    Voice: lib.FakeVoice,
    startAudio: lib.startAudio,
    MasterBus: lib.MasterBus,
    audioNow: lib.audioNow,
  };
});

// ----------------------------------------------------------------- fixtures ---

/** `level.volumeDb` is required on every preset, so it resolves against whatever
 *  voice the lib hands back — no fixture can make the Level stage absent, which
 *  is what makes it the safe parameter to assert on. */
const VOLUME_PATH = 'level.volumeDb';

function twoTracks(): readonly Track[] {
  ensureComposition();
  addTrack('Rhythm');
  return getTracks();
}

const lead = () => getTracks()[0];
const rhythm = () => getTracks()[1];

const volumeOf = (track: Track): unknown => getAtPath(trackVoicePreset(track), VOLUME_PATH);

/** A built-in guitar voice by name, so a test names a tone rather than a slot id. */
function builtIn(name: string) {
  const found = listSelectableVoices('guitar').builtIns.find((voice) => voice.name === name);
  if (!found) throw new Error(`no built-in guitar voice called ${name}`);
  return found;
}

const group = (name: string) => within(screen.getByRole('group', { name }));

const actionButton = (name: string) => screen.getByRole('button', { name });

/** The fallback row. Its accessible name carries the sub-line too — "Follows the
 *  instrument" is what makes "Auto" mean anything — so it is matched by prefix. */
const auto = () => screen.getByRole('button', { name: /^Auto\b/ });

beforeEach(() => {
  sessionStorage.clear();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  useVoiceStore.getState().reset();
  selectTrack(null);
  // A module that outlives every unmount also outlives every test in this file.
  clearTrackVoiceDrafts();
  lib.reset();
});

// Restored here rather than at the end of each test body: an assertion that throws
// in between would otherwise leave `confirm` stubbed for every test after it.
afterEach(() => {
  vi.unstubAllGlobals();
});

// -------------------------------------------------------------- empty states ---

describe('the empty rail', () => {
  it('says which kind of empty it is', () => {
    // Nothing open at all: there is no track for a voice to belong to.
    const nothing = render(<VoiceRail />);
    expect(screen.getByText('No composition open')).toBeInTheDocument();
    nothing.unmount();

    act(() => {
      twoTracks();
    });
    render(<VoiceRail />);
    // A different sentence, because it is a different situation with a different
    // thing to do about it. Silence, or one message for both, reads as broken.
    expect(screen.getByText('No track selected')).toBeInTheDocument();
    expect(screen.queryByText('No composition open')).not.toBeInTheDocument();
  });

  it('stays mounted in voice mode whether or not a track is selected', () => {
    twoTracks();
    render(<CompositionPage mode="voice" onModeChange={() => {}} />);

    // The rail is a landmark of its own, named for what it holds rather than
    // sharing edit mode's 'Inspector'. Always there: one that appeared and
    // vanished with the selection would move the grid beside it on every click.
    const rail = screen.getByRole('complementary', { name: 'Voices' });
    expect(within(rail).getByText('No track selected')).toBeInTheDocument();

    act(() => selectTrack(lead().id));
    expect(within(rail).getByRole('group', { name: 'Presets' })).toBeInTheDocument();
  });
});

// -------------------------------------------------------------- the two groups ---

describe('the list', () => {
  it('separates built-in slots from the user’s own, and says when there are none of the latter', () => {
    twoTracks();
    selectTrack(lead().id);
    render(<VoiceRail />);

    // The distinction is load-bearing rather than cosmetic: only one of the two
    // groups can ever be saved to.
    expect(group('Presets').getAllByRole('button').length).toBeGreaterThan(1);
    expect(
      group('My tones').getByText(/No voices of your own for guitar yet/),
    ).toBeInTheDocument();
    // …and that is a DIFFERENT empty from having no track selected, which is the
    // rule the other rails established.
    expect(screen.queryByText('No track selected')).not.toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ picking ---

describe('picking a voice', () => {
  it('moves the selected track and no other, and leaves the open pattern alone', async () => {
    twoTracks();
    openBlankPattern('Riff');
    selectTrack(lead().id);
    render(<VoiceRail />);

    const clean = builtIn('Clean Amp');
    await userEvent.click(screen.getByRole('button', { name: clean.name }));

    expect(readTrackVoiceRef(lead())).toEqual(clean.ref);
    // The whole point of per-track voices, and the assertion a one-track page
    // could not make: the other track is untouched.
    expect(readTrackVoiceRef(rhythm())).toBeNull();
    // `selectVoice` is the function that looks right and is wrong. If the rail
    // had called it, THIS is what would have moved instead.
    expect(readVoiceRef(getEditingPattern()!)).toBeNull();
  });

  it('offers the way back to the instrument’s own voice', async () => {
    twoTracks();
    selectTrack(lead().id);
    setTrackVoice(lead().id, builtIn('Clean Amp').ref);
    render(<VoiceRail />);

    await userEvent.click(auto());

    // A null ref is not a missing value — it is the lib's documented fallback to
    // the instrument's global active variant.
    expect(readTrackVoiceRef(lead())).toBeNull();
  });

  it('confirms before stranding an unsaved edit, and throws it away when the answer is yes', async () => {
    twoTracks();
    selectTrack(lead().id);
    const clean = builtIn('Clean Amp');
    setTrackVoice(lead().id, clean.ref);
    setTrackVoiceParam(lead().id, VOLUME_PATH, -6);
    render(<VoiceRail />);

    // Answered NO: nothing moves, and the edit is still there to go back to.
    vi.stubGlobal('confirm', () => false);
    await userEvent.click(screen.getByRole('button', { name: builtIn('Crunch').name }));
    expect(readTrackVoiceRef(lead())).toEqual(clean.ref);
    expect(isTrackVoiceDirty(lead())).toBe(true);

    // Answered YES: the pick lands AND the draft is gone. Proved by pointing the
    // track back at the voice the draft was tagged with — a pick only SHADOWS a
    // draft by tag, so one that was never actually discarded matches again here
    // and the user is silently back on an edit they threw away.
    vi.stubGlobal('confirm', () => true);
    await userEvent.click(screen.getByRole('button', { name: builtIn('Crunch').name }));
    expect(readTrackVoiceRef(lead())).toEqual(builtIn('Crunch').ref);
    setTrackVoice(lead().id, clean.ref);
    expect(isTrackVoiceDirty(lead())).toBe(false);
  });

  it('marks the current voice as pressed, so the list says what is playing', () => {
    twoTracks();
    selectTrack(lead().id);
    const clean = builtIn('Clean Amp');
    setTrackVoice(lead().id, clean.ref);
    render(<VoiceRail />);

    expect(screen.getByRole('button', { name: clean.name })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(auto()).toHaveAttribute('aria-pressed', 'false');
  });
});

// -------------------------------------------------------------------- saving ---

describe('saving', () => {
  it('refuses a built-in slot, in the button and in the seam, with a reason', async () => {
    twoTracks();
    selectTrack(lead().id);
    setTrackVoice(lead().id, builtIn('Clean Amp').ref);
    setTrackVoiceParam(lead().id, VOLUME_PATH, -6);
    render(<VoiceRail />);

    // Disabled AND explained: the fourteen slots are readonly lib consts with no
    // setter, so Save is impossible rather than discouraged.
    expect(actionButton('Save')).toBeDisabled();
    expect(screen.getByText(/Presets are read-only/)).toBeInTheDocument();

    // The seam refuses independently of the disabled attribute — which is what
    // the agent hits, since it never sees a button at all.
    expect(saveTrackVoice(lead().id, trackVoicePreset(lead()))).toEqual({
      ok: false,
      reason: 'built-in',
    });
  });

  it('Save as… creates a variant that appears in the user group at once, on this track only', async () => {
    twoTracks();
    openBlankPattern('Riff');
    selectTrack(lead().id);
    setTrackVoiceParam(lead().id, VOLUME_PATH, -6);
    render(<VoiceRail />);

    await userEvent.click(actionButton('Save as…'));
    const name = screen.getByLabelText('New name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Rail tone');
    await userEvent.click(actionButton('Create'));

    // In the list immediately — the group is driven by the voice store, not by a
    // snapshot taken at mount.
    expect(group('My tones').getByRole('button', { name: 'Rail tone' })).toBeInTheDocument();

    const variant = useVoiceStore.getState().variants.find((v) => v.name === 'Rail tone')!;
    expect(getAtPath(variant.preset, VOLUME_PATH)).toBe(-6);
    // Repointed, or the track keeps playing the voice the copy was taken from
    // and the saved variant sits in the library unused.
    expect(readTrackVoiceRef(lead())).toEqual({ kind: 'user', id: variant.id });
    expect(readTrackVoiceRef(rhythm())).toBeNull();
    expect(readVoiceRef(getEditingPattern()!)).toBeNull();
    // The draft is RETIRED, not merely shadowed — asserted through the RAIL rather
    // than through `isTrackVoiceDirty`, which self-clears on a tag mismatch and so
    // would destroy the very evidence it was called to look for. Pointing the track
    // back at the ref the draft was tagged with is what tells the two apart: a draft
    // that was only shadowed by the repoint matches again here and resurrects.
    expect(screen.getByText('Saved')).toBeInTheDocument();
    act(() => {
      setTrackVoice(lead().id, null);
    });
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('Save writes the draft into the shared variant and clears the unsaved mark', async () => {
    twoTracks();
    selectTrack(lead().id);
    const created = saveTrackVoiceAs(lead().id, 'Shared tone', trackVoicePreset(lead()));
    if (!created.ok) throw new Error(created.reason);
    // A SECOND track on the same variant, which is the surprising half: saving
    // retunes every holder, and that is settled behaviour rather than a bug.
    setTrackVoice(rhythm().id, { kind: 'user', id: created.id });

    setTrackVoiceParam(lead().id, VOLUME_PATH, -9);
    render(<VoiceRail />);
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
    // Said BEFORE the button is pressed, not after.
    expect(screen.getByText(/Saving overwrites .* everywhere it is used/)).toBeInTheDocument();

    await userEvent.click(actionButton('Save'));

    const variant = useVoiceStore.getState().variants.find((v) => v.id === created.id)!;
    expect(getAtPath(variant.preset, VOLUME_PATH)).toBe(-9);
    expect(isTrackVoiceDirty(lead())).toBe(false);
    expect(screen.getByText('Saved')).toBeInTheDocument();
    // The other holder followed, because a voice is one shared object.
    expect(volumeOf(rhythm())).toBe(-9);
  });

  it('will not rename under an unsaved edit, because the next Save would undo it', async () => {
    twoTracks();
    selectTrack(lead().id);
    const created = saveTrackVoiceAs(lead().id, 'Named tone', trackVoicePreset(lead()));
    if (!created.ok) throw new Error(created.reason);

    render(<VoiceRail />);
    expect(actionButton('Rename')).toBeEnabled();

    // No `rerender` anywhere below: the subscriptions are the property under test,
    // and a forced re-render would keep every assertion green against a plain
    // non-reactive read.
    act(() => {
      setTrackVoiceParam(lead().id, VOLUME_PATH, -3);
    });

    // The draft carries the OLD name and `saveTrackVoice` writes the record's
    // name back from `preset.name`, so a rename made now would be silently
    // reverted. `trackVoiceDrafts` exposes no name write to patch it with.
    expect(actionButton('Rename')).toBeDisabled();
  });

  it('deletes through the shared seam and clears this track’s ref', async () => {
    vi.stubGlobal('confirm', () => true);
    twoTracks();
    selectTrack(lead().id);
    const created = saveTrackVoiceAs(lead().id, 'Doomed', trackVoicePreset(lead()));
    if (!created.ok) throw new Error(created.reason);
    render(<VoiceRail />);

    await userEvent.click(actionButton('Delete'));

    expect(useVoiceStore.getState().variants).toHaveLength(0);
    // Cleared rather than left dangling: a dangling ref resolves silently to a
    // built-in while the rail shows nothing selected.
    expect(readTrackVoiceRef(lead())).toBeNull();
  });
});

// ---------------------------------------------------------------- refusals ---

describe('what the rail says when a write is refused', () => {
  it('renders the seam’s own reason rather than inventing copy', async () => {
    twoTracks();
    selectTrack(lead().id);
    render(<VoiceRail />);

    await userEvent.click(actionButton('Save as…'));
    const name = screen.getByLabelText('New name');
    await userEvent.clear(name);
    await userEvent.click(actionButton('Create'));

    // `saveTrackVoiceAs` refuses `empty-name`; the rail's job is to say which.
    expect(screen.getByRole('status')).toHaveTextContent('Give the variant a name.');
    // …and nothing was written on the way to saying so.
    expect(useVoiceStore.getState().variants).toHaveLength(0);
  });

  it('says a ref has gone dangling, and which of the two ways', async () => {
    twoTracks();
    selectTrack(lead().id);
    const created = saveTrackVoiceAs(lead().id, 'Doomed', trackVoicePreset(lead()));
    if (!created.ok) throw new Error(created.reason);
    // Deleted from UNDER the track — the pattern page can do this, and nothing
    // about the composition store moves when it happens.
    act(() => useVoiceStore.getState().deleteVariant(created.id));

    render(<VoiceRail />);
    expect(screen.getByText(/voice has been deleted/)).toBeInTheDocument();
    // Save has nothing to write into, and says so rather than leaving a disabled
    // button with no reason beside it.
    expect(actionButton('Save')).toBeDisabled();
    expect(screen.getByText('That voice is no longer in your library.')).toBeInTheDocument();
  });

  it('says when a ref belongs to another instrument, which is a different sentence', () => {
    twoTracks();
    selectTrack(lead().id);
    const created = saveTrackVoiceAs(lead().id, 'Guitar tone', trackVoicePreset(lead()));
    if (!created.ok) throw new Error(created.reason);
    // The variant still exists; the TRACK moved out from under it. Written through
    // the COMPOSITION seam, which stores the ref opaquely — `setTrackVoice` refuses
    // this pairing outright, and `setTrackInstrument` clears the override on the way
    // past. What is left is the shape a rehydrated document arrives in, which is the
    // only way this state is actually reached.
    setTrackInstrument(lead().id, 'ukulele');
    setTrackVoiceRef(lead().id, { kind: 'user', id: created.id });

    render(<VoiceRail />);
    expect(screen.getByText(/belongs to another instrument/)).toBeInTheDocument();
    expect(screen.queryByText(/voice has been deleted/)).not.toBeInTheDocument();
  });

  it('explains the fallback rather than the read-only rule when there is no ref at all', () => {
    twoTracks();
    selectTrack(lead().id);
    render(<VoiceRail />);

    // `no-voice`, not `built-in`: there is nothing read-only here, there is simply
    // nothing to save INTO, and the two have different things to do about them.
    expect(screen.getByText(/follows its instrument’s voice/)).toBeInTheDocument();
    expect(screen.queryByText(/Presets are read-only/)).not.toBeInTheDocument();
  });

  it('repairs a track pointing at a variant that is already gone', () => {
    twoTracks();
    const created = saveTrackVoiceAs(lead().id, 'Ghost', trackVoicePreset(lead()));
    if (!created.ok) throw new Error(created.reason);
    act(() => useVoiceStore.getState().deleteVariant(created.id));

    // The seam, called by id with no pointer anywhere: the variant is already gone,
    // so the only thing left to do is the repair — and it still has to happen, or
    // the track keeps a dead ref and the only way out is picking another voice.
    expect(deleteTrackVoice(lead().id, created.id)).toEqual({ ok: true, id: created.id });
    expect(readTrackVoiceRef(lead())).toBeNull();
  });
});

// ------------------------------------------------------- the dirty indicator ---

describe('the unsaved mark', () => {
  it('follows the selected track, and switching keeps both drafts', async () => {
    twoTracks();
    selectTrack(lead().id);
    render(<VoiceRail />);

    // No `rerender` calls: `useTrackVoiceDirty` and `useTrackVoiceWorkingPreset`
    // subscribe, and forcing a re-render after every `act` would leave this green
    // even if they were swapped for a plain non-reactive read — which is exactly
    // the property this test is about.
    act(() => {
      setTrackVoiceParam(lead().id, VOLUME_PATH, -6);
    });
    expect(screen.getByText('Unsaved')).toBeInTheDocument();

    // The rhythm track has no edit of its own yet, so the mark has to go back to
    // "Saved" — a single shared flag would keep saying "Unsaved" here.
    act(() => selectTrack(rhythm().id));
    expect(screen.getByText('Saved')).toBeInTheDocument();

    act(() => {
      setTrackVoiceParam(rhythm().id, VOLUME_PATH, 2);
    });
    expect(screen.getByText('Unsaved')).toBeInTheDocument();

    act(() => selectTrack(lead().id));
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
    // Neither draft was lost by the switch — `trackVoiceDrafts` holds up to eight
    // of them above every unmount, and this is what that is for.
    expect(volumeOf(lead())).toBe(-6);
    expect(volumeOf(rhythm())).toBe(2);
  });

  it('leaves Revert to the rack, which is where the edit was made', () => {
    twoTracks();
    selectTrack(lead().id);
    setTrackVoiceParam(lead().id, VOLUME_PATH, -6);
    render(<VoiceRail />);

    // One draft, one discard button, and it is beside the knobs that made the
    // edit. Two would be two places to explain what "revert" means.
    expect(screen.queryByRole('button', { name: /Revert/ })).not.toBeInTheDocument();
  });
});

// ----------------------------------------------------------------- audition ---

describe('the audition', () => {
  it('plays the selected track’s voice, including its unsaved edit', async () => {
    twoTracks();
    openBlankPattern('Riff');
    selectTrack(rhythm().id);
    setTrackVoiceParam(rhythm().id, VOLUME_PATH, -11);
    setTrackVoiceParam(lead().id, VOLUME_PATH, 4);
    render(<CompositionPage mode="voice" onModeChange={() => {}} />);

    await userEvent.click(actionButton('Audition'));

    await waitFor(() => expect(lib.played).toHaveLength(1));
    const heard = lib.played[0].preset as VoicePreset;
    // The correction this ticket was re-planned for: `auditionVoice` resolves
    // through `getEditingPattern()`, so from here it would have played the open
    // pattern's voice — silently wrong, and indistinguishable from the picker
    // not working. The draft is what proves which one was reached: no variant
    // holds this value, so nothing but the track path could produce it.
    expect(getAtPath(heard, VOLUME_PATH)).toBe(-11);
    // …and specifically NOT the other track's, which is dirty too.
    expect(getAtPath(heard, VOLUME_PATH)).not.toBe(4);
  });

  it('re-points the one rig instead of rebuilding it, so a second audition is the NEW tone', async () => {
    twoTracks();
    selectTrack(lead().id);
    setTrackVoiceParam(lead().id, VOLUME_PATH, -2);
    render(<CompositionPage mode="voice" onModeChange={() => {}} />);

    await userEvent.click(actionButton('Audition'));
    await waitFor(() => expect(lib.played).toHaveLength(1));
    expect(getAtPath(lib.played[0].preset as VoicePreset, VOLUME_PATH)).toBe(-2);

    act(() => {
      setTrackVoiceParam(lead().id, VOLUME_PATH, -8);
    });
    await userEvent.click(actionButton('Audition'));
    await waitFor(() => expect(lib.played).toHaveLength(2));

    // The guarantee this ticket was re-planned for: an audition matches what
    // playback will do INCLUDING the unsaved edit. Without the `swapPreset` the rig
    // would keep playing the preset it was constructed with.
    expect(getAtPath(lib.played[1].preset as VoicePreset, VOLUME_PATH)).toBe(-8);
    // …and it is one rig re-pointed, not a second `Tone.Sampler` set per knob turn:
    // the source is unchanged, which is exactly what `swapPreset` exists for.
    expect(lib.built).toHaveLength(1);
  });

  it('warms on hover and on focus, from the SELECTED track’s preset', async () => {
    twoTracks();
    // An open pattern, so this cannot pass by accident: `warmVoice` — the pattern
    // path — returns before `startAudio` when nothing is open, which would make
    // "startAudio was called" prove the track path all on its own.
    openBlankPattern('Riff');
    selectTrack(rhythm().id);
    setTrackVoiceParam(rhythm().id, VOLUME_PATH, -13);
    render(<CompositionPage mode="voice" onModeChange={() => {}} />);

    await userEvent.hover(actionButton('Audition'));

    // Nothing can await the sampler on the click path, so hovering is the only
    // pre-roll the first audition gets — and it must fire on EVERY hover, since
    // the voice under the button changes with every pick. Asserted on the PRESET
    // the rig was built from: no variant holds this value, so nothing but the
    // track path could have produced it.
    await waitFor(() => expect(lib.built).toHaveLength(1));
    expect(getAtPath(lib.built[0].preset as VoicePreset, VOLUME_PATH)).toBe(-13);
    // The load is awaited HERE, off the click path, which is the whole point.
    await waitFor(() => expect(lib.built[0].ready).toHaveBeenCalled());

    // Keyboard users reach the button by focus and never hover at all.
    lib.reset();
    act(() => actionButton('Audition').focus());
    await waitFor(() => expect(lib.startAudio).toHaveBeenCalled());
  });

  it('disposes the rig when the page goes, even if Play was never pressed', async () => {
    twoTracks();
    selectTrack(lead().id);
    const page = render(<CompositionPage mode="voice" onModeChange={() => {}} />);

    await userEvent.hover(actionButton('Audition'));
    await waitFor(() => expect(lib.built).toHaveLength(1));

    // ⚠ NO PLAY. The rig is built by the audition path alone, so on this page the
    // composition ENGINE is still null — and the rig is connected to the shared
    // `MasterBus` on its own. A teardown that ran only when an engine existed would
    // strand it there for the rest of the session with no handle left to reach it.
    page.unmount();
    expect(lib.built[0].dispose).toHaveBeenCalled();
  });
});
