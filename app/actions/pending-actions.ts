'use server'

import { headers } from 'next/headers'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { decidePendingAction as decideForUser } from '@/lib/pending-actions'

async function getActor() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  return { userId: session.user.id, sessionId: session.session.id }
}

/** Approves (runs) or declines one proposal. */
export async function decidePendingAction(id: string, approve: boolean): Promise<ActionResult<{ status: 'done' | 'failed' | 'declined' | 'running'; reason: string | null }>> {
  return runAction(async () => {
    const actor = await getActor()
    const parsed = z.uuid().safeParse(id)
    if (!parsed.success) throw new ActionFailureError('pendingActionUnavailable')
    const { status, error } = await decideForUser(actor.userId, parsed.data, approve === true, actor.sessionId)
    return { status, reason: error }
  })
}
