/**
 * Real SQL, via the in-memory better-sqlite3 adapter the op-SQLite mock is backed by.
 *
 * These exercise the part of the pass that cannot be reasoned about on paper: whether a
 * parent-key update with orphaned children survives to COMMIT under
 * `PRAGMA defer_foreign_keys`, and whether the duplicate policy actually holds.
 */

import { ensureNormalizedSchema } from '../../../db/createNormalizedTables';
import { getDb } from '../../../store/persistence/db';
import { buildIdMap, createIdMap, dropIdMap, idMapSize, loadIdMap } from '../reidMap';
import {
  deleteSupersededRows,
  rekeyEmbeddedIds,
  rekeyPlainColumns,
  verifyDeferredForeignKeys,
} from '../reidRekey';

import type { InternalDb } from '../../../store/persistence/db';

/** A 32-hex id, which `canonicalId` re-encodes. */
const hex = (seed: string): string => seed.padEnd(32, '0').slice(0, 32);

let db: InternalDb;

beforeEach(async () => {
  db = getDb() as InternalDb;
  ensureNormalizedSchema(db);
  for (const t of ['cached_item_songs', 'cached_songs', 'cached_albums', 'cached_playlists', 'cached_items']) {
    await db.runAsync(`DELETE FROM ${t};`);
  }
  await dropIdMap(db);
  await createIdMap(db);
});

async function seedSong(id: string, albumId: string): Promise<void> {
  await db.runAsync(
    'INSERT INTO cached_songs (song_id, title, album_id, bytes, duration, suffix, '
    + 'format_captured_at, downloaded_at, raw_json, cover_art) '
    + "VALUES (?, 'T', ?, 1, 1, 'mp3', 0, 0, ?, ?)",
    [id, albumId, JSON.stringify({ id, albumId, coverArt: `al-${albumId}_hash` }), `al-${albumId}_hash`],
  );
}

describe('verifyDeferredForeignKeys', () => {
  it('confirms the pragma works on this build', async () => {
    // The 14-case spike ran better-sqlite3 3.53.3; the device runs op-SQLite 3.51.3. The
    // pass runs this before touching real data so a future bump cannot silently break it.
    await expect(verifyDeferredForeignKeys(db)).resolves.toBe(true);
  });

  it('leaves no probe tables behind', async () => {
    await verifyDeferredForeignKeys(db);
    const rows = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name LIKE '_reid_fk_probe%'",
    );
    expect(rows).toEqual([]);
  });
});

describe('buildIdMap', () => {
  it('maps only the ids that actually change', async () => {
    const legacy = hex('aaaa');
    await seedSong(legacy, hex('bbbb'));
    // An id already canonical must not enter the map.
    await seedSong('5cLJPkLA5DK2BADhoeotPk', hex('bbbb'));

    const pairs = await buildIdMap(db);
    const map = await loadIdMap(db);

    expect(pairs).toBeGreaterThan(0);
    expect(map.has(legacy)).toBe(true);
    expect(map.has('5cLJPkLA5DK2BADhoeotPk')).toBe(false);
    expect(map.get(legacy)).toHaveLength(22);
  });

  it('produces an empty map on an already-canonical install', async () => {
    await seedSong('5cLJPkLA5DK2BADhoeotPk', '7rke2SAWaicSeSYzkhww6R');
    expect(await buildIdMap(db)).toBe(0);
    expect(await idMapSize(db)).toBe(0);
  });

  it('survives being rebuilt after a partial run', async () => {
    await seedSong(hex('aaaa'), hex('bbbb'));
    const first = await buildIdMap(db);
    // INSERT OR IGNORE, so a resumed run re-inserting the same pairs is a no-op.
    const second = await buildIdMap(db);
    expect(second).toBe(first);
    expect(await idMapSize(db)).toBe(first);
  });
});

describe('rekeyPlainColumns', () => {
  it('rewrites a parent key and its FK children in one batch', async () => {
    const song = hex('aaaa');
    const album = hex('bbbb');
    await seedSong(song, album);
    await db.runAsync(
      "INSERT INTO cached_items (item_id, type, name, expected_song_count, last_sync_at, downloaded_at) "
      + "VALUES (?, 'album', 'A', 1, 0, 0)",
      [album],
    );
    await db.runAsync(
      'INSERT INTO cached_item_songs (item_id, position, song_id) VALUES (?, 1, ?)',
      [album, song],
    );

    await buildIdMap(db);
    const map = await loadIdMap(db);
    await rekeyPlainColumns(db);

    const newSong = map.get(song);
    const newAlbum = map.get(album);
    const songRow = await db.getFirstAsync<{ song_id: string; album_id: string }>(
      'SELECT song_id, album_id FROM cached_songs',
    );
    const link = await db.getFirstAsync<{ item_id: string; song_id: string }>(
      'SELECT item_id, song_id FROM cached_item_songs',
    );

    expect(songRow?.song_id).toBe(newSong);
    expect(songRow?.album_id).toBe(newAlbum);
    // The FK child followed both parents, across two clusters.
    expect(link?.song_id).toBe(newSong);
    expect(link?.item_id).toBe(newAlbum);
  });

  it('leaves foreign keys satisfied afterwards', async () => {
    const song = hex('cccc');
    await seedSong(song, hex('dddd'));
    await db.runAsync(
      "INSERT INTO cached_items (item_id, type, name, expected_song_count, last_sync_at, downloaded_at) "
      + "VALUES (?, 'album', 'A', 1, 0, 0)",
      [hex('dddd')],
    );
    await db.runAsync(
      'INSERT INTO cached_item_songs (item_id, position, song_id) VALUES (?, 1, ?)',
      [hex('dddd'), song],
    );

    await buildIdMap(db);
    await rekeyPlainColumns(db);

    const violations = await db.getAllAsync('PRAGMA foreign_key_check;');
    expect(violations).toEqual([]);
  });

  it('is idempotent', async () => {
    await seedSong(hex('eeee'), hex('ffff'));
    await buildIdMap(db);
    await rekeyPlainColumns(db);
    const first = await db.getFirstAsync<{ song_id: string }>('SELECT song_id FROM cached_songs');
    await rekeyPlainColumns(db);
    const second = await db.getFirstAsync<{ song_id: string }>('SELECT song_id FROM cached_songs');
    expect(second?.song_id).toBe(first?.song_id);
  });
});

describe('duplicate policy — existing row wins', () => {
  it('keeps the canonical row and removes the superseded one', async () => {
    const legacy = hex('1111');
    await seedSong(legacy, hex('2222'));
    await buildIdMap(db);
    const canonical = (await loadIdMap(db)).get(legacy) as string;

    // The user re-synced without logging out, so both rows exist.
    await seedSong(canonical, hex('2222'));

    await rekeyPlainColumns(db);
    // UPDATE OR IGNORE skipped the legacy row rather than failing the batch.
    expect(await deleteSupersededRows(db)).toBe(1);

    const rows = await db.getAllAsync<{ song_id: string }>('SELECT song_id FROM cached_songs');
    expect(rows.map((r) => r.song_id)).toEqual([canonical]);
  });
});

describe('rekeyEmbeddedIds', () => {
  it('rewrites artwork tokens and JSON envelopes', async () => {
    const song = hex('3333');
    const album = hex('4444');
    await seedSong(song, album);

    await buildIdMap(db);
    const map = await loadIdMap(db);
    await rekeyPlainColumns(db);
    await rekeyEmbeddedIds(db);

    const row = await db.getFirstAsync<{ cover_art: string; raw_json: string }>(
      'SELECT cover_art, raw_json FROM cached_songs',
    );
    const newAlbum = map.get(album) as string;
    const newSong = map.get(song) as string;
    expect(row?.cover_art).toBe(`al-${newAlbum}_hash`);
    const envelope = JSON.parse(row?.raw_json ?? '{}') as Record<string, string>;
    expect(envelope.id).toBe(newSong);
    expect(envelope.albumId).toBe(newAlbum);
    expect(envelope.coverArt).toBe(`al-${newAlbum}_hash`);
  });

  it('rewrites an envelope-only id the map never saw', async () => {
    // cached_items.raw_json carries artists[]; cached_albums holds only ONE artist_id, so
    // a featured album artist exists in no plain column and would miss a map-based lookup.
    const item = hex('5555');
    const featured = hex('6666');
    await db.runAsync(
      "INSERT INTO cached_items (item_id, type, name, expected_song_count, last_sync_at, "
      + 'downloaded_at, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [item, 'album', 'A', 0, 0, 0, JSON.stringify({ id: item, artists: [{ id: featured }] })],
    );

    await buildIdMap(db);
    expect((await loadIdMap(db)).has(featured)).toBe(false); // not in the map at all
    await rekeyPlainColumns(db);
    await rekeyEmbeddedIds(db);

    const row = await db.getFirstAsync<{ raw_json: string }>(
      'SELECT raw_json FROM cached_items',
    );
    const parsed = JSON.parse(row?.raw_json ?? '{}') as { artists: Array<{ id: string }> };
    expect(parsed.artists[0].id).not.toBe(featured);
    expect(parsed.artists[0].id).toHaveLength(22);
  });

  it('rewrites the legacy song_json column when the install still has it', async () => {
    // Not in schema.ts, so no schema-derived list can see it. Left stale, the backfill
    // that reads it writes old ids back over the re-keyed history.
    await db.runAsync('ALTER TABLE scrobble_events ADD COLUMN song_json TEXT');
    const song = hex('7777');
    await db.runAsync(
      "INSERT INTO scrobble_events (id, time, song_json) VALUES ('s1', 0, ?)",
      [JSON.stringify({ id: song, albumId: song })],
    );

    await buildIdMap(db);
    await rekeyEmbeddedIds(db);

    const row = await db.getFirstAsync<{ song_json: string }>(
      'SELECT song_json FROM scrobble_events',
    );
    const parsed = JSON.parse(row?.song_json ?? '{}') as { id: string };
    expect(parsed.id).not.toBe(song);
    expect(parsed.id).toHaveLength(22);
  });

  it('reports progress and leaves untouched rows alone', async () => {
    await seedSong('5cLJPkLA5DK2BADhoeotPk', '7rke2SAWaicSeSYzkhww6R');
    await buildIdMap(db);
    const seen: number[] = [];
    const rewritten = await rekeyEmbeddedIds(db, (done: number) => seen.push(done));
    expect(rewritten).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
  });
});
