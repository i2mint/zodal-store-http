/**
 * Tests for `createHttpProvider` — REST CRUD, query conventions, client-side fallback,
 * server-side delegation, and error reporting.
 *
 * Every test injects a mock `fetch`. The mock backend is dumb by default (it ignores
 * query params), so the fallback tests are non-vacuous: they assert BOTH that the result
 * is correct AND that the query string carried no filter/sort/page — i.e. the provider,
 * not the server, did the work. The delegation tests assert the mirror image.
 */

import { describe, it, expect } from 'vitest';
import { createHttpProvider } from '../src/provider.js';
import { HttpError } from '../src/http.js';
import { createMockBackend, type Item } from './mock-backend.js';

const SEED: Item[] = [
  { id: 'a', name: 'Zebra', priority: 1 },
  { id: 'b', name: 'Alpha', priority: 3 },
  { id: 'c', name: 'Mango', priority: 5 },
];

function makeProvider(backend: ReturnType<typeof createMockBackend>, overrides = {}) {
  return createHttpProvider<Item>({
    baseUrl: '/api/items',
    fetch: backend.fetch,
    ...overrides,
  });
}

describe('createHttpProvider — CRUD', () => {
  it('creates via POST and round-trips via GET', async () => {
    const backend = createMockBackend();
    const provider = makeProvider(backend);

    const created = await provider.create({ name: 'New', priority: 2 });
    expect(created.id).toBeTruthy();
    expect(backend.calls[0].method).toBe('POST');
    expect(backend.calls[0].url).toBe('/api/items');
    expect(JSON.parse(backend.calls[0].body!)).toEqual({ name: 'New', priority: 2 });

    const fetched = await provider.getOne(created.id);
    expect(fetched).toEqual({ id: created.id, name: 'New', priority: 2 });
    expect(backend.last().method).toBe('GET');
    expect(backend.last().url).toBe(`/api/items/${created.id}`);
  });

  it('updates via PATCH to /{id}', async () => {
    const backend = createMockBackend({ seed: SEED });
    const provider = makeProvider(backend);

    const updated = await provider.update('b', { priority: 9 });
    expect(updated).toEqual({ id: 'b', name: 'Alpha', priority: 9 });
    expect(backend.last().method).toBe('PATCH');
    expect(backend.last().url).toBe('/api/items/b');
    expect(backend.store.get('b')!.priority).toBe(9);
  });

  it('deletes via DELETE to /{id}', async () => {
    const backend = createMockBackend({ seed: SEED });
    const provider = makeProvider(backend);

    await provider.delete('a');
    expect(backend.last().method).toBe('DELETE');
    expect(backend.store.has('a')).toBe(false);
    await expect(provider.getOne('a')).rejects.toThrow(HttpError);
  });

  it('updateMany maps over the singles', async () => {
    const backend = createMockBackend({ seed: SEED });
    const provider = makeProvider(backend);

    const results = await provider.updateMany(['a', 'c'], { priority: 7 });
    expect(results.map((r) => r.id).sort()).toEqual(['a', 'c']);
    expect(backend.store.get('a')!.priority).toBe(7);
    expect(backend.store.get('c')!.priority).toBe(7);
    expect(backend.store.get('b')!.priority).toBe(3);
    expect(backend.calls.filter((c) => c.method === 'PATCH')).toHaveLength(2);
  });

  it('deleteMany maps over the singles', async () => {
    const backend = createMockBackend({ seed: SEED });
    const provider = makeProvider(backend);

    await provider.deleteMany(['a', 'b']);
    expect([...backend.store.keys()]).toEqual(['c']);
  });

  it('percent-encodes ids in the URL', async () => {
    const backend = createMockBackend({ seed: [{ id: 'osoto gari/1', name: 'x', priority: 1 }] });
    const provider = makeProvider(backend);

    const item = await provider.getOne('osoto gari/1');
    expect(item.name).toBe('x');
    expect(backend.last().url).toBe('/api/items/osoto%20gari%2F1');
  });

  it('falls back to the sent payload when the server answers 204 on update', async () => {
    const backend = createMockBackend({ seed: SEED, noContentOnWrite: true });
    const provider = makeProvider(backend);

    const updated = await provider.update('b', { priority: 9 });
    expect(updated).toEqual({ id: 'b', priority: 9 });
  });

  it('throws an informative error when create gets an empty body', async () => {
    const backend = createMockBackend({ noContentOnWrite: true });
    const provider = makeProvider(backend);

    await expect(provider.create({ name: 'x' })).rejects.toThrow(/empty body/i);
  });
});

describe('createHttpProvider — list shapes', () => {
  it('accepts a bare array', async () => {
    const backend = createMockBackend({ seed: SEED, shape: 'array' });
    const { data, total } = await makeProvider(backend).getList({});
    expect(data.map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(total).toBe(3);
  });

  it('accepts a { data, total } envelope', async () => {
    const backend = createMockBackend({ seed: SEED, shape: 'envelope' });
    const { data, total } = await makeProvider(backend).getList({});
    expect(data).toHaveLength(3);
    expect(total).toBe(3);
  });

  it('honors X-Total-Count on a bare array when the server paginates', async () => {
    const backend = createMockBackend({
      seed: SEED,
      shape: 'array',
      totalHeader: 120,
      honor: { pagination: true },
    });
    const provider = makeProvider(backend, {
      capabilities: { serverPagination: true },
    });

    const { data, total } = await provider.getList({ pagination: { page: 1, pageSize: 2 } });
    expect(data).toHaveLength(2);
    expect(total).toBe(120);
  });

  it('uses a custom parseList for a foreign envelope', async () => {
    const backend = createMockBackend({ seed: SEED, shape: 'custom' });
    const provider = makeProvider(backend, {
      parseList: async (response: Response) => {
        const body = (await response.json()) as { items: Item[]; count: number };
        return { data: body.items, total: body.count };
      },
    });

    const { data, total } = await provider.getList({});
    expect(data.map((d) => d.name)).toEqual(['Zebra', 'Alpha', 'Mango']);
    expect(total).toBe(3);
  });

  it('throws an informative error on an unrecognized list shape', async () => {
    const backend = createMockBackend({ seed: SEED, shape: 'custom' });
    await expect(makeProvider(backend).getList({})).rejects.toThrow(/Unrecognized list response/);
  });
});

describe('createHttpProvider — client-side fallback (the default)', () => {
  it('filters client-side and sends NO filter param', async () => {
    const backend = createMockBackend({ seed: SEED });
    const provider = makeProvider(backend);

    const { data, total } = await provider.getList({
      filter: { field: 'priority', operator: 'gte', value: 3 },
    });

    expect(data.map((d) => d.id)).toEqual(['b', 'c']);
    expect(total).toBe(2);
    // Non-vacuous: the server was never told about the filter, so the provider did it.
    expect(backend.last().url).toBe('/api/items');
    expect(backend.last().url).not.toContain('filter');
  });

  it('evaluates compound filters (and/or/not) via filterToFunction', async () => {
    const backend = createMockBackend({ seed: SEED });
    const provider = makeProvider(backend);

    const { data } = await provider.getList({
      filter: {
        and: [
          { field: 'priority', operator: 'gte', value: 2 },
          { not: { field: 'name', operator: 'eq', value: 'Mango' } },
        ],
      },
    });
    expect(data.map((d) => d.id)).toEqual(['b']);
  });

  it('searches client-side over string fields', async () => {
    const backend = createMockBackend({ seed: SEED });
    const provider = makeProvider(backend);

    const { data } = await provider.getList({ search: 'ang' });
    expect(data.map((d) => d.id)).toEqual(['c']);
    expect(backend.last().url).not.toContain('q=');
  });

  it('restricts client-side search to searchFields', async () => {
    const backend = createMockBackend({ seed: SEED });
    const provider = makeProvider(backend, { searchFields: ['id'] });

    const { data } = await provider.getList({ search: 'ang' });
    expect(data).toHaveLength(0);
  });

  it('sorts client-side', async () => {
    const backend = createMockBackend({ seed: SEED });
    const { data } = await makeProvider(backend).getList({
      sort: [{ id: 'name', desc: false }],
    });
    expect(data.map((d) => d.name)).toEqual(['Alpha', 'Mango', 'Zebra']);
    expect(backend.last().url).not.toContain('sort');
  });

  it('paginates client-side, reporting the pre-pagination total', async () => {
    const backend = createMockBackend({ seed: SEED });
    const { data, total } = await makeProvider(backend).getList({
      sort: [{ id: 'name', desc: false }],
      pagination: { page: 2, pageSize: 2 },
    });
    expect(data.map((d) => d.name)).toEqual(['Zebra']);
    expect(total).toBe(3);
    expect(backend.last().url).not.toContain('page');
  });

  it('combines a client-side filter with client-side pagination', async () => {
    const backend = createMockBackend({ seed: SEED });
    const { data, total } = await makeProvider(backend).getList({
      filter: { field: 'priority', operator: 'gte', value: 3 },
      pagination: { page: 1, pageSize: 1 },
    });
    expect(data.map((d) => d.id)).toEqual(['b']);
    expect(total).toBe(2); // total is the filtered count, not the page size
  });
});

describe('createHttpProvider — server-side delegation', () => {
  it('sends the default query convention and does NOT re-filter client-side', async () => {
    // The backend deliberately answers with an item that does NOT match the filter.
    // If the provider filtered client-side too, it would be dropped.
    const backend = createMockBackend({ seed: SEED, honor: {} });
    const provider = makeProvider(backend, { capabilities: { serverFilter: true } });

    const { data } = await provider.getList({
      filter: { field: 'priority', operator: 'gte', value: 3 },
    });

    expect(backend.last().url).toBe(
      `/api/items?filter=${encodeURIComponent('{"field":"priority","operator":"gte","value":3}')}`,
    );
    // Server said "here's everything" — provider trusts it, proving no double-filtering.
    expect(data.map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });

  it('emits sort as a comma-separated list with - for descending', async () => {
    const backend = createMockBackend({ seed: SEED, honor: { sort: true } });
    const provider = makeProvider(backend, { capabilities: { serverSort: true } });

    const { data } = await provider.getList({
      sort: [{ id: 'name', desc: true }, { id: 'priority', desc: false }],
    });
    expect(backend.last().url).toContain('sort=-name%2Cpriority');
    expect(data.map((d) => d.name)).toEqual(['Zebra', 'Mango', 'Alpha']);
  });

  it('emits page/pageSize when pagination is delegated', async () => {
    const backend = createMockBackend({ seed: SEED, honor: { pagination: true } });
    const provider = makeProvider(backend, { capabilities: { serverPagination: true } });

    const { data } = await provider.getList({ pagination: { page: 2, pageSize: 2 } });
    expect(backend.last().url).toContain('page=2');
    expect(backend.last().url).toContain('pageSize=2');
    expect(data.map((d) => d.id)).toEqual(['c']);
  });

  it('delegates a field-scoped serverFilter only when every filtered field is covered', async () => {
    const backend = createMockBackend({ seed: SEED, honor: { filter: true } });
    const provider = makeProvider(backend, { capabilities: { serverFilter: ['priority'] } });

    // 'priority' is covered → delegated
    await provider.getList({ filter: { field: 'priority', operator: 'gte', value: 3 } });
    expect(backend.last().url).toContain('filter=');

    // 'name' is not → client-side fallback, no filter param
    const { data } = await provider.getList({
      filter: { field: 'name', operator: 'eq', value: 'Alpha' },
    });
    expect(backend.last().url).toBe('/api/items');
    expect(data.map((d) => d.id)).toEqual(['b']);
  });

  it('uses a custom toQuery when the backend spells things differently', async () => {
    const backend = createMockBackend({ seed: SEED });
    const provider = makeProvider(backend, {
      capabilities: { serverPagination: true },
      toQuery: (params: { pagination?: { page: number; pageSize: number } }) => {
        const q = new URLSearchParams();
        if (params.pagination) {
          q.set('_page', String(params.pagination.page));
          q.set('_limit', String(params.pagination.pageSize));
        }
        return q;
      },
    });

    await provider.getList({ pagination: { page: 3, pageSize: 10 } });
    expect(backend.last().url).toBe('/api/items?_page=3&_limit=10');
  });
});

describe('createHttpProvider — errors and options', () => {
  it('throws HttpError with status, method and url on a non-2xx', async () => {
    const backend = createMockBackend({ seed: SEED });
    const provider = makeProvider(backend);

    const error = await provider.getOne('nope').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    const httpError = error as HttpError;
    expect(httpError.status).toBe(404);
    expect(httpError.method).toBe('GET');
    expect(httpError.url).toBe('/api/items/nope');
    expect(httpError.message).toContain('404');
    expect(httpError.message).toContain('/api/items/nope');
    expect(httpError.body).toContain('not found');
  });

  it('applies `init` (credentials + headers) to every request', async () => {
    const backend = createMockBackend({ seed: SEED });
    const provider = makeProvider(backend, {
      init: { credentials: 'include', headers: { Authorization: 'Bearer t0ken' } },
    });

    await provider.getList({});
    await provider.update('a', { priority: 2 });

    for (const call of backend.calls) {
      expect(call.credentials).toBe('include');
      expect(call.headers.authorization).toBe('Bearer t0ken');
    }
    // ...and the per-request Content-Type still lands on the write.
    expect(backend.last().headers['content-type']).toBe('application/json');
  });

  it('uses idField when synthesizing the item a 204 write did not return', async () => {
    const backend = createMockBackend({ seed: SEED, noContentOnWrite: true });
    const provider = makeProvider(backend, { idField: 'slug' });

    const updated = await provider.update('b', { priority: 4 });
    expect(backend.last().url).toBe('/api/items/b');
    expect(updated as unknown as Record<string, unknown>).toEqual({ slug: 'b', priority: 4 });
  });

  it('reports capabilities honestly — client-side by default, merged when overridden', async () => {
    const backend = createMockBackend();

    const dumb = makeProvider(backend).getCapabilities!();
    expect(dumb.serverFilter).toBe(false);
    expect(dumb.serverSort).toBe(false);
    expect(dumb.serverSearch).toBe(false);
    expect(dumb.serverPagination).toBe(false);
    expect(dumb.canCreate).toBe(true);

    const smart = makeProvider(backend, {
      capabilities: { serverFilter: true, serverPagination: true, canUpsert: true },
    }).getCapabilities!();
    expect(smart.serverFilter).toBe(true);
    expect(smart.serverPagination).toBe(true);
    expect(smart.canUpsert).toBe(true);
    expect(smart.serverSearch).toBe(false); // untouched defaults survive the merge
  });
});
