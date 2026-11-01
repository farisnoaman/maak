import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';
import { useNotificationTapRouting } from '../lib/push-routing';

/**
 * Root layout. Direction is decided by the locale, not by I18nManager, so switching language
 * does not require an app restart (specs.md §6.15).
 */
export default function RootLayout() {
  const scheme = useColorScheme();
  // A tapped push opens the screen its `link` names, cold start included.
  useNotificationTapRouting();
  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}
