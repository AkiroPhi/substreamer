import { getDb } from '../../../store/persistence/db';
import { ensureNormalizedSchema } from '../../createNormalizedTables';
import { albumCoverTokens, coverTokensWithImages } from '../coverArt';

const db = () => getDb()!;

const TABLES = ['cached_albums', 'cached_items', 'albums', 'cached_images'];

beforeAll(() => ensureNormalizedSchema(db()));
beforeEach(() => {
  for (const t of TABLES) db().runSync(`DELETE FROM ${t}`);
});

const seedAlbum = (id: string, coverArt: string | null): void => {
  db().runSync('INSERT INTO albums (id, cover_art) VALUES (?, ?)', [id, coverArt]);
};

const seedCachedAlbum = (id: string, coverArt: string | null): void => {
  db().runSync(
    'INSERT INTO cached_items (item_id, type, name, expected_song_count, last_sync_at, downloaded_at) ' +
      "VALUES (?, 'album', 'A', 1, 0, 0)",
    [id],
  );
  db().runSync('INSERT INTO cached_albums (item_id, cover_art) VALUES (?, ?)', [id, coverArt]);
};

const seedImage = (token: string, size: number, ext = 'jpg'): void => {
  db().runSync(
    'INSERT INTO cached_images (cover_art_id, size, ext, bytes, cached_at) VALUES (?, ?, ?, 1, 0)',
    [token, size, ext],
  );
};

describe('coverTokensWithImages', () => {
  it('prefers the library album token, then the downloaded album, then the song', async () => {
    seedAlbum('albLib', 'al-lib_1');
    seedAlbum('albBoth', 'al-both_1');
    seedCachedAlbum('albBoth', 'al-stale_0');
    seedCachedAlbum('albDl', 'al-dl_1');

    const rows = await coverTokensWithImages(db(), [
      { coverArt: 'dc-1', albumId: 'albLib' },
      { coverArt: 'dc-2', albumId: 'albBoth' },
      { coverArt: 'dc-3', albumId: 'albDl' },
      { coverArt: 'dc-4', albumId: 'albMissing' },
      { coverArt: 'mf-5', albumId: null },
    ]);

    expect(rows.map((r) => [r.index, r.token])).toEqual([
      [0, 'al-lib_1'],
      [1, 'al-both_1'],
      [2, 'al-dl_1'],
      [3, 'dc-4'],
      [4, 'mf-5'],
    ]);
  });

  it('treats empty album tokens as absent', async () => {
    seedAlbum('albEmpty', '');
    const rows = await coverTokensWithImages(db(), [{ coverArt: 'dc-1', albumId: 'albEmpty' }]);
    expect(rows[0].token).toBe('dc-1');
  });

  it('lists every cached variant of the resolved token, and none for an uncached one', async () => {
    seedAlbum('alb', 'al-1');
    seedImage('al-1', 600, 'jpg');
    seedImage('al-1', 150, 'webp');
    seedImage('dc-9', 600); // the song's own token — not the one resolved

    const rows = await coverTokensWithImages(db(), [
      { coverArt: 'dc-9', albumId: 'alb' },
      { coverArt: 'mf-2', albumId: null },
    ]);

    expect(rows.filter((r) => r.index === 0).map((r) => [r.size, r.ext]).sort()).toEqual([
      [150, 'webp'],
      [600, 'jpg'],
    ]);
    expect(rows.filter((r) => r.index === 1)).toEqual([{ index: 1, token: 'mf-2', size: null, ext: null }]);
  });

  it('yields a null token when there is nothing to resolve, and nothing for no lookups', async () => {
    const rows = await coverTokensWithImages(db(), [{ coverArt: null, albumId: null }]);
    expect(rows).toEqual([{ index: 0, token: null, size: null, ext: null }]);
    expect(await coverTokensWithImages(db(), [])).toEqual([]);
  });
});

describe('albumCoverTokens', () => {
  it('maps each album to its library or downloaded token, omitting albums without one', async () => {
    seedAlbum('a1', 'al-1');
    seedCachedAlbum('a2', 'al-2');
    seedAlbum('a3', null);

    const out = await albumCoverTokens(db(), ['a1', 'a2', 'a3', 'a4', 'a1', '']);

    expect([...out.entries()].sort()).toEqual([
      ['a1', 'al-1'],
      ['a2', 'al-2'],
    ]);
    expect(await albumCoverTokens(db(), [])).toEqual(new Map());
  });
});
