/**
 * Ordering is the contract here, not just the outcome. The pass is one-shot and
 * irreversible, and several steps are only safe in one position — so this records the
 * sequence of destructive calls and asserts it, rather than checking each in isolation.
 */

const mockCalls: string[] = [];
const record = <T>(name: string, value?: T) => () => {
  mockCalls.push(name);
  return Promise.resolve(value);
};

jest.mock('../../../store/persistence/db', () => ({
  getDb: () => ({
    runAsync: (sql: string) => {
      if (sql.includes('queue_snapshots')) mockCalls.push('clearLiveQueue');
      if (sql.includes('download_queue')) mockCalls.push('clearDownloadQueue');
      return Promise.resolve({ changes: 0 });
    },
  }),
}));

jest.mock('../../../store/persistence/imageDownloadQueueTable', () => ({
  clearImageQueue: () => { mockCalls.push('clearImageQueue'); return Promise.resolve(0); },
}));

jest.mock('../../imageCacheService', () => ({
  cancelImageRefreshCycle: () => { mockCalls.push('cancelImageRefreshCycle'); return Promise.resolve(); },
  clearImageCache: () => { mockCalls.push('clearImageCache'); return Promise.resolve(); },
  enqueueImageRefreshCycle: () => { mockCalls.push('enqueueImageRefreshCycle'); return Promise.resolve(null); },
}));

let mockPairs = 3;
jest.mock('../reidMap', () => ({
  createIdMap: record('createIdMap'),
  buildIdMap: () => { mockCalls.push('buildIdMap'); return Promise.resolve(mockPairs); },
  idMapSize: () => Promise.resolve(mockPairs),
  dropIdMap: record('dropIdMap'),
}));

let mockFkOk = true;
jest.mock('../reidRekey', () => ({
  verifyDeferredForeignKeys: () => Promise.resolve(mockFkOk),
  rekeyPlainColumns: record('rekeyPlainColumns'),
  deleteSupersededRows: () => { mockCalls.push('deleteSupersededRows'); return Promise.resolve(0); },
  rekeyEmbeddedIds: record('rekeyEmbeddedIds'),
}));

let mockFileResult = { moved: 44, missing: 0, failed: 0 };
jest.mock('../reidFiles', () => ({
  moveDownloadedFiles: () => { mockCalls.push('moveDownloadedFiles'); return Promise.resolve(mockFileResult); },
}));

jest.mock('../reidKv', () => ({ rekeyKvBlobs: record('rekeyKvBlobs') }));
jest.mock('../reidLibrary', () => ({
  discardLibrary: () => { mockCalls.push('discardLibrary'); return Promise.resolve(45); },
}));

let mockVerdict = 'run';
const mockSetReidState = jest.fn((s: string) => mockCalls.push(`setReidState:${s}`));
jest.mock('../reidMarker', () => ({
  reidVerdict: () => mockVerdict,
  setReidState: (s: string) => mockSetReidState(s),
  setUserConfirmedReid: jest.fn(),
}));

jest.mock('../../../store/persistence/rehydrate', () => ({
  rehydrateAllStores: () => { mockCalls.push('rehydrateAllStores'); return Promise.resolve({ failed: [] }); },
}));
jest.mock('../../musicCacheService', () => ({
  rebuildTrackMaps: record('rebuildTrackMaps'),
}));
jest.mock('../../../store/ratingStore', () => ({
  ratingStore: { persist: { rehydrate: () => Promise.resolve() } },
}));
jest.mock('../../../store/syncStatusStore', () => ({
  syncStatusStore: { persist: { rehydrate: () => Promise.resolve() } },
}));
jest.mock('../../../store/persistence', () => ({
  kvStorage: { setItem: () => Promise.resolve() },
}));
jest.mock('../../librarySyncLogger', () => ({
  logLibrarySync: jest.fn(),
  flushLibrarySyncLog: () => Promise.resolve(),
}));
jest.mock('../../dataModelUpgradeService', () => ({
  MIGRATION_DONE_KEY: 'k', MIGRATION_VERSION: '3',
}));

import { migrationGateStore } from '../../../store/migrationGateStore';
import { runNavidromeReidIfNeeded } from '../runNavidromeReid';

beforeEach(() => {
  mockCalls.length = 0;
  mockPairs = 3;
  mockFkOk = true;
  mockFileResult = { moved: 44, missing: 0, failed: 0 };
  mockVerdict = 'run';
  mockSetReidState.mockClear();
  migrationGateStore.getState().reset();
});

const idx = (name: string): number => mockCalls.indexOf(name);

describe('the pass ordering', () => {
  it('clears the image queue up front, with the other queues', async () => {
    await runNavidromeReidIfNeeded();

    // Every row in it names a retired id. It must go before the cache is cleared and
    // before the re-warm enqueues, or stale rows are retried against ids the server no
    // longer has - and the re-warm's ids collide with them.
    expect(idx('clearImageQueue')).toBeGreaterThan(-1);
    expect(idx('clearImageQueue')).toBeLessThan(idx('clearImageCache'));
    expect(idx('clearImageQueue')).toBeLessThan(idx('enqueueImageRefreshCycle'));
    expect(idx('clearImageQueue')).toBeLessThan(idx('rekeyPlainColumns'));
  });

  it('moves files only after the database is re-keyed', async () => {
    await runNavidromeReidIfNeeded();
    expect(idx('rekeyPlainColumns')).toBeLessThan(idx('moveDownloadedFiles'));
    expect(idx('rekeyEmbeddedIds')).toBeLessThan(idx('moveDownloadedFiles'));
  });

  it('discards the library before the stores rehydrate', async () => {
    await runNavidromeReidIfNeeded();
    expect(idx('discardLibrary')).toBeLessThan(idx('rehydrateAllStores'));
  });

  it('re-warms artwork AFTER the rehydrate, so purge protection sees current state', async () => {
    await runNavidromeReidIfNeeded();
    expect(idx('rehydrateAllStores')).toBeLessThan(idx('enqueueImageRefreshCycle'));
    expect(idx('rebuildTrackMaps')).toBeLessThan(idx('enqueueImageRefreshCycle'));
  });

  it('stamps complete last, after every step that can fail', async () => {
    await runNavidromeReidIfNeeded();
    const done = idx('setReidState:complete');
    expect(done).toBeGreaterThan(idx('moveDownloadedFiles'));
    expect(done).toBeGreaterThan(idx('discardLibrary'));
    expect(done).toBeGreaterThan(idx('rehydrateAllStores'));
    expect(done).toBe(mockCalls.length - 1);
  });
});

describe('the pass refuses to write when it should', () => {
  it('destroys nothing when the map is empty', async () => {
    mockPairs = 0;
    await runNavidromeReidIfNeeded();

    expect(mockCalls).not.toContain('clearLiveQueue');
    expect(mockCalls).not.toContain('clearImageQueue');
    expect(mockCalls).not.toContain('discardLibrary');
    expect(mockCalls).toContain('setReidState:complete');
  });

  it('writes nothing when deferred foreign keys are unsupported', async () => {
    mockFkOk = false;
    await runNavidromeReidIfNeeded();

    expect(mockCalls).not.toContain('clearImageQueue');
    expect(mockCalls).not.toContain('rekeyPlainColumns');
    expect(migrationGateStore.getState().failed).toBe(true);
  });

  it('does not stamp complete when a file fails to move', async () => {
    mockFileResult = { moved: 40, missing: 0, failed: 4 };
    await runNavidromeReidIfNeeded();

    expect(mockCalls).not.toContain('setReidState:complete');
    expect(migrationGateStore.getState().failed).toBe(true);
    // A failure after the first write must not offer "continue anyway".
    expect(migrationGateStore.getState().hasWritten).toBe(true);
  });

  it('asks rather than running when the verdict is undecided', async () => {
    mockVerdict = 'ask';
    await runNavidromeReidIfNeeded();

    expect(mockCalls).toEqual([]);
    expect(migrationGateStore.getState().mode).toBe('asking');
  });
});
