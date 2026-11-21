import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { validTraceparent } from '@mikka/protocol/trace-context'
import { hostedApiUpgrade } from '@mikka/protocol/version'
import { authClient } from '@/lib/auth'
import { currentAccount } from '@/lib/config'
import { endLostSession } from '@/lib/session'
import { apiCache } from './api-cache'
import { mobileTraceHeaders } from './tracing'
import { accountStorageKey } from './server-store'
import { presenceScope } from './presence-scope'
import { requireMobileUpdate } from './startup'

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly traceId?: string, cause?: unknown) {
    super(code, { cause })
  }
}

export class ApiTransportError extends Error {
  constructor(readonly reason: 'credentials' | 'network' | 'timeout' | 'invalid_response', cause: unknown, readonly traceId?: string) {
    super(reason, { cause })
  }
}

type ApiRequest = { method?: string; body?: unknown; timeoutMs?: number; diagnostics?: { headers?: Record<string, string> } }
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

export async function api<T>(path: string, init: ApiRequest = {}, connection: ApiConnection = apiConnection()): Promise<T> {
  const context = apiCache.context()
  let authentication: Record<string, string>
  try { authentication = await authHeaders(connection) }
  catch (error) {
    if (init.diagnostics) throw new ApiTransportError('credentials', error)
    throw error
  }
  const headers: Record<string, string> = { ...init.diagnostics?.headers, accept: 'application/json', ...authentication }
  const traceId = validTraceparent(authentication.traceparent) ? authentication.traceparent.slice(3, 35) : undefined
  if (path === '/api/mobile/threads' && (init.method ?? 'GET').toUpperCase() === 'GET' && currentAccount().id === connection.account.id) {
    const proof = presenceScope.token(context)
    if (proof) headers['x-mikka-presence-scope'] = proof
  }
  if (path === '/api/rpc') headers['x-mikka-rpc'] = '1'
  if (path === '/api/rpc' || (path === '/api/inbox' && init.method === 'POST')) {
    // Native fetch has no browser Origin. Bind the cookie and origin to the
    // same saved connection even if the person switches servers in flight.
    if (Platform.OS !== 'web') headers.origin = new URL(connection.account.server.url).origin
  }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${connection.account.server.url}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: Platform.OS === 'web' ? 'include' : 'omit',
      redirect: 'error',
      signal: controller.signal,
    }).catch(error => {
      if (init.diagnostics) throw new ApiTransportError(controller.signal.aborted ? 'timeout' : 'network', error, traceId)
      throw error
    })
    if (!init.diagnostics) clearTimeout(timer)
    // A response for a previous identity must not sign the current person out.
    if (response.status === 401 && currentAccount().id === connection.account.id) apiCache.commit(context, () => { void endLostSession() })
    if (response.status === 204) return undefined as T
    const data = await response.json().catch(error => {
      if (response.ok && init.diagnostics) throw new ApiTransportError(controller.signal.aborted ? 'timeout' : 'invalid_response', error, traceId)
      return null
    }) as (T & { error?: string }) | null
    if (!response.ok) {
      const upgrade = response.status === 426 ? hostedApiUpgrade(data) : null
      if (upgrade && currentAccount().id === connection.account.id) requireMobileUpdate(connection.account.server.url)
      throw new ApiError(response.status, data?.error ?? `http${response.status}`, traceId, upgrade?.cause)
    }
    return data as T
  } finally { clearTimeout(timer) }
}
