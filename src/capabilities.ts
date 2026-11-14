/**
 * What `createHttpProvider` reports before the caller declares anything the server
 * does: a dumb endpoint, every query step done client-side. Its `capabilities`
 * option is merged over this.
 *
 * A module of its own so the provider descriptor can describe capabilities
 * without importing the provider.
 */

import type { ProviderCapabilities } from '@zodal/store';

export const CLIENT_SIDE_DEFAULTS: ProviderCapabilities = {
  canCreate: true,
  canUpdate: true,
  canDelete: true,
  // `updateMany`/`deleteMany` are N requests, not a bulk endpoint — but they work,
  // so the UI is right to offer bulk actions.
  canBulkUpdate: true,
  canBulkDelete: true,
  canUpsert: false,
  serverSort: false,
  serverFilter: false,
  serverSearch: false,
  serverPagination: false,
};
