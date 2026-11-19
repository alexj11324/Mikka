'use server'

import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { requireUser } from '@/lib/acting-user'
import { decidePendingAction as decideForUser } from '@/lib/pending-actions'

const getUserId = async () => (await requireUser()).id

/** Approves (runs) or declines one proposal. */
export async function decidePendingAction(id: string, approve: boolean): Promise<ActionResult<{ status: 'done' | 'failed' | 'declined' | 'running'; reason: string | null }>> {
  return runAction(async () => {
    const userId = await getUserId()
    const parsed = z.uuid().safeParse(id)
    if (!parsed.success) throw new ActionFailureError('pendingActionUnavailable')
    const { status, error } = await decideForUser(userId, parsed.data, approve === true)
    return { status, reason: error }
  })
}
