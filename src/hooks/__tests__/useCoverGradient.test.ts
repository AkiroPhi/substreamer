/**
 * useCoverGradient: a two-stop gradient from the extracted primary (or the theme background
 * when there is none) to the caller's end colour, passing the palette's opacity through.
 */
import { renderHook } from '@testing-library/react-native';

const mockOpacity = { value: 0.5 };
const mockUseImagePalette = jest.fn();
jest.mock('../useImagePalette', () => ({
  useImagePalette: (id: string | undefined, albumId?: string | null) => mockUseImagePalette(id, albumId),
}));
jest.mock('../useTheme', () => ({ useTheme: () => ({ colors: { background: '#000000' } }) }));

import { useCoverGradient } from '../useCoverGradient';

beforeEach(() => {
  mockUseImagePalette.mockReset();
});

it('runs from the extracted primary to the end colour', () => {
  mockUseImagePalette.mockReturnValue({ primary: '#123456', secondary: '#654321', gradientOpacity: mockOpacity });
  const { result } = renderHook(() => useCoverGradient('cov-1', '#ffffff', 'alb-1'));

  expect(mockUseImagePalette).toHaveBeenCalledWith('cov-1', 'alb-1');
  expect(result.current.gradientColors).toEqual(['#123456', '#ffffff']);
  expect(result.current.gradientLocations).toEqual([0, 0.6]);
  expect(result.current.gradientOpacity).toBe(mockOpacity);
});

it('falls back to the theme background when there is no palette', () => {
  mockUseImagePalette.mockReturnValue({ primary: null, secondary: null, gradientOpacity: mockOpacity });
  const { result } = renderHook(() => useCoverGradient(undefined, '#111111'));

  expect(mockUseImagePalette).toHaveBeenCalledWith(undefined, undefined);
  expect(result.current.gradientColors).toEqual(['#000000', '#111111']);
});
