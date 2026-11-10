'use server'

import { headers } from 'next/headers'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { authenticatedArtifactReader } from '@/lib/artifacts/route'
import { createCaptureShare, revokeCaptureShares } from '@/lib/captures/store'

// Share links for a thread's screenshots and recordings, as for artifacts:
// the token comes back once, only its hash is kept, revoking ends it.

async function getReader() {
  const reader = await authenticatedArtifactReader(await headers())
  if (!reader) throw new ActionFailureError('authRequired')
  return reader
}

/** A new share link for the capture, opened at /api/captures/shared/<token>. */
export async function shareCapture(captureId: string): Promise<ActionResult<{ token: string }>> {
  return runAction(async () => {
    const share = await createCaptureShare(await getReader(), captureId)
    if (!share) throw new ActionFailureError('artifactNotFound')
    return share
  })
}

/** Ends every share link to the capture. */
export async function stopSharingCapture(captureId: string): Promise<ActionResult<{ revoked: number }>> {
  return runAction(async () => ({ revoked: await revokeCaptureShares(await getReader(), captureId) }))
}
