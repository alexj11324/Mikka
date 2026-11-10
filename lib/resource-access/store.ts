import 'server-only'
import { createHash } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, withDatabaseTransaction } from '@/lib/db'
import { ActionFailureError } from '@/lib/action-error'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { activeTaskWorkspaces, taskReaderScope, withTaskWorkspace } from '@/lib/task-workspace'
import { workspaceDb } from '@/lib/workspace-db'
import type { IssueReader } from '@/lib/issue-visibility'
import { RESOURCE_ACTIONS, RESOURCE_KINDS, SHARING_GRANT_ACTIONS, deniedResourceCapabilities, resourceManagementMetadata,
  type ResourceAction, type ResourceCapabilities, type ResourceKind, type ResourcePolicy, type ResourceReference } from './contract'

export type ResourceExecutor = Pick<typeof db, 'execute'>
const referenceSchema = z.object({ kind: z.enum(RESOURCE_KINDS), id: z.uuid(), workspaceId: z.uuid() }).strict()
const columns = sql`kind,id,"workspaceId","ownerId",visibility,revision,"parentKind","parentId",provenance,"createdAt","updatedAt"`

/** Historical bot chats use their real owner+bot identity; null legacy bots
 * have no tenant and remain quarantined until a trusted migration resolves it. */
export function botChatResourceId(ownerId: string, botId: string | null): string {
  const hex = createHash('sha256').update(`${ownerId}:${botId ?? 'coordinator'}`).digest('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function resourceAncestry(reference: ResourceReference) {
  return sql`with recursive ancestry as (
    select kind,id,"parentKind","parentId",0 as depth,array[kind||':'||id::text] as path,false as cycle
      from resource_access_policies where kind=${reference.kind} and id=${reference.id}::uuid
    union all select p.kind,p.id,p."parentKind",p."parentId",a.depth+1,a.path||(p.kind||':'||p.id::text),(p.kind||':'||p.id::text)=any(a.path)
      from ancestry a join resource_access_policies p on p.kind=a."parentKind" and p.id=a."parentId" where a.depth<32 and not a.cycle
  )`
}

/** The caller has already proved the exact Workspace. All content checks,
 * including list predicates, resolve this same ancestry and grant function. */
export async function resourceActionAllowed(executor: ResourceExecutor, readerId: string, reference: ResourceReference, action: ResourceAction): Promise<boolean> {
  const { rows: [row] } = await executor.execute<{ allowed: boolean }>(sql`select mikka_resource_acl_allowed('account',${readerId},${reference.workspaceId}::uuid,${reference.kind},${reference.id}::uuid,${action}) as allowed`)
  return row?.allowed === true
}

export async function requireResourceAccess(reader: IssueReader, reference: ResourceReference, action: ResourceAction = 'canReadContent', executor: ResourceExecutor = db): Promise<void> {
  const parsed = referenceSchema.safeParse(reference)
  if (!parsed.success || !(await activeTaskWorkspaces(reader, reference.workspaceId)).length
    || !await resourceActionAllowed(executor, taskReaderScope(reader).userId, reference, action)) throw new ActionFailureError('issueNotFound')
}

/** Hold every ancestor until the application transaction ends. A parent may
 * have changed while locks were waiting, so compare the complete chain again
 * before authorizing. A grant mutation locks its policy row, too. This uses
 * row locks, never a Workspace-wide serial bottleneck or a stale ACL cache. */
export async function lockResourceAccess(executor: ResourceExecutor, userId: string, reference: ResourceReference, action: ResourceAction, writePolicy = false): Promise<ResourcePolicy> {
  return (await lockResourcesAccess(executor, userId, [{ reference, action }], writePolicy))[0]
}

/** Graph edits can touch several Tasks. Acquire the union of their ancestors
 * in one deterministic order before any content row, including overlapping
 * private parents; locking each resource separately can deadlock. */
export async function lockResourcesAccess(executor: ResourceExecutor, userId: string,
  requests: readonly { reference: ResourceReference; action: ResourceAction }[], writePolicy = false): Promise<ResourcePolicy[]> {
  if (!requests.length) return []
  for (const { reference } of requests) referenceSchema.parse(reference)
  const roots = sql.join(requests.map(({ reference }) => sql`(${reference.kind}::text,${reference.id}::uuid)`), sql`, `)
  const ancestry = sql`with recursive ancestry as (
    select kind,id,"parentKind","parentId",0 as depth,array[kind||':'||id::text] as path,false as cycle
      from resource_access_policies where (kind,id) in (${roots})
    union all select p.kind,p.id,p."parentKind",p."parentId",a.depth+1,a.path||(p.kind||':'||p.id::text),(p.kind||':'||p.id::text)=any(a.path)
      from ancestry a join resource_access_policies p on p.kind=a."parentKind" and p.id=a."parentId" where a.depth<32 and not a.cycle
  )`
  const strength = writePolicy ? sql`for update of p` : sql`for share of p`
  const locked = await executor.execute<ResourcePolicy>(sql`${ancestry} select p.* from resource_access_policies p
    where (p.kind,p.id) in (select kind,id from ancestry) order by p.kind,p.id ${strength}`)
  const { rows: current } = await executor.execute<{ kind: ResourceKind; id: string }>(sql`${ancestry} select kind,id from ancestry`)
  const keys = new Set(locked.rows.map(row => `${row.kind}:${row.id}`))
  if (current.some(row => !keys.has(`${row.kind}:${row.id}`))) throw new ActionFailureError('issueNotFound')
  const result: ResourcePolicy[] = []
  for (const { reference, action } of requests) {
    const policy = locked.rows.find(row => row.kind === reference.kind && row.id === reference.id)
    if (!policy || !await resourceActionAllowed(executor, userId, reference, action)) throw new ActionFailureError('issueNotFound')
    result.push(policy)
  }
  return result
}

/** Canonical write lease: Workspace and membership first, then APP ACL rows,
 * then the caller's resource rows. Nested actions share this APP transaction. */
export async function withResourceAccess<T>(reader: IssueReader, reference: ResourceReference, action: ResourceAction,
  work: (policy: ResourcePolicy) => Promise<T>): Promise<T> {
  referenceSchema.parse(reference)
  return withTaskWorkspace(reader, reference.workspaceId, () => db.transaction(tx => withDatabaseTransaction(tx, async () => {
    const policy = await lockResourceAccess(tx, taskReaderScope(reader).userId, reference, action)
    return work(policy)
  })))
}

/** Private administrative metadata is a separate projection. Admin status is
 * never passed to the database's content predicate and cannot grant content. */
export async function readResourceCapabilities(reader: IssueReader, reference: ResourceReference): Promise<ResourceCapabilities> {
  const denied = deniedResourceCapabilities()
  if (!referenceSchema.safeParse(reference).success || !(await activeTaskWorkspaces(reader, reference.workspaceId)).length) return denied
  const userId = taskReaderScope(reader).userId
  const { rows } = await db.execute<{ action: ResourceAction; allowed: boolean }>(sql`select action,
    mikka_resource_acl_allowed('account',${userId},${reference.workspaceId}::uuid,${reference.kind},${reference.id}::uuid,action) as allowed
    from unnest(${sql.param([...RESOURCE_ACTIONS])}::text[]) action`)
  const result = Object.fromEntries(rows.map(row => [row.action, row.allowed === true])) as ResourceCapabilities
  const [admin] = await workspaceDb.select({ role: workspaceMembers.role }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, reference.workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active'), eq(workspaceMembers.role, 'admin'))).limit(1)
  if (admin) {
    const { rows: [policy] } = await db.execute<{ present: boolean }>(sql`select true as present from resource_access_policies where kind=${reference.kind} and id=${reference.id}::uuid and "workspaceId"=${reference.workspaceId}::uuid`)
    if (policy) { result.canReadMetadata = true; result.canViewUsage = true }
  }
  return result
}

export async function readResourceManagementMetadata(reader: IssueReader, reference: ResourceReference) {
  if (!(await readResourceCapabilities(reader, reference)).canReadMetadata) return null
  const { rows: [policy] } = await db.execute<ResourcePolicy>(sql`select ${columns} from resource_access_policies where kind=${reference.kind} and id=${reference.id}::uuid and "workspaceId"=${reference.workspaceId}::uuid`)
  return policy ? resourceManagementMetadata(policy) : null
}

const grantSchema = z.object({ subjectId: z.string().min(1).max(256), capabilities: z.array(z.enum(RESOURCE_ACTIONS)).min(1).max(RESOURCE_ACTIONS.length), expiresAt: z.iso.datetime().nullable().optional() }).strict()
export const resourceAccessChangeSchema = z.object({ expectedRevision: z.number().int().positive(), visibility: z.enum(['shared', 'private']),
  grants: z.array(grantSchema).max(200), confirmExpansion: z.boolean().default(false) }).strict()

/** Owner-managed sharing. This never transfers ownership or grants access to
 * a model, machine, private key, personal memory or billing account. */
export async function changeResourceAccess(reader: IssueReader, reference: ResourceReference, input: z.input<typeof resourceAccessChangeSchema>) {
  const value = resourceAccessChangeSchema.parse(input)
  referenceSchema.parse(reference)
  const userId = taskReaderScope(reader).userId
  if (new Set(value.grants.map(grant => grant.subjectId)).size !== value.grants.length
    || value.grants.some(grant => !grant.capabilities.includes('canReadContent') || grant.capabilities.some(action => !SHARING_GRANT_ACTIONS.includes(action))))
    throw new ActionFailureError('validationGeneric')
  return withTaskWorkspace(reader, reference.workspaceId, async (_workspace, membership) => {
    const subjects = value.grants.map(grant => grant.subjectId)
    const active = subjects.length ? await membership.select({ id: workspaceMembers.userId }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, reference.workspaceId), eq(workspaceMembers.status, 'active'), inArray(workspaceMembers.userId, subjects))) : []
    if (active.length !== subjects.length) throw new ActionFailureError('workspaceAccessDenied')
    return db.transaction(tx => withDatabaseTransaction(tx, async () => {
      const current = await lockResourceAccess(tx, userId, reference, 'canManageAccess', true)
      if (current.revision !== value.expectedRevision) throw new ActionFailureError('issueOutdated')
      const { rows: previous } = await tx.execute<{ subjectId: string; capabilities: ResourceAction[]; expiresAt: Date | null }>(sql`select "subjectId",capabilities,"expiresAt" from resource_access_grants where "resourceKind"=${reference.kind} and "resourceId"=${reference.id}::uuid and "subjectKind"='account'`)
      const expansion = current.visibility !== 'shared' && value.visibility === 'shared'
        || value.grants.some(grant => {
          const old = previous.find(item => item.subjectId === grant.subjectId)
          return !old || grant.capabilities.some(action => !old.capabilities.includes(action))
            || old.expiresAt !== null && (!grant.expiresAt || new Date(grant.expiresAt).getTime() > old.expiresAt.getTime())
        })
      if (expansion && !value.confirmExpansion) throw new ActionFailureError('validationGeneric')
      const restriction = current.visibility === 'shared' && value.visibility === 'private'
        || previous.some(old => {
          const grant = value.grants.find(item => item.subjectId === old.subjectId)
          return !grant || old.capabilities.some(action => !grant.capabilities.includes(action))
            || Boolean(grant.expiresAt && (!old.expiresAt || new Date(grant.expiresAt).getTime() < old.expiresAt.getTime()))
        })
      if (restriction) {
        // Reuse the native execution revocation path. The already admitted
        // machine receives a stop hint; model traffic remains provider-direct.
        // All affected runs stop conservatively because older runs predate
        // distinct Actor/Execution Principal snapshots.
        const { rows: runs } = await tx.execute<{ id: string }>(sql`with recursive descendants as (
          select kind,id,0 as depth from resource_access_policies where kind=${reference.kind} and id=${reference.id}::uuid
          union all select p.kind,p.id,d.depth+1 from resource_access_policies p join descendants d
            on p."parentKind"=d.kind and p."parentId"=d.id where d.depth<32
        ) select distinct r.id from agent_runs r where r."workspaceId"=${reference.workspaceId}::uuid and (
          r.id in(select id from descendants where kind='thread') or r."issueId" in(select id from descendants where kind='task')
          or (${reference.kind}='bot' and r."botId"=${reference.id}::uuid))`)
        if (runs.length) {
          const { runPolicyStopSQL, notifyStoppedPolicyRuns } = await import('@/lib/run-policy-stop')
          const stopped = await tx.execute<import('@/lib/run-policy-stop').StoppedPolicyRun>(runPolicyStopSQL({ kind: 'runs', runIds: runs.map(run => run.id) }))
          notifyStoppedPolicyRuns(tx, stopped.rows)
        }
      }
      await tx.execute(sql`select set_config('mikka.acl_actor',${userId},true),set_config('mikka.acl_source','owner_access_change',true)`)
      await tx.execute(sql`update resource_access_policies set visibility=${value.visibility}
        where kind=${reference.kind} and id=${reference.id}::uuid`)
      await tx.execute(sql`delete from resource_access_grants where "resourceKind"=${reference.kind} and "resourceId"=${reference.id}::uuid and "subjectKind"='account'`)
      for (const grant of value.grants) await tx.execute(sql`insert into resource_access_grants("resourceKind","resourceId","subjectKind","subjectId",capabilities,"expiresAt")
        values(${reference.kind},${reference.id}::uuid,'account',${grant.subjectId},${sql.param([...new Set(grant.capabilities)])}::text[],${grant.expiresAt ?? null}::timestamptz)`)
      const { rows: [policy] } = await tx.execute<ResourcePolicy>(sql`select ${columns} from resource_access_policies where kind=${reference.kind} and id=${reference.id}::uuid`)
      if (reference.kind === 'task') await (await import('@/lib/live/panels')).documentChanged(tx, reference.id)
      return resourceManagementMetadata(policy)
    }))
  })
}
