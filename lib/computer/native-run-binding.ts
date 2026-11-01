import 'server-only'
import type { Pool } from 'pg'
import { SubscriptionRepository } from '@/lib/subscription-repository'
/** Scheduling reads only metadata. Actual native credentials still require the
 * existing subscriptionRuntime custody/authentication path at execution time. */
export async function nativeRunBinding(pool: Pick<Pool, 'query'>, userId: string, agentId: string, harness: string, workspaceId?: string, bindingId?: string) {
  if (harness !== 'codex' && harness !== 'claude_code') return null
  const repository = new SubscriptionRepository(pool)
  const binding = bindingId ? await repository.binding(userId, bindingId) : await repository.nativeBinding(userId, agentId, harness)
  if (!binding || binding.consumerId !== agentId || binding.route !== (harness === 'codex' ? 'codex_cli' : 'claude_code_cli') || (workspaceId && binding.workspaceId !== workspaceId)) return null
  // The connection is the owner's from any workspace; the binding is the Bot's (decision 2026-10-31-2130).
  const current = await pool.query(`SELECT 1 FROM byos_connections c WHERE c.id=$1 AND c."ownerId"=$2
    AND c.state='connected' AND c.paused=false AND c.epoch=$3 AND c.provider=$4`, [binding.connectionId, userId, binding.connectionRevision, harness === 'codex' ? 'codex' : 'claude'])
  return current.rowCount ? binding : null
}
