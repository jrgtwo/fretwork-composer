import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PATTERNS_STATE, PPQ, useVoiceStore, usePatternsStore } from '@fretwork/lib';
import { App } from '../src/App';
import { stop } from '../src/audio/playbackService';
import { PatternLibraryPanel, type SwitchGuard } from '../src/patterns/PatternLibraryPanel';
import {
  clearHistory,
  deletePattern,
  duplicatePattern,
  getEditingPattern,
  getLibraryPatterns,
  getSelectedIds,
  openBlankPattern,
  openPattern,
  renamePattern,
  selectNotes,
  setEditingPatternInstrument,
  stampNote,
  undo,
} from '../src/patterns/patternService';

// Only `stop` is stood in for, exactly as `AppNavigation.test.tsx` does it:
// jsdom has no Web Audio, so the transport's having been released is not
// observable any other way. Everything else in the seam stays real.
vi.mock('../src/audio/playbackService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audio/playbackService')>();
  return { ...actual, stop: vi.fn(actual.stop) };
});

/**
 * The pattern page's library — the seam that can open a pattern by id (PP-01),
 * and the rail panel over it.
 *
 * The seam half is asserted BY ID AND BY VALUE with no component in sight,
 * because that is the shape the agent reaches it in: it has no pointer, so
 * "clicking the row worked" would say nothing about whether `openPattern('…')`
 * does. The panel half then only has to show that the gestures reach those same
 * functions and that a refusal is said out loud.
 *
 * jsdom has no layout, so nothing here asserts where the rail sits or how tall
 * it is; the rail-versus-fourth-pane decision is argued in the module note on
 * `PatternLibraryPanel` and is not a thing a test in this environment can check.
 *
 * What is asserted at the seam only, because the DOM cannot reach it: a refusal
 * from `duplicatePattern` or `deletePattern`. Every id the panel passes those
 * comes from the list it is rendering, so the only refusal they have — an id the
 * library has not got — cannot be produced by clicking. `create`'s can, since
 * the lib declines a create at the tier cap, and it is exercised below.
 */

beforeEach(() => {
  sessionStorage.clear();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  clearHistory();
  // Variants persist to sessionStorage, and the App-level test below reaches the
  // voice pane through the same module singleton every other file does.
  useVoiceStore.getState().reset();
  // Both confirmations this file exercises — the destructive delete and the
  // caller's switch guard — are stubbed per-test where the answer matters. The
  // default is yes so that every OTHER test is testing the thing it names;
  // jsdom's own `confirm` is a "not implemented" stub returning undefined, which
  // would silently cancel every delete.
  vi.stubGlobal('confirm', () => true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A library pattern with one note in it, left open. Returns its id. */
function seed(name: string, tick = 0): string {
  const made = openBlankPattern(name);
  if (!made.ok) throw new Error(made.reason);
  stampNote({ stringIndex: 0, fret: 3, tick, durationTicks: PPQ });
  return made.value.id;
}

const names = () => getLibraryPatterns().map((pattern) => pattern.name);

// ------------------------------------------------------------------- seam ---

describe('openPattern', () => {
  it('opens an existing pattern by id, with no pointer anywhere', () => {
    const a = seed('Riff A');
    const b = seed('Riff B');
    expect(getEditingPattern()?.id).toBe(b);

    const result = openPattern(a);

    expect(result.ok && result.value.id).toBe(a);
    expect(getEditingPattern()?.name).toBe('Riff A');
  });

  it('refuses an id the library has not got, and leaves the editor where it was', () => {
    const a = seed('Riff A');

    const result = openPattern('not-a-pattern');

    // The lib's `openPatternForEditing` would have taken this id at face value
    // and left the editor pointed at nothing.
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/no such pattern/i);
    expect(getEditingPattern()?.id).toBe(a);
  });

  it('leaves cursor and selection alone when the pattern is already open', () => {
    const a = seed('Riff A');
    const noteId = getEditingPattern()!.events[0].id;
    selectNotes([noteId]);
    usePatternsStore.getState().setCursorTick(PPQ * 3);

    expect(openPattern(a).ok).toBe(true);

    // `openPatternForEditing` clears all three. Clicking the row you are already
    // editing must not throw your place away.
    expect(getSelectedIds()).toEqual([noteId]);
    expect(usePatternsStore.getState().cursorTick).toBe(PPQ * 3);
  });

  it('does not carry undo history across a switch', () => {
    const a = seed('Riff A');
    const b = seed('Riff B');
    // The step has to be pushed while A is open and be switched AWAY from, or
    // the leak is invisible: `seed` clears history and then stamps, so the only
    // step left after two seeds belongs to whichever pattern was seeded last —
    // which is also the one that ends up open.
    openPattern(a);
    stampNote({ stringIndex: 1, fret: 7, tick: PPQ * 2, durationTicks: PPQ });
    expect(getEditingPattern()?.events).toHaveLength(2);
    openPattern(b);

    undo();

    // `writePatternBack` addresses the pattern the SNAPSHOT names, not the one
    // that is open — so a leaked step reverts a document nobody is looking at.
    // Without the `clearHistory` in `openPattern`, A is back to one note here.
    expect(getLibraryPatterns().find((p) => p.id === a)?.events).toHaveLength(2);
    expect(getLibraryPatterns().find((p) => p.id === b)?.events).toHaveLength(1);
    expect(getEditingPattern()?.id).toBe(b);
  });

  it('keeps every timeline edit — there is no unsaved pattern state to lose', () => {
    const a = seed('Riff A');
    const b = seed('Riff B');

    openPattern(a);
    stampNote({ stringIndex: 1, fret: 7, tick: PPQ * 2, durationTicks: PPQ });
    openPattern(b);
    openPattern(a);

    expect(getEditingPattern()?.events).toHaveLength(2);
  });
});

describe('renamePattern', () => {
  it('renames by id, whether or not it is the one open', () => {
    const a = seed('Riff A');
    seed('Riff B');

    const result = renamePattern(a, 'Chorus');

    expect(result.ok && result.value.name).toBe('Chorus');
    expect(names()).toEqual(['Chorus', 'Riff B']);
  });

  it('trims, and refuses a name with nothing in it', () => {
    const a = seed('Riff A');

    expect(renamePattern(a, '  Chorus  ').ok && names()).toEqual(['Chorus']);

    const blank = renamePattern(a, '   ');
    // The lib's `setPatternName` would have written it: a pattern called '' has
    // no handle left anywhere in the app.
    expect(blank.ok).toBe(false);
    expect(!blank.ok && blank.reason).toMatch(/needs a name/i);
    expect(names()).toEqual(['Chorus']);
  });

  it('refuses an unknown id', () => {
    const result = renamePattern('not-a-pattern', 'Chorus');
    expect(!result.ok && result.reason).toMatch(/no such pattern/i);
  });
});

describe('duplicatePattern', () => {
  it('copies the notes and does not switch the editor', () => {
    const a = seed('Riff A');
    const b = seed('Riff B');

    const result = duplicatePattern(a);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.events).toHaveLength(1);
    expect(result.ok && result.value.id).not.toBe(a);
    expect(names()).toEqual(['Riff A', 'Riff B', 'Riff A (copy)']);
    // A duplicate is usually made to keep the original safe before changing it,
    // so it deliberately does not steal the editor.
    expect(getEditingPattern()?.id).toBe(b);
  });

  it('refuses an unknown id', () => {
    const result = duplicatePattern('not-a-pattern');
    expect(!result.ok && result.reason).toMatch(/no such pattern/i);
  });

  it('does not make a second row with the same name as the first copy', () => {
    const a = seed('Riff A');

    duplicatePattern(a);
    duplicatePattern(a);

    // The lib's `clonePattern` always appends " (copy)" and never uniquifies, so
    // two presses of Copy used to leave two rows with one name between them —
    // indistinguishable to a screen reader and unaddressable by name.
    expect(names()).toEqual(['Riff A', 'Riff A (copy)', 'Riff A (copy) 2']);
  });
});

describe('naming a pattern nobody named', () => {
  it('gives each blank pattern a name the library has not already got', () => {
    openBlankPattern();
    openBlankPattern();
    openBlankPattern();

    // The lib's default is the flat 'Untitled pattern'. Three of them is three
    // rows that cannot be told apart, referred to, or read out.
    expect(names()).toEqual(['Untitled pattern', 'Untitled pattern 2', 'Untitled pattern 3']);
  });

  it('uses a name the caller passed verbatim, collision or not', () => {
    // Only the DEFAULT is de-duplicated: a caller — or a user at the rename
    // form — that asks for a name has said what it meant.
    expect(openBlankPattern('Riff').ok && names()).toEqual(['Riff']);
    expect(openBlankPattern('Riff').ok && names()).toEqual(['Riff', 'Riff']);
  });
});

describe('deletePattern', () => {
  it('removes a pattern that is not open, and leaves the editor alone', () => {
    const a = seed('Riff A');
    const b = seed('Riff B');

    expect(deletePattern(a).ok).toBe(true);

    expect(names()).toEqual(['Riff B']);
    expect(getEditingPattern()?.id).toBe(b);
  });

  it('keeps the open pattern undoable when some other row is deleted', () => {
    const a = seed('Riff A');
    seed('Riff B');
    stampNote({ stringIndex: 1, fret: 7, tick: PPQ * 2, durationTicks: PPQ });

    deletePattern(a);
    undo();

    // History is per-pattern; deleting a DIFFERENT pattern is not a switch, so
    // the open pattern's stack has to survive it.
    expect(getEditingPattern()?.events).toHaveLength(1);
  });

  it('leaves a usable editor when the open pattern is the one deleted', () => {
    seed('Riff A');
    const b = seed('Riff B');

    expect(deletePattern(b).ok).toBe(true);

    // The lib's `deletePattern` nulls the pointer and stops; `ensurePattern` is
    // the existing answer to "nothing is open".
    expect(names()).toEqual(['Riff A']);
    expect(getEditingPattern()?.name).toBe('Riff A');
  });

  it('drops the undo stack when the pattern it belongs to is the one deleted', () => {
    const a = seed('Riff A');
    const b = seed('Riff B');
    openPattern(a);
    // One undo step, on A, pushed while A is open.
    stampNote({ stringIndex: 1, fret: 7, tick: PPQ * 2, durationTicks: PPQ });

    deletePattern(a);
    undo();

    // The surviving step names a pattern that is no longer in the library, so
    // `writePatternBack`'s `map` matches nothing: an Undo button that looks live
    // and does nothing. Cleared, there is no step at all.
    expect(getEditingPattern()?.id).toBe(b);
    expect(getEditingPattern()?.events).toHaveLength(1);
    expect(getLibraryPatterns()).toHaveLength(1);
  });

  it('does not hand the adopted pattern the deleted one’s selection or cursor', () => {
    seed('Riff A');
    const b = seed('Riff B');
    selectNotes([getEditingPattern()!.events[0].id]);
    usePatternsStore.getState().setCursorTick(PPQ * 3);

    deletePattern(b);

    // `ensureEditingPattern` adopts by setting one field and clears neither —
    // unlike `openPatternForEditing`. Left alone, `getSelectedIds` reports a
    // note that no longer exists anywhere, which is the kind of lie the seam is
    // here to prevent: the Delete key then silently does nothing.
    expect(getEditingPattern()?.name).toBe('Riff A');
    expect(getSelectedIds()).toEqual([]);
    expect(usePatternsStore.getState().cursorTick).toBe(0);
  });

  it('leaves a blank pattern open — not the demo — when the last one goes', () => {
    const only = seed('Riff A');

    deletePattern(only);

    const open = getEditingPattern();
    expect(open).not.toBeNull();
    expect(open?.events).toHaveLength(0);
    // `App`'s "A major arpeggio" seed is a first-run affordance and must not
    // resurrect itself here: a riff the user did not write reappearing right
    // after they deleted everything reads as the delete having failed.
    expect(open?.name).not.toBe('A major arpeggio');
    expect(getLibraryPatterns()).toHaveLength(1);
  });

  it('refuses an unknown id', () => {
    const result = deletePattern('not-a-pattern');
    expect(!result.ok && result.reason).toMatch(/no such pattern/i);
  });
});

// ------------------------------------------------------------------ panel ---

const rowFor = (name: string) => screen.getByRole('button', { name: `Open pattern ${name}` });
const rows = () => screen.queryAllByRole('button', { name: /^Open pattern / });

describe('the library panel', () => {
  it('says the library is empty rather than drawing an empty box', () => {
    render(<PatternLibraryPanel />);

    expect(rows()).toHaveLength(0);
    expect(screen.getByText(/no patterns yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New pattern' })).toBeInTheDocument();
  });

  it('lists what the store holds, with the instrument and a derived length', async () => {
    seed('Riff A', PPQ * 5); // one note starting in bar 2 → two bars
    setEditingPatternInstrument('bass');
    seed('Riff B');

    render(<PatternLibraryPanel />);

    expect(rows().map((row) => row.getAttribute('data-library-pattern'))).toEqual(
      getLibraryPatterns().map((pattern) => pattern.id),
    );
    const a = within(rowFor('Riff A'));
    expect(a.getByText('bass')).toBeInTheDocument();
    expect(a.getByText('2 bars')).toBeInTheDocument();
    // Derived, never stored: the figure has to follow the notes.
    expect(within(rowFor('Riff B')).getByText('1 bar')).toBeInTheDocument();
  });

  it('marks the pattern that is open', async () => {
    seed('Riff A');
    seed('Riff B');

    render(<PatternLibraryPanel />);

    expect(rowFor('Riff B')).toHaveAttribute('aria-current', 'true');
    expect(rowFor('Riff A')).not.toHaveAttribute('aria-current');
  });

  it('opens a pattern when its row is clicked', async () => {
    const a = seed('Riff A');
    seed('Riff B');
    render(<PatternLibraryPanel />);

    await userEvent.click(rowFor('Riff A'));

    expect(getEditingPattern()?.id).toBe(a);
    expect(rowFor('Riff A')).toHaveAttribute('aria-current', 'true');
  });

  it('creates a pattern, switches to it, and opens its name form', async () => {
    seed('Riff A');
    render(<PatternLibraryPanel />);

    await userEvent.click(screen.getByRole('button', { name: 'New pattern' }));

    expect(getLibraryPatterns()).toHaveLength(2);
    const made = getEditingPattern()!;
    expect(made.name).not.toBe('Riff A');
    expect(made.events).toHaveLength(0);
    // A blank pattern arrives named but not named BY YOU; the form is how you
    // say what it is while you still know.
    const field = screen.getByRole('textbox', { name: `New name for ${made.name}` });
    await userEvent.clear(field);
    await userEvent.type(field, 'Bridge');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(getEditingPattern()?.name).toBe('Bridge');
    expect(rowFor('Bridge')).toHaveAttribute('aria-current', 'true');
  });

  it('says why a rename was refused instead of doing nothing', async () => {
    seed('Riff A');
    render(<PatternLibraryPanel />);

    await userEvent.click(screen.getByRole('button', { name: 'Rename Riff A' }));
    await userEvent.clear(screen.getByRole('textbox', { name: 'New name for Riff A' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByRole('alert')).toHaveTextContent(/needs a name/i);
    expect(names()).toEqual(['Riff A']);
  });

  it('takes the refusal down with the action that caused it', async () => {
    seed('Riff A');
    seed('Riff B');
    render(<PatternLibraryPanel />);
    const refuseARename = async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Rename Riff A' }));
      await userEvent.clear(screen.getByRole('textbox', { name: 'New name for Riff A' }));
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(screen.getByRole('alert')).toBeInTheDocument();
    };

    // A `role="alert"` left standing after the thing it described was abandoned
    // reads as a live complaint about whatever the user does next.
    await refuseARename();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alert')).toBeNull();

    await refuseARename();
    await userEvent.click(rowFor('Riff A'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('duplicates a row without leaving the pattern you are in', async () => {
    seed('Riff A');
    const b = seed('Riff B');
    render(<PatternLibraryPanel />);

    await userEvent.click(screen.getByRole('button', { name: 'Duplicate Riff A' }));

    expect(rowFor('Riff A (copy)')).toBeInTheDocument();
    expect(getEditingPattern()?.id).toBe(b);
  });

  it('leaves a usable editor after deleting the open pattern', async () => {
    seed('Riff A');
    seed('Riff B');
    render(<PatternLibraryPanel />);

    await userEvent.click(screen.getByRole('button', { name: 'Delete Riff B' }));

    expect(rows()).toHaveLength(1);
    expect(rowFor('Riff A')).toHaveAttribute('aria-current', 'true');
    expect(getEditingPattern()?.name).toBe('Riff A');
  });

  it('confirms every delete, and honours a no', async () => {
    seed('Riff A');
    const asked: string[] = [];
    vi.stubGlobal('confirm', (message?: string) => {
      asked.push(String(message));
      return false;
    });
    // Two notes in one, nothing in the other: an empty pattern still carries a
    // name, an instrument, a tempo and a chosen voice, and a confirmation that
    // skips the cheap case is a confirmation people learn to click through.
    stampNote({ stringIndex: 1, fret: 7, tick: PPQ * 2, durationTicks: PPQ });
    openBlankPattern('Empty');
    render(<PatternLibraryPanel />);

    await userEvent.click(screen.getByRole('button', { name: 'Delete Riff A' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete Empty' }));

    expect(names()).toEqual(['Riff A', 'Empty']);
    expect(asked).toEqual([
      'Delete "Riff A"? Its 2 notes go with it, and this cannot be undone.',
      'Delete "Empty"? This cannot be undone.',
    ]);
  });

  it('releases the transport when a different pattern becomes the open one', async () => {
    // `play` snapshots the pattern into the scheduler once and nothing
    // re-streams it, so a switch mid-playback would leave the pattern you just
    // left sounding under the one you are now looking at.
    seed('Riff A');
    seed('Riff B');
    render(<PatternLibraryPanel />);
    const stopped = vi.mocked(stop);
    stopped.mockClear();

    await userEvent.click(rowFor('Riff A'));
    expect(stopped).toHaveBeenCalledTimes(1);

    // Clicking the row that is ALREADY open changes nothing, so it must not
    // silence a transport that is playing the pattern on screen.
    await userEvent.click(rowFor('Riff A'));
    expect(stopped).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'New pattern' }));
    expect(stopped).toHaveBeenCalledTimes(2);
    const made = getEditingPattern()!.name;
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Deleting some other row leaves the open pattern playing …
    await userEvent.click(screen.getByRole('button', { name: 'Delete Riff B' }));
    expect(stopped).toHaveBeenCalledTimes(2);

    // … deleting the open one does not: something else is adopted underneath it.
    await userEvent.click(screen.getByRole('button', { name: `Delete ${made}` }));
    expect(stopped).toHaveBeenCalledTimes(3);
  });

  it('asks the caller before changing which pattern is open, and cancels on a no', async () => {
    const a = seed('Riff A');
    const b = seed('Riff B');
    // `App` puts the voice pane's unsaved working copy behind this. The panel
    // cannot see it, which is exactly why the question is asked outward.
    const confirmSwitch = vi.fn<SwitchGuard>(() => null);
    render(<PatternLibraryPanel confirmSwitch={confirmSwitch} />);

    await userEvent.click(rowFor('Riff A'));
    expect(getEditingPattern()?.id).toBe(b);

    await userEvent.click(screen.getByRole('button', { name: 'New pattern' }));
    expect(getLibraryPatterns()).toHaveLength(2);

    await userEvent.click(screen.getByRole('button', { name: 'Delete Riff B' }));
    expect(names()).toEqual(['Riff A', 'Riff B']);

    // Deleting a row that is NOT open changes nothing about what is open, so it
    // must not be gated on a question about the open pattern's unsaved work.
    const commit = vi.fn();
    confirmSwitch.mockReturnValue(commit);
    await userEvent.click(rowFor('Riff A'));
    expect(getEditingPattern()?.id).toBe(a);
    // Run only once the switch has actually happened — see `SwitchGuard`.
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('does not run the caller’s discard when the create it agreed to is refused', async () => {
    seed('Riff A');
    const commit = vi.fn();
    const confirmSwitch = vi.fn<SwitchGuard>(() => commit);
    // The lib's `createPattern` returns '' at the tier cap and creates nothing.
    // Store actions live in store state, so this stands in for that refusal.
    const real = usePatternsStore.getState().createPattern;
    usePatternsStore.setState({ createPattern: () => '' });
    try {
      render(<PatternLibraryPanel confirmSwitch={confirmSwitch} />);

      await userEvent.click(screen.getByRole('button', { name: 'New pattern' }));

      expect(confirmSwitch).toHaveBeenCalled();
      // Unsaved voice work destroyed for a pattern that was never made is the
      // one outcome nothing can put back.
      expect(commit).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent(/library refused/i);
      expect(names()).toEqual(['Riff A']);
    } finally {
      usePatternsStore.setState({ createPattern: real });
    }
  });

  it('warns before a switch strands the voice pane, and honours both answers', async () => {
    // The whole point of `confirmSwitch` wired up: the working preset lives in
    // `App`, is keyed by pattern id, and stops applying to anything the moment
    // another pattern opens. Rendered through `App` rather than stubbed, because
    // what is being checked is that the two halves are actually connected.
    seed('Riff A');
    const b = seed('Riff B');
    const asked: string[] = [];
    vi.stubGlobal('confirm', (message?: string) => {
      asked.push(String(message));
      return false;
    });
    render(<App />);
    const rail = () => within(screen.getByRole('complementary'));

    // One click on a voice control is an unsaved edit.
    await userEvent.click(screen.getByRole('button', { name: 'Add Amp' }));
    await userEvent.click(rail().getByRole('button', { name: 'Open pattern Riff A' }));

    expect(asked).toContain('Discard unsaved changes to this voice?');
    expect(getEditingPattern()?.id).toBe(b);

    vi.stubGlobal('confirm', () => true);
    await userEvent.click(rail().getByRole('button', { name: 'Open pattern Riff A' }));

    expect(getEditingPattern()?.name).toBe('Riff A');
  });

  it('discards the stranded voice copy even with the amp pane folded away', async () => {
    // The reason the discard lives in `App` and not in `VoicePane`'s own
    // retire-a-stranded-copy effect: `PaneStack` unmounts a collapsed pane's
    // body, so with Instrument & Amp folded that effect never runs.
    //
    // The round trip is what makes the assertion able to fail. Switching A → B
    // alone proves nothing — the working copy is keyed by pattern id, so it
    // reads as clean against B whether or not anything cleared it. Coming BACK
    // to A makes the key match again, and an uncleared copy is live and unsaved
    // the moment the pane is unfolded.
    seed('Riff A');
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Add Amp' }));
    expect(screen.getByText('Unsaved')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Collapse Instrument & Amp' }));
    const rail = () => within(screen.getByRole('complementary'));
    await userEvent.click(rail().getByRole('button', { name: 'New pattern' }));
    await userEvent.click(rail().getByRole('button', { name: 'Open pattern Riff A' }));
    await userEvent.click(screen.getByRole('button', { name: 'Expand Instrument & Amp' }));

    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(screen.queryByText('Unsaved')).toBeNull();
    // `applyVoicePreset(null)`, the other half of the discard, is NOT asserted:
    // the engine's tagged copy is module-private to `playbackService` and jsdom
    // has no Web Audio, so nothing outside the seam can observe it.
  });

  it('does not ask when deleting a row that is not open', async () => {
    seed('Riff A');
    seed('Riff B');
    const confirmSwitch = vi.fn<SwitchGuard>(() => () => {});
    render(<PatternLibraryPanel confirmSwitch={confirmSwitch} />);

    await userEvent.click(screen.getByRole('button', { name: 'Delete Riff A' }));

    expect(confirmSwitch).not.toHaveBeenCalled();
    expect(names()).toEqual(['Riff B']);
  });
});
