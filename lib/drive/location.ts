import { withBasePath } from '../base-path'

export type DriveLocation = string | { workspaceId: string; projectId: string; driveScope?: 'project' }
  | { workspaceId: string; driveScope: 'team-workspace'; projectId?: never }

export function driveVolumeUrl(location: DriveLocation, suffix = '', query: Record<string, string | undefined> = {}) {
  const params = new URLSearchParams(typeof location === 'string'
    ? { workspaceId: location }
    : { workspaceId: location.workspaceId, ...(location.projectId ? { projectId: location.projectId } : {}), ...(location.driveScope ? { driveScope: location.driveScope } : {}) })
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, value)
  return withBasePath(`/api/drive/volumes${suffix}?${params}`)
}

export function driveFileLinkUrl(location: DriveLocation, volumeId: string, linkId: string) {
  return driveVolumeUrl(location, `/${encodeURIComponent(volumeId)}/shares/${encodeURIComponent(linkId)}`)
}

export function driveShareViewUrl(shareId: string) {
  return withBasePath(`/api/drive/shares/${encodeURIComponent(shareId)}`)
}
