import { Platform } from 'react-native'
import { authClient } from '@/lib/auth'
import { apiCache } from './api-cache'
import { currentAccount, servers } from './config'

let ending: Promise<void> | null = null
let expired = false

/**
 * The server no longer knows this session (a 401: a password reset elsewhere,
 * revoked on the web, expired). Sign out here only: the Expo plugin clears the
 * keychain cookie before the request goes out, so the app returns to the
 * sign-in screen even though the server call itself fails.
 */
export function endLostSession(): Promise<void> {
  if (ending) return ending
  const client = authClient, account = currentAccount()
  expired = true
  apiCache.clear()
  ending = (async () => {
    if (Platform.OS !== 'web') await (await import('@/lib/push')).forgetPushToken(account.id).catch(() => undefined)
    await client.signOut().catch(() => undefined)
    client.$store.notify('$sessionSignal')
    await servers.signedOut(account.id).catch(() => undefined)
  })().finally(() => { ending = null })
  return ending
}

/** Whether the app signed out because the session was lost, so the sign-in screen can say so. */
export const sessionExpired = () => expired

/** The person is signing in again. */
export function clearSessionExpired() {
  expired = false
}
