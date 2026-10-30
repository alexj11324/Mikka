import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { assertCredentialSafeChat } from '@/lib/credentials/chat-guard'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { acquireCiMembership, ciIssueAuthorized } from './authority'

export type CiNoticeIdentity = { userId: string; issueId: string; remoteKey: string; prNumber: number; originRunId: string; scopeVersion: number; generation: string | number; watchId: string }

/** Only an exact live observation can produce a notice. Shared-task notices are
 * intentionally generic even after delivery, because membership may later be
 * revoked before the Coordinator consumes an already-committed event. */
export async function recordCiAttention(pool: Pool, identity: CiNoticeIdentity, dedupeKey: string, text: string): Promise<boolean> {
  const { rows: [owner] } = await pool.query<{ userId: string }>('SELECT "userId" FROM issues WHERE id=$1', [identity.issueId])
  if (!owner) return false
  const lease = await acquireCiMembership(identity.issueId, identity.userId, owner.userId)
  try {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout = '1s'")
      const { rows: [issue] } = await client.query('SELECT "userId",scope,"scopeVersion",content FROM issues WHERE id=$1 FOR UPDATE', [identity.issueId])
      if (!ciIssueAuthorized(issue, identity.userId, identity.scopeVersion, lease.held, value => Boolean(readIssueMetadata(value as Parameters<typeof readIssueMetadata>[0]).deletedAt))) { await client.query('ROLLBACK'); return false }
      const owner = issue.userId === identity.userId
      const payload = { text: owner ? text : 'CI needs attention. Open an authorized task to review its checks.', source: 'github_ci' }
      await assertCredentialSafeChat(identity.userId, payload)
      const notice = await client.query(`INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey","issueId","runId",payload,tier)
        SELECT $8,o."userId",r."botId",'run_report',$9,CASE WHEN $11 THEN o."issueId" ELSE NULL END,CASE WHEN $11 THEN o."originRunId" ELSE NULL END,$10,'attention'
        FROM github_ci_observations o JOIN issues i ON i.id=o."issueId" AND i."scopeVersion"=o."scopeVersion"
        JOIN agent_runs r ON r.id=o."originRunId" AND r."userId"=o."userId" AND r."issueId"=o."issueId"
        WHERE o."userId"=$1 AND o."issueId"=$2 AND o."remoteKey"=$3 AND o."prNumber"=$4 AND o."originRunId"=$5 AND o.generation=$6::bigint AND o."watchId"=$7
        ON CONFLICT ("dedupeKey") DO NOTHING RETURNING id`,
      [identity.userId,identity.issueId,identity.remoteKey,identity.prNumber,identity.originRunId,String(identity.generation),identity.watchId,randomUUID(),dedupeKey,JSON.stringify(payload),owner])
      await lease.check()
      await client.query('COMMIT')
      return Boolean(notice.rowCount)
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
  } finally { await lease.close() }
}
