/**
 * Push registration for the native app.
 *
 * The token is the only thing the server needs, and it is the only thing this file sends: the phone
 * asks the OS for permission, Expo mints a token, and the token goes to `notifications.device.register`
 * through the gateway like every other write (ADR-018). Nothing here reads the notification table.
 *
 * A refusal is a normal answer, not an error: a passenger who taps "don't allow" still gets email and
 * the in-app inbox, and the settings screen says so instead of failing silently.
 */

import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { notificationCommandSpec } from '@maak/core';
import { getApiClient } from './api';

export type PushRegistration =
  | { readonly ok: true; readonly token: string }
  | {
      readonly ok: false;
      readonly reason: 'permission' | 'unsupported' | 'not-configured';
    };

const CHANNEL = 'default';

/**
 * Android drops notifications posted to a channel the app never created. Creating it once at start-up,
 * with the accent colour, is why the demo push does not arrive silently on Android 13+.
 */
export async function preparePushChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL, {
    name: 'Maak',
    importance: Notifications.AndroidImportance.DEFAULT,
    lightColor: '#0f766e',
  });
}

/**
 * The permission answer, reduced to what this file needs.
 *
 * `expo-notifications` types the response through `expo-modules-core`, which is not installed in this
 * workspace (the app is typechecked, not built, in CI). Reading the two fields positionally keeps the
 * screen honest without pinning a second native dependency the build does not have.
 */
interface PermissionAnswer {
  readonly status?: string;
  readonly granted?: boolean;
}

function isGranted(answer: PermissionAnswer): boolean {
  return answer.granted === true || answer.status === 'granted';
}

/** The EAS project id, without which `getExpoPushTokenAsync` throws. Expo Go has none. */
function projectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? null;
}

export async function registerForPush(): Promise<PushRegistration> {
  const id = projectId();
  if (!id) return { ok: false, reason: 'not-configured' };

  const existing = (await Notifications.getPermissionsAsync()) as unknown as PermissionAnswer;
  const allowed = isGranted(existing)
    ? true
    : isGranted((await Notifications.requestPermissionsAsync()) as unknown as PermissionAnswer);
  if (!allowed) return { ok: false, reason: 'permission' };

  await preparePushChannel();

  let token: string;
  try {
    token = (await Notifications.getExpoPushTokenAsync({ projectId: id })).data;
  } catch {
    // Simulators and Expo Go with no project both land here; the caller shows "not configured".
    return { ok: false, reason: 'unsupported' };
  }

  const client = getApiClient();
  if (!client) return { ok: false, reason: 'not-configured' };

  const result = await client.call(notificationCommandSpec, {
    action: 'notifications.device.register',
    platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
    token,
  });
  if (!result.ok) return { ok: false, reason: 'not-configured' };

  return { ok: true, token };
}

/** Best-effort removal on sign-out, so a shared phone does not keep receiving the last user's trips. */
export async function unregisterDevice(deviceId: string): Promise<boolean> {
  const client = getApiClient();
  if (!client) return false;
  const result = await client.call(notificationCommandSpec, {
    action: 'notifications.device.revoke',
    deviceId,
  });
  return result.ok;
}
