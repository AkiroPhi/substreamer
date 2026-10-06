/**
 * Player queue row: its swipe actions and what it renders. `SwipeableRow` is stubbed to
 * expose each action as a pressable; the gesture itself belongs to its own suite.
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

import type { Child } from '../../services/subsonicService';

interface StubAction {
  label?: string;
  onPress: () => void;
}
jest.mock('../SwipeableRow', () => {
  const { Pressable, Text, View } = require('react-native');
  return {
    SwipeableRow: ({
      children,
      rightActions = [],
      leftActions = [],
      enableFullSwipeRight,
      onPress,
      onLongPress,
    }: {
      children: React.ReactNode;
      rightActions?: StubAction[];
      leftActions?: StubAction[];
      enableFullSwipeRight?: boolean;
      onPress?: () => void;
      onLongPress?: () => void;
    }) => (
      <View>
        <Pressable testID="row-body" onPress={onPress} onLongPress={onLongPress}>
          {children}
        </Pressable>
        <Text testID="full-swipe-right">{String(!!enableFullSwipeRight)}</Text>
        {rightActions.map((a, i) => (
          <Pressable key={`r${i}`} testID={`right-${a.label}`} onPress={a.onPress} />
        ))}
        {leftActions.map((a, i) => (
          <Pressable key={`l${i}`} testID={`left-${i}`} onPress={a.onPress} />
        ))}
      </View>
    ),
  };
});
jest.mock('../CachedImage', () => ({ CachedImage: () => null }));
jest.mock('../NowPlayingIndicator', () => {
  const { Text } = require('react-native');
  return { NowPlayingIndicator: () => <Text>now-playing</Text> };
});
jest.mock('../RowMetaLine', () => {
  const { Text } = require('react-native');
  return {
    RowMetaLine: ({ durationText }: { durationText?: string }) =>
      durationText ? <Text>{durationText}</Text> : null,
  };
});
jest.mock('../../hooks/useRating', () => ({ useRating: () => 0 }));
const mockStarred = { value: false };
jest.mock('../../hooks/useIsStarred', () => ({ useIsStarred: () => mockStarred.value }));
jest.mock('../../hooks/useDownloadStatus', () => ({ useDownloadStatus: () => 'none' }));

const mockRemoveItemFromQueue = jest.fn();
const mockToggleStar = jest.fn();
jest.mock('../../services/moreOptionsService', () => ({
  removeItemFromQueue: (index: number) => mockRemoveItemFromQueue(index),
  toggleStar: (type: string, id: string) => mockToggleStar(type, id),
}));
const mockShowSong = jest.fn();
jest.mock('../../store/addToPlaylistStore', () => ({
  addToPlaylistStore: { getState: () => ({ showSong: mockShowSong }) },
}));

import { QueueItemRow } from '../QueueItemRow';
import { offlineModeStore } from '../../store/offlineModeStore';

const COLORS = {
  textPrimary: '#fff',
  textSecondary: '#888',
  primary: '#1D9BF0',
  border: '#333',
  red: '#e91429',
};

const track = { id: 't1', title: 'Song One', artist: 'Artist', duration: 200 } as Child;

function renderRow(props: Partial<React.ComponentProps<typeof QueueItemRow>> = {}) {
  const onPress = jest.fn();
  const onLongPress = jest.fn();
  render(
    <QueueItemRow
      track={track}
      index={3}
      isActive={false}
      colors={COLORS}
      onPress={onPress}
      onLongPress={onLongPress}
      {...props}
    />,
  );
  return { onPress, onLongPress };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStarred.value = false;
  offlineModeStore.setState({ offlineMode: false });
});

describe('QueueItemRow remove action', () => {
  it('offers remove on a queued track and removes it by index', () => {
    renderRow();
    expect(screen.getByTestId('full-swipe-right').props.children).toBe('true');
    fireEvent.press(screen.getByTestId('right-Remove'));
    expect(mockRemoveItemFromQueue).toHaveBeenCalledWith(3);
  });

  it('offers no remove action, and no full swipe, on the playing track', () => {
    renderRow({ isActive: true });
    expect(screen.queryByTestId('right-Remove')).toBeNull();
    expect(screen.getByTestId('full-swipe-right').props.children).toBe('false');
    expect(screen.getByText('now-playing')).toBeTruthy();
  });
});

describe('QueueItemRow other actions', () => {
  it('adds to a playlist and toggles the favourite', () => {
    renderRow();
    fireEvent.press(screen.getByTestId('left-0'));
    expect(mockShowSong).toHaveBeenCalledWith(track);
    fireEvent.press(screen.getByTestId('left-1'));
    expect(mockToggleStar).toHaveBeenCalledWith('song', 't1');
  });

  it('hides the playlist and favourite actions offline', () => {
    offlineModeStore.setState({ offlineMode: true });
    renderRow();
    expect(screen.queryByTestId('left-0')).toBeNull();
  });

  it('passes press and long press through', () => {
    const { onPress, onLongPress } = renderRow();
    fireEvent.press(screen.getByTestId('row-body'));
    expect(onPress).toHaveBeenCalledWith(3);
    fireEvent(screen.getByTestId('row-body'), 'longPress');
    expect(onLongPress).toHaveBeenCalledWith(track);
  });

  it('renders title, artist and duration, and copes with no artist or duration', () => {
    mockStarred.value = true;
    renderRow();
    expect(screen.getByText('Song One')).toBeTruthy();
    expect(screen.getByText('Artist')).toBeTruthy();
    expect(screen.getByText('3:20')).toBeTruthy();
    screen.unmount();
    renderRow({ track: { id: 't2', title: 'Bare' } as Child, onLongPress: undefined });
    expect(screen.getByText('Bare')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });
});
