import 'server-only'
import { isDeepStrictEqual } from 'node:util'
import type { Pool, PoolClient } from 'pg'
import { CodingWorkspaceError, type RunWorktreeIdentity } from '@mikka/protocol/coding-workspace'
import { diffFileMetadata, WorkspaceReviewError, type DiffSnapshot } from '@mikka/protocol/coding-workspace-review'
import { resolveRunWorktree } from '../identity'
import type { ReviewActor, ReviewScope } from './authority'
import { captureDiffSnapshot, type DiffDependencies } from './service'
import { UNFINISHED_RUN_STATUSES } from '../../agent-run-statuses'
import type { FrozenReviewBatch } from './batch-store'

const outdated = () => new WorkspaceReviewError('workspace_snapshot_outdated')
async function material(database: Pick<PoolClient, 'query'>, snapshot: DiffSnapshot) {
  const { rows } = await database.query<{ metadata: unknown }>('SELECT metadata FROM coding_workspace_snapshot_files WHERE "snapshotId"=$1 ORDER BY position', [snapshot.id])
  const old: unknown[][] = [], next: unknown[][] = []
  if (rows.length !== snapshot.counts.files) throw outdated()
  for (const row of rows) {
    const file = diffFileMetadata.parse(row.metadata)
    if (file.status === 'unavailable' || file.unavailableReason || file.workingVersion) throw outdated()
    if (file.oldBlob) old.push([file.previousPath ?? file.path, file.oldBlob, file.oldMode])
    if (file.newBlob) next.push([file.path, file.newBlob, file.newMode])
  }
  const sort = (a: unknown[], b: unknown[]) => String(a[0]).localeCompare(String(b[0]))
  return [old.sort(sort), next.sort(sort)]
}

/** Different origins may encode renames differently. Compare both complete
 * path/blob/mode sides, with the same frozen base/head; never fuzzy anchors. */
export async function assertReviewSourceMatches(database: Pick<Pool, 'query'>, snapshot: DiffSnapshot, current: DiffSnapshot) {
  if (snapshot.availability === 'unavailable' || current.availability === 'unavailable'
    || snapshot.revision.baseSha !== current.revision.baseSha || snapshot.revision.headSha !== current.revision.headSha)
    throw outdated()
  if (snapshot.revision.source === 'working' && snapshot.revision.version !== current.revision.version) throw outdated()
  if (!isDeepStrictEqual(await material(database, snapshot), await material(database, current))) throw outdated()
}

/** Remote observation precedes the short delivery transaction. Its machine
 * binding, checkpoint pointer and Factory revision are checked again there. */
export async function reviewSourceWitness(deps: DiffDependencies, actor: ReviewActor, scope: ReviewScope,
  snapshot: DiffSnapshot, signal?: AbortSignal, candidate?: NonNullable<FrozenReviewBatch['agent']>['factory']): Promise<{ live?: RunWorktreeIdentity; checkpointId?: string }> {
  const { runId, repoId } = scope.identity
  if (UNFINISHED_RUN_STATUSES.some(status => status === scope.status) || snapshot.revision.source === 'working') {
    const current = await captureDiffSnapshot(deps, actor, runId, repoId, { source: 'working' }, signal)
    await assertReviewSourceMatches(deps.database, snapshot, current)
    return { live: (await resolveRunWorktree(deps.database, deps.membership, actor, runId, repoId)).identity }
  }
  if (snapshot.sourceAccess || snapshot.pullRequest) {
    if (!deps.external) throw new WorkspaceReviewError('workspace_review_github_unavailable')
    const verified = await deps.external.verify(scope, snapshot)
    if (verified?.isStale) throw outdated()
    if (snapshot.pullRequest) return {}
  }
  const current = await captureDiffSnapshot(deps, actor, runId, repoId, { source: 'checkpoint' }, signal)
  if (current.availability !== 'unavailable') {
    await assertReviewSourceMatches(deps.database, snapshot, current)
    return { checkpointId: current.id }
  }
  // An immutable commit alone does not prove which version an agent will
  // repair. A current Factory candidate is checked separately under its lock.
  if (snapshot.revision.source === 'commit' && candidate?.candidateId && candidate.sha === snapshot.revision.headSha) return {}
  throw new CodingWorkspaceError('workspace_checkout_unavailable')
}
