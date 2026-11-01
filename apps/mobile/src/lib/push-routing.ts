import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { useRootNavigationState, useRouter } from 'expo-router';
import { mobileRoute } from '@maak/core';

/**
 * A tapped push opens what it is about.
 *
 * The worker sends `data.link` alongside the body (see `expoPushMessages` in `@maak/core`), and until now
 * nothing on the phone read it: the notification opened the app at whatever screen it was last on, and a
 * saved-search alert about «عدن → صنعاء، ≤ 5,000» landed nowhere in particular. `mobileRoute` maps the web
 * href to a native screen and keeps the query, so the tap reopens the search.
 *
 * Two entry points, because a tap is not always an event:
 *   · **cold start** — the app was not running, so the tap arrives through `getLastNotificationResponseAsync`
 *     and never reaches the listener;
 *   · **warm** — the listener fires.
 *
 * The root navigation state is the guard for both: pushing before the navigator has mounted is the classic
 * "nothing happens when you tap the notification" bug, and the state object is the only honest signal that it
 * has.
 */
export function useNotificationTapRouting(): void {
  const router = useRouter();
  const navigation = useRootNavigationState();

  useEffect(() => {
    if (!navigation?.key) return;

    const open = (response: Notifications.NotificationResponse) => {
      const data = response.notification.request.content.data as { link?: unknown } | null;
      // A payload with no link still means "there is a message": the inbox is the honest destination.
      router.push(mobileRoute(typeof data?.link === 'string' ? data.link : null));
    };

    let cancelled = false;
    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (!cancelled && response) open(response);
      })
      .catch(() => {
        // No native module (a web build, or a simulator): the listener below is still worth attaching.
      });

    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [navigation?.key, router]);
}
