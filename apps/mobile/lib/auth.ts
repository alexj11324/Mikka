import { createAuthClient } from 'better-auth/react'
import { expoClient } from '@better-auth/expo/client'
import * as SecureStore from 'expo-secure-store'
import { API_URL } from '@/lib/config'

/** better-auth with the Expo plugin: OAuth opens in the system browser, the session cookie lives in the keychain. */
export const authClient = createAuthClient({
  baseURL: `${API_URL}/api/auth`,
  plugins: [expoClient({ scheme: 'mikka', storagePrefix: 'mikka', storage: SecureStore })],
})
