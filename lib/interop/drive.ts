import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { requireTaskWorkspace } from '@/lib/task-workspace'
import { ActionFailureError } from '@/lib/action-error'
import { agentDriveOwner, DRIVE_MAX_FILE_BYTES, isDrivePath, isVolumeId, type DriveScope } from '@/lib/drive/contract'
import { driveBytes, readDriveBlobObject, recordDriveBlob, storeDriveBlob } from '@/lib/drive/blobs'
import { applyDriveWrite, DriveError, readDriveVersion } from '@/lib/drive/store'
import { createDriveVolume, DriveVolumeError, listDriveVolumes, readDriveVolume, type DriveVolumeSummary } from '@/lib/drive/volumes'
import { InteropError } from './errors'
import { admitPrincipal, interopAllowed, principalReader, type InteropPrincipal } from './principal'
import { authorizedThread } from './threads'

/**
 * Drive for Agents and Bots (decision 2026-11-19-2200 §4): one shared folder
 * per scope. `workspace` is the existing `team-workspace` scope.
 */
export const INTEROP_DRIVE_SCOPES = ['bot', 'thread', 'environment', 'workspace'] as const
export type InteropDriveScope = typeof INTEROP_DRIVE_SCOPES[number]

/** Read and write bounds for a tool or API call; larger files stay a human Drive surface. */
export const INTEROP_DRIVE_READ_LIMIT = 1024 * 1024
export const INTEROP_DRIVE_WRITE_LIMIT = 4 * 1024 * 1024
/** The volume a scope's first write creates when it has none. */
export const DEFAULT_SCOPE_VOLUME = 'Shared'

const uuid = z.uuid()
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

export type DriveTarget = {
  /** What a caller named, echoed back. */
  scope: InteropDriveScope
  /** The stored scope and its id; a thread is always its root run. */
  driveScope: DriveScope
  scopeId: string
  workspaceId: string
  /** The storage namespace that owns the volumes and their bytes. */
  storageOwner: string
}

function denied(cause?: unknown): never {
  throw new InteropError('interop_not_found', cause === undefined ? {} : { cause })
}

/** Workspace membership of the owner, with the tenant's kind. A service has no membership. */
async function memberWorkspace(principal: InteropPrincipal) {
  const reader = principalReader(principal)
  if (!reader) denied()
  try { return await requireTaskWorkspace(reader, principal.workspaceId) }
  catch (error) { if (error instanceof ActionFailureError) denied(error); throw error }
}

/**
 * Who may read or write this scope's Drive, under the principal's tenant only.
 * Every refusal is `interop_not_found`, so ids of other people and tenants
 * cannot be probed.
 */
export async function resolveDriveTarget(principal: InteropPrincipal, input: { scope: string; scopeId?: string }, access: 'read' | 'write'): Promise<DriveTarget> {
  const scope = z.enum(INTEROP_DRIVE_SCOPES).safeParse(input.scope)
  if (!scope.success) throw new InteropError('interop_invalid_request', { cause: scope.error })
  const action = access === 'read' ? 'canReadContent' : 'canSteer'
  const { workspaceId } = principal
  switch (scope.data) {
    case 'workspace': {
      if (input.scopeId !== undefined && input.scopeId !== workspaceId) denied()
      const workspace = await memberWorkspace(principal)
      if (workspace.kind !== 'team') denied()
      return { scope: 'workspace', driveScope: 'team-workspace', scopeId: workspaceId, workspaceId, storageOwner: `drive-team:${workspaceId}` }
    }
    case 'environment': {
      if (!uuid.safeParse(input.scopeId).success) denied()
      await memberWorkspace(principal)
      const { rowCount } = await workspacePool.query('SELECT 1 FROM workspace_environments WHERE id=$1 AND "workspaceId"=$2 AND "archivedAt" IS NULL', [input.scopeId, workspaceId])
      if (!rowCount) denied()
      return { scope: 'environment', driveScope: 'environment', scopeId: input.scopeId!, workspaceId, storageOwner: agentDriveOwner(workspaceId, 'environment', input.scopeId!) }
    }
    case 'bot': {
      if (!uuid.safeParse(input.scopeId).success) denied()
      await admitPrincipal(principal)
      const { rows: [bot] } = await pool.query<{ workspaceId: string }>('SELECT "workspaceId" FROM bots WHERE id=$1 AND "archivedAt" IS NULL', [input.scopeId])
      if (bot?.workspaceId !== workspaceId) denied()
      // A Bot always reaches its own Drive; everyone else needs the ACL.
      const self = principal.kind === 'bot' && principal.botId === input.scopeId
      if (!self && !await interopAllowed(principal, { kind: 'bot', id: input.scopeId! }, action)) denied()
      return { scope: 'bot', driveScope: 'bot', scopeId: input.scopeId!, workspaceId, storageOwner: agentDriveOwner(workspaceId, 'bot', input.scopeId!) }
    }
    case 'thread': {
      const { chain } = await authorizedThread(principal, input.scopeId ?? '', action)
      return { scope: 'thread', driveScope: 'thread', scopeId: chain.rootRunId, workspaceId, storageOwner: agentDriveOwner(workspaceId, 'thread', chain.rootRunId) }
    }
  }
}

function volumeScope(target: DriveTarget) {
  return { driveScope: target.driveScope, scopeId: target.scopeId, workspaceId: target.workspaceId }
}

async function selectVolume(target: DriveTarget, volumeId: string | undefined): Promise<DriveVolumeSummary | null> {
  const actor = { ownerId: target.storageOwner, ...volumeScope(target) }
  if (volumeId !== undefined) {
    if (!isVolumeId(volumeId)) denied()
    try { return await readDriveVolume(pool, actor, volumeId) }
    catch (error) { if (error instanceof DriveVolumeError) denied(error); throw error }
  }
  // The scope's first folder is its default; a new scope has none until a write.
  const volumes = await listDriveVolumes(pool, actor, volumeScope(target))
  return volumes.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0] ?? null
}

export interface InteropDriveListing {
  scope: InteropDriveScope; scopeId: string
  volumes: { id: string; name: string; headDigest: string; entryCount: number; totalBytes: number; updatedAt: string }[]
  volume: { id: string; name: string; headVersionId: string; headDigest: string; entries: { path: string; sizeBytes: number; sha256: string }[] } | null
}

/** The scope's folders and the selected (default) folder's files at its head. */
export async function listInteropDrive(principal: InteropPrincipal, input: { scope: string; scopeId?: string; volumeId?: string; prefix?: string }): Promise<InteropDriveListing> {
  const target = await resolveDriveTarget(principal, input, 'read')
  const volumes = await listDriveVolumes(pool, { ownerId: target.storageOwner }, volumeScope(target), { limit: 100 })
  const selected = await selectVolume(target, input.volumeId)
  let volume: InteropDriveListing['volume'] = null
  if (selected) {
    const version = await readDriveVersion(pool, { ownerId: target.storageOwner }, selected.id, selected.headVersionId)
    const prefix = input.prefix ?? ''
    volume = { id: selected.id, name: selected.name, headVersionId: version.id, headDigest: version.digest,
      entries: version.manifest.filter(entry => entry.path.startsWith(prefix)).slice(0, 1000)
        .map(entry => ({ path: entry.path, sizeBytes: entry.sizeBytes, sha256: entry.sha256 })) }
  }
  return {
    scope: target.scope, scopeId: target.scopeId, volume,
    volumes: volumes.map(row => ({ id: row.id, name: row.name, headDigest: row.headDigest, entryCount: row.entryCount, totalBytes: row.totalBytes, updatedAt: row.updatedAt.toISOString() })),
  }
}

async function readAll(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.byteLength
    if (size > limit) throw new InteropError('interop_drive_unavailable', { detail: 'file_too_large' })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

export interface InteropDriveFile { scope: InteropDriveScope; scopeId: string; volumeId: string; path: string; sha256: string; sizeBytes: number; headDigest: string; encoding: 'utf8' | 'base64'; content: string }

/** One file at the head (or a named version) of the scope's folder. */
export async function readInteropDriveFile(principal: InteropPrincipal, input: { scope: string; scopeId?: string; volumeId?: string; path: string; encoding?: 'utf8' | 'base64' }, signal?: AbortSignal): Promise<InteropDriveFile> {
  if (!isDrivePath(input.path)) throw new InteropError('interop_invalid_request')
  const target = await resolveDriveTarget(principal, input, 'read')
  const volume = await selectVolume(target, input.volumeId)
  if (!volume) denied()
  const version = await readDriveVersion(pool, { ownerId: target.storageOwner }, volume.id, volume.headVersionId)
  const entry = version.manifest.find(item => item.path === input.path)
  if (!entry) denied()
  if (entry.sizeBytes > INTEROP_DRIVE_READ_LIMIT) throw new InteropError('interop_drive_unavailable', { detail: 'file_too_large' })
  const { rows: [blob] } = await pool.query<{ inlineContent: Buffer | null }>('SELECT "inlineContent" FROM drive_blobs WHERE "ownerId"=$1 AND sha256=$2', [target.storageOwner, entry.sha256])
  if (!blob) denied()
  const bytes = blob.inlineContent ?? await readAll(await readDriveBlobObject(target.storageOwner, entry.sha256, signal ?? new AbortController().signal), INTEROP_DRIVE_READ_LIMIT)
  const encoding = input.encoding ?? 'utf8'
  return { scope: target.scope, scopeId: target.scopeId, volumeId: volume.id, path: entry.path, sha256: entry.sha256, sizeBytes: entry.sizeBytes,
    headDigest: version.digest, encoding, content: Buffer.from(bytes).toString(encoding) }
}

export const interopDriveWriteInput = z.object({
  scope: z.enum(INTEROP_DRIVE_SCOPES),
  scopeId: z.string().max(64).optional(),
  volumeId: z.string().refine(isVolumeId).optional(),
  path: z.string().refine(isDrivePath),
  /** Omit to delete the path. */
  content: z.string().max(Math.ceil(INTEROP_DRIVE_WRITE_LIMIT * 4 / 3) + 4).optional(),
  encoding: z.enum(['utf8', 'base64']).optional(),
  expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  mutationId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
}).strict()

export interface InteropDriveWriteResult { scope: InteropDriveScope; scopeId: string; volumeId: string; headVersionId: string; headDigest: string; replayed: boolean }

/**
 * Write one file with Drive's compare-and-swap: `expectedDigest` is the head
 * the writer read. A changed head is `interop_drive_conflict` naming the head
 * to re-read; nothing is overwritten silently.
 */
export async function writeInteropDriveFile(principal: InteropPrincipal, raw: unknown, authorName: string): Promise<InteropDriveWriteResult> {
  const parsed = interopDriveWriteInput.safeParse(raw)
  if (!parsed.success) throw new InteropError('interop_invalid_request', { cause: parsed.error })
  const input = parsed.data
  const target = await resolveDriveTarget(principal, input, 'write')
  let volume = await selectVolume(target, input.volumeId)
  if (!volume) {
    const actor = { ownerId: target.storageOwner, authorName }
    try { volume = await createDriveVolume(pool, actor, { ...volumeScope(target), name: DEFAULT_SCOPE_VOLUME }, sha256) }
    catch (error) {
      // A concurrent first write created it.
      if (!(error instanceof DriveVolumeError && error.code === 'drive_volume_exists')) throw error
      volume = await selectVolume(target, undefined)
      if (!volume) throw error
    }
  }
  const changes = []
  if (input.content === undefined) changes.push({ op: 'delete' as const, path: input.path })
  else {
    const bytes = driveBytes(Buffer.from(input.content, input.encoding ?? 'utf8'))
    if (bytes.byteLength > Math.min(INTEROP_DRIVE_WRITE_LIMIT, DRIVE_MAX_FILE_BYTES)) throw new InteropError('interop_drive_unavailable', { detail: 'file_too_large' })
    const blob = await storeDriveBlob(target.storageOwner, bytes, { workspaceId: target.workspaceId })
    await recordDriveBlob(pool, blob, bytes)
    changes.push({ op: 'put' as const, path: input.path, mode: 0o644 as const, sha256: blob.sha256, sizeBytes: blob.sizeBytes })
  }
  try {
    const result = await applyDriveWrite(pool, { ownerId: target.storageOwner, volumeId: volume.id, driveScope: target.driveScope },
      { ownerId: target.storageOwner, authorName, threadId: target.driveScope === 'thread' ? target.scopeId : null },
      { expectedDigest: input.expectedDigest, mutationId: input.mutationId, changes })
    return { scope: target.scope, scopeId: target.scopeId, volumeId: volume.id, headVersionId: result.headVersionId, headDigest: result.headDigest, replayed: result.replayed }
  } catch (error) {
    if (error instanceof DriveError) {
      if (error.code === 'drive_version_conflict') throw new InteropDriveConflict(error)
      if (error.code === 'drive_not_found') denied(error)
      if (error.code === 'drive_replay_mismatch') throw new InteropError('interop_invalid_request', { cause: error })
      if (error.code === 'drive_limit_exceeded') throw new InteropError('interop_drive_unavailable', { detail: 'file_too_large', cause: error })
      if (error.code === 'drive_manifest_invalid' || error.code === 'drive_write_invalid') throw new InteropError('interop_invalid_request', { cause: error })
    }
    throw error
  }
}

/** A CAS refusal that carries the head the writer must re-read. */
export class InteropDriveConflict extends InteropError {
  readonly headDigest: string
  readonly headVersionId: string
  readonly paths: string[]
  constructor(cause: DriveError) {
    super('interop_drive_conflict', { cause })
    this.headDigest = cause.detail?.headDigest ?? ''
    this.headVersionId = cause.detail?.headVersionId ?? ''
    this.paths = cause.detail?.paths ?? []
  }
}
