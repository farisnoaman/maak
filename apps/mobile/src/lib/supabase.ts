import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';

/**
 * Mobile Supabase client.
 *
 * Sessions are stored in the OS keychain / keystore (SecureStore), never in AsyncStorage:
 * an access token on disk in plain text is a credential leak on a shared or stolen device.
 *
 * SecureStore caps values at ~2 KB, while a Supabase session can exceed that, so values are
 * chunked. Reads are never trusted blindly: a corrupt or partially written entry reads as
 * "logged out" rather than throwing at startup.
 */

const CHUNK_SIZE = 1800;

const chunkedStorage = {
  async getItem(key: string): Promise<string | null> {
    try {
      const countRaw = await SecureStore.getItemAsync(`${key}::count`);
      if (!countRaw) return null;
      const count = Number.parseInt(countRaw, 10);
      if (!Number.isInteger(count) || count < 1) return null;

      const parts: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const part = await SecureStore.getItemAsync(`${key}::${index}`);
        if (part === null) return null;
        parts.push(part);
      }
      return parts.join('');
    } catch {
      return null;
    }
  },

  async setItem(key: string, value: string): Promise<void> {
    const chunks: string[] = [];
    for (let offset = 0; offset < value.length; offset += CHUNK_SIZE) {
      chunks.push(value.slice(offset, offset + CHUNK_SIZE));
    }
    await this.removeItem(key);
    for (let index = 0; index < chunks.length; index += 1) {
      await SecureStore.setItemAsync(`${key}::${index}`, chunks[index] as string);
    }
    await SecureStore.setItemAsync(`${key}::count`, String(chunks.length));
  },

  async removeItem(key: string): Promise<void> {
    const countRaw = await SecureStore.getItemAsync(`${key}::count`);
    const count = countRaw ? Number.parseInt(countRaw, 10) : 0;
    for (let index = 0; index < (Number.isInteger(count) ? count : 0); index += 1) {
      await SecureStore.deleteItemAsync(`${key}::${index}`);
    }
    await SecureStore.deleteItemAsync(`${key}::count`);
  },
};

let cached: SupabaseClient | null = null;

export function getMobileClient(): SupabaseClient | null {
  if (cached) return cached;

  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  cached = createClient(url, anonKey, {
    auth: {
      storage: chunkedStorage,
      autoRefreshToken: true,
      persistSession: true,
      // Deep links handle the OAuth/magic-link callback explicitly.
      detectSessionInUrl: false,
    },
    global: { headers: { 'X-Maak-Client': 'mobile' } },
  });
  return cached;
}
