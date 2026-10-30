import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { approvalModeSchema, intersectNetworkDomains, CONFIGURABLE_ACTIONS, networkAllowSchema, storedPermissionsSchema, type RunPolicy } from '@mikka/protocol/agent-policy'
import { resolveTrustedRunPolicy } from './policy-snapshot'
import type { MailboxTransactionLease, MailboxTransactionGuard } from '@/lib/mailbox-transaction-guard'
import { writeTransaction } from '@/lib/operations/write-transaction'

export type CliMembershipGuard = (workspaceId: string, userId: string, signal: AbortSignal) => Promise<MailboxTransactionLease>
export const realCliMembershipGuard: CliMembershipGuard = async (workspaceId, userId, signal) => {
  const [{ workspacePool }, { acquireWorkspaceMembership }] = await Promise.all([import('@/lib/workspace-db'), import('@/lib/workspace-membership-guard')])
  return acquireWorkspaceMembership(workspacePool, { workspaceId, userId }, signal)
}

// Computer authority has its existing persisted broker policy. Adding a
// shared protocol action must not silently create a second writable source.
export const cliPolicyLayerSchema = z.strictObject({ permissions: storedPermissionsSchema.omit({ computer_use: true }).optional(), networkAllow: networkAllowSchema.optional(), approvalMode: approvalModeSchema.optional() })
const rank = { deny: 0, ask: 1, allow: 2 } as const
/** Caller identity is authenticated by the host. Workspace membership is
 * separately pinned by cliAgentPolicyGuard through transaction commit. */
export async function lockCliAgentPolicy(tx: PoolClient, userId: string, agentId: string, botId: string | null): Promise<{ policy: RunPolicy; revision: string; workspaceId: string | null; layers: { agent: z.infer<typeof cliPolicyLayerSchema>; worker: z.infer<typeof cliPolicyLayerSchema>; workspace: z.infer<typeof cliPolicyLayerSchema> } }> {
  let workspaceId: string | null = null
  if (botId) {
    const bot = await tx.query<{ workspaceId: string }>('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2 FOR SHARE', [botId,userId])
    if (!bot.rows[0]) throw new Error('agentPolicyUnavailable')
    workspaceId = bot.rows[0].workspaceId
  }
  const scope = { botId, workspaceId, agentId }
  const key = scope.botId ?? 'coordinator'
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`agent-cli-policy:${userId}:${key}`])
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`worker-cli-policy:${scope.agentId}`])
  if (scope.workspaceId) await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`workspace-cli-policy:${scope.workspaceId}`])
  // Materialize empty defaults under the same locks, so legacy runs have a
  // stable generation. No existing computer or external-write choice changes.
  await tx.query(`INSERT INTO agent_kit_heads (owner_id,bot_key,bot_id,workspace_id) VALUES ($1,$2,$3,$4) ON CONFLICT (owner_id,bot_key) DO NOTHING`, [userId,key,scope.botId,scope.workspaceId])
  if (scope.workspaceId) await tx.query(`INSERT INTO workspace_computer_policies ("workspaceId",permission) VALUES ($1,'allow') ON CONFLICT ("workspaceId") DO NOTHING`, [scope.workspaceId])
  const agentRow = await tx.query<{ policy: unknown; version: string; generation: string; workspace: string | null }>(`SELECT cli_run_policy AS policy,cli_run_policy_version AS version,cli_run_policy_generation AS generation,workspace_id AS workspace FROM agent_kit_heads WHERE owner_id=$1 AND bot_key=$2 FOR SHARE`, [userId,key])
  if (!agentRow.rows[0] || agentRow.rows[0].workspace !== scope.workspaceId) throw new Error('agentPolicyUnavailable')
  const agent = cliPolicyLayerSchema.parse(agentRow.rows[0]?.policy ?? {})
  const workerRow = await tx.query<{ policy: unknown; version: string; generation: string; deviceId: string | null }>(`SELECT cli_run_policy AS policy,cli_run_policy_version AS version,cli_run_policy_generation AS generation,"deviceId" FROM agents WHERE id=$1 AND "userId"=$2 FOR SHARE`, [scope.agentId,userId])
  if (!workerRow.rows[0]) throw new Error('agentPolicyUnavailable')
  // A new owned worker can be configured before its first device assignment.
  // Absence gets the bounded local default, never cloud authority. A bound
  // device must still belong to the same owner and remain locked through commit.
  let deviceKind = 'local'
  if (workerRow.rows[0].deviceId) {
    const device = await tx.query<{kind:string}>(`SELECT kind FROM devices WHERE id=$1 AND "ownerId"=$2 FOR SHARE`,[workerRow.rows[0].deviceId,userId])
    if (!device.rows[0]) throw new Error('agentPolicyUnavailable')
    deviceKind = device.rows[0].kind
  }
  const worker = cliPolicyLayerSchema.parse(workerRow.rows[0].policy)
  const workerVersion = String(workerRow.rows[0].version)
  const agentVersion = String(agentRow.rows[0]?.version ?? '0')
  let workspace: z.infer<typeof cliPolicyLayerSchema> = {}, workspaceVersion = '0', workspaceGeneration = 'personal'
  if (scope.workspaceId) {
    const row = await tx.query<{ policy: unknown; version: string; generation: string }>(`SELECT cli_run_policy AS policy,cli_run_policy_version AS version,cli_run_policy_generation AS generation FROM workspace_computer_policies WHERE "workspaceId"=$1 FOR SHARE`, [scope.workspaceId])
    if (!row.rows[0]) throw new Error('agentPolicyUnavailable')
    workspace = cliPolicyLayerSchema.parse(row.rows[0].policy)
    workspaceVersion = String(row.rows[0].version)
    workspaceGeneration = row.rows[0].generation
  }
  if (!/^\d+$/.test(agentVersion) || !/^\d+$/.test(workerVersion) || !/^\d+$/.test(workspaceVersion)) throw new Error('agentPolicyUnavailable')
  const policy = resolveTrustedRunPolicy({ workspace: { permissions: agent.permissions, networkAllow: agent.networkAllow }, personalApprovalMode: agent.approvalMode, environment: deviceKind === 'cloud' ? 'cloud' : 'local' })
  for (const layer of [worker, workspace]) {
    for (const action of CONFIGURABLE_ACTIONS) {
      if (action === 'computer_use') continue
      const override = layer.permissions?.[action]
      if (override && rank[override] < rank[policy.permissions[action]]) policy.permissions[action] = override
    }
    if (layer.networkAllow !== undefined) {
      policy.networkCeiling = policy.networkCeiling === undefined ? [...layer.networkAllow] : intersectNetworkDomains(policy.networkCeiling, layer.networkAllow)
      policy.networkAllow = intersectNetworkDomains(policy.networkAllow, layer.networkAllow)
    }
  }
  if (worker.approvalMode === 'read_only' || workspace.approvalMode === 'read_only') {
    policy.readOnly = true
    policy.permissions.install_dependency = 'deny'
    policy.permissions.write_outside_repo = 'deny'
    policy.permissions.git_push = 'deny'
  }
  const revision = createHash('sha256').update(JSON.stringify(['sandbox-defaults-404-v1',deviceKind,userId,scope.botId,scope.workspaceId,scope.agentId,agentRow.rows[0].generation,agentVersion,workerRow.rows[0].generation,workerVersion,workspaceGeneration,workspaceVersion])).digest('hex')
  return { policy, revision, workspaceId: scope.workspaceId, layers: { agent, worker, workspace } }
}

/** Resolve a run's exact owner, Bot and worker; then use the same policy layer. */
export async function lockCliRunPolicy(tx: PoolClient, runId: string, userId: string) {
  const result = await tx.query<{ botId: string | null; agentId: string }>('SELECT "botId","agentId" FROM agent_runs WHERE id=$1 AND "userId"=$2', [runId,userId])
  const run = result.rows[0]
  if (!run) throw new Error('agentPolicyUnavailable')
  return lockCliAgentPolicy(tx,userId,run.agentId,run.botId)
}

export function cliAgentPolicyGuard(userId: string, agentId: string, botId: string | null, membership: CliMembershipGuard): MailboxTransactionGuard {
  return async (tx, signal) => {
    const current = await lockCliAgentPolicy(tx,userId,agentId,botId)
    if (current.workspaceId) return membership(current.workspaceId,userId,signal)
    return { async check() {}, async close() {} }
  }
}

export async function readCliAgentPolicy(pool: Pick<Pool, 'connect'>, userId: string, agentId: string, botId: string | null, guard: CliMembershipGuard = realCliMembershipGuard) {
  return writeTransaction(pool, tx => lockCliAgentPolicy(tx,userId,agentId,botId), { guard: cliAgentPolicyGuard(userId,agentId,botId,guard) })
}

/** Hold the workspace membership lease through the application transaction. */
export function cliPolicyGuard(runId: string, userId: string, membership: CliMembershipGuard): MailboxTransactionGuard {
  return async (tx, signal) => {
    const current = await lockCliRunPolicy(tx, runId, userId)
    if (current.workspaceId) return membership(current.workspaceId, userId, signal)
    return { async check() {}, async close() {} }
  }
}

/** Read an authenticated run's policy under the same locks used by decisions. */
export async function readCliRunPolicy(pool: Pick<Pool, 'connect'>, runId: string, userId: string, guard: CliMembershipGuard = realCliMembershipGuard) {
  return writeTransaction(pool, tx => lockCliRunPolicy(tx, runId, userId), { guard: cliPolicyGuard(runId,userId,guard) })
}
