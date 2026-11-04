import type { Pool } from 'pg'
import { notifyLive } from '@/lib/live/notify'
import type { LiveScope } from '@/lib/live/scope'
import { COMPUTER_EVENT_PAGE_SIZE, computerEventCursor, type ComputerEventPage } from './event-page'

export { lockSubagentEvents } from './event-lock'

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
