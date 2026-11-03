import { hostedBillingScope } from '@/lib/abuse/context'
import { groupDirectory } from '@/lib/group-conversations-directory'
import { after, NextResponse } from 'next/server'
import { groupsWithPendingTurns, hasPendingGroupTurn, processGroupTurn } from '@/lib/coordinator/group-turns'
import { groupRuntime } from '@/lib/coordinator/group-runtime'
import { and, eq, inArray } from 'drizzle-orm'
import { auth, apiWorkspaceAllowed } from '@/lib/api-auth'
import { db, pool } from '@/lib/db'
import { agents, bots } from '@/lib/db/schema'
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
  async ownedBots(workspaceId, userId, ids) {
    const rows = await db.select({ id: bots.id }).from(bots).where(and(eq(bots.ownerId, userId), eq(bots.workspaceId, workspaceId), inArray(bots.id, ids)))
    return rows.map(row => row.id)
  },
})
export async function respondGroup(request: Request, resource: GroupRequest['resource'], id?: string) {
  const session = await auth.api.getSession({ headers: request.headers })
  const url = new URL(request.url)
  const scopedDirectory: typeof directory = async (workspaceId, userId, members) => (!session || apiWorkspaceAllowed(session, workspaceId)) && directory(workspaceId, userId, members)
  const result = await handleGroup(pool, scopedDirectory, {
    userId: session?.user?.id ?? null, method: request.method as GroupRequest['method'], resource, id,
    origin: request.headers.get('origin'),
    // Do not trust client-controlled x-forwarded-host to satisfy the Origin check.
    host: request.headers.get('host') ?? url.host,
    body: request.method !== 'GET' ? await request.text().catch(() => '') : undefined,
    before: url.searchParams.get('before'), after: url.searchParams.get('after'), limit: url.searchParams.get('limit'), workspaceId: url.searchParams.get('workspaceId') ?? session?.tokenWorkspaceId,
  }, true)
  if (resource === 'messages' && id && result.status < 300) {
    // A send starts the worker. A history read (polled while a reply is generating) starts it only
    // when a turn is still pending, instead of taking the group's lock and recovering on every poll.
    const conversationId = id
    after(async () => {
      if (request.method === 'GET' && !await hasPendingGroupTurn(pool, conversationId).catch(() => false)) return
      await drainGroupTurns(conversationId, Date.now() + 220000)
    })
  }
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'private, no-store' } })
}

/** Runs a group's pending turns one after another until none is left or the deadline nears. */
export async function drainGroupTurns(conversationId: string, deadline: number) {
  try {
    while (Date.now() < deadline - 20000) {
      const row = (await pool.query('SELECT "workspaceId" FROM conversations WHERE id=$1',[conversationId])).rows[0]
      if (!row || !await hostedBillingScope.run({workspaceId:row.workspaceId},()=>processGroupTurn(pool, conversationId, groupRuntime, deadline))) break
    }
  } catch { console.error('Group turn failed; retained in group_turns without automatic replay') }
}

/**
 * The minute cron's sweep: a turn whose request ended before it ran (a send whose worker
 * was cut off, a group nobody is looking at) still runs. One group at a time; a group a
 * request is already working on keeps its lock and is skipped.
 */
export async function resumePendingGroupTurns(deadline: number) {
  let groups = 0
  for (const conversationId of await groupsWithPendingTurns(pool)) {
    if (Date.now() >= deadline - 20000) break
    await drainGroupTurns(conversationId, deadline)
    groups++
  }
  return { groups }
}
