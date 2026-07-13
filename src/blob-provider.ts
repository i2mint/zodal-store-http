/**
 * HTTP Blob Provider: content-only storage served over HTTP — the URL half of zodal.
 *
 * Your backend already serves the bytes (`GET /api/kodokan/clips/osoto-gari.mp4`). This
 * provider makes that endpoint a `DataProvider` content half, so a collection can address
 * its media through zodal instead of through hand-built URL strings scattered across
 * components.
 *
 * **`getUrl()` is the point.** It returns a plain URL string a browser can put straight
 * into `<video src>` — so HTTP range requests survive, and the video streams and seeks
 * instead of being downloaded whole into memory (which is what `getContent()` would do).
 *
 * It is also the seam that survives a storage migration. Today `getUrl('osoto-gari.mp4',
 * 'clip')` answers `/api/kodokan/clips/osoto-gari.mp4`; swap this provider for
 * `createS3BlobProvider({ publicBaseUrl })` and the same call answers
 * `https://bucket.s3.../osoto-gari.mp4`. The components never learn that the bytes moved.
 *
 * Reads may be redirected away from the backend (`publicBaseUrl` / `urlFor` — a CDN, a
 * bucket, a presigner). **Writes always go to `baseUrl`**: you cannot `PUT` to a CDN.
 *
 * @example
 * ```typescript
 * import { createBifurcatedProvider } from '@zodal/store';
 * import { createHttpProvider, createHttpBlobProvider } from '@zodal/store-http';
 *
 * const provider = createBifurcatedProvider({
 *   metadataProvider: createHttpProvider({ baseUrl: '/api/kodokan/techniques' }),
 *   contentProvider: createHttpBlobProvider({
 *     baseUrl: '/api/kodokan/clips',
 *     contentFields: ['clip'],
 *     init: { credentials: 'include' },
 *   }),
 *   contentFields: ['clip'],
 * });
 *
 * videoEl.src = (await provider.getUrl!('osoto-gari.mp4', 'clip'))!;
 * ```
 */

import type { ContentRef } from '@zodal/core';
import type {
  DataProvider,
  GetListResult,
  ProviderCapabilities,
} from '@zodal/store';
import {
  httpRequest,
  joinUrl,
  resolveFetch,
  toRequestBody,
  type FetchLike,
} from './http.js';

export interface HttpBlobProviderOptions {
  /**
   * The content endpoint base — where your backend serves (and accepts) the bytes.
   * E.g. `/api/kodokan/clips`.
   */
  baseUrl: string;
  /** Content field names this provider manages. */
  contentFields: string[];
  /** Field used as unique identifier. Default: `'id'`. */
  idField?: string;
  /** `fetch` implementation. Default: `globalThis.fetch`. Inject to mock or wrap. */
  fetch?: FetchLike;
  /** Base `RequestInit` for every request — headers, `credentials: 'include'`, `signal`. */
  init?: RequestInit;
  /**
   * Serve reads from somewhere other than `baseUrl` — a CDN origin, a public bucket.
   *
   * `getUrl()` (and therefore `getContent()`) then resolves against this instead:
   * `${publicBaseUrl}/{contentPath}`. Writes still go to `baseUrl`.
   */
  publicBaseUrl?: string;
  /**
   * Full control over read-URL resolution. May be async — presigning is a round-trip.
   * Takes precedence over `publicBaseUrl`.
   */
  urlFor?: (id: string, field: string) => string | Promise<string>;
  /** HTTP method used to write content. Default: `'PUT'`. */
  writeMethod?: 'PUT' | 'POST';
  /**
   * Override the `Content-Type` sent when writing. Return `undefined` to keep the
   * inferred one (`application/octet-stream` for bytes, `text/plain` for strings,
   * `application/json` otherwise). Useful when the id carries the real type:
   * `contentTypeFor: (id) => (id.endsWith('.mp4') ? 'video/mp4' : undefined)`.
   */
  contentTypeFor?: (id: string, field: string, content: unknown) => string | undefined;
}

export function createHttpBlobProvider<T extends Record<string, any>>(
  options: HttpBlobProviderOptions,
): DataProvider<T> {
  const { baseUrl, contentFields, init, publicBaseUrl, urlFor, contentTypeFor } = options;
  const idField = options.idField ?? 'id';
  const writeMethod = options.writeMethod ?? 'PUT';
  const doFetch = resolveFetch(options.fetch);
  const contentSet = new Set(contentFields);

  /**
   * The path rule, and it is the only one:
   * - **one** content field  → `{base}/{id}`        (`/api/kodokan/clips/osoto-gari.mp4`)
   * - **many** content fields → `{base}/{id}/{field}` (`/api/docs/blobs/42/thumbnail`)
   *
   * With a single content field the field name carries no information, and a URL that
   * ends in the id — extension and all — is what a `<video>`, a CDN and a human all want.
   * Reads and writes both use this path, against `publicBaseUrl`/`urlFor` and `baseUrl`
   * respectively.
   */
  function contentSegments(id: string, field: string): string[] {
    return contentFields.length === 1 ? [id] : [id, field];
  }

  function assertContentField(field: string): void {
    if (!contentSet.has(field)) {
      throw new Error(
        `'${field}' is not a content field of this provider ` +
          `(content fields: ${contentFields.join(', ') || 'none'})`,
      );
    }
  }

  /** Where the bytes are *read* from: `urlFor` > `publicBaseUrl` > `baseUrl`. */
  async function readUrl(id: string, field: string): Promise<string> {
    if (urlFor) return await urlFor(id, field);
    const base = publicBaseUrl ?? baseUrl;
    return joinUrl(base, ...contentSegments(id, field));
  }

  /** Where the bytes are *written* to. Always the backend — you cannot PUT to a CDN. */
  function writeUrl(id: string, field: string): string {
    return joinUrl(baseUrl, ...contentSegments(id, field));
  }

  async function putBlob(id: string, field: string, content: unknown): Promise<ContentRef> {
    const { body, contentType } = toRequestBody(content);
    const mimeType = contentTypeFor?.(id, field, content) ?? contentType;
    await httpRequest(doFetch, {
      method: writeMethod,
      url: writeUrl(id, field),
      init,
      body,
      headers: { 'Content-Type': mimeType },
    });
    return {
      _tag: 'ContentRef',
      field,
      itemId: id,
      url: await readUrl(id, field),
      mimeType,
      ...(content instanceof Uint8Array ? { size: content.byteLength } : {}),
    };
  }

  async function getBlob(id: string, field: string): Promise<Uint8Array> {
    const response = await httpRequest(doFetch, {
      method: 'GET',
      url: await readUrl(id, field),
      init,
    });
    return new Uint8Array(await response.arrayBuffer());
  }

  async function deleteBlob(id: string, field: string): Promise<void> {
    try {
      await httpRequest(doFetch, { method: 'DELETE', url: writeUrl(id, field), init });
    } catch {
      // swallow — the blob may never have existed
    }
  }

  async function writeContentFields(id: string, data: Record<string, unknown>): Promise<void> {
    for (const [field, value] of Object.entries(data)) {
      if (contentSet.has(field) && value !== undefined) {
        await putBlob(id, field, value);
      }
    }
  }

  return {
    async getList(): Promise<GetListResult<T>> {
      // Content-only provider — the metadata provider does the listing.
      return { data: [], total: 0 };
    },

    async getOne(id: string): Promise<T> {
      const result: Record<string, unknown> = { [idField]: id };
      for (const field of contentFields) {
        try {
          result[field] = await getBlob(id, field);
        } catch {
          // Field may not have been stored yet.
        }
      }
      return result as T;
    },

    async create(data: Partial<T>): Promise<T> {
      const id = String(data[idField]);
      await writeContentFields(id, data as Record<string, unknown>);
      return { [idField]: id } as unknown as T;
    },

    async update(id: string, data: Partial<T>): Promise<T> {
      await writeContentFields(id, data as Record<string, unknown>);
      return { [idField]: id } as unknown as T;
    },

    async updateMany(ids: string[], data: Partial<T>): Promise<T[]> {
      return Promise.all(
        ids.map(async (id) => {
          await writeContentFields(id, data as Record<string, unknown>);
          return { [idField]: id } as unknown as T;
        }),
      );
    },

    async delete(id: string): Promise<void> {
      for (const field of contentFields) {
        await deleteBlob(id, field);
      }
    },

    async deleteMany(ids: string[]): Promise<void> {
      await Promise.all(ids.map((id) => this.delete(id)));
    },

    getCapabilities(): ProviderCapabilities {
      return {
        canCreate: true,
        canUpdate: true,
        canDelete: true,
        canBulkUpdate: true,
        canBulkDelete: true,
        canUpsert: false,
        serverSort: false,
        serverFilter: false,
        serverSearch: false,
        serverPagination: false,
        bifurcated: false,
        contentFields: [...contentFields],
      };
    },

    /**
     * The headline method: a plain URL string for `<video src>` / `<img src>` /
     * `<a download>`. Range requests intact, so the browser streams and seeks.
     *
     * Never `null` here — an HTTP backend can *always* name a URL for its own bytes.
     * That is the entire reason this adapter exists.
     */
    async getUrl(id: string, field: string): Promise<string | null> {
      assertContentField(field);
      return readUrl(id, field);
    },

    /**
     * The bytes themselves. Correct for "read this file and process it"; wrong for
     * anything the browser renders by URL — use `getUrl()` there.
     */
    async getContent(id: string, field: string): Promise<unknown> {
      assertContentField(field);
      return getBlob(id, field);
    },

    async setContent(id: string, field: string, content: unknown): Promise<ContentRef> {
      assertContentField(field);
      return putBlob(id, field, content);
    },
  };
}
