/**
 * A task's status advances with its work, as Linear's does (decision 2026-11-13-1405): its Agent starts → 进行中;
 * a run is submitted for review or opens a PR → 评审中; its PRs are merged, or the Factory accepts it → 已完成.
 *
 * One rule for every such move:
 * - forward only, along 待整理 → 待办 → 进行中 → 评审中 → 已完成. A task already at or past the target stays, so a
 *   repeated or late event changes nothing;
 * - 已取消 and 重复 are the person's last word and never move;
 * - a status the person set by hand after the work began (`since`) is kept: the move is skipped;
 * - every move is a versioned system change (`issue_versions`, actor `system` / `source`), so the next check can tell
 *   a person's change from an automatic one.
 */
import { sql, type SQL } from 'drizzle-orm'

export type AdvanceTarget = 'doing' | 'review' | 'done'
export const STATUS_ADVANCE_ORDER = ['backlog', 'todo', 'doing', 'review', 'done'] as const

/** Whether moving `current` to `target` is a step forward. Pure: closed-by-hand and unknown statuses never move. */
export function advancesTo(current: string, target: AdvanceTarget): boolean {
  const from = (STATUS_ADVANCE_ORDER as readonly string[]).indexOf(current)
  return from >= 0 && from < STATUS_ADVANCE_ORDER.indexOf(target)
}

/** A version written by a person after `since` whose status differs from the version before it. */
const PERSON_CHANGED = (issue: string, since: string) => `EXISTS (
  SELECT 1 FROM issue_versions v WHERE v."issueId"=${issue} AND v.actor_type='user' AND v."createdAt">${since}
    AND v.status IS DISTINCT FROM (SELECT p.status FROM issue_versions p WHERE p."issueId"=v."issueId" AND p.revision<v.revision ORDER BY p.revision DESC LIMIT 1))`

/** $1 issue id, $2 target status, $3 when the work began (or null), $4 the source recorded on the version. */
export const ADVANCE_ISSUE_STATUS = `WITH target AS (
  SELECT i.id FROM issues i WHERE i.id=$1
    AND array_position(ARRAY['backlog','todo','doing','review','done'], i.status) < array_position(ARRAY['backlog','todo','doing','review','done'], $2::text)
    AND ($3::timestamptz IS NULL OR NOT ${PERSON_CHANGED('i.id', '$3::timestamptz')})
  FOR UPDATE OF i
), saved AS (
  UPDATE issues i SET status=$2::text, revision=i.revision+1, "updatedAt"=now() FROM target WHERE i.id=target.id
  RETURNING i.id, i."userId", i.revision, i.title, i.content, i.status, i.priority
), versioned AS (
  INSERT INTO issue_versions (id,"issueId","userId",revision,title,content,status,priority,actor_type,actor_id)
  SELECT gen_random_uuid(), id, "userId", revision, title, content, status, priority, 'system', $4::text FROM saved
)
SELECT id FROM saved`

type Query = { query: (text: string, values: unknown[]) => Promise<{ rows: unknown[] }> }

/** Moves the task forward in one statement; true when it moved. Safe to repeat. */
export async function advanceIssueStatus(database: Query, input: { issueId: string; to: AdvanceTarget; since: Date | string | null; source: string }): Promise<boolean> {
  const since = input.since instanceof Date ? input.since.toISOString() : input.since
  const { rows } = await database.query(ADVANCE_ISSUE_STATUS, [input.issueId, input.to, since, input.source])
  return rows.length > 0
}

/** The same guard for a caller that already holds the task's row in a Drizzle transaction and writes it itself. */
export function personChangedStatusSince(issueId: string, since: Date): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM issue_versions v WHERE v."issueId"=${issueId} AND v.actor_type='user' AND v."createdAt">${since.toISOString()}::timestamptz
      AND v.status IS DISTINCT FROM (SELECT p.status FROM issue_versions p WHERE p."issueId"=v."issueId" AND p.revision<v.revision ORDER BY p.revision DESC LIMIT 1))`
}

/** 进行中 when the task's Agent starts: $1 run id. The run's creation is when the work was asked for. */
export const ADVANCE_ON_RUN_START = `SELECT r."issueId", r."createdAt" FROM agent_runs r WHERE r.id=$1 AND r."issueId" IS NOT NULL AND r."startedAt" IS NOT NULL`

/**
 * 已完成 when the last open PR Mikka delivered on a task is merged, in one statement: $1 the merged PR's URL, $2 the
 * source recorded on the version. A task with another delivery, or another PR listed on it, still open or in draft
 * is left alone; so is one the person moved since its work began. Returns the tasks that moved.
 */
export const ADVANCE_MERGED_TASKS = `WITH due AS (
  SELECT p."issueId", min(r."createdAt") AS since FROM run_publications p JOIN agent_runs r ON r.id=p."runId"
  WHERE p."pullRequest"->>'url'=$1 AND p."pullRequest"->>'state'='merged' AND p."issueId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM run_publications o WHERE o."issueId"=p."issueId" AND o."pullRequest"->>'url'<>$1 AND o."pullRequest"->>'state' IN ('open','draft'))
  GROUP BY p."issueId"
), target AS (
  SELECT i.id FROM issues i JOIN due d ON d."issueId"=i.id
  WHERE array_position(ARRAY['backlog','todo','doing','review','done'], i.status) < array_position(ARRAY['backlog','todo','doing','review','done'], 'done')
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(i.content #> '{attrs,mikka,pullRequests}','[]'::jsonb)) e WHERE rtrim(e->>'url','/')<>$1 AND e->>'state' IN ('open','draft'))
    AND NOT ${PERSON_CHANGED('i.id', 'd.since')}
  ORDER BY i.id FOR UPDATE OF i
), saved AS (
  UPDATE issues i SET status='done', revision=i.revision+1, "updatedAt"=now() FROM target WHERE i.id=target.id
  RETURNING i.id, i."userId", i.revision, i.title, i.content, i.status, i.priority
), versioned AS (
  INSERT INTO issue_versions (id,"issueId","userId",revision,title,content,status,priority,actor_type,actor_id)
  SELECT gen_random_uuid(), id, "userId", revision, title, content, status, priority, 'system', $2::text FROM saved
)
SELECT id FROM saved`
