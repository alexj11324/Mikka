import type { PoolClient } from 'pg'
import { SubscriptionRefusal } from '@mikka/protocol/subscription'

/** Invoked inside every authoritative claim transaction, after its run lock. */
export async function bindSubscriptionClaim(tx: Pick<PoolClient, 'query'>, runId: string, binding: {
  id: string; ownerId: string; workspaceId: string; consumerId: string; connectionRevision: number
}) {
  const result = await tx.query(`INSERT INTO byos_native_runs ("runId","bindingId")
    SELECT r.id,b.id FROM agent_runs r JOIN byos_bindings b ON b.id=$2
    JOIN byos_connections c ON c.id=b."connectionId"
    WHERE r.id=$1 AND r."userId"=$3 AND r."agentId"::text=$5
      AND r.status='preparing' AND r."stopRequestedAt" IS NULL AND r."leaseExpiresAt">now()
      AND b."ownerId"=$3 AND b."workspaceId"=$4 AND b."consumerId"=$5
      AND b."connectionRevision"=$6 AND c.epoch=$6 AND c.state='connected'
      AND c."ownerId"=$3 AND c."workspaceId"=$4
    RETURNING "runId"`, [runId,binding.id,binding.ownerId,binding.workspaceId,binding.consumerId,binding.connectionRevision])
  if (result.rowCount !== 1) throw new SubscriptionRefusal('stale_binding')
}
