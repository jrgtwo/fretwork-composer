import { useState } from 'react';
import { COMMAND_BUTTON } from './commandSlots';
import { getTranscript, transcriptText } from './runTranscript';

/**
 * The way a failed run leaves the browser.
 *
 * Shown on both panels' reports, on every run that has ENDED — not only on the
 * ones that went wrong. A run that answered but built the wrong thing is the
 * case a "something failed" affordance would miss, and it is a real case: the
 * arrangement that came back four bars short answered perfectly well.
 *
 * ── Copy first, download second ─────────────────────────────────────────────
 *
 * Copy is the one that matches what actually happens — the transcript gets
 * pasted into a message. Download exists for the runs too big to want in a
 * clipboard, and because a file survives the tab.
 *
 * ⚠ BOTH ARE FEATURE-DETECTED. `navigator.clipboard` is absent over plain HTTP
 * and in jsdom, and `URL.createObjectURL` is absent in jsdom — an unguarded call
 * to either throws inside a click handler, which React surfaces as an error
 * boundary tearing down the rail. A diagnostic control that can break the panel
 * it is diagnosing is worse than none. The fallback is the textarea below: the
 * transcript rendered where it can be selected by hand, which needs nothing from
 * the platform at all.
 */
export function RunTranscriptControl({ transcriptId }: { transcriptId: string }) {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(false);

  // Read at click time, never held in state. A transcript is mutated in place as
  // the run proceeds and can still be growing when this renders; a copy taken at
  // render would be the run as it was some renders ago.
  const exists = getTranscript(transcriptId) !== undefined;
  if (!exists) return null;

  const copy = () => {
    const text = transcriptText(transcriptId);
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      setShown(true);
      return;
    }
    void clipboard.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      // A rejected write is a permissions decision, not a bug — fall through to
      // the thing that needs no permission.
      () => setShown(true),
    );
  };

  const download = () => {
    if (typeof URL.createObjectURL !== 'function') {
      setShown(true);
      return;
    }
    const blob = new Blob([transcriptText(transcriptId)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = `${transcriptId}.json`;
    link.click();
    // Released on the next turn of the loop rather than immediately: revoking
    // synchronously after `click()` races the browser's own read of the URL in
    // some engines, and the leak until then is one blob.
    window.setTimeout(() => URL.revokeObjectURL(href), 0);
  };

  return (
    <div className="mt-1.5">
      <p className="font-mono text-[9px] font-bold tracking-[0.12em] text-ink-mut uppercase">
        Run log
      </p>
      <div className="mt-0.5 flex flex-wrap gap-1">
        <button type="button" onClick={copy} className={COMMAND_BUTTON}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" onClick={download} className={COMMAND_BUTTON}>
          Download
        </button>
        <button
          type="button"
          onClick={() => setShown((was) => !was)}
          className={COMMAND_BUTTON}
          aria-expanded={shown}
        >
          {shown ? 'Hide' : 'Show'}
        </button>
      </div>

      {shown && (
        // `readOnly` and not `disabled`: a disabled textarea cannot be focused,
        // so its content cannot be selected — which is the entire point of the
        // fallback path that lands here.
        <textarea
          readOnly
          aria-label="Run log"
          value={transcriptText(transcriptId)}
          className="mt-1 h-40 w-full resize-y rounded-[7px] bg-black/25 p-1.5 font-mono text-[9px] leading-relaxed text-ink"
        />
      )}
    </div>
  );
}
