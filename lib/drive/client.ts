import { withBasePath } from '../base-path'
import { driveFileLinkUrl, driveShareViewUrl, organizationDriveVersionFileUrl, driveVolumeUrl as url, type DriveLocation } from './location'
export { driveFileLinkUrl, type DriveLocation } from './location'
import { DRIVE_MAX_CHANGES, DRIVE_MAX_FILE_BYTES, isDrivePath, type DriveFileVersion, type DriveFileLinkDetails, type DriveFileLinkPage, type DriveShareView, type DriveWorkspaceFileLinkPage, type DriveFileLinkVisibility, type DriveManifestEntry, type DriveSkillCursor, type DriveSkillPage } from './contract'
import type { OrganizationDriveScopePage, OrganizationDriveVolume } from './organization-volumes'
import type { DriveVolumeSummary } from './volumes'
import type { DriveVersionSummary } from './store'

export type DriveVolume = Omit<DriveVolumeSummary, 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string }
export type DriveVersion = Omit<DriveVersionSummary, 'createdAt'> & { createdAt: string }
export type DriveVolumePage = { volumes: DriveVolume[]; nextCursor: string | null }
export type DriveHistoryPage = { versions: DriveVersion[]; nextCursor: string | null }
export type DriveHead = { volume: DriveVolume; head: { headVersionId: string; headDigest: string; entries: DriveManifestEntry[] } }
export type DriveVersionRead = { version: DriveVersion & { manifest: DriveManifestEntry[]; parentDigest?: string | null } }
export type OrganizationDriveVersion = Pick<DriveVersion, 'id' | 'kind' | 'fileCount' | 'totalBytes' | 'createdAt' | 'threadId' | 'threadTitle' | 'authorName'> & { volumeId: string }
export type OrganizationDriveManifest = Pick<DriveVersion, 'digest' | 'fileCount' | 'totalBytes'> & {
  versionId: string; volumeId: string; parentDigest: string | null; entries: DriveManifestEntry[]
}

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

function locationKey(location: DriveLocation) {
  if (typeof location === 'string') return [location] as const
  if (location.driveScope === 'team-workspace') return [location.workspaceId, 'team-workspace'] as const
  const ids = [location.workspaceId, location.projectId] as const
  return location.driveScope === 'project' ? [...ids, 'project'] as const : ids
}

export const driveVolumesKey = (location: DriveLocation, ownerId: string) => ['drive:volumes', ownerId, ...locationKey(location)] as const
export const driveHeadKey = (location: DriveLocation, ownerId: string, volumeId: string) => ['drive:head', ownerId, ...locationKey(location), volumeId] as const
export const driveHistoryKey = (location: DriveLocation, ownerId: string, volumeId: string) => ['drive:history', ownerId, ...locationKey(location), volumeId] as const

async function request<T>(target: string, init: RequestInit = {}, send: typeof fetch = fetch, empty = false): Promise<T> {
  let response: Response
  try { response = await send(target, { ...init, credentials: 'same-origin', cache: 'no-store' }) }
  catch (cause) { throw new DriveRequestError('drive_unavailable', undefined, { cause }) }
  if (empty && response.status === 204) return undefined as T
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

export function readDriveShareView(shareId: string, send?: typeof fetch) {
  return request<DriveShareView>(driveShareViewUrl(shareId), {}, send)
}

export function readWorkspaceDriveFileLinks(workspaceId: string, page = 1, send?: typeof fetch) {
  const query = new URLSearchParams({ workspaceId, page: String(page) })
  return request<DriveWorkspaceFileLinkPage>(withBasePath(`/api/drive/shares?${query}`), {}, send)
}

export function readDriveFileLinks(location: DriveLocation, volumeId: string, after?: string, send?: typeof fetch) {
  return request<DriveFileLinkPage>(url(location, `/${encodeURIComponent(volumeId)}/shares`, { after }), {}, send)
}

export function readOwnDriveFileLink(location: DriveLocation, volumeId: string, path: string, send?: typeof fetch) {
  return request<{ link: DriveFileLinkDetails | null }>(url(location, `/${encodeURIComponent(volumeId)}/shares`, { path }), {}, send)
}

export function createDriveFileLink(location: DriveLocation, volumeId: string, path: string, send?: typeof fetch) {
  return request<{ link: DriveFileLinkDetails }>(url(location, `/${encodeURIComponent(volumeId)}/shares`),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }, send)
}

export function updateDriveFileLink(location: DriveLocation, volumeId: string, linkId: string, visibility: DriveFileLinkVisibility, send?: typeof fetch) {
  return request<{ link: DriveFileLinkDetails }>(driveFileLinkUrl(location, volumeId, linkId),
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visibility }) }, send)
}

export function revokeDriveFileLink(location: DriveLocation, volumeId: string, linkId: string, send?: typeof fetch) {
  return request<{ revoked: true }>(driveFileLinkUrl(location, volumeId, linkId), { method: 'DELETE' }, send)
}

function organizationShareUrl(organizationId: string, shareId: string) {
  return withBasePath(`/api/organizations/${encodeURIComponent(organizationId)}/drive-shares/${encodeURIComponent(shareId)}`)
}

function organizationVolumeShares(organizationId: string, volumeId: string) {
  return withBasePath(`/api/organizations/${encodeURIComponent(organizationId)}/drive/${encodeURIComponent(volumeId)}/shares`)
}

export function readOrganizationVolumeFileLinks(organizationId: string, volumeId: string, send?: typeof fetch) {
  return request<DriveFileLinkDetails[]>(organizationVolumeShares(organizationId, volumeId), {}, send)
}

export function createOrganizationVolumeFileLink(organizationId: string, volumeId: string, path: string, send?: typeof fetch) {
  return request<DriveFileLinkDetails>(organizationVolumeShares(organizationId, volumeId), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
  }, send)
}

export function updateOrganizationDriveFileLink(organizationId: string, shareId: string, visibility: DriveFileLinkVisibility, send?: typeof fetch) {
  return request<DriveFileLinkDetails>(organizationShareUrl(organizationId, shareId),
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visibility }) }, send)
}

export function revokeOrganizationDriveFileLink(organizationId: string, shareId: string, send?: typeof fetch) {
  return request<void>(organizationShareUrl(organizationId, shareId), { method: 'DELETE' }, send, true)
}

export function readDriveSkills(location: DriveLocation, after?: DriveSkillCursor, send?: typeof fetch) {
  return request<DriveSkillPage>(url(location, '', { view: 'skills', afterVolume: after?.volumeId, afterPath: after?.path }), {}, send)
}

function organizationFilesUrl(organizationId: string, resource: 'drive' | 'drive-scopes' | 'drive-skills', filters: Record<string, string | number | boolean | undefined>) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && (key !== 'exactScope' || value)) query.set(key, String(value))
  }
  const target = `/api/organizations/${encodeURIComponent(organizationId)}/${resource}`
  return withBasePath(query.size ? target + '?' + query : target)
}

export function readOrganizationDriveScopes(organizationId: string, filters: { projectId?: string; automationId?: string; page?: number } = {}, send?: typeof fetch) {
  return request<OrganizationDriveScopePage>(organizationFilesUrl(organizationId, 'drive-scopes', filters), {}, send)
}

export function readOrganizationDriveVolumes(organizationId: string, filters: {
  projectId?: string; userId?: string; automationId?: string; captainJamId?: string; exactScope?: boolean; archived?: boolean
} = {}, send?: typeof fetch) {
  return request<OrganizationDriveVolume[]>(organizationFilesUrl(organizationId, 'drive', filters), {}, send)
}

export function readOrganizationDriveSkills(organizationId: string, filters: { projectId?: string } = {}, send?: typeof fetch) {
  return request<{ name: string; description: string }[]>(organizationFilesUrl(organizationId, 'drive-skills', filters), {}, send)
}

export function readDriveVolumes(location: DriveLocation, before?: string, send?: typeof fetch) {
  return request<DriveVolumePage>(url(location, '', { before }), {}, send)
}

export function readArchivedDriveVolumes(location: DriveLocation, before?: string, send?: typeof fetch) {
  return request<DriveVolumePage>(url(location, '', { archived: 'true', before }), {}, send)
}

export function setOrganizationDriveArchived(organizationId: string, volumeId: string, archived: boolean, send?: typeof fetch) {
  const operation = archived ? 'archive' : 'unarchive'
  const target = withBasePath(`/api/organizations/${encodeURIComponent(organizationId)}/drive/${encodeURIComponent(volumeId)}/${operation}`)
  return request<OrganizationDriveVolume>(target, { method: 'POST' }, send)
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

function organizationVersionsUrl(organizationId: string, volumeId: string) {
  return withBasePath(`/api/organizations/${encodeURIComponent(organizationId)}/drive/${encodeURIComponent(volumeId)}/versions`)
}

export function restoreOrganizationDriveVersion(organizationId: string, volumeId: string, versionId: string, expectedDigest: string, send?: typeof fetch) {
  const target = withBasePath(`/api/organizations/${encodeURIComponent(organizationId)}/drive/${encodeURIComponent(volumeId)}/restore`)
  return request<OrganizationDriveManifest>(target, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ versionId, expectedDigest }) }, send)
}

export function readOrganizationDriveVersions(organizationId: string, volumeId: string, send?: typeof fetch) {
  return request<OrganizationDriveVersion[]>(organizationVersionsUrl(organizationId, volumeId), {}, send)
}

export function readOrganizationDriveManifest(organizationId: string, volumeId: string, versionId: string, send?: typeof fetch) {
  return request<OrganizationDriveManifest>(`${organizationVersionsUrl(organizationId, volumeId)}/${encodeURIComponent(versionId)}`, {}, send)
}

export function readOrganizationDriveFileHistory(organizationId: string, volumeId: string, path: string, send?: typeof fetch) {
  const target = `/api/organizations/${encodeURIComponent(organizationId)}/drive/${encodeURIComponent(volumeId)}/file-versions`
  return request<DriveFileVersion[]>(withBasePath(`${target}?${new URLSearchParams({ path })}`), {}, send)
}

export function readOrganizationDriveVersionFile(organizationId: string, volumeId: string, versionId: string, sha256: string, send?: typeof fetch) {
  return request<DriveShareView['file']>(organizationDriveVersionFileUrl(organizationId, volumeId, versionId, sha256), {}, send)
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
