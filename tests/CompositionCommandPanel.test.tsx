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
    /** Every filled template the seam was handed, in order. What a run is
     *  actually AIMED at is in this string and nowhere else — `fillCommand`
     *  substitutes a track's id, never its name. */
    inputs: [] as string[],
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
      input: string,
      options: {
        onEvent?: (event: unknown) => void;
        signal?: AbortSignal;
        maxIters?: number;
      },
    ) => {
      harness.inputs.push(input);
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

/**
 * ── THE SEAM, WRAPPED TO RECORD THE ORDER OF TWO CALLS ──────────────────────
 *
 * §2's order — restore the pattern pointer BEFORE the agent takes the document —
 * is not observable from the outside: both writes land in one React commit, so
 * the intermediate state (locked, still pointed at the user's block) is never
 * rendered and `getEditingPlacementId() === null` after the fact is equally true
 * of the wrong order. This is the smallest thing that can see it: the real
 * module, with the two functions in question wrapped to note that they ran.
 *
 * Everything else is `actual` and every wrapper delegates, so no behaviour in
 * this file changes — the mock exists to answer "in which order", nothing more.
 */
const order = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('../src/composition/compositionService', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/composition/compositionService')>();
  return {
    ...actual,
    closePlacementEditing: () => {
      order.calls.push('close');
      return actual.closePlacementEditing();
    },
    beginJob: () => {
      order.calls.push('beginJob');
      return actual.beginJob();
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
  getEditingComposition,
  getEditingPlacementId,
  getSelectedPlacementIds,
  getSelectedTrackId,
  getTracks,
  isJobRunning,
  openBlankComposition,
  openPlacementForEditing,
  removeTrack,
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
  harness.inputs.length = 0;
  harness.live = null;
  harness.throwWith = null;
  irJob.live = null;
  irJob.throwWith = null;
  selectTrack(null);
  setConnectorSettings({ baseUrl: 'http://localhost:8080/v1', token: '' });
  // Last, because the reset above goes through the wrapped seam and would
  // otherwise leave its own calls in the log.
  order.calls.length = 0;
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

/** What the last run was actually handed — the filled template, which carries
 *  the ids the command was aimed at. */
const lastInput = (): string => harness.inputs.at(-1) ?? '';

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
function openBlock(): { placementId: string; trackId: string; patternId: string } {
  // Idempotent, as the `ensureComposition` this replaced was: a helper that
  // CREATES unconditionally would switch away from a composition the test had
  // already opened, and the switch is silent.
  if (!getEditingComposition()) openBlankComposition('Song');
  const track = addTrack('Riff track');
  if (!track.ok) throw new Error(track.reason);
  // ⚠ SELECTED AS WELL AS OPEN, since COMPS-TRACK-TABS milestone 5. The panel's
  // TRACK group is about the SELECTED track and an Edit row acts on the block
  // that track has open, so a block open on a track nobody selected offers
  // nothing — which is the app's own order too: `ArrangementGrid`'s activation
  // coordinator selects the track and only then opens the placement.
  selectTrack(track.value.id);
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
  return { placementId: placement.value, trackId: track.value.id, patternId: pattern.value.id };
}

// -------------------------------------------------------------- the catalog ---

describe('the two groups', () => {
  /** The rows in one group, by label — the only way to assert a row is in the
   *  RIGHT list rather than merely somewhere on screen. */
  const groupLabels = (name: string | RegExp): string[] =>
    within(screen.getByRole('group', { name }))
      .queryAllByRole('button')
      .map((button) => button.textContent ?? '');

  const COMPOSITION_GROUP = 'Composition commands';

  /**
   * ⚠ THE REGRESSION, AS THE PANEL SHOWS IT.
   *
   * Milestone 4 passed the selected track's view straight into the offering
   * filter, and five composition-wide rows were tagged `mode: 'pattern'` — so
   * selecting a Voice track hid "Create a backing track", whose entire product
   * is a NEW composition and which needs no track at all. This is that test, one
   * view at a time.
   */
  it('offers every composition command from every view, and with no track selected', () => {
    openBlankComposition('Song');
    const { rerender } = render(<CompositionCommandPanel view="pattern" />);
    const expected = [
      BACKING_TRACK,
      'Create a bass line',
      'Add a harmony track',
      'Extend the arrangement',
      'Balance the mix',
    ];
    expect(groupLabels(COMPOSITION_GROUP)).toEqual(expected);

    rerender(<CompositionCommandPanel view="voice" />);
    expect(groupLabels(COMPOSITION_GROUP)).toEqual(expected);

    rerender(<CompositionCommandPanel view="edit" />);
    expect(groupLabels(COMPOSITION_GROUP)).toEqual(expected);
    // And nothing is selected in any of the three — `selectTrack(null)` is the
    // beforeEach — so this is also the no-selection case.
    expect(getSelectedTrackId()).toBeNull();
  });

  it('offers the backing track with no composition open at all', () => {
    // ⚠ THE PANEL DOES RENDER IN THIS STATE — `CompositionPage` shows its
    // open-failure alert and keeps the rail — and the backing track is the one
    // row whose whole product is a NEW composition, so it is exactly the row
    // that must survive having nothing to point at.
    expect(getEditingComposition()).toBeNull();
    render(<CompositionCommandPanel view="pattern" />);

    expect(groupLabels(COMPOSITION_GROUP)).toContain(BACKING_TRACK);
    // ⚠ AND THE TRACK GROUP SAYS THE RIGHT THING ABOUT IT. "Press a track
    // header" is a dead end when there are no headers to press, so the refusal
    // names the cause the user can actually act on.
    expect(screen.getByText(/No composition is open/)).toBeInTheDocument();
  });

  it('puts the selected track’s rows in a group named after it', () => {
    openBlankComposition('Song');
    const track = addTrack('Rhythm');
    if (!track.ok) throw new Error(track.reason);
    selectTrack(track.value.id);
    const { rerender } = render(<CompositionCommandPanel view="pattern" />);

    expect(groupLabels('Track commands — Rhythm')).toEqual(['Lay a pattern down the timeline']);
    // A track row is in the TRACK group and not the composition one — the
    // negative half, which is what makes the split a split.
    expect(groupLabels(COMPOSITION_GROUP)).not.toContain('Lay a pattern down the timeline');

    rerender(<CompositionCommandPanel view="voice" />);
    expect(groupLabels('Track commands — Rhythm')).toEqual(['Dial in a tone']);
  });

  it('asks for a selection instead of track rows when there is none', () => {
    openBlankComposition('Song');
    const track = addTrack('Rhythm');
    if (!track.ok) throw new Error(track.reason);
    render(<CompositionCommandPanel view="pattern" />);

    expect(groupLabels('Track commands')).toEqual([]);
    expect(screen.getByText(/No track is selected/)).toBeInTheDocument();
    // ⚠ AND THE COMPOSITION GROUP IS UNTOUCHED BY IT. "No track selected" gates
    // the track group and never the other one.
    expect(groupLabels(COMPOSITION_GROUP)).toContain(BACKING_TRACK);
  });

  /**
   * The Edit view is served by the PATTERN page's rows: `openPlacementForEditing`
   * aims the lib's single pattern-editing pointer at the block and
   * `patternService` routes writes to that placement's snapshot, so they act on
   * the block being edited unchanged.
   */
  it('offers the pattern page’s rows as the track group of an Edit track', () => {
    openBlock();
    render(<CompositionCommandPanel view="edit" />);

    expect(groupLabels('Track commands — Riff track')).toContain('Fix the timing');
    expect(groupLabels(COMPOSITION_GROUP)).not.toContain('Fix the timing');
  });

  /**
   * ⚠ "Generate a pattern" opens a NEW document — its template says so in as
   * many words — and `openPatternForEditing` nulls the placement pointer, so run
   * against a block it would send every later stamp into a library pattern
   * nobody is looking at, outside the rollback and off-screen. Withheld here;
   * the tool refuses for itself as well, because `Command.tools` is not
   * enforcement (tests/AgentTools).
   */
  it('withholds the row that opens a different document from the Edit group', () => {
    openBlock();
    render(<CompositionCommandPanel view="edit" />);

    expect(groupLabels('Track commands — Riff track')).not.toContain('Generate a pattern');
    // Dropped by the CATALOG's Edit slice, not deleted from the page: the
    // pattern page still offers it, and this is the line that fails if someone
    // "fixes" this by removing the row instead.
    expect(commandsForPage('pattern').map((command) => command.label)).toContain(
      'Generate a pattern',
    );
  });

  /**
   * A VIEW IS NOT THE SAME AS A BLOCK BEING OPEN. With none open,
   * `writePatternBack` falls through to its LIBRARY branch, so these rows would
   * rewrite whatever pattern the pattern page left open — off-screen, and
   * covered by neither the rollback nor the lock.
   */
  it('asks for a block instead of Edit rows until one is open', () => {
    openBlankComposition('Song');
    const track = addTrack('Rhythm');
    if (!track.ok) throw new Error(track.reason);
    selectTrack(track.value.id);
    openBlankPattern('The user’s own pattern');
    render(<CompositionCommandPanel view="edit" />);

    expect(groupLabels('Track commands — Rhythm')).toEqual([]);
    expect(screen.getByText(/Press a block in this track/)).toBeInTheDocument();
    // And no Run button to reach, because nothing is selected yet.
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
    expect(isJobRunning()).toBe(false);
    // ⚠ THE WHOLE POINT OF THE SPLIT: the composition group is still there, and
    // still launchable, over an Edit track with nothing open.
    expect(groupLabels(COMPOSITION_GROUP)).toContain(BACKING_TRACK);
  });

  it('withholds Edit rows for a block that belongs to another track', () => {
    // §2: the active placement has to be owned by the SELECTED track. The grid's
    // reconciler maintains that; this is the panel refusing to assume it.
    openBlock();
    const other = addTrack('Somebody else');
    if (!other.ok) throw new Error(other.reason);
    selectTrack(other.value.id);
    render(<CompositionCommandPanel view="edit" />);

    expect(screen.getByText(/Press a block in this track/)).toBeInTheDocument();
    expect(groupLabels('Track commands — Somebody else')).toEqual([]);
  });
});

describe('what a track command is aimed at', () => {
  it('shows the selected track’s name instead of a picker', async () => {
    openBlankComposition('Song');
    const first = addTrack('Rhythm');
    if (!first.ok) throw new Error(first.reason);
    selectTrack(first.value.id);
    render(<CompositionCommandPanel view="voice" />);

    await userEvent.click(screen.getByRole('button', { name: 'Dial in a tone' }));
    // The target is bound, so there is no Track picker to get out of step with
    // the selection — the name is shown as the fact it is.
    expect(screen.queryByRole('combobox', { name: 'Track' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Track')).toHaveTextContent('Rhythm');
  });

  /**
   * ⚠ THE HIDDEN STALE TARGET, which is the failure §2 names by hand: a form
   * opened on track A, the selection moved to track B, Run pressed — and the
   * untouched `track` value still saying A would write to a track that is not on
   * screen.
   */
  it('rebinds to the new track when the selection moves before Run', async () => {
    openBlankComposition('Song');
    const first = addTrack('Rhythm');
    const second = addTrack('Lead');
    if (!first.ok) throw new Error(first.reason);
    if (!second.ok) throw new Error(second.reason);
    selectTrack(first.value.id);
    render(<CompositionCommandPanel view="voice" />);

    await userEvent.click(screen.getByRole('button', { name: 'Dial in a tone' }));
    expect(screen.getByLabelText('Track')).toHaveTextContent('Rhythm');

    act(() => selectTrack(second.value.id));
    expect(screen.getByLabelText('Track')).toHaveTextContent('Lead');

    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    // What actually reached the agent. `fillCommand` substitutes the slot's
    // VALUE — the track id — so this is the assertion that the run is aimed at
    // the track on screen and not at the one the form opened on.
    expect(harness.live).not.toBeNull();
    expect(lastInput()).toContain(second.value.id);
    expect(lastInput()).not.toContain(first.value.id);
  });

  /**
   * The other half, and it is the opposite rule: a COMPOSITION row's track slot
   * is an explicit input the selection may SEED and must never silently replace.
   */
  it('keeps a user’s own choice on a composition command when the selection moves', async () => {
    openBlankComposition('Song');
    const first = addTrack('Rhythm');
    const second = addTrack('Lead');
    if (!first.ok) throw new Error(first.reason);
    if (!second.ok) throw new Error(second.reason);
    selectTrack(first.value.id);
    render(<CompositionCommandPanel view="pattern" />);

    await userEvent.click(screen.getByRole('button', { name: 'Add a harmony track' }));
    // Seeded from the selection, then chosen explicitly — a real picker, not a
    // readout.
    const picker = screen.getByRole('combobox', { name: 'Track to double' });
    expect(picker).toHaveValue(first.value.id);
    await userEvent.selectOptions(picker, second.value.id);

    act(() => selectTrack(first.value.id));
    expect(screen.getByRole('combobox', { name: 'Track to double' })).toHaveValue(
      second.value.id,
    );
  });

  it('refuses a track command whose target has gone, without disabling the group', async () => {
    openBlankComposition('Song');
    const track = addTrack('Rhythm');
    if (!track.ok) throw new Error(track.reason);
    selectTrack(track.value.id);
    render(<CompositionCommandPanel view="voice" />);

    await userEvent.click(screen.getByRole('button', { name: 'Dial in a tone' }));
    // The document moves under the open form, exactly as an undo or an agent
    // could move it. `removeTrack` prunes the selection with it.
    act(() => {
      const removed = removeTrack(track.value.id);
      if (!removed.ok) throw new Error(removed.reason);
    });

    expect(screen.getByText(/No track is selected/)).toBeInTheDocument();
    // The form went with the row, and nothing was launched.
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
    expect(isJobRunning()).toBe(false);
    // ⚠ AND THE COMPOSITION GROUP IS STILL LIVE. Gating one group must never
    // gate the other.
    expect(
      within(screen.getByRole('group', { name: 'Composition commands' })).getByRole('button', {
        name: BACKING_TRACK,
      }),
    ).toBeInTheDocument();
  });

  /**
   * With no composition open there is no track for "Add a harmony track" to
   * double. §2: that disables THAT command's Run with a useful explanation, and
   * never the whole global group.
   *
   * A composition with ZERO tracks is not reachable — `removeTrack` refuses the
   * last one — so "no composition" is the live version of a missing track
   * input, and it is a state this panel genuinely renders in.
   */
  it('disables one command’s Run for a missing input, and leaves the rest of its group alone', async () => {
    render(<CompositionCommandPanel view="pattern" />);

    await userEvent.click(screen.getByRole('button', { name: 'Add a harmony track' }));
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
    // The seam's own sentence, which says what to do about it.
    expect(screen.getAllByText('No composition is open.').length).toBeGreaterThan(0);

    // ⚠ AND THE ROW BESIDE IT IS UNAFFECTED — the one whose product is a new
    // composition. A gate on one row's inputs may not reach the group.
    await userEvent.click(screen.getByRole('button', { name: BACKING_TRACK }));
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
  });

  /**
   * ⚠ THE OTHER HALF OF THE REBIND, AND THE ONE THAT IS EASY TO BREAK: the
   * target follows the selection and NOTHING ELSE DOES. §2 asks for
   * target-dependent fields to be rebound and the user's own preferences to be
   * left alone while they are still valid, and the row that can tell the two
   * apart is this one — it is the only track-scoped command with slots besides
   * its target.
   *
   * Re-seeding the whole form on a selection change (`setValues(defaultValues)`)
   * passes every other test in this file and fails this one.
   */
  it('rebinds only the target, keeping the fields the user chose', async () => {
    openBlankComposition('Song');
    const first = addTrack('Rhythm');
    const second = addTrack('Lead');
    if (!first.ok) throw new Error(first.reason);
    if (!second.ok) throw new Error(second.reason);
    const riff = openBlankPattern('Riff');
    const chorus = openBlankPattern('Chorus');
    if (!riff.ok) throw new Error(riff.reason);
    if (!chorus.ok) throw new Error(chorus.reason);
    selectTrack(first.value.id);
    render(<CompositionCommandPanel view="pattern" />);

    await userEvent.click(
      screen.getByRole('button', { name: 'Lay a pattern down the timeline' }),
    );
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Pattern' }),
      riff.value.id,
    );
    // 4 → 5, so the assertion below is about the user's number and not about the
    // catalog's fallback.
    await userEvent.click(screen.getByRole('button', { name: 'Increase Copies' }));

    act(() => selectTrack(second.value.id));
    expect(screen.getByLabelText('Track')).toHaveTextContent('Lead');
    // Untouched by the selection moving — a stepper that snapped back to 4 here
    // is the user being overruled.
    expect(within(screen.getByRole('group', { name: 'Copies' })).getByText('5')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(lastInput()).toContain(second.value.id);
    expect(lastInput()).not.toContain(first.value.id);
    expect(lastInput()).toContain(riff.value.id);
    expect(lastInput()).toContain('5 times');

    await finishRun();
  });
});

/**
 * ── THE SNAPSHOT IS CHECKED AGAIN AT THE PRESS, NOT ONLY AT THE RENDER ──────
 *
 * §2 asks for the launch to snapshot the command, the composition, the track and
 * the form — and to RE-VALIDATE all of it against live state when Run is pressed.
 * The render-time rebind effect is not that: it is an effect, it does not run
 * with nothing selected, and a press lands after the render it was drawn in.
 *
 * ⚠ HOW THESE REACH THE GAP. Every one moves a seam and presses Run inside ONE
 * `act`, so the commit that would have re-rendered the panel — and flushed the
 * rebind effect — has not happened when the handler runs. That is the shape of
 * the real hazard (state moving under a form between paint and press) and it is
 * the only way to drive the execution-time checks at all: `userEvent.click`
 * flushes first, which is what made these lines dead code before.
 */
describe('what a launch re-checks at the press', () => {
  /** The panel, with one selected track and one track command open on it. */
  async function openTrackCommand(): Promise<{ first: string; second: string }> {
    openBlankComposition('Song');
    const first = addTrack('Rhythm');
    const second = addTrack('Lead');
    if (!first.ok) throw new Error(first.reason);
    if (!second.ok) throw new Error(second.reason);
    selectTrack(first.value.id);
    render(<CompositionCommandPanel view="voice" />);
    await userEvent.click(screen.getByRole('button', { name: 'Dial in a tone' }));
    return { first: first.value.id, second: second.value.id };
  }

  it('binds the target from the live selection, not from the last render', async () => {
    const { first, second } = await openTrackCommand();
    const run = screen.getByRole('button', { name: 'Run' });

    await act(async () => {
      selectTrack(second);
      fireEvent.click(run);
    });

    // Without the execution-time rebind this carries `first` — the form's own
    // untouched value — and the run writes to a track that is not on screen.
    expect(lastInput()).toContain(second);
    expect(lastInput()).not.toContain(first);

    await finishRun();
  });

  it('refuses when the selected track has gone since the render', async () => {
    await openTrackCommand();
    const run = screen.getByRole('button', { name: 'Run' });

    await act(async () => {
      selectTrack(null);
      fireEvent.click(run);
    });

    expect(harness.inputs).toHaveLength(0);
    expect(isJobRunning()).toBe(false);
    expect(within(report()).getByText(/No track is selected any more/)).toBeInTheDocument();
  });

  /**
   * The composition id is part of the snapshot too. Nothing checks it by name —
   * the track lookup is what makes it hold, because a track of the composition
   * that was open is not a member of the one that is.
   */
  it('refuses when a different composition has been opened under the form', async () => {
    await openTrackCommand();
    const run = screen.getByRole('button', { name: 'Run' });

    await act(async () => {
      const other = openBlankComposition('Another song');
      if (!other.ok) throw new Error(other.reason);
      fireEvent.click(run);
    });

    expect(harness.inputs).toHaveLength(0);
    expect(isJobRunning()).toBe(false);
    expect(within(report()).getByText(/No track is selected any more/)).toBeInTheDocument();
  });

  /**
   * ⚠ THE DATA-LOSS ONE. With no block open `writePatternBack` falls through to
   * its LIBRARY branch, so an Edit row launched here would rewrite whatever
   * pattern the pattern page left open — off-screen, outside the rollback.
   */
  it('refuses an Edit row when the block has closed since the render', async () => {
    openBlock();
    render(<CompositionCommandPanel view="edit" />);
    await userEvent.click(screen.getByRole('button', { name: 'Fix the timing' }));
    const run = screen.getByRole('button', { name: 'Run' });

    await act(async () => {
      closePlacementEditing();
      fireEvent.click(run);
    });

    expect(harness.inputs).toHaveLength(0);
    expect(isJobRunning()).toBe(false);
    expect(
      within(report()).getByText(/No block on the selected track is open for editing/),
    ).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ the run ---

describe('a run in flight', () => {
  it('reports the tools as they run, and marks the one in flight', async () => {
    openBlankComposition('Song');
    render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="pattern" />);

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
  it('keeps a finished run’s report across a view change', async () => {
    openBlankComposition('Song');
    const track = addTrack('Rhythm');
    if (!track.ok) throw new Error(track.reason);
    selectTrack(track.value.id);
    const { rerender } = render(<CompositionCommandPanel view="pattern" />);

    await startRun();
    callTool('read_composition');
    await finishRun('answered', 'Added a drum track.');

    rerender(<CompositionCommandPanel view="voice" />);

    // The TRACK group swapped…
    expect(
      screen.queryByRole('button', { name: 'Lay a pattern down the timeline' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dial in a tone' })).toBeInTheDocument();
    // …the composition group did NOT, which is milestone 5's own claim…
    expect(screen.getByRole('button', { name: SINGLE_RUN })).toBeInTheDocument();
    // …and neither did the report.
    const done = report();
    expect(within(done).getByText(new RegExp(SINGLE_RUN))).toBeInTheDocument();
    expect(within(done).getByText(/Added a drum track\./)).toBeInTheDocument();
  });

  /**
   * ⚠ A LIVE PATH SINCE MILESTONE 4, AND THE TEST SAYS WHICH ONE.
   *
   * An earlier version of this note called the transition defence: the mode bar
   * was disabled while a job held the document, so nothing changed `mode`
   * mid-run. THE BAR IS GONE. The user's own routes are still shut — the view
   * buttons are `disabled={locked}` in `TrackHeader` and `ArrangementGrid`'s
   * activation coordinator refuses under `isJobRunning()` — but `view` here is
   * `selectedTrackView(...)`, which depends on the SELECTION, and
   * `pruneTrackSelection` nulls the selection when the track it names stops
   * existing. So a run that calls `composition_remove_track` on the selected
   * track changes this panel's `view` prop from inside its own lock.
   *
   * That is the transition driven here, through the run's own tool rather than
   * through a bare `rerender`, so the test is about the app and not about a
   * hypothesis. What it pins is the structure that makes it harmless: the run is
   * rendered outside the selected-command block, so it does not travel with the
   * list. Move it inside `{selected && …}` and this fails.
   */
  it('survives the run changing the selected track out from under the rail', async () => {
    openBlankComposition('Song');
    const track = addTrack('Rhythm');
    if (!track.ok) throw new Error(track.reason);
    selectTrack(track.value.id);
    const { rerender } = render(<CompositionCommandPanel view="voice" />);

    await startRun();
    callTool('read_composition');
    expect(screen.getByRole('button', { name: 'Dial in a tone' })).toBeInTheDocument();

    // The agent's own write, through the run's registry — so it goes through
    // `jobWrite` and the lock lets it past, exactly as a real run's would.
    callTool('composition_remove_track', { trackId: track.value.id });
    expect(getSelectedTrackId()).toBeNull();
    // Which is what the page would now compute for the rail: no valid selection
    // falls back to Pattern (`arrangementMath.selectedTrackView`).
    rerender(<CompositionCommandPanel view="pattern" />);

    // The track group went…
    expect(screen.queryByRole('button', { name: 'Dial in a tone' })).not.toBeInTheDocument();
    expect(screen.getByText(/No track is selected/)).toBeInTheDocument();
    // …and neither the composition group nor the run went with it. Including
    // which command is running, because the form that started it may not be.
    expect(screen.getByRole('button', { name: SINGLE_RUN })).toBeInTheDocument();
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
    render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="pattern" />);

    await startRun();
    expect(isJobRunning()).toBe(true);

    await finishRun();
    expect(isJobRunning()).toBe(false);
  });

  it('is released when the run is cancelled', async () => {
    openBlankComposition('Song');
    render(<CompositionCommandPanel view="pattern" />);

    await startRun();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(isJobRunning()).toBe(false);
  });

  it('is released when the run comes back refused', async () => {
    openBlankComposition('Song');
    harness.throwWith = 'Failed to fetch';
    render(<CompositionCommandPanel view="pattern" />);

    await startRun();

    expect(isJobRunning()).toBe(false);
    expect(within(report()).getByText(/Failed to fetch/)).toBeInTheDocument();
  });

  it('is released when the panel is unmounted mid-run', async () => {
    openBlankComposition('Song');
    const { unmount } = render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="pattern" />);

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
    // A value that went STALE between opening the form and pressing Run, which
    // is the case `fillForNow` is for — as opposed to a slot with nothing to
    // offer at all, which disables Run up front (see "disables one command's
    // Run…"). Two tracks so removing one leaves the slot fillable and only the
    // chosen VALUE dead.
    openBlankComposition('Song');
    const lead = addTrack('Lead');
    if (!lead.ok) throw new Error(lead.reason);
    const tracks = getTracks();
    selectTrack(tracks[0]!.id);
    render(<CompositionCommandPanel view="pattern" />);

    await userEvent.click(screen.getByRole('button', { name: 'Add a harmony track' }));
    act(() => {
      const removed = removeTrack(tracks[0]!.id);
      if (!removed.ok) throw new Error(removed.reason);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));

    expect(harness.live).toBeNull();
    expect(isJobRunning()).toBe(false);
    expect(within(report()).getByText(/no longer offers/)).toBeInTheDocument();
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
    render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="pattern" />);

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
    const { unmount } = render(<CompositionCommandPanel view="pattern" />);

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

    render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="pattern" />);

    await startRun();
    callTool('pattern_open_blank', { name: 'Bass line' });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(within(report()).getByText(/still in your library/)).toBeInTheDocument();
    expect(getEditingPattern()?.name).toBe('Bass line');
  });

  it('does not say it when the run wrote no patterns', async () => {
    openBlankComposition('Song');
    render(<CompositionCommandPanel view="pattern" />);

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
      render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="edit" />);

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

  /**
   * The lock is taken for Edit-view runs too — not because the pattern seam
   * needs it, but because it is what kills every route to closing the placement
   * out from under the agent: `TrackHeader` disables the view buttons on
   * `useIsJobRunning`, `ArrangementGrid`'s activation coordinator refuses under
   * `isJobRunning()`, and the grid's reconciler stays silent about the pointer
   * while the lock is held. (The mode bar this used to name was deleted in
   * milestone 4.)
   */
  it('still holds the document lock for the duration', async () => {
    openBlock();
    render(<CompositionCommandPanel view="edit" />);

    await startRun('Fix the timing');
    expect(isJobRunning()).toBe(true);

    await finishRun();
    expect(isJobRunning()).toBe(false);
  });

  /**
   * The Edit rows cannot be reached without a block, and the withdrawal is what
   * enforces it rather than a guard nobody can trip.
   *
   * ⚠ WITHOUT THIS, `writePatternBack` falls through to its LIBRARY branch and
   * the run rewrites whatever pattern the pattern page left open — off-screen,
   * outside the rollback and outside the lock. `start` carries the same check as
   * defence in depth (the document can move between the render that offered the
   * row and the press) but no route through the UI reaches it, which is the
   * point: the form goes with the row.
   */
  it('withdraws the Edit form when the block closes under it', async () => {
    openBlock();
    render(<CompositionCommandPanel view="edit" />);

    await userEvent.click(screen.getByRole('button', { name: 'Fix the timing' }));
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument();

    act(() => closePlacementEditing());

    expect(screen.queryByRole('button', { name: 'Fix the timing' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
    expect(screen.getByText(/Press a block in this track/)).toBeInTheDocument();
    expect(isJobRunning()).toBe(false);
  });
});

// ------------------------------------------ a global command, from the Edit view ---

/**
 * ⚠ A NEWLY REACHABLE ENTRY PATH, and the reason it has a describe of its own.
 *
 * Before milestone 5 the panel offered ONE list, filtered by the page mode, so
 * in Edit it was the pattern page's rows and nothing else — a composition
 * command could not be launched with a block open. The composition group is now
 * offered in every view, so it can be: the selected track in Edit, one of its
 * blocks open, and "Create a bass line" one press away.
 *
 * What that costs if the pointer is left where it is, and what these tests pin:
 *
 *   - `pattern_open_blank` REFUSES while a placement is open (deliberately — it
 *     is the one place that rule can live), so the row cannot author the part it
 *     exists to author; and
 *   - `pattern_stamp_notes` does NOT refuse. `writePatternBack` routes to the
 *     open placement's snapshot, so the agent's bass line lands in the block the
 *     user was editing.
 *
 * So the panel restores the pointer BEFORE it takes the lock. The gesture half
 * of the order is `ArrangementGrid`'s — its reconciler sweeps `endOutgoingWork()`
 * on the lock transition — and is not repeated here; jsdom has no pointer
 * gestures to end in this file anyway, since the panel is rendered without a
 * grid.
 */
describe('a composition command launched from the Edit view', () => {
  it('restores the pattern pointer before the agent takes the document', async () => {
    const { placementId } = openBlock();
    expect(getEditingPlacementId()).toBe(placementId);
    render(<CompositionCommandPanel view="edit" />);

    await startRun();

    // Closed, and the lock taken.
    expect(getEditingPlacementId()).toBeNull();
    expect(isJobRunning()).toBe(true);
    // ⚠ AND IN THAT ORDER, which is the half the two assertions above cannot
    // see: both writes land in one commit, so a panel that locked first and
    // closed second would satisfy them exactly. See the seam wrapper at the head
    // of this file.
    expect(order.calls).toEqual(['close', 'beginJob']);

    await finishRun();
  });

  it('lets the run author its own pattern, which an open block would have refused', async () => {
    openBlock();
    const userPattern = getEditingPattern();
    render(<CompositionCommandPanel view="edit" />);

    await startRun();
    const opened = callTool('pattern_open_blank', { name: 'Bass', instrumentId: 'bass' }) as {
      ok: boolean;
    };

    // ⚠ THE ASSERTION THE WHOLE ORDER IS FOR. With the placement still open this
    // comes back `{ok: false}` with "A composition block is open for editing",
    // and the row cannot do its job at all.
    expect(opened.ok).toBe(true);
    // And the user's block is not what the run is writing into.
    expect(getEditingPattern()?.id).not.toBe(userPattern?.id);

    await finishRun();
  });

  it('still rolls the arrangement back when it is cancelled', async () => {
    openBlock();
    const before = getTracks().length;
    render(<CompositionCommandPanel view="edit" />);

    await startRun();
    callTool('composition_add_track', { name: 'Bass' });
    expect(getTracks()).toHaveLength(before + 1);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(getTracks()).toHaveLength(before);
    expect(isJobRunning()).toBe(false);
    expect(within(report()).getByText(/put back the way it was/)).toBeInTheDocument();
  });

  it('refuses a second launch while the first is still in flight', async () => {
    openBlankComposition('Song');
    render(<CompositionCommandPanel view="pattern" />);

    await startRun();
    const first = harness.live;
    expect(first).not.toBeNull();

    // Another row, another press — one runner, one lock, and the second is
    // refused rather than starting a competing job. The button reads "Running…"
    // rather than being `disabled`, deliberately: disabling it under the pointer
    // that just pressed it drops focus to `<body>`. So it IS pressable, and
    // `inFlightRef` is what makes the press do nothing.
    await userEvent.click(screen.getByRole('button', { name: 'Extend the arrangement' }));
    await userEvent.click(screen.getByRole('button', { name: 'Running…' }));

    expect(harness.live).toBe(first);
    expect(harness.inputs).toHaveLength(1);
    // And Cancel still belongs to the run that is actually going.
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(within(report()).getByText(new RegExp(SINGLE_RUN))).toBeInTheDocument();

    await finishRun();
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

  /**
   * ⚠ ACCEPTANCE 13, AND THE ROW THE MILESTONE IS NAMED AFTER. Tagged
   * `mode: 'pattern'`, this vanished the moment the selected track showed Voice
   * or Edit — which is absurd for a row that creates a NEW composition and reads
   * nothing about the selection. Driven from all three views, and from Edit with
   * a block open, because those are the states that used to hide it.
   */
  it('launches from Voice, from Edit with a block open, and still builds a NEW composition', async () => {
    openBlock();
    const openBefore = getEditingComposition()?.id;
    const { rerender } = render(<CompositionCommandPanel view="voice" />);
    expect(screen.getByRole('button', { name: BACKING_TRACK })).toBeInTheDocument();

    rerender(<CompositionCommandPanel view="edit" />);
    await startRun(BACKING_TRACK);
    expect(irJob.live?.label).toBe(BACKING_TRACK);
    // Still the route's own pipeline, not an agent loop with tools.
    expect(harness.live).toBeNull();

    runThroughParts();
    progress({ type: 'import.started' });
    await settle({ ok: true, value: { documents: documents(['p1', 'p2', 'p3']), chart: CHART } }, () =>
      repointTo('comp-1'),
    );

    expect(within(report()).getByText(/A new composition was created from 3 parts/)).toBeInTheDocument();
    // ⚠ AND THE ONE THE USER HAD OPEN IS NOT THE ONE IT MADE. The route's whole
    // contract, asserted from the state rather than from the sentence.
    expect(openBefore).not.toBe('comp-1');
    expect(getEditingPlacementId()).toBeNull();
    expect(getSelectedTrackId()).toBeNull();
  });

  it('starts the job rather than an agent run, and the other rows still do not', async () => {
    openBlankComposition('Song');
    render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="pattern" />);

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

    render(<CompositionCommandPanel view="pattern" />);
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
    render(<CompositionCommandPanel view="pattern" />);
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
    render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="pattern" />);

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
      render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="pattern" />);

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
    render(<CompositionCommandPanel view="pattern" />);

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
    const { unmount } = render(<CompositionCommandPanel view="pattern" />);

    await startRun(BACKING_TRACK);
    runThroughParts(1);

    unmount();

    expect(irJob.live?.signal?.aborted).toBe(true);
    expect(isJobRunning()).toBe(false);
  });
});
