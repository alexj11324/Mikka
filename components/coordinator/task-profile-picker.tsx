'use client'

import { useTranslations } from 'next-intl'
import { ArrowUpRight, SlidersHorizontal } from 'lucide-react'
import { ProfileAgentMark, ProfileMark } from '@/components/labels/profile-mark'
import { DEFAULT_PROFILE_MARK, resolveProfileMark } from '@/lib/factory/agent-profile-mark'
import { Select, SelectContent, SelectGroup, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { harnessName } from '@/components/labels/entity-labels'
import { InlineLoadError } from '@/components/load-error'
import { withBasePath } from '@/lib/base-path'
import { settingsHref } from '@/lib/settings-sections'
import { BUILTIN_AGENT_PROFILE_ID } from '@/lib/factory/agent-profile-reference'
import { profileAvailabilityKey, taskProfileSelectable, type AgentProfilesView } from '@/components/settings/factory-profiles-data'

const MANAGE = '__manage'

/**
 * The task's Agent 配置 as a chip in the new-task dialog's header row, drawn like the machine and Bot pickers there
 * (R-90). 管理 is the menu's last item and opens Settings in a new tab, so the draft in the dialog stays.
 */
export function TaskProfilePicker({ workspaceId, value, onChange, data, disabled }: {
  workspaceId?: string; value: string | null; onChange: (id: string | null) => void
  data?: AgentProfilesView; disabled?: boolean
}) {
  const t = useTranslations('Settings.agentProfiles')
  const profiles = data?.profiles ?? []
  const builtin = value === BUILTIN_AGENT_PROFILE_ID
  const selected = profiles.find(profile => profile.id === value)
  const manage = () => { if (workspaceId) window.open(withBasePath(settingsHref('models', workspaceId) + '#factory-profiles-heading'), '_blank', 'noopener,noreferrer') }
  return <Select value={value ?? 'auto'} onValueChange={id => { if (id === MANAGE) manage(); else if (id) onChange(id === 'auto' ? null : id) }}
    items={[{ value: 'auto', label: t('automaticShort') }, { value: BUILTIN_AGENT_PROFILE_ID, label: t('defaultName') }, ...profiles.map(profile => ({ value: profile.id, label: profile.name })),
      ...(value && !builtin && !selected ? [{ value, label: t('selectionUnavailable') }] : []), { value: MANAGE, label: t('manage') }]} disabled={disabled || !workspaceId}>
    <SelectTrigger size="sm" className="h-7 min-w-28 max-w-56 gap-1.5 rounded-full px-2.5" aria-label={t('taskProfile')}>
      {/* The chosen Profile's own mark; 自动 and an unavailable choice keep the generic one. */}
      {builtin ? <ProfileMark {...DEFAULT_PROFILE_MARK} /> : selected ? <ProfileMark {...resolveProfileMark(selected, selected)} /> : <SlidersHorizontal aria-hidden="true" />}
      <SelectValue className="min-w-0 truncate" />
    </SelectTrigger>
    <SelectContent align="start" alignItemWithTrigger={false} className="w-auto min-w-64 max-w-[calc(100vw-3rem)]">
      <SelectGroup>
        <SelectItem value="auto">{t('automatic')}</SelectItem>
        <SelectItem value={BUILTIN_AGENT_PROFILE_ID} disabled={!taskProfileSelectable(BUILTIN_AGENT_PROFILE_ID, data)}>
          <span className="mt-1.5 flex self-start"><ProfileMark {...DEFAULT_PROFILE_MARK} /></span>
          <span className="flex min-w-0 flex-col gap-0.5 py-1">
            <span className="truncate">{t('defaultName')}</span>
            <span className="text-xs text-muted-foreground">{data?.defaultAvailability?.available ? t('inherit') : t(`reasons.${profileAvailabilityKey(data?.defaultAvailability?.reason)}`)}</span>
          </span>
        </SelectItem>
        {profiles.map(profile => {
          const available = data?.availability[profile.id]
          return <SelectItem key={profile.id} value={profile.id} disabled={!taskProfileSelectable(profile.id, data)}>
            <span className="mt-1.5 flex self-start"><ProfileMark {...resolveProfileMark(profile, profile)} /></span>
            <span className="flex min-w-0 flex-col gap-0.5 py-1">
              <span className="flex min-w-0 items-center gap-1.5"><span className="truncate">{profile.name}</span>{profile.harness !== 'auto' && <ProfileAgentMark harness={profile.harness} />}</span>
              <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                {!available?.available ? t(`reasons.${profileAvailabilityKey(available?.reason)}`) : profile.roles.join(' · ')}
              </span>
            </span>
          </SelectItem>
        })}
      </SelectGroup>
      {workspaceId && <><SelectSeparator /><SelectGroup><SelectItem value={MANAGE}><ArrowUpRight aria-hidden="true" />{t('manage')}<span className="sr-only">{t('newTab')}</span></SelectItem></SelectGroup></>}
    </SelectContent>
  </Select>
}

/** Pending checks, refused choices and read errors under the dialog's header row. */
export function TaskProfileNotice({ value, data, error, onRetry }: { value: string | null; data?: AgentProfilesView; error?: unknown; onRetry: () => void }) {
  const t = useTranslations('Settings.agentProfiles')
  const common = useTranslations('Common')
  const selected = data?.profiles.find(profile => profile.id === value)
  const availability = value === BUILTIN_AGENT_PROFILE_ID ? data?.defaultAvailability : selected && data?.availability[selected.id]
  const reason = selected?.archivedAt ? 'archived' : selected?.enabled === false ? 'disabled' : availability?.reason
  const unavailable = value && !taskProfileSelectable(value, data)
  if (error) return <InlineLoadError message={t('loadFailed')} retryLabel={common('retry')} onRetry={onRetry} />
  if (unavailable) return <p role="alert" className="text-sm text-destructive-foreground">{t(`reasons.${profileAvailabilityKey(reason)}`)}</p>
  if (value && !availability?.available && reason === 'checking') return <p role="status" className="text-sm text-muted-foreground">{t('reasons.checking')}</p>
  return null
}

/**
 * The same choices as TaskProfilePicker's menu, as data, for a UI layer's new-task window (the new-task slot):
 * 自动, the default Agent, each profile with its Agent and roles or why it cannot run, and 管理.
 */
export function useTaskProfileChoices({ workspaceId, value, data }: { workspaceId?: string; value: string | null; data?: AgentProfilesView }) {
  const t = useTranslations('Settings.agentProfiles')
  const profiles = data?.profiles ?? []
  const builtin = value === BUILTIN_AGENT_PROFILE_ID
  const selected = profiles.find(profile => profile.id === value)
  const reason = (key?: string) => t(`reasons.${profileAvailabilityKey(key)}`)
  const choices = [
    { value: 'auto', label: t('automatic') },
    { value: BUILTIN_AGENT_PROFILE_ID, label: t('defaultName'), icon: <ProfileMark {...DEFAULT_PROFILE_MARK} />, detail: data?.defaultAvailability?.available ? t('inherit') : reason(data?.defaultAvailability?.reason), disabled: !taskProfileSelectable(BUILTIN_AGENT_PROFILE_ID, data) },
    ...profiles.map(profile => {
      const available = data?.availability[profile.id]
      const detail = [profile.harness !== 'auto' ? harnessName(profile.harness) : null, !available?.available ? reason(available?.reason) : profile.roles.join(' · ')].filter(Boolean).join(' · ')
      return { value: profile.id, label: profile.name, icon: <ProfileMark {...resolveProfileMark(profile, profile)} />, detail: detail || undefined, disabled: !taskProfileSelectable(profile.id, data) }
    }),
  ]
  const label = !value ? t('automaticShort') : builtin ? t('defaultName') : selected?.name ?? t('selectionUnavailable')
  const icon = builtin ? <ProfileMark {...DEFAULT_PROFILE_MARK} /> : selected ? <ProfileMark {...resolveProfileMark(selected, selected)} /> : undefined
  const onManage = workspaceId ? () => { window.open(withBasePath(settingsHref('models', workspaceId) + '#factory-profiles-heading'), '_blank', 'noopener,noreferrer') } : undefined
  return { choices, label, icon, onManage }
}
