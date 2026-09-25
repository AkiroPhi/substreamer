/**
 * Vectors mirrored verbatim from Navidrome's own
 * `db/migrations/id_canonical_test.go`. They are the only trustworthy check on the
 * transform: a wrong base62 alphabet round-trips against its own encoder and still
 * produces output of the right shape, so testing against ourselves proves nothing.
 */

import { md5 } from 'subsonic-api';

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

  // Round-1 review mutation-tested the suite: `bits <= 129` instead of `<= 128` passed
  // every published vector while producing thousands of wrong ids, because no vector sits
  // at 129. Simulating legacy 22-char ids puts ~14% of them there, so it is a large slice
  // of the affected population. Both values generated from the real Go.
  it('pins both sides of the 128-bit boundary', () => {
    expect(canonicalId('7N42dgm5tFLK9N8MT7fHC7')).toBe('7N42dgm5tFLK9N8MT7fHC7');
    expect(canonicalId('7N42dgm5tFLK9N8MT7fHC8')).toBe('4lNKf50OxNrXbwJuGRpSfD');
  });

  // Narrowing the hex check to lowercase-only also survived the whole suite. Go's
  // `hex.DecodeString` accepts both cases, so the port must too.
  it('accepts uppercase hex, like Go', () => {
    expect(canonicalId('E3B7FC2AE9447BBEC37A13BF916E3CF6')).toBe('6VHl3uR4kss6sUPKA8Cwnk');
    expect(canonicalId('F47AC10B-58CC-4372-A567-0E02B2C3D479')).toBe('7rke2SAWaicSeSYzkhww6R');
  });

  // Navidrome's own second invariant: the transform is the identity on every id its
  // `NewHash` mints. Its exemptions for participants/tags/folder ids rest on this.
  it('is the identity on every NewHash id', () => {
    const newHash = (...parts: string[]): string => {
      const joined = `${parts.join('\u200b')}\u200b`;
      // NewHash is encode(md5(parts joined by ZWSP, trailing ZWSP)) — id.go:35-41.
      return canonicalId(md5(joined));
    };
    for (const parts of [
      [''], ['a'], ['The Beatles'], ['genre', 'electronic'],
      ['/music/Artist/Album', '1'], ['x'.repeat(500)],
    ]) {
      const hashed = newHash(...parts);
      expect(hashed).toHaveLength(22);
      expect(canonicalId(hashed)).toBe(hashed);
    }
  });

  it('treats a MusicBrainz id like any other uuid — the caller must exclude it', () => {
    // Documents the hazard: this function cannot tell an MBID from a playlist id.
    const mbid = 'c8da2e40-bd28-4d4e-813a-bd2f51958ba8';
    expect(canonicalId(mbid)).not.toBe(mbid);
    expect(canonicalId(mbid)).toHaveLength(22);
  });
});
