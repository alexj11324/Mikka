import 'server-only'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, pool, withDatabaseTransaction } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { ActionFailureError } from '@/lib/action-error'
import { requireTaskWorkspace } from '@/lib/task-workspace'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { readRunChain } from '@/lib/run-chain'
import { botChatResourceId, lockResourceAccess } from '@/lib/resource-access/store'
import { SHARING_GRANT_ACTIONS, type ResourceAction, type ResourceKind } from '@/lib/resource-access/contract'
import { InteropError } from './errors'

/**
 * Explicit grants to a Bot, a run or a service identity (decision 2026-11-19-2200 §1).
 * Such a subject is authorized only by these rows. Creating one shares the
 * resource's content, so only someone holding `canManageAccess` (its owner)
 * may create it; a Workspace admin may list and revoke, never create, keeping
 * the rule that admin status never grants content.
 */
export const GRANT_RESOURCE_KINDS = ['thread', 'artifact', 'bot', 'task', 'chat'] as const
export const AGENT_GRANT_SUBJECTS = ['bot', 'run', 'service'] as const
export type AgentGrantSubject = typeof AGENT_GRANT_SUBJECTS[number]

export const agentGrantInput = z.object({
  subjectKind: z.enum(AGENT_GRANT_SUBJECTS),
  subjectId: z.uuid(),
  capabilities: z.array(z.enum(SHARING_GRANT_ACTIONS as [ResourceAction, ...ResourceAction[]])).min(1).max(SHARING_GRANT_ACTIONS.length),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
}).strict()

export interface AgentGrant { subjectKind: AgentGrantSubject; subjectId: string; capabilities: ResourceAction[]; expiresAt: string | null; createdAt: string }
type Manager = { userId: string; workspaceId: string }
type Target = { kind: ResourceKind; id: string; workspaceId: string; ownerId: string | null }

function notFound(cause?: unknown): never {
  throw new InteropError('interop_not_found', cause === undefined ? {} : { cause })
}

/**
 * The policy a caller names, in the caller's tenant. A thread is its root run;
 * a chat is named by its Bot and means that Bot owner's chat with it.
 */
async function target(manager: Manager, rawKind: string, rawId: string): Promise<Target> {
  const kind = z.enum(GRANT_RESOURCE_KINDS).safeParse(rawKind)
  if (!kind.success || !z.uuid().safeParse(rawId).success) notFound()
  try { await requireTaskWorkspace({ id: manager.userId, [tokenWorkspace]: manager.workspaceId }, manager.workspaceId) }
  catch (error) { if (error instanceof ActionFailureError) notFound(error); throw error }
  let id = rawId
  if (kind.data === 'thread') {
    const { rows: [run] } = await pool.query<{ userId: string; workspaceId: string | null }>('SELECT "userId","workspaceId" FROM agent_runs WHERE id=$1', [rawId])
    if (!run || run.workspaceId !== manager.workspaceId) notFound()
    const chain = await readRunChain(pool, run.userId, rawId)
    if (!chain) notFound()
    id = chain.rootRunId
  }
  if (kind.data === 'chat') {
    const { rows: [bot] } = await pool.query<{ ownerId: string | null; workspaceId: string }>('SELECT "ownerId","workspaceId" FROM bots WHERE id=$1', [rawId])
    if (!bot?.ownerId || bot.workspaceId !== manager.workspaceId) notFound()
    id = botChatResourceId(bot.ownerId, rawId)
  }
  const { rows: [policy] } = await pool.query<{ ownerId: string | null }>(
    'SELECT "ownerId" FROM resource_access_policies WHERE kind=$1 AND id=$2 AND "workspaceId"=$3', [kind.data, id, manager.workspaceId])
  if (!policy) notFound()
  return { kind: kind.data, id, workspaceId: manager.workspaceId, ownerId: policy.ownerId }
}

async function canManage(manager: Manager, resource: Target): Promise<boolean> {
  const { rows: [row] } = await pool.query<{ allowed: boolean }>(
    `SELECT mikka_resource_acl_allowed('account',$1,$2,$3,$4,'canManageAccess') AS allowed`, [manager.userId, resource.workspaceId, resource.kind, resource.id])
  return row?.allowed === true
}

async function isAdmin(manager: Manager): Promise<boolean> {
  const { rowCount } = await workspacePool.query(`SELECT 1 FROM mikka_workspace_members
    WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active' AND role='admin'`, [manager.workspaceId, manager.userId])
  return Boolean(rowCount)
}

/** The subject exists, in the same tenant, and is alive. */
async function requireSubject(workspaceId: string, kind: AgentGrantSubject, id: string): Promise<void> {
  const found = kind === 'bot'
    ? await pool.query('SELECT 1 FROM bots WHERE id=$1 AND "workspaceId"=$2 AND "archivedAt" IS NULL', [id, workspaceId])
    : kind === 'run'
    ? await pool.query('SELECT 1 FROM agent_runs WHERE id=$1 AND "workspaceId"=$2', [id, workspaceId])
    : await workspacePool.query('SELECT 1 FROM mikka_workspace_service_identities WHERE id=$1 AND "workspaceId"=$2 AND enabled', [id, workspaceId])
  if (!found.rowCount) throw new InteropError('interop_invalid_request')
}

async function grantsOf(resource: Target): Promise<AgentGrant[]> {
  const { rows } = await pool.query<{ subjectKind: AgentGrantSubject; subjectId: string; capabilities: ResourceAction[]; expiresAt: Date | null; createdAt: Date }>(
    `SELECT "subjectKind","subjectId",capabilities,"expiresAt","createdAt" FROM resource_access_grants
     WHERE "resourceKind"=$1 AND "resourceId"=$2 AND "subjectKind" IN ('bot','run','service') ORDER BY "createdAt","subjectKind","subjectId"`, [resource.kind, resource.id])
  return rows.map(row => ({ ...row, expiresAt: row.expiresAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() }))
}

/** Bot, run and service grants on one resource. Owner or Workspace admin. */
export async function listAgentGrants(manager: Manager, kind: string, id: string): Promise<{ resource: { kind: ResourceKind; id: string }; grants: AgentGrant[] }> {
  const resource = await target(manager, kind, id)
  if (!await canManage(manager, resource) && !await isAdmin(manager)) notFound()
  return { resource: { kind: resource.kind, id: resource.id }, grants: await grantsOf(resource) }
}

/** Create or replace one subject's grant. Only the resource's manager (owner). */
export async function putAgentGrant(manager: Manager, kind: string, id: string, raw: unknown): Promise<AgentGrant> {
  const parsed = agentGrantInput.safeParse(raw)
  if (!parsed.success) throw new InteropError('interop_invalid_request', { cause: parsed.error })
  const input = parsed.data
  if (input.expiresAt && new Date(input.expiresAt).getTime() <= Date.now()) throw new InteropError('interop_invalid_request')
  const resource = await target(manager, kind, id)
  await requireSubject(resource.workspaceId, input.subjectKind, input.subjectId)
  try {
    await db.transaction(tx => withDatabaseTransaction(tx, async () => {
      // Lock the ancestry and recheck canManageAccess under the same lease as content writers.
      await lockResourceAccess(tx, manager.userId, { kind: resource.kind, id: resource.id, workspaceId: resource.workspaceId }, 'canManageAccess', true)
      await tx.execute(sql`select set_config('mikka.acl_actor',${manager.userId},true),set_config('mikka.acl_source','agent_access_grant',true)`)
      await tx.execute(sql`insert into resource_access_grants("resourceKind","resourceId","subjectKind","subjectId",capabilities,"expiresAt")
        values(${resource.kind},${resource.id}::uuid,${input.subjectKind},${input.subjectId},${sql.param([...new Set(input.capabilities)])}::text[],${input.expiresAt ?? null}::timestamptz)
        on conflict ("resourceKind","resourceId","subjectKind","subjectId") do update set capabilities=excluded.capabilities,"expiresAt"=excluded."expiresAt"`)
    }))
  } catch (error) {
    if (error instanceof ActionFailureError) notFound(error)
    throw error
  }
  const grant = (await grantsOf(resource)).find(row => row.subjectKind === input.subjectKind && row.subjectId === input.subjectId)
  if (!grant) notFound()
  return grant
}

/** Revoke one subject's grant. Owner or Workspace admin: removing access never shares anything. */
export async function deleteAgentGrant(manager: Manager, kind: string, id: string, subjectKind: string, subjectId: string): Promise<{ revoked: boolean }> {
  if (!z.enum(AGENT_GRANT_SUBJECTS).safeParse(subjectKind).success || !z.uuid().safeParse(subjectId).success) notFound()
  const resource = await target(manager, kind, id)
  if (!await canManage(manager, resource) && !await isAdmin(manager)) notFound()
  const result = await db.transaction(tx => withDatabaseTransaction(tx, async () => {
    await tx.execute(sql`select set_config('mikka.acl_actor',${manager.userId},true),set_config('mikka.acl_source','agent_access_revoke',true)`)
    return tx.execute(sql`delete from resource_access_grants where "resourceKind"=${resource.kind} and "resourceId"=${resource.id}::uuid
      and "subjectKind"=${subjectKind} and "subjectId"=${subjectId}`)
  }))
  return { revoked: Boolean(result.rowCount) }
}
