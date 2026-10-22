'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { createTelegramConnectLink, disconnectTelegram, getTelegramIntegrationStatus } from '@/app/actions/telegram'

type TelegramStatus = Awaited<ReturnType<typeof getTelegramIntegrationStatus>>

export function TelegramSettings({ preview = false }: { preview?: boolean }) {
  const t = useTranslations('Settings.telegram')
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [connectLink, setConnectLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<'error' | 'notConfigured' | ''>('')

  async function refresh() {
    setBusy(true)
    setError('')
    try {
      setStatus(await getTelegramIntegrationStatus())
      setConnectLink('')
    } catch {
      setError('error')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (preview) return
    let active = true
    setBusy(true)
    void getTelegramIntegrationStatus().then(value => {
      if (active) setStatus(value)
    }).catch(() => {
      if (active) setError('error')
    }).finally(() => {
      if (active) setBusy(false)
    })
    return () => { active = false }
  }, [preview])

  async function connect() {
    setBusy(true)
    setError('')
    try {
      const result = await createTelegramConnectLink()
      if ('error' in result) {
        setError('notConfigured')
      } else {
        setConnectLink(result.link)
      }
    } catch {
      setError('error')
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    if (!window.confirm(t('disconnectConfirm'))) return
    setBusy(true)
    setError('')
    try {
      await disconnectTelegram()
      setConnectLink('')
      await refresh()
    } catch {
      setError('error')
    } finally {
      setBusy(false)
    }
  }

  return <SettingsSection id="telegram-heading" title={t('heading')} description={t('description')}>
    {preview ? <SettingRow title={t('title')} description={t('previewDescription')} /> : <>
      <SettingRow title={t('title')} description={t('statusDescription')}>
        {status === null
          ? <span className="text-muted-foreground">{t('loading')}</span>
          : status.connected
            ? <span role="status" className="text-success-foreground">{t('connected')}{status.telegramUserName ? ' · @' + status.telegramUserName.replace(/^@/, '') : ''}</span>
            : <span role="status" className="text-muted-foreground">{t('notConnected')}</span>}
      </SettingRow>
      {connectLink && <SettingRow title={t('linkTitle')} description={t('linkDescription')}>
        <Button render={<a href={connectLink} target="_blank" rel="noreferrer" />}>{t('openTelegram')}</Button>
      </SettingRow>}
      {error && <p role="alert" className="px-5 py-3 text-sm text-destructive">{t(error)}</p>}
      <SettingRow title={status?.connected ? t('connected') : t('connectTitle')} description={status?.connected ? t('disconnectDescription') : t('connectDescription')}>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={busy || status === null || !status.configured || status.connected} onClick={() => void connect()}>
            {connectLink ? t('newLink') : t('connect')}
          </Button>
          {status?.connected
            ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void disconnect()}>{t('disconnect')}</Button>
            : <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}>{t('refresh')}</Button>}
        </div>
      </SettingRow>
      {status && !status.configured && <p role="status" className="px-5 py-3 text-xs text-muted-foreground">{t('notConfigured')}</p>}
    </>}
  </SettingsSection>
}
