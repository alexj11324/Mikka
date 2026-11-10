import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { JSONContent } from '@tiptap/core'
import { z } from 'zod'
import { applyApprovalMode, approvalModeSchema, intersectNetworkDomains, CONFIGURABLE_ACTIONS, networkAllowSchema, runPolicySchema, storedPermissionsSchema, type ConfigurableAction, type PermissionDecision, type RunPolicy } from '@mikka/protocol/agent-policy'
import { resolveTrustedRunPolicy } from './policy-snapshot'
import { intersectRunPolicy } from '../run-assignment-policy'
import type { MailboxTransactionLease, MailboxTransactionGuard } from '@/lib/mailbox-transaction-guard'
import { writeTransaction } from '@/lib/operations/write-transaction'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { requireTaskWorkspace } from '@/lib/task-workspace'
import { ActionFailureError } from '@/lib/action-error'

/** Derived from the stored task and its trusted workspace relation, never a tool argument. */
export interface CliTaskScope { issueId: string; scopeVersion: number; workspaceId: string | null; hierarchy?: CliHierarchy }
interface CliTaskRow { workspaceId: string | null; ownershipState: string; scopeVersion: number; content: JSONContent }
const hierarchySchema = z.strictObject({ workspaceId: z.uuid(), teamId: z.uuid(), projectId: z.uuid().nullable() })
export type CliHierarchy = z.infer<typeof hierarchySchema>

/** Resolve stored team/shared-project UUIDs, never a mutable project label. */
async function cliHierarchy(task: CliTaskScope, frozenHierarchy: unknown): Promise<CliHierarchy | undefined> {
  if (!task.workspaceId) return undefined
  const { workspacePool } = await import('@/lib/workspace-db')
  const { rows: [team] } = await workspacePool.query<{ teamId: string }>(`SELECT l."teamId" FROM mikka_team_issues l JOIN mikka_teams t ON t.id=l."teamId" AND t."workspaceId"=l."workspaceId" WHERE l."issueId"=$1 AND l."workspaceId"=$2`,[task.issueId,task.workspaceId])
  // Teams are optional grouping inside the tenant. Removing a previously
  // frozen policy hierarchy still requires a fresh admission.
  if (!team) {
    if (frozenHierarchy != null) throw new Error('agentPolicyChanged')
    return undefined
  }
  const { rows: projects } = await workspacePool.query<{ id: string }>(`SELECT DISTINCT p.id FROM workspace_projects p JOIN mikka_team_projects l ON l."projectId"=p.id WHERE p."issueIds" ? $1 AND l."teamId"=$2 AND l."workspaceId"=$3`,[task.issueId,team.teamId,task.workspaceId])
  if (projects.length > 1) throw new Error('agentPolicyUnavailable')
  const hierarchy = hierarchySchema.parse({ workspaceId: task.workspaceId,teamId:team.teamId,projectId:projects[0]?.id ?? null })
  if (frozenHierarchy != null) {
    const frozen = hierarchySchema.parse(frozenHierarchy)
    // Membership in a stricter team/project may change without issue.scopeVersion.
    // Never keep authorizing with an older, wider admitted hierarchy.
    if (frozen.workspaceId !== hierarchy.workspaceId || frozen.teamId !== hierarchy.teamId || frozen.projectId !== hierarchy.projectId) throw new Error('agentPolicyChanged')
    return frozen
  }
  return hierarchy
}
export async function lockCliTaskScope(tx: PoolClient, userId: string, issueId: string): Promise<CliTaskScope> {
  // Authority needs the complete metadata schema, never the document body.
  // Preserve non-object roots so malformed/null content keeps its old behavior.
  const { rows: [task] } = await tx.query<CliTaskRow>(`SELECT "workspaceId","ownershipState","scopeVersion",
    CASE WHEN jsonb_typeof(content)='object' THEN jsonb_build_object('attrs',content->'attrs') ELSE content END AS content
    FROM issues WHERE id=$1`, [issueId])
  return validateCliTaskScope(userId, issueId, task)
}

async function validateCliTaskScope(userId: string, issueId: string, task: CliTaskRow | undefined): Promise<CliTaskScope> {
  if (!task || task.ownershipState !== 'bound' || !task.workspaceId || readIssueMetadata(task.content).deletedAt) throw new Error('agentPolicyUnavailable')
  await requirePolicyWorkspace(userId, task.workspaceId)
  return { issueId, scopeVersion: task.scopeVersion, workspaceId: task.workspaceId }
}

async function requirePolicyWorkspace(userId: string, workspaceId: string) {
  try { await requireTaskWorkspace(userId, workspaceId) }
  catch (error) {
    if (error instanceof ActionFailureError && error.code === 'workspaceAccessDenied') throw new Error('agentPolicyUnavailable', { cause: error })
    throw error
  }
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
export async function lockCliAgentPolicy(tx: PoolClient, userId: string, agentId: string, botId: string | null, task?: CliTaskScope, runWorkspaceId?: string) {
  let workspaceId: string | null = null
  if (botId) {
    const bot = await tx.query<{ workspaceId: string }>('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2 FOR SHARE', [botId,userId])
    if (!bot.rows[0]) throw new Error('agentPolicyUnavailable')
    workspaceId = bot.rows[0].workspaceId
  }
  const scope = { botId, workspaceId, agentId }
  const workspaceIds = [...new Set([workspaceId, task?.workspaceId, runWorkspaceId].filter((id): id is string => !!id))].sort()
  if (workspaceIds.length > 1) throw new Error('agentPolicyUnavailable')
  const primaryWorkspaceId = runWorkspaceId ?? workspaceId ?? task?.workspaceId ?? null
  const key = scope.botId ?? 'coordinator'
  // One statement, the same locks in the same order: the Bot and worker keys are
  // execution identity, then each workspace in UUID order (a function scan
  // returns unnest's rows in order).
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended(k,0)) FROM unnest($1::text[]) AS k',
    [[`agent-cli-policy:${userId}:${key}`, `worker-cli-policy:${scope.agentId}`, ...workspaceIds.map(id => `workspace-cli-policy:${id}`)]])
  // Materialize empty defaults under the same locks, so legacy runs have a
  // stable generation. No existing computer or external-write choice changes.
  await tx.query(`WITH head AS (INSERT INTO agent_kit_heads (owner_id,bot_key,bot_id,workspace_id) VALUES ($1,$2,$3,$4) ON CONFLICT (owner_id,bot_key) DO NOTHING)
    INSERT INTO workspace_computer_policies ("workspaceId",permission) SELECT w,'allow' FROM unnest($5::uuid[]) AS w ON CONFLICT ("workspaceId") DO NOTHING`, [userId,key,scope.botId,scope.workspaceId,workspaceIds])
  // The head is identity only: it binds the run to its Bot and workspace.
  // Its policy columns are not read; no Bot layer exists.
  const agentRow = await tx.query<{ workspace: string | null }>(`SELECT workspace_id AS workspace FROM agent_kit_heads WHERE owner_id=$1 AND bot_key=$2 FOR SHARE`, [userId,key])
  if (!agentRow.rows[0] || agentRow.rows[0].workspace !== scope.workspaceId) throw new Error('agentPolicyUnavailable')
  // The worker row is identity and device only; its policy columns are retired.
  const workerRow = await tx.query<{ deviceId: string | null }>(`SELECT "deviceId" FROM agents WHERE id=$1 AND "userId"=$2 FOR SHARE`, [scope.agentId,userId])
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
  // The Bot and task share one tenant; optional team/project policies narrow it.
  for (const id of workspaceIds) inherit('workspace', id, workspaceById.get(id))
  if (hierarchy) {
    inherit('team', hierarchy.teamId, scopeLayers.team)
    if (hierarchy.projectId) inherit('project', hierarchy.projectId, scopeLayers.project)
  }
  // The workspace is the base, not only a ceiling: an explicit workspace allow
  // must be able to widen a protocol default. Team/project still narrow it.
  const configured = mergeCliPolicyValues(defaults, {
    ...(workspace.permissions ? { permissions: workspace.permissions } : {}),
    ...(workspace.networkAllow !== undefined ? { networkAllow: workspace.networkAllow } : {}),
    ...(workspace.approvalMode !== undefined ? { approvalMode: workspace.approvalMode } : {}),
  })
  const policy = resolveTrustedRunPolicy({ workspace: { permissions: configured.permissions, networkAllow: configured.networkAllow }, personalApprovalMode: configured.approvalMode, environment: deviceKind === 'cloud' ? 'cloud' : 'local' })
  for (const layer of [...workspaceLayers, ...scopedLayers]) {
    for (const action of CONFIGURABLE_ACTIONS) {
      if (action === 'computer_use') continue
      const override = layer.permissions?.[action]
      // Stored layers parse git_push to allow / deny only (storedPermissionsSchema).
      if (override && rank[override] < rank[policy.permissions[action]]) (policy.permissions as Record<ConfigurableAction, PermissionDecision>)[action] = override
    }
    if (layer.networkAllow !== undefined) {
      policy.networkCeiling = policy.networkCeiling === undefined ? [...layer.networkAllow] : intersectNetworkDomains(policy.networkCeiling, layer.networkAllow)
      policy.networkAllow = intersectNetworkDomains(policy.networkAllow, layer.networkAllow)
    }
  }
  if ([...workspaceLayers, ...scopedLayers].some(layer => layer.approvalMode === 'read_only')) {
    policy.readOnly = true
    policy.permissions.install_dependency = 'deny'
    policy.permissions.write_outside_repo = 'deny'
    policy.permissions.git_push = 'deny'
  }
  const revision = createHash('sha256').update(JSON.stringify(['sandbox-task-policy-v3',deviceKind,userId,scope.botId,scope.workspaceId,scope.agentId,workspaceVersions,scopeVersions,task ? { issueId: task.issueId, workspaceId: task.workspaceId, hierarchy: task.hierarchy } : null])).digest('hex')
  return { policy, revision, workspaceId: primaryWorkspaceId, workspaceIds, hierarchy, defaults, defaultSources, policySnapshotRequired: [...workspaceLayers, ...scopedLayers].some(layer => Object.keys(layer).length > 0), layers: { workspace, ...scopeLayers } }
}

/** Resolve a run's exact owner, Bot and worker; then read the workspace policy. */
export async function lockCliRunPolicy(tx: PoolClient, runId: string, userId: string, options: { freezeHierarchy?: boolean } = {}) {
  // Policy must precede Factory/task/run locks. Read the task with the run,
  // then freeze any new hierarchy only after acquiring the policy locks.
  const result = await tx.query<CliTaskRow & { botId: string | null; agentId: string; issueId: string | null; runWorkspaceId: string | null; policyCeiling: unknown; hierarchy: unknown }>(`SELECT "botId","agentId","issueId",r."agentDefinition"->'policyCeiling' AS "policyCeiling",
    r.cli_policy_hierarchy AS hierarchy,r."workspaceId" AS "runWorkspaceId",i."workspaceId",i."ownershipState",i."scopeVersion",
    CASE WHEN jsonb_typeof(i.content)='object' THEN jsonb_build_object('attrs',i.content->'attrs') ELSE i.content END AS content
    FROM agent_runs r LEFT JOIN issues i ON i.id=r."issueId" WHERE r.id=$1 AND r."userId"=$2`, [runId,userId])
  const run = result.rows[0]
  if (!run?.runWorkspaceId) throw new Error('agentPolicyUnavailable')
  const task = run.issueId ? await validateCliTaskScope(userId,run.issueId,run) : undefined
  if (task && task.workspaceId !== run.runWorkspaceId) throw new Error('agentPolicyUnavailable')
  if (!task && run.hierarchy != null) throw new Error('agentPolicyUnavailable')
  if (!task) await requirePolicyWorkspace(userId, run.runWorkspaceId)
  if (task) { const hierarchy = await cliHierarchy(task,run.hierarchy); if (hierarchy) task.hierarchy = hierarchy }
  const current = await lockCliAgentPolicy(tx,userId,run.agentId,run.botId,task,run.runWorkspaceId)
  if (options.freezeHierarchy !== false && task?.hierarchy && run.hierarchy == null) {
    // Concurrent first readers may agree on the snapshot, but one may never
    // overwrite a different admitted hierarchy after waiting on the row lock.
    const frozen = await tx.query(`UPDATE agent_runs SET cli_policy_hierarchy=$3 WHERE id=$1 AND "userId"=$2
      AND (cli_policy_hierarchy IS NULL OR cli_policy_hierarchy=$3::jsonb) RETURNING id`, [runId,userId,task.hierarchy])
    if (!frozen.rowCount) throw new Error('agentPolicyChanged')
  }
  if (run.policyCeiling == null) return current
  const ceiling = runPolicySchema.safeParse(run.policyCeiling)
  if (!ceiling.success) throw new Error('agentPolicyUnavailable')
  return { ...current, policy: intersectRunPolicy(current.policy, ceiling.data),
    revision: createHash('sha256').update(JSON.stringify(['provider-policy-ceiling-v1', current.revision, ceiling.data])).digest('hex') }
}

/** A host prelocks policy before its Factory/issue/run locks. It verifies an
 * existing hierarchy without taking a run lock; admission freezes it later. */
export function prelockCliRunPolicy(tx: PoolClient, runId: string, userId: string) {
  return lockCliRunPolicy(tx, runId, userId, { freezeHierarchy: false })
}

/** Capture the source's effective policy while the caller holds policy locks
 * before Factory/issue/run locks. New credentials and harnesses do not inherit
 * a broader worker default, including after later target settings edits. */
export async function providerContinuationPolicy(tx: PoolClient, userId: string, sourceRunId: string): Promise<RunPolicy> {
  const { rows: [source] } = await tx.query<{ readOnly: boolean | null; computerUse: PermissionDecision | null }>(`SELECT "agentDefinition"->>'readOnly'='true' AS "readOnly",
    "agentDefinition"#>>'{policyCeiling,permissions,computer_use}' AS "computerUse"
    FROM agent_runs WHERE id=$1 AND "userId"=$2`, [sourceRunId, userId])
  if (!source) throw new Error('agentPolicyUnavailable')
  const current = await lockCliRunPolicy(tx, sourceRunId, userId)
  let policy = structuredClone(current.policy)
  // The generic CLI default is not an independent computer grant. The broker
  // reauthorizes it, but an existing host ceiling (especially deny) survives.
  if (source.computerUse) policy.permissions.computer_use = source.computerUse
  else delete policy.permissions.computer_use
  if (source.readOnly || policy.readOnly) policy = applyApprovalMode(policy, 'read_only')
  const { rows: assignments } = await tx.query<{ stage: string; policy: unknown }>(`SELECT a.stage,a.output->'check'->'policy' AS policy
    FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId" AND t."attemptId"=a.id
    JOIN agent_runs r ON r.id=a."runId" AND r."issueId"=t."issueId" AND r."userId"=t."userId"
    WHERE r.id=$1 AND r."userId"=$2 AND a.stage IN ('review','verify','monitor')`, [sourceRunId, userId])
  for (const assignment of assignments) {
    if (assignment.stage !== 'monitor') policy = intersectRunPolicy(policy, runPolicySchema.parse(assignment.policy))
    policy = applyApprovalMode(policy, 'read_only')
  }
  return policy
}

export async function policyMemberships(current: Awaited<ReturnType<typeof lockCliAgentPolicy>>, userId: string, signal: AbortSignal, membership: CliMembershipGuard): Promise<MailboxTransactionLease> {
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
  // The work resolved the policy in this transaction and still holds its locks
  // (advisory, FOR SHARE) through COMMIT, so the membership lease is taken for
  // that same result instead of resolving it a second time (12 statements).
  let current: Awaited<ReturnType<typeof lockCliRunPolicy>> | undefined
  return writeTransaction(pool, async tx => (current = await lockCliRunPolicy(tx, runId, userId)), {
    guard: (_tx, signal) => policyMemberships(current!, userId, signal, guard),
  })
}
