import * as Notifications from 'expo-notifications';
import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';

import { migrationGateStore } from '../store/migrationGateStore';

const CHANNEL_ID = 'data-migration';
let channelEnsured = false;

function ensureChannel(): void {
  if (channelEnsured) return;
  channelEnsured = true;
  if (Platform.OS === 'android') {
    Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Data migration',
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: null,
    }).catch(() => { /* non-critical if the channel already exists */ });
  }
}

/**
 * Tell the user to come back when they background the app mid-migration.
 *
 * The pass runs in the foreground behind a blocking screen, so backgrounding suspends it
 * — on iOS reliably. It resumes only when the app is reopened, and until it finishes the
 * library will not sync, so a user who wanders off has a quietly stuck app. DEFAULT
 * importance rather than the sync's LOW: this one is asking them to act.
 */
export function useMigrationGateBackgroundNotification(): void {
  const { t } = useTranslation();
  const notificationId = useRef<string | null>(null);

  useEffect(() => {
    ensureChannel();
    const sub = AppState.addEventListener('change', async (next) => {
      const gate = migrationGateStore.getState();
      const running = gate.visible && gate.mode === 'working' && !gate.failed;

      if (next === 'background' && running) {
        const { granted } = await Notifications.requestPermissionsAsync();
        if (!granted) return;
        notificationId.current = await Notifications.scheduleNotificationAsync({
          content: {
            title: t('migrationPausedTitle'),
            body: t('migrationPausedBody'),
            ...(Platform.OS === 'android' && { channelId: CHANNEL_ID }),
          },
          trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 1 },
        });
      } else if (next === 'active' && notificationId.current) {
        await Notifications.dismissNotificationAsync(notificationId.current);
        notificationId.current = null;
      }
    });
    return () => sub.remove();
  }, [t]);
}
