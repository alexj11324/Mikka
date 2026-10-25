'use server'

import { headers } from 'next/headers'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { createShare, readArtifact, readArtifactContent, revokeShares, type ArtifactDetail } from '@/lib/artifacts/store'

async function getUserId(): Promise<string> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  return session.user.id
}

/** One of the person's artifacts with its versions, or null. */
export async function getArtifact(artifactId: string): Promise<ArtifactDetail | null> {
  return readArtifact(await getUserId(), artifactId)
}

/** A Markdown artifact's text at `version`, for the reader. HTML is only ever served through its sandboxed frame. */
export async function getArtifactText(artifactId: string, version: number): Promise<string | null> {
  const found = await readArtifactContent(await getUserId(), artifactId, version)
  return found?.kind === 'markdown' ? found.content : null
}

/** A new share link for the artifact; the token comes back once. */
export async function shareArtifact(artifactId: string): Promise<ActionResult<{ token: string }>> {
  return runAction(async () => {
    const share = await createShare(await getUserId(), artifactId)
    if (!share) throw new ActionFailureError('artifactNotFound')
    return share
  })
}

/** Ends every share link to the artifact. */
export async function stopSharingArtifact(artifactId: string): Promise<ActionResult<{ revoked: number }>> {
  return runAction(async () => ({ revoked: await revokeShares(await getUserId(), artifactId) }))
}
