import { createHash } from 'node:crypto'
import type { RunRepositoryIdentity } from '@mikka/protocol/coding-workspace-review'

/** Stable across a Task's successive Runs, without loading authorization. */
export function reviewBoardId(identity: RunRepositoryIdentity, taskId: string | null) {
  return createHash('sha256').update(JSON.stringify([
    identity.workspaceId, taskId ? 'task' : 'run', taskId ?? identity.runId, identity.repositoryKey,
  ])).digest('hex')
}
