import type { PoolClient } from 'pg'
import { workspaceLink } from '../../components/workspace/workspace-navigation'
import { actingContext } from '../activity-actor'
import { withBasePath } from '../base-path'
import type { ArtifactKind } from '../db/schema'
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
  creatorRunId: string | null
  scopeRunId: string | null
  scopeIssueId: string | null
  botWorkspace: string | null
  bindingWorkspace: string | null
}

/** Batch equivalent of routeArtifact -> artifactOutsideToken: scope follows
 * the Artifact's original run (Bot, computer binding and issue), or its issue
 * when no run remains. Owner browser sessions do not carry a token scope. */
async function withinArtifactTokenScope(rows: DocumentRow[], userId: string, workspaces?: Query): Promise<DocumentRow[]> {
  const context = actingContext.getStore()
  const workspaceId = context?.userId === userId ? context.tokenWorkspaceId : undefined
  if (!workspaceId || !rows.length) return rows
  const database = workspaces ?? (await import('../workspace-db')).workspacePool
  const issueIds = [...new Set(rows.flatMap(row => row.scopeIssueId ? [row.scopeIssueId] : []))]
  const issueWorkspaces = new Map<string,string>()
  if (issueIds.length) {
    const { rows: linked } = await database.query<{ issueId:string; workspaceId:string }>(
      'SELECT "issueId","workspaceId" FROM mikka_team_issues WHERE "issueId"=ANY($1::uuid[])',[issueIds])
    for (const link of linked) issueWorkspaces.set(link.issueId,link.workspaceId)
  }
  let personal: boolean | undefined
  const visible: DocumentRow[] = []
  for (const row of rows) {
    // Match runsOutsideToken's existing missing-run behavior exactly. Normal
    // FK cleanup instead sets artifacts.runId=null, taking the issue branch.
    if (row.creatorRunId && !row.scopeRunId) { visible.push(row); continue }
    const named = [row.botWorkspace,row.bindingWorkspace,row.scopeIssueId && issueWorkspaces.get(row.scopeIssueId)].filter(Boolean)
    if (named.length) {
      if (named.every(id => id===workspaceId)) visible.push(row)
    } else {
      if (personal===undefined) personal=Boolean((await database.query(
        `SELECT 1 FROM mikka_workspaces WHERE id=$1 AND "userId"=$2 AND kind='personal'`,[workspaceId,userId])).rowCount)
      if (personal) visible.push(row)
    }
  }
  return visible
}

/** Called inside the task-detail authorization boundary. Like
 * runArtifactSubmissions, this attributes versions by immutable submission
 * receipts, with a version-one-only fallback for pre-receipt Artifacts. Unlike
 * its compact run summary, this keeps each attempt/version independently. */
export async function readFactoryActivityDocuments(
  tx: Query,
  task: Pick<FactoryTask, 'id' | 'userId' | 'issueId' | 'candidateId'>,
  workspaces?: Query,
): Promise<FactoryActivityDocument[]> {
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
      JOIN artifacts document ON document."userId"=attempt."userId" AND document.id::text=receipt.payload->>'artifactId'
      JOIN artifact_versions version ON version."artifactId"=document.id AND version.version::text=receipt.payload->>'version'
      WHERE jsonb_typeof(receipt.payload->'version')='number'
        AND receipt."dedupeKey"='artifact_submitted:' || document.id::text || ':' || version.version::text
      UNION ALL
      SELECT attempt.*,document.id AS "artifactId",document.kind AS format,left(document.title,200) AS title,
        document."runId" AS "creatorRunId",document."issueId" AS "creatorIssueId",
        version.version,version.size,version.sha256,version."createdAt"
      FROM owned_attempts attempt
      JOIN artifacts document ON document."runId"=attempt."runId" AND document."userId"=attempt."userId"
        AND document."issueId" IS NOT DISTINCT FROM attempt."issueId"
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
      submitted."creatorRunId",creator.id AS "scopeRunId",
      CASE WHEN submitted."creatorRunId" IS NOT NULL THEN creator."issueId" ELSE submitted."creatorIssueId" END AS "scopeIssueId",
      bot."workspaceId" AS "botWorkspace",binding."workspaceId" AS "bindingWorkspace",
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
    LEFT JOIN agent_runs creator ON creator.id=submitted."creatorRunId"
    LEFT JOIN bots bot ON bot.id=creator."botId"
    LEFT JOIN computer_run_bindings binding ON binding."runId"=creator.id
    ORDER BY submitted."createdAt",submitted."artifactId",submitted.version,submitted."attemptId"`,
  [task.id, task.userId, task.issueId, task.candidateId])
  return (await withinArtifactTokenScope(rows,task.userId,workspaces)).map(row => {
    const { creatorRunId: _creator,scopeRunId: _scopeRun,scopeIssueId: _scopeIssue,botWorkspace: _bot,bindingWorkspace: _binding,...document } = row
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
