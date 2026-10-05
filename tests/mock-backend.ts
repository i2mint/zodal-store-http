/**
 * A mock REST backend, injected as the `fetch` option.
 *
 * Deliberately *dumb* by default — it ignores query parameters entirely — so that any
 * test which observes filtering/sorting/pagination is proving the provider's client-side
 * fallback did the work, not the server. Server-side behaviour is opt-in per test via the
 * `honor` flag, which lets the delegation tests prove the opposite. An honored step is
 * evaluated with `@zodal/store`'s `applyQuery` (the full filter language, multi-key sort),
 * standing in for a real server, so the contract kit can run in a delegating mode too.
 *
 * A `POST` with an id that already exists answers `409 Conflict`, as a REST server should.
 */

import { applyQuery } from '@zodal/store';
import type { SortingState } from '@zodal/core';
import type { FetchLike } from '../src/http.js';

export interface Item extends Record<string, unknown> {
  id: string;
  name: string;
  priority: number;
}

export interface RecordedCall {
  method: string;
  url: string;
  body: string | undefined;
  headers: Record<string, string>;
  credentials: string | undefined;
}

export interface MockBackend {
  fetch: FetchLike;
  store: Map<string, Item>;
  calls: RecordedCall[];
  /** The last request, for terse assertions. */
  last(): RecordedCall;
  /** Every URL requested, for asserting what was (and was NOT) sent. */
  urls(): string[];
}

export interface MockBackendOptions {
  /** Items to seed the collection with. */
  seed?: Item[];
  /** Collection path this backend answers on. Default: '/api/items'. */
  basePath?: string;
  /** Response envelope. 'array' (bare) | 'envelope' ({data,total}) | 'custom' ({items,count}). */
  shape?: 'array' | 'envelope' | 'custom';
  /** Emit an X-Total-Count header on list responses. */
  totalHeader?: number;
  /** Honor server-side query params — off by default, so the dumb path is the default. */
  honor?: { filter?: boolean; pagination?: boolean; sort?: boolean; search?: boolean };
  /** Answer writes with 204 No Content instead of the resource. */
  noContentOnWrite?: boolean;
}

export function createMockBackend(options: MockBackendOptions = {}): MockBackend {
  const basePath = options.basePath ?? '/api/items';
  const shape = options.shape ?? 'array';
  const honor = options.honor ?? {};
  const store = new Map<string, Item>();
  const calls: RecordedCall[] = [];
  let nextId = 1;

  for (const item of options.seed ?? []) store.set(item.id, { ...item });

  function json(payload: unknown, init: ResponseInit = {}): Response {
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    if (options.totalHeader !== undefined) {
      headers.set('X-Total-Count', String(options.totalHeader));
    }
    return new Response(JSON.stringify(payload), { status: 200, ...init, headers });
  }

  /** `total` is the pre-pagination count (every item, unless a filter/search was honored). */
  function listBody(items: Item[], total: number): unknown {
    if (shape === 'envelope') return { data: items, total };
    if (shape === 'custom') return { items, count: total };
    return items;
  }

  /** Decode the default `toQuery` convention (page/pageSize, sort, q, filter). */
  function parseQuery(params: URLSearchParams) {
    const filter = params.get('filter');
    const sort = params.get('sort');
    const page = params.get('page');
    return {
      filter: filter ? JSON.parse(filter) : undefined,
      sort: sort
        ? sort.split(',').map((key): SortingState =>
            key.startsWith('-') ? { id: key.slice(1), desc: true } : { id: key, desc: false },
          )
        : undefined,
      search: params.get('q') ?? undefined,
      pagination: page
        ? { page: Number(page), pageSize: Number(params.get('pageSize') ?? store.size) }
        : undefined,
    };
  }

  const fetchImpl: FetchLike = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = input;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({
      method,
      url,
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers,
      credentials: init?.credentials,
    });

    // Parse the URL against a dummy origin so relative paths work.
    const parsed = new URL(url, 'http://backend.test');
    const path = parsed.pathname;

    if (path === basePath && method === 'GET') {
      const { data, total } = applyQuery([...store.values()], parseQuery(parsed.searchParams), {
        skip: {
          filter: !honor.filter,
          sort: !honor.sort,
          search: !honor.search,
          paginate: !honor.pagination,
        },
      });
      return json(listBody(data, total));
    }

    if (path === basePath && method === 'POST') {
      const payload = JSON.parse(String(init?.body ?? '{}')) as Partial<Item>;
      if (payload.id !== undefined && store.has(payload.id)) {
        return json({ error: 'already exists', id: payload.id }, { status: 409 });
      }
      const id = payload.id ?? `item-${nextId++}`;
      const created = { ...payload, id } as Item;
      store.set(id, created);
      if (options.noContentOnWrite) return new Response(null, { status: 204 });
      return json(created, { status: 201 });
    }

    if (path.startsWith(`${basePath}/`)) {
      const id = decodeURIComponent(path.slice(basePath.length + 1));
      const existing = store.get(id);

      if (method === 'GET') {
        if (!existing) return json({ error: 'not found', id }, { status: 404 });
        return json(existing);
      }
      if (method === 'PATCH') {
        if (!existing) return json({ error: 'not found', id }, { status: 404 });
        const patch = JSON.parse(String(init?.body ?? '{}')) as Partial<Item>;
        const updated = { ...existing, ...patch, id };
        store.set(id, updated);
        if (options.noContentOnWrite) return new Response(null, { status: 204 });
        return json(updated);
      }
      if (method === 'DELETE') {
        if (!existing) return json({ error: 'not found', id }, { status: 404 });
        store.delete(id);
        return new Response(null, { status: 204 });
      }
    }

    return json({ error: 'no route', path, method }, { status: 405 });
  };

  return {
    fetch: fetchImpl,
    store,
    calls,
    last: () => calls[calls.length - 1],
    urls: () => calls.map((c) => c.url),
  };
}

/**
 * A mock blob backend: an in-memory byte store keyed by URL path.
 *
 * It answers on *any* path, recording what it was asked for — which is what lets the
 * tests assert that reads went to the CDN while writes went to the backend.
 */
async function bodyToBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body == null) return new Uint8Array();
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }
  throw new Error(`mock backend cannot read body of type ${typeof body}`);
}

export function createMockBlobBackend(seed: Record<string, Uint8Array | string> = {}) {
  const blobs = new Map<string, Uint8Array>();
  const calls: RecordedCall[] = [];

  for (const [key, value] of Object.entries(seed)) {
    blobs.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value);
  }

  const fetchImpl: FetchLike = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({
      method,
      url: input,
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers,
      credentials: init?.credentials,
    });

    if (method === 'GET') {
      const bytes = blobs.get(input);
      if (!bytes) return new Response('missing blob', { status: 404, statusText: 'Not Found' });
      return new Response(bytes, { status: 200 });
    }
    if (method === 'PUT' || method === 'POST') {
      blobs.set(input, await bodyToBytes(init?.body));
      return new Response(null, { status: 204 });
    }
    if (method === 'DELETE') {
      if (!blobs.delete(input)) return new Response('missing blob', { status: 404 });
      return new Response(null, { status: 204 });
    }
    return new Response('method not allowed', { status: 405 });
  };

  return {
    fetch: fetchImpl,
    blobs,
    calls,
    urls: () => calls.map((c) => c.url),
    callsOfMethod: (method: string) => calls.filter((c) => c.method === method),
  };
}
