'use client'

import { useTranslations } from 'next-intl'
import { ArrowUpRight, SlidersHorizontal } from '@/components/icons'
import { ProfileMark } from '@/components/labels/profile-mark'
import { resolveProfileMark } from '@/lib/factory/agent-profile-mark'
import { Select, SelectContent, SelectGroup, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { InlineLoadError } from '@/components/load-error'
import { withBasePath } from '@/lib/base-path'
import { settingsHref } from '@/lib/settings-sections'
import { BUILTIN_AGENT_PROFILE_ID } from '@/lib/factory/agent-profile-reference'
import { profileAvailabilityKey, taskProfileSelectable, type AgentProfilesView } from '@/components/settings/factory-profiles-data'

const MANAGE = '__manage'
/** A draft saved with the retired Default choice reads as no Agent 配置. */
const profileChoice = (value: string | null) => value === BUILTIN_AGENT_PROFILE_ID ? null : value

/**
 * The task's Agent 配置 as a chip in the new-task dialog's header row, drawn like the machine and Bot pickers there
 * (R-90). 管理 is the menu's last item and opens Settings in a new tab, so the draft in the dialog stays.
 * An Agent 配置 is content only and is never chosen automatically: no choice means none.
 */
export function TaskProfilePicker({ workspaceId, value: stored, onChange, data, disabled }: {
  workspaceId?: string; value: string | null; onChange: (id: string | null) => void
  data?: AgentProfilesView; disabled?: boolean
}) {
  const value = profileChoice(stored)
  const t = useTranslations('Settings.agentProfiles')
  const profiles = data?.profiles ?? []
  const selected = profiles.find(profile => profile.id === value)
  const manage = () => { if (workspaceId) window.open(withBasePath(settingsHref('models', workspaceId) + '#factory-profiles-heading'), '_blank', 'noopener,noreferrer') }
  return <Select value={value ?? 'auto'} onValueChange={id => { if (id === MANAGE) manage(); else if (id) onChange(id === 'auto' ? null : id) }}
    items={[{ value: 'auto', label: t('taskProfile') }, ...profiles.map(profile => ({ value: profile.id, label: profile.name })),
      ...(value && !selected ? [{ value, label: t('selectionUnavailable') }] : []), { value: MANAGE, label: t('manage') }]} disabled={disabled || !workspaceId}>
    <SelectTrigger size="sm" className="h-7 min-w-28 max-w-56 gap-1.5 rounded-full px-2.5" aria-label={t('taskProfile')}>
      {/* The chosen Profile's own mark; none and an unavailable choice keep the generic one. */}
      {selected ? <ProfileMark {...resolveProfileMark(selected, selected)} /> : <SlidersHorizontal aria-hidden="true" />}
      <SelectValue className="min-w-0 truncate" />
    </SelectTrigger>
    <SelectContent align="start" alignItemWithTrigger={false} className="w-auto min-w-64 max-w-[calc(100vw-3rem)]">
      <SelectGroup>
        <SelectItem value="auto">{t('none')}</SelectItem>
        {profiles.map(profile => {
          const available = data?.availability[profile.id]
          return <SelectItem key={profile.id} value={profile.id} disabled={!taskProfileSelectable(profile.id, data)}>
            <span className="mt-1.5 flex self-start"><ProfileMark {...resolveProfileMark(profile, profile)} /></span>
            <span className="flex min-w-0 flex-col gap-0.5 py-1">
              <span className="truncate">{profile.name}</span>
              {(!available?.available || profile.description) && <span className="line-clamp-2 text-xs text-muted-foreground">
                {!available?.available ? t(`reasons.${profileAvailabilityKey(available?.reason)}`) : profile.description}
              </span>}
            </span>
          </SelectItem>
        })}
      </SelectGroup>
      {workspaceId && <><SelectSeparator /><SelectGroup><SelectItem value={MANAGE}><ArrowUpRight aria-hidden="true" />{t('manage')}<span className="sr-only">{t('newTab')}</span></SelectItem></SelectGroup></>}
    </SelectContent>
  </Select>
}

/** Pending checks, refused choices and read errors under the dialog's header row. */
export function TaskProfileNotice({ value: stored, data, error, onRetry }: { value: string | null; data?: AgentProfilesView; error?: unknown; onRetry: () => void }) {
  const value = profileChoice(stored)
  const t = useTranslations('Settings.agentProfiles')
  const common = useTranslations('Common')
  const selected = data?.profiles.find(profile => profile.id === value)
  const availability = selected && data?.availability[selected.id]
  const reason = selected?.archivedAt ? 'archived' : selected?.enabled === false ? 'disabled' : availability?.reason
  const unavailable = value && !taskProfileSelectable(value, data)
  if (error) return <InlineLoadError message={t('loadFailed')} retryLabel={common('retry')} onRetry={onRetry} />
  if (unavailable) return <p role="alert" className="text-sm text-destructive-foreground">{t(`reasons.${profileAvailabilityKey(reason)}`)}</p>
  if (value && !availability?.available && reason === 'checking') return <p role="status" className="text-sm text-muted-foreground">{t('reasons.checking')}</p>
  return null
}

/**
 * The same choices as TaskProfilePicker's menu, as data, for a UI layer's new-task window (the new-task slot):
 * none, each profile with its description or why it cannot run, and 管理.
 */
export function useTaskProfileChoices({ workspaceId, value: stored, data }: { workspaceId?: string; value: string | null; data?: AgentProfilesView }) {
  const value = profileChoice(stored)
  const t = useTranslations('Settings.agentProfiles')
  const profiles = data?.profiles ?? []
  const selected = profiles.find(profile => profile.id === value)
  const reason = (key?: string) => t(`reasons.${profileAvailabilityKey(key)}`)
  const choices = [
    { value: 'auto', label: t('none') },
    ...profiles.map(profile => {
      const available = data?.availability[profile.id]
      const detail = !available?.available ? reason(available?.reason) : profile.description
      return { value: profile.id, label: profile.name, icon: <ProfileMark {...resolveProfileMark(profile, profile)} />, detail: detail || undefined, disabled: !taskProfileSelectable(profile.id, data) }
    }),
  ]
  const label = !value ? t('taskProfile') : selected?.name ?? t('selectionUnavailable')
  const icon = selected ? <ProfileMark {...resolveProfileMark(selected, selected)} /> : undefined
  const onManage = workspaceId ? () => { window.open(withBasePath(settingsHref('models', workspaceId) + '#factory-profiles-heading'), '_blank', 'noopener,noreferrer') } : undefined
  return { choices, label, icon, onManage }
}
