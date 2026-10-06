// Jest native-module mock, loaded by jest-expo for `requireNativeModule(...)` (its `mocks/`
// lookup). Returns the same values as the wrapper's no-native fallback, so tests behave as before.

const status = { installed: false, error: null };

export const initTrustStore = () => Promise.resolve(status);
export const getInstallStatus = () => Promise.resolve(status);
export const getCertificateInfo = () =>
  Promise.reject(new Error('expo-ssl-trust native module not available. Rebuild the app.'));
export const trustCertificate = () => Promise.resolve();
export const removeTrustedCertificate = () => Promise.resolve();
export const clearAllTrustedCertificates = () => Promise.resolve();
export const getTrustedCertificates = () => Promise.resolve([]);
export const isCertificateTrusted = () => Promise.resolve(false);
export const syncProxyUpstreams = () => Promise.resolve(null);
export const getProxyInfo = () => Promise.resolve(null);
