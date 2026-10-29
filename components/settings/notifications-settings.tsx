'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { getPreferences, updatePreferences } from '@/app/actions/preferences'
import type { Preferences } from '@/lib/preferences'

type Flags = Pick<Preferences, 'proactive' | 'pushDecide' | 'pushReview' | 'pushFinished' | 'pushBriefing' | 'pushWhen'>

/** D16: the notification settings the phone already has, now on the web Settings page. */
export function NotificationSettings() {
  const t = useTranslations('Settings.notifications')
  const { data, error, mutate } = useSWR('preferences', getPreferences)
  const [failed, setFailed] = useState(false)

  async function set(patch: Partial<Flags>) {
    if (!data) return
    setFailed(false)
    try {
      await mutate(async current => ({ ...(current ?? data), ...(await updatePreferences(patch) as Preferences) }), {
        optimisticData: { ...data, ...patch },
        rollbackOnError: true,
        revalidate: false,
      })
    } catch {
      setFailed(true)
    }
  }

  if (error) return <p role="alert" className="text-xs text-destructive">{t('loadError')}</p>
  if (!data) return null

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
      {failed && <p role="alert" className="text-xs text-destructive">{t('saveFailed')}</p>}
    </SettingsSection>
  </div>
}
