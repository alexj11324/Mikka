'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import type { getExecutionFallbacks } from '@/app/actions/execution-settings'
import { ChoicePicker } from '@/components/settings/bot-agents-settings'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { FieldError } from '@/components/ui/field'
import { saveFallbacks, type WhenDeviceOffline, type WhenQuotaExhausted } from '@/lib/execution-settings-client'
import { settingsRead } from '@/lib/settings-read'

type Fallbacks = Awaited<ReturnType<typeof getExecutionFallbacks>>
export const EXECUTION_FALLBACKS_KEY = 'execution-fallbacks'
export const readExecutionFallbacks = () => settingsRead<Fallbacks>('execution-fallbacks')

/** 设备离线时 and 额度用完时: account settings, stored and used per person (decision 2026-10-31-2130). */
export function ExecutionFallbackSettings() {
  const t = useTranslations('Settings.botAgents')
  const fallbacks = useSWR(EXECUTION_FALLBACKS_KEY, readExecutionFallbacks)
  const [failed, setFailed] = useState<Fallbacks | null>(null)

  async function save(next: Fallbacks) {
    setFailed(null)
    try {
      await fallbacks.mutate(async () => { await saveFallbacks(next); return next }, { optimisticData: next, rollbackOnError: true, revalidate: false })
    } catch { setFailed(next) }
  }

  if (fallbacks.error) return <FieldError>{t('loadFailed')}</FieldError>
  if (!fallbacks.data) return <SettingsLoading label={t('loading')} rows={2} />
  const value = fallbacks.data
  const offline = { wait: t('offlineWait'), cloud: t('offlineCloud') } satisfies Record<WhenDeviceOffline, string>
  const quota = { stop: t('quotaStop'), switchAccount: t('quotaSwitch') } satisfies Record<WhenQuotaExhausted, string>
  return <>
    <SettingsSection id="execution-fallbacks-heading" title={t('fallbacks')}>
      <SettingRow title={t('whenDeviceOffline')}>
        <ChoicePicker ariaLabel={t('setting', { name: t('whenDeviceOffline'), value: offline[value.whenDeviceOffline] })} value={value.whenDeviceOffline} names={offline} onChange={whenDeviceOffline => void save({ ...value, whenDeviceOffline })} />
      </SettingRow>
      <SettingRow title={t('whenQuotaExhausted')}>
        <ChoicePicker ariaLabel={t('setting', { name: t('whenQuotaExhausted'), value: quota[value.whenQuotaExhausted] })} value={value.whenQuotaExhausted} names={quota} onChange={whenQuotaExhausted => void save({ ...value, whenQuotaExhausted })} />
      </SettingRow>
    </SettingsSection>
    {failed && <SettingsSaveError message={t('notSaved')} retryLabel={t('retry')} onRetry={() => void save(failed)} />}
  </>
}
