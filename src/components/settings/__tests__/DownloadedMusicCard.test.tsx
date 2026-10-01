jest.mock('../../../store/persistence/kvStorage', () =>
  require('../../../store/persistence/__mocks__/kvStorage'),
);

jest.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      primary: '#ff6600',
      textPrimary: '#ffffff',
      textSecondary: '#888888',
      border: '#333333',
      card: '#1e1e1e',
    },
  }),
}));

const mockAlert = jest.fn();
jest.mock('../../../hooks/useThemedAlert', () => ({
  useThemedAlert: () => ({ alert: mockAlert, confirm: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const mockEnqueueImageRefreshCycle = jest.fn(async (_scope: string) => 'cyc-1');
jest.mock('../../../services/imageCacheService', () => ({
  enqueueImageRefreshCycle: (scope: string) => mockEnqueueImageRefreshCycle(scope),
  subscribeImageQueueChanges: jest.fn(),
}));

const mockRefreshDownloadedMetadata = jest.fn(async (_opts: { mode: string }) => ({ attempted: 0, remaining: 0 }));
jest.mock('../../../services/downloadedMetadataService', () => ({
  refreshDownloadedMetadata: (opts: { mode: string }) => mockRefreshDownloadedMetadata(opts),
}));

const mockRefreshPlaylistLibrary = jest.fn(async () => {});
jest.mock('../../../services/normalizedLibrarySync', () => ({
  refreshPlaylistLibrary: () => mockRefreshPlaylistLibrary(),
}));

jest.mock('../../../services/fullLibraryDownloadService', () => ({
  canDownloadFullLibrary: jest.fn(() => true),
  enqueueFullLibraryDownload: jest.fn(),
}));

jest.mock('../../../services/musicCacheService', () => ({
  clearQueuedDownloads: jest.fn(),
}));

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { DownloadedMusicCard } from '../DownloadedMusicCard';
import { connectivityStore } from '../../../store/connectivityStore';
import { imageDownloadQueueStore } from '../../../store/imageDownloadQueueStore';
import { offlineModeStore } from '../../../store/offlineModeStore';

describe('DownloadedMusicCard refresh covers', () => {
  beforeEach(() => {
    mockEnqueueImageRefreshCycle.mockClear();
    mockRefreshDownloadedMetadata.mockClear();
    mockRefreshPlaylistLibrary.mockClear();
    mockAlert.mockClear();
    offlineModeStore.setState({ offlineMode: false });
    connectivityStore.setState({ isServerReachable: true });
    imageDownloadQueueStore.setState({ cycleId: null, cycleTotal: 0 });
  });

  it('renders above Refresh downloads', () => {
    render(<DownloadedMusicCard />);
    const tree = JSON.stringify(screen.toJSON());
    expect(tree.indexOf('Refresh covers')).toBeGreaterThan(-1);
    expect(tree.indexOf('Refresh covers')).toBeLessThan(tree.indexOf('Refresh downloads'));
  });

  it('starts a downloaded-covers refresh cycle', () => {
    render(<DownloadedMusicCard />);
    fireEvent.press(screen.getByText('Refresh covers'));
    expect(mockEnqueueImageRefreshCycle).toHaveBeenCalledWith('refresh-downloads');
  });

  it('is disabled in offline mode', () => {
    offlineModeStore.setState({ offlineMode: true });
    render(<DownloadedMusicCard />);
    fireEvent.press(screen.getByText('Refresh covers'));
    expect(mockEnqueueImageRefreshCycle).not.toHaveBeenCalled();
  });

  it('is disabled when the server is unreachable', () => {
    connectivityStore.setState({ isServerReachable: false });
    render(<DownloadedMusicCard />);
    fireEvent.press(screen.getByText('Refresh covers'));
    expect(mockEnqueueImageRefreshCycle).not.toHaveBeenCalled();
  });

  it('is disabled while a refresh cycle is running', () => {
    imageDownloadQueueStore.setState({ cycleId: 'cyc-live', cycleTotal: 5 });
    render(<DownloadedMusicCard />);
    fireEvent.press(screen.getByText('Refresh covers'));
    expect(mockEnqueueImageRefreshCycle).not.toHaveBeenCalled();
  });
});

describe('DownloadedMusicCard refresh downloads', () => {
  beforeEach(() => {
    mockRefreshDownloadedMetadata.mockClear();
    mockRefreshPlaylistLibrary.mockClear();
    mockAlert.mockClear();
    offlineModeStore.setState({ offlineMode: false });
    connectivityStore.setState({ isServerReachable: true });
  });

  it('re-fetches downloaded detail, then runs the playlist sync', async () => {
    let finishDetail: () => void = () => {};
    mockRefreshDownloadedMetadata.mockImplementationOnce(
      () => new Promise((resolve) => { finishDetail = () => resolve({ attempted: 1, remaining: 0 }); }),
    );
    render(<DownloadedMusicCard />);
    fireEvent.press(screen.getByText('Refresh downloads'));

    expect(mockRefreshDownloadedMetadata).toHaveBeenCalledWith({ mode: 'all' });
    expect(mockRefreshPlaylistLibrary).not.toHaveBeenCalled();
    finishDetail();
    await waitFor(() => expect(mockRefreshPlaylistLibrary).toHaveBeenCalledTimes(1));
  });

  it('alerts instead of refreshing when the server is unreachable', () => {
    connectivityStore.setState({ isServerReachable: false });
    render(<DownloadedMusicCard />);
    fireEvent.press(screen.getByText('Refresh downloads'));

    expect(mockAlert).toHaveBeenCalledWith(
      'Refresh downloads',
      'Connect to your server to refresh downloads.',
    );
    expect(mockRefreshDownloadedMetadata).not.toHaveBeenCalled();
    expect(mockRefreshPlaylistLibrary).not.toHaveBeenCalled();
  });
});
