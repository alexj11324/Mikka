// Live push for the app (#1212): the web's channel (lib/live/channel.ts) on React Native.
// Same ticket route (/api/live/ticket, signed in by the session cookie), same gateway
// socket, same keys. Nothing here reads the app's data: a key only tells a screen to
// read its own path again. Kept free of react-native so it runs under node:test.
import { LiveChannels } from '../../../lib/live/channels'
import type { LiveRuntime, LiveSocket, LiveSubscriptionOptions, LiveTicket } from '../../../lib/live/channel'
import type { LiveKind } from '../../../lib/live/events'
import { liveSocketUrl } from './server-discovery'

export { LIVE_FALLBACK_MS } from '../../../lib/live/channel'
export type { LiveKind } from '../../../lib/live/events'

/** A key with no known scope yet: it reads every minute (the channel's fallback) and asks for no ticket. */
export const UNRESOLVED_LIVE_ID = '00000000-0000-4000-8000-000000000000'

/** react-native's AppState, as far as the channel needs it. */
export interface AppStateLike {
  currentState: string | null | undefined
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void }
}

export interface LiveClientDeps {
  appState: AppStateLike
  /** GET /api/live/ticket?workspace=<id> as the signed-in person; the parsed body, or null when refused. */
  ticket(workspaceId: string, signal: AbortSignal): Promise<unknown>
  socket(url: string, protocol: string): LiveSocket
  now?: () => number
  monotonicNow?: () => number
  later?: (callback: () => void, milliseconds: number) => unknown
  cancel?: (timer: unknown) => void
  invalidateAccess?: (workspaceId:string) => void
}

/** One key a screen listens to: what changed (`kind`, `id`) on which owner/workspace channel (`scope`). */
export type LiveRef = { kind: LiveKind; id: string | null | undefined; scope: string | null | undefined }

/** Only the background stops the socket; iOS passes through `inactive` for a moment on every app switch. */
export const appInFront = (state: string | null | undefined) => state !== 'background'

export function validTicket(value: unknown): LiveTicket | null {
  if (!value || typeof value !== 'object') return null
  const ticket = value as Partial<LiveTicket>
  return liveSocketUrl(ticket.url) && typeof ticket.protocol === 'string' && ticket.protocol
    && typeof ticket.expiresAt === 'number' && Number.isFinite(ticket.expiresAt) ? ticket as LiveTicket : null
}

/** The channel's runtime for one scope. A null scope never asks for a ticket: it only falls back to a read a minute. */
export function liveRuntime(deps: LiveClientDeps, workspaceId: string | null): LiveRuntime {
  const later = deps.later ?? ((callback, milliseconds) => setTimeout(callback, milliseconds))
  const cancel = deps.cancel ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  return {
    async ticket(signal) {
      if (!workspaceId) return null
      try { return validTicket(await deps.ticket(workspaceId, signal)) } catch { return null }
    },
    socket: ticket => deps.socket(ticket.url, ticket.protocol),
    visible: () => appInFront(deps.appState.currentState),
    watchVisibility(changed) {
      let front = appInFront(deps.appState.currentState)
      const subscription = deps.appState.addEventListener('change', state => {
        // active → inactive → background is one change for the channel, not three.
        if (appInFront(state) === front) return
        front = appInFront(state)
        changed()
      })
      return () => subscription.remove()
    },
    now: deps.now ?? Date.now,
    monotonicNow: deps.monotonicNow,
    later,
    cancel,
    invalidateAccess: id => { if (id === workspaceId) deps.invalidateAccess?.(id) },
  }
}

export type LiveSpecOptions = LiveSubscriptionOptions

/**
 * The app's live connections: one per scope (the person's home channel, the open
 * workspace's), shared by every screen. While connected, a key re-reads its screen
 * and nothing polls; while disconnected or before the gateway lists a key's kind,
 * each key re-reads every LIVE_FALLBACK_MS. In the background no socket stays
 * open and nothing reads; coming back reads every listened key once, then reconnects.
 */
export function createLiveClient(deps: LiveClientDeps) {
  let channels = new LiveChannels(scope => liveRuntime(deps, scope))
  let generation = 0
  const watchers = new Set<() => void>()
  return {
    /** Changes on reset: a mounted screen subscribes again on the new connections. */
    generation: () => generation,
    watch(listener: () => void) { watchers.add(listener); return () => { watchers.delete(listener) } },
    /** Listens to `refs` and calls `refresh` (once per burst) when one changes. Returns the stop. */
    subscribe(refs: readonly LiveRef[], key: string, refresh: () => unknown, options: LiveSpecOptions = {}) {
      const current = channels
      const handles = refs.flatMap(ref => ref.id ? [current.subscribe(ref.scope ?? null, ref.kind, ref.id, [key], () => refresh(), options)] : [])
      return Object.assign(() => { for (const stop of handles) stop() }, {
        update(next: LiveSpecOptions) { for (const handle of handles) handle.update(next) },
      })
    },
    /** Signing out: every socket closes; the next account starts its own. */
    reset() {
      channels.dispose()
      channels = new LiveChannels(scope => liveRuntime(deps, scope))
      generation++
      for (const listener of watchers) listener()
    },
  }
}

export type LiveClient = ReturnType<typeof createLiveClient>

const PENDING_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // lib/pending-action-view.ts
const SHORT_LIVED = ['credential_operation', 'browser_operation']

/** When the soonest proposal expires (lib/live/pending-action-cache.ts): no write marks it, so the list reads once more then. */
export function pendingActionsDeadline(items: readonly { action: string; createdAt: string }[] | null | undefined, now = Date.now()) {
  const expiries = (items ?? []).map(item => Date.parse(item.createdAt) + (SHORT_LIVED.includes(item.action) ? 5 * 60_000 : PENDING_ACTION_TTL_MS))
    .filter(at => Number.isFinite(at) && at > now)
  if (!expiries.length) return null
  const at = Math.min(...expiries)
  return { at: new Date(at).toISOString(), afterMs: at - now }
}
