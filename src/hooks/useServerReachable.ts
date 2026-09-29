import { connectivityStore } from '../store/connectivityStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { serverWorkAllowed } from '../utils/serverWorkAllowed';

export interface ServerReachability {
  /** Server-backed background work may run. */
  canReach: boolean;
  /**
   * The user chose offline mode, as opposed to the connection being down. A retry is
   * meaningless here — the fix is the offline toggle — so surfaces offer one only when
   * this is false.
   */
  offlineMode: boolean;
}

/** Reactive form of {@link serverWorkAllowed}, for banners and other chrome. */
export function useServerReachable(): ServerReachability {
  const offlineMode = offlineModeStore((s) => s.offlineMode);
  const hasConnection = connectivityStore((s) => s.hasConnection);
  const isServerReachable = connectivityStore((s) => s.isServerReachable);
  return {
    canReach: serverWorkAllowed(offlineMode, hasConnection, isServerReachable),
    offlineMode,
  };
}
