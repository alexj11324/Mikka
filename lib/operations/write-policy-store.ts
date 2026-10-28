import type { PoolClient } from 'pg'
import { z } from 'zod'
import { OperationError } from './write-error'
import { resolveWritePermission } from './write-policy'

/** Values originate from the authenticated host, not tool arguments. Call in
 * the effect transaction and keep the row locks until the effect is fenced. */
export interface WritePolicyScope { ownerId: string; botId: string | null; workspaceId: string | null; runId: string; action: string }
const scopeSchema = z.object({ ownerId: z.string().min(1), botId: z.uuid().nullable(), workspaceId: z.uuid().nullable(), runId: z.uuid(), action: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/) }).strict().refine(s => (s.botId === null) === (s.workspaceId === null))

export async function lockWritePolicy(tx: PoolClient, input: WritePolicyScope) {
  const scope = scopeSchema.parse(input)
  const key = scope.botId ?? 'coordinator'
  const head = await tx.query<{ workspace_id: string | null; external_write_permissions: unknown; external_write_policy_version: string }>(
    'select workspace_id,external_write_permissions,external_write_policy_version from agent_kit_heads where owner_id=$1 and bot_key=$2 for share', [scope.ownerId, key])
  const policy = head.rows[0]
  if (!policy || policy.workspace_id !== scope.workspaceId || !/^\d+$/.test(String(policy.external_write_policy_version))) throw new OperationError('writePolicyUnavailable')
  const execution = await tx.query<{ status: string; snapshot: unknown }>('select status,snapshot from agent_kit_executions where owner_id=$1 and bot_key=$2 and id=$3 for share', [scope.ownerId, key, scope.runId])
  const row = execution.rows[0]
  const snapshot = z.object({ effectiveTools: z.array(z.string()) }).safeParse(row?.snapshot)
  if (!row || row.status !== 'running' || !snapshot.success || !snapshot.data.effectiveTools.includes(scope.action)) throw new OperationError('writeRunUnavailable')
  return { decision: resolveWritePermission(scope.action, [policy.external_write_permissions]), version: String(policy.external_write_policy_version) }
}
