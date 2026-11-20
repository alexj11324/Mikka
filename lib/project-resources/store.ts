import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { memberProjectOrganization } from '@/lib/resource-access/project-creation-default'
import { workspaceListChanged } from '@/lib/live/lists'
import { inDatabaseTransaction } from '@/lib/db/request-scope'
import { currentTransactionBoundary } from '@/lib/db/transaction-boundary'
import { workspaceSecrets } from '@/lib/db/secrets-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { taskReaderScope, withTaskWorkspace } from '@/lib/task-workspace'
import type { WorkspaceTransaction } from '@/lib/workspace-access'
import { ActionFailureError } from '@/lib/action-error'
import { normalizeRepository } from '@mikka/protocol/repository'
import { GovernanceError } from '@/lib/governance/errors'
import { accessibleProjects } from '@/lib/project-access'
import { isMachineSize } from '@/lib/cloud-computer/machine-pricing'
import { environmentConfiguration, projectEnvironmentVariableInput, listProjectSetupVersionsInput, rollbackProjectSetupInput, projectSetupScope, type ProjectSetupHistory, type ProjectSetupRecipe, projectDefaultEnvironmentInput, maxProjectRepositories, projectResourceMutation, repositoryBindingInput, saveEnvironmentInput, workspaceRepositoryPolicyInput, type EnvironmentConfiguration, type ProjectExecutionSnapshot } from './contracts'

type Reader = Parameters<typeof withTaskWorkspace>[0]
const actorId = (reader: Reader) => typeof reader === 'string' ? reader : reader.id
export type EnvironmentRow = { id: string; workspaceId: string; name: string; revision: number; configuration: EnvironmentConfiguration; archivedAt: Date | null; defaultMachineSize: string | null }
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

export async function resourceLock(tx: WorkspaceTransaction, workspaceId: string, write: boolean) {
  await tx.execute(write
    ? sql`select pg_advisory_xact_lock(hashtextextended(${'project-resources:' + workspaceId},0))`
    : sql`select pg_advisory_xact_lock_shared(hashtextextended(${'project-resources:' + workspaceId},0))`)
}
export async function resourceWriteLock(tx: WorkspaceTransaction, workspaceId: string) {
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

/** Keep the Workspace Project row and its APP content policy locked during the
 * resource operation. Missing and inaccessible Projects have one public result. */
async function withConfiguredProject<T>(reader: Reader, workspaceId: string, projectId: string, write: boolean,
  work: (tx: WorkspaceTransaction, project: { revision: number; archivedAt: Date | null }) => Promise<T>) {
  const { withResourceAccess } = await import('@/lib/resource-access/store')
  return withTaskWorkspace(reader, workspaceId, async (_workspace, tx) => {
    if (write) {
      await admin(tx, reader, workspaceId)
      await resourceWriteLock(tx, workspaceId)
    }
    // Match the Project lifecycle writer: the APP policy is locked before
    // the source row. The surrounding Workspace transaction owns both uses.
    try {
      return await withResourceAccess(reader, { kind: 'project', id: projectId, workspaceId }, write ? 'canSteer' : 'canReadContent', async () => {
        const project = (await tx.execute<{ revision: number; archivedAt: Date | null }>(sql`select revision,"archivedAt"
          from workspace_projects where id=${projectId} and "workspaceId"=${workspaceId} ${write ? sql`for update` : sql`for share`}`)).rows[0]
        if (!project) throw new ActionFailureError('projectNotFound')
        if (write && project.archivedAt) throw new ActionFailureError('projectArchived')
        return work(tx, project)
      })
    } catch (error) {
      if (error instanceof ActionFailureError && error.code === 'issueNotFound') throw new ActionFailureError('projectNotFound', undefined, undefined, { cause: error })
      throw error
    }
  })
}

type ProjectRepositoryBinding = z.output<typeof repositoryBindingInput>

async function projectRepositoryBindings(tx: WorkspaceTransaction, workspaceId: string, projectId: string) {
  const result = await tx.execute<ProjectRepositoryBinding>(sql`select "repositoryKey","baseBranch","environmentId","isPrimary" from workspace_project_repositories
    where "projectId"=${projectId} and "workspaceId"=${workspaceId} order by "repositoryKey"`)
  return result.rows
}

/** Workspace configuration stays tenant-scoped. Project bindings also require current Project content access. */
export async function listProjectResources(reader: Reader, workspaceId: string, projectId?: string) {
  const read = async (tx: WorkspaceTransaction) => {
    const policy = await tx.execute(sql`select mode,"repositoryKeys",revision from workspace_repository_policies where "workspaceId"=${workspaceId}`)
    const environments = await tx.execute<EnvironmentRow>(sql`select id,"workspaceId",name,configuration,revision,"archivedAt","defaultMachineSize" from workspace_environments where "workspaceId"=${workspaceId} order by name,id`)
    const repositories = projectId ? await projectRepositoryBindings(tx, workspaceId, projectId) : []
    const bindings = projectId ? await tx.execute(sql`select "environmentId","isDefault" from workspace_project_environments where "projectId"=${projectId} and "workspaceId"=${workspaceId} order by "environmentId"`) : { rows: [] }
    return { policy: policy.rows[0] ?? { mode: 'inherit', repositoryKeys: [], revision: 0 }, environments: environments.rows, repositories, environmentBindings: bindings.rows }
  }
  return projectId ? withConfiguredProject(reader, workspaceId, projectId, false, read)
    : withTaskWorkspace(reader, workspaceId, (_workspace, tx) => read(tx))
}

function activeDefaultEnvironment(workspaceId: string, projectId: string) {
  return sql`from workspace_project_environments b
    join workspace_environments e on e.id=b."environmentId" and e."workspaceId"=b."workspaceId"
    where b."workspaceId"=${workspaceId} and b."projectId"=${projectId} and b."isDefault"
      and e."archivedAt" is null`
}

/** Read one ordinary variable from the Project's current default environment. */
export async function readProjectEnvironmentVariable(reader: Reader, raw: z.input<typeof projectEnvironmentVariableInput>) {
  const { workspaceId, projectId, name } = projectEnvironmentVariableInput.parse(raw)
  return withConfiguredProject(reader, workspaceId, projectId, false, async tx => {
    const { rows: [row] } = await tx.execute<{ value: string | null }>(sql`
      SELECT e.configuration->'variables'->>${name}::text AS value
      ${activeDefaultEnvironment(workspaceId, projectId)}`)
    return row?.value == null ? null : { name, value: row.value }
  })
}

const organizationVariableInput = projectEnvironmentVariableInput.omit({ workspaceId: true }).extend({ organizationId: z.uuid() })

export async function readOrganizationProjectEnvironmentVariable(reader: Reader, raw: z.input<typeof organizationVariableInput>) {
  const { organizationId, projectId, name } = organizationVariableInput.parse(raw)
  // Discovery selects only a candidate. The Workspace lease pins its attachment
  // while the current membership, Project ACL and default Environment are read.
  const { rows: [project] } = await workspacePool.query<{ workspaceId: string }>(`SELECT p."workspaceId"
    FROM workspace_projects p JOIN mikka_organization_workspaces a ON a."workspaceId"=p."workspaceId"
    WHERE p.id=$1 AND a."organizationId"=$2 AND p."archivedAt" IS NULL`, [projectId, organizationId])
  if (!project) throw new GovernanceError('not_found')
  return withTaskWorkspace(reader, project.workspaceId, async (workspace, tx) => {
    if (await memberProjectOrganization(tx, workspace, actorId(reader)) !== organizationId) throw new GovernanceError('not_found')
    return readProjectEnvironmentVariable(reader, { workspaceId: workspace.id, projectId, name })
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

function setupRecipe(configuration: EnvironmentConfiguration): ProjectSetupRecipe | null {
  const setup = configuration.setup
  return setup ? { copyFiles: setup.copyFiles, ...(setup.command !== undefined ? { command: setup.command } : {}) } : null
}

async function recordSetupVersion(tx: WorkspaceTransaction, workspaceId: string, id: string, revision: number, configuration: EnvironmentConfiguration) {
  const recipe = setupRecipe(configuration)
  await tx.execute(sql`insert into workspace_environment_setup_versions ("workspaceId","environmentId",revision,recipe)
    select ${workspaceId}::uuid,${id}::uuid,${revision}::integer,nullif(${JSON.stringify(recipe)}::jsonb,'null'::jsonb)
    where not exists (select 1 from (select recipe from workspace_environment_setup_versions where "workspaceId"=${workspaceId}
      and "environmentId"=${id} order by revision desc limit 1) latest
      where latest.recipe is not distinct from nullif(${JSON.stringify(recipe)}::jsonb,'null'::jsonb))`)
}

async function persistEnvironment(tx: WorkspaceTransaction, reader: Reader, workspaceId: string, id: string, name: string, configuration: EnvironmentConfiguration, revision: number, archivedAt: Date | null, defaultMachineSize?: string | null) {
  // An absent size keeps the saved one (archive and restore resend the rest without it).
  const keepSize = defaultMachineSize === undefined
  await tx.execute(sql`insert into workspace_environments(id,"workspaceId",name,configuration,revision,"archivedAt","createdBy","updatedBy","defaultMachineSize")
    values(${id},${workspaceId},${name},${JSON.stringify(configuration)}::jsonb,${revision},${archivedAt},${actorId(reader)},${actorId(reader)},${defaultMachineSize ?? null})
    on conflict(id) do update set name=excluded.name,configuration=excluded.configuration,revision=excluded.revision,"archivedAt"=excluded."archivedAt","updatedBy"=excluded."updatedBy","updatedAt"=now(),
      "defaultMachineSize"=CASE WHEN ${keepSize} THEN workspace_environments."defaultMachineSize" ELSE excluded."defaultMachineSize" END`)
  await recordSetupVersion(tx, workspaceId, id, revision, configuration)
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
    await persistEnvironment(tx, reader, input.workspaceId, id, input.name, configuration, revision, input.archived ? new Date() : null, input.defaultMachineSize)
    await audit(tx, reader, input.workspaceId, input.archived ? 'environment.archived' : 'environment.saved', id, { revision })
    await workspaceListChanged(tx, input.workspaceId, ['workspace_settings'])
    return { id, revision }
  })
}

const currentSetupScope = projectSetupScope.omit({ environmentId: true })

type SelectedProjectRepository = Pick<ProjectRepositoryBinding, 'repositoryKey' | 'baseBranch' | 'environmentId'> & { selectedEnvironmentId: string | null }

/** The Run admission and current setup view resolve the same Project repository overrides and default. */
async function configuredProjectBindings(tx: WorkspaceTransaction, workspaceId: string, projectId: string) {
  const { rows } = await tx.execute<{ repositoryKey: string | null; baseBranch: string | null; environmentId: string | null; defaultEnvironmentId: string | null }>(sql`
    select r."repositoryKey", r."baseBranch", r."environmentId", d."environmentId" as "defaultEnvironmentId"
    from (values (${workspaceId}::uuid, ${projectId}::uuid)) as scope(workspace_id, project_id)
    left join workspace_project_environments d on d."workspaceId"=scope.workspace_id and d."projectId"=scope.project_id and d."isDefault"
    left join workspace_project_repositories r on r."workspaceId"=scope.workspace_id and r."projectId"=scope.project_id
    order by r."repositoryKey"`)
  const repositories: SelectedProjectRepository[] = []
  for (const { repositoryKey, baseBranch, environmentId, defaultEnvironmentId } of rows) {
    if (repositoryKey !== null) repositories.push({ repositoryKey, baseBranch, environmentId, selectedEnvironmentId: environmentId ?? defaultEnvironmentId })
  }
  return { repositories, defaultEnvironmentId: rows[0]?.defaultEnvironmentId ?? null }
}

/** An explicit repository selection survives archival. Such an Environment has no readable current recipe. */
export async function readCurrentProjectSetup(reader: Reader, input: z.input<typeof currentSetupScope>) {
  const { workspaceId, projectId } = currentSetupScope.parse(input)
  return withConfiguredProject(reader, workspaceId, projectId, false, async (tx, project) => {
    if (project.archivedAt) throw new ActionFailureError('projectNotFound')
    const { repositories, defaultEnvironmentId } = await configuredProjectBindings(tx, workspaceId, projectId)
    const ids = new Set(repositories.flatMap(repo => repo.environmentId ? [repo.environmentId] : []))
    if (defaultEnvironmentId) ids.add(defaultEnvironmentId)
    const rows = ids.size ? (await tx.execute<{ id: string; revision: number; setup: unknown }>(sql`
      select id, revision, configuration->'setup' as setup from workspace_environments
      where "workspaceId"=${workspaceId} and "archivedAt" is null
        and id in (${sql.join([...ids].map(id => sql`${id}::uuid`), sql`, `)})
      order by id`)).rows : []
    const environments = rows.map(row => {
      const setup = environmentConfiguration.shape.setup.nullable().safeParse(row.setup)
      if (!setup.success) throw new ActionFailureError('projectEnvironmentUnavailable', undefined, undefined, { cause: setup.error })
      return { id: row.id, revision: row.revision, setup: setup.data ?? null }
    })
    return { defaultEnvironmentId, repositories, environments }
  })
}

type SetupScope = z.infer<typeof projectSetupScope>
async function withProjectSetup<T>(reader: Reader, scope: SetupScope, write: boolean, work: (tx: WorkspaceTransaction, environment: EnvironmentRow, projects: string[], bindingSnapshot: string) => Promise<T>) {
  const { withResourceAccess } = await import('@/lib/resource-access/store')
  const { workspaceId, projectId, environmentId } = scope
  return withTaskWorkspace(reader, workspaceId, async (_workspace, tx) => {
    if (write) {
      await admin(tx, reader, workspaceId)
      await resourceWriteLock(tx, workspaceId)
    } else {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('mikka-team-relations',0))`)
      await resourceLock(tx, workspaceId, false)
    }
    return withResourceAccess(reader, { kind: 'project', id: projectId, workspaceId }, write ? 'canSteer' : 'canReadContent', async () => {
      const environment = (await tx.execute<EnvironmentRow>(sql`select e.id,e."workspaceId",e.name,e.revision,e.configuration,e."archivedAt"
        ${activeDefaultEnvironment(workspaceId, projectId)} and b."environmentId"=${environmentId}
        and exists (select 1 from workspace_projects p where p.id=b."projectId" and p."workspaceId"=b."workspaceId" and p."archivedAt" is null)`)).rows[0]
      if (!environment) throw new ActionFailureError('projectEnvironmentUnavailable')
      const bindings = await tx.execute<{ projectId: string }>(sql`select "projectId" from workspace_project_environments where "workspaceId"=${workspaceId} and "environmentId"=${environmentId}
        union select "projectId" from workspace_project_repositories where "workspaceId"=${workspaceId} and "environmentId"=${environmentId} order by 1`)
      const projects = bindings.rows.map(row => row.projectId)
      const snapshot = createHash('sha256').update(JSON.stringify([workspaceId, environmentId, projects])).digest('hex')
      return work(tx, environment, projects, snapshot)
    })
  })
}

export async function listProjectSetupVersions(reader: Reader, raw: z.input<typeof listProjectSetupVersionsInput>): Promise<ProjectSetupHistory> {
  const input = listProjectSetupVersionsInput.parse(raw)
  return withProjectSetup(reader, input, false, async (tx, environment, projects, bindingSnapshot) => {
    const page = await tx.execute<{ revision: number; recordedAt: Date | string; recipe: ProjectSetupRecipe | null }>(sql`
      select revision,"recordedAt",recipe from workspace_environment_setup_versions where "workspaceId"=${input.workspaceId}
      and "environmentId"=${input.environmentId} ${input.before ? sql`and revision < ${input.before}` : sql``} order by revision desc limit 31`)
    const versions = page.rows.slice(0, 30).map(row => ({ ...row, recordedAt: new Date(row.recordedAt).toISOString() }))
    return { revision: environment.revision, bindingSnapshot, totalProjects: projects.length, versions, before: page.rows.length > 30 ? versions.at(-1)!.revision : null }
  })
}

export async function rollbackProjectSetup(reader: Reader, raw: z.input<typeof rollbackProjectSetupInput>) {
  const input = rollbackProjectSetupInput.parse(raw)
  return withProjectSetup(reader, input, true, async (tx, environment, _projects, snapshot) => {
    if (environment.revision !== input.revision || snapshot !== input.bindingSnapshot) throw new ActionFailureError('projectResourceConflict')
    const historical = (await tx.execute<{ recipe: ProjectSetupRecipe | null }>(sql`select recipe from workspace_environment_setup_versions
      where "workspaceId"=${input.workspaceId} and "environmentId"=${environment.id} and revision=${input.version}`)).rows[0]
    if (!historical) throw new ActionFailureError('projectEnvironmentUnavailable')
    const { setup: _previous, ...current } = environment.configuration
    const configuration = environmentConfiguration.parse({ ...current, ...(historical.recipe ? { setup: { ...historical.recipe, approved: false } } : {}) })
    const revision = environment.revision + 1
    await persistEnvironment(tx, reader, input.workspaceId, environment.id, environment.name, configuration, revision, null)
    await audit(tx, reader, input.workspaceId, 'environment.setup_restored', environment.id, { projectId: input.projectId, fromRevision: input.version, revision })
    await workspaceListChanged(tx, input.workspaceId, ['workspace_settings'])
    return { id: environment.id, revision }
  })
}

export async function saveProjectResources(reader: Reader, raw: z.input<typeof projectResourceMutation>) {
  const input = projectResourceMutation.parse(raw)
  return withConfiguredProject(reader, input.workspaceId, input.projectId, true, async (tx, project) => {
    let bindings: ProjectRepositoryBinding[]
    let counts: { repositoryCount: number; environmentCount?: number }
    if ('repos' in input) {
      // The current provisioning path cannot promise lazy clones.
      if (input.repos.some(repo => repo.mode === 'lazy')) throw new GovernanceError('feature_unavailable')
      const existing = await projectRepositoryBindings(tx, input.workspaceId, input.projectId)
      const byKey = new Map(existing.map(row => [row.repositoryKey, row]))
      let primary = existing.find(row => row.isPrimary)?.repositoryKey
      bindings = []
      for (const item of input.repos) {
        const repositoryKey = normalizeRepository(item.repoFullName).key
        const previous = byKey.get(repositoryKey)
        if (previous) {
          if ((item.baseBranch !== undefined && (item.baseBranch || null) !== previous.baseBranch)
            || (item.mode === 'primary' && !previous.isPrimary)) throw new ActionFailureError('projectResourceConflict')
          continue
        }
        const isPrimary = item.mode === 'primary'
        if (isPrimary && primary) throw new ActionFailureError('projectResourceConflict')
        if (isPrimary) primary = repositoryKey
        const binding = repositoryBindingInput.parse({ repositoryKey, baseBranch: item.baseBranch || null, isPrimary })
        bindings.push(binding)
        byKey.set(repositoryKey, binding)
      }
      z.number().max(maxProjectRepositories).parse(byKey.size)
      counts = { repositoryCount: byKey.size }
    } else {
      if (project.revision !== input.revision) throw new ActionFailureError('projectResourceConflict')
      const ids = [...new Set(input.environmentIds)]
      for (const id of ids) {
        const environment = await tx.execute(sql`select id from workspace_environments where id=${id} and "workspaceId"=${input.workspaceId} and "archivedAt" is null`)
        if (!environment.rowCount) throw new ActionFailureError('projectEnvironmentUnavailable')
      }
      await tx.execute(sql`delete from workspace_project_repositories where "projectId"=${input.projectId}`)
      await tx.execute(sql`delete from workspace_project_environments where "projectId"=${input.projectId}`)
      for (const id of ids) await tx.execute(sql`insert into workspace_project_environments("projectId","workspaceId","environmentId","isDefault") values(${input.projectId},${input.workspaceId},${id},${id === input.defaultEnvironmentId})`)
      bindings = input.repositories
      counts = { repositoryCount: bindings.length, environmentCount: ids.length }
    }
    let revision = project.revision
    if (bindings.length || !('repos' in input)) {
      for (const repo of bindings) await tx.execute(sql`insert into workspace_project_repositories("projectId","workspaceId","repositoryKey","baseBranch","environmentId","isPrimary") values(${input.projectId},${input.workspaceId},${repo.repositoryKey},${repo.baseBranch},${repo.environmentId},${repo.isPrimary})`)
      revision += 1
      await tx.execute(sql`update workspace_projects set revision=${revision},"updatedAt"=now() where id=${input.projectId} and "workspaceId"=${input.workspaceId}`)
      await audit(tx, reader, input.workspaceId, 'project_resources.changed', input.projectId, { revision, ...counts })
      await (await import('@/lib/live/project-map')).projectMapChanged(tx, input.projectId)
      await workspaceListChanged(tx, input.workspaceId, ['workspace_settings'])
    }
    if (!('repos' in input)) return { revision }
    const [view] = await accessibleProjects(reader, tx, input.workspaceId, input.projectId)
    if (!view) throw new ActionFailureError('projectNotFound')
    const repositories = await projectRepositoryBindings(tx, input.workspaceId, input.projectId)
    return { ...view, repos: repositories.map(binding => ({
      ...binding,
      repoFullName: binding.repositoryKey.startsWith('v2/github.com/') ? binding.repositoryKey.slice('v2/github.com/'.length) : null,
    })) }
  })
}

/** Change only the default; repository overrides and other admitted environments survive. */
export async function setProjectDefaultEnvironment(reader: Reader, raw: z.input<typeof projectDefaultEnvironmentInput>) {
  const input = projectDefaultEnvironmentInput.parse(raw)
  return withConfiguredProject(reader, input.workspaceId, input.projectId, true, async (tx, project) => {
    if (project.revision !== input.revision) throw new ActionFailureError('projectResourceConflict')
    if (input.environmentId) {
      const environment = await tx.execute(sql`select id from workspace_environments where id=${input.environmentId} and "workspaceId"=${input.workspaceId} and "archivedAt" is null`)
      if (!environment.rowCount) throw new ActionFailureError('projectEnvironmentUnavailable')
    }
    await tx.execute(sql`update workspace_project_environments set "isDefault"=false where "projectId"=${input.projectId} and "workspaceId"=${input.workspaceId} and "isDefault"`)
    if (input.environmentId) await tx.execute(sql`insert into workspace_project_environments("projectId","workspaceId","environmentId","isDefault")
      values(${input.projectId},${input.workspaceId},${input.environmentId},true)
      on conflict("projectId","environmentId") do update set "isDefault"=true`)
    await tx.execute(sql`update workspace_projects set revision=revision+1,"updatedAt"=now() where id=${input.projectId} and "workspaceId"=${input.workspaceId}`)
    await audit(tx, reader, input.workspaceId, 'project_resources.changed', input.projectId, { revision: input.revision + 1 })
    await (await import('@/lib/live/project-map')).projectMapChanged(tx, input.projectId)
    await workspaceListChanged(tx, input.workspaceId, ['workspace_settings'])
    return { revision: input.revision + 1 }
  })
}

/** `environmentId`: an Environment the run's request chose, used instead of the Project's default (it must still fit). */
export type ProjectExecutionInput = { userId: string; workspaceId: string; issueId: string; repositoryKey: string | null; baseBranch: string | null; runtime: 'local' | 'cloud'; harness: string; environmentId?: string }

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
      const { repositories, defaultEnvironmentId } = await configuredProjectBindings(tx, input.workspaceId, selected.id)
      const binding = repositories.find(repo => repo.repositoryKey === input.repositoryKey)
      if (input.repositoryKey && repositories.length && !binding) throw new ActionFailureError('projectRepositoryDenied')
      baseBranch = binding?.baseBranch ?? input.baseBranch
      environmentId = binding?.selectedEnvironmentId ?? defaultEnvironmentId
    }
    if (input.environmentId) environmentId = input.environmentId
    let environment: ProjectExecutionSnapshot['environment'] = null
    if (environmentId) {
      const rows = await tx.execute<EnvironmentRow>(sql`select id,"workspaceId",name,configuration,revision,"archivedAt","defaultMachineSize" from workspace_environments where id=${environmentId} and "workspaceId"=${input.workspaceId} and "archivedAt" is null`)
      const row = rows.rows[0]
      if (!row) throw new ActionFailureError('projectEnvironmentUnavailable')
      const parsed = environmentConfiguration.safeParse(row.configuration)
      if (!parsed.success) throw new ActionFailureError('projectEnvironmentUnavailable')
      const config = parsed.data
      if ((config.runtime !== 'any' && config.runtime !== input.runtime) || (config.harness !== 'any' && config.harness !== input.harness) || (config.repositoryKeys.length && (!input.repositoryKey || !config.repositoryKeys.includes(input.repositoryKey)))) throw new ActionFailureError('projectEnvironmentUnavailable')
      await secretsFit(input.workspaceId, config, input.repositoryKey)
      environment = { id: row.id, revision: row.revision, name: row.name, ...config, ...(input.environmentId ? { chosen: true as const } : {}),
        ...(isMachineSize(row.defaultMachineSize) ? { defaultMachineSize: row.defaultMachineSize } : {}) }
    }
    return operation({ version: 1, workspaceId: input.workspaceId, projectId: selected?.id ?? null, projectRevision: selected?.revision ?? null, policyRevision: policy.rows[0]?.revision ?? 0, repositoryKey: input.repositoryKey, baseBranch, environment })
  }, requireExisting)
}
