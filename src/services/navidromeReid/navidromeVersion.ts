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
 * Parse the leading `X.Y.Z` out of a Navidrome version string, or `null` when there
 * isn't one — `dev`, `master (sha)`, an empty string, or anything else unrecognised.
 *
 * Tolerates a missing patch (`0.64`), a pre-release tail (`0.3.2-SNAPSHOT`) and the
 * ` (sha)` suffix. A leading `v` is stripped, although Navidrome removes it already.
 */
export function parseNavidromeVersion(raw: string | null | undefined): ParsedVersion | null {
  if (!raw) return null;
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw.trim());
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
 * True for Navidrome at 0.64.0 or later, **and for a Navidrome whose version we cannot
 * parse**. An unparseable version means an untagged build (`dev`, `master`), which is as
 * likely to carry the migration as not — and the two errors are not equal. A false
 * positive costs one pass that finds nothing to do, because the transform is shape-gated;
 * a false negative leaves the user permanently broken with no way to notice.
 *
 * `serverType` comes from `serverInfoStore`; anything that is not Navidrome is untouched.
 */
export function serverNeedsReid(
  serverType: string | null | undefined,
  serverVersion: string | null | undefined,
): boolean {
  if (serverType?.toLowerCase() !== 'navidrome') return false;
  const parsed = parseNavidromeVersion(serverVersion);
  if (parsed === null) return true;
  return compare(parsed, REID_MIN_VERSION) >= 0;
}
