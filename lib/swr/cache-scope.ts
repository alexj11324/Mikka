import 'server-only'
import { cookies } from 'next/headers'
import { and, asc, eq } from 'drizzle-orm'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers, workspaces } from '@/lib/db/workspace-schema'

export type AuthorizedCacheWorkspace = { workspaceId: string; role: 'admin' | 'member' }

/** A small, read-only authorization check before any disk data is shown. It
 * deliberately does not load members, invitations, task bodies or credentials.
 * A removed membership or downgraded role cannot hydrate its previous namespace. */
export async function authorizedCacheWorkspace(userId: string, requestedId?: string): Promise<AuthorizedCacheWorkspace | null> {
  const memberships = await workspaceDb.select({ workspaceId: workspaces.id, role: workspaceMembers.role })
    .from(workspaces).innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
    .orderBy(asc(workspaces.createdAt))
  const selected = requestedId ?? (await cookies()).get('mikka-workspace')?.value
  const match = memberships.find(item => item.workspaceId === selected)
  return match ?? (requestedId ? null : memberships[0] ?? null)
}
