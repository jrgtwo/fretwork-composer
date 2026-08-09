import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_PATTERNS_STATE, MAX_COMPOSITION_TRACKS, usePatternsStore } from '@fretwork/lib';

/**
 * AG-07 — the composition page's command panel.
 *
 * ⚠ **THE END-TO-END RUN IS NOT TESTED HERE, AND CANNOT BE.** jsdom has no
 * network, so there is no provider to reach; `AgentService.test.ts` states the
 * same thing about the seam and this file inherits it. What is testable is the
 * panel's own behaviour AROUND a run, and that is where every defect this ticket
 * is about lives:
 *
 *   - the document LOCK is released on every exit path, including the ones
 *     nobody thinks about (a refusal, an unmount mid-run) — a leaked one makes
 *     the page read-only until the tab is reloaded;
 *   - a cancelled job leaves the composition exactly as it was;
 *   - a finished job's work survives, as ONE undo step;
 *   - the run view survives a MODE CHANGE, which is the failure the ticket names
 *     by hand: a backing track takes minutes and the user will switch modes
 *     while it runs.
 *
 * The harness is mocked at its module boundary, the way `AgentService.test.ts`
 * does it and for the same reason: exactly one module imports
 * `agent-harness/browser`, so one `vi.mock` replaces it — and the mock is what
 * lets a "run" call real tools at times this test chooses.
 */

// -------------------------------------------------------- the harness mock ---

interface ToolDefLike {
  name: string;
  handler: (args: unknown) => unknown;
}

interface HarnessEvent {
  type: string;
  name?: string;
  result?: unknown;
  [key: string]: unknown;
}

const harness = vi.hoisted(() => {
  return {
    /** Every registry the seam built, in order — the last one is the live run's. */
    registries: [] as { name: string; handler: (args: unknown) => unknown }[][],
    /** The live run's handles, set by `runAgent` when the panel starts one. */
    live: null as null | {
      onEvent: (event: unknown) => void;
      signal: AbortSignal | undefined;
      maxIters: number | undefined;
      finish: (result: { stoppedReason: string; content: string }) => void;
    },
    /** Set to make `runAgent` throw instead of running — the "provider died"
     *  path, which `runAgentTask` turns into a returned refusal. */
    throwWith: null as string | null,
  };
});

vi.mock('agent-harness/browser', () => {
  class ToolRegistry {
    readonly defs: { name: string; handler: (args: unknown) => unknown }[] = [];
    constructor() {
      harness.registries.push(this.defs);
    }
    register(tools: { name: string; handler: (args: unknown) => unknown }[]): void {
      this.defs.push(...tools);
    }
  }
  class OpenAICompatibleClient {}
  return {
    ToolRegistry,
    OpenAICompatibleClient,
    runAgent: (
      _agent: unknown,
      _input: string,
      options: {
        onEvent?: (event: unknown) => void;
        signal?: AbortSignal;
        maxIters?: number;
      },
    ) => {
      if (harness.throwWith !== null) throw new Error(harness.throwWith);
      return new Promise<{ stoppedReason: string; content: string }>((resolve) => {
        harness.live = {
          onEvent: (event) => options.onEvent?.(event),
          signal: options.signal,
          maxIters: options.maxIters,
          finish: resolve,
        };
        // The harness honours the signal mid-run and reports the run as a
        // SUCCESS that stopped early — `agentService` documents that, and the
        // panel's rollback hangs off it.
        options.signal?.addEventListener('abort', () =>
          resolve({ stoppedReason: 'aborted', content: '' }),
        );
      });
    },
  };
});

import { CompositionCommandPanel } from '../src/ai/CompositionCommandPanel';
import { commandsForPage } from '../src/ai/commandCatalog';
import { setConnectorSettings } from '../src/ai/connectorSettings';
import { TRACK_CAP_REASON } from '../src/composition/compositionService';
import {
  addPlacement,
  addTrack,
  clearHistory,
  closePlacementEditing,
  endJob,
  ensureComposition,
  getTracks,
  isJobRunning,
  openPlacementForEditing,
  undo,
} from '../src/composition/compositionService';
import {
  clearHistory as clearPatternHistory,
  getEditingPattern,
  openBlankPattern,
  stampNote,
  undo as patternUndo,
} from '../src/patterns/patternService';

beforeEach(() => {
  sessionStorage.clear();
  usePatternsStore.setState({
    ...DEFAULT_PATTERNS_STATE,
    library: { patterns: [], compositions: [], collections: [] },
  });
  clearHistory();
  clearPatternHistory();
  // Module state on the seam: a job leaked by one test would refuse every write
  // in the next one and disable half the UI with it. An open PLACEMENT is the
  // same kind of leak one document down — it repoints the lib's single pattern
  // pointer, so the next test's pattern writes would land in a block.
  endJob();
  closePlacementEditing();
  harness.registries.length = 0;
  harness.live = null;
  harness.throwWith = null;
  setConnectorSettings({ baseUrl: 'http://localhost:8080/v1', token: '' });
});

// ------------------------------------------------------------------ helpers ---

const BACKING_TRACK = 'Create a backing track';

/** Pick a command and press Run. Returns once the run is in flight. */
async function startRun(label = BACKING_TRACK) {
  await userEvent.click(screen.getByRole('button', { name: label }));
  await userEvent.click(screen.getByRole('button', { name: 'Run' }));
}

/** Call one of the run's OWN tools, exactly as the loop would: the started
 *  event, the real handler, then the finished event carrying its result. This is
 *  what makes the writes below the agent's rather than the user's — they go
 *  through `jobWrite`, so the job lock lets them past. */
function callTool(name: string, args: unknown = {}): unknown {
  const defs = harness.registries.at(-1);
  const def = defs?.find((d: ToolDefLike) => d.name === name);
  if (!def) throw new Error(`the run was not given ${name}`);
  let result: unknown;
  act(() => {
    harness.live?.onEvent({ type: 'tool.started', runId: 'r', callId: 'c', name });
    result = def.handler(args);
    harness.live?.onEvent({
      type: 'tool.finished',
      runId: 'r',
      callId: 'c',
      name,
      ok: true,
      result,
      ms: 1,
    } satisfies HarnessEvent);
  });
  return result;
}

/** Let the run's loop end the way the harness would. */
async function finishRun(stoppedReason = 'answered', content = 'Built it.') {
  await act(async () => {
    harness.live?.finish({ stoppedReason, content });
    await Promise.resolve();
  });
}

const report = () => screen.getByRole('button', { name: 'Cancel' }).parentElement!;

/**
 * A block on a track, open for editing — which is what EDIT MODE means, and not
 * what entering edit mode does. Entering the mode only ever CLOSES a placement;
 * one opens when a lane is pressed. Built through the seams because the panel is
 * rendered on its own here, with no grid to press.
 */
function openBlock(): { placementId: string; patternId: string } {
  ensureComposition();
  const track = addTrack('Riff track');
  if (!track.ok) throw new Error(track.reason);
  const pattern = openBlankPattern('Riff');
  if (!pattern.ok) throw new Error(pattern.reason);
  // A note of the user's already in it — an empty block cannot tell "the run's
  // work was kept" apart from "the block was emptied".
  const seeded = stampNote({ stringIndex: 0, fret: 3, tick: 0, durationTicks: 480 });
  if (!seeded.ok) throw new Error(seeded.reason);
  const placement = addPlacement(pattern.value.id, track.value.id, 0);
  if (!placement.ok) throw new Error(placement.reason);
  const opened = openPlacementForEditing(placement.value);
  if (!opened.ok) throw new Error(opened.reason);
  clearHistory();
  clearPatternHistory();
  return { placementId: placement.value, patternId: pattern.value.id };
}

// -------------------------------------------------------------- the catalog ---

describe('which commands the panel offers', () => {
  it('offers the composition rows in pattern mode', () => {
    ensureComposition();
    render(<CompositionCommandPanel mode="pattern" />);

    expect(screen.getByRole('button', { name: BACKING_TRACK })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create a bass line' })).toBeInTheDocument();
    // A voice-mode row is not on offer here — by its REAL label, which is the
    // only kind of negative assertion worth having. A name no command carries
    // passes whether or not the modes are honoured at all.
    expect(screen.queryByRole('button', { name: 'Dial in a tone' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Balance the mix' })).not.toBeInTheDocument();
  });

  it('offers the voice rows in voice mode, and not the pattern-mode ones', () => {
    ensureComposition();
    render(<CompositionCommandPanel mode="voice" />);

    expect(screen.getByRole('button', { name: 'Dial in a tone' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: BACKING_TRACK })).not.toBeInTheDocument();
  });

  /**
   * Edit mode has no rows of its own and needs none: `openPlacementForEditing`
   * aims the lib's single pattern-editing pointer at the block and
   * `patternService` routes writes to that placement's snapshot, so the PATTERN
   * page's rows act on the block being edited unchanged.
   */
  it('offers the pattern page’s rows in edit mode, with a block open', () => {
    openBlock();
    render(<CompositionCommandPanel mode="edit" />);

    expect(screen.getByRole('button', { name: 'Fix the timing' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: BACKING_TRACK })).not.toBeInTheDocument();
  });

  /**
   * ⚠ "Generate a pattern" opens a NEW document — its template says so in as
   * many words — and `openPatternForEditing` nulls the placement pointer, so run
   * against a block it would send every later stamp into a library pattern
   * nobody is looking at, outside the rollback and off-screen. Withheld here;
   * the tool refuses for itself as well, because `Command.tools` is not
   * enforcement (tests/AgentTools).
   */
  it('withholds the row that opens a different document from edit mode', () => {
    openBlock();
    render(<CompositionCommandPanel mode="edit" />);

    expect(screen.queryByRole('button', { name: 'Fix the timing' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate a pattern' })).not.toBeInTheDocument();
    // Dropped by the PANEL, not deleted from the catalog: the pattern page still
    // offers it, and this is the line that fails if someone "fixes" this by
    // removing the row instead.
    expect(commandsForPage('pattern').map((command) => command.label)).toContain(
      'Generate a pattern',
    );
  });

  /**
   * EDIT MODE IS NOT THE SAME AS A BLOCK BEING OPEN. With none open,
   * `writePatternBack` falls through to its LIBRARY branch, so these rows would
   * rewrite whatever pattern the pattern page left open — off-screen, and
   * covered by neither the rollback nor the lock.
   */
  it('offers nothing in edit mode until a block is actually open', () => {
    ensureComposition();
    openBlankPattern('The user’s own pattern');
    render(<CompositionCommandPanel mode="edit" />);

    expect(screen.queryByRole('button', { name: 'Fix the timing' })).not.toBeInTheDocument();
    expect(screen.getByText(/Press a block in the arrangement/)).toBeInTheDocument();
    // And no Run button to reach, which is what makes a guard inside `start`
    // unnecessary rather than merely unreached.
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
    expect(isJobRunning()).toBe(false);
  });
});

// ------------------------------------------------------------------ the run ---

describe('a run in flight', () => {
  it('reports the tools as they run, and marks the one in flight', async () => {
    ensureComposition();
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun();
    callTool('read_composition');

    const running = report();
    expect(within(running).getByText(/Running…/)).toBeInTheDocument();
    // The trailing ellipsis is the MARK, and it is the only thing separating a
    // job whose tools take seconds each from one that has stalled. Asserted
    // rather than named in the test title.
    expect(within(running).getByText('1. read_composition …')).toBeInTheDocument();
    // No percentage anywhere: a job has no fixed number of steps, and the panel
    // says so rather than drawing a bar against a guess.
    expect(within(running).getByText(/No total to count towards/)).toBeInTheDocument();

    callTool('composition_add_track', { name: 'Drums' });
    // The mark MOVES; it is not simply appended to everything.
    expect(within(report()).getByText('1. read_composition')).toBeInTheDocument();
    expect(within(report()).getByText('2. composition_add_track …')).toBeInTheDocument();

    await finishRun();
    // And it is gone once nothing is in flight.
    expect(within(report()).queryByText(/…$/)).not.toBeInTheDocument();
  });

  /**
   * ⚠ THE REACHABLE VERSION OF "a control that vanishes mid-run". The mode bar
   * is disabled for the duration of a job, so a mode switch cannot strand
   * anyone — but the command list is right there and clicking a row used to
   * clear the report unconditionally, which disabled Cancel while the job still
   * held the document: mode bar dead, undo inert, every user write refused, and
   * nothing on screen saying why.
   */
  it('keeps the run — and Cancel — when another command is picked mid-run', async () => {
    ensureComposition();
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun();
    callTool('read_composition');

    await userEvent.click(screen.getByRole('button', { name: 'Create a bass line' }));

    const running = report();
    expect(within(running).getByText(/Running…/)).toBeInTheDocument();
    // Still named as the command that is actually running, not the one just
    // clicked.
    expect(within(running).getByText(new RegExp(BACKING_TRACK))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();

    // And the way out still works.
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(isJobRunning()).toBe(false);
  });

  /**
   * The command LIST swaps with the mode; the report does not. This is the
   * reachable case — the lock is released, so the mode bar is live again and the
   * user goes to look at what was built while the outcome and its refusals stay
   * on screen.
   */
  it('keeps a finished run’s report across a mode change', async () => {
    ensureComposition();
    const { rerender } = render(<CompositionCommandPanel mode="pattern" />);

    await startRun();
    callTool('read_composition');
    await finishRun('answered', 'Added a drum track.');

    rerender(<CompositionCommandPanel mode="voice" />);

    expect(screen.queryByRole('button', { name: BACKING_TRACK })).not.toBeInTheDocument();
    const done = report();
    expect(within(done).getByText(new RegExp(BACKING_TRACK))).toBeInTheDocument();
    expect(within(done).getByText(/Added a drum track\./)).toBeInTheDocument();
  });

  /**
   * ⚠ DEFENCE, NOT A LIVE PATH, and the test says so rather than implying the
   * app produces this transition: `CompositionPage` disables the mode bar while
   * a job holds the document, so nothing in the app changes `mode` mid-run
   * today. What this pins is the STRUCTURE that makes the disable unnecessary
   * for correctness — the run is rendered outside the selected-command block, so
   * it does not travel with the list. Move it inside `{selected && …}` and this
   * fails.
   */
  it('would survive a mode change mid-run: the run is not rendered inside the form', async () => {
    ensureComposition();
    const { rerender } = render(<CompositionCommandPanel mode="pattern" />);

    await startRun();
    callTool('read_composition');

    rerender(<CompositionCommandPanel mode="voice" />);

    // The list swapped…
    expect(screen.queryByRole('button', { name: BACKING_TRACK })).not.toBeInTheDocument();
    // …and the run did not. Including which command is running, because the form
    // that started it is no longer on screen to say so.
    const running = report();
    expect(within(running).getByText(new RegExp(BACKING_TRACK))).toBeInTheDocument();
    expect(within(running).getByText(/1\. read_composition/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();

    await finishRun();
  });

  /**
   * `RUN_TIMEOUT_MS` and `MAX_ITERS` are sized for a JOB rather than for a
   * command — ten minutes and forty round trips, against AG-06's three and
   * twelve — and both are argued at length in the panel. Pinned here so the
   * argument and the numbers cannot drift apart.
   */
  it('gives the run forty round trips and an abort signal', async () => {
    ensureComposition();
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun();

    expect(harness.live?.maxIters).toBe(40);
    expect(harness.live?.signal).toBeInstanceOf(AbortSignal);

    await finishRun();
  });
});

// ----------------------------------------------------------- the job lock ---

describe('the document lock', () => {
  it('is held for the duration of a run and released when it answers', async () => {
    ensureComposition();
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun();
    expect(isJobRunning()).toBe(true);

    await finishRun();
    expect(isJobRunning()).toBe(false);
  });

  it('is released when the run is cancelled', async () => {
    ensureComposition();
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(isJobRunning()).toBe(false);
  });

  it('is released when the run comes back refused', async () => {
    ensureComposition();
    harness.throwWith = 'Failed to fetch';
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun();

    expect(isJobRunning()).toBe(false);
    expect(within(report()).getByText(/Failed to fetch/)).toBeInTheDocument();
  });

  it('is released when the panel is unmounted mid-run', async () => {
    ensureComposition();
    const { unmount } = render(<CompositionCommandPanel mode="pattern" />);

    await startRun();
    expect(isJobRunning()).toBe(true);

    await act(async () => {
      unmount();
      await Promise.resolve();
    });

    // A leaked lock here is the worst of the four: nothing is left on screen to
    // release it and the page stays read-only until the tab is reloaded.
    expect(isJobRunning()).toBe(false);
  });

  it('refuses to start when there is no composition to work on', async () => {
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun();

    expect(isJobRunning()).toBe(false);
    expect(within(report()).getByText(/No composition is open/)).toBeInTheDocument();
  });

  /**
   * The anti-hallucination check, refused BEFORE the lock. `fillForNow` carries
   * the live allow-list, and a slot whose source has nothing to offer — no
   * patterns in the library — cannot be spent on a dead id.
   */
  it('is never taken when the command no longer fills', async () => {
    ensureComposition();
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun('Lay a pattern down the timeline');

    expect(harness.live).toBeNull();
    expect(isJobRunning()).toBe(false);
    expect(within(report()).getByText(/Pattern has no value/)).toBeInTheDocument();
  });

  /**
   * The app's DEFAULT state, and it must not exercise the lock. Taking the
   * document, opening a bracket and running the rollback path over a run that
   * never existed is a page that flickers read-only for a user who has simply
   * not set a provider yet.
   */
  it('is never taken when no provider is configured', async () => {
    ensureComposition();
    setConnectorSettings({ baseUrl: '', token: '' });
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun();

    expect(harness.live).toBeNull();
    expect(isJobRunning()).toBe(false);
    expect(within(report()).getByText(/No provider is configured/)).toBeInTheDocument();
  });
});

// ------------------------------------------------------------- the rollback ---

describe('a cancelled job', () => {
  it('puts the arrangement back exactly as it was', async () => {
    ensureComposition();
    const before = getTracks().length;
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun();
    callTool('composition_add_track', { name: 'Drums' });
    callTool('composition_add_track', { name: 'Bass' });
    expect(getTracks()).toHaveLength(before + 2);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // The ticket's acceptance criterion, in one line.
    expect(getTracks()).toHaveLength(before);
    expect(within(report()).getByText(/put back the way it was/)).toBeInTheDocument();
    // Not "Done": the loop did not finish because it had finished.
    expect(within(report()).getByText(/Stopped/)).toBeInTheDocument();
  });

  it('rolls back when the panel is unmounted mid-run, rather than leaving half an arrangement', async () => {
    ensureComposition();
    const before = getTracks().length;
    const { unmount } = render(<CompositionCommandPanel mode="pattern" />);

    await startRun();
    callTool('composition_add_track', { name: 'Drums' });

    await act(async () => {
      unmount();
      await Promise.resolve();
    });

    expect(getTracks()).toHaveLength(before);
  });

  /**
   * ⚠ ASSERTED AGAINST THE USER'S OWN LAST EDIT, not against "nothing moved".
   * An abort that pushed a step would push one carrying the snapshot it had just
   * restored — so an undo would rewrite identical content and a test that only
   * checked the track COUNT would pass either way. The way to see the difference
   * is to have something of the user's one press away and check the press
   * reaches it.
   */
  it('leaves the user’s own undo stack untouched — one press still reaches their edit', async () => {
    ensureComposition();
    const before = getTracks().length;
    // The user's own edit, before the job — one undo step of their own.
    expect(addTrack('Mine').ok).toBe(true);
    expect(getTracks()).toHaveLength(before + 1);

    render(<CompositionCommandPanel mode="pattern" />);

    await startRun();
    callTool('composition_add_track', { name: 'Drums' });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(getTracks()).toHaveLength(before + 1);
    // ONE press, and it reaches the user's track — not a step of the job's
    // standing in front of it.
    act(() => undo());
    expect(getTracks()).toHaveLength(before);
    expect(getTracks().some((track) => track.name === 'Mine')).toBe(false);
  });

  /**
   * ⚠ THE ONE THING THE ROLLBACK DOES NOT REACH. A job authors its parts as
   * patterns and those live in the OTHER seam's history, so a cancel leaves them
   * in the library. The report says so; a bare "put back the way it was" over a
   * library with three new patterns in it is the promise that makes Cancel feel
   * safer than it is.
   */
  it('says the patterns it wrote are still in the library', async () => {
    ensureComposition();
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun();
    callTool('pattern_open_blank', { name: 'Bass line' });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(within(report()).getByText(/still in your library/)).toBeInTheDocument();
    expect(getEditingPattern()?.name).toBe('Bass line');
  });

  it('does not say it when the run wrote no patterns', async () => {
    ensureComposition();
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun();
    callTool('composition_add_track', { name: 'Drums' });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(within(report()).getByText(/put back the way it was/)).toBeInTheDocument();
    expect(within(report()).queryByText(/still in your library/)).not.toBeInTheDocument();
  });

  /**
   * The deadline is what separates "the provider never finished" from "you
   * cancelled" — and both arrive as the same `{ok:true, stoppedReason:'aborted'}`
   * from the harness, so nothing but this flag tells them apart.
   */
  it('gives up on the deadline, says so, and still rolls back', async () => {
    vi.useFakeTimers();
    try {
      ensureComposition();
      const before = getTracks().length;
      render(<CompositionCommandPanel mode="pattern" />);

      // `fireEvent`, not `userEvent`: the deadline is a `setTimeout` taken when
      // the run starts, so the clock has to already be fake by then — and
      // `userEvent`'s own delays run on the same faked clock.
      fireEvent.click(screen.getByRole('button', { name: BACKING_TRACK }));
      fireEvent.click(screen.getByRole('button', { name: 'Run' }));
      callTool('composition_add_track', { name: 'Drums' });

      await act(async () => {
        // Ten minutes — `RUN_TIMEOUT_MS`, sized for a job rather than for one
        // batched write.
        vi.advanceTimersByTime(600_000);
        await Promise.resolve();
      });

      expect(within(report()).getByText(/Gave up after 10 minutes/)).toBeInTheDocument();
      // NOT "Cancelled": nobody cancelled this one.
      expect(within(report()).queryByText(/^Cancelled\.$/)).not.toBeInTheDocument();
      expect(getTracks()).toHaveLength(before);
      expect(isJobRunning()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a finished job', () => {
  it('keeps its work, as ONE undo step', async () => {
    ensureComposition();
    const before = getTracks().length;
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun();
    callTool('composition_add_track', { name: 'Drums' });
    callTool('composition_add_track', { name: 'Bass' });
    await finishRun();

    expect(getTracks()).toHaveLength(before + 2);
    // Two tool calls, two seam writes, ONE press — the run-level bracket. Both
    // tracks go, not just the second.
    act(() => undo());
    expect(getTracks()).toHaveLength(before);
  });

  it('shows what the model said, under what it actually called', async () => {
    ensureComposition();
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun();
    callTool('read_composition');
    await finishRun('answered', 'Added a drum track and a bass track.');

    const done = report();
    expect(within(done).getByText(/Done/)).toBeInTheDocument();
    expect(within(done).getByText(/Added a drum track and a bass track\./)).toBeInTheDocument();
  });
});

// --------------------------------------------------------------- refusals ---

describe('refusals the run met along the way', () => {
  /**
   * The track cap is a MEMORY limit refused at the seam, and the model is free
   * to write a confident summary that never mentions it. Surfacing it is the
   * difference between "the run stopped adding tracks" and a silent stop.
   */
  it('states the track cap rather than letting the model paper over it', async () => {
    ensureComposition();
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun();
    // Bounded: an unbounded `while` here would HANG the suite rather than fail
    // it the day `composition_add_track` starts refusing an empty-args call.
    for (let i = getTracks().length; i < MAX_COMPOSITION_TRACKS; i++) {
      callTool('composition_add_track', {});
    }
    expect(getTracks()).toHaveLength(MAX_COMPOSITION_TRACKS);
    // The one over the line.
    callTool('composition_add_track', {});
    await finishRun('answered', 'All done — five tracks, sounding great.');

    expect(within(report()).getByText(TRACK_CAP_REASON)).toBeInTheDocument();
  });

  /** A model that hits the cap typically hits it repeatedly. The same sentence
   *  five times is noise that buries the four other things a run may have been
   *  refused. */
  it('says each refusal once, however many times the run met it', async () => {
    ensureComposition();
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun();
    for (let i = getTracks().length; i < MAX_COMPOSITION_TRACKS; i++) {
      callTool('composition_add_track', {});
    }
    callTool('composition_add_track', {});
    callTool('composition_add_track', {});
    callTool('composition_add_track', {});
    await finishRun();

    expect(within(report()).getAllByText(TRACK_CAP_REASON)).toHaveLength(1);
  });
});

// ------------------------------------------------------------- edit mode ---

/**
 * ⚠ AN EDIT-MODE RUN IS A DIFFERENT RUN. `command.page` — not `mode` — picks the
 * agent, the write-tool set, the seam whose gesture brackets it, and whether a
 * cancel rolls back. A pattern row taken from edit mode runs on the PATTERN
 * seam, and keeps AG-06's deliberate no-rollback behaviour: a pattern command is
 * a handful of calls over seconds and its partial work is one undo press.
 */
describe('a run started from edit mode', () => {
  it('keeps its partial work as one undo step, and does not touch the arrangement', async () => {
    openBlock();
    const tracksBefore = getTracks().length;
    render(<CompositionCommandPanel mode="edit" />);

    await startRun('Fix the timing');
    callTool('pattern_stamp_notes', {
      notes: [{ stringIndex: 2, fret: 5, tick: 480, durationTicks: 480 }],
    });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // NOT rolled back — the divergence, stated as a test. The note is still
    // there and the panel does not claim otherwise.
    expect(getEditingPattern()?.events).toHaveLength(2);
    expect(within(report()).queryByText(/put back the way it was/)).not.toBeInTheDocument();
    // …and one press takes it back, which is what the panel promises instead.
    act(() => patternUndo());
    expect(getEditingPattern()?.events).toHaveLength(1);

    // The composition was never in it.
    expect(getTracks()).toHaveLength(tracksBefore);
    expect(isJobRunning()).toBe(false);
  });

  /** The lock is taken for edit-mode runs too — not because the pattern seam
   *  needs it, but because it is what disables the mode bar, and a mode change
   *  mid-run would close the placement out from under the agent. */
  it('still holds the document lock for the duration', async () => {
    openBlock();
    render(<CompositionCommandPanel mode="edit" />);

    await startRun('Fix the timing');
    expect(isJobRunning()).toBe(true);

    await finishRun();
    expect(isJobRunning()).toBe(false);
  });
});
