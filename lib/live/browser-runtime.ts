import { withBasePath } from '@/lib/base-path'
import type { LiveRuntime, LiveTicket } from './channel'
import { observeLiveTelemetry } from './telemetry'

// The desktop build replaces this transport only. Shared live invalidation,
// revisions and the consuming components remain identical to the web.
/** Shared visibility subscription for live transport and local display clocks.
 * Subscribers decide their own catch-up; this helper never reads application data. */
export function watchPageVisibility(changed: () => void) {
  document.addEventListener('visibilitychange', changed)
  return () => document.removeEventListener('visibilitychange', changed)
}

export function browserRuntime(workspaceId: string | null): LiveRuntime {
  return {
    async ticket(signal) {
      // An unresolved/inaccessible entity has slow fallback reads, never a guessed channel.
      if (!workspaceId) return null
      const response = await fetch(withBasePath(`/api/live/ticket?workspace=${encodeURIComponent(workspaceId)}`), {
        cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      })
      if (!response.ok) return null
      const value = await response.json() as Partial<LiveTicket>
      return typeof value.url === 'string' && /^wss?:\/\//.test(value.url) && typeof value.protocol === 'string' && typeof value.expiresAt === 'number' ? value as LiveTicket : null
    },
    socket: ticket => new WebSocket(ticket.url, ticket.protocol),
    visible: () => document.visibilityState === 'visible',
    watchVisibility(changed) {
      const unwatch = watchPageVisibility(changed)
      window.addEventListener('online', changed)
      return () => { unwatch(); window.removeEventListener('online', changed) }
    },
    now: Date.now,
    monotonicNow: () => performance.now(),
    later: (callback, milliseconds) => setTimeout(callback, milliseconds),
    cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    observe: observeLiveTelemetry,
  }
}

