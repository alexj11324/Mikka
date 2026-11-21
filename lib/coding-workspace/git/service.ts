import 'server-only'
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { CodingWorkspaceError, type RunWorktreeIdentity, type WorkspaceReadRequest } from '@mikka/protocol/coding-workspace'
import { diffSnapshot } from '@mikka/protocol/coding-workspace-review'
import { gitCheckpointList, type GitCheckpointList, type GitFrozen, type GitHistory, type GitStatus } from '@mikka/protocol/coding-workspace-git'
import { requestWorkspaceRead } from '../requests'
import { withReviewTransaction, type ReviewActor, type ReviewScope } from '../diff/authority'
import type { WorkspaceQuery } from '../identity'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export type GitDependencies = { database: Pool; membership: Pool }
type Live<T> = { value: T; live: RunWorktreeIdentity | null }

const frozenCodes = new Set(['workspace_not_found', 'workspace_machine_unavailable', 'workspace_checkout_unavailable',
  'workspace_request_expired'])

async function liveRead<T extends GitStatus | GitHistory>(dependencies: GitDependencies, actor: ReviewActor, runId: string,
  repoId: string, request: WorkspaceReadRequest, signal?: AbortSignal): Promise<Live<T>> {
  const result = await requestWorkspaceRead(dependencies.database, dependencies.membership, actor, runId, repoId, request, signal)
  if (!result.ok) throw new CodingWorkspaceError(result.code)
  return { value: result as T, live: (result as GitStatus | GitHistory).identity }
}

/** A stopped or unreachable Run falls back only to retained, provable facts:
 * a publication, the checkpoint review and commit snapshots. It never
 * fabricates a live branch, clean status or commit authorship. */
async function frozenRead(dependencies: GitDependencies, actor: ReviewActor, runId: string, repoId: string,
  kind: 'git_status' | 'git_history', reason: string, signal?: AbortSignal): Promise<Live<GitFrozen>> {
  return withReviewTransaction(dependencies.database, dependencies.membership, actor, runId, repoId, async (client, scope) => {
    const { rows: [publication] } = await client.query<{ branch: string | null; pullRequest: unknown }>(
      `SELECT branch,"pullRequest" FROM run_publications WHERE "runId"=$1 AND "userId"=$2 AND "remoteKey"=$3
        ORDER BY "updatedAt" DESC LIMIT 1`, [runId, scope.identity.ownerId, scope.identity.repositoryKey])
    const { rows: [checkpoint] } = await client.query<{ baseSha: string; headSha: string | null; treeSha: string | null }>(
      `SELECT "baseSha","headSha","treeSha" FROM coding_workspace_checkpoint_reviews
        WHERE "runId"=$1 AND "repoId"=$2 AND "workspaceId"=$3`, [runId, repoId, scope.identity.workspaceId])
    const { rows: [snapshot] } = await client.query<{ snapshot: unknown }>(
      `SELECT snapshot FROM coding_workspace_snapshots WHERE "runId"=$1 AND "repoId"=$2 AND "workspaceId"=$3 AND source='commit'
        ORDER BY "createdAt" DESC LIMIT 1`, [runId, repoId, scope.identity.workspaceId])
    const retained = snapshot ? diffSnapshot.parse(snapshot.snapshot).revision : null
    const pullRequest = parsePublication(publication?.pullRequest)
    const source = pullRequest ? 'pull_request' as const : checkpoint ? 'checkpoint' as const : 'commit' as const
    const baseSha = checkpoint?.baseSha ?? retained?.baseSha ?? null
    const commitSha = pullRequest?.headSha ?? checkpoint?.headSha ?? retained?.headSha ?? null
    const value: GitFrozen = { ok: true, identity: scope.identity, kind, observedAt: new Date().toISOString(),
      availability: 'offline', frozen: true, reason: reason === 'workspace_not_found' ? 'no_live_checkout'
        : reason === 'workspace_checkout_unavailable' ? 'checkout_unavailable' : 'machine_unavailable',
      source, branch: publication?.branch ?? null, commitSha, baseSha, pullRequest, commits: [] }
    return { value, live: null }
  }, { historical: true, signal })
}

function parsePublication(value: unknown): GitFrozen['pullRequest'] {
  if (!value || typeof value !== 'object') return null
  const row = value as { url?: unknown; state?: unknown; headSha?: unknown }
  if (typeof row.url !== 'string') return null
  const number = /\/pull\/(\d+)(?:$|[/?#])/.exec(row.url)?.[1]
  if (!number) return null
  const state = row.state === 'merged' || row.state === 'closed' ? row.state : 'open'
  const headSha = typeof row.headSha === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(row.headSha) ? row.headSha : null
  if (!headSha) return null
  return { number: Number(number), url: row.url, headSha, state }
}

export async function getRunGitStatus(dependencies: GitDependencies, actor: ReviewActor, runId: string, repoId: string, signal?: AbortSignal) {
  try { return await liveRead<GitStatus>(dependencies, actor, runId, repoId, { kind: 'git_status' }, signal) }
  catch (error) {
    if (!(error instanceof CodingWorkspaceError) || !frozenCodes.has(error.code)) throw error
    return frozenRead(dependencies, actor, runId, repoId, 'git_status', error.code, signal)
  }
}

export async function listRunGitHistory(dependencies: GitDependencies, actor: ReviewActor, runId: string,
  repoId: string, input: { cursor?: string; limit: number }, signal?: AbortSignal) {
  try {
    return await liveRead<GitHistory>(dependencies, actor, runId, repoId,
      { kind: 'git_history', ...(input.cursor ? { cursor: input.cursor } : {}), limit: input.limit }, signal)
  } catch (error) {
    if (!(error instanceof CodingWorkspaceError) || !frozenCodes.has(error.code)) throw error
    return frozenRead(dependencies, actor, runId, repoId, 'git_history', error.code, signal)
  }
}

type CheckpointRow = { snapshotId: string | null; baseSha: string; headSha: string | null; treeSha: string | null
  reason: GitCheckpointList['checkpoints'][number]['reason']; capturedAt: Date }
type SnapshotRow = { id: string; snapshot: unknown; createdAt: Date }
type LegacyRow = { baseCommit: string; files: number; takenAt: Date; unavailableReason: 'too_large' | null }

export async function readCheckpointEntries(client: WorkspaceQuery, scope: ReviewScope): Promise<GitCheckpointList['checkpoints']> {
  const { rows: [review] } = await client.query<CheckpointRow>(`SELECT "snapshotId","baseSha","headSha","treeSha",reason,"capturedAt"
    FROM coding_workspace_checkpoint_reviews WHERE "runId"=$1 AND "repoId"=$2 AND "workspaceId"=$3`,
  [scope.identity.runId, scope.identity.repoId, scope.identity.workspaceId])
  const { rows: snapshots } = await client.query<SnapshotRow>(`SELECT id,snapshot,"createdAt" FROM coding_workspace_snapshots
    WHERE "runId"=$1 AND "repoId"=$2 AND "workspaceId"=$3 AND source='checkpoint' ORDER BY "createdAt" DESC,id DESC LIMIT 50`,
  [scope.identity.runId, scope.identity.repoId, scope.identity.workspaceId])
  const { rows: [legacy] } = await client.query<LegacyRow>(`SELECT "baseCommit",files,"takenAt","unavailableReason" FROM run_checkpoints
    WHERE "runId"=$1 AND "userId"=$2`, [scope.identity.runId, scope.identity.ownerId])
  const restorableLegacy = Boolean(legacy && !legacy.unavailableReason && review && !review.reason && review.baseSha === legacy.baseCommit)
  const entries: GitCheckpointList['checkpoints'] = []
  for (const row of snapshots) {
    const snapshot = diffSnapshot.parse(row.snapshot)
    if (snapshot.revision.source !== 'checkpoint' || !snapshot.revision.baseSha || !snapshot.revision.version) continue
    const latest = review?.snapshotId === row.id
    const payload = latest && restorableLegacy && snapshot.revision.baseSha === legacy?.baseCommit
    entries.push({ checkpointId: row.id, revision: { source: 'checkpoint', baseSha: snapshot.revision.baseSha,
      headSha: snapshot.revision.headSha, treeSha: snapshot.revision.treeSha, version: snapshot.revision.version },
      takenAt: row.createdAt.toISOString(), files: snapshot.counts.files,
      restorable: payload, reason: payload ? null : 'missing_payload' })
  }
  if (!entries.length && review && legacy) {
    // Only the newest capture has a payload. Older retained snapshots above
    // remain visible evidence but are not silently offered as restorable.
    entries.push({ checkpointId: 'latest', revision: { source: 'checkpoint', baseSha: review.baseSha, headSha: review.headSha,
      treeSha: review.treeSha, version: digest(JSON.stringify([review.baseSha, review.headSha, review.treeSha, review.capturedAt.toISOString()])) },
      takenAt: review.capturedAt.toISOString(), files: legacy.files,
      restorable: restorableLegacy, reason: restorableLegacy ? null : legacy.unavailableReason ?? 'missing_payload' })
  }
  return entries
}

export async function listRunCheckpoints(dependencies: GitDependencies, actor: ReviewActor, runId: string,
  repoId: string, signal?: AbortSignal): Promise<GitCheckpointList> {
  return withReviewTransaction(dependencies.database, dependencies.membership, actor, runId, repoId, async (client, scope) => {
    return gitCheckpointList.parse({ ok: true, identity: scope.identity, checkpoints: await readCheckpointEntries(client, scope) })
  }, { historical: true, signal })
}

export async function readCheckpointRevision(client: WorkspaceQuery, scope: ReviewScope, checkpointId: string) {
  const entries = await readCheckpointEntries(client, scope)
  return entries.find(entry => entry.checkpointId === checkpointId) ?? null
}
