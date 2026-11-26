/**
 * `withTrash` (zodal#156) over the HTTP provider (zodal#162), against the mock backend: delete
 * becomes a PATCH of the mark, and the Trash filters client-side. Skipped until the installed
 * `@zodal/store` ships `withTrash`.
 */
import { describe, it, expect } from 'vitest';
import * as store from '@zodal/store';
import { createHttpProvider } from '../src/provider.js';
import { createMockBackend, type Item } from './mock-backend.js';

const withTrash = (store as any).withTrash as typeof import('@zodal/store').withTrash | undefined;
const SEED: Item[] = [
  { id: 'a', name: 'Zebra', priority: 1 },
  { id: 'b', name: 'Alpha', priority: 3 },
  { id: 'c', name: 'Mango', priority: 5 },
];
const make = () => createHttpProvider<Item>({ baseUrl: '/api/items', fetch: createMockBackend({ seed: SEED }).fetch });

describe.skipIf(!withTrash)('withTrash over HTTP', () => {
  it('delete moves to the Trash; restore and purge work; the DataProvider contract holds', async () => {
    const p = withTrash(make(), { stamp: () => '2026-01-01T00:00:00.000Z' });
    expect(p.getCapabilities().softDelete).toBe(true);
    await p.delete('a');
    expect((await p.getList({})).data.map((x: any) => x.id).sort()).toEqual(['b', 'c']);
    await expect(p.getOne('a')).rejects.toThrow();
    expect((await p.trashed.getList({})).data.map((x: any) => x.id)).toEqual(['a']);
    expect(await p.restore(['a'])).toEqual(['a']);
    expect((await p.getList({})).total).toBe(3);
    await p.deleteMany(['b', 'c']);
    expect(await p.emptyTrash()).toBe(2);
    expect((await p.getList({})).data.map((x: any) => x.id)).toEqual(['a']);
    expect((await p.trashed.getList({})).total).toBe(0);
  });
});
