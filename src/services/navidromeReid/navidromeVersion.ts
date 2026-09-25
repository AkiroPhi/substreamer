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
}

/**
 * Parse a Navidrome version, or `null` when it cannot be decided.
 *
 * `null` covers more than "unrecognised". A **pre-release tail is undecidable**, because
 * Navidrome's `GIT_TAG` is `$(git describe --tags --abbrev=0)-SNAPSHOT`
 * (`reference/navidrome/Makefile:12`) — the most recent tag *reachable from HEAD*, not the
 * build's own version. So a develop build made after the migration merged but before the
 * next tag was cut reports the tag before it, and a shallow clone with no tags at all
 * falls back to `v0.0.0-SNAPSHOT` (`:12`) or, for a source archive, to the directory name
 * (`:15`). Reading `0.0.0-SNAPSHOT` as "0.0.0" would report a server that has definitely
 * migrated as one that has not. A snapshot is a commit *somewhere* after the named tag;
 * semver ordering cannot say whether that includes the migration, so we do not pretend.
 */
export function parseNavidromeVersion(raw: string | null | undefined): ParsedVersion | null {
  if (!raw) return null;
  // `X.Y[.Z]` followed by end-of-string or the " (sha)" suffix, and nothing else. A
  // pre-release tail fails this deliberately — see above.
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?\s*(?:\(.*\))?$/.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
  };
}

/** `a` compared to `b`: negative, zero or positive. */
function compare(a: ParsedVersion, b: ParsedVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Should the re-key run against this server?
 *
 * Only for a Navidrome whose version parses to 0.64.0 or later. **An undecidable version
 * fails CLOSED**, which reverses an earlier decision here — the reasoning behind it was
 * wrong, and wrong in the direction that destroys data.
 *
 * That reasoning was: a false positive is harmless because the transform is shape-gated.
 * It is not. Shape-gating makes the pass a no-op against a server that has *already*
 * migrated. The three shapes it rewrites are precisely the historical **pre-0.64** shapes
 * — Navidrome's own migration says so — so running it against a pre-0.64 server re-keys
 * the local downloads, history and bookmarks to ids that server has never issued. The
 * two errors are not symmetric:
 *
 * - Fail open on a pre-0.64 server: the offline library is silently destroyed, and there
 *   is nothing to recover from.
 * - Fail closed on a 0.64+ server: the user stays broken, can fix it today by signing out
 *   and back in, and is repaired automatically by a later build.
 *
 * The real answer is to stop inferring from the version string and read the server's own
 * id shapes instead — one request, correct for `dev`, `master`, every `-SNAPSHOT` and
 * every future tag. Until that exists, this is the safe default.
 */
export function serverNeedsReid(
  serverType: string | null | undefined,
  serverVersion: string | null | undefined,
): boolean {
  if (serverType?.toLowerCase() !== 'navidrome') return false;
  const parsed = parseNavidromeVersion(serverVersion);
  if (parsed === null) return false;
  return compare(parsed, REID_MIN_VERSION) >= 0;
}
