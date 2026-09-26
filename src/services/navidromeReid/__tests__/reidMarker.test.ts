const mockStore = new Map<string, string>();

jest.mock('../../../store/persistence', () => ({
  kvStorageSync: {
    getItem: (k: string) => mockStore.get(k) ?? null,
    setItem: (k: string, v: string) => { mockStore.set(k, v); },
    removeItem: (k: string) => { mockStore.delete(k); },
  },
}));

let mockPing: unknown = { status: 'ok', serverVersion: '0.64.0 (1072e9f7)' };
let mockPingDelayMs = 0;
let mockApiNull = false;
jest.mock('../../subsonicService', () => ({
  getApi: () => (mockApiNull ? null : {
    ping: () => new Promise((resolve, reject) => {
      setTimeout(() => (mockPing instanceof Error ? reject(mockPing) : resolve(mockPing)), mockPingDelayMs);
    }),
  }),
}));

let mockHasConnection = true;
let mockServerReachable = true;
jest.mock('../../../store/connectivityStore', () => ({
  connectivityStore: {
    getState: () => ({
      hasConnection: mockHasConnection,
      isServerReachable: mockServerReachable,
    }),
  },
}));

let mockServerType: string | null = 'navidrome';
let mockServerVersion: string | null = '0.64.0 (1072e9f7)';
jest.mock('../../../store/serverInfoStore', () => ({
  serverInfoStore: { getState: () => ({ serverType: mockServerType, serverVersion: mockServerVersion }) },
}));

import { probeServerVersion, resetReidProbeInFlightForTests } from '../reidProbe';
import {
  clearReidMarker,
  resetReidProbeForTests,
  shouldBlockLibraryWrites,
  isReidComplete,
  isReidRequired,
  reidVerdict,
  setReidState,
  shouldBlockContent,
} from '../reidMarker';

beforeEach(() => {
  mockStore.clear();
  mockServerType = 'navidrome';
  mockServerVersion = '0.64.0 (1072e9f7)';
  mockPing = { status: 'ok', serverVersion: '0.64.0 (1072e9f7)' };
  mockPingDelayMs = 0;
  mockApiNull = false;
  mockHasConnection = true;
  mockServerReachable = true;
  resetReidProbeForTests();
  resetReidProbeInFlightForTests();
});

describe('reidMarker', () => {
  it('requires the pass on an affected server with no marker', () => {
    expect(isReidRequired()).toBe(true);
    expect(isReidComplete()).toBe(false);
  });

  it('stops requiring it once complete', () => {
    setReidState('complete');
    expect(isReidComplete()).toBe(true);
    expect(isReidRequired()).toBe(false);
  });

  it('still requires it while pending', () => {
    setReidState('pending');
    expect(isReidComplete()).toBe(false);
    expect(isReidRequired()).toBe(true);
  });

  it('never fires on an unaffected server', () => {
    mockServerVersion = '0.63.2';
    expect(isReidRequired()).toBe(false);
    mockServerType = 'gonic';
    mockServerVersion = '0.64.0';
    expect(isReidRequired()).toBe(false);
  });

  it('runs unattended on a development build', () => {
    mockServerVersion = 'dev';
    expect(reidVerdict()).toBe('run');
    expect(isReidRequired()).toBe(true);
  });

  it('asks rather than guessing on an ambiguous snapshot', () => {
    mockServerVersion = '0.0.0-SNAPSHOT (deadbee)';
    expect(reidVerdict()).toBe('ask');
    expect(isReidRequired()).toBe(false);
  });

  it('skips everything once complete, even an ambiguous version', () => {
    mockServerVersion = '0.0.0-SNAPSHOT (deadbee)';
    setReidState('complete');
    expect(reidVerdict()).toBe('skip');
  });

  it('treats an unreadable marker as not done', () => {
    mockStore.set('substreamer-navidrome-reid', '{not json');
    expect(isReidComplete()).toBe(false);
    expect(isReidRequired()).toBe(true);
  });

  it('blocks headless content while undecided, not just while required', () => {
    mockServerVersion = '0.0.0-SNAPSHOT (deadbee)';
    expect(isReidRequired()).toBe(false);
    expect(shouldBlockContent()).toBe(true);
  });

  it('treats an unknown marker value as not done', () => {
    mockStore.set('substreamer-navidrome-reid', JSON.stringify({ state: 'halfway' }));
    expect(isReidComplete()).toBe(false);
  });

  it('clears', () => {
    setReidState('complete');
    clearReidMarker();
    expect(isReidComplete()).toBe(false);
  });

  it('blocks headless content exactly when the pass is required', () => {
    expect(shouldBlockContent()).toBe(true);
    setReidState('complete');
    expect(shouldBlockContent()).toBe(false);
  });

  it('does not block a user who never needed the pass', () => {
    mockServerType = 'subsonic';
    expect(shouldBlockContent()).toBe(false);
  });

  describe('before serverInfoStore has hydrated', () => {
    // The store persists through the ASYNC kvStorage, so a headless cold wake reads
    // serverType: null from memory while the persisted blob says navidrome.
    beforeEach(() => {
      mockServerType = null;
      mockServerVersion = null;
      mockStore.set(
        'substreamer-server-info',
        JSON.stringify({ state: { serverType: 'navidrome', serverVersion: '0.64.0 (1072e9f7)' } }),
      );
    });

    it('falls back to the persisted blob rather than reading as "not Navidrome"', () => {
      expect(reidVerdict()).toBe('run');
      expect(shouldBlockContent()).toBe(true);
    });

    it('still skips when the persisted server is below 0.64', () => {
      mockStore.set(
        'substreamer-server-info',
        JSON.stringify({ state: { serverType: 'navidrome', serverVersion: '0.63.3 (abc)' } }),
      );
      expect(reidVerdict()).toBe('skip');
    });

    it('skips when nothing is persisted either - no server, nothing to corrupt', () => {
      mockStore.delete('substreamer-server-info');
      expect(reidVerdict()).toBe('skip');
      expect(shouldBlockContent()).toBe(false);
    });

    it('keeps the store answer when the blob is corrupt', () => {
      mockStore.set('substreamer-server-info', '{not json');
      expect(reidVerdict()).toBe('skip');
    });

    it('prefers the live store once it HAS hydrated', () => {
      mockServerType = 'subsonic';
      expect(reidVerdict()).toBe('skip');
    });
  });
});

describe('the live version probe', () => {
  // The bug this exists for: the persisted version is the PRE-upgrade one on exactly the
  // launch the pass is needed.
  it('overrides a stale persisted version with what the server reports', async () => {
    mockServerVersion = '0.61.2 (aa84e645)';
    expect(reidVerdict()).toBe('skip');          // stale copy says unaffected
    await (probeServerVersion() ?? Promise.resolve());
    expect(reidVerdict()).toBe('run');           // the server says otherwise
  });

  it('does not route through serverInfoStore, which a late hydration would clobber', async () => {
    mockServerVersion = '0.61.2 (aa84e645)';
    await (probeServerVersion() ?? Promise.resolve());
    // Simulate zustand's persist merge restoring the stale value after hydration.
    mockServerType = 'navidrome';
    mockServerVersion = '0.61.2 (aa84e645)';
    expect(reidVerdict()).toBe('run');
  });

  it('blocks library writes until the probe settles', async () => {
    mockServerVersion = '0.61.2 (aa84e645)';
    expect(shouldBlockLibraryWrites()).toBe(true);   // unsettled - fail safe
    await (probeServerVersion() ?? Promise.resolve());
    expect(shouldBlockLibraryWrites()).toBe(true);   // settled, and it IS affected
  });

  it('releases writes once the probe confirms an unaffected server', async () => {
    mockServerVersion = '0.61.2 (aa84e645)';
    mockPing = { status: 'ok', serverVersion: '0.61.2 (aa84e645)' };
    await (probeServerVersion() ?? Promise.resolve());
    expect(reidVerdict()).toBe('skip');
    expect(shouldBlockLibraryWrites()).toBe(false);
  });

  it('settles, rather than blocking forever, when the server is unreachable', async () => {
    mockServerVersion = '0.61.2 (aa84e645)';
    mockPing = new Error('unreachable');
    await (probeServerVersion() ?? Promise.resolve());
    // A server that cannot answer a ping cannot serve a sync either.
    expect(shouldBlockLibraryWrites()).toBe(false);
  });

  it('settles in offline mode without a request', async () => {
    mockApiNull = true;
    mockServerVersion = '0.61.2 (aa84e645)';
    await (probeServerVersion() ?? Promise.resolve());
    expect(shouldBlockLibraryWrites()).toBe(false);
  });

  it('never blocks writes for a non-Navidrome server', () => {
    mockServerType = 'subsonic';
    expect(shouldBlockLibraryWrites()).toBe(false);
  });

  it('never blocks writes once the pass has completed', () => {
    setReidState('complete');
    expect(shouldBlockLibraryWrites()).toBe(false);
  });

  it('runs at most one request for concurrent callers', async () => {
    mockPingDelayMs = 5;
    await Promise.all([probeServerVersion(), probeServerVersion(), probeServerVersion()].map((p) => p ?? Promise.resolve()));
    expect(reidVerdict()).toBe('run');
  });

  it('does not hold the splash when the server is known unreachable', () => {
    mockServerVersion = '0.61.2 (aa84e645)';
    mockServerReachable = false;
    // null means "nothing to wait for" — the caller proceeds in the same tick.
    expect(probeServerVersion()).toBeNull();
    expect(shouldBlockLibraryWrites()).toBe(false);
  });

  it('returns null synchronously for a non-Navidrome server', () => {
    mockServerType = 'subsonic';
    expect(probeServerVersion()).toBeNull();
  });

  it('returns null synchronously once the pass is complete', () => {
    setReidState('complete');
    expect(probeServerVersion()).toBeNull();
  });
});
