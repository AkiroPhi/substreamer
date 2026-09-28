/**
 * The ETL must never run alongside the Navidrome re-key.
 *
 * Its own file because the main suite leaves module state behind — a deferred re-call
 * can register an in-flight sync after that suite's reset, and the ETL then defers
 * behind it. A fresh module registry per file is the cheapest way to test this
 * honestly rather than fighting someone else's leak.
 */
import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { countAlbums } from '../../db/repository/albums';
import { countSongs } from '../../db/repository/songs';
import { getDb } from '../../store/persistence/db';
import { createLegacyBlobTables } from '../../test-utils/legacyBlobTables';
import { migrationGateStore } from '../../store/migrationGateStore';
import { clearReidMarker, setReidState } from '../navidromeReid/reidMarker';
import { runDataModelUpgradeIfNeeded } from '../dataModelUpgradeService';
import { LATEST_MIGRATION_ID } from '../migrationService';

const db = () => getDb()!;

beforeEach(() => {
  ensureNormalizedSchema(db());
  createLegacyBlobTables(db());
  for (const t of ['library_albums', 'song_index', 'albums', 'songs']) db().runSync(`DELETE FROM ${t}`);
  db().runSync("DELETE FROM storage WHERE key = 'substreamer-normalized-migration-complete'");
  db().runSync("INSERT OR REPLACE INTO storage (key, value) VALUES ('substreamer-migration', ?)", [
    JSON.stringify({ state: { completedVersion: LATEST_MIGRATION_ID }, version: 0 }),
  ]);
  db().runSync('INSERT OR REPLACE INTO library_albums (id, sortKey, raw_json) VALUES (?, ?, ?)', [
    'al1', 'al1',
    JSON.stringify({ id: 'al1', name: 'al1', created: '2020-01-01', duration: 1, songCount: 1 }),
  ]);
  db().runSync('INSERT OR REPLACE INTO song_index (id, albumId, raw_json) VALUES (?, ?, ?)', [
    's1', 'al1', JSON.stringify({ id: 's1', albumId: 'al1', title: 's1', isDir: false }),
  ]);
  migrationGateStore.getState().reset();
  clearReidMarker();
});

describe('the ETL and the re-key never overlap', () => {
  it('imports normally when the gate is down', async () => {
    await runDataModelUpgradeIfNeeded();
    expect(await countAlbums(db())).toBeGreaterThan(0);
  });

  // Its writes carry `fromMigration`, which bypasses the library-write guard by design.
  // Running while the pass discards the library leaves canonical rows polluted with
  // retired ids and no automatic recovery.
  it('refuses to start while the migration gate is up', async () => {
    migrationGateStore.getState().show('working');

    await runDataModelUpgradeIfNeeded();

    expect(await countAlbums(db())).toBe(0);
    expect(await countSongs(db())).toBe(0);
  });

  // A completed re-key means the library is canonical and the blobs hold retired ids.
  // Re-importing would undo the pass — which a future MIGRATION_VERSION bump would
  // otherwise do on an already-re-keyed install.
  it('does not re-import legacy blobs once the re-key has completed', async () => {
    setReidState('complete');

    await runDataModelUpgradeIfNeeded();

    expect(await countAlbums(db())).toBe(0);
  });
});
