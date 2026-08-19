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
 *
 * ── TWO ROUTES, AND EVERY LIST ABOVE IS ABOUT ONE OF THEM ───────────────────
 *
 * Everything named above is the `'single-run'` route — a tool-using agent
 * writing into the OPEN composition, driven here by {@link SINGLE_RUN}. The
 * backing track declares `route: 'ir-job'` and does something else entirely:
 * it runs `irCompositionJob` and IMPORTS A NEW COMPOSITION, so it has no tools
 * to trace, no gesture to bracket and no rollback to assert. That route has its
 * own mock and its own describe at the foot of this file; the two are kept apart
 * because the claims are not the same claims.
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

/**
 * ── THE IR JOB, MOCKED AT ITS OWN MODULE BOUNDARY ───────────────────────────
 *
 * `irCompositionJob` is driven end to end by `IrCompositionJob.test.ts` with its
 * own fakes; what is left to assert HERE is the panel around it, and that is
 * exactly the thing a real job cannot give in jsdom — a chart run needs a
 * provider, and the phases are what is being rendered.
 *
 * So the module is replaced by a promise this file settles by hand, which makes
 * every phase, every failure and the exact moment of a Cancel a choice the test
 * makes rather than a race it hopes for. It is the same technique the harness
 * mock above uses, one seam further out.
 */
const irJob = vi.hoisted(() => ({
  /** The live job's handles, set when the panel starts one. */
  live: null as null | {
    input: string;
    label: string | undefined;
    signal: AbortSignal | undefined;
    progress: (event: unknown) => void;
    settle: (outcome: unknown) => void;
  },
  /** Set to make the job throw synchronously — a defect in the job runner,
   *  which the panel still has to survive with the lock given back. */
  throwWith: null as string | null,
}));

vi.mock('../src/ai/irCompositionJob', () => ({
  runIrCompositionJob: (
    input: string,
    options: {
      signal?: AbortSignal;
      label?: string;
      onProgress?: (event: unknown) => void;
    } = {},
  ) => {
    if (irJob.throwWith !== null) throw new Error(irJob.throwWith);
    return new Promise<unknown>((resolve) => {
      irJob.live = {
        input,
        label: options.label,
        signal: options.signal,
        progress: (event) => options.onProgress?.(event),
        settle: resolve,
      };
      // The real job checks its signal between steps and reports a cancel as a
      // typed refusal that names where it stopped — never as a failure of the
      // model. Its guarantee is the second sentence: nothing was written.
      options.signal?.addEventListener('abort', () =>
        resolve({
          ok: false,
          stopped: 'cancelled',
          reason: 'The job was cancelled while it was writing the chart. Nothing was written.',
        }),
      );
    });
  },
}));

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
  getEditingComposition,
  getEditingPlacementId,
  getSelectedPlacementIds,
  getSelectedTrackId,
  getTracks,
  isJobRunning,
  openBlankComposition,
  openPlacementForEditing,
  selectPlacements,
  selectTrack,
  undo,
} from '../src/composition/compositionService';
import { beginJobTranscript, clearTranscripts } from '../src/ai/runTranscript';
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
  // Selection is module state on the seam like the two above, and it is asserted
  // on below — a set left behind by one test would be another's starting point.
  selectPlacements([], 'replace');
  clearTranscripts();
  harness.registries.length = 0;
  harness.live = null;
  harness.throwWith = null;
  irJob.live = null;
  irJob.throwWith = null;
  selectTrack(null);
  setConnectorSettings({ baseUrl: 'http://localhost:8080/v1', token: '' });
});

// ------------------------------------------------------------------ helpers ---

const BACKING_TRACK = 'Create a backing track';

/**
 * The composition row every SINGLE-RUN test below drives.
 *
 * ⚠ It used to be the backing track, and that row has moved to the `'ir-job'`
 * route — no tools, no edit to the open composition, no rollback. Everything in
 * this file about the tool trace, the gesture and the rollback is about the
 * OTHER route, so it needs a row still on it; the bass line is one, and it
 * reaches the same tools (`composition_add_track`, `pattern_open_blank`) the
 * assertions below name.
 */
const SINGLE_RUN = 'Create a bass line';

/** Pick a command and press Run. Returns once the run is in flight. */
async function startRun(label = SINGLE_RUN) {
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
  // Idempotent, as the `ensureComposition` this replaced was: a helper that
  // CREATES unconditionally would switch away from a composition the test had
  // already opened, and the switch is silent.
  if (!getEditingComposition()) openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun();
    callTool('read_composition');

    await userEvent.click(screen.getByRole('button', { name: BACKING_TRACK }));

    const running = report();
    expect(within(running).getByText(/Running…/)).toBeInTheDocument();
    // Still named as the command that is actually running, not the one just
    // clicked.
    expect(within(running).getByText(new RegExp(SINGLE_RUN))).toBeInTheDocument();
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
    openBlankComposition('Song');
    const { rerender } = render(<CompositionCommandPanel mode="pattern" />);

    await startRun();
    callTool('read_composition');
    await finishRun('answered', 'Added a drum track.');

    rerender(<CompositionCommandPanel mode="voice" />);

    expect(screen.queryByRole('button', { name: SINGLE_RUN })).not.toBeInTheDocument();
    const done = report();
    expect(within(done).getByText(new RegExp(SINGLE_RUN))).toBeInTheDocument();
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
    openBlankComposition('Song');
    const { rerender } = render(<CompositionCommandPanel mode="pattern" />);

    await startRun();
    callTool('read_composition');

    rerender(<CompositionCommandPanel mode="voice" />);

    // The list swapped…
    expect(screen.queryByRole('button', { name: SINGLE_RUN })).not.toBeInTheDocument();
    // …and the run did not. Including which command is running, because the form
    // that started it is no longer on screen to say so.
    const running = report();
    expect(within(running).getByText(new RegExp(SINGLE_RUN))).toBeInTheDocument();
    expect(within(running).getByText(/1\. read_composition/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();

    await finishRun();
  });

  /**
   * `RUN_TIMEOUT_MS` and `MAX_ITERS` are sized for a JOB rather than for a
   * command — fifteen minutes and sixty round trips, against AG-06's three and
   * twelve — and both are argued at length in the panel. Pinned here so the
   * argument and the numbers cannot drift apart.
   *
   * They are one bound counted two ways, and what holds THAT together is the
   * panel deriving the timeout from the budget rather than these two tests: a
   * pinning test catches a changed constant, not a broken ratio, so a budget
   * raised to eighty with the pin updated to match would have kept both of
   * these green while the wall clock silently stayed at fifteen minutes.
   */
  it('gives the run sixty round trips and an abort signal', async () => {
    openBlankComposition('Song');
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun();

    expect(harness.live?.maxIters).toBe(60);
    expect(harness.live?.signal).toBeInstanceOf(AbortSignal);

    await finishRun();
  });
});

// ----------------------------------------------------------- the job lock ---

describe('the document lock', () => {
  it('is held for the duration of a run and released when it answers', async () => {
    openBlankComposition('Song');
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun();
    expect(isJobRunning()).toBe(true);

    await finishRun();
    expect(isJobRunning()).toBe(false);
  });

  it('is released when the run is cancelled', async () => {
    openBlankComposition('Song');
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(isJobRunning()).toBe(false);
  });

  it('is released when the run comes back refused', async () => {
    openBlankComposition('Song');
    harness.throwWith = 'Failed to fetch';
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun();

    expect(isJobRunning()).toBe(false);
    expect(within(report()).getByText(/Failed to fetch/)).toBeInTheDocument();
  });

  it('is released when the panel is unmounted mid-run', async () => {
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun();
    callTool('pattern_open_blank', { name: 'Bass line' });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(within(report()).getByText(/still in your library/)).toBeInTheDocument();
    expect(getEditingPattern()?.name).toBe('Bass line');
  });

  it('does not say it when the run wrote no patterns', async () => {
    openBlankComposition('Song');
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
      openBlankComposition('Song');
      const before = getTracks().length;
      render(<CompositionCommandPanel mode="pattern" />);

      // `fireEvent`, not `userEvent`: the deadline is a `setTimeout` taken when
      // the run starts, so the clock has to already be fake by then — and
      // `userEvent`'s own delays run on the same faked clock.
      fireEvent.click(screen.getByRole('button', { name: SINGLE_RUN }));
      fireEvent.click(screen.getByRole('button', { name: 'Run' }));
      callTool('composition_add_track', { name: 'Drums' });

      await act(async () => {
        // Fifteen minutes — `RUN_TIMEOUT_MS`, sized for a job rather than for
        // one batched write, and DERIVED as `MAX_ITERS` × ~15 s.
        vi.advanceTimersByTime(900_000);
        await Promise.resolve();
      });

      expect(within(report()).getByText(/Gave up after 15 minutes/)).toBeInTheDocument();
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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
    openBlankComposition('Song');
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

// ------------------------------------------------------------- the ir route ---

/**
 * THE `'ir-job'` ROUTE — one row, and it is a different shape of thing.
 *
 * ⚠ The difference that drives every test here: **the import CREATES A NEW
 * COMPOSITION.** It does not edit the open one, nothing is written until the
 * import runs, and after it runs the job is over. So there is no gesture, no
 * rollback and no "the arrangement was put back" to assert — what there IS to
 * assert is that the panel says a new composition was made, that a job which
 * came back short does not read as a clean success, and that a cancel wrote
 * nothing.
 */
describe('a command on the IR route', () => {
  /** Emit one progress event, as the job would. */
  function progress(event: unknown): void {
    act(() => {
      irJob.live?.progress(event);
    });
  }

  /**
   * Settle the job, as the job would.
   *
   * `before` runs inside the same act, just ahead of the promise resolving —
   * which is where `importIR` does its work in a real run: the store is already
   * repointed by the time the panel's continuation gets the outcome. See
   * {@link repointTo}.
   */
  async function settle(outcome: unknown, before?: () => void): Promise<void> {
    await act(async () => {
      before?.();
      irJob.live?.settle(outcome);
      await Promise.resolve();
    });
  }

  /**
   * The one move of `commitImport` this panel can observe: the store stops
   * pointing at the composition the user had open and points at what was
   * imported.
   *
   * Reached through the LIB store rather than through `openBlankComposition`,
   * for the same reason the real import does not go near the seam: the job lock
   * is still held at this moment and the seam refuses a composition switch for
   * its duration.
   */
  function repointTo(compositionId: string): void {
    usePatternsStore.getState().openCompositionForArranging(compositionId);
  }

  const CHART = {
    bars: 12,
    bpm: 100,
    tracks: [
      { name: 'Bass', instrumentId: 'bass', role: 'walking bass' },
      { name: 'Rhythm', instrumentId: 'guitar', role: 'off-beat comping' },
      { name: 'Lead', instrumentId: 'guitar', role: 'sparse fills' },
    ],
    chords: [{ bar: 1, symbol: 'C7' }],
  };

  /** The job's progress, up to and including the part named. Every phase in
   *  order, because the order is what the panel is rendering. */
  function runThroughParts(upTo = CHART.tracks.length): void {
    progress({ type: 'job.started', transcriptId: 'run-1' });
    progress({ type: 'chart.started' });
    progress({ type: 'chart.finished', chart: CHART });
    for (let index = 1; index <= upTo; index++) {
      const track = CHART.tracks[index - 1];
      progress({ type: 'track.started', index, count: CHART.tracks.length, track });
      progress({ type: 'track.finished', index, count: CHART.tracks.length, track, ok: true });
    }
  }

  const documents = (patternIds: readonly string[], warnings: readonly string[] = []) => ({
    patternIds,
    compositionId: 'comp-1',
    topology: 'composition' as const,
    warnings,
  });

  it('starts the job rather than an agent run, and the other rows still do not', async () => {
    openBlankComposition('Song');
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun(BACKING_TRACK);
    // The job got the FILLED template — the chart run's whole input.
    expect(irJob.live?.input).toContain('backing track');
    expect(irJob.live?.label).toBe(BACKING_TRACK);
    // ⚠ And no agent loop was started at all. This route registers no tools, so
    // a run reaching the harness would be the old path silently still in place.
    expect(harness.live).toBeNull();

    await settle({ ok: false, stopped: 'chart-failed', reason: 'no chart' });

    // The other composition rows are unchanged: an agent run, with tools.
    await startRun(SINGLE_RUN);
    expect(harness.live).not.toBeNull();
    callTool('read_composition');
    expect(within(report()).getByText('1. read_composition …')).toBeInTheDocument();
    await finishRun();
  });

  it('shows the phases the job emits — chart, then part N of M, then import', async () => {
    openBlankComposition('Song');
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun(BACKING_TRACK);
    progress({ type: 'job.started', transcriptId: 'run-1' });
    progress({ type: 'chart.started' });
    // Before the chart lands there is nothing else to say, and no count to
    // count towards — the job does not know how many parts there are yet.
    expect(within(report()).getByText('Chart …')).toBeInTheDocument();
    expect(within(report()).queryByText(/Part 1 of/)).not.toBeInTheDocument();

    progress({ type: 'chart.finished', chart: CHART });
    expect(within(report()).getByText('Chart — 12 bars at 100 bpm, 3 parts')).toBeInTheDocument();

    progress({ type: 'track.started', index: 1, count: 3, track: CHART.tracks[0] });
    // ⚠ "1 of 3" is the whole point of the job emitting phases rather than the
    // panel inferring them: nothing else in the app knows there are three.
    expect(within(report()).getByText('Part 1 of 3: Bass …')).toBeInTheDocument();

    progress({ type: 'track.finished', index: 1, count: 3, track: CHART.tracks[0], ok: true });
    progress({ type: 'track.started', index: 2, count: 3, track: CHART.tracks[1] });
    // The mark MOVES, exactly as the single-run route's tool trace does.
    expect(within(report()).getByText('Part 1 of 3: Bass')).toBeInTheDocument();
    expect(within(report()).getByText('Part 2 of 3: Rhythm …')).toBeInTheDocument();

    progress({ type: 'track.finished', index: 2, count: 3, track: CHART.tracks[1], ok: true });
    progress({ type: 'track.started', index: 3, count: 3, track: CHART.tracks[2] });
    progress({ type: 'track.finished', index: 3, count: 3, track: CHART.tracks[2], ok: true });
    progress({ type: 'import.started', trackCount: 3 });
    expect(within(report()).getByText('Importing …')).toBeInTheDocument();

    await settle({
      ok: true,
      value: { chart: CHART, documents: documents(['p1', 'p2', 'p3']), transcriptId: 'run-1' },
    });
    expect(within(report()).getByText('Imported')).toBeInTheDocument();
    // No tool trace anywhere: there are no tools on this route, so the
    // single-run report's "No tools called" would be a lie about a capability.
    expect(within(report()).queryByText(/tools called/)).not.toBeInTheDocument();
  });

  it('says a NEW composition was created and opened, and clears the state naming the old one', async () => {
    // What the import will hand back, made before the run because the mocked job
    // cannot run the real one — see `repointTo`.
    const imported = openBlankComposition('What the import built');
    if (!imported.ok) throw new Error(imported.reason);
    const mine = openBlankComposition('The one you had open');
    if (!mine.ok) throw new Error(mine.reason);

    const { placementId } = openBlock();
    selectTrack(getTracks()[0].id);
    selectPlacements([placementId], 'replace');
    expect(getEditingPlacementId()).toBe(placementId);
    expect(getSelectedPlacementIds()).toHaveLength(1);
    const minesTracks = getTracks().length;

    render(<CompositionCommandPanel mode="pattern" />);
    await startRun(BACKING_TRACK);
    runThroughParts();
    progress({ type: 'import.started', trackCount: 3 });
    await settle(
      {
        ok: true,
        value: { chart: CHART, documents: documents(['p1', 'p2', 'p3']), transcriptId: 'run-1' },
      },
      () => repointTo(imported.value.id),
    );

    const done = report();
    expect(within(done).getByText(/^Done/)).toBeInTheDocument();
    expect(
      within(done).getByText(/A new composition was created from 3 parts and is now open/),
    ).toBeInTheDocument();
    // ⚠ And it says the OPEN one was left alone, which is the fact a user
    // watching their own arrangement for changes will otherwise never work out.
    expect(within(done).getByText(/composition you had open was not changed/)).toBeInTheDocument();

    // ⚠ THE IMPORT'S REPOINT SURVIVED THE PANEL. Asserted because the panel's
    // clean-up runs AFTER it — four seam calls, one of which (`clearHistory`)
    // exists precisely so nothing later writes the old document back.
    expect(getEditingComposition()?.id).toBe(imported.value.id);
    expect(getTracks().some((track) => track.name === 'Riff track')).toBe(false);

    // The four pieces of seam state `importIR` cannot reach itself, all of which
    // named the document that WAS open. The fourth — the history — has a test of
    // its own below, because an undo is what shows it.
    expect(getEditingPlacementId()).toBeNull();
    expect(getSelectedPlacementIds()).toHaveLength(0);
    expect(getSelectedTrackId()).toBeNull();
    expect(isJobRunning()).toBe(false);

    // ⚠ AND THE COMPOSITION THE USER HAD OPEN IS UNTOUCHED — the route's own
    // claim, checked where it lives rather than through what happens to be on
    // screen.
    const untouched = usePatternsStore
      .getState()
      .library.compositions.find((composition) => composition.id === mine.value.id);
    expect(untouched?.tracks).toHaveLength(minesTracks);

    // ⚠ WHAT THIS DOES *NOT* PROVE, said plainly rather than claimed in a
    // comment that reads like an assertion: that no undo gesture was bracketed
    // around the job. `abortEditGesture` restores BY ID, so a bracket opened out
    // of habit would write the pre-job snapshot over the row it came from —
    // which the import did not touch and nothing above reads — and would move
    // nothing observable here. The reason not to open one is in the panel's
    // header; there is no assertion in this seam that can tell the two apart.
  });

  it('drops the undo history, so a press cannot stamp the old composition back', async () => {
    openBlankComposition('Song');
    render(<CompositionCommandPanel mode="pattern" />);
    const added = addTrack('The user’s own track');
    if (!added.ok) throw new Error(added.reason);
    const tracksBefore = getTracks().length;

    await startRun(BACKING_TRACK);
    runThroughParts();
    await settle({
      ok: true,
      value: { chart: CHART, documents: documents(['p1', 'p2', 'p3']), transcriptId: 'run-1' },
    });

    // The user's own edit is still there and undo is inert: the history was
    // cleared, because an undo after an import writes a snapshot of the
    // PREVIOUS composition over the one that is now open.
    act(() => undo());
    expect(getTracks()).toHaveLength(tracksBefore);

    // ⚠ AND THE HISTORY STILL WORKS AFTERWARDS, which is the half a cleared
    // stack cannot show on its own: a job that opened an undo GESTURE and never
    // closed it leaves the seam's one gesture slot held, and every later edit
    // disappears into it instead of pushing a step. Two lines that fail if a
    // bracket is ever added around this route and leaked.
    const after = addTrack('After the job');
    if (!after.ok) throw new Error(after.reason);
    act(() => undo());
    expect(getTracks()).toHaveLength(tracksBefore);
  });

  /**
   * The panel says both halves of what the route costs BEFORE the run, under the
   * Run button — and says them only for this route.
   *
   * ⚠ THE UNDO CLAUSE IS NOT DECORATION. `clearHistory` is the composition
   * seam's single global stack, so an import drops the undo history of the
   * document the user had open even though the job never touched it. That is a
   * consequence the user cannot see coming from anywhere else.
   */
  it('says what the route costs, and says something else for the other route', async () => {
    openBlankComposition('Song');
    render(<CompositionCommandPanel mode="pattern" />);

    await userEvent.click(screen.getByRole('button', { name: BACKING_TRACK }));
    expect(screen.getByText(/builds a NEW composition and opens it/)).toBeInTheDocument();
    expect(screen.getByText(/clears the undo history/)).toBeInTheDocument();
    // ⚠ And NOT the single-run promise: there is no arrangement edit to put
    // back, so offering one is a promise this route cannot keep.
    expect(screen.queryByText(/puts the arrangement back/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: SINGLE_RUN }));
    expect(screen.getByText(/Cancelling puts the arrangement back as it was/)).toBeInTheDocument();
    expect(screen.queryByText(/builds a NEW composition/)).not.toBeInTheDocument();
  });

  it('does not read as a clean success when a part is missing from the piece', async () => {
    openBlankComposition('Song');
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun(BACKING_TRACK);
    runThroughParts();
    progress({ type: 'import.started', trackCount: 3 });
    // ⚠ THREE PARTS WRITTEN, TWO PATTERNS IMPORTED. Reachable and SILENT: the
    // validator drops a note whose tick is not a whole number, a track left
    // empty is not cut into a pattern, and nothing warns. The job returned `ok`.
    await settle({
      ok: true,
      value: { chart: CHART, documents: documents(['p1', 'p2']), transcriptId: 'run-1' },
    });

    const done = report();
    expect(within(done).getByText(/^Incomplete/)).toBeInTheDocument();
    expect(within(done).queryByText(/^Done/)).not.toBeInTheDocument();
    expect(
      within(done).getByText(
        /The chart named 3 parts and 2 were imported — 1 did not survive, so this is not the arrangement that was asked for/,
      ),
    ).toBeInTheDocument();
  });

  /**
   * ⚠ THE REPORT IS BUILT FROM THE OUTCOME, NOT FROM THE PROGRESS IT SAW.
   *
   * `partsMissing` — the whole of whether this reads "Done" or "Incomplete" — is
   * the chart's part count against the imported one, so a chart taken from the
   * `chart.finished` event alone makes a MISSED event read as a clean success.
   * The outcome carries the chart every part was written against, and the
   * transcript id, and cannot have been missed; this test settles a job that
   * emitted no progress at all to say so.
   */
  it('builds the report from the outcome, not from the events it happened to see', async () => {
    openBlankComposition('Song');
    const transcript = beginJobTranscript({
      page: 'composition',
      command: BACKING_TRACK,
      agent: 'ir-composition-job',
      input: 'a blues backing track',
    });
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun(BACKING_TRACK);
    await settle({
      ok: true,
      value: {
        chart: CHART,
        documents: documents(['p1', 'p2']),
        transcriptId: transcript.id,
      },
    });

    const done = report();
    expect(within(done).getByText(/^Incomplete/)).toBeInTheDocument();
    expect(within(done).getByText(/The chart named 3 parts and 2 were imported/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('puts the import’s warnings on the screen', async () => {
    openBlankComposition('Song');
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun(BACKING_TRACK);
    runThroughParts();
    progress({ type: 'import.started', trackCount: 3 });
    await settle({
      ok: true,
      value: {
        chart: CHART,
        documents: documents(
          ['p1', 'p2', 'p3'],
          ['Dropped 2 events with a fractional tick.', 'Lead: 4 notes are on strings the guitar has not got.'],
        ),
        transcriptId: 'run-1',
      },
    });

    const done = report();
    // Verbatim, both of them: the validator and the mapper author these, and
    // they arrive on a SUCCESS — nothing else on screen would mention them.
    expect(within(done).getByText('Dropped 2 events with a fractional tick.')).toBeInTheDocument();
    expect(
      within(done).getByText('Lead: 4 notes are on strings the guitar has not got.'),
    ).toBeInTheDocument();
  });

  /**
   * ⚠ THE SAME SENTENCE TWICE IS TWO WARNINGS. `importIR` concatenates the
   * validator's list, the seam's, the mapper's and its own off-neck check with
   * no dedupe — unlike the single-run route's tool refusals, which are
   * deduplicated on the way in — so one string can legitimately arrive from two
   * of the four. Keyed on the string alone, React renders one row and logs about
   * the collision, and the count the user is reading is wrong.
   */
  it('shows a repeated warning as many times as it arrived', async () => {
    openBlankComposition('Song');
    // ⚠ THE COLLISION IS REPORTED TO THE CONSOLE, NOT TO THE DOM — React renders
    // both rows and logs "two children with the same key" — so the console is
    // where the assertion has to look. Restored in a `finally`: a swallowed
    // `console.error` left behind would hide the next test's own warnings.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<CompositionCommandPanel mode="pattern" />);

    const twice = 'Dropped 2 events with a fractional tick.';
    await startRun(BACKING_TRACK);
    runThroughParts();
    progress({ type: 'import.started', trackCount: 3 });
    await settle({
      ok: true,
      value: {
        chart: CHART,
        documents: documents(['p1', 'p2', 'p3'], [twice, twice]),
        transcriptId: 'run-1',
      },
    });

    try {
      expect(within(report()).getAllByText(twice)).toHaveLength(2);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('marks the part that failed where the part is, and says nothing was imported', async () => {
    openBlankComposition('Song');
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun(BACKING_TRACK);
    runThroughParts(1);
    progress({ type: 'track.started', index: 2, count: 3, track: CHART.tracks[1] });
    progress({
      type: 'track.finished',
      index: 2,
      count: 3,
      track: CHART.tracks[1],
      ok: false,
      reason: 'Fret 40 is off the neck.',
    });
    await settle({
      ok: false,
      stopped: 'track-failed',
      reason:
        '"Rhythm" — part 2 of 3 — could not be written, so nothing was imported and the part already written was not kept. Fret 40 is off the neck.',
    });

    const refused = report();
    expect(within(refused).getByText(/^Refused/)).toBeInTheDocument();
    // The part is marked WHERE THE PART IS, rather than the whole display being
    // replaced by one sentence — the phases stay readable.
    expect(within(refused).getByText('Part 1 of 3: Bass')).toBeInTheDocument();
    expect(
      within(refused).getByText('Part 2 of 3: Rhythm — could not be written'),
    ).toBeInTheDocument();
    // …and the job's own sentence, which names what became of the rest.
    expect(within(refused).getByText(/nothing was imported/)).toBeInTheDocument();
    expect(isJobRunning()).toBe(false);
  });

  /**
   * The three phase lines an ENDED job leaves behind, each of which is the
   * difference between "this went wrong here" and a display that just stops.
   * One test apiece, because each needs the job to end at a different point.
   */
  it('says the chart was not written when the chart run is what failed', async () => {
    openBlankComposition('Song');
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun(BACKING_TRACK);
    // ⚠ `job.started` FIRST — it is what says a job was ever handed the request,
    // and the phase list is withheld without it. A refusal decided before that
    // (no provider, a slot that no longer fills) reports no phases at all, which
    // the provider test below pins.
    progress({ type: 'job.started', transcriptId: 'run-1' });
    progress({ type: 'chart.started' });
    await settle({
      ok: false,
      stopped: 'chart-failed',
      reason: 'The model did not answer with a chart.',
    });

    const refused = report();
    expect(within(refused).getByText('Chart — not written')).toBeInTheDocument();
    expect(within(refused).queryByText('Chart …')).not.toBeInTheDocument();
    expect(within(refused).getByText(/^Refused/)).toBeInTheDocument();
  });

  it('says the import was refused when every part was written and the document was not', async () => {
    openBlankComposition('Song');
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun(BACKING_TRACK);
    runThroughParts();
    progress({ type: 'import.started', trackCount: 3 });
    await settle({
      ok: false,
      stopped: 'import-refused',
      reason: 'Nothing was imported — your plan’s library cap is in the way.',
    });

    const refused = report();
    // Every part is still marked written: the parts were fine, the import was
    // not, and a display that blamed the last part would send somebody to fix
    // the wrong thing.
    expect(within(refused).getByText('Part 3 of 3: Lead')).toBeInTheDocument();
    expect(within(refused).getByText('Import — refused')).toBeInTheDocument();
    expect(within(refused).getByText(/library cap is in the way/)).toBeInTheDocument();
  });

  it('leaves the part a cancel interrupted marked stopped, not failed', async () => {
    openBlankComposition('Song');
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun(BACKING_TRACK);
    runThroughParts(1);
    progress({ type: 'track.started', index: 2, count: 3, track: CHART.tracks[1] });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await Promise.resolve();
    });

    const stopped = report();
    // ⚠ NOT "could not be written". The job emits no `track.finished` for a part
    // the user cancelled out of, deliberately — putting a failure mark against
    // work nobody claims is bad is the report this route must not write.
    expect(within(stopped).getByText('Part 2 of 3: Rhythm — stopped')).toBeInTheDocument();
    expect(
      within(stopped).queryByText('Part 2 of 3: Rhythm — could not be written'),
    ).not.toBeInTheDocument();
    expect(within(stopped).getByText('Part 1 of 3: Bass')).toBeInTheDocument();
  });

  /**
   * The log of a job that went wrong, offered where the job's own account of
   * itself is.
   *
   * ⚠ AGAINST A REAL TRANSCRIPT. `RunTranscriptControl` renders NOTHING for an
   * id that resolves to no record, so a test emitting a made-up id asserts the
   * control's absence just as happily as its presence.
   */
  it('offers the job’s run log, from the id the job emitted', async () => {
    openBlankComposition('Song');
    const transcript = beginJobTranscript({
      page: 'composition',
      command: BACKING_TRACK,
      agent: 'ir-composition-job',
      input: 'a blues backing track',
    });
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun(BACKING_TRACK);
    progress({ type: 'job.started', transcriptId: transcript.id });
    progress({ type: 'chart.started' });
    // Withheld while the job is live — the log is still growing.
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();

    await settle({
      ok: false,
      stopped: 'chart-failed',
      reason: 'The model did not answer with a chart.',
    });

    expect(within(report()).getByText('Run log')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('stops on Cancel and imports nothing', async () => {
    openBlankComposition('Song');
    const tracksBefore = getTracks().length;
    const patternsBefore = usePatternsStore.getState().library.patterns.length;
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun(BACKING_TRACK);
    progress({ type: 'job.started', transcriptId: 'run-1' });
    progress({ type: 'chart.started' });
    expect(irJob.live?.signal?.aborted).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await Promise.resolve();
    });

    // The signal the job checks between steps — its own guarantee is that a
    // cancel landing before the import writes nothing at all.
    expect(irJob.live?.signal?.aborted).toBe(true);
    expect(within(report()).getByText(/Nothing was written/)).toBeInTheDocument();
    expect(within(report()).queryByText(/^Done/)).not.toBeInTheDocument();

    // ⚠ AND IT IS NOT HEADED "REFUSED". The job types its stop precisely so a
    // caller can tell a cancel from a failure — "a cancel above all is not a
    // failure and must not be reported as one" — and REFUSED over somebody's
    // own Cancel press is that report. The single-run route next door says
    // 'Cancelled.' for the same event.
    expect(within(report()).getByText(/^Cancelled/)).toBeInTheDocument();
    expect(within(report()).queryByText(/^Refused/)).not.toBeInTheDocument();

    // The lock is back, and the library is where it was. ⚠ THIS HALF IS WEAK ON
    // PURPOSE and the comment says so rather than the title implying otherwise:
    // the job module is mocked here, so no path in this test could have written
    // a composition or a pattern in the first place. What actually guarantees
    // "imports nothing" is the job itself, in `IrCompositionJob.test.ts`; what
    // this test owns is the signal reaching it and the panel's own teardown.
    expect(usePatternsStore.getState().library.compositions).toHaveLength(1);
    expect(usePatternsStore.getState().library.patterns).toHaveLength(patternsBefore);
    expect(getTracks()).toHaveLength(tracksBefore);
    expect(isJobRunning()).toBe(false);
  });

  /**
   * ⚠ NOBODY CANCELLED THIS ONE. The deadline aborts the same controller a
   * Cancel press does, so the job reports `stopped: 'cancelled'` for both — and
   * the whole value of having a deadline is saying which of the two happened.
   * Thirty-four minutes is `JOB_TIMEOUT_MS`, derived as
   * `1 + 2 * MAX_COMPOSITION_TRACKS` runs at two minutes each — the factor of two
   * is the job's one retry per part, and a ceiling sized for one run a part would
   * abort a job mid-way and throw away every part it had already written. The
   * single-run route has this test for its own fifteen.
   */
  it('gives up on its own deadline, and does not call that a cancel', async () => {
    vi.useFakeTimers();
    try {
      openBlankComposition('Song');
      render(<CompositionCommandPanel mode="pattern" />);

      // `fireEvent`, not `userEvent`: the deadline is a `setTimeout` taken when
      // the job starts, so the clock has to already be fake by then.
      fireEvent.click(screen.getByRole('button', { name: BACKING_TRACK }));
      fireEvent.click(screen.getByRole('button', { name: 'Run' }));
      act(() => {
        irJob.live?.progress({ type: 'job.started', transcriptId: 'run-1' });
        irJob.live?.progress({ type: 'chart.started' });
      });

      await act(async () => {
        vi.advanceTimersByTime(34 * 60_000);
        await Promise.resolve();
      });

      expect(within(report()).getByText(/Gave up after 34 minutes/)).toBeInTheDocument();
      expect(within(report()).getByText(/^Refused/)).toBeInTheDocument();
      expect(within(report()).queryByText(/^Cancelled/)).not.toBeInTheDocument();
      expect(isJobRunning()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses without a provider, and reports no phase the job never reached', async () => {
    openBlankComposition('Song');
    setConnectorSettings({ baseUrl: '', token: '' });
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun(BACKING_TRACK);

    // Decided before anything ran, so the lock was never taken and no job
    // exists — the same guard the single-run route has, on the other report.
    expect(irJob.live).toBeNull();
    expect(isJobRunning()).toBe(false);
    const refused = report();
    expect(within(refused).getByText(/No provider is configured/)).toBeInTheDocument();
    // ⚠ And NOT "Chart — not written": there was no chart run to fail. A phase
    // list here would describe a job that was never asked for.
    expect(within(refused).queryByText(/^Chart/)).not.toBeInTheDocument();
  });

  it('gives the lock back when the job runner itself throws', async () => {
    openBlankComposition('Song');
    irJob.throwWith = 'the job runner is broken';
    render(<CompositionCommandPanel mode="pattern" />);

    await startRun(BACKING_TRACK);
    await act(async () => {
      await Promise.resolve();
    });

    expect(within(report()).getByText(/The job could not complete/)).toBeInTheDocument();
    // ⚠ AND NO PHASE LIST. The throw happened before the job emitted anything,
    // so there was no chart run to have failed — "Chart — not written" here
    // would describe a run nobody ever asked for, which is the distinction
    // `JobView.started` exists to keep.
    expect(within(report()).queryByText(/^Chart/)).not.toBeInTheDocument();
    // The failure this asserts is not the message: it is the page staying
    // read-only for the rest of the session.
    expect(isJobRunning()).toBe(false);
  });

  it('cancels the job when the panel is unmounted mid-job', async () => {
    openBlankComposition('Song');
    const { unmount } = render(<CompositionCommandPanel mode="pattern" />);

    await startRun(BACKING_TRACK);
    runThroughParts(1);

    unmount();

    expect(irJob.live?.signal?.aborted).toBe(true);
    expect(isJobRunning()).toBe(false);
  });
});
