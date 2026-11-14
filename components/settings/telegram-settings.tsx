'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { createTelegramConnectLink, disconnectTelegram, getTelegramIntegrationStatus } from '@/app/actions/telegram'
import { FieldError } from '@/components/ui/field'
import { useCheckOnReturn } from '@/lib/hooks/use-check-on-return'

type TelegramStatus = Awaited<ReturnType<typeof getTelegramIntegrationStatus>>

/** Telegram's connection as data and actions; `disconnect` acts at once, so a UI confirms first. Shared with UI layers. */
export function useTelegramPlugin() {
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [connectLink, setConnectLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<'error' | 'notConfigured' | ''>('')

  const latestRead = useRef(0)
  const refresh = useCallback(async () => {
    const read = ++latestRead.current
    setBusy(true)
    setError('')
    try {
      const next = await getTelegramIntegrationStatus()
      if (read !== latestRead.current) return
      setStatus(next)
      if (next.connected) setConnectLink('')
    } catch {
      if (read !== latestRead.current) return
      setStatus(null)
      setConnectLink('')
      setError('error')
    } finally {
      if (read === latestRead.current) setBusy(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    return () => { latestRead.current++ }
  }, [refresh])
  // Opening Telegram to press Start: read once when the person comes back, never on plain focus.
  const checkOnReturn = useCheckOnReturn(refresh)

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

  return { status, connectLink, busy, error, refresh, connect, disconnect, checkOnReturn }
}

export function TelegramSettings() {
  const t = useTranslations('Settings.telegram')
  const common = useTranslations('Common')
  const { status, connectLink, busy, error, refresh, connect, disconnect: disconnectNow, checkOnReturn } = useTelegramPlugin()
  const disconnect = async () => { if (window.confirm(t('disconnectConfirm'))) await disconnectNow() }
  if (!status && error) return <SettingsSection id="telegram-heading" title={t('title')}
    action={<Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>{common('retry')}</Button>}>
    <FieldError className="px-5 py-3">{t(error)}</FieldError>
  </SettingsSection>
  return <SettingsSection id="telegram-heading">
    <SettingRow title={t('title')}>
      {status === null
        ? <span className="text-muted-foreground">{t('loading')}</span>
        : status.connected
          ? <span role="status" className="text-success-foreground">{t('connected')}{status.telegramUserName ? ' · @' + status.telegramUserName.replace(/^@/, '') : ''}</span>
          : <span role="status" className="text-muted-foreground">{status.configured ? t('notConnected') : t('notConfigured')}</span>}
    </SettingRow>
    {connectLink && <SettingRow title={t('linkTitle')}>
      <Button render={<a href={connectLink} target="_blank" rel="noreferrer" onClick={checkOnReturn} />}>{t('openTelegram')}</Button>
    </SettingRow>}
    {error && <FieldError className="px-5 py-3">{t(error)}</FieldError>}
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
