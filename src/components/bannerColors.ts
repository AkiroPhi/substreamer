/**
 * Shared palette for the top-of-screen pill banners.
 *
 * `PAUSED_AMBER` is not decoration — it is the signal that work is paused waiting on
 * connectivity, and it has to mean the same thing on every banner or it means nothing.
 * Distinct from the red of `ConnectivityBanner`, which reports a fault rather than a
 * deliberate pause.
 */
export const PAUSED_AMBER = '#FF9500';
