'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { createTelegramConnectLink, disconnectTelegram, getTelegramIntegrationStatus } from '@/app/actions/telegram'

type TelegramStatus = Awaited<ReturnType<typeof getTelegramIntegrationStatus>>

export function TelegramSettings() {
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
    let active = true
    setBusy(true)
    void getTelegramIntegrationStatus().then(value => {
      if (active) setStatus(value)
    }).catch(() => {
      if (active) setError('error')
    }).finally(() => {
      if (active) setBusy(false)
    })
    // Coming back from Telegram after Start re-reads the state.
    const onFocus = () => { void getTelegramIntegrationStatus().then(value => { if (active) setStatus(value) }).catch(() => {}) }
    window.addEventListener('focus', onFocus)
    return () => { active = false; window.removeEventListener('focus', onFocus) }
  }, [])

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

  return <SettingsSection id="telegram-heading">
    <SettingRow title={t('title')}>
      {status === null
        ? <span className="text-muted-foreground">{t('loading')}</span>
        : status.connected
          ? <span role="status" className="text-success-foreground">{t('connected')}{status.telegramUserName ? ' · @' + status.telegramUserName.replace(/^@/, '') : ''}</span>
          : <span role="status" className="text-muted-foreground">{status.configured ? t('notConnected') : t('notConfigured')}</span>}
    </SettingRow>
    {connectLink && <SettingRow title={t('linkTitle')}>
      <Button render={<a href={connectLink} target="_blank" rel="noreferrer" />}>{t('openTelegram')}</Button>
    </SettingRow>}
    {error && <p role="alert" className="px-5 py-3 text-sm text-destructive">{t(error)}</p>}
    {status?.configured && <SettingRow title={status.connected ? t('connected') : t('connectTitle')}>
      <div className="flex flex-wrap items-center gap-2">
        {!status.connected && <Button variant="outline" size="sm" disabled={busy} onClick={() => void connect()}>
          {connectLink ? t('newLink') : t('connect')}
        </Button>}
        {status.connected && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void disconnect()}>{t('disconnect')}</Button>}
      </div>
    </SettingRow>}
  </SettingsSection>
}
