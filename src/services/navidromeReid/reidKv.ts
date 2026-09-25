/**
 * Re-key the entity ids held in KV blobs rather than in tables.
 *
 * Only three keys still matter here. The blobs that migrations 34-42 convert are read and
 * then REMOVED by those migrations, and the pass runs after the chain — so by the time we
 * get here their data lives in tables and is re-keyed with everything else.
 *
 *   substreamer-ratings       keys are entity ids, and no table ever took this over
 *   substreamer-sync-status   notFoundAlbumIds + lastKnownNewestAlbumId, plus cursors
 *   substreamer-album-lists   a stale blob from a pre-normalized install; cleared
 */

import { canonicalId } from './canonicalId';
import { kvStorage } from '../../store/persistence';

const RATINGS_KEY = 'substreamer-ratings';
const SYNC_STATUS_KEY = 'substreamer-sync-status';
const ALBUM_LISTS_KEY = 'substreamer-album-lists';

/** Zustand's persist envelope. Fields we do not touch must survive untouched. */
interface PersistBlob {
  state?: Record<string, unknown>;
  version?: number;
}

async function readBlob(key: string): Promise<PersistBlob | null> {
  try {
    const raw = await kvStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistBlob;
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    // A corrupt blob is left exactly as it is: the store already has to cope with it, and
    // rewriting it during a migration would turn a degraded state into a lost one.
    return null;
  }
}

/** Canonical form, or undefined when the id does not move. */
function moved(id: string): string | undefined {
  const next = canonicalId(id);
  return next === id ? undefined : next;
}

/** Re-key the keys of an id-keyed record, leaving its values alone. */
function rekeyRecordKeys(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[moved(key) ?? key] = value;
  }
  return out;
}

/**
 * Rewrite the user's per-entity rating overrides.
 *
 * User-authored with no server copy — a rating the user set by hand is not recoverable
 * from anywhere — and the only one of the three where the ids are the KEYS.
 */
async function rekeyRatings(): Promise<void> {
  const blob = await readBlob(RATINGS_KEY);
  const overrides = blob?.state?.overrides;
  if (!blob || typeof overrides !== 'object' || overrides === null) return;
  const next = rekeyRecordKeys(overrides as Record<string, unknown>);
  await kvStorage.setItem(
    RATINGS_KEY,
    JSON.stringify({ ...blob, state: { ...blob.state, overrides: next } }),
  );
}

/**
 * Re-key the sync bookkeeping, and clear the cursors.
 *
 * `notFoundAlbumIds` and `lastKnownNewestAlbumId` are entity ids and move like any other.
 * The cursors do NOT move: base62 re-encoding reorders ids arbitrarily, so a keyset cursor
 * into the old ordering points somewhere meaningless in the new one. Clearing them makes
 * the next sync start from the beginning, which is what an affected install wants anyway.
 */
async function rekeySyncStatus(): Promise<void> {
  const blob = await readBlob(SYNC_STATUS_KEY);
  if (!blob?.state) return;
  const state = { ...blob.state };

  if (Array.isArray(state.notFoundAlbumIds)) {
    state.notFoundAlbumIds = (state.notFoundAlbumIds as unknown[]).map(
      (id) => (typeof id === 'string' ? moved(id) ?? id : id),
    );
  }
  if (typeof state.lastKnownNewestAlbumId === 'string') {
    state.lastKnownNewestAlbumId = moved(state.lastKnownNewestAlbumId) ?? state.lastKnownNewestAlbumId;
  }
  state.librarySyncCursor = null;
  state.songSyncCursor = null;

  await kvStorage.setItem(SYNC_STATUS_KEY, JSON.stringify({ ...blob, state }));
}

/**
 * Drop the stale home-screen lists.
 *
 * On a pre-normalized install this blob holds four full `AlbumID3` arrays; on the current
 * schema the lists live in `album_list_entries` and the blob keeps only a timestamp.
 * Either way it is a cache of `getAlbumList2` that `refreshAllIfDue(0)` refills at the
 * next cold start, and under this plan its contents point at albums the database no longer
 * has. Clearing beats re-keying.
 */
async function clearAlbumLists(): Promise<void> {
  const blob = await readBlob(ALBUM_LISTS_KEY);
  if (!blob?.state) return;
  const state = { ...blob.state };
  for (const field of ['recentlyAdded', 'recentlyPlayed', 'frequentlyPlayed', 'randomSelection']) {
    if (field in state) state[field] = [];
  }
  state.lastRefreshedAt = 0;
  await kvStorage.setItem(ALBUM_LISTS_KEY, JSON.stringify({ ...blob, state }));
}

/** Re-key every KV blob that still holds entity ids. */
export async function rekeyKvBlobs(): Promise<void> {
  await rekeyRatings();
  await rekeySyncStatus();
  await clearAlbumLists();
}
