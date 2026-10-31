'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { listArchivedBots, takeOverArchivedBot } from '@/app/actions/workspace-settings'
import { BotAvatar } from '@/components/nav/bot-avatar'
import { SettingRow, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { Button } from '@/components/ui/button'
import { useActionError } from '@/lib/use-action-error'

/**
 * Bots of people who left the team or were suspended stay paused here until an
 * admin takes one over; it then runs on that admin's own resources (§8.3,
 * decision 2026-10-31-2225). Members and empty lists show nothing.
 */
export function ArchivedBotsSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.archivedBots')
  const commonT = useTranslations('Common')
  const actionError = useActionError()
  const list = useSWR(['settings:archived-bots', workspaceId], () => listArchivedBots(workspaceId))
  const [pending, setPending] = useState<string | null>(null)
  const [failed, setFailed] = useState<{ botId: string; message: string } | null>(null)
  const bots = list.data && !list.data.error ? list.data.bots : []

  async function takeOver(botId: string) {
    setPending(botId)
    setFailed(null)
    try {
      const result = await takeOverArchivedBot(botId, workspaceId)
      if (result.error) { setFailed({ botId, message: actionError(result.error) }); return }
      await list.mutate()
    } catch {
      setFailed({ botId, message: actionError() })
    } finally {
      setPending(null)
    }
  }

  if (!bots.length) return null
  return <>
    <SettingsSection id="archived-bots-heading" title={t('heading')}>
      {bots.map(bot => <SettingRow key={bot.id} title={bot.name} icon={<BotAvatar color={bot.color} shape={bot.shape} size="row" />}>
        <Button variant="outline" size="sm" disabled={pending !== null} onClick={() => void takeOver(bot.id)}>{t('takeOver')}</Button>
      </SettingRow>)}
    </SettingsSection>
    {failed && <SettingsSaveError message={failed.message} retryLabel={commonT('retry')} onRetry={() => void takeOver(failed.botId)} />}
  </>
}
