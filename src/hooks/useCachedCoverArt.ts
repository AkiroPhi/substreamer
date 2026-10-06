/**
 * Hook that resolves a cover's URI through the one cover resolver
 * (`resolveDisplayImage`): the cached file, else the server URL online, else
 * `null`. Triggers a background cache download on a miss.
 *
 * Intended for non-Image consumers like `react-native-image-colors`.
 * Resolution is asynchronous and DB-authoritative — no synchronous
 * FS/SQLite — and the cache-update subscription re-resolves when a
 * download lands.
 */

import { useEffect, useReducer, useState } from 'react';

import {
  ensureCached,
  resolveDisplayImage,
  subscribeImageCacheUpdate,
} from '../services/imageCacheService';
import { layoutPreferencesStore } from '../store/layoutPreferencesStore';
import { offlineModeStore } from '../store/offlineModeStore';

/**
 * Returns a URI (file:// or http(s)://) for the cover, preferring the local cache, or `null`
 * while resolving / when nothing is displayable. Pass a song's `albumId` so album cover mode
 * resolves its album's cover.
 */
export function useCachedCoverArt(
  coverArtId: string | undefined,
  size: number,
  albumId?: string | null,
): string | null {
  const offline = offlineModeStore((s) => s.offlineMode);
  const songCoverArtMode = layoutPreferencesStore((s) => s.songCoverArtMode);
  const [resolved, setResolved] = useState<{ uri: string | null; token?: string }>({ uri: null });
  const [resolveToken, bumpResolve] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    if (!coverArtId) {
      setResolved({ uri: null });
      return;
    }
    let cancelled = false;
    resolveDisplayImage({ coverArt: coverArtId, albumId }, size, { offline }).then((r) => {
      if (cancelled) return;
      setResolved({ uri: r.uri, token: r.coverArtId });
      if (r.coverArtId && (r.uri == null || r.isRemote)) {
        ensureCached(r.coverArtId).catch(() => {
          /* non-critical: caching failure falls back to the network URL */
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [coverArtId, albumId, size, offline, songCoverArtMode, resolveToken]);

  // Re-resolve when a download/resize lands for the resolved cover.
  useEffect(() => {
    if (!resolved.token) return;
    return subscribeImageCacheUpdate(resolved.token, bumpResolve);
  }, [resolved.token]);

  return resolved.uri;
}
