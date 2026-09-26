/**
 * Ask the server what version it actually is, before the re-key decides.
 *
 * Split from `reidMarker` on purpose: that module is imported by
 * `db/repository/{songs,albums}` for the library-write guard, and the repository layer
 * must not depend on `subsonicService` or the Expo stack behind it. The state lives in
 * `reidMarker`; only the request lives here.
 */

import { connectivityStore } from '../../store/connectivityStore';
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

  // Known-unreachable: do not hold the splash for a request that cannot arrive. `getApi`
  // is null only in OFFLINE MODE, not merely off-network, so without this an off-LAN
  // launch waits out the whole timeout on every start. Settling here is safe for the
  // same reason a timeout is — nothing can sync over a connection that is not there.
  const conn = connectivityStore.getState();
  if (!conn.hasConnection || !conn.isServerReachable) {
    markProbeSettled();
    probeDone = true;
    return null;
  }

  probeInFlight = (async () => {
    try {
      // Null in offline mode, where there is no sync to protect against anyway.
      const api = getApi();
      if (!api) return;

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
      // Settled either way. An unreachable server must not block writes forever — and it
      // cannot serve a sync either, so there is nothing to protect against.
      markProbeSettled();
      probeDone = true;
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
