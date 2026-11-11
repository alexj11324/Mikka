import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
import { and, asc, eq, or } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { WorkspaceError } from '@/lib/workspace-error'
import { actingContext } from '@/lib/activity-actor'
import { workspaces, workspaceMembers } from '@/lib/db/workspace-schema'
import { organizationWorkspaces } from '@/lib/db/governance-schema'
import * as workspaceDatabase from '@/lib/workspace-db'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { filterEnterpriseWorkspaceLinks, filterEnterpriseWorkspaces } from '@/lib/enterprise/access'
import { enterprisePrincipal, type EnterprisePrincipal } from '@/lib/enterprise/principal'

const { workspaceDb } = workspaceDatabase
// Short aliases keep the repeated fresh membership/Org SELECT bounded on the
// wire. Locking readers retain their original table references and predicates.
const readerWorkspace = alias(workspaces, 'w')
const readerMember = alias(workspaceMembers, 'm')
const readerOrganization = alias(organizationWorkspaces, 'o')

type Reader = string | { id: string; [tokenWorkspace]?: string; [enterprisePrincipal]?: EnterprisePrincipal }
type WorkspaceTransaction = Parameters<Parameters<typeof workspaceDb.transaction>[0]>[0]
export type TaskWorkspace = { id: string; kind: 'personal' | 'team' }

type HeldTaskWorkspace = {
  userId: string; workspaceId: string; kind: TaskWorkspace['kind']; organizationId: string | null; tx: WorkspaceTransaction; active: boolean;
  changedOrganizationWorkspaces: Set<string> | null;
  workspaceTransactionKey: object | null;
  parent?: HeldTaskWorkspace;
}
const taskWorkspaceLease = new AsyncLocalStorage<HeldTaskWorkspace>()
function leaseActive(lease: HeldTaskWorkspace): boolean {
  return lease.active
    && (!lease.workspaceTransactionKey || workspaceDatabase.workspaceTransactionKey?.() === lease.workspaceTransactionKey)
    && (!lease.parent || leaseActive(lease.parent))
}
const organizationChanges = new WeakMap<object, Set<string>>()
function currentOrganizationChanges(): Set<string> | null {
  // Executors without an active transaction identity retain fresh-link reads.
  const key = workspaceDatabase.workspaceTransactionKey?.()
  if (!key) return null
  let changed = organizationChanges.get(key)
  if (!changed) { changed = new Set<string>(); organizationChanges.set(key, changed) }
  return changed
}

/** A canonical attach/detach can upgrade this transaction's own Workspace
 * lock. Every branch of that transaction shares invalidations, even outside a
 * Task lease. Rollback never restores an earlier linkage projection. */
export function invalidateTaskWorkspaceOrganization(workspaceId: string): void {
  currentOrganizationChanges()?.add(workspaceId)
}

export type BorrowedTaskWorkspaceMembership = { workspaceClient: Pick<PoolClient, 'query'>; check(): Promise<void>; close(): Promise<void> }

/** A borrow cannot release the owner transaction or authorize another tenant.
 * Its fresh read uses the held WS executor; no second pool checkout occurs. */
export function borrowTaskWorkspaceMembership(userId: string, workspaceId: string): BorrowedTaskWorkspaceMembership | null {
  const lease = taskWorkspaceLease.getStore()
  if (!lease || !leaseActive(lease)) return null
  if (lease.userId !== userId || lease.workspaceId !== workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  let closed = false
  const assertActive = () => { if (closed || !leaseActive(lease)) throw new ActionFailureError('workspaceAccessDenied') }
  // Capture the current WS executor while its owning transaction is active.
  // The wrapper refuses use after close or after that transaction completes.
  const query = workspaceDatabase.workspacePool.query
  return {
    workspaceClient: { query: ((...args: unknown[]) => { assertActive(); return Reflect.apply(query, workspaceDatabase.workspacePool, args) }) as PoolClient['query'] },
    async check() {
      assertActive()
      const [current] = await lease.tx.select({ id: workspaces.id }).from(workspaces)
        .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
        .where(membership(userId, workspaceId)).limit(1)
      assertActive()
      if (!current) throw new ActionFailureError('workspaceAccessDenied')
    },
    async close() { closed = true },
  }
}

export function taskReaderScope(reader: Reader) {
  const userId = typeof reader === 'string' ? reader : reader.id
  const acting = actingContext.getStore()
  const pinned = typeof reader === 'string' ? undefined : reader[tokenWorkspace]
  return { userId, workspaceId: pinned ?? (acting?.userId === userId ? acting.tokenWorkspaceId : undefined) }
}

function membership(userId: string, workspaceId?: string,
  workspace: typeof workspaces | typeof readerWorkspace = workspaces, member: typeof workspaceMembers | typeof readerMember = workspaceMembers) {
  return and(
    eq(member.userId, userId), eq(member.status, 'active'),
    workspaceId ? eq(workspace.id, workspaceId) : undefined,
    // Even a corrupt membership row cannot turn a personal tenant into a team.
    or(eq(workspace.kind, 'team'), and(eq(workspace.kind, 'personal'), eq(workspace.userId, userId))),
  )
}

/** Read on every operation, or reuse only the membership held by this exact
 * active lease. Enterprise policy and principal are checked on every call. */
export async function activeTaskWorkspaces(reader: Reader, requestedId?: string): Promise<TaskWorkspace[]> {
  const scope = taskReaderScope(reader)
  if (requestedId && !z.uuid().safeParse(requestedId).success) return []
  if (scope.workspaceId && requestedId && scope.workspaceId !== requestedId) return []
  const selectedId = scope.workspaceId ?? requestedId
  const lease = taskWorkspaceLease.getStore()
  // Membership and Org attachment writers take the Workspace lock first.
  // The exact active lease may reuse those locked facts, never a policy result:
  // SSO, directory, provider and principal checks remain fresh on every read.
  if (selectedId && lease && leaseActive(lease) && lease.userId === scope.userId && lease.workspaceId === selectedId) {
    if (!lease.changedOrganizationWorkspaces || lease.changedOrganizationWorkspaces.has(selectedId))
      return filterEnterpriseWorkspaces(reader, [{ id: lease.workspaceId, kind: lease.kind }])
    const rows = await filterEnterpriseWorkspaceLinks(reader, [{ id: lease.workspaceId, kind: lease.kind, organizationId: lease.organizationId }])
    return rows.map(({ id, kind }) => ({ id, kind }))
  }
  const rows = await workspaceDb.select({ id: readerWorkspace.id, kind: readerWorkspace.kind, organizationId: readerOrganization.organizationId }).from(readerWorkspace)
    .innerJoin(readerMember, eq(readerMember.workspaceId, readerWorkspace.id))
    .leftJoin(readerOrganization, eq(readerOrganization.workspaceId, readerWorkspace.id))
    .where(membership(scope.userId, selectedId, readerWorkspace, readerMember)).orderBy(asc(readerWorkspace.createdAt))
  return (await filterEnterpriseWorkspaceLinks(reader, rows)).map(({ id, kind }) => ({ id, kind }))
}

/** Pin authoritative membership until the app write commits. Call outside the
 * application transaction: split DB deployments need no cross-database FK. */
export async function withTaskWorkspace<T>(reader: Reader, workspaceId: string, work: (workspace: TaskWorkspace, tx: WorkspaceTransaction) => Promise<T>): Promise<T> {
  const scope = taskReaderScope(reader)
  if (!z.uuid().safeParse(workspaceId).success || (scope.workspaceId && scope.workspaceId !== workspaceId)) throw new ActionFailureError('workspaceAccessDenied')
  return workspaceDb.transaction(async tx => {
    // Every admission locks workspace then member, matching seat/role writes.
    const [workspace] = await tx.select({ id: workspaces.id, kind: workspaces.kind, ownerId: workspaces.userId }).from(workspaces)
      .where(eq(workspaces.id, workspaceId)).for('share')
    if (!workspace || (workspace.kind === 'personal' && workspace.ownerId !== scope.userId)) throw new ActionFailureError('workspaceAccessDenied')
    // Read linkage only after acquiring the Workspace lock: a join in the
    // earlier locking statement could keep a pre-wait attachment snapshot.
    const [member] = await tx.select({ id: workspaceMembers.userId, organizationId: organizationWorkspaces.organizationId }).from(workspaceMembers)
      .leftJoin(organizationWorkspaces, eq(organizationWorkspaces.workspaceId, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, scope.userId), eq(workspaceMembers.status, 'active'))).for('share', { of: workspaceMembers })
    if (!member) throw new ActionFailureError('workspaceAccessDenied')
    try {
      if (!(await filterEnterpriseWorkspaceLinks(reader, [{ id: workspaceId, organizationId: member.organizationId }])).length)
        throw new WorkspaceError('workspaceAccessDenied')
    }
    catch (error) {
      // This task boundary has one established refusal type for native claims,
      // quota continuations and human writes. Do not turn a policy refusal into
      // a fallback or normalize infrastructure/programming errors.
      if (error instanceof WorkspaceError && error.code === 'workspaceAccessDenied') {
        const denied = new ActionFailureError('workspaceAccessDenied')
        denied.cause = error
        throw denied
      }
      throw error
    }
    const parent = taskWorkspaceLease.getStore()
    const changedOrganizationWorkspaces = currentOrganizationChanges()
    const lease: HeldTaskWorkspace = { userId: scope.userId, workspaceId, kind: workspace.kind, organizationId: member.organizationId, tx, active: true,
      changedOrganizationWorkspaces,
      workspaceTransactionKey: workspaceDatabase.workspaceTransactionKey?.() ?? null,
      ...(parent && leaseActive(parent) ? { parent } : {}) }
    try { return await taskWorkspaceLease.run(lease, () => work(workspace, tx)) }
    finally { lease.active = false }
  })
}

/** Validate an internal creator's explicit tenant; never use title, creator or scope. */
export async function requireTaskWorkspace(reader: Reader, workspaceId: string): Promise<TaskWorkspace> {
  const [workspace] = await activeTaskWorkspaces(reader, workspaceId)
  if (!workspace) throw new ActionFailureError('workspaceAccessDenied')
  return workspace
}

