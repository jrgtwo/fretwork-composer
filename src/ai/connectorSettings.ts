/**
 * The provider connector: which OpenAI-compatible endpoint to talk to, and with
 * what token.
 *
 * ── Where the settings are held ─────────────────────────────────────────────
 *
 * `window.localStorage`, under {@link CONNECTOR_STORAGE_KEY}, as one JSON
 * object. In PLAIN TEXT. That is stated here and again on the surface itself
 * because it is the accepted model for this app and not an oversight: there is
 * no server, no auth and no session, so there is nowhere else a key could live
 * that the page could still read. Anything running on this origin — an
 * extension, a dependency, a devtools paste — can read it. The right token to
 * put in is one you can revoke.
 *
 * A deliberate divergence from the rest of the app, which persists to
 * `sessionStorage`. `sessionStorage` would survive a reload too — it dies with
 * the TAB, not with the reload — and that is exactly why it is wrong here: the
 * connector is machine-level configuration you set once, and being asked for
 * your endpoint again in every new tab is the behaviour of something broken.
 * The cost is the honest one: a credential that outlives the session, on an
 * origin any script can read. Hence the disclosure above and on the panel, and
 * hence Forget.
 *
 * Deliberately not the pattern store either — this is app configuration, not
 * document content, and it must never end up inside a saved pattern or a shared
 * composition.
 *
 * ── Why a store and not `useState` ──────────────────────────────────────────
 *
 * Every capability here is a seam function first and a gesture second.
 * {@link getConnectorSettings} and {@link setConnectorSettings} are callable BY
 * VALUE, with no component mounted — the agent work that follows needs to ask
 * "is a provider configured at all?" from code that has no access to a form.
 * {@link subscribeToConnectorSettings} is what a React view is built on, so the
 * panel cannot hold a copy that drifts from what a caller reads.
 *
 * The `useSyncExternalStore` wrapper deliberately lives in `ConnectorPanel.tsx`
 * and not here: every `.ts` in `src/ai` is walked by the tripwire in
 * `tests/AgentTools.test.ts`, whose allow-list is the seams and sibling modules
 * — nothing in this directory may reach outward, React included. Keeping the
 * store free of React is also what makes it callable from the agent later.
 *
 * Nothing in this module logs, and nothing returns the token in a formatted
 * message. The only place the token is allowed to travel is the `authorization`
 * header built in `./testConnection`.
 */

export type ConnectorSettings = {
  /** The OpenAI-compatible ROOT — no `/chat/completions`; that is appended. */
  readonly baseUrl: string;
  /** Bearer token, or `''` for a local server that wants none. */
  readonly token: string;
};

export const CONNECTOR_STORAGE_KEY = 'fretwork.connector';

export const EMPTY_CONNECTOR_SETTINGS: ConnectorSettings = { baseUrl: '', token: '' };

/**
 * Whether there is anything to talk to. A blank token is legitimate — a local
 * llama.cpp needs none — so only the URL decides this.
 *
 * Takes a value rather than reading, so the panel can apply it to what it is
 * rendering and a non-React caller can apply it to `getConnectorSettings()`
 * without the two disagreeing about the rule.
 */
export function isConfigured(settings: ConnectorSettings): boolean {
  return settings.baseUrl.trim() !== '';
}

/** Held so `getSnapshot` is referentially stable — a fresh object per call is an
 *  infinite render loop under `useSyncExternalStore`. */
let cache: ConnectorSettings | null = null;
const listeners = new Set<() => void>();

/** Storage access itself throws in a browser with cookies disabled, so even
 *  reaching for it is guarded. Absent storage is not an error: the app works,
 *  the settings just will not outlive the tab. */
function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function readStored(): ConnectorSettings {
  const raw = storage()?.getItem(CONNECTOR_STORAGE_KEY);
  if (!raw) return EMPTY_CONNECTOR_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_CONNECTOR_SETTINGS;
    const record = parsed as Record<string, unknown>;
    return {
      baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : '',
      token: typeof record.token === 'string' ? record.token : '',
    };
  } catch {
    // Hand-edited or half-written storage reads as "not configured" rather than
    // taking the app down on load.
    return EMPTY_CONNECTOR_SETTINGS;
  }
}

export function getConnectorSettings(): ConnectorSettings {
  cache ??= readStored();
  return cache;
}

export function setConnectorSettings(next: ConnectorSettings): void {
  const value: ConnectorSettings = { baseUrl: next.baseUrl, token: next.token };
  const current = getConnectorSettings();
  // An unchanged value still WRITES: storage and this cache can disagree (another
  // tab, a devtools edit, a cleared key), and re-setting the same value is then
  // the only way to force them back into agreement. Only the notification is
  // skipped, because a re-render for an identical snapshot is pure noise.
  const unchanged = current.baseUrl === value.baseUrl && current.token === value.token;
  cache = value;
  try {
    storage()?.setItem(CONNECTOR_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Full quota or a private window that refuses writes. The in-memory value
    // still stands, so the session works; it just will not survive a reload.
    // Swallowed rather than surfaced because the alternative — a write that
    // throws out of an onChange — loses the keystroke as well.
  }
  if (unchanged) return;
  notify();
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeToConnectorSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Another tab (or devtools) changed the key. Without this the two tabs disagree
 * about which provider is configured for as long as both stay open, and the
 * agent's "is a provider configured?" answer depends on which tab asked.
 * Dropping the cache rather than parsing the event's `newValue` keeps one read
 * path, including for `localStorage.clear()`, which arrives with a null key.
 */
globalThis.addEventListener?.('storage', (event) => {
  const key = (event as StorageEvent).key;
  if (key !== null && key !== CONNECTOR_STORAGE_KEY) return;
  cache = null;
  notify();
});
