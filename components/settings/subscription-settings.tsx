'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { withBasePath } from '@/lib/base-path'
import { parseSubscriptionStart, subscriptionListSchema } from '@/lib/subscription-ui'

type Provider = 'codex' | 'claude'
type State = ReturnType<typeof subscriptionListSchema.parse>
type Attempt = ReturnType<typeof parseSubscriptionStart> & { provider: Provider }
const path = withBasePath('/api/subscriptions')

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
  const refresh = useCallback(async () => {
    const response = await fetch(`${path}?workspace=${encodeURIComponent(workspaceId)}`, { cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok) throw new Error('Subscription list unavailable')
    setState(subscriptionListSchema.parse(await response.json())); setLoadFailed(false)
  }, [workspaceId])

  useEffect(() => { void refresh().catch(() => { setState(null); setLoadFailed(true) }) }, [refresh])
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
        return <SettingRow key={provider} title={t(provider)} description={available ? t('providerDescription') : t('unavailable')}>
          <div className="flex flex-col items-end gap-2">
            {connections.map(connection => <div key={connection.id} className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{connection.state === 'connected' ? t('connected') : t('notConnected')}</span>
              {connection.state === 'connected'
                ? <Button type="button" variant="outline" size="sm" disabled={pending || !!attempt} onClick={() => { void disconnect(connection) }}>{t('disconnect')}</Button>
                : <><Button type="button" variant="outline" size="sm" disabled={!available || pending || !!attempt} onClick={() => { void connect(provider, connection) }}>{t('reconnect')}</Button><Button type="button" variant="ghost" size="sm" disabled={pending || !!attempt} onClick={() => { void disconnect(connection) }}>{t('disconnect')}</Button></>}
            </div>)}
            <Button type="button" variant="outline" size="sm" disabled={!available || pending || !!attempt} onClick={() => { void connect(provider) }}>{connections.some(item => item.state === 'connected') ? t('connectAnother') : t('connect')}</Button>
          </div>
        </SettingRow>
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
