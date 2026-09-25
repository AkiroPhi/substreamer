/**
 * Re-key the entity id embedded in a Navidrome artwork token.
 *
 * Navidrome never stores `coverArt`; it derives it at response time from the entity's own
 * id — `ArtworkID{Kind, ID: <entity>.ID, Hash: <entity>.ImageHash}`
 * (`reference/navidrome/model/artwork_id.go:143-157`), rendered `<prefix>-<ID>[_<Hash>]`
 * by `String()` (`:61-68`). So when the id changes, so does the token, and only the
 * embedded id part moves: the prefix is fixed per kind and `Hash` is a content hash of the
 * image, which the re-key does not touch.
 *
 * Shapes we hold:
 *
 *     al-<albumId>[_<hash>]        albums, and songs falling back to album art
 *     ar-<artistId>[_<hash>]       artists
 *     mf-<songId>[_<hash>]         songs with their own embedded art
 *     dc-<albumId>:<disc>[_<hash>] songs on a multi-disc album
 *     pl-<playlistId>[_<hash>]     playlists
 *
 * **A song's token usually embeds an ALBUM id.** `MediaFile.CoverArtID()`
 * (`model/mediafile.go:135-151`) returns `mf-` only when the track has its own art, and
 * otherwise falls back to the disc or the album. So the id is looked up in the whole map,
 * never a per-table subset — which is also what makes this correct on an install where
 * albums moved and songs did not, or the reverse.
 */

/** Split on the FIRST `-` only: a legacy UUID id contains dashes. Mirrors `ParseArtworkID`. */
const FIRST_DASH = /^([^-]+)-(.+)$/;

/**
 * Rewrite the id inside an artwork token, leaving the prefix, disc index and content hash
 * exactly as they were.
 *
 * Anything that is not a recognisable token — or whose id is not in the map — comes back
 * untouched, so this is safe to run over a column that mixes tokens with nulls or with
 * values from another server generation.
 */
export function remapArtworkToken(
  token: string | null | undefined,
  lookup: (id: string) => string | undefined,
): string | null | undefined {
  if (!token) return token;

  const parts = FIRST_DASH.exec(token);
  if (parts === null) return token;
  const [, prefix, remainder] = parts;

  // The id runs to the first `_` (content hash) or `:` (disc index), whichever comes
  // first. Both suffixes are preserved verbatim.
  const hashAt = remainder.indexOf('_');
  const discAt = remainder.indexOf(':');
  const cuts = [hashAt, discAt].filter((i) => i >= 0);
  const cut = cuts.length > 0 ? Math.min(...cuts) : remainder.length;

  const id = remainder.slice(0, cut);
  const suffix = remainder.slice(cut);
  if (id === '') return token;

  const mapped = lookup(id);
  return mapped === undefined ? token : `${prefix}-${mapped}${suffix}`;
}
