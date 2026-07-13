/**
 * Tests for `createHttpBlobProvider` — the content half.
 *
 * The load-bearing assertions are about `getUrl()`: what it resolves to under each URL
 * strategy (backend / `publicBaseUrl` / async `urlFor`), that `getContent()` fetches
 * exactly that same URL, and that writes still go to the backend even when reads are
 * redirected to a CDN. That last one is the invariant a naive implementation breaks.
 */

import { describe, it, expect } from 'vitest';
import { createHttpBlobProvider } from '../src/blob-provider.js';
import { HttpError } from '../src/http.js';
import { createMockBlobBackend } from './mock-backend.js';

const decode = (bytes: unknown) => new TextDecoder().decode(bytes as Uint8Array);

interface Clip extends Record<string, unknown> {
  id: string;
  clip: unknown;
}

describe('createHttpBlobProvider — getUrl (the headline)', () => {
  it('resolves against baseUrl by default — the backend serves the bytes', async () => {
    const backend = createMockBlobBackend();
    const provider = createHttpBlobProvider<Clip>({
      baseUrl: '/api/kodokan/clips',
      contentFields: ['clip'],
      fetch: backend.fetch,
    });

    const url = await provider.getUrl!('osoto-gari.mp4', 'clip');
    expect(url).toBe('/api/kodokan/clips/osoto-gari.mp4');
  });

  it('never returns null — an HTTP backend can always name a URL for its own bytes', async () => {
    const backend = createMockBlobBackend();
    const provider = createHttpBlobProvider<Clip>({
      baseUrl: '/api/kodokan/clips',
      contentFields: ['clip'],
      fetch: backend.fetch,
    });
    // No blob stored, no publicBaseUrl, no urlFor — still a URL.
    expect(await provider.getUrl!('never-uploaded.mp4', 'clip')).toBe(
      '/api/kodokan/clips/never-uploaded.mp4',
    );
  });

  it('resolves against publicBaseUrl when given — bytes move to a CDN, app code does not', async () => {
    const backend = createMockBlobBackend();
    const provider = createHttpBlobProvider<Clip>({
      baseUrl: '/api/kodokan/clips',
      publicBaseUrl: 'https://cdn.example.com/clips/',
      contentFields: ['clip'],
      fetch: backend.fetch,
    });

    expect(await provider.getUrl!('osoto-gari.mp4', 'clip')).toBe(
      'https://cdn.example.com/clips/osoto-gari.mp4',
    );
  });

  it('awaits an async urlFor, and urlFor wins over publicBaseUrl', async () => {
    const backend = createMockBlobBackend();
    const provider = createHttpBlobProvider<Clip>({
      baseUrl: '/api/kodokan/clips',
      publicBaseUrl: 'https://cdn.example.com',
      contentFields: ['clip'],
      fetch: backend.fetch,
      urlFor: async (id, field) => {
        await Promise.resolve(); // a presign is a round-trip
        return `https://bucket.s3.amazonaws.com/${id}?field=${field}&sig=abc`;
      },
    });

    const url = await provider.getUrl!('osoto-gari.mp4', 'clip');
    // A plain string, not a pending Promise — the classic forgotten-await bug.
    expect(typeof url).toBe('string');
    expect(url).toBe('https://bucket.s3.amazonaws.com/osoto-gari.mp4?field=clip&sig=abc');
  });

  it('uses /{id}/{field} when there is more than one content field', async () => {
    const backend = createMockBlobBackend();
    const provider = createHttpBlobProvider({
      baseUrl: '/api/docs/blobs',
      contentFields: ['attachment', 'thumbnail'],
      fetch: backend.fetch,
    });

    expect(await provider.getUrl!('42', 'attachment')).toBe('/api/docs/blobs/42/attachment');
    expect(await provider.getUrl!('42', 'thumbnail')).toBe('/api/docs/blobs/42/thumbnail');
  });

  it('percent-encodes the id', async () => {
    const backend = createMockBlobBackend();
    const provider = createHttpBlobProvider<Clip>({
      baseUrl: '/api/kodokan/clips',
      contentFields: ['clip'],
      fetch: backend.fetch,
    });

    expect(await provider.getUrl!('o soto/gari.mp4', 'clip')).toBe(
      '/api/kodokan/clips/o%20soto%2Fgari.mp4',
    );
  });

  it('rejects a field that is not a content field', async () => {
    const backend = createMockBlobBackend();
    const provider = createHttpBlobProvider<Clip>({
      baseUrl: '/api/kodokan/clips',
      contentFields: ['clip'],
      fetch: backend.fetch,
    });

    await expect(provider.getUrl!('x', 'title')).rejects.toThrow(/not a content field/);
    await expect(provider.getContent!('x', 'title')).rejects.toThrow(/not a content field/);
    await expect(provider.setContent!('x', 'title', 'v')).rejects.toThrow(/not a content field/);
  });
});

describe('createHttpBlobProvider — getContent', () => {
  it('returns the bytes, fetched from the resolved URL', async () => {
    const backend = createMockBlobBackend({
      '/api/kodokan/clips/osoto-gari.mp4': 'MP4 BYTES',
    });
    const provider = createHttpBlobProvider<Clip>({
      baseUrl: '/api/kodokan/clips',
      contentFields: ['clip'],
      fetch: backend.fetch,
    });

    const bytes = await provider.getContent!('osoto-gari.mp4', 'clip');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(decode(bytes)).toBe('MP4 BYTES');
    expect(backend.urls()).toEqual(['/api/kodokan/clips/osoto-gari.mp4']);
  });

  it('fetches from publicBaseUrl when reads are redirected there', async () => {
    const backend = createMockBlobBackend({
      'https://cdn.example.com/osoto-gari.mp4': 'CDN BYTES',
    });
    const provider = createHttpBlobProvider<Clip>({
      baseUrl: '/api/kodokan/clips',
      publicBaseUrl: 'https://cdn.example.com',
      contentFields: ['clip'],
      fetch: backend.fetch,
    });

    expect(decode(await provider.getContent!('osoto-gari.mp4', 'clip'))).toBe('CDN BYTES');
    // getContent and getUrl agree — one path rule, not two.
    expect(backend.urls()).toEqual([await provider.getUrl!('osoto-gari.mp4', 'clip')]);
  });

  it('throws HttpError when the backend has no such blob', async () => {
    const backend = createMockBlobBackend();
    const provider = createHttpBlobProvider<Clip>({
      baseUrl: '/api/kodokan/clips',
      contentFields: ['clip'],
      fetch: backend.fetch,
    });

    const error = await provider.getContent!('missing.mp4', 'clip').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(404);
    expect((error as HttpError).url).toBe('/api/kodokan/clips/missing.mp4');
    expect((error as HttpError).method).toBe('GET');
  });

  it('passes `init` (credentials) through to the byte fetch', async () => {
    const backend = createMockBlobBackend({ '/api/kodokan/clips/x.mp4': 'bytes' });
    const provider = createHttpBlobProvider<Clip>({
      baseUrl: '/api/kodokan/clips',
      contentFields: ['clip'],
      fetch: backend.fetch,
      init: { credentials: 'include' },
    });

    await provider.getContent!('x.mp4', 'clip');
    expect(backend.calls[0].credentials).toBe('include');
  });
});

describe('createHttpBlobProvider — setContent', () => {
  it('PUTs the bytes and returns a ContentRef carrying the url', async () => {
    const backend = createMockBlobBackend();
    const provider = createHttpBlobProvider<Clip>({
      baseUrl: '/api/kodokan/clips',
      contentFields: ['clip'],
      fetch: backend.fetch,
    });

    const bytes = new TextEncoder().encode('NEW CLIP');
    const ref = await provider.setContent!('uchi-mata.mp4', 'clip', bytes);

    expect(ref).toMatchObject({
      _tag: 'ContentRef',
      field: 'clip',
      itemId: 'uchi-mata.mp4',
      url: '/api/kodokan/clips/uchi-mata.mp4',
      mimeType: 'application/octet-stream',
      size: bytes.byteLength,
    });
    expect(backend.calls[0].method).toBe('PUT');
    expect(decode(backend.blobs.get('/api/kodokan/clips/uchi-mata.mp4'))).toBe('NEW CLIP');
  });

  it('writes to baseUrl even when reads resolve to a CDN — you cannot PUT to a CDN', async () => {
    const backend = createMockBlobBackend();
    const provider = createHttpBlobProvider<Clip>({
      baseUrl: '/api/kodokan/clips',
      publicBaseUrl: 'https://cdn.example.com',
      contentFields: ['clip'],
      fetch: backend.fetch,
    });

    const ref = await provider.setContent!('uchi-mata.mp4', 'clip', 'BYTES');

    // Write went to the backend...
    expect(backend.callsOfMethod('PUT')[0].url).toBe('/api/kodokan/clips/uchi-mata.mp4');
    // ...while the ref points readers at the CDN.
    expect(ref.url).toBe('https://cdn.example.com/uchi-mata.mp4');
  });

  it('honors writeMethod: POST', async () => {
    const backend = createMockBlobBackend();
    const provider = createHttpBlobProvider<Clip>({
      baseUrl: '/api/kodokan/clips',
      contentFields: ['clip'],
      fetch: backend.fetch,
      writeMethod: 'POST',
    });

    await provider.setContent!('x.mp4', 'clip', 'bytes');
    expect(backend.calls[0].method).toBe('POST');
  });

  it('lets contentTypeFor override the inferred Content-Type', async () => {
    const backend = createMockBlobBackend();
    const provider = createHttpBlobProvider<Clip>({
      baseUrl: '/api/kodokan/clips',
      contentFields: ['clip'],
      fetch: backend.fetch,
      contentTypeFor: (id) => (id.endsWith('.mp4') ? 'video/mp4' : undefined),
    });

    const ref = await provider.setContent!('x.mp4', 'clip', new Uint8Array([1, 2, 3]));
    expect(backend.calls[0].headers['content-type']).toBe('video/mp4');
    expect(ref.mimeType).toBe('video/mp4');

    await provider.setContent!('notes.txt', 'clip', 'plain text');
    expect(backend.calls[1].headers['content-type']).toBe('text/plain');
  });

  it('round-trips setContent → getContent', async () => {
    const backend = createMockBlobBackend();
    const provider = createHttpBlobProvider<Clip>({
      baseUrl: '/api/kodokan/clips',
      contentFields: ['clip'],
      fetch: backend.fetch,
    });

    await provider.setContent!('x.mp4', 'clip', new Uint8Array([7, 8, 9]));
    const bytes = (await provider.getContent!('x.mp4', 'clip')) as Uint8Array;
    expect([...bytes]).toEqual([7, 8, 9]);
  });
});

describe('createHttpBlobProvider — DataProvider surface', () => {
  it('getList is empty — the metadata provider does the listing', async () => {
    const backend = createMockBlobBackend({ '/api/kodokan/clips/x.mp4': 'bytes' });
    const provider = createHttpBlobProvider<Clip>({
      baseUrl: '/api/kodokan/clips',
      contentFields: ['clip'],
      fetch: backend.fetch,
    });

    expect(await provider.getList({})).toEqual({ data: [], total: 0 });
  });

  it('create/getOne round-trip content fields and ignore metadata fields', async () => {
    const backend = createMockBlobBackend();
    const provider = createHttpBlobProvider({
      baseUrl: '/api/docs/blobs',
      contentFields: ['attachment', 'thumbnail'],
      fetch: backend.fetch,
    });

    await provider.create({
      id: '42',
      attachment: 'the doc',
      thumbnail: 'the thumb',
      title: 'ignored metadata',
    } as never);

    expect([...backend.blobs.keys()].sort()).toEqual([
      '/api/docs/blobs/42/attachment',
      '/api/docs/blobs/42/thumbnail',
    ]);

    const item = (await provider.getOne('42')) as Record<string, unknown>;
    expect(item.id).toBe('42');
    expect(decode(item.attachment)).toBe('the doc');
    expect(decode(item.thumbnail)).toBe('the thumb');
  });

  it('getOne tolerates a content field that was never uploaded', async () => {
    const backend = createMockBlobBackend();
    const provider = createHttpBlobProvider({
      baseUrl: '/api/docs/blobs',
      contentFields: ['attachment', 'thumbnail'],
      fetch: backend.fetch,
    });

    await provider.create({ id: '42', attachment: 'only this' } as never);
    const item = (await provider.getOne('42')) as Record<string, unknown>;
    expect(decode(item.attachment)).toBe('only this');
    expect(item.thumbnail).toBeUndefined();
  });

  it('delete removes every content field of an item', async () => {
    const backend = createMockBlobBackend();
    const provider = createHttpBlobProvider({
      baseUrl: '/api/docs/blobs',
      contentFields: ['attachment', 'thumbnail'],
      fetch: backend.fetch,
    });

    await provider.create({ id: '42', attachment: 'a', thumbnail: 't' } as never);
    await provider.delete('42');
    expect(backend.blobs.size).toBe(0);
  });

  it('deleteMany removes several items', async () => {
    const backend = createMockBlobBackend();
    const provider = createHttpBlobProvider<Clip>({
      baseUrl: '/api/kodokan/clips',
      contentFields: ['clip'],
      fetch: backend.fetch,
    });

    await provider.create({ id: 'a.mp4', clip: 'a' } as never);
    await provider.create({ id: 'b.mp4', clip: 'b' } as never);
    await provider.deleteMany(['a.mp4', 'b.mp4']);
    expect(backend.blobs.size).toBe(0);
  });

  it('reports capabilities, including the content fields it manages', async () => {
    const backend = createMockBlobBackend();
    const provider = createHttpBlobProvider<Clip>({
      baseUrl: '/api/kodokan/clips',
      contentFields: ['clip'],
      fetch: backend.fetch,
    });

    const caps = provider.getCapabilities!();
    expect(caps.canCreate).toBe(true);
    expect(caps.canUpsert).toBe(false);
    expect(caps.serverFilter).toBe(false);
    expect(caps.serverSort).toBe(false);
    expect(caps.contentFields).toEqual(['clip']);
  });
});
