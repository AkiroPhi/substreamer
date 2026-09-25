import { remapArtworkToken } from '../artworkToken';

const MAP: Record<string, string> = {
  oldalbum: 'NEWALBUM',
  oldsong: 'NEWSONG',
  'f47ac10b-58cc-4372-a567-0e02b2c3d479': '7rke2SAWaicSeSYzkhww6R',
};
const lookup = (id: string): string | undefined => MAP[id];
const remap = (t: string | null | undefined): string | null | undefined =>
  remapArtworkToken(t, lookup);

describe('remapArtworkToken', () => {
  it('rewrites each prefix, preserving it', () => {
    expect(remap('al-oldalbum')).toBe('al-NEWALBUM');
    expect(remap('ar-oldalbum')).toBe('ar-NEWALBUM');
    expect(remap('mf-oldsong')).toBe('mf-NEWSONG');
    expect(remap('pl-oldalbum')).toBe('pl-NEWALBUM');
  });

  it('preserves the content hash', () => {
    // The hash is the image's content hash — still valid after a re-key, and it is the
    // cache-busting key, so dropping it would be a silent regression.
    expect(remap('al-oldalbum_9f8e7d6c')).toBe('al-NEWALBUM_9f8e7d6c');
    expect(remap('mf-oldsong_1122334455667788')).toBe('mf-NEWSONG_1122334455667788');
  });

  it('preserves the disc index, and both suffixes together', () => {
    expect(remap('dc-oldalbum:2')).toBe('dc-NEWALBUM:2');
    expect(remap('dc-oldalbum:12_9f8e')).toBe('dc-NEWALBUM:12_9f8e');
  });

  it('splits on the FIRST dash, so a legacy UUID id survives', () => {
    // The id itself contains dashes; splitting on the last one would mangle it.
    expect(remap('al-f47ac10b-58cc-4372-a567-0e02b2c3d479'))
      .toBe('al-7rke2SAWaicSeSYzkhww6R');
    expect(remap('al-f47ac10b-58cc-4372-a567-0e02b2c3d479_abcd'))
      .toBe('al-7rke2SAWaicSeSYzkhww6R_abcd');
  });

  it('leaves a token whose id is not in the map completely alone', () => {
    // An entity that did not move, or one from another server generation.
    expect(remap('al-untouched')).toBe('al-untouched');
    expect(remap('dc-untouched:3_ff00')).toBe('dc-untouched:3_ff00');
  });

  it('treats an unknown prefix as a bare id, not as a token', () => {
    // A bare legacy uuid in a cover-art column would otherwise split as prefix
    // `f47ac10b` + id `58cc-…` and never match, leaving it stale forever.
    expect(remap('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe('7rke2SAWaicSeSYzkhww6R');
    expect(remap('oldsong')).toBe('NEWSONG');
    expect(remap('zz-oldsong')).toBe('zz-oldsong');
  });

  it('passes through anything that is not a token', () => {
    expect(remap('')).toBe('');
    expect(remap(null)).toBeNull();
    expect(remap(undefined)).toBeUndefined();
    expect(remap('nodashhere')).toBe('nodashhere');
    expect(remap('al-')).toBe('al-');
    expect(remap('-oldalbum')).toBe('-oldalbum');
  });

  it('is idempotent once the map no longer contains the old id', () => {
    const once = remap('al-oldalbum_9f8e');
    expect(once).toBe('al-NEWALBUM_9f8e');
    // Re-running after the map is rebuilt from canonical data finds nothing.
    expect(remapArtworkToken(once, () => undefined)).toBe(once);
  });

  it('looks the id up globally, not per entity kind', () => {
    // A song's token commonly embeds an ALBUM id, so a per-table map would miss it.
    expect(remap('mf-oldalbum')).toBe('mf-NEWALBUM');
    expect(remap('dc-oldalbum:1')).toBe('dc-NEWALBUM:1');
  });
});
