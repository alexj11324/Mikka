import { Alert, Linking, Platform } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import { api, apiConnection } from '@/lib/api'
import { API_URL, currentAccount } from '@/lib/config'
import { finishAppleDeletionHandoff } from './apple-auth'
import { mobileMessages as messages } from './messages'
import { apiCache } from './api-cache'
import { mobileTaskTarget } from '../../../lib/mobile-task-handoff'

export { webChatPath } from './web-chat'

export async function openPrivacyPolicy(): Promise<void> {
  try { await Linking.openURL('https://aspectlylabs.com/privacy') }
  catch { Alert.alert(messages.Auth.webOpenUnconfirmed) }
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
  const web = Platform.OS === 'web'
  if (web && !mobileTaskTarget(path)) {
    // The app root is /mikka, not /mikka/ (lib/base-path.ts).
    window.open(`${API_URL}${path.startsWith('/?') || path === '/' ? path.slice(1) : path}`, '_blank', 'noopener')
    return
  }
  // Reserve the tab during the gesture. The authorized handoff resolves the
  // Task's workspace and selects the official client for self-hosted servers.
  const tab = web ? window.open('about:blank', '_blank') : null
  if (tab) tab.opener = null
  const context = apiCache.context()
  try {
    const { token } = await api<{ token: string }>('/api/auth/one-time-token/generate', {}, connection)
    if (context !== apiCache.context() || connection.account.id !== currentAccount().id) {
      tab?.close()
      return
    }
    if (!token) throw new Error('handoff_unconfirmed')
    const query = new URLSearchParams({ to: path, token })
    const url = `${connection.account.server.url}/api/mobile/open?${query}`
    if (!web) await WebBrowser.openBrowserAsync(url)
    else if (tab) { if (!tab.closed) tab.location.replace(url) }
    else window.location.assign(url)
  } catch {
    tab?.close()
    if (web) window.alert(messages.Auth.webOpenUnconfirmed)
    else Alert.alert(messages.Auth.webOpenUnconfirmed)
  }
}

/** After the existing deletion flow, offer Apple's manual authorization control. */
export async function openAccountDeletion(): Promise<void> {
  const accountId = currentAccount().id
  await openOnWeb('/settings?section=account')
  try {
    if (await finishAppleDeletionHandoff(accountId)) Alert.alert(messages.Auth.appleAuthorizationTitle, messages.Auth.appleRevocationBody, [
      { text: messages.Common.close, style: 'cancel' },
      { text: messages.Auth.manageAppleAuthorization, onPress: () => { void Linking.openURL('https://account.apple.com/').catch(() => Alert.alert(messages.Auth.webOpenUnconfirmed)) } },
    ])
  } catch { Alert.alert(messages.Auth.accountDeletionUnconfirmed) }
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
  } catch { if (current()) Alert.alert(messages.Auth.webOpenUnconfirmed) }
}
