import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { agents } from '@/lib/db/schema'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { directory } from '@/lib/group-conversations-route'

/** Directory offers active workspace humans and only the caller's own Agents.
 * Shared Agent names come from authorized group membership, never this directory. */
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const workspaceId = new URL(request.url).searchParams.get('workspaceId')
  if (!z.uuid().safeParse(workspaceId).success || !await directory(workspaceId!, session.user.id, [])) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const users = await workspaceDb.select({ id: workspaceMembers.userId, name: workspaceMembers.name }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId!), eq(workspaceMembers.status, 'active')))
  const ownAgents = await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.userId, session.user.id))
  return NextResponse.json({ users, agents: ownAgents }, { headers: { 'Cache-Control': 'private, no-store' } })
}
