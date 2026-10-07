import ExpoScrollToTopModule from '../ExpoScrollToTopModule';
import { addStatusBarTapListener, isSupported, setArmed } from '../index';

const mockModule = jest.mocked(ExpoScrollToTopModule);

beforeEach(() => jest.clearAllMocks());

describe('expo-scroll-to-top', () => {
  it('arms and disarms interception', () => {
    setArmed(true);
    expect(mockModule.setArmed).toHaveBeenLastCalledWith(true);
    setArmed(false);
    expect(mockModule.setArmed).toHaveBeenLastCalledWith(false);
  });

  it('subscribes the listener to declined taps', () => {
    const onTap = jest.fn();
    addStatusBarTapListener(onTap);

    expect(mockModule.addListener).toHaveBeenCalledWith('onStatusBarTap', onTap);
  });

  it('removes the native subscription on unsubscribe', () => {
    // The listener outliving its screen would reset a list the user is no longer looking at.
    const remove = jest.fn();
    mockModule.addListener.mockReturnValueOnce({ remove });
    const unsubscribe = addStatusBarTapListener(jest.fn());

    unsubscribe();

    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('reports whether interception is actually in place', () => {
    // False on Android, and on any iOS build where the RN internals moved — callers fall
    // back to stock scroll-to-top rather than silently doing nothing.
    mockModule.isSupported.mockReturnValueOnce(true);
    expect(isSupported()).toBe(true);
    expect(isSupported()).toBe(false);
  });
});
