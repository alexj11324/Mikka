import 'server-only'
import type { Pool } from 'pg'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { factoryCommitted } from '@/lib/live/factory'
import { pullRequestStatusChanged } from '@/lib/live/pull-requests'
import { issueListChanged } from '@/lib/live/lists'
import { ADVANCE_MERGED_TASKS } from '@/lib/task-status-advance'
import { reviewCheckEvent } from './review-checks'

const pullRequestEvent = z.object({
  action: z.string().optional(),
  before: z.string().regex(/^[a-f0-9]{40,64}$/i).optional(), after: z.string().regex(/^[a-f0-9]{40,64}$/i).optional(),
  repository: z.object({ full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }),
  pull_request: z.object({
    number: z.number().int().positive(),
    html_url: z.url(), title: z.string().max(256),
    state: z.enum(['open', 'closed']), draft: z.boolean(), merged_at: z.string().nullable(),
    additions: z.number().int().nonnegative().optional(), deletions: z.number().int().nonnegative().optional(),
    changed_files: z.number().int().nonnegative().optional(),
    head: z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/i), ref: z.string().min(1).max(1024).optional() }).optional(),
    updated_at: z.iso.datetime({ offset: true }).optional(),
  }),
})

const reviewEvent = z.object({ repository: z.object({ full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }),
  pull_request: z.object({ number: z.number().int().positive(), html_url: z.url() }) })

/** The already verified review webhook names an existing delivery. It never
 * copies a review body or changes approval/merge state from event contents. */
export async function invalidatePublishedPullReview(payload: unknown, database: Pick<Pool, 'query'> = pool) {
  const parsed = reviewEvent.safeParse(payload)
  if (!parsed.success) return
  const { repository, pull_request: pull } = parsed.data
  const url = `https://github.com/${repository.full_name}/pull/${pull.number}`
  if (pull.html_url !== url) return
  const { rows } = await database.query<{ issueId: string }>(`SELECT DISTINCT p."issueId" FROM run_publications p
    JOIN agent_runs r ON r.id=p."runId" AND r."userId"=p."userId" AND r."issueId"=p."issueId"
    WHERE p.status='published' AND p."remoteKey"=$1 AND p."pullRequest"->>'url'=$2 AND p."issueId" IS NOT NULL LIMIT 50`,
  [`v2/github.com/${repository.full_name.toLowerCase()}`, url])
  await pullRequestStatusChanged(database, rows.map(row => row.issueId))
}

/**
 * The PR's line counts on the tasks its delivery belongs to, as the thread
 * card's PR list shows them. Only the counts of that one PR change, only when
 * they differ, and each change is a task version by the GitHub webhook, like
 * any other system write. Its state on the task is left as it was.
 */
const RECORD_LINE_COUNTS = `
WITH delivered AS (
  SELECT DISTINCT "issueId" FROM run_publications WHERE "pullRequest"->>'url'=$1
), locked AS MATERIALIZED (
  -- Match publication settlement's issue-before-publication lock order.
  SELECT i.id FROM issues i JOIN delivered d ON d."issueId"=i.id ORDER BY i.id FOR UPDATE OF i
), current AS MATERIALIZED (
  -- Recheck the exact metadata after obtaining the publication lock. A newer
  -- webhook can run between the two statements; its line counts must win.
  SELECT p."issueId" FROM run_publications p JOIN locked i ON i.id=p."issueId"
  WHERE p."pullRequest"->>'url'=$1 AND p."pullRequest" @> $3::jsonb FOR SHARE OF p
), target AS (
  SELECT i.id FROM issues i WHERE i.id IN (SELECT "issueId" FROM current) AND EXISTS (
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
 * tasks those deliveries belong to. A delivery that changes nothing stored
 * writes nothing; a PR Mikka never delivered costs one statement (#1212). */
export async function refreshPublishedPullRequest(event: string, payload: unknown, database: Pick<Pool, 'query'> = pool) {
  if (event !== 'pull_request') {
    const delta = reviewCheckEvent(event, payload)
    if (!delta) return
    // One atomic update prevents concurrent runs/statuses from losing each
    // other's entries. IDs order reruns, and terminal states never regress on
    // redelivery. Only the exact repository and current PR head can change.
    const { rows } = await database.query<{ id: string }>(`WITH saved AS (
      UPDATE run_publications p SET "pullRequest"=jsonb_set(p."pullRequest",'{reviewChecks}',jsonb_build_object(
        'headSha',$2::text,'complete',CASE WHEN p."pullRequest"#>>'{reviewChecks,headSha}'=$2 THEN coalesce((p."pullRequest"#>>'{reviewChecks,complete}')::boolean,false) ELSE false END,
        'updatedAt',greatest(coalesce(p."pullRequest"#>>'{reviewChecks,updatedAt}',''),$4::jsonb->>'at'),
        'entries',(CASE WHEN p."pullRequest"#>>'{reviewChecks,headSha}'=$2 THEN coalesce(p."pullRequest"#>'{reviewChecks,entries}','{}'::jsonb) ELSE '{}'::jsonb END)||jsonb_build_object($3::text,$4::jsonb))),"updatedAt"=now()
      WHERE starts_with(p."pullRequest"->>'url',$1) AND p."pullRequest"->>'headSha'=$2
        AND (p."pullRequest"#>>'{reviewChecks,headSha}' IS DISTINCT FROM $2 OR p."pullRequest"#>ARRAY['reviewChecks','entries',$3] IS NULL
          OR (p."pullRequest"#>>ARRAY['reviewChecks','entries',$3,'id'])::numeric<($4::jsonb->>'id')::numeric
          OR ((p."pullRequest"#>>ARRAY['reviewChecks','entries',$3,'id'])::numeric=($4::jsonb->>'id')::numeric
            AND p."pullRequest"#>>ARRAY['reviewChecks','entries',$3,'state']<>$4::jsonb->>'state'
            AND (p."pullRequest"#>>ARRAY['reviewChecks','entries',$3,'state']='pending'
              OR ($4::jsonb->>'state'<>'pending' AND (p."pullRequest"#>>ARRAY['reviewChecks','entries',$3,'at'])<($4::jsonb->>'at')))))
      RETURNING p."runId",p."userId"
    ) SELECT DISTINCT t.id FROM saved p JOIN factory_candidates c ON c."runId"=p."runId"
      JOIN factory_tasks t ON t.id=c."taskId" AND t."candidateId"=c.id AND t."userId"=p."userId"`,
    [`https://github.com/${delta.repository}/pull/`, delta.headSha, delta.key, JSON.stringify(delta.check)])
    await Promise.all(rows.map(task => factoryCommitted(task.id)))
    return
  }
  const parsed = pullRequestEvent.safeParse(payload)
  if (!parsed.success) return
  const { repository, pull_request: pr } = parsed.data
  const transition = parsed.data.action === 'synchronize' && parsed.data.before && parsed.data.after ? parsed.data : null
  if (transition && pr.head?.sha.toLowerCase() !== transition.after!.toLowerCase()) return
  const before = transition?.before?.toLowerCase() ?? null
  const url = `https://github.com/${repository.full_name}/pull/${pr.number}`
  if (pr.html_url !== url) return
  const state = pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft ? 'draft' : 'open'
  const lines = pr.additions !== undefined && pr.deletions !== undefined ? { additions: pr.additions, deletions: pr.deletions } : null
  const patch = JSON.stringify({ title: pr.title, state, ...lines,
    ...(pr.changed_files === undefined ? {} : { changedFiles: pr.changed_files }),
    ...(pr.head ? { headSha: pr.head.sha.toLowerCase(), ...(pr.head.ref ? { branch: pr.head.ref } : {}) } : {}),
    ...(pr.updated_at ? { githubUpdatedAt: new Date(pr.updated_at).toISOString() } : {}) })
  const { rows } = await database.query<{ id: string | null; issueId: string | null; changed: boolean }>(`WITH matched AS (
      SELECT "runId","userId","issueId" FROM run_publications WHERE "pullRequest"->>'url'=$1
        AND (NOT $2::jsonb ? 'githubUpdatedAt' OR coalesce("pullRequest"->>'githubUpdatedAt','')<=$2::jsonb->>'githubUpdatedAt')
        AND ($3::text IS NULL OR "pullRequest"->>'headSha' IS NULL OR "pullRequest"->>'headSha' IN ($3,$2::jsonb->>'headSha'))
        AND ($3::text IS NOT NULL OR "pullRequest"->>'headSha' IS NULL OR NOT $2::jsonb ? 'headSha' OR "pullRequest"->>'headSha'=$2::jsonb->>'headSha'
          OR coalesce("pullRequest"->>'githubUpdatedAt','')<coalesce($2::jsonb->>'githubUpdatedAt','~'))
      ORDER BY "runId" FOR UPDATE
    ), saved AS (
      UPDATE run_publications SET "pullRequest"=(CASE
        WHEN $2::jsonb ? 'headSha' AND "pullRequest"->>'headSha' IS DISTINCT FROM $2::jsonb->>'headSha'
        THEN "pullRequest"-'reviewChecks'-'additions'-'deletions'-'changedFiles' ELSE "pullRequest" END) || $2::jsonb,"updatedAt"=now()
      WHERE "pullRequest"->>'url'=$1 AND NOT "pullRequest" @> $2::jsonb
        AND "runId" IN (SELECT "runId" FROM matched)
        AND (NOT $2::jsonb ? 'githubUpdatedAt' OR coalesce("pullRequest"->>'githubUpdatedAt','')<=$2::jsonb->>'githubUpdatedAt')
        AND ($3::text IS NULL OR "pullRequest"->>'headSha' IS NULL OR "pullRequest"->>'headSha' IN ($3,$2::jsonb->>'headSha'))
        AND ($3::text IS NOT NULL OR "pullRequest"->>'headSha' IS NULL OR NOT $2::jsonb ? 'headSha' OR "pullRequest"->>'headSha'=$2::jsonb->>'headSha'
          OR coalesce("pullRequest"->>'githubUpdatedAt','')<coalesce($2::jsonb->>'githubUpdatedAt','~')) RETURNING "runId"
    ) SELECT DISTINCT t.id,p."issueId",(s."runId" IS NOT NULL) AS changed FROM matched p
      LEFT JOIN saved s ON s."runId"=p."runId"
      LEFT JOIN factory_candidates c ON c."runId"=p."runId"
      LEFT JOIN factory_tasks t ON t.id=c."taskId" AND t."candidateId"=c.id AND t."userId"=p."userId"`,
    [url, patch, before])
  if (!rows.length) return
  const tasks = [...new Set(rows.flatMap(row => row.id && row.changed ? [row.id] : []))].map(id => ({ id }))
  // The PR badge on each task it was delivered on asks GitHub again (#1212); the state itself never crosses.
  await pullRequestStatusChanged(database, rows.flatMap(row => row.issueId ? [row.issueId] : []))
  // 已完成 once the last PR Mikka delivered on a task is merged: forward only, and a status the person set since the
  // work began is kept (lib/task-status-advance.ts). A redelivery finds the task already there and changes nothing.
  if (state === 'merged') {
    const moved = await database.query<{ id: string }>(ADVANCE_MERGED_TASKS, [url, 'pull-request-merged'])
    for (const task of moved.rows) await issueListChanged(database, task.id)
  }
  try {
    if (lines) await database.query(RECORD_LINE_COUNTS, [url, JSON.stringify(lines), patch])
  } finally {
    // This webhook writer uses autocommitted queries. Even if the optional line-count
    // sync fails, the delivery's title/state is committed and its open view must refresh.
    await Promise.all(tasks.map(task => factoryCommitted(task.id)))
  }
}
