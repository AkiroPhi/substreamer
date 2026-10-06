/**
 * useImagePalette: extracts from the resolved cover URI, picks the variant for the current
 * theme, keeps the last-good palette across transient misses/failures, clears only when
 * there is nothing to extract from, and drives the gradient opacity.
 */
import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { Palette } from 'expo-image-colors';

const mockGetPalette = jest.fn<Promise<Palette | null>, [string]>();
jest.mock('expo-image-colors', () => ({
  getImagePaletteAsync: (uri: string) => mockGetPalette(uri),
}));

const mockConstants = { appOwnership: null as string | null };
jest.mock('expo-constants', () => ({
  __esModule: true,
  get default() {
    return mockConstants;
  },
}));

const mockUseCachedCoverArt = jest.fn<string | null, [string | undefined, number, (string | null)?]>();
jest.mock('../useCachedCoverArt', () => ({
  useCachedCoverArt: (id: string | undefined, size: number, albumId?: string | null) =>
    mockUseCachedCoverArt(id, size, albumId),
}));

const mockTheme = { theme: 'dark' as 'dark' | 'light' };
jest.mock('../useTheme', () => ({ useTheme: () => ({ theme: mockTheme.theme }) }));

const mockWithTiming = jest.fn((v: number, _cfg?: object) => v);
jest.mock('react-native-reanimated', () => {
  const { useRef } = require('react');
  return {
    useSharedValue: (init: number) => useRef({ value: init }).current,
    withTiming: (v: number, cfg?: object) => mockWithTiming(v, cfg),
  };
});

import { SKIP_COLOR_EXTRACTION, useImagePalette } from '../useImagePalette';

const PALETTE_A: Palette = {
  dark: { primary: '#112233', secondary: '#445566' },
  light: { primary: '#ddeeff', secondary: null },
};
const PALETTE_B: Palette = {
  dark: { primary: '#aa0000', secondary: null },
  light: { primary: '#ffcccc', secondary: '#ccffcc' },
};

let uris: Record<string, string | null>;

beforeEach(() => {
  mockGetPalette.mockReset();
  mockWithTiming.mockClear();
  mockConstants.appOwnership = null;
  mockTheme.theme = 'dark';
  uris = { 'cov-a': 'file:///c/a.jpg', 'cov-b': 'file:///c/b.jpg' };
  mockUseCachedCoverArt.mockReset();
  mockUseCachedCoverArt.mockImplementation((id) => (id ? uris[id] ?? null : null));
});

function setup(initial: string | undefined, albumId?: string | null) {
  return renderHook(
    ({ id, album }: { id: string | undefined; album?: string | null }) => useImagePalette(id, album),
    { initialProps: { id: initial, album: albumId } },
  );
}

it('extracts from the resolved cover and returns the dark variant, fading the gradient in', async () => {
  mockGetPalette.mockResolvedValue(PALETTE_A);
  const { result } = setup('cov-a', 'alb-1');

  expect(result.current.primary).toBeNull();
  await waitFor(() => expect(result.current.primary).toBe('#112233'));
  expect(result.current.secondary).toBe('#445566');
  expect(mockGetPalette).toHaveBeenCalledWith('file:///c/a.jpg');
  expect(mockUseCachedCoverArt).toHaveBeenCalledWith('cov-a', 300, 'alb-1');
  expect(mockWithTiming).toHaveBeenLastCalledWith(1, { duration: 400 });
  expect(result.current.gradientOpacity.value).toBe(1);
});

it('re-picks the light variant on a theme flip without calling native again', async () => {
  mockGetPalette.mockResolvedValue(PALETTE_A);
  const { result, rerender } = setup('cov-a');
  await waitFor(() => expect(result.current.primary).toBe('#112233'));

  mockTheme.theme = 'light';
  rerender({ id: 'cov-a' });
  expect(result.current.primary).toBe('#ddeeff');
  expect(result.current.secondary).toBeNull();
  expect(mockGetPalette).toHaveBeenCalledTimes(1);
});

it('skips extraction for the sentinel and does not resolve the cover', async () => {
  const { result } = setup(SKIP_COLOR_EXTRACTION);
  await act(async () => {});
  expect(mockUseCachedCoverArt).toHaveBeenCalledWith(undefined, 300, undefined);
  expect(mockGetPalette).not.toHaveBeenCalled();
  expect(result.current.primary).toBeNull();
  expect(result.current.secondary).toBeNull();
  expect(mockWithTiming).toHaveBeenLastCalledWith(0, { duration: 300 });
});

it('does nothing in Expo Go, where there is no native module', async () => {
  mockConstants.appOwnership = 'expo';
  const { result } = setup('cov-a');
  await act(async () => {});
  expect(mockGetPalette).not.toHaveBeenCalled();
  expect(result.current.primary).toBeNull();
});

it('clears the palette and fades the gradient out when the cover goes away', async () => {
  mockGetPalette.mockResolvedValue(PALETTE_A);
  const { result, rerender } = setup('cov-a');
  await waitFor(() => expect(result.current.primary).toBe('#112233'));

  rerender({ id: undefined });
  await waitFor(() => expect(result.current.primary).toBeNull());
  expect(mockWithTiming).toHaveBeenLastCalledWith(0, { duration: 300 });
  expect(result.current.gradientOpacity.value).toBe(0);
});

it('keeps the last-good palette while the cover URI is transiently unresolved', async () => {
  mockGetPalette.mockResolvedValue(PALETTE_A);
  const { result, rerender } = setup('cov-a');
  await waitFor(() => expect(result.current.primary).toBe('#112233'));

  uris['cov-a'] = null;
  rerender({ id: 'cov-a' });
  await act(async () => {});
  expect(result.current.primary).toBe('#112233');
  expect(mockGetPalette).toHaveBeenCalledTimes(1);
});

it('waits for the URI before extracting', async () => {
  uris['cov-a'] = null;
  mockGetPalette.mockResolvedValue(PALETTE_A);
  const { result, rerender } = setup('cov-a');
  await act(async () => {});
  expect(mockGetPalette).not.toHaveBeenCalled();

  uris['cov-a'] = 'file:///c/a.jpg';
  rerender({ id: 'cov-a' });
  await waitFor(() => expect(result.current.primary).toBe('#112233'));
});

it('keeps the last-good palette when a later extraction fails', async () => {
  mockGetPalette.mockResolvedValueOnce(PALETTE_A);
  const { result, rerender } = setup('cov-a');
  await waitFor(() => expect(result.current.primary).toBe('#112233'));

  mockGetPalette.mockRejectedValueOnce(new Error('decode failed'));
  rerender({ id: 'cov-b' });
  await waitFor(() => expect(mockGetPalette).toHaveBeenCalledWith('file:///c/b.jpg'));
  await act(async () => {});
  expect(result.current.primary).toBe('#112233');
});

it('ignores a stale extraction that resolves after the cover changed', async () => {
  let resolveA: (p: Palette) => void = () => {};
  mockGetPalette.mockImplementation((uri) =>
    uri === 'file:///c/a.jpg'
      ? new Promise<Palette>((r) => { resolveA = r; })
      : Promise.resolve(PALETTE_B),
  );
  const { result, rerender } = setup('cov-a');
  await waitFor(() => expect(mockGetPalette).toHaveBeenCalledWith('file:///c/a.jpg'));

  rerender({ id: 'cov-b' });
  await waitFor(() => expect(result.current.primary).toBe('#aa0000'));

  await act(async () => { resolveA(PALETTE_A); });
  expect(result.current.primary).toBe('#aa0000');
});

it('returns nulls when the image has no usable colour', async () => {
  mockGetPalette.mockResolvedValue(null);
  const { result } = setup('cov-a');
  await waitFor(() => expect(mockGetPalette).toHaveBeenCalled());
  await act(async () => {});
  expect(result.current.primary).toBeNull();
  expect(result.current.secondary).toBeNull();
  expect(result.current.gradientOpacity.value).toBe(0);
});
