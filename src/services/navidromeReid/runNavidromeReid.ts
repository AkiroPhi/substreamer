/**
 * The Navidrome 0.64 id re-key, start to finish.
 *
 * Runs behind the blocking interstitial, before the app launches. That placement is what
 * makes the rest simple: `_layout`'s startup effects are gated on the same flag, so
 * nothing is racing this — no pause flag threaded through the services, no writes to
 * refuse, no half-live app to defend against.
 *
 * Ordering is not arbitrary:
 *
 *   1. the FK-deferral self-check, before anything is written
 *   2. the live queue, cleared so a queue of retired ids is never restored
 *   3. the id map
 *   4. the database — plain columns, then duplicates, then embedded ids
 *   5. the files, which cannot be rolled back and so go last among the writes
 *   6. the stores, which still hold old ids in memory until they are rehydrated
 *   7. the marker, only once every step above has succeeded
 *
 * The marker is the only thing that stops this running again, and it is stamped last on
 * purpose: an interrupted run re-enters the interstitial on the next launch and repeats
 * from the top. Every step is idempotent, so repeating is free.
 */

import {
  cancelImageRefreshCycle,
  clearImageCache,
  enqueueImageRefreshCycle,
} from '../imageCacheService';
import { logLibrarySync } from '../librarySyncLogger';
import { migrationGateStore } from '../../store/migrationGateStore';
import { rebuildTrackMaps } from '../musicCacheService';
import { rehydrateAllStores } from '../../store/persistence/rehydrate';
import { ratingStore } from '../../store/ratingStore';
import { getDb } from '../../store/persistence/db';
import { buildIdMap, createIdMap, dropIdMap, idMapSize } from './reidMap';
import { moveDownloadedFiles } from './reidFiles';
import { reidVerdict, setReidState } from './reidMarker';
import {
  deleteSupersededRows,
  rekeyEmbeddedIds,
  rekeyPlainColumns,
  verifyDeferredForeignKeys,
} from './reidRekey';

let inFlight: Promise<void> | null = null;

/**
 * Run the pass if this install needs it.
 *
 * Safe to call on every launch: it returns immediately when the marker says complete, the
 * server is not affected, or a run is already going. When the server's version cannot
 * settle the question it shows the interstitial in `asking` mode instead and returns —
 * the user's answer triggers a fresh call.
 */
export function runNavidromeReidIfNeeded(): Promise<void> {
  if (inFlight) return inFlight;

  const verdict = reidVerdict();
  if (verdict === 'skip') return Promise.resolve();
  if (verdict === 'ask') {
    migrationGateStore.getState().show('asking');
    return Promise.resolve();
  }

  inFlight = execute().finally(() => { inFlight = null; });
  return inFlight;
}

async function execute(): Promise<void> {
  const gate = migrationGateStore.getState();
  const db = getDb();
  if (!db) {
    // No database means nothing to re-key and nothing we could safely stamp.
    logLibrarySync('[reid] no database — deferring to the next launch');
    return;
  }

  gate.show('working');
  gate.beginStage('preparing');
  setReidState('pending');

  try {
    // Prove the deferral works on THIS build before writing anything. The spike that
    // justified the design ran a different SQLite; if a future op-SQLite bump ever changes
    // the behaviour, the pass must refuse rather than corrupt.
    if (!(await verifyDeferredForeignKeys(db))) {
      logLibrarySync('[reid] deferred foreign keys unsupported — refusing to run');
      gate.fail();
      return;
    }

    await clearLiveQueue(db);
    await clearDownloadQueue(db);

    await createIdMap(db);
    const pairs = await buildIdMap(db);
    logLibrarySync(`[reid] map built: ${pairs} ids change`);

    if (pairs === 0 && (await idMapSize(db)) === 0) {
      // Already canonical — an install that re-synced, or one that joined after the
      // server migrated. Stamp and stop before clearing anything.
      await dropIdMap(db);
      setReidState('complete');
      gate.hide();
      logLibrarySync('[reid] nothing to do');
      return;
    }

    gate.beginStage('updatingDownloads');
    await rekeyPlainColumns(db);
    const superseded = await deleteSupersededRows(db);
    await rekeyEmbeddedIds(db, (done, total) => {
      if (gate.stages.updatingDownloads?.total !== total) {
        gate.beginStage('updatingDownloads', total);
      }
      gate.advanceStage('updatingDownloads', done);
    });
    logLibrarySync(`[reid] database re-keyed (${superseded} superseded rows removed)`);

    gate.beginStage('movingFiles');
    const files = await moveDownloadedFiles(db, (done, total) => {
      if (gate.stages.movingFiles?.total !== total) gate.beginStage('movingFiles', total);
      gate.advanceStage('movingFiles', done);
    });
    logLibrarySync(
      `[reid] files: ${files.moved} moved, ${files.missing} missing, ${files.failed} failed`,
    );

    gate.beginStage('refreshingArtwork');
    await refreshArtwork();

    gate.beginStage('finishing');
    // The stores still hold old ids in memory. Until they are rehydrated, any store-driven
    // write puts them straight back into SQL, and `reconcileMusicCacheAsync` — which reads
    // the store, not SQL — would treat every moved file as an orphan.
    await rehydrateAllStores();
    // `rehydrateAllStores` covers the row-backed stores only; its own header says the
    // kvStorage-backed ones are not included.
    await ratingStore.persist.rehydrate();
    await rebuildTrackMaps();

    await dropIdMap(db);
    setReidState('complete');
    gate.hide();
    logLibrarySync('[reid] complete');
  } catch (e) {
    // The marker stays `pending`, so the next launch re-enters the interstitial and
    // repeats from the top. Every step is idempotent, so that is safe.
    logLibrarySync(`[reid] failed: ${e instanceof Error ? e.message : String(e)}`);
    gate.fail();
  }
}

/**
 * Clear the saved player queue.
 *
 * A queue of retired ids is the symptom that started all of this — restoring one puts the
 * player straight into the failure the pass exists to fix. Bookmarks are deliberately not
 * touched: they are re-keyed like everything else.
 */
async function clearLiveQueue(db: ReturnType<typeof getDb>): Promise<void> {
  if (!db) return;
  await db.runAsync("DELETE FROM queue_snapshots WHERE id = 'live'");
}

/**
 * Empty the download queue.
 *
 * It holds work not yet done, so re-keying seven tables of it buys nothing the user
 * cannot get by queueing again. Completed downloads live in `cached_*` and are re-keyed.
 */
async function clearDownloadQueue(db: ReturnType<typeof getDb>): Promise<void> {
  if (!db) return;
  await db.runAsync('DELETE FROM download_queue');
}

/**
 * Clear the image cache and queue a re-warm for downloaded covers.
 *
 * `clearImageCache` alone is not enough: it deletes `cached_images` and nothing else, so
 * `image_download_queue` rows and the queue meta survive on retired ids — and a live
 * `cycleId` makes the re-warm return early as "cycle already active". `reinit: false`
 * because re-initialising re-arms a foreground subscription we do not want during the
 * pass.
 */
async function refreshArtwork(): Promise<void> {
  // Drop any in-flight cycle FIRST: it clears both the queue rows and the cycle metadata,
  // and a surviving `cycleId` would make the re-warm below return early as "cycle already
  // active", leaving downloaded covers blank.
  await cancelImageRefreshCycle();
  await clearImageCache({ reinit: false });
  // Snapshots from SQL, so it sees the re-keyed ids regardless of store state. It kicks
  // its own drain, which proceeds once the app is running.
  await enqueueImageRefreshCycle('refresh-downloads');
}
