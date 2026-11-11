import 'server-only'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { db } from '@/lib/db'
import { inDatabaseTransaction } from '@/lib/db/request-scope'
import { currentTransactionBoundary } from '@/lib/db/transaction-boundary'
import { workspaceSecrets } from '@/lib/db/secrets-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { taskReaderScope, withTaskWorkspace } from '@/lib/task-workspace'
import type { WorkspaceTransaction } from '@/lib/workspace-access'
import { ActionFailureError } from '@/lib/action-error'
import { environmentConfiguration, projectResourcesInput, saveEnvironmentInput, workspaceRepositoryPolicyInput, type EnvironmentConfiguration, type ProjectExecutionSnapshot } from './contracts'

type Reader = Parameters<typeof withTaskWorkspace>[0]
const actorId = (reader: Reader) => typeof reader === 'string' ? reader : reader.id
type EnvironmentRow = { id: string; workspaceId: string; name: string; revision: number; configuration: EnvironmentConfiguration; archivedAt: Date | null }
type ResourceLease = { userId: string; workspaceId: string; tx: WorkspaceTransaction; active: boolean; boundary: object | undefined }
const resourceLease = new AsyncLocalStorage<ResourceLease>()
const currentResourceLease = () => {
  const held = resourceLease.getStore()
  return held?.active && held.boundary === currentTransactionBoundary() ? held : undefined
}

/** Acquire before the APP transaction. Nested Factory queues borrow the same
 * lease; the shared locks survive savepoints and last through the owner's COMMIT.
 * An existing APP owner without that lease must not invert the two databases. */
export async function withProjectResourceLease<T>(reader: Reader, workspaceId: string, work: (tx: WorkspaceTransaction) => Promise<T>, requireExisting = false): Promise<T> {
  const scope = taskReaderScope(reader)
  if (scope.workspaceId && scope.workspaceId !== workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  const held = currentResourceLease()
  if (held?.active && held.userId === scope.userId && held.workspaceId === workspaceId) return work(held.tx)
  if (requireExisting || inDatabaseTransaction() || held?.active) throw new ActionFailureError('projectEnvironmentUnavailable')
  return withTaskWorkspace(reader, workspaceId, async (_workspace, tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('mikka-team-relations',0))`)
    await resourceLock(tx, workspaceId, false)
    const lease: ResourceLease = { userId: scope.userId, workspaceId, tx, active: true, boundary: currentTransactionBoundary() }
    try { return await resourceLease.run(lease, () => work(tx)) }
    finally { lease.active = false }
  })
}

export function requireProjectResourceLease(userId: string, workspaceId: string) {
  const held = currentResourceLease()
  if (!held?.active || held.userId !== userId || held.workspaceId !== workspaceId) throw new ActionFailureError('projectEnvironmentUnavailable')
}

/** A continuation may retain its frozen configuration only while that exact
 * repository/branch/environment selection is still admitted. Never combine a
 * historical Environment with a newly selected branch or rewrite the snapshot. */
export function assertFrozenProjectExecution(frozen: ProjectExecutionSnapshot, admitted: ProjectExecutionSnapshot) {
  if (frozen.workspaceId !== admitted.workspaceId || frozen.projectId !== admitted.projectId || frozen.repositoryKey !== admitted.repositoryKey || frozen.baseBranch !== admitted.baseBranch) throw new ActionFailureError('projectRepositoryDenied')
  if ((frozen.environment?.id ?? null) !== (admitted.environment?.id ?? null) || (frozen.environment?.revision ?? null) !== (admitted.environment?.revision ?? null)) throw new ActionFailureError('projectEnvironmentUnavailable')
}

/** Called after the queue locks the actual device repository and Agent. */
export function assertProjectExecutionTarget(snapshot: ProjectExecutionSnapshot, target: { userId: string; workspaceId: string; repositoryKey: string | null; runtime: 'local' | 'cloud'; harness: string }) {
  requireProjectResourceLease(target.userId, target.workspaceId)
  if (snapshot.workspaceId !== target.workspaceId || snapshot.repositoryKey !== target.repositoryKey) throw new ActionFailureError('projectRepositoryDenied')
  const environment = snapshot.environment
  if (environment && ((environment.runtime !== 'any' && environment.runtime !== target.runtime) || (environment.harness !== 'any' && environment.harness !== target.harness))) throw new ActionFailureError('projectEnvironmentUnavailable')
}

async function resourceLock(tx: WorkspaceTransaction, workspaceId: string, write: boolean) {
  await tx.execute(write
    ? sql`select pg_advisory_xact_lock(hashtextextended(${'project-resources:' + workspaceId},0))`
    : sql`select pg_advisory_xact_lock_shared(hashtextextended(${'project-resources:' + workspaceId},0))`)
}
async function resourceWriteLock(tx: WorkspaceTransaction, workspaceId: string) {
  // Configuration edits cannot upgrade an admission's shared lease. Every
  // independent writer takes relation -> resource -> entity locks, matching
  // admission and Project lifecycle operations across the split databases.
  if (currentResourceLease()) throw new ActionFailureError('projectResourceConflict')
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('mikka-team-relations',0))`)
  await resourceLock(tx, workspaceId, true)
}
async function admin(tx: WorkspaceTransaction, reader: Reader, workspaceId: string) {
  const [member] = await tx.select({ role: workspaceMembers.role }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actorId(reader)), eq(workspaceMembers.status, 'active')))
  if (member?.role !== 'admin') throw new ActionFailureError('workspaceAccessDenied')
}
async function audit(tx: WorkspaceTransaction, reader: Reader, workspaceId: string, kind: string, resourceId: string | null, detail: object) {
  await tx.execute(sql`insert into workspace_resource_events(id,"workspaceId","actorId",kind,"resourceId",detail)
    values(${randomUUID()},${workspaceId},${actorId(reader)},${kind},${resourceId},${JSON.stringify(detail)}::jsonb)`)
}
async function secretsFit(workspaceId: string, configuration: EnvironmentConfiguration, repositoryKey?: string | null) {
  if (!configuration.secretIds.length) return
  const ids = [...new Set(configuration.secretIds)]
  const secrets = await db.select({ id: workspaceSecrets.id, scopeType: workspaceSecrets.scopeType, scopeRef: workspaceSecrets.scopeRef })
    .from(workspaceSecrets).where(and(eq(workspaceSecrets.workspaceId, workspaceId), inArray(workspaceSecrets.id, ids)))
  const repo = repositoryKey?.startsWith('v2/github.com/') ? repositoryKey.slice('v2/github.com/'.length) : null
  if (secrets.length !== ids.length || (repositoryKey !== undefined && secrets.some(secret => secret.scopeType === 'repository' && secret.scopeRef !== repo))) {
    throw new ActionFailureError('projectEnvironmentUnavailable')
  }
}

/** Configuration is visible only to current tenant members. It contains secret IDs, never values. */
export async function listProjectResources(reader: Reader, workspaceId: string, projectId?: string) {
  return withTaskWorkspace(reader, workspaceId, async (_workspace, tx) => {
    if (projectId) {
      const found = await tx.execute(sql`select id from workspace_projects where id=${projectId} and "workspaceId"=${workspaceId}`)
      if (!found.rowCount) throw new ActionFailureError('projectNotFound')
    }
    const policy = await tx.execute(sql`select mode,"repositoryKeys",revision from workspace_repository_policies where "workspaceId"=${workspaceId}`)
    const environments = await tx.execute(sql`select id,"workspaceId",name,configuration,revision,"archivedAt" from workspace_environments where "workspaceId"=${workspaceId} order by name,id`)
    const repositories = projectId ? await tx.execute(sql`select "repositoryKey","baseBranch","environmentId","isPrimary" from workspace_project_repositories where "projectId"=${projectId} and "workspaceId"=${workspaceId} order by "repositoryKey"`) : { rows: [] }
    const bindings = projectId ? await tx.execute(sql`select "environmentId","isDefault" from workspace_project_environments where "projectId"=${projectId} and "workspaceId"=${workspaceId} order by "environmentId"`) : { rows: [] }
    return { policy: policy.rows[0] ?? { mode: 'inherit', repositoryKeys: [], revision: 0 }, environments: environments.rows, repositories: repositories.rows, environmentBindings: bindings.rows }
  })
}

/** Restricted + an empty list is an explicit deny-all policy; no row means inherit. */
export async function saveWorkspaceRepositoryPolicy(reader: Reader, raw: z.input<typeof workspaceRepositoryPolicyInput>) {
  const input = workspaceRepositoryPolicyInput.parse(raw)
  return withTaskWorkspace(reader, input.workspaceId, async (_workspace, tx) => {
    await admin(tx, reader, input.workspaceId)
    await resourceWriteLock(tx, input.workspaceId)
    const current = await tx.execute(sql`select revision from workspace_repository_policies where "workspaceId"=${input.workspaceId}`)
    if (Number(current.rows[0]?.revision ?? 0) !== input.revision) throw new ActionFailureError('projectResourceConflict')
    const revision = input.revision + 1
    const keys = [...new Set(input.repositoryKeys)].sort()
    await tx.execute(sql`insert into workspace_repository_policies("workspaceId",mode,"repositoryKeys",revision,"updatedBy")
      values(${input.workspaceId},${input.mode},${JSON.stringify(keys)}::jsonb,${revision},${actorId(reader)})
      on conflict("workspaceId") do update set mode=excluded.mode,"repositoryKeys"=excluded."repositoryKeys",revision=excluded.revision,"updatedBy"=excluded."updatedBy","updatedAt"=now()`)
    await audit(tx, reader, input.workspaceId, 'repository_policy.changed', null, { revision, mode: input.mode, repositoryCount: keys.length })
    return { revision }
  })
}

export async function saveEnvironment(reader: Reader, raw: z.input<typeof saveEnvironmentInput>) {
  const input = saveEnvironmentInput.parse(raw)
  return withTaskWorkspace(reader, input.workspaceId, async (_workspace, tx) => {
    await admin(tx, reader, input.workspaceId)
    await resourceWriteLock(tx, input.workspaceId)
    await secretsFit(input.workspaceId, input.configuration)
    const id = input.id ?? randomUUID()
    const current = await tx.execute(sql`select revision from workspace_environments where id=${id} and "workspaceId"=${input.workspaceId}`)
    if (input.id && (!current.rowCount || Number(current.rows[0].revision) !== input.revision)) throw new ActionFailureError('projectResourceConflict')
    const revision = Number(current.rows[0]?.revision ?? 0) + 1
    const configuration = { ...input.configuration, secretIds: [...new Set(input.configuration.secretIds)], repositoryKeys: [...new Set(input.configuration.repositoryKeys)] }
    await tx.execute(sql`insert into workspace_environments(id,"workspaceId",name,configuration,revision,"archivedAt","createdBy","updatedBy")
      values(${id},${input.workspaceId},${input.name},${JSON.stringify(configuration)}::jsonb,${revision},${input.archived ? new Date() : null},${actorId(reader)},${actorId(reader)})
      on conflict(id) do update set name=excluded.name,configuration=excluded.configuration,revision=excluded.revision,"archivedAt"=excluded."archivedAt","updatedBy"=excluded."updatedBy","updatedAt"=now()`)
    await audit(tx, reader, input.workspaceId, input.archived ? 'environment.archived' : 'environment.saved', id, { revision })
    return { id, revision }
  })
}

export async function saveProjectResources(reader: Reader, raw: z.input<typeof projectResourcesInput>) {
  const input = projectResourcesInput.parse(raw)
  return withTaskWorkspace(reader, input.workspaceId, async (_workspace, tx) => {
    await admin(tx, reader, input.workspaceId)
    await resourceWriteLock(tx, input.workspaceId)
    const current = await tx.execute(sql`select revision,"archivedAt" from workspace_projects where id=${input.projectId} and "workspaceId"=${input.workspaceId} for update`)
    if (!current.rowCount) throw new ActionFailureError('projectNotFound')
    if (current.rows[0].archivedAt) throw new ActionFailureError('projectArchived')
    if (Number(current.rows[0].revision) !== input.revision) throw new ActionFailureError('projectResourceConflict')
    const ids = [...new Set(input.environmentIds)]
    for (const id of ids) {
      const environment = await tx.execute(sql`select id from workspace_environments where id=${id} and "workspaceId"=${input.workspaceId} and "archivedAt" is null`)
      if (!environment.rowCount) throw new ActionFailureError('projectEnvironmentUnavailable')
    }
    await tx.execute(sql`delete from workspace_project_repositories where "projectId"=${input.projectId}`)
    await tx.execute(sql`delete from workspace_project_environments where "projectId"=${input.projectId}`)
    for (const id of ids) await tx.execute(sql`insert into workspace_project_environments("projectId","workspaceId","environmentId","isDefault") values(${input.projectId},${input.workspaceId},${id},${id === input.defaultEnvironmentId})`)
    for (const repo of input.repositories) await tx.execute(sql`insert into workspace_project_repositories("projectId","workspaceId","repositoryKey","baseBranch","environmentId","isPrimary") values(${input.projectId},${input.workspaceId},${repo.repositoryKey},${repo.baseBranch},${repo.environmentId},${repo.isPrimary})`)
    await tx.execute(sql`update workspace_projects set revision=revision+1,"updatedAt"=now() where id=${input.projectId}`)
    await audit(tx, reader, input.workspaceId, 'project_resources.changed', input.projectId, { revision: input.revision + 1, repositoryCount: input.repositories.length, environmentCount: ids.length })
    await (await import('@/lib/live/project-map')).projectMapChanged(tx, input.projectId)
    return { revision: input.revision + 1 }
  })
}

export type ProjectExecutionInput = { userId: string; workspaceId: string; issueId: string; repositoryKey: string | null; baseBranch: string | null; runtime: 'local' | 'cloud'; harness: string }

/** Hold current membership and policy through the caller's Run transaction. Existing
 * GitHub/device authorization remains mandatory at that caller; a binding grants none. */
export async function withProjectExecution<T>(input: ProjectExecutionInput, operation: (snapshot: ProjectExecutionSnapshot) => Promise<T>, requireExisting = false): Promise<T> {
  return withProjectResourceLease(input.userId, input.workspaceId, async tx => {
    const policy = await tx.execute<{ mode: string; repositoryKeys: string[]; revision: number }>(sql`select mode,"repositoryKeys",revision from workspace_repository_policies where "workspaceId"=${input.workspaceId}`)
    if (policy.rows[0]?.mode === 'restricted' && input.repositoryKey && !policy.rows[0].repositoryKeys.includes(input.repositoryKey)) throw new ActionFailureError('projectRepositoryDenied')
    const project = await tx.execute<{ id: string; revision: number; archivedAt: Date | null }>(sql`select p.id,p.revision,p."archivedAt" from workspace_project_tasks t join workspace_projects p on p.id=t."projectId" and p."workspaceId"=t."workspaceId" where t."issueId"=${input.issueId} and t."workspaceId"=${input.workspaceId}`)
    const selected = project.rows[0]
    if (selected?.archivedAt) throw new ActionFailureError('projectArchived')
    let environmentId: string | null = null
    let baseBranch = input.baseBranch
    if (selected) {
      const repositories = await tx.execute<{ repositoryKey: string; baseBranch: string | null; environmentId: string | null }>(sql`select "repositoryKey","baseBranch","environmentId" from workspace_project_repositories where "projectId"=${selected.id} and "workspaceId"=${input.workspaceId}`)
      const binding = repositories.rows.find(repo => repo.repositoryKey === input.repositoryKey)
      if (input.repositoryKey && repositories.rowCount && !binding) throw new ActionFailureError('projectRepositoryDenied')
      baseBranch = binding?.baseBranch ?? input.baseBranch
      environmentId = binding?.environmentId ?? null
      if (!environmentId) {
        const defaults = await tx.execute<{ environmentId: string }>(sql`select "environmentId" from workspace_project_environments where "projectId"=${selected.id} and "workspaceId"=${input.workspaceId} and "isDefault"`)
        environmentId = defaults.rows[0]?.environmentId ?? null
      }
    }
    let environment: ProjectExecutionSnapshot['environment'] = null
    if (environmentId) {
      const rows = await tx.execute<EnvironmentRow>(sql`select id,"workspaceId",name,configuration,revision,"archivedAt" from workspace_environments where id=${environmentId} and "workspaceId"=${input.workspaceId} and "archivedAt" is null`)
      const row = rows.rows[0]
      if (!row) throw new ActionFailureError('projectEnvironmentUnavailable')
      const parsed = environmentConfiguration.safeParse(row.configuration)
      if (!parsed.success) throw new ActionFailureError('projectEnvironmentUnavailable')
      const config = parsed.data
      if ((config.runtime !== 'any' && config.runtime !== input.runtime) || (config.harness !== 'any' && config.harness !== input.harness) || (config.repositoryKeys.length && (!input.repositoryKey || !config.repositoryKeys.includes(input.repositoryKey)))) throw new ActionFailureError('projectEnvironmentUnavailable')
      await secretsFit(input.workspaceId, config, input.repositoryKey)
      environment = { id: row.id, revision: row.revision, name: row.name, ...config }
    }
    return operation({ version: 1, workspaceId: input.workspaceId, projectId: selected?.id ?? null, projectRevision: selected?.revision ?? null, policyRevision: policy.rows[0]?.revision ?? 0, repositoryKey: input.repositoryKey, baseBranch, environment })
  }, requireExisting)
}
