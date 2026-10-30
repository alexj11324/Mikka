'use client'

import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { settingsHref } from '@/lib/settings-sections'
import { parseBotModelRefusal } from '@/lib/workspace-admin/bot-model-policy'

/** Asks the conversation's right column to open the bot's 详情 (components/workspace/issue-workspace.tsx listens). */
export const OPEN_BOT_DETAILS_EVENT = 'mikka:open-bot-details'

/**
 * The chat's failed-turn alert. A turn refused for its bot's model
 * (docs/design/bot-settings.md) names the reason and links to the fix:
 * 模型订阅 when the subscription is missing, the bot's 详情 when another model
 * has to be chosen. Any other failure shows its error as before.
 */
export function TurnError({ error }: { error: string }) {
  const t = useTranslations('Coordinator')
  const allT = useTranslations()
  const refusal = parseBotModelRefusal(error)
  if (!refusal) return <Alert variant="destructive"><AlertTitle>{t('failedTitle')}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>
  const model = refusal.family ? allT(`Settings.bots.models.${refusal.family}`) : ''
  return <Alert variant="destructive" data-testid="bot-model-refusal">
    <AlertTitle>{t('failedTitle')}</AlertTitle>
    <AlertDescription>{refusal.reason === 'binding_required' ? allT('Settings.botSettings.subscriptionMissing', { model }) : t('modelUnavailableHere', { model })}</AlertDescription>
    <AlertAction>{refusal.reason === 'binding_required'
      ? <Button variant="outline" size="sm" nativeButton={false} render={<Link href={settingsHref('models')} />}>{allT('Settings.sections.models.title')}</Button>
      : <Button variant="outline" size="sm" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_BOT_DETAILS_EVENT))}>{t('changeModel')}</Button>}
    </AlertAction>
  </Alert>
}
