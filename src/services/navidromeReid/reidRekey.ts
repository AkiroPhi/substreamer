/**
 * The SQL half of the Navidrome re-key: rewrite every allowlisted column, one atomic
 * batch per FK cluster.
 *
 * `PRAGMA defer_foreign_keys` is what makes a parent-key update possible at all — without
 * it, rewriting `cached_songs.song_id` fails the instant the first child row is orphaned,
 * before we get to rewrite the child. It defers enforcement to the COMMIT of the
 * transaction it was set in, and each `runAtomicBatchAsync` is its own transaction, so a
 * batch must hold a parent AND every FK child referencing it. That is what `FK_CLUSTERS`
 * encodes; it is a correctness constraint, not a progress-reporting convenience.
 *
 * The pragma resets itself at commit, so it is set fresh inside every batch.
 */

import {
  ARTWORK_TOKEN_COLUMNS,
  FK_CLUSTERS,
  JSON_COLUMNS,
  NEVER_REKEY,
  REID_COLUMNS,
  type ClusterMember,
} from './reidColumns';
import { ID_MAP_TABLE } from './reidMap';
import { remapArtworkToken } from './artworkToken';
import { remapJsonEnvelope } from './jsonEnvelope';
import type { BatchCommand, InternalDb } from '../../store/persistence/db';

/** Rows per batch when rewriting JSON envelopes and artwork tokens row by row. */
const ROW_CHUNK = 250;

/**
 * Prove the deferred-FK pragma actually works on this build before touching real data.
 *
 * The fourteen-case spike that justified this design ran better-sqlite3 3.53.3; the device
 * runs op-SQLite 3.51.3, a different build with a different threading model. Rather than
 * leave that as a gate someone has to remember, the pass checks it against a scratch table
 * every run — a few milliseconds, and it keeps protecting us if an op-SQLite bump ever
 * changes the behaviour.
 *
 * Returns true when a parent-key update with orphaned children survives to COMMIT.
 */
export async function verifyDeferredForeignKeys(db: InternalDb): Promise<boolean> {
  const parent = '_reid_fk_probe_parent';
  const child = '_reid_fk_probe_child';
  try {
    await db.runAsync(`DROP TABLE IF EXISTS ${child};`);
    await db.runAsync(`DROP TABLE IF EXISTS ${parent};`);
    await db.runAsync(`CREATE TABLE ${parent} (id TEXT PRIMARY KEY NOT NULL);`);
    await db.runAsync(
      `CREATE TABLE ${child} (`
      + `pid TEXT NOT NULL REFERENCES ${parent}(id) ON DELETE CASCADE, `
      + 'n INTEGER NOT NULL);',
    );
    await db.runAsync(`INSERT INTO ${parent} (id) VALUES ('old');`);
    await db.runAsync(`INSERT INTO ${child} (pid, n) VALUES ('old', 1);`);

    // The parent update orphans the child mid-batch; only the deferral lets it reach the
    // child update. If the pragma is a no-op here this throws.
    await db.runAtomicBatchAsync([
      ['PRAGMA defer_foreign_keys = ON', []],
      [`UPDATE ${parent} SET id = 'new' WHERE id = 'old'`, []],
      [`UPDATE ${child} SET pid = 'new' WHERE pid = 'old'`, []],
    ] as BatchCommand[]);

    const row = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${child} WHERE pid = 'new'`,
    );
    return (row?.n ?? 0) === 1;
  } catch {
    return false;
  } finally {
    await db.runAsync(`DROP TABLE IF EXISTS ${child};`).catch(() => undefined);
    await db.runAsync(`DROP TABLE IF EXISTS ${parent};`).catch(() => undefined);
  }
}

/**
 * The plain-column updates for one cluster member: its allowlisted, non-artwork columns,
 * narrowed to `only` when the table spans more than one cluster.
 */
function plainColumnCommands(member: ClusterMember): BatchCommand[] {
  const { table, only } = member;
  const artwork = new Set(ARTWORK_TOKEN_COLUMNS[table] ?? []);
  const scoped = only === undefined
    ? (REID_COLUMNS[table] ?? [])
    : (REID_COLUMNS[table] ?? []).filter((c) => only.includes(c));
  return scoped
    .filter((c) => !artwork.has(c) && !(`${table}.${c}` in NEVER_REKEY))
    .map((column) => [
      `UPDATE OR IGNORE "${table}" SET "${column}" = `
      + `(SELECT new_id FROM ${ID_MAP_TABLE} WHERE old_id = "${table}"."${column}") `
      + `WHERE "${column}" IN (SELECT old_id FROM ${ID_MAP_TABLE})`,
      [],
    ] as BatchCommand);
}

/**
 * Rewrite every plain id column, one batch per FK cluster.
 *
 * `UPDATE OR IGNORE` is the duplicate policy: where a re-synced row already holds the
 * canonical id, the update silently skips rather than failing the whole batch on the
 * primary key. Existing row wins. The rows it skipped are then stale duplicates, which
 * {@link deleteSupersededRows} removes.
 */
export async function rekeyPlainColumns(db: InternalDb): Promise<void> {
  for (const cluster of FK_CLUSTERS) {
    const commands: BatchCommand[] = [['PRAGMA defer_foreign_keys = ON', []]];
    for (const member of cluster) commands.push(...plainColumnCommands(member));
    if (commands.length === 1) continue;
    // eslint-disable-next-line no-await-in-loop
    await db.runAtomicBatchAsync(commands);
  }
}

/**
 * Remove rows the re-key could not move because the canonical id was already taken.
 *
 * Only the two tables with a re-keyed single-column primary key can strand a row this
 * way. A row still holding a mapped old id after the update is one `UPDATE OR IGNORE`
 * skipped, and its content is a duplicate of the row that won.
 */
export async function deleteSupersededRows(db: InternalDb): Promise<number> {
  let removed = 0;
  for (const [table, key] of [['cached_songs', 'song_id'], ['cached_items', 'item_id']] as const) {
    // eslint-disable-next-line no-await-in-loop
    const row = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM "${table}" WHERE "${key}" IN (SELECT old_id FROM ${ID_MAP_TABLE})`,
    );
    const n = row?.n ?? 0;
    if (n === 0) continue;
    // eslint-disable-next-line no-await-in-loop
    await db.runAtomicBatchAsync([
      ['PRAGMA defer_foreign_keys = ON', []],
      [`DELETE FROM "${table}" WHERE "${key}" IN (SELECT old_id FROM ${ID_MAP_TABLE})`, []],
    ] as BatchCommand[]);
    removed += n;
  }
  return removed;
}

/**
 * Rewrite the artwork tokens and JSON envelopes, which cannot be done in SQL because the
 * id is embedded in a larger string.
 *
 * Addressed by ROWID rather than by the row's own key: the plain-column pass has already
 * rewritten those keys, so reading them back would mean tracking which value each row now
 * holds. ROWID is stable across an UPDATE and needs no bookkeeping.
 */
export async function rekeyEmbeddedIds(
  db: InternalDb,
  map: Map<string, string>,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const lookup = (id: string): string | undefined => map.get(id);
  const tables = new Set([...Object.keys(ARTWORK_TOKEN_COLUMNS), ...Object.keys(JSON_COLUMNS)]);
  let rewritten = 0;
  let seen = 0;

  // A rough total for the progress bar; exactness is not worth a second pass.
  let total = 0;
  for (const table of tables) {
    // eslint-disable-next-line no-await-in-loop
    const row = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`);
    total += row?.n ?? 0;
  }

  for (const table of tables) {
    const artwork = ARTWORK_TOKEN_COLUMNS[table] ?? [];
    const json = JSON_COLUMNS[table] ?? [];
    const columns = [...artwork, ...json];
    if (columns.length === 0) continue;

    const select = columns.map((c) => `"${c}"`).join(', ');
    let after = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await db.getAllAsync<Record<string, unknown>>(
        `SELECT rowid AS _rid, ${select} FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ?`,
        [after, ROW_CHUNK],
      );
      if (rows.length === 0) break;

      const commands: BatchCommand[] = [];
      for (const row of rows) {
        const sets: string[] = [];
        const values: unknown[] = [];
        for (const column of artwork) {
          const current = row[column];
          if (typeof current !== 'string') continue;
          const next = remapArtworkToken(current, lookup);
          if (next !== current) { sets.push(`"${column}" = ?`); values.push(next); }
        }
        for (const column of json) {
          const current = row[column];
          if (typeof current !== 'string') continue;
          const next = remapJsonEnvelope(current, lookup);
          if (next !== current) { sets.push(`"${column}" = ?`); values.push(next); }
        }
        if (sets.length === 0) continue;
        commands.push([
          `UPDATE "${table}" SET ${sets.join(', ')} WHERE rowid = ?`,
          [...values, row._rid],
        ] as BatchCommand);
      }

      if (commands.length > 0) {
        // eslint-disable-next-line no-await-in-loop
        await db.runAtomicBatchAsync(commands);
        rewritten += commands.length;
      }
      after = Number(rows[rows.length - 1]._rid);
      seen += rows.length;
      onProgress?.(seen, total);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    }
  }

  return rewritten;
}
