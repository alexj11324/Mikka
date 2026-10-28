'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Progress } from '@/components/ui/progress'
import { Claude } from '@/components/ui/svgs/claude'
import { OpenAI } from '@/components/ui/svgs/openai'
import { BotAvatar } from '@/components/nav/bot-avatar'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { withBasePath } from '@/lib/base-path'
import { parseSubscriptionStart, subscriptionListSchema, subscriptionUsageSchema, type SubscriptionUsageView } from '@/lib/subscription-ui'
import { cn } from '@/lib/utils'

type Provider = 'codex' | 'claude'
type State = ReturnType<typeof subscriptionListSchema.parse>
type Attempt = ReturnType<typeof parseSubscriptionStart> & { provider: Provider }
const path = withBasePath('/api/subscriptions')
const logos = { codex: OpenAI, claude: Claude } as const
/** Comma re-reads a plan's windows every 5 minutes while the page is watched. */
const USAGE_EVERY_MS = 5 * 60_000
type Usage = Map<string, SubscriptionUsageView> | 'failed' | null

async function post(body: unknown, signal?: AbortSignal) {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal })
  if (!response.ok) throw new Error('Subscription request failed')
  return response.json() as Promise<unknown>
}

/** The provider ceremony stays in this page's memory, never chat or storage. */
export function SubscriptionSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.subscriptions')
  const [state, setState] = useState<State | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [callback, setCallback] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [usage, setUsage] = useState<Usage>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const usageAbort = useRef<AbortController | null>(null)
  const connectedKey = state?.connections.filter(item => item.state === 'connected').map(item => `${item.id}:${item.revision}`).join(',') ?? ''
  const refresh = useCallback(async () => {
    const response = await fetch(`${path}?workspace=${encodeURIComponent(workspaceId)}`, { cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok) throw new Error('Subscription list unavailable')
    setState(subscriptionListSchema.parse(await response.json())); setLoadFailed(false)
  }, [workspaceId])

  useEffect(() => { void refresh().catch(() => { setState(null); setLoadFailed(true) }) }, [refresh])
  const loadUsage = useCallback(async () => {
    usageAbort.current?.abort()
    const abort = new AbortController()
    usageAbort.current = abort
    setUsageLoading(true)
    try {
      const response = await fetch(`${path}/usage?workspace=${encodeURIComponent(workspaceId)}`, { cache: 'no-store', credentials: 'same-origin', signal: abort.signal })
      if (!response.ok) throw new Error('Subscription usage unavailable')
      const result = subscriptionUsageSchema.parse(await response.json())
      if (!abort.signal.aborted) setUsage(new Map(result.connections.map(item => [item.id, item])))
    } catch { if (!abort.signal.aborted) setUsage('failed') } finally { if (usageAbort.current === abort) setUsageLoading(false); setNow(Date.now()) }
  }, [workspaceId])
  useEffect(() => {
    if (!connectedKey) return
    void loadUsage()
    const read = setInterval(() => { if (document.visibilityState === 'visible') void loadUsage() }, USAGE_EVERY_MS)
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => { clearInterval(read); clearInterval(tick); usageAbort.current?.abort() }
  }, [connectedKey, loadUsage])
  useEffect(() => {
    if (!attempt || attempt.flow !== 'device' || !attempt.interval) return
    let stopped = false
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (stopped) return
      if (Date.now() >= Date.parse(attempt.expiresAt)) { setAttempt(null); setError(t('expired')); return }
      try {
        const result = await post({ action: 'poll', connectionId: attempt.connectionId, state: attempt.state }, abort.signal) as { pending?: unknown; state?: unknown }
        if (stopped) return
        if (result.pending === true) { timer = setTimeout(poll, (attempt.interval! + 1) * 1000); return }
        if (result.state !== 'connected') throw new Error('Subscription connection failed')
        setAttempt(null); setNotice(t('connectedNotice')); await refresh()
      } catch { if (!stopped) { setAttempt(null); setError(t('connectionFailed')); void refresh().catch(() => undefined) } }
    }
    timer = setTimeout(poll, (attempt.interval + 1) * 1000)
    return () => { stopped = true; clearTimeout(timer); abort.abort() }
  }, [attempt, refresh, t])

  async function connect(provider: Provider, existing?: { id: string; revision: number }) {
    setPending(true); setError(''); setNotice(''); setCallback('')
    try {
      const result = await post(existing ? { action: 'reconnect', connectionId: existing.id, revision: existing.revision } : { action: 'connect', workspaceId, provider })
      const value = existing && result && typeof result === 'object' ? { ...result, connectionId: existing.id } : result
      const next = parseSubscriptionStart(value, provider)
      if (Date.parse(next.expiresAt) <= Date.now()) throw new Error('Authorization expired')
      setAttempt({ ...next, provider })
      await refresh()
    } catch { setError(t('connectionFailed')) } finally { setPending(false) }
  }
  async function finishCallback() {
    if (!attempt || attempt.flow !== 'callback_handoff' || !callback.trim()) return
    setPending(true); setError('')
    try {
      const result = await post({ action: 'callback', connectionId: attempt.connectionId, state: attempt.state, callbackUrl: callback.trim() }) as { state?: unknown }
      if (result.state !== 'connected') throw new Error('Subscription connection failed')
      setAttempt(null); setNotice(t('connectedNotice')); await refresh()
    } catch { setError(t('connectionFailed')); void refresh().catch(() => undefined) } finally { setCallback(''); setPending(false) }
  }
  async function disconnect(connection: { id: string; revision: number }) {
    setPending(true); setError(''); setNotice('')
    try { await post({ action: 'disconnect', connectionId: connection.id, revision: connection.revision }); await refresh(); setNotice(t('disconnectedNotice')) }
    catch { setError(t('disconnectFailed')) } finally { setPending(false) }
  }

  if (loadFailed) return <p role="alert" className="px-1 text-sm text-destructive">{t('loadFailed')}</p>
  if (!state?.enabled) return null
  return <div className="flex flex-col gap-3">
    <SettingsSection id="subscriptions-heading" title={t('heading')} description={t('description')}>
      {(['codex', 'claude'] as const).map(provider => {
        const available = state.providers.some(item => item.provider === provider && item.available)
        const connections = state.connections.filter(item => item.provider === provider)
        const Logo = logos[provider]
        return <div key={provider} className="divide-y divide-border">
          <SettingRow title={t(provider)} description={available ? undefined : t('unavailable')}>
            <Button type="button" variant="secondary" size="sm" disabled={!available || pending || !!attempt} onClick={() => { void connect(provider) }}>{connections.some(item => item.state === 'connected') ? t('connectAnother') : t('connect')}</Button>
          </SettingRow>
          {connections.map(connection => {
            const read = connection.state === 'connected' && usage ? usage === 'failed' ? undefined : usage.get(connection.id) : undefined
            const failed = connection.state === 'connected' && (usage === 'failed' || read?.status === 'unavailable')
            const reauth = connection.state === 'reconnect_required' || read?.status === 'reauth'
            const connected = connection.state === 'connected' && !reauth
            const account = read?.account ?? connection.account ?? null
            const plan = read?.plan ? t('codexPlan', { plan: read.plan }) : null
            const product = provider === 'codex' ? plan ?? t('codexProduct') : t('claudeProduct')
            const updated = read?.status === 'ok' ? Math.max(0, Math.floor((now - Date.parse(read.observedAt)) / 60_000)) : null
            const bots = connection.bots ?? []
            return <div key={connection.id} className="flex flex-col gap-3 px-5 py-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <Logo className="size-5 text-foreground" />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">{account ?? product}</span>
                    {account && <span className="text-xs text-muted-foreground">{product}</span>}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:justify-end">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span aria-hidden="true" className={cn('size-2 rounded-full', connected ? 'bg-success' : reauth ? 'bg-warning' : 'bg-muted-foreground')} />
                    {connected ? t('connected') : reauth ? t('reauth') : t('notConnected')}
                  </span>
                  <span className="flex items-center gap-2">
                    {(reauth || connection.state !== 'connected') && <Button type="button" variant="secondary" size="sm" disabled={!available || pending || !!attempt} onClick={() => { void connect(provider, connection) }}>{t('reconnect')}</Button>}
                    <Button type="button" variant={connection.state === 'connected' && !reauth ? 'secondary' : 'ghost'} size="sm" disabled={pending || !!attempt} onClick={() => { void disconnect(connection) }}>{connection.state === 'connected' ? t('disconnect') : t('remove')}</Button>
                  </span>
                </div>
              </div>
              {connection.state === 'connected' && !reauth && <div className="flex flex-col gap-2 sm:pl-8">
                {failed
                  ? <span className="flex items-center gap-2 text-xs text-muted-foreground">{t('quotaUnavailable')}<Button type="button" variant="secondary" size="xs" disabled={usageLoading} onClick={() => { void loadUsage() }}>{t('retry')}</Button></span>
                  : read && <QuotaMeters windows={read.windows} now={now} />}
                {read?.status === 'ok' && <p className="text-xs text-muted-foreground">{[updated !== null && (updated < 1 ? t('updatedJustNow') : t('updatedAgo', { minutes: updated })), t('whenExhausted')].filter(Boolean).join(' · ')}</p>}
                {bots.length > 0 && <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {t('usedBy')}
                  {bots.map(bot => <span key={bot.id} className="flex items-center gap-1 text-foreground"><BotAvatar color={bot.color} shape={bot.shape} size="row" label={bot.name} />{bot.name}</span>)}
                </span>}
              </div>}
            </div>
          })}
        </div>
      })}
    </SettingsSection>
    {attempt && <div className="flex flex-col gap-2 px-1 text-sm">
      <p>{attempt.flow === 'device' ? t('deviceInstructions') : t('callbackInstructions')}</p>
      {attempt.userCode && <p className="font-mono font-semibold select-all">{attempt.userCode}</p>}
      <a className="w-fit text-sidebar-primary underline underline-offset-4" href={attempt.authorizationUrl} target="_blank" rel="noopener noreferrer">{t('openProvider')}</a>
      {attempt.flow === 'callback_handoff' && <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void finishCallback() }}>
        <FieldGroup><Field><FieldLabel htmlFor="subscription-callback">{t('callbackLabel')}</FieldLabel>
          <Input id="subscription-callback" value={callback} autoComplete="off" spellCheck={false} maxLength={8192} onChange={event => setCallback(event.target.value)} />
        </Field></FieldGroup>
        <Button type="submit" className="w-fit" disabled={pending || !callback.trim()}>{t('finish')}</Button>
      </form>}
      <Button type="button" variant="ghost" size="sm" className="w-fit" disabled={pending} onClick={() => { setAttempt(null); setCallback(''); void refresh().catch(() => undefined) }}>{t('close')}</Button>
    </div>}
    {notice && <p role="status" className="px-1 text-sm">{notice}</p>}
    {error && <p role="alert" className="px-1 text-sm text-destructive">{error}</p>}
  </div>
}

/** What is left of each window the provider returned, with when it resets. */
function QuotaMeters({ windows, now }: { windows: SubscriptionUsageView['windows']; now: number }) {
  const t = useTranslations('Settings.subscriptions')
  const format = useFormatter()
  return <span className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:gap-x-6">
    {windows.map(window => {
      const label = window.model ? t('quotaWeeklyModel', { model: window.model }) : window.kind === 'five_hour' ? t('quotaFiveHour') : t('quotaWeekly')
      const at = window.resetsAt ? Date.parse(window.resetsAt) : NaN
      // Within a day the hour is enough; further out, the date.
      const reset = Number.isFinite(at) ? t('quotaReset', { time: at - now < 86_400_000 ? format.dateTime(at, { hour: '2-digit', minute: '2-digit' }) : format.dateTime(at, { month: 'short', day: 'numeric' }) }) : null
      const left = t('quotaLeft', { percent: window.remaining })
      return <span key={`${window.kind}-${window.model ?? ''}`} className="flex items-center gap-2 text-xs">
        <span className="min-w-10 text-muted-foreground">{label}</span>
        <Progress value={window.remaining} aria-label={[label, left, reset].filter(Boolean).join(' · ')} className={cn('w-12', window.remaining < 10 && '[&_[data-slot=progress-indicator]]:bg-destructive')} />
        <span className={cn('tabular-nums', window.remaining < 10 ? 'text-destructive' : 'text-foreground')}>{left}</span>
        {reset && <span className="text-muted-foreground">· {reset}</span>}
      </span>
    })}
  </span>
}
