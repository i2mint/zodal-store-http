/** ETag / If-Match conditional writes (i2mint/zodal#118). */
import { describe, it, expect } from 'vitest';
import { createHttpProvider, WriteConflictError } from '../src/index.js';

/** A REST backend that versions items with ETags and honours If-Match. */
function etagBackend(seed: Record<string, Record<string, unknown>>) {
  const items = new Map(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
  const versions = new Map([...items.keys()].map((k) => [k, 1]));
  const etag = (id: string) => `"v${versions.get(id)}"`;
  const calls: { method: string; ifMatch: string | null }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    calls.push({ method, ifMatch: headers.get('If-Match') });
    const id = decodeURIComponent(url.split('/').pop()!);
    if (!items.has(id)) return new Response('gone', { status: 404, statusText: 'Not Found' });
    const ifMatch = headers.get('If-Match');
    if (ifMatch && ifMatch !== etag(id)) return new Response('stale', { status: 412, statusText: 'Precondition Failed' });
    if (method === 'GET') return new Response(JSON.stringify(items.get(id)), { status: 200, headers: { ETag: etag(id) } });
    if (method === 'PATCH') {
      items.set(id, { ...items.get(id)!, ...JSON.parse(String(init!.body)) });
      versions.set(id, versions.get(id)! + 1);
      return new Response(JSON.stringify(items.get(id)), { status: 200, headers: { ETag: etag(id) } });
    }
    if (method === 'DELETE') {
      items.delete(id);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  };
  return { fetch, items, calls };
}

describe('createHttpProvider({ versioned: true })', () => {
  it('reads ETags, writes with If-Match, and turns 412 into a WriteConflict', async () => {
    const backend = etagBackend({ doc: { id: 'doc', lock: null } });
    const p = createHttpProvider<{ id: string; lock: string | null }>({ baseUrl: '/api/docs', fetch: backend.fetch, versioned: true });
    expect((p.getCapabilities!() as any).versioned).toBe(true);
    const a = await p.getVersioned('doc');
    const b = await p.getVersioned('doc');
    expect(a.version).toBe('"v1"');
    const won = await p.updateIfVersion('doc', { lock: 'alice' }, a.version);
    expect(won).toEqual({ item: { id: 'doc', lock: 'alice' }, version: '"v2"' });
    const lost = await p.updateIfVersion('doc', { lock: 'bob' }, b.version).catch((e) => e);
    expect(lost).toBeInstanceOf(WriteConflictError);
    expect(lost.name).toBe('WriteConflict');
    expect(backend.items.get('doc')!.lock).toBe('alice');
    expect(backend.calls.filter((c) => c.method === 'PATCH').map((c) => c.ifMatch)).toEqual(['"v1"', '"v1"']);
    await expect(p.deleteIfVersion('doc', a.version)).rejects.toBeInstanceOf(WriteConflictError);
    await p.deleteIfVersion('doc', won.version);
    await expect(p.updateIfVersion('doc', { lock: 'x' }, won.version)).rejects.toBeInstanceOf(WriteConflictError);
  });
  it('is off by default (no methods, no capability) and refuses a backend without ETags', async () => {
    const plain = createHttpProvider({ baseUrl: '/x', fetch: async () => new Response('{"id":"1"}', { status: 200 }) });
    expect((plain as any).getVersioned).toBeUndefined();
    expect((plain.getCapabilities!() as any).versioned).toBeUndefined();
    const noEtag = createHttpProvider({ baseUrl: '/x', versioned: true, fetch: async () => new Response('{"id":"1"}', { status: 200 }) });
    await expect(noEtag.getVersioned('1')).rejects.toThrow(/no ETag/);
  });
});
