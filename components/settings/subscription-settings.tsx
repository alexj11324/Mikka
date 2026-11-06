'use client'

import { ReadResponseError } from '@/lib/swr/retry'
import { settingsKeys } from '@/lib/swr/keys'
import { useCallback, useEffect, useRef, useState } from 'react'
import useSWR, { unstable_serialize, useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { refreshSubscriptionModels } from '@/app/actions/model-order'
import { useLiveKey } from '@/hooks/use-live-key'
import { modelOrderKey } from '@/components/settings/model-order-settings'
import { Check, Copy, MoreHorizontal, RefreshCw, TriangleAlert } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel, FieldError } from '@/components/ui/field'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Claude } from '@/components/ui/svgs/claude'
import { OpenAI } from '@/components/ui/svgs/openai'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { Skeleton } from '@/components/ui/skeleton'
import { withBasePath } from '@/lib/base-path'
import { bridgeFromWindow, type MikkaWindow } from '@/lib/platform/detect'
import { InvalidAuthorization, parseSubscriptionStart, planName, subscriptionListSchema, subscriptionSignInState, subscriptionUsageSchema, type SubscriptionUsageView } from '@/lib/subscription-ui'
import { cn } from '@/lib/utils'

type Provider = 'codex' | 'claude'
type State = ReturnType<typeof subscriptionListSchema.parse>
type Attempt = ReturnType<typeof parseSubscriptionStart> & { provider: Provider }
const path = withBasePath('/api/subscriptions')
const logos = { codex: OpenAI, claude: Claude } as const
/** Meters older than this read again when the page comes back into focus; nothing re-reads them on a timer (#1212). */
const USAGE_FRESH_FOR_MS = 5 * 60_000
type Usage = Map<string, SubscriptionUsageView> | 'failed' | null
/** Shown under the provider's row; `again` restarts that provider's sign-in. */
type Failure = { provider: Provider; message: string; again?: { connectionId?: string; resume?: boolean } }

class RequestError extends Error {
  constructor(readonly code: string) { super(code) }
}
function canRetryResume(failure: unknown) {
  return !(failure instanceof RequestError && ['acquire_expired', 'stale_operation', 'reconnect_required'].includes(failure.code))
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
 * The bounded provider ceremony lives on the server; this page resumes it.
 * Authorization URLs and codes never go into chat or browser storage.
 * The subscriptions are their own group on 「API 与订阅」; API keys are the
 * next one (decision 2026-11-02-1200).
 */
/** `heading` replaces the section title where the rows appear outside Settings (the first-run guide's 绑定订阅). */
export function SubscriptionSettings({ workspaceId, heading }: { workspaceId: string; heading?: string }) {
  const t = useTranslations('Settings.subscriptions')
  // Cached per workspace: a return to the page shows the last list at once and re-reads it behind.
  const list = useSWR(subscriptionsKey(workspaceId), () => readSubscriptions(workspaceId), { revalidateOnFocus: false })
  const state = list.data ?? null
  const loadFailed = !list.data && !!list.error
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const attemptRef = useRef<Attempt | null>(null)
  const observedAttempt = useRef(false)
  const request = useRef<AbortController | null>(null)
  const changeAttempt = useCallback((next: Attempt | null) => { observedAttempt.current = false; attemptRef.current = next; setAttempt(next) }, [])
  const beginRequest = useCallback(() => {
    request.current?.abort()
    const next = new AbortController()
    request.current = next
    return next
  }, [])
  // Leaving a page/dialog stops this client's work, retaining the same bounded server attempt.
  // Explicit Cancel below is the only action that disconnects an unfinished sign-in.
  useEffect(() => () => { request.current?.abort(); attemptRef.current = null }, [])
  const [callback, setCallback] = useState('')
  /** The desktop app is catching the browser's return, so there is nothing to paste. */
  const [catching, setCatching] = useState(false)
  const [pending, setPending] = useState(false)
  /** The sign-in being started, until its attempt exists. */
  const [starting, setStarting] = useState<{ provider: Provider; id?: string } | null>(null)
  const [error, setError] = useState<Failure | null>(null)
  const [notice, setNotice] = useState('')
  // 断开连接 asks first, like deleting an API key (A1).
  const [disconnecting, setDisconnecting] = useState<{ id: string; provider: Provider; revision: number; label: string } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const connectedKey = state?.connections.filter(item => item.state === 'connected').map(item => `${item.id}:${item.revision}`).join(',') ?? ''
  const { mutate } = list
  // The allowed models' candidates follow the connected accounts.
  // The workspace's own SWR cache (workspace-app.tsx), not swr's global one: 启用 and a disconnect re-read 优先使用的模型.
  const { mutate: mutateCached } = useSWRConfig()
  const refresh = useCallback(async () => { await mutate(); void mutateCached(modelOrderKey(workspaceId)) }, [mutate, mutateCached, workspaceId])
  // Connected, paused or removed elsewhere (another tab, the desktop app's sign-in): this list re-reads (no polling).
  // A quota read that changes what the page shows (额度用完, 待检查) pushes the same key: the meters re-read too.
  useLiveKey('model_settings', workspaceId, [unstable_serialize(subscriptionsKey(workspaceId))], workspaceId, { minIntervalMs: 2_000 })
  useLiveKey('model_settings', connectedKey ? workspaceId : null, [unstable_serialize(subscriptionUsageKey(workspaceId))], workspaceId, { minIntervalMs: 2_000 })
  /** 刷新模型: the account is asked for its models again; 优先使用的模型 shows the answer, a model gone marked unavailable. */
  const [refreshingModels, setRefreshingModels] = useState<string | null>(null)
  const refreshModels = useCallback(async (connection: { id: string; label: string }) => {
    setRefreshingModels(connection.id)
    const id = toast.loading(t('refreshingModels', { label: connection.label }))
    try {
      const result = await refreshSubscriptionModels(connection.id, workspaceId)
      if (result.error) throw new Error(result.error)
      await mutateCached(modelOrderKey(workspaceId), result.view, { revalidate: false })
      toast.success(t('modelsRefreshed', { label: connection.label, count: result.models }), { id })
    } catch {
      toast.error(t('modelsRefreshFailed', { label: connection.label }), { id })
    } finally { setRefreshingModels(null) }
  }, [mutateCached, t, workspaceId])
  const failureMessage = useCallback((failure: unknown, key: 'startFailed' | 'finishFailed', provider: Provider) => {
    if (failure instanceof InvalidAuthorization) return t('refusedPage', { provider: t(provider) })
    const code = failure instanceof RequestError ? failure.code : ''
    if (code === 'auth_required') return t('signedOut')
    if (code === 'backend_unavailable') return t('refusedOff')
    if (code === 'account_unavailable') return t('refusedAccount', { provider: t(provider) })
    if (code === 'secret_store_unavailable' || code === 'secret_create_outcome_unknown' || code === 'metadata_unavailable') return t('refusedStore', { provider: t(provider) })
    if (code === 'provider_operation_failed') return t('refusedProvider', { provider: t(provider) })
    if (code === 'acquire_expired') return t('expired', { provider: t(provider) })
    if (code === 'stale_operation' || code === 'reconnect_required') return t('authorizationEnded', { provider: t(provider) })
    if (code === 'credential_busy') return t('signInPreparing', { provider: t(provider) })
    return t(key, { provider: t(provider) })
  }, [t])
  // The meters are cached too. They re-read on the settings key above, and when the page comes back into focus
  // with meters older than five minutes; the 30 s clock below only ages their 已更新 label.
  const usageRead = useSWR(connectedKey ? subscriptionUsageKey(workspaceId) : null, () => readSubscriptionUsage(workspaceId), { focusThrottleInterval: USAGE_FRESH_FOR_MS })
  const usage: Usage = usageRead.error ? 'failed' : usageRead.data ?? null
  const usageLoading = usageRead.isValidating
  const { mutate: mutateUsage } = usageRead
  // A connection added, signed in again or removed after the list was on screen: read the meters again.
  // The list's first answer is not a change, so the prefetched meters stand.
  const readFor = useRef(connectedKey)
  useEffect(() => {
    const before = readFor.current
    readFor.current = connectedKey
    if (before && connectedKey && before !== connectedKey) void mutateUsage()
  }, [connectedKey, mutateUsage])
  // A retry that fails again leaves 暂时无法读取 on screen.
  const reloadUsage = useCallback(() => { void mutateUsage(readSubscriptionUsage(workspaceId, true), { revalidate: false }).catch(() => undefined) }, [mutateUsage, workspaceId])
  const usageData = usageRead.data
  useEffect(() => { setNow(Date.now()) }, [usageData, usageRead.error])
  useEffect(() => {
    if (!connectedKey) return
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(tick)
  }, [connectedKey])
  // One deadline notification covers both flows and interrupted rows. It does not poll for data.
  const deadlines = [attempt?.expiresAt, ...(state?.connections.filter(item => item.state === 'pending').map(item => item.activeAttempt?.expiresAt) ?? [])]
    .flatMap(value => value && Date.parse(value) > now ? [Date.parse(value)] : [])
  const nextExpiry = deadlines.length ? Math.min(...deadlines) : null
  useEffect(() => {
    if (nextExpiry === null) return
    const timer = setTimeout(() => {
      const time = Date.now()
      setNow(time)
      const current = attemptRef.current
      if (current && Date.parse(current.expiresAt) <= time) {
        request.current?.abort(); changeAttempt(null); setCallback(''); setCatching(false); setPending(false)
        setError({ provider: current.provider, message: t('expired', { provider: t(current.provider) }), again: { connectionId: current.connectionId } })
      }
      void refresh().catch(() => undefined)
    }, Math.max(0, nextExpiry - Date.now()))
    return () => clearTimeout(timer)
  }, [nextExpiry, changeAttempt, refresh, t])
  useEffect(() => {
    // A stale poll/resume or the local deadline can finish before the successful
    // list read. Its old recovery action must not restart a connected account.
    if (error?.again?.connectionId && state?.connections.some(item => item.id === error.again?.connectionId && item.state === 'connected')) setError(null)
    const current = attemptRef.current
    if (!current || !state) return
    const connection = state.connections.find(item => item.id === current.connectionId)
    if (!connection) {
      // A new start may precede its first list read. Absence becomes terminal
      // only after this exact attempt has appeared in the list at least once.
      if (!observedAttempt.current) return
      request.current?.abort(); changeAttempt(null); setCallback(''); setCatching(false); setPending(false); setStarting(null)
      return
    }
    if (connection.revision < current.revision) return
    if (connection.revision === current.revision) observedAttempt.current = true
    if (connection.state === 'connected') { changeAttempt(null); setCallback(''); setError(null) }
    else if (connection.state === 'reconnect_required') {
      request.current?.abort(); changeAttempt(null); setCallback(''); setCatching(false); setPending(false)
      setError({ provider: current.provider, message: t(connection.lastErrorCode === 'acquire_expired' ? 'expired' : 'authorizationEnded', { provider: t(current.provider) }), again: { connectionId: current.connectionId } })
    }
  }, [state, attempt, error, changeAttempt, t])
  useEffect(() => {
    if (!attempt || attempt.flow !== 'device' || !attempt.interval) return
    let stopped = false
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (stopped || attemptRef.current !== attempt) return
      const again = { connectionId: attempt.connectionId, resume: true }
      if (Date.now() >= Date.parse(attempt.expiresAt)) return
      try {
        const result = await post({ action: 'poll', connectionId: attempt.connectionId, state: attempt.state }, abort.signal) as { pending?: unknown; state?: unknown }
        if (stopped || attemptRef.current !== attempt) return
        if (result.pending === true) { timer = setTimeout(poll, (attempt.interval! + 1) * 1000); return }
        if (result.state !== 'connected') throw new Error('Subscription connection failed')
        changeAttempt(null); await refresh()
      } catch (failure) { if (!stopped && attemptRef.current === attempt) { changeAttempt(null); setError({ provider: attempt.provider, message: failureMessage(failure, 'finishFailed', attempt.provider), again: { ...again, resume: canRetryResume(failure) } }); void refresh().catch(() => undefined) } }
    }
    timer = setTimeout(poll, (attempt.interval + 1) * 1000)
    return () => { stopped = true; clearTimeout(timer); abort.abort() }
  }, [attempt, changeAttempt, failureMessage, refresh])

  const submitLatest = useRef(submitCallback)
  useEffect(() => { submitLatest.current = submitCallback })
  useEffect(() => {
    const catcher = bridgeFromWindow(window as MikkaWindow)?.app.claudeCallback
    if (attempt?.flow !== 'callback_handoff' || !catcher) return
    let stopped = false
    setCatching(true)
    catcher(attempt.authorizationUrl).then(callbackUrl => {
      if (stopped || attemptRef.current !== attempt) return
      // Still catching while the return is submitted: ending the attempt ends it, and no paste field flashes.
      if (callbackUrl) void submitLatest.current(attempt, callbackUrl)
      else { setCatching(false); changeAttempt(null); setError({ provider: attempt.provider, message: t('authorizationEnded', { provider: t(attempt.provider) }), again: { connectionId: attempt.connectionId, resume: true } }) }
    }, () => { if (!stopped) setCatching(false) }) // The port is taken: the paste below still works.
    return () => { stopped = true; setCatching(false) }
  }, [attempt, changeAttempt, t])

  async function connect(provider: Provider, existing?: { id: string; revision: number }, resume = false) {
    const abort = beginRequest()
    setPending(true); setStarting({ provider, id: existing?.id }); setError(null); setNotice(''); setCallback('')
    // A tab opened after the request would be blocked, so hold it now. The desktop app opens the system browser instead.
    const tab = bridgeFromWindow(window as MikkaWindow) ? null : window.open('', '_blank')
    try {
      const result = await post(existing ? resume ? { action: 'resume', connectionId: existing.id } : { action: 'reconnect', connectionId: existing.id, revision: existing.revision } : { action: 'connect', workspaceId, provider }, abort.signal)
      if (abort.signal.aborted) { tab?.close(); return }
      const value = existing && result && typeof result === 'object' ? { ...result, connectionId: existing.id } : result
      const next = parseSubscriptionStart(value, provider)
      if (Date.parse(next.expiresAt) <= Date.now()) throw new RequestError('acquire_expired')
      if (tab) { tab.opener = null; tab.location.href = next.authorizationUrl }
      // Set together with the attempt, so the paste field never flashes while the desktop app catches the return.
      if (next.flow === 'callback_handoff' && bridgeFromWindow(window as MikkaWindow)?.app.claudeCallback) setCatching(true)
      changeAttempt({ ...next, provider })
    } catch (failure) {
      tab?.close()
      if (!abort.signal.aborted) setError({ provider, message: failureMessage(failure, 'startFailed', provider), again: existing ? { connectionId: existing.id, resume: resume && canRetryResume(failure) } : {} })
    } finally { if (!abort.signal.aborted) { setPending(false); setStarting(null) } }
    // The started attempt stands even if the list cannot be re-read right now.
    if (!abort.signal.aborted) void refresh().catch(() => undefined)
  }
  async function finishCallback() {
    if (!attempt || attempt.flow !== 'callback_handoff' || !callback.trim()) return
    await submitCallback(attempt, callback.trim())
  }
  async function submitCallback(attempt: Attempt, callbackUrl: string) {
    const abort = beginRequest()
    setPending(true); setError(null)
    try {
      const result = await post({ action: 'callback', connectionId: attempt.connectionId, state: attempt.state, callbackUrl }, abort.signal) as { state?: unknown }
      if (abort.signal.aborted || attemptRef.current !== attempt) return
      if (result.state !== 'connected') throw new Error('Subscription connection failed')
      changeAttempt(null); await refresh()
    } catch (failure) { if (!abort.signal.aborted && attemptRef.current === attempt) { changeAttempt(null); setError({ provider: attempt.provider, message: failureMessage(failure, 'finishFailed', attempt.provider), again: { connectionId: attempt.connectionId, resume: canRetryResume(failure) } }); void refresh().catch(() => undefined) } } finally { if (!abort.signal.aborted) { setCallback(''); setPending(false) } }
  }
  async function disconnect(connection: { id: string; provider: Provider; revision: number }) {
    setPending(true); setError(null); setNotice('')
    try { await post({ action: 'disconnect', connectionId: connection.id, revision: connection.revision }); await refresh(); setNotice(t('disconnectedNotice')) }
    catch { setError({ provider: connection.provider, message: t('disconnectFailed') }) } finally { setPending(false) }
  }
  async function setPaused(connection: { id: string; provider: Provider }, paused: boolean) {
    setPending(true); setError(null); setNotice('')
    try { await post({ action: 'pause', connectionId: connection.id, paused }); await refresh() }
    catch { setError({ provider: connection.provider, message: t('pauseFailed') }) } finally { setPending(false) }
  }
  async function remove(connection: { id: string; provider: Provider; revision: number }) {
    setPending(true); setError(null); setNotice('')
    try { await post({ action: 'remove', connectionId: connection.id, revision: connection.revision }); await refresh() }
    catch { setError({ provider: connection.provider, message: t('removeFailed') }) } finally { setPending(false) }
  }
  async function cancel() {
    const current = attemptRef.current
    if (!current) return
    const abort = beginRequest()
    changeAttempt(null); setCallback(''); setCatching(false); setPending(true); setError(null); setNotice('')
    try {
      await post({ action: 'disconnect', connectionId: current.connectionId, revision: current.revision }, abort.signal)
      if (abort.signal.aborted) return
      await mutate(value => value ? { ...value, connections: value.connections.filter(item => item.id !== current.connectionId) } : value, { revalidate: false })
      setNotice(t('cancelledNotice'))
      void refresh().catch(() => undefined)
    } catch {
      if (!abort.signal.aborted) { setError({ provider: current.provider, message: t('cancelFailed'), again: { connectionId: current.connectionId, resume: true } }); void refresh().catch(() => undefined) }
    } finally { if (!abort.signal.aborted) setPending(false) }
  }
  /** 重新开始: the same connection when there is one (its revision read now), else a new one. */
  function startAgain(failure: Failure) {
    const existing = failure.again?.connectionId
      ? state?.connections.find(item => item.id === failure.again?.connectionId)
      : state?.connections.find(item => item.provider === failure.provider && subscriptionSignInState(item, Date.now()) === 'resume')
    if (existing?.state === 'connected') { setError(null); return }
    void connect(failure.provider, existing, !!existing && (!failure.again?.connectionId || failure.again.resume === true) && subscriptionSignInState(existing, Date.now()) === 'resume')
  }

  const status = loadFailed ? <FieldError className="px-1">{t('loadFailed')}</FieldError>
    : !state ? null
      : !state.enabled ? <p role="status" className="px-1 text-sm text-muted-foreground">{t('serviceOff')}</p> : null
  // First visit only: rows the size of the provider rows, so nothing moves when the list arrives.
  if (!state && !loadFailed) return <div role="status" aria-label={t('loading')} className="flex flex-col gap-1">
    <SettingsSection id="subscriptions-heading" title={heading ?? t('heading')}>
      {(['codex', 'claude'] as const).map(provider => <SubscriptionRowSkeleton key={provider} provider={provider} label={t(provider)} />)}
    </SettingsSection>
  </div>
  if (status || !state) return <section className="flex flex-col gap-1" aria-labelledby="subscriptions-heading">
    <h2 id="subscriptions-heading" className="pl-1 text-sm font-medium">{heading ?? t('heading')}</h2>
    {status}
  </section>
  // The oldest read on screen, so the line never overstates how fresh a meter is.
  const reads = usage && usage !== 'failed' ? state.connections.flatMap(connection => {
    const read = connection.state === 'connected' ? usage.get(connection.id) : undefined
    return read && read.status !== 'unavailable' && read.status !== 'reauth' ? [Date.parse(read.observedAt)] : []
  }) : []
  const updated = reads.length > 0 ? Math.max(0, Math.floor((now - Math.min(...reads)) / 60_000)) : null
  return <div className="flex flex-col gap-1">
    <SettingsSection id="subscriptions-heading" title={heading ?? t('heading')}>
      {(['codex', 'claude'] as const).map(provider => {
        const available = state.providers.some(item => item.provider === provider && item.available)
        const connections = state.connections.filter(item => item.provider === provider)
        const Logo = logos[provider]
        const failure = error?.provider === provider ? error : null
        const mine = attempt?.provider === provider ? attempt : null
        return <div key={provider} className="divide-y divide-border">
          <div>
            <div className="divide-y divide-border">
              {connections.length === 0 && <SettingRow icon={<Logo className={cn('size-5 shrink-0 text-foreground', provider === 'claude' && 'text-brand-claude')} />} title={t(provider)} description={available ? undefined : t('unavailable')}>
                <span className="flex items-center gap-2">
                  {mine && catching && <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={cancel}>{t('cancel')}</Button>}
                  <SignInButton busy={(starting?.provider === provider && !starting.id) || !!mine} disabled={!available || pending || !!attempt} label={t('connect')} busyLabel={t('connecting')} onClick={() => { void connect(provider) }} />
                </span>
              </SettingRow>}
              {connections.map(connection => {
                const live = connection.state === 'connected'
                const signInState = subscriptionSignInState(connection, now)
                const resumable = signInState === 'resume' && !(failure?.again?.connectionId === connection.id && failure.again.resume === false)
                const read = live && usage && usage !== 'failed' ? usage.get(connection.id) : undefined
                const failed = live && (usage === 'failed' || read?.status === 'unavailable')
                // reauth: the runtime's own reconnect_required, or the provider refused this read.
                const reauth = connection.state === 'reconnect_required' || read?.status === 'reauth'
                const paused = connection.paused === true
                const healthy = live && !reauth && !paused
                const account = read?.account ?? connection.account ?? null
                const plan = read?.plan ? planName(read.plan) : null
                const product = plan ? t(provider === 'codex' ? 'codexPlan' : 'claudePlan', { plan }) : t(provider === 'codex' ? 'codexProduct' : 'claudeProduct')
                const signingIn = starting?.id === connection.id || attempt?.connectionId === connection.id
                const canReconnect = available && !pending && !attempt
                return <div key={connection.id} id={`subscription-${connection.id}`} tabIndex={-1} className="flex scroll-mt-6 flex-col gap-3 px-5 py-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className={cn('flex min-w-0 items-center gap-3 transition-opacity duration-150', paused && 'opacity-50')}>
                      <Logo className={cn('size-5 shrink-0 text-foreground', provider === 'claude' && 'text-brand-claude')} />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium">{account ?? product}</span>
                        {account && <span className="text-xs text-muted-foreground">{product}</span>}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-2 sm:justify-end">
                      {/* The 启用 switch says on or off; the label speaks only for other states. */}
                      {!healthy && !(paused && live && !reauth && !signingIn) && <span className="flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
                        {reauth && <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />}
                        {signInState === 'expired' ? t('signInExpired') : resumable && !signingIn ? t('unfinished') : reauth ? t('reauth') : paused ? t('paused') : t('notConnected')}
                      </span>}
                      {mine?.connectionId === connection.id && catching && <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={cancel}>{t('cancel')}</Button>}
                      {(reauth || !live || signingIn) && <SignInButton busy={signingIn} disabled={!canReconnect} label={t(resumable ? 'resume' : 'reconnect')} busyLabel={t('connecting')} onClick={() => { void connect(provider, connection, resumable) }} />}
                      {/* 启用, labelled like 设备's 参与调度: off, its models in 优先使用的模型 read 订阅已停用 and no run or chat uses it. */}
                      {live && !reauth && !signingIn && <Label className="flex items-center gap-2 font-normal text-muted-foreground">
                        <span aria-hidden="true" className="max-sm:hidden">{t('enabled')}</span>
                        <Switch checked={!paused} disabled={pending || !!attempt} aria-label={t('useSubscription', { label: account ?? product })} onCheckedChange={checked => { void setPaused(connection, !checked) }} />
                      </Label>}
                      <DropdownMenu>
                        <DropdownMenuTrigger disabled={pending || !!attempt} render={<Button variant="ghost" size="icon-sm" aria-label={t('rowMenu', { label: account ?? product })} />}><MoreHorizontal aria-hidden="true" /></DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuGroup>
                            {healthy && <DropdownMenuItem disabled={refreshingModels === connection.id} onClick={() => { void refreshModels({ id: connection.id, label: account ?? product }) }}><RefreshCw />{t('refreshModels')}</DropdownMenuItem>}
                            {live
                              ? <DropdownMenuItem variant="destructive" onClick={() => setDisconnecting({ ...connection, label: account ?? product })}>{t('disconnect')}</DropdownMenuItem>
                              : <DropdownMenuItem variant="destructive" onClick={() => { void remove(connection) }}>{t('remove')}</DropdownMenuItem>}
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                  {(live || reauth) && <div className={cn('flex flex-col gap-2 transition-opacity duration-150 sm:pl-8', paused && 'opacity-50')}>
                    {failed
                      ? <span className="flex items-center gap-2 text-xs text-muted-foreground">{t('quotaUnavailable')}<Button type="button" variant="secondary" size="xs" disabled={usageLoading} onClick={reloadUsage}>{t('retry')}</Button></span>
                      : read && read.windows.length > 0 && <QuotaMeters windows={read.windows} now={now} />}
                  </div>}
                </div>
              })}
            </div>
            {mine && !catching && <SignInPanel attempt={mine} callback={callback} pending={pending} onCallback={setCallback} onFinish={() => { void finishCallback() }} onCancel={cancel} />}
          </div>
          {failure && <div role="alert" className="flex items-center gap-2 px-5 py-3 text-sm text-warning-foreground">
            <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-warning-foreground" />
            <span className="min-w-0 flex-1">{failure.message}</span>
            {failure.again && available && <Button type="button" variant="secondary" size="sm" disabled={pending || !!attempt} onClick={() => startAgain(failure)}>{t('retry')}</Button>}
          </div>}
        </div>
      })}
    </SettingsSection>
    {updated !== null && <p className="pt-1 pl-1 text-xs text-muted-foreground">{updated < 1 ? t('updatedJustNow') : t('updatedAgo', { minutes: updated })}</p>}
    {notice && <p role="status" className="pt-1 pl-1 text-xs text-muted-foreground">{notice}</p>}
    <AlertDialog open={disconnecting !== null} onOpenChange={open => { if (!open && !pending) setDisconnecting(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{t('disconnectTitle', { label: disconnecting?.label ?? '' })}</AlertDialogTitle></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={() => { const target = disconnecting; setDisconnecting(null); if (target) void disconnect(target) }}>{t('disconnect')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}

export const subscriptionsKey = settingsKeys.subscriptions
export async function readSubscriptions(workspaceId: string): Promise<State> {
  const response = await fetch(`${path}?workspace=${encodeURIComponent(workspaceId)}`, { cache: 'no-store', credentials: 'same-origin' })
  if (!response.ok) throw new ReadResponseError(response.status)
  return subscriptionListSchema.parse(await response.json())
}
export const subscriptionUsageKey = settingsKeys.subscriptionUsage
export async function readSubscriptionUsage(workspaceId: string, force = false) {
  const response = await fetch(`${path}/usage?workspace=${encodeURIComponent(workspaceId)}${force ? '&refresh=1' : ''}`, { cache: 'no-store', credentials: 'same-origin' })
  if (!response.ok) throw new ReadResponseError(response.status)
  const result = subscriptionUsageSchema.parse(await response.json())
  return new Map(result.connections.map(item => [item.id, item]))
}

/** A provider row before the list has ever loaded: the not-connected row, its button still a placeholder. */
function SubscriptionRowSkeleton({ provider, label }: { provider: Provider; label: string }) {
  const Logo = logos[provider]
  return <SettingRow icon={<Logo className={cn('size-5 shrink-0 text-foreground', provider === 'claude' && 'text-brand-claude')} />} title={label}>
    <Skeleton className="h-7 w-14 rounded-md" />
  </SettingRow>
}

/** The rest of a sign-in the browser can't finish for us, inside its provider's row. */
function SignInPanel({ attempt, callback, pending, onCallback, onFinish, onCancel }: { attempt: Attempt; callback: string; pending: boolean; onCallback: (value: string) => void; onFinish: () => void; onCancel: () => void }) {
  const t = useTranslations('Settings.subscriptions')
  const [copied, setCopied] = useState(false)
  const name = t(attempt.provider === 'codex' ? 'codexProduct' : 'claudeProduct')
  const cancel = <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onCancel}>{t('cancel')}</Button>
  const open = <Button variant="secondary" size="sm" nativeButton={false} render={<a href={attempt.authorizationUrl} target="_blank" rel="noopener noreferrer" />}>{t('open', { provider: name })}</Button>
  if (attempt.flow === 'device') return <div className="flex flex-col gap-2 px-5 pb-4 sm:pl-13">
    <span className="text-xs font-medium">{t('deviceCode')}</span>
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-xl font-semibold select-all">{attempt.userCode}</span>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={copied ? t('copied') : t('copy')} onClick={() => { void navigator.clipboard.writeText(attempt.userCode ?? '').then(() => setCopied(true), () => undefined) }}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</Button>
      <span className="ml-auto flex items-center gap-2">{cancel}{open}</span>
    </div>
  </div>
  return <form className="flex flex-col gap-3 px-5 pb-4 sm:pl-13" onSubmit={event => { event.preventDefault(); onFinish() }}>
    <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground">
      <li>{t('callbackStepOpen')}</li>
      <li>{t('callbackStepCopy')}</li>
      <li>{t('callbackStepPaste')}</li>
    </ol>
    <FieldGroup><Field><FieldLabel htmlFor="subscription-callback">{t('callbackLabel')}</FieldLabel>
      <Input id="subscription-callback" value={callback} placeholder={t('callbackPlaceholder')} autoComplete="off" spellCheck={false} maxLength={8192} onChange={event => onCallback(event.target.value)} />
    </Field></FieldGroup>
    <div className="flex flex-wrap items-center justify-end gap-2">
      {cancel}{open}
      <Button type="submit" size="sm" disabled={pending || !callback.trim()}>{t('finish')}</Button>
    </div>
  </form>
}

function SignInButton({ busy, disabled, label, busyLabel, onClick }: { busy: boolean; disabled: boolean; label: string; busyLabel: string; onClick: () => void }) {
  // Busy reads as work in progress, not as a dimmed button, and still can't be pressed twice.
  return <Button type="button" variant="secondary" size="sm" className={cn(busy && 'disabled:opacity-100')} disabled={busy || disabled} aria-busy={busy} onClick={onClick}>{busy ? <><Spinner className="size-3.5" aria-hidden="true" />{busyLabel}</> : label}</Button>
}

/** What is left of each window the provider returned, with when it resets. */
function QuotaMeters({ windows, now }: { windows: SubscriptionUsageView['windows']; now: number }) {
  const t = useTranslations('Settings.subscriptions')
  const format = useFormatter()
  return <div className="flex flex-col gap-3 text-xs">
    {windows.map(window => {
      const label = window.model ? t('quotaWeeklyModel', { model: window.model }) : window.kind === 'five_hour' ? t('quotaFiveHour') : t('quotaWeekly')
      const at = window.resetsAt ? Date.parse(window.resetsAt) : NaN
      // Within a day the hour is enough; further out, the date.
      const reset = Number.isFinite(at) ? t('quotaReset', { time: at - now < 86_400_000 ? format.dateTime(at, { hour: '2-digit', minute: '2-digit' }) : format.dateTime(at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }) : null
      const left = t('quotaLeft', { percent: window.remaining })
      const low = window.remaining < 10
      return <div key={`${window.kind}-${window.model ?? ''}`} className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="text-foreground">{label}</span>
          <span className="flex items-baseline gap-2 whitespace-nowrap tabular-nums">
            {reset && <span className="text-muted-foreground">{reset}</span>}
            <span className={cn('font-medium', low ? 'text-destructive-foreground' : 'text-foreground')}>{left}</span>
          </span>
        </div>
        <Progress value={window.remaining} aria-label={[label, left, reset].filter(Boolean).join(' · ')} className={cn('[&_[data-slot=progress-track]]:h-1.5', low && '[&_[data-slot=progress-indicator]]:bg-destructive')} />
      </div>
    })}
  </div>
}
