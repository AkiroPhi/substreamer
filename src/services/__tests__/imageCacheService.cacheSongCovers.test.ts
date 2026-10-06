/**
 * Downloads cache BOTH covers of every song — its own and its album's — whatever the cover
 * mode. Observed through the server fetches the image queue makes for covers not yet on disk.
 */

const mockFetchedUrls: string[] = [];
jest.mock('expo/fetch', () => ({
  fetch: jest.fn(async (url: string) => {
    mockFetchedUrls.push(url);
    return { ok: false, status: 503, headers: { get: () => null } };
  }),
}));

jest.mock('../subsonicService', () => ({
  ...jest.requireActual('../subsonicService'),
  getCoverArtUrl: (id: string, size: number) => `https://server/cover/${id}?size=${size}`,
}));

import { getDb } from '../../store/persistence/db';
import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { connectivityStore } from '../../store/connectivityStore';
import { layoutPreferencesStore } from '../../store/layoutPreferencesStore';
import { cacheSongCovers } from '../imageCacheService';

const db = () => getDb()!;

beforeAll(() => ensureNormalizedSchema(db()));
beforeEach(() => {
  for (const t of ['cached_albums', 'cached_items', 'albums', 'cached_images']) {
    db().runSync(`DELETE FROM ${t}`);
  }
  mockFetchedUrls.length = 0;
  // The stubbed fetch fails; with the server unreachable that is a transient failure, so the
  // image queue keeps its rows instead of purging them.
  connectivityStore.setState({ isServerReachable: false });
});

const fetchedTokens = (): string[] =>
  [...new Set(mockFetchedUrls.map((u) => decodeURIComponent(u.split('/cover/')[1].split('?')[0])))].sort();

it.each(['album', 'perTrack'] as const)(
  'caches the song cover AND its album cover in %s mode',
  async (mode) => {
    layoutPreferencesStore.setState({ songCoverArtMode: mode });
    db().runSync("INSERT INTO albums (id, cover_art) VALUES ('alb1', 'al-alb1_h')");

    await cacheSongCovers([
      { coverArt: 'dc-alb1:1_x', albumId: 'alb1' },
      { coverArt: 'mf-s2_y', albumId: 'alb1' },
    ]);

    expect(fetchedTokens()).toEqual(['al-alb1_h', 'dc-alb1:1_x', 'mf-s2_y']);
  },
);

it("uses the downloaded album's cover when the library doesn't hold the album", async () => {
  db().runSync(
    "INSERT INTO cached_items (item_id, type, name, expected_song_count, last_sync_at, downloaded_at) VALUES ('alb2', 'album', 'A', 1, 0, 0)",
  );
  db().runSync("INSERT INTO cached_albums (item_id, cover_art) VALUES ('alb2', 'al-alb2_h')");

  await cacheSongCovers([{ coverArt: 'dc-alb2:1_x', albumId: 'alb2' }]);

  expect(fetchedTokens()).toEqual(['al-alb2_h', 'dc-alb2:1_x']);
});

it('caches only the song cover when the album is unknown or `_unknown`', async () => {
  await cacheSongCovers([
    { coverArt: 'mf-1', albumId: 'missing' },
    { coverArt: 'mf-2', albumId: '_unknown' },
    { coverArt: null, albumId: null },
  ]);

  expect(fetchedTokens()).toEqual(['mf-1', 'mf-2']);
});

it('skips covers already fully on disk', async () => {
  db().runSync("INSERT INTO albums (id, cover_art) VALUES ('alb1', 'al-alb1_h')");
  for (const size of [50, 150, 300, 600]) {
    db().runSync(
      "INSERT INTO cached_images (cover_art_id, size, ext, bytes, cached_at) VALUES ('al-alb1_h', ?, 'jpg', 1, 0)",
      [size],
    );
  }

  await cacheSongCovers([{ coverArt: 'dc-alb1:1_x', albumId: 'alb1' }]);

  expect(fetchedTokens()).toEqual(['dc-alb1:1_x']);
});
