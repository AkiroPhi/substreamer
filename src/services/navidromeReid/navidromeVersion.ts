/**
 * Does this server need the Navidrome 0.64 id re-key?
 *
 * Navidrome's `consts.Version` (`reference/navidrome/consts/version.go:16-26`) is
 * `"<tag> (<sha>)"` with the leading `v` stripped, and can also be the literal `dev` or
 * `master (9ed35cb)` on an untagged build:
 *
 *     dev · 0.2.0 (5b84188) · 0.3.2-SNAPSHOT (715f552) · master (9ed35cb)
 *
 * The existing `compareVersions` in `serverCapabilityService` cannot read that — it does
 * `a.split('.').map(Number)`, so `"0.64.1 (5b84188)"` yields `NaN` on the last segment and
 * the comparison reports the server as OLDER than 0.64.0. That fails in the dangerous
 * direction: an affected user would never be detected. Hence a parser of our own rather
 * than reuse.
 */

/** The release that re-encoded existing ids. */
export const REID_MIN_VERSION = { major: 0, minor: 64, patch: 0 } as const;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /**
   * True for a `-SNAPSHOT` build. The version is then a LOWER BOUND, not the build's own
   * version: Navidrome's `GIT_TAG` is `$(git describe --tags --abbrev=0)-SNAPSHOT`
   * (`reference/navidrome/Makefile:12`), the most recent tag reachable from HEAD. So HEAD
   * is at or after that tag — which settles a snapshot at or above 0.64.0 and leaves one
   * below it genuinely unknown.
   */
  isSnapshot: boolean;
}

/** What to do about this server. */
export type ReidVerdict =
  /** Definitely affected: run without asking. */
  | 'run'
  /** Definitely unaffected, or not Navidrome at all. */
  | 'skip'
  /** Cannot be decided from the version string — ask the user. */
  | 'ask';

/**
 * Parse a Navidrome version string, or `null` when there is no `X.Y[.Z]` in it at all
 * (`dev`, `master (9ed35cb)`, an empty string).
 *
 * A `-SNAPSHOT` tail parses, but sets `isSnapshot` — see {@link ParsedVersion}.
 */
export function parseNavidromeVersion(raw: string | null | undefined): ParsedVersion | null {
  if (!raw) return null;
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?(-[0-9A-Za-z.-]+)?\s*(?:\(.*\))?$/.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    isSnapshot: match[4] !== undefined,
  };
}

/** `a` compared to `b`: negative, zero or positive. */
function compare(a: ParsedVersion, b: { major: number; minor: number; patch: number }): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** A build name that is not a release at all — someone tracking the bleeding edge. */
function isDevelopmentBuild(raw: string): boolean {
  const name = raw.trim().toLowerCase();
  return name === 'dev' || name.startsWith('master') || name.startsWith('develop');
}

/**
 * Should the re-key run against this server?
 *
 * - **`run`** — a release at 0.64.0 or later; a snapshot whose tag is already 0.64.0 or
 *   later, since the tag is a lower bound on HEAD; or an explicit `dev` / `master` /
 *   `develop` build, on the reasoning that nobody tracks a development branch without
 *   keeping it current.
 * - **`skip`** — not Navidrome, or a release below 0.64.0.
 * - **`ask`** — a snapshot whose tag is below 0.64.0, or a version string with no
 *   recognisable number in it. The build may sit either side of the migration and nothing
 *   in the string says which, so the interstitial asks the user, who knows whether they
 *   have updated.
 *
 * Guessing is not an option in the `ask` case. Running against a pre-0.64 server re-keys
 * downloads, history and bookmarks to ids it never issued, and nothing recovers that;
 * skipping leaves a 0.64+ user silently broken. Neither is acceptable to do blind.
 */
export function navidromeReidVerdict(
  serverType: string | null | undefined,
  serverVersion: string | null | undefined,
): ReidVerdict {
  if (serverType?.toLowerCase() !== 'navidrome') return 'skip';
  if (serverVersion && isDevelopmentBuild(serverVersion)) return 'run';

  const parsed = parseNavidromeVersion(serverVersion);
  if (parsed === null) return 'ask';
  if (compare(parsed, REID_MIN_VERSION) >= 0) return 'run';
  // Below 0.64.0: conclusive for a release, a lower bound for a snapshot.
  return parsed.isSnapshot ? 'ask' : 'skip';
}

/** Convenience for the callers that only care whether it runs unattended. */
export function serverNeedsReid(
  serverType: string | null | undefined,
  serverVersion: string | null | undefined,
): boolean {
  return navidromeReidVerdict(serverType, serverVersion) === 'run';
}
