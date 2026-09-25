const mockStore = new Map<string, string>();

jest.mock('../../../store/persistence', () => ({
  kvStorageSync: {
    getItem: (k: string) => mockStore.get(k) ?? null,
    setItem: (k: string, v: string) => { mockStore.set(k, v); },
    removeItem: (k: string) => { mockStore.delete(k); },
  },
}));

let mockServerType: string | null = 'navidrome';
let mockServerVersion: string | null = '0.64.0 (1072e9f7)';
jest.mock('../../../store/serverInfoStore', () => ({
  serverInfoStore: { getState: () => ({ serverType: mockServerType, serverVersion: mockServerVersion }) },
}));

import {
  clearReidMarker,
  isReidComplete,
  isReidRequired,
  setReidState,
  shouldBlockContent,
} from '../reidMarker';

beforeEach(() => {
  mockStore.clear();
  mockServerType = 'navidrome';
  mockServerVersion = '0.64.0 (1072e9f7)';
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

  it('fires on an unparseable Navidrome version', () => {
    mockServerVersion = 'dev';
    expect(isReidRequired()).toBe(true);
  });

  it('treats an unreadable marker as not done', () => {
    mockStore.set('substreamer-navidrome-reid', '{not json');
    expect(isReidComplete()).toBe(false);
    expect(isReidRequired()).toBe(true);
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
});
