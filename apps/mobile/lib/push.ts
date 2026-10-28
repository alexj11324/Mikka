import { Platform } from 'react-native'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import * as SecureStore from 'expo-secure-store'
import { api } from '@/lib/api'

const TOKEN_KEY = 'mikka_push_token'

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
})

/**
 * Asks for permission and registers this phone's Expo push token with Mikka,
 * so the Coordinator's proactive messages reach it (lib/mobile-push.ts on the
 * server). Needs a real device and the EAS project id; otherwise nothing happens.
 */
export async function registerForPush(): Promise<void> {
  if (Platform.OS === 'web' || !Device.isDevice) return
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined
  if (!projectId) return
  const { status } = await Notifications.getPermissionsAsync()
  const granted = status === 'granted' || (await Notifications.requestPermissionsAsync()).status === 'granted'
  if (!granted) return
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId })
  await api('/api/mobile/push-tokens', { method: 'POST', body: { token, platform: Platform.OS, deviceName: Device.deviceName } })
  await SecureStore.setItemAsync(TOKEN_KEY, token)
}

/** On sign-out: this phone stops getting the person's pushes. */
export async function unregisterPush(): Promise<void> {
  if (Platform.OS === 'web') return
  const token = await SecureStore.getItemAsync(TOKEN_KEY)
  if (!token) return
  await api('/api/mobile/push-tokens', { method: 'DELETE', body: { token } }).catch(() => undefined)
  await SecureStore.deleteItemAsync(TOKEN_KEY)
}

/** A tapped push opens the chat it came from (mobile.md: the push has no buttons). */
export function onPushOpened(open: (botId: string | null) => void) {
  const subscription = Notifications.addNotificationResponseReceivedListener(response => {
    const botId = response.notification.request.content.data?.botId
    open(typeof botId === 'string' ? botId : null)
  })
  return () => subscription.remove()
}
