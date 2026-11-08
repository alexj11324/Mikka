import { AppState, Platform } from 'react-native'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import * as SecureStore from 'expo-secure-store'
import { api, apiConnection, type ApiConnection } from '@/lib/api'
import { pushBelongsToAccount, pushTarget, pushTaskTarget, type TaskPushTarget } from '@/lib/push-route'
import { pushState, setPushState as set, type PushState } from '@/lib/push-state'
import { currentAccount, onServerChange } from './config'
import { accountStorageKey } from './server-store'

/**
 * The binding the server confirmed: this account's token posted under this session (#1659). The server binds a token
 * to the native session that posts it and reads that session itself, so a confirmation counts only for the session it
 * was made under, and only for a while: a POST that predates the server's session binding (a deploy while the app
 * stayed open) is redone on the next sign-in, session change or return to the front after that, never on a timer.
 * The session is kept in memory to compare; it is never sent, stored or logged.
 */
let confirmed: { key: string; at: number } | null = null
let session: string | null = null
export const CONFIRMED_FOR_MS = 12 * 60 * 60 * 1000
const bindingKey = (accountId: string, token: string) => `${accountId}\u0000${session ?? ''}\u0000${token}`
const isConfirmed = (key: string) => confirmed?.key === key && Date.now() - confirmed.at < CONFIRMED_FOR_MS
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
onServerChange(() => { generation++; confirmed = null; set('unknown') })

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
      const key = bindingKey(connection.account.id, token)
      if (isConfirmed(key)) return 'registered'
      await api('/api/mobile/push-tokens', { method: 'POST', body: { token, platform: Platform.OS, deviceName: Device.deviceName }, timeoutMs: 5000 }, connection)
      // A switch can begin while the POST is in flight. Finish its cleanup
      // before a new account may register this same device token.
      if (cancelled()) { await remove(connection, token); return 'unknown' }
      try { await SecureStore.setItemAsync(accountStorageKey(connection.account.id, 'push_token'), token) }
      catch (error) { await remove(connection, token); throw error }
      if (!cancelled()) confirmed = { key, at: Date.now() }
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

/**
 * The signed-in session changed (signed in, or the same phone and token under a new session): registers again, so
 * the server binds the token to it. The first call only records the session; watchPushes registers right after.
 */
export function setPushSession(next: string | null): Promise<PushState> | null {
  if (next === session) return null
  const first = session === null
  session = next
  if (first || !next) return null
  return refreshPush()
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
    if (currentAccount().id === connection.account.id) confirmed = null
  })
}

/** After the session is gone (a 401): the token can no longer be removed on the server, only forgotten here. */
export async function forgetPushToken(accountId = currentAccount().id): Promise<void> {
  if (currentAccount().id === accountId) generation++
  await mutate(async () => {
    if (Platform.OS !== 'web') await SecureStore.deleteItemAsync(accountStorageKey(accountId, 'push_token')).catch(() => undefined)
    if (currentAccount().id === accountId) { confirmed = null; set('unknown') }
  })
}

/**
 * Opens what a tapped push points at (lib/push-route.ts). A tap that launched
 * the app from closed is read once with getLastNotificationResponseAsync, then
 * cleared so it does not open again; later taps arrive through the listener.
 * A full task push goes to `openTask`, which confirms its workspace before opening it (lib/task-push.ts); a push
 * that names a workspace but no valid task target goes to `refuseTask` and opens nothing; every other push keeps its
 * entry. Also refreshes the push state whenever the app comes to the front.
 */
export function watchPushes(open: (href: string) => void, openTask: (target: TaskPushTarget) => void, refuseTask: () => void) {
  let handled: string | null = null
  const route = (response: Notifications.NotificationResponse | null) => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return
    if (!pushBelongsToAccount(response.notification.request.content.data, currentAccount())) return
    const key = response.notification.request.identifier
    if (key === handled) return
    handled = key
    const data = response.notification.request.content.data
    const task = pushTaskTarget(data)
    if (task === 'invalid') refuseTask()
    else if (task) openTask(task)
    else open(pushTarget(data))
    void Notifications.clearLastNotificationResponseAsync().catch(() => undefined)
  }
  void Notifications.getLastNotificationResponseAsync().then(route).catch(() => undefined)
  const tap = Notifications.addNotificationResponseReceivedListener(route)
  const front = AppState.addEventListener('change', next => { if (next === 'active') void refreshPush().catch(() => undefined) })
  void refreshPush().catch(() => undefined)
  return () => { tap.remove(); front.remove() }
}
