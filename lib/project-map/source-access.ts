import 'server-only'
import type { PoolClient } from 'pg'
import type { ProjectScope } from './scope'
import { MAP_SOURCE_LIMIT } from './read-contracts'

/** Batch, metadata-only reauthorization. Persisted locators are coordinates, not grants. */
export async function currentSourceAccess(database: Pick<PoolClient, 'query'>, scope: ProjectScope, sourceIds: string[], ownRuns: string[], personal: boolean) {
  if (!sourceIds.length) return new Map<string, string>()
  const rows = (await database.query(`WITH refs AS (
      SELECT id,locator,"sourceType","sourceId" FROM project_decision_sources WHERE id=ANY($1::uuid[]) AND "ownerId"=$2 AND "workspaceId"=$3
    ), tasks AS (
      SELECT t.id,t."issueId",t."botId" FROM factory_tasks t LEFT JOIN bots b ON b.id=t."botId" AND b."ownerId"=t."userId"
      WHERE t."userId"=$2 AND t."issueId"=ANY($4::uuid[]) AND (t."botId" IS NULL OR b."workspaceId"=$3)
    )
    SELECT s.id, CASE WHEN
      CASE s."sourceType"
      WHEN 'issue' THEN s."sourceId"=ANY($4::uuid[]::text[])
      WHEN 'run' THEN s."sourceId"=ANY($5::uuid[]::text[])
      WHEN 'run_chunk' THEN EXISTS (SELECT 1 FROM run_chunks c WHERE c.id::text=s."sourceId" AND c."runId"=ANY($5::uuid[])
        AND (s.locator->>'runId' IS NULL OR s.locator->>'runId'=c."runId"::text) AND (s.locator->>'seq' IS NULL OR s.locator->>'seq'=c.seq::text))
      WHEN 'run_message' THEN EXISTS (SELECT 1 FROM run_messages m LEFT JOIN session_mailboxes b ON b.id=m."mailboxId" AND b.kind='run'
        LEFT JOIN agent_runs r ON r.id::text=b."sessionKey" AND r."mailboxId"=b.id AND r."userId"=b."userId" AND r.kind<>'group_review'
        WHERE m.id::text=s."sourceId" AND m."userId"=$2 AND COALESCE(m."runId",r.id)=ANY($5::uuid[])
          AND (s.locator->>'runId' IS NULL OR s.locator->>'runId'=COALESCE(m."runId",r.id)::text))
      WHEN 'bot_message' THEN EXISTS (SELECT 1 FROM coordinator_messages m LEFT JOIN bots b ON b.id=m."botId" AND b."ownerId"=m."userId"
        WHERE m.id::text=s."sourceId" AND m."userId"=$2 AND (b."workspaceId"=$3 OR (m."botId" IS NULL AND $7::boolean))
          AND (s.locator->>'botId' IS NULL OR s.locator->>'botId'=m."botId"::text)
          AND (s.locator->>'position' IS NULL OR s.locator->>'position'=m.position::text))
      WHEN 'group_message' THEN EXISTS (SELECT 1 FROM conversation_messages m JOIN conversations c ON c.id=m."conversationId"
        JOIN conversation_members cm ON cm."conversationId"=c.id AND cm."memberType"='user' AND cm."memberId"=$2 AND cm."leftAt" IS NULL
        WHERE m.id::text=s."sourceId" AND c.kind='group' AND c."workspaceId"=$3
          AND (s.locator->>'conversationId' IS NULL OR s.locator->>'conversationId'=c.id::text)
          AND (s.locator->>'position' IS NULL OR s.locator->>'position'=m.position::text)
          AND (s.locator->>'runId' IS NULL OR s.locator->>'runId'=ANY($5::uuid[]::text[])))
      WHEN 'factory_task' THEN EXISTS (SELECT 1 FROM tasks t WHERE t.id::text=s."sourceId"
        AND (s.locator->>'issueId' IS NULL OR s.locator->>'issueId'=t."issueId"::text))
      WHEN 'attempt' THEN EXISTS (SELECT 1 FROM factory_attempts a JOIN tasks t ON t.id=a."taskId"
        WHERE a.id::text=s."sourceId" AND (a."runId" IS NULL OR a."runId"=ANY($5::uuid[]))
          AND (s.locator->>'taskId' IS NULL OR s.locator->>'taskId'=t.id::text)
          AND (s.locator->>'runId' IS NULL OR s.locator->>'runId'=a."runId"::text))
      WHEN 'candidate' THEN EXISTS (SELECT 1 FROM factory_candidates c JOIN tasks t ON t.id=c."taskId"
        WHERE c.id::text=s."sourceId" AND c."runId"=ANY($5::uuid[]) AND (s.locator->>'runId' IS NULL OR s.locator->>'runId'=c."runId"::text)
          AND (s.locator->>'taskId' IS NULL OR s.locator->>'taskId'=t.id::text))
      WHEN 'commit' THEN EXISTS (SELECT 1 FROM factory_candidates c JOIN tasks t ON t.id=c."taskId"
        WHERE c.id::text=s."sourceId" AND c."runId"=ANY($5::uuid[]) AND c.kind='repository' AND s.locator->>'commitSha'=lower(c.sha))
      WHEN 'factory_event' THEN EXISTS (SELECT 1 FROM factory_events e JOIN tasks t ON t.id=e."taskId"
        WHERE e."eventId"::text=s."sourceId" AND s.locator->>'taskId'=t.id::text)
      WHEN 'acceptance' THEN EXISTS (SELECT 1 FROM factory_deliverable_acceptances a JOIN tasks t ON t.id=a."taskId"
        JOIN factory_candidates c ON c.id=a."candidateId" AND c."taskId"=t.id
        WHERE a.id::text=s."sourceId" AND a."userId"=$2 AND c."runId"=ANY($5::uuid[]))
      WHEN 'question' THEN EXISTS (SELECT 1 FROM factory_questions q JOIN tasks t ON t.id=q."taskId"
        WHERE q.id::text=s."sourceId" AND q."userId"=$2 AND q."issueId"=t."issueId" AND q."originRunId"=ANY($5::uuid[])
          AND (s.locator->>'revision' IS NULL OR s.locator->>'revision'=q."originRevision"::text))
      WHEN 'answer' THEN EXISTS (SELECT 1 FROM factory_questions q JOIN tasks t ON t.id=q."taskId"
        WHERE q.id::text=s."sourceId" AND q."userId"=$2 AND q."issueId"=t."issueId" AND q."originRunId"=ANY($5::uuid[])
          AND s.locator->>'answerId'=q."answerId"::text AND q."answeredAt" IS NOT NULL
          AND (s.locator->>'revision' IS NULL OR s.locator->>'revision'=q."originRevision"::text))
      WHEN 'artifact_version' THEN EXISTS (SELECT 1 FROM artifacts a JOIN artifact_versions v ON v."artifactId"=a.id
        LEFT JOIN coordinator_events e ON e."dedupeKey"='artifact_submitted:'||a.id::text||':'||v.version::text
        WHERE a.id::text=s."sourceId" AND v.id::text=s.locator->>'versionId' AND a."userId"=$2
          AND ((e.id IS NULL AND v.version=1) OR (e.kind='artifact_submitted' AND e."userId"=$2 AND e.payload->>'artifactId'=a.id::text AND e.payload->>'version'=v.version::text))
          AND (CASE WHEN e.id IS NULL THEN a."issueId" ELSE e."issueId" END)=ANY($4::uuid[])
          AND ((CASE WHEN e.id IS NULL THEN a."runId" ELSE e."runId" END) IS NULL OR (CASE WHEN e.id IS NULL THEN a."runId" ELSE e."runId" END)=ANY($5::uuid[])))
      WHEN 'pull_request' THEN EXISTS (SELECT 1 FROM run_publications p WHERE p."runId"::text=s."sourceId" AND p."runId"=ANY($5::uuid[]) AND p."userId"=$2
        AND rtrim(p."pullRequest"->>'url','/')='https://github.com/'||(s.locator->>'repositoryKey')||'/pull/'||(s.locator->>'prNumber'))
      ELSE false END
      AND (s.locator->>'issueId' IS NULL OR s.locator->>'issueId'=ANY($4::uuid[]::text[]))
      AND (s.locator->>'runId' IS NULL OR EXISTS(SELECT 1 FROM agent_runs r WHERE r.id::text=s.locator->>'runId' AND r.id=ANY($5::uuid[])
        AND (s.locator->>'issueId' IS NULL OR s.locator->>'issueId'=r."issueId"::text)))
      THEN 'available'
      WHEN s."sourceType" IN ('run','run_chunk','run_message') AND s.locator->>'issueId'=ANY($4::uuid[]::text[])
        AND COALESCE(s.locator->>'runId',CASE WHEN s."sourceType"='run' THEN s."sourceId" END) IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM agent_runs r WHERE r.id::text=COALESCE(s.locator->>'runId',CASE WHEN s."sourceType"='run' THEN s."sourceId" END))
      THEN 'unavailable' ELSE NULL END AS availability
    FROM refs s ORDER BY s.id LIMIT $6`, [sourceIds, scope.userId, scope.workspaceId, scope.issueIds, ownRuns, MAP_SOURCE_LIMIT, personal])).rows
  return new Map<string, string>(rows.filter(row => row.availability).map(row => [row.id, row.availability]))
}
