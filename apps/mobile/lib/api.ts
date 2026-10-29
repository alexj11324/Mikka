import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { authClient } from '@/lib/auth'
import { API_URL } from '@/lib/config'
import { endLostSession } from '@/lib/session'

const WORKSPACE_KEY = 'mikka_workspace'

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
  }
}

/** The workspace the person picked in Settings; the server reads it as its `mikka-workspace` cookie. */
export async function savedWorkspace(): Promise<string | null> {
  if (Platform.OS === 'web') return null
  return SecureStore.getItemAsync(WORKSPACE_KEY)
}

export async function saveWorkspace(id: string) {
  if (Platform.OS === 'web') document.cookie = `mikka-workspace=${id}; path=/; samesite=lax`
  else await SecureStore.setItemAsync(WORKSPACE_KEY, id)
}

/**
 * A request to Mikka's API as the signed-in person. On iOS the session cookie
 * comes from the keychain; on web the browser sends its own cookies. A 401
 * means the session is gone: the app signs out and shows the sign-in screen.
 */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  if (Platform.OS !== 'web') {
    const workspace = await savedWorkspace()
    headers.cookie = [await authClient.getCookie(), workspace ? `mikka-workspace=${workspace}` : ''].filter(Boolean).join('; ')
  }
  const response = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
  })
  if (response.status === 401) void endLostSession()
  if (response.status === 204) return undefined as T
  const data = await response.json().catch(() => null) as (T & { error?: string }) | null
  if (!response.ok) throw new ApiError(response.status, data?.error ?? `http${response.status}`)
  return data as T
}
