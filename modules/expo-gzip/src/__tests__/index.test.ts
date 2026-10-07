import ExpoGzipModule from '../ExpoGzipModule';
import { compressToFile, decompressFromFile } from '../index';


const mockModule = jest.mocked(ExpoGzipModule);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('compressToFile', () => {
  it('passes data and destUri to native', async () => {
    mockModule.compressToFile.mockResolvedValue({ bytes: 256 });

    const result = await compressToFile('{"key":"value"}', 'file:///cache/data.gz');

    expect(mockModule.compressToFile).toHaveBeenCalledWith(
      '{"key":"value"}',
      'file:///cache/data.gz',
    );
    expect(result).toEqual({ bytes: 256 });
  });

  it('handles empty data', async () => {
    mockModule.compressToFile.mockResolvedValue({ bytes: 20 });

    const result = await compressToFile('', 'file:///cache/empty.gz');

    expect(mockModule.compressToFile).toHaveBeenCalledWith('', 'file:///cache/empty.gz');
    expect(result).toEqual({ bytes: 20 });
  });

  it('propagates native errors', async () => {
    mockModule.compressToFile.mockRejectedValue(new Error('Disk full'));

    await expect(
      compressToFile('data', 'file:///readonly/out.gz'),
    ).rejects.toThrow('Disk full');
  });
});

describe('decompressFromFile', () => {
  it('passes sourceUri to native and returns string', async () => {
    mockModule.decompressFromFile.mockResolvedValue('{"key":"value"}');

    const result = await decompressFromFile('file:///cache/data.gz');

    expect(mockModule.decompressFromFile).toHaveBeenCalledWith('file:///cache/data.gz');
    expect(result).toBe('{"key":"value"}');
  });

  it('handles empty content', async () => {
    mockModule.decompressFromFile.mockResolvedValue('');

    const result = await decompressFromFile('file:///cache/empty.gz');

    expect(result).toBe('');
  });

  it('propagates native errors for invalid files', async () => {
    mockModule.decompressFromFile.mockRejectedValue(new Error('Not a gzip file'));

    await expect(
      decompressFromFile('file:///cache/notgz.txt'),
    ).rejects.toThrow('Not a gzip file');
  });
});
