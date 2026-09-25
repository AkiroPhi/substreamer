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

import { FK_CLUSTERS, NEVER_REKEY, REID_COLUMNS } from '../reidColumns';

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
  || col.endsWith('_id')
  || col === 'parent'
  || col === 'cover_art'
  || /music_brainz|mbid/.test(col);

const schema = readSchemaTables();
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

  it('classifies every id-bearing column on every covered table', () => {
    const unclassified: string[] = [];
    for (const table of coveredTables) {
      for (const column of schema.get(table) ?? []) {
        if (!looksLikeAnId(column)) continue;
        const isRekeyed = REID_COLUMNS[table].includes(column);
        const isExcluded = `${table}.${column}` in NEVER_REKEY;
        if (!isRekeyed && !isExcluded) unclassified.push(`${table}.${column}`);
      }
    }
    // A new id column on a covered table lands here. Add it to REID_COLUMNS, or to
    // NEVER_REKEY with the reason it must not be touched.
    expect(unclassified).toEqual([]);
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
      for (const table of cluster) counts.set(table, (counts.get(table) ?? 0) + 1);
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
      for (const table of cluster) {
        expect({ table, covered: table in REID_COLUMNS }).toEqual({ table, covered: true });
      }
    }
  });
});
