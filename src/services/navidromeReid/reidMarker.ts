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
import { navidromeReidVerdict, type ReidVerdict } from './navidromeVersion';

const MARKER_KEY = 'substreamer-navidrome-reid';
/** Where `serverInfoStore` persists. Read directly when the store has not hydrated. */
const SERVER_INFO_KEY = 'substreamer-server-info';
/** Set when the user answers the `ask` prompt: they told us their server is updated. */
const OVERRIDE_KEY = 'substreamer-navidrome-reid-confirmed';

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

/**
 * Record that the user confirmed their server has been updated.
 *
 * The version string could not settle it, so their answer is the only evidence there is.
 * Persisted, so a kill between the answer and the pass finishing does not lose it.
 */
export function setUserConfirmedReid(): void {
  try {
    kvStorageSync.setItem(OVERRIDE_KEY, '1');
  } catch {
    /* the prompt simply reappears next launch */
  }
}

function userConfirmed(): boolean {
  try {
    return kvStorageSync.getItem(OVERRIDE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Test-only: forget the marker. */
export function clearReidMarker(): void {
  try {
    kvStorageSync.removeItem(MARKER_KEY);
    kvStorageSync.removeItem(OVERRIDE_KEY);
  } catch {
    /* nothing to do */
  }
}

/** Has the pass finished for this install? */
export function isReidComplete(): boolean {
  return read() === 'complete';
}

/**
 * The server's type and version, without waiting for a hydration.
 *
 * `serverInfoStore` persists through the ASYNC `kvStorage`, so on a headless cold wake —
 * exactly the path {@link shouldBlockContent} exists for — its in-memory state is still
 * the initial `serverType: null` when this is called. Reading the store alone therefore
 * answers "not Navidrome" for an affected server and the content block never engages,
 * which is the one direction that must not fail. So fall back to the persisted blob,
 * which `kvStorageSync` can read on the spot.
 */
function serverInfo(): { serverType: string | null; serverVersion: string | null } {
  const live = serverInfoStore.getState();
  if (live.serverType !== null) return live;
  try {
    const raw = kvStorageSync.getItem(SERVER_INFO_KEY);
    if (typeof raw !== 'string' || raw === '') return live;
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
    const { serverType, serverVersion } = parsed.state ?? {};
    return {
      serverType: typeof serverType === 'string' ? serverType : null,
      serverVersion: typeof serverVersion === 'string' ? serverVersion : null,
    };
  } catch {
    // Unreadable: keep the store's answer rather than inventing one.
    return live;
  }
}

/**
 * What should happen about the re-key on this launch?
 *
 * `run` unattended, `skip` entirely, or `ask` the user because the server's version string
 * cannot settle it (see `navidromeReidVerdict`). Always `skip` once the pass has completed.
 *
 * Synchronous and cheap — one KV read plus a string compare — so it is safe on every
 * launch and on the headless path.
 */
export function reidVerdict(): ReidVerdict {
  if (isReidComplete()) return 'skip';
  const { serverType, serverVersion } = serverInfo();
  const verdict = navidromeReidVerdict(serverType, serverVersion);
  // The user has already answered the prompt; do not ask again.
  return verdict === 'ask' && userConfirmed() ? 'run' : verdict;
}

/** Will the pass run without asking? */
export function isReidRequired(): boolean {
  return reidVerdict() === 'run';
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
  // `ask` blocks too. An undecided server is one we may be about to re-key, and serving
  // a car head unit ids we are unsure about is the case this exists to prevent.
  return reidVerdict() !== 'skip';
}
