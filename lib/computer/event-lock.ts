import type { PoolClient } from 'pg'
import type { LiveScope } from '@/lib/live/scope'

/** Take after the writer's business-row locks and hold until COMMIT. Serializing
 * sequence allocation per stream prevents a later commit being skipped by after. */
export async function lockSubagentEvents(client: PoolClient, scope: LiveScope) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`subagent-events:${scope.ownerId}:${scope.workspaceId}`])
}
