import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { JSONContent } from '@tiptap/core'
import { z } from 'zod'
import { approvalModeSchema, intersectNetworkDomains, CONFIGURABLE_ACTIONS, networkAllowSchema, storedPermissionsSchema } from '@mikka/protocol/agent-policy'
import { resolveTrustedRunPolicy } from './policy-snapshot'
import type { MailboxTransactionLease, MailboxTransactionGuard } from '@/lib/mailbox-transaction-guard'
import { writeTransaction } from '@/lib/operations/write-transaction'
import { readIssueMetadata } from '@/lib/issue-metadata'

/** Derived from the stored task and its trusted workspace relation, never a tool argument. */
export interface CliTaskScope { issueId: string; scopeVersion: number; workspaceId: string | null; hierarchy?: CliHierarchy }
const hierarchySchema = z.strictObject({ workspaceId: z.uuid(), teamId: z.uuid(), projectId: z.uuid().nullable() })
export type CliHierarchy = z.infer<typeof hierarchySchema>

/** Pin a run to stored team/shared-project UUIDs, never a mutable project label. */
async function lockCliHierarchy(tx: PoolClient, userId: string, runId: string, task: CliTaskScope): Promise<CliHierarchy | undefined> {
  if (!task.workspaceId) return undefined
  const { rows: [run] } = await tx.query<{ hierarchy: unknown }>('SELECT cli_policy_hierarchy AS hierarchy FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [runId,userId])
  if (!run) throw new Error('agentPolicyUnavailable')
  const { workspacePool } = await import('@/lib/workspace-db')
  const { rows: [team] } = await workspacePool.query<{ teamId: string }>(`SELECT l."teamId" FROM mikka_team_issues l JOIN mikka_teams t ON t.id=l."teamId" AND t."workspaceId"=l."workspaceId" WHERE l."issueId"=$1 AND l."workspaceId"=$2`,[task.issueId,task.workspaceId])
  if (!team) throw new Error('agentPolicyUnavailable')
  const { rows: projects } = await workspacePool.query<{ id: string }>(`SELECT DISTINCT p.id FROM workspace_projects p JOIN mikka_team_projects l ON l."projectId"=p.id WHERE p."issueIds" ? $1 AND l."teamId"=$2 AND l."workspaceId"=$3`,[task.issueId,team.teamId,task.workspaceId])
  if (projects.length > 1) throw new Error('agentPolicyUnavailable')
  const hierarchy = hierarchySchema.parse({ workspaceId: task.workspaceId,teamId:team.teamId,projectId:projects[0]?.id ?? null })
  if (run.hierarchy != null) {
    const frozen = hierarchySchema.parse(run.hierarchy)
    // Membership in a stricter team/project may change without issue.scopeVersion.
    // Never keep authorizing with an older, wider admitted hierarchy.
    if (frozen.workspaceId !== hierarchy.workspaceId || frozen.teamId !== hierarchy.teamId || frozen.projectId !== hierarchy.projectId) throw new Error('agentPolicyChanged')
    return frozen
  }
  await tx.query('UPDATE agent_runs SET cli_policy_hierarchy=$3 WHERE id=$1 AND "userId"=$2', [runId,userId,hierarchy])
  return hierarchy
}
export async function lockCliTaskScope(tx: PoolClient, userId: string, issueId: string): Promise<CliTaskScope> {
  const { rows: [task] } = await tx.query<{ userId: string; scope: string; scopeVersion: number; content: JSONContent }>('SELECT "userId",scope,"scopeVersion",content FROM issues WHERE id=$1', [issueId])
  if (!task || readIssueMetadata(task.content).deletedAt) throw new Error('agentPolicyUnavailable')
  if (task.scope === 'personal') {
    if (task.userId !== userId) throw new Error('agentPolicyUnavailable')
    return { issueId, scopeVersion: task.scopeVersion, workspaceId: null }
  }
  const { workspacePool } = await import('@/lib/workspace-db')
  const { rows: [link] } = await workspacePool.query<{ workspaceId: string }>('SELECT "workspaceId" FROM mikka_team_issues WHERE "issueId"=$1', [issueId])
  if (task.scope !== 'workspace' || !link) throw new Error('agentPolicyUnavailable')
  return { issueId, scopeVersion: task.scopeVersion, workspaceId: link.workspaceId }
}

export type CliMembershipGuard = (workspaceId: string, userId: string, signal: AbortSignal) => Promise<MailboxTransactionLease>
export const realCliMembershipGuard: CliMembershipGuard = async (workspaceId, userId, signal) => {
  const [{ workspacePool }, { acquireWorkspaceMembership }] = await Promise.all([import('@/lib/workspace-db'), import('@/lib/workspace-membership-guard')])
  return acquireWorkspaceMembership(workspacePool, { workspaceId, userId }, signal)
}

// Computer authority has its existing persisted broker policy. Adding a
// shared protocol action must not silently create a second writable source.
export const cliPolicyValuesSchema = z.strictObject({ permissions: storedPermissionsSchema.omit({ computer_use: true }).optional(), networkAllow: networkAllowSchema.optional(), approvalMode: approvalModeSchema.optional() })
export const cliPolicyLayerSchema = cliPolicyValuesSchema.extend({ defaults: cliPolicyValuesSchema.optional() })
type CliPolicyValues = z.infer<typeof cliPolicyValuesSchema>
// Defaults replace scalar/list fields; permission choices inherit per action.
const mergeCliPolicyValues = (base: CliPolicyValues, next: CliPolicyValues): CliPolicyValues => ({ ...base, ...next, ...(next.permissions ? { permissions: { ...base.permissions, ...next.permissions } } : {}) })
const rank = { deny: 0, ask: 1, allow: 2 } as const
/** Caller identity is authenticated by the host. Workspace membership is
 * separately pinned by cliAgentPolicyGuard through transaction commit. */
export async function lockCliAgentPolicy(tx: PoolClient, userId: string, agentId: string, botId: string | null, task?: CliTaskScope) {
  let workspaceId: string | null = null
  if (botId) {
    const bot = await tx.query<{ workspaceId: string }>('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2 FOR SHARE', [botId,userId])
    if (!bot.rows[0]) throw new Error('agentPolicyUnavailable')
    workspaceId = bot.rows[0].workspaceId
  }
  const scope = { botId, workspaceId, agentId }
  const workspaceIds = [...new Set([workspaceId, task?.workspaceId].filter((id): id is string => !!id))].sort()
  const primaryWorkspaceId = workspaceId ?? task?.workspaceId ?? null
  const key = scope.botId ?? 'coordinator'
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`agent-cli-policy:${userId}:${key}`])
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`worker-cli-policy:${scope.agentId}`])
  for (const id of workspaceIds) await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`workspace-cli-policy:${id}`])
  // Materialize empty defaults under the same locks, so legacy runs have a
  // stable generation. No existing computer or external-write choice changes.
  await tx.query(`INSERT INTO agent_kit_heads (owner_id,bot_key,bot_id,workspace_id) VALUES ($1,$2,$3,$4) ON CONFLICT (owner_id,bot_key) DO NOTHING`, [userId,key,scope.botId,scope.workspaceId])
  for (const id of workspaceIds) await tx.query(`INSERT INTO workspace_computer_policies ("workspaceId",permission) VALUES ($1,'allow') ON CONFLICT ("workspaceId") DO NOTHING`, [id])
  const agentRow = await tx.query<{ policy: unknown; version: string; generation: string; workspace: string | null }>(`SELECT cli_run_policy AS policy,cli_run_policy_version AS version,cli_run_policy_generation AS generation,workspace_id AS workspace FROM agent_kit_heads WHERE owner_id=$1 AND bot_key=$2 FOR SHARE`, [userId,key])
  if (!agentRow.rows[0] || agentRow.rows[0].workspace !== scope.workspaceId) throw new Error('agentPolicyUnavailable')
  const agent = cliPolicyValuesSchema.parse(agentRow.rows[0]?.policy ?? {})
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
  const worker = cliPolicyValuesSchema.parse(workerRow.rows[0].policy)
  const workerVersion = String(workerRow.rows[0].version)
  const agentVersion = String(agentRow.rows[0]?.version ?? '0')
  let workspace: z.infer<typeof cliPolicyLayerSchema> = {}
  const workspaceLayers: z.infer<typeof cliPolicyLayerSchema>[] = []
  const workspaceById = new Map<string, z.infer<typeof cliPolicyLayerSchema>>()
  const workspaceVersions: string[][] = []
  for (const id of workspaceIds) {
    const row = await tx.query<{ policy: unknown; version: string; generation: string }>(`SELECT cli_run_policy AS policy,cli_run_policy_version AS version,cli_run_policy_generation AS generation FROM workspace_computer_policies WHERE "workspaceId"=$1 FOR SHARE`, [id])
    if (!row.rows[0]) throw new Error('agentPolicyUnavailable')
    const layer = cliPolicyLayerSchema.parse(row.rows[0].policy)
    workspaceLayers.push(layer); workspaceById.set(id, layer)
    if (id === primaryWorkspaceId) workspace = layer
    const version = String(row.rows[0].version)
    if (!/^\d+$/.test(version)) throw new Error('agentPolicyUnavailable')
    workspaceVersions.push([id, row.rows[0].generation, version])
  }
  if (!/^\d+$/.test(agentVersion) || !/^\d+$/.test(workerVersion)) throw new Error('agentPolicyUnavailable')
  const scopedLayers: z.infer<typeof cliPolicyLayerSchema>[] = []
  const scopeVersions: string[][] = []
  const hierarchy = task?.hierarchy
  const scopeLayers: { team?: z.infer<typeof cliPolicyLayerSchema>; project?: z.infer<typeof cliPolicyLayerSchema> } = {}
  for (const kind of ['team','project'] as const) {
    const id = hierarchy?.[kind === 'team' ? 'teamId' : 'projectId']
    if (!id || !hierarchy) continue
    await tx.query(`INSERT INTO cli_scope_policies(kind,scope_id,workspace_id) VALUES($1,$2,$3) ON CONFLICT(kind,scope_id) DO NOTHING`, [kind,id,hierarchy.workspaceId])
    const { rows: [row] } = await tx.query<{ workspaceId: string; policy: unknown; version: string; generation: string }>(`SELECT workspace_id AS "workspaceId",cli_run_policy AS policy,cli_run_policy_version AS version,cli_run_policy_generation AS generation FROM cli_scope_policies WHERE kind=$1 AND scope_id=$2 FOR SHARE`,[kind,id])
    if (!row || row.workspaceId !== hierarchy.workspaceId || !/^\d+$/.test(String(row.version))) throw new Error('agentPolicyUnavailable')
    const layer = cliPolicyLayerSchema.parse(row.policy)
    scopedLayers.push(layer); scopeLayers[kind] = layer
    scopeVersions.push([kind,id,row.generation,String(row.version)])
  }
  let defaults: CliPolicyValues = {}
  const defaultSources: { scope: 'workspace' | 'team' | 'project'; scopeId: string; defaults: CliPolicyValues }[] = []
  const inherit = (scope: 'workspace' | 'team' | 'project', scopeId: string, layer?: z.infer<typeof cliPolicyLayerSchema>) => {
    if (!layer?.defaults) return
    defaults = mergeCliPolicyValues(defaults, layer.defaults)
    defaultSources.push({ scope, scopeId, defaults: layer.defaults })
  }
  // Locks/revisions keep UUID order. Inheritance instead follows specificity:
  // the task workspace overrides its Bot's workspace, then its team/project.
  for (const id of new Set([workspaceId, task?.workspaceId].filter((id): id is string => !!id))) inherit('workspace', id, workspaceById.get(id))
  if (hierarchy) {
    inherit('team', hierarchy.teamId, scopeLayers.team)
    if (hierarchy.projectId) inherit('project', hierarchy.projectId, scopeLayers.project)
  }
  const configured = mergeCliPolicyValues(defaults, agent)
  const policy = resolveTrustedRunPolicy({ workspace: { permissions: configured.permissions, networkAllow: configured.networkAllow }, personalApprovalMode: configured.approvalMode, environment: deviceKind === 'cloud' ? 'cloud' : 'local' })
  for (const layer of [worker, ...workspaceLayers, ...scopedLayers]) {
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
  if ([worker, ...workspaceLayers, ...scopedLayers].some(layer => layer.approvalMode === 'read_only')) {
    policy.readOnly = true
    policy.permissions.install_dependency = 'deny'
    policy.permissions.write_outside_repo = 'deny'
    policy.permissions.git_push = 'deny'
  }
  const revision = createHash('sha256').update(JSON.stringify(['sandbox-task-policy-v2',deviceKind,userId,scope.botId,scope.workspaceId,scope.agentId,agentRow.rows[0].generation,agentVersion,workerRow.rows[0].generation,workerVersion,workspaceVersions,scopeVersions,task ?? null])).digest('hex')
  return { policy, revision, workspaceId: primaryWorkspaceId, workspaceIds, hierarchy, defaults, defaultSources, policySnapshotRequired: [...workspaceLayers, ...scopedLayers].some(layer => Object.keys(layer).length > 0), layers: { agent, worker, workspace, ...scopeLayers } }
}

/** Resolve a run's exact owner, Bot and worker; then use the same policy layer. */
export async function lockCliRunPolicy(tx: PoolClient, runId: string, userId: string) {
  const result = await tx.query<{ botId: string | null; agentId: string; issueId: string | null }>('SELECT "botId","agentId","issueId" FROM agent_runs WHERE id=$1 AND "userId"=$2', [runId,userId])
  const run = result.rows[0]
  if (!run) throw new Error('agentPolicyUnavailable')
  const task = run.issueId ? await lockCliTaskScope(tx,userId,run.issueId) : undefined
  if (task) { const hierarchy = await lockCliHierarchy(tx,userId,runId,task); if (hierarchy) task.hierarchy = hierarchy }
  return lockCliAgentPolicy(tx,userId,run.agentId,run.botId,task)
}

async function policyMemberships(current: Awaited<ReturnType<typeof lockCliAgentPolicy>>, userId: string, signal: AbortSignal, membership: CliMembershipGuard): Promise<MailboxTransactionLease> {
  const leases: MailboxTransactionLease[] = []
  try {
    for (const id of current.workspaceIds) leases.push(await membership(id,userId,signal))
    return {
      workspaceClient: leases[current.workspaceIds.indexOf(current.workspaceId ?? '')]?.workspaceClient,
      signal: AbortSignal.any([signal, ...leases.flatMap(lease => lease.signal ? [lease.signal] : [])]),
      async check() { for (const lease of leases) await lease.check() },
      async close() { await Promise.all(leases.map(lease => lease.close())) },
    }
  } catch (error) { await Promise.all(leases.map(lease => lease.close())); throw error }
}

export function cliAgentPolicyGuard(userId: string, agentId: string, botId: string | null, membership: CliMembershipGuard): MailboxTransactionGuard {
  return async (tx, signal) => {
    const current = await lockCliAgentPolicy(tx,userId,agentId,botId)
    return policyMemberships(current,userId,signal,membership)
  }
}

export async function readCliAgentPolicy(pool: Pick<Pool, 'connect'>, userId: string, agentId: string, botId: string | null, guard: CliMembershipGuard = realCliMembershipGuard) {
  return writeTransaction(pool, tx => lockCliAgentPolicy(tx,userId,agentId,botId), { guard: cliAgentPolicyGuard(userId,agentId,botId,guard) })
}

/** Hold the workspace membership lease through the application transaction. */
export function cliPolicyGuard(runId: string, userId: string, membership: CliMembershipGuard): MailboxTransactionGuard {
  return async (tx, signal) => {
    const current = await lockCliRunPolicy(tx, runId, userId)
    return policyMemberships(current,userId,signal,membership)
  }
}

/** Read an authenticated run's policy under the same locks used by decisions. */
export async function readCliRunPolicy(pool: Pick<Pool, 'connect'>, runId: string, userId: string, guard: CliMembershipGuard = realCliMembershipGuard) {
  return writeTransaction(pool, tx => lockCliRunPolicy(tx, runId, userId), { guard: cliPolicyGuard(runId,userId,guard) })
}
