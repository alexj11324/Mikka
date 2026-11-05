'use client'

import { useTranslations } from 'next-intl'
import { ArrowUpRight, SlidersHorizontal } from 'lucide-react'
import { Select, SelectContent, SelectGroup, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { HarnessLabel } from '@/components/labels/entity-labels'
import { InlineLoadError } from '@/components/load-error'
import { withBasePath } from '@/lib/base-path'
import { settingsHref } from '@/lib/settings-sections'
import { profileAvailabilityKey, type AgentProfilesView } from '@/components/settings/factory-profiles-data'

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
  const selected = profiles.find(profile => profile.id === value)
  const manage = () => { if (workspaceId) window.open(withBasePath(settingsHref('models', workspaceId) + '#factory-profiles-heading'), '_blank', 'noopener,noreferrer') }
  return <Select value={value ?? 'auto'} onValueChange={id => { if (id === MANAGE) manage(); else if (id) onChange(id === 'auto' ? null : id) }}
    items={[{ value: 'auto', label: t('automaticShort') }, ...profiles.map(profile => ({ value: profile.id, label: profile.name })),
      ...(value && !selected ? [{ value, label: t('selectionUnavailable') }] : []), { value: MANAGE, label: t('manage') }]} disabled={disabled || !workspaceId}>
    <SelectTrigger size="sm" className="h-7 min-w-28 max-w-56 gap-1.5 rounded-full px-2.5" aria-label={t('taskProfile')}><SlidersHorizontal aria-hidden="true" /><SelectValue className="min-w-0 truncate" /></SelectTrigger>
    <SelectContent align="start" alignItemWithTrigger={false} className="w-auto min-w-64 max-w-[calc(100vw-3rem)]">
      <SelectGroup>
        <SelectItem value="auto">{t('automatic')}</SelectItem>
        {profiles.map(profile => {
          const available = data?.availability[profile.id]
          return <SelectItem key={profile.id} value={profile.id} disabled={!available?.available}>
            <span className="flex min-w-0 flex-col gap-0.5 py-1">
              <span className="truncate">{profile.name}</span>
              <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                {profile.harness !== 'auto' && <HarnessLabel harness={profile.harness} />}
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

/** Why the chosen Agent 配置 cannot run, or that the list did not load; shown under the dialog's header row. */
export function TaskProfileNotice({ value, data, error, onRetry }: { value: string | null; data?: AgentProfilesView; error?: unknown; onRetry: () => void }) {
  const t = useTranslations('Settings.agentProfiles')
  const common = useTranslations('Common')
  const selected = data?.profiles.find(profile => profile.id === value)
  const unavailable = value && (!selected || !data?.availability[value]?.available)
  if (error) return <InlineLoadError message={t('loadFailed')} retryLabel={common('retry')} onRetry={onRetry} />
  if (unavailable) return <p role="alert" className="text-sm text-destructive-foreground">{t(`reasons.${profileAvailabilityKey(data?.availability[value]?.reason)}`)}</p>
  return null
}
