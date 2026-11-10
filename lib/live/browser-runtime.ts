import { withBasePath } from '@/lib/base-path'
import type { LiveRuntime, LiveTicket } from './channel'
import { observeLiveTelemetry } from './telemetry'
import { selectedLiveURLAllowed, selectedWebServer, webSelectionVersion } from '../web-connection/selection'
import { invalidateResourceAccessCaches } from '../swr/persistent-cache'

// The desktop build replaces this transport only. Shared live invalidation,
// revisions and the consuming components remain identical to the web.
/** Shared visibility subscription for live transport and local display clocks.
 * Subscribers decide their own catch-up; this helper never reads application data. */
export function watchPageVisibility(changed: () => void) {
  document.addEventListener('visibilitychange', changed)
  return () => document.removeEventListener('visibilitychange', changed)
}

export function browserRuntime(workspaceId: string | null): LiveRuntime {
  const server = selectedWebServer(), generation = webSelectionVersion()
  return {
    async ticket(signal) {
      // An unresolved/inaccessible entity has slow fallback reads, never a guessed channel.
      if (!workspaceId || generation !== webSelectionVersion()) return null
      const response = await fetch(withBasePath(`/api/live/ticket?workspace=${encodeURIComponent(workspaceId)}`), {
        cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      })
      if (!response.ok) {
        if (generation === webSelectionVersion() && [401,403].includes(response.status)) await invalidateResourceAccessCaches(workspaceId)
        return null
      }
      const value = await response.json() as Partial<LiveTicket> & { accessProof?: string }
      if (generation === webSelectionVersion() && typeof value.accessProof === 'string' && /^[a-f0-9]{64}$/.test(value.accessProof))
        await invalidateResourceAccessCaches(workspaceId,value.accessProof)
      return generation === webSelectionVersion() && typeof value.url === 'string' && selectedLiveURLAllowed(value.url, server)
        && typeof value.protocol === 'string' && typeof value.expiresAt === 'number' ? value as LiveTicket : null
    },
    socket: ticket => {
      if (generation !== webSelectionVersion() || !selectedLiveURLAllowed(ticket.url, server)) throw new Error('web_connection_session_changed')
      return new WebSocket(ticket.url, ticket.protocol)
    },
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
    invalidateAccess: id => { if (id === workspaceId) void invalidateResourceAccessCaches(id) },
  }
}

