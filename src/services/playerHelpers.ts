/**
 * Stateless helpers for playerService. None of these touch the module's
 * own state machine; they only read from external stores and services.
 * Extracted so the main service can stay focused on its event handlers.
 */

import { type PlayerState, type RepeatMode, type TrackItem } from 'react-native-queue-player';

import i18n from '../i18n/i18n';
import { type EffectiveFormat } from '../types/audio';
import { completeSongFromCache, musicCacheStore } from '../store/musicCacheStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { imageCacheDiagnosticsStore } from '../store/imageCacheDiagnosticsStore';
import { playbackSettingsStore, type RepeatModeSetting } from '../store/playbackSettingsStore';
import { type PlaybackStatus } from '../store/playerStore';
import { resolveEffectiveFormat } from '../utils/effectiveFormat';
import { resolveDisplayImages } from './imageCacheService';
import { logImageCache } from './imageCacheLogger';
import { getLocalTrackUri } from './musicCacheService';
import { getStreamUrl, type Child } from './subsonicService';

/** Map our RepeatModeSetting to RNQP's RepeatMode string union. */
export function mapRepeatMode(mode: RepeatModeSetting): RepeatMode {
  switch (mode) {
    case 'all':
      return 'queue';
    case 'one':
      return 'track';
    default:
      return 'off';
  }
}

/** Map RNQP PlayerState to our simplified PlaybackStatus. */
export function mapState(state: PlayerState): PlaybackStatus {
  switch (state) {
    case 'playing':
      return 'playing';
    case 'paused':
      return 'paused';
    case 'buffering':
      return 'buffering';
    case 'loading':
      return 'loading';
    case 'ended':
    case 'error':
      return 'stopped';
    default:
      // 'none'
      return 'idle';
  }
}

/**
 * Build an EffectiveFormat stamp for a track being added to the queue.
 * If the track has a downloaded copy with a persisted format, use that;
 * otherwise resolve from the current streaming settings.
 */
export function stampQueueFormat(child: Child): EffectiveFormat {
  const downloadedSong = musicCacheStore.getState().cachedSongs[child.id];
  if (downloadedSong) {
    return {
      suffix: downloadedSong.suffix.toLowerCase(),
      bitRate: downloadedSong.bitRate,
      bitDepth: downloadedSong.bitDepth,
      samplingRate: downloadedSong.samplingRate,
      capturedAt: downloadedSong.formatCapturedAt,
    };
  }

  const { streamFormat, maxBitRate } = playbackSettingsStore.getState();
  return resolveEffectiveFormat({
    sourceSuffix: child.suffix,
    sourceBitRate: child.bitRate,
    sourceBitDepth: child.bitDepth,
    sourceSamplingRate: child.samplingRate,
    formatSetting: streamFormat,
    bitRateSetting: maxBitRate,
  });
}

/**
 * Convert a Child (Subsonic song) to an RNQP TrackItem.
 *
 * Returns `null` when the track can't be played right now:
 * - Offline mode + no local cached file → never hand the player a server
 *   stream URL (it would stall waiting on an unreachable server).
 * - No local URI AND stream-URL construction failed (e.g. auth not yet
 *   initialised) — an empty URL would stall the same way, so filter here.
 *
 * Callers must filter nulls out of the resulting array and treat an
 * all-null queue as "nothing playable" (toast + clearQueue).
 */
export function childToTrack(
  child: Child,
  artworkUrl?: string | null,
): TrackItem | null {
  const localUri = getLocalTrackUri(child.id);
  const offline = offlineModeStore.getState().offlineMode;
  if (!localUri && offline) return null;

  const url = localUri ?? getStreamUrl(child.id);
  if (!url) return null;

  // Diagnostic: a song the cache store reports as downloaded resolving to a
  // server stream URL means the in-memory track map missed it. Logged (gated).
  if (!localUri
    && imageCacheDiagnosticsStore.getState().enabled
    && musicCacheStore.getState().cachedSongs[child.id]) {
    logImageCache(`player stream-url-for-cached-song id=${child.id}`);
  }

  return {
    id: child.id,
    url,
    title: child.title,
    artist: child.artist ?? i18n.t('unknownArtist'),
    album: child.album ?? undefined,
    artworkUrl: artworkUrl ?? undefined,
    duration: child.duration ?? 0,
    ...replayGainFields(child),
  };
}

/**
 * The server's ReplayGain values in the player's shape. Any of the four fields
 * makes the player use these instead of the file's tags, so a song without
 * server values gets none. A peak of 0 is "not measured" (Gonic) and is dropped.
 */
function replayGainFields(child: Child): ReplayGainFields {
  const rg = child.replayGain;
  const out: ReplayGainFields = {};
  if (!rg) return out;
  const finite = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
  if (finite(rg.trackGain)) out.replayGainTrackGain = rg.trackGain;
  if (finite(rg.trackPeak) && rg.trackPeak > 0) out.replayGainTrackPeak = rg.trackPeak;
  if (finite(rg.albumGain)) out.replayGainAlbumGain = rg.albumGain;
  if (finite(rg.albumPeak) && rg.albumPeak > 0) out.replayGainAlbumPeak = rg.albumPeak;
  return out;
}

type ReplayGainFields = Partial<
  Pick<
    TrackItem,
    'replayGainTrackGain' | 'replayGainTrackPeak' | 'replayGainAlbumGain' | 'replayGainAlbumPeak'
  >
>;

/**
 * Build (RNQP tracks, filtered child queue) from a Child queue, dropping
 * entries that aren't currently playable. Preserves source order so callers
 * can translate desired indices onto the filtered queue by looking up the
 * original Child.
 *
 * This is the one funnel every queue entry point shares (play, add to queue, play
 * next, the boot restore, shuffle, the car), so it is where a track built from a
 * narrow list projection is completed: rendering a row needs a handful of columns,
 * but the queue feeds the lock screen, the details sheet and the permanent
 * listening history.
 */
export async function buildPlayableQueue(queue: readonly Child[]): Promise<{
  rnTracks: TrackItem[];
  filteredQueue: Child[];
}> {
  const songs = queue.map(completeSongFromCache);

  // Artwork for the whole queue through the one cover resolver, in one query: the cached
  // file, else the server URL online, else none (the player shows its placeholder).
  const artwork = await resolveDisplayImages(songs, 600, {
    offline: offlineModeStore.getState().offlineMode,
  });

  const rnTracks: TrackItem[] = [];
  const filteredQueue: Child[] = [];
  for (let i = 0; i < songs.length; i++) {
    const child = songs[i];
    const track = childToTrack(child, artwork[i].uri);
    if (track) {
      rnTracks.push(track);
      filteredQueue.push(child);
    }
  }
  return { rnTracks, filteredQueue };
}
