import ExpoBackupExclusionsModule from '../ExpoBackupExclusionsModule';
import { excludeFromBackup } from '../index';


const mockModule = jest.mocked(ExpoBackupExclusionsModule);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('excludeFromBackup', () => {
  it('delegates to native excludeFromBackup', async () => {
    mockModule.excludeFromBackup.mockResolvedValue(undefined);

    await excludeFromBackup();

    expect(mockModule.excludeFromBackup).toHaveBeenCalledTimes(1);
  });

  it('returns a void promise', async () => {
    mockModule.excludeFromBackup.mockResolvedValue(undefined);

    const result = await excludeFromBackup();

    expect(result).toBeUndefined();
  });

  it('propagates native errors', async () => {
    mockModule.excludeFromBackup.mockRejectedValue(new Error('Failed to set exclusion'));

    await expect(excludeFromBackup()).rejects.toThrow('Failed to set exclusion');
  });
});
