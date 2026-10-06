import { memo, useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { CachedImage } from './CachedImage';
import { useTheme } from '../hooks/useTheme';
import {
  bookmarkCurrentTrack,
  bookmarkQueuePosition,
  bookmarkTimes,
  restoreBookmark,
} from '../services/bookmarkService';
import { type PlayQueueBookmark } from '../store/bookmarksStore';
import { formatCompactDuration } from '../utils/formatters';

const COVER_SIZE = 150;

export const BookmarkCard = memo(function BookmarkCard({
  bookmark,
  width,
}: {
  bookmark: PlayQueueBookmark;
  width?: number;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  // Whole-queue math walks the entire stored queue; compute once per bookmark.
  const { track, trackLine, remainingLine } = useMemo(() => {
    const pos = bookmarkQueuePosition(bookmark);
    const times = bookmarkTimes(bookmark);
    return {
      track: bookmarkCurrentTrack(bookmark),
      trackLine: t('bookmarkTrackOf', { index: pos.index, total: pos.total }),
      remainingLine: t('bookmarkRemaining', {
        remaining: formatCompactDuration(times.remainingSec),
      }),
    };
  }, [bookmark, t]);

  const onPress = useCallback(() => {
    void restoreBookmark(bookmark);
  }, [bookmark]);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => pressed && styles.pressed}
      accessibilityRole="button"
      accessibilityLabel={bookmark.name}
    >
      <View style={[styles.tile, { backgroundColor: colors.card }, width != null && { width }]}>
        <CachedImage
          coverArtId={track?.coverArt}
          albumId={track?.albumId}
          size={COVER_SIZE}
          style={styles.cover}
          resizeMode="cover"
        />
        <View style={styles.text}>
          <Text
            style={[styles.name, { color: colors.textPrimary }]}
            numberOfLines={1}
          >
            {bookmark.name}
          </Text>
          <Text
            style={[styles.meta, { color: colors.textSecondary }]}
            numberOfLines={1}
          >
            {trackLine}
          </Text>
          <Text
            style={[styles.meta, { color: colors.textSecondary }]}
            numberOfLines={1}
          >
            {remainingLine}
          </Text>
        </View>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  pressed: {
    opacity: 0.6,
  },
  tile: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    padding: 8,
  },
  cover: {
    width: 48,
    height: 48,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.1)',
  },
  text: {
    flex: 1,
    marginLeft: 10,
    marginRight: 4,
  },
  name: {
    fontSize: 14,
    fontWeight: '600',
  },
  meta: {
    fontSize: 12,
    marginTop: 2,
  },
});
