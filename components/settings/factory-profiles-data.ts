'use client'

import useSWR from 'swr'
import { withBasePath } from '@/lib/base-path'
import { BUILTIN_AGENT_PROFILE_ID } from '@/lib/factory/agent-profile-reference'
import type { AgentProfile, AgentProfileDefinition } from '@/lib/factory/agent-profile-definition'

export type ProfileModel = Extract<AgentProfileDefinition['model'], { mode: 'fixed' }> & {
  provider: string
  sourceLabel?: string
  sourceOrdinal?: number
  available: boolean
  reason?: string
}
export type ProfileAvailability = { available: boolean; reason?: string }
export type ProfileSkillSource = 'official' | 'personal' | 'workspace' | 'repository'
export type ProfileSkillView = {
  id: string; name: string; description: string; version: number; digest: string
  source: ProfileSkillSource; available: boolean; reason?: 'disabled' | 'missing' | 'forbidden' | 'invalid'; shareable?: boolean; shared?: boolean
}
export type AgentProfilesView = {
  profiles: AgentProfile[]
  catalog: {
    models: Omit<ProfileModel, 'mode'>[]
    skills: ProfileSkillView[]
  }
  availability: Record<string, ProfileAvailability>
  defaultAvailability?: ProfileAvailability
}

/** A pending allowance check may be requested; only dispatch grants execution.
 * A missing read or a disabled/archived role never becomes selectable this way. */
export function taskProfileSelectable(value: string | null | undefined, data?: AgentProfilesView): boolean {
  if (!value) return true
  if (!data) return false
  const builtin = value === BUILTIN_AGENT_PROFILE_ID
  const profile = builtin ? undefined : data.profiles.find(item => item.id === value)
  if (!builtin && (!profile?.enabled || profile.archivedAt)) return false
  const availability = builtin ? data.defaultAvailability : data.availability[value]
  return availability?.available === true || availability?.reason === 'checking'
}

export const agentProfilesKey = (workspaceId: string) => ['factory-agent-profiles', workspaceId] as const

export class ProfileRequestError extends Error {
  constructor(readonly code: string) { super(code) }
}

type ProfilePreview = { location?: 'local' | 'cloud'; deviceId?: string }

export async function profileRequest<T>(workspaceId: string, method = 'GET', id?: string, body?: object, preview?: ProfilePreview): Promise<T> {
  const query = new URLSearchParams({ workspaceId })
  if (preview?.location) query.set('location', preview.location)
  if (preview?.deviceId) query.set('deviceId', preview.deviceId)
  const response = await fetch(withBasePath('/api/factory/agent-profiles' + (id ? '/' + encodeURIComponent(id) : '') + '?' + query.toString()), {
    method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, workspaceId }) } : {}),
  })
  if (!response.ok) {
    const result = await response.json().catch(() => null) as { error?: string } | null
    throw new ProfileRequestError(result?.error ?? 'agentProfileUnavailable')
  }
  return response.json() as Promise<T>
}

export function useAgentProfiles(workspaceId?: string, enabled = true, preview?: ProfilePreview) {
  const key = workspaceId ? preview?.location || preview?.deviceId ? [...agentProfilesKey(workspaceId), preview.location ?? null, preview.deviceId ?? null] : agentProfilesKey(workspaceId) : null
  return useSWR(enabled ? key : null,
    () => profileRequest<AgentProfilesView>(workspaceId!, 'GET', undefined, undefined, preview), {
      keepPreviousData: false, shouldRetryOnError: false,
    })
}

export function profileDefinition(profile: AgentProfile): AgentProfileDefinition {
  return { name: profile.name, description: profile.description, roles: [...profile.roles], enabled: profile.enabled,
    harness: profile.harness, model: profile.model, ...(profile.effort ? { effort: profile.effort } : {}),
    instructions: profile.instructions, skills: [...profile.skills] }
}

export function profileModelKey(model: Pick<ProfileModel, 'harness' | 'model' | 'source'>) {
  return [model.harness, model.model, model.source.kind, model.source.kind === 'subscription' ? model.source.connectionId : model.source.keyId].join(':')
}

/** Server reason codes only. Never render an unknown server error as screen copy. */
export function profileAvailabilityKey(reason?: string) {
  switch (reason) {
    case 'disabled': case 'archived': case 'pinConflict': case 'skillsChanged':
    case 'skillMissing': case 'skillDisabled': case 'skillForbidden':
    case 'noModels': case 'cloudNotConfigured': case 'cloudModelsUnknown':
    case 'cloudModelNotReported': case 'noDevice': case 'checking': case 'quota':
    case 'expired': case 'paused': case 'missing': case 'keyRefused': case 'balance':
    case 'providerUnavailable': return reason
    default: return 'unavailable'
  }
}

/** Explicitly share one of the owner's installed Skills to the current team
 * workspace. The server rechecks ownership, membership and organization policy. */
export async function shareWorkspaceSkill(workspaceId: string, skillId: string, shared: boolean) {
  const response = await fetch(withBasePath('/api/skills/share'), {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ workspaceId, skillId, shared }),
  })
  if (!response.ok) {
    const result = await response.json().catch(() => null) as { error?: string } | null
    throw new ProfileRequestError(result?.error ?? 'agentProfileUnavailable')
  }
  return response.json() as Promise<unknown>
}
