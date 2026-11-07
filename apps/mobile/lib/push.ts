import { AppState, Platform } from 'react-native'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import * as SecureStore from 'expo-secure-store'
import { api, apiConnection, type ApiConnection } from '@/lib/api'
import { pushBelongsToAccount, pushTarget } from '@/lib/push-route'
import { pushState, setPushState as set, type PushState } from '@/lib/push-state'
import { currentAccount, onServerChange } from './config'
import { accountStorageKey } from './server-store'

/** The token the server already took in this run of the app, so coming back to the front does not post it again. */
let sent: string | null = null
let generation = 0
let mutations: Promise<unknown> = Promise.resolve()
function mutate<T>(work: () => Promise<T>): Promise<T> {
  const next = mutations.then(work)
  mutations = next.catch(() => undefined)
  return next
}

Notifications.setNotificationHandler({
  handleNotification: async notification => {
    const current = pushBelongsToAccount(notification.request.content.data, currentAccount())
    return { shouldShowBanner: current, shouldShowList: current, shouldPlaySound: current, shouldSetBadge: false }
  },
})
onServerChange(() => { generation++; sent = null; set('unknown') })

/** The EAS project id the Expo token is minted for: `extra.eas.projectId` (app.config.ts, from EAS_PROJECT_ID). */
export function easProjectId(): string | null {
  const id = (Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId) as string | undefined
  return id || null
}

async function remove(connection: ApiConnection, token: string) {
  await api('/api/mobile/push-tokens', { method: 'DELETE', body: { token }, timeoutMs: 5000 }, connection).catch(() => undefined)
}

async function register(connection: ApiConnection, started: number): Promise<PushState> {
  const projectId = easProjectId()
  if (!projectId) return 'failed'
  const cancelled = () => started !== generation || currentAccount().id !== connection.account.id
  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId })
    return await mutate(async () => {
      if (cancelled()) return 'unknown'
      const key = `${connection.account.id}:${token}`
      if (key === sent) return 'registered'
      await api('/api/mobile/push-tokens', { method: 'POST', body: { token, platform: Platform.OS, deviceName: Device.deviceName }, timeoutMs: 5000 }, connection)
      // A switch can begin while the POST is in flight. Finish its cleanup
      // before a new account may register this same device token.
      if (cancelled()) { await remove(connection, token); return 'unknown' }
      try { await SecureStore.setItemAsync(accountStorageKey(connection.account.id, 'push_token'), token) }
      catch (error) { await remove(connection, token); throw error }
      if (!cancelled()) sent = key
      return 'registered'
    })
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
  const connection = apiConnection(), started = generation
  if (Platform.OS === 'web' || !Device.isDevice) { set('unsupported'); return pushState() }
  const { status } = await Notifications.getPermissionsAsync()
  if (generation !== started || currentAccount().id !== connection.account.id) return pushState()
  const next = status === 'denied' ? 'denied' : status !== 'granted' ? 'undetermined' : await register(connection, started)
  if (generation === started && currentAccount().id === connection.account.id) set(next)
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
  const connection = apiConnection(), key = accountStorageKey(connection.account.id, 'push_token')
  generation++
  await mutate(async () => {
    const token = await SecureStore.getItemAsync(key)
    if (token) await remove(connection, token)
    await SecureStore.deleteItemAsync(key)
    if (currentAccount().id === connection.account.id) sent = null
  })
}

/** After the session is gone (a 401): the token can no longer be removed on the server, only forgotten here. */
export async function forgetPushToken(accountId = currentAccount().id): Promise<void> {
  if (currentAccount().id === accountId) generation++
  await mutate(async () => {
    if (Platform.OS !== 'web') await SecureStore.deleteItemAsync(accountStorageKey(accountId, 'push_token')).catch(() => undefined)
    if (currentAccount().id === accountId) { sent = null; set('unknown') }
  })
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
    if (!pushBelongsToAccount(response.notification.request.content.data, currentAccount())) return
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
