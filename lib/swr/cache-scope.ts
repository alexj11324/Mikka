import 'server-only'
import { cookies } from 'next/headers'
import { and, asc, eq, or } from 'drizzle-orm'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers, workspaces } from '@/lib/db/workspace-schema'
import { currentRequestScope } from '@/apps/api/src/context'
import { workspaceSelection } from '@/lib/workspace-selection'
import { enterpriseWorkspaceAllowed } from '@/lib/enterprise/access'
import { enterprisePrincipal, type EnterprisePrincipal, type EnterpriseReader } from '@/lib/enterprise/principal'

export type AuthorizedCacheWorkspace = { workspaceId: string; role: 'admin' | 'member' }

type ActiveWorkspaceProjection = { workspaceId: string; ownerId: string; kind: 'personal' | 'team' }
export type BootstrapWorkspaceScopes = {
  cacheWorkspace: AuthorizedCacheWorkspace | null
  liveHomeWorkspaceId: string | null
}

/** Input is the same membership SELECT's active projection. This is only a
 * routing hint: neither cached data nor a Live ticket is authorized by it. */
export function liveHomeWorkspaceHint(userId: string, activeMemberships: readonly ActiveWorkspaceProjection[]): string | null {
  const homes = activeMemberships.filter(item => item.kind === 'personal' && item.ownerId === userId)
  return homes.length === 1 ? homes[0].workspaceId : null
}

/** Keep the selected cache gate and owner Live route on one fresh membership
 * read. The Live ticket endpoint independently authorizes the hinted scope. */
export async function authorizedBootstrapScopes(reader: EnterpriseReader & { [enterprisePrincipal]: EnterprisePrincipal }, requestedId?: string): Promise<BootstrapWorkspaceScopes> {
  const unavailable: BootstrapWorkspaceScopes = { cacheWorkspace: null, liveHomeWorkspaceId: null }
  const userId = reader.id
  const selection = workspaceSelection(currentRequestScope()?.headers)
  if (selection.present && !selection.workspaceId) return unavailable
  // A cache namespace must match the selected remote data requests. An
  // explicit business target can be read separately, but cannot relabel them.
  if (selection.present && requestedId && requestedId !== selection.workspaceId) return unavailable
  const memberships = await workspaceDb.select({
    workspaceId: workspaces.id, role: workspaceMembers.role, kind: workspaces.kind, ownerId: workspaces.userId,
  }).from(workspaces).innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active'),
      or(eq(workspaces.kind, 'team'), eq(workspaces.userId, userId))))
    .orderBy(asc(workspaces.createdAt))
  if (selection.present && !memberships.some(item => item.workspaceId === selection.workspaceId)) return unavailable
  const selected = requestedId ?? selection.workspaceId ?? (await cookies()).get('mikka-workspace')?.value
  const match = memberships.find(item => item.workspaceId === selected)
  const workspace = match ?? (requestedId || selection.present ? null : memberships[0] ?? null)
  if (!workspace || !await enterpriseWorkspaceAllowed(userId, workspace.workspaceId, reader[enterprisePrincipal])) return unavailable
  return {
    cacheWorkspace: { workspaceId: workspace.workspaceId, role: workspace.role },
    liveHomeWorkspaceId: liveHomeWorkspaceHint(userId, memberships),
  }
}

/** A small, read-only authorization check before any disk data is shown. It
 * deliberately does not load members, invitations, task bodies or credentials.
 * A removed membership or downgraded role cannot hydrate its previous namespace. */
export async function authorizedCacheWorkspace(reader: EnterpriseReader & { [enterprisePrincipal]: EnterprisePrincipal }, requestedId?: string): Promise<AuthorizedCacheWorkspace | null> {
  return (await authorizedBootstrapScopes(reader, requestedId)).cacheWorkspace
}
