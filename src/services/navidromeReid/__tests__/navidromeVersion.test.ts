import { parseNavidromeVersion, serverNeedsReid } from '../navidromeVersion';

describe('parseNavidromeVersion', () => {
  it.each([
    ['0.64.0 (1072e9f7)', { major: 0, minor: 64, patch: 0 }],
    ['0.64.1 (5b84188)', { major: 0, minor: 64, patch: 1 }],
    ['0.63.2', { major: 0, minor: 63, patch: 2 }],
    ['0.65.0', { major: 0, minor: 65, patch: 0 }],
    ['v0.64.0 (abc1234)', { major: 0, minor: 64, patch: 0 }],
    ['0.64', { major: 0, minor: 64, patch: 0 }],
    ['1.0.0', { major: 1, minor: 0, patch: 0 }],
    ['  0.64.0 (deadbee)  ', { major: 0, minor: 64, patch: 0 }],
  ])('parses %s', (raw, expected) => {
    expect(parseNavidromeVersion(raw)).toEqual(expected);
  });

  it.each([['dev'], ['master (9ed35cb)'], [''], ['   '], ['nonsense'], [null], [undefined]])(
    'returns null for %s',
    (raw) => {
      expect(parseNavidromeVersion(raw as string | null | undefined)).toBeNull();
    },
  );

  // Navidrome's GIT_TAG is `git describe --tags --abbrev=0`-SNAPSHOT (Makefile:12), i.e.
  // the tag BEFORE this build, so a snapshot cannot be ordered against 0.64.0 at all.
  it.each([
    ['0.3.2-SNAPSHOT (715f552)'],
    ['0.63.0-SNAPSHOT (abc1234)'],
    ['0.0.0-SNAPSHOT (deadbee)'],
    ['navidrome-SNAPSHOT (source_archive)'],
    ['0.64.0-rc1'],
  ])('returns null for the undecidable snapshot %s', (raw) => {
    expect(parseNavidromeVersion(raw)).toBeNull();
  });
});

describe('serverNeedsReid', () => {
  it('is true from 0.64.0 onward', () => {
    expect(serverNeedsReid('navidrome', '0.64.0 (1072e9f7)')).toBe(true);
    expect(serverNeedsReid('navidrome', '0.64.1 (5b84188)')).toBe(true);
    expect(serverNeedsReid('navidrome', '0.65.0')).toBe(true);
    expect(serverNeedsReid('navidrome', '1.0.0')).toBe(true);
  });

  it('is false below 0.64.0', () => {
    expect(serverNeedsReid('navidrome', '0.63.2')).toBe(false);
    expect(serverNeedsReid('navidrome', '0.63.0 (abc1234)')).toBe(false);
  });

  it('fails CLOSED on an undecidable version', () => {
    // Running against a PRE-0.64 server re-keys local data to ids it never issued, and
    // nothing recovers that. A missed 0.64+ user stays broken but is repairable.
    for (const raw of [
      'dev',
      'master (9ed35cb)',
      '0.0.0-SNAPSHOT (deadbee)',
      '0.63.0-SNAPSHOT (abc1234)',
      'navidrome-SNAPSHOT (source_archive)',
      null,
      '',
    ]) {
      expect(serverNeedsReid('navidrome', raw)).toBe(false);
    }
  });

  it('ignores every other server type', () => {
    for (const type of ['gonic', 'airsonic', 'subsonic', 'ampache', '', null, undefined]) {
      expect(serverNeedsReid(type, '0.64.0')).toBe(false);
    }
  });

  it('matches the server type case-insensitively', () => {
    expect(serverNeedsReid('Navidrome', '0.64.0')).toBe(true);
    expect(serverNeedsReid('NAVIDROME', '0.64.0')).toBe(true);
  });

  it('would have been wrong under the existing compareVersions', () => {
    // `'0.64.1 (5b84188)'.split('.').map(Number)` yields NaN on the last segment, and
    // `NaN > 0` is false, so serverCapabilityService's comparator reports "older".
    const naive = '0.64.1 (5b84188)'.split('.').map(Number);
    expect(naive.some(Number.isNaN)).toBe(true);
    expect(serverNeedsReid('navidrome', '0.64.1 (5b84188)')).toBe(true);
  });

  it('rejects trailing junk rather than parsing a prefix out of it', () => {
    expect(serverNeedsReid('navidrome', '0.64.0-something-else')).toBe(false);
    expect(serverNeedsReid('navidrome', '0.64.0.1.2')).toBe(false);
  });
});
