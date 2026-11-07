import { Alert, Linking, Platform } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import { api, apiConnection } from '@/lib/api'
import { API_URL } from '@/lib/config'
import { apiCache } from './api-cache'

export { webChatPath } from './web-chat'

export async function openPrivacyPolicy(): Promise<void> {
  try { await Linking.openURL('https://aspectlylabs.com/privacy') }
  catch { Alert.alert('网页打开未确认') }
}

/**
 * Opens a page of the web app signed in as the person, for what the app cannot
 * draw. The in-app browser does not share the keychain cookie, so a one-minute,
 * single-use token goes with it (app/api/mobile/open on the server). The browser
 * shows the target account for confirmation before setting its session. Without a
 * token the native page stays open; it cannot fall into another browser session.
 */
export async function openOnWeb(path: string): Promise<void> {
  const connection = apiConnection()
  if (Platform.OS === 'web') {
    // The app root is /mikka, not /mikka/ (lib/base-path.ts).
    window.open(`${API_URL}${path.startsWith('/?') || path === '/' ? path.slice(1) : path}`, '_blank', 'noopener')
    return
  }
  try {
    const { token } = await api<{ token: string }>('/api/auth/one-time-token/generate', {}, connection)
    if (!token) throw new Error('handoff_unconfirmed')
    const query = new URLSearchParams({ to: path, token })
    await WebBrowser.openBrowserAsync(`${connection.account.server.url}/api/mobile/open?${query}`)
  } catch { Alert.alert('网页打开未确认') }
}

/** The selected server checks the issuer and billing workspace. Never pass its
 * local login token to the cloud page or guess an official cloud domain. */
export async function openCloudBilling(): Promise<void> {
  const connection = apiConnection(), context = apiCache.context()
  // The server's authenticated redirect opens synchronously from the web tap,
  // so waiting for JSON cannot turn it into a blocked browser popup.
  if (Platform.OS === 'web') {
    window.open(`${connection.account.server.url}/api/cloud/models/billing?redirect=1`, '_blank', 'noopener')
    return
  }
  const current = () => context === apiCache.context() && connection.account.id === apiConnection().account.id
  try {
    const result = await api<{ url: string }>('/api/cloud/models/billing', {}, connection)
    if (!current()) return
    const url = new URL(result.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || !url.pathname.endsWith('/settings') || url.searchParams.get('section') !== 'billing'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url.searchParams.get('workspace') ?? '')
      || url.searchParams.getAll('section').length !== 1 || url.searchParams.getAll('workspace').length !== 1
      || [...url.searchParams.keys()].some(key => key !== 'section' && key !== 'workspace')) throw new Error('cloud_billing_unconfirmed')
    await WebBrowser.openBrowserAsync(url.href)
  } catch { if (current()) Alert.alert('网页打开未确认') }
}
