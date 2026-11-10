import type { PoolClient } from 'pg'
import type { ArtifactKind } from '@/lib/db/schema'

type RunArtifact = { id: string; kind: ArtifactKind; title: string; latestVersion: number; createdAt: Date }

/** The versions these owned runs actually submitted. artifacts.runId records
 * the original creator; its mutable latestVersion is not per-run evidence. */
export async function runArtifactSubmissions(query: Pick<PoolClient, 'query'>, userId: string, runIds: readonly string[], readerId = userId): Promise<RunArtifact[]> {
  if (!runIds.length) return []
  const { rows } = await query.query<RunArtifact>(`
    WITH owned_runs AS (
      SELECT id,"userId","issueId","workspaceId" FROM agent_runs WHERE "userId"=$1 AND id=ANY($2::uuid[])
        AND mikka_resource_acl_allowed('account',$3,"workspaceId",'thread',id,'canReadContent')
    ), submitted AS (
      SELECT ar.id,ar.kind,COALESCE(NULLIF(e.payload->>'title',''),ar.title) AS title,
        av.version AS "latestVersion",av."createdAt"
      FROM owned_runs r
      JOIN coordinator_events e ON e."runId"=r.id AND e."userId"=r."userId"
        AND e."issueId" IS NOT DISTINCT FROM r."issueId" AND e.kind='artifact_submitted'
      JOIN artifacts ar ON ar."userId"=r."userId" AND ar.id::text=e.payload->>'artifactId'
      JOIN artifact_versions av ON av."artifactId"=ar.id AND av.version::text=e.payload->>'version'
      WHERE jsonb_typeof(e.payload->'version')='number'
        AND mikka_resource_acl_allowed('account',$3,r."workspaceId",'artifact',ar.id,'canReadContent')
        AND e."dedupeKey"='artifact_submitted:' || ar.id::text || ':' || av.version::text
      UNION ALL
      SELECT ar.id,ar.kind,ar.title,av.version AS "latestVersion",av."createdAt"
      FROM owned_runs r
      JOIN artifacts ar ON ar."runId"=r.id AND ar."userId"=r."userId"
        AND ar."issueId" IS NOT DISTINCT FROM r."issueId"
      JOIN artifact_versions av ON av."artifactId"=ar.id AND av.version=1
      -- Before submission receipts existed only the initial version can be
      -- attributed to the creator. A conflicting receipt never falls back.
      WHERE mikka_resource_acl_allowed('account',$3,r."workspaceId",'artifact',ar.id,'canReadContent') AND NOT EXISTS (SELECT 1 FROM coordinator_events e
        WHERE e."dedupeKey"='artifact_submitted:' || ar.id::text || ':1')
    )
    SELECT * FROM (
      SELECT DISTINCT ON (id) * FROM submitted ORDER BY id,"latestVersion" DESC
    ) chosen ORDER BY "createdAt",id`, [userId, [...new Set(runIds)], readerId])
  return rows
}
