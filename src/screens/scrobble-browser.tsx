import { HeaderHeightContext } from "expo-router/react-navigation";
import Ionicons from '@react-native-vector-icons/ionicons/static';
import { FlashList } from '@shopify/flash-list';
import { memo, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { EmptyState as EmptyStateComponent } from '../components/EmptyState';
import { GradientBackground } from '../components/GradientBackground';
import { BottomChrome } from '../components/BottomChrome';
import { SegmentControl } from '../components/SegmentControl';
import { useKeysetList } from '../hooks/useKeysetList';
import { useTheme } from '../hooks/useTheme';
import { type CompletedScrobble } from '../store/completedScrobbleStore';
import { pendingScrobbleStore, type PendingScrobble } from '../store/pendingScrobbleStore';
import { loadScrobblePage } from '../store/persistence/scrobbleAggregates';
import { settingsStyles } from '../styles/settingsStyles';
import { timeAgo } from '../utils/stringHelpers';

import type { Cursor } from '../db/repository/core';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type Scrobble = PendingScrobble | CompletedScrobble;

type ScrobbleSegment = 'completed' | 'pending';

const SEGMENT_KEYS = [
  { key: 'completed', labelKey: 'completed' },
  { key: 'pending', labelKey: 'pending' },
] as const;

const ROW_HEIGHT = 56;
const PAGE_SIZE = 100;
const FILTER_DEBOUNCE_MS = 250;

/* ------------------------------------------------------------------ */
/*  ScrobbleRow                                                        */
/* ------------------------------------------------------------------ */

const ScrobbleRow = memo(function ScrobbleRow({
  scrobble,
  colors,
}: {
  scrobble: Scrobble;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const { t } = useTranslation();
  return (
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
      <View style={styles.rowLeft}>
        <Text style={[styles.trackTitle, { color: colors.textPrimary }]} numberOfLines={1}>
          {scrobble.song.title}
        </Text>
        {scrobble.song.artist ? (
          <Text style={[styles.artistName, { color: colors.textSecondary }]} numberOfLines={1}>
            {scrobble.song.artist}
          </Text>
        ) : null}
      </View>
      <Text style={[styles.timeLabel, { color: colors.textSecondary }]}>
        {timeAgo(scrobble.time, t)}
      </Text>
    </View>
  );
});

/* ------------------------------------------------------------------ */
/*  Empty State                                                        */
/* ------------------------------------------------------------------ */

function ScrobbleEmptyState({ segment, filtered = false }: { segment: ScrobbleSegment; filtered?: boolean }) {
  const { t } = useTranslation();
  if (filtered) {
    return <EmptyStateComponent icon="search-outline" title={t('noScrobblesMatchFilter')} />;
  }
  const icon = segment === 'completed' ? 'checkmark-done-outline' : 'time-outline';
  const message =
    segment === 'completed' ? t('noCompletedScrobblesYet') : t('noPendingScrobbles');
  const subtitle =
    segment === 'completed'
      ? t('scrobblesAppearAfterPlaying')
      : t('pendingScrobblesSentAutomatically');

  return <EmptyStateComponent icon={icon} title={message} subtitle={subtitle} />;
}

/* ------------------------------------------------------------------ */
/*  ScrobbleBrowserScreen                                              */
/* ------------------------------------------------------------------ */

export function ScrobbleBrowserScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const [activeSegment, setActiveSegment] = useState<ScrobbleSegment>('completed');

  const segments = useMemo(
    () => SEGMENT_KEYS.map((s) => ({ key: s.key, label: t(s.labelKey) })),
    [t],
  );

  const pendingScrobbles = pendingScrobbleStore((s) => s.pendingScrobbles);

  // The full completed history, paged from SQL newest first. A snapshot: it is read
  // when the screen opens or the filter changes, not as new scrobbles land.
  const [filterText, setFilterText] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQuery(filterText.trim()), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filterText]);

  const loadPage = useCallback(
    (cursor: Cursor | null) => loadScrobblePage({ cursor, limit: PAGE_SIZE, query }),
    [query],
  );
  const {
    rows: completedRows,
    initialLoading: completedLoading,
    loadMore: loadMoreCompleted,
  } = useKeysetList<CompletedScrobble>(loadPage);

  const pendingReversed = useMemo(
    () => [...pendingScrobbles].reverse(),
    [pendingScrobbles],
  );

  // `item.id` is a unique per-event id (`${time}-${random}`) for both pending
  // and completed scrobbles, so it needs no index suffix — and an index-free
  // key lets FlashList recycle rows when a new scrobble is prepended.
  const keyExtractor = useCallback((item: Scrobble) => item.id, []);

  const renderItem = useCallback(
    ({ item }: { item: Scrobble }) => <ScrobbleRow scrobble={item} colors={colors} />,
    [colors],
  );

  const completedEmpty = useCallback(
    () =>
      completedLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <ScrobbleEmptyState segment="completed" filtered={query !== ''} />
      ),
    [completedLoading, query, colors.primary],
  );

  const pendingEmpty = useCallback(
    () => <ScrobbleEmptyState segment="pending" />,
    [],
  );

  const [chromeHeight, setChromeHeight] = useState(0);
  const contentInsetTop = headerHeight + chromeHeight;

  const completedContentContainerStyle = useMemo(
    () => ({
      paddingTop: contentInsetTop,
      ...(completedRows.length === 0 ? { flexGrow: 1 } : undefined),
    }),
    [contentInsetTop, completedRows.length],
  );
  const pendingContentContainerStyle = useMemo(
    () => ({
      paddingTop: contentInsetTop,
      ...(pendingReversed.length === 0 ? { flexGrow: 1 } : undefined),
    }),
    [contentInsetTop, pendingReversed.length],
  );

  return (
    <GradientBackground style={styles.container} scrollable>
      <View style={styles.content}>
        {activeSegment === 'completed' && (
          <FlashList
            data={completedRows}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            ListEmptyComponent={completedEmpty}
            contentContainerStyle={completedContentContainerStyle}
            onEndReached={loadMoreCompleted}
            maintainVisibleContentPosition={{ disabled: true }}
          />
        )}
        {activeSegment === 'pending' && (
          <FlashList
            data={pendingReversed}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            ListEmptyComponent={pendingEmpty}
            contentContainerStyle={pendingContentContainerStyle}
          />
        )}
      </View>
      <View
        style={[styles.segmentOverlay, { top: headerHeight }]}
        onLayout={(e) => setChromeHeight(e.nativeEvent.layout.height)}
      >
        <SegmentControl segments={segments} selected={activeSegment} onSelect={setActiveSegment} />
        {activeSegment === 'completed' && (
          <View style={styles.filterWrap}>
            <View style={[settingsStyles.filterPill, { backgroundColor: colors.inputBg }]}>
              <Ionicons name="search" size={18} color={colors.textSecondary} style={settingsStyles.filterIcon} />
              <TextInput
                style={[settingsStyles.filterInput, { color: colors.textPrimary }]}
                placeholder={t('filterPlaceholder')}
                placeholderTextColor={colors.textSecondary}
                value={filterText}
                onChangeText={setFilterText}
                autoCapitalize="none"
                autoCorrect={false}
                clearButtonMode="while-editing"
              />
            </View>
          </View>
        )}
      </View>
      <BottomChrome withSafeAreaPadding />
    </GradientBackground>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
  segmentOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 1,
  },
  filterWrap: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    minHeight: ROW_HEIGHT,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLeft: {
    flex: 1,
    marginRight: 12,
  },
  trackTitle: {
    fontSize: 14,
    fontWeight: '500',
  },
  artistName: {
    fontSize: 12,
    marginTop: 2,
  },
  timeLabel: {
    fontSize: 12,
    flexShrink: 0,
  },
});
