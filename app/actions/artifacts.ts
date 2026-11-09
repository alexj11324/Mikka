'use server'

import { headers } from 'next/headers'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { createShare, listArtifacts as listOwnArtifacts, listRunArtifacts as listOwnRunArtifacts, readArtifact, readArtifactContent, reportIssueKey, revokeShares, type ArtifactDetail, type ArtifactListItem } from '@/lib/artifacts/store'
import type { ListLiveRead } from '@/lib/live/list-read'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal } from '@/lib/enterprise/principal'

async function getReader() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  const context = await loadWorkspaceContext(undefined, session.user)
  return { id: session.user.id, [tokenWorkspace]: context.workspace.id, [enterprisePrincipal]: { kind: 'session' as const, sessionId: session.session.id } }
}

/** Every artifact of the person's, last changed first, for the Artifact page. */
export async function listArtifacts(): Promise<ArtifactListItem[]> {
  return listOwnArtifacts(await getReader())
}

/** What one of the person's runs handed over, for that thread's 「Artifact · N」. */
export async function listRunArtifacts(runId: string): Promise<ArtifactListItem[]> {
  const reader = await getReader()
  const parsed = z.uuid().safeParse(runId)
  return parsed.success ? listOwnRunArtifacts(reader, parsed.data) : []
}

/** One of the person's artifacts with its versions, or null. */
export async function getArtifact(artifactId: string): Promise<(ArtifactDetail & { live: ListLiveRead }) | null> {
  const reader = await getReader()
  const found = await readArtifact(reader, artifactId)
  if (!found) return null
  return { ...found, issueKey: await reportIssueKey(reader, found), live: { ownerId: reader.id, workspaceId: reader[tokenWorkspace] } }
}

/** A Markdown artifact's text at `version`, for the reader. HTML is only ever served through its sandboxed frame. */
export async function getArtifactText(artifactId: string, version: number): Promise<string | null> {
  const found = await readArtifactContent(await getReader(), artifactId, version)
  return found?.kind === 'markdown' ? found.content : null
}

/** A new share link for the artifact; the token comes back once. */
export async function shareArtifact(artifactId: string): Promise<ActionResult<{ token: string }>> {
  return runAction(async () => {
    const share = await createShare(await getReader(), artifactId)
    if (!share) throw new ActionFailureError('artifactNotFound')
    return share
  })
}

/** Ends every share link to the artifact. */
export async function stopSharingArtifact(artifactId: string): Promise<ActionResult<{ revoked: number }>> {
  return runAction(async () => ({ revoked: await revokeShares(await getReader(), artifactId) }))
}
