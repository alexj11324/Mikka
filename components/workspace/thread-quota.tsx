'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Info } from 'lucide-react'
import { resumeQuotaPausedRunOnApiKey, retryQuotaPausedRun } from '@/app/actions/agents'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { Link } from '@/i18n/navigation'
import { settingsHref } from '@/lib/settings-sections'
import type { ThreadQuotaView } from '@/lib/run-quota-view'
import { subscriptionName, useKeyName, useResetTime } from '@/components/coordinator/quota-notice'

/** In an open thread: a run that went on on the person's API key when its subscription ran out. */
export function ThreadQuotaSwitchLine({ switched }: { switched: ThreadQuotaView['switched'][number] }) {
  const t = useTranslations('Coordinator.quota')
  const keyName = useKeyName()
  return <p data-thread-quota-switch className="mx-auto max-w-full text-center text-xs text-muted-foreground wrap-break-word">
    {t('switched', { name: subscriptionName(switched.subscription, switched.plan), key: keyName(switched.key.provider, switched.key.name) })}
  </p>
}

/**
 * A thread whose run paused because its subscription ran out: when it resets,
 * and the way on. 用 API Key 继续 once the person has a key (添加 API Key 继续
 * takes them to add one), and 重置后重试 with the original credential once it resets.
 */
export function ThreadQuotaPausedCard({ paused, onContinued }: { paused: NonNullable<ThreadQuotaView['paused']>; onContinued: () => unknown }) {
  const t = useTranslations('Coordinator.quota')
  const resetTime = useResetTime()
  const [pending, setPending] = useState<'key' | 'retry' | null>(null)
  const [failed, setFailed] = useState(false)
  const [reset, setReset] = useState(() => !paused.resetsAt || Date.parse(paused.resetsAt) <= Date.now())
  useEffect(() => {
    if (!paused.resetsAt) { setReset(true); return }
    const wait = Date.parse(paused.resetsAt) - Date.now()
    setReset(wait <= 0)
    if (wait <= 0) return
    const timer = setTimeout(() => setReset(true), Math.min(wait, 2 ** 31 - 1))
    return () => clearTimeout(timer)
  }, [paused.resetsAt])
  async function run(kind: 'key' | 'retry') {
    if (pending) return
    setPending(kind); setFailed(false)
    try { await (kind === 'key' ? resumeQuotaPausedRunOnApiKey(paused.runId) : retryQuotaPausedRun(paused.runId)); await onContinued() }
    catch { setFailed(true) }
    finally { setPending(null) }
  }
  const title = t('used', { name: subscriptionName(paused.subscription, paused.plan) })
  const detail = paused.resetsAt && !reset ? t('resets', { time: resetTime(paused.resetsAt) }) : null
  return <div className="flex flex-col gap-1">
    <Alert data-thread-quota-paused role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 pr-1.5">
      <Info aria-hidden="true" className="shrink-0" />
      <AlertTitle className="min-w-0 flex-1 basis-48 font-normal">{detail ? `${title} · ${detail}` : title}</AlertTitle>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {paused.keyReady
          ? <Button size="sm" disabled={pending !== null} onClick={() => void run('key')}>{t('useKey')}</Button>
          : <Button size="sm" nativeButton={false} role="link" render={<Link href={settingsHref('models')} />}>{t('addKey')}</Button>}
        <Button size="sm" variant="outline" disabled={!reset || pending !== null} onClick={() => void run('retry')}>{t('retryAfterReset')}</Button>
      </span>
    </Alert>
    {failed && <FieldError className="px-3 text-xs">{t('continueFailed')}</FieldError>}
  </div>
}
