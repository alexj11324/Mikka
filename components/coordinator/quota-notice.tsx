'use client'

import { useEffect, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { Info } from 'lucide-react'
import { getBotModelMenu } from '@/app/actions/execution-settings'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Link } from '@/i18n/navigation'
import { settingsHref } from '@/lib/settings-sections'
import type { BotModelMenu } from '@/lib/bot-model-menu-view'
import type { QuotaSwitchNotice } from '@/lib/coordinator/message-safety'
import { botModelMenuKey, openModelPicker } from './bot-model-picker'

const PROVIDERS = ['anthropic', 'openai', 'deepseek', 'kimi'] as const

/** `Claude Max`, `ChatGPT Pro`, or the provider alone when it reports no plan. */
export function subscriptionName(provider: string, plan: string | null) {
  const name = provider === 'codex' ? 'ChatGPT' : 'Claude'
  return plan ? `${name} ${plan}` : name
}

export function useKeyName() {
  const t = useTranslations('Settings.apiKeys.provider')
  return (provider: string, name: string | null) =>
    name ?? ((PROVIDERS as readonly string[]).includes(provider) ? t(provider as (typeof PROVIDERS)[number]) : provider)
}

/** 14:00 today, 11月2日 14:00 on another day. */
export function useResetTime() {
  const format = useFormatter()
  return (at: string) => {
    const date = new Date(at)
    const today = new Date().toDateString() === date.toDateString()
    return format.dateTime(date, today ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
}

/**
 * The chat's line for a turn that moved to the person's API key because the
 * subscription ran out (订阅额度用完后，自动改用 API Key). 改回 opens the model
 * picker, where the person picks what the next turn uses.
 */
export function QuotaSwitchLine({ notice, botId }: { notice: QuotaSwitchNotice; botId: string | null }) {
  const t = useTranslations('Coordinator.quota')
  const keyName = useKeyName()
  return <p data-quota-switch className="mx-auto max-w-full text-center text-xs text-muted-foreground wrap-break-word">
    {t('switched', { name: subscriptionName(notice.subscription, notice.plan), key: keyName(notice.keyProvider, notice.keyName) })}
    {' · '}
    <Button variant="link" size="xs" className="-my-1 h-auto px-0 py-1 text-xs text-foreground underline" onClick={() => openModelPicker(botId)}>{t('revert')}</Button>
  </p>
}

/**
 * The chat's subscription is out of quota, above the composer. Before sending
 * it names when the quota resets, or the key the next turn moves to. After a
 * turn stopped on it (`stopped`), it also offers the way on: 添加 API Key 继续
 * and 重置后重试, or 用 API Key 继续 when the next turn will move to a key.
 */
export function QuotaNotice({ botId, stopped, retry }: {
  botId: string | null
  stopped: boolean
  /** The 重试 button, given its label and whether it waits for the reset. */
  retry: (label: string, disabled: boolean) => ReactNode
}) {
  const t = useTranslations('Coordinator.quota')
  const keyName = useKeyName()
  const resetTime = useResetTime()
  const menu = useSWR<BotModelMenu>(botModelMenuKey(botId), () => getBotModelMenu(botId))
  const { mutate } = menu
  const quota = menu.data?.current.quota
  const resetsAt = quota?.resetsAt ?? null
  const [reset, setReset] = useState(() => !resetsAt || Date.parse(resetsAt) <= Date.now())
  useEffect(() => {
    if (!resetsAt) { setReset(true); return }
    const wait = Date.parse(resetsAt) - Date.now()
    setReset(wait <= 0)
    if (wait <= 0) return
    const timer = setTimeout(() => { setReset(true); void mutate() }, Math.min(wait, 2 ** 31 - 1))
    return () => clearTimeout(timer)
  }, [resetsAt, mutate])
  if (!quota && !stopped) return null

  const name = quota ? subscriptionName(quota.subscription, quota.plan) : null
  const title = name ? t('used', { name }) : t('usedGeneric')
  const detail = quota?.fallback
    ? t('next', { key: keyName(quota.fallback.keyProvider, quota.fallback.keyName) })
    : resetsAt && !reset ? t('resets', { time: resetTime(resetsAt) }) : null
  const actions = stopped
    ? quota?.fallback
      ? retry(t('useKey'), false)
      : <>
          <Button size="sm" nativeButton={false} role="link" render={<Link href={settingsHref('models')} />}>{t('addKey')}</Button>
          {retry(t('retryAfterReset'), !reset)}
        </>
    : quota?.fallback ? null : <Button size="sm" variant="outline" nativeButton={false} role="link" render={<Link href={settingsHref('models')} />}>{t('addKey')}</Button>
  return <Alert data-quota-notice={stopped ? 'stopped' : 'before-send'} role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 pr-1.5">
    <Info aria-hidden="true" className="shrink-0" />
    <AlertTitle className="min-w-0 flex-1 basis-48 font-normal">{detail ? `${title} · ${detail}` : title}</AlertTitle>
    {actions && <span className="ml-auto flex shrink-0 items-center gap-1">{actions}</span>}
  </Alert>
}
