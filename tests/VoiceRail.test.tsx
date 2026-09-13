import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
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
// The pattern page's surface, mounted in exactly one test below: the two arms of
// one write seam are only comparable side by side, and the comparison is what the
// merge could quietly lose.
import { VoicePane } from '../src/voice/VoicePane';
import {
  addTrack,
  getEditingComposition,
  getTracks,
  openBlankComposition,
  selectTrack,
  setTrackInstrument,
  setTrackVoiceRef,
} from '../src/composition/compositionService';
import {
  listSelectableVoices,
  readTrackVoiceRef,
  readVoiceRef,
  saveVoiceAs,
  selectVoice,
} from '../src/voice/voiceService';
import {
  clearVoiceDrafts,
  isVoiceDirty,
  setVoiceParam,
  voicePreset,
} from '../src/voice/voiceDrafts';
import { getAtPath } from '../src/voice/presetPaths';
import { getEditingPattern, openBlankPattern } from '../src/patterns/patternService';

/**
 * CP-15 — the voice rail: the list a track's voice is picked from.
 *
 * SAVING IS NOT HERE ANY MORE. Save / Save as… / Rename / Delete, the unsaved
 * pill, the name form and the refusal map moved into each track's own rack header,
 * beside the knobs that made the edit, and their tests moved with them into
 * `VoiceMode.test.tsx`. What is asserted here is the LIST, the picking, the four
 * empty states — and, below, that none of the moved controls answers here any
 * more, because two Saves for one voice is the failure this split can ship.
 *
 * TWO TRACKS IN EVERY TEST THAT COULD BE FOOLED BY ONE, for CP-13's reason. The
 * failure this ticket is most likely to ship is a rail wired to the write seam's
 * `'pattern'` arm, which addresses the editing PATTERN: with a single track on
 * the fallback that reads as "the picker works". Anything
 * asserting that a pick or a save landed also asserts that the OTHER track did
 * not move, and — because that is the specific trap — that the open PATTERN did
 * not move either.
 *
 * jsdom has no Web Audio, so `startAudio` is replaced at the module boundary —
 * never Tone itself. That is ALL that is replaced, and it is enough only because
 * nothing here builds a `Voice` or an `EventScheduler`: the rail writes presets
 * and drafts, and the page is never played. A test that ever reaches the engine
 * from this file would construct the REAL lib `Voice`; fake it the way
 * `VoiceMode.test.tsx` fakes `Voice` (or `PerTrackVoices.test.tsx` fakes the
 * schedulers) rather than assuming this file's mock already covers it.
 *
 * jsdom also has no LAYOUT, so nothing here asserts that the rail is 300 px wide
 * or that a list scrolls. Every assertion is about what the rail offers, what it
 * writes and what it says.
 */
const lib = vi.hoisted(() => ({
  startAudio: vi.fn(async () => {}),
  reset() {
    vi.clearAllMocks();
  },
}));

// Only `startAudio` is replaced — `MasterBus` deliberately is NOT: `levelMeters`
// calls `MasterBus.getPreLimiterPeakDb()` for the master meter `CompositionPage`
// renders, and a partial stub would swallow that call in `readSource`'s catch and
// report silence. The voice store, `resolveActiveVoice`, the param schema and the
// composition store all stay real too, so the list, the refusals and the drafts
// are resolved here exactly as the app resolves them.
vi.mock('@fretwork/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fretwork/lib')>();
  return {
    ...actual,
    startAudio: lib.startAudio,
  };
});

/**
 * `refreshVoice` is counted, not replaced — it still runs, finds no engine under
 * jsdom and returns, so nothing else in this file behaves differently. The count
 * is the only way to assert the one obligation the two arms of the write seam do
 * NOT share: the pattern arm's caller has to follow a pick with this call and the
 * track arm's caller must not, and the seam cannot make the call itself because
 * `playbackService` imports `voiceService` and the arrow only points one way.
 */
const audio = vi.hoisted(() => ({ refreshVoice: vi.fn() }));

vi.mock('../src/audio/playbackService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audio/playbackService')>();
  return {
    ...actual,
    refreshVoice: () => {
      audio.refreshVoice();
      actual.refreshVoice();
    },
  };
});

// ----------------------------------------------------------------- fixtures ---

/** `level.volumeDb` is required on every preset, so it resolves against whatever
 *  voice the lib hands back — no fixture can make the Level stage absent, which
 *  is what makes it the safe parameter to assert on. */
const VOLUME_PATH = 'level.volumeDb';

function twoTracks(): readonly Track[] {
  // Idempotent, as the `ensureComposition` this replaced was: a helper that
  // CREATES unconditionally would switch away from a composition the test had
  // already opened, and the switch is silent.
  if (!getEditingComposition()) openBlankComposition('Song');
  addTrack('Rhythm');
  return getTracks();
}

const lead = () => getTracks()[0];
const rhythm = () => getTracks()[1];

/**
 * The draft seam addressed for a TRACK, which is how the store is keyed now — see
 * `voiceDrafts`, which takes a holder kind and an id rather than a document, so a
 * caller with no pointer can reach it. Null means "no such track", which these
 * tests never mean.
 */
const presetOf = (track: Track): VoicePreset => {
  const preset = voicePreset('track', track.id);
  if (!preset) throw new Error(`no such track: ${track.id}`);
  return preset;
};

const dirtyOf = (track: Track): boolean => isVoiceDirty('track', track.id);

const volumeOf = (track: Track): unknown => getAtPath(presetOf(track), VOLUME_PATH);

/** A built-in guitar voice by name, so a test names a tone rather than a slot id. */
function builtIn(name: string) {
  const found = listSelectableVoices('guitar').builtIns.find((voice) => voice.name === name);
  if (!found) throw new Error(`no built-in guitar voice called ${name}`);
  return found;
}

const group = (name: string) => within(screen.getByRole('group', { name }));

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
  clearVoiceDrafts();
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
    // `'pattern'` is the argument that looks right and is wrong. Had the rail
    // passed it to the same seam, THIS is what would have moved instead.
    expect(readVoiceRef(getEditingPattern()!)).toBeNull();
  });

  it('does not refresh the live voice, where the pattern page’s pick must', async () => {
    twoTracks();
    openBlankPattern('Riff');
    selectTrack(lead().id);
    const clean = builtIn('Clean Amp');

    const rail = render(<VoiceRail />);
    await userEvent.click(screen.getByRole('button', { name: clean.name }));

    expect(readTrackVoiceRef(lead())).toEqual(clean.ref);
    // `playbackService` follows the COMPOSITION store and swaps that one track's
    // voice itself. A `refreshVoice` on top would rebuild the EDITING PATTERN's
    // voice — a document this write never touched — and would retire an unsaved
    // edit sitting in front of it.
    expect(audio.refreshVoice).not.toHaveBeenCalled();
    rail.unmount();

    // The same seam one argument apart, and the opposite obligation: nothing
    // makes a pattern's selection audible on its own, and this call is also what
    // retires an edit abandoned behind the pane's back — so it is made even with
    // nothing playing.
    render(<VoicePane openSections={[]} onOpenSectionsChange={() => {}} />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Voice' }), clean.key);

    expect(readVoiceRef(getEditingPattern()!)).toEqual(clean.ref);
    // Counted, not merely called: a double refresh rebuilds the voice twice, and
    // the count is the only thing that would say so.
    expect(audio.refreshVoice).toHaveBeenCalledTimes(1);
  });

  it('offers the way back to the instrument’s own voice', async () => {
    twoTracks();
    selectTrack(lead().id);
    selectVoice('track', lead().id, builtIn('Clean Amp').ref);
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
    selectVoice('track', lead().id, clean.ref);
    setVoiceParam('track', lead().id, VOLUME_PATH, -6);
    render(<VoiceRail />);

    // Answered NO: nothing moves, and the edit is still there to go back to.
    vi.stubGlobal('confirm', () => false);
    await userEvent.click(screen.getByRole('button', { name: builtIn('Crunch').name }));
    expect(readTrackVoiceRef(lead())).toEqual(clean.ref);
    expect(dirtyOf(lead())).toBe(true);

    // Answered YES: the pick lands AND the draft is gone. Proved by pointing the
    // track back at the voice the draft was tagged with — a pick only SHADOWS a
    // draft by tag, so one that was never actually discarded matches again here
    // and the user is silently back on an edit they threw away.
    vi.stubGlobal('confirm', () => true);
    await userEvent.click(screen.getByRole('button', { name: builtIn('Crunch').name }));
    expect(readTrackVoiceRef(lead())).toEqual(builtIn('Crunch').ref);
    selectVoice('track', lead().id, clean.ref);
    expect(dirtyOf(lead())).toBe(false);
  });

  it('marks the current voice as pressed, so the list says what is playing', () => {
    twoTracks();
    selectTrack(lead().id);
    const clean = builtIn('Clean Amp');
    selectVoice('track', lead().id, clean.ref);
    render(<VoiceRail />);

    expect(screen.getByRole('button', { name: clean.name })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(auto()).toHaveAttribute('aria-pressed', 'false');
  });
});

// ---------------------------------------------------------------- refusals ---

describe('what the rail says when a write is refused', () => {
  it('says a ref has gone dangling, and which of the two ways', async () => {
    twoTracks();
    selectTrack(lead().id);
    const created = saveVoiceAs('track', lead().id, 'Doomed', presetOf(lead()));
    if (!created.ok) throw new Error(created.reason);
    // Deleted from UNDER the track — the pattern page can do this, and nothing
    // about the composition store moves when it happens.
    act(() => useVoiceStore.getState().deleteVariant(created.id));

    render(<VoiceRail />);
    // The LIST's half of this. What Save does about it is the rack's, and it is
    // asserted there ("refuses a Save into a ref that cannot be written back to"
    // in `VoiceMode.test.tsx`) — the two sentences are different and both have to
    // exist: this one says the voice is gone, that one says the button is dead.
    expect(screen.getByText(/voice has been deleted/)).toBeInTheDocument();
  });

  it('says when a ref belongs to another instrument, which is a different sentence', () => {
    twoTracks();
    selectTrack(lead().id);
    const created = saveVoiceAs('track', lead().id, 'Guitar tone', presetOf(lead()));
    if (!created.ok) throw new Error(created.reason);
    // The variant still exists; the TRACK moved out from under it. Written through
    // the COMPOSITION seam, which stores the ref opaquely — the voice seam refuses
    // this pairing outright, and `setTrackInstrument` clears the override on the way
    // past. What is left is the shape a rehydrated document arrives in, which is the
    // only way this state is actually reached.
    setTrackInstrument(lead().id, 'ukulele');
    setTrackVoiceRef(lead().id, { kind: 'user', id: created.id });

    render(<VoiceRail />);
    expect(screen.getByText(/belongs to another instrument/)).toBeInTheDocument();
    expect(screen.queryByText(/voice has been deleted/)).not.toBeInTheDocument();
  });

});

// --------------------------------------------------- what the rail no longer is ---

describe('the saving controls are not here any more', () => {
  it('offers none of them, with a track selected and an unsaved edit in front of it', () => {
    twoTracks();
    selectTrack(lead().id);
    // The state that used to light every one of them up: a track on a saveable
    // variant with a draft standing on top of it. If any of these still answered
    // here, they would answer for the SELECTED track while eight racks each
    // offered the same buttons for their own — two Saves for one voice.
    const created = saveVoiceAs('track', lead().id, 'Rail tone', presetOf(lead()));
    if (!created.ok) throw new Error(created.reason);
    act(() => {
      setVoiceParam('track', lead().id, VOLUME_PATH, -6);
    });
    render(<VoiceRail />);

    for (const name of ['Save', 'Save as…', 'Rename', 'Delete', 'Revert']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    // The pill went with them — the rack draws the dirty state for its own track.
    expect(screen.queryByText('Unsaved')).not.toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    // …and so did the sentence that travels with Save.
    expect(screen.queryByText(/Saving overwrites/)).not.toBeInTheDocument();
    // The draft itself is untouched by any of that: it is in `voiceDrafts`, which
    // is neither surface's.
    expect(volumeOf(lead())).toBe(-6);
    expect(dirtyOf(lead())).toBe(true);
  });

  it('keeps saying WHICH track it is picking for, because a rack picker is on screen too', () => {
    twoTracks();
    selectTrack(lead().id);
    render(<VoiceRail />);

    // The one thing stopping two pickers showing two different voices from
    // reading as a bug: this list follows the SELECTION, a rack header follows its
    // own track, and only the heading says which this one is.
    expect(screen.getByText('Voice for')).toBeInTheDocument();
    expect(screen.getByText(lead().name)).toBeInTheDocument();
    expect(screen.queryByText(rhythm().name)).not.toBeInTheDocument();

    // And it FOLLOWS the selection — a heading fixed at mount would name the
    // wrong track for the rest of the session.
    act(() => selectTrack(rhythm().id));
    expect(screen.getByText(rhythm().name)).toBeInTheDocument();
    expect(screen.queryByText(lead().name)).not.toBeInTheDocument();
  });
});
