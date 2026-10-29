import { Platform } from 'react-native'
import { authClient } from '@/lib/auth'

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
  expired = true
  ending = (async () => {
    if (Platform.OS !== 'web') await (await import('@/lib/push')).forgetPushToken().catch(() => undefined)
    await authClient.signOut().catch(() => undefined)
    authClient.$store.notify('$sessionSignal')
  })().finally(() => { ending = null })
  return ending
}

/** Whether the app signed out because the session was lost, so the sign-in screen can say so. */
export const sessionExpired = () => expired

/** The person is signing in again. */
export function clearSessionExpired() {
  expired = false
}
