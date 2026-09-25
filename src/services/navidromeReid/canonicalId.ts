/**
 * Navidrome 0.64.0's entity-id transform, ported exactly.
 *
 * Navidrome 0.64.0 ships a migration that re-encodes every id already in its database
 * into one uniform format, so any client holding cached ids is holding keys the server
 * no longer knows. The transform is a pure function of the id string, which is what lets
 * us repair our own copy locally instead of re-downloading the library.
 *
 * Source: `db/migrations/20260720015443_uniform_canonical_ids.go:21-47` (`canonicalID`)
 * and `model/id/id.go:18-20` (`Encode`). The vectors in `db/migrations/id_canonical_test.go`
 * are mirrored verbatim in the test suite — test against those, never against ourselves,
 * because a wrong alphabet round-trips against its own encoder and still fails them.
 *
 * Deliberately avoids `BigInt`: this is permanent migration code that must not depend on a
 * runtime feature we have no other use of, so the 128-bit arithmetic is done on byte arrays.
 */

import { md5 } from 'subsonic-api';

/**
 * Go's `big.Int.Text(62)` alphabet: digits, then LOWERCASE, then uppercase.
 *
 * The conventional `0-9A-Za-z` ordering is wrong and fails 3 of the 10 published vectors —
 * but it round-trips against itself, so an encoder/decoder pair built on it looks correct
 * in isolation.
 */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Canonical ids are always this wide; `Encode` left-pads with '0' (`%022s`). */
const ENCODED_LENGTH = 22;

/** Big-endian 16 bytes to the canonical 22-char base62 id. Mirrors `id.Encode`. */
function encode(bytes: readonly number[]): string {
  const digits: string[] = [];
  let work = [...bytes];
  while (work.some((b) => b !== 0)) {
    let remainder = 0;
    const quotient: number[] = [];
    for (const byte of work) {
      const current = remainder * 256 + byte;
      quotient.push(Math.floor(current / 62));
      remainder = current % 62;
    }
    digits.push(ALPHABET[remainder]);
    let lead = 0;
    while (lead < quotient.length - 1 && quotient[lead] === 0) lead++;
    work = quotient.slice(lead);
  }
  return digits.reverse().join('').padStart(ENCODED_LENGTH, '0');
}

/** Hex string to bytes, or null when it is not valid hex. */
function hexToBytes(hex: string): number[] | null {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    const byte = Number.parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(byte) || !/^[0-9a-fA-F]{2}$/.test(hex.slice(i, i + 2))) return null;
    out.push(byte);
  }
  return out;
}

/**
 * Bit length of a base62 string, or -1 when it contains a character outside the alphabet.
 * Stands in for Go's `SetString(s, 62)` + `BitLen()`: we only need to know whether the
 * value overflows 128 bits, not the value itself.
 */
function base62BitLength(value: string): number {
  let bytes = [0];
  for (const char of value) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) return -1;
    let carry = digit;
    for (let i = bytes.length - 1; i >= 0; i--) {
      const current = bytes[i] * 62 + carry;
      bytes[i] = current & 0xff;
      carry = current >>> 8;
    }
    while (carry > 0) {
      bytes.unshift(carry & 0xff);
      carry >>>= 8;
    }
  }
  let lead = 0;
  while (lead < bytes.length - 1 && bytes[lead] === 0) lead++;
  bytes = bytes.slice(lead);
  if (bytes.length === 1 && bytes[0] === 0) return 0;
  return (bytes.length - 1) * 8 + (32 - Math.clz32(bytes[0]));
}

/**
 * The canonical form of a Subsonic entity id, as Navidrome 0.64.0 computes it.
 *
 * SHAPE-DRIVEN, never entity-driven: it inspects the string and rewrites only the shapes
 * it recognises, so an id already in the target format — or one that is not an entity id
 * at all — passes through untouched. That is what makes the pass safe to run blind, and
 * what makes it idempotent.
 *
 * Callers must still use an allowlist of columns. A MusicBrainz id is a dashed UUID and
 * this function will happily rewrite one; only the caller knows it must not.
 */
export function canonicalId(value: string): string {
  switch (value.length) {
    case 22: {
      // A hash-family id already fits 128 bits and is kept. Only a random id that
      // overflows is remapped, and it is remapped through md5 of the id STRING.
      // `bits < 0` (a character outside the alphabet) is redundant by construction —
      // -1 <= 128 already returns — but it is kept to mirror Go's `!ok` branch explicitly.
      const bits = base62BitLength(value);
      if (bits < 0 || bits <= 128) return value;
      const digest = hexToBytes(md5(value));
      return digest === null ? value : encode(digest);
    }
    case 32: {
      const bytes = hexToBytes(value);
      return bytes === null ? value : encode(bytes);
    }
    case 36: {
      if (value[8] !== '-' || value[13] !== '-' || value[18] !== '-' || value[23] !== '-') {
        return value;
      }
      const bytes = hexToBytes(
        value.slice(0, 8) + value.slice(9, 13) + value.slice(14, 18)
        + value.slice(19, 23) + value.slice(24),
      );
      return bytes === null ? value : encode(bytes);
    }
    default:
      return value;
  }
}
