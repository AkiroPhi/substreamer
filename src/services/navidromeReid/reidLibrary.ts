/**
 * Discard the server-owned library so the normal sync refills it.
 *
 * The library is the one part of the local database that the server can rebuild, so it is
 * cheaper to throw away than to re-key: doing so removes the whole entity-cluster surface
 * — songs, albums, artists, playlists and their two dozen child tables — from the pass.
 *
 * NOT `resetNormalizedSchema`. That drops every `MODEL_TABLES` entry, and three of them are
 * user-authored with no server copy: the bookmark snapshot family, `mbid_overrides` and
 * `scrobble_exclusions`. Its own docblock also says boot must never call it, and it is
 * synchronous. So this keeps its own list.
 */

import { MODEL_TABLES } from '../../db/createNormalizedTables';
import { awaitDbWritesIdle } from '../../db/client';
import { syncStatusStore } from '../../store/syncStatusStore';
import type { BatchCommand, InternalDb } from '../../store/persistence/db';

/**
 * `MODEL_TABLES` members that must survive.
 *
 * Bookmarks, MBID corrections and scrobble exclusions are in `MODEL_TABLES` because
 * LOGOUT should drop them — that assumes you may be switching servers. A re-key is the
 * same server, so they are re-keyed instead.
 */
const KEEP: ReadonlySet<string> = new Set([
  'queue_snapshots',
  'queue_snapshot_songs',
  'queue_snapshot_song_genres',
  'queue_snapshot_song_artists',
  'queue_snapshot_song_album_artists',
  'queue_snapshot_song_contributors',
  'queue_snapshot_song_moods',
  'mbid_overrides',
  'scrobble_exclusions',
]);

/** The tables this pass empties. */
export function libraryTablesToClear(): string[] {
  return MODEL_TABLES.filter((t) => !KEEP.has(t));
}

/**
 * Empty the library and reset the sync so it refills.
 *
 * `DELETE FROM` rather than `DROP` + recreate: it needs no schema rebuild, it leaves every
 * index and trigger in place, and FK cascades do most of the work anyway. Deferred FKs
 * because the deletes span parents and children in one batch.
 *
 * Resetting the sync state is not optional. `needsLibraryFetch` requires
 * `!librarySyncComplete || !songSyncComplete || rowCount === 0`; emptying the tables alone
 * satisfies the row count, but leaving the completion flags set means the walk resumes
 * from a cursor into an ordering that no longer exists. `resetLibrarySync` /
 * `resetSongSync` clear the flags, the cursors and the strategy together.
 */
export async function discardLibrary(db: InternalDb): Promise<number> {
  const tables = libraryTablesToClear();
  const present = new Set(
    (
      await db.getAllAsync<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )
    ).map((r) => r.name),
  );

  const commands: BatchCommand[] = [['PRAGMA defer_foreign_keys = ON', []]];
  let cleared = 0;
  for (const table of tables) {
    if (!present.has(table)) continue;
    commands.push([`DELETE FROM "${table}"`, []] as BatchCommand);
    cleared++;
  }

  // The pool must be idle: a batch's savepoint being open elsewhere would make this fail.
  await awaitDbWritesIdle();
  await db.runAtomicBatchAsync(commands);

  syncStatusStore.getState().resetLibrarySync();
  syncStatusStore.getState().resetSongSync();
  // `resetSongSync` already clears `notFoundAlbumIds`, but neither reset touches the
  // newest-album watermark, and it holds an id the server has retired. Cleared HERE, in
  // the same breath as the resets, rather than in `reidKv`: that module edits the
  // persisted blob directly, and these two `set` calls have their own write to the same
  // key in flight, so whichever landed second won. `dataSyncService` only compares the
  // watermark for inequality, so a null reads as "changed" and the refill runs anyway.
  syncStatusStore.setState({ lastKnownNewestAlbumId: null });

  return cleared;
}
