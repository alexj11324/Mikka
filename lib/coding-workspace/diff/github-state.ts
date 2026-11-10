import 'server-only'
import { z } from 'zod'
import { WorkspaceReviewError, type DiffSnapshot } from '@mikka/protocol/coding-workspace-review'
import type { GitHubPullGrant } from './github'

const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
const id = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String), z.string().regex(/^[1-9]\d{0,39}$/)])
const response = z.object({ repository: z.object({ pullRequest: z.object({ number: z.number().int().positive(),
  headRefOid: sha, baseRefOid: sha, state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
  repository: z.object({ fullDatabaseId: id, nameWithOwner: z.string() }),
}) }) })
export const observedPullState = z.strictObject({ repositoryId: id, number: z.number().int().positive(), headSha: sha, baseSha: sha,
  state: z.enum(['open', 'approved', 'changes_requested', 'closed', 'merged']), observedAt: z.iso.datetime() })
export type ObservedPullState = z.infer<typeof observedPullState>
export function matchingPullState(raw: unknown, snapshot: DiffSnapshot): ObservedPullState | null {
  const state = observedPullState.safeParse(raw)
  return state.success && state.data.repositoryId === snapshot.sourceAccess?.repositoryId && state.data.number === snapshot.pullRequest?.number
    && state.data.headSha === snapshot.revision.headSha && state.data.baseSha === snapshot.pullRequest?.baseSha ? state.data : null
}
const document = `query WorkspaceReviewState($owner:String!,$name:String!,$number:Int!) {
  repository(owner:$owner,name:$name) { pullRequest(number:$number) {
    number headRefOid baseRefOid state reviewDecision repository { fullDatabaseId nameWithOwner }
  } }
}`

/** GitHub's current reviewDecision includes dismissed/superseded reviews.
 * A previously accepted Mikka batch cannot stand in for that observation. */
export async function readGitHubPullState(grant: GitHubPullGrant, snapshot: DiffSnapshot): Promise<ObservedPullState> {
  if (!snapshot.pullRequest || !snapshot.sourceAccess || snapshot.sourceAccess.repositoryId !== grant.repositoryId)
    throw new WorkspaceReviewError('workspace_review_github_forbidden')
  const [owner, name] = grant.fullName.split('/')
  const observedAt = new Date().toISOString()
  const parsed = response.safeParse(await grant.client.graphql(document, { owner, name, number: snapshot.pullRequest.number }))
  if (!parsed.success) throw new WorkspaceReviewError('workspace_review_github_unavailable')
  const value = parsed.data.repository.pullRequest
  if (value.number !== snapshot.pullRequest.number || value.repository.fullDatabaseId !== grant.repositoryId
    || value.repository.nameWithOwner.toLowerCase() !== grant.fullName.toLowerCase())
    throw new WorkspaceReviewError('workspace_review_github_forbidden')
  if (value.headRefOid !== snapshot.revision.headSha || value.baseRefOid !== snapshot.pullRequest.baseSha)
    throw new WorkspaceReviewError('workspace_snapshot_outdated')
  return observedPullState.parse({ repositoryId: grant.repositoryId, number: value.number, headSha: value.headRefOid, baseSha: value.baseRefOid,
    state: value.state === 'MERGED' ? 'merged' : value.state === 'CLOSED' ? 'closed' : value.reviewDecision === 'APPROVED'
      ? 'approved' : value.reviewDecision === 'CHANGES_REQUESTED' ? 'changes_requested' : 'open', observedAt })
}
