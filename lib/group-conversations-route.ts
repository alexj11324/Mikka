import { groupDirectory } from '@/lib/group-conversations-directory'
import { after, NextResponse } from 'next/server'
import { processGroupTurn } from '@/lib/coordinator/group-turns'
import { groupRuntime } from '@/lib/coordinator/group-runtime'
import { and, eq, inArray } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db, pool } from '@/lib/db'
import { agents } from '@/lib/db/schema'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { handleGroup, type GroupRequest } from '@/lib/group-conversations-store'

/** Workspace membership grants user-directory access, NOT another user's private agents.
 * Until agents have an explicit workspace sharing model, only caller-owned agents qualify.
 * This adapter never returns agent configuration, credentials, runs or private history.
 */
const directory = groupDirectory({
  async activeUsers(workspaceId, ids) {
    const rows = await workspaceDb.select({ id: workspaceMembers.userId }).from(workspaceMembers).where(and(
      eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.status, 'active'), inArray(workspaceMembers.userId, ids),
    ))
    return rows.map(row => row.id)
  },
  async ownedAgents(userId, ids) {
    const rows = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.userId, userId), inArray(agents.id, ids)))
    return rows.map(row => row.id)
  },
})
export async function respondGroup(request: Request, resource: GroupRequest['resource'], id?: string) {
  const session = await auth.api.getSession({ headers: request.headers })
  const url = new URL(request.url)
  const result = await handleGroup(pool, directory, {
    userId: session?.user?.id ?? null, method: request.method as GroupRequest['method'], resource, id,
    origin: request.headers.get('origin'),
    // Do not trust client-controlled x-forwarded-host to satisfy the Origin check.
    host: request.headers.get('host') ?? url.host,
    body: request.method !== 'GET' ? await request.text().catch(() => '') : undefined,
    before: url.searchParams.get('before'), limit: url.searchParams.get('limit'), workspaceId: url.searchParams.get('workspaceId'),
  }, true)
  if (resource === 'messages' && id && result.status < 300) {
    after(async () => {
      // Bounded request lifetime. Durable queued roots resume on the next history poll/send.
      try {
        const deadline = Date.now() + 220000
        while (Date.now() < deadline - 20000) {
          if (!await processGroupTurn(pool, id, groupRuntime, deadline)) break
        }
      } catch { console.error('Group turn failed; retained in group_turns without automatic replay') }
    })
  }
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'private, no-store' } })
}
