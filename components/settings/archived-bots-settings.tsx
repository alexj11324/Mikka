'use client'

import { useTranslations } from 'next-intl'
import { BotAvatar } from '@/components/nav/bot-avatar'
import { SettingRow, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { Button } from '@/components/ui/button'
import { useArchivedBots } from '@/hooks/settings/use-workspace-general'

/**
 * Bots of people who left the team or were suspended stay paused here until an
 * admin takes one over; it then runs on that admin's own resources (§8.3,
 * decision 2026-10-31-2225). Members and empty lists show nothing.
 */
export function ArchivedBotsSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.archivedBots')
  const commonT = useTranslations('Common')
  const { bots, readError, reload, pending, failed, takeOver } = useArchivedBots(workspaceId)

  if (readError) return <SettingsSection id="archived-bots-heading" title={t('heading')}>
    <SettingsSaveError message={readError} retryLabel={commonT('retry')} onRetry={() => { void reload() }} />
  </SettingsSection>
  if (!bots.length) return null
  return <>
    <SettingsSection id="archived-bots-heading" title={t('heading')}>
      {bots.map(bot => <SettingRow key={bot.id} title={bot.name} icon={<BotAvatar id={bot.id} color={bot.color} shape={bot.shape} size="row" />}>
        <Button variant="outline" size="sm" disabled={pending !== null} onClick={() => void takeOver(bot.id)}>{t('takeOver')}</Button>
      </SettingRow>)}
    </SettingsSection>
    {failed && <SettingsSaveError message={failed.message} retryLabel={commonT('retry')} onRetry={() => void takeOver(failed.botId)} />}
  </>
}
