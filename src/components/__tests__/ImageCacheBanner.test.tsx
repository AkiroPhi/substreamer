jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

jest.mock('../../services/connectivityService', () => ({
  recheckNow: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../services/imageCacheService', () => ({
  dismissImageCacheErrorBanner: jest.fn(),
  // The queue store subscribes at module init.
  subscribeImageQueueChanges: jest.fn(() => () => {}),
  readImageQueueMeta: jest.fn(() => ({ cycleId: null, cycleTotal: 0, isPaused: false, phase: 'idle' })),
}));

jest.mock('react-native-reanimated', () => {
  const { View, Text } = require('react-native');
  return {
    __esModule: true,
    default: { View, Text },
    useSharedValue: (init: number) => ({ value: init }),
    useAnimatedStyle: (fn: () => object) => fn(),
    withTiming: (v: number) => v,
    withSpring: (v: number) => v,
    withDelay: (_d: number, v: number) => v,
    Easing: { in: () => null, out: () => null, inOut: () => null, cubic: null },
  };
});

import { fireEvent, render, screen } from '@testing-library/react-native';

import { ImageCacheBanner } from '../ImageCacheBanner';
import { recheckNow } from '../../services/connectivityService';
import { connectivityStore } from '../../store/connectivityStore';
import { imageDownloadQueueStore } from '../../store/imageDownloadQueueStore';
import { offlineModeStore } from '../../store/offlineModeStore';

const mockRecheck = recheckNow as jest.Mock;

/** A cycle that is open with nothing done — the state the user reported. */
function openCycle() {
  imageDownloadQueueStore.setState({
    cycleId: 'cyc-1', cycleTotal: 11, cycleProcessed: 0, cycleFailed: 0,
    isPaused: false, phase: 'active',
  });
}

describe('ImageCacheBanner when the queue cannot run', () => {
  beforeEach(() => {
    mockRecheck.mockClear();
    openCycle();
    offlineModeStore.setState({ offlineMode: false });
    connectivityStore.setState({ hasConnection: true, isServerReachable: true });
  });

  it('reports progress normally when the server is reachable', () => {
    render(<ImageCacheBanner />);
    expect(screen.getByText('Refreshing covers 0 / 11')).toBeTruthy();
  });

  // The reported bug: offline, the queue declines to run and the pill sat on
  // "Refreshing covers 0 / 11" forever, claiming work that could not happen.
  it('says it is paused rather than refreshing, in offline mode', () => {
    offlineModeStore.setState({ offlineMode: true });
    render(<ImageCacheBanner />);

    expect(screen.queryByText('Refreshing covers 0 / 11')).toBeNull();
    // Names the task, and drops the count — "0 / 11" beside "paused" reads as progress.
    expect(screen.getByText('Covers paused — offline')).toBeTruthy();
  });

  // Offline mode is the user's own choice, so re-pinging would not help them.
  it('offers no retry in offline mode', () => {
    offlineModeStore.setState({ offlineMode: true });
    render(<ImageCacheBanner />);

    fireEvent.press(screen.getByTestId('image-cache-banner-action'));
    expect(mockRecheck).not.toHaveBeenCalled();
  });

  it('waits for the connection, and retries on tap, when the server is unreachable', () => {
    connectivityStore.setState({ hasConnection: true, isServerReachable: false });
    render(<ImageCacheBanner />);

    expect(screen.getByText('Covers paused — no connection')).toBeTruthy();

    fireEvent.press(screen.getByTestId('image-cache-banner-action'));
    expect(mockRecheck).toHaveBeenCalled();
  });
});
