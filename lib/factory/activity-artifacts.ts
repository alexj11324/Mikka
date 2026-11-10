import type { PoolClient } from 'pg'
import { workspaceLink } from '../../components/workspace/workspace-navigation'
import { withBasePath } from '../base-path'
import type { ArtifactKind } from '../db/schema'
import { taskReaderScope } from '../task-workspace'
import { maskFactoryNote } from './note-mask'
import type { FactoryTask } from './store'

export interface FactoryActivityDocument {
  /** A submission is immutable even when the Artifact later gains versions. */
  id: string
  artifactId: string
  kind: 'plan' | 'acceptance' | 'document'
  format: ArtifactKind
  title: string
  runId: string
  attemptId: string
  candidateId: string | null
  version: number
  size: number
  createdAt: string
  url: string
  downloadUrl: string
}

type Query = Pick<PoolClient, 'query'>
type DocumentRow = Omit<FactoryActivityDocument, 'id' | 'createdAt' | 'url' | 'downloadUrl'> & {
  createdAt: Date | string
}

/** Called inside the task-detail authorization boundary. Like
 * runArtifactSubmissions, this attributes versions by immutable submission
 * receipts, with a version-one-only fallback for pre-receipt Artifacts. Unlike
 * its compact run summary, this keeps each attempt/version independently.
 * Task authorization already holds current membership in its selected tenant;
 * owner + persisted Artifact workspace matches artifactReadAccess in that lease.
 * NULL history is quarantined, and retiring provenance cannot change tenancy. */
export async function readFactoryActivityDocuments(
  tx: Query,
  task: Pick<FactoryTask, 'id' | 'userId' | 'issueId' | 'candidateId' | 'workspaceId'>,
): Promise<FactoryActivityDocument[]> {
  const selectedWorkspace = taskReaderScope(task.userId).workspaceId
  if (!task.workspaceId || selectedWorkspace && selectedWorkspace !== task.workspaceId) return []
  const { rows } = await tx.query<DocumentRow>(`
    WITH owned_attempts AS (
      SELECT attempt.id AS "attemptId",attempt."candidateId",attempt.stage,attempt.output,
        run.id AS "runId",run."userId",run."issueId"
      FROM factory_attempts attempt
      JOIN agent_runs run ON run.id=attempt."runId" AND run."userId"=$2 AND run."issueId"=$3
      WHERE attempt."taskId"=$1
    ), submitted AS (
      SELECT attempt.*,document.id AS "artifactId",document.kind AS format,
        left(COALESCE(NULLIF(receipt.payload->>'title',''),document.title),200) AS title,
        document."runId" AS "creatorRunId",document."issueId" AS "creatorIssueId",
        version.version,version.size,version.sha256,version."createdAt"
      FROM owned_attempts attempt
      JOIN coordinator_events receipt ON receipt."runId"=attempt."runId" AND receipt."userId"=attempt."userId"
        AND receipt."issueId" IS NOT DISTINCT FROM attempt."issueId" AND receipt.kind='artifact_submitted'
      JOIN artifacts document ON document."userId"=attempt."userId" AND document."workspaceId"=$5
        AND document.id::text=receipt.payload->>'artifactId'
      JOIN artifact_versions version ON version."artifactId"=document.id AND version.version::text=receipt.payload->>'version'
      WHERE jsonb_typeof(receipt.payload->'version')='number'
        AND receipt."dedupeKey"='artifact_submitted:' || document.id::text || ':' || version.version::text
      UNION ALL
      SELECT attempt.*,document.id AS "artifactId",document.kind AS format,left(document.title,200) AS title,
        document."runId" AS "creatorRunId",document."issueId" AS "creatorIssueId",
        version.version,version.size,version.sha256,version."createdAt"
      FROM owned_attempts attempt
      JOIN artifacts document ON document."runId"=attempt."runId" AND document."userId"=attempt."userId"
        AND document."issueId" IS NOT DISTINCT FROM attempt."issueId" AND document."workspaceId"=$5
      JOIN artifact_versions version ON version."artifactId"=document.id AND version.version=1
      WHERE NOT EXISTS (SELECT 1 FROM coordinator_events receipt
        WHERE receipt."dedupeKey"='artifact_submitted:' || document.id::text || ':1')
    ), current_acceptance AS (
      SELECT report."artifactId",report."candidateId",report."runId",report.sha256
      FROM factory_acceptance_artifacts report
      JOIN factory_candidates candidate ON candidate.id=report."candidateId" AND candidate."taskId"=report."taskId"
        AND candidate."runId"=report."runId"
      WHERE report."taskId"=$1 AND report."candidateId"=$4
    )
    SELECT submitted."artifactId",submitted.format,submitted.title,submitted."runId",submitted."attemptId",
      COALESCE(report."candidateId",submitted."candidateId") AS "candidateId",submitted.version,submitted.size,submitted."createdAt",
      CASE WHEN submitted.stage='spec' AND submitted.format='markdown'
        AND submitted."creatorRunId"=submitted."runId" AND submitted."creatorIssueId"=$3
        AND jsonb_typeof(submitted.output->'specArtifact'->'version')='number'
        AND submitted.output->'specArtifact'->>'artifactId'=submitted."artifactId"::text
        AND submitted.output->'specArtifact'->>'runId'=submitted."runId"::text
        AND submitted.output->'specArtifact'->>'version'=submitted.version::text
        AND jsonb_typeof(submitted.output->'specArtifact'->'sha256')='string' AND submitted.sha256 ~ '^[a-f0-9]{64}$'
        AND submitted.output->'specArtifact'->>'sha256'=submitted.sha256
        THEN 'plan'
      WHEN report."artifactId" IS NOT NULL THEN 'acceptance' ELSE 'document' END AS kind
    FROM submitted LEFT JOIN current_acceptance report ON report."artifactId"=submitted."artifactId"
      AND report."runId"=submitted."runId" AND report.sha256=submitted.sha256
    ORDER BY submitted."createdAt",submitted."artifactId",submitted.version,submitted."attemptId"`,
  [task.id, task.userId, task.issueId, task.candidateId, task.workspaceId])
  return rows.map(document => {
    return {
      ...document,
      id: `artifact:${document.artifactId}:v${document.version}:${document.attemptId}`,
      title: maskFactoryNote(document.title).slice(0,200),
      createdAt: new Date(document.createdAt).toISOString(),
      url: withBasePath(workspaceLink({ artifact: document.artifactId })),
      downloadUrl: withBasePath(`/api/artifacts/${document.artifactId}/versions/${document.version}/download`),
    }
  })
}
