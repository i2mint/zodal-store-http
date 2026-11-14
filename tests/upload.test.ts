/** Write options, headContent, presigned upload URLs and validateContent (zodal-store-http#8). */
import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => vi.unstubAllGlobals());
import { createHttpBlobProvider } from '../src/blob-provider.js';
import { joinUrl } from '../src/http.js';
import { createMockBlobBackend } from './mock-backend.js';

const make = (backend: ReturnType<typeof createMockBlobBackend>, extra: Record<string, unknown> = {}) =>
  createHttpBlobProvider<{ id: string }>({ baseUrl: '/api/img', contentFields: ['img'], fetch: backend.fetch, ...extra });

describe('write options and headContent', () => {
  it('sends mimeType and cacheControl, and headContent reports without the bytes', async () => {
    const backend = createMockBlobBackend();
    const p = make(backend);
    expect(await p.headContent('a.svg', 'img')).toBeNull();
    const ref = await p.setContent('a.svg', 'img', '<svg/>', { mimeType: 'image/svg+xml', cacheControl: 'public, max-age=31536000, immutable', hash: 'h' });
    expect(ref).toMatchObject({ mimeType: 'image/svg+xml', size: 6, hash: 'h', url: '/api/img/a.svg' });
    const put = backend.callsOfMethod('PUT')[0]!;
    expect(put.headers).toMatchObject({ 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=31536000, immutable' });
    const head = await p.headContent('a.svg', 'img');
    expect(head).toMatchObject({ mimeType: 'image/svg+xml', size: 6, url: '/api/img/a.svg' });
    expect(backend.callsOfMethod('GET')).toEqual([]);
  });
  it('ifAbsent: If-None-Match: *, and a 412 resolves with the stored content', async () => {
    const backend = createMockBlobBackend();
    const p = make(backend, { conditionalWrites: true });
    await p.setContent('x', 'img', 'first', { ifAbsent: true, mimeType: 'text/plain' });
    const second = await p.setContent('x', 'img', 'second', { ifAbsent: true });
    expect(second).toMatchObject({ itemId: 'x', url: '/api/img/x' });
    expect(backend.callsOfMethod('HEAD')).toEqual([]);
    expect(new TextDecoder().decode(backend.blobs.get('/api/img/x'))).toBe('first');
    expect(backend.callsOfMethod('PUT').every((c) => c.headers['if-none-match'] === '*')).toBe(true);
    expect((p.getCapabilities!() as any).contentIfAbsent).toBe('atomic');
  });
  it('without conditionalWrites, ifAbsent checks with a HEAD first and reports best-effort', async () => {
    const backend = createMockBlobBackend({ '/api/img/y': 'kept' });
    const p = make(backend);
    const ref = await p.setContent('y', 'img', 'new', { ifAbsent: true });
    expect(ref).toMatchObject({ size: 4 });
    expect(backend.callsOfMethod('PUT')).toEqual([]);
    expect((p.getCapabilities!() as any).contentIfAbsent).toBe('best-effort');
  });
});

describe('uploadUrlFor (presigned uploads)', () => {
  it('uploads to the minted URL with only its headers, never the app credentials', async () => {
    const backend = createMockBlobBackend();
    const asked: unknown[] = [];
    // The app's fetch wrapper adds its token: it must not be used for the upload.
    const appFetch = (u: string, i?: RequestInit) => backend.fetch(u, { ...i, headers: { ...Object.fromEntries(new Headers(i?.headers)), authorization: 'Bearer wrapped' } });
    const p = make(backend, {
      fetch: appFetch, // uploads default to globalThis.fetch, stubbed below
      init: { credentials: 'include', headers: { Authorization: 'Bearer app-token' } },
      publicBaseUrl: 'https://cdn.example',
      uploadUrlFor: async (id: string, field: string, info: unknown) => {
        asked.push([id, field, info]);
        return { url: `https://bucket.example/${id}?sig=1`, headers: { 'x-amz-acl': 'public-read' } };
      },
    });
    vi.stubGlobal('fetch', backend.fetch);
    const ref = await p.setContent('a.png', 'img', new Uint8Array([1, 2, 3]), { mimeType: 'image/png' });
    expect(asked).toEqual([['a.png', 'img', { mimeType: 'image/png', size: 3 }]]);
    const put = backend.callsOfMethod('PUT')[0]!;
    expect(put.url).toBe('https://bucket.example/a.png?sig=1');
    expect(put.headers).toMatchObject({ 'content-type': 'image/png', 'x-amz-acl': 'public-read' });
    expect(put.headers.authorization).toBeUndefined();
    expect(put.credentials).toBeUndefined();
    expect(ref.url).toBe('https://cdn.example/a.png'); // reads still follow publicBaseUrl
  });
});

describe('validateContent', () => {
  it('refuses before any request', async () => {
    const backend = createMockBlobBackend();
    const p = make(backend, {
      validateContent: (_c: unknown, info: { size?: number; mimeType: string }) => {
        if ((info.size ?? 0) > 4) throw new Error(`too big: ${info.size}`);
        if (!info.mimeType.startsWith('image/')) throw new Error(`not an image: ${info.mimeType}`);
      },
    });
    await expect(p.setContent('a', 'img', 'hello', { mimeType: 'image/png' })).rejects.toThrow(/too big: 5/);
    await expect(p.setContent('a', 'img', 'hi')).rejects.toThrow(/not an image/);
    expect(backend.calls).toEqual([]);
  });
});

describe('joinUrl refuses dot segments', () => {
  it('throws on . and .. and empty', () => {
    expect(() => joinUrl('/items', '..')).toThrow(/cannot be a URL path segment/);
    expect(() => joinUrl('/items', '.')).toThrow();
    expect(() => joinUrl('/items', '')).toThrow();
    expect(joinUrl('/items', 'a/b')).toBe('/items/a%2Fb');
  });
});

describe('uploadUrlFor needs a read location', () => {
  it('refuses uploadUrlFor without urlFor or publicBaseUrl', () => {
    expect(() => make(createMockBlobBackend(), { uploadUrlFor: () => ({ url: 'x' }) })).toThrow(/reads need urlFor or publicBaseUrl/);
  });
});
