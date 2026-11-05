import 'server-only'
import { and, eq } from 'drizzle-orm'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers, workspaces } from '@/lib/db/workspace-schema'
import { resolveSlugRedirect } from './general'

/** The same active-membership read used by the browser's /w/<slug> route. */
export async function readWorkspaceSlug(userId: string, slug: string): Promise<{ id: string } | null> {
  if (!/^[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])$/.test(slug)) return null
  const [workspace] = await workspaceDb.select({ id: workspaces.id }).from(workspaces)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaces.slug, slug), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active'))).limit(1)
  return workspace ?? null
}

/** Resolves the browser's optional old-slug redirect without changing the
 * active workspace. The existing switch action rechecks membership on write. */
export async function readWorkspaceLink(userId: string, slug: string): Promise<{ workspaceId: string; slug: string } | null> {
  if (!/^[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])$/.test(slug)) return null
  const workspace = await readWorkspaceSlug(userId, slug)
  if (workspace) return { workspaceId: workspace.id, slug }
  const current = await resolveSlugRedirect(slug, userId)
  if (!current || current === slug) return null
  const moved = await readWorkspaceSlug(userId, current)
  return moved ? { workspaceId: moved.id, slug: current } : null
}
