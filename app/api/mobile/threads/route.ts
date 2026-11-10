import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { json, mobileUser, unauthorized } from '@/lib/mobile-api'
import { mobileThreads } from '@/lib/mobile-threads'
import { effectiveRequestWorkspace } from '@/lib/request-workspace'
import { tokenWorkspace } from '@/lib/tokens/principal'

export const dynamic = 'force-dynamic'

/** `GET /api/mobile/threads`: the 线程 screen: the person's threads and machines. */
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  // This optional proof routes presence only; PATs retain their ordinary scoped data read.
  const homeScope = user[tokenWorkspace] ? undefined : request.headers.get('x-mikka-presence-scope') ?? undefined
  const workspaceId = await effectiveRequestWorkspace(user)
  return json(await mobileThreads(user, 60, homeScope, workspaceId))
}

export const GET = withRequestLog('/api/mobile/threads', handleGET)
