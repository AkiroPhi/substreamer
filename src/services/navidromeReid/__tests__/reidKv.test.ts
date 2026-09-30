const mockStore = new Map<string, string>();

jest.mock('../../../store/persistence', () => ({
  kvStorage: {
    getItem: (k: string) => Promise.resolve(mockStore.get(k) ?? null),
    setItem: (k: string, v: string) => { mockStore.set(k, v); return Promise.resolve(); },
    removeItem: (k: string) => { mockStore.delete(k); return Promise.resolve(); },
  },
}));

import { canonicalId } from '../canonicalId';
import { rekeyKvBlobs } from '../reidKv';

const LEGACY = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
const CANONICAL = canonicalId(LEGACY);

const write = (key: string, state: unknown): void => {
  mockStore.set(key, JSON.stringify({ state, version: 0 }));
};
const read = (key: string): { state: Record<string, unknown> } =>
  JSON.parse(mockStore.get(key) as string) as { state: Record<string, unknown> };

beforeEach(() => mockStore.clear());

describe('rekeyKvBlobs', () => {
  it('re-keys the KEYS of the ratings map, keeping the values', () => {
    write('substreamer-ratings', { overrides: { [LEGACY]: { rating: 4 }, keep: { rating: 2 } } });
    return rekeyKvBlobs().then(() => {
      const overrides = read('substreamer-ratings').state.overrides as Record<string, unknown>;
      expect(overrides[CANONICAL]).toEqual({ rating: 4 });
      expect(overrides[LEGACY]).toBeUndefined();
      // An id that does not move keeps its key.
      expect(overrides.keep).toEqual({ rating: 2 });
    });
  });

  it('empties the stale album lists rather than re-keying them', async () => {
    write('substreamer-album-lists', {
      recentlyAdded: [{ id: LEGACY }],
      recentlyPlayed: [{ id: LEGACY }],
      lastRefreshedAt: 12345,
    });

    await rekeyKvBlobs();
    const state = read('substreamer-album-lists').state;

    expect(state.recentlyAdded).toEqual([]);
    expect(state.recentlyPlayed).toEqual([]);
    // Zeroed so refreshAllIfDue(0) refetches at the next cold start.
    expect(state.lastRefreshedAt).toBe(0);
  });

  it('leaves a corrupt blob exactly as it is', async () => {
    mockStore.set('substreamer-ratings', '{not json');
    await rekeyKvBlobs();
    expect(mockStore.get('substreamer-ratings')).toBe('{not json');
  });

  it('does nothing, and reports nothing moved, when the blobs are absent', async () => {
    await expect(rekeyKvBlobs()).resolves.toBe(0);
    expect(mockStore.size).toBe(0);
  });

  // The count feeds the completion log. Reporting 0 while ids actually moved is what
  // made a real defect read as a no-op, so the number has to be the true one.
  it('reports how many ids actually moved', async () => {
    write('substreamer-ratings', { overrides: { [LEGACY]: { rating: 4 }, keep: { rating: 2 } } });

    await expect(rekeyKvBlobs()).resolves.toBe(1);
  });

  it('is idempotent', async () => {
    write('substreamer-ratings', { overrides: { [LEGACY]: { rating: 5 } } });
    await rekeyKvBlobs();
    const once = mockStore.get('substreamer-ratings');
    await rekeyKvBlobs();
    expect(mockStore.get('substreamer-ratings')).toBe(once);
  });
});
