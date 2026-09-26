/**
 * Move downloaded audio onto its re-keyed paths.
 *
 * A downloaded song lives at `{music-cache}/{album_id}/{song_id}.{suffix}`
 * (`src/services/musicCacheService.ts:183-188`), so BOTH path components are entity ids
 * and both move with the re-key. This is the only part of the pass that touches the
 * filesystem, and the only part that cannot be rolled back by a transaction.
 *
 * It runs AFTER the database commits, which is why the marker exists: the app must not
 * launch in between. `reconcileMusicCacheAsync` reads the music-cache store rather than
 * SQL (`musicCacheService.ts:512-515, 522-527`), so a launch with the rows re-keyed and
 * the files not yet moved would see every file as an orphan under an unreferenced
 * directory and delete the lot.
 *
 * Idempotent: a file already at its destination is skipped, so a resumed run simply
 * finishes what the interrupted one started.
 */

import { Directory, File, Paths } from 'expo-file-system';

import { deleteDirectoryAsync, listDirectoryAsync } from 'expo-async-fs';
import { CACHE_DIR_NAME, UNKNOWN_ALBUM_ID } from '../musicCacheService';
import { loadIdMap } from './reidMap';
import type { InternalDb } from '../../store/persistence/db';

/**
 * Imported rather than duplicated: this module reconstructs paths that
 * `musicCacheService` owns, and a silent drift between the two would move files to a
 * directory nothing reads. `UNKNOWN_ALBUM_ID` is the bucket a song with no album id falls
 * into — a literal, not an entity id, so it never moves and is never swept.
 */

/** Rows read per chunk while walking the downloads. */
const CHUNK = 200;

export interface FileMoveResult {
  moved: number;
  missing: number;
  failed: number;
}

/**
 * Move every downloaded file from its old-id path to its new-id path.
 *
 * Reads the re-keyed rows and works BACKWARDS through the map to find where each file
 * used to be. Doing it the other way round — reading old ids and computing new ones —
 * would need the pre-re-key state, which no longer exists by the time this runs.
 */
export async function moveDownloadedFiles(
  db: InternalDb,
  onProgress?: (done: number, total: number) => void,
): Promise<FileMoveResult> {
  const map = await loadIdMap(db);
  if (map.size === 0) return { moved: 0, missing: 0, failed: 0 };

  // new id -> old id. The map is injective in practice (distinct 128-bit values encode to
  // distinct strings), and a collision would only mean we look in the wrong old place and
  // record the file as missing, never that we move the wrong file.
  const toOld = new Map<string, string>();
  for (const [oldId, newId] of map) toOld.set(newId, oldId);

  const root = new Directory(Paths.document, CACHE_DIR_NAME);
  if (!root.exists) return { moved: 0, missing: 0, failed: 0 };

  const totalRow = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM cached_songs');
  const total = totalRow?.n ?? 0;
  const result: FileMoveResult = { moved: 0, missing: 0, failed: 0 };
  const touchedOldDirs = new Set<string>();
  let seen = 0;
  let after = '';

  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await db.getAllAsync<{ song_id: string; album_id: string; suffix: string }>(
      'SELECT song_id, album_id, suffix FROM cached_songs WHERE song_id > ? '
      + 'ORDER BY song_id LIMIT ?',
      [after, CHUNK],
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      const newAlbum = row.album_id || UNKNOWN_ALBUM_ID;
      const oldAlbum = toOld.get(newAlbum) ?? newAlbum;
      const oldSong = toOld.get(row.song_id) ?? row.song_id;
      if (oldAlbum === newAlbum && oldSong === row.song_id) continue;

      const from = new File(new Directory(root, oldAlbum), `${oldSong}.${row.suffix}`);
      const toDir = new Directory(root, newAlbum);
      const to = new File(toDir, `${row.song_id}.${row.suffix}`);

      try {
        if (to.exists) continue; // a resumed run already moved this one
        if (!from.exists) { result.missing++; continue; }
        if (!toDir.exists) toDir.create();
        // eslint-disable-next-line no-await-in-loop
        await from.move(to);
        result.moved++;
        if (oldAlbum !== newAlbum) touchedOldDirs.add(oldAlbum);
      } catch {
        // Best-effort per file: one failure must not abandon the rest, and the row still
        // points at a path the reconcile will later notice is empty.
        result.failed++;
      }
    }

    after = rows[rows.length - 1].song_id;
    seen += rows.length;
    onProgress?.(seen, total);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }

  await removeEmptiedAlbumDirs(root, touchedOldDirs);
  return result;
}

/**
 * Delete the old album directories we emptied.
 *
 * Only ones this pass actually moved files out of, and only when they are genuinely empty
 * — a directory still holding something is left alone, because the something is a file we
 * failed to move or never knew about, and deleting it would destroy a download.
 *
 * The `_unknown` skip is belt-and-braces rather than a live branch: the bucket is a
 * literal, never an entry in the id map, so a song in it always has `oldAlbum ===
 * newAlbum` and the directory never reaches this set. It stays because the operation
 * guarded is an unrecoverable delete of a user's downloads.
 */
async function removeEmptiedAlbumDirs(root: Directory, dirs: Set<string>): Promise<void> {
  for (const name of dirs) {
    if (name === UNKNOWN_ALBUM_ID) continue;
    const dir = new Directory(root, name);
    try {
      if (!dir.exists) continue;
      // eslint-disable-next-line no-await-in-loop
      const remaining = await listDirectoryAsync(dir.uri);
      if (Array.isArray(remaining) && remaining.length === 0) {
        // eslint-disable-next-line no-await-in-loop
        await deleteDirectoryAsync(dir.uri);
      }
    } catch {
      /* best-effort tidy-up; an orphaned empty directory costs nothing */
    }
  }
}
