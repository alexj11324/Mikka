'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { HarnessLabel } from '@/components/labels/entity-labels'
import { InlineLoadError } from '@/components/load-error'
import { settingsHref } from '@/lib/settings-sections'
import { profileAvailabilityKey, type AgentProfilesView } from '@/components/settings/factory-profiles-data'

export function TaskProfilePicker({ workspaceId, value, onChange, data, error, onRetry, disabled }: {
  workspaceId?: string; value: string | null; onChange: (id: string | null) => void
  data?: AgentProfilesView; error?: unknown; onRetry: () => void; disabled?: boolean
}) {
  const t = useTranslations('Settings.agentProfiles')
  const common = useTranslations('Common')
  const profiles = data?.profiles ?? []
  const selected = profiles.find(profile => profile.id === value)
  const unavailable = value && (!selected || !data?.availability[value]?.available)
  return <div className="flex min-w-0 flex-col gap-2">
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Select value={value ?? 'auto'} onValueChange={id => { if (id) onChange(id === 'auto' ? null : id) }}
        items={[{ value: 'auto', label: t('automatic') }, ...profiles.map(profile => ({ value: profile.id, label: profile.name })),
          ...(value && !selected ? [{ value, label: t('selectionUnavailable') }] : [])]} disabled={disabled || !workspaceId}>
        <SelectTrigger size="sm" className="min-w-0 max-w-full" aria-label={t('taskProfile')}><SlidersHorizontal aria-hidden="true" /><SelectValue className="min-w-0 truncate" /></SelectTrigger>
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
        </SelectContent>
      </Select>
      {workspaceId && <Button nativeButton={false} variant="ghost" size="sm" render={<Link href={settingsHref('models', workspaceId) + '#factory-profiles-heading'} />}>{t('manage')}</Button>}
    </div>
    {error ? <InlineLoadError message={t('loadFailed')} retryLabel={common('retry')} onRetry={onRetry} />
      : unavailable ? <p role="alert" className="text-sm text-destructive">{t(`reasons.${profileAvailabilityKey(data?.availability[value]?.reason)}`)}</p>
      : !data && <p role="status" className="text-xs text-muted-foreground">{t('loading')}</p>}
  </div>
}
