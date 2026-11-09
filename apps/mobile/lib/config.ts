import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { storageAdapter } from '@better-auth/expo/client'
import { MobileServerStore, type MobileServer } from './server-store'
import { CLOUD_API_URL } from './server-discovery'
import { apiCache } from './api-cache'

/**
 * Where Mikka runs, with its base path (lib/base-path.ts on the server), e.g.
 * https://app.aspectlylabs.com/mikka. Set EXPO_PUBLIC_API_URL for a preview
 * deployment. On web the app is served next to the API, so it uses its own origin.
 */
export { CLOUD_API_URL } from './server-discovery'

const initialUrl = (process.env.EXPO_PUBLIC_API_URL
  ?? (Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.origin : CLOUD_API_URL)).replace(/\/$/, '')
export const defaultServer: MobileServer = { url: initialUrl, name: 'Mikka Cloud', version: null,
  edition: 'cloud', signIn: { google: true, github: true, apple: initialUrl === CLOUD_API_URL, email: true }, mobileReady: true }
const storage = Platform.OS === 'web' ? {
  getItemAsync: async (key: string) => globalThis.localStorage?.getItem(key) ?? null,
  setItemAsync: async (key: string, value: string) => { globalThis.localStorage?.setItem(key, value) },
} : storageAdapter(SecureStore)
export const servers = new MobileServerStore(storage, defaultServer)
export const currentAccount = servers.current

/** Live binding for existing screens; the root remounts on every account change. */
export let API_URL = initialUrl
let active = servers.current().id
servers.subscribe(() => {
  const account = servers.current()
  API_URL = account.server.url
  if (active !== account.id) { active = account.id; apiCache.setIdentity(null) }
})
export function onServerChange(listener: () => void) {
  let previous = `${servers.current().id}:${API_URL}`
  return servers.subscribe(() => {
    const next = `${servers.current().id}:${API_URL}`
    if (next !== previous) { previous = next; listener() }
  })
}
