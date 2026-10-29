'use server'

import { headers } from 'next/headers'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { createCaptureShare, revokeCaptureShares } from '@/lib/captures/store'

// Share links for a thread's screenshots and recordings, as for artifacts:
// the token comes back once, only its hash is kept, revoking ends it.

async function getUserId(): Promise<string> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  return session.user.id
}

/** A new share link for the capture, opened at /api/captures/shared/<token>. */
export async function shareCapture(captureId: string): Promise<ActionResult<{ token: string }>> {
  return runAction(async () => {
    const share = await createCaptureShare(await getUserId(), captureId)
    if (!share) throw new ActionFailureError('artifactNotFound')
    return share
  })
}

/** Ends every share link to the capture. */
export async function stopSharingCapture(captureId: string): Promise<ActionResult<{ revoked: number }>> {
  return runAction(async () => ({ revoked: await revokeCaptureShares(await getUserId(), captureId) }))
}
