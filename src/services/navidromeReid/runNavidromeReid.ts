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
import { flushLibrarySyncLog, logLibrarySync } from '../librarySyncLogger';
import { migrationGateStore } from '../../store/migrationGateStore';
import { rebuildTrackMaps } from '../musicCacheService';
import { rehydrateAllStores } from '../../store/persistence/rehydrate';
import { ratingStore } from '../../store/ratingStore';
import { syncStatusStore } from '../../store/syncStatusStore';
import { clearImageQueue } from '../../store/persistence/imageDownloadQueueTable';
import { getDb } from '../../store/persistence/db';
import { buildIdMap, createIdMap, dropIdMap, idMapSize } from './reidMap';
import { moveDownloadedFiles } from './reidFiles';
import { rekeyKvBlobs } from './reidKv';
import { discardLibrary } from './reidLibrary';
import { kvStorage } from '../../store/persistence';
import { reidVerdict, setReidState, setUserConfirmedReid } from './reidMarker';
import { MIGRATION_DONE_KEY, MIGRATION_VERSION } from '../normalizedMigrationKey';
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

/**
 * The user answered the `ask` prompt: their server is updated, run it.
 *
 * Their answer is persisted before the pass starts, so a kill mid-run does not put the
 * question back — the version string still cannot answer it and asking twice is worse
 * than remembering.
 */
export function confirmAndRunNavidromeReid(): Promise<void> {
  setUserConfirmedReid();
  migrationGateStore.getState().confirm();
  return runNavidromeReidIfNeeded();
}

/** Re-run after a failure, from the gate's retry button. */
export function retryNavidromeReid(): Promise<void> {
  migrationGateStore.getState().clearFailure();
  return runNavidromeReidIfNeeded();
}

async function execute(): Promise<void> {
  const gate = migrationGateStore.getState();
  gate.show('working');
  const db = getDb();
  if (!db) {
    // Show the gate FIRST and fail into it. Returning silently would let the app launch
    // with the marker still `pending` — and on a resumed run that means rows re-keyed,
    // files half-moved, and `reconcileMusicCacheAsync` reading the store and deleting
    // every moved file as an orphan.
    logLibrarySync('[reid] no database — cannot run');
    gate.fail();
    return;
  }

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

    // Only now that we know there IS work. Clearing these above the early exit destroyed
    // the saved queue and every queued download for anyone already canonical — a fresh
    // sign-in on 0.64, or anyone who had re-synced.
    //
    // The IMAGE queue goes with them, and up here rather than in `refreshArtwork`: every
    // row in it names a retired id, and `cancelImageRefreshCycle` only drops rows of the
    // ACTIVE cycle, so anything queued outside one would survive and be retried against
    // ids the server no longer has. Clearing before the cache is cleared also means the
    // re-warm enqueues into an empty queue, so none of its ids collide.
    // From here on the run writes. A failure after this point cannot be walked away from:
    // the database ends up re-keyed with files still at their old paths, and launching the
    // app into that lets `reconcileMusicCacheAsync` delete every download as an orphan.
    gate.markWritten();

    await clearLiveQueue(db);
    await clearDownloadQueue(db);
    await clearImageQueue();

    gate.beginStage('updatingDownloads');
    await rekeyPlainColumns(db);
    const superseded = await deleteSupersededRows(db);
    await rekeyEmbeddedIds(db, (done, total) => {
      // getState() each time: `gate` is a snapshot taken before any set(), so its
      // `stages` never changes and the guard below would always fire.
      const live = migrationGateStore.getState();
      if (live.stages.updatingDownloads?.total !== total) {
        live.beginStage('updatingDownloads', total);
      }
      live.advanceStage('updatingDownloads', done);
    });
    logLibrarySync(`[reid] database re-keyed (${superseded} superseded rows removed)`);

    gate.beginStage('movingFiles');
    const files = await moveDownloadedFiles(db, (done, total) => {
      const live = migrationGateStore.getState();
      if (live.stages.movingFiles?.total !== total) live.beginStage('movingFiles', total);
      live.advanceStage('movingFiles', done);
    });
    logLibrarySync(
      `[reid] files: ${files.moved} moved, ${files.missing} missing, ${files.failed} failed`,
    );
    // A file left at its old path has a row pointing at the new one, so the next
    // reconcile deletes it as an orphan. The move is idempotent, so failing here and
    // retrying next launch costs nothing and saves the track.
    if (files.failed > 0) throw new Error(`${files.failed} file(s) could not be moved`);

    // Discard the library and reset the sync. This has to happen BEFORE the stores
    // rehydrate and before `rebuildTrackMaps`: the track-map populate ends with a starred
    // sync that reads `favorite_songs` from SQL, and if those rows still held retired ids
    // while the store had just been rehydrated to canonical ones, the zero overlap would
    // tear down the whole starred download.
    const cleared = await discardLibrary(db);
    // Stamp the blob-to-SQL ETL complete, and PROVE it stuck.
    //
    // The pass has just discarded the library that ETL imports into, and the legacy blob
    // tables survive the migration chain — so if this key is missing afterwards the idle
    // orchestrator re-imports the entire pre-re-key library on top of the canonical one.
    // That is the doubled-library bug, and it is silent: `kvStorage.setItem` swallowed
    // its own failures, so the write could vanish while the pass reported success.
    //
    // Read back rather than trust the write. Failing here leaves the marker `pending`,
    // so the next launch re-runs an idempotent pass — which is strictly better than
    // completing into a library half in retired ids.
    await kvStorage.setItem(MIGRATION_DONE_KEY, MIGRATION_VERSION);
    const stamped = await kvStorage.getItem(MIGRATION_DONE_KEY);
    if (stamped !== MIGRATION_VERSION) {
      throw new Error(
        `ETL completion key did not persist (wrote "${MIGRATION_VERSION}", read "${stamped}")`,
      );
    }
    logLibrarySync(`[reid] library discarded (${cleared} tables) — one sync will refill it`);

    // The KV blobs that survive the migration chain. Done before the stores rehydrate, so
    // the rehydrate reads the corrected values rather than writing stale ones back.
    await rekeyKvBlobs();

    gate.beginStage('finishing');
    // The stores still hold old ids in memory. Until they are rehydrated, any store-driven
    // write puts them straight back into SQL, and `reconcileMusicCacheAsync` — which reads
    // the store, not SQL — would treat every moved file as an orphan.
    const rehydration = await rehydrateAllStores();
    if (rehydration.failed.some((f) => f.store === 'musicCache')) {
      // Without it `hasHydrated` stays false, the track maps build empty and never latch,
      // and every download reads as unavailable — with the marker already stamped.
      throw new Error('music cache failed to rehydrate');
    }
    // `rehydrateAllStores` covers the row-backed stores only; its own header says the
    // kvStorage-backed ones are not included, and both of these hold re-keyed ids.
    await ratingStore.persist.rehydrate();
    await syncStatusStore.persist.rehydrate();
    await rebuildTrackMaps();

    // AFTER the rehydrate, not before. `downloadedCoverArtIds()` reads `musicCacheStore`,
    // and that set is the downloaded-item exemption in `purgeCoverArtRows` — run against
    // stale pre-re-key state, a failed download during the re-warm could purge a
    // downloaded item's cover rows with its protection silently inactive.
    gate.beginStage('refreshingArtwork');
    await refreshArtwork();

    await dropIdMap(db);
    setReidState('complete');
    logLibrarySync('[reid] complete');
    // Buffered behind a 2s timer and nothing wires a flush to AppState, so without this
    // the lines explaining a run are exactly the ones an app kill loses.
    await flushLibrarySyncLog();
    gate.complete();
  } catch (e) {
    // The marker stays `pending`, so the next launch re-enters the interstitial and
    // repeats from the top. Every step is idempotent, so that is safe.
    logLibrarySync(`[reid] failed: ${e instanceof Error ? e.message : String(e)}`);
    await flushLibrarySyncLog();
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
