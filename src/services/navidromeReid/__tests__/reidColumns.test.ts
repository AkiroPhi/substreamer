/**
 * Drift guard for the re-key allowlist.
 *
 * `reidColumns.ts` is a literal list rather than something generated at runtime, because a
 * list you can read is worth more than one you have to trust. The cost of that choice is
 * that it can fall out of step with the schema — so this test derives the id-bearing
 * columns from `src/db/schema.ts` and fails if any of them is neither re-keyed nor
 * explicitly excluded.
 *
 * Adding a column to a covered table therefore breaks the build until someone classifies
 * it, which is the whole point: silently missing a column corrupts data that has no server
 * copy, and silently re-keying one destroys a MusicBrainz id.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  ARTWORK_TOKEN_COLUMNS,
  FK_CLUSTERS,
  JSON_COLUMNS,
  NEVER_REKEY,
  REID_COLUMNS,
} from '../reidColumns';

const SCHEMA_PATH = join(__dirname, '../../../db/schema.ts');

/** Every table in the schema, with its column names. */
function readSchemaTables(): Map<string, string[]> {
  const src = readFileSync(SCHEMA_PATH, 'utf8');
  const starts = [...src.matchAll(/export const \w+ = sqliteTable\(\s*'([a-z_0-9]+)'/g)];
  const tables = new Map<string, string[]>();
  starts.forEach((match, i) => {
    const from = match.index ?? 0;
    const to = i + 1 < starts.length ? (starts[i + 1].index ?? src.length) : src.length;
    const body = src.slice(from, to);
    const cols = [...body.matchAll(/\b\w+:\s*(?:text|integer|real)\(\s*'([a-z_0-9]+)'/g)]
      .map((m) => m[1]);
    tables.set(match[1], cols);
  });
  return tables;
}

/**
 * Columns that plausibly hold an entity id. Deliberately broad — a false positive here
 * costs one line in `NEVER_REKEY` with a reason, which is exactly the documentation we
 * want; a false negative is a silent corruption.
 */
const looksLikeAnId = (col: string): boolean =>
  col === 'id'
  || col === 'parent'
  || /_ids?$|_json$|_key$|_uri$|_url$|token|cover_art|music_brainz|mbid/.test(col);

const schema = readSchemaTables();

/**
 * The tables in scope, derived INDEPENDENTLY of the answer being checked.
 *
 * Taking it from `Object.keys(REID_COLUMNS)` would make the guard circular: a table with
 * id columns and no entry at all would simply never be inspected. Seven tables are in that
 * position (`scrobble_genres`, the snapshot genres/moods, `queue_snapshots`), and adding an
 * id column to any of them would pass silently.
 */
const IN_SCOPE: readonly string[] = (() => {
  const src = readFileSync(join(__dirname, '../../../db/createNormalizedTables.ts'), 'utf8');
  const block = src.slice(src.indexOf('KEPT_TABLES'), src.indexOf('];', src.indexOf('KEPT_TABLES')));
  const kept = [...block.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]);
  const carveOuts = [
    'queue_snapshots', 'queue_snapshot_songs', 'queue_snapshot_song_genres',
    'queue_snapshot_song_artists', 'queue_snapshot_song_album_artists',
    'queue_snapshot_song_contributors', 'queue_snapshot_song_moods',
    'mbid_overrides', 'scrobble_exclusions',
  ];
  // Documented exclusions: KV, the cleared image cache, the cleared download queue.
  const excluded = (t: string): boolean =>
    t === 'storage' || t === 'cached_images' || t === 'image_download_queue'
    || t.startsWith('download_queue');
  return [...new Set([...kept, ...carveOuts])].filter((t) => !excluded(t));
})();

const coveredTables = Object.keys(REID_COLUMNS);

describe('reidColumns drift guard', () => {
  it('every table it names exists in the schema', () => {
    for (const table of coveredTables) {
      expect(schema.has(table)).toBe(true);
    }
  });

  it('every column it names exists on its table', () => {
    for (const [table, columns] of Object.entries(REID_COLUMNS)) {
      const actual = schema.get(table) ?? [];
      for (const column of columns) {
        expect({ table, column, present: actual.includes(column) })
          .toEqual({ table, column, present: true });
      }
    }
  });

  it('inspects every in-scope table, not just the ones already listed', () => {
    // Guards against the guard: a table with id columns and no REID_COLUMNS entry.
    const missing = IN_SCOPE
      .filter((t) => schema.has(t))
      .filter((t) => (schema.get(t) ?? []).some(looksLikeAnId))
      .filter((t) => !(t in REID_COLUMNS)
        && !(schema.get(t) ?? []).every((c) => !looksLikeAnId(c) || `${t}.${c}` in NEVER_REKEY));
    expect(missing).toEqual([]);
  });

  it('classifies every id-bearing column on every IN-SCOPE table', () => {
    const unclassified: string[] = [];
    for (const table of IN_SCOPE.filter((t) => schema.has(t))) {
      for (const column of schema.get(table) ?? []) {
        if (!looksLikeAnId(column)) continue;
        const isRekeyed = (REID_COLUMNS[table] ?? []).includes(column);
        const isExcluded = `${table}.${column}` in NEVER_REKEY;
        if (!isRekeyed && !isExcluded) unclassified.push(`${table}.${column}`);
      }
    }
    // A new id column on a covered table lands here. Add it to REID_COLUMNS, or to
    // NEVER_REKEY with the reason it must not be touched.
    expect(unclassified).toEqual([]);
  });

  it('guards the artwork and JSON column maps too', () => {
    // Without this, renaming cover_art on a covered table leaves a dead entry here while
    // REID_COLUMNS is fixed — the column stops being subtracted from the plain-column
    // updates AND stops being rewritten, so the tokens silently go stale.
    for (const [table, columns] of Object.entries(ARTWORK_TOKEN_COLUMNS)) {
      for (const column of columns) {
        expect({ table, column, present: (schema.get(table) ?? []).includes(column) })
          .toEqual({ table, column, present: true });
      }
    }
    for (const [table, columns] of Object.entries(JSON_COLUMNS)) {
      for (const column of columns) {
        expect({ table, column, present: (schema.get(table) ?? []).includes(column) })
          .toEqual({ table, column, present: true });
      }
    }
    // And every artwork/envelope column on a covered table must BE in those maps.
    for (const table of coveredTables) {
      for (const column of schema.get(table) ?? []) {
        if (/^cover_art/.test(column)) {
          expect({ c: `${table}.${column}`, mapped: (ARTWORK_TOKEN_COLUMNS[table] ?? []).includes(column) })
            .toEqual({ c: `${table}.${column}`, mapped: true });
        }
        if (/_json$/.test(column)) {
          expect({ c: `${table}.${column}`, mapped: (JSON_COLUMNS[table] ?? []).includes(column) })
            .toEqual({ c: `${table}.${column}`, mapped: true });
        }
      }
    }
  });

  it('never re-keys a column it also excludes', () => {
    for (const key of Object.keys(NEVER_REKEY)) {
      const [table, column] = key.split('.');
      expect(REID_COLUMNS[table]?.includes(column) ?? false).toBe(false);
    }
  });

  it('excludes every MusicBrainz column on a covered table', () => {
    for (const table of coveredTables) {
      for (const column of schema.get(table) ?? []) {
        if (!/music_brainz|mbid/.test(column)) continue;
        // `mbid_overrides.entity_id` is the entity, not the MBID — it is re-keyed.
        if (table === 'mbid_overrides' && column === 'entity_id') continue;
        expect(`${table}.${column}` in NEVER_REKEY).toBe(true);
      }
    }
  });

  it('puts every covered table in exactly one FK cluster, bar the shared child', () => {
    const counts = new Map<string, number>();
    for (const cluster of FK_CLUSTERS) {
      for (const { table } of cluster) counts.set(table, (counts.get(table) ?? 0) + 1);
    }
    for (const table of coveredTables) {
      const seen = counts.get(table) ?? 0;
      // cached_item_songs holds an FK to BOTH cached_songs and cached_items, so it is
      // deliberately in two clusters; everything else must be in exactly one.
      expect({ table, seen }).toEqual({ table, seen: table === 'cached_item_songs' ? 2 : 1 });
    }
  });

  it('names no table in a cluster that it does not also re-key', () => {
    for (const cluster of FK_CLUSTERS) {
      for (const { table } of cluster) {
        expect({ table, covered: table in REID_COLUMNS }).toEqual({ table, covered: true });
      }
    }
  });

  it('scopes a table that spans two clusters, and covers all its columns exactly once', () => {
    // Without `only`, whichever batch runs first rewrites BOTH FK columns and orphans the
    // one whose parent has not moved yet — a real failure the SQL tests caught.
    const perTable = new Map<string, string[]>();
    for (const cluster of FK_CLUSTERS) {
      for (const { table, only } of cluster) {
        const cols = only ?? REID_COLUMNS[table];
        perTable.set(table, [...(perTable.get(table) ?? []), ...cols]);
      }
    }
    for (const [table, columns] of perTable) {
      // No column rewritten twice, and every allowlisted column rewritten once.
      expect({ table, dupes: columns.length - new Set(columns).size })
        .toEqual({ table, dupes: 0 });
      expect({ table, missing: REID_COLUMNS[table].filter((c) => !columns.includes(c)) })
        .toEqual({ table, missing: [] });
    }
  });
});
