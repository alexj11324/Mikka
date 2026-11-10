import { useEffect, useRef, useSyncExternalStore } from 'react'
import { AppState, Platform } from 'react-native'
import { apiConnection, authHeaders } from '@/lib/api'
import { onServerChange } from '@/lib/config'
import { createLiveClient, type LiveRef, type LiveSpecOptions } from './live-client'
import { presenceScope } from './presence-scope'
import { apiCache } from './api-cache'
import type { PresenceProof } from '../../../lib/live/presence'

export { UNRESOLVED_LIVE_ID, type LiveRef } from './live-client'
export { listRef } from './live-keys'

const TICKET_TIMEOUT_MS = 15_000

/** The live ticket for one owner/workspace channel, as the signed-in person (the same session cookie `api` sends). */
async function ticket(workspaceId: string, signal: AbortSignal): Promise<unknown> {
  apiCache.expireAccess()
  const context = apiCache.context()
  const connection = apiConnection()
  const request = presenceScope.begin()
  const requestedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, TICKET_TIMEOUT_MS)
  signal.addEventListener('abort', abort)
  try {
    const response = await fetch(`${connection.account.server.url}/api/live/ticket?workspace=${encodeURIComponent(workspaceId)}`, {
      headers: { accept: 'application/json', ...await authHeaders(connection) },
      credentials: Platform.OS === 'web' ? 'include' : 'omit',
      redirect: 'error',
      signal: controller.signal,
    })
    const value = response.ok ? await response.json() : null
    if (!controller.signal.aborted && !signal.aborted) apiCache.commit(context,() => {
      if ([401,403].includes(response.status)) apiCache.clear()
      else if (typeof value?.accessProof === 'string' && /^[a-f0-9]{64}$/.test(value.accessProof))
        apiCache.accessProof(workspaceId,value.accessProof,typeof value.accessExpiresAt === 'string' ? value.accessExpiresAt : null, typeof value.accessExpiresAfterMs === 'number' ? value.accessExpiresAfterMs : null, requestedAt)
    })
    if (!controller.signal.aborted && !signal.aborted) presenceScope.remember(workspaceId, value, request)
    return value
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

export const live = createLiveClient({
  appState: AppState,
  ticket,
  socket: (url, protocol) => new WebSocket(url, protocol),
  invalidateAccess: () => apiCache.clear(),
  monotonicNow: typeof performance !== 'undefined' && typeof performance.now === 'function' ? () => performance.now() : undefined,
})
onServerChange(() => { presenceScope.clear(); live.reset() })

/** A deadline as the server observed it, for a read that started at `requestedAt` (performance clock). */
export type LiveDeadline = { at: string; afterMs: number } | null | undefined
export type LiveSpec = { refs: readonly LiveRef[]; minIntervalMs?: number; deadline?: LiveDeadline; presence?: PresenceProof | null }

const clock = () => typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()

/** The channel's deadline, anchored at the request start so a slow answer never postpones it. */
export function anchoredDeadline(deadline: LiveDeadline, requestedAt: number | null, now = clock()): LiveSpecOptions['deadline'] {
  if (!deadline || !Number.isFinite(deadline.afterMs)) return null
  const elapsed = requestedAt === null ? Infinity : Math.max(0, now - requestedAt)
  return { at: deadline.at, afterMs: Math.max(0, deadline.afterMs - elapsed), ...(requestedAt !== null && deadline.afterMs > 0 ? { observation: requestedAt } : {}) }
}

/**
 * Calls `refresh` when one of `spec.refs` changes on the server (after its COMMIT).
 * A ref with no id listens to nothing; one with no scope re-reads every minute.
 */
export function useLive(spec: LiveSpec, refresh: () => unknown, requestedAt: number | null = null) {
  const generation = useSyncExternalStore(live.watch, live.generation, live.generation)
  const latest = useRef(refresh)
  latest.current = refresh
  const key = useRef(`live:${Math.random().toString(36).slice(2)}`).current
  const refs = JSON.stringify(spec.refs.filter(ref => ref.id).map(ref => [ref.kind, ref.id, ref.scope ?? null]))
  const options = { minIntervalMs: spec.minIntervalMs ?? 0, deadline: anchoredDeadline(spec.deadline, requestedAt), presence: spec.presence }
  const timing = useRef(options)
  timing.current = options
  const handle = useRef<ReturnType<typeof live.subscribe> | null>(null)
  useEffect(() => {
    const parsed = (JSON.parse(refs) as [LiveRef['kind'], string, string | null][]).map(([kind, id, scope]) => ({ kind, id, scope }))
    if (!parsed.length) return
    const subscription = live.subscribe(parsed, key, () => latest.current(), timing.current)
    handle.current = subscription
    return () => { subscription(); if (handle.current === subscription) handle.current = null }
  }, [refs, key, generation])
  const deadlineAt = options.deadline?.at ?? null
  const observation = options.deadline?.observation
  const presenceRequired = options.presence !== undefined, presenceToken = options.presence?.token, presenceExpiry = options.presence?.expiresAt
  useEffect(() => { handle.current?.update(timing.current) }, [options.minIntervalMs, deadlineAt, observation, presenceRequired, presenceToken, presenceExpiry])
}
