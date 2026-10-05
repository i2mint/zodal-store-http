# zodal-store-http -- Agent Guide

## What This Is

zodal `DataProvider` adapters for a REST backend, over `fetch`. Browser-first: this is how
an app talks to its *own* API server through zodal.

- `createHttpProvider` -- full REST CRUD. The metadata half.
- `createHttpBlobProvider` -- content served over HTTP, with `getUrl()`. The blob half, and
  the reason the package exists.

## Package Structure

```
src/
  index.ts           # re-exports
  http.ts            # shared plumbing: FetchLike, HttpError, joinUrl, request/response helpers
  provider.ts        # createHttpProvider  (GET/POST/PATCH/DELETE + client-side fallback)
  blob-provider.ts   # createHttpBlobProvider (getUrl / getContent / setContent)
tests/
  mock-backend.ts       # injected mock `fetch` -- a REST backend and a blob backend
  provider.test.ts
  blob-provider.test.ts
  contract.test.ts      # @zodal/store/testing conformance kit, client-side / delegating / mixed
```

## Load-Bearing Invariants

Break any of these and the package stops being worth having:

1. **`getUrl()` returns a URL, not bytes.** Media consumed by URL (`<video src>`) needs
   HTTP range requests to stream and seek. `getContent()` defeats them and holds the whole
   file in memory. `getUrl()` is also the migration seam: swap in
   `createS3BlobProvider({ publicBaseUrl })` and the app code does not change.
2. **One path rule, shared by reads and writes.** Single content field -> `{base}/{id}`;
   multiple -> `{base}/{id}/{field}`. `getContent()` fetches exactly the URL `getUrl()`
   returns.
3. **Reads may be redirected (`publicBaseUrl` / `urlFor`); writes always go to `baseUrl`.**
   You cannot `PUT` to a CDN.
4. **`urlFor` may be async** (presigning is a round-trip) -- always `await` it. Forgetting
   is the classic bug: the field silently holds a pending Promise and `ref.url` reads
   `undefined`.
5. **Capabilities are reported honestly.** Anything not delegated to the server is done
   client-side (through `applyQuery()` from `@zodal/store`, skipping the steps the server
   did -- never re-implemented here), and `getCapabilities()` says so. When the server
   paginates, `total` is the server's.
7. **Contract errors come from the server's status.** `create` with an existing id must be
   refused by the backend (409); `updateMany`/`deleteMany` skip ids answered 404 and
   reject on any other error.
6. **Nothing about the REST convention is hardcoded.** `toQuery` and `parseList` are the
   escape hatches; their defaults are documented in the README and in the option doc
   comments. Keep those three in sync.

## Version Situation (read before touching package.json)

`peerDependencies` / `devDependencies` point at `@zodal/core` + `@zodal/store` **^0.2.1** --
the version that carries `applyQuery` and the `@zodal/store/testing` conformance kit. If
it is not on npm yet, `pnpm install` from the registry will fail until it is. To work locally,
build the monorepo packages and link them into `node_modules` (do **not** commit `file:`
deps -- CI has no sibling checkout):

```bash
cd ../zodal/packages/core  && npx tsup
cd ../zodal/packages/store && npx tsup
cd ../../../zodal-store-http
mkdir -p node_modules/@zodal
ln -sfn ../../../zodal/packages/core  node_modules/@zodal/core
ln -sfn ../../../zodal/packages/store node_modules/@zodal/store
npx tsc --noEmit && npx vitest run
```

`pnpm-lock.yaml` is committed and CI installs with `--frozen-lockfile`, so after a peer
bump the lockfile must be regenerated (`pnpm install`) once the new core version is on npm.

## Testing

```bash
npx vitest run      # or: pnpm test
```

Tests inject a mock `fetch` (`tests/mock-backend.ts`); nothing hits the network. The mock
REST backend **ignores query params by default**, on purpose: a fallback test that passes
proves the *provider* filtered/sorted/paginated, not the server. Tests assert both the
result and the absence of the corresponding query param. Keep them non-vacuous that way.

## Skills

- **Store adapter patterns**: zodal monorepo `.claude/skills/zodal-store-adapter/SKILL.md`
  (the `DataProvider` contract, the content trio, the async-`toContentRef` rule)
- **Data placement doctrine**: `~/.claude/skills/app-data-lifecycle/SKILL.md`

## Dependencies

- `@zodal/core` -- types (`FilterExpression`, `SortingState`, `ContentRef`)
- `@zodal/store` -- `DataProvider`, `ProviderCapabilities`, `filterToFunction`
- No runtime dependencies. `fetch` is injected (default `globalThis.fetch`), so the package
  runs in browsers, Node >= 18, Deno, Bun and workers alike. `tsconfig` targets
  `["ES2022", "DOM"]` with `"types": []` -- deliberately no `@types/node`.
