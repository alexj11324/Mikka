import 'server-only'
import { pool } from '../db'
import { workspacePool } from '../workspace-db'
import { LiveChannel } from '../live/channel'
import { coordinatorSessionScope } from '../live/coordinator-session'
import { liveGatewayConfig, liveTicket, type LiveScope } from '../live/scope'

/** A bounded server-side subscriber on the existing private channel. The
 * ticket stays inside this request and grants no MCP or business write. */
export function subscribeToCoordinatorReplies(scope: LiveScope, botId: string, changed: () => void) {
  const config = liveGatewayConfig(process.env)
  if (!config) return () => {}
  const channel = new LiveChannel({
    async ticket(signal) {
      const current = await coordinatorSessionScope(pool, workspacePool, scope.ownerId, botId)
      if (signal.aborted || !current || current.workspaceId !== scope.workspaceId) return null
      return liveTicket(current, config)
    },
    socket: ticket => new WebSocket(ticket.url, ticket.protocol),
    visible: () => true,
    watchVisibility: () => () => {},
    now: Date.now,
    later: (callback, milliseconds) => setTimeout(callback, milliseconds),
    cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  })
  return channel.subscribe('coordinator_session', botId, [botId], changed)
}
