import { settingsKeys } from '@/lib/swr/keys'
import type { listTeamMembers, loadTeamDirectory } from '@/app/actions/teams'
import { withBasePath } from '@/lib/base-path'

export const settingsReadOptions = { revalidateIfStale: false, shouldRetryOnError: false } as const
export const memberSettingsKey = settingsKeys.memberSettings
export const teamDirectoryKey = settingsKeys.teamDirectory
export const teamMembersKey = settingsKeys.teamMembers
export const fetchTeamMembers = ([, teamId]: ReturnType<typeof teamMembersKey>) => fetchSettingsData<Awaited<ReturnType<typeof listTeamMembers>>>(`/api/teams/${encodeURIComponent(teamId)}/members`)
export const teamHomeKey = (userId: string, teamId: string) => ['team-home', userId, teamId] as const
export const fetchTeamHome = ([, , teamId]: ReturnType<typeof teamHomeKey>) => fetchSettingsData<Awaited<ReturnType<typeof listTeamMembers>>>(`/api/teams/${encodeURIComponent(teamId)}/members?include=task-count`)
export const fetchTeamDirectory = ([, workspaceId]: ReturnType<typeof teamDirectoryKey>) => fetchSettingsData<Awaited<ReturnType<typeof loadTeamDirectory>>>(`/api/teams/directory${workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ''}`)

export class SettingsReadError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'SettingsReadError' }
}

export async function fetchSettingsData<T>(url: string): Promise<T> {
  const requestedAt = performance.now()
  const response = await fetch(withBasePath(url), { cache: 'no-store' })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new SettingsReadError(body?.error ?? 'Failed to load settings data.', response.status)
  }
  const body = await response.json()
  // Workspace list expiry uses the actual request start. Arrays and unrelated
  // settings payloads retain their existing public shape.
  return body && typeof body === 'object' && !Array.isArray(body) && body.live
    ? { ...body, requestedAt } : body
}

export function isSettingsAccessError(error: unknown) {
  return error instanceof SettingsReadError && (error.status === 401 || error.status === 403)
}
