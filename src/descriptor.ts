/**
 * Provider descriptors for this package: each HTTP provider described as data, so
 * an app, a playground or an agent can list it in a backend menu, render its
 * options, check it can run here, and create it by name with
 * `createFromDescriptor` from `@zodal/store/descriptor`.
 *
 * - `descriptor` (`http`): REST CRUD against your own API (`createHttpProvider`).
 * - `blobDescriptor` (`httpBlob`): content addressed by URL (`createHttpBlobProvider`),
 *   the content side of a bifurcation.
 *
 * **Secrets.** `init.headers` is a secret as a whole: it is where an
 * `Authorization` (or `X-Api-Key`, or a session cookie) goes, and a header's name
 * does not always say so. `init.credentials` is a fetch *mode* (`'include'`...),
 * not a credential, and is declared public. Headers are plain data here (an object
 * or `[name, value]` pairs); a `Headers` instance is refused by validation, so pass
 * it to the factory directly.
 *
 * **Live options** (supplied in code, never shared or exported): `fetch`,
 * `toQuery`, `parseList`, `urlFor`, `contentTypeFor`, `init.signal`.
 *
 * `init` is declared field by field for forms, and otherwise passed through as
 * given (runtime-specific `RequestInit` extensions such as undici's `dispatcher`
 * are kept), exactly as the factories pass it to `fetch`.
 *
 * `supports()` checks for a global `fetch`. A runtime without one can still use
 * these providers by passing `fetch` in the options and creating them directly.
 * `create` imports its provider module lazily.
 */

import { z } from 'zod';
import { defineProviderDescriptor } from '@zodal/store/descriptor';
import type { FilterOperator } from '@zodal/core';
import type { GetListParams, GetListResult } from '@zodal/store';
import type { FetchLike } from './http.js';
import { CLIENT_SIDE_DEFAULTS } from './capabilities.js';

const MODULE = '@zodal/store-http';

/** Every `FilterOperator`; the type check below fails if `@zodal/core` adds one. */
const FILTER_OPERATORS = [
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte',
  'contains', 'startsWith', 'endsWith',
  'in', 'notIn',
  'arrayContains', 'arrayContainsAny',
  'isNull', 'isNotNull',
] as const satisfies readonly FilterOperator[];
type MissingOperator = Exclude<FilterOperator, (typeof FILTER_OPERATORS)[number]>;
const _everyOperatorListed: [MissingOperator] extends [never] ? true : MissingOperator = true;
void _everyOperatorListed;

const isFunction = (v: unknown): boolean => typeof v === 'function';
const fn = <F>(description: string) => z.custom<F>(isFunction).optional().meta({ description });

const hasGlobalFetch = (): boolean => typeof (globalThis as { fetch?: unknown }).fetch === 'function';

const baseUrl = z.string().min(1).meta({ description: 'Endpoint base URL; relative URLs (same origin) are fine.' });
const idField = z.string().min(1).optional().meta({ description: "Field used as the unique identifier. Default: 'id'." });
const fetchOption = fn<FetchLike>('fetch implementation. Default: globalThis.fetch. Supply in code (mock, retries, auth refresh).');

/** The `RequestInit` applied to every request. */
const init = z
  .object({
    headers: z
      .union([z.record(z.string(), z.string()), z.array(z.tuple([z.string(), z.string()]))])
      .optional()
      .meta({ sensitivity: 'secret', description: 'Headers sent with every request (an object or [name, value] pairs); may carry Authorization.' }),
    credentials: z
      .enum(['omit', 'same-origin', 'include'])
      .optional()
      .meta({ sensitivity: 'public', description: "Cookie mode: 'include' for a cookie-authenticated backend." }),
    mode: z.enum(['cors', 'no-cors', 'same-origin', 'navigate']).optional(),
    cache: z.enum(['default', 'no-store', 'reload', 'no-cache', 'force-cache', 'only-if-cached']).optional(),
    redirect: z.enum(['follow', 'error', 'manual']).optional(),
    referrer: z.string().optional(),
    referrerPolicy: z
      .enum([
        '', 'no-referrer', 'no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin',
        'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'unsafe-url',
      ])
      .optional(),
    integrity: z.string().optional(),
    keepalive: z.boolean().optional(),
    priority: z.enum(['high', 'low', 'auto']).optional(),
    signal: z.custom<AbortSignal | null>().optional().meta({ description: 'AbortSignal for every request; supply in code.' }),
  })
  .loose()
  .optional()
  .meta({ description: 'RequestInit applied to every request.' });

/** `true` = every field, a list = only those fields, `false` = none. */
const fieldScope = z.union([z.boolean(), z.array(z.string())]);

/** What the server really does (`HttpProviderOptions.capabilities`). */
const serverCapabilities = z
  .object({
    canCreate: z.boolean(),
    canUpdate: z.boolean(),
    canDelete: z.boolean(),
    canBulkUpdate: z.boolean(),
    canBulkDelete: z.boolean(),
    canUpsert: z.boolean(),
    serverSort: fieldScope,
    serverFilter: fieldScope,
    serverSearch: z.boolean(),
    serverPagination: z.boolean(),
    filterOperators: z.record(z.string(), z.array(z.enum(FILTER_OPERATORS))),
    paginationStyle: z.enum(['offset', 'cursor']),
    realtime: z.boolean(),
    bifurcated: z.boolean(),
    contentFields: z.array(z.string()),
  })
  .partial()
  .optional()
  .meta({ description: 'What the server does (merged over all-client-side); the rest is done in the client.' });

/** REST CRUD against your own API (`createHttpProvider`). */
export const descriptor = defineProviderDescriptor({
  name: 'http',
  label: 'HTTP / REST API',
  description: 'Items behind a REST endpoint (GET/POST/PATCH/DELETE), over fetch.',
  source: { module: MODULE, export: 'descriptor' },
  runtime: 'any',
  supports: hasGlobalFetch,
  options: z.object({
    baseUrl,
    idField,
    fetch: fetchOption,
    init,
    searchFields: z.array(z.string()).optional().meta({ description: 'Fields searched by the client-side search fallback. Default: every string field.' }),
    toQuery: fn<(params: GetListParams) => URLSearchParams>('Encode delegated list params as a query string; supply in code.'),
    parseList: fn<(response: Response) => GetListResult<any> | Promise<GetListResult<any>>>('Normalize a list response to { data, total }; supply in code.'),
    capabilities: serverCapabilities,
  }),
  capabilities: (o) => ({ ...CLIENT_SIDE_DEFAULTS, ...o.capabilities }),
  create: async (o) => (await import('./provider.js')).createHttpProvider(o),
});

/** Content addressed by URL (`createHttpBlobProvider`): the content side of a bifurcation. */
export const blobDescriptor = defineProviderDescriptor({
  name: 'httpBlob',
  label: 'HTTP (content by URL)',
  description: 'Content fields served (and accepted) by your backend over HTTP, addressed by URL; pair it with a metadata provider.',
  source: { module: MODULE, export: 'blobDescriptor' },
  runtime: 'any',
  supports: hasGlobalFetch,
  options: z.object({
    baseUrl,
    contentFields: z.array(z.string()).meta({ description: 'Fields served as content.' }),
    idField,
    fetch: fetchOption,
    init,
    publicBaseUrl: z.string().min(1).optional().meta({ description: 'Serve reads from here (a CDN, a public bucket); writes still go to baseUrl.' }),
    urlFor: fn<(id: string, field: string) => string | Promise<string>>('Resolve a read URL (may presign); supply in code. Wins over publicBaseUrl.'),
    writeMethod: z.enum(['PUT', 'POST']).optional().meta({ description: "HTTP method that writes content. Default: 'PUT'." }),
    contentTypeFor: fn<(id: string, field: string, content: unknown) => string | undefined>('Override the Content-Type of a write; supply in code.'),
  }),
  capabilities: (o) => ({
    canCreate: true, canUpdate: true, canDelete: true,
    canBulkUpdate: true, canBulkDelete: true, canUpsert: false,
    serverSort: false, serverFilter: false, serverSearch: false, serverPagination: false,
    bifurcated: false,
    contentFields: o.contentFields,
  }),
  create: async (o) => (await import('./blob-provider.js')).createHttpBlobProvider(o),
});
