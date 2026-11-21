import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { ActionFailureError } from '@/lib/action-error'
import { pool } from '@/lib/db'
import { sendEveEvent } from '@/lib/eve/server-client'
import { pullRequestStatusChanged } from '@/lib/live/pull-requests'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { GitHubAccessError } from './user-access-error'
import { githubRepositoryReadCredential } from './user-access'
import type { WorkflowResult } from './workflow-result'

type Target = {
  runId: string; issueId: string; ownerId: string; workspaceId: string; botId: string | null
  previous: { headSha: string; run: number; attempt: number; conclusion: string } | null
}
type Database = Pick<PoolClient, 'query'>

async function targets(database: Database, result: WorkflowResult, lock = false) {
  return (await database.query<Target>(`SELECT p."runId",p."issueId",p."userId" AS "ownerId",r."workspaceId",r."botId",
    p."pullRequest"#>ARRAY['workflowResults',$6::text] AS previous
    FROM run_publications p JOIN agent_runs r ON r.id=p."runId" AND r."issueId"=p."issueId" AND r."userId"=p."userId"
    JOIN issues i ON i.id=r."issueId" AND i."workspaceId"=r."workspaceId" AND i."ownershipState"='bound'
    JOIN github_repository_installations g ON g."userId"=p."userId" AND g."remoteKey"=p."remoteKey"
    WHERE p.status='published' AND p."remoteKey"=$1 AND p.branch=$2 AND p."pullRequest"->>'headSha'=$3
      AND g."installationId"=$4 AND g."repositoryId"=$5
      AND (r."botId" IS NULL OR EXISTS (SELECT 1 FROM bots b WHERE b.id=r."botId" AND b."ownerId"=r."userId" AND b."workspaceId"=r."workspaceId"))
    ORDER BY p."runId" LIMIT 2${lock ? ' FOR UPDATE OF p FOR SHARE OF g,r,i' : ''}`,
    ['v2/github.com/' + result.repository, result.branch, result.headSha, result.installationId, result.repositoryId, String(result.workflowId)])).rows
}

function newest(previous: Target['previous'], result: WorkflowResult) {
  if (!previous || previous.headSha !== result.headSha) return 'new'
  if (previous.run === result.workflowRunId && previous.attempt === result.attempt)
    return previous.conclusion === result.conclusion ? 'same' : 'old'
  return previous.run > result.workflowRunId || previous.run === result.workflowRunId && previous.attempt > result.attempt ? 'old' : 'new'
}

/** Outbox and exact-head receipt commit together. A duplicate after a crash can
 * only redeliver the same product event; Eve's session key is mikka-event:<id>. */
export async function recordWorkflowResult(database: Pick<Pool, 'connect'>, candidate: Target, result: WorkflowResult) {
  const tx = await database.connect()
  try {
    await tx.query('BEGIN')
    const [target, ambiguous] = await targets(tx, result, true)
    if (!target || ambiguous || target.runId !== candidate.runId || target.ownerId !== candidate.ownerId ||
        target.workspaceId !== candidate.workspaceId || target.issueId !== candidate.issueId || target.botId !== candidate.botId || newest(target.previous, result) === 'old') {
      await tx.query('ROLLBACK')
      return null
    }
    const stamp = { headSha: result.headSha, run: result.workflowRunId, attempt: result.attempt, conclusion: result.conclusion }
    const dedupe = ['github-workflow', target.runId, result.installationId, result.repositoryId, result.workflowId,
      result.workflowRunId, result.attempt, result.headSha].join(':')
    if (newest(target.previous, result) === 'new') {
      await tx.query(`UPDATE run_publications SET "pullRequest"=jsonb_set("pullRequest",'{workflowResults}',
        coalesce("pullRequest"->'workflowResults','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb)),"updatedAt"=now()
        WHERE "runId"=$1`, [target.runId, String(result.workflowId), JSON.stringify(stamp)])
      if (target.botId) {
        const payload = { source: 'github_workflow_run', workflowId: result.workflowId, workflowRunId: result.workflowRunId,
          attempt: result.attempt, headSha: result.headSha, conclusion: result.conclusion, deliveryId: result.deliveryId,
          text: `GitHub Actions workflow ${result.workflowId}, run ${result.workflowRunId} attempt ${result.attempt}, concluded ${result.conclusion} for commit ${result.headSha}. Inspect the current task and its authorized review or repair flow before acting.` }
        await tx.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey","issueId","runId",tier,payload)
          VALUES ($1,$2,$3,'run_report',$4,$5,$6,'result',$7) ON CONFLICT ("dedupeKey") DO NOTHING`,
          [randomUUID(), target.ownerId, target.botId, dedupe, target.issueId, target.runId, JSON.stringify(payload)])
      }
      await pullRequestStatusChanged(tx, [target.issueId])
    }
    const event = target.botId && (await tx.query<{ id: string }>(`SELECT id FROM coordinator_events WHERE "dedupeKey"=$1
      AND "userId"=$2 AND "botId"=$3 AND "issueId"=$4 AND "runId"=$5 AND "deliveredAt" IS NULL`,
      [dedupe, target.ownerId, target.botId, target.issueId, target.runId])).rows[0]
    await tx.query('COMMIT')
    return event ? event.id : null
  } catch (error) {
    await tx.query('ROLLBACK')
    throw error
  } finally { tx.release() }
}

export async function acceptWorkflowResult(result: WorkflowResult): Promise<void> {
  const [candidate, ambiguous] = await targets(pool, result)
  if (!candidate || ambiguous || newest(candidate.previous, result) === 'old') return
  // Frozen publication + installation is necessary, but a later user revoke
  // also has to win. Recheck the existing repository-specific read authority.
  try {
    const { repository } = await githubRepositoryReadCredential(candidate.ownerId, 'v2/github.com/' + result.repository)
    if (repository.id !== String(result.repositoryId) || repository.installationId !== String(result.installationId)) return
  } catch (error) {
    if (error instanceof GitHubAccessError && ['githubRepositoryForbidden','githubNotConnected','githubReconnectRequired'].includes(error.code)) return
    throw error
  }
  let event: string | null
  try {
    event = await withTaskWorkspace(candidate.ownerId, candidate.workspaceId, () => recordWorkflowResult(pool, candidate, result))
  } catch (error) {
    if (error instanceof ActionFailureError && error.code === 'workspaceAccessDenied') return
    throw error
  }
  if (event && candidate.botId) await sendEveEvent({ ownerId: candidate.ownerId, workspaceId: candidate.workspaceId,
    botId: candidate.botId, surface: 'web' }, event)
}
