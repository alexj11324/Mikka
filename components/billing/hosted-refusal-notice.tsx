'use client'

import type { ReactNode } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { CreditCard, Info, Pause } from 'lucide-react'
import { MikkaMarkSmall } from '@/components/brand/mikka-mark'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { COMPOSER_NOTICE } from '@/components/coordinator/chat-composer'
import { Claude } from '@/components/ui/svgs/claude'
import { OpenAI } from '@/components/ui/svgs/openai'
import { Link } from '@/i18n/navigation'
import { getHostedUsage, type HostedRefusal } from '@/lib/billing/verification-client'
import { refusalOffer } from '@/lib/billing/hosted-usage'
import { settingsHref } from '@/lib/settings-sections'

/**
 * A hosted-model (Mikka 默认) turn was refused (#523, #525, #526). One line above
 * the composer in place of 回复失败, styled as the composer is (Figma ALW-1
 * `709:27554`, ALW-1b `709:27767`, ALW-2 `709:27979`, ALW-3 `709:28207`), with
 * the way on the person's real state allows (`refusalOffer`).
 */
export function HostedRefusalNotice({ code, retry }: { code: HostedRefusal; retry?: ReactNode }) {
  const t = useTranslations('Billing.refusal')
  const usage = useSWR(['hosted-usage'], () => getHostedUsage())
  const { transient, card, connect } = refusalOffer(code, usage.data && !usage.data.error ? usage.data : null)
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
      {card && <Button size="sm" variant="link" className="text-muted-foreground" nativeButton={false} role="link" render={<Link href={settingsHref('billing')} />}>{t('verifyCard')}</Button>}
      {connect && <Button size="sm" nativeButton={false} role="link" render={<Link href={settingsHref('models')} />}>
        {t.rich('connect', { claude: () => <Claude aria-hidden="true" />, openai: () => <OpenAI aria-hidden="true" /> })}
      </Button>}
    </span>
  </Alert>
}
