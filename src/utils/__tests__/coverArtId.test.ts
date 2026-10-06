import { coverArtForAlbum, coverArtForArtist, coverArtForPlaylist } from '../coverArtId';
import { type AlbumID3, type ArtistID3, type Playlist } from '../../services/subsonicService';

/**
 * Cover-art keys off the entity's `coverArt` VALUE, NEVER the entity id. (Songs go through the
 * cover resolver; see the imageCacheService resolver suites.)
 */
describe('coverArtId helpers', () => {
  it('coverArtForAlbum returns the coverArt value, never the id', () => {
    expect(coverArtForAlbum({ id: 'al-1', coverArt: 'cover-xyz' } as AlbumID3)).toBe('cover-xyz');
  });

  it('coverArtForArtist returns the coverArt value, never the id', () => {
    expect(coverArtForArtist({ id: 'ar-1', coverArt: 'cover-xyz' } as ArtistID3)).toBe('cover-xyz');
  });

  it('coverArtForPlaylist returns the coverArt value, never the id', () => {
    expect(coverArtForPlaylist({ id: 'pl-1', coverArt: 'cover-xyz' } as Playlist)).toBe('cover-xyz');
  });

  it('returns undefined when the entity has no coverArt', () => {
    expect(coverArtForAlbum({ id: 'al-1' } as AlbumID3)).toBeUndefined();
    expect(coverArtForArtist({ id: 'ar-1' } as ArtistID3)).toBeUndefined();
    expect(coverArtForPlaylist({ id: 'pl-1' } as Playlist)).toBeUndefined();
  });
});
