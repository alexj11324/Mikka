import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { authClient } from '@/lib/auth'
import { currentAccount } from '@/lib/config'
import { endLostSession } from '@/lib/session'
import { apiCache } from './api-cache'
import { mobileTraceHeaders } from './tracing'
import { accountStorageKey } from './server-store'
import { workspaceFromCookie } from './workspace-cookie'
import { presenceScope } from './presence-scope'

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
  }
}
export const apiConnection = () => ({ account: currentAccount(), client: authClient })
export type ApiConnection = ReturnType<typeof apiConnection>

/**
 * The workspace the person picked in Settings; the server reads it as its `mikka-workspace` cookie. On web that cookie
 * is the saved pick (saveWorkspace writes it), so a pushed task's read (lib/task-push.ts) can compare against it.
 */
export async function savedWorkspace(account = currentAccount()): Promise<string | null> {
  if (Platform.OS === 'web') return typeof document === 'undefined' ? null : workspaceFromCookie(document.cookie)
  return SecureStore.getItemAsync(accountStorageKey(account.id, 'workspace'))
}

const workspaceListeners = new Set<() => void>()

/** Runs `listener` whenever the person switches workspace; returns the unsubscribe. */
export function onWorkspaceChange(listener: () => void) {
  workspaceListeners.add(listener)
  return () => { workspaceListeners.delete(listener) }
}

/** The account and cache context an action started in (lib/task-push.ts): it may write only while both are current. */
export type WorkspaceOwner = { account: string; context: number }

/**
 * Saves the workspace pick for the current account. With `owner`, nothing is written unless that account and context
 * are still current. Returns the context this save's own switch produced, or null when it wrote nothing or the
 * context moved while it was writing (then no screen is told to reload).
 */
export async function saveWorkspace(id: string, owner?: WorkspaceOwner): Promise<number | null> {
  const account = currentAccount(), context = apiCache.context()
  if (owner && (owner.account !== account.id || owner.context !== context)) return null
  if (Platform.OS === 'web') document.cookie = `mikka-workspace=${id}; path=/; samesite=lax`
  else await SecureStore.setItemAsync(accountStorageKey(account.id, 'workspace'), id)
  // Every screen's data belongs to the workspace: reload it now, not at the next poll.
  const committed = currentAccount().id === account.id && apiCache.commit(context, () => { for (const listener of workspaceListeners) listener() })
  return committed ? apiCache.context() : null
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

/** `headers` adds request preferences (a task push's x-mikka-workspace-id, lib/task-push.ts); the sign-in headers always win. */
export async function api<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number; headers?: Record<string, string> } = {}, connection: ApiConnection = apiConnection()): Promise<T> {
  const context = apiCache.context()
  const headers: Record<string, string> = { accept: 'application/json', ...init.headers, ...await authHeaders(connection) }
  if (path === '/api/mobile/threads' && (init.method ?? 'GET').toUpperCase() === 'GET' && currentAccount().id === connection.account.id) {
    const proof = presenceScope.token(context)
    if (proof) headers['x-mikka-presence-scope'] = proof
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
