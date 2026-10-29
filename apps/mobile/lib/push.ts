import { AppState, Platform } from 'react-native'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import * as SecureStore from 'expo-secure-store'
import { api } from '@/lib/api'
import { pushTarget } from '@/lib/push-route'
import { pushState, setPushState as set, type PushState } from '@/lib/push-state'

const TOKEN_KEY = 'mikka_push_token'
/** The token the server already took in this run of the app, so coming back to the front does not post it again. */
let sent: string | null = null

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
})

/** The EAS project id the Expo token is minted for: `extra.eas.projectId` (app.config.ts, from EAS_PROJECT_ID). */
export function easProjectId(): string | null {
  const id = (Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId) as string | undefined
  return id || null
}

async function register(): Promise<PushState> {
  const projectId = easProjectId()
  if (!projectId) return 'failed'
  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId })
    if (token === sent) return 'registered'
    await api('/api/mobile/push-tokens', { method: 'POST', body: { token, platform: Platform.OS, deviceName: Device.deviceName } })
    await SecureStore.setItemAsync(TOKEN_KEY, token)
    sent = token
    return 'registered'
  } catch {
    return 'failed'
  }
}

/**
 * Reads iOS's permission without asking, and registers this phone when it is
 * granted. Runs at sign-in and whenever the app comes back to the front (the
 * person may have changed it in iOS Settings).
 */
export async function refreshPush(): Promise<PushState> {
  if (Platform.OS === 'web' || !Device.isDevice) { set('unsupported'); return pushState() }
  const { status } = await Notifications.getPermissionsAsync()
  if (status === 'denied') set('denied')
  else if (status !== 'granted') set('undetermined')
  else set(await register())
  return pushState()
}

/** Shows iOS's permission prompt (once; afterwards only iOS Settings can change it), then registers. */
export async function askForPush(): Promise<PushState> {
  if (Platform.OS === 'web' || !Device.isDevice) { set('unsupported'); return pushState() }
  const { status } = await Notifications.getPermissionsAsync()
  if (status === 'undetermined') await Notifications.requestPermissionsAsync()
  return refreshPush()
}

/** On sign-out: this phone stops getting the person's pushes. */
export async function unregisterPush(): Promise<void> {
  if (Platform.OS === 'web') return
  const token = await SecureStore.getItemAsync(TOKEN_KEY)
  if (!token) return
  await api('/api/mobile/push-tokens', { method: 'DELETE', body: { token } }).catch(() => undefined)
  await SecureStore.deleteItemAsync(TOKEN_KEY)
  sent = null
}

/** After the session is gone (a 401): the token can no longer be removed on the server, only forgotten here. */
export async function forgetPushToken(): Promise<void> {
  if (Platform.OS !== 'web') await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => undefined)
  sent = null
  set('unknown')
}

/**
 * Opens what a tapped push points at (lib/push-route.ts). A tap that launched
 * the app from closed is read once with getLastNotificationResponseAsync, then
 * cleared so it does not open again; later taps arrive through the listener.
 * Also refreshes the push state whenever the app comes to the front.
 */
export function watchPushes(open: (href: string) => void) {
  let handled: string | null = null
  const route = (response: Notifications.NotificationResponse | null) => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return
    const key = response.notification.request.identifier
    if (key === handled) return
    handled = key
    open(pushTarget(response.notification.request.content.data))
    void Notifications.clearLastNotificationResponseAsync().catch(() => undefined)
  }
  void Notifications.getLastNotificationResponseAsync().then(route).catch(() => undefined)
  const tap = Notifications.addNotificationResponseReceivedListener(route)
  const front = AppState.addEventListener('change', next => { if (next === 'active') void refreshPush().catch(() => undefined) })
  void refreshPush().catch(() => undefined)
  return () => { tap.remove(); front.remove() }
}
