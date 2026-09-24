jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
}));

jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

jest.mock('../subsonicService');

jest.mock('../musicCacheService', () => ({
  getLocalTrackUri: jest.fn().mockReturnValue(null),
  waitForTrackMapsReady: jest.fn(() => Promise.resolve()),
}));

jest.mock('../imageCacheService', () => ({
  resolveCachedImageUri: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../store/musicCacheStore', () => ({
  musicCacheStore: { getState: jest.fn(() => ({ cachedSongs: {} })) },
  completeSongFromCache: (song: unknown) => song,
}));

const mockOfflineMode = { offlineMode: false };
jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: { getState: jest.fn(() => mockOfflineMode) },
}));

import { childToTrack } from '../playerHelpers';
import { getStreamUrl, type Child } from '../subsonicService';

const RG_KEYS = [
  'replayGainTrackGain',
  'replayGainTrackPeak',
  'replayGainAlbumGain',
  'replayGainAlbumPeak',
] as const;

const makeChild = (overrides?: Partial<Child>): Child =>
  ({
    id: 's1',
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    duration: 200,
    ...overrides,
  }) as Child;

/** The four player-side ReplayGain keys present on a built track. */
const rgOf = (child: Child) => {
  const track = childToTrack(child)!;
  return Object.fromEntries(RG_KEYS.filter((k) => k in track).map((k) => [k, track[k]]));
};

beforeEach(() => {
  (getStreamUrl as jest.Mock).mockReturnValue('https://example.com/stream?id=s1');
});

describe('childToTrack ReplayGain passthrough', () => {
  it('maps all four server values onto the track', () => {
    expect(
      rgOf(makeChild({ replayGain: { trackGain: -6.5, trackPeak: 0.98, albumGain: -7.1, albumPeak: 1.02 } })),
    ).toEqual({
      replayGainTrackGain: -6.5,
      replayGainTrackPeak: 0.98,
      replayGainAlbumGain: -7.1,
      replayGainAlbumPeak: 1.02,
    });
  });

  it("forwards Gonic's zero-for-absent album fields as a 0 dB gain and no peak", () => {
    expect(
      rgOf(makeChild({ replayGain: { trackGain: -6.5, trackPeak: 0.98, albumGain: 0, albumPeak: 0 } })),
    ).toEqual({
      replayGainTrackGain: -6.5,
      replayGainTrackPeak: 0.98,
      replayGainAlbumGain: 0,
    });
  });

  it('sends only the fields the server gave', () => {
    expect(rgOf(makeChild({ replayGain: { trackGain: -3 } }))).toEqual({ replayGainTrackGain: -3 });
  });

  it('sends nothing when the server reports no ReplayGain, so file tags still apply', () => {
    expect(rgOf(makeChild())).toEqual({});
    expect(rgOf(makeChild({ replayGain: {} }))).toEqual({});
    // baseGain / fallbackGain are not part of the player's contract.
    expect(rgOf(makeChild({ replayGain: { baseGain: -18, fallbackGain: -6 } }))).toEqual({});
  });

  it('drops non-finite values rather than claiming the track with them', () => {
    expect(
      rgOf(makeChild({ replayGain: { trackGain: Number.NaN, trackPeak: Number.POSITIVE_INFINITY } })),
    ).toEqual({});
  });
});

describe('childToTrack', () => {
  it('returns null offline when the song has no local file', () => {
    mockOfflineMode.offlineMode = true;
    expect(childToTrack(makeChild())).toBeNull();
    mockOfflineMode.offlineMode = false;
  });

  it('returns null when no stream URL can be built', () => {
    (getStreamUrl as jest.Mock).mockReturnValue(null);
    expect(childToTrack(makeChild())).toBeNull();
  });
});
