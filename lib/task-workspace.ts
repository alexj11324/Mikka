import 'server-only'
import { and, asc, eq, or } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { actingContext } from '@/lib/activity-actor'
import { workspaces, workspaceMembers } from '@/lib/db/workspace-schema'
import { workspaceDb } from '@/lib/workspace-db'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal, type EnterprisePrincipal } from '@/lib/enterprise/principal'

type Reader = string | { id: string; [tokenWorkspace]?: string; [enterprisePrincipal]?: EnterprisePrincipal }
type WorkspaceTransaction = Parameters<Parameters<typeof workspaceDb.transaction>[0]>[0]
export type TaskWorkspace = { id: string; kind: 'personal' | 'team' }

export function taskReaderScope(reader: Reader) {
  const userId = typeof reader === 'string' ? reader : reader.id
  const acting = actingContext.getStore()
  const pinned = typeof reader === 'string' ? undefined : reader[tokenWorkspace]
  return { userId, workspaceId: pinned ?? (acting?.userId === userId ? acting.tokenWorkspaceId : undefined) }
}

function membership(userId: string, workspaceId?: string) {
  return and(
    eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active'),
    workspaceId ? eq(workspaces.id, workspaceId) : undefined,
    // Even a corrupt membership row cannot turn a personal tenant into a team.
    or(eq(workspaces.kind, 'team'), and(eq(workspaces.kind, 'personal'), eq(workspaces.userId, userId))),
  )
}

/** Read on every operation. Billing and organization roles never grant membership. */
export async function activeTaskWorkspaces(reader: Reader, requestedId?: string): Promise<TaskWorkspace[]> {
  const scope = taskReaderScope(reader)
  if (requestedId && !z.uuid().safeParse(requestedId).success) return []
  if (scope.workspaceId && requestedId && scope.workspaceId !== requestedId) return []
  const rows = await workspaceDb.select({ id: workspaces.id, kind: workspaces.kind }).from(workspaces)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(membership(scope.userId, scope.workspaceId ?? requestedId)).orderBy(asc(workspaces.createdAt))
  return rows
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
    const [member] = await tx.select({ id: workspaceMembers.userId }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, scope.userId), eq(workspaceMembers.status, 'active'))).for('share')
    if (!member) throw new ActionFailureError('workspaceAccessDenied')
    return work(workspace, tx)
  })
}

/** Validate an internal creator's explicit tenant; never use title, creator or scope. */
export async function requireTaskWorkspace(reader: Reader, workspaceId: string): Promise<TaskWorkspace> {
  const [workspace] = await activeTaskWorkspaces(reader, workspaceId)
  if (!workspace) throw new ActionFailureError('workspaceAccessDenied')
  return workspace
}
