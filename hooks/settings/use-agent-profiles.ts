'use client'

import { useRef, useState } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import { toast } from 'sonner'
import type { AgentProfile, AgentProfileDefinition } from '@/lib/factory/agent-profile-definition'
import { agentProfileTemplateDefinition, type AgentProfileTemplateId } from '@/lib/factory/agent-profile-templates'
import { deriveProfileMark, resolveProfileMark, type ProfileMarkValue } from '@/lib/factory/agent-profile-mark'
import { profileDefinition, profileRequest, ProfileRequestError, useAgentProfiles } from '@/components/settings/factory-profiles-data'

export type ProfileEditor = { profile?: AgentProfile; duplicate?: boolean; template?: AgentProfileTemplateId }
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
    case 'skillNotFound': return 'profileMissing'
    case 'authRequired': case 'agentProfileScopeNotFound': case 'originMismatch': case 'workspaceAccessDenied': return 'accessChanged'
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
export function useAgentProfileEditor({ workspaceId, editor, onSaved }: { workspaceId: string; editor: ProfileEditor; onSaved: () => void }) {
  const t = useTranslations('Settings.agentProfiles')
  const original = editor.duplicate ? undefined : editor.profile
  const [draft, setDraft] = useState<AgentProfileDefinition>(() => editor.profile
    ? { ...profileDefinition(editor.profile), ...(editor.duplicate ? { name: t('copyName', { name: editor.profile.name }).slice(0, 80) } : {}) }
    : editor.template
      ? agentProfileTemplateDefinition(editor.template, { name: t(`templates.${editor.template}.name`), description: t(`templates.${editor.template}.description`) })
      : { ...initialDefinition })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ProfileFailure | null>(null)
  // Only what the person picked is sent; the rest stays stored (edit) or is derived from the roles (add).
  const [chosenMark, setChosenMark] = useState<Partial<ProfileMarkValue>>({})
  const requestId = useRef<string | null>(null)
  const attempt = useRef<{ profile: AgentProfileDefinition; mark?: Partial<ProfileMarkValue> } | null>(null)
  const frozen = error === 'saveUnconfirmed'
  function change(patch: Partial<AgentProfileDefinition>) { setDraft(current => ({ ...current, ...patch })); setError(null) }
  const derived = deriveProfileMark({ name: draft.name, roles: [], description: draft.description })
  const stored = original ? resolveProfileMark(original, original) : derived
  const mark: ProfileMarkValue = { icon: chosenMark.icon ?? stored.icon, color: chosenMark.color ?? stored.color }
  function changeMark(patch: Partial<ProfileMarkValue>) { setChosenMark(current => ({ ...current, ...patch })); setError(null) }

  async function save() {
    if (pending) return
    if (!draft.name.trim()) { setError('invalid'); return }
    // An Agent 配置 is content only: the model and machine come from the task.
    const { effort: _effort, ...content } = draft
    const sent = frozen && attempt.current ? attempt.current : {
      profile: {
        ...content, name: draft.name.trim(), description: draft.description.trim(), roles: [], harness: 'auto', model: { mode: 'inherit' },
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

  return { original, draft, change, mark, changeMark, frozen, pending, error, setError, save }
}
