import 'server-only'
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { WorkspaceReviewError } from '@mikka/protocol/coding-workspace-review'
import type { WorkerDefinitionSnapshot } from '../../agent-kit/worker'
import type { FactoryTask } from '../../factory/store'
import { secretMaskerFor } from '../../secrets/runtime'
import { maskDeep } from '../../secrets/mask'
import { frozenReviewBatch } from './batch-store'
import { appendReviewFeedback } from './feedback'

export const reviewBatchReference = z.strictObject({ batchId: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
const conflict = () => new WorkspaceReviewError('workspace_review_conflict')

/** Runs after stage configuration/handoff and before the real worker freezes.
 * The caller commits this new Run and the accepted batch together. */
export async function appendReviewBatchToRun(tx: PoolClient, task: FactoryTask, runId: string, raw: unknown) {
  const reference = reviewBatchReference.parse(raw)
  const { rows: [row] } = await tx.query(`SELECT b.input,b.fingerprint,b.state,board."workspaceId",source."issueId"
    FROM coding_workspace_review_batches b JOIN coding_workspace_review_boards board ON board.id=b."boardId"
    JOIN agent_runs source ON source.id=(b.input->>'runId')::uuid AND source."userId"=b."userId"
    WHERE b.id=$1 AND b."userId"=$2 AND b.destination='agent' AND source."issueId"=$3 FOR SHARE OF b`,
  [reference.batchId, task.userId, task.issueId])
  if (!row || row.fingerprint !== reference.fingerprint || row.state !== 'prepared') throw conflict()
  const input = frozenReviewBatch.parse(row.input), agent = input.agent
  if (!agent) throw conflict()
  if (agent.factory) {
    if (agent.factory.taskId !== task.id || agent.factory.sourceEventId !== task.sourceEventId
      || agent.factory.attemptId === task.attemptId) throw conflict()
  } else {
    const source = await tx.query(`SELECT 1 FROM coordinator_events WHERE id=$1 AND "userId"=$2 AND "issueId"=$3
      AND "botId" IS NOT DISTINCT FROM $4::uuid AND kind='user_message' AND payload->>'source'='thread_continuation'
      AND payload->>'previousRunId'=$5 AND payload->>'workspaceReviewBatchId'=$6`,
    [task.sourceEventId, task.userId, task.issueId, task.botId, input.runId, reference.batchId])
    if (!source.rowCount) throw conflict()
  }
  const mask = await secretMaskerFor({ ownerId: task.userId, workspaceId: row.workspaceId })
  if (!isDeepStrictEqual(maskDeep(input, mask), input)) throw new CodingWorkspaceError('workspace_path_unavailable')
  const { rows: [run] } = await tx.query<{ prompt: string; agentDefinition: WorkerDefinitionSnapshot | null }>(
    `SELECT prompt,"agentDefinition" FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "issueId"=$3
      AND status='queued' AND "stopRequestedAt" IS NULL FOR UPDATE`, [runId, task.userId, task.issueId])
  if (!run?.agentDefinition) throw conflict()
  const prompt = appendReviewFeedback(run.prompt, agent.text)
  const definition = { ...run.agentDefinition, workspaceReview: { ...reference, sourceRunId: input.runId } }
  await tx.query('UPDATE agent_runs SET prompt=$2,"agentDefinition"=$3 WHERE id=$1', [runId, prompt, definition])
}

/** Native session resumption reads the whole immutable request, never a
 * Markdown slice that comment text could shorten or redirect. */
export async function reviewBatchFollowUp(database: Pick<PoolClient, 'query'>,
  run: { id: string; userId: string; issueId: string | null; continuesRunId: string | null; agentDefinition: WorkerDefinitionSnapshot | null }): Promise<string | null> {
  const reference = run.agentDefinition?.workspaceReview
  if (!reference) return null
  reviewBatchReference.parse({ batchId: reference.batchId, fingerprint: reference.fingerprint })
  const { rows: [row] } = await database.query(`SELECT b.input,b.fingerprint,board."workspaceId" FROM coding_workspace_review_batches b
    JOIN coding_workspace_review_boards board ON board.id=b."boardId"
    WHERE b.id=$1 AND b."userId"=$2 AND b.destination='agent' AND b.state='accepted'
      AND b.receipt->'delivery'->>'runId'=$3 AND b.receipt->'delivery'->>'kind' IN ('run_continuation','factory_repair')
      AND board."taskId"=$4`, [reference.batchId, run.userId, run.id, run.issueId])
  if (!row || row.fingerprint !== reference.fingerprint) throw conflict()
  const input = frozenReviewBatch.parse(row.input)
  if (!input.agent || input.runId !== reference.sourceRunId
    || ![input.runId, input.agent.factory?.producerRunId].includes(run.continuesRunId ?? '')) throw conflict()
  const mask = await secretMaskerFor({ ownerId: run.userId, workspaceId: row.workspaceId })
  if (!isDeepStrictEqual(maskDeep(input, mask), input)) throw new CodingWorkspaceError('workspace_path_unavailable')
  return input.agent.text
}
