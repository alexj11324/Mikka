import 'server-only'
import { cookies } from 'next/headers'
import { and, asc, eq, or } from 'drizzle-orm'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers, workspaces } from '@/lib/db/workspace-schema'
import { currentRequestScope } from '@/apps/api/src/context'
import { workspaceSelection } from '@/lib/workspace-selection'
import { enterpriseWorkspaceAllowed } from '@/lib/enterprise/access'
import { enterprisePrincipal, type EnterprisePrincipal, type EnterpriseReader } from '@/lib/enterprise/principal'

export type AuthorizedCacheWorkspace = { workspaceId: string; role: 'admin' | 'member'; accessProof?: string; accessExpiresAt?: string | null; accessExpiresAfterMs?: number | null }

/** A small, read-only authorization check before any disk data is shown. It
 * deliberately does not load members, invitations, task bodies or credentials.
 * A removed membership or downgraded role cannot hydrate its previous namespace. */
export async function authorizedCacheWorkspace(reader: EnterpriseReader & { [enterprisePrincipal]: EnterprisePrincipal }, requestedId?: string, includeAccessProof = true): Promise<AuthorizedCacheWorkspace | null> {
  const userId = reader.id
  const selection = workspaceSelection(currentRequestScope()?.headers)
  if (selection.present && !selection.workspaceId) return null
  // A cache namespace must match the selected remote data requests. An
  // explicit business target can be read separately, but cannot relabel them.
  if (selection.present && requestedId && requestedId !== selection.workspaceId) return null
  const memberships = await workspaceDb.select({ workspaceId: workspaces.id, role: workspaceMembers.role })
    .from(workspaces).innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active'),
      or(eq(workspaces.kind, 'team'), eq(workspaces.userId, userId))))
    .orderBy(asc(workspaces.createdAt))
  if (selection.present && !memberships.some(item => item.workspaceId === selection.workspaceId)) return null
  const selected = requestedId ?? selection.workspaceId ?? (await cookies()).get('mikka-workspace')?.value
  const match = memberships.find(item => item.workspaceId === selected)
  const workspace = match ?? (requestedId || selection.present ? null : memberships[0] ?? null)
  if (!workspace) return null
  if (!await enterpriseWorkspaceAllowed(userId, workspace.workspaceId, reader[enterprisePrincipal])) return null
  return includeAccessProof ? { ...workspace, ...await (await import('@/lib/resource-access/cache-proof')).readResourceAccessProof(userId, workspace.workspaceId) } : workspace
}
