// Jest native-module mock, loaded by jest-expo for `requireNativeModule(...)` (its `mocks/`
// lookup). Returns the same values as the wrapper's no-native fallback, so tests behave as before.

export const setArmed = () => {};
export const isSupported = () => false;
export const addListener = () => ({ remove: () => {} });
export const removeListeners = () => {};
