/**
 * The DataProvider contract from `@zodal/store/testing`, run against the provider
 * wired to the mock REST backend. Each case gets a fresh backend.
 *
 * Three modes, because this provider splits each `getList` between server and client
 * according to its declared `capabilities`:
 * - client-side: a dumb backend, every query step done by the provider;
 * - server-delegating: every step declared server-side and honored by the backend
 *   (`total` comes from the server's envelope);
 * - mixed: a field-scoped `serverFilter` (other fields fall back client-side) and a
 *   server sort, with search and pagination client-side.
 */

import { describe, it } from 'vitest';
import { providerContract, type ContractRow } from '@zodal/store/testing';
import type { ProviderCapabilities } from '@zodal/store';
import { createHttpProvider } from '../src/provider.js';
import { createMockBackend, type Item, type MockBackendOptions } from './mock-backend.js';

const modes: [string, Pick<MockBackendOptions, 'shape' | 'honor'>, Partial<ProviderCapabilities>][] = [
  ['client-side', {}, {}],
  [
    'server-delegating',
    { shape: 'envelope', honor: { filter: true, sort: true, search: true, pagination: true } },
    { serverFilter: true, serverSort: true, serverSearch: true, serverPagination: true },
  ],
  [
    'mixed (field-scoped serverFilter, server sort)',
    { honor: { filter: true, sort: true } },
    { serverFilter: ['status', 'priority'], serverSort: true },
  ],
];

for (const [label, backendOptions, capabilities] of modes) {
  const cases = await providerContract({
    make: (seed) =>
      createHttpProvider<ContractRow>({
        baseUrl: '/api/items',
        fetch: createMockBackend({ ...backendOptions, seed: seed as unknown as Item[] }).fetch,
        capabilities,
      }),
  });
  describe(`http ${label}: DataProvider contract`, () => {
    for (const c of cases) (c.skip ? it.skip : it)(c.name, c.run);
  });
}
