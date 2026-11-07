'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import useSWR, { unstable_serialize, useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { refreshSubscriptionModels } from '@/app/actions/model-order'
import { useLiveKey } from '@/hooks/use-live-key'
import { ReadResponseError } from '@/lib/swr/retry'
import { settingsKeys } from '@/lib/swr/keys'
import { withBasePath } from '@/lib/base-path'
import { bridgeFromWindow, type MikkaWindow } from '@/lib/platform/detect'
import { InvalidAuthorization, parseSubscriptionStart, subscriptionListSchema, subscriptionSignInState, subscriptionUsageSchema, type SubscriptionUsageView } from '@/lib/subscription-ui'

// The same key as model-order-settings' modelOrderKey, written here so this hook does not import a UI module.
const modelOrderKey = settingsKeys.modelOrder

export type SubscriptionProvider = 'codex' | 'claude'
export type SubscriptionState = ReturnType<typeof subscriptionListSchema.parse>
export type SubscriptionAttempt = ReturnType<typeof parseSubscriptionStart> & { provider: SubscriptionProvider }
const path = withBasePath('/api/subscriptions')
/** Meters older than this read again when the page comes back into focus; nothing re-reads them on a timer (#1212). */
const USAGE_FRESH_FOR_MS = 5 * 60_000
export type SubscriptionUsage = Map<string, SubscriptionUsageView> | 'failed' | null
/** Shown under the provider's row; `again` restarts that provider's sign-in. */
export type SubscriptionFailure = { provider: SubscriptionProvider; message: string; again?: { connectionId?: string; resume?: boolean } }

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

type Provider = SubscriptionProvider
type State = SubscriptionState
type Attempt = SubscriptionAttempt
type Usage = SubscriptionUsage
type Failure = SubscriptionFailure

/**
 * The person's subscriptions in 模型与订阅 and the bounded provider sign-in
 * this page resumes (the ceremony lives on the server; authorization URLs and
 * codes never go into chat or browser storage). The open-source page and the
 * hosted layer draw it each in their own look (docs/ui-overlay.md).
 */
export function useSubscriptions(workspaceId: string) {
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

  return { state, loadFailed, attempt, callback, setCallback, catching, pending, starting, error, notice, now, usage, usageLoading, reloadUsage, refreshingModels, refreshModels, connect, finishCallback, cancel, disconnect, setPaused, remove, startAgain }
}
