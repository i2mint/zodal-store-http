/**
 * HTTP DataProvider for zodal — full REST CRUD against your own API server.
 *
 * This is how a *browser* talks to a backend through the zodal `DataProvider` interface:
 *
 *   getList  → GET    {baseUrl}
 *   getOne   → GET    {baseUrl}/{id}
 *   create   → POST   {baseUrl}
 *   update   → PATCH  {baseUrl}/{id}
 *   delete   → DELETE {baseUrl}/{id}
 *
 * REST conventions vary wildly, so nothing here is rigid: the query encoding
 * (`toQuery`) and the list-response shape (`parseList`) are both overridable, and the
 * defaults are documented below rather than guessed at.
 *
 * **Server capability is opt-in.** By default this provider assumes your endpoint just
 * returns the collection, and it evaluates filter / search / sort / pagination
 * client-side (filtering via `filterToFunction()` from `@zodal/store` — the same
 * evaluator the in-memory provider uses, not a re-implementation). Tell it what the
 * server really does with `capabilities`, and it delegates exactly that much and no more —
 * which is also what `getCapabilities()` reports, so the UI layer is never lied to.
 */

import type { FilterExpression, SortingState } from '@zodal/core';
import type {
  DataProvider,
  GetListParams,
  GetListResult,
  ProviderCapabilities,
} from '@zodal/store';
import { filterToFunction } from '@zodal/store';
import {
  httpRequest,
  joinUrl,
  readJson,
  resolveFetch,
  withQuery,
  type FetchLike,
} from './http.js';

/** What a list endpoint may hand back, before `parseList` normalizes it. */
type ListPayload<T> = T[] | { data: T[]; total?: number };

export interface HttpProviderOptions<T> {
  /** Collection endpoint, e.g. `/api/kodokan/clips` or `https://api.example.com/projects`. */
  baseUrl: string;
  /** Field name used as the unique identifier. Default: `'id'`. */
  idField?: string;
  /**
   * `fetch` implementation. Default: `globalThis.fetch`.
   * Inject to mock in tests, or to wrap with retries / auth-token refresh / tracing.
   */
  fetch?: FetchLike;
  /**
   * Base `RequestInit` applied to every request — headers, `credentials`, `mode`, `signal`.
   * A cookie-authenticated backend (enlace, Django, Rails) wants `credentials: 'include'`.
   */
  init?: RequestInit;
  /** Fields to include in the client-side text-search fallback. Default: all string-valued fields. */
  searchFields?: string[];
  /**
   * Encode the `getList` params the server has been declared capable of handling
   * (see `capabilities`) as a query string.
   *
   * The default emits — and *only* emits — parameters for the delegated concerns:
   *
   * | Concern    | Emitted as                                                       |
   * |------------|------------------------------------------------------------------|
   * | pagination | `page=2&pageSize=25` (1-based page)                               |
   * | sort       | `sort=-createdAt,name` (`-` prefix = descending, comma-separated) |
   * | search     | `q=throw`                                                         |
   * | filter     | `filter=<JSON-encoded FilterExpression>`                          |
   *
   * If your backend spells these differently (`_page`/`_limit`, `ordering`, `search`,
   * RSQL, whatever), pass your own `toQuery` — it is the whole extension point, and it
   * only ever receives params the server actually handles.
   */
  toQuery?: (params: GetListParams) => URLSearchParams;
  /**
   * Normalize the list response into `{ data, total }`.
   *
   * The default accepts either shape a REST endpoint usually returns:
   * - a **bare array** `[{...}, {...}]` — `total` comes from the `X-Total-Count` header
   *   when present, else from the array length;
   * - an **envelope** `{ data: [...], total: 123 }` — `total` falls back to `data.length`.
   *
   * Anything else (`{ items, count }`, JSON:API, a cursor envelope) is a one-liner here.
   */
  parseList?: (response: Response) => GetListResult<T> | Promise<GetListResult<T>>;
  /**
   * What the *server* does, so the provider can stop doing it client-side.
   *
   * Merged over the defaults, which assume a dumb endpoint: `serverSort`, `serverFilter`,
   * `serverSearch` and `serverPagination` all `false`. Set `serverFilter: true` and the
   * filter goes into the query string instead of being applied in JS; `serverFilter:
   * ['status', 'tag']` delegates only when every field in the filter is in that list, and
   * falls back to client-side otherwise.
   *
   * Caveat, and it is a real one: if you set `serverPagination: true` you should delegate
   * whatever else your app uses too. The provider cannot correctly filter or sort
   * client-side over a page the server already sliced — it only sees that page.
   */
  capabilities?: Partial<ProviderCapabilities>;
}

const CLIENT_SIDE_DEFAULTS: ProviderCapabilities = {
  canCreate: true,
  canUpdate: true,
  canDelete: true,
  // `updateMany`/`deleteMany` are N requests, not a bulk endpoint — but they work,
  // so the UI is right to offer bulk actions.
  canBulkUpdate: true,
  canBulkDelete: true,
  canUpsert: false,
  serverSort: false,
  serverFilter: false,
  serverSearch: false,
  serverPagination: false,
};

/** Collect every field named anywhere in a (possibly compound) filter expression. */
function _filterFields(filter: FilterExpression, into: Set<string> = new Set()): Set<string> {
  if ('and' in filter) {
    for (const sub of filter.and) _filterFields(sub, into);
  } else if ('or' in filter) {
    for (const sub of filter.or) _filterFields(sub, into);
  } else if ('not' in filter) {
    _filterFields(filter.not, into);
  } else {
    into.add(filter.field);
  }
  return into;
}

/**
 * Does a `boolean | string[]` capability cover these fields?
 * `true` = all fields; a list = only those fields; `false` = none.
 */
function _delegates(capability: boolean | string[], fields: Iterable<string>): boolean {
  if (capability === true) return true;
  if (Array.isArray(capability)) {
    return [...fields].every((field) => capability.includes(field));
  }
  return false;
}

/** The default query convention. See `HttpProviderOptions.toQuery` for the emitted shape. */
function _defaultToQuery(params: GetListParams): URLSearchParams {
  const query = new URLSearchParams();
  if (params.pagination) {
    query.set('page', String(params.pagination.page));
    query.set('pageSize', String(params.pagination.pageSize));
  }
  if (params.sort?.length) {
    query.set('sort', params.sort.map((s) => (s.desc ? `-${s.id}` : s.id)).join(','));
  }
  if (params.search) query.set('q', params.search);
  if (params.filter) query.set('filter', JSON.stringify(params.filter));
  return query;
}

/** The default list-response convention. See `HttpProviderOptions.parseList`. */
async function _defaultParseList<T>(response: Response): Promise<GetListResult<T>> {
  const payload = await readJson<ListPayload<T>>(response);
  const headerTotal = Number(response.headers.get('X-Total-Count'));

  if (Array.isArray(payload)) {
    return {
      data: payload,
      total: Number.isFinite(headerTotal) && headerTotal >= 0 ? headerTotal : payload.length,
    };
  }
  if (payload && Array.isArray(payload.data)) {
    return { data: payload.data, total: payload.total ?? payload.data.length };
  }
  throw new Error(
    `Unrecognized list response from ${response.url || 'the server'}: expected an array or ` +
      `{ data, total }. Pass a \`parseList\` option to describe your API's shape.`,
  );
}

function _compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  return a < b ? -1 : 1;
}

function _sortItems<T>(items: T[], sort: SortingState[]): T[] {
  return [...items].sort((a, b) => {
    for (const s of sort) {
      const cmp = _compare((a as Record<string, unknown>)[s.id], (b as Record<string, unknown>)[s.id]);
      if (cmp !== 0) return s.desc ? -cmp : cmp;
    }
    return 0;
  });
}

export function createHttpProvider<T extends Record<string, any>>(
  options: HttpProviderOptions<T>,
): DataProvider<T> {
  const { baseUrl, init, searchFields } = options;
  const idField = options.idField ?? 'id';
  const doFetch = resolveFetch(options.fetch);
  const toQuery = options.toQuery ?? _defaultToQuery;
  const parseList = options.parseList ?? _defaultParseList<T>;
  const capabilities: ProviderCapabilities = { ...CLIENT_SIDE_DEFAULTS, ...options.capabilities };

  const jsonHeaders = { 'Content-Type': 'application/json' };

  function itemUrl(id: string): string {
    return joinUrl(baseUrl, id);
  }

  function matchesSearch(item: T, search: string): boolean {
    const needle = search.toLowerCase();
    const fields =
      searchFields ?? Object.keys(item).filter((k) => typeof item[k] === 'string');
    return fields.some((field) => {
      const value = item[field];
      return typeof value === 'string' && value.toLowerCase().includes(needle);
    });
  }

  /** Split `getList` params into "the server handles this" and "we handle this". */
  function planQuery(params: GetListParams): { delegated: GetListParams; local: GetListParams } {
    const delegated: GetListParams = {};
    const local: GetListParams = {};

    if (params.filter) {
      const target = _delegates(capabilities.serverFilter, _filterFields(params.filter))
        ? delegated
        : local;
      target.filter = params.filter;
    }
    if (params.sort?.length) {
      const target = _delegates(capabilities.serverSort, params.sort.map((s) => s.id))
        ? delegated
        : local;
      target.sort = params.sort;
    }
    if (params.search) {
      (capabilities.serverSearch ? delegated : local).search = params.search;
    }
    if (params.pagination) {
      (capabilities.serverPagination ? delegated : local).pagination = params.pagination;
    }
    return { delegated, local };
  }

  async function getOneItem(id: string): Promise<T> {
    const response = await httpRequest(doFetch, { method: 'GET', url: itemUrl(id), init });
    const item = await readJson<T>(response);
    if (item === undefined) {
      throw new Error(`GET ${itemUrl(id)} returned an empty body; expected the item.`);
    }
    return item;
  }

  async function updateOne(id: string, data: Partial<T>): Promise<T> {
    const response = await httpRequest(doFetch, {
      method: 'PATCH',
      url: itemUrl(id),
      init,
      body: JSON.stringify(data),
      headers: jsonHeaders,
    });
    // A 204 answer is legal; then the best we can honestly report is what we sent.
    return (await readJson<T>(response)) ?? ({ ...data, [idField]: id } as unknown as T);
  }

  async function deleteOne(id: string): Promise<void> {
    await httpRequest(doFetch, { method: 'DELETE', url: itemUrl(id), init });
  }

  return {
    async getList(params: GetListParams): Promise<GetListResult<T>> {
      const { delegated, local } = planQuery(params);
      const url = withQuery(baseUrl, toQuery(delegated));
      const response = await httpRequest(doFetch, { method: 'GET', url, init });
      const parsed = await parseList(response);

      let items = parsed.data;
      if (local.filter) items = items.filter(filterToFunction<T>(local.filter));
      if (local.search) items = items.filter((item) => matchesSearch(item, local.search!));

      // Pre-pagination count. When the server paginated, only it knows the true total.
      const total = capabilities.serverPagination ? parsed.total : items.length;

      if (local.sort?.length) items = _sortItems(items, local.sort);
      if (local.pagination) {
        const { page, pageSize } = local.pagination;
        items = items.slice((page - 1) * pageSize, page * pageSize);
      }

      return { data: items, total };
    },

    getOne(id: string): Promise<T> {
      return getOneItem(id);
    },

    async create(data: Partial<T>): Promise<T> {
      const response = await httpRequest(doFetch, {
        method: 'POST',
        url: baseUrl,
        init,
        body: JSON.stringify(data),
        headers: jsonHeaders,
      });
      const created = await readJson<T>(response);
      if (created === undefined) {
        throw new Error(
          `POST ${baseUrl} returned an empty body. The provider needs the created item ` +
            `back (it cannot know the server-assigned ${idField}).`,
        );
      }
      return created;
    },

    update(id: string, data: Partial<T>): Promise<T> {
      return updateOne(id, data);
    },

    updateMany(ids: string[], data: Partial<T>): Promise<T[]> {
      return Promise.all(ids.map((id) => updateOne(id, data)));
    },

    delete(id: string): Promise<void> {
      return deleteOne(id);
    },

    async deleteMany(ids: string[]): Promise<void> {
      await Promise.all(ids.map((id) => deleteOne(id)));
    },

    getCapabilities(): ProviderCapabilities {
      return { ...capabilities };
    },
  };
}
