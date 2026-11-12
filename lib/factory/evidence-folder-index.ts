import type { PoolClient } from 'pg'

/** Called with visible, source-verified Factory IDs inside the presentation
 * snapshot. Count only entries that the existing activity reader can open,
 * without transferring reports, captured content, events or individual files. */
export async function factoryEvidenceFolderCounts(tx: Pick<PoolClient, 'query'>, workspaceId: string, ownerId: string,
  factoryIds: readonly string[], storedArtifactIds: readonly string[]) {
  if (!factoryIds.length) return new Map<string, number>()
  const { rows } = await tx.query<{ factoryId: string; count: number }>(`
    WITH runs AS (
      SELECT DISTINCT f.id AS "factoryId", r.id AS "runId", r."issueId", a.id AS "attemptId"
        FROM factory_tasks f
        JOIN factory_attempts a ON a."taskId"=f.id
        JOIN agent_runs r ON r.id=a."runId" AND r."userId"=f."userId" AND r."issueId"=f."issueId" AND r."workspaceId"=f."workspaceId"
       WHERE f.id=ANY($1::uuid[]) AND f."userId"=$2 AND f."workspaceId"=$3
    ), evidence AS (
      SELECT r."factoryId", 'capture:' || c.id AS key, NULL::uuid AS document FROM runs r
        JOIN run_captures c ON c."runId"=r."runId" AND c."userId"=$2 AND (c."issueId" IS NULL OR c."issueId"=r."issueId")
       WHERE c.status='ready'
      UNION
      SELECT r."factoryId", 'pr:' || r."runId", NULL::uuid FROM runs r
        JOIN run_publications p ON p."runId"=r."runId" AND p."userId"=$2 AND p."issueId"=r."issueId"
       WHERE p.status='published' AND p."pullRequest"->>'url' ~ '^https://github[.]com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[1-9][0-9]*$'
      UNION
      SELECT r."factoryId", 'document:' || d.id || ':' || v.version || ':' || r."attemptId", d.id FROM runs r
        JOIN coordinator_events e ON e."runId"=r."runId" AND e."userId"=$2 AND e."issueId"=r."issueId" AND e.kind='artifact_submitted'
        JOIN artifacts d ON d."userId"=$2 AND d."workspaceId"=$3 AND d.id::text=e.payload->>'artifactId'
        JOIN artifact_versions v ON v."artifactId"=d.id AND v.version::text=e.payload->>'version'
       WHERE jsonb_typeof(e.payload->'version')='number' AND e."dedupeKey"='artifact_submitted:' || d.id::text || ':' || v.version::text

      UNION
      SELECT r."factoryId", 'document:' || d.id || ':1:' || r."attemptId", d.id FROM runs r
        JOIN artifacts d ON d."runId"=r."runId" AND d."userId"=$2 AND d."issueId"=r."issueId" AND d."workspaceId"=$3
        JOIN artifact_versions v ON v."artifactId"=d.id AND v.version=1
       WHERE NOT EXISTS (SELECT 1 FROM coordinator_events e
         WHERE e."dedupeKey"='artifact_submitted:' || d.id::text || ':1')
    )
    SELECT "factoryId",(count(*) - count(DISTINCT document) FILTER (WHERE document=ANY($4::uuid[])))::integer AS count FROM evidence GROUP BY "factoryId"`,
  [factoryIds, ownerId, workspaceId, storedArtifactIds])
  return new Map(rows.map(row => [row.factoryId, row.count]))
}
