/**
 * The one cover resolver against the real SQLite substitute: which token a subject resolves to
 * in each cover mode, and which image it shows (cached file, server URL, or nothing).
 */

jest.mock('../subsonicService', () => ({
  ...jest.requireActual('../subsonicService'),
  getCoverArtUrl: (id: string, size: number) => `https://server/cover/${id}?size=${size}`,
}));

import { getDb } from '../../store/persistence/db';
import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { layoutPreferencesStore } from '../../store/layoutPreferencesStore';
import { reportBadRemote, resolveDisplayImage, resolveDisplayImages } from '../imageCacheService';

const db = () => getDb()!;

beforeAll(() => ensureNormalizedSchema(db()));
beforeEach(() => {
  for (const t of ['cached_albums', 'cached_items', 'albums', 'cached_images']) {
    db().runSync(`DELETE FROM ${t}`);
  }
  layoutPreferencesStore.setState({ songCoverArtMode: 'album' });
});

const seedAlbum = (id: string, coverArt: string): void => {
  db().runSync('INSERT INTO albums (id, cover_art) VALUES (?, ?)', [id, coverArt]);
};
const seedImage = (token: string, size: number, ext = 'jpg'): void => {
  db().runSync(
    'INSERT INTO cached_images (cover_art_id, size, ext, bytes, cached_at) VALUES (?, ?, ?, 1, 0)',
    [token, size, ext],
  );
};

const song = { coverArt: 'dc-alb1:1_x', albumId: 'alb1' };

describe('resolveDisplayImage — which token', () => {
  it('album mode: a song shows its ALBUM cover, even when the song token is cached too', async () => {
    seedAlbum('alb1', 'al-alb1_h');
    seedImage('al-alb1_h', 600);
    seedImage('dc-alb1:1_x', 600);

    const r = await resolveDisplayImage(song, 600, { offline: true });

    expect(r.coverArtId).toBe('al-alb1_h');
    expect(r.isRemote).toBe(false);
    expect(r.uri).toContain('/600.jpg');
    expect(r.uri).toContain('al-alb1_h');
  });

  it('per-track mode: a song shows its own cover', async () => {
    layoutPreferencesStore.setState({ songCoverArtMode: 'perTrack' });
    seedAlbum('alb1', 'al-alb1_h');
    seedImage('dc-alb1:1_x', 600);

    const r = await resolveDisplayImage(song, 600, { offline: true });

    expect(r.coverArtId).toBe('dc-alb1:1_x');
    expect(r.uri).not.toBeNull();
  });

  it("falls back to the song's own token when the album is unknown or `_unknown`", async () => {
    const [missing, unknown] = await resolveDisplayImages(
      [song, { coverArt: 'mf-2', albumId: '_unknown' }],
      600,
      { offline: false },
    );
    expect(missing.coverArtId).toBe('dc-alb1:1_x');
    expect(unknown.coverArtId).toBe('mf-2');
  });

  it('an album / artist / playlist subject uses its own coverArt', async () => {
    seedAlbum('alb1', 'al-alb1_h');
    const r = await resolveDisplayImage({ coverArt: 'ar-9' }, 300, { offline: false });
    expect(r.coverArtId).toBe('ar-9');
  });
});

describe('resolveDisplayImage — which image', () => {
  it('uses the exact size, else the 600 source', async () => {
    seedAlbum('alb1', 'al-alb1_h');
    seedImage('al-alb1_h', 300, 'webp');
    seedImage('al-alb1_h', 600, 'jpg');

    expect((await resolveDisplayImage(song, 300, { offline: true })).uri).toContain('/300.webp');
    expect((await resolveDisplayImage(song, 150, { offline: true })).uri).toContain('/600.jpg');
  });

  it('online with nothing cached: the server URL for the resolved token', async () => {
    seedAlbum('alb1', 'al-alb1_h');
    const r = await resolveDisplayImage(song, 600, { offline: false });
    expect(r).toEqual({
      coverArtId: 'al-alb1_h',
      uri: 'https://server/cover/al-alb1_h?size=600',
      isRemote: true,
    });
  });

  it('offline with nothing cached: no image (placeholder), token still reported', async () => {
    seedAlbum('alb1', 'al-alb1_h');
    expect(await resolveDisplayImage(song, 600, { offline: true })).toEqual({
      coverArtId: 'al-alb1_h',
      uri: null,
      isRemote: false,
    });
  });

  it('skipCache goes to the server URL even when a file is cached', async () => {
    seedAlbum('alb1', 'al-alb1_h');
    seedImage('al-alb1_h', 600);
    expect((await resolveDisplayImage(song, 600, { offline: false, skipCache: true })).isRemote).toBe(true);
  });

  it('a token whose remote URL failed gets no image', async () => {
    seedAlbum('alb1', 'al-alb1_h');
    await reportBadRemote('al-alb1_h');
    expect((await resolveDisplayImage(song, 600, { offline: false })).uri).toBeNull();
  });

  it('no coverArt at all: nothing to show', async () => {
    expect(await resolveDisplayImage({}, 600, { offline: false })).toEqual({
      coverArtId: undefined,
      uri: null,
      isRemote: false,
    });
  });

  it("a failed read falls back to each subject's own token instead of throwing", async () => {
    db().runSync('DROP TABLE cached_images');
    try {
      const r = await resolveDisplayImage(song, 600, { offline: false });
      expect(r.coverArtId).toBe('dc-alb1:1_x');
      expect(r.isRemote).toBe(true);
    } finally {
      ensureNormalizedSchema(db());
    }
  });
});
