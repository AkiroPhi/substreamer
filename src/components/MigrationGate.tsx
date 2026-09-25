/**
 * Blocking screen shown between the splash and the app while a slow, one-time data
 * migration runs.
 *
 * Exists for two reasons. A splash that sits for two minutes reads as a hung app, and the
 * work here can take that long on a large library — so it says what is happening and shows
 * progress through the parts that are countable. And because the app has not launched
 * behind it, holding it here is what keeps the migration from racing the startup effects,
 * which is otherwise a check scattered across the codebase.
 *
 * Not dismissible: the app genuinely is not ready.
 */

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../hooks/useTheme';
import { migrationGateStore, type MigrationStageId } from '../store/migrationGateStore';

/** Stage order, and the i18n key for each label. */
const STAGE_LABELS: ReadonlyArray<{ id: MigrationStageId; key: string }> = [
  { id: 'preparing', key: 'migrationStagePreparing' },
  { id: 'updatingDownloads', key: 'migrationStageUpdatingDownloads' },
  { id: 'movingFiles', key: 'migrationStageMovingFiles' },
  { id: 'refreshingArtwork', key: 'migrationStageRefreshingArtwork' },
  { id: 'finishing', key: 'migrationStageFinishing' },
];

function MigrationGateInner(): React.ReactElement | null {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const visible = migrationGateStore((s) => s.visible);
  const activeStage = migrationGateStore((s) => s.activeStage);
  const stages = migrationGateStore((s) => s.stages);
  const failed = migrationGateStore((s) => s.failed);

  if (!visible) return null;

  const activeIndex = STAGE_LABELS.findIndex((s) => s.id === activeStage);

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: colors.background,
          paddingTop: insets.top + 24,
          paddingBottom: insets.bottom + 24,
        },
      ]}
    >
      <View style={styles.content}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>
          {t('migrationGateTitle')}
        </Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          {t('migrationGateBody')}
        </Text>

        <View style={styles.stages}>
          {STAGE_LABELS.map((stage, index) => {
            const state = stages[stage.id];
            const isActive = stage.id === activeStage;
            const isDone = activeIndex >= 0 && index < activeIndex;
            const showCount = isActive && state?.total !== undefined && state.total > 0;
            return (
              <View key={stage.id} style={styles.stageRow}>
                <View style={styles.stageIcon}>
                  {isActive && !failed ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <Text
                      style={[
                        styles.stageBullet,
                        { color: isDone ? colors.primary : colors.textSecondary },
                      ]}
                    >
                      {isDone ? '✓' : '·'}
                    </Text>
                  )}
                </View>
                <Text
                  style={[
                    styles.stageLabel,
                    { color: isActive || isDone ? colors.textPrimary : colors.textSecondary },
                  ]}
                >
                  {t(stage.key)}
                  {showCount ? `  ${state?.done ?? 0} / ${state?.total ?? 0}` : ''}
                </Text>
              </View>
            );
          })}
        </View>

        {failed && (
          <Text style={[styles.error, { color: colors.red }]}>
            {t('migrationGateFailed')}
          </Text>
        )}

        <Text style={[styles.footnote, { color: colors.textSecondary }]}>
          {t('migrationGateFootnote')}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    paddingHorizontal: 28,
    zIndex: 100,
  },
  content: { gap: 20 },
  title: { fontSize: 22, fontWeight: '700' },
  body: { fontSize: 15, lineHeight: 21 },
  stages: { gap: 12, marginTop: 4 },
  stageRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stageIcon: { width: 20, alignItems: 'center' },
  stageBullet: { fontSize: 15, fontWeight: '600' },
  stageLabel: { fontSize: 15, flexShrink: 1 },
  error: { fontSize: 14, lineHeight: 20 },
  footnote: { fontSize: 13, lineHeight: 18, marginTop: 4 },
});

export const MigrationGate = memo(MigrationGateInner);
