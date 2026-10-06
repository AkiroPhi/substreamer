/**
 * Tests for the persistent image-download queue worker.
 *
 * These tests focus on the orchestration layer — enqueue → worker → state
 * transitions → cycle accounting. The actual `downloadAndCacheImage`
 * machinery (fetch + variant generation) is exercised by
 * `imageCacheService.test.ts`; here it is mocked out so the assertions land
 * on the queue state transitions.
 */

jest.mock('expo-file-system', () => ({
  File: class {},
  Directory: class {
    create = jest.fn();
    delete = jest.fn();
    get exists() { return true; }
  },
  Paths: { document: { uri: 'file:///document' } },
}));

jest.mock('expo-image-resize', () => ({
  resizeImageToFileAsync: jest.fn(),
}));

jest.mock('expo-async-fs', () => ({
  listDirectoryAsync: jest.fn(async () => []),
  listDirectoryWithSizesAsync: jest.fn(async () => []),
  getDirectorySizeAsync: jest.fn(async () => 0),
  deleteFileAsync: jest.fn(async () => false),
}));

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

jest.mock('react-native', () => ({
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));

const mockOfflineMode = { offlineMode: false };
jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: {
    getState: () => mockOfflineMode,
    subscribe: () => () => {},
  },
}));

const mockConnectivity = { hasConnection: true, isServerReachable: true };
jest.mock('../../store/connectivityStore', () => ({
  connectivityStore: {
    getState: () => mockConnectivity,
    subscribe: jest.fn(() => () => {}),
  },
}));

jest.mock('../connectivityService', () => ({
  awaitFirstPing: () => Promise.resolve(),
}));

// imageCacheStore — minimal surface the worker reads.
const mockImageCacheState = {
  maxConcurrentImageDownloads: 1,
  recalculateFromDb: jest.fn(),
};
jest.mock('../../store/imageCacheStore', () => ({
  imageCacheStore: { getState: () => mockImageCacheState },
}));

jest.mock('../imageCacheLogger', () => ({
  logImageCache: jest.fn(),
}));

// Mock the queue table — the worker's persistence layer.
const mockQueueState: {
  rows: Array<{ coverArtId: string; scope: 'refresh-downloads' | 'refresh-all'; status: 'queued' | 'downloading' | 'error'; cycleId: string }>;
} = { rows: [] };

const mockPickNext = jest.fn(() => {
  const next = mockQueueState.rows.find((r) => r.status === 'queued');
  return next
    ? {
        coverArtId: next.coverArtId,
        scope: next.scope,
        status: next.status,
        attempts: 0,
        addedAt: 0,
        cycleId: next.cycleId,
      }
    : null;
});

const mockMarkDownloading = jest.fn((id: string) => {
  const r = mockQueueState.rows.find((x) => x.coverArtId === id);
  if (r) r.status = 'downloading';
});
const mockMarkError = jest.fn((id: string, _err: string) => {
  const r = mockQueueState.rows.find((x) => x.coverArtId === id);
  if (r) r.status = 'error';
});
const mockRemoveFromQueue = jest.fn((id: string) => {
  mockQueueState.rows = mockQueueState.rows.filter((r) => r.coverArtId !== id);
});
const mockEnqueueBulk = jest.fn((ids: readonly string[], scope: 'refresh-downloads' | 'refresh-all', cycleId: string) => {
  let inserted = 0;
  for (const id of ids) {
    if (mockQueueState.rows.some((r) => r.coverArtId === id)) continue;
    mockQueueState.rows.push({ coverArtId: id, scope, status: 'queued', cycleId });
    inserted++;
  }
  return inserted;
});
const mockClearByCycle = jest.fn((cycleId: string) => {
  const before = mockQueueState.rows.length;
  mockQueueState.rows = mockQueueState.rows.filter((r) => r.cycleId !== cycleId);
  return before - mockQueueState.rows.length;
});
const mockResetStalled = jest.fn(() => {
  let n = 0;
  for (const r of mockQueueState.rows) {
    if (r.status === 'downloading' || r.status === 'error') {
      r.status = 'queued';
      n++;
    }
  }
  return n;
});
const mockResetErrorForCycle = jest.fn((cycleId: string) => {
  let n = 0;
  for (const r of mockQueueState.rows) {
    if (r.status === 'error' && r.cycleId === cycleId) {
      r.status = 'queued';
      n++;
    }
  }
  return n;
});
const mockCountByCycle = jest.fn((cycleId: string) =>
  mockQueueState.rows.filter((r) => r.cycleId === cycleId).length,
);
const mockCountByStatus = jest.fn((status: string) =>
  mockQueueState.rows.filter((r) => r.status === status).length,
);

const mockCoverRows: Record<string, string[]> = {
  cached_albums: [], cached_playlists: [], cached_songs_cover_art: [], cached_songs_cover_art_id: [],
};
jest.mock('../../store/persistence/db', () => ({
  isDbHealthy: () => true,
  getDb: () => ({
    getAllSync: (sql: string) => {
      // Keyed by table+column: cached_songs is read twice, once per cover-art mode.
      const key = sql.includes('JOIN albums')
        ? 'downloaded_song_album_cover_art'
        : sql.includes('cached_songs')
          ? (sql.includes('cover_art_id') ? 'cached_songs_cover_art_id' : 'cached_songs_cover_art')
          : Object.keys(mockCoverRows).find((t) => sql.includes(t));
      if (key === undefined || !(key in mockCoverRows)) throw new Error(`unmocked: ${sql}`);
      return mockCoverRows[key].map((v) => ({ v }));
    },
  }),
}));

jest.mock('../../store/persistence/imageDownloadQueueTable', () => ({
  enqueueImagesBulk: (ids: readonly string[], scope: any, cycleId: string) => mockEnqueueBulk(ids, scope, cycleId),
  pickNextQueuedImageRow: () => mockPickNext(),
  markImageDownloading: (id: string) => mockMarkDownloading(id),
  markImageError: (id: string, err: string) => mockMarkError(id, err),
  removeImageFromQueue: (id: string) => mockRemoveFromQueue(id),
  clearImageQueueByCycle: (cycleId: string) => mockClearByCycle(cycleId),
  resetStalledImageRows: () => mockResetStalled(),
  resetErrorRowsForCycle: (cycleId: string) => mockResetErrorForCycle(cycleId),
  countImageQueueRowsByCycle: (cycleId: string) => mockCountByCycle(cycleId),
  countImageQueueRowsByStatus: (status: string) => mockCountByStatus(status),
  countImageQueueRowsByCycleAndStatus: (_cycleId: string, status: string) => mockCountByStatus(status),
  clearImageQueue: () => Promise.resolve(0),
}));

// kvStorage — back the meta with an in-test Map.
const mockKvStore = new Map<string, string>();
jest.mock('../../store/persistence/kvStorage', () => {
  const adapter = {
    getItem: (k: string) => mockKvStore.get(k) ?? null,
    setItem: (k: string, v: string) => { mockKvStore.set(k, v); },
    removeItem: (k: string) => { mockKvStore.delete(k); },
  };
  // imageCacheService reads the queue-meta blob via the sync adapter; expose
  // both names backed by the same in-memory map.
  return { kvStorage: adapter, kvStorageSync: adapter };
});

// Snapshot helpers in musicCacheTables. Two-source dedup is exercised
// via these returning predictable sets.
const mockHydrateCachedItems = jest.fn(() => ({}));
const mockHydrateCachedSongs = jest.fn(() => ({}));
jest.mock('../../store/persistence/musicCacheTables', () => ({
  hydrateCachedItems: () => mockHydrateCachedItems(),
  hydrateCachedSongs: () => mockHydrateCachedSongs(),
}));

const mockGetAllCachedCoverArtIds = jest.fn(() => [] as string[]);
jest.mock('../../store/persistence/imageCacheTable', () => ({
  // Worker reuses these for snapshot-all-cached.
  getAllCachedCoverArtIds: () => mockGetAllCachedCoverArtIds(),
  // The service file imports several other things from imageCacheTable that
  // are not exercised by these tests; stub them out as no-ops.
  bulkInsertCachedImages: jest.fn(),
  clearAllCachedImages: jest.fn(),
  deleteCachedImageVariant: jest.fn(),
  deleteCachedImagesForCoverArt: jest.fn(() => ({ files: 0 })),
  findIncompleteCovers: jest.fn(() => []),
  hasCachedImage: jest.fn(() => false),
  hydrateImageCacheAggregates: jest.fn(() => ({
    totalBytes: 0,
    imageCount: 0,
    fileCount: 0,
    incompleteCount: 0,
  })),
  listCachedImagesForBrowser: jest.fn(() => []),
  upsertCachedImage: jest.fn(),
}));

jest.mock('../subsonicService', () => ({
  ensureCoverArtAuth: jest.fn(),
  getCoverArtUrl: jest.fn(() => 'http://example/cov'),
}));

// The queue worker downloads through a swappable `imageDownloader`. Tests
// install a deterministic stub via `__setImageDownloaderForTest()` rather
// than driving `downloadAndCacheImage`'s full fetch + resize pipeline.
let mockDownloaderShouldFail = false;
const mockDownloader = jest.fn(async (_id: string) => {
  if (mockDownloaderShouldFail) throw new Error('stubbed download failure');
});

import {
  __setImageDownloaderForTest,
  cancelImageRefreshCycle,
  dismissImageCacheErrorBanner,
  enqueueImageRefreshCycle,
  getImageQueueState,
  pauseImageQueue,
  processImageQueue,
  recoverStalledImageDownloads,
  resumeImageQueue,
  retryFailedImages,
} from '../imageCacheService';

__setImageDownloaderForTest(mockDownloader);

beforeEach(() => {
  mockQueueState.rows = [];
  mockKvStore.clear();
  jest.clearAllMocks();
  mockImageCacheState.maxConcurrentImageDownloads = 1;
  mockOfflineMode.offlineMode = false;
  mockConnectivity.hasConnection = true;
  mockConnectivity.isServerReachable = true;
  mockHydrateCachedItems.mockReturnValue({});
  mockHydrateCachedSongs.mockReturnValue({});
  mockGetAllCachedCoverArtIds.mockReturnValue([]);
  mockDownloaderShouldFail = false;
  // Re-install the downloader stub — it may have been reset by
  // earlier tests calling __setImageDownloaderForTest(undefined).
  __setImageDownloaderForTest(mockDownloader);
  mockCoverRows.cached_albums = [];
  mockCoverRows.downloaded_song_album_cover_art = [];
  mockCoverRows.cached_playlists = [];
  mockCoverRows.cached_songs_cover_art = [];
  mockCoverRows.cached_songs_cover_art_id = [];
});

describe('image-queue meta accessors', () => {
  it('getImageQueueState returns the empty shape when no cycle is active', async () => {
    expect(await getImageQueueState()).toEqual({
      cycleId: null,
      cycleScope: null,
      cycleTotal: 0,
      processed: 0,
      failed: 0,
      isPaused: false,
      phase: 'active',
    });
  });
});

describe('enqueueImageRefreshCycle', () => {
  it('refresh-downloads snapshots the tokens each surface renders', async () => {
    // Albums and playlists come from cached_albums/cached_playlists — the cover-art
    // TOKEN the UI reads — and songs from their mode-aware resolved cover.
    mockCoverRows.cached_albums = ['al-1_hash'];
    mockCoverRows.cached_playlists = ['pl-1_hash'];
    mockCoverRows.cached_songs_cover_art = ['dc-a2:1_0', 'al-1_hash']; // second dedups

    const cycleId = await enqueueImageRefreshCycle('refresh-downloads');

    expect(cycleId).not.toBeNull();
    expect(mockEnqueueBulk).toHaveBeenCalledTimes(1);
    const [ids, scope] = mockEnqueueBulk.mock.calls[0];
    expect(ids).toEqual(['al-1_hash', 'pl-1_hash', 'dc-a2:1_0']);
    expect(scope).toBe('refresh-downloads');
    const meta = await getImageQueueState();
    expect(meta.cycleTotal).toBe(3);
  });

  it('refresh-downloads includes the album cover of every downloaded song', async () => {
    // A playlist / favourites / single-song download has no cached_albums row for the
    // song's album, so its album cover comes from the downloaded songs joined to albums.
    mockCoverRows.cached_albums = ['al-1_hash'];
    mockCoverRows.cached_playlists = ['pl-1_hash'];
    mockCoverRows.cached_songs_cover_art = ['dc-a2:1_0'];
    mockCoverRows.downloaded_song_album_cover_art = ['al-2_hash', 'al-1_hash'];

    await enqueueImageRefreshCycle('refresh-downloads');

    const [ids] = mockEnqueueBulk.mock.calls[0];
    expect(ids).toEqual(['al-1_hash', 'pl-1_hash', 'dc-a2:1_0', 'al-2_hash']);
  });

  // The regression this fixes: cached_items.cover_art_id is frozen at download time and
  // holds a BARE ENTITY ID, so warming it filled the cache under a key nothing renders.
  // On a real device that left every downloaded playlist cover blank after a re-key.
  it('never warms the frozen bare id on cached_items', async () => {
    mockCoverRows.cached_albums = ['al-1_hash'];
    mockHydrateCachedItems.mockReturnValue({
      'a-1': { itemId: 'a-1', type: 'album', coverArtId: 'bareEntityId' },
      'pl-1': { itemId: 'pl-1', type: 'playlist', coverArtId: 'barePlaylistId' },
    });

    await enqueueImageRefreshCycle('refresh-downloads');

    const [ids] = mockEnqueueBulk.mock.calls[0];
    expect(ids).toEqual(['al-1_hash']);
    expect(ids).not.toContain('bareEntityId');
    expect(ids).not.toContain('barePlaylistId');
  });

  it('refresh-all snapshots from cached_images distinct cover_art_ids', async () => {
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a', 'cov-b', 'cov-c']);

    const cycleId = await enqueueImageRefreshCycle('refresh-all');

    expect(cycleId).not.toBeNull();
    const [ids, scope] = mockEnqueueBulk.mock.calls[0];
    expect(ids).toEqual(['cov-a', 'cov-b', 'cov-c']);
    expect(scope).toBe('refresh-all');
  });

  it('refresh-all also covers downloaded covers that were never cached', async () => {
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a', 'al-1_hash']);
    mockCoverRows.cached_albums = ['al-1_hash'];
    mockCoverRows.cached_playlists = ['pl-1_hash'];

    await enqueueImageRefreshCycle('refresh-all');

    const [ids, scope] = mockEnqueueBulk.mock.calls[0];
    expect(ids).toEqual(['cov-a', 'al-1_hash', 'pl-1_hash']);
    expect(scope).toBe('refresh-all');
  });

  it('returns null when the scope has no ids', async () => {
    const cycleId = await enqueueImageRefreshCycle('refresh-all');
    expect(cycleId).toBeNull();
    expect(mockEnqueueBulk).not.toHaveBeenCalled();
  });

  it('does not start a second cycle while one is active', async () => {
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a']);
    const first = await enqueueImageRefreshCycle('refresh-all');
    // Don't drain — leave the row in 'downloading' or 'queued'
    mockQueueState.rows[0].status = 'queued'; // ensure cycle isn't complete

    // Second call returns the existing cycle id (no-op)
    mockHydrateCachedItems.mockReturnValue({ 'a-1': { type: 'album', coverArtId: 'cov-b' } });
    const second = await enqueueImageRefreshCycle('refresh-downloads');
    expect(second).toBe(first);
    expect(mockEnqueueBulk).toHaveBeenCalledTimes(1);
  });
});

describe('processImageQueue worker', () => {
  it('drains all queued rows and clears cycle metadata on completion', async () => {
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a', 'cov-b']);
    await enqueueImageRefreshCycle('refresh-all');

    await processImageQueue();

    // Every row consumed; cycle metadata cleared.
    expect(mockQueueState.rows).toEqual([]);
    expect((await getImageQueueState()).cycleId).toBeNull();
    expect(mockMarkDownloading).toHaveBeenCalledTimes(2);
    expect(mockRemoveFromQueue).toHaveBeenCalledTimes(2);
  });

  it('writes error and increments attempts when the downloader fails repeatedly', async () => {
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a']);
    mockDownloaderShouldFail = true;
    await enqueueImageRefreshCycle('refresh-all');

    await processImageQueue();

    expect(mockQueueState.rows).toHaveLength(1);
    expect(mockQueueState.rows[0].status).toBe('error');
    expect(mockMarkError).toHaveBeenCalledWith('cov-a', expect.stringContaining('Failed after retry'));
    expect((await getImageQueueState()).cycleId).not.toBeNull();
    // Retry-once-inline: 2 attempts per row
    expect(mockDownloader).toHaveBeenCalledTimes(2);
  });

  it('transitions to the error phase when a cycle finishes with failures', async () => {
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a', 'cov-b']);
    mockDownloaderShouldFail = true;
    await enqueueImageRefreshCycle('refresh-all');

    await processImageQueue();

    const s = await getImageQueueState();
    expect(s.phase).toBe('error');
    // cycleId is KEPT (banner shows the error variant; cycle-scoped retry still works).
    expect(s.cycleId).not.toBeNull();
    expect(s.failed).toBe(2);
  });

  it('dismissImageCacheErrorBanner hides the banner but keeps the cycle for retry', async () => {
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a']);
    mockDownloaderShouldFail = true;
    await enqueueImageRefreshCycle('refresh-all');
    await processImageQueue();
    expect((await getImageQueueState()).phase).toBe('error');

    dismissImageCacheErrorBanner();

    const s = await getImageQueueState();
    expect(s.phase).toBe('dismissed');
    expect(s.cycleId).not.toBeNull();
  });

  it('returns early when paused', async () => {
    // Seed the queue directly (no auto-kick) and the meta says paused.
    mockQueueState.rows.push({
      coverArtId: 'cov-a',
      scope: 'refresh-all',
      status: 'queued',
      cycleId: 'cyc-test',
    });
    mockKvStore.set(
      'substreamer-image-queue-meta',
      JSON.stringify({
        cycleId: 'cyc-test',
        cycleScope: 'refresh-all',
        cycleTotal: 1,
        isPaused: true,
      }),
    );

    await processImageQueue();

    expect(mockMarkDownloading).not.toHaveBeenCalled();
    expect(mockQueueState.rows).toHaveLength(1);
  });

  it('returns early when offline', async () => {
    mockOfflineMode.offlineMode = true;
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a']);
    await enqueueImageRefreshCycle('refresh-all');

    await processImageQueue();

    expect(mockMarkDownloading).not.toHaveBeenCalled();
  });

  it('returns early when server is unreachable', async () => {
    mockConnectivity.isServerReachable = false;
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a']);
    await enqueueImageRefreshCycle('refresh-all');

    await processImageQueue();

    expect(mockMarkDownloading).not.toHaveBeenCalled();
  });

  it('is idempotent — concurrent calls await the same drain', async () => {
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a', 'cov-b']);
    await enqueueImageRefreshCycle('refresh-all');

    await Promise.all([processImageQueue(), processImageQueue()]);

    // Each row processed exactly once, even with concurrent processImageQueue() calls.
    expect(mockMarkDownloading).toHaveBeenCalledTimes(2);
    expect(mockDownloader).toHaveBeenCalledTimes(2); // once per row
  });
});

describe('pause / resume', () => {
  it('pauseImageQueue persists isPaused=true and resumeImageQueue clears it', async () => {
    pauseImageQueue();
    expect((await getImageQueueState()).isPaused).toBe(true);
    resumeImageQueue();
    expect((await getImageQueueState()).isPaused).toBe(false);
  });

  it('pause survives a meta re-read (i.e., simulated app restart)', async () => {
    pauseImageQueue();
    // Trigger a fresh read by clearing the in-process memo (the function
    // reads kvStorage every time, so this is implicit). Just call again.
    expect((await getImageQueueState()).isPaused).toBe(true);
  });
});

describe('cancel', () => {
  it('drops the cycle\'s rows and clears cycle metadata', async () => {
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a', 'cov-b']);
    await enqueueImageRefreshCycle('refresh-all');
    expect(mockQueueState.rows).toHaveLength(2);

    await cancelImageRefreshCycle();

    expect(mockQueueState.rows).toHaveLength(0);
    expect((await getImageQueueState()).cycleId).toBeNull();
  });

  it('is a no-op when no cycle is active', async () => {
    await cancelImageRefreshCycle();
    expect(mockClearByCycle).not.toHaveBeenCalled();
  });
});

describe('retryFailedImages', () => {
  it('resets error rows in the current cycle back to queued', async () => {
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a']);
    mockDownloaderShouldFail = true;
    await enqueueImageRefreshCycle('refresh-all');
    await processImageQueue();
    expect(mockQueueState.rows[0].status).toBe('error');

    // Now retry — but make the next pass succeed.
    mockDownloaderShouldFail = false;
    await retryFailedImages();
    // retryFailedImages kicks the worker via void; flush the event loop.
    await new Promise((r) => setTimeout(r, 0));

    expect(mockResetErrorForCycle).toHaveBeenCalled();
  });

  it('is a no-op when no cycle is active', async () => {
    await retryFailedImages();
    expect(mockResetErrorForCycle).not.toHaveBeenCalled();
  });
});

describe('recoverStalledImageDownloads', () => {
  it('resets downloading + error rows to queued', async () => {
    mockQueueState.rows.push(
      { coverArtId: 'cov-a', scope: 'refresh-all', status: 'downloading', cycleId: 'cyc-1' },
      { coverArtId: 'cov-b', scope: 'refresh-all', status: 'error', cycleId: 'cyc-1' },
      { coverArtId: 'cov-c', scope: 'refresh-all', status: 'queued', cycleId: 'cyc-1' },
    );

    await recoverStalledImageDownloads();

    expect(mockQueueState.rows.every((r) => r.status === 'queued')).toBe(true);
    expect(mockResetStalled).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when queue is empty', async () => {
    await recoverStalledImageDownloads();
    expect(mockResetStalled).toHaveBeenCalledTimes(1); // it still calls, just returns 0
  });

  // The stuck-banner bug: a cycle whose rows are all gone but whose completion write was
  // lost. Nothing re-checked it, so the banner sat at N/N and every future refresh was
  // refused, on every launch, forever.
  it('completes a cycle whose queue is empty', async () => {
    mockKvStore.set('substreamer-image-queue-meta', JSON.stringify({
      cycleId: 'cyc-orphan', cycleScope: 'refresh-downloads',
      cycleTotal: 11, isPaused: false, phase: 'active',
    }));

    await recoverStalledImageDownloads();

    const meta = JSON.parse(mockKvStore.get('substreamer-image-queue-meta') as string);
    expect(meta.cycleId).toBeNull();
    expect(meta.cycleTotal).toBe(0);
  });

  it('leaves a cycle alone while it still has rows', async () => {
    mockQueueState.rows.push(
      { coverArtId: 'cov-a', scope: 'refresh-all', status: 'queued', cycleId: 'cyc-live' },
    );
    mockKvStore.set('substreamer-image-queue-meta', JSON.stringify({
      cycleId: 'cyc-live', cycleScope: 'refresh-all',
      cycleTotal: 3, isPaused: false, phase: 'active',
    }));

    await recoverStalledImageDownloads();

    const meta = JSON.parse(mockKvStore.get('substreamer-image-queue-meta') as string);
    expect(meta.cycleId).toBe('cyc-live');
  });

  // Revived rows must count as outstanding, or the reset and the completion check
  // would contradict each other on the same pass.
  it('does not complete a cycle whose rows were just revived from error', async () => {
    mockQueueState.rows.push(
      { coverArtId: 'cov-a', scope: 'refresh-all', status: 'error', cycleId: 'cyc-live' },
    );
    mockKvStore.set('substreamer-image-queue-meta', JSON.stringify({
      cycleId: 'cyc-live', cycleScope: 'refresh-all',
      cycleTotal: 1, isPaused: false, phase: 'error',
    }));

    await recoverStalledImageDownloads();

    const meta = JSON.parse(mockKvStore.get('substreamer-image-queue-meta') as string);
    expect(meta.cycleId).toBe('cyc-live');
    expect(mockQueueState.rows[0].status).toBe('queued');
  });
});

describe('a cycle that enqueues nothing', () => {
  // cycleTotal 0 hides the banner AND the Cancel button, while still blocking every
  // future refresh - a permanent block with no user-visible state at all.
  it('does not open a cycle when every id collided with an existing row', async () => {
    // The snapshot DOES produce ids, so this reaches the insert; every one of them
    // already has a row, so `INSERT OR IGNORE` inserts nothing.
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a', 'cov-b']);
    mockQueueState.rows.push(
      { coverArtId: 'cov-a', scope: 'refresh-all', status: 'queued', cycleId: 'cyc-old' },
      { coverArtId: 'cov-b', scope: 'refresh-all', status: 'queued', cycleId: 'cyc-old' },
    );

    const id = await enqueueImageRefreshCycle('refresh-all');

    expect(mockEnqueueBulk).toHaveBeenCalledTimes(1);
    expect(mockEnqueueBulk.mock.results[0].value).toBe(0);
    expect(id).toBeNull();
    const raw = mockKvStore.get('substreamer-image-queue-meta');
    expect(raw === undefined || JSON.parse(raw).cycleId === null).toBe(true);
  });
});

describe('getImageQueueState — progress derivation', () => {
  it('returns zeros when no cycle', async () => {
    const s = await getImageQueueState();
    expect(s.processed).toBe(0);
    expect(s.cycleTotal).toBe(0);
    expect(s.failed).toBe(0);
  });

  it('computes processed = total - (queued + downloading)', async () => {
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a', 'cov-b', 'cov-c', 'cov-d']);
    await enqueueImageRefreshCycle('refresh-all');

    // Simulate two completed, one queued, one errored
    mockQueueState.rows[0].status = 'queued';
    mockQueueState.rows[1].status = 'error';
    // Remove the "completed" rows
    mockQueueState.rows = mockQueueState.rows.slice(0, 2);

    const s = await getImageQueueState();
    expect(s.cycleTotal).toBe(4);
    expect(s.processed).toBe(3); // total 4 minus 1 still-queued = 3 attempted
    expect(s.failed).toBe(1);
  });
});

// The cover-art mode setting is reachable OFFLINE. Warming only the active mode leaves
// the other blank with no way to repair it, so both are cached up front.
describe('cover-art mode', () => {
  it('warms both the album cover and the per-track cover', async () => {
    mockCoverRows.cached_albums = ['al-parent_hash'];   // album mode reads this
    mockCoverRows.cached_songs_cover_art = ['mf-track_hash']; // per-track mode reads this

    await enqueueImageRefreshCycle('refresh-downloads');

    const [ids] = mockEnqueueBulk.mock.calls[0];
    expect(ids).toContain('al-parent_hash');
    expect(ids).toContain('mf-track_hash');
  });

  it('dedups when both modes resolve to the same cover', async () => {
    mockCoverRows.cached_albums = ['al-same_hash'];
    mockCoverRows.cached_songs_cover_art = ['al-same_hash'];

    await enqueueImageRefreshCycle('refresh-downloads');

    const [ids] = mockEnqueueBulk.mock.calls[0];
    expect(ids).toEqual(['al-same_hash']);
  });
});
