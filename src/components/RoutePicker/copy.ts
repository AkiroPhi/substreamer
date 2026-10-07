import { Platform } from 'react-native';
import type { AudioRoute } from 'react-native-queue-player';

import i18n from '../../i18n/i18n';
import type { RouteInfo } from './types';

/**
 * User-facing copy for the route picker, in one place so the picker, the button,
 * and screen-reader announcements speak with one voice. Follows the "Listening
 * on" convention for audio context. Protocol names (AirPlay, Chromecast) are
 * product names and stay untranslated.
 */

function localDeviceLabel(): string {
  return Platform.OS === 'ios' ? i18n.t('routeThisIphone') : i18n.t('thisDevice');
}

/** Title for the sheet header, and the CastButton's inline preposition ("Listening on X"). */
export function listeningOnLabel(): string {
  return i18n.t('routeListeningOn');
}

/** Subtitle line under the device name on each row. */
export function rowSubtitle(route: RouteInfo): string {
  if (route.protocol === 'local') return i18n.t('routeCurrentlyListeningHere');
  const protoBits: string[] = [];
  if (route.protocol === 'airplay') {
    protoBits.push(`AirPlay${route.protocolVersion ? ' ' + route.protocolVersion : ''}`);
  } else if (route.protocol === 'chromecast') {
    protoBits.push('Chromecast');
  } else {
    protoBits.push(route.protocol);
  }
  if (route.modelName.length > 0) protoBits.push(route.modelName);
  if (route.lastError) protoBits.push(i18n.t('routeCouldntConnect'));
  return protoBits.join(' • ');
}

/** Local-row subtitle while audio is routed to an OS-managed AirPlay/BT device. */
export function systemRouteActiveLocalSubtitle(): string {
  return i18n.t('routeSystemActiveLocalSubtitle');
}

/** Local-row subtitle while a lib-managed cast route (Chromecast) is active. */
export function castActiveLocalSubtitle(): string {
  return i18n.t('routeCastActiveLocalSubtitle');
}

/** Friendly name for the local device row. */
export function localRouteDisplayName(): string {
  return localDeviceLabel();
}

/** Text the player-screen CastButton displays — the active route's name. */
export function castButtonLabel(audioRoute: AudioRoute, activeCastName: string | null): string {
  if (activeCastName != null && activeCastName.length > 0) {
    return activeCastName;
  }
  if (
    audioRoute.name &&
    audioRoute.name.length > 0 &&
    audioRoute.kind !== 'speaker' &&
    audioRoute.kind !== 'unknown'
  ) {
    return audioRoute.name;
  }
  return localDeviceLabel();
}

/** A11y label for the CastButton. */
export function castButtonA11yLabel(name: string): string {
  return i18n.t('routeCastButtonA11y', { name });
}

/** A11y label for the active receiver row (disconnect target). */
export function stopCastingA11yLabel(name: string): string {
  return i18n.t('routeStopListeningOn', { name });
}

/** A11y label for an idle, tappable receiver row. */
export function startCastingA11yLabel(name: string): string {
  return i18n.t('routeListenOn', { name });
}
