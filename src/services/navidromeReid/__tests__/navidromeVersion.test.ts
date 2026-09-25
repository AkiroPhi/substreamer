import { navidromeReidVerdict, parseNavidromeVersion, serverNeedsReid } from '../navidromeVersion';

describe('parseNavidromeVersion', () => {
  it.each([
    ['0.64.0 (1072e9f7)', { major: 0, minor: 64, patch: 0, isSnapshot: false }],
    ['0.64.1 (5b84188)', { major: 0, minor: 64, patch: 1, isSnapshot: false }],
    ['0.63.2', { major: 0, minor: 63, patch: 2, isSnapshot: false }],
    ['0.65.0', { major: 0, minor: 65, patch: 0, isSnapshot: false }],
    ['v0.64.0 (abc1234)', { major: 0, minor: 64, patch: 0, isSnapshot: false }],
    ['0.64', { major: 0, minor: 64, patch: 0, isSnapshot: false }],
    ['1.0.0', { major: 1, minor: 0, patch: 0, isSnapshot: false }],
    ['  0.64.0 (deadbee)  ', { major: 0, minor: 64, patch: 0, isSnapshot: false }],
  ])('parses %s', (raw, expected) => {
    expect(parseNavidromeVersion(raw)).toEqual(expected);
  });

  it.each([['dev'], ['master (9ed35cb)'], [''], ['   '], ['nonsense'], [null], [undefined]])(
    'returns null for %s',
    (raw) => {
      expect(parseNavidromeVersion(raw as string | null | undefined)).toBeNull();
    },
  );

  // Navidrome's GIT_TAG is `git describe --tags --abbrev=0`-SNAPSHOT (Makefile:12), so the
  // number is the tag BEFORE this build — a lower bound on HEAD, not its own version.
  it.each([
    ['0.3.2-SNAPSHOT (715f552)', { major: 0, minor: 3, patch: 2, isSnapshot: true }],
    ['0.63.0-SNAPSHOT (abc1234)', { major: 0, minor: 63, patch: 0, isSnapshot: true }],
    ['0.0.0-SNAPSHOT (deadbee)', { major: 0, minor: 0, patch: 0, isSnapshot: true }],
    ['0.64.0-SNAPSHOT (feedbee)', { major: 0, minor: 64, patch: 0, isSnapshot: true }],
    ['0.64.0-rc1', { major: 0, minor: 64, patch: 0, isSnapshot: true }],
  ])('flags %s as a snapshot', (raw, expected) => {
    expect(parseNavidromeVersion(raw)).toEqual(expected);
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

  it('runs on a development build', () => {
    // Nobody tracks dev or master without keeping it current.
    for (const raw of ['dev', 'master (9ed35cb)', 'develop', 'DEV']) {
      expect(navidromeReidVerdict('navidrome', raw)).toBe('run');
    }
  });

  it('runs on a snapshot whose tag is already 0.64.0 or later', () => {
    // The tag is a lower bound on HEAD, so this build is at or past 0.64.0.
    expect(navidromeReidVerdict('navidrome', '0.64.0-SNAPSHOT (feedbee)')).toBe('run');
    expect(navidromeReidVerdict('navidrome', '0.65.0-SNAPSHOT (abc1234)')).toBe('run');
  });

  it('asks when a snapshot could sit either side of the migration', () => {
    for (const raw of ['0.63.0-SNAPSHOT (abc1234)', '0.0.0-SNAPSHOT (deadbee)', '0.3.2-SNAPSHOT (7f5)']) {
      expect(navidromeReidVerdict('navidrome', raw)).toBe('ask');
    }
  });

  it('asks when there is no version number at all', () => {
    for (const raw of ['navidrome-SNAPSHOT (source_archive)', 'nonsense', null, '']) {
      expect(navidromeReidVerdict('navidrome', raw)).toBe('ask');
    }
  });

  it('skips a release below 0.64.0 outright', () => {
    expect(navidromeReidVerdict('navidrome', '0.63.2')).toBe('skip');
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

  it('does not parse a prefix out of trailing junk', () => {
    // `0.64.0.1.2` has no recognisable shape; ask rather than guess.
    expect(navidromeReidVerdict('navidrome', '0.64.0.1.2')).toBe('ask');
  });
});
