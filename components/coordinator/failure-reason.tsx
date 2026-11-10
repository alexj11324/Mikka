'use client'

import { useTranslations } from 'next-intl'
import { CircleAlert } from 'lucide-react'
import { failureMessageKey, type ChatFailure } from '@/lib/chat-failure'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Link } from '@/i18n/navigation'
import { settingsHref } from '@/lib/settings-sections'
import { openModelPicker } from './bot-model-picker'
import { subscriptionRecovery } from '@/lib/subscription-refusal'
import { withBasePath } from '@/lib/base-path'
import { RunErrorDetails } from '@/components/workspace/run-error-text'
import type { CloudErrorCode } from '@/lib/cloud-services/errors'
import type { ReactNode } from 'react'

const TRANSIENT = new Set(['usage_in_progress', 'usage_concurrency_limit', 'usage_cost_unavailable'])
const ACTION = 'h-auto px-0 py-0.5 text-xs text-foreground underline'

/** The current failure and its history share the same explicit cloud recovery. */
export function CloudFailureAction({ code, fallback }: { code: CloudErrorCode; fallback: ReactNode }) {
  const cloud = useTranslations('Settings.cloud')
  if (code === 'cloud_quota_exhausted') return <Button variant="link" size="xs" className={ACTION} nativeButton={false} role="link" render={<a href={withBasePath('/api/cloud/models/billing?redirect=1')} target="_blank" rel="noreferrer" />}>{cloud('topUp')}</Button>
  if (['cloud_not_connected', 'cloud_server_revoked', 'cloud_scope_missing'].includes(code)) return <Button variant="link" size="xs" className={ACTION} nativeButton={false} role="link" render={<Link href={settingsHref('account')} />}>{cloud('connectAccount')}</Button>
  return fallback
}

/**
 * Why an earlier turn did not answer this message, under it for good: the same words as the line it had when
 * it failed (Telegram and the phone read the same key, failureMessageKey), and one way on (review C5,
 * copy.md C-04): billing for Mikka 默认, subscription settings for account
 * recovery, model selection for a rejected choice, else 重新发送.
 */
/** `retry`: the turn runs again (a welcome has no message of the person's to send again), so the action reads 重试. */
export function FailureReason({ failure, botId, onResend, sending = false, retry = false }: { failure: ChatFailure; botId: string | null; onResend: () => void; sending?: boolean; retry?: boolean }) {
  const chat = useTranslations('Coordinator')
  const common = useTranslations('Common')
  const refusal = useTranslations('Billing.refusal')
  const balance = useTranslations('Billing.balance')
  const picker = useTranslations('Coordinator.modelPicker')
  const errors = useTranslations('RunErrors')
  const message = failureMessageKey(failure)
  const reason = message.namespace === 'RunErrors' ? errors(message.key) : message.namespace === 'Billing.refusal' ? refusal(message.key) : chat(message.key)
  const transient = failure.kind === 'hosted' && TRANSIENT.has(failure.code)
  const recovery = failure.kind === 'subscription' ? subscriptionRecovery(failure.notice) : null
  const cloudCode = failure.kind === 'failed' ? failure.cloudCode : undefined
  const resend = <Button variant="link" size="xs" className={ACTION} disabled={sending} onClick={onResend}>{retry ? common('retry') : chat('resend')}</Button>
  const action = cloudCode ? <CloudFailureAction code={cloudCode} fallback={resend} />
    : failure.kind === 'hosted' && !transient && failure.code !== 'platform_paused'
    ? <Button variant="link" size="xs" className={ACTION} nativeButton={false} role="link" render={<Link href={settingsHref('billing')} />}>{failure.code === 'verification_required' ? refusal('verifyCard') : balance('topUp')}</Button>
    : recovery === 'settings'
      ? <Button variant="link" size="xs" className={ACTION} nativeButton={false} role="link" render={<Link href={settingsHref('models')} />}>{chat('subscriptionRefusal.open')}</Button>
      : recovery === 'model' || (failure.kind === 'hosted' && failure.code === 'platform_paused') || (failure.kind === 'failed' && failure.reason === 'balance')
      ? <Button variant="link" size="xs" className={ACTION} onClick={() => openModelPicker(botId)}>{picker('changeModel')}</Button>
      : resend
  return <div data-failure-reason="" className={cn('flex flex-col gap-0.5', retry ? 'items-start' : 'items-end')}>
    <p data-message-failure="past" className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />{reason}<span aria-hidden="true">·</span>{action}
    </p>
    {/* The stored code only under 详情, never in place of the words (decision 2026-11-05-0330). */}
    {failure.raw && <RunErrorDetails code={failure.raw} />}
  </div>
}
