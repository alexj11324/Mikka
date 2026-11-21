import 'server-only'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { readGovernanceLease } from '@/lib/governance/lease'
import { GovernanceError } from '@/lib/governance/errors'
import { usageRange } from '@/lib/governance/usage'
import { runChainSql, RUN_CHAIN_MAX_DEPTH } from '@/lib/run-chain'
import type { EnterpriseReader } from '@/lib/enterprise/principal'
import { threadCostsPending, type WorkspaceContributionDay, type WorkspaceSettingsActivity } from './device-activity-contract'

/** Workspace activity is an administrator's aggregate, with task content ACLs
 * still applied. Thread content, task titles and private PR URLs never leave it. */
function issueMetadata(alias: 'i' | 'v') {
  return `coalesce(${alias}.content->'attrs'->'mikka',${alias}.content->'attrs'->'orvilo','{}'::jsonb)`
}

export async function readWorkspaceSettingsActivity(reader: EnterpriseReader, workspaceId: string,
  range: { from?: string | null; to?: string | null }, groupBy: string | null = null): Promise<WorkspaceSettingsActivity> {
  z.uuid().parse(workspaceId)
  if (groupBy && groupBy !== 'member') throw new GovernanceError('invalid_request')
  const { from, to } = usageRange(range)
  return withTaskWorkspace(reader, workspaceId, async () => {
    const scope = await readGovernanceLease(workspacePool, workspaceId, reader.id)
    if (scope.role !== 'admin') throw new GovernanceError('access_denied')
    const { rows: members } = await workspacePool.query<{ userId: string }>(`SELECT "userId" FROM mikka_workspace_members
      WHERE "workspaceId"=$1 AND status='active' ORDER BY "userId"`, [workspaceId])
    const { rows } = await pool.query<WorkspaceContributionDay>(`WITH RECURSIVE
      ${runChainSql('r."workspaceId"=$1 AND r."userId"=ANY($2::text[])', '$6')},
      visible_tasks AS (
        SELECT i.id,i."userId" FROM issues i WHERE i."workspaceId"=$1 AND i."ownershipState"='bound'
          AND ${issueMetadata('i')}->>'deletedAt' IS NULL
          AND mikka_resource_acl_allowed('account',$5,i."workspaceId",'task',i.id,'canReadContent')
      ), versions AS (
        SELECT v."issueId",v."userId",v.revision,v.status,v."createdAt" AS at,v.actor_type,v.actor_id,metadata,
          lag(v.status) OVER w AS previous_status,lag(v.revision) OVER w AS previous_revision,
          pulls,lag(pulls) OVER w AS previous_pulls
        FROM issue_versions v JOIN visible_tasks i ON i.id=v."issueId" AND i."userId"=v."userId"
        CROSS JOIN LATERAL (SELECT ${issueMetadata('v')} AS metadata) m
        CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(metadata->'pullRequests')='array'
          THEN metadata->'pullRequests' ELSE '[]'::jsonb END AS pulls) p
        WINDOW w AS (PARTITION BY v."issueId" ORDER BY v.revision,v.id)
      ), credited AS (
        SELECT *,coalesce(CASE WHEN metadata->'assignee'->>'kind'='member' THEN metadata->'assignee'->>'id' END,
          CASE WHEN actor_type='user' THEN actor_id END,"userId") AS member
        FROM versions WHERE previous_revision=revision-1
      ), completion_events AS (
        SELECT DISTINCT "issueId",date_trunc('day',at AT TIME ZONE 'UTC') AS day,member
        FROM credited WHERE status='done' AND previous_status<>'done' AND at>=$3 AND at<$4
      ), pull_events AS (
        SELECT DISTINCT ON (rtrim(pull->>'url','/')) rtrim(pull->>'url','/') AS url,c.at,c.member
        FROM credited c CROSS JOIN LATERAL jsonb_array_elements(c.pulls) pull
        WHERE pull->>'state'='merged' AND nullif(pull->>'url','') IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(c.previous_pulls) previous
            WHERE rtrim(previous->>'url','/')=rtrim(pull->>'url','/') AND previous->>'state'='merged')
        ORDER BY rtrim(pull->>'url','/'),c.at,c."issueId"
      ), events AS (
        SELECT to_char(day,'YYYY-MM-DD') AS day,member,1 AS tasks,0 AS pulls,0 AS threads FROM completion_events
        UNION ALL
        SELECT to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD'),member,0,1,0 FROM pull_events WHERE at>=$3 AND at<$4
        UNION ALL
        SELECT to_char(r."createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD'),r."userId",0,0,1
        FROM assigned a JOIN agent_runs r ON r.id=a.id
        WHERE a.id=a.root AND NOT a."depthExceeded" AND r."createdAt">=$3 AND r."createdAt"<$4
          AND (r."issueId" IS NULL OR r."issueId" IN (SELECT id FROM visible_tasks))
      )
      SELECT day,member AS "memberId",sum(tasks)::int AS "completedTasks",sum(pulls)::int AS "mergedPullRequests",sum(threads)::int AS threads
      FROM events WHERE member=ANY($2::text[]) GROUP BY day,member ORDER BY day,member`,
    [workspaceId, members.map(member => member.userId), from, to, reader.id, RUN_CHAIN_MAX_DEPTH])
    return { workspaceId, from: from.toISOString(), toExclusive: to.toISOString(), timeZone: 'UTC', groupBy: 'member',
      dateSource: 'recorded_events', contributions: rows, threadCosts: threadCostsPending }
  })
}
