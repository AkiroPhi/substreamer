import { parseNavidromeVersion, serverNeedsReid } from '../navidromeVersion';

describe('parseNavidromeVersion', () => {
  it.each([
    ['0.64.0 (1072e9f7)', { major: 0, minor: 64, patch: 0 }],
    ['0.64.1 (5b84188)', { major: 0, minor: 64, patch: 1 }],
    ['0.63.2', { major: 0, minor: 63, patch: 2 }],
    ['0.65.0', { major: 0, minor: 65, patch: 0 }],
    ['0.3.2-SNAPSHOT (715f552)', { major: 0, minor: 3, patch: 2 }],
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
    expect(serverNeedsReid('navidrome', '0.3.2-SNAPSHOT (715f552)')).toBe(false);
  });

  it('fails OPEN on an unparseable Navidrome version', () => {
    // A pass that finds nothing costs one no-op; a missed affected user is permanent.
    expect(serverNeedsReid('navidrome', 'dev')).toBe(true);
    expect(serverNeedsReid('navidrome', 'master (9ed35cb)')).toBe(true);
    expect(serverNeedsReid('navidrome', null)).toBe(true);
    expect(serverNeedsReid('navidrome', '')).toBe(true);
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
});
