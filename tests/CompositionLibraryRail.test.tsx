import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_PATTERNS_STATE, usePatternsStore } from '@fretwork/lib';
import { CompositionLibraryRail } from '../src/composition/CompositionLibraryRail';
import {
  addPlacement,
  addTrack,
  getEditingComposition,
  getLibraryCompositions,
  openBlankComposition,
  selectPlacements,
  selectTrack,
} from '../src/composition/compositionService';
import { getEditingPattern, openBlankPattern } from '../src/patterns/patternService';
import { stop } from '../src/audio/playbackService';

/**
 * The composition library, in the composition page's rail (CP-17).
 *
 * `PatternLibraryPanel`'s sibling and deliberately its mirror — create, switch,
 * rename, duplicate, delete, each a call to a seam function that already refuses
 * in words. What differs is what a row IS: a pattern row is a drag source for the
 * grid beside it, and a composition row switches the document the whole page is
 * looking at.
 *
 * `stop` is stood in for because jsdom has no Web Audio and the transport having
 * been released is not observable any other way. The seam is otherwise real: the
 * point of these tests is that a press reaches `library.compositions`, which a
 * mocked seam would assert away.
 */
vi.mock('../src/audio/playbackService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audio/playbackService')>();
  return { ...actual, stop: vi.fn() };
});

beforeEach(() => {
  sessionStorage.clear();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  selectPlacements([]);
  selectTrack(null);
  vi.mocked(stop).mockClear();
  vi.restoreAllMocks();
});

const rowFor = (name: string) => screen.getByRole('button', { name: `Open composition ${name}` });
const names = () => getLibraryCompositions().map((c) => c.name);

describe('CompositionLibraryRail', () => {
  it('lists what the library holds and marks the one being arranged', () => {
    openBlankComposition('First');
    openBlankComposition('Second');
    render(<CompositionLibraryRail />);

    expect(rowFor('First')).toBeInTheDocument();
    expect(rowFor('Second')).toHaveAttribute('aria-current', 'true');
    expect(rowFor('First')).not.toHaveAttribute('aria-current');
  });

  it('says so when there is nothing yet, rather than showing an empty list', () => {
    render(<CompositionLibraryRail />);

    expect(screen.getByText(/no compositions yet/i)).toBeInTheDocument();
  });

  it('creates one, opens it, and puts the rename form up on it', async () => {
    const user = userEvent.setup();
    render(<CompositionLibraryRail />);

    await user.click(screen.getByRole('button', { name: /New composition/ }));

    expect(getLibraryCompositions()).toHaveLength(1);
    expect(getEditingComposition()?.id).toBe(getLibraryCompositions()[0].id);
    // Named but unnamed-by-you: the form is how you say what it is while you
    // still know, and it is the same form Rename opens.
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('switches the open composition, releasing the transport first', async () => {
    const user = userEvent.setup();
    openBlankComposition('First');
    const firstId = getEditingComposition()?.id;
    openBlankComposition('Second');
    render(<CompositionLibraryRail />);

    await user.click(rowFor('First'));

    expect(getEditingComposition()?.id).toBe(firstId);
    // The engine is still streaming the composition that WAS open.
    expect(vi.mocked(stop)).toHaveBeenCalled();
  });

  it('does nothing when the row already open is pressed', async () => {
    const user = userEvent.setup();
    openBlankComposition('Only');
    render(<CompositionLibraryRail />);

    await user.click(rowFor('Only'));

    expect(vi.mocked(stop)).not.toHaveBeenCalled();
  });

  it('renames through the seam', async () => {
    const user = userEvent.setup();
    openBlankComposition('Song');
    render(<CompositionLibraryRail />);

    await user.click(screen.getByRole('button', { name: 'Rename Song' }));
    const field = screen.getByRole('textbox');
    await user.clear(field);
    await user.type(field, 'Blues in C');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(names()).toEqual(['Blues in C']);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('announces a refusal rather than failing silently', async () => {
    const user = userEvent.setup();
    openBlankComposition('Song');
    render(<CompositionLibraryRail />);

    await user.click(screen.getByRole('button', { name: 'Rename Song' }));
    await user.clear(screen.getByRole('textbox'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // Every refusal the seam returns is a case where nothing visibly happens.
    expect(screen.getByRole('alert')).toHaveTextContent(/needs a name/i);
    expect(names()).toEqual(['Song']);
  });

  it('duplicates without switching away from what is open', async () => {
    const user = userEvent.setup();
    openBlankComposition('Song');
    const openId = getEditingComposition()?.id;
    render(<CompositionLibraryRail />);

    await user.click(screen.getByRole('button', { name: 'Duplicate Song' }));

    expect(getLibraryCompositions()).toHaveLength(2);
    expect(getEditingComposition()?.id).toBe(openId);
    expect(names().every((n) => n.length > 0)).toBe(true);
    expect(new Set(names()).size).toBe(2);
  });

  it('confirms a delete, and leaves NOTHING open when it was the one being arranged', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    openBlankComposition('Song');
    const track = addTrack('Rhythm');
    if (!track.ok) throw new Error(track.reason);
    openBlankPattern('Riff');
    const pattern = getEditingPattern();
    if (!pattern) throw new Error('no pattern');
    addPlacement(pattern.id, track.value.id);
    render(<CompositionLibraryRail />);

    await user.click(screen.getByRole('button', { name: 'Delete Song' }));

    expect(window.confirm).toHaveBeenCalled();
    expect(getLibraryCompositions()).toEqual([]);
    // CP-17: no successor is chased — the page's empty state is a real state.
    expect(getEditingComposition()).toBeNull();
  });

  it('keeps it when the confirmation is declined', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    openBlankComposition('Song');
    render(<CompositionLibraryRail />);

    await user.click(screen.getByRole('button', { name: 'Delete Song' }));

    expect(names()).toEqual(['Song']);
  });

  it('describes a row by what is in it', async () => {
    openBlankComposition('Song');
    const track = addTrack('Rhythm');
    if (!track.ok) throw new Error(track.reason);
    render(<CompositionLibraryRail />);

    // Two tracks: the one the lib seeds and the one added above.
    expect(within(rowFor('Song')).getByText(/2 tracks/i)).toBeInTheDocument();
  });
});
