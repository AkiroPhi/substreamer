/**
 * Add-to-playlist sheet: what it shows for each target, how the playlist list is
 * seeded from SQL and refreshed from the server, and the service calls made when a
 * playlist is picked or created.
 */

// Shared values must keep their identity across renders: the sheet's load effect
// depends on them.
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const { useRef } = require('react');
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (init: number) => useRef({ value: init }).current,
    useAnimatedStyle: (fn: () => object) => fn(),
    withTiming: (val: number, _config?: object, cb?: (finished: boolean) => void) => {
      if (cb) cb(true);
      return val;
    },
    runOnJS: (fn: Function) => fn,
    Easing: { out: (fn: unknown) => fn, cubic: () => 0 },
  };
});

jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      textPrimary: '#fff',
      textSecondary: '#888',
      border: '#333',
      primary: '#1D9BF0',
      red: '#e91429',
      inputBg: '#222',
    },
  }),
}));

// Children inline; a backdrop pressable stands in for the sheet's own dismiss gesture.
jest.mock('../BottomSheet', () => {
  const { Pressable, View } = require('react-native');
  return {
    BottomSheet: ({
      visible,
      onClose,
      children,
    }: {
      visible: boolean;
      onClose: () => void;
      children: React.ReactNode;
    }) =>
      visible ? (
        <View testID="bottom-sheet">
          <Pressable testID="sheet-backdrop" onPress={onClose} />
          {children}
        </View>
      ) : null,
  };
});

jest.mock('../CachedImage', () => ({ CachedImage: jest.fn(() => null) }));

jest.mock('../../services/subsonicService', () => ({
  addToPlaylist: jest.fn(),
  createNewPlaylist: jest.fn(),
  getAlbum: jest.fn(),
}));
jest.mock('../../services/musicCacheService', () => ({ syncCachedItemTracks: jest.fn() }));
jest.mock('../../services/detailFetchService', () => ({ fetchPlaylistDetail: jest.fn() }));
jest.mock('../../services/normalizedLibrarySync', () => ({ refreshPlaylistLibrary: jest.fn() }));

let mockCachedItems: Record<string, unknown> = {};
jest.mock('../../store/musicCacheStore', () => ({
  musicCacheStore: { getState: () => ({ cachedItems: mockCachedItems }) },
}));

let mockDb: object | null = {};
jest.mock('../../store/persistence/db', () => ({ getDb: () => mockDb }));
jest.mock('../../db/repository/playlists', () => ({
  ...jest.requireActual('../../db/repository/playlists'),
  listAllPlaylists: jest.fn(),
}));

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { AddToPlaylistSheet } from '../AddToPlaylistSheet';
import { CachedImage } from '../CachedImage';
import { listAllPlaylists, type PlaylistBrowseRow } from '../../db/repository/playlists';
import { fetchPlaylistDetail } from '../../services/detailFetchService';
import { syncCachedItemTracks } from '../../services/musicCacheService';
import { refreshPlaylistLibrary } from '../../services/normalizedLibrarySync';
import { addToPlaylist, createNewPlaylist, getAlbum } from '../../services/subsonicService';
import { addToPlaylistStore } from '../../store/addToPlaylistStore';
import { processingOverlayStore } from '../../store/processingOverlayStore';

import type { AlbumID3, Child } from '../../services/subsonicService';

const mockCachedImage = CachedImage as unknown as jest.Mock;
const mockListAllPlaylists = listAllPlaylists as jest.Mock;
const mockRefresh = refreshPlaylistLibrary as jest.Mock;
const mockAddToPlaylist = addToPlaylist as jest.Mock;
const mockCreateNewPlaylist = createNewPlaylist as jest.Mock;
const mockGetAlbum = getAlbum as jest.Mock;
const mockFetchPlaylistDetail = fetchPlaylistDetail as jest.Mock;
const mockSyncCachedItemTracks = syncCachedItemTracks as jest.Mock;

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const song = {
  id: 's1',
  title: 'Test Track',
  artist: 'Test Artist',
  albumId: 'al1',
  coverArt: 'ca-s1',
} as unknown as Child;

const album = {
  id: 'al1',
  name: 'Test Album',
  artist: 'Album Artist',
  coverArt: 'ca-al1',
} as unknown as AlbumID3;

const queueSongs = [
  { id: 'q1', title: 'Q1', albumId: 'al-q1', coverArt: 'ca-q1' },
  { id: 'q2', title: 'Q2', albumId: 'al-q2', coverArt: 'ca-q2' },
] as unknown as Child[];

const row = (id: string, name: string, count: number | null): PlaylistBrowseRow => ({
  id,
  name,
  cover_art: null,
  song_count: count,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let the reveal delay elapse and the load effect's awaits settle. */
async function elapseRevealDelay() {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(750);
  });
}

/** Fire the measuring container's layout so the pick list reaches its 'ready' phase. */
function measureContent(height = 240) {
  const measuring = screen.UNSAFE_root.findAll(
    (n) => typeof n.type !== 'string' && typeof n.props.onLayout === 'function',
  );
  expect(measuring.length).toBeGreaterThan(0);
  fireEvent(measuring[0], 'layout', { nativeEvent: { layout: { height } } });
}

function lastCoverProps() {
  const calls = mockCachedImage.mock.calls;
  return calls[calls.length - 1][0];
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockCachedItems = {};
  mockDb = {};
  mockListAllPlaylists.mockReset().mockResolvedValue([]);
  mockRefresh.mockReset().mockResolvedValue(undefined);
  mockAddToPlaylist.mockReset().mockResolvedValue(true);
  mockCreateNewPlaylist.mockReset().mockResolvedValue(true);
  mockGetAlbum.mockReset().mockResolvedValue(null);
  mockFetchPlaylistDetail.mockReset().mockResolvedValue(null);
  act(() => {
    addToPlaylistStore.setState({ visible: false, target: null });
    processingOverlayStore.getState().hide();
  });
});

afterEach(() => {
  act(() => {
    processingOverlayStore.getState().hide();
  });
  jest.useRealTimers();
});

/* ------------------------------------------------------------------ */
/*  Header per target                                                  */
/* ------------------------------------------------------------------ */

describe('header', () => {
  it('renders nothing while hidden', () => {
    render(<AddToPlaylistSheet />);
    expect(screen.queryByTestId('bottom-sheet')).toBeNull();
    expect(mockCachedImage).not.toHaveBeenCalled();
  });

  it('shows a song with its own cover token and its album id', async () => {
    act(() => addToPlaylistStore.getState().showSong(song));
    render(<AddToPlaylistSheet />);
    await elapseRevealDelay();

    expect(screen.getByText('Add to Playlist')).toBeTruthy();
    expect(screen.getByText('Test Track — Test Artist')).toBeTruthy();
    expect(lastCoverProps()).toEqual(
      expect.objectContaining({ coverArtId: 'ca-s1', albumId: 'al1', size: 150 }),
    );
  });

  it('falls back to unknown song/artist labels and still resolves a cover from the album id', async () => {
    const bare = { id: 's2', albumId: 'al9' } as unknown as Child;
    act(() => addToPlaylistStore.getState().showSong(bare));
    render(<AddToPlaylistSheet />);
    await elapseRevealDelay();

    expect(screen.getByText('Unknown Song — Unknown Artist')).toBeTruthy();
    const props = lastCoverProps();
    expect(props.coverArtId).toBeUndefined();
    expect(props.albumId).toBe('al9');
  });

  it('omits the cover when a song has neither cover token nor album id', async () => {
    const bare = { id: 's3', title: 'T', artist: 'A' } as unknown as Child;
    act(() => addToPlaylistStore.getState().showSong(bare));
    render(<AddToPlaylistSheet />);
    await elapseRevealDelay();

    expect(screen.getByText('T — A')).toBeTruthy();
    expect(mockCachedImage).not.toHaveBeenCalled();
  });

  it('shows an album with its cover token and no album id', async () => {
    act(() => addToPlaylistStore.getState().showAlbum(album));
    render(<AddToPlaylistSheet />);
    await elapseRevealDelay();

    expect(screen.getByText('Test Album — Album Artist')).toBeTruthy();
    const props = lastCoverProps();
    expect(props.coverArtId).toBe('ca-al1');
    expect(props.albumId).toBeUndefined();
  });

  it('falls back to unknown album/artist labels and omits the cover for a bare album', async () => {
    act(() => addToPlaylistStore.getState().showAlbum({ id: 'al2' } as unknown as AlbumID3));
    render(<AddToPlaylistSheet />);
    await elapseRevealDelay();

    expect(screen.getByText('Unknown Album — Unknown Artist')).toBeTruthy();
    expect(mockCachedImage).not.toHaveBeenCalled();
  });

  it("shows the queue's track count and the first song's cover", async () => {
    act(() => addToPlaylistStore.getState().showQueue(queueSongs));
    render(<AddToPlaylistSheet />);
    await elapseRevealDelay();

    expect(screen.getByText('2 tracks from queue')).toBeTruthy();
    expect(lastCoverProps()).toEqual(
      expect.objectContaining({ coverArtId: 'ca-q1', albumId: 'al-q1' }),
    );
  });

  it('omits the cover for an empty queue', async () => {
    act(() => addToPlaylistStore.getState().showQueue([]));
    render(<AddToPlaylistSheet />);
    await elapseRevealDelay();

    expect(screen.getByText('0 tracks from queue')).toBeTruthy();
    expect(mockCachedImage).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  Playlist list loading                                              */
/* ------------------------------------------------------------------ */

describe('playlist list', () => {
  it('seeds from the cached rows, then replaces them with the post-refresh rows', async () => {
    const refresh = deferred<void>();
    mockRefresh.mockReturnValueOnce(refresh.promise);
    mockListAllPlaylists
      .mockResolvedValueOnce([row('p1', 'Cached One', 3)])
      .mockResolvedValueOnce([row('p1', 'Cached One', 4), row('p2', 'Fresh Two', null)]);

    act(() => addToPlaylistStore.getState().showSong(song));
    render(<AddToPlaylistSheet />);

    // Before the delay nothing is read.
    expect(mockListAllPlaylists).not.toHaveBeenCalled();
    expect(screen.queryByText('New Playlist')).toBeNull();

    await elapseRevealDelay();
    expect(screen.getByText('Cached One')).toBeTruthy();
    expect(screen.getByText('3 tracks')).toBeTruthy();
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    await act(async () => refresh.resolve());
    expect(screen.getByText('4 tracks')).toBeTruthy();
    expect(screen.getByText('Fresh Two')).toBeTruthy();
    expect(screen.getByText('0 tracks')).toBeTruthy();
    expect(mockListAllPlaylists).toHaveBeenCalledTimes(2);
  });

  it('shows "No playlists yet" when neither the cache nor the server has any', async () => {
    const refresh = deferred<void>();
    mockRefresh.mockReturnValueOnce(refresh.promise);
    act(() => addToPlaylistStore.getState().showSong(song));
    render(<AddToPlaylistSheet />);
    await elapseRevealDelay();

    // While the refresh is in flight there is nothing to show yet.
    expect(screen.queryByText('No playlists yet')).toBeNull();

    await act(async () => refresh.resolve());
    expect(screen.getByText('No playlists yet')).toBeTruthy();
  });

  it('shows the load error when the refresh fails and nothing is cached', async () => {
    mockRefresh.mockRejectedValueOnce(new Error('offline'));
    act(() => addToPlaylistStore.getState().showSong(song));
    render(<AddToPlaylistSheet />);
    await elapseRevealDelay();

    expect(screen.getByText('Failed to load playlists')).toBeTruthy();
    expect(screen.queryByText('No playlists yet')).toBeNull();
  });

  it('keeps the cached rows when the refresh fails', async () => {
    mockListAllPlaylists.mockResolvedValueOnce([row('p1', 'Cached One', 1)]);
    mockRefresh.mockRejectedValueOnce(new Error('offline'));
    act(() => addToPlaylistStore.getState().showSong(song));
    render(<AddToPlaylistSheet />);
    await elapseRevealDelay();

    expect(screen.getByText('Cached One')).toBeTruthy();
    expect(screen.getByText('1 track')).toBeTruthy();
    expect(screen.queryByText('Failed to load playlists')).toBeNull();
  });

  it('skips the SQL reads when there is no database, but still refreshes', async () => {
    mockDb = null;
    act(() => addToPlaylistStore.getState().showSong(song));
    render(<AddToPlaylistSheet />);
    await elapseRevealDelay();

    expect(mockListAllPlaylists).not.toHaveBeenCalled();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText('No playlists yet')).toBeTruthy();
  });

  it('never loads when closed before the reveal delay elapses', async () => {
    act(() => addToPlaylistStore.getState().showSong(song));
    render(<AddToPlaylistSheet />);
    fireEvent.press(screen.getByTestId('sheet-backdrop'));
    await elapseRevealDelay();

    expect(mockListAllPlaylists).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('abandons the load when closed while the cached read is in flight', async () => {
    const cached = deferred<PlaylistBrowseRow[]>();
    mockListAllPlaylists.mockReturnValueOnce(cached.promise);
    act(() => addToPlaylistStore.getState().showSong(song));
    render(<AddToPlaylistSheet />);
    await elapseRevealDelay();

    fireEvent.press(screen.getByTestId('sheet-backdrop'));
    await act(async () => cached.resolve([row('p1', 'Late', 1)]));

    expect(mockRefresh).not.toHaveBeenCalled();
    expect(screen.queryByTestId('bottom-sheet')).toBeNull();
  });

  it('drops the refresh result when closed while the refresh is in flight', async () => {
    const refresh = deferred<void>();
    mockRefresh.mockReturnValueOnce(refresh.promise);
    act(() => addToPlaylistStore.getState().showSong(song));
    render(<AddToPlaylistSheet />);
    await elapseRevealDelay();

    fireEvent.press(screen.getByTestId('sheet-backdrop'));
    await act(async () => refresh.resolve());

    // Only the seed read ran; the post-refresh read is skipped.
    expect(mockListAllPlaylists).toHaveBeenCalledTimes(1);
  });

  it('ignores a refresh failure that lands after the sheet closed', async () => {
    const refresh = deferred<void>();
    mockRefresh.mockReturnValueOnce(refresh.promise);
    act(() => addToPlaylistStore.getState().showSong(song));
    render(<AddToPlaylistSheet />);
    await elapseRevealDelay();

    fireEvent.press(screen.getByTestId('sheet-backdrop'));
    await act(async () => refresh.reject(new Error('late')));

    expect(screen.queryByTestId('bottom-sheet')).toBeNull();
  });

  it('measures the list once, then stops listening for layout', async () => {
    act(() => addToPlaylistStore.getState().showSong(song));
    render(<AddToPlaylistSheet />);
    await elapseRevealDelay();

    measureContent(200);
    // 'ready': the content no longer carries a layout handler.
    expect(
      screen.UNSAFE_root.findAll(
        (n) => typeof n.type !== 'string' && typeof n.props.onLayout === 'function',
      ),
    ).toHaveLength(0);
    expect(screen.getByText('New Playlist')).toBeTruthy();
  });

  it('measures only once even if layout fires again before ready', async () => {
    act(() => addToPlaylistStore.getState().showSong(song));
    render(<AddToPlaylistSheet />);
    await elapseRevealDelay();

    const node = screen.UNSAFE_root.findAll(
      (n) => typeof n.type !== 'string' && typeof n.props.onLayout === 'function',
    )[0];
    const onLayout = node.props.onLayout as (e: unknown) => void;
    act(() => {
      onLayout({ nativeEvent: { layout: { height: 100 } } });
      onLayout({ nativeEvent: { layout: { height: 300 } } });
    });
    expect(screen.getByText('New Playlist')).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/*  Picking an existing playlist                                       */
/* ------------------------------------------------------------------ */

describe('adding to an existing playlist', () => {
  async function openWithPlaylist(show: () => void) {
    mockListAllPlaylists.mockResolvedValue([row('p1', 'Road Trip', 2)]);
    act(show);
    render(<AddToPlaylistSheet />);
    await elapseRevealDelay();
    mockRefresh.mockClear();
  }

  async function pickRoadTrip() {
    await act(async () => {
      fireEvent.press(screen.getByText('Road Trip'));
    });
  }

  async function settleOverlay() {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
  }

  it('adds a song, closes the sheet, refreshes playlists and reports success', async () => {
    await openWithPlaylist(() => addToPlaylistStore.getState().showSong(song));
    await pickRoadTrip();

    expect(mockAddToPlaylist).toHaveBeenCalledWith('p1', ['s1']);
    expect(addToPlaylistStore.getState().visible).toBe(false);
    expect(screen.queryByTestId('bottom-sheet')).toBeNull();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    // Not downloaded — no detail re-fetch.
    expect(mockFetchPlaylistDetail).not.toHaveBeenCalled();

    await settleOverlay();
    expect(processingOverlayStore.getState()).toEqual(
      expect.objectContaining({ status: 'success', label: 'Added to Playlist' }),
    );
  });

  it("adds every track of an album, resolved from the server's album", async () => {
    mockGetAlbum.mockResolvedValue({ id: 'al1', song: [{ id: 'a1' }, { id: 'a2' }] });
    mockAddToPlaylist.mockResolvedValue(true);
    await openWithPlaylist(() => addToPlaylistStore.getState().showAlbum(album));
    await pickRoadTrip();

    expect(mockGetAlbum).toHaveBeenCalledWith('al1');
    expect(mockAddToPlaylist).toHaveBeenCalledWith('p1', ['a1', 'a2']);
  });

  it('adds every song in the queue', async () => {
    mockAddToPlaylist.mockResolvedValue(true);
    await openWithPlaylist(() => addToPlaylistStore.getState().showQueue(queueSongs));
    await pickRoadTrip();

    expect(mockAddToPlaylist).toHaveBeenCalledWith('p1', ['q1', 'q2']);
  });

  it('re-syncs the on-disk tracks of a downloaded playlist', async () => {
    mockAddToPlaylist.mockResolvedValue(true);
    mockCachedItems = { p1: { type: 'playlist' } };
    mockFetchPlaylistDetail.mockResolvedValue({ id: 'p1', entry: [{ id: 's1' }, { id: 'x' }] });
    await openWithPlaylist(() => addToPlaylistStore.getState().showSong(song));
    await pickRoadTrip();

    expect(mockFetchPlaylistDetail).toHaveBeenCalledWith('p1', { force: true });
    expect(mockSyncCachedItemTracks).toHaveBeenCalledWith('p1', [{ id: 's1' }, { id: 'x' }]);
  });

  it('syncs an empty track list when the re-fetched playlist has no entries', async () => {
    mockAddToPlaylist.mockResolvedValue(true);
    mockCachedItems = { p1: { type: 'playlist' } };
    mockFetchPlaylistDetail.mockResolvedValue({ id: 'p1' });
    await openWithPlaylist(() => addToPlaylistStore.getState().showSong(song));
    await pickRoadTrip();

    expect(mockSyncCachedItemTracks).toHaveBeenCalledWith('p1', []);
  });

  it('skips the track sync when the downloaded playlist cannot be re-fetched', async () => {
    mockAddToPlaylist.mockResolvedValue(true);
    mockCachedItems = { p1: { type: 'playlist' } };
    mockFetchPlaylistDetail.mockResolvedValue(null);
    await openWithPlaylist(() => addToPlaylistStore.getState().showSong(song));
    await pickRoadTrip();

    expect(mockFetchPlaylistDetail).toHaveBeenCalled();
    expect(mockSyncCachedItemTracks).not.toHaveBeenCalled();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  describe('failures', () => {
    let warnSpy: jest.SpyInstance;
    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    async function expectFailure(message: string) {
      expect(warnSpy).toHaveBeenCalledWith('[processingOverlay] task failed:', new Error(message));
      expect(mockRefresh).not.toHaveBeenCalled();
      await settleOverlay();
      expect(processingOverlayStore.getState()).toEqual(
        expect.objectContaining({ status: 'error', label: 'Failed to add to playlist' }),
      );
    }

    it('reports an error when the server rejects the add', async () => {
      mockAddToPlaylist.mockResolvedValue(false);
      await openWithPlaylist(() => addToPlaylistStore.getState().showSong(song));
      await pickRoadTrip();

      expect(mockAddToPlaylist).toHaveBeenCalledWith('p1', ['s1']);
      await expectFailure('API returned false');
    });

    it('reports an error when the album cannot be fetched', async () => {
      mockGetAlbum.mockResolvedValue(null);
      await openWithPlaylist(() => addToPlaylistStore.getState().showAlbum(album));
      await pickRoadTrip();

      expect(mockAddToPlaylist).not.toHaveBeenCalled();
      await expectFailure('Could not resolve songs');
    });

    it('reports an error when the album has no tracks', async () => {
      mockGetAlbum.mockResolvedValue({ id: 'al1', song: [] });
      await openWithPlaylist(() => addToPlaylistStore.getState().showAlbum(album));
      await pickRoadTrip();

      expect(mockAddToPlaylist).not.toHaveBeenCalled();
      await expectFailure('Could not resolve songs');
    });

    it('reports an error for an empty queue', async () => {
      await openWithPlaylist(() => addToPlaylistStore.getState().showQueue([]));
      await pickRoadTrip();

      expect(mockAddToPlaylist).not.toHaveBeenCalled();
      await expectFailure('Could not resolve songs');
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Creating a new playlist                                            */
/* ------------------------------------------------------------------ */

describe('creating a new playlist', () => {
  async function openCreateForm(show: () => void = () => addToPlaylistStore.getState().showSong(song)) {
    act(show);
    render(<AddToPlaylistSheet />);
    await elapseRevealDelay();
    mockRefresh.mockClear();
    fireEvent.press(screen.getByText('New Playlist'));
  }

  it('switches to the form and back, clearing the typed name', async () => {
    await openCreateForm();
    expect(screen.getByText('Playlist Name')).toBeTruthy();
    expect(screen.queryByText('New Playlist')).toBeNull();

    fireEvent.changeText(screen.getByPlaceholderText('Enter playlist name…'), 'Draft');
    fireEvent.press(screen.getByText('Back'));
    expect(screen.getByText('New Playlist')).toBeTruthy();

    fireEvent.press(screen.getByText('New Playlist'));
    expect(screen.getByPlaceholderText('Enter playlist name…').props.value).toBe('');
  });

  it('asks for a name when it is blank, without calling the server', async () => {
    await openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText('Enter playlist name…'), '   ');
    await act(async () => {
      fireEvent.press(screen.getByText('Create Playlist'));
    });

    expect(screen.getByText('Please enter a playlist name')).toBeTruthy();
    expect(mockCreateNewPlaylist).not.toHaveBeenCalled();

    // Back clears the error.
    fireEvent.press(screen.getByText('Back'));
    fireEvent.press(screen.getByText('New Playlist'));
    expect(screen.queryByText('Please enter a playlist name')).toBeNull();
  });

  it('creates the playlist with the trimmed name and closes with a success overlay', async () => {
    mockCreateNewPlaylist.mockResolvedValue(true);
    await openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText('Enter playlist name…'), '  Summer  ');
    await act(async () => {
      fireEvent.press(screen.getByText('Create Playlist'));
    });

    expect(mockCreateNewPlaylist).toHaveBeenCalledWith('Summer', ['s1']);
    expect(addToPlaylistStore.getState().visible).toBe(false);
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(processingOverlayStore.getState()).toEqual(
      expect.objectContaining({ status: 'success', label: 'Playlist Created' }),
    );
  });

  it('creates from the keyboard submit with an album target', async () => {
    mockGetAlbum.mockResolvedValue({ id: 'al1', song: [{ id: 'a1' }] });
    mockCreateNewPlaylist.mockResolvedValue(true);
    await openCreateForm(() => addToPlaylistStore.getState().showAlbum(album));
    const input = screen.getByPlaceholderText('Enter playlist name…');
    fireEvent.changeText(input, 'From Album');
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    expect(mockCreateNewPlaylist).toHaveBeenCalledWith('From Album', ['a1']);
  });

  it('shows the busy state and ignores a second submit while creating', async () => {
    const create = deferred<boolean>();
    mockCreateNewPlaylist.mockReturnValueOnce(create.promise);
    await openCreateForm();
    const input = screen.getByPlaceholderText('Enter playlist name…');
    fireEvent.changeText(input, 'Busy');
    await act(async () => {
      fireEvent.press(screen.getByText('Create Playlist'));
    });

    expect(screen.queryByText('Create Playlist')).toBeNull();
    expect(input.props.editable).toBe(false);
    await act(async () => {
      fireEvent(input, 'submitEditing');
    });
    expect(mockCreateNewPlaylist).toHaveBeenCalledTimes(1);

    await act(async () => create.resolve(true));
    expect(addToPlaylistStore.getState().visible).toBe(false);
  });

  it('shows an error and stays open when the server rejects the create', async () => {
    mockCreateNewPlaylist.mockResolvedValue(false);
    await openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText('Enter playlist name…'), 'Nope');
    await act(async () => {
      fireEvent.press(screen.getByText('Create Playlist'));
    });

    expect(screen.getByText('Failed to create playlist')).toBeTruthy();
    expect(addToPlaylistStore.getState().visible).toBe(true);
    expect(mockRefresh).not.toHaveBeenCalled();
    // Busy is cleared, so the button is back.
    expect(screen.getByText('Create Playlist')).toBeTruthy();
    expect(processingOverlayStore.getState().status).toBe('idle');
  });

  it('shows an error when the songs cannot be resolved', async () => {
    await openCreateForm(() => addToPlaylistStore.getState().showQueue([]));
    fireEvent.changeText(screen.getByPlaceholderText('Enter playlist name…'), 'Empty');
    await act(async () => {
      fireEvent.press(screen.getByText('Create Playlist'));
    });

    expect(mockCreateNewPlaylist).not.toHaveBeenCalled();
    expect(screen.getByText('Failed to create playlist')).toBeTruthy();
  });

  it('resets to the pick list when the sheet is dismissed and reopened', async () => {
    await openCreateForm();
    fireEvent.press(screen.getByTestId('sheet-backdrop'));
    expect(addToPlaylistStore.getState().visible).toBe(false);

    act(() => addToPlaylistStore.getState().showSong(song));
    await elapseRevealDelay();
    await waitFor(() => expect(screen.getByText('New Playlist')).toBeTruthy());
    expect(screen.queryByText('Playlist Name')).toBeNull();
  });
});
