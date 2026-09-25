/**
 * Build and hold the old-id to new-id map for a Navidrome re-key.
 *
 * A REAL table, not a TEMP one. Navidrome's own migration uses TEMP, but it can: its
 * migration is a single transaction with no files to move. Ours is not — the music files
 * are renamed after the database commits, so a kill in between must be resumable. And
 * `PRAGMA temp_store = MEMORY` (`src/db/client.ts:267`) means a TEMP table dies with the
 * process, while `canonicalId` is idempotent — so rebuilding the map after a partial run
 * reads the already-re-keyed rows and yields nothing, stranding the file move forever.
 *
 * Created imperatively rather than in `src/db/schema.ts`, because `NORMALIZED_DDL` is
 * generated and a hand-added entry there would be overwritten. That also means nothing
 * else knows the table exists, so this module owns dropping it — on success, on logout,
 * and at the start of any run that is not resuming.
 */

import { canonicalId } from './canonicalId';
import { NEVER_REKEY, REID_COLUMNS } from './reidColumns';
import type { BatchCommand, InternalDb } from '../../store/persistence/db';

const MAP_TABLE = '_navidrome_id_map';

/** Rows per INSERT batch while building the map. */
const INSERT_CHUNK = 500;

export async function createIdMap(db: InternalDb): Promise<void> {
  // No FKs and nothing subscribes to it, so it sits outside the normalized model
  // entirely. `IF NOT EXISTS` lets a resumed run reuse what the interrupted one built.
  await db.runAsync(
    `CREATE TABLE IF NOT EXISTS ${MAP_TABLE} (`
    + 'old_id TEXT PRIMARY KEY NOT NULL, '
    + 'new_id TEXT NOT NULL'
    + ') WITHOUT ROWID;',
  );
}

export async function dropIdMap(db: InternalDb): Promise<void> {
  await db.runAsync(`DROP TABLE IF EXISTS ${MAP_TABLE};`);
}

export async function idMapSize(db: InternalDb): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${MAP_TABLE}`);
  return row?.n ?? 0;
}

/**
 * Collect every distinct id across the allowlisted columns, compute its canonical form,
 * and store the pairs that actually differ.
 *
 * Only differing pairs go in, which is what makes the re-key statements cheap: a column
 * update can be restricted to `WHERE col IN (SELECT old_id FROM …)` and touch nothing
 * else. It also means an unaffected install produces an empty map, and the caller can
 * stop without writing anything.
 *
 * Artwork tokens and JSON envelopes are NOT read here. Their ids are the same entity ids
 * already gathered from the plain columns, so mapping those columns is enough — the
 * rewriters look up whatever id they find embedded.
 */
export async function buildIdMap(db: InternalDb): Promise<number> {
  const seen = new Set<string>();
  const pairs: Array<[string, string]> = [];

  for (const [table, columns] of Object.entries(REID_COLUMNS)) {
    for (const column of columns) {
      if (`${table}.${column}` in NEVER_REKEY) continue;
      // Artwork columns hold `<prefix>-<id>[...]`, not a bare id; their embedded ids are
      // entity ids that the plain columns already contribute.
      if (column === 'cover_art' || column === 'cover_art_id') continue;

      // eslint-disable-next-line no-await-in-loop
      const rows = await db.getAllAsync<{ v: string | null }>(
        `SELECT DISTINCT "${column}" AS v FROM "${table}" WHERE "${column}" IS NOT NULL`,
      );
      for (const { v } of rows) {
        if (v === null || v === '' || seen.has(v)) continue;
        seen.add(v);
        const next = canonicalId(v);
        if (next !== v) pairs.push([v, next]);
      }
    }
  }

  for (let i = 0; i < pairs.length; i += INSERT_CHUNK) {
    const chunk = pairs.slice(i, i + INSERT_CHUNK);
    const commands: BatchCommand[] = chunk.map(
      ([oldId, newId]) => [
        `INSERT OR IGNORE INTO ${MAP_TABLE} (old_id, new_id) VALUES (?, ?)`,
        [oldId, newId],
      ] as BatchCommand,
    );
    // eslint-disable-next-line no-await-in-loop
    await db.runAtomicBatchAsync(commands);
  }

  return pairs.length;
}

/**
 * Load the whole map into memory for the rewriters.
 *
 * Safe to hold: it contains only ids that CHANGED, for data the user has downloaded,
 * scrobbled or bookmarked — thousands of rows, not the hundreds of thousands a
 * whole-library re-key would have produced.
 */
export async function loadIdMap(db: InternalDb): Promise<Map<string, string>> {
  const rows = await db.getAllAsync<{ old_id: string; new_id: string }>(
    `SELECT old_id, new_id FROM ${MAP_TABLE}`,
  );
  return new Map(rows.map((r) => [r.old_id, r.new_id]));
}

/** The map table's name, for the re-key statements that join against it. */
export const ID_MAP_TABLE = MAP_TABLE;
