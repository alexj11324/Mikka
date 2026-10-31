import 'server-only'
import { headers } from 'next/headers'
import { and, asc, eq } from 'drizzle-orm'
import { auth, type DeviceSessionSummary } from '@/lib/auth'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers, workspaces } from '@/lib/db/workspace-schema'
import type { ApiSession } from '@/lib/api-auth'
import { loadWorkspaceContext } from '@/lib/workspace-access'

export async function loadWorkspaceSwitcher(apiSession?: ApiSession) {
  const context = await loadWorkspaceContext(undefined, apiSession?.user)
  const deviceSessions: DeviceSessionSummary[] = apiSession?.tokenWorkspaceId ? [] : await auth.api.listDeviceSessions({ headers: await headers() })
  const accounts = await Promise.all(deviceSessions.filter(item => item.user.id !== context.currentUserId).map(async item => {
    const choices = await workspaceDb.select({ id: workspaces.id, name: workspaces.name }).from(workspaces)
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(and(eq(workspaceMembers.userId, item.user.id), eq(workspaceMembers.status, 'active'))).orderBy(asc(workspaces.createdAt))
    return { id: item.user.id, email: item.user.email, choices }
  }))
  return {
    workspace: context.workspace,
    accounts: [{ id: context.currentUserId, email: context.currentUser.email, choices: context.choices }, ...accounts],
  }
}

export type WorkspaceSwitcher = Awaited<ReturnType<typeof loadWorkspaceSwitcher>>
