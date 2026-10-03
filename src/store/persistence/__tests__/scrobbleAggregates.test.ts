/**
 * SQL scrobble analytics (the OOM fix): aggregates come from GROUP BY over the
 * structured columns, scoped by an optional `sinceMs`. Also covers the one-time
 * backfill of derived columns for rows written before the columns existed.
 */
import type { Child } from 'subsonic-api';

import { getDb } from '../db';
import { getTopDecade } from '../../../services/tunedInService';
import {
  computeScrobbleAnalytics,
  loadRecentScrobbles,
  loadScrobblePage,
} from '../scrobbleAggregates';
import { backfillScrobbleColumnsAsync } from '../scrobbleTable';
import { __setDbForTests } from '../db';
import type { Cursor } from '../../../db/repository/core';
import { deriveScrobbleColumns, scrobbleColumnValues, SCROBBLE_COLUMN_NAMES } from '../scrobbleColumns';
import {
  createLegacyScrobbleTables,
  createScrobbleTables,
} from '../../../test-utils/legacyScrobbleTables';

const db = () => getDb()!;

const song = (id: string, extra: Partial<Child> = {}): Child =>
  ({ id, title: id, isDir: false, ...extra }) as Child;

// Insert directly via the same column set the write path uses.
const insert = (id: string, s: Child, time: number): void => {
  const cols = scrobbleColumnValues(deriveScrobbleColumns(s, time));
  db().runSync(
    `INSERT INTO scrobble_events (id, time, ${SCROBBLE_COLUMN_NAMES.join(', ')}) ` +
      `VALUES (${new Array(2 + SCROBBLE_COLUMN_NAMES.length).fill('?').join(', ')});`,
    [id, time, ...cols],
  );
};

const HOUR = 3_600_000;
const DAY = 86_400_000;
// A fixed "now" far enough back that the fabricated times below are stable.
const NOW = 1_700_000_000_000;

beforeEach(() => {
  // Rebuild rather than DELETE: one case below swaps in the legacy table shape.
  createScrobbleTables(db());
});

it('computes all-time aggregates from GROUP BY', async () => {
  insert('e1', song('s1', { artist: 'A', artistId: 'ar-a', album: 'AlbA', albumId: 'al-a', duration: 100, genres: [{ name: 'Rock' }] as any }), NOW);
  insert('e2', song('s1', { artist: 'A', artistId: 'ar-a', album: 'AlbA', albumId: 'al-a', duration: 100, genres: [{ name: 'Rock' }] as any }), NOW + HOUR);
  insert('e3', song('s2', { artist: 'B', album: 'AlbB', duration: 200, genres: [{ name: 'Jazz' }] as any }), NOW + 2 * HOUR);

  const { stats, aggregates } = await computeScrobbleAnalytics(0);
  expect(stats.totalPlays).toBe(3);
  expect(stats.totalListeningSeconds).toBe(400); // 100+100+200
  expect(Object.keys(stats.uniqueArtists).sort()).toEqual(['A', 'B']);
  expect(aggregates.artistCounts.A).toEqual({ count: 2, artistId: 'ar-a' });
  expect(aggregates.artistCounts.B.count).toBe(1);
  expect(aggregates.albumCounts['AlbA::A']).toMatchObject({ artist: 'A', count: 2, albumId: 'al-a' });
  expect(aggregates.songStats.s1).toEqual({ count: 2, duration: 100, year: undefined });
  expect(aggregates.topSongs.map((e) => e.song.id)).toEqual(['s1', 's2']);
  expect(aggregates.genreCounts).toEqual({ Rock: 2, Jazz: 1 });
});

it('scopes aggregates to a period via sinceMs', async () => {
  insert('old', song('s1', { artist: 'A' }), NOW - 40 * DAY);
  insert('recent', song('s2', { artist: 'B' }), NOW - 2 * DAY);
  // sinceMs = 7 days before NOW → only the recent one.
  const { stats, aggregates } = await computeScrobbleAnalytics(NOW - 7 * DAY);
  expect(stats.totalPlays).toBe(1);
  expect(Object.keys(aggregates.artistCounts)).toEqual(['B']);
});

it('backfills derived columns for rows written before the columns existed', async () => {
  // An install that has not run the column drop: only id/song_json/time populated.
  createLegacyScrobbleTables(db());
  db().runSync('INSERT INTO scrobble_events (id, song_json, time) VALUES (?, ?, ?);', [
    'legacy',
    JSON.stringify(song('s9', { artist: 'Zed', album: 'AlbZ', duration: 50, genres: [{ name: 'Folk' }] as any })),
    NOW,
  ]);
  // Before backfill: aggregates ignore the NULL-column row.
  expect((await computeScrobbleAnalytics(0)).aggregates.artistCounts.Zed).toBeUndefined();

  await backfillScrobbleColumnsAsync();

  const { stats, aggregates } = await computeScrobbleAnalytics(0);
  expect(stats.totalPlays).toBe(1);
  expect(aggregates.artistCounts.Zed.count).toBe(1);
  expect(aggregates.genreCounts.Folk).toBe(1);
});

/* ------------------------------------------------------------------ */
/*  Totals hold while only the ranked few are reconstructed            */
/* ------------------------------------------------------------------ */

describe('analytics totals over a repeat-heavy history', () => {
  /** Eight songs played 8,7,…,1 times — distinct counts, so the ranking is exact —
   *  spread one play per hour across a day and a half. */
  const history = (() => {
    const rows: { id: string; song: Child; time: number }[] = [];
    let k = 0;
    for (let i = 0; i < 8; i++) {
      const s = song(`s${i}`, {
        artist: `A${i % 3}`,
        artistId: `ar-${i % 3}`,
        album: `Alb${i % 4}`,
        albumId: `al-${i % 4}`,
        duration: 100 + 10 * i,
        year: 1962 + 7 * i,
        genres: [{ name: `G${i % 2}` }] as any,
      });
      for (let p = 0; p < 8 - i; p++) rows.push({ id: `e${k}`, song: s, time: NOW - k++ * HOUR });
    }
    return rows;
  })();

  beforeEach(() => {
    for (const r of history) insert(r.id, r.song, r.time);
  });

  it('totals, unique artists and the genre/hour/day buckets come out unchanged', async () => {
    const { stats, aggregates } = await computeScrobbleAnalytics(0);

    // Oracle: the same reduction over the seed, independent of the SQL.
    const expectedSeconds = history.reduce((n, r) => n + (r.song.duration ?? 0), 0);
    const expectedGenres: Record<string, number> = {};
    const expectedHours = new Array<number>(24).fill(0);
    const expectedDays: Record<string, number> = {};
    for (const r of history) {
      const g = (r.song.genres as unknown as { name: string }[])[0].name;
      expectedGenres[g] = (expectedGenres[g] ?? 0) + 1;
      expectedHours[new Date(r.time).getHours()]++;
      const dk = new Date(r.time);
      const key = `${dk.getFullYear()}-${String(dk.getMonth() + 1).padStart(2, '0')}-${String(dk.getDate()).padStart(2, '0')}`;
      expectedDays[key] = (expectedDays[key] ?? 0) + 1;
    }

    expect(stats.totalPlays).toBe(36);
    expect(stats.totalListeningSeconds).toBe(expectedSeconds);
    expect(Object.keys(stats.uniqueArtists).sort()).toEqual(['A0', 'A1', 'A2']);
    expect(aggregates.genreCounts).toEqual(expectedGenres);
    expect(aggregates.hourBuckets).toEqual(expectedHours);
    expect(aggregates.dayCounts).toEqual(expectedDays);
  });

  it('songStats still sums to the same listening total the screen shows', async () => {
    const { aggregates } = await computeScrobbleAnalytics(0);
    // The My Listening figure: per-song duration x play count, over every song.
    const fromSongs = Object.values(aggregates.songStats).reduce(
      (n, e) => n + (e.duration ?? 0) * e.count,
      0,
    );
    expect(Object.keys(aggregates.songStats)).toHaveLength(8);
    expect(fromSongs).toBe(history.reduce((n, r) => n + (r.song.duration ?? 0), 0));
  });

  it('ranks topSongs by play count', async () => {
    const { aggregates } = await computeScrobbleAnalytics(0);
    expect(aggregates.topSongs.map((e) => e.song.id)).toEqual([
      's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7',
    ]);
    expect(aggregates.topSongs.map((e) => e.count)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it('feeds getTopDecade the same years, so it picks the same decade', async () => {
    const { aggregates } = await computeScrobbleAnalytics(0);
    // The pick is a weighted random over the decades; pinning the roll to 0 takes the
    // first candidate, so this asserts the years reached it rather than the shuffle.
    const roll = jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      expect(getTopDecade(aggregates.songStats)).toEqual({
        decade: 1960,
        fromYear: 1960,
        toYear: 1969,
      });
    } finally {
      roll.mockRestore();
    }
  });
});

it('loadRecentScrobbles returns newest first, bounded', async () => {
  insert('a', song('s1'), NOW);
  insert('b', song('s2'), NOW + HOUR);
  insert('c', song('s3'), NOW + 2 * HOUR);
  const recent = await loadRecentScrobbles(2);
  expect(recent.map((r) => r.id)).toEqual(['c', 'b']); // newest first, limit 2
});

describe('loadScrobblePage', () => {
  /** Page through everything with `limit`, collecting scrobble ids in order. */
  const pageAll = async (limit: number, query?: string): Promise<string[]> => {
    const out: string[] = [];
    let cursor: Cursor | null = null;
    for (let i = 0; i < 50; i++) {
      // eslint-disable-next-line no-await-in-loop
      const page = await loadScrobblePage({ cursor, limit, query });
      out.push(...page.rows.map((r) => r.id));
      if (!page.nextCursor) return out;
      cursor = page.nextCursor;
    }
    throw new Error('paging did not terminate');
  };

  it('pages the whole history newest first, each play exactly once, across tied times', async () => {
    // Song ids sort OPPOSITE to scrobble ids, so ordering by the `song_id AS id` alias
    // instead of the scrobble id would reorder the tied rows and break the cursor.
    insert('e1', song('s9'), NOW);
    insert('e2', song('s8'), NOW + HOUR);
    insert('e3', song('s7'), NOW + HOUR);
    insert('e4', song('s6'), NOW + HOUR);
    insert('e5', song('s5'), NOW + 2 * HOUR);
    expect(await pageAll(2)).toEqual(['e5', 'e4', 'e3', 'e2', 'e1']);
    expect(await pageAll(1)).toEqual(['e5', 'e4', 'e3', 'e2', 'e1']);
  });

  it('returns a full page with a cursor, and a null cursor on the last page', async () => {
    insert('e1', song('s1'), NOW);
    insert('e2', song('s2'), NOW + HOUR);
    const first = await loadScrobblePage({ cursor: null, limit: 2 });
    expect(first.rows.map((r) => r.id)).toEqual(['e2', 'e1']);
    expect(first.nextCursor).toBeNull();
    const partial = await loadScrobblePage({ cursor: null, limit: 1 });
    expect(partial.nextCursor).toEqual({ sortKey: NOW + HOUR, id: 'e2' });
  });

  it('filters on title OR artist, case-insensitively', async () => {
    insert('e1', song('s1', { title: 'Blue Monday', artist: 'New Order' }), NOW);
    insert('e2', song('s2', { title: 'Karma Police', artist: 'Radiohead' }), NOW + HOUR);
    insert('e3', song('s3', { title: 'Ceremony', artist: 'New Order' }), NOW + 2 * HOUR);
    expect(await pageAll(1, 'new order')).toEqual(['e3', 'e1']);
    expect(await pageAll(1, '  POLICE ')).toEqual(['e2']);
    expect(await pageAll(1, 'nothing matches')).toEqual([]);
    expect(await pageAll(1, '   ')).toEqual(['e3', 'e2', 'e1']);
  });

  it('matches %, _ and backslash literally', async () => {
    insert('e1', song('s1', { title: '100% Pure' }), NOW);
    insert('e2', song('s2', { title: '100 Pure' }), NOW + HOUR);
    insert('e3', song('s3', { title: 'a_b' }), NOW + 2 * HOUR);
    insert('e4', song('s4', { title: 'axb' }), NOW + 3 * HOUR);
    insert('e5', song('s5', { title: 'AC\\DC' }), NOW + 4 * HOUR);
    expect(await pageAll(5, '100%')).toEqual(['e1']);
    expect(await pageAll(5, 'a_b')).toEqual(['e3']);
    expect(await pageAll(5, 'C\\D')).toEqual(['e5']);
  });

  it('excludes rows with no title or song id without shortening a page', async () => {
    insert('e1', song('s1'), NOW);
    insert('e2', song('s2'), NOW + HOUR);
    insert('e3', song('s3'), NOW + 2 * HOUR);
    db().runSync("UPDATE scrobble_events SET title = '' WHERE id = 'e3'");
    db().runSync("UPDATE scrobble_events SET song_id = NULL WHERE id = 'e2'");
    insert('e4', song('s4'), NOW + 3 * HOUR);
    const page = await loadScrobblePage({ cursor: null, limit: 2 });
    expect(page.rows.map((r) => r.id)).toEqual(['e4', 'e1']);
    expect(page.nextCursor).toBeNull();
  });

  it('returns an empty last page with no db, or when the query fails', async () => {
    const real = db();
    __setDbForTests(null);
    expect(await loadScrobblePage({ cursor: null, limit: 5 })).toEqual({ rows: [], nextCursor: null });
    __setDbForTests(real);
    db().runSync('DROP TABLE scrobble_events');
    expect(await loadScrobblePage({ cursor: null, limit: 5 })).toEqual({ rows: [], nextCursor: null });
  });
});
