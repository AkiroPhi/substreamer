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

// The `storage` table, so the ETL stamp can be written and read back the way the pass
// really does it - through the db handle, not kvStorage.
const mockStorage = new Map<string, string>();
let mockStorageDropWrites = false;
jest.mock('../../../store/persistence/db', () => ({
  getDb: () => ({
    runAsync: (sql: string, params?: unknown[]) => {
      if (sql.includes('queue_snapshots')) mockCalls.push('clearLiveQueue');
      if (sql.includes('download_queue')) mockCalls.push('clearDownloadQueue');
      if (sql.includes('INTO storage') && !mockStorageDropWrites) {
        mockStorage.set(String(params?.[0]), String(params?.[1]));
      }
      return Promise.resolve({ changes: 0 });
    },
    getFirstAsync: (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM storage')) {
        const v = mockStorage.get(String(params?.[0]));
        return Promise.resolve(v === undefined ? null : { value: v });
      }
      return Promise.resolve(null);
    },
  }),
}));

jest.mock('../../../store/persistence/imageDownloadQueueTable', () => ({
  clearImageQueue: () => { mockCalls.push('clearImageQueue'); return Promise.resolve(0); },
}));

jest.mock('../../imageCacheService', () => ({
  cancelImageRefreshCycle: () => { mockCalls.push('cancelImageRefreshCycle'); return Promise.resolve(); },
  clearImageCache: () => { mockCalls.push('clearImageCache'); return Promise.resolve(); },
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

let mockCannotAsk = false;
jest.mock('../reidProbe', () => ({ cannotAskNow: () => mockCannotAsk }));

let mockServerAnswered = true;

let mockVerdict = 'run';
const mockSetReidState = jest.fn((s: string) => {
  mockCalls.push(`setReidState:${s}`);
  // The real marker drives the verdict: once complete, reidVerdict() answers 'skip'.
  // Modelled here so a log written after the pass cannot quietly report the wrong cause.
  if (s === 'complete') mockVerdict = 'skip';
});
jest.mock('../reidMarker', () => ({
  hasServerAnswered: () => mockServerAnswered,
  reidVerdict: () => mockVerdict,
  setReidState: (s: string) => mockSetReidState(s),
  setUserConfirmedReid: jest.fn(),
}));

const mockAppendReidLog = jest.fn();
jest.mock('../reidMigrationLog', () => ({
  appendReidLog: (...args: unknown[]) => mockAppendReidLog(...args),
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
// A real (tiny) store, not a stub: the pass subscribes to this to mirror the library
// upgrade's progress into the gate, so getState/setState/subscribe all have to work.
jest.mock('../../../store/syncStatusStore', () => {
  let state: Record<string, number> = { normalizedMigrationTotal: 0, normalizedMigrationDone: 0 };
  const listeners = new Set<() => void>();
  return {
    syncStatusStore: {
      persist: { rehydrate: () => Promise.resolve() },
      getState: () => state,
      setState: (partial: Record<string, number>) => {
        state = { ...state, ...partial };
        listeners.forEach((l) => l());
      },
      subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    },
  };
});
jest.mock('../../../store/persistence', () => ({
  kvStorage: { setItem: () => Promise.resolve(), getItem: () => Promise.resolve(null) },
}));
const mockLog = jest.fn();
jest.mock('../../librarySyncLogger', () => ({
  logLibrarySync: (m: string) => mockLog(m),
  flushLibrarySyncLog: () => Promise.resolve(),
}));
let mockEtlInFlight: Promise<void> | null = null;
jest.mock('../../dataModelUpgradeService', () => ({
  MIGRATION_DONE_KEY: 'k',
  MIGRATION_VERSION: '3',
  dataModelUpgradeInFlight: () => {
    if (mockEtlInFlight) mockCalls.push('awaitEtl');
    return mockEtlInFlight;
  },
}));

import { migrationGateStore } from '../../../store/migrationGateStore';
import { syncStatusStore } from '../../../store/syncStatusStore';
import {
  acceptMidSessionReid,
  declineMidSessionReid,
  resetMidSessionAcceptanceForTests,
  runNavidromeReidIfNeeded,
} from '../runNavidromeReid';

beforeEach(() => {
  mockCalls.length = 0;
  mockPairs = 3;
  mockFkOk = true;
  mockFileResult = { moved: 44, missing: 0, failed: 0 };
  mockVerdict = 'run';
  mockCannotAsk = false;
  mockServerAnswered = true;
  mockEtlInFlight = null;
  mockLog.mockClear();
  resetMidSessionAcceptanceForTests();
  mockSetReidState.mockClear();
  mockAppendReidLog.mockClear();
  mockStorage.clear();
  mockStorageDropWrites = false;
  migrationGateStore.getState().reset();
  syncStatusStore.setState({ normalizedMigrationTotal: 0, normalizedMigrationDone: 0 });
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

  it('clears the image cache AFTER the rehydrate, so purge protection sees current state', async () => {
    await runNavidromeReidIfNeeded();
    expect(idx('rehydrateAllStores')).toBeLessThan(idx('clearImageCache'));
    expect(idx('rebuildTrackMaps')).toBeLessThan(idx('clearImageCache'));
  });

  // It used to enqueue one here, and could only ever enqueue the WRONG keys: `albums` is
  // empty at this point, so the snapshot fell back to bare entity ids the server does not
  // serve. Covers repopulate on demand instead.
  it('does not enqueue a re-warm cycle while the library is empty', async () => {
    await runNavidromeReidIfNeeded();
    expect(mockCalls).not.toContain('enqueueImageRefreshCycle');
    expect(mockCalls).toContain('clearImageCache');
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

describe('the blob-ETL completion stamp', () => {
  // The library is discarded here but the legacy blob tables survive the migration
  // chain, so this key is the only thing stopping the idle ETL re-importing the whole
  // pre-re-key library on top of the canonical one - the doubled-library bug.
  it('stamps the ETL complete before finishing', async () => {
    await runNavidromeReidIfNeeded();
    expect(mockStorage.get('substreamer-normalized-migration-complete')).toBe('3');
    expect(mockCalls).toContain('setReidState:complete');
  });

  it('FAILS the pass when the stamp does not persist', async () => {
    mockStorageDropWrites = true;

    await runNavidromeReidIfNeeded();

    // Completing here would let the ETL double the library, silently. Better to fail and
    // re-run an idempotent pass next launch.
    expect(mockCalls).not.toContain('setReidState:complete');
    expect(migrationGateStore.getState().failed).toBe(true);
  });
});

describe('without a server to refill from', () => {
  // Measured on a fixture with in-app offline mode on and a persisted 0.64 version: the
  // pass ran, logged "library discarded (45 tables)", stamped the marker complete, and
  // left songs=0 albums=0 with no sync able to run. Downloads survived, everything else
  // was gone, and the marker then prevented any retry.
  it('refuses to run at all when offline or unreachable', async () => {
    mockCannotAsk = true;

    await runNavidromeReidIfNeeded();

    expect(mockCalls).toEqual([]);
    expect(mockCalls).not.toContain('discardLibrary');
    expect(mockSetReidState).not.toHaveBeenCalled();
    expect(migrationGateStore.getState().visible).toBe(false);
  });

  // Worse than running silently: the prompt appears and a "yes" confirms straight into
  // the same destruction.
  it('does not even show the ask prompt when there is no server', async () => {
    mockCannotAsk = true;
    mockVerdict = 'ask';

    await runNavidromeReidIfNeeded();

    expect(migrationGateStore.getState().visible).toBe(false);
  });


  // The away-from-home case: offline mode is OFF and the connectivity flags still say
  // reachable (they default optimistically and are only corrected after repeated ping
  // failures), so `cannotAskNow()` is false. The probe times out, the verdict falls back
  // to a persisted >= 0.64, and without this the pass discarded 45 tables against a
  // server that was never there.
  it('refuses when nothing says we are offline but the server never answered', async () => {
    mockCannotAsk = false;
    mockServerAnswered = false;

    await runNavidromeReidIfNeeded();

    expect(mockCalls).toEqual([]);
    expect(mockCalls).not.toContain('discardLibrary');
    expect(migrationGateStore.getState().visible).toBe(false);
  });


  // The availability check used to run BEFORE the verdict, and the probe never records
  // an answer for installs it short-circuits — so every non-Navidrome and every
  // already-complete install logged "deferred" on every launch.
  it('returns silently for an install that will never need the pass', async () => {
    mockVerdict = 'skip';
    mockServerAnswered = false;
    mockCannotAsk = true;

    await runNavidromeReidIfNeeded();

    expect(mockCalls).toEqual([]);
    expect(mockLog).not.toHaveBeenCalledWith(expect.stringContaining('deferred'));
  });

  it('runs normally once a server is reachable again', async () => {
    mockCannotAsk = false;
  mockServerAnswered = true;
  mockEtlInFlight = null;
  mockLog.mockClear();
  resetMidSessionAcceptanceForTests();
    await runNavidromeReidIfNeeded();
    expect(mockCalls).toContain('discardLibrary');
    expect(mockCalls).toContain('setReidState:complete');
  });
});

describe('the blob ETL race', () => {
  // The ETL writes with `fromMigration`, which bypasses the write guard by design. An
  // ETL already running when the gate went up would otherwise keep upserting retired-id
  // rows straight through discardLibrary and past the completion stamp.
  it('waits for an in-flight ETL before touching the library', async () => {
    let release = (): void => {};
    mockEtlInFlight = new Promise<void>((r) => { release = r; });
    const run = runNavidromeReidIfNeeded();
    await Promise.resolve();

    // Nothing destructive may have happened yet.
    expect(mockCalls).not.toContain('discardLibrary');

    release();
    await run;

    // -1 would satisfy a bare "less than", so assert presence first.
    expect(mockCalls).toContain('awaitEtl');
    expect(mockCalls.indexOf('awaitEtl')).toBeLessThan(mockCalls.indexOf('discardLibrary'));
    expect(mockCalls).toContain('setReidState:complete');
  });

  // Holding silently on "Preparing" for minutes reads as a hang. The wait gets its own
  // stage, carrying the library upgrade's own counter so the screen matches the banner.
  it('shows a waiting stage that mirrors the library upgrade progress', async () => {
    syncStatusStore.setState({ normalizedMigrationTotal: 900, normalizedMigrationDone: 0 });
    let release = (): void => {};
    mockEtlInFlight = new Promise<void>((r) => { release = r; });
    const run = runNavidromeReidIfNeeded();
    await Promise.resolve();

    expect(migrationGateStore.getState().activeStage).toBe('waitingForTasks');

    // The upgrade advances; the gate must follow it rather than sit still.
    syncStatusStore.setState({ normalizedMigrationDone: 450 });
    expect(migrationGateStore.getState().stages.waitingForTasks)
      .toEqual(expect.objectContaining({ total: 900, done: 450 }));

    release();
    await run;

    // And it must hand over to the real work. Asserting only that the active stage moved
    // on is vacuous — later stages would satisfy it even if 'preparing' never ran.
    expect(migrationGateStore.getState().stages.preparing).toBeDefined();
  });

  // Nothing to wait for: the stage must not appear at all, or every run claims to be
  // blocked on a job that was never running.
  it('shows no waiting stage when no ETL is running', async () => {
    await runNavidromeReidIfNeeded();

    expect(migrationGateStore.getState().stages.waitingForTasks).toBeUndefined();
  });

  it('proceeds straight through when no ETL is running', async () => {
    await runNavidromeReidIfNeeded();
    expect(mockCalls).not.toContain('awaitEtl');
    expect(mockCalls).toContain('discardLibrary');
  });
});

describe('interrupting a live session', () => {
  // A cold start just runs — the user is sat at a splash expecting startup work. Mid
  // session they may be listening, and the pass clears the queue, discards the library
  // and cannot be paused once started. So it is offered, not imposed.
  it('offers rather than starting when the app is already running', async () => {
    await runNavidromeReidIfNeeded({ midSession: true });

    expect(mockCalls).toEqual([]);
    expect(migrationGateStore.getState().mode).toBe('offering');
    expect(migrationGateStore.getState().visible).toBe(true);
  });

  it('runs straight through on a cold start', async () => {
    await runNavidromeReidIfNeeded();

    expect(mockCalls).toContain('discardLibrary');
    expect(migrationGateStore.getState().mode).not.toBe('offering');
  });

  it('runs once the user accepts', async () => {
    await runNavidromeReidIfNeeded({ midSession: true });
    expect(mockCalls).toEqual([]);

    await acceptMidSessionReid();

    expect(mockCalls).toContain('discardLibrary');
    expect(mockCalls).toContain('setReidState:complete');
  });

  // Declining must cost nothing: the marker stays pending so the next launch runs it.
  it('writes nothing when the user declines, and leaves the marker alone', async () => {
    await runNavidromeReidIfNeeded({ midSession: true });

    declineMidSessionReid();

    expect(mockCalls).toEqual([]);
    expect(mockSetReidState).not.toHaveBeenCalled();
    expect(migrationGateStore.getState().visible).toBe(false);
  });
});





// A deferred pass leaves the app working but stale, and blocks every library write for
// the session. This flag is what lets a surface say so instead of leaving the user with
// sync controls that accept a tap and do nothing.
describe('reporting that the pass was deferred', () => {
  it('raises the flag when there is no confirmed server', async () => {
    mockServerAnswered = false;

    await runNavidromeReidIfNeeded();

    expect(mockCalls).toEqual([]);
    expect(migrationGateStore.getState().deferred).toBe(true);
  });

  it('raises the flag when the user declines mid-session', async () => {
    await runNavidromeReidIfNeeded({ midSession: true });
    declineMidSessionReid();

    expect(migrationGateStore.getState().deferred).toBe(true);
  });

  it('lowers it once the pass actually runs', async () => {
    mockServerAnswered = false;
    await runNavidromeReidIfNeeded();
    expect(migrationGateStore.getState().deferred).toBe(true);

    mockServerAnswered = true;
    await runNavidromeReidIfNeeded();

    expect(mockCalls).toContain('discardLibrary');
    expect(migrationGateStore.getState().deferred).toBe(false);
  });

  // We deferred because nothing could answer; the server then answered pre-0.64. The
  // pass is not needed, so the claim of a pending update has to be withdrawn.
  it('lowers it when a late answer says the pass was never needed', async () => {
    mockServerAnswered = false;
    await runNavidromeReidIfNeeded();
    expect(migrationGateStore.getState().deferred).toBe(true);

    mockVerdict = 'skip';
    await runNavidromeReidIfNeeded();

    expect(mockCalls).toEqual([]);
    expect(migrationGateStore.getState().deferred).toBe(false);
  });
});

// The shared migration log is what a user sends when something looks wrong, so a line
// that misreports why the pass ran costs a real investigation — it cost one here.
describe('what the pass records about itself', () => {
  it('logs the verdict that CAUSED the run, not the one the finished marker implies', async () => {
    await runNavidromeReidIfNeeded();

    const entry = mockAppendReidLog.mock.calls.find((c) => c[0] === 'complete');
    expect(entry).toBeDefined();
    expect(entry?.[2]).toBe('run');
  });

  it('says what it examined when there was nothing to re-key', async () => {
    mockPairs = 0;

    await runNavidromeReidIfNeeded();

    const entry = mockAppendReidLog.mock.calls.find((c) => c[0] === 'nothing to do');
    expect(entry).toBeDefined();
    // Not "every id was already canonical" — that reads as a claim about the library,
    // which this pass never touches.
    expect((entry?.[1] as string[]).join(' ')).toContain('local-only');
    expect(entry?.[2]).toBe('run');
  });
});
