import 'server-only'
import { pool } from '../db'
import { workspacePool } from '../workspace-db'
import { MCP_REPLY_CHANNEL, subscribeShared } from '../db/listen'
import type { LiveScope } from '../live/scope'
import { observeReplySignals } from './reply-signals'
import type { ReplyChanged } from './reply-wait'

/** Listen before reading. App and workspace notifications are committed with
 * their writes; identical target settings share one physical LISTEN session. */
export function subscribeToCoordinatorReplies(scope: LiveScope, botId: string, changed: ReplyChanged, signal: AbortSignal) {
  return observeReplySignals(async signal => {
    // One budget for both connect+LISTEN handshakes. subscribeShared detaches
    // this setup signal after ready, so it cannot expire a healthy observer.
    const setup = new AbortController(), timer = setTimeout(() => setup.abort(), 5_000)
    const ready = AbortSignal.any([signal, setup.signal])
    try {
      return await Promise.all([
        subscribeShared(pool, MCP_REPLY_CHANNEL, [`bot:${botId}`], ready),
        subscribeShared(workspacePool, MCP_REPLY_CHANNEL, [`member:${scope.workspaceId}:${scope.ownerId}`], ready),
      ])
    } finally { clearTimeout(timer) }
  }, changed, signal)
}
