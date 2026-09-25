/**
 * Whether the Navidrome id re-key still has to run, and how far it got.
 *
 * A STANDING check, not a one-shot tied to a release. Users upgrade their server on their
 * own schedule — someone deliberately holding Navidrome at 0.63 for a year still needs
 * this the day they upgrade — so the condition is evaluated on every launch and this
 * module stays in the app indefinitely. No transition tracking is needed: the condition
 * simply becomes true once their server crosses 0.64.0.
 *
 * Reads and writes go through `kvStorageSync`, because the gate is consulted on the boot
 * path and by the headless media service, neither of which can await a hydration.
 *
 * One install points at one server: editing the server URL reaches the same server at a
 * different address, and switching servers means logging out, which clears the marker
 * along with the data. So a single marker describes the situation exactly.
 */

import { kvStorageSync } from '../../store/persistence';
import { serverInfoStore } from '../../store/serverInfoStore';
import { serverNeedsReid } from './navidromeVersion';

const MARKER_KEY = 'substreamer-navidrome-reid';

/**
 * `pending` — nothing done, or a run was interrupted before the re-key committed.
 * `complete` — everything done; the pass never runs again for this install.
 *
 * Deliberately two states. An earlier design had a middle "files moved, stores not yet
 * rehydrated" state, but the app does not launch until the marker reads `complete`, so
 * that state could never be observed — and re-running the file move on resume is free,
 * because moving a file already at its destination is a no-op.
 */
export type ReidState = 'pending' | 'complete';

function read(): ReidState | null {
  try {
    const raw = kvStorageSync.getItem(MARKER_KEY);
    if (typeof raw !== 'string' || raw === '') return null;
    const parsed = JSON.parse(raw) as { state?: unknown };
    return parsed.state === 'pending' || parsed.state === 'complete' ? parsed.state : null;
  } catch {
    // An unreadable marker means "not done", which re-runs a pass that is idempotent.
    return null;
  }
}

/** Record progress. Called by the pass; nothing else should write this. */
export function setReidState(state: ReidState): void {
  try {
    kvStorageSync.setItem(MARKER_KEY, JSON.stringify({ state, at: Date.now() }));
  } catch {
    /* A failed write re-runs the pass next launch, which is safe. */
  }
}

/** Test-only: forget the marker. */
export function clearReidMarker(): void {
  try {
    kvStorageSync.removeItem(MARKER_KEY);
  } catch {
    /* nothing to do */
  }
}

/** Has the pass finished for this install? */
export function isReidComplete(): boolean {
  return read() === 'complete';
}

/**
 * Does the re-key still need to run?
 *
 * True when the server is a Navidrome at 0.64.0 or later — or a Navidrome whose version
 * we cannot parse, which fails OPEN deliberately — and the pass has not completed.
 *
 * Synchronous and cheap: one KV read plus a string compare. Safe to call on every launch
 * and from the headless path.
 */
export function isReidRequired(): boolean {
  if (isReidComplete()) return false;
  const { serverType, serverVersion } = serverInfoStore.getState();
  return serverNeedsReid(serverType, serverVersion);
}

/**
 * Must the app refuse to serve content right now?
 *
 * The interstitial holds the UI launch path, but it cannot hold a headless one: `index.js`
 * requires `playerBootstrap` before `expo-router/entry`, so a CarPlay, Android Auto, Siri
 * or lock-screen cold wake arms the media service without ever rendering `_layout` — and a
 * headless boot does not run the migration chain either. Serving retired ids to a car head
 * unit fails anyway; failing deliberately, before any write, is the difference between a
 * blank browse tree and a corrupted download set.
 */
export function shouldBlockContent(): boolean {
  return isReidRequired();
}
