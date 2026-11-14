import { withBasePath } from '../base-path'
import { DRIVE_MAX_FILE_BYTES, type DriveManifestEntry } from './contract'
import type { DriveVolumeSummary } from './volumes'
import type { DriveVersionSummary } from './store'

export type DriveVolume = Omit<DriveVolumeSummary, 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string }
export type DriveVersion = Omit<DriveVersionSummary, 'createdAt'> & { createdAt: string }
export type DriveVolumePage = { volumes: DriveVolume[]; nextCursor: string | null }
export type DriveHistoryPage = { versions: DriveVersion[]; nextCursor: string | null }
export type DriveHead = { volume: DriveVolume; head: { headVersionId: string; headDigest: string; entries: DriveManifestEntry[] } }
export type DriveVersionRead = { version: DriveVersion & { manifest: DriveManifestEntry[] } }

export class DriveRequestError extends Error {
  readonly code: string
  readonly status?: number
  constructor(code: string, status?: number, options?: ErrorOptions) {
    super(code, options)
    this.code = code
    this.status = status
    this.name = 'DriveRequestError'
  }
}

export const driveVolumesKey = (workspaceId: string, ownerId: string) => ['drive:volumes', ownerId, workspaceId] as const
export const driveHeadKey = (workspaceId: string, ownerId: string, volumeId: string) => ['drive:head', ownerId, workspaceId, volumeId] as const
export const driveHistoryKey = (workspaceId: string, ownerId: string, volumeId: string) => ['drive:history', ownerId, workspaceId, volumeId] as const

function url(workspaceId: string, suffix = '', query: Record<string, string | undefined> = {}) {
  const params = new URLSearchParams({ workspaceId })
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, value)
  return withBasePath(`/api/drive/volumes${suffix}?${params}`)
}

async function request<T>(target: string, init: RequestInit = {}, send: typeof fetch = fetch): Promise<T> {
  let response: Response
  try { response = await send(target, { ...init, credentials: 'same-origin', cache: 'no-store' }) }
  catch (cause) { throw new DriveRequestError('drive_unavailable', undefined, { cause }) }
  let body: unknown
  try { body = await response.json() }
  catch (cause) { throw new DriveRequestError('drive_unavailable', response.status, { cause }) }
  if (!response.ok) {
    const code = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error : 'drive_unavailable'
    throw new DriveRequestError(code, response.status)
  }
  if (!body || typeof body !== 'object') throw new DriveRequestError('drive_unavailable', response.status)
  return body as T
}

export function readDriveVolumes(workspaceId: string, before?: string, send?: typeof fetch) {
  return request<DriveVolumePage>(url(workspaceId, '', { before }), {}, send)
}

export function readArchivedDriveVolumes(workspaceId: string, before?: string, send?: typeof fetch) {
  return request<DriveVolumePage>(url(workspaceId, '', { archived: 'true', before }), {}, send)
}

export function setPersonalDriveArchive(workspaceId: string, volumeId: string, archived: boolean, send?: typeof fetch) {
  const operation = archived ? 'archive' : 'unarchive'
  return request<{ archived: boolean }>(url(workspaceId, `/${encodeURIComponent(volumeId)}/${operation}`), { method: 'POST' }, send)
}

export function readDriveHead(workspaceId: string, volumeId: string, send?: typeof fetch) {
  return request<DriveHead>(url(workspaceId, `/${encodeURIComponent(volumeId)}`), {}, send)
}

export function readDriveHistory(workspaceId: string, volumeId: string, before?: string, send?: typeof fetch) {
  return request<DriveHistoryPage>(url(workspaceId, `/${encodeURIComponent(volumeId)}/versions`, { before }), {}, send)
}

export function readDriveFileHistory(workspaceId: string, volumeId: string, path: string, before?: string, send?: typeof fetch) {
  return request<{ versions: (DriveVersion & { file: DriveManifestEntry | null })[]; nextCursor: string | null }>(
    url(workspaceId, `/${encodeURIComponent(volumeId)}/versions`, { path, before }), {}, send)
}

export function readDriveVersion(workspaceId: string, volumeId: string, versionId: string, send?: typeof fetch) {
  return request<DriveVersionRead>(url(workspaceId, `/${encodeURIComponent(volumeId)}/versions/${encodeURIComponent(versionId)}`), {}, send)
}

export function driveFileURL(workspaceId: string, volumeId: string, path: string, versionId?: string) {
  return url(workspaceId, `/${encodeURIComponent(volumeId)}/files`, { path, versionId })
}

export function createDriveVolume(workspaceId: string, name: string, send?: typeof fetch) {
  return request<{ volume: DriveVolume }>(url(workspaceId), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  }, send)
}

/** Upload bytes first; the compare-and-swap then publishes the complete file selection. */
export async function uploadDriveFiles(workspaceId: string, volumeId: string, expectedDigest: string,
  files: readonly File[], mutationId: string, send: typeof fetch = fetch) {
  if (!files.length || files.some(file => file.size > DRIVE_MAX_FILE_BYTES)) throw new DriveRequestError('drive_limit_exceeded', 413)
  const changes: { op: 'put'; path: string; mode: 420; sha256: string; sizeBytes: number }[] = []
  for (const file of files) {
    const blob = await request<{ sha256: string; sizeBytes: number }>(url(workspaceId, `/${encodeURIComponent(volumeId)}/blobs`), {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file,
    }, send)
    changes.push({ op: 'put', path: file.name, mode: 420, sha256: blob.sha256, sizeBytes: blob.sizeBytes })
  }
  return request<{ headDigest: string; headVersionId: string }>(url(workspaceId, `/${encodeURIComponent(volumeId)}/entries`), {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedDigest, mutationId, changes }),
  }, send)
}

export function restoreDriveVersion(workspaceId: string, volumeId: string, versionId: string, expectedDigest: string,
  mutationId: string, send?: typeof fetch) {
  return request<{ headDigest: string; headVersionId: string }>(url(workspaceId, `/${encodeURIComponent(volumeId)}/restore`), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versionId, expectedDigest, mutationId }),
  }, send)
}
