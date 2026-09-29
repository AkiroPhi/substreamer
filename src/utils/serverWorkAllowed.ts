/**
 * Whether background work that needs the server may run right now.
 *
 * Pure so both the workers and the banners can evaluate it — the queue silently
 * declining while a pill reports a count that cannot move is how "Refreshing covers
 * 0 / 11" sat on screen indefinitely. One rule, two readers.
 */
export function serverWorkAllowed(
  offlineMode: boolean,
  hasConnection: boolean,
  isServerReachable: boolean,
): boolean {
  if (offlineMode) return false;
  return hasConnection && isServerReachable;
}
