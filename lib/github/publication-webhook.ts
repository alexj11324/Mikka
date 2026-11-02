import 'server-only'
import type { Pool } from 'pg'
import { z } from 'zod'
import { pool } from '@/lib/db'

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
  await database.query(`UPDATE run_publications SET "pullRequest"="pullRequest" || $2::jsonb,"updatedAt"=now()
    WHERE "pullRequest"->>'url'=$1`, [url, JSON.stringify({ title: pr.title, state, ...lines })])
  if (lines) await database.query(RECORD_LINE_COUNTS, [url, JSON.stringify(lines)])
}
