/**
 * CachedImage — state-machine tests for the three render branches.
 *
 *   LOCAL  → cached file URI rendered
 *   REMOTE → server URL rendered (component asked service to cache)
 *   PLACEHOLDER → no Image layer; the WaveformLogo shows through
 *
 * The placeholder is ALWAYS in the tree underneath the Image layer; the
 * Image just covers it once it paints. We never end up with a blank
 * rectangle.
 *
 * Service collaboration:
 *   - On mount with no cached file: component calls `ensureCached(id)`.
 *   - On cached-file decode error: `reportBadCache(id, size)`; component
 *     marks a per-mount flag so it won't retry the same broken URI.
 *   - On remote-URL load error: `reportBadRemote(id)`.
 *   - The single recovery signal is `subscribeImageCacheUpdate(id, …)`:
 *     when it fires, the component clears its local-error flag and
 *     re-renders. The service is responsible for firing it on file
 *     landed AND on remote-failed-flag flipped.
 */

/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

import React from 'react';
import { Image as RNImage } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

const mockGetCachedImageUri = jest.fn<string | null, [string, number]>();
const mockEnsureCached = jest.fn<void, [string]>();
const mockReportBadCache = jest.fn<void, [string, number]>();
const mockReportBadRemote = jest.fn<void, [string]>();
const mockIsRemoteFailed = jest.fn<boolean, [string]>();
const mockBuildRemoteImageUrl = jest.fn<string | null, [string, number]>();

let cacheUpdateListener: (() => void) | null = null;
let subscribedId: string | null = null;
// Album mode: a song subject resolves to its album's token when the album is known.
const mockAlbumTokens: Record<string, string> = {};

jest.mock('../../services/imageCacheService', () => ({
  resolveCachedImageUri: (id: string, size: number) =>
    Promise.resolve(mockGetCachedImageUri(id, size)),
  // Mirror the real resolveDisplayImage (file:// cache → server URL, gated on
  // offline + remote-failed) by composing the mocked primitives, so the tests'
  // existing per-primitive setups still drive CachedImage's render branches.
  resolveDisplayImage: async (
    subject: { coverArt?: string | null; albumId?: string | null },
    size: number,
    opts: { offline: boolean; skipCache?: boolean },
  ) => {
    const id = (subject.albumId && mockAlbumTokens[subject.albumId]) || subject.coverArt || undefined;
    if (!id) return { coverArtId: undefined, uri: null, isRemote: false };
    if (!opts.skipCache) {
      const cached = mockGetCachedImageUri(id, size);
      if (cached) return { coverArtId: id, uri: cached, isRemote: false };
    }
    if (opts.offline || mockIsRemoteFailed(id)) return { coverArtId: id, uri: null, isRemote: false };
    const remote = mockBuildRemoteImageUrl(id, size);
    return { coverArtId: id, uri: remote, isRemote: remote != null };
  },
  ensureCached: (id: string) => mockEnsureCached(id),
  reportBadCache: (id: string, size: number) => mockReportBadCache(id, size),
  reportBadRemote: (id: string) => mockReportBadRemote(id),
  isRemoteFailed: (id: string) => mockIsRemoteFailed(id),
  buildRemoteImageUrl: (id: string, size: number) => mockBuildRemoteImageUrl(id, size),
  subscribeImageCacheUpdate: (id: string, listener: () => void) => {
    subscribedId = id;
    cacheUpdateListener = listener;
    return () => { cacheUpdateListener = null; };
  },
}));

// expo-image renders the leaf cover image. Mock it to a plain RN Image that
// forwards `source`/`onError`, so `UNSAFE_queryAllByType(RNImage)` and the
// `props.onError()` assertions below keep working — identically under both the
// ios and android jest-expo projects.
jest.mock('expo-image', () => {
  const ReactMock = require('react');
  const RN = require('react-native');
  return {
    __esModule: true,
    Image: (props: { source?: unknown; onError?: () => void; style?: unknown }) =>
      ReactMock.createElement(RN.Image, {
        source: props.source,
        onError: props.onError,
        style: props.style,
      }),
  };
});

jest.mock('../../services/subsonicService', () => ({
  VARIOUS_ARTISTS_COVER_ART_ID: '__VA__',
}));

jest.mock('../../services/musicCacheService', () => ({
  STARRED_COVER_ART_ID: '__STARRED__',
}));

let mockOfflineMode = false;

jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: jest.fn(<T,>(selector: (s: { offlineMode: boolean }) => T) =>
    selector({ offlineMode: mockOfflineMode }),
  ),
}));

jest.mock('../WaveformLogo', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: (props: { size: number; color: string }) => (
      <View testID="waveform-placeholder" style={{ width: props.size, height: props.size }} />
    ),
  };
});

jest.mock('react-native-reanimated', () => {
  const { View, Image } = require('react-native');
  const ReactActual = require('react');
  return {
    __esModule: true,
    default: { View, Image },
    useSharedValue: (init: number) => {
      const ref = ReactActual.useRef({ value: init });
      return ref.current;
    },
    useAnimatedStyle: (fn: () => object) => fn(),
    withTiming: (val: number) => val,
    cancelAnimation: () => {},
    runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  };
});

jest.mock('../../services/imageCacheLogger', () => ({
  logImageCache: jest.fn(),
}));

/* ------------------------------------------------------------------ */
/*  Test helpers                                                       */
/* ------------------------------------------------------------------ */

import { CachedImage } from '../CachedImage';

function resetMocks(): void {
  mockGetCachedImageUri.mockReset();
  mockEnsureCached.mockReset();
  mockReportBadCache.mockReset();
  mockReportBadRemote.mockReset();
  mockIsRemoteFailed.mockReset();
  mockBuildRemoteImageUrl.mockReset();
  cacheUpdateListener = null;
  mockOfflineMode = false;

  // Sensible defaults — tests override individually.
  mockGetCachedImageUri.mockReturnValue(null);
  mockIsRemoteFailed.mockReturnValue(false);
  mockBuildRemoteImageUrl.mockImplementation(
    (id, size) => `https://srv.example/art?id=${id}&size=${size}`,
  );
}

beforeEach(() => {
  resetMocks();
  for (const k of Object.keys(mockAlbumTokens)) delete mockAlbumTokens[k];
  subscribedId = null;
});

/** Find the Image layer in the rendered tree (if any). The placeholder
 *  is a View with testID; the Image is the only Image element in the
 *  output once the component renders one. */
function findImage(tree: ReturnType<typeof render>): { uri: string } | null {
  const images = tree.UNSAFE_queryAllByType(RNImage);
  if (images.length === 0) return null;
  const last = images[images.length - 1];
  const src = last.props.source;
  if (typeof src === 'object' && src && 'uri' in src && typeof src.uri === 'string') {
    return { uri: src.uri };
  }
  return null;
}

/** Flush the async cover-art resolution (promise microtasks + state apply). */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Fire the cache-update notification the service would normally send, then
 *  flush the async re-resolution it triggers. */
async function fireCacheUpdate(): Promise<void> {
  await act(async () => {
    cacheUpdateListener?.();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/* ------------------------------------------------------------------ */
/*  LOCAL: cached file present                                         */
/* ------------------------------------------------------------------ */

describe('LOCAL state', () => {
  it('renders the cached URI once the async resolver returns a file://', async () => {
    mockGetCachedImageUri.mockReturnValue('file:///cache/abc/150.jpg');
    const tree = render(<CachedImage coverArtId="abc" size={150} />);
    await flush();
    expect(findImage(tree)?.uri).toBe('file:///cache/abc/150.jpg');
  });

  it('does NOT call ensureCached when a cached file already exists', async () => {
    mockGetCachedImageUri.mockReturnValue('file:///cache/abc/150.jpg');
    render(<CachedImage coverArtId="abc" size={150} />);
    await flush();
    expect(mockEnsureCached).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  REMOTE: no cache, online, not flagged                              */
/* ------------------------------------------------------------------ */

describe('REMOTE state', () => {
  it('renders the remote URL when no cached file exists', async () => {
    mockGetCachedImageUri.mockReturnValue(null);
    const tree = render(<CachedImage coverArtId="abc" size={150} />);
    await flush();
    expect(findImage(tree)?.uri).toContain('id=abc&size=150');
  });

  it('calls ensureCached after resolving a miss', async () => {
    mockGetCachedImageUri.mockReturnValue(null);
    render(<CachedImage coverArtId="abc" size={150} />);
    await flush();
    expect(mockEnsureCached).toHaveBeenCalledWith('abc');
  });
});

/* ------------------------------------------------------------------ */
/*  PLACEHOLDER branches                                               */
/* ------------------------------------------------------------------ */

describe('PLACEHOLDER state', () => {
  it('renders no Image layer when offline + no cache', async () => {
    mockOfflineMode = true;
    mockGetCachedImageUri.mockReturnValue(null);
    const tree = render(<CachedImage coverArtId="abc" size={150} />);
    await flush();
    expect(findImage(tree)).toBeNull();
    expect(tree.getByTestId('waveform-placeholder')).toBeTruthy();
  });

  it('renders no Image layer when isRemoteFailed is true', async () => {
    mockGetCachedImageUri.mockReturnValue(null);
    mockIsRemoteFailed.mockReturnValue(true);
    const tree = render(<CachedImage coverArtId="abc" size={150} />);
    await flush();
    expect(findImage(tree)).toBeNull();
    expect(tree.getByTestId('waveform-placeholder')).toBeTruthy();
  });

  it('renders only the placeholder when there is no coverArtId and no fallback', async () => {
    const tree = render(<CachedImage coverArtId={undefined} size={150} />);
    await flush();
    expect(findImage(tree)).toBeNull();
    expect(tree.getByTestId('waveform-placeholder')).toBeTruthy();
    expect(mockEnsureCached).not.toHaveBeenCalled();
  });

  it('renders the fallbackUri when no coverArtId is provided', async () => {
    const tree = render(
      <CachedImage coverArtId={undefined} size={150} fallbackUri="https://ext.example/img.jpg" />,
    );
    await flush();
    expect(findImage(tree)?.uri).toBe('https://ext.example/img.jpg');
  });
});

/* ------------------------------------------------------------------ */
/*  Cache-update recovery                                              */
/* ------------------------------------------------------------------ */

describe('cache-update recovery', () => {
  it('switches from REMOTE to LOCAL when the cache file lands', async () => {
    mockGetCachedImageUri.mockReturnValue(null);
    const tree = render(<CachedImage coverArtId="abc" size={150} />);
    await flush();
    expect(findImage(tree)?.uri).toContain('id=abc');

    // Service downloaded the file; next resolve returns a file:// URI.
    mockGetCachedImageUri.mockReturnValue('file:///cache/abc/150.jpg');
    await fireCacheUpdate();
    expect(findImage(tree)?.uri).toBe('file:///cache/abc/150.jpg');
  });

  it('switches from PLACEHOLDER (remote-failed) back to LOCAL on cache update', async () => {
    mockGetCachedImageUri.mockReturnValue(null);
    mockIsRemoteFailed.mockReturnValue(true);
    const tree = render(<CachedImage coverArtId="abc" size={150} />);
    await flush();
    expect(findImage(tree)).toBeNull();

    // Service recovered: cache landed AND the remote-failed flag is gone.
    mockIsRemoteFailed.mockReturnValue(false);
    mockGetCachedImageUri.mockReturnValue('file:///cache/abc/150.jpg');
    await fireCacheUpdate();
    expect(findImage(tree)?.uri).toBe('file:///cache/abc/150.jpg');
  });
});

/* ------------------------------------------------------------------ */
/*  Error handling                                                     */
/* ------------------------------------------------------------------ */

describe('decode errors', () => {
  it('calls reportBadCache when a local URI fails to load, then falls through to REMOTE', async () => {
    mockGetCachedImageUri.mockReturnValue('file:///cache/abc/150.jpg');
    const tree = render(<CachedImage coverArtId="abc" size={150} />);
    await flush();

    // Simulate the Image layer failing to decode.
    const img = tree.UNSAFE_queryAllByType(RNImage)[0];
    await act(async () => {
      img.props.onError();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockReportBadCache).toHaveBeenCalledWith('abc', 150);
    expect(mockReportBadRemote).not.toHaveBeenCalled();

    // localErroredRef is set so we skip the cached URI and fall through to the
    // remote URL.
    const after = findImage(tree);
    expect(after?.uri).toContain('id=abc');
  });

  it('calls reportBadRemote when a remote URI fails to load', async () => {
    mockGetCachedImageUri.mockReturnValue(null);
    const tree = render(<CachedImage coverArtId="abc" size={150} />);
    await flush();
    const img = tree.UNSAFE_queryAllByType(RNImage)[0];
    await act(async () => {
      img.props.onError();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockReportBadRemote).toHaveBeenCalledWith('abc');
    expect(mockReportBadCache).not.toHaveBeenCalled();
  });

  it('clears the local-error flag when the cache-update fires', async () => {
    mockGetCachedImageUri.mockReturnValue('file:///cache/abc/150.jpg');
    const tree = render(<CachedImage coverArtId="abc" size={150} />);
    await flush();
    const img = tree.UNSAFE_queryAllByType(RNImage)[0];
    await act(async () => { img.props.onError(); await Promise.resolve(); await Promise.resolve(); });

    // After fallthrough — remote.
    expect(findImage(tree)?.uri).toContain('id=abc');

    // Service redownloaded the file; resolve now returns it again.
    await fireCacheUpdate();
    expect(findImage(tree)?.uri).toBe('file:///cache/abc/150.jpg');
  });
});

/* ------------------------------------------------------------------ */
/*  Sentinels                                                          */
/* ------------------------------------------------------------------ */

describe('sentinel cover-art ids', () => {
  it('never contacts the image cache service for the starred-cover id', async () => {
    render(<CachedImage coverArtId="__STARRED__" size={150} />);
    await flush();
    expect(mockEnsureCached).not.toHaveBeenCalled();
    expect(mockGetCachedImageUri).not.toHaveBeenCalled();
    expect(mockBuildRemoteImageUrl).not.toHaveBeenCalled();
  });

  it('never contacts the image cache service for the various-artists id', async () => {
    render(<CachedImage coverArtId="__VA__" size={150} />);
    await flush();
    expect(mockEnsureCached).not.toHaveBeenCalled();
    expect(mockGetCachedImageUri).not.toHaveBeenCalled();
    expect(mockBuildRemoteImageUrl).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  Re-mount semantics                                                 */
/* ------------------------------------------------------------------ */

describe('id changes', () => {
  it('resets local-error flag when the coverArtId changes mid-mount', async () => {
    mockGetCachedImageUri.mockImplementation((id) => `file:///cache/${id}/150.jpg`);
    const tree = render(<CachedImage coverArtId="abc" size={150} />);
    await flush();

    // Error on abc — flag goes up, switches to remote on next render.
    const img = tree.UNSAFE_queryAllByType(RNImage)[0];
    await act(async () => { img.props.onError(); await Promise.resolve(); await Promise.resolve(); });
    expect(mockReportBadCache).toHaveBeenCalledWith('abc', 150);

    // Re-render with a different id — flag resets, cached file for the new
    // id renders cleanly once it resolves.
    tree.rerender(<CachedImage coverArtId="xyz" size={150} />);
    await flush();
    expect(findImage(tree)?.uri).toBe('file:///cache/xyz/150.jpg');
  });
});

describe('song subject (coverArtId + albumId)', () => {
  it("shows the album's cover and keys every report and subscription on its token", async () => {
    mockAlbumTokens.alb1 = 'al-alb1_h';
    mockGetCachedImageUri.mockImplementation((id) => (id === 'al-alb1_h' ? 'file:///cache/al/150.jpg' : null));
    const tree = render(<CachedImage coverArtId="dc-alb1:1_x" albumId="alb1" size={150} />);
    await flush();

    expect(findImage(tree)?.uri).toBe('file:///cache/al/150.jpg');
    expect(subscribedId).toBe('al-alb1_h');

    const img = tree.UNSAFE_queryAllByType(RNImage)[0];
    await act(async () => { img.props.onError(); await Promise.resolve(); await Promise.resolve(); });
    expect(mockReportBadCache).toHaveBeenCalledWith('al-alb1_h', 150);
  });

  it("caches the resolved album token on a miss, not the song's own", async () => {
    mockAlbumTokens.alb1 = 'al-alb1_h';
    render(<CachedImage coverArtId="dc-alb1:1_x" albumId="alb1" size={150} />);
    await flush();
    expect(mockEnsureCached).toHaveBeenCalledWith('al-alb1_h');
    expect(mockEnsureCached).not.toHaveBeenCalledWith('dc-alb1:1_x');
  });

  it('a recycled cell given another song drops the previous cover at once', async () => {
    mockAlbumTokens.alb1 = 'al-alb1_h';
    mockAlbumTokens.alb2 = 'al-alb2_h';
    mockGetCachedImageUri.mockImplementation((id) => `file:///cache/${id}/150.jpg`);
    const tree = render(<CachedImage coverArtId="dc-1" albumId="alb1" size={150} />);
    await flush();
    expect(findImage(tree)?.uri).toBe('file:///cache/al-alb1_h/150.jpg');

    tree.rerender(<CachedImage coverArtId="dc-2" albumId="alb2" size={150} />);
    // Before the new resolve lands: no image from the previous song.
    expect(findImage(tree)).toBeNull();
    await flush();
    expect(findImage(tree)?.uri).toBe('file:///cache/al-alb2_h/150.jpg');
    expect(subscribedId).toBe('al-alb2_h');
  });

  it('falls back to the song cover when its album is unknown', async () => {
    mockGetCachedImageUri.mockImplementation((id) => `file:///cache/${id}/150.jpg`);
    const tree = render(<CachedImage coverArtId="dc-9" albumId="missing" size={150} />);
    await flush();
    expect(findImage(tree)?.uri).toBe('file:///cache/dc-9/150.jpg');
  });
});
