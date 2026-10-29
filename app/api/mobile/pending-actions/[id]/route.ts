import { z } from 'zod'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { ActionFailureError } from '@/lib/action-error'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { decidePendingAction } from '@/lib/pending-actions'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/**
 * `POST /api/mobile/pending-actions/:id` with `{ approve }`: the person
 * approves (runs) or declines one proposal from the app, as the web's
 * decidePendingAction server action does. The list is `/api/pending-actions`.
 * 409 when it was already decided or has expired.
 */
async function handlePOST(request: Request, { params }: Params) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const id = z.uuid().safeParse((await params).id)
  const body = z.object({ approve: z.boolean() }).safeParse(await request.json().catch(() => null))
  if (!id.success) return json({ error: 'pendingActionUnavailable' }, 409)
  if (!body.success) return json({ error: 'invalidInput' }, 400)
  try {
    const { status, error } = await decidePendingAction(user.id, id.data, body.data.approve)
    return json({ status, reason: error })
  } catch (error) {
    if (error instanceof ActionFailureError) return json({ error: error.code }, 409)
    throw error
  }
}

export const POST = withRequestLog('/api/mobile/pending-actions/[id]', handlePOST)
