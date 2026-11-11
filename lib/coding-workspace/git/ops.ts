import 'server-only'
import type { PoolClient } from 'pg'
import { WorkspaceGitError } from '@mikka/protocol/coding-workspace-git'
import type { WorkspaceQuery } from '../identity'

export type GitOperationKind = 'revert' | 'restore'
export type GitOperationState = 'previewed' | 'delivering' | 'applied' | 'failed' | 'undone'
export type GitOperationRow = {
  operationId: string; runId: string; repoId: string; ownerId: string; workspaceId: string
  kind: GitOperationKind; state: GitOperationState; requestFingerprint: string
  previewVersion: string | null; checkpointId: string | null
  revision: unknown; files: unknown; expected: unknown; payload: unknown; receipt: unknown
  undoFiles: { path: string; existed: boolean; mode: string | null; base64: string; sha256: string
    after: { exists: boolean; contentSha256: string | null } }[] | null
  undoMaskPolicy: string | null; undoAvailable: boolean; undoReason: 'secret' | 'too_large' | 'none' | null
  undoClaimedAt: Date | null; undoReceipt: unknown
  expiresAt: Date; undoExpiresAt: Date | null
}
type Query = Pick<PoolClient, 'query'> | WorkspaceQuery

const columns = `"operationId","runId","repoId","ownerId","workspaceId",kind,state,"requestFingerprint","previewVersion","checkpointId",
  revision,files,expected,payload,receipt,"undoFiles","undoMaskPolicy","undoAvailable","undoReason","undoClaimedAt","undoReceipt","expiresAt","undoExpiresAt"`

/** A preview is a durable confirmation token. The same operation id with a
 * different body is a conflict, never a silent second intent. */
export async function insertPreview(database: Query, input: {
  operationId: string; runId: string; repoId: string; ownerId: string; workspaceId: string; kind: GitOperationKind
  requestFingerprint: string; previewVersion: string; checkpointId: string | null
  revision: unknown; files: unknown; expected: unknown; payload: unknown; expiresAt: Date
}): Promise<GitOperationRow> {
  // Expired previews stop being usable and their payload is released. Applied
  // audit rows remain; only their Undo capture ages out.
  await database.query(`DELETE FROM coding_workspace_git_operations WHERE "ownerId"=$1 AND state IN ('previewed','failed')
    AND "expiresAt"<clock_timestamp()`, [input.ownerId])
  // A failed or expired attempt may be retried with the same client-chosen
  // id; no write is recorded for it, so replacing it cannot hide an outcome.
  await database.query(`DELETE FROM coding_workspace_git_operations WHERE "operationId"=$1 AND "ownerId"=$2
    AND (state='failed' OR (state='previewed' AND "expiresAt"<clock_timestamp()))`, [input.operationId, input.ownerId])
  await database.query(`UPDATE coding_workspace_git_operations SET "undoFiles"=NULL,"undoMaskPolicy"=NULL,"undoAvailable"=false,
    "undoReason"='none',"updatedAt"=now() WHERE "ownerId"=$1 AND state IN ('applied','undone')
    AND "undoExpiresAt"<clock_timestamp() AND "undoFiles" IS NOT NULL`, [input.ownerId])
  const inserted = await database.query<GitOperationRow>(`INSERT INTO coding_workspace_git_operations
    ("operationId","runId","repoId","ownerId","workspaceId",kind,state,"requestFingerprint","previewVersion","checkpointId",
      revision,files,expected,payload,"expiresAt")
    VALUES ($1,$2,$3,$4,$5,$6,'previewed',$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT ("operationId") DO NOTHING RETURNING ${columns}`,
  [input.operationId, input.runId, input.repoId, input.ownerId, input.workspaceId, input.kind, input.requestFingerprint,
    input.previewVersion, input.checkpointId, JSON.stringify(input.revision), JSON.stringify(input.files),
    JSON.stringify(input.expected), JSON.stringify(input.payload), input.expiresAt])
  if (inserted.rows[0]) return inserted.rows[0]
  const { rows: [existing] } = await database.query<GitOperationRow>(`SELECT ${columns} FROM coding_workspace_git_operations
    WHERE "operationId"=$1 AND "ownerId"=$2`, [input.operationId, input.ownerId])
  if (!existing || existing.requestFingerprint !== input.requestFingerprint || existing.kind !== input.kind)
    throw new WorkspaceGitError('workspace_git_operation_conflict')
  return existing
}

export async function readOperation(database: Query, ownerId: string, operationId: string) {
  const { rows: [row] } = await database.query<GitOperationRow>(`SELECT ${columns} FROM coding_workspace_git_operations
    WHERE "operationId"=$1 AND "ownerId"=$2`, [operationId, ownerId])
  return row ?? null
}

/** Only one apply may leave previewed. A late retry sees the stored result. */
export async function claimOperation(database: Query, ownerId: string, operationId: string) {
  const claimed = await database.query<GitOperationRow>(`UPDATE coding_workspace_git_operations SET state='delivering',"updatedAt"=now()
    WHERE "operationId"=$1 AND "ownerId"=$2 AND "expiresAt">clock_timestamp()
      AND (state='previewed' OR (state='delivering' AND "updatedAt"<clock_timestamp()-interval '2 minutes'))
    RETURNING ${columns}`, [operationId, ownerId])
  if (claimed.rows[0]) return { kind: 'claimed' as const, row: claimed.rows[0] }
  const row = await readOperation(database, ownerId, operationId)
  if (!row) throw new WorkspaceGitError('workspace_git_operation_expired')
  if (row.state === 'applied' || row.state === 'undone') return { kind: 'finished' as const, row }
  if (row.state === 'previewed' && row.expiresAt.getTime() <= Date.now()) throw new WorkspaceGitError('workspace_git_operation_expired')
  throw new WorkspaceGitError('workspace_git_operation_conflict')
}

export async function releaseOperation(database: Query, ownerId: string, operationId: string, retryable: boolean) {
  await database.query(`UPDATE coding_workspace_git_operations SET state=$3,"updatedAt"=now() WHERE "operationId"=$1 AND "ownerId"=$2 AND state='delivering'`,
    [operationId, ownerId, retryable ? 'previewed' : 'failed'])
}

export async function finishOperation(database: Query, ownerId: string, operationId: string, receipt: unknown, undoExpiresAt: Date) {
  const { rows: [row] } = await database.query<GitOperationRow>(`UPDATE coding_workspace_git_operations SET state='applied',receipt=$3,
    "undoExpiresAt"=$4,"updatedAt"=now() WHERE "operationId"=$1 AND "ownerId"=$2 AND state IN ('delivering','previewed')
    RETURNING ${columns}`, [operationId, ownerId, JSON.stringify(receipt), undoExpiresAt])
  if (!row) throw new WorkspaceGitError('workspace_git_operation_conflict')
  return row
}

/** Only the most recent applied write on this Run/repository is undoable. */
export async function latestUndoable(database: Query, ownerId: string, runId: string, repoId: string, operationId: string) {
  const { rows: [row] } = await database.query<GitOperationRow>(`SELECT ${columns} FROM coding_workspace_git_operations candidate
    WHERE candidate."operationId"=$1 AND candidate."ownerId"=$2 AND candidate."runId"=$3 AND candidate."repoId"=$4
      AND NOT EXISTS (SELECT 1 FROM coding_workspace_git_operations newer WHERE newer."ownerId"=candidate."ownerId"
        AND newer."runId"=candidate."runId" AND newer."repoId"=candidate."repoId" AND newer.state IN ('applied','undone')
        AND (newer."createdAt",newer."operationId")>(candidate."createdAt",candidate."operationId"))`,
  [operationId, ownerId, runId, repoId])
  return row ?? null
}

export async function claimUndo(database: Query, ownerId: string, operationId: string) {
  const claimed = await database.query<GitOperationRow>(`UPDATE coding_workspace_git_operations SET "undoClaimedAt"=now(),"updatedAt"=now()
    WHERE "operationId"=$1 AND "ownerId"=$2 AND state='applied' AND "undoClaimedAt" IS NULL
      AND "undoAvailable" AND "undoExpiresAt">clock_timestamp() AND "undoFiles" IS NOT NULL
    RETURNING ${columns}`, [operationId, ownerId])
  if (claimed.rows[0]) return { kind: 'claimed' as const, row: claimed.rows[0] }
  const row = await readOperation(database, ownerId, operationId)
  if (row?.state === 'undone' && row.undoReceipt) return { kind: 'finished' as const, row }
  throw new WorkspaceGitError('workspace_git_undo_unavailable')
}

export async function releaseUndoClaim(database: Query, ownerId: string, operationId: string) {
  await database.query(`UPDATE coding_workspace_git_operations SET "undoClaimedAt"=NULL,"updatedAt"=now()
    WHERE "operationId"=$1 AND "ownerId"=$2 AND state='applied'`, [operationId, ownerId])
}

export async function finishUndo(database: Query, ownerId: string, operationId: string, receipt: unknown) {
  const { rows: [row] } = await database.query<GitOperationRow>(`UPDATE coding_workspace_git_operations SET state='undone',
    "undoReceipt"=$3,"undoClaimedAt"=NULL,"undoFiles"=NULL,"undoMaskPolicy"=NULL,"undoAvailable"=false,"undoReason"='none',"updatedAt"=now()
    WHERE "operationId"=$1 AND "ownerId"=$2 AND state='applied' RETURNING ${columns}`, [operationId, ownerId, JSON.stringify(receipt)])
  if (!row) throw new WorkspaceGitError('workspace_git_undo_unavailable')
  return row
}
