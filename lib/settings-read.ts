import { withBasePath } from '@/lib/base-path'

/** The reads `GET /api/settings/[read]` serves; each is the function a section used to call as a server action. */
export type SettingsRead =
  | 'password' | 'sessions' | 'preferences' | 'saved-logins'
  | 'workspace-general' | 'transfer-targets' | 'deletion-impact'
  | 'app-policy' | 'personal-policy' | 'secrets' | 'e2b-key' | 'usage' | 'billing' | 'credit-billing' | 'card-verification' | 'audit'
  | 'execution-rules' | 'execution-fallbacks' | 'execution-places' | 'bot-models' | 'bots' | 'api-keys'

/**
 * A settings read over GET. The body is what the server action returned, so
 * callers keep their types; a GET runs alongside other requests instead of
 * queuing in front of the page's server actions (saves).
 */
export async function settingsRead<T>(read: SettingsRead, query: Record<string, string | null | undefined> = {}): Promise<T> {
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(query)) if (value) params.set(name, value)
  const search = params.size ? `?${params}` : ''
  const response = await fetch(withBasePath(`/api/settings/${read}${search}`), { cache: 'no-store', credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Settings read ${read} failed`)
  return response.json() as Promise<T>
}
