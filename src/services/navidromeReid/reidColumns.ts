/**
 * Exactly which columns the Navidrome re-key rewrites.
 *
 * A LITERAL list, checked by a drift test rather than generated at runtime. Generating it
 * was right when the surface was ~50 library columns; it is now a small, stable set, and
 * because this code is permanent the failure that matters is a future column being
 * silently picked up or silently missed. A literal list is reviewable at a glance and the
 * test fails loudly the moment the schema and this file disagree.
 *
 * Scope is `KEPT_TABLES` — the data with no server copy — minus `storage` (KV, handled
 * separately), `cached_images` and `image_download_queue` (the image cache is cleared, not
 * re-keyed), minus the seven `download_queue` tables (pending work, cleared), plus the
 * carve-outs that survive the library discard.
 *
 * Every entry was derived from `src/db/schema.ts` and cross-checked by sweeping for any
 * other column whose name contains id/art/path/key/uri/url — that sweep returned only
 * display names, `path` (Navidrome's synthesised `fakePath`), `shares.url` and image flags.
 */

/** Columns holding an entity id, keyed by table. */
export const REID_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  // Downloaded songs and their child rows.
  cached_songs: ['song_id', 'album_id', 'src_album_id', 'artist_id', 'parent', 'cover_art'],
  cached_song_genres: ['song_id'],
  cached_song_moods: ['song_id'],
  cached_song_artists: ['song_id', 'artist_id'],
  cached_song_album_artists: ['song_id', 'artist_id'],
  cached_song_contributors: ['song_id', 'artist_id'],

  // The downloaded album/playlist aggregates.
  cached_items: ['item_id', 'parent_album_id', 'cover_art_id'],
  cached_albums: ['item_id', 'artist_id', 'cover_art'],
  cached_playlists: ['item_id', 'cover_art'],
  cached_item_songs: ['item_id', 'song_id'],

  // Listening history. `id` on both parents is a local synthetic key — see NEVER_REKEY.
  scrobble_events: ['song_id', 'album_id', 'artist_id', 'parent', 'cover_art'],
  scrobble_artists: ['artist_id'],
  scrobble_album_artists: ['artist_id'],
  scrobble_contributors: ['artist_id'],
  pending_scrobble_events: ['song_id', 'album_id', 'artist_id', 'parent', 'cover_art'],
  pending_scrobble_artists: ['artist_id'],
  pending_scrobble_album_artists: ['artist_id'],
  pending_scrobble_contributors: ['artist_id'],

  // Bookmarks. `snapshot_id` is a local UUID — see NEVER_REKEY.
  queue_snapshot_songs: ['song_id', 'album_id', 'artist_id', 'parent', 'cover_art'],
  queue_snapshot_song_artists: ['artist_id'],
  queue_snapshot_song_album_artists: ['artist_id'],
  queue_snapshot_song_contributors: ['artist_id'],

  // User-authored corrections, which have no server copy at all.
  mbid_overrides: ['entity_id'],
  scrobble_exclusions: ['entity_id'],
};

/** Columns that LOOK like ids and must never be rewritten, with the reason. */
export const NEVER_REKEY: Readonly<Record<string, string>> = {
  // Dashed UUIDs — the exact shape canonicalId rewrites. Navidrome's own migration
  // excludes them, and re-keying one destroys a correction with no server copy.
  'cached_songs.music_brainz_id': 'MusicBrainz id',
  'cached_albums.music_brainz_id': 'MusicBrainz id',
  'scrobble_events.music_brainz_id': 'MusicBrainz id',
  'pending_scrobble_events.music_brainz_id': 'MusicBrainz id',
  'queue_snapshot_songs.music_brainz_id': 'MusicBrainz id',
  'mbid_overrides.mbid': 'MusicBrainz id (the KEY of this row is re-keyed, the value never)',

  // Local synthetic keys. Same shape family, no relationship to the server.
  'queue_snapshots.id': 'bookmark id — Crypto.randomUUID(), a dashed UUID',
  'queue_snapshot_songs.snapshot_id': 'FK to the bookmark id',
  'queue_snapshot_song_genres.snapshot_id': 'FK to the bookmark id',
  'queue_snapshot_song_moods.snapshot_id': 'FK to the bookmark id',
  'queue_snapshot_song_artists.snapshot_id': 'FK to the bookmark id',
  'queue_snapshot_song_album_artists.snapshot_id': 'FK to the bookmark id',
  'queue_snapshot_song_contributors.snapshot_id': 'FK to the bookmark id',
  'scrobble_events.id': 'local synthetic `${time}-${random}`',
  'pending_scrobble_events.id': 'local synthetic `${time}-${random}`',
  // Caught by the drift guard, not by hand: the children's FK to that synthetic key.
  // Re-keying these while the parent stays put would orphan every scrobble's tag rows.
  'scrobble_artists.scrobble_id': 'FK to the synthetic scrobble id',
  'scrobble_album_artists.scrobble_id': 'FK to the synthetic scrobble id',
  'scrobble_contributors.scrobble_id': 'FK to the synthetic scrobble id',
  'pending_scrobble_artists.scrobble_id': 'FK to the synthetic scrobble id',
  'pending_scrobble_album_artists.scrobble_id': 'FK to the synthetic scrobble id',
  'pending_scrobble_contributors.scrobble_id': 'FK to the synthetic scrobble id',
};

/**
 * One atomic batch per group, because `PRAGMA defer_foreign_keys` defers only to the
 * commit of the transaction it was set in — so a parent and every FK child referencing it
 * must be rewritten together or the batch fails at its own COMMIT.
 *
 * Only tables whose PRIMARY KEY is re-keyed head a group. A table that merely holds an id
 * in a non-key column has no FK pointing at that column and can go anywhere.
 */
export const FK_CLUSTERS: readonly (readonly string[])[] = [
  // cached_songs.song_id is the PK; six children reference it, one of which
  // (cached_item_songs) is the DDL's only ON DELETE no action.
  [
    'cached_songs',
    'cached_song_genres',
    'cached_song_moods',
    'cached_song_artists',
    'cached_song_album_artists',
    'cached_song_contributors',
    'cached_item_songs',
  ],
  // cached_items.item_id is the PK; three children reference it. cached_item_songs appears
  // in both clusters because it holds an FK to each — it is written once, in whichever
  // batch runs first, and the second finds nothing left to change.
  ['cached_items', 'cached_albums', 'cached_playlists', 'cached_item_songs'],
  // The remaining tables have no re-keyed primary key, so nothing points at them.
  ['scrobble_events', 'scrobble_artists', 'scrobble_album_artists', 'scrobble_contributors'],
  [
    'pending_scrobble_events',
    'pending_scrobble_artists',
    'pending_scrobble_album_artists',
    'pending_scrobble_contributors',
  ],
  [
    'queue_snapshot_songs',
    'queue_snapshot_song_artists',
    'queue_snapshot_song_album_artists',
    'queue_snapshot_song_contributors',
  ],
  ['mbid_overrides'],
  ['scrobble_exclusions'],
];

/** Columns whose value EMBEDS an id inside an artwork token rather than being one. */
export const ARTWORK_TOKEN_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  cached_songs: ['cover_art'],
  cached_albums: ['cover_art'],
  cached_playlists: ['cover_art'],
  cached_items: ['cover_art_id'],
  scrobble_events: ['cover_art'],
  pending_scrobble_events: ['cover_art'],
  queue_snapshot_songs: ['cover_art'],
};

/** Columns holding a JSON envelope with ids inside it. */
export const JSON_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  cached_songs: ['raw_json'],
  cached_items: ['raw_json'],
};
