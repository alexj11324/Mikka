import 'server-only'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db, pool, withDatabaseClient, withDatabaseTransaction } from '@/lib/db'
import { inDatabaseTransaction } from '@/lib/db/request-scope'
import { connectForCommitEffects } from '@/lib/db/commit-effects'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace } from '@/lib/workspace-access'
import { ScheduleError } from '@/lib/schedules/contract'
import { codeReviewConfiguration } from './settings-storage'
import type { ReviewGitHubAuthority } from './github-policy'

type Source = { id: string; botId: string | null; issueId: string | null; payload: Record<string, unknown> }
const reviewSchedule = z.object({ scheduleId: z.uuid(), occurrenceId: z.uuid(), codeReview: z.literal(true) })
const unavailable = () => new ScheduleError('scheduleDispatchUnavailable', 403)

async function originalReviewRequest(userId: string, sourceEventId?: string | null, botId?: string | null, requireSource = true): Promise<Source | null> {
  if (!sourceEventId) return null
  const { rows: [source] } = await pool.query<Source>(`SELECT e.id,e."botId",coalesce(e."issueId",r."issueId") AS "issueId",e.payload
    FROM coordinator_events e LEFT JOIN agent_runs r ON r.id=e."runId" AND r."userId"=e."userId"
    WHERE e.id=$1 AND e."userId"=$2`, [sourceEventId, userId])
  if (!source) {
    if (requireSource) throw unavailable()
    return null
  }
  if (botId !== undefined && source.botId !== botId) throw unavailable()
  if (reviewSchedule.safeParse(source.payload.schedule).success) return source
  const retry = z.uuid().safeParse(source.payload.taskRequestSourceEventId)
  const { rows: [original] } = await pool.query<Source>(`SELECT e.id,e."botId",e."issueId",e.payload FROM coordinator_events e
    WHERE e."userId"=$1 AND e."botId" IS NOT DISTINCT FROM $2::uuid AND e.kind='user_message'
      AND e.payload->'schedule'->>'codeReview'='true' AND (e.id=$3::uuid OR e."issueId"=$4::uuid)
    ORDER BY e."createdAt",e.id LIMIT 1`, [userId, source.botId, retry.success ? retry.data : null, source.issueId])
  return original ?? null
}

/** Current scope is held through the operation. The immutable request marker
 * remains after deletion, so an old review cannot turn into an unrestricted
 * GitHub call when its repository configuration disappears. */
export async function withReviewRequestAuthority<T>(userId: string, sourceEventId: string | null | undefined,
  botId: string | null | undefined, work: (authority: ReviewGitHubAuthority | null) => Promise<T>): Promise<T> {
  return withReviewAuthority(userId, await originalReviewRequest(userId, sourceEventId, botId), work)
}

async function withReviewAuthority<T>(userId: string, source: Source | null, work: (authority: ReviewGitHubAuthority | null) => Promise<T>): Promise<T> {
  if (!source) return work(null)
  const stored = reviewSchedule.parse(source.payload.schedule)
  const { rows: [hint] } = await pool.query<{ workspace_id: string }>('SELECT workspace_id FROM user_schedules WHERE id=$1', [stored.scheduleId])
  if (!hint?.workspace_id) throw unavailable()
  return workspaceDb.transaction(async workspace => {
    await requireWorkspace(workspace, hint.workspace_id, userId, true)
    const run = () => db.transaction(database => withDatabaseTransaction(database, async () => {
      const { rows: [row] } = await database.execute<{ repository: string; pullNumber: number }>(sql`SELECT r.repository,(o.trigger->'event'->>'number')::integer AS "pullNumber"
        FROM workspace_code_review_repositories r JOIN user_schedules s ON s.id=r."scheduleId"
        JOIN schedule_occurrences o ON o.schedule_id=s.id AND o.id=${stored.occurrenceId}::uuid
        JOIN coordinator_events e ON e.id=${source.id}::uuid AND e."userId"=${userId} AND e.kind='user_message'
        JOIN bots b ON b.id=e."botId" AND b."ownerId"=e."userId" AND b."workspaceId"=s.workspace_id AND b."archivedAt" IS NULL
        WHERE s.id=${stored.scheduleId}::uuid AND s.workspace_id=${hint.workspace_id}::uuid
          AND r."workspaceId"=s.workspace_id AND r."ownerId"=${userId} AND r.enabled=true
          AND s.owner_id=${userId} AND coalesce(s.run_as_user_id,s.owner_id)=${userId}
          AND s.status='active' AND s.status_before_delete IS NULL AND o.status IN ('running','succeeded')
          AND e.payload->'schedule'->>'codeReview'='true' AND e.payload->>'submissionId'=o.id::text
          AND o.trigger->'event'->>'source'='github' AND o.trigger->'event'->>'repository'=r.repository
        FOR SHARE OF r,s,o,e,b`)
      if (!row || !Number.isSafeInteger(row.pullNumber) || row.pullNumber <= 0) throw unavailable()
      const { repositoryAvailable } = await import('@/lib/workspace-admin/bots')
      if (!await repositoryAvailable(hint.workspace_id, row.repository)) throw unavailable()
      const config = await codeReviewConfiguration(hint.workspace_id, database)
      return work({ repository: row.repository, pullNumber: row.pullNumber, output: config.output })
    }))
    if (inDatabaseTransaction()) return run()
    // Native credential and repository readers use both Drizzle and raw pg.
    // Pin both interfaces, including the callback, to this one checkout.
    const client = await connectForCommitEffects(pool)
    try { return await withDatabaseClient(client, run) } finally { client.release() }
  })
}

/** Only host-marked review requests get a read-only worker. It tightens the
 * existing native policy; it does not change native credential or network rules. */
export async function requestedCodeReviewReadOnly(userId: string, sourceEventId?: string | null): Promise<boolean> {
  return withReviewAuthority(userId, await originalReviewRequest(userId, sourceEventId, undefined, false), async authority => authority !== null)
}
