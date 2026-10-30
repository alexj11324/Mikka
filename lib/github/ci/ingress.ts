/** Webhooks are wakeups only. GitHub's PR and check APIs remain authoritative. */
type Json = Record<string, unknown>
type Attempt = { runId: string; head: string; attempt: number; state: 'requested' | 'in_progress' | 'completed' }
type Wakeup = { repositoryId: number; installationId: number | null; branch: string | null; prNumber: number | null; refresh: boolean; attempt: Attempt | null }
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

export function ciWakeup(event: string, payload: Json): Wakeup | null {
  const repo = object(payload.repository), installation = object(payload.installation)
  if (!positive(repo.id) || (payload.installation !== undefined && !positive(installation.id))) return null
  const installationId = positive(installation.id) ? installation.id : null
  if (event === 'workflow_run') {
    if (!['requested', 'in_progress', 'completed'].includes(String(payload.action))) return null
    const run = object(payload.workflow_run)
    if (typeof run.head_branch !== 'string' || !run.head_branch || run.head_branch.length > 255 || !positive(run.id) || !positive(run.run_attempt) || typeof run.head_sha !== 'string' || !/^[a-f0-9]{40}$/i.test(run.head_sha)) return null
    const attempt: Attempt = { runId: String(run.id), attempt: run.run_attempt, head: run.head_sha.toLowerCase(), state: payload.action as Attempt['state'] }
    return { repositoryId: repo.id, installationId, branch: run.head_branch, prNumber: null, refresh: true, attempt }
  }
  if (event === 'pull_request') {
    if (!['opened', 'synchronize', 'reopened', 'closed'].includes(String(payload.action)) || !positive(payload.number)) return null
    return { repositoryId: repo.id, installationId, branch: null, prNumber: payload.number, refresh: payload.action !== 'closed', attempt: null }
  }
  return null
}

type Query = { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ scheduled: boolean }> }> }
/** Create watches only from existing server-issued publication receipts, never raw webhook PR data. */
export async function backfillCiWakeup(db: Query, wakeup: Wakeup): Promise<void> {
  await db.query(`INSERT INTO github_ci_observations ("userId","issueId","remoteKey","prNumber","originRunId","scopeVersion","expiresAt")
    SELECT DISTINCT ON (p."userId",p."issueId",p."remoteKey",(regexp_match(p."pullRequest"->>'url','/pull/([1-9][0-9]*)/?$'))[1])
      p."userId",p."issueId",p."remoteKey",((regexp_match(p."pullRequest"->>'url','/pull/([1-9][0-9]*)/?$'))[1])::integer,p."runId",p."scopeVersion",now()+interval '48 hours'
    FROM run_publications p JOIN github_repository_installations gi ON gi."userId"=p."userId" AND gi."remoteKey"=p."remoteKey"
    JOIN agent_runs r ON r.id=p."runId" AND r."userId"=p."userId" AND r."issueId"=p."issueId"
    JOIN issues issue ON issue.id=p."issueId" AND issue."scopeVersion"=p."scopeVersion"
    WHERE gi."repositoryId"=$1 AND ($2::bigint IS NULL OR gi."installationId"=$2) AND p.status='published'
      AND p."scopeVersion" IS NOT NULL AND p."pullRequest"->>'state' IN ('open','draft') AND ($3::text IS NULL OR p.branch=$3)
      AND p."remoteKey" ~ '^v2/github\\.com/[a-z0-9_.-]+/[a-z0-9_.-]+$'
      AND lower(rtrim(p."pullRequest"->>'url','/')) = 'https://github.com/' || split_part(p."remoteKey",'/',3) || '/' || split_part(p."remoteKey",'/',4) || '/pull/' || (regexp_match(p."pullRequest"->>'url','/pull/([1-9][0-9]*)/?$'))[1]
      AND length((regexp_match(p."pullRequest"->>'url','/pull/([1-9][0-9]*)/?$'))[1]) <= 9
      AND ($4::integer IS NULL OR (regexp_match(p."pullRequest"->>'url','/pull/([1-9][0-9]*)/?$'))[1]=$4::text)
    ORDER BY p."userId",p."issueId",p."remoteKey",(regexp_match(p."pullRequest"->>'url','/pull/([1-9][0-9]*)/?$'))[1],r."createdAt" DESC,r.id DESC
    LIMIT 100 ON CONFLICT DO NOTHING`, [wakeup.repositoryId, wakeup.installationId, wakeup.branch, wakeup.prNumber])
}

/** Only already task-bound PRs can be scheduled; the attempt write and generation fence are atomic. */
export async function scheduleCiWakeup(db: Query, wakeup: Wakeup): Promise<boolean> {
  const a = wakeup.attempt
  const result = await db.query(`WITH changed AS (
    UPDATE github_ci_observations o SET "nextCheckAt"=LEAST(o."nextCheckAt",now()), "updatedAt"=now(), generation=o.generation+1, "expiresAt"=CASE WHEN $5::boolean THEN GREATEST(o."expiresAt",now()+interval '48 hours') ELSE o."expiresAt" END
    FROM github_repository_installations i, run_publications p
    WHERE i."userId"=o."userId" AND i."remoteKey"=o."remoteKey" AND i."repositoryId"=$1
      AND ($2::bigint IS NULL OR i."installationId"=$2)
      AND p."runId"=o."originRunId" AND p."userId"=o."userId" AND p."issueId"=o."issueId"
      AND p."remoteKey"=o."remoteKey" AND p.status='published'
      AND ($3::text IS NULL OR p.branch=$3) AND ($4::integer IS NULL OR o."prNumber"=$4)
      AND (o."expiresAt">now() OR $5::boolean)
    RETURNING o."userId",o."issueId",o."remoteKey",o."prNumber"
  ), recorded AS (
    INSERT INTO github_ci_workflow_attempts ("userId","issueId","remoteKey","prNumber","runId",head,attempt,state)
    SELECT "userId","issueId","remoteKey","prNumber",$6,$7,$8,$9 FROM changed WHERE $6::text IS NOT NULL
    ON CONFLICT ("userId","issueId","remoteKey","prNumber","runId") DO UPDATE SET head=EXCLUDED.head,attempt=EXCLUDED.attempt,state=EXCLUDED.state
    WHERE EXCLUDED.attempt > github_ci_workflow_attempts.attempt OR (EXCLUDED.attempt = github_ci_workflow_attempts.attempt AND EXCLUDED.head = github_ci_workflow_attempts.head AND
      (CASE EXCLUDED.state WHEN 'requested' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END) > (CASE github_ci_workflow_attempts.state WHEN 'requested' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END))
    RETURNING 1
  ) SELECT EXISTS(SELECT 1 FROM changed) AS scheduled`, [wakeup.repositoryId, wakeup.installationId, wakeup.branch, wakeup.prNumber, wakeup.refresh, a?.runId ?? null, a?.head ?? null, a?.attempt ?? null, a?.state ?? null])
  return result.rows[0]?.scheduled === true
}

/** Backfill and event receipt are committed together before GitHub receives 202. */
export async function recordCiWakeup(pool: { connect: () => Promise<Query & { release: () => void }> }, wakeup: Wakeup): Promise<boolean> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN', [])
    await backfillCiWakeup(client, wakeup)
    const scheduled = await scheduleCiWakeup(client, wakeup)
    await client.query('COMMIT', [])
    return scheduled
  } catch (error) {
    await client.query('ROLLBACK', []).catch(() => {})
    throw error
  } finally { client.release() }
}
