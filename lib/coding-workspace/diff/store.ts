import 'server-only'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { diffFileMetadata, diffFilePatch, diffSnapshot, diffSourceAccess, WorkspaceReviewError,
  type DiffFileMetadata, type DiffFilePage, type DiffFilePatch, type DiffRevision, type DiffSnapshot, type DiffSourceAccess } from '@mikka/protocol/coding-workspace-review'
import { maskDeep, type Masker } from '../../secrets/mask'
import type { WorkspaceQuery } from '../identity'
import { assertDiffPatchSafe, diffDigest, diffFileVersion } from './patch'
import type { ReviewScope } from './authority'

const SNAPSHOT_LIMIT = 50
const PATCH_BUDGET = 16 * 1024 * 1024
const unavailable = () => new WorkspaceReviewError('workspace_snapshot_unavailable')
function maskPolicy(mask: Masker): string {
  if (!mask.sourcePolicy || !/^[a-f0-9]{64}$/.test(mask.sourcePolicy)) throw new CodingWorkspaceError('workspace_path_unavailable')
  return mask.sourcePolicy
}
const policy = { working: 'combined_working_tree', checkpoint: 'retained_checkpoint', commit: 'explicit_commits', pull_request: 'whole_pull_request' } as const

export function manifestRevision(source: DiffRevision['source'], baseSha: string | null, headSha: string | null,
  treeSha: string | null, files: DiffFileMetadata[], access?: DiffSourceAccess): DiffRevision {
  return { source, baseSha, headSha, treeSha,
    version: diffDigest(JSON.stringify([source, baseSha, headSha, treeSha, files.map(file => file.fileVersion),
      ...(access ? [[access.kind, access.repositoryId, access.pullRequestNumber ?? null, access.pullRequestBaseSha ?? null, access.manifestComplete]] : [])])) }
}

export async function retainDiffSnapshot(client: PoolClient, scope: ReviewScope, input: {
  revision: DiffRevision; files: DiffFileMetadata[]; pullRequest?: DiffSnapshot['pullRequest']; sourceAccess?: DiffSourceAccess; factory?: DiffSnapshot['factory'];
  patches?: Map<string, DiffFilePatch>; observedAt?: string; reason?: DiffSnapshot['reason'];
}, mask: Masker): Promise<DiffSnapshot> {
  const { identity } = scope, files = input.files.map(file => diffFileMetadata.parse(file))
  const access = input.sourceAccess ? diffSourceAccess.parse(input.sourceAccess) : undefined
  if (access ? !['commit', 'pull_request'].includes(input.revision.source)
    || files.some(file => file.github?.repositoryId !== access.repositoryId || file.rawBlob !== undefined || file.rawSize !== undefined || file.workingVersion !== undefined)
    || (input.revision.source === 'pull_request' ? !input.pullRequest || input.pullRequest.number !== access.pullRequestNumber
      : access.pullRequestNumber !== undefined || access.pullRequestBaseSha !== undefined || Boolean(input.pullRequest))
    : Boolean(input.pullRequest) || input.revision.source === 'pull_request' || files.some(file => file.github !== undefined)) throw unavailable()
  if (access?.pullRequestBaseSha !== input.pullRequest?.baseSha
    || (input.factory && (!access || input.factory.sha !== input.revision.headSha))) throw unavailable()
  if (files.length > 20_000 || new Set(files.map(file => file.path)).size !== files.length
    || Buffer.byteLength(JSON.stringify(files)) > 1536 * 1024) throw new CodingWorkspaceError('workspace_limit_exceeded')
  if (files.some(file => file.fileVersion !== diffFileVersion(identity.repoId, input.revision, file))
    || input.revision.version !== manifestRevision(input.revision.source, input.revision.baseSha, input.revision.headSha, input.revision.treeSha, files, access).version)
    throw unavailable()
  if (!isDeepStrictEqual(maskDeep(files, mask), files)) throw new CodingWorkspaceError('workspace_path_unavailable')
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`workspace-snapshots:${identity.runId}`])
  const { rows: [existing] } = await client.query<{ snapshot: unknown }>(`SELECT snapshot FROM coding_workspace_snapshots
    WHERE "runId"=$1 AND "repoId"=$2 AND source=$3 AND version=$4`, [identity.runId, identity.repoId, input.revision.source, input.revision.version])
  if (existing) {
    const saved = diffSnapshot.parse(existing.snapshot)
    if (!isDeepStrictEqual(saved.identity, scope.identity) || saved.taskId !== scope.taskId
      || !isDeepStrictEqual(saved.sourceAccess, access)
      || !isDeepStrictEqual(saved.factory, input.factory)
      || (saved.pullRequest?.number ?? null) !== (input.pullRequest?.number ?? null)) throw unavailable()
    return saved
  }
  const count = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM coding_workspace_snapshots WHERE "runId"=$1', [identity.runId])
  if (count.rows[0]!.count >= SNAPSHOT_LIMIT) {
    // Never evict an anchor or a delivery receipt. Unreferenced observations
    // can make room without deleting an old review or inventing a new version.
    await client.query(`DELETE FROM coding_workspace_snapshots s WHERE s.id IN (
      SELECT candidate.id FROM coding_workspace_snapshots candidate WHERE candidate."runId"=$1
        AND NOT EXISTS(SELECT 1 FROM coding_workspace_review_comments c WHERE c."snapshotId"=candidate.id)
        AND NOT EXISTS(SELECT 1 FROM coding_workspace_review_batches b WHERE b."snapshotId"=candidate.id)
        AND NOT EXISTS(SELECT 1 FROM coding_workspace_checkpoint_reviews cp WHERE cp."snapshotId"=candidate.id)
      ORDER BY candidate."createdAt",candidate.id LIMIT 1)`, [identity.runId])
    if (!(await client.query<{ count: number }>('SELECT count(*)::int AS count FROM coding_workspace_snapshots WHERE "runId"=$1', [identity.runId])).rows
      .every(row => row.count < SNAPSHOT_LIMIT)) throw new CodingWorkspaceError('workspace_limit_exceeded')
  }
  const id = randomUUID(), rows: { path: string; position: number; metadata: DiffFileMetadata; patch: DiffFilePatch | null; maskPolicy: string | null }[] = []
  let total = 0
  for (const [position, metadata] of files.entries()) {
    const supplied = input.patches?.get(metadata.path)
    if (supplied && supplied.sourceVersion !== input.revision.version) throw unavailable()
    const patch = supplied ? diffFilePatch.parse({ ...supplied, snapshotId: id, sourceVersion: input.revision.version }) : null
    if (patch) {
      if (patch.file.fileVersion !== metadata.fileVersion || patch.file.path !== metadata.path) throw unavailable()
      assertDiffPatchSafe(patch, mask)
      const length = Buffer.byteLength(JSON.stringify(patch))
      if (length > 1024 * 1024) throw new CodingWorkspaceError('workspace_limit_exceeded')
      total += length
    }
    rows.push({ path: metadata.path, position, metadata, patch, maskPolicy: patch ? maskPolicy(mask) : null })
  }
  const usage = await client.query<{ bytes: number }>(`SELECT coalesce(sum(octet_length(f.patch::text)),0)::int AS bytes
    FROM coding_workspace_snapshot_files f JOIN coding_workspace_snapshots s ON s.id=f."snapshotId" WHERE s."runId"=$1`, [identity.runId])
  if (total + usage.rows[0]!.bytes > PATCH_BUDGET) throw new CodingWorkspaceError('workspace_limit_exceeded')
  const complete = !input.reason && rows.every(row => row.patch && ['text', 'binary'].includes(row.patch.format))
  const snapshot = diffSnapshot.parse({ id, identity, taskId: scope.taskId, revision: input.revision,
    observedAt: input.observedAt ?? new Date().toISOString(), isStale: input.revision.source === 'checkpoint',
    availability: input.reason ? 'unavailable' : files.length ? 'available' : 'empty', reason: input.reason ?? null,
    counts: { files: files.length, additions: rows.reduce((sum, row) => sum + (row.patch?.file.additions ?? row.metadata.additions), 0),
      deletions: rows.reduce((sum, row) => sum + (row.patch?.file.deletions ?? row.metadata.deletions), 0), complete },
    policy: policy[input.revision.source], pullRequest: input.pullRequest ?? null, ...(access ? { sourceAccess: access } : {}),
    ...(input.factory ? { factory: input.factory } : {}) })
  if (!isDeepStrictEqual(maskDeep(snapshot, mask), snapshot)) throw new CodingWorkspaceError('workspace_path_unavailable')
  await client.query(`INSERT INTO coding_workspace_snapshots (id,"runId","repoId","ownerId","workspaceId","boardId",source,version,snapshot)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, identity.runId, identity.repoId, identity.ownerId, identity.workspaceId,
    scope.boardId, input.revision.source, input.revision.version, snapshot])
  if (rows.length) await client.query(`INSERT INTO coding_workspace_snapshot_files ("snapshotId",path,position,metadata,patch,"maskPolicy")
    SELECT $1,x.path,x.position,x.metadata,x.patch,x."maskPolicy" FROM jsonb_to_recordset($2::jsonb)
    AS x(path text,position integer,metadata jsonb,patch jsonb,"maskPolicy" text)`, [id, JSON.stringify(rows)])
  return snapshot
}

export async function readDiffSnapshot(database: WorkspaceQuery, scope: ReviewScope, id: string): Promise<DiffSnapshot> {
  const { rows: [row] } = await database.query<{ snapshot: unknown; files: number; additions: number; deletions: number; complete: boolean }>(
    `SELECT s.snapshot,count(f.path)::int AS files,
      coalesce(sum(coalesce((f.patch->'file'->>'additions')::int,(f.metadata->>'additions')::int)),0)::int AS additions,
      coalesce(sum(coalesce((f.patch->'file'->>'deletions')::int,(f.metadata->>'deletions')::int)),0)::int AS deletions,
      coalesce(bool_and(f.patch IS NOT NULL AND f.patch->>'format' IN ('text','binary')) FILTER (WHERE f.path IS NOT NULL),true) AS complete
      FROM coding_workspace_snapshots s LEFT JOIN coding_workspace_snapshot_files f ON f."snapshotId"=s.id
      WHERE s.id=$1 AND s."runId"=$2 AND s."repoId"=$3 AND s."boardId"=$4 AND s."workspaceId"=$5 GROUP BY s.id`,
  [id, scope.identity.runId, scope.identity.repoId, scope.boardId, scope.identity.workspaceId])
  if (!row) throw unavailable()
  const saved = diffSnapshot.parse(row.snapshot)
  if (!isDeepStrictEqual(saved.identity, scope.identity) || saved.taskId !== scope.taskId) throw unavailable()
  return { ...saved, isStale: true, counts: { files: row.files, additions: row.additions, deletions: row.deletions,
    complete: saved.availability !== 'unavailable' && row.complete } }
}

export async function latestDiffSnapshot(database: WorkspaceQuery, scope: ReviewScope, source?: DiffRevision['source']) {
  const { rows: [row] } = await database.query<{ id: string }>(`SELECT id FROM coding_workspace_snapshots
    WHERE "runId"=$1 AND "repoId"=$2 AND "workspaceId"=$3 AND ($4::text IS NULL OR source=$4)
    ORDER BY "createdAt" DESC,id DESC LIMIT 1`, [scope.identity.runId, scope.identity.repoId, scope.identity.workspaceId, source ?? null])
  return row ? readDiffSnapshot(database, scope, row.id) : null
}

export async function readDiffFilePage(database: WorkspaceQuery, scope: ReviewScope, snapshot: DiffSnapshot, viewerId: string,
  options: { cursor?: string; limit?: number; unreviewed?: boolean } = {}): Promise<DiffFilePage> {
  if (!isDeepStrictEqual(snapshot.identity, scope.identity) || snapshot.taskId !== scope.taskId) throw unavailable()
  const limit = options.limit ?? 100
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CodingWorkspaceError('workspace_invalid_request')
  const match = options.cursor ? /^([a-f0-9]{64}):([0-9]+):([01]):([0-9]+)$/.exec(options.cursor) : null
  if (options.cursor && (!match || match[1] !== snapshot.revision.version || match[3] !== (options.unreviewed ? '1' : '0')))
    throw new WorkspaceReviewError('workspace_snapshot_outdated')
  const position = match ? Number(match[4]) : 0
  if (!Number.isSafeInteger(position) || position > 20_000) throw new CodingWorkspaceError('workspace_invalid_request')
  type Row = { metadata: unknown; position: number; reviewedAt: string | null }
  const { rows: [page] } = await database.query<{ revision: number; files: Row[] }>(`WITH entries AS (
    SELECT coalesce(f.patch->'file',f.metadata) AS metadata,f.position,r."reviewedAt" FROM coding_workspace_snapshot_files f
    JOIN coding_workspace_snapshots s ON s.id=f."snapshotId" AND s."boardId"=$2 AND s."runId"=$7 AND s."repoId"=$8 AND s."workspaceId"=$9
    LEFT JOIN coding_workspace_reviewed_files r ON r."boardId"=$2 AND r."userId"=$3 AND r.path=f.path
      AND r."fileVersion"=f.metadata->>'fileVersion'
    WHERE f."snapshotId"=$1 AND f.position>=$4 AND (NOT $5::boolean OR r.path IS NULL)
    ORDER BY f.position LIMIT $6
  ) SELECT b.revision,coalesce((SELECT jsonb_agg(to_jsonb(entries) ORDER BY position) FROM entries),'[]'::jsonb) AS files
    FROM coding_workspace_review_boards b JOIN coding_workspace_snapshots selected ON selected.id=$1 AND selected."boardId"=b.id
      AND selected."runId"=$7 AND selected."repoId"=$8 AND selected."workspaceId"=$9 WHERE b.id=$2`, [snapshot.id, scope.boardId, viewerId, position, options.unreviewed ?? false,
    limit + 1, scope.identity.runId, scope.identity.repoId, scope.identity.workspaceId])
  if (!page) throw unavailable()
  if (match && Number(match[2]) !== page.revision) throw new WorkspaceReviewError('workspace_review_conflict')
  const selected = page.files.slice(0, limit)
  return { snapshot, boardRevision: page.revision, files: selected.map(row => ({ ...diffFileMetadata.parse(row.metadata),
    reviewed: row.reviewedAt !== null, reviewedAt: row.reviewedAt ? new Date(row.reviewedAt).toISOString() : null })),
  nextCursor: page.files.length > limit ? `${snapshot.revision.version}:${page.revision}:${options.unreviewed ? 1 : 0}:${selected.at(-1)!.position + 1}` : null }
}

export async function readStoredDiffFile(database: WorkspaceQuery, scope: ReviewScope, snapshot: DiffSnapshot, path: string, mask: Masker) {
  const { rows: [row] } = await database.query<{ metadata: unknown; patch: unknown; maskPolicy: string | null }>(`SELECT f.metadata,f.patch,f."maskPolicy" FROM coding_workspace_snapshot_files f
    JOIN coding_workspace_snapshots s ON s.id=f."snapshotId" WHERE s.id=$1 AND s."boardId"=$2 AND s."runId"=$3 AND s."repoId"=$4 AND f.path=$5`,
  [snapshot.id, scope.boardId, scope.identity.runId, scope.identity.repoId, path])
  if (!row) throw unavailable()
  const file = diffFileMetadata.parse(row.metadata), patch = row.patch ? diffFilePatch.parse(row.patch) : null
  if (patch) {
    // A new multiline secret may span separate hunks and their omitted source.
    // Partial fragments cannot re-prove its absence, even if each hunk passes.
    if (row.maskPolicy !== maskPolicy(mask)) throw new CodingWorkspaceError('workspace_path_unavailable')
    assertDiffPatchSafe(patch, mask)
  }
  if (!isDeepStrictEqual(maskDeep(file, mask), file)) throw new CodingWorkspaceError('workspace_path_unavailable')
  return { file, patch }
}

export async function retainDiffFilePatch(client: PoolClient, scope: ReviewScope, snapshot: DiffSnapshot, input: DiffFilePatch, mask: Masker,
  verifiedPolicy = mask.sourcePolicy) {
  if (verifiedPolicy !== maskPolicy(mask)) throw new CodingWorkspaceError('workspace_path_unavailable')
  const patch = diffFilePatch.parse(input)
  if (patch.snapshotId !== snapshot.id || patch.sourceVersion !== snapshot.revision.version) throw unavailable()
  const current = await readStoredDiffFile(client, scope, snapshot, patch.file.path, mask)
  if (current.file.fileVersion !== patch.file.fileVersion) throw new WorkspaceReviewError('workspace_snapshot_outdated')
  if (current.patch) return current.patch
  assertDiffPatchSafe(patch, mask)
  const bytes = Buffer.byteLength(JSON.stringify(patch))
  if (bytes > 1024 * 1024) throw new CodingWorkspaceError('workspace_limit_exceeded')
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`workspace-snapshots:${scope.identity.runId}`])
  const usage = await client.query<{ bytes: number }>(`SELECT coalesce(sum(octet_length(f.patch::text)),0)::int AS bytes
    FROM coding_workspace_snapshot_files f JOIN coding_workspace_snapshots s ON s.id=f."snapshotId" WHERE s."runId"=$1`, [scope.identity.runId])
  if (usage.rows[0]!.bytes + bytes > PATCH_BUDGET) throw new CodingWorkspaceError('workspace_limit_exceeded')
  await client.query(`UPDATE coding_workspace_snapshot_files SET patch=$3,"maskPolicy"=$4 WHERE "snapshotId"=$1 AND path=$2 AND patch IS NULL`,
    [snapshot.id, patch.file.path, patch, verifiedPolicy])
  return (await readStoredDiffFile(client, scope, snapshot, patch.file.path, mask)).patch!
}
