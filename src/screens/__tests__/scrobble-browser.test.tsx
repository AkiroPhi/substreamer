/**
 * The scrobble browser: the Completed segment pages the full history from SQL and
 * narrows it with the filter box; Pending is the in-memory queue. The SQL page
 * reader itself is covered in `store/persistence/__tests__/scrobbleAggregates.test.ts`.
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { Cursor } from '../../db/repository/core';
import type { CompletedScrobble } from '../../store/completedScrobbleStore';

jest.mock('@shopify/flash-list', () => {
  const { Pressable, Text, View } = require('react-native');
  return {
    FlashList: ({
      data,
      renderItem,
      ListEmptyComponent,
      onEndReached,
    }: {
      data: unknown[];
      renderItem: (info: { item: unknown; index: number }) => React.ReactNode;
      ListEmptyComponent?: () => React.ReactNode;
      onEndReached?: () => void;
    }) => (
      <View>
        {data.length === 0
          ? ListEmptyComponent?.()
          : data.map((item, index) => <View key={index}>{renderItem({ item, index })}</View>)}
        {onEndReached ? (
          <Pressable testID="end-reached" onPress={onEndReached}>
            <Text>end</Text>
          </Pressable>
        ) : null}
      </View>
    ),
  };
});

jest.mock('expo-router/react-navigation', () => {
  const ReactModule = require('react');
  return { HeaderHeightContext: ReactModule.createContext(0) };
});

jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      background: '#000',
      card: '#111',
      textPrimary: '#fff',
      textSecondary: '#888',
      border: '#333',
      primary: '#1D9BF0',
      inputBg: '#222',
    },
  }),
}));

jest.mock('../../components/GradientBackground', () => {
  const { View } = require('react-native');
  return {
    GradientBackground: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
  };
});
jest.mock('../../components/BottomChrome', () => ({ BottomChrome: () => null }));

const mockLoadScrobblePage = jest.fn();
jest.mock('../../store/persistence/scrobbleAggregates', () => ({
  loadScrobblePage: (opts: unknown) => mockLoadScrobblePage(opts),
}));

import { ScrobbleBrowserScreen } from '../scrobble-browser';
import { pendingScrobbleStore } from '../../store/pendingScrobbleStore';

const scrobble = (id: string, title: string, artist = 'Artist'): CompletedScrobble => ({
  id,
  song: { id: `song-${id}`, title, artist, isDir: false } as CompletedScrobble['song'],
  time: 1_700_000_000_000,
});

/** A source of `total` scrobbles paged by `limit`, newest first, filtered on title/artist. */
function pagedHistory(all: CompletedScrobble[]) {
  mockLoadScrobblePage.mockImplementation(
    async ({ cursor, limit, query }: { cursor: Cursor | null; limit: number; query?: string }) => {
      const q = query?.toLowerCase() ?? '';
      const matches = all.filter(
        (s) => !q || s.song.title.toLowerCase().includes(q) || (s.song.artist ?? '').toLowerCase().includes(q),
      );
      const start = cursor ? matches.findIndex((s) => s.id === cursor.id) + 1 : 0;
      const rows = matches.slice(start, start + limit);
      const more = start + limit < matches.length;
      return { rows, nextCursor: more ? { sortKey: 0, id: rows[rows.length - 1].id } : null };
    },
  );
}

beforeEach(() => {
  mockLoadScrobblePage.mockReset();
  pendingScrobbleStore.setState({ pendingScrobbles: [] });
});

describe('ScrobbleBrowserScreen completed history', () => {
  it('shows a spinner, not the empty state, before the first page lands', async () => {
    let resolve: (v: unknown) => void = () => {};
    mockLoadScrobblePage.mockImplementation(() => new Promise((r) => { resolve = r; }));
    render(<ScrobbleBrowserScreen />);
    expect(screen.queryByText('No completed scrobbles yet')).toBeNull();
    await act(async () => resolve({ rows: [], nextCursor: null }));
    expect(screen.getByText('No completed scrobbles yet')).toBeTruthy();
  });

  it('loads the first page, then pages further on end reached', async () => {
    const all = Array.from({ length: 150 }, (_, i) => scrobble(`e${i}`, `Song ${i}`));
    pagedHistory(all);
    render(<ScrobbleBrowserScreen />);
    await waitFor(() => expect(screen.getByText('Song 0')).toBeTruthy());
    expect(screen.queryByText('Song 120')).toBeNull();
    expect(mockLoadScrobblePage).toHaveBeenCalledWith({ cursor: null, limit: 100, query: '' });

    fireEvent.press(screen.getByTestId('end-reached'));
    await waitFor(() => expect(screen.getByText('Song 149')).toBeTruthy());
    expect(mockLoadScrobblePage).toHaveBeenLastCalledWith({
      cursor: { sortKey: 0, id: 'e99' },
      limit: 100,
      query: '',
    });
  });

  it('filters by the typed text once typing pauses, and says when nothing matches', async () => {
    pagedHistory([
      scrobble('e1', 'Blue Monday', 'New Order'),
      scrobble('e2', 'Karma Police', 'Radiohead'),
    ]);
    // The debounce runs on fake timers so it fires inside act, not whenever a loaded
    // machine gets round to a real 250ms timer.
    jest.useFakeTimers();
    try {
      render(<ScrobbleBrowserScreen />);
      await act(async () => {});
      expect(screen.getByText('Karma Police')).toBeTruthy();

      fireEvent.changeText(screen.getByPlaceholderText('Filter...'), '  new order ');
      await act(async () => jest.advanceTimersByTime(249));
      expect(mockLoadScrobblePage).toHaveBeenCalledTimes(1);
      await act(async () => jest.advanceTimersByTime(1));
      expect(screen.queryByText('Karma Police')).toBeNull();
      expect(screen.getByText('Blue Monday')).toBeTruthy();
      expect(mockLoadScrobblePage).toHaveBeenLastCalledWith({ cursor: null, limit: 100, query: 'new order' });

      fireEvent.changeText(screen.getByPlaceholderText('Filter...'), 'zzz');
      await act(async () => jest.advanceTimersByTime(250));
      expect(screen.getByText('No scrobbles match your filter')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('ScrobbleBrowserScreen pending', () => {
  it('lists pending scrobbles newest first and hides the filter', async () => {
    pagedHistory([]);
    pendingScrobbleStore.setState({
      pendingScrobbles: [scrobble('p1', 'Older'), scrobble('p2', 'Newer')],
    });
    render(<ScrobbleBrowserScreen />);
    await waitFor(() => expect(mockLoadScrobblePage).toHaveBeenCalled());
    fireEvent.press(screen.getByText('Pending'));

    expect(screen.queryByPlaceholderText('Filter...')).toBeNull();
    const tree = JSON.stringify(screen.toJSON());
    expect(tree.indexOf('Newer')).toBeLessThan(tree.indexOf('Older'));
  });

  it('shows the pending empty state', async () => {
    pagedHistory([]);
    render(<ScrobbleBrowserScreen />);
    await waitFor(() => expect(mockLoadScrobblePage).toHaveBeenCalled());
    fireEvent.press(screen.getByText('Pending'));
    expect(screen.getByText('No pending scrobbles')).toBeTruthy();
  });
});
