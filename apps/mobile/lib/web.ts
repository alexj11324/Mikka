import { Platform } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import { api } from '@/lib/api'
import { API_URL } from '@/lib/config'

/** The web chat a phone chat matches: the Coordinator's, or a bot's (issue-workspace.tsx reads `section` and `bot`). */
export const webChatPath = (botId: string | null) => botId ? `/?section=coordinator&bot=${botId}` : '/?section=coordinator'

/**
 * Opens a page of the web app signed in as the person, for what the app cannot
 * draw. The in-app browser does not share the keychain cookie, so a one-minute,
 * single-use token goes with it (app/api/mobile/open on the server). Without a
 * token the page still opens and asks to sign in.
 */
export async function openOnWeb(path: string): Promise<void> {
  if (Platform.OS === 'web') {
    // The app root is /mikka, not /mikka/ (lib/base-path.ts).
    window.open(`${API_URL}${path.startsWith('/?') || path === '/' ? path.slice(1) : path}`, '_blank', 'noopener')
    return
  }
  const token = await api<{ token: string }>('/api/auth/one-time-token/generate').then(result => result.token).catch(() => null)
  const query = new URLSearchParams({ to: path, ...(token ? { token } : {}) })
  await WebBrowser.openBrowserAsync(`${API_URL}/api/mobile/open?${query}`)
}
