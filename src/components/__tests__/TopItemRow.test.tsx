/**
 * Top-items stats row: rank/title/subtitle/count rendering, initials vs cover art, the
 * bar's animation target (count / maxCount, staggered by index), and press handling.
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockWithTiming = jest.fn((v: number, _cfg?: object) => v);
const mockWithDelay = jest.fn((_d: number, v: number) => v);
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const { useRef } = require('react');
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (init: number) => useRef({ value: init }).current,
    useAnimatedStyle: (fn: () => object) => fn(),
    withTiming: (v: number, cfg?: object) => mockWithTiming(v, cfg),
    withDelay: (d: number, v: number) => mockWithDelay(d, v),
  };
});

const mockCachedImage = jest.fn();
jest.mock('../CachedImage', () => ({
  CachedImage: (props: Record<string, unknown>) => {
    mockCachedImage(props);
    return null;
  },
}));

import { TopItemRow } from '../TopItemRow';
import { themeColors } from '../../constants/theme';

const colors = themeColors.dark;

function renderRow(overrides: Partial<React.ComponentProps<typeof TopItemRow>> = {}) {
  return render(
    <TopItemRow
      rank={3}
      title="Song Title"
      count={5}
      maxCount={10}
      colors={colors}
      index={2}
      {...overrides}
    />,
  );
}

/** Pressable is the only element here that takes a function style. */
function findStyleFunctions() {
  return screen.UNSAFE_root.findAll((n) => typeof n.props.style === 'function');
}

beforeEach(() => {
  mockWithTiming.mockClear();
  mockWithDelay.mockClear();
  mockCachedImage.mockClear();
});

it('renders rank, title, count, and the subtitle when given', () => {
  renderRow({ subtitle: 'Some Artist' });
  expect(screen.getByText('3')).toBeTruthy();
  expect(screen.getByText('Song Title')).toBeTruthy();
  expect(screen.getByText('5')).toBeTruthy();
  expect(screen.getByText('Some Artist')).toBeTruthy();
});

it('omits the subtitle line when none is given', () => {
  renderRow();
  expect(screen.queryByText('Some Artist')).toBeNull();
});

it('animates the bar to count / maxCount, staggered by row index', () => {
  const { toJSON } = renderRow({ count: 5, maxCount: 10, index: 2 });
  expect(mockWithTiming).toHaveBeenCalledWith(50, { duration: 600 });
  expect(mockWithDelay).toHaveBeenCalledWith(120, 50);
  // The first paint starts from an empty bar.
  expect(JSON.stringify(toJSON())).toContain('"width":"0%"');
});

it('reflects the animated width once the shared value has been set', () => {
  const { rerender, toJSON } = renderRow({ count: 3, maxCount: 4, index: 0 });
  // A changed prop re-renders the memoised row, which reads the shared value the effect set.
  rerender(<TopItemRow rank={4} title="Song Title" count={3} maxCount={4} colors={colors} index={0} />);
  expect(JSON.stringify(toJSON())).toContain('"width":"75%"');
  expect(mockWithDelay).toHaveBeenCalledWith(0, 75);
});

it('targets an empty bar when maxCount is zero instead of dividing by zero', () => {
  renderRow({ count: 4, maxCount: 0 });
  expect(mockWithTiming).toHaveBeenCalledWith(0, { duration: 600 });
});

it('shows initials instead of cover art when initials are given', () => {
  renderRow({ initials: 'AB', coverArtId: 'cov-1' });
  expect(screen.getByText('AB')).toBeTruthy();
  expect(mockCachedImage).not.toHaveBeenCalled();
});

it('hands cover art (and the album id) to CachedImage', () => {
  renderRow({ coverArtId: 'cov-1', albumId: 'alb-1' });
  expect(mockCachedImage).toHaveBeenCalledWith(
    expect.objectContaining({ coverArtId: 'cov-1', albumId: 'alb-1', size: 150 }),
  );
});

it('still renders CachedImage when the cover art id is not known yet', () => {
  renderRow();
  expect(mockCachedImage).toHaveBeenCalledWith(expect.objectContaining({ coverArtId: undefined }));
});

it('is pressable when onPress is given, with pressed feedback', () => {
  const onPress = jest.fn();
  renderRow({ onPress });
  fireEvent.press(screen.getByText('Song Title'));
  expect(onPress).toHaveBeenCalledTimes(1);

  const [pressable] = findStyleFunctions();
  const styleFn = pressable.props.style as (s: { pressed: boolean }) => unknown[];
  expect(styleFn({ pressed: true })).toContainEqual({ opacity: 0.6 });
  expect(styleFn({ pressed: false })).toContain(false);
});

it('is a plain non-interactive row when onPress is omitted', () => {
  renderRow();
  expect(findStyleFunctions()).toHaveLength(0);
  expect(screen.getByText('Song Title')).toBeTruthy();
});
