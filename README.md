# zodal-store-http

zodal `DataProvider` adapters for a REST backend, over `fetch`. This is how a **browser**
talks to **your own API server** through zodal.

Two providers:

- **`createHttpProvider`** — full REST CRUD (`GET`/`POST`/`PATCH`/`DELETE`). The metadata half.
- **`createHttpBlobProvider`** — content served over HTTP, with **`getUrl()`**. The blob half.

`getUrl()` is the reason this package exists. It hands you a plain URL string for
`<video src>` — so the browser keeps HTTP range requests, and the video **streams and
seeks** instead of being downloaded whole into memory (which is what `getContent()` would
do).

## Install

```bash
npm install @zodal/store-http @zodal/core @zodal/store
```

## The point: today's backend, tomorrow's bucket

435 demo clips sit behind your API server. You address them through zodal:

```typescript
import { createBifurcatedProvider } from '@zodal/store';
import { createHttpProvider, createHttpBlobProvider } from '@zodal/store-http';

const clips = createHttpBlobProvider({
  baseUrl: '/api/kodokan/clips',        // ← your server serves the bytes
  contentFields: ['clip'],
  init: { credentials: 'include' },     // cookie-authenticated backend
});

const provider = createBifurcatedProvider({
  metadataProvider: createHttpProvider({ baseUrl: '/api/kodokan/techniques' }),
  contentProvider: clips,
  contentFields: ['clip'],
});

// In your component — the ONLY line that ever touches a URL:
videoEl.src = (await provider.getUrl('osoto-gari.mp4', 'clip'))!;
//            → '/api/kodokan/clips/osoto-gari.mp4'
```

The clips outgrow the server. You move the bytes to S3 and change **one factory call**:

```typescript
import { createS3BlobProvider } from '@zodal/store-s3';

const clips = createS3BlobProvider({          // ← was createHttpBlobProvider
  client: s3,
  bucket: 'kodokan-clips',
  publicBaseUrl: 'https://cdn.example.com',
  contentFields: ['clip'],
});
```

`videoEl.src` now reads `https://cdn.example.com/osoto-gari.mp4`, straight from the CDN,
with the API server out of the byte path entirely. **No component changed.** They all went
through `getUrl()`, and `getUrl()` is the seam.

That is the whole pitch: `@zodal/store-http` is the *today* half of a migration whose
*tomorrow* half is `@zodal/store-s3`, and the app never learns which one it's on.

## `createHttpProvider` — REST CRUD

| Method | Request |
|---|---|
| `getList(params)` | `GET {baseUrl}` (+ query, see below) |
| `getOne(id)` | `GET {baseUrl}/{id}` |
| `create(data)` | `POST {baseUrl}` |
| `update(id, data)` | `PATCH {baseUrl}/{id}` |
| `updateMany(ids, data)` | N × `PATCH` |
| `delete(id)` | `DELETE {baseUrl}/{id}` |
| `deleteMany(ids)` | N × `DELETE` |

```typescript
const provider = createHttpProvider<Project>({
  baseUrl: '/api/projects',
  init: { credentials: 'include' },
});

const project = await provider.create({ name: 'New', priority: 3 });
const { data, total } = await provider.getList({
  filter: { field: 'priority', operator: 'gte', value: 2 },
  sort: [{ id: 'name', desc: false }],
  pagination: { page: 1, pageSize: 25 },
});
```

### Client-side by default, server-side when you say so

REST endpoints differ enormously in what they can do, so this provider assumes **nothing**:
by default it fetches the collection and evaluates filter / search / sort / pagination
**client-side** (filters via `filterToFunction()` from `@zodal/store` — the same evaluator
the in-memory provider uses). `getCapabilities()` reports that honestly, so the UI layer is
never lied to.

Tell it what your server actually does, and it delegates exactly that much:

```typescript
createHttpProvider({
  baseUrl: '/api/projects',
  capabilities: {
    serverFilter: true,        // or ['status', 'tag'] — only these fields
    serverSort: true,
    serverPagination: true,
  },
});
```

> **Caveat.** If you set `serverPagination: true`, delegate whatever else your app uses
> too. The provider cannot correctly filter or sort client-side over a page the server has
> already sliced — it only sees that page.

### The default query convention

When a concern is delegated, the default `toQuery` emits — and only emits — this:

| Concern | Emitted as |
|---|---|
| pagination | `page=2&pageSize=25` (1-based page) |
| sort | `sort=-createdAt,name` (`-` prefix = descending, comma-separated) |
| search | `q=throw` |
| filter | `filter=<JSON-encoded FilterExpression>` |

Your backend spells them differently? That's a normal Tuesday. Override it:

```typescript
createHttpProvider({
  baseUrl: '/api/projects',
  capabilities: { serverPagination: true },
  toQuery: (params) => {
    const q = new URLSearchParams();
    if (params.pagination) {
      q.set('_page', String(params.pagination.page));
      q.set('_limit', String(params.pagination.pageSize));
    }
    return q;
  },
});
```

### The default list-response convention

`parseList` accepts either of the two shapes a REST list endpoint usually returns:

- a **bare array**, `[{...}, {...}]` — `total` from the `X-Total-Count` header if present,
  else the array length;
- an **envelope**, `{ data: [...], total: 123 }` — `total` falls back to `data.length`.

Anything else is one option away:

```typescript
createHttpProvider({
  baseUrl: '/api/projects',
  parseList: async (response) => {
    const { items, count } = await response.json();
    return { data: items, total: count };
  },
});
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `baseUrl` | `string` | *required* | Collection endpoint |
| `idField` | `string` | `'id'` | Unique identifier field |
| `fetch` | `FetchLike` | `globalThis.fetch` | Injectable — mock in tests, wrap for retries/auth |
| `init` | `RequestInit` | — | Applied to every request (headers, `credentials`, `signal`) |
| `searchFields` | `string[]` | all string fields | Fields used by the client-side search fallback |
| `toQuery` | `(params) => URLSearchParams` | see above | Query encoding for delegated params |
| `parseList` | `(response) => {data,total}` | see above | List-response normalization |
| `capabilities` | `Partial<ProviderCapabilities>` | all-client-side | What the server really does |

## `createHttpBlobProvider` — content, addressed by URL

Content-only. Pair it as the `contentProvider` of `createBifurcatedProvider` (above), or
use it standalone. `getList()` returns `{ data: [], total: 0 }` — listing is the metadata
provider's job.

```typescript
const clips = createHttpBlobProvider({
  baseUrl: '/api/kodokan/clips',
  contentFields: ['clip'],
});

await clips.getUrl('osoto-gari.mp4', 'clip');      // → '/api/kodokan/clips/osoto-gari.mp4'
await clips.getContent('osoto-gari.mp4', 'clip');  // → Uint8Array (only when you need bytes)
await clips.setContent('uchi-mata.mp4', 'clip', bytes);  // → PUT, returns a ContentRef with .url
```

### The path rule

One rule, used by reads *and* writes:

- **one** content field → `{base}/{id}` — e.g. `/api/kodokan/clips/osoto-gari.mp4`
- **many** content fields → `{base}/{id}/{field}` — e.g. `/api/docs/blobs/42/thumbnail`

With a single content field the field name carries no information, and a URL ending in the
id — extension and all — is what a `<video>`, a CDN and a human all want.

### Where the bytes come from

| Given | `getUrl()` resolves to |
|---|---|
| nothing (default) | `{baseUrl}/…` — **your backend serves the bytes** |
| `publicBaseUrl` | `{publicBaseUrl}/…` — a CDN or public bucket |
| `urlFor` (may be async — presigning is a round-trip) | whatever it returns; wins over `publicBaseUrl` |

`getContent()` fetches **the same URL `getUrl()` returns** — one rule, not two.
**Writes always go to `baseUrl`**, whatever the read strategy: you cannot `PUT` to a CDN.

`getUrl()` here essentially never returns `null` (the signature allows it because other
adapters — in-memory, IndexedDB — genuinely cannot name a URL). An HTTP backend can always
name a URL for its own bytes. That is the point of this adapter.

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `baseUrl` | `string` | *required* | Content endpoint (serves and accepts bytes) |
| `contentFields` | `string[]` | *required* | Fields this provider manages |
| `idField` | `string` | `'id'` | Unique identifier field |
| `fetch` | `FetchLike` | `globalThis.fetch` | Injectable |
| `init` | `RequestInit` | — | Applied to every request |
| `publicBaseUrl` | `string` | — | Serve reads from a CDN / public bucket |
| `urlFor` | `(id, field) => string \| Promise<string>` | — | Full control; may presign |
| `writeMethod` | `'PUT' \| 'POST'` | `'PUT'` | How content is written |
| `contentTypeFor` | `(id, field, content) => string \| undefined` | inferred | Override the write `Content-Type` |

## Errors

Any non-2xx throws an `HttpError` carrying `status`, `statusText`, `method`, `url` and the
(truncated) response `body` — so the message alone tells you which call failed and why:

```
HTTP 404 Not Found on GET /api/kodokan/clips/missing.mp4 — {"error":"not found"}
```

## Capabilities

| Capability | Supported |
|---|---|
| Create / Update / Delete | Yes |
| Bulk Update / Delete | Yes (N requests, not a bulk endpoint) |
| Upsert | No |
| Server Sort / Filter / Search / Pagination | **No by default** — client-side fallback. Opt in via `capabilities`. |
| Real-time | No |

## License

MIT
