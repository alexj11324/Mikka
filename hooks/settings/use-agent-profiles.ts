'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import type { AgentProfile, AgentProfileDefinition } from '@/lib/factory/agent-profile-definition'
import { deriveProfileMark, resolveProfileMark, type ProfileMarkValue } from '@/lib/factory/agent-profile-mark'
import { profileDefinition, profileModelKey, profileRequest, ProfileRequestError, useAgentProfiles, type AgentProfilesView } from '@/components/settings/factory-profiles-data'

export type ProfileEditor = { profile?: AgentProfile; duplicate?: boolean }
const initialDefinition: AgentProfileDefinition = { name: '', description: '', roles: [], enabled: true, harness: 'auto', model: { mode: 'inherit' }, instructions: '', skills: [] }

export type ProfileFailure = 'saveUnconfirmed' | 'versionConflict' | 'modelUnavailable' | 'skillUnavailable' | 'limitReached' | 'invalid' | 'profileMissing' | 'accessChanged' | 'saveFailed'

export function profileFailure(error: unknown): ProfileFailure {
  if (!(error instanceof ProfileRequestError)) return 'saveUnconfirmed'
  switch (error.code) {
    case 'agentProfileVersionConflict': case 'agentProfileRequestConflict': return 'versionConflict'
    case 'agentProfileModelUnavailable': return 'modelUnavailable'
    case 'agentProfileSkillUnavailable': return 'skillUnavailable'
    case 'agentProfileLimit': return 'limitReached'
    case 'agentProfileInvalid': case 'agentProfileTooLarge': return 'invalid'
    case 'agentProfileArchived': case 'agentProfileNotFound': return 'profileMissing'
    case 'authRequired': case 'agentProfileScopeNotFound': case 'originMismatch': return 'accessChanged'
    default: return 'saveFailed'
  }
}

/**
 * Agent 配置: the list, its 启用 switch and 归档. `onArchived` runs once an
 * archive is saved, so a confirmation can close. The open-source page and the
 * hosted layer draw it each in their own look (docs/ui-overlay.md).
 */
export function useAgentProfileList(workspaceId: string, onArchived?: () => void) {
  const t = useTranslations('Settings.agentProfiles')
  const list = useAgentProfiles(workspaceId)
  const [pending, setPending] = useState<string | null>(null)
  const [failure, setFailure] = useState<ProfileFailure | null>(null)
  // Only a toggle's result is announced; the rows' states are read in place, not as live regions.
  const [announce, setAnnounce] = useState('')
  const data = list.data

  async function update(profile: AgentProfile, archive = false) {
    setPending(profile.id); setFailure(null)
    try {
      await profileRequest(workspaceId, archive ? 'DELETE' : 'PATCH', profile.id,
        archive ? { version: profile.version } : { version: profile.version, profile: { ...profileDefinition(profile), enabled: !profile.enabled } })
      onArchived?.()
      if (!archive) setAnnounce(t(profile.enabled ? 'disabledNamed' : 'enabledNamed', { name: profile.name }))
      void list.mutate()
    } catch (error) {
      setFailure(profileFailure(error))
      void list.mutate()
    } finally { setPending(null) }
  }

  return { list, data, pending, failure, setFailure, announce, update }
}

/** One Agent 配置 being added, edited or duplicated: its draft and its save, with one request id per attempt. */
export function useAgentProfileEditor({ workspaceId, editor, catalog, onSaved }: { workspaceId: string; editor: ProfileEditor; catalog: AgentProfilesView['catalog']; onSaved: () => void }) {
  const t = useTranslations('Settings.agentProfiles')
  const original = editor.duplicate ? undefined : editor.profile
  const [draft, setDraft] = useState<AgentProfileDefinition>(() => editor.profile
    ? { ...profileDefinition(editor.profile), ...(editor.duplicate ? { name: t('copyName', { name: editor.profile.name }).slice(0, 80) } : {}) }
    : { ...initialDefinition })
  const [roles, setRoles] = useState(draft.roles.join(', '))
  const [modelMode, setModelMode] = useState(draft.model.mode)
  const [modelKey, setModelKey] = useState(draft.model.mode === 'fixed' ? profileModelKey(draft.model) : '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ProfileFailure | null>(null)
  // Only what the person picked is sent; the rest stays stored (edit) or is derived from the roles (add).
  const [chosenMark, setChosenMark] = useState<Partial<ProfileMarkValue>>({})
  const requestId = useRef<string | null>(null)
  const attempt = useRef<{ profile: AgentProfileDefinition; mark?: Partial<ProfileMarkValue> } | null>(null)
  const models = catalog.models.filter(model => draft.harness === 'auto' || model.harness === draft.harness)
  const selectedModel = models.find(model => profileModelKey(model) === modelKey)
  const frozen = error === 'saveUnconfirmed'
  function change(patch: Partial<AgentProfileDefinition>) { setDraft(current => ({ ...current, ...patch })); setError(null) }
  const roleList = () => [...new Set(roles.split(/[,，\n]/).map(role => role.trim()).filter(Boolean))]
  const derived = deriveProfileMark({ name: draft.name, roles: roleList(), description: draft.description })
  const stored = original ? resolveProfileMark(original, original) : derived
  const mark: ProfileMarkValue = { icon: chosenMark.icon ?? stored.icon, color: chosenMark.color ?? stored.color }
  function changeMark(patch: Partial<ProfileMarkValue>) { setChosenMark(current => ({ ...current, ...patch })); setError(null) }

  async function save() {
    if (pending) return
    const roleNames = roleList()
    if (!draft.name.trim() || roleNames.length > 12 || roleNames.some(role => role.length > 48) || (modelMode === 'fixed' && !selectedModel)) { setError('invalid'); return }
    const sent = frozen && attempt.current ? attempt.current : {
      profile: {
        ...draft, name: draft.name.trim(), description: draft.description.trim(), roles: roleNames,
        model: modelMode === 'fixed' && selectedModel ? { mode: 'fixed', harness: selectedModel.harness, model: selectedModel.model, source: selectedModel.source } : { mode: 'inherit' },
      } satisfies AgentProfileDefinition,
      ...(chosenMark.icon || chosenMark.color ? { mark: { ...chosenMark } } : {}),
    }
    attempt.current = sent
    requestId.current ??= crypto.randomUUID()
    setPending(true); setError(null)
    try {
      await profileRequest<{ profile: AgentProfile }>(workspaceId, original ? 'PATCH' : 'POST', original?.id,
        { ...sent, ...(original ? { version: original.version } : { requestId: requestId.current }) })
      toast.success(t('saved'))
      onSaved()
    } catch (failure) { setError(profileFailure(failure)) }
    finally { setPending(false) }
  }

  return { original, draft, change, mark, changeMark, roles, setRoles, modelMode, setModelMode, modelKey, setModelKey, models, selectedModel, frozen, pending, error, setError, save }
}
