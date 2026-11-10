import { z } from 'zod'
import { pool } from '@/lib/db'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { json, mobileUser, unauthorized } from '@/lib/mobile-api'
import { mobileThread } from '@/lib/mobile-threads'
import { readRunChain } from '@/lib/run-chain'
import { runOutsideToken } from '@/lib/tokens/scope'
import { readThreadMachine } from '@/lib/thread-machine-view'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/**
 * `GET /api/mobile/threads/:id/machine`: which machine the thread runs on, read when the person taps the
 * icon in its title (docs/design/thread-run-location.md). Only the owner's own thread; null when it has none.
 */
async function handleGET(request: Request, { params }: Params) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const id = z.uuid().safeParse((await params).id)
  if (!id.success || await runOutsideToken(user, id.data)) return json({ error: 'runNotFound' }, 404)
  const thread = await mobileThread(user, id.data)
  if (!thread) return json({ error: 'runNotFound' }, 404)
  if (!thread.ownedByCurrentUser) return json({ machine: null })
  const chain = await readRunChain(pool, user.id, id.data)
  const runIds = chain ? chain.attempts.map(attempt => attempt.runId) : [id.data]
  return json({ machine: await readThreadMachine(pool, user.id, runIds) })
}

export const GET = withRequestLog('/api/mobile/threads/[id]/machine', handleGET)
