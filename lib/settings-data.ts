import { getTranslations } from 'next-intl/server'
import type { listTeamMembers, loadTeamDirectory } from '@/app/actions/teams'

export const settingsReadOptions = { revalidateIfStale: false, shouldRetryOnError: false } as const
export const memberSettingsKey = (workspaceId?: string) => workspaceId ? `/api/workspace?workspace=${encodeURIComponent(workspaceId)}` : '/api/workspace'
export const teamDirectoryKey = (workspaceId?: string) => ['team-directory', workspaceId ?? null] as const
export const teamMembersKey = (teamId: string) => ['team-members', teamId] as const
export const fetchTeamMembers = ([, teamId]: ReturnType<typeof teamMembersKey>) => fetchSettingsData<Awaited<ReturnType<typeof listTeamMembers>>>(`/api/teams/${encodeURIComponent(teamId)}/members`)
export const fetchTeamDirectory = ([, workspaceId]: ReturnType<typeof teamDirectoryKey>) => fetchSettingsData<Awaited<ReturnType<typeof loadTeamDirectory>>>(`/api/teams/directory${workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ''}`)

export class SettingsReadError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'SettingsReadError' }
}

export async function fetchSettingsData<T>(url: string): Promise<T> {
  const i18nText = await getTranslations();
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new SettingsReadError(body?.error ?? i18nText("FeatureCopy.c_af7a3f0c"), response.status)
  }
  return response.json()
}

export function isSettingsAccessError(error: unknown) {
  return error instanceof SettingsReadError && (error.status === 401 || error.status === 403)
}
