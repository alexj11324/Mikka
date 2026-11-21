import 'server-only'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { getArtifactObject } from '@/lib/artifacts/storage'
import { InteropError } from './errors'
import { aclParams, aclPredicate, admitPrincipal, requireInterop, type InteropPrincipal } from './principal'

const CONTENT_LIMIT = 256 * 1024
const uuid = z.uuid()

export interface InteropArtifact { id: string; kind: string; title: string; runId: string | null; issueId: string | null; latestVersion: number; updatedAt: string }

/** Artifacts of the principal's tenant it may read, newest first. */
export async function listInteropArtifacts(principal: InteropPrincipal, input: { runId?: string; issueId?: string; limit?: number } = {}): Promise<InteropArtifact[]> {
  if ((input.runId !== undefined && !uuid.safeParse(input.runId).success) || (input.issueId !== undefined && !uuid.safeParse(input.issueId).success))
    throw new InteropError('interop_invalid_request')
  await admitPrincipal(principal)
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100))
  const { rows } = await pool.query<{ id: string; kind: string; title: string; runId: string | null; issueId: string | null; latestVersion: number; updatedAt: Date }>(
    `SELECT a.id,a.kind,a.title,a."runId",a."issueId",a."latestVersion",a."updatedAt" FROM artifacts a
     WHERE a."workspaceId"=$1 AND ($2::uuid IS NULL OR a."runId"=$2) AND ($3::uuid IS NULL OR a."issueId"=$3)
       AND ${aclPredicate(5, '$1', 'artifact', 'a.id', 'canReadContent')}
     ORDER BY a."updatedAt" DESC, a.id DESC LIMIT $4`,
    [principal.workspaceId, input.runId ?? null, input.issueId ?? null, limit, ...aclParams(principal)])
  return rows.map(row => ({ ...row, updatedAt: row.updatedAt.toISOString() }))
}

/** One version of an artifact; the latest when `version` is omitted. Text is bounded. */
export async function readInteropArtifact(principal: InteropPrincipal, artifactId: string, version?: number): Promise<InteropArtifact & { version: number; content: string; truncated: boolean }> {
  if (!uuid.safeParse(artifactId).success || (version !== undefined && (!Number.isInteger(version) || version < 1))) throw new InteropError('interop_not_found')
  await admitPrincipal(principal)
  const { rows: [artifact] } = await pool.query<{ id: string; kind: string; title: string; runId: string | null; issueId: string | null; latestVersion: number; updatedAt: Date; workspaceId: string | null }>(
    'SELECT id,kind,title,"runId","issueId","latestVersion","updatedAt","workspaceId" FROM artifacts WHERE id=$1', [artifactId])
  if (!artifact || artifact.workspaceId !== principal.workspaceId) throw new InteropError('interop_not_found')
  await requireInterop(principal, { kind: 'artifact', id: artifactId }, 'canReadContent')
  const selected = version ?? artifact.latestVersion
  const { rows: [row] } = await pool.query<{ storageKey: string; inlineContent: string | null }>(
    'SELECT "storageKey","inlineContent" FROM artifact_versions WHERE "artifactId"=$1 AND version=$2', [artifactId, selected])
  if (!row) throw new InteropError('interop_not_found')
  const full = row.inlineContent ?? await getArtifactObject(row.storageKey)
  const content = full.slice(0, CONTENT_LIMIT)
  const { workspaceId: _tenant, ...summary } = artifact
  return { ...summary, updatedAt: artifact.updatedAt.toISOString(), version: selected, content, truncated: full.length > content.length }
}
