/**
 * Cover-art token lookups for the one cover resolver (`imageCacheService.resolveDisplayImages`).
 *
 * A song's album-mode cover is its ALBUM's `cover_art` token, which the song itself does not
 * carry (Navidrome: `al-<id>_<hash>`, not the bare album id). The token comes from the synced
 * library (`albums`), then the downloaded album's metadata (`cached_albums`) for an album the
 * library does not hold, then the song's own token.
 */
import type { InternalDb } from '../client';

/** One cover to resolve. `albumId` is set only when the album's token should be preferred. */
export interface CoverLookup {
  coverArt: string | null;
  albumId: string | null;
}

/** The resolved token for `lookups[index]`, plus one cached variant of it (`size`/`ext`), if any. */
export interface CoverImageRow {
  index: number;
  token: string | null;
  size: number | null;
  ext: string | null;
}

const ALBUM_TOKEN = `COALESCE(NULLIF(a.cover_art, ''), NULLIF(ca.cover_art, ''))`;

/**
 * Resolve each lookup's token and list its cached variants, in ONE query. A lookup with several
 * cached sizes yields several rows; one with none yields a single row with null `size`/`ext`.
 */
export async function coverTokensWithImages(
  db: InternalDb,
  lookups: readonly CoverLookup[],
): Promise<CoverImageRow[]> {
  if (lookups.length === 0) return [];
  return db.getAllAsync<CoverImageRow>(
    `WITH s AS (
       SELECT CAST(key AS INTEGER) AS i,
              NULLIF(json_extract(value, '$.c'), '') AS song,
              NULLIF(json_extract(value, '$.a'), '') AS album_id
         FROM json_each(?)
     ), t AS (
       SELECT s.i, COALESCE(${ALBUM_TOKEN}, s.song) AS token
         FROM s
         LEFT JOIN albums a ON a.id = s.album_id
         LEFT JOIN cached_albums ca ON ca.item_id = s.album_id
     )
     SELECT t.i AS "index", t.token AS token, ci.size AS size, ci.ext AS ext
       FROM t LEFT JOIN cached_images ci ON ci.cover_art_id = t.token
      ORDER BY t.i`,
    [JSON.stringify(lookups.map((l) => ({ c: l.coverArt, a: l.albumId })))],
  );
}

/** Each album's own cover token (library first, then downloaded metadata); albums with none are absent. */
export async function albumCoverTokens(
  db: InternalDb,
  albumIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(albumIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await db.getAllAsync<{ id: string; token: string | null }>(
    `SELECT j.value AS id, ${ALBUM_TOKEN} AS token
       FROM json_each(?) j
       LEFT JOIN albums a ON a.id = j.value
       LEFT JOIN cached_albums ca ON ca.item_id = j.value`,
    [JSON.stringify(ids)],
  );
  const out = new Map<string, string>();
  for (const r of rows) if (r.token) out.set(r.id, r.token);
  return out;
}
