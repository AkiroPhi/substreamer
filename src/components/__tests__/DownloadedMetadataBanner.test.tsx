jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

jest.mock('../../services/connectivityService', () => ({
  recheckNow: jest.fn(() => Promise.resolve()),
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

import { DownloadedMetadataBanner } from '../DownloadedMetadataBanner';
import { recheckNow } from '../../services/connectivityService';
import { connectivityStore } from '../../store/connectivityStore';
import { downloadedMetadataRefreshStore } from '../../store/downloadedMetadataRefreshStore';
import { offlineModeStore } from '../../store/offlineModeStore';

const mockRecheck = recheckNow as jest.Mock;

describe('DownloadedMetadataBanner when the pass cannot run', () => {
  beforeEach(() => {
    mockRecheck.mockClear();
    downloadedMetadataRefreshStore.setState({ active: true, total: 8, done: 0, failed: 0 });
    offlineModeStore.setState({ offlineMode: false });
    connectivityStore.setState({ hasConnection: true, isServerReachable: true });
  });

  it('reports progress normally when the server is reachable', () => {
    render(<DownloadedMetadataBanner />);
    expect(screen.getByText('Updating downloads 0 / 8')).toBeTruthy();
  });

  // This banner previously had no paused state at all, so it claimed to be updating
  // downloads while the pass could not reach the server.
  it('says it is paused rather than updating, in offline mode', () => {
    offlineModeStore.setState({ offlineMode: true });
    render(<DownloadedMetadataBanner />);

    expect(screen.queryByText('Updating downloads 0 / 8')).toBeNull();
    expect(screen.getByText('Downloads paused — offline')).toBeTruthy();
  });

  it('offers no retry in offline mode', () => {
    offlineModeStore.setState({ offlineMode: true });
    render(<DownloadedMetadataBanner />);

    fireEvent.press(screen.getByTestId('downloaded-metadata-banner-action'));
    expect(mockRecheck).not.toHaveBeenCalled();
  });

  it('waits for the connection, and retries on tap, when the server is unreachable', () => {
    connectivityStore.setState({ hasConnection: false, isServerReachable: true });
    render(<DownloadedMetadataBanner />);

    expect(screen.getByText('Downloads paused — no connection')).toBeTruthy();

    fireEvent.press(screen.getByTestId('downloaded-metadata-banner-action'));
    expect(mockRecheck).toHaveBeenCalled();
  });
});
