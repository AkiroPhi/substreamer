/**
 * Downloaded music's covers are never purged by an automated path — BOTH covers of every
 * downloaded song (its own and its album's), whatever the cover mode, while covers nothing
 * downloaded uses are purged as before.
 */

jest.mock('expo/fetch', () => ({
  fetch: jest.fn(async () => ({ ok: false, status: 503, headers: { get: () => null } })),
}));

jest.mock('../subsonicService', () => ({
  ...jest.requireActual('../subsonicService'),
  getCoverArtUrl: (id: string, size: number) => `https://server/cover/${id}?size=${size}`,
}));

import { getDb } from '../../store/persistence/db';
import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { connectivityStore } from '../../store/connectivityStore';
import { layoutPreferencesStore } from '../../store/layoutPreferencesStore';
import { musicCacheStore } from '../../store/musicCacheStore';
import { cacheSongCovers } from '../imageCacheService';

const db = () => getDb()!;
const rowsFor = (token: string): number =>
  db().getAllSync<{ c: number }>('SELECT COUNT(*) AS c FROM cached_images WHERE cover_art_id = ?', [token])[0].c;

let warn: jest.SpyInstance;

beforeAll(() => ensureNormalizedSchema(db()));
beforeEach(() => {
  for (const t of ['cached_albums', 'cached_items', 'albums', 'cached_images']) {
    db().runSync(`DELETE FROM ${t}`);
  }
  // Online and reachable: a failed source download purges the cover unless it is protected.
  connectivityStore.setState({ hasConnection: true, isServerReachable: true });
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

/** A partially cached cover: one small variant and no source, so caching it downloads the source. */
const seedPartial = (token: string): void => {
  db().runSync(
    "INSERT INTO cached_images (cover_art_id, size, ext, bytes, cached_at) VALUES (?, 50, 'jpg', 1, 0)",
    [token],
  );
};

const downloadedSong = {
  id: 's1',
  title: 'One',
  albumId: 'old-dir', // the file's directory, not the server album
  srcAlbumId: 'alb1',
  coverArt: 'dc-alb1:1_x',
  bytes: 1,
  duration: 1,
  suffix: 'mp3',
  formatCapturedAt: 0,
  downloadedAt: 0,
};

it.each(['album', 'perTrack'] as const)(
  'keeps both covers of a downloaded song in %s mode, and purges an unrelated cover',
  async (mode) => {
    layoutPreferencesStore.setState({ songCoverArtMode: mode });
    musicCacheStore.setState({ cachedSongs: { s1: downloadedSong }, cachedItems: {} });
    db().runSync("INSERT INTO albums (id, cover_art) VALUES ('alb1', 'al-alb1_h')");
    for (const t of ['al-alb1_h', 'dc-alb1:1_x', 'mf-unrelated']) seedPartial(t);

    await cacheSongCovers([
      { coverArt: 'dc-alb1:1_x', albumId: 'alb1' },
      { coverArt: 'mf-unrelated', albumId: null },
    ]);

    expect(rowsFor('al-alb1_h')).toBe(1);
    expect(rowsFor('dc-alb1:1_x')).toBe(1);
    expect(rowsFor('mf-unrelated')).toBe(0);
    // The failed downloads are reported; only the unrelated cover was actually purged.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 503 for coverArt=mf-unrelated'));
  },
);
