import type { PoolClient } from 'pg'
import { z } from 'zod'
import { OperationError } from './write-error'
import { resolveWritePermission, resolveScopedWritePermission, type WriteFallback } from './write-policy'
import { digest, parseDefinition, type DefinitionSnapshot } from '@/lib/agent-kit/definition'
import { supportsWritePlanning } from './write-planning-model'

/** Values originate from the authenticated host, not tool arguments. Call in
 * the effect transaction and keep the row locks until the effect is fenced. */
export interface WritePolicyScope { ownerId: string; botId: string | null; workspaceId: string | null; runId: string; action: string }
const scopeSchema = z.object({ ownerId: z.string().min(1), botId: z.uuid().nullable(), workspaceId: z.uuid().nullable(), runId: z.uuid(), action: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/) }).strict().refine(s => (s.botId === null) === (s.workspaceId === null))

/** readbackOnly is for an already-invoked operation, not another effect grant.
 * withWritePolicy restricts that mode to read/reconcile phases. fallback is the
 * judged default for an action no setting names; defaulted says whether it applied. */
export async function lockWritePolicy(tx: PoolClient, input: WritePolicyScope, options: { allowCompleted?: boolean; readbackOnly?: boolean; fallback?: WriteFallback } = {}) {
  const scope = scopeSchema.parse(input)
  const key = scope.botId ?? 'coordinator'
  const head = await tx.query<{ workspace_id: string | null; active_version: string; external_write_permissions: unknown; external_write_policy_version: string }>(
    'select workspace_id,active_version,external_write_permissions,external_write_policy_version from agent_kit_heads where owner_id=$1 and bot_key=$2 for share', [scope.ownerId, key])
  const policy = head.rows[0]
  if (!policy || policy.workspace_id !== scope.workspaceId || !/^\d+$/.test(String(policy.external_write_policy_version))) throw new OperationError('writePolicyUnavailable')
  const execution = await tx.query<{ status: string; snapshot: DefinitionSnapshot; version_id: string }>('select status,snapshot,version_id from agent_kit_executions where owner_id=$1 and bot_key=$2 and id=$3 for share', [scope.ownerId, key, scope.runId])
  const row = execution.rows[0]
  const snapshot = row?.snapshot
  const readableFailure = options.readbackOnly && row?.status === 'failed'
  if (!row || (row.status !== 'running' && !(options.allowCompleted && row.status === 'completed') && !readableFailure) || !snapshot || !supportsWritePlanning(snapshot.runtime) || row.version_id !== snapshot.revisionId || digest(snapshot.definition) !== snapshot.definitionDigest || !Array.isArray(snapshot.effectiveTools) || !snapshot.effectiveTools.includes(scope.action) || !parseDefinition(snapshot.definition).tools.includes(scope.action as never)) throw new OperationError('writeRunUnavailable')
  const current = await tx.query<{ definition: unknown; digest: string }>('select definition,digest from agent_kit_versions where owner_id=$1 and bot_key=$2 and id=$3', [scope.ownerId, key, policy.active_version])
  const definition = current.rows[0]
  if (!definition || digest(definition.definition) !== definition.digest || !parseDefinition(definition.definition).tools.includes(scope.action as never)) throw new OperationError('writeRunUnavailable')
  if (!scope.workspaceId) return { decision: resolveWritePermission(scope.action, [policy.external_write_permissions], options.fallback), defaulted: resolveWritePermission(scope.action, [policy.external_write_permissions], 'allow') !== resolveWritePermission(scope.action, [policy.external_write_permissions], 'ask'), version: String(policy.external_write_policy_version) }
  // Serializes absence as well as existing rows with the workspace settings writer.
  await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`workspace-external-write:${scope.workspaceId}`])
  const workspace = await tx.query<{ external_write_permissions: unknown; external_write_policy_version: string }>('select external_write_permissions,external_write_policy_version from workspace_computer_policies where "workspaceId"=$1 for share', [scope.workspaceId])
  const override = workspace.rows[0]
  const revision = override ? String(override.external_write_policy_version) : '0'
  if (!/^\d+$/.test(revision)) throw new OperationError('writePolicyUnavailable')
  return { decision: resolveScopedWritePermission(scope.action, policy.external_write_permissions, override?.external_write_permissions ?? {}, options.fallback), defaulted: resolveScopedWritePermission(scope.action, policy.external_write_permissions, override?.external_write_permissions ?? {}, 'allow') !== resolveScopedWritePermission(scope.action, policy.external_write_permissions, override?.external_write_permissions ?? {}, 'ask'), version: `${policy.external_write_policy_version}:${revision}` }
}
