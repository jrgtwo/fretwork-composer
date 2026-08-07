import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectorControl } from '../src/ai/ConnectorPanel';
import {
  CONNECTOR_STORAGE_KEY,
  EMPTY_CONNECTOR_SETTINGS,
  getConnectorSettings,
  isConfigured,
  setConnectorSettings,
  subscribeToConnectorSettings,
} from '../src/ai/connectorSettings';
import {
  buildTestRequest,
  chatCompletionsUrl,
  outcomeForRejection,
  outcomeForResponse,
  runConnectionTest,
  validateBaseUrl,
  TEST_REQUEST_MODEL,
} from '../src/ai/testConnection';

/**
 * AG-08 — the connector.
 *
 * jsdom has NO NETWORK, so nothing here proves the browser can reach a provider;
 * that is what the button is for, pressed by a human against a real endpoint.
 * What IS worth pinning, and is pinned below, is everything around the wire:
 *
 *   - the request SHAPE, so what the button tests is what a client will send;
 *   - the OUTCOME MAPPING, which is the difference between sending someone to
 *     fix their token and sending them to fix their URL — and, in the one
 *     ambiguous case, the difference between saying "CORS" and saying "one of
 *     these two, check both";
 *   - that the settings survive a reload, and that the token never leaks into a
 *     log or into the report.
 *
 * A `Response` is faked as a plain object rather than constructed: jsdom does not
 * ship `fetch`, and the only two things this code reads off a response are
 * `status` and `text()`.
 */
function fakeResponse(status: number, body = ''): Response {
  return { status, text: async () => body } as unknown as Response;
}

/** A `fetch` that stays outstanding until the test lets it answer — the only way
 *  to observe the in-flight state at all. */
function deferredFetch() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { fetchImpl: vi.fn(() => promise), resolve };
}

/** The result path is `.then().catch().finally()`, so one awaited microtask is
 *  not enough to know a reply has been fully handled — or deliberately dropped. */
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

const LOCAL = 'http://localhost:8080/v1';
const TOKEN = 'sk-do-not-leak-9f3a';

/** Anchored: the dialog's own close button is "Close connector settings", which
 *  an unanchored /connector/i matches too. */
const OPENER_NAME = /^connector/i;

beforeEach(() => {
  localStorage.clear();
  // Also drops the module's in-memory cache, which `localStorage.clear()` alone
  // cannot reach.
  setConnectorSettings(EMPTY_CONNECTOR_SETTINGS);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------- request ---

describe('buildTestRequest', () => {
  it('posts to <base>/chat/completions, with the base URL normalised', () => {
    expect(buildTestRequest({ baseUrl: '  http://localhost:8080/v1//  ', token: '' }).url).toBe(
      'http://localhost:8080/v1/chat/completions',
    );
    expect(chatCompletionsUrl('https://api.example.com/v1')).toBe(
      'https://api.example.com/v1/chat/completions',
    );
  });

  it('sends JSON, one token, and a model that is not meant to exist', () => {
    const request = buildTestRequest({ baseUrl: LOCAL, token: '' });

    expect(request.method).toBe('POST');
    expect(request.headers['content-type']).toBe('application/json');
    expect(JSON.parse(request.body)).toEqual({
      model: TEST_REQUEST_MODEL,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    });
  });

  it('carries a bearer token only when there is one', () => {
    expect(buildTestRequest({ baseUrl: LOCAL, token: '' }).headers.authorization).toBeUndefined();
    // Whitespace is not a credential — an empty `Bearer ` would be rejected by a
    // server that wanted no header at all.
    expect(buildTestRequest({ baseUrl: LOCAL, token: '   ' }).headers.authorization).toBeUndefined();
    expect(buildTestRequest({ baseUrl: LOCAL, token: TOKEN }).headers.authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });
});

// --------------------------------------------------------------- outcomes ---

describe('outcomeForResponse', () => {
  it('reads 2xx as reachable', () => {
    const outcome = outcomeForResponse(200, '{}', true);
    expect(outcome.kind).toBe('reachable');
    expect(outcome.reached).toBe(true);
    expect(outcome.status).toBe(200);
    expect(outcome.checks).toEqual([]);
  });

  it('reads 401 as reached-but-rejected, and names the token as the problem', () => {
    const outcome = outcomeForResponse(401, 'invalid api key', true);
    expect(outcome.kind).toBe('auth-rejected');
    // The load-bearing claim: a response arriving at all clears CORS and the URL.
    expect(outcome.reached).toBe(true);
    expect(outcome.detail).toMatch(/token/i);
    expect(outcome.checks.join(' ')).toMatch(/token/i);
  });

  it('says a 401 with no token sent needs one, rather than blaming the token', () => {
    expect(outcomeForResponse(401, '', false).checks.join(' ')).toMatch(/No token was sent/i);
    expect(outcomeForResponse(403, '', true).kind).toBe('auth-rejected');
  });

  it('reads a plain 404 as the wrong path, and points at /v1', () => {
    const outcome = outcomeForResponse(404, 'Not Found', true);
    expect(outcome.kind).toBe('not-found');
    expect(outcome.reached).toBe(true);
    expect(outcome.checks.join(' ')).toMatch(/\/v1/);
  });

  it('does not blame the path for a 404 that is about the model', () => {
    // This probe deliberately sends a model nobody has, and some providers answer
    // 404 for that. Reporting it as a wrong path sends the user to edit a URL
    // that was correct.
    const outcome = outcomeForResponse(404, '{"error":{"code":"model_not_found"}}', true);
    expect(outcome.kind).toBe('not-found');
    expect(outcome.title).toMatch(/no such model/i);
    // Neither 404 branch is certain, so neither is a dead end: this one still
    // says what to look at if a real call fails the same way.
    expect(outcome.checks.join(' ')).toMatch(/\/v1/);
  });

  it('does not read a 404 that merely echoes the request as an unknown model', () => {
    // Several proxies reflect the request body in their 404. A bare /model/ test
    // matches `"model":"connection-test"` and would tell someone with a WRONG
    // PATH that the transport is fine and there is nothing to fix.
    const outcome = outcomeForResponse(
      404,
      '{"error":"not found","request":{"model":"connection-test","max_tokens":1}}',
      true,
    );
    expect(outcome.title).toMatch(/nothing at that path/i);
    expect(outcome.checks.join(' ')).toMatch(/\/v1/);
    // …and it still admits the other reading rather than sending them to fix the
    // wrong thing outright.
    expect(outcome.checks.join(' ')).toMatch(/unknown model/i);
  });

  it('keeps the same reading for the other wordings providers use', () => {
    for (const body of [
      'The model `connection-test` does not exist',
      '{"error":{"message":"unknown model"}}',
      'no such model: connection-test',
    ]) {
      expect(outcomeForResponse(404, body, true).title).toMatch(/no such model/i);
    }
  });

  it('reads any other status as reached, with the connection cleared', () => {
    const outcome = outcomeForResponse(500, '', true);
    expect(outcome.kind).toBe('error-response');
    expect(outcome.reached).toBe(true);
    expect(outcome.title).toContain('500');
  });
});

describe('outcomeForRejection', () => {
  const context = { url: `${LOCAL}/chat/completions`, origin: 'http://localhost:5173' };

  it('refuses to claim whether a rejection was CORS or a dead server', () => {
    const outcome = outcomeForRejection(new TypeError('Failed to fetch'), context);

    expect(outcome.kind).toBe('blocked');
    expect(outcome.reached).toBe(false);
    // The honesty requirement, asserted rather than trusted: the copy must say
    // the two are indistinguishable, and must not assert either one.
    expect(outcome.detail).toMatch(/cannot tell them apart/i);
    expect(outcome.detail).not.toMatch(/blocked by CORS|the server is not running/i);
    // …and it must offer both fixes, cheapest first.
    expect(outcome.checks[0]).toMatch(/listening/i);
    expect(outcome.checks.join(' ')).toMatch(/cross-origin/i);
    expect(outcome.checks.join(' ')).toContain(context.origin);
  });

  it('does state mixed content plainly, because that one is decidable', () => {
    const outcome = outcomeForRejection(new TypeError('Failed to fetch'), {
      url: 'http://localhost:8080/v1/chat/completions',
      origin: 'https://app.example.com',
    });

    expect(outcome.title).toMatch(/mixed content/i);
    expect(outcome.detail).toMatch(/explains this result/i);
  });

  it('separates a timeout from a refusal', () => {
    const outcome = outcomeForRejection(
      new DOMException('The operation timed out.', 'TimeoutError'),
      context,
    );
    expect(outcome.kind).toBe('timed-out');
    expect(outcome.reached).toBe(false);
    expect(outcome.detail).toMatch(/deadline/i);
  });

  it('reads a deliberate abort the same way as the deadline', () => {
    // The deadline arrives as a TimeoutError today; anything that later cancels a
    // probe by hand arrives as an AbortError, and both mean "no answer", not
    // "blocked".
    const outcome = outcomeForRejection(new DOMException('Aborted.', 'AbortError'), context);
    expect(outcome.kind).toBe('timed-out');
  });
});

describe('validateBaseUrl', () => {
  it('passes a usable http(s) URL', () => {
    expect(validateBaseUrl(LOCAL)).toBeNull();
    expect(validateBaseUrl('https://api.example.com/v1/')).toBeNull();
  });

  // The copy IS the value of this function — each of these sends someone
  // somewhere different, so the titles are asserted per case rather than the
  // shared `kind`.
  it('names an empty base URL as nothing to test', () => {
    const outcome = validateBaseUrl('   ');
    expect(outcome?.kind).toBe('invalid-url');
    expect(outcome?.title).toBe('No base URL');
  });

  it('names an unparseable base URL as unparseable', () => {
    const outcome = validateBaseUrl('not a url');
    expect(outcome?.title).toBe('Not a URL');
  });

  it('names a scheme a browser cannot fetch', () => {
    // `localhost:8080` PARSES — protocol `localhost:` — so it is a scheme
    // problem, not a parse problem, and the copy has to match or the fix does
    // not follow from it.
    expect(validateBaseUrl('localhost:8080')?.title).toBe('Unsupported scheme');
    expect(validateBaseUrl('ftp://example.com')?.title).toBe('Unsupported scheme');
  });

  it('refuses a base URL carrying a query or fragment rather than mangling the path', () => {
    // `/chat/completions` is appended to the end, so a query would end up in the
    // middle: `…?api-version=1/chat/completions`.
    const outcome = validateBaseUrl('https://example.com/openai?api-version=2024-02-01');
    expect(outcome?.kind).toBe('invalid-url');
    expect(outcome?.title).toMatch(/query or fragment/i);
    expect(validateBaseUrl('https://example.com/v1#frag')?.kind).toBe('invalid-url');
  });
});

// ------------------------------------------------------------------- send ---

describe('runConnectionTest', () => {
  it('sends the built request through the injected fetch and maps the answer', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, '{"choices":[]}'));

    const outcome = await runConnectionTest(
      { baseUrl: LOCAL, token: TOKEN },
      { fetchImpl: fetchImpl as unknown as typeof fetch, origin: 'http://localhost:5173' },
    );

    expect(outcome.kind).toBe('reachable');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:8080/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    });
    // The body has to go out too: an empty POST is a 400 from every real
    // provider, which would report as "reached, answered 400" and send someone
    // hunting for a problem this page created.
    expect(JSON.parse(init.body as string)).toEqual({
      model: TEST_REQUEST_MODEL,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    });
    // And a deadline, or a firewalled host hangs the button for the life of the tab.
    expect(init.signal).toBeDefined();
    expect(init.signal?.aborted).toBe(false);
  });

  it('maps a fetch rejection to the ambiguous outcome', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });

    const outcome = await runConnectionTest(
      { baseUrl: LOCAL, token: '' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, origin: 'http://localhost:5173' },
    );

    expect(outcome.kind).toBe('blocked');
    expect(outcome.reached).toBe(false);
  });

  it('never sends a request it knows cannot work', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200));

    const outcome = await runConnectionTest(
      { baseUrl: '', token: '' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(outcome.kind).toBe('invalid-url');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('defaults to the stored settings, so it is callable with no arguments', async () => {
    setConnectorSettings({ baseUrl: LOCAL, token: '' });
    const fetchImpl = vi.fn(async () => fakeResponse(200));

    const outcome = await runConnectionTest(undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome.kind).toBe('reachable');
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe('http://localhost:8080/v1/chat/completions');
  });
});

// ------------------------------------------------------------ persistence ---

describe('connector settings storage', () => {
  it('holds both values in localStorage, under a named key', () => {
    setConnectorSettings({ baseUrl: LOCAL, token: TOKEN });

    const raw = localStorage.getItem(CONNECTOR_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({ baseUrl: LOCAL, token: TOKEN });
  });

  it('re-reads what was stored after a reload', async () => {
    setConnectorSettings({ baseUrl: LOCAL, token: TOKEN });

    // jsdom cannot reload a page. Resetting the module registry and re-importing
    // is the faithful equivalent for what is being asserted: a FRESH module
    // instance, with an empty in-memory cache, reading the same storage.
    vi.resetModules();
    const reloaded = await import('../src/ai/connectorSettings');

    expect(reloaded.getConnectorSettings()).toEqual({ baseUrl: LOCAL, token: TOKEN });
    expect(reloaded.isConfigured(reloaded.getConnectorSettings())).toBe(true);
  });

  it('treats unreadable storage as not configured rather than throwing', async () => {
    localStorage.setItem(CONNECTOR_STORAGE_KEY, 'not json');

    // Through a FRESH module, because that is the only path that parses storage:
    // a hand-edited key is read on load, and an exception there takes the app
    // down before anything renders.
    vi.resetModules();
    const reloaded = await import('../src/ai/connectorSettings');

    expect(reloaded.getConnectorSettings()).toEqual(EMPTY_CONNECTOR_SETTINGS);
    expect(reloaded.isConfigured(reloaded.getConnectorSettings())).toBe(false);
  });

  it('ignores stored JSON that is the wrong shape', async () => {
    for (const stored of ['[]', '"a string"', '{"baseUrl":7,"token":null}']) {
      localStorage.setItem(CONNECTOR_STORAGE_KEY, stored);
      vi.resetModules();
      const reloaded = await import('../src/ai/connectorSettings');

      expect(reloaded.getConnectorSettings()).toEqual(EMPTY_CONNECTOR_SETTINGS);
    }
  });

  it('only the base URL decides whether a connector is configured', () => {
    // A blank token is legitimate — a local llama.cpp wants none.
    expect(isConfigured({ baseUrl: '   ', token: TOKEN })).toBe(false);
    expect(isConfigured({ baseUrl: LOCAL, token: '' })).toBe(true);
  });

  it('writes even an unchanged value, so storage can be forced back into agreement', () => {
    setConnectorSettings({ baseUrl: LOCAL, token: TOKEN });
    // Another tab, or a devtools clear: storage and the module cache now disagree
    // and re-setting the same value is the only lever there is.
    localStorage.clear();

    setConnectorSettings({ baseUrl: LOCAL, token: TOKEN });

    expect(JSON.parse(localStorage.getItem(CONNECTOR_STORAGE_KEY) as string)).toEqual({
      baseUrl: LOCAL,
      token: TOKEN,
    });
  });

  it('picks up a change made in another tab', () => {
    setConnectorSettings({ baseUrl: LOCAL, token: '' });
    let notified = 0;
    const unsubscribe = subscribeToConnectorSettings(() => {
      notified += 1;
    });

    // What the browser does for the other tab's write: the value is already in
    // storage by the time the event arrives.
    localStorage.setItem(
      CONNECTOR_STORAGE_KEY,
      JSON.stringify({ baseUrl: 'http://elsewhere:9000/v1', token: '' }),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: CONNECTOR_STORAGE_KEY }));

    expect(getConnectorSettings().baseUrl).toBe('http://elsewhere:9000/v1');
    expect(notified).toBe(1);
    unsubscribe();
  });
});

// ---------------------------------------------------------------- surface ---

describe('ConnectorControl', () => {
  it('opens the connector from the frame, and reports whether one is set up', async () => {
    const user = userEvent.setup();
    render(<ConnectorControl />);

    const opener = screen.getByRole('button', { name: OPENER_NAME });
    expect(opener).toHaveAccessibleName(/not configured/i);

    await user.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Connector' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText('Base URL')).toBeInTheDocument();
    expect(screen.getByLabelText('API token')).toBeInTheDocument();
  });

  it('persists what is typed, and shows the exact URL it will post to', async () => {
    const user = userEvent.setup();
    render(<ConnectorControl />);
    await user.click(screen.getByRole('button', { name: OPENER_NAME }));

    await user.type(screen.getByLabelText('Base URL'), LOCAL);

    expect(getConnectorSettings().baseUrl).toBe(LOCAL);
    expect(screen.getByText('http://localhost:8080/v1/chat/completions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: OPENER_NAME })).toHaveAccessibleName(
      /(?<!not )configured/i,
    );
  });

  it('claims no destination until there is a base URL', async () => {
    const user = userEvent.setup();
    render(<ConnectorControl />);
    await user.click(screen.getByRole('button', { name: OPENER_NAME }));

    // An empty field would otherwise read "Posts to /chat/completions" — a
    // same-origin path nothing would ever be posted to, on the one screen where
    // the user has least idea what is correct.
    expect(screen.getByRole('dialog')).not.toHaveTextContent('/chat/completions');
  });

  it('says where the settings are kept', async () => {
    const user = userEvent.setup();
    render(<ConnectorControl />);
    await user.click(screen.getByRole('button', { name: OPENER_NAME }));

    const dialog = screen.getByRole('dialog', { name: 'Connector' });
    expect(dialog).toHaveTextContent(/localStorage/);
    expect(dialog).toHaveTextContent(/plain text/i);
  });

  it('reports a reachable provider after a real press', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => fakeResponse(200, '{"choices":[]}'));
    vi.stubGlobal('fetch', fetchMock);

    setConnectorSettings({ baseUrl: LOCAL, token: TOKEN });
    render(<ConnectorControl />);
    await user.click(screen.getByRole('button', { name: OPENER_NAME }));
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/reachable/i));
    // The token's one legitimate destination.
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
  });

  it('reports a rejection without deciding which failure it was', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    setConnectorSettings({ baseUrl: LOCAL, token: '' });
    render(<ConnectorControl />);
    await user.click(screen.getByRole('button', { name: OPENER_NAME }));
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    const status = await screen.findByText(/blocked or unreachable/i);
    expect(status).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/cannot tell them apart/i);
  });

  it('clears the stale result when the endpoint is edited', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse(200)),
    );

    setConnectorSettings({ baseUrl: LOCAL, token: '' });
    render(<ConnectorControl />);
    await user.click(screen.getByRole('button', { name: OPENER_NAME }));
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/reachable/i));

    await user.type(screen.getByLabelText('Base URL'), '2');

    // "Reachable" left standing beside an edited URL is a claim about an endpoint
    // nobody tested.
    expect(screen.getByRole('status')).not.toHaveTextContent(/reachable/i);
  });

  it('disables the button while a probe is in flight, so two cannot race', async () => {
    const user = userEvent.setup();
    const pending = deferredFetch();
    vi.stubGlobal('fetch', pending.fetchImpl);

    setConnectorSettings({ baseUrl: LOCAL, token: '' });
    render(<ConnectorControl />);
    await user.click(screen.getByRole('button', { name: OPENER_NAME }));
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    const busy = screen.getByRole('button', { name: 'Testing…' });
    expect(busy).toBeDisabled();
    // A second press is the whole reason this is disabled: two probes in flight
    // means last-to-resolve wins, which need not be the last one asked for.
    await user.click(busy);
    expect(pending.fetchImpl).toHaveBeenCalledTimes(1);

    pending.resolve(fakeResponse(200));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/reachable/i));
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled();
  });

  it('drops a result that lands after the endpoint was edited', async () => {
    const user = userEvent.setup();
    const pending = deferredFetch();
    vi.stubGlobal('fetch', pending.fetchImpl);

    setConnectorSettings({ baseUrl: LOCAL, token: '' });
    render(<ConnectorControl />);
    await user.click(screen.getByRole('button', { name: OPENER_NAME }));
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    // Typed WHILE the probe is outstanding: the answer coming back describes
    // `…8080/v1`, and the field now says `…8080/v12`.
    await user.type(screen.getByLabelText('Base URL'), '2');
    pending.resolve(fakeResponse(200));
    await flushMicrotasks();

    expect(screen.getByRole('status')).not.toHaveTextContent(/reachable/i);
    // And the busy line must not describe a URL that has since changed either.
    expect(screen.getByRole('status')).not.toHaveTextContent(/testing/i);
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled();
  });

  it('keeps Tab inside the dialog, which is what aria-modal promises', async () => {
    const user = userEvent.setup();
    render(<ConnectorControl />);
    await user.click(screen.getByRole('button', { name: OPENER_NAME }));
    const dialog = screen.getByRole('dialog', { name: 'Connector' });

    // Nothing behind is inert, so without a trap this lands on the page nav — a
    // keyboard user ends up somewhere they cannot see and cannot act.
    screen.getByRole('button', { name: 'Forget' }).focus();
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    screen.getByRole('button', { name: 'Close connector settings' }).focus();
    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it('never puts the token in a log or in the report', async () => {
    const user = userEvent.setup();
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse(401, `Incorrect API key provided: ${TOKEN}`)),
    );

    render(<ConnectorControl />);
    await user.click(screen.getByRole('button', { name: OPENER_NAME }));
    await user.type(screen.getByLabelText('Base URL'), LOCAL);
    await user.type(screen.getByLabelText('API token'), TOKEN);
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/credentials/i));

    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(TOKEN);
      }
    }
    // Not in the report either — providers echo rejected keys back in their error
    // bodies, which is why the body is classified and never displayed.
    expect(screen.getByRole('status').textContent ?? '').not.toContain(TOKEN);
    // The field itself is the one place it is on screen, and it is masked there.
    expect(screen.getByLabelText('API token')).toHaveAttribute('type', 'password');
  });

  it('forgets both values on request', async () => {
    const user = userEvent.setup();
    setConnectorSettings({ baseUrl: LOCAL, token: TOKEN });
    render(<ConnectorControl />);
    await user.click(screen.getByRole('button', { name: OPENER_NAME }));

    await user.click(screen.getByRole('button', { name: 'Forget' }));

    expect(getConnectorSettings()).toEqual(EMPTY_CONNECTOR_SETTINGS);
    expect(JSON.parse(localStorage.getItem(CONNECTOR_STORAGE_KEY) as string)).toEqual(
      EMPTY_CONNECTOR_SETTINGS,
    );
  });

  it('closes on Escape and returns focus to the opener', async () => {
    const user = userEvent.setup();
    render(<ConnectorControl />);
    const opener = screen.getByRole('button', { name: OPENER_NAME });
    await user.click(opener);

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
