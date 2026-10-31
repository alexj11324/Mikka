'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { updatePreferences, type getPreferences } from '@/app/actions/preferences'
import { settingsRead } from '@/lib/settings-read'
import type { Preferences } from '@/lib/preferences'
import { FieldError } from '@/components/ui/field'

type Flags = Pick<Preferences, 'proactive' | 'pushDecide' | 'pushReview' | 'pushFinished' | 'pushBriefing' | 'pushWhen'>

/** D16: the notification settings the phone already has, on the web Settings page. */
export function NotificationSettings() {
  const t = useTranslations('Settings.notifications')
  const { data, error, mutate } = useSWR('preferences', () => settingsRead<Awaited<ReturnType<typeof getPreferences>>>('preferences'))
  // The change that did not save, kept so 重试 sends exactly it again.
  const [failed, setFailed] = useState<Partial<Flags> | null>(null)

  async function set(patch: Partial<Flags>) {
    if (!data) return
    setFailed(null)
    try {
      await mutate(async current => {
        const result = await updatePreferences(patch)
        // A refused save comes back as { error }, not as a throw. Throwing rolls the switch back.
        if (result.error) throw new Error(result.error)
        return { ...(current ?? data), ...result }
      }, { optimisticData: { ...data, ...patch }, rollbackOnError: true, revalidate: false })
    } catch {
      setFailed(patch)
    }
  }

  if (error) return <FieldError className="text-xs">{t('loadError')}</FieldError>
  if (!data) return <SettingsLoading label={t('loading')} rows={6} />

  const switches: { key: Exclude<keyof Flags, 'pushWhen'>; title: string }[] = [
    { key: 'proactive', title: t('proactive') },
    { key: 'pushDecide', title: t('pushDecide') },
    { key: 'pushReview', title: t('pushReview') },
    { key: 'pushFinished', title: t('pushFinished') },
    { key: 'pushBriefing', title: t('pushBriefing') },
  ]

  return <div className="flex flex-col gap-6">
    <SettingsSection title={t('heading')}>
      {switches.map(({ key, title }) => <SettingRow key={key} title={title}>
        <Switch checked={data[key]} aria-label={title} onCheckedChange={checked => { void set({ [key]: checked }) }} />
      </SettingRow>)}
      <SettingRow title={t('pushWhen')}>
        <ToggleGroup aria-label={t('pushWhen')} variant="outline" spacing={0} value={[data.pushWhen]} onValueChange={values => {
          const next = values[0]
          if (next === 'always' || next === 'away') void set({ pushWhen: next })
        }}>
          <ToggleGroupItem value="always" aria-label={t('always')}>{t('always')}</ToggleGroupItem>
          <ToggleGroupItem value="away" aria-label={t('away')}>{t('away')}</ToggleGroupItem>
        </ToggleGroup>
      </SettingRow>
    </SettingsSection>
    {failed && <SettingsSaveError message={t('notSaved')} retryLabel={t('retry')} onRetry={() => { void set(failed) }} />}
  </div>
}
