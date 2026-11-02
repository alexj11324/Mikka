import { z } from 'zod'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { requestRunStop } from '@/lib/agent-runs'
import { ActionFailureError } from '@/lib/action-error'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { runOutsideToken } from '@/lib/tokens/scope'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/**
 * `POST /api/mobile/threads/:id/stop`: 停止 a working thread, as the web's
 * stop does (lib/agent-runs.ts requestRunStop: this run and every later
 * attempt of its chain). 409 `runChainEnded` when nothing is left to stop.
 */
async function handlePOST(request: Request, { params }: Params) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const id = z.uuid().safeParse((await params).id)
  if (!id.success || await runOutsideToken(user, id.data)) return json({ error: 'runNotFound' }, 404)
  try {
    return json(await requestRunStop(user.id, id.data))
  } catch (error) {
    if (error instanceof ActionFailureError && error.code === 'runNotFound') return json({ error: 'runNotFound' }, 404)
    if (error instanceof ActionFailureError && error.code === 'runChainEnded') return json({ error: 'runChainEnded' }, 409)
    throw error
  }
}

export const POST = withRequestLog('/api/mobile/threads/[id]/stop', handlePOST)
