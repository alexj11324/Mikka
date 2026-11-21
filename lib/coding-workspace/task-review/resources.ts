import 'server-only'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { repositoryBindingMatches } from '@mikka/protocol/repository'
import { WorkspaceReviewError } from '@mikka/protocol/coding-workspace-review'
import type { ReviewResources } from '../../code-review/contract'
import { hostedTaskEnabled } from '../../cloud-computer/sponsored-task'
import { ReviewAuthorityError, taskReviewAuthority } from '../review-authority'
import { readRunChain } from '../../run-chain'
import { assertCurrentTaskReview, currentTaskReview } from './context'
import type { TaskReviewHttpInput, TaskReviewHttpResult } from './http'
import { summarySnapshot } from './read'

/** Only the current candidate produced by this exact Task run can supply a
 * preview. The newest successful receipt is authoritative, even if invalid. */
async function previewForRun(tx: Pick<PoolClient, 'query'>, input: { taskId: string; ownerId: string; runId: string; repositoryKey: string }) {
  const { rows } = await tx.query<{ repository: string; previewUrl: unknown }>(`SELECT c.repository,
      p.receipt->'verifiedTarget'->>'reference' AS "previewUrl"
    FROM factory_tasks t JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id
    LEFT JOIN LATERAL (SELECT receipt FROM factory_publications p
      WHERE p."taskId"=t.id AND p."candidateId"=c.id AND p.status='succeeded'
      ORDER BY p."finishedAt" DESC NULLS LAST,p.id DESC LIMIT 1) p ON true
    WHERE t."issueId"=$1 AND t."userId"=$2 AND c."runId"=$3`, [input.taskId, input.ownerId, input.runId])
  if (rows.length !== 1) return null
  const row = rows[0]!
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(row.repository)
    || !repositoryBindingMatches(input.repositoryKey, `https://github.com/${row.repository}`)
    || typeof row.previewUrl !== 'string' || row.previewUrl.length > 4096) return null
  try {
    const url = new URL(row.previewUrl)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash ? url.href : null
  } catch { return null }
}

/** Locators confer no new access to files or private thread contents. Their
 * native endpoints retain their own live source, viewer and PAT checks. */
export async function readTaskReviewResources(input: TaskReviewHttpInput): Promise<TaskReviewHttpResult> {
  z.strictObject({ workspaceId: z.uuid().optional() }).parse(input.input)
  const context = await currentTaskReview(input.deps, input.actor, input.taskId, input.request.signal)
  if (!context) return { context: null, render: async () => ({ body: null }) }
  const selected = await summarySnapshot(input.deps.database, context.scope)
  if (selected?.sourceAccess || selected?.pullRequest) {
    if (!input.deps.external) throw new WorkspaceReviewError('workspace_review_github_unavailable')
    await input.deps.external.verify(context.scope, selected)
  }
  let interactiveTerminalAvailable = false
  if (input.actor.userId === context.scope.identity.ownerId && hostedTaskEnabled(context.scope.identity.workspaceId)) {
    try {
      const authority = await taskReviewAuthority(input.request,input.taskId,{
        runId:context.scope.identity.runId,workspaceId:context.scope.identity.workspaceId,
      })
      interactiveTerminalAvailable = Boolean(authority.nativeExitedProof && authority.sponsoredPlacement &&
        (authority.machineStatus === 'running' ||
         (authority.machineStatus === 'paused' && authority.sponsoredPlacement.checkpoint)))
    } catch (error) {
      if (!(error instanceof ReviewAuthorityError)) throw error
    }
  }
  return { context, render: async (tx, scope) => {
    await assertCurrentTaskReview(tx, input.actor, context)
    if ((await summarySnapshot(tx, scope))?.id !== selected?.id) throw new WorkspaceReviewError('workspace_snapshot_outdated')
    const { runId, repoId, workspaceId, ownerId, repositoryKey } = scope.identity
    const chain = await readRunChain(tx, ownerId, runId)
    const body: ReviewResources = { taskId: input.taskId,
      workspace: { runId, repoId, workspaceId },
      run: { id: runId, threadId: chain?.rootRunId ?? runId, status: scope.status },
      previewUrl: selected ? await previewForRun(tx, { taskId: input.taskId, ownerId, runId, repositoryKey }) : null,
      interactiveTerminalAvailable, live: { workspaceId },
    }
    return { body }
  } }
}
