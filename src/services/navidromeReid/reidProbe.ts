/**
 * Ask the server what version it actually is, before the re-key decides.
 *
 * Split from `reidMarker` on purpose: that module is imported by
 * `db/repository/{songs,albums}` for the library-write guard, and the repository layer
 * must not depend on `subsonicService` or the Expo stack behind it. The state lives in
 * `reidMarker`; only the request lives here.
 */

import { connectivityStore } from '../../store/connectivityStore';
import { offlineModeStore } from '../../store/offlineModeStore';
import { getApi } from '../subsonicService';
import { currentServerInfo, isReidComplete, markProbeSettled, setProbedVersion } from './reidMarker';

/**
 * Cap on the probe. Comfortably under the splash's 15s backstop
 * (`AnimatedSplashScreen.tsx:39`) so a slow server delays launch rather than stranding it.
 */
const PROBE_TIMEOUT_MS = 4_000;

let probeInFlight: Promise<void> | null = null;
let probeDone = false;

/** Test-only: allow another probe. */
export function resetReidProbeInFlightForTests(): void {
  probeInFlight = null;
  probeDone = false;
}

/**
 * Ask the server what version it is, once per session.
 *
 * Deliberately `ping` alone rather than `fetchServerInfo`, which awaits ping, then
 * `getOpenSubsonicExtensions`, then `getUser` (`subsonicService.ts:938,954,971`). Timing
 * out the whole of that would discard a version that had already arrived at the first
 * call, and the library sync would then succeed over the very network the timeout implied
 * was broken. With ping alone, a timeout genuinely means the server is unreachable.
 */
/**
 * True when this device must not, or cannot, reach the server right now.
 *
 * `offlineMode` is read explicitly rather than inferred from `getApi()` returning null:
 * it is a deliberate user choice on a device that may be perfectly connected, and it is
 * the branch that actually fires on an offline launch. The connectivity flags default
 * optimistically to `true` and are only monitored while offline mode is OFF, so they
 * never catch this case on their own.
 */
export function cannotAskNow(): boolean {
  if (offlineModeStore.getState().offlineMode) return true;
  const conn = connectivityStore.getState();
  return !conn.hasConnection || !conn.isServerReachable;
}

export function probeServerVersion(): Promise<void> | null {
  if (probeInFlight) return probeInFlight;
  if (probeDone) return null;

  // Decided synchronously, and `null` means "nothing to wait for". Only the population
  // whose answer could change pays for a request, or for a deferred splash: a completed
  // pass is final, and a non-Navidrome server cannot become one without a logout. Every
  // other install proceeds in the same tick, exactly as before this existed.
  if (isReidComplete() || currentServerInfo().serverType?.toLowerCase() !== 'navidrome') {
    markProbeSettled();
    probeDone = true;
    return null;
  }

  // We must not, or cannot, ask right now. Return `null` so nothing waits — but do NOT
  // settle, and do not create `probeInFlight`.
  //
  // Settling here was a real hole. The verdict then fell back to the PERSISTED server
  // version for the rest of the session, `shouldBlockLibraryWrites()` went false, and a
  // later call returned early because `probeDone` was already true — so leaving offline
  // mode never re-asked. "Nothing can sync over a connection that is not there" was
  // wrong on both counts: in-app offline mode is a user choice on a connected device,
  // and the user can revoke it mid-session.
  //
  // Returning before the IIFE matters too: settling inside the `finally` instead would
  // leave `probeInFlight` pointing at a resolved promise, which the guard above hands
  // back forever — the same never-re-probes bug, with writes stuck off.
  if (cannotAskNow()) return null;

  let unaskable = false;
  probeInFlight = (async () => {
    try {
      const api = getApi();
      if (!api) { unaskable = true; return; }

      const response = await withTimeout(api.ping(), PROBE_TIMEOUT_MS);
      // `serverVersion` only exists on the OpenSubsonic variant of the response, so it is
      // narrowed the same way `fetchServerInfo` does (`subsonicService.ts:944-948`).
      if (response?.status === 'ok' && 'serverVersion' in response
          && typeof response.serverVersion === 'string') {
        setProbedVersion(response.serverVersion);
      }
    } catch {
      // Unreachable or malformed: the persisted version stands, and Layer 1 keeps
      // refusing library writes for as long as the verdict says a re-key is outstanding.
    } finally {
      // Settle only on a real outcome: the server answered, or was asked and failed or
      // timed out. A timeout still settles, so an unreachable server cannot block writes
      // forever. Never settle when we did not ask at all.
      if (!unaskable) {
        markProbeSettled();
        probeDone = true;
      }
      probeInFlight = null;
    }
  })();
  return probeInFlight;
}

/**
 * Resolve to `null` rather than hang.
 *
 * The timer is cleared on settle: `Promise.race` does not cancel the loser, so without it
 * every probe leaves a timer pending for the rest of the timeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}
