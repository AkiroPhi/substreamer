import ExpoMoveToBackModule from '../ExpoMoveToBackModule';
import { moveToBack } from '../index';


const mockModule = jest.mocked(ExpoMoveToBackModule);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('moveToBack', () => {
  it('delegates to native moveToBack', () => {
    moveToBack();

    expect(mockModule.moveToBack).toHaveBeenCalledTimes(1);
  });

  it('can be called multiple times', () => {
    moveToBack();
    moveToBack();
    moveToBack();

    expect(mockModule.moveToBack).toHaveBeenCalledTimes(3);
  });

  it('returns void', () => {
    const result = moveToBack();

    expect(result).toBeUndefined();
  });
});
