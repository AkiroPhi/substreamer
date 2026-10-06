/**
 * Player artwork end to end through the real cover resolver and the SQLite substitute: the
 * lock screen / CarPlay / notification art for a queue is the same cover the app shows.
 */

jest.mock('../subsonicService', () => ({
  ...jest.requireActual('../subsonicService'),
  getStreamUrl: (id: string) => `https://server/stream/${id}`,
  getCoverArtUrl: (id: string, size: number) => `https://server/cover/${id}?size=${size}`,
}));

const mockLocalUris: Record<string, string> = {};
jest.mock('../musicCacheService', () => ({
  getLocalTrackUri: (id: string) => mockLocalUris[id] ?? null,
}));

import { getDb } from '../../store/persistence/db';
import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { layoutPreferencesStore } from '../../store/layoutPreferencesStore';
import { offlineModeStore } from '../../store/offlineModeStore';
import { buildPlayableQueue } from '../playerHelpers';
import type { Child } from '../subsonicService';

const db = () => getDb()!;

beforeAll(() => ensureNormalizedSchema(db()));
beforeEach(() => {
  for (const t of ['cached_albums', 'cached_items', 'albums', 'cached_images']) {
    db().runSync(`DELETE FROM ${t}`);
  }
  layoutPreferencesStore.setState({ songCoverArtMode: 'album' });
  offlineModeStore.setState({ offlineMode: true });
  mockLocalUris.s1 = 'file:///music/s1.mp3';
  mockLocalUris.s2 = 'file:///music/s2.mp3';
});

const seedImage = (token: string): void => {
  db().runSync(
    "INSERT INTO cached_images (cover_art_id, size, ext, bytes, cached_at) VALUES (?, 600, 'jpg', 1, 0)",
    [token],
  );
};

const songs = [
  { id: 's1', title: 'One', albumId: 'alb1', coverArt: 'dc-alb1:1_x' },
  { id: 's2', title: 'Two', albumId: 'alb1', coverArt: 'mf-s2_y' },
] as Child[];

describe('buildPlayableQueue artwork, offline, downloaded songs', () => {
  it('album mode: every track gets the ALBUM cover file, even with both tokens cached', async () => {
    db().runSync("INSERT INTO albums (id, cover_art) VALUES ('alb1', 'al-alb1_h')");
    seedImage('al-alb1_h');
    seedImage('dc-alb1:1_x');
    seedImage('mf-s2_y');

    const { rnTracks } = await buildPlayableQueue(songs);

    expect(rnTracks).toHaveLength(2);
    for (const t of rnTracks) {
      expect(t.artworkUrl).toContain('al-alb1_h');
      expect(t.artworkUrl).toContain('/600.jpg');
    }
  });

  it('album mode with only the album token cached still uses it', async () => {
    db().runSync("INSERT INTO albums (id, cover_art) VALUES ('alb1', 'al-alb1_h')");
    seedImage('al-alb1_h');

    const { rnTracks } = await buildPlayableQueue(songs);

    expect(rnTracks.map((t) => t.artworkUrl?.includes('al-alb1_h'))).toEqual([true, true]);
  });

  it("per-track mode: each track gets its own cover file", async () => {
    layoutPreferencesStore.setState({ songCoverArtMode: 'perTrack' });
    db().runSync("INSERT INTO albums (id, cover_art) VALUES ('alb1', 'al-alb1_h')");
    seedImage('al-alb1_h');
    seedImage('dc-alb1:1_x');
    seedImage('mf-s2_y');

    const { rnTracks } = await buildPlayableQueue(songs);

    expect(rnTracks[0].artworkUrl).toContain('dc-alb1');
    expect(rnTracks[1].artworkUrl).toContain('mf-s2_y');
  });

  it('nothing cached offline: no artwork (the player shows its placeholder), never a server URL', async () => {
    db().runSync("INSERT INTO albums (id, cover_art) VALUES ('alb1', 'al-alb1_h')");

    const { rnTracks } = await buildPlayableQueue(songs);

    expect(rnTracks.map((t) => t.artworkUrl)).toEqual([undefined, undefined]);
  });

  it('online with nothing cached: the server URL of the album cover', async () => {
    offlineModeStore.setState({ offlineMode: false });
    db().runSync("INSERT INTO albums (id, cover_art) VALUES ('alb1', 'al-alb1_h')");

    const { rnTracks } = await buildPlayableQueue(songs);

    expect(rnTracks[0].artworkUrl).toBe('https://server/cover/al-alb1_h?size=600');
  });
});
