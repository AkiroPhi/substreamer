// Jest native-module mock, loaded by jest-expo for `requireNativeModule(...)` (its `mocks/`
// lookup). Returns the same values as the wrapper's no-native fallback, so tests behave as before.

export const listDirectoryAsync = () => Promise.resolve([]);
export const listDirectoryWithSizesAsync = () => Promise.resolve([]);
export const getDirectorySizeAsync = () => Promise.resolve(0);
export const statAsync = () => Promise.resolve({ exists: false, size: 0, isDirectory: false });
export const deleteFileAsync = () => Promise.resolve(false);
export const deleteDirectoryAsync = () => Promise.resolve(false);
export const downloadFileAsyncWithProgress = () => Promise.resolve({ uri: '', bytes: 0 });
export const addListener = () => ({ remove: () => {} });
