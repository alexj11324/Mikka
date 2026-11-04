import type { Pool, PoolClient } from 'pg'
import { notifyLive } from '@/lib/live/notify'
import type { LiveScope } from '@/lib/live/scope'
import { COMPUTER_EVENT_PAGE_SIZE, computerEventCursor, type ComputerEventPage } from './event-page'

/** Take after the writer's business-row locks and hold until COMMIT. Serializing
 * sequence allocation per stream prevents a later commit being skipped by after. */
export async function lockSubagentEvents(client: PoolClient, scope: LiveScope) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`subagent-events:${scope.ownerId}:${scope.workspaceId}`])
}

/** Called only after a transaction which actually appended an event committed. */
export function notifySubagentEvents(scope: LiveScope) {
  notifyLive(scope, [{ kind: 'subagent_events', id: scope.workspaceId }])
}

/** One bounded query; no held connection, server timer or long-lived response. */
export async function readComputerEvents(pool: Pool, scope: LiveScope, cursor: string): Promise<ComputerEventPage> {
  if (computerEventCursor(cursor) === null) throw new Error('Invalid computer event cursor')
  const { rows } = await pool.query<{ seq: string; event: { data: unknown } }>(
    'SELECT seq,event FROM subagent_events WHERE "ownerId"=$1 AND "workspaceId"=$2 AND seq>$3 ORDER BY seq LIMIT $4',
    [scope.ownerId, scope.workspaceId, cursor, COMPUTER_EVENT_PAGE_SIZE + 1],
  )
  const events = rows.slice(0, COMPUTER_EVENT_PAGE_SIZE).map(row => ({ id: String(row.seq), data: row.event.data }))
  return { events, cursor: events.at(-1)?.id ?? cursor, hasMore: rows.length > COMPUTER_EVENT_PAGE_SIZE }
}
