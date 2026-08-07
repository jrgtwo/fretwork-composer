/**
 * "Can this browser actually reach the provider?" — as one request and one
 * answer.
 *
 * This is AG-01 turned into a button. The check has to be made BY THE PAGE, from
 * the page's own origin: `curl` does not enforce CORS, so a request that works
 * in a terminal proves nothing about whether the app can make it. That is the
 * whole reason this file exists rather than a note in the README.
 *
 * The request mirrors the shape an OpenAI-compatible client uses — POST to
 * `<base>/chat/completions`, `content-type: application/json`, and
 * `authorization: Bearer <token>` when a token is set — so what is tested is
 * what will later be sent. The body is minimal and the answer is discarded:
 * `max_tokens: 1` because the TRANSPORT is under test, not the model.
 *
 * ── The thing this file exists to get right ─────────────────────────────────
 *
 * A CORS refusal and a dead server ARE NOT DISTINGUISHABLE from JavaScript.
 * `fetch` rejects with a bare `TypeError` for both, deliberately — the browser
 * will not tell a page why a cross-origin request failed, because that would
 * itself be a cross-origin information leak. So {@link outcomeForRejection}
 * never claims which one happened; it says what is likely and lists what to
 * check, in the order that costs the least to rule out. Guessing here sends
 * someone to add CORS flags to a server that was never running.
 *
 * The inverse is solid, and is the useful half: A RESPONSE THAT ARRIVES IS
 * PROOF. The browser only exposes a cross-origin response the provider's CORS
 * headers permitted it to expose, so any status at all — 401, 404, 500 — means
 * the request left, arrived, and came back readable. Those outcomes carry
 * `reached: true` and can be stated plainly.
 *
 * ── The token ───────────────────────────────────────────────────────────────
 *
 * It goes into the `authorization` header and nowhere else. Nothing here logs,
 * and no outcome string interpolates it. The response BODY is read but never
 * surfaced — some providers echo part of a rejected key back in their error
 * message, and the only thing the body is used for here is telling a
 * wrong-path 404 apart from an unknown-model 404.
 */
import { getConnectorSettings, type ConnectorSettings } from './connectorSettings';

/**
 * The model name the probe sends. It is not expected to exist. A server that
 * validates model names answers 404 or 400, which still proves reach — see
 * {@link outcomeForResponse}, which says so rather than blaming the path.
 */
export const TEST_REQUEST_MODEL = 'connection-test';

/** Trailing slashes off, whitespace off. `http://host:8080/v1/` and
 *  `http://host:8080/v1` are the same endpoint and must not produce a double
 *  slash in the path. */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function chatCompletionsUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

export type ConnectionRequest = {
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

/**
 * Pure: settings in, the exact request out. Separated from the sending so the
 * shape can be asserted without a network, and so the panel can show the URL it
 * is about to hit before anyone presses anything.
 */
export function buildTestRequest(settings: ConnectorSettings): ConnectionRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = settings.token.trim();
  // No header at all when there is no token — an empty `Bearer ` is a malformed
  // credential, and a local server that wants none would reject it.
  if (token !== '') headers.authorization = `Bearer ${token}`;

  return {
    url: chatCompletionsUrl(settings.baseUrl),
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: TEST_REQUEST_MODEL,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    }),
  };
}

// --------------------------------------------------------------- outcomes ---

export type ConnectionOutcomeKind =
  /** 2xx — it answered. */
  | 'reachable'
  /** 401/403 — arrived, credentials refused. */
  | 'auth-rejected'
  /** 404 — arrived, nothing at that path (or no such model). */
  | 'not-found'
  /** Any other non-2xx — arrived, the provider disliked the request. */
  | 'error-response'
  /** `fetch` rejected. CORS or network, and NOT distinguishable. */
  | 'blocked'
  /** The request was still outstanding when the deadline passed. */
  | 'timed-out'
  /** Never sent — the base URL is empty or not a URL. */
  | 'invalid-url';

export type ConnectionOutcome = {
  readonly kind: ConnectionOutcomeKind;
  /**
   * Whether a response came back readable. `true` is the strong claim this
   * check can make: the request crossed the origin boundary in both directions,
   * so CORS is not the problem whatever else is.
   */
  readonly reached: boolean;
  /** Present only when a response arrived. */
  readonly status?: number;
  /** One short line, safe to render in mono. */
  readonly title: string;
  /** What is known, phrased so it does not over-claim. */
  readonly detail: string;
  /** What to try, cheapest to rule out first. Empty when there is nothing to fix. */
  readonly checks: readonly string[];
};

/**
 * Status → outcome. Pure, and the piece most worth pinning in a test: it is the
 * difference between "your token is wrong" and "your URL is wrong", and those
 * send someone to opposite ends of the problem.
 */
export function outcomeForResponse(
  status: number,
  bodyText: string,
  hadToken: boolean,
): ConnectionOutcome {
  if (status >= 200 && status < 300) {
    return {
      kind: 'reachable',
      reached: true,
      status,
      title: 'Reachable',
      detail:
        `The provider answered ${status} and the browser let this page read the response. ` +
        'The endpoint, the path and cross-origin access all work from here.',
      checks: [],
    };
  }

  if (status === 401 || status === 403) {
    return {
      kind: 'auth-rejected',
      reached: true,
      status,
      title: 'Reached — credentials refused',
      detail:
        `The request arrived and the provider answered ${status}, so the URL and cross-origin ` +
        'access are fine. It is the token it did not accept.',
      checks: hadToken
        ? ['Check the token is current and pasted whole, with no stray whitespace.']
        : ['No token was sent. This provider requires one — paste it above and test again.'],
    };
  }

  if (status === 404) {
    // Some providers answer 404 for an unknown MODEL rather than an unknown
    // path, and this probe deliberately sends a model that does not exist. The
    // two 404s want opposite fixes, so the body decides which one to LEAD with.
    //
    // Matched on error CODES and phrases, not the bare word "model": a proxy
    // that echoes the request back in its 404 body includes
    // `"model":"connection-test"`, and treating that as an unknown-model answer
    // would tell someone with a wrong path that nothing is wrong. Neither branch
    // is certain, so neither branch is a dead end — both keep the other reading.
    const aboutModel =
      /model_not_found|unknown model|no such model|invalid model|model[^.]{0,80}does not exist/i.test(
        bodyText,
      );
    const pathChecks = [
      'Most OpenAI-compatible servers want the base URL to end in `/v1`.',
      'If the base URL already ends in `/chat/completions`, drop it — this test appends it.',
    ];
    const modelCheck =
      `Some providers answer 404 for an unknown model, and this probe sends \`${TEST_REQUEST_MODEL}\`` +
      ' on purpose — a 404 here does not have to mean the path is wrong.';
    return {
      kind: 'not-found',
      reached: true,
      status,
      title: aboutModel ? 'Reached — no such model' : 'Reached — nothing at that path',
      detail: aboutModel
        ? `The endpoint answered 404 about the model, not the path. This probe sends ` +
          `\`${TEST_REQUEST_MODEL}\`, which is not meant to exist — the transport works.`
        : 'The request arrived (so cross-origin access works) but there is nothing at ' +
          'the path it was posted to.',
      checks: aboutModel
        ? ['Nothing to fix for the transport. If a real call also 404s, check the base URL ends in `/v1`.']
        : [...pathChecks, modelCheck],
    };
  }

  return {
    kind: 'error-response',
    reached: true,
    status,
    title: `Reached — answered ${status}`,
    detail:
      'A response came back, so the endpoint and cross-origin access work. The provider ' +
      'refused the request itself rather than the connection.',
    checks: [
      `This probe sends the model \`${TEST_REQUEST_MODEL}\`, which is not meant to exist —` +
        ' a 400 here is often that.',
      'A 5xx is the provider’s own problem, not this page’s.',
    ],
  };
}

/**
 * Rejection → outcome. THE HONEST ONE.
 *
 * `fetch` hands us a `TypeError` with a message that varies by browser and says
 * nothing usable. So this returns a single ambiguous outcome and an ordered list
 * of things to check — it does not pick a cause. The one exception is mixed
 * content, which is decidable from the two URLs alone and is stated plainly
 * because it is certain.
 */
export function outcomeForRejection(
  error: unknown,
  context: { readonly url: string; readonly origin: string },
): ConnectionOutcome {
  const aborted =
    error instanceof DOMException &&
    (error.name === 'TimeoutError' || error.name === 'AbortError');
  if (aborted) {
    return {
      kind: 'timed-out',
      reached: false,
      title: 'Timed out',
      detail:
        'Nothing came back before the deadline. A host that is reachable but not listening ' +
        'usually refuses at once, so this is more often a firewall or a wrong host than a wrong port.',
      checks: [
        `Open ${context.url} in a new tab and see whether anything answers.`,
        'Check the host is reachable from this machine at all.',
      ],
    };
  }

  // Decidable, so say it outright: a page on https may not fetch plain http, and
  // the browser stops it before it leaves.
  const mixedContent =
    context.origin.startsWith('https:') && context.url.toLowerCase().startsWith('http:');

  return {
    kind: 'blocked',
    reached: false,
    title: mixedContent ? 'Blocked — mixed content' : 'Blocked or unreachable',
    detail: mixedContent
      ? `This page is served over HTTPS and the endpoint is plain HTTP, so the browser refuses ` +
        'the request before it is sent. That alone explains this result.'
      : 'The request produced no readable response, and the browser does not say why — a ' +
        'cross-origin refusal and a server that is not there both surface as the same error. ' +
        'This result cannot tell them apart, so check both.',
    checks: mixedContent
      ? [
          'Use an https endpoint, or run this app over http (a plain `pnpm dev` origin can call http).',
        ]
      : [
          `Confirm something is listening: open ${context.url || 'the endpoint'} in a new tab.`,
          `Confirm the server allows cross-origin requests from ${context.origin || 'this page’s origin'}` +
            ' — llama.cpp needs its CORS flag, and a hosted provider may not allow browsers at all.',
          'If the server is up and refuses the origin, the fix is server-side or a dev proxy.',
        ],
  };
}

function invalidUrlOutcome(
  title: string,
  detail: string,
  checks: readonly string[],
): ConnectionOutcome {
  return { kind: 'invalid-url', reached: false, title, detail, checks };
}

/**
 * Pure pre-flight. Returns the outcome to report INSTEAD of sending, or `null`
 * when the URL is worth sending to. Nothing here can distinguish a real endpoint
 * from a typo — only that a request could be formed at all.
 */
export function validateBaseUrl(raw: string): ConnectionOutcome | null {
  const normalized = normalizeBaseUrl(raw);
  if (normalized === '') {
    return invalidUrlOutcome(
      'No base URL',
      'There is nothing to test against yet.',
      ['Enter the provider’s OpenAI-compatible root, e.g. `http://localhost:8080/v1`.'],
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return invalidUrlOutcome(
      'Not a URL',
      'The base URL could not be parsed, so no request was made.',
      ['Include the scheme and host, e.g. `http://localhost:8080/v1`.'],
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return invalidUrlOutcome(
      'Unsupported scheme',
      `A browser can only fetch over http or https, and this is \`${parsed.protocol}\`.`,
      ['Use an http:// or https:// endpoint.'],
    );
  }

  // `/chat/completions` is appended to the whole string, so a query or fragment
  // ends up in the MIDDLE of the path — `…?api-version=1/chat/completions`,
  // which is not a request anyone meant to send. Refused rather than silently
  // dropped: the parameter may be load-bearing for that provider, and this
  // connector has nowhere to put it.
  if (parsed.search !== '' || parsed.hash !== '') {
    return invalidUrlOutcome(
      'Query or fragment in base URL',
      'The base URL carries a query string or fragment, and `/chat/completions` is appended ' +
        'to the end — the result would not be a valid path, so nothing was sent.',
      [
        'Give the root only, e.g. `https://api.example.com/v1`.',
        'A provider that needs a query parameter on every call is not usable through this connector yet.',
      ],
    );
  }

  return null;
}

export type ConnectionTestOptions = {
  /** Injected in tests. Defaults to the page's own `fetch` — which is the point:
   *  the request must come from the real origin. */
  readonly fetchImpl?: typeof fetch;
  /** The page origin, used only to phrase the CORS advice. */
  readonly origin?: string;
  /** Milliseconds before giving up. A firewalled host will otherwise hang the
   *  button forever. */
  readonly timeoutMs?: number;
};

/** The body is read only to classify a 404 and is never shown — see the note at
 *  the top of this file. A body that will not read is not an error. */
async function readBodySafely(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

/**
 * Send the probe and classify what came back. Callable by value — the settings
 * are a parameter, defaulting to the stored ones, so this is usable from
 * anywhere and not just from the panel.
 */
export async function runConnectionTest(
  settings: ConnectorSettings = getConnectorSettings(),
  options: ConnectionTestOptions = {},
): Promise<ConnectionOutcome> {
  const invalid = validateBaseUrl(settings.baseUrl);
  if (invalid) return invalid;

  const request = buildTestRequest(settings);
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const origin = options.origin ?? globalThis.location?.origin ?? '';

  try {
    const response = await doFetch(request.url, {
      method: request.method,
      headers: { ...request.headers },
      body: request.body,
      // Not optional: without a deadline a firewalled host leaves the button
      // spinning for as long as the tab is open.
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    const bodyText = await readBodySafely(response);
    return outcomeForResponse(response.status, bodyText, settings.token.trim() !== '');
  } catch (error) {
    return outcomeForRejection(error, { url: request.url, origin });
  }
}
