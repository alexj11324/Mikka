'use server'

import { headers } from 'next/headers'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { decidePendingAction as decideForUser } from '@/lib/pending-actions'

async function getUserId(): Promise<string> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  return session.user.id
}

/** Approves (runs) or declines one proposal. */
export async function decidePendingAction(id: string, approve: boolean): Promise<ActionResult<{ status: 'done' | 'failed' | 'declined'; reason: string | null }>> {
  return runAction(async () => {
    const userId = await getUserId()
    const parsed = z.uuid().safeParse(id)
    if (!parsed.success) throw new ActionFailureError('pendingActionUnavailable')
    const { status, error } = await decideForUser(userId, parsed.data, approve === true)
    return { status, reason: error }
  })
}
