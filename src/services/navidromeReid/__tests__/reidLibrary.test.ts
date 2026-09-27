const mockCalls: string[] = [];

jest.mock('../../../db/client', () => ({
  awaitDbWritesIdle: () => { mockCalls.push('awaitDbWritesIdle'); return Promise.resolve(); },
}));

jest.mock('../../../store/syncStatusStore', () => ({
  syncStatusStore: {
    getState: () => ({
      resetLibrarySync: () => mockCalls.push('resetLibrarySync'),
      resetSongSync: () => mockCalls.push('resetSongSync'),
    }),
    setState: () => mockCalls.push('setState'),
  },
}));

jest.mock('../../../db/createNormalizedTables', () => ({
  MODEL_TABLES: ['songs', 'albums', 'queue_snapshots', 'mbid_overrides'],
}));

import { discardLibrary, libraryTablesToClear } from '../reidLibrary';

const db = {
  getAllAsync: () => Promise.resolve(
    [{ name: 'songs' }, { name: 'albums' }, { name: 'queue_snapshots' }, { name: 'mbid_overrides' }],
  ),
  runAtomicBatchAsync: () => { mockCalls.push('batch'); return Promise.resolve(); },
} as never;

beforeEach(() => { mockCalls.length = 0; });

describe('discardLibrary', () => {
  it('keeps the tables that have no server copy', () => {
    const cleared = libraryTablesToClear();
    expect(cleared).toContain('songs');
    expect(cleared).toContain('albums');
    // Bookmarks and MBID corrections are user-authored; a re-key is the same server.
    expect(cleared).not.toContain('queue_snapshots');
    expect(cleared).not.toContain('mbid_overrides');
  });

  it('quiesces the pool before its batch, so a stranded savepoint cannot fail it', async () => {
    await discardLibrary(db);
    expect(mockCalls.indexOf('awaitDbWritesIdle')).toBeLessThan(mockCalls.indexOf('batch'));
  });
});
