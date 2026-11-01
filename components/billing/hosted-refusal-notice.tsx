'use client'

import { useState, type ReactNode } from 'react'
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
import { botModelMenuKey } from '@/components/coordinator/bot-model-picker'
import { subscriptionName } from '@/components/coordinator/quota-notice'
import { getHostedUsage, type HostedRefusal } from '@/lib/billing/verification-client'
import { ownSubscriptionOption, type BotModelMenu } from '@/lib/bot-model-menu-view'
import { refusalOffer } from '@/lib/billing/hosted-usage'
import { settingsHref } from '@/lib/settings-sections'
import { useActionError } from '@/lib/use-action-error'

/**
 * A hosted-model (Mikka 默认) turn was refused (#523, #525, #526). One line above
 * the composer in place of 回复失败, styled as the composer is (Figma ALW-1
 * `709:27554`, ALW-1b `709:27767`, ALW-2 `709:27979`, ALW-3 `709:28207`), with
 * the way on the person's real state allows (`refusalOffer`). With their own
 * subscription connected (it serves them anywhere, decision 2240), 改用我的
 * Claude 订阅 moves this chat onto it, as the model menu does, and sends the
 * message again; 重试 stays beside it.
 */
export function HostedRefusalNotice({ code, botId, retry, onQueued }: { code: HostedRefusal; botId: string | null; retry?: ReactNode; onQueued: () => unknown }) {
  const t = useTranslations('Billing.refusal')
  const usage = useSWR(['hosted-usage'], () => getHostedUsage())
  const { transient, card, connect } = refusalOffer(code, usage.data && !usage.data.error ? usage.data : null)
  // The model menu's own read (the same SWR key as the composer's chip): its first own subscription.
  const menu = useSWR<BotModelMenu>(transient ? botModelMenuKey(botId) : null, () => getBotModelMenu(botId))
  const own = menu.data ? ownSubscriptionOption(menu.data) : null
  const Icon = transient ? Info : code === 'verification_required' ? CreditCard : code === 'platform_paused' ? Pause : Info
  const title = transient || code === 'usage_in_progress' || code === 'usage_concurrency_limit' || code === 'usage_cost_unavailable' ? t('unavailable')
    : code === 'verification_required'
      ? t.rich('verification_required', { mark: () => <MikkaMarkSmall />, model: chunks => <span className="inline-flex items-center gap-1">{chunks}</span> })
      : t(code)
  return <Alert data-hosted-refusal={code} role="status" className={COMPOSER_NOTICE}>
    <Icon aria-hidden="true" className="shrink-0" />
    <AlertTitle className="min-w-0 flex-1 basis-48">{title}</AlertTitle>
    <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
      {transient && retry}
      {transient && own && <UseSubscriptionButton botId={botId} option={own.option} label={t('useSubscription', { name: subscriptionName(own.provider, own.plan) })} onQueued={onQueued} />}
      {card && <Button size="sm" variant="link" className="text-muted-foreground" nativeButton={false} role="link" render={<Link href={settingsHref('billing')} />}>{t('verifyCard')}</Button>}
      {connect && <Button size="sm" nativeButton={false} role="link" render={<Link href={settingsHref('models')} />}>
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
