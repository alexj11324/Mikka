import 'server-only'
import type { PoolClient } from 'pg'
import { WorkspaceReviewError, type DiffSnapshot } from '@mikka/protocol/coding-workspace-review'
import { runChanged } from '../../live/panels'
import type { ReviewActor, ReviewScope } from '../diff/authority'
import { matchingPullState, type ObservedPullState } from '../diff/github-state'

export async function retainTaskPullState(tx: Pick<PoolClient, 'query'>, actor: ReviewActor, scope: ReviewScope,
  snapshot: DiffSnapshot, observation: ObservedPullState | undefined) {
  if (!observation) return
  if (!matchingPullState(observation, snapshot)) throw new WorkspaceReviewError('workspace_snapshot_outdated')
  const { rows: [previous] } = await tx.query<{ observation: unknown }>(`SELECT observation FROM coding_workspace_pull_states
    WHERE "snapshotId"=$1 AND "userId"=$2 FOR UPDATE`, [snapshot.id, actor.userId])
  const prior = previous && matchingPullState(previous.observation, snapshot)
  // A slower concurrent read cannot overwrite a newer provider observation.
  if (prior && prior.observedAt >= observation.observedAt) return
  const { rowCount } = await tx.query(`INSERT INTO coding_workspace_pull_states ("snapshotId","boardId","workspaceId","userId",observation)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT ("snapshotId","userId") DO UPDATE SET observation=excluded.observation,"updatedAt"=now()
    WHERE coding_workspace_pull_states.observation->>'observedAt'<excluded.observation->>'observedAt'`,
  [snapshot.id, scope.boardId, actor.workspaceId, actor.userId, observation])
  if (rowCount && prior?.state !== observation.state) await runChanged(tx, scope.identity.runId)
}
