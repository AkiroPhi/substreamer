/**
 * The medium mix card's outermost view is what the phone row (and the tablet bento cell)
 * lays out, so it carries the `flex: 1` that splits the row evenly / fills the cell.
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';

jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const { View } = require('react-native');
  const chain: Record<string, () => unknown> = {};
  chain.delay = () => chain;
  chain.duration = () => chain;
  return {
    __esModule: true,
    default: { View, createAnimatedComponent: (c: unknown) => c },
    FadeInDown: chain,
    useSharedValue: (init: number) => React.useRef({ value: init }).current,
    useAnimatedStyle: (fn: () => object) => fn(),
    withRepeat: (val: number) => val,
    withSequence: (val: number) => val,
    withSpring: (val: number) => val,
    withTiming: (val: number) => val,
  };
});
jest.mock('../../services/playerService', () => ({ playTrack: jest.fn() }));
jest.mock('../../services/tunedInService', () => ({
  ...jest.requireActual('../../services/tunedInService'),
  fetchMixSongs: jest.fn(async () => []),
}));

import { MediumMixCard } from '../tuned-in';
import type { MixDefinition } from '../../services/tunedInService';

const mix: MixDefinition = {
  id: 'deep-cuts',
  name: 'Deep Cuts',
  subtitle: 'Artists like Pearl Jam you might love',
  icon: 'compass-outline',
  gradientColors: ['#7c3aed', '#4338ca'],
  fetchStrategy: { type: 'random' } as MixDefinition['fetchStrategy'],
};

it('gives its outermost view flex: 1, so the row splits evenly and the bento cell is filled', () => {
  render(<MediumMixCard mix={mix} index={1} />);
  const root = screen.toJSON() as { props: { style?: unknown } };
  expect(StyleSheet.flatten(root.props.style as never)).toMatchObject({ flex: 1 });
  expect(screen.getByText('Deep Cuts')).toBeTruthy();
});
