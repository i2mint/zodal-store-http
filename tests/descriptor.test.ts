/**
 * The provider descriptors: created by name through `createFromDescriptor` with a
 * mock `fetch`, the REST provider passes the `@zodal/store/testing` contract (with
 * and without declared server capabilities, which must survive validation); the
 * request `init` reaches `fetch` intact; headers are secret and never shown;
 * functions are live; bad options fail with a structural error naming the
 * descriptor; and the menu's capabilities are what the provider reports.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createFromDescriptor,
  defineProviderDescriptor,
  describedCapabilities,
  isProviderSupported,
  liveOptionPaths,
  redactOptions,
  secretOptionPaths,
  splitOptions,
  LIVE,
} from '@zodal/store/descriptor';
import { providerContract, type ContractRow } from '@zodal/store/testing';
import type { DataProvider, ProviderCapabilities } from '@zodal/store';
import { descriptor, blobDescriptor } from '../src/index.js';
import { createMockBackend, createMockBlobBackend, type Item } from './mock-backend.js';

const paths = (ps: readonly (readonly (string | number)[])[]) => ps.map((p) => p.join('.')).sort();

// The contract, run through the descriptor path: `fetch` (live) and `capabilities`
// (nested data) must both come out of validation as given.
const modes: [string, Parameters<typeof createMockBackend>[0], Partial<ProviderCapabilities>][] = [
  ['client-side', {}, {}],
  [
    'server-delegating',
    { shape: 'envelope', honor: { filter: true, sort: true, search: true, pagination: true } },
    { serverFilter: true, serverSort: true, serverSearch: true, serverPagination: true },
  ],
];
for (const [label, backendOptions, capabilities] of modes) {
  const cases = await providerContract({
    make: async (seed) =>
      (await createFromDescriptor(descriptor, {
        baseUrl: '/api/items',
        fetch: createMockBackend({ ...backendOptions, seed: seed as unknown as Item[] }).fetch,
        capabilities,
      })) as DataProvider<ContractRow>,
  });
  describe(`http descriptor (${label}) via createFromDescriptor: DataProvider contract`, () => {
    for (const c of cases) (c.skip ? it.skip : it)(c.name, c.run);
  });
}

const TOKEN = 'Bearer sk-live-DO-NOT-SHOW';

describe('http provider descriptors', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('are accepted by defineProviderDescriptor, with their own name and source', () => {
    expect(defineProviderDescriptor(descriptor)).toBe(descriptor);
    expect(defineProviderDescriptor(blobDescriptor)).toBe(blobDescriptor);
    expect([descriptor.name, blobDescriptor.name]).toEqual(['http', 'httpBlob']);
    expect(descriptor.source).toEqual({ module: '@zodal/store-http', export: 'descriptor' });
    expect(blobDescriptor.source).toEqual({ module: '@zodal/store-http', export: 'blobDescriptor' });
    expect([descriptor.runtime, blobDescriptor.runtime]).toEqual(['any', 'any']);
  });

  it('are supported where a global fetch exists', async () => {
    expect(await isProviderSupported(descriptor)).toBe(true);
    expect(await isProviderSupported(blobDescriptor)).toBe(true);
    vi.stubGlobal('fetch', undefined);
    expect(await isProviderSupported(descriptor)).toBe(false);
    expect(await isProviderSupported(blobDescriptor)).toBe(false);
  });

  it('pass the request init to fetch: headers, credentials mode, and undeclared RequestInit extensions', async () => {
    const backend = createMockBackend({ seed: [{ id: '1', name: 'one', priority: 1 }] });
    const dispatcher = { kind: 'proxy-agent' };
    let seenInit: RequestInit | undefined;
    const provider = await createFromDescriptor(descriptor, {
      baseUrl: '/api/items',
      fetch: (input: string, reqInit?: RequestInit) => {
        seenInit = reqInit;
        return backend.fetch(input, reqInit);
      },
      init: { headers: { Authorization: TOKEN }, credentials: 'include', cache: 'no-store', dispatcher },
    });
    expect(await provider.getOne('1')).toMatchObject({ name: 'one' });
    expect(backend.last()).toMatchObject({ headers: { authorization: TOKEN }, credentials: 'include' });
    expect(seenInit).toMatchObject({ cache: 'no-store', dispatcher });
  });

  it('create a working blob provider from valid options', async () => {
    const backend = createMockBlobBackend({ '/api/clips/a.mp4': 'bytes' });
    const clips = await createFromDescriptor(blobDescriptor, {
      baseUrl: '/api/clips',
      contentFields: ['clip'],
      fetch: backend.fetch,
      publicBaseUrl: 'https://cdn.example.com/clips',
      writeMethod: 'POST',
    });
    expect(await clips.getUrl!('a.mp4', 'clip')).toBe('https://cdn.example.com/clips/a.mp4');
    await clips.setContent!('b.mp4', 'clip', 'more');
    expect(backend.calls.at(-1)).toMatchObject({ method: 'POST', url: '/api/clips/b.mp4' });
  });

  it('reject invalid options with a structural error naming the descriptor, without echoing values', async () => {
    await expect(createFromDescriptor(descriptor, {})).rejects.toThrow(/Invalid options for provider "http": baseUrl: invalid_type/);
    await expect(createFromDescriptor(descriptor, { baseUrl: '/x', fetch: 'fetch' })).rejects.toThrow(/provider "http": fetch: custom/);
    await expect(createFromDescriptor(descriptor, { baseUrl: '/x', init: { credentials: 'always' } })).rejects.toThrow(/init\.credentials: invalid_value/);
    await expect(createFromDescriptor(descriptor, { baseUrl: '/x', init: { headers: new Headers() } })).rejects.toThrow(/init\.headers: invalid_union/);
    await expect(createFromDescriptor(descriptor, { baseUrl: '/x', capabilities: { serverFilter: 'yes' } })).rejects.toThrow(/capabilities\.serverFilter/);
    await expect(createFromDescriptor(blobDescriptor, { baseUrl: '/x' })).rejects.toThrow(/provider "httpBlob": contentFields/);
    const err = await createFromDescriptor(descriptor, { baseUrl: '/x', init: { headers: [['Authorization', TOKEN, 'extra']] } }).catch((e: Error) => e);
    expect(err.message).toMatch(/provider "http"/);
    expect(err.message).not.toContain('sk-live');
  });

  it('withhold a creation error message when the options carry headers', async () => {
    vi.stubGlobal('fetch', undefined); // createHttpProvider throws: no fetch to use
    const err = await createFromDescriptor(descriptor, { baseUrl: '/x', init: { headers: { Authorization: TOKEN } } }).catch((e: Error) => e);
    expect(err.message).toMatch(/Provider "http" could not be created: .*withheld/);
    expect(err.message).not.toContain('sk-live');
  });

  it('treat init.headers as a secret, and the credentials mode as public', () => {
    for (const d of [descriptor, blobDescriptor]) expect(paths(secretOptionPaths(d))).toEqual(['init.headers']);
    const options = {
      baseUrl: '/api/items',
      init: { headers: { Authorization: TOKEN, Accept: 'application/json' }, credentials: 'include' as const },
      fetch: globalThis.fetch,
    };
    const redacted = redactOptions(descriptor, options);
    expect(redacted).toEqual({ baseUrl: '/api/items', init: { headers: '[secret]', credentials: 'include' }, fetch: LIVE });
    expect(JSON.stringify(redacted)).not.toContain('sk-live');
    // Header pairs are redacted too.
    expect(JSON.stringify(redactOptions(descriptor, { baseUrl: '/x', init: { headers: [['Authorization', TOKEN]] } }))).not.toContain('sk-live');
  });

  it('list functions and the abort signal as live, and leave them out of shareable data', () => {
    expect(paths(liveOptionPaths(descriptor))).toEqual(['fetch', 'init.signal', 'parseList', 'toQuery']);
    expect(paths(liveOptionPaths(blobDescriptor))).toEqual(['contentTypeFor', 'fetch', 'init.signal', 'urlFor']);
    const { data, live, secretPaths } = splitOptions(descriptor, {
      baseUrl: '/api/items',
      fetch: globalThis.fetch,
      toQuery: () => new URLSearchParams(),
      init: { credentials: 'include' as const, headers: { Authorization: TOKEN } },
      capabilities: { serverFilter: ['status'] },
    });
    expect(data).toEqual({ baseUrl: '/api/items', init: { credentials: 'include', headers: '[secret]' }, capabilities: { serverFilter: ['status'] } });
    expect(paths(live)).toContain('fetch');
    expect(paths(secretPaths)).toEqual(['init.headers']);
  });

  it('describe the capabilities from the capabilities option, as the provider reports them', async () => {
    const backend = createMockBackend();
    for (const capabilities of [undefined, { serverFilter: ['status'], serverSort: true }, { serverPagination: true, paginationStyle: 'offset' as const }]) {
      const options = { baseUrl: '/api/items', fetch: backend.fetch, capabilities };
      const provider = await createFromDescriptor(descriptor, options);
      expect(describedCapabilities(descriptor, options)).toEqual(provider.getCapabilities!());
    }
    const blobOptions = { baseUrl: '/b', contentFields: ['clip'], fetch: backend.fetch };
    const blob = await createFromDescriptor(blobDescriptor, blobOptions);
    expect(describedCapabilities(blobDescriptor, blobOptions)).toEqual(blob.getCapabilities!());
  });
});
