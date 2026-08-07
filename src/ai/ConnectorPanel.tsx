import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  CONNECTOR_STORAGE_KEY,
  EMPTY_CONNECTOR_SETTINGS,
  getConnectorSettings,
  isConfigured,
  setConnectorSettings,
  subscribeToConnectorSettings,
  type ConnectorSettings,
} from './connectorSettings';
import {
  chatCompletionsUrl,
  normalizeBaseUrl,
  runConnectionTest,
  type ConnectionOutcome,
} from './testConnection';

/**
 * The connector surface — where the provider URL and token are entered, and
 * where "can this page actually reach it?" is answered.
 *
 * ── Why it lives in the header, and not in a rail ───────────────────────────
 *
 * These settings are APP-level. They are not a property of the pattern being
 * edited or the composition being arranged, and they do not change meaning with
 * the composition page's mode — so neither rail is the right home. The pattern
 * page's rail holds one label and would make the connector look like a pattern
 * tool; the composition page's rail is mode-scoped and would hide the connector
 * behind whichever mode happens to be open, or duplicate it across all of them.
 *
 * The header is the only chrome both pages share and the only place that is
 * already app-scoped, so the affordance goes there and opens a modal. A modal
 * rather than a popover because the content is a form with an outcome report
 * that wants room, and because this is a thing you configure once and dismiss —
 * it should not be sitting in the way of the editor the rest of the time.
 *
 * ── Saving ─────────────────────────────────────────────────────────────────
 *
 * There is no Save button on purpose: the fields ARE the stored value, written
 * on each keystroke. A separate draft would let Test connection check something
 * other than what is stored, which is the one confusion this surface cannot
 * afford. Where the value is kept, and how exposed it is, is stated on the panel
 * itself — see `connectorSettings.ts` for the full reasoning.
 */

const fieldLabelClass =
  'font-mono text-[9px] font-semibold tracking-[0.14em] text-ink-mut uppercase';

const buttonClass =
  'pressable control rounded-[7px] px-2.5 py-1.5 font-mono text-[9.5px] font-bold tracking-[0.12em] uppercase';

/** The React view of the settings store. It lives here rather than beside the
 *  store because `src/ai/*.ts` may import only the seams — see the note at the
 *  top of `connectorSettings.ts`. */
function useConnectorSettings(): ConnectorSettings {
  return useSyncExternalStore(
    subscribeToConnectorSettings,
    getConnectorSettings,
    getConnectorSettings,
  );
}

/** The header affordance. Owns whether the dialog is open — nothing above needs
 *  to know, and a connector panel that survived a page switch would be chrome
 *  left hanging over a surface nobody was configuring. */
export function ConnectorControl() {
  const settings = useConnectorSettings();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const configured = isConfigured(settings);

  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={`${buttonClass} flex items-center gap-1.5`}
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full ${
            configured ? 'bg-brass shadow-glow-brass' : 'bg-line-hi'
          }`}
        />
        Connector
        {/* The dot is the glanceable half; this is the same fact for a screen
            reader, which cannot see it. */}
        <span className="sr-only">{configured ? '— configured' : '— not configured'}</span>
      </button>
      {open && (
        <ConnectorDialog
          onClose={() => {
            setOpen(false);
            // Dismissing must not drop focus to the document, or a keyboard user
            // restarts their tab order from the top of the app.
            buttonRef.current?.focus();
          }}
        />
      )}
    </>
  );
}

/** Everything a keyboard can land on inside the dialog, in document order.
 *  Disabled controls are skipped because the browser skips them too — the Test
 *  button is disabled mid-flight, and a trap that cycled onto it would strand
 *  focus. */
function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])'),
  ].filter((element) => !element.hasAttribute('disabled'));
}

function ConnectorDialog({ onClose }: { onClose: () => void }) {
  const settings = useConnectorSettings();
  const titleId = useId();
  const urlId = useId();
  const tokenId = useId();
  const [outcome, setOutcome] = useState<ConnectionOutcome | null>(null);
  const [testing, setTesting] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Set on unmount so a test that resolves after the dialog closes does not set
  // state on nothing. The request itself is left to finish; it has no side effect.
  const liveRef = useRef(true);
  /** Bumped by anything that makes an in-flight result meaningless. A reply from
   *  a superseded generation is dropped rather than rendered — see `update`. */
  const generationRef = useRef(0);

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const update = (next: ConnectorSettings) => {
    setConnectorSettings(next);
    // The stored value changed, so the last result describes a different
    // endpoint. Keeping it on screen is how someone reads "Reachable" about a
    // URL they have since edited — and a test still IN FLIGHT would do exactly
    // that when it landed, so an edit supersedes it too.
    generationRef.current += 1;
    setOutcome(null);
    setTesting(false);
  };

  const runTest = () => {
    const generation = ++generationRef.current;
    const current = () => liveRef.current && generation === generationRef.current;
    setTesting(true);
    setOutcome(null);
    void runConnectionTest(settings)
      .then((result) => {
        if (current()) setOutcome(result);
      })
      .catch(() => {
        // `runConnectionTest` classifies its own failures, so arriving here means
        // a defect in this app, not a fact about the provider. Nothing truthful
        // can be reported, but the button must not stay disabled forever.
        if (current()) setOutcome(null);
      })
      .finally(() => {
        if (current()) setTesting(false);
      });
  };

  /**
   * `aria-modal` is a promise that focus stays inside, and nothing else here
   * keeps it: the app behind is neither `inert` nor hidden, so without this Tab
   * walks straight out onto page nav a user cannot see they have reached.
   */
  const onKeyDownTrap = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const root = dialogRef.current;
    if (!root) return;
    const focusables = focusablesIn(root);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // Portalled out of the header, which sets `z-20` and so caps any z-index of a
  // descendant inside its stacking context. The repo's overlay convention is a
  // body-level `fixed inset-0 z-50` — see `timeline/NoteSurface`.
  return createPortal(
    <div
      // The scrim is a token at reduced alpha, not a new colour.
      className="fixed inset-0 z-50 flex items-start justify-center bg-ground/75 p-4 pt-[12vh]"
      onPointerDown={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="panel w-[460px] max-w-full p-4"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDownTrap}
      >
        <div className="mb-3 flex items-center gap-2 border-b border-line pb-2.5">
          <h2 id={titleId} className="font-display text-[16px] text-ink-hi">
            Connector
          </h2>
          <span className="flex-1" />
          <button
            type="button"
            aria-label="Close connector settings"
            onClick={onClose}
            className="font-mono text-[12px] text-ink-mut hover:text-ink"
          >
            ✕
          </button>
        </div>

        <p className="mb-3 text-[11px] leading-relaxed text-ink-mut">
          The agent talks to an OpenAI-compatible endpoint that you supply. Nothing is proxied —
          this page posts to it directly, from this origin.
        </p>

        <label htmlFor={urlId} className={`mb-1 block ${fieldLabelClass}`}>
          Base URL
        </label>
        <input
          id={urlId}
          autoFocus
          value={settings.baseUrl}
          spellCheck={false}
          autoComplete="off"
          placeholder="http://localhost:8080/v1"
          onChange={(event) => update({ ...settings, baseUrl: event.currentTarget.value })}
          className="well w-full px-2 py-1.5 font-mono text-[11px] text-ink"
        />
        {/* An empty field has no destination: `chatCompletionsUrl('')` is the
            same-origin `/chat/completions`, which is not where anything would be
            posted, and showing it on first open is a straight lie. */}
        <p className="mt-1 mb-3 font-mono text-[9.5px] text-ink-mut">
          Posts to{' '}
          <span className="text-ink">
            {normalizeBaseUrl(settings.baseUrl) === '' ? '…' : chatCompletionsUrl(settings.baseUrl)}
          </span>
        </p>

        <label htmlFor={tokenId} className={`mb-1 block ${fieldLabelClass}`}>
          API token
        </label>
        <input
          id={tokenId}
          type="password"
          value={settings.token}
          spellCheck={false}
          // `off` is ignored on password fields by Chrome and Safari, which then
          // offer to save the token to the browser's password manager — a second
          // copy of the secret this panel's disclosure does not cover.
          autoComplete="new-password"
          placeholder="optional"
          onChange={(event) => update({ ...settings, token: event.currentTarget.value })}
          className="well w-full px-2 py-1.5 font-mono text-[11px] text-ink"
        />
        <p className="mt-1 mb-3 text-[10.5px] leading-relaxed text-ink-mut">
          Sent as <span className="font-mono text-ink">authorization: Bearer …</span>. Leave empty
          for a local server that wants none.
        </p>

        <p className="tray mb-3 px-2.5 py-2 text-[10.5px] leading-relaxed text-ink-mut">
          Both values are saved as you type, in this browser under{' '}
          <span className="font-mono text-ink">localStorage["{CONNECTOR_STORAGE_KEY}"]</span>. They
          are stored in plain text and are not encrypted — anything running on this page can read
          them. Use a token you can revoke.
        </p>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={runTest}
            disabled={testing}
            className={`pressable control-accent rounded-[7px] px-3 py-1.5 font-mono text-[9.5px] font-bold tracking-[0.12em] uppercase ${
              testing ? 'opacity-60' : ''
            }`}
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button
            type="button"
            onClick={() => update(EMPTY_CONNECTOR_SETTINGS)}
            className={buttonClass}
          >
            Forget
          </button>
        </div>

        {/* Always mounted: a live region that appears with its content is
            announced inconsistently, and an empty one is invisible anyway. */}
        <div role="status" aria-live="polite" className="mt-3 empty:mt-0">
          {testing && (
            <p className="font-mono text-[10px] tracking-[0.1em] text-ink-mut uppercase">
              Testing…
            </p>
          )}
          {outcome && !testing && <OutcomeReport outcome={outcome} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function OutcomeReport({ outcome }: { outcome: ConnectionOutcome }) {
  return (
    <div className="well px-2.5 py-2">
      <p className="flex items-center gap-2">
        {/* Lit by `reached`, not by a 2xx: what this button tests is the
            TRANSPORT, and the commonest success against a real provider is a
            404 or 400 about the deliberately fake model. Grading those as
            failure shows the working case as broken. The title carries whatever
            still needs doing. */}
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 flex-none rounded-full ${
            outcome.reached ? 'bg-brass shadow-glow-brass' : 'bg-line-hi'
          }`}
        />
        <span className="font-mono text-[10px] font-bold tracking-[0.1em] text-ink-hi uppercase">
          {outcome.title}
        </span>
        {outcome.status !== undefined && (
          <span className="font-mono text-[10px] text-ink-mut">HTTP {outcome.status}</span>
        )}
      </p>
      <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink">{outcome.detail}</p>
      {outcome.checks.length > 0 && (
        <ul className="mt-1.5 list-disc pl-4 text-[10.5px] leading-relaxed text-ink-mut">
          {outcome.checks.map((check) => (
            <li key={check}>{check}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
