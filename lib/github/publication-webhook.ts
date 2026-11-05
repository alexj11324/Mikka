import 'server-only'
import type { Pool } from 'pg'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { factoryCommitted } from '@/lib/live/factory'
import { pullRequestStatusChanged } from '@/lib/live/pull-requests'

const pullRequestEvent = z.object({
  repository: z.object({ full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }),
  pull_request: z.object({
    number: z.number().int().positive(),
    html_url: z.url(), title: z.string().max(256),
    state: z.enum(['open', 'closed']), draft: z.boolean(), merged_at: z.string().nullable(),
    additions: z.number().int().nonnegative().optional(), deletions: z.number().int().nonnegative().optional(),
  }),
})

/**
 * The PR's line counts on the tasks its delivery belongs to, as the thread
 * card's PR list shows them. Only the counts of that one PR change, only when
 * they differ, and each change is a task version by the GitHub webhook, like
 * any other system write. Its state on the task is left as it was.
 */
const RECORD_LINE_COUNTS = `
WITH delivered AS (
  SELECT DISTINCT "issueId" FROM run_publications WHERE "pullRequest"->>'url'=$1
), target AS (
  SELECT i.id FROM issues i JOIN delivered d ON d."issueId"=i.id
  WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements(coalesce(i.content #> '{attrs,mikka,pullRequests}','[]'::jsonb)) e
    WHERE rtrim(e->>'url','/')=$1 AND (e->'additions' IS DISTINCT FROM $2::jsonb->'additions' OR e->'deletions' IS DISTINCT FROM $2::jsonb->'deletions')
  )
  FOR UPDATE OF i
), saved AS (
  UPDATE issues i SET content=jsonb_set(i.content,'{attrs,mikka,pullRequests}',(
      SELECT jsonb_agg(CASE WHEN rtrim(e->>'url','/')=$1 THEN e || $2::jsonb ELSE e END ORDER BY n)
      FROM jsonb_array_elements(i.content #> '{attrs,mikka,pullRequests}') WITH ORDINALITY AS list(e,n))),
    revision=i.revision+1, "updatedAt"=now()
  FROM target WHERE i.id=target.id
  RETURNING i.id, i."userId", i.revision, i.title, i.content, i.status, i.priority
)
INSERT INTO issue_versions (id,"issueId","userId",revision,title,content,status,priority,actor_type,actor_id)
SELECT gen_random_uuid(), id, "userId", revision, title, content, status, priority, 'system', 'github-webhook' FROM saved`

/** Called only after verification of the GitHub webhook signature. Updates only
 * deliveries already associated with this exact repository and PR URL, and the
 * tasks those deliveries belong to. */
export async function refreshPublishedPullRequest(event: string, payload: unknown, database: Pick<Pool, 'query'> = pool) {
  if (event !== 'pull_request') return
  const parsed = pullRequestEvent.safeParse(payload)
  if (!parsed.success) return
  const { repository, pull_request: pr } = parsed.data
  const url = `https://github.com/${repository.full_name}/pull/${pr.number}`
  if (pr.html_url !== url) return
  const state = pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft ? 'draft' : 'open'
  const lines = pr.additions !== undefined && pr.deletions !== undefined ? { additions: pr.additions, deletions: pr.deletions } : null
  const { rows } = await database.query<{ id: string | null; issueId: string | null }>(`WITH saved AS (
      UPDATE run_publications SET "pullRequest"="pullRequest" || $2::jsonb,"updatedAt"=now()
      WHERE "pullRequest"->>'url'=$1 RETURNING "runId","userId","issueId"
    ) SELECT DISTINCT t.id,p."issueId" FROM saved p
      LEFT JOIN factory_candidates c ON c."runId"=p."runId"
      LEFT JOIN factory_tasks t ON t.id=c."taskId" AND t."candidateId"=c.id AND t."userId"=p."userId"`,
    [url, JSON.stringify({ title: pr.title, state, ...lines })])
  const tasks = [...new Set(rows.flatMap(row => row.id ? [row.id] : []))].map(id => ({ id }))
  // The PR badge on each task it was delivered on asks GitHub again (#1212); the state itself never crosses.
  await pullRequestStatusChanged(database, rows.flatMap(row => row.issueId ? [row.issueId] : []))
  try {
    if (lines) await database.query(RECORD_LINE_COUNTS, [url, JSON.stringify(lines)])
  } finally {
    // This webhook writer uses autocommitted queries. Even if the optional line-count
    // sync fails, the delivery's title/state is committed and its open view must refresh.
    await Promise.all(tasks.map(task => factoryCommitted(task.id)))
  }
}
