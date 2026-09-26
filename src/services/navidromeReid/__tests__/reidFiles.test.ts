/**
 * The file move is the one step of the pass that cannot be rolled back, so these tests run
 * it against a virtual mockFilesystem — a set of paths that `move`, `create` and `delete`
 * actually mutate — rather than against existence flags. A test that only asserts call
 * counts would pass while moving mockFiles to the wrong place.
 */

/** Every file that "exists", as `<album>/<song>.<suffix>`. */
let mockFiles = new Set<string>();
/** Every directory that "exists", as `<album>`. */
let mockDirs = new Set<string>();
/** Paths whose `move` should throw, to exercise the per-file failure path. */
let mockFailMoves = new Set<string>();

const MOCK_ROOT = 'file:///doc/music-cache';
/** `file:///doc/music-cache/<rel>` -> `<rel>`; null for anything outside the root. */
const mockRel = (uri: string): string | null =>
  (uri.startsWith(`${MOCK_ROOT}/`) ? uri.slice(MOCK_ROOT.length + 1) : null);

jest.mock('expo-file-system', () => {
  const join = (...args: any[]): string =>
    args.map((a) => (typeof a === 'string' ? a : a.uri)).join('/');
  class MockDirectory {
    uri: string;
    constructor(...args: any[]) { this.uri = join(...args); }
    get exists() { const r = mockRel(this.uri); return r === null ? true : mockDirs.has(r); }
    create() { const r = mockRel(this.uri); if (r !== null) mockDirs.add(r); }
  }
  class MockFile {
    uri: string;
    constructor(...args: any[]) { this.uri = join(...args); }
    get exists() { const r = mockRel(this.uri); return r !== null && mockFiles.has(r); }
    async move(dest: any) {
      const from = mockRel(this.uri);
      const to = mockRel(dest.uri);
      if (from === null || to === null) throw new Error('outside root');
      if (mockFailMoves.has(from)) throw new Error('move failed');
      mockFiles.delete(from);
      mockFiles.add(to);
    }
  }
  return { Directory: MockDirectory, File: MockFile, Paths: { document: 'file:///doc' } };
});

jest.mock('expo-async-fs', () => ({
  listDirectoryAsync: (uri: string) => {
    const r = mockRel(uri);
    return Promise.resolve([...mockFiles].filter((f) => f.startsWith(`${r}/`)));
  },
  deleteDirectoryAsync: (uri: string) => {
    const r = mockRel(uri);
    if (r !== null) mockDirs.delete(r);
    return Promise.resolve(true);
  },
}));

jest.mock('../../musicCacheService', () => ({
  CACHE_DIR_NAME: 'music-cache',
  UNKNOWN_ALBUM_ID: '_unknown',
}));

let mockIdMap = new Map<string, string>();
jest.mock('../reidMap', () => ({ loadIdMap: () => Promise.resolve(mockIdMap) }));

import { moveDownloadedFiles } from '../reidFiles';

interface Row { song_id: string; album_id: string; suffix: string }

/** A db stub serving `cached_songs` rows, paged exactly as the mover asks for them. */
const dbWith = (rows: Row[]): any => ({
  getFirstAsync: () => Promise.resolve({ n: rows.length }),
  getAllAsync: (_sql: string, [after, limit]: [string, number]) =>
    Promise.resolve(
      [...rows].sort((a, b) => a.song_id.localeCompare(b.song_id))
        .filter((r) => r.song_id > after).slice(0, limit),
    ),
});

beforeEach(() => {
  mockFiles = new Set();
  mockDirs = new Set();
  mockFailMoves = new Set();
  mockIdMap = new Map();
});

describe('moveDownloadedFiles', () => {
  it('does nothing when no ids moved', async () => {
    mockDirs.add('albumA');
    mockFiles.add('albumA/song1.mp3');
    const result = await moveDownloadedFiles(
      dbWith([{ song_id: 'song1', album_id: 'albumA', suffix: 'mp3' }]),
    );
    expect(result).toEqual({ moved: 0, missing: 0, failed: 0 });
    expect(mockFiles.has('albumA/song1.mp3')).toBe(true);
  });

  it('renames the file when only the song id moved', async () => {
    mockIdMap.set('oldSong', 'newSong');
    mockDirs.add('albumA');
    mockFiles.add('albumA/oldSong.mp3');

    const result = await moveDownloadedFiles(
      dbWith([{ song_id: 'newSong', album_id: 'albumA', suffix: 'mp3' }]),
    );

    expect(result.moved).toBe(1);
    expect([...mockFiles]).toEqual(['albumA/newSong.mp3']);
    // The album directory did not move, so it must survive.
    expect(mockDirs.has('albumA')).toBe(true);
  });

  it('moves the file and removes the emptied directory when the album id moved', async () => {
    mockIdMap.set('oldAlbum', 'newAlbum');
    mockIdMap.set('oldSong', 'newSong');
    mockDirs.add('oldAlbum');
    mockFiles.add('oldAlbum/oldSong.mp3');

    const result = await moveDownloadedFiles(
      dbWith([{ song_id: 'newSong', album_id: 'newAlbum', suffix: 'mp3' }]),
    );

    expect(result.moved).toBe(1);
    expect([...mockFiles]).toEqual(['newAlbum/newSong.mp3']);
    expect(mockDirs.has('newAlbum')).toBe(true);
    expect(mockDirs.has('oldAlbum')).toBe(false);
  });

  it('leaves an old directory alone while it still holds anything', async () => {
    mockIdMap.set('oldAlbum', 'newAlbum');
    mockIdMap.set('oldSong', 'newSong');
    mockDirs.add('oldAlbum');
    mockFiles.add('oldAlbum/oldSong.mp3');
    // Not in cached_songs, so the pass never moves it — and must not delete it either.
    mockFiles.add('oldAlbum/astray.mp3');

    await moveDownloadedFiles(dbWith([{ song_id: 'newSong', album_id: 'newAlbum', suffix: 'mp3' }]));

    expect(mockDirs.has('oldAlbum')).toBe(true);
    expect(mockFiles.has('oldAlbum/astray.mp3')).toBe(true);
  });

  // The bucket is a literal, so it is never in the id map, so `oldAlbum === newAlbum` for
  // everything in it and it can never enter the swept set. What is worth pinning is that a
  // song in it still gets RENAMED in place.
  it('renames inside the _unknown bucket and leaves the bucket standing', async () => {
    mockIdMap.set('oldSong', 'newSong');
    mockDirs.add('_unknown');
    mockFiles.add('_unknown/oldSong.mp3');

    await moveDownloadedFiles(dbWith([{ song_id: 'newSong', album_id: '', suffix: 'mp3' }]));

    expect([...mockFiles]).toEqual(['_unknown/newSong.mp3']);
    expect(mockDirs.has('_unknown')).toBe(true);
  });

  it('is idempotent - a file already at its destination is skipped', async () => {
    mockIdMap.set('oldSong', 'newSong');
    mockDirs.add('albumA');
    mockFiles.add('albumA/newSong.mp3');

    const result = await moveDownloadedFiles(
      dbWith([{ song_id: 'newSong', album_id: 'albumA', suffix: 'mp3' }]),
    );

    expect(result).toEqual({ moved: 0, missing: 0, failed: 0 });
    expect([...mockFiles]).toEqual(['albumA/newSong.mp3']);
  });

  it('counts a vanished source as missing, not failed', async () => {
    mockIdMap.set('oldSong', 'newSong');
    mockDirs.add('albumA');

    const result = await moveDownloadedFiles(
      dbWith([{ song_id: 'newSong', album_id: 'albumA', suffix: 'mp3' }]),
    );

    expect(result).toEqual({ moved: 0, missing: 1, failed: 0 });
  });

  it('keeps going after a failed move and reports it', async () => {
    mockIdMap.set('bad', 'badNew');
    mockIdMap.set('good', 'goodNew');
    mockDirs.add('albumA');
    mockFiles.add('albumA/bad.mp3');
    mockFiles.add('albumA/good.mp3');
    mockFailMoves.add('albumA/bad.mp3');

    const result = await moveDownloadedFiles(dbWith([
      { song_id: 'badNew', album_id: 'albumA', suffix: 'mp3' },
      { song_id: 'goodNew', album_id: 'albumA', suffix: 'mp3' },
    ]));

    expect(result).toEqual({ moved: 1, missing: 0, failed: 1 });
    expect(mockFiles.has('albumA/goodNew.mp3')).toBe(true);
    expect(mockFiles.has('albumA/bad.mp3')).toBe(true);
  });

  it('preserves the suffix rather than assuming mp3', async () => {
    mockIdMap.set('oldSong', 'newSong');
    mockDirs.add('albumA');
    mockFiles.add('albumA/oldSong.flac');

    await moveDownloadedFiles(dbWith([{ song_id: 'newSong', album_id: 'albumA', suffix: 'flac' }]));

    expect([...mockFiles]).toEqual(['albumA/newSong.flac']);
  });

  it('pages through more rows than one chunk and reports progress', async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 450; i++) {
      const id = `s${String(i).padStart(4, '0')}`;
      mockIdMap.set(`old-${id}`, id);
      mockDirs.add('albumA');
      mockFiles.add(`albumA/old-${id}.mp3`);
      rows.push({ song_id: id, album_id: 'albumA', suffix: 'mp3' });
    }
    const progress: number[] = [];
    const result = await moveDownloadedFiles(dbWith(rows), (done) => progress.push(done));

    expect(result.moved).toBe(450);
    expect(progress).toEqual([200, 400, 450]);
    expect(mockFiles.size).toBe(450);
    expect([...mockFiles].every((f) => !f.includes('old-'))).toBe(true);
  });

  it('short-circuits on an empty map without touching the disk', async () => {
    mockFiles.add('albumA/song1.mp3');
    const result = await moveDownloadedFiles(
      dbWith([{ song_id: 'song1', album_id: 'albumA', suffix: 'mp3' }]),
    );
    expect(result).toEqual({ moved: 0, missing: 0, failed: 0 });
    expect(mockFiles.size).toBe(1);
  });
});
