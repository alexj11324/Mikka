import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { json, mobileUser, unauthorized } from '@/lib/mobile-api'
import { mobileThreads } from '@/lib/mobile-threads'
import { runsOutsideToken } from '@/lib/tokens/scope'

export const dynamic = 'force-dynamic'

/** `GET /api/mobile/threads`: the 线程 screen: the person's threads and machines. */
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const listed = await mobileThreads(user.id)
  const outside = await runsOutsideToken(user, listed.threads.map(thread => thread.id))
  return json({ ...listed, threads: listed.threads.filter(thread => !outside.has(thread.id)) })
}

export const GET = withRequestLog('/api/mobile/threads', handleGET)
