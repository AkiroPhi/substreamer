/**
 * Resolve the cover-art VALUE for a Subsonic entity.
 *
 * Per the OpenSubsonic spec, `getCoverArt?id=` takes the entity's `coverArt`
 * token (the opaque value from its metadata), NOT the entity id. We use that
 * `coverArt` value as both the image-cache key and the fetch id everywhere —
 * never the entity id. Servers where `coverArt !== id` (airsonic-advanced,
 * Gonic) return a placeholder/error for an entity id; the `coverArt` token works
 * on all servers.
 *
 * These cover an album, artist or playlist, whose cover is its own `coverArt`. A song's cover
 * depends on the cover mode and its album, so it goes through the cover resolver
 * (`imageCacheService.resolveDisplayImage`).
 *
 * Returns `undefined` when the entity has no usable `coverArt`; `CachedImage`
 * and `getCoverArtUrl` are null-safe for that.
 */

export function coverArtForAlbum(album: { coverArt?: string | null }): string | undefined {
  return album.coverArt ?? undefined;
}

export function coverArtForArtist(artist: { coverArt?: string | null }): string | undefined {
  return artist.coverArt ?? undefined;
}

export function coverArtForPlaylist(playlist: { coverArt?: string | null }): string | undefined {
  return playlist.coverArt ?? undefined;
}
