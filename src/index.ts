/**
 * @zodal/store-http — fetch-based DataProvider adapters for a REST backend.
 *
 * - `createHttpProvider` — full REST CRUD (the metadata half).
 * - `createHttpBlobProvider` — content served over HTTP, with `getUrl()` (the blob half).
 */

// Full REST CRUD provider
export { createHttpProvider, WriteConflictError } from './provider.js';
export type { HttpProviderOptions, HttpVersionedMethods } from './provider.js';

// Blob-only provider: content addressed by URL, for bifurcation or standalone use
export { createHttpBlobProvider } from './blob-provider.js';
export type { HttpBlobProviderOptions, UploadTarget, ContentWriteOptions } from './blob-provider.js';

// HTTP plumbing (injectable fetch, informative errors)
export { HttpError } from './http.js';
export type { FetchLike } from './http.js';
