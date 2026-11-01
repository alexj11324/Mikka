'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel, FieldError } from '@/components/ui/field'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { Claude } from '@/components/ui/svgs/claude'
import { OpenAI } from '@/components/ui/svgs/openai'
import { BotAvatar } from '@/components/nav/bot-avatar'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { withBasePath } from '@/lib/base-path'
import { bridgeFromWindow, type MikkaWindow } from '@/lib/platform/detect'
import { InvalidAuthorization, parseSubscriptionStart, subscriptionListSchema, subscriptionUsageSchema, type SubscriptionUsageView } from '@/lib/subscription-ui'
import { cn } from '@/lib/utils'

type Provider = 'codex' | 'claude'
type State = ReturnType<typeof subscriptionListSchema.parse>
type Attempt = ReturnType<typeof parseSubscriptionStart> & { provider: Provider }
const path = withBasePath('/api/subscriptions')
const logos = { codex: OpenAI, claude: Claude } as const
/** Comma re-reads a plan's windows every 5 minutes while the page is watched. */
const USAGE_EVERY_MS = 5 * 60_000
type Usage = Map<string, SubscriptionUsageView> | 'failed' | null
/** Shown under the provider's row; `again` restarts that provider's sign-in. */
type Failure = { provider: Provider; message: string; again?: { connectionId?: string } }

class RequestError extends Error {
  constructor(readonly code: string) { super(code) }
}
async function post(body: unknown, signal?: AbortSignal) {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal })
  if (!response.ok) {
    const result = await response.json().catch(() => null) as { error?: unknown } | null
    throw new RequestError(typeof result?.error === 'string' ? result.error : 'subscription_unavailable')
  }
  return response.json() as Promise<unknown>
}

/**
 * The provider ceremony stays in this page's memory, never chat or storage.
 * `extraRows` (the API keys and custom providers) and `action` (添加 API Key)
 * join the same list (「API 与订阅」, orchestration.md § 1).
 */
export function SubscriptionSettings({ workspaceId, extraRows, action }: { workspaceId: string; extraRows?: ReactNode[]; action?: ReactNode }) {
  const t = useTranslations('Settings.subscriptions')
  const [state, setState] = useState<State | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [callback, setCallback] = useState('')
  /** The desktop app is catching the browser's return, so there is nothing to paste. */
  const [catching, setCatching] = useState(false)
  const [pending, setPending] = useState(false)
  /** The sign-in being started, until its attempt exists. */
  const [starting, setStarting] = useState<{ provider: Provider; id?: string } | null>(null)
  const [error, setError] = useState<Failure | null>(null)
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
  const failureMessage = useCallback((failure: unknown, key: 'startFailed' | 'finishFailed', provider: Provider) => {
    if (failure instanceof InvalidAuthorization) return t('refusedPage', { provider: t(provider) })
    const code = failure instanceof RequestError ? failure.code : ''
    if (code === 'auth_required') return t('signedOut')
    if (code === 'backend_unavailable') return t('refusedOff')
    if (code === 'account_unavailable') return t('refusedAccount', { provider: t(provider) })
    if (code === 'secret_store_unavailable' || code === 'secret_create_outcome_unknown' || code === 'metadata_unavailable') return t('refusedStore', { provider: t(provider) })
    if (code === 'provider_operation_failed') return t('refusedProvider', { provider: t(provider) })
    return t(key, { provider: t(provider) })
  }, [t])
  const loadUsage = useCallback(async (force = false) => {
    usageAbort.current?.abort()
    const abort = new AbortController()
    usageAbort.current = abort
    setUsageLoading(true)
    try {
      const response = await fetch(`${path}/usage?workspace=${encodeURIComponent(workspaceId)}${force ? '&refresh=1' : ''}`, { cache: 'no-store', credentials: 'same-origin', signal: abort.signal })
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
      const again = { connectionId: attempt.connectionId }
      if (Date.now() >= Date.parse(attempt.expiresAt)) { setAttempt(null); setError({ provider: attempt.provider, message: t('expired', { provider: t(attempt.provider) }), again }); return }
      try {
        const result = await post({ action: 'poll', connectionId: attempt.connectionId, state: attempt.state }, abort.signal) as { pending?: unknown; state?: unknown }
        if (stopped) return
        if (result.pending === true) { timer = setTimeout(poll, (attempt.interval! + 1) * 1000); return }
        if (result.state !== 'connected') throw new Error('Subscription connection failed')
        setAttempt(null); setNotice(t('connectedNotice')); await refresh()
      } catch (failure) { if (!stopped) { setAttempt(null); setError({ provider: attempt.provider, message: failureMessage(failure, 'finishFailed', attempt.provider), again }); void refresh().catch(() => undefined) } }
    }
    timer = setTimeout(poll, (attempt.interval + 1) * 1000)
    return () => { stopped = true; clearTimeout(timer); abort.abort() }
  }, [attempt, failureMessage, refresh, t])

  const submitLatest = useRef(submitCallback)
  useEffect(() => { submitLatest.current = submitCallback })
  useEffect(() => {
    const catcher = bridgeFromWindow(window as MikkaWindow)?.app.claudeCallback
    if (attempt?.flow !== 'callback_handoff' || !catcher) return
    let stopped = false
    setCatching(true)
    catcher(attempt.authorizationUrl).then(callbackUrl => {
      if (stopped) return
      setCatching(false)
      if (callbackUrl) void submitLatest.current(attempt, callbackUrl)
      else { setAttempt(null); setError({ provider: attempt.provider, message: t('expired', { provider: t(attempt.provider) }), again: { connectionId: attempt.connectionId } }) }
    }, () => { if (!stopped) setCatching(false) }) // The port is taken: the paste below still works.
    return () => { stopped = true; setCatching(false) }
  }, [attempt, t])

  async function connect(provider: Provider, existing?: { id: string; revision: number }) {
    setPending(true); setStarting({ provider, id: existing?.id }); setError(null); setNotice(''); setCallback('')
    // A tab opened after the request would be blocked, so hold it now. The desktop app opens the system browser instead.
    const tab = bridgeFromWindow(window as MikkaWindow) ? null : window.open('', '_blank')
    try {
      const result = await post(existing ? { action: 'reconnect', connectionId: existing.id, revision: existing.revision } : { action: 'connect', workspaceId, provider })
      const value = existing && result && typeof result === 'object' ? { ...result, connectionId: existing.id } : result
      const next = parseSubscriptionStart(value, provider)
      if (Date.parse(next.expiresAt) <= Date.now()) throw new Error('Authorization expired')
      if (tab) { tab.opener = null; tab.location.href = next.authorizationUrl }
      setAttempt({ ...next, provider })
    } catch (failure) { tab?.close(); setError({ provider, message: failureMessage(failure, 'startFailed', provider), again: existing ? { connectionId: existing.id } : {} }) } finally { setPending(false); setStarting(null) }
    // The started attempt stands even if the list cannot be re-read right now.
    void refresh().catch(() => undefined)
  }
  async function finishCallback() {
    if (!attempt || attempt.flow !== 'callback_handoff' || !callback.trim()) return
    await submitCallback(attempt, callback.trim())
  }
  async function submitCallback(attempt: Attempt, callbackUrl: string) {
    setPending(true); setError(null)
    try {
      const result = await post({ action: 'callback', connectionId: attempt.connectionId, state: attempt.state, callbackUrl }) as { state?: unknown }
      if (result.state !== 'connected') throw new Error('Subscription connection failed')
      setAttempt(null); setNotice(t('connectedNotice')); await refresh()
    } catch (failure) { setAttempt(null); setError({ provider: attempt.provider, message: failureMessage(failure, 'finishFailed', attempt.provider), again: { connectionId: attempt.connectionId } }); void refresh().catch(() => undefined) } finally { setCallback(''); setPending(false) }
  }
  async function disconnect(connection: { id: string; provider: Provider; revision: number }) {
    setPending(true); setError(null); setNotice('')
    try { await post({ action: 'disconnect', connectionId: connection.id, revision: connection.revision }); await refresh(); setNotice(t('disconnectedNotice')) }
    catch { setError({ provider: connection.provider, message: t('disconnectFailed') }) } finally { setPending(false) }
  }
  async function remove(connection: { id: string; provider: Provider; revision: number }) {
    setPending(true); setError(null); setNotice('')
    try { await post({ action: 'remove', connectionId: connection.id, revision: connection.revision }); await refresh() }
    catch { setError({ provider: connection.provider, message: t('removeFailed') }) } finally { setPending(false) }
  }
  /** 重新开始: the same connection when there is one (its revision read now), else a new one. */
  function startAgain(failure: Failure) {
    const existing = failure.again?.connectionId ? state?.connections.find(item => item.id === failure.again?.connectionId) : undefined
    void connect(failure.provider, existing)
  }

  // Without the subscription service the API keys still form the list.
  const status = loadFailed ? <FieldError className="px-1">{t('loadFailed')}</FieldError>
    : !state ? <p role="status" className="px-1 text-sm text-muted-foreground">{t('loading')}</p>
      : !state.enabled ? <p role="status" className="px-1 text-sm text-muted-foreground">{t('serviceOff')}</p> : null
  if (status || !state) return <div className="flex flex-col gap-3">
    {extraRows?.length ? <SettingsSection action={action}>{extraRows}</SettingsSection> : action && <div className="flex justify-end">{action}</div>}
    {status}
  </div>
  return <div className="flex flex-col gap-3">
    <SettingsSection action={action}>
      {(['codex', 'claude'] as const).map(provider => {
        const available = state.providers.some(item => item.provider === provider && item.available)
        const connections = state.connections.filter(item => item.provider === provider)
        const Logo = logos[provider]
        const failure = error?.provider === provider ? error : null
        return <div key={provider} className="divide-y divide-border">
          {connections.length === 0 && <SettingRow icon={<Logo className={cn('size-5 shrink-0 text-foreground', provider === 'claude' && 'text-brand-claude')} />} title={t(provider)} description={available ? undefined : t('unavailable')}>
            <SignInButton busy={(starting?.provider === provider && !starting.id) || attempt?.provider === provider} disabled={!available || pending || !!attempt} label={t('connect')} busyLabel={t('connecting')} onClick={() => { void connect(provider) }} />
          </SettingRow>}
          {connections.map(connection => {
            const live = connection.state === 'connected'
            const read = live && usage && usage !== 'failed' ? usage.get(connection.id) : undefined
            const failed = live && (usage === 'failed' || read?.status === 'unavailable')
            // reauth: the runtime's own reconnect_required, or the provider refused this read.
            const reauth = connection.state === 'reconnect_required' || read?.status === 'reauth'
            const refused = read?.status === 'extra_usage' || read?.status === 'unverified'
            const healthy = live && !reauth && !refused
            const account = read?.account ?? connection.account ?? null
            const plan = read?.plan ? t('codexPlan', { plan: read.plan }) : null
            const product = provider === 'codex' ? plan ?? t('codexProduct') : t('claudeProduct')
            const updated = read && read.status !== 'unavailable' && read.status !== 'reauth' ? Math.max(0, Math.floor((now - Date.parse(read.observedAt)) / 60_000)) : null
            const bots = connection.bots ?? []
            return <div key={connection.id} className="flex flex-col gap-3 px-5 py-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <Logo className={cn('size-5 shrink-0 text-foreground', provider === 'claude' && 'text-brand-claude')} />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">{account ?? product}</span>
                    {account && <span className="text-xs text-muted-foreground">{product}</span>}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:justify-end">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span aria-hidden="true" className={cn('size-2 rounded-full', healthy ? 'bg-success' : reauth || refused ? 'bg-warning' : 'bg-muted-foreground')} />
                    {reauth ? t('reauth') : refused ? t('notInUse') : live ? t('connected') : t('notConnected')}
                  </span>
                  <span className="flex items-center gap-2">
                    {(reauth || !live) && <SignInButton busy={starting?.id === connection.id || attempt?.connectionId === connection.id} disabled={!available || pending || !!attempt} label={t('reconnect')} busyLabel={t('connecting')} onClick={() => { void connect(provider, connection) }} />}
                    {live
                      ? <Button type="button" variant={reauth ? 'ghost' : 'secondary'} size="sm" disabled={pending || !!attempt} onClick={() => { void disconnect(connection) }}>{t('disconnect')}</Button>
                      : <Button type="button" variant="ghost" size="sm" disabled={pending || !!attempt} onClick={() => { void remove(connection) }}>{t('remove')}</Button>}
                  </span>
                </div>
              </div>
              {(live || reauth) && <div className="flex flex-col gap-2 sm:pl-8">
                {refused && <p className="text-xs text-foreground">{read?.status === 'unverified' ? t('extraUsageUnverified') : provider === 'claude' ? `${t('extraUsageOn')} · ${t('extraUsageClaudeFix')}` : t('extraUsageOn')}</p>}
                {failed
                  ? <span className="flex items-center gap-2 text-xs text-muted-foreground">{t('quotaUnavailable')}<Button type="button" variant="secondary" size="xs" disabled={usageLoading} onClick={() => { void loadUsage(true) }}>{t('retry')}</Button></span>
                  : read && read.windows.length > 0 && <QuotaMeters windows={read.windows} now={now} />}
                {updated !== null && <p className="text-xs text-muted-foreground">{updated < 1 ? t('updatedJustNow') : t('updatedAgo', { minutes: updated })}</p>}
                {bots.length > 0 && <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {t('usedBy')}
                  {bots.map(bot => <span key={bot.id} className="flex items-center gap-1 text-foreground"><BotAvatar color={bot.color} shape={bot.shape} size="row" label={bot.name} />{bot.name}</span>)}
                </span>}
              </div>}
            </div>
          })}
          {failure && <div className="px-5 py-3">
            <Alert variant="destructive" role="alert">
              <AlertDescription>{failure.message}</AlertDescription>
              {failure.again && available && <AlertAction><Button variant="outline" size="sm" disabled={pending || !!attempt} onClick={() => startAgain(failure)}>{t('restart')}</Button></AlertAction>}
            </Alert>
          </div>}
        </div>
      })}
      {extraRows}
    </SettingsSection>
    {attempt && <div className="flex flex-col gap-2 px-1 text-sm">
      <p role="status">{attempt.flow === 'device' ? t('deviceInstructions') : catching ? t('browserInstructions') : t('callbackInstructions')}</p>
      {attempt.userCode && <p className="font-mono font-semibold select-all">{attempt.userCode}</p>}
      <a className="w-fit text-sidebar-primary underline underline-offset-4" href={attempt.authorizationUrl} target="_blank" rel="noopener noreferrer">{t('openProvider')}</a>
      {attempt.flow === 'callback_handoff' && !catching && <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void finishCallback() }}>
        <FieldGroup><Field><FieldLabel htmlFor="subscription-callback">{t('callbackLabel')}</FieldLabel>
          <Input id="subscription-callback" value={callback} autoComplete="off" spellCheck={false} maxLength={8192} onChange={event => setCallback(event.target.value)} />
        </Field></FieldGroup>
        <Button type="submit" className="w-fit" disabled={pending || !callback.trim()}>{t('finish')}</Button>
      </form>}
      <Button type="button" variant="ghost" size="sm" className="w-fit" disabled={pending} onClick={() => { setAttempt(null); setCallback(''); void refresh().catch(() => undefined) }}>{t('close')}</Button>
    </div>}
    {notice && <p role="status" className="px-1 text-sm">{notice}</p>}
  </div>
}

function SignInButton({ busy, disabled, label, busyLabel, onClick }: { busy: boolean; disabled: boolean; label: string; busyLabel: string; onClick: () => void }) {
  return <Button type="button" variant="secondary" size="sm" disabled={disabled} aria-busy={busy} onClick={onClick}>{busy ? <><Spinner className="size-3.5" aria-hidden="true" />{busyLabel}</> : label}</Button>
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
      const reset = Number.isFinite(at) ? t('quotaReset', { time: at - now < 86_400_000 ? format.dateTime(at, { hour: '2-digit', minute: '2-digit' }) : format.dateTime(at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }) : null
      const left = t('quotaLeft', { percent: window.remaining })
      return <span key={`${window.kind}-${window.model ?? ''}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        <span className="min-w-10 whitespace-nowrap text-muted-foreground">{label}</span>
        <Progress value={window.remaining} aria-label={[label, left, reset].filter(Boolean).join(' · ')} className={cn('w-12', window.remaining < 10 && '[&_[data-slot=progress-indicator]]:bg-destructive')} />
        <span className={cn('whitespace-nowrap tabular-nums', window.remaining < 10 ? 'text-destructive' : 'text-foreground')}>{left}</span>
        {reset && <span className="whitespace-nowrap text-muted-foreground">· {reset}</span>}
      </span>
    })}
  </span>
}
