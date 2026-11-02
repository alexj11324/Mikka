'use client'

import { useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Info } from 'lucide-react'
import { getBotModelMenu } from '@/app/actions/execution-settings'
import { getCreditShare, updateCreditShare } from '@/app/actions/personal-policy'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { HOSTED_CHOICE, type BotModelMenu } from '@/lib/bot-model-menu-view'
import { getHostedUsage } from '@/lib/billing/verification-client'
import { Link } from '@/i18n/navigation'
import { settingsHref } from '@/lib/settings-sections'
import { useActionError } from '@/lib/use-action-error'
import { botModelMenuKey, openModelPicker } from './bot-model-picker'
import { COMPOSER_NOTICE } from './composer-notice'
import { ConnectSubscriptionButton } from '@/components/billing/connect-subscription-dialog'

/**
 * The chat is on Mikka 默认 but this workspace has no points for it (decision
 * 2026-11-02-1450): said above the composer when the chat opens, not after a
 * send. 换模型 opens the model menu; in a team, 把我的点数用于这个团队 turns on
 * the member's own share where they are, then the menu is read again; in a
 * personal workspace, 验证银行卡 or 充值 opens 计费.
 */
export function HostedUnavailableNotice({ botId }: { botId: string | null }) {
  const t = useTranslations('Coordinator.modelPicker')
  const actionError = useActionError()
  const { mutate } = useSWRConfig()
  const menu = useSWR<BotModelMenu>(botModelMenuKey(botId), () => getBotModelMenu(botId))
  const current = menu.data?.current
  const unavailable = current?.id === HOSTED_CHOICE && !current.available
  const share = useSWR(unavailable ? ['credit-share'] : null, () => getCreditShare())
  // The same read as the refusal line (hosted-refusal-notice): a personal workspace verifies a card or tops up.
  const usage = useSWR(unavailable ? ['hosted-usage'] : null, () => getHostedUsage())
  const billing = useTranslations('Billing')
  const [pending, setPending] = useState(false)
  if (!unavailable) return null
  const canShare = share.data && !share.data.error && share.data.canShare && !share.data.mine
  const own = usage.data && !usage.data.error && usage.data.personal ? usage.data : null
  async function shareMyPoints() {
    if (pending) return
    setPending(true)
    try {
      const result = await updateCreditShare(true)
      if (result.error) { toast.error(actionError(result.error)); return }
      await Promise.all([share.mutate(), mutate(botModelMenuKey(botId))])
    } catch { toast.error(actionError()) } finally { setPending(false) }
  }
  return <Alert data-hosted-unavailable role="status" className={COMPOSER_NOTICE}>
    <Info aria-hidden="true" className="shrink-0" />
    <AlertTitle className="min-w-0 flex-1 basis-48">{t('hostedUnavailable')}</AlertTitle>
    <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
      <Button type="button" size="sm" variant="outline" onClick={() => openModelPicker(botId)}>{t('changeModel')}</Button>
      {own && !own.subscribed && own.workspaceId && <ConnectSubscriptionButton workspaceId={own.workspaceId} botId={botId} label={billing('refusal.bindSubscription')} />}
      {own && <Button size="sm" variant={own.subscribed ? 'default' : 'outline'} nativeButton={false} role="link" render={<Link href={settingsHref('billing')} />}>{own.balance.verified ? billing('balance.topUp') : billing('refusal.verifyCard')}</Button>}
      {canShare && <Button type="button" size="sm" disabled={pending} onClick={() => void shareMyPoints()}>{t('useMyPoints')}</Button>}
    </span>
  </Alert>
}
