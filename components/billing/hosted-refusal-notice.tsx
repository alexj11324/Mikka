'use client'

import type { ReactNode } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { CreditCard, Info, Pause } from 'lucide-react'
import { MikkaMarkSmall } from '@/components/brand/mikka-mark'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Claude } from '@/components/ui/svgs/claude'
import { OpenAI } from '@/components/ui/svgs/openai'
import { Link } from '@/i18n/navigation'
import { getHostedUsage, type HostedRefusal } from '@/lib/billing/verification-client'
import { settingsHref } from '@/lib/settings-sections'

/**
 * A hosted-model (Mikka 默认) turn was refused (#523, #525, #526). One line above
 * the composer in place of 回复失败 (Figma ALW-1 `709:27554`, ALW-1b `709:27767`,
 * ALW-2 `709:27979`, ALW-3 `709:28207`). The way on is the person's own
 * Claude / ChatGPT subscription (设置 › 模型与额度); 验证银行卡 (计费) is the
 * secondary link in a personal workspace that has no verified card.
 */
export function HostedRefusalNotice({ code, retry }: { code: HostedRefusal; retry?: ReactNode }) {
  const t = useTranslations('Billing.refusal')
  const usage = useSWR(['hosted-usage'], () => getHostedUsage())
  const unverified = usage.data && !usage.data.error && !usage.data.balance.verified
  const Icon = code === 'verification_required' ? CreditCard : code === 'platform_paused' ? Pause : Info
  const transient = code === 'usage_in_progress' || code === 'usage_concurrency_limit' || code === 'usage_cost_unavailable'
  const title = code === 'verification_required'
    ? t.rich('verification_required', { mark: () => <MikkaMarkSmall />, model: chunks => <span className="inline-flex items-center gap-1">{chunks}</span> })
    : transient ? t('unavailable') : t(code)
  // Verification is the person's and its credit lands in their personal workspace (C19): offered there only.
  const personal = Boolean(usage.data && !usage.data.error && usage.data.personal)
  const offersCard = personal && (code === 'verification_required' || (unverified && (code === 'free_allowance_used' || code === 'points_exhausted')))
  // Narrow screens: the line wraps above the actions instead of squeezing to one character per line.
  return <Alert data-hosted-refusal={code} role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 pr-1.5">
    <Icon aria-hidden="true" className="shrink-0" />
    <AlertTitle className="min-w-0 flex-1 basis-48 font-normal">{title}</AlertTitle>
    <span className="ml-auto flex shrink-0 items-center gap-1">
      {retry}
      {offersCard && <Button size="sm" variant="link" className="text-muted-foreground" nativeButton={false} role="link" render={<Link href={settingsHref('billing')} />}>{t('verifyCard')}</Button>}
      {!transient && <Button size="sm" nativeButton={false} role="link" render={<Link href={settingsHref('models')} />}>
        {t.rich('connect', { claude: () => <Claude aria-hidden="true" />, openai: () => <OpenAI aria-hidden="true" /> })}
      </Button>}
    </span>
  </Alert>
}
