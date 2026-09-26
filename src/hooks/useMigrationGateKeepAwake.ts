import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect } from 'react';

import { migrationGateStore } from '../store/migrationGateStore';

const TAG = 'migration-gate';

/**
 * Hold the screen on while the one-shot data migration runs.
 *
 * Stronger grounds than the library sync has for the same treatment: this pass moves
 * downloaded files and rewrites ids, it cannot be resumed from the middle by anything
 * except a full re-run, and the device sleeping is the most likely way a user's run gets
 * suspended part way. Only `working` holds the screen — the `asking` prompt and the
 * completion screen are both waiting on a tap.
 */
export function useMigrationGateKeepAwake(): void {
  const running = migrationGateStore((s) => s.visible && s.mode === 'working' && !s.failed);

  useEffect(() => {
    if (running) {
      activateKeepAwakeAsync(TAG).catch(() => { /* activity may be unavailable */ });
    } else {
      deactivateKeepAwake(TAG).catch(() => { /* activity may be unavailable */ });
    }
    return () => {
      deactivateKeepAwake(TAG).catch(() => { /* unavailable during backgrounding */ });
    };
  }, [running]);
}
