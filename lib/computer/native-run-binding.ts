import 'server-only'
import type { Pool } from 'pg'
import { SubscriptionRepository } from '@/lib/subscription-repository'
/** Scheduling reads only metadata. Actual native credentials still require the
 * existing subscriptionRuntime custody/authentication path at execution time. */
export async function nativeRunBinding(pool: Pick<Pool, 'query'>, userId: string, agentId: string, harness: string, workspaceId?: string) {
  const binding = await new SubscriptionRepository(pool).nativeBinding(userId, agentId, harness)
  if (!binding || (workspaceId && binding.workspaceId !== workspaceId)) return null
  const current = await pool.query(`SELECT 1 FROM byos_connections c WHERE c.id=$1 AND c."ownerId"=$2 AND c."workspaceId"=$3
    AND c.state='connected' AND c.epoch=$4 AND c.provider=$5`, [binding.connectionId, userId, binding.workspaceId, binding.connectionRevision, harness === 'codex' ? 'codex' : 'claude'])
  return current.rowCount ? binding : null
}
