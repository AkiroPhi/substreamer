import Ionicons from "@react-native-vector-icons/ionicons/static";
import { memo } from 'react';
import { StyleSheet, Text } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { type ThemeColors } from '../constants/theme';

import type { IoniconsName } from '../utils/iconNames';
interface StatCardProps {
  icon: IoniconsName;
  value: string;
  label: string;
  colors: ThemeColors;
  index?: number;
}

// `entering`, NOT a shared value starting at 0 driven by a mount-only effect. That shape
// leaves the card at opacity 0 whenever the animation does not fire — and because the
// effect's deps are all stable, nothing ever re-runs it, so the card stays invisible for
// the life of the screen. Seen on Android by flipping the period a few times.
export const StatCard = memo(function StatCard({ icon, value, label, colors, index = 0 }: StatCardProps) {
  return (
    <Animated.View
      entering={FadeInDown.delay(index * 80).duration(400)}
      style={[styles.card, { backgroundColor: colors.card }]}
    >
      <Ionicons name={icon} size={20} color={colors.primary} style={styles.icon} />
      <Text style={[styles.value, { color: colors.textPrimary }]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={[styles.label, { color: colors.textSecondary }]} numberOfLines={1}>
        {label}
      </Text>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  card: {
    flex: 1,
    borderRadius: 12,
    padding: 14,
    gap: 4,
  },
  icon: {
    marginBottom: 4,
  },
  value: {
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  label: {
    fontSize: 12,
    fontWeight: '500',
  },
});
