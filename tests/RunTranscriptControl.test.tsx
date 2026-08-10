import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RunTranscriptControl } from '../src/ai/RunTranscriptControl';
import { beginTranscript, clearTranscripts } from '../src/ai/runTranscript';

/**
 * The control's whole job is to work when something has already gone wrong, so
 * what is asserted is that it survives the platform not cooperating.
 *
 * The two APIs it reaches for are NOT equally available here, and the difference
 * shaped these tests: jsdom has no `navigator.clipboard` — the same shape as a
 * page served over plain HTTP — but it DOES implement `URL.createObjectURL`. So
 * the clipboard fallback is reachable simply by clicking, while the download
 * fallback has to be forced. Getting that backwards writes two tests that pass
 * while exercising nothing.
 */

const meta = {
  page: 'pattern' as const,
  command: 'Fix the timing',
  agent: 'pattern',
  systemPrompt: '# How you work\n\nYou act only by calling tools.',
  input: 'Pull every note onto a clean grid.',
};

beforeEach(() => clearTranscripts());

describe('the run log control', () => {
  it('renders nothing for a transcript that has fallen out of the buffer', () => {
    const { container } = render(<RunTranscriptControl transcriptId="run-999" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('falls back to a selectable textarea when the clipboard is unavailable', async () => {
    const transcript = beginTranscript(meta);
    transcript.record({
      type: 'tool.requested',
      runId: 'r',
      callId: 'c1',
      name: 'pattern_move_notes',
      args: { moves: [{ noteId: 'ev_1', startTick: 480 }] },
    });

    render(<RunTranscriptControl transcriptId={transcript.id} />);
    // `fireEvent` and NOT `userEvent`: `userEvent` installs a clipboard stub of
    // its own, so driving this with it would test the stub and never reach the
    // branch that matters. Bare jsdom has no `navigator.clipboard` — the same
    // shape as a page served over plain HTTP, which is the real case.
    expect(navigator.clipboard).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    const log = screen.getByRole('textbox', { name: 'Run log' });
    expect((log as HTMLTextAreaElement).value).toContain('pattern_move_notes');
    // `readOnly`, not `disabled` — a disabled field cannot be focused, so its
    // contents cannot be selected, which would defeat the fallback entirely.
    expect(log).toHaveAttribute('readonly');
    expect(log).not.toBeDisabled();
  });

  it('hands the log to the browser as a file, named after the run', async () => {
    // jsdom DOES implement `createObjectURL`, so this is the real path.
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:log');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    // The anchor's own click is stubbed, and not to avoid asserting it: jsdom
    // does not honour `download`, so a real click makes it try to NAVIGATE to
    // the blob url and print "Not implemented" to stderr on every run. Stubbing
    // lets the element itself be asserted, which is the more useful check.
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    const transcript = beginTranscript(meta);
    render(<RunTranscriptControl transcriptId={transcript.id} />);
    await userEvent.click(screen.getByRole('button', { name: 'Download' }));

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);

    const link = click.mock.instances[0] as HTMLAnchorElement;
    expect(link.href).toBe('blob:log');
    expect(link.download).toBe(`${transcript.id}.json`);

    // Released, and released with the url it created — a revoke that dropped
    // the wrong handle would leak the blob for as long as the tab is open.
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:log');

    click.mockRestore();
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });

  it('does not throw when the platform has no createObjectURL', () => {
    const transcript = beginTranscript(meta);
    // The guard exists for the environments that lack it. Removed rather than
    // mocked, because what is being asserted is the absence branch.
    const original = URL.createObjectURL;
    // Defined away rather than `delete`d: jsdom's is not configurable by
    // deletion, so a `delete` reports success and leaves the function in place —
    // which would quietly run the real path and assert nothing.
    Object.defineProperty(URL, 'createObjectURL', { value: undefined, configurable: true });
    try {
      render(<RunTranscriptControl transcriptId={transcript.id} />);
      // The failure this guards against is an unguarded throw inside a click
      // handler, which React turns into the rail unmounting — a diagnostic
      // control taking down the panel it is diagnosing.
      fireEvent.click(screen.getByRole('button', { name: 'Download' }));
      expect(screen.getByRole('textbox', { name: 'Run log' })).toBeInTheDocument();
    } finally {
      Object.defineProperty(URL, 'createObjectURL', { value: original, configurable: true });
    }
  });

  it('copies the transcript when a clipboard is there', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

    const transcript = beginTranscript(meta);
    transcript.finish({ stoppedReason: 'answered' });
    render(<RunTranscriptControl transcriptId={transcript.id} />);

    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0]?.[0]).toContain('"command": "Fix the timing"');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('shows the log on request without any copying at all', async () => {
    const transcript = beginTranscript(meta);
    render(<RunTranscriptControl transcriptId={transcript.id} />);

    const show = screen.getByRole('button', { name: 'Show' });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(show);

    expect(screen.getByRole('textbox', { name: 'Run log' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByRole('textbox', { name: 'Run log' })).not.toBeInTheDocument();
  });
});
