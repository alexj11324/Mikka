import 'server-only'
import type { PoolClient } from 'pg'
import type { WorkerDefinitionSnapshot } from '@/lib/agent-kit/worker'
import { lockSubscriptionBinding } from './subscription-binding-lock'

/** Keep the original account binding current through CI claim and response. */
export async function currentCiSubscriptionAuthorized(tx: PoolClient, userId: string, agentId: string | null, definition: WorkerDefinitionSnapshot | null): Promise<boolean> {
  const pinned = definition?.subscription
  if (!pinned) return true
  if (!agentId || process.env.MIKKA_BYOS_ENABLED !== '1') return false
  await lockSubscriptionBinding(tx, userId, agentId, pinned.route)
  const { rows } = await tx.query(`SELECT b.id FROM byos_bindings b JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId" AND c."workspaceId"=b."workspaceId"
    WHERE b.id=$1 AND b."ownerId"=$2 AND b."consumerId"=$3 AND b.route=$4 AND b."modelId"=$5 AND c.state='connected' AND c.epoch=b."connectionRevision"
      AND b.id=(SELECT latest.id FROM byos_bindings latest WHERE latest."ownerId"=$2 AND latest."consumerId"=$3 AND latest.route=$4 ORDER BY latest."createdAt" DESC,latest.id DESC LIMIT 1)
    FOR SHARE OF b,c`, [pinned.bindingId,userId,agentId,pinned.route,pinned.modelId])
  return rows.length === 1
}
