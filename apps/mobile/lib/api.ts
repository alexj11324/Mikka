import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { authClient } from '@/lib/auth'
import { currentAccount } from '@/lib/config'
import { endLostSession } from '@/lib/session'
import { apiCache } from './api-cache'
import { mobileTraceHeaders } from './tracing'
import { accountStorageKey } from './server-store'
import { presenceScope } from './presence-scope'

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
  }
}
export const apiConnection = () => ({ account: currentAccount(), client: authClient })
export type ApiConnection = ReturnType<typeof apiConnection>

/** The workspace the person picked in Settings; the server reads it as its `mikka-workspace` cookie. */
export async function savedWorkspace(account = currentAccount()): Promise<string | null> {
  if (Platform.OS === 'web') return null
  return SecureStore.getItemAsync(accountStorageKey(account.id, 'workspace'))
}

const workspaceListeners = new Set<() => void>()

/** Runs `listener` whenever the person switches workspace; returns the unsubscribe. */
export function onWorkspaceChange(listener: () => void) {
  workspaceListeners.add(listener)
  return () => { workspaceListeners.delete(listener) }
}

export async function saveWorkspace(id: string) {
  const account = currentAccount(), context = apiCache.context()
  if (Platform.OS === 'web') document.cookie = `mikka-workspace=${id}; path=/; samesite=lax`
  else await SecureStore.setItemAsync(accountStorageKey(account.id, 'workspace'), id)
  // Every screen's data belongs to the workspace: reload it now, not at the next poll.
  apiCache.commit(context, () => { for (const listener of workspaceListeners) listener() })
}

/**
 * A request to Mikka's API as the signed-in person. On iOS the session cookie
 * comes from the keychain; on web the browser sends its own cookies. A 401
 * means the session is gone: the app signs out and shows the sign-in screen.
 */
/** The headers that sign a request as the person (iOS: the session and workspace cookies; the web's browser sends its own). */
export async function authHeaders(connection: ApiConnection = apiConnection()): Promise<Record<string, string>> {
  const tracing = mobileTraceHeaders()
  if (Platform.OS === 'web') return tracing
  const workspace = await savedWorkspace(connection.account)
  return { ...tracing, cookie: [await connection.client.getCookie(), workspace ? `mikka-workspace=${workspace}` : ''].filter(Boolean).join('; ') }
}

/** A request that has not answered by then fails, so nothing waits on it forever (a send shows 重试). */
export const REQUEST_TIMEOUT_MS = 30_000

export async function api<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}, connection: ApiConnection = apiConnection()): Promise<T> {
  const context = apiCache.context()
  const headers: Record<string, string> = { accept: 'application/json', ...await authHeaders(connection) }
  if (path === '/api/mobile/threads' && (init.method ?? 'GET').toUpperCase() === 'GET' && currentAccount().id === connection.account.id) {
    const proof = presenceScope.token(context)
    if (proof) headers['x-mikka-presence-scope'] = proof
  }
  if (path === '/api/rpc') {
    headers['x-mikka-rpc'] = '1'
    // Native fetch has no browser Origin. Bind the cookie and origin to the
    // same saved connection even if the person switches servers in flight.
    if (Platform.OS !== 'web') headers.origin = new URL(connection.account.server.url).origin
  }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS)
  const response = await fetch(`${connection.account.server.url}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
    redirect: 'error',
    signal: controller.signal,
  }).finally(() => clearTimeout(timer))
  // A response for a previous identity must not sign the current person out.
  if (response.status === 401 && currentAccount().id === connection.account.id) apiCache.commit(context, () => { void endLostSession() })
  if (response.status === 204) return undefined as T
  const data = await response.json().catch(() => null) as (T & { error?: string }) | null
  if (!response.ok) throw new ApiError(response.status, data?.error ?? `http${response.status}`)
  return data as T
}
