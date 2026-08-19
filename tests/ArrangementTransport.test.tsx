import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_PATTERNS_STATE,
  PPQ,
  totalDurationTicks,
  useMetronomeStore,
  usePatternsStore,
} from '@fretwork/lib';

/**
 * The composition transport, as the DOM sees it.
 *
 * `tests/MultiTrackPlayback.test.tsx` covers the seam — what the engine is built
 * from, what reaches it, what clears on stop. This file covers the other side of
 * that boundary: that the surface renders what the seam publishes and calls what
 * it claims to. The engine is replaced wholesale, which is the same trade
 * `tests/TimelineTransport.test.tsx` makes for the pattern page, and for the same
 * reason — jsdom has no Web Audio.
 *
 * jsdom also has NO LAYOUT, so nothing here asserts that the playhead LOOKS
 * right. `style.left` is a real DOM write and is readable; a rect is not.
 */
vi.mock('../src/audio/playbackService', () => ({
  useCompositionPlayback: vi.fn(),
  playComposition: vi.fn(async () => ({ ok: true, value: undefined })),
  stop: vi.fn(),
  useIsPlaying: vi.fn(() => false),
  useHeadTick: vi.fn((): number | null => null),
  useActivePlacementIds: vi.fn((): readonly string[] => []),
  useLoopBoundaryTicks: vi.fn(() => 0),
  useClickMuted: vi.fn(() => false),
  toggleClick: vi.fn(),
  setClickTimeSignature: vi.fn(),
  setClickSubdivision: vi.fn(),
}));

// The follow-scroll loop reads the transport in its own rAF and writes
// `scrollLeft`, neither of which jsdom can show. What IS worth pinning is the
// ARGUMENTS it is handed — the boundary in particular, which the grid's own
// comment says is the easy one to get wrong.
vi.mock('../src/timeline/useTimelineAutoScroll', () => ({
  useTimelineAutoScroll: vi.fn(),
}));

import { ArrangementGrid } from '../src/composition/ArrangementGrid';
import { CompositionPage } from '../src/composition/CompositionPage';
import { TransportBar } from '../src/composition/TransportBar';
import {
  ARRANGEMENT_ZOOM_LEVELS,
  DEFAULT_ARRANGEMENT_ZOOM_INDEX,
  contentEndTick,
  tickToPx,
  type ArrangementMode,
} from '../src/composition/arrangementMath';
import {
  playComposition,
  setClickSubdivision,
  setClickTimeSignature,
  stop,
  toggleClick,
  useActivePlacementIds,
  useClickMuted,
  useCompositionPlayback,
  useHeadTick,
  useIsPlaying,
  useLoopBoundaryTicks,
} from '../src/audio/playbackService';
import { useTimelineAutoScroll } from '../src/timeline/useTimelineAutoScroll';
import {
  addPlacement,
  addTrack,
  clearHistory,
  getEditingComposition,
  getTracks,
  openBlankComposition,
  resizePlacement,
  selectPlacements,
  selectTrack,
  setCompositionTimeSignature,
} from '../src/composition/compositionService';
import { getEditingPattern, openBlankPattern, stampNote } from '../src/patterns/patternService';

const MODE: ArrangementMode = 'pattern';
const PX_PER_BEAT = ARRANGEMENT_ZOOM_LEVELS[DEFAULT_ARRANGEMENT_ZOOM_INDEX];
const BAR = 4 * PPQ;

beforeEach(() => {
  sessionStorage.clear();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  selectPlacements([]);
  selectTrack(null);
  vi.clearAllMocks();
  vi.mocked(useIsPlaying).mockReturnValue(false);
  vi.mocked(useHeadTick).mockReturnValue(null);
  vi.mocked(useActivePlacementIds).mockReturnValue([]);
  vi.mocked(useLoopBoundaryTicks).mockReturnValue(0);
  vi.mocked(useClickMuted).mockReturnValue(false);
  vi.mocked(playComposition).mockResolvedValue({ ok: true, value: undefined });
});

function seedPattern(): string {
  openBlankPattern('Riff');
  const pattern = getEditingPattern();
  if (!pattern) throw new Error('pattern seam did not open a pattern');
  stampNote({ stringIndex: 0, fret: 0, tick: 0, durationTicks: BAR });
  return pattern.id;
}

/** Two tracks, a block on each — the second one truncated, so the drawn width
 *  and the engine's loop boundary are genuinely different numbers. */
function seedArrangement(): { patternId: string; placements: string[] } {
  // Idempotent, as the `ensureComposition` this replaced was: a helper that
  // CREATES unconditionally would switch away from a composition the test had
  // already opened, and the switch is silent.
  if (!getEditingComposition()) openBlankComposition('Song');
  const patternId = seedPattern();
  addTrack('Rhythm');
  const trackIds = getTracks().map((t) => t.id);
  const placements = [patternId, patternId].map((id, i) =>
    add(id, trackIds[i], i * BAR),
  );
  selectPlacements([]);
  clearHistory();
  return { patternId, placements };
}

function add(patternId: string, trackId: string, atTick: number): string {
  const result = addPlacement(patternId, trackId, atTick);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

const grid = () => render(<ArrangementGrid mode={MODE} />);
const playhead = () => screen.queryByTestId('arrangement-playhead');
const blockEl = (id: string) =>
  document.querySelector<HTMLElement>(`[data-placement="${id}"]`);

describe('meter and click subdivision (CP-18)', () => {
  const meter = () => screen.getByRole('combobox', { name: 'Time signature' });
  const subdivision = () => screen.getByRole('combobox', { name: 'Click subdivision' });

  it('shows the COMPOSITION\'s meter, not the metronome\'s', () => {
    if (!getEditingComposition()) openBlankComposition('Song');
    setCompositionTimeSignature({ numerator: 6, denominator: 8 });
    useMetronomeStore.setState({ timeSignatureId: '4/4' });
    render(<TransportBar />);

    // The document is the source. A transport showing a meter belonging to a
    // document you cannot see is the kind of wrong that reads as lost settings.
    expect(meter()).toHaveValue('6/8');
  });

  it('SAVES the meter on the composition, and tells the click about it', async () => {
    const user = userEvent.setup();
    if (!getEditingComposition()) openBlankComposition('Song');
    render(<TransportBar />);

    await user.selectOptions(meter(), '3/4');

    // Saved on the document — it draws the bars and travels with the arrangement.
    expect(getEditingComposition()?.timeSignature).toEqual({ numerator: 3, denominator: 4 });
    // And handed to the click too, so it is audible now rather than at the next
    // press of Play. What that call DOES is covered where the module is real —
    // tests/MultiTrackPlayback and tests/playbackService.
    expect(vi.mocked(setClickTimeSignature)).toHaveBeenCalledWith('3/4');
  });

  it('saves the subdivision on the composition, and tells the click about it', async () => {
    const user = userEvent.setup();
    if (!getEditingComposition()) openBlankComposition('Song');
    render(<TransportBar />);

    await user.selectOptions(subdivision(), '8ths');

    expect(getEditingComposition()?.subdivision).toBe('8ths');
    expect(vi.mocked(setClickSubdivision)).toHaveBeenCalledWith('8ths');
  });

  it('reads a composition that never chose a subdivision as off', () => {
    if (!getEditingComposition()) openBlankComposition('Song');
    render(<TransportBar />);

    // The lib's null means "use the metronome's current value"; the picker has
    // no such option, and `off` is what it comes to.
    expect(subdivision()).toHaveValue('off');
  });
});

describe('the arrangement playhead', () => {
  it('draws nothing while the head is null', () => {
    seedArrangement();
    grid();

    expect(playhead()).not.toBeInTheDocument();
  });

  it('positions it at the head tick, scaled by zoom', async () => {
    const user = userEvent.setup();
    seedArrangement();
    vi.mocked(useIsPlaying).mockReturnValue(true);
    vi.mocked(useHeadTick).mockReturnValue(2 * PPQ);
    grid();

    // Compared against `arrangementMath`, not a number copied here: the
    // playhead and the blocks must be placed by one function or they disagree.
    expect(playhead()!.style.left).toBe(`${tickToPx(2 * PPQ, PX_PER_BEAT)}px`);

    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    const zoomed = ARRANGEMENT_ZOOM_LEVELS[DEFAULT_ARRANGEMENT_ZOOM_INDEX + 1];
    expect(playhead()!.style.left).toBe(`${tickToPx(2 * PPQ, zoomed)}px`);
  });

  it('draws it at the left edge on tick zero', () => {
    seedArrangement();
    vi.mocked(useIsPlaying).mockReturnValue(true);
    vi.mocked(useHeadTick).mockReturnValue(0);
    grid();

    // Tick 0 is a POSITION, not "no playhead" — a truthiness check here blanks
    // the head for the whole first tick and reads as a dropped frame.
    expect(playhead()!.style.left).toBe('0px');
  });

  it('clears it when the head goes null on stop', () => {
    seedArrangement();
    vi.mocked(useIsPlaying).mockReturnValue(true);
    vi.mocked(useHeadTick).mockReturnValue(PPQ);
    const view = grid();
    expect(playhead()).toBeInTheDocument();

    vi.mocked(useIsPlaying).mockReturnValue(false);
    vi.mocked(useHeadTick).mockReturnValue(null);
    view.rerender(<ArrangementGrid mode={MODE} />);

    // A line parked wherever the last frame put it is how a stopped transport
    // still looks like it is playing.
    expect(playhead()).not.toBeInTheDocument();
  });

  it('lights only the blocks the seam says are sounding', () => {
    const { placements } = seedArrangement();
    vi.mocked(useIsPlaying).mockReturnValue(true);
    vi.mocked(useActivePlacementIds).mockReturnValue([placements[1]]);
    grid();

    expect(blockEl(placements[0])).not.toHaveAttribute('data-playing');
    expect(blockEl(placements[1])).toHaveAttribute('data-playing');
  });
});

describe('follow-scroll', () => {
  it('follows the ENGINE loop boundary, not the drawn width', () => {
    const { placements } = seedArrangement();
    // Truncating the LAST block is what makes the two numbers differ
    // (LIB-GAP(11) — the lib's duration ignores `lengthTicks`).
    resizePlacement(placements[1], BAR / 2);
    const engineBoundary = totalDurationTicks(getEditingComposition()!);
    const drawnWidth = contentEndTick(getEditingComposition()!.tracks);
    // Without this the test could not fail: for an untruncated arrangement both
    // numbers are the same number and either argument would pass.
    expect(drawnWidth).not.toBe(engineBoundary);
    vi.mocked(useIsPlaying).mockReturnValue(true);
    vi.mocked(useLoopBoundaryTicks).mockReturnValue(engineBoundary);
    grid();

    // Following the drawn width would page the view back a bar early on every
    // loop, and the head would already be past where the scroller landed.
    const args = vi.mocked(useTimelineAutoScroll).mock.calls.at(-1)!;
    expect(args[2]).toBe(true);
    expect(args[3]).toBe(engineBoundary);
    expect(args[3]).not.toBe(drawnWidth);
  });
});

describe('the page audio lifecycle', () => {
  it('is mounted by the page, from a leaf that renders nothing', () => {
    seedArrangement();
    render(<CompositionPage mode={MODE} onModeChange={() => {}} />);

    // The hook lives in a null-rendering child so the metronome's beat counters
    // don't reconcile the whole page 4–8× a bar — which is exactly the kind of
    // move that can drop the audio lifecycle entirely and look fine on screen.
    expect(useCompositionPlayback).toHaveBeenCalled();
  });
});

describe('the composition transport bar', () => {
  it('renders nothing with no composition open', () => {
    render(<TransportBar />);

    expect(screen.queryByRole('group', { name: 'Transport' })).not.toBeInTheDocument();
  });

  it('starts playback through the seam', async () => {
    const user = userEvent.setup();
    seedArrangement();
    render(<TransportBar />);

    await user.click(screen.getByRole('button', { name: 'Play' }));

    expect(playComposition).toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it('becomes a stop button while playing', async () => {
    const user = userEvent.setup();
    seedArrangement();
    vi.mocked(useIsPlaying).mockReturnValue(true);
    render(<TransportBar />);

    await user.click(screen.getByRole('button', { name: 'Stop' }));

    expect(stop).toHaveBeenCalled();
    expect(playComposition).not.toHaveBeenCalled();
  });

  it('reports a refusal rather than looking broken', async () => {
    const user = userEvent.setup();
    seedArrangement();
    vi.mocked(playComposition).mockResolvedValue({ ok: false, reason: 'Nothing to play yet.' });
    render(<TransportBar />);

    await user.click(screen.getByRole('button', { name: 'Play' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing to play yet.');
  });

  it('toggles looping on the composition', async () => {
    const user = userEvent.setup();
    seedArrangement();
    render(<TransportBar />);
    const loop = screen.getByRole('button', { name: 'Turn looping on' });
    expect(loop).toHaveAttribute('aria-pressed', 'false');

    await user.click(loop);

    expect(getEditingComposition()!.loop).toBe(true);
    expect(screen.getByRole('button', { name: 'Turn looping off' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('walks the tempo through the composition seam', async () => {
    const user = userEvent.setup();
    seedArrangement();
    const before = getEditingComposition()!.bpm;
    render(<TransportBar />);

    await user.click(screen.getByRole('button', { name: 'Increase tempo' }));
    expect(getEditingComposition()!.bpm).toBe(before + 1);

    await user.click(screen.getByRole('button', { name: 'Decrease tempo' }));
    expect(screen.getByTestId('composition-tempo')).toHaveTextContent(String(before));
  });

  it('mutes the click without touching the transport', async () => {
    const user = userEvent.setup();
    seedArrangement();
    render(<TransportBar />);

    await user.click(screen.getByRole('button', { name: 'Mute metronome click' }));

    // The click bypasses the master bus entirely — muting it must not reach
    // playback at all.
    expect(toggleClick).toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(playComposition).not.toHaveBeenCalled();
  });
});
