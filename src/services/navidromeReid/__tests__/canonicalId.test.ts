/**
 * Vectors mirrored verbatim from Navidrome's own
 * `db/migrations/id_canonical_test.go`. They are the only trustworthy check on the
 * transform: a wrong base62 alphabet round-trips against its own encoder and still
 * produces output of the right shape, so testing against ourselves proves nothing.
 */

import { canonicalId } from '../canonicalId';

describe('canonicalId — Navidrome vectors', () => {
  it.each([
    ['hash-family id (fits 128 bits) is kept', '5cLJPkLA5DK2BADhoeotPk', '5cLJPkLA5DK2BADhoeotPk'],
    ['overflowing random id is remapped via md5', 'zzzzzzzzzzzzzzzzzzzzzz', '3LyqmwQBm5IRqlVjNYASwb'],
    ['legacy 32-hex is re-encoded value-preserving', 'e3b7fc2ae9447bbec37a13bf916e3cf6', '6VHl3uR4kss6sUPKA8Cwnk'],
    ['playlist uuid is re-encoded value-preserving', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', '7rke2SAWaicSeSYzkhww6R'],
    ['empty string passes through', '', ''],
    ['share id (10 chars) passes through', 'aB3xY9kQz1', 'aB3xY9kQz1'],
    ['truncated Finamp id (16 chars) passes through', '0123456789abcdef', '0123456789abcdef'],
    ['22 chars with non-base62 char passes through', '!!!!!!!!!!!!!!!!!!!!!!', '!!!!!!!!!!!!!!!!!!!!!!'],
    ['32 chars non-hex passes through', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'],
    ['36 chars without uuid dashes passes through', '000000000000000000000000000000000000', '000000000000000000000000000000000000'],
  ])('%s', (_name, input, expected) => {
    expect(canonicalId(input)).toBe(expected);
  });
});

describe('canonicalId — invariants', () => {
  it('is idempotent for every rewritten shape', () => {
    for (const value of [
      '5cLJPkLA5DK2BADhoeotPk',
      'zzzzzzzzzzzzzzzzzzzzzz',
      'e3b7fc2ae9447bbec37a13bf916e3cf6',
      'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    ]) {
      const once = canonicalId(value);
      expect(canonicalId(once)).toBe(once);
    }
  });

  it('always returns 22 chars when it rewrites', () => {
    for (const value of [
      'e3b7fc2ae9447bbec37a13bf916e3cf6',
      'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      'zzzzzzzzzzzzzzzzzzzzzz',
    ]) {
      expect(canonicalId(value)).toHaveLength(22);
    }
  });

  it('left-pads a small value to 22 chars rather than returning a short id', () => {
    // All-zero 32-hex encodes to 0, which must render as 22 zeros, not "0".
    expect(canonicalId('00000000000000000000000000000000')).toBe('0'.repeat(22));
    // 1 encodes to a single digit and must be padded the same way.
    expect(canonicalId('00000000000000000000000000000001')).toBe(`${'0'.repeat(21)}1`);
  });

  it('leaves lengths it does not recognise alone', () => {
    for (const value of ['a', 'ab', '0123456789', 'x'.repeat(21), 'x'.repeat(23), 'x'.repeat(64)]) {
      expect(canonicalId(value)).toBe(value);
    }
  });

  it('rejects a malformed uuid rather than rewriting it', () => {
    // Right length and dash positions, but non-hex content.
    expect(canonicalId('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz'))
      .toBe('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz');
  });

  it('uses the lowercase-first alphabet, not 0-9A-Za-z', () => {
    // The conventional ordering yields a different string for this vector; if this
    // assertion ever passes with '6VHL3Ur4KSS6Supka8cWNK'-style output the alphabet
    // has been swapped.
    expect(canonicalId('e3b7fc2ae9447bbec37a13bf916e3cf6')).toBe('6VHl3uR4kss6sUPKA8Cwnk');
  });

  it('treats a MusicBrainz id like any other uuid — the caller must exclude it', () => {
    // Documents the hazard: this function cannot tell an MBID from a playlist id.
    const mbid = 'c8da2e40-bd28-4d4e-813a-bd2f51958ba8';
    expect(canonicalId(mbid)).not.toBe(mbid);
    expect(canonicalId(mbid)).toHaveLength(22);
  });
});
