'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { CreditCard, Info, Pause } from 'lucide-react'
import { MikkaMarkSmall } from '@/components/brand/mikka-mark'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { COMPOSER_NOTICE } from '@/components/coordinator/composer-notice'
import { Claude } from '@/components/ui/svgs/claude'
import { OpenAI } from '@/components/ui/svgs/openai'
import { Link } from '@/i18n/navigation'
import { chooseBotModel, getBotModelMenu } from '@/app/actions/execution-settings'
import { retryCoordinatorTurn } from '@/app/actions/coordinator'
import { getCreditShare, updateCreditShare } from '@/app/actions/personal-policy'
import { botModelMenuKey } from '@/components/coordinator/bot-model-picker'
import { subscriptionName } from '@/components/coordinator/quota-notice'
import { getHostedUsage, type HostedRefusal } from '@/lib/billing/verification-client'
import { ownSubscriptionOption, type BotModelMenu } from '@/lib/bot-model-menu-view'
import { balancePoints, refusalOffer } from '@/lib/billing/hosted-usage'
import { useLiveWait } from '@/hooks/use-live-wait'
import { ConnectSubscriptionButton } from '@/components/billing/connect-subscription-dialog'
import { TopUpInPlace } from '@/components/billing/top-up-in-place'
import { dropQueryKeys } from '@/components/workspace/workspace-navigation'
import { settingsHref } from '@/lib/settings-sections'
import { useActionError } from '@/lib/use-action-error'
import { cn } from '@/lib/utils'

/**
 * A hosted-model (Mikka 默认) turn was refused (#523, #525, #526). One line under
 * the message it was answering, in place of 回复失败, styled as the composer is (Figma ALW-1
 * `709:27554`, ALW-1b `709:27767`, ALW-2 `709:27979`, ALW-3 `709:28207`), with
 * the way on the person's real state allows (`refusalOffer`). With their own
 * subscription connected (it serves them anywhere, decision 2240), 改用我的
 * Claude 订阅 moves this chat onto it, as the model menu does, and sends the
 * message again. 重试 is always there: after verifying or buying points it runs
 * the turn again.
 */
export function HostedRefusalNotice({ code, botId, retry, onQueued }: { code: HostedRefusal; botId: string | null; retry?: ReactNode; onQueued: () => unknown }) {
  const t = useTranslations('Billing.refusal')
  const usage = useSWR(['hosted-usage'], () => getHostedUsage())
  const read = usage.data && !usage.data.error ? usage.data : null
  const { transient, billing, card, connect, topUp } = refusalOffer(code, read)
  // The free messages are used up (no card yet): 绑定订阅 and 验证银行卡 side by side (decision 2026-11-02-1450).
  const trialUsed = code === 'verification_required' && read?.trialLeft === 0
  const actionError = useActionError()
  // Paid: once the webhook has credited the points, the refused turn runs again. The webhook's commit pushes
  // this workspace's hosted_billing key (#1212); no timer reads the balance.
  const credited = useCallback((value: NonNullable<typeof usage.data>) => !value.error && balancePoints(value.balance) > 0, [])
  const waitForPoints = useLiveWait(usage, 'hosted_billing', read?.workspaceId, ['hosted-usage'], credited)
  async function afterPayment() {
    await waitForPoints()
    const result = botId ? await retryCoordinatorTurn(botId) : await retryCoordinatorTurn()
    if (result.error) toast.error(actionError(result.error))
    else await onQueued()
  }
  // Back from Stripe's own page (no publishable key, or a payment method that left the page): the same.
  const returned = useRef(false)
  useEffect(() => {
    if (returned.current) return
    const topup = new URL(window.location.href).searchParams.get('topup')
    if (!topup) return
    returned.current = true
    dropQueryKeys('topup', 'session_id')
    if (topup === 'success') void afterPayment()
  })
  // The model menu's own read (the same SWR key as the composer's chip): its first own subscription.
  const menu = useSWR<BotModelMenu>(transient || billing ? botModelMenuKey(botId) : null, () => getBotModelMenu(botId))
  // A team with no points: the member's own share turns on right here (decision 2026-11-02-1450).
  const share = useSWR(billing ? ['credit-share'] : null, () => getCreditShare())
  const own = menu.data ? ownSubscriptionOption(menu.data) : null
  const Icon = transient ? Info : code === 'verification_required' ? CreditCard : code === 'platform_paused' ? Pause : Info
  const title = transient || code === 'usage_in_progress' || code === 'usage_concurrency_limit' || code === 'usage_cost_unavailable' ? t('unavailable')
    : code === 'usage_budget_exhausted' || code === 'billing_authorization_revoked' ? t(code)
    : billing ? t('teamNoPoints')
    : trialUsed ? t('trialUsed')
    : code === 'verification_required'
      ? t.rich('verification_required', { mark: () => <MikkaMarkSmall />, model: chunks => <span className="inline-flex items-center gap-1">{chunks}</span> })
      : t(code)
  return <Alert data-hosted-refusal={code} role="status" className={COMPOSER_NOTICE}>
    <Icon aria-hidden="true" className="shrink-0" />
    <AlertTitle className="min-w-0 flex-1 basis-48">{title}</AlertTitle>
    <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
      {retry}
      {(transient || billing) && own && <UseSubscriptionButton botId={botId} option={own.option} label={t('useSubscription', { name: subscriptionName(own.provider, own.plan) })} onQueued={onQueued} />}
      {billing && (code !== 'usage_budget_exhausted' && code !== 'billing_authorization_revoked' && share.data && !share.data.error && share.data.canShare && !share.data.mine
        ? <ShareMyPointsButton botId={botId} label={t('useMyPoints')} onQueued={onQueued} onShared={() => share.mutate()} />
        : <Button size="sm" variant="outline" nativeButton={false} role="link" render={<Link href={settingsHref('billing')} />}>{t('openBilling')}</Button>)}
      {topUp && <TopUpInPlace botId={botId} label={t('topUp')} onPaid={afterPayment} />}
      {connect && trialUsed && read?.workspaceId && <ConnectSubscriptionButton workspaceId={read.workspaceId} botId={botId} label={t('bindSubscription')} />}
      {card && <Button size="sm" variant={trialUsed ? 'outline' : 'link'} className={cn(!trialUsed && 'text-muted-foreground')} nativeButton={false} role="link" render={<Link href={settingsHref('billing')} />}>{t('verifyCard')}</Button>}
      {connect && !trialUsed && <Button size="sm" variant={billing || topUp ? "outline" : "default"} nativeButton={false} role="link" render={<Link href={settingsHref('models')} />}>
        {t.rich('connect', { claude: () => <Claude aria-hidden="true" />, openai: () => <OpenAI aria-hidden="true" /> })}
      </Button>}
    </span>
  </Alert>
}

/** 改用我的 Claude 订阅: picks it in the model menu (`chooseBotModel`), then runs the refused turn again on it. */
function UseSubscriptionButton({ botId, option, label, onQueued }: { botId: string | null; option: string; label: string; onQueued: () => unknown }) {
  const actionError = useActionError()
  const { mutate } = useSWRConfig()
  const [pending, setPending] = useState(false)
  async function use() {
    if (pending) return
    setPending(true)
    try {
      const { error, ...saved } = await chooseBotModel(botId, option)
      if (error) { toast.error(actionError(error)); return }
      await mutate(botModelMenuKey(botId), saved as BotModelMenu, { revalidate: false })
      const result = botId ? await retryCoordinatorTurn(botId) : await retryCoordinatorTurn()
      if (result.error) toast.error(actionError(result.error))
      else await onQueued()
    } catch { toast.error(actionError()) } finally { setPending(false) }
  }
  return <Button type="button" size="sm" disabled={pending} onClick={() => void use()}>{label}</Button>
}

/**
 * 把我的点数用于这个团队: turns the member's share on for this team where the
 * refusal is, then runs the refused turn again, which now spends their points.
 */
function ShareMyPointsButton({ botId, label, onQueued, onShared }: { botId: string | null; label: string; onQueued: () => unknown; onShared: () => unknown }) {
  const actionError = useActionError()
  const { mutate } = useSWRConfig()
  const [pending, setPending] = useState(false)
  async function share() {
    if (pending) return
    setPending(true)
    try {
      const shared = await updateCreditShare(true)
      if (shared.error) { toast.error(actionError(shared.error)); return }
      await Promise.all([onShared(), mutate(botModelMenuKey(botId))])
      const result = botId ? await retryCoordinatorTurn(botId) : await retryCoordinatorTurn()
      if (result.error) toast.error(actionError(result.error))
      else await onQueued()
    } catch { toast.error(actionError()) } finally { setPending(false) }
  }
  return <Button type="button" size="sm" disabled={pending} onClick={() => void share()}>{label}</Button>
}
