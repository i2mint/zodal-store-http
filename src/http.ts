/**
 * Shared HTTP plumbing for the zodal HTTP adapters.
 *
 * Everything both `createHttpProvider` and `createHttpBlobProvider` need to talk to a
 * backend over `fetch`: the injectable `FetchLike` type, URL joining, request/response
 * helpers, and `HttpError` — the informative non-2xx error carrying status, method and
 * URL, so a failure tells you *which* call failed and *why*.
 *
 * The `fetch` implementation is always injected (defaulting to `globalThis.fetch`), which
 * is what makes these adapters testable without a network and usable in any runtime that
 * has a WHATWG `fetch` — browser, Node >= 18, Deno, Bun, workers.
 */

/**
 * The subset of WHATWG `fetch` the adapters use.
 *
 * Injectable so tests can hand in a mock backend, and so callers can wrap the real
 * `fetch` (retries, auth token refresh, tracing) without the adapter knowing.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * A non-2xx HTTP response.
 *
 * Carries enough context to debug from the message alone: the method, the resolved URL,
 * the status, and (when readable) the response body — truncated, because backends love to
 * answer with a full HTML error page.
 */
export class HttpError extends Error {
  readonly name = 'HttpError';
  readonly status: number;
  readonly statusText: string;
  readonly method: string;
  readonly url: string;
  readonly body: string;

  constructor(args: {
    status: number;
    statusText: string;
    method: string;
    url: string;
    body: string;
  }) {
    const detail = args.body ? ` — ${truncate(args.body, 500)}` : '';
    super(
      `HTTP ${args.status} ${args.statusText} on ${args.method} ${args.url}${detail}`,
    );
    this.status = args.status;
    this.statusText = args.statusText;
    this.method = args.method;
    this.url = args.url;
    this.body = args.body;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Resolve the fetch implementation, defaulting to a correctly-bound `globalThis.fetch`. */
export function resolveFetch(injected?: FetchLike): FetchLike {
  if (injected) return injected;
  if (typeof globalThis.fetch !== 'function') {
    throw new Error(
      'No global fetch available. Pass a `fetch` implementation in the provider options ' +
        '(e.g. from `node-fetch` or `undici`), or run on a platform with WHATWG fetch.',
    );
  }
  // Wrapped rather than passed by reference: an unbound `fetch` throws
  // "Illegal invocation" in browsers.
  return (input, init) => globalThis.fetch(input, init);
}

/**
 * Join a base URL with path segments, percent-encoding each segment.
 *
 * `joinUrl('/api/clips/', 'osoto gari.mp4')` → `'/api/clips/osoto%20gari.mp4'`.
 * Relative bases are preserved as relative — a relative URL is exactly what you want in
 * `<video src>` when the backend serving the bytes is the same origin as the app.
 */
export function joinUrl(base: string, ...segments: string[]): string {
  const trimmed = base.replace(/\/+$/, '');
  if (segments.length === 0) return trimmed;
  const path = segments.map((s) => encodeURIComponent(s)).join('/');
  return `${trimmed}/${path}`;
}

/** Append a query string to a URL, but only when there is one. */
export function withQuery(url: string, query: URLSearchParams): string {
  const qs = query.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * Merge a caller-supplied `RequestInit` with per-request method/body/headers.
 *
 * The caller's `init` (credentials, mode, auth headers, signal) is the base; per-request
 * headers win on conflict. This is how `credentials: 'include'` — the thing a
 * cookie-authenticated backend needs — is applied to every call from one option.
 */
export function mergeInit(
  base: RequestInit | undefined,
  overrides: { method: string; body?: BodyInit; headers?: Record<string, string> },
): RequestInit {
  const headers = new Headers(base?.headers);
  for (const [key, value] of Object.entries(overrides.headers ?? {})) {
    headers.set(key, value);
  }
  return {
    ...base,
    method: overrides.method,
    headers,
    ...(overrides.body === undefined ? {} : { body: overrides.body }),
  };
}

/**
 * Perform a request and throw `HttpError` on any non-2xx response.
 *
 * Returns the raw `Response` — callers decide whether they want JSON, bytes, or nothing.
 */
export async function httpRequest(
  fetchImpl: FetchLike,
  args: {
    method: string;
    url: string;
    init?: RequestInit;
    body?: BodyInit;
    headers?: Record<string, string>;
  },
): Promise<Response> {
  const response = await fetchImpl(
    args.url,
    mergeInit(args.init, { method: args.method, body: args.body, headers: args.headers }),
  );
  if (!response.ok) {
    throw new HttpError({
      status: response.status,
      statusText: response.statusText,
      method: args.method,
      url: args.url,
      body: await readBodyText(response),
    });
  }
  return response;
}

/** Read a response body as text, tolerating an unreadable/consumed body. */
async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * Parse a JSON response body, returning `undefined` for an empty one.
 *
 * `204 No Content` is a perfectly ordinary answer to `POST`/`PATCH`/`DELETE`, so callers
 * need to distinguish "the server sent back the resource" from "the server sent nothing".
 */
export async function readJson<R>(response: Response): Promise<R | undefined> {
  if (response.status === 204 || response.status === 205) return undefined;
  const text = await readBodyText(response);
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as R;
  } catch (cause) {
    throw new Error(
      `Expected JSON from ${response.url || 'the server'} but the body did not parse: ` +
        `${truncate(text, 200)}`,
      { cause },
    );
  }
}

/**
 * Coerce arbitrary content into a `fetch` body, reporting the MIME type used.
 *
 * Bytes stay bytes (no copy, no base64) — which is the whole point for media. Strings go
 * as text; anything else is JSON-serialized as a last resort.
 */
export function toRequestBody(content: unknown): { body: BodyInit; contentType: string } {
  if (content instanceof Uint8Array) {
    // BufferSource is a valid BodyInit; the slice keeps TS happy about the ArrayBuffer view.
    return { body: content as unknown as BodyInit, contentType: 'application/octet-stream' };
  }
  if (content instanceof ArrayBuffer) {
    return { body: content, contentType: 'application/octet-stream' };
  }
  if (typeof Blob !== 'undefined' && content instanceof Blob) {
    return { body: content, contentType: content.type || 'application/octet-stream' };
  }
  if (typeof content === 'string') {
    return { body: content, contentType: 'text/plain' };
  }
  return { body: JSON.stringify(content), contentType: 'application/json' };
}
