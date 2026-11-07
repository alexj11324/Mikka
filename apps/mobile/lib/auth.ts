import { createAuthClient } from 'better-auth/react'
import { expoClient } from '@better-auth/expo/client'
import * as SecureStore from 'expo-secure-store'
import { currentAccount, onServerChange } from '@/lib/config'
import { accountStorageKey } from './server-store'
import { mobileFetchFor } from './tracing'
import { boundAuthFetch } from './server-transport'

/** better-auth with the Expo plugin: OAuth opens in the system browser, the session cookie lives in the keychain. */
function createClient() {
  const account = currentAccount()
  return createAuthClient({
    baseURL: `${account.server.url}/api/auth`,
    fetchOptions: { customFetchImpl: boundAuthFetch(account.server.url, mobileFetchFor(account.server.url)) },
    plugins: [expoClient({ scheme: 'mikka', storagePrefix: accountStorageKey(account.id, '').replace(/_$/, ''), storage: SecureStore })],
  })
}
export let authClient = createClient()
onServerChange(() => { authClient = createClient() })
