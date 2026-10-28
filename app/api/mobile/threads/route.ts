import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { json, mobileUser, unauthorized } from '@/lib/mobile-api'
import { mobileThreads } from '@/lib/mobile-threads'

export const dynamic = 'force-dynamic'

/** `GET /api/mobile/threads`: the 线程 screen: the person's threads and machines. */
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  return json(await mobileThreads(user.id))
}

export const GET = withRequestLog('/api/mobile/threads', handleGET)
