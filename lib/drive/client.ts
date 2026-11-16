import { withBasePath } from '../base-path'
import { DRIVE_MAX_CHANGES, DRIVE_MAX_FILE_BYTES, isDrivePath, type DriveFileLink, type DriveFileLinkVisibility, type DriveManifestEntry, type DriveSkillCursor, type DriveSkillPage } from './contract'
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

export type DriveLocation = string | { workspaceId: string; projectId: string; driveScope?: 'project' }
  | { workspaceId: string; driveScope: 'team-workspace'; projectId?: never }

function locationKey(location: DriveLocation) {
  if (typeof location === 'string') return [location] as const
  if (location.driveScope === 'team-workspace') return [location.workspaceId, 'team-workspace'] as const
  const ids = [location.workspaceId, location.projectId] as const
  return location.driveScope === 'project' ? [...ids, 'project'] as const : ids
}

export const driveVolumesKey = (location: DriveLocation, ownerId: string) => ['drive:volumes', ownerId, ...locationKey(location)] as const
export const driveHeadKey = (location: DriveLocation, ownerId: string, volumeId: string) => ['drive:head', ownerId, ...locationKey(location), volumeId] as const
export const driveHistoryKey = (location: DriveLocation, ownerId: string, volumeId: string) => ['drive:history', ownerId, ...locationKey(location), volumeId] as const

function url(location: DriveLocation, suffix = '', query: Record<string, string | undefined> = {}) {
  const params = new URLSearchParams(typeof location === 'string'
    ? { workspaceId: location }
    : { workspaceId: location.workspaceId, ...(location.projectId ? { projectId: location.projectId } : {}), ...(location.driveScope ? { driveScope: location.driveScope } : {}) })
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

export type PersonalDriveScope = { driveScope: 'user'; workspaceId: string }
  | { driveScope: 'project-user'; workspaceId: string; projectId: string; name: string }

export function readTeamDriveScopes(workspaceId: string, send?: typeof fetch) {
  const params = new URLSearchParams({ workspaceId, driveScope: 'team-workspace' })
  return request<{ scopes: { driveScope: 'team-workspace'; workspaceId: string }[] }>(withBasePath(`/api/drive/scopes?${params}`), {}, send)
}

export function readProjectDriveScopes(workspaceId: string, send?: typeof fetch) {
  const params = new URLSearchParams({ workspaceId, driveScope: 'project' })
  return request<{ scopes: { driveScope: 'project'; workspaceId: string; projectId: string; name: string }[] }>(
    withBasePath(`/api/drive/scopes?${params}`), {}, send)
}

export function readPersonalDriveScopes(workspaceId: string, send?: typeof fetch) {
  const params = new URLSearchParams({ workspaceId })
  return request<{ scopes: PersonalDriveScope[] }>(withBasePath(`/api/drive/scopes?${params}`), {}, send)
}

export function driveFileLinkUrl(location: DriveLocation, volumeId: string, linkId: string) {
  return url(location, `/${encodeURIComponent(volumeId)}/shares/${encodeURIComponent(linkId)}`)
}

export function readOwnDriveFileLink(location: DriveLocation, volumeId: string, path: string, send?: typeof fetch) {
  return request<{ link: DriveFileLink | null }>(url(location, `/${encodeURIComponent(volumeId)}/shares`, { path }), {}, send)
}

export function createDriveFileLink(location: DriveLocation, volumeId: string, path: string, send?: typeof fetch) {
  return request<{ link: DriveFileLink }>(url(location, `/${encodeURIComponent(volumeId)}/shares`),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }, send)
}

export function updateDriveFileLink(location: DriveLocation, volumeId: string, linkId: string, visibility: DriveFileLinkVisibility, send?: typeof fetch) {
  return request<{ link: DriveFileLink }>(driveFileLinkUrl(location, volumeId, linkId),
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visibility }) }, send)
}

export function revokeDriveFileLink(location: DriveLocation, volumeId: string, linkId: string, send?: typeof fetch) {
  return request<{ revoked: true }>(driveFileLinkUrl(location, volumeId, linkId), { method: 'DELETE' }, send)
}

export function readDriveSkills(location: DriveLocation, after?: DriveSkillCursor, send?: typeof fetch) {
  return request<DriveSkillPage>(url(location, '', { view: 'skills', afterVolume: after?.volumeId, afterPath: after?.path }), {}, send)
}

export function readDriveVolumes(location: DriveLocation, before?: string, send?: typeof fetch) {
  return request<DriveVolumePage>(url(location, '', { before }), {}, send)
}

export function readArchivedDriveVolumes(location: DriveLocation, before?: string, send?: typeof fetch) {
  return request<DriveVolumePage>(url(location, '', { archived: 'true', before }), {}, send)
}

export function setPersonalDriveArchive(location: DriveLocation, volumeId: string, archived: boolean, send?: typeof fetch) {
  const operation = archived ? 'archive' : 'unarchive'
  return request<{ archived: boolean }>(url(location, `/${encodeURIComponent(volumeId)}/${operation}`), { method: 'POST' }, send)
}

export function readDriveHead(location: DriveLocation, volumeId: string, send?: typeof fetch) {
  return request<DriveHead>(url(location, `/${encodeURIComponent(volumeId)}`), {}, send)
}

export function readDriveHistory(location: DriveLocation, volumeId: string, before?: string, send?: typeof fetch) {
  return request<DriveHistoryPage>(url(location, `/${encodeURIComponent(volumeId)}/versions`, { before }), {}, send)
}

export function readDriveFileHistory(location: DriveLocation, volumeId: string, path: string, before?: string, send?: typeof fetch) {
  return request<{ versions: (DriveVersion & { file: DriveManifestEntry | null })[]; nextCursor: string | null }>(
    url(location, `/${encodeURIComponent(volumeId)}/versions`, { path, before }), {}, send)
}

export function readDriveVersion(location: DriveLocation, volumeId: string, versionId: string, send?: typeof fetch) {
  return request<DriveVersionRead>(url(location, `/${encodeURIComponent(volumeId)}/versions/${encodeURIComponent(versionId)}`), {}, send)
}

export function driveFileURL(location: DriveLocation, volumeId: string, path: string, versionId?: string) {
  return url(location, `/${encodeURIComponent(volumeId)}/files`, { path, versionId })
}

export function createDriveVolume(location: DriveLocation, name: string, send?: typeof fetch) {
  return request<{ volume: DriveVolume }>(url(location), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  }, send)
}

/** Upload bytes first; the compare-and-swap then publishes the complete file selection. */
export async function uploadDriveFiles(location: DriveLocation, volumeId: string, expectedDigest: string,
  files: readonly File[], mutationId: string, send: typeof fetch = fetch) {
  if (!files.length || files.some(file => file.size > DRIVE_MAX_FILE_BYTES)) throw new DriveRequestError('drive_limit_exceeded', 413)
  if (files.length > DRIVE_MAX_CHANGES || files.some(file => !isDrivePath(file.name)))
    throw new DriveRequestError('drive_write_invalid', 400)
  if (new Set(files.map(file => file.name)).size !== files.length)
    throw new DriveRequestError('drive_write_invalid', 422)
  const changes: { op: 'put'; path: string; mode: 420; sha256: string; sizeBytes: number }[] = []
  for (const file of files) {
    const blob = await request<{ sha256: string; sizeBytes: number }>(url(location, `/${encodeURIComponent(volumeId)}/blobs`), {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file,
    }, send)
    changes.push({ op: 'put', path: file.name, mode: 420, sha256: blob.sha256, sizeBytes: blob.sizeBytes })
  }
  return request<{ headDigest: string; headVersionId: string }>(url(location, `/${encodeURIComponent(volumeId)}/entries`), {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedDigest, mutationId, changes }),
  }, send)
}

/** Remove one path from the displayed head and retain all earlier immutable versions. */
export function deleteDriveFile(location: DriveLocation, volumeId: string, path: string, expectedDigest: string,
  mutationId: string, send?: typeof fetch) {
  return request<{ headDigest: string; headVersionId: string }>(url(location, `/${encodeURIComponent(volumeId)}/entries`), {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedDigest, mutationId, changes: [{ op: 'delete', path }] }),
  }, send)
}

export function restoreDriveVersion(location: DriveLocation, volumeId: string, versionId: string, expectedDigest: string,
  mutationId: string, send?: typeof fetch) {
  return request<{ headDigest: string; headVersionId: string }>(url(location, `/${encodeURIComponent(volumeId)}/restore`), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versionId, expectedDigest, mutationId }),
  }, send)
}
