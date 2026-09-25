import { remapJsonEnvelope } from '../jsonEnvelope';

const MAP: Record<string, string> = {
  oldsong: 'NEWSONG',
  oldalbum: 'NEWALBUM',
  oldartist: 'NEWARTIST',
};
const lookup = (id: string): string | undefined => MAP[id];
const remap = (raw: string | null | undefined): string | null | undefined =>
  remapJsonEnvelope(raw, lookup);
const round = (obj: unknown): unknown => JSON.parse(remap(JSON.stringify(obj)) as string);

describe('remapJsonEnvelope', () => {
  it('rewrites the allowlisted id keys', () => {
    expect(round({
      id: 'oldsong', parent: 'oldalbum', albumId: 'oldalbum', artistId: 'oldartist',
    })).toEqual({
      id: 'NEWSONG', parent: 'NEWALBUM', albumId: 'NEWALBUM', artistId: 'NEWARTIST',
    });
  });

  it('rewrites artwork tokens, hash and all', () => {
    expect(round({ coverArt: 'al-oldalbum_9f8e' })).toEqual({ coverArt: 'al-NEWALBUM_9f8e' });
    expect(round({ coverArtId: 'dc-oldalbum:2' })).toEqual({ coverArtId: 'dc-NEWALBUM:2' });
  });

  it('recurses into nested artist arrays', () => {
    expect(round({
      id: 'oldsong',
      artists: [{ id: 'oldartist', name: 'A' }],
      albumArtists: [{ id: 'oldartist', name: 'A' }],
      // The real wire shape: Contributor is { role, artist: ArtistID3 }, so the id is
      // reached by recursion rather than by an allowlisted key at this level.
      contributors: [{ role: 'composer', artist: { id: 'oldartist', name: 'A' } }],
    })).toEqual({
      id: 'NEWSONG',
      artists: [{ id: 'NEWARTIST', name: 'A' }],
      albumArtists: [{ id: 'NEWARTIST', name: 'A' }],
      contributors: [{ role: 'composer', artist: { id: 'NEWARTIST', name: 'A' } }],
    });
  });

  it('rewrites a coverArt nested inside an artist entry', () => {
    expect(round({ artists: [{ id: 'oldartist', coverArt: 'ar-oldartist_ff' }] }))
      .toEqual({ artists: [{ id: 'NEWARTIST', coverArt: 'ar-NEWARTIST_ff' }] });
  });

  it('NEVER rewrites a MusicBrainz id, even though it is a mappable shape', () => {
    // The headline hazard: an MBID is a dashed UUID and canonicalId would transform it.
    const mbid = 'oldsong';
    expect(round({ id: 'oldsong', musicBrainzId: mbid, mbid, musicBrainzTrackId: mbid }))
      .toEqual({ id: 'NEWSONG', musicBrainzId: mbid, mbid, musicBrainzTrackId: mbid });
  });

  it('never touches free text that happens to equal an id', () => {
    // Exactly what a string replace would corrupt.
    expect(round({ id: 'oldsong', title: 'oldsong', comment: 'see oldalbum', path: 'oldalbum' }))
      .toEqual({ id: 'NEWSONG', title: 'oldsong', comment: 'see oldalbum', path: 'oldalbum' });
  });

  it('leaves ids that are not in the map alone', () => {
    expect(round({ id: 'unmoved', albumId: 'unmoved' }))
      .toEqual({ id: 'unmoved', albumId: 'unmoved' });
  });

  it('returns the ORIGINAL string when nothing changed, so the caller can skip the write', () => {
    const raw = JSON.stringify({ id: 'unmoved', title: 'x' });
    expect(remap(raw)).toBe(raw);
  });

  it('survives a corrupt envelope rather than destroying it', () => {
    // A damaged row is a problem; losing it during a migration is a worse one.
    expect(remap('{not json')).toBe('{not json');
    expect(remap('null')).toBe('null');
    expect(remap('"a string"')).toBe('"a string"');
    expect(remap('42')).toBe('42');
  });

  it('passes empty input straight through', () => {
    expect(remap('')).toBe('');
    expect(remap(null)).toBeNull();
    expect(remap(undefined)).toBeUndefined();
  });

  it('handles a top-level array', () => {
    expect(round([{ id: 'oldsong' }, { id: 'oldalbum' }]))
      .toEqual([{ id: 'NEWSONG' }, { id: 'NEWALBUM' }]);
  });

  it('preserves non-string values on allowlisted keys', () => {
    // A numeric `id` is not ours to rewrite, and must not be stringified in passing.
    expect(round({ id: 42, albumId: null, artists: [] }))
      .toEqual({ id: 42, albumId: null, artists: [] });
  });
});
