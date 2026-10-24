'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { SettingRow, SettingsSection } from './primitives'
import { useWorkspace } from '@/hooks/use-workspace'
import { withBasePath } from '@/lib/base-path'

type Connection = { id: string; provider: 'codex' | 'claude'; state: string; revision: number }
type Attempt = { connectionId: string; flow: 'device' | 'callback_handoff'; state: string; authorizationUrl: string; userCode?: string; interval?: number; expiresAt: string }
type State = { enabled: boolean; providers: { provider: 'codex' | 'claude'; available: boolean }[]; connections: Connection[] }
async function fetchState(url: string): Promise<State> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error('subscription_unavailable')
  return response.json()
}
export function SubscriptionSettings({ userKey, workspaceId }: { userKey: string; workspaceId?: string }) {
  const t = useTranslations('Settings.subscriptions')
  const { data: workspace } = useWorkspace(userKey, workspaceId)
  const selected = workspace?.workspace.id
  const { data, error, mutate } = useSWR(selected ? withBasePath(`/api/subscriptions?workspace=${encodeURIComponent(selected)}`) : null, fetchState, { refreshInterval: 5000, revalidateOnFocus: true })
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [callbackUrl, setCallbackUrl] = useState('')
  const [pending, setPending] = useState(false)
  if (!data?.enabled && !error) return null
  async function act(provider: 'codex' | 'claude', connection: Connection | undefined, disconnect = false) {
    setBusy(true); setFailed(false)
    try {
      const body = disconnect && connection ? { action: 'disconnect', connectionId: connection.id, revision: connection.revision } : connection ? { action: 'reconnect', connectionId: connection.id, revision: connection.revision } : { action: 'connect', provider, workspaceId: selected }
      const response = await fetch(withBasePath('/api/subscriptions'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!response.ok) throw new Error('subscription_unavailable')
      const next = await response.json()
      if (!disconnect) {
        const target = new URL(next.authorizationUrl)
        if (target.protocol !== 'https:' || target.username || target.password || !['auth.openai.com', 'claude.ai'].includes(target.hostname) || !['device', 'callback_handoff'].includes(next.flow)) throw new Error('authorization_refused')
        setAttempt({ ...next, connectionId: connection?.id ?? next.connectionId })
        setCallbackUrl(''); setPending(false)
      } else { setAttempt(null); setCallbackUrl(''); await mutate() }
    } catch { setFailed(true) }
    finally { setBusy(false) }
  }
  async function finish() {
    if (!attempt) return
    setBusy(true); setFailed(false); setPending(false)
    try {
      const body = attempt.flow === 'device' ? { action: 'poll', connectionId: attempt.connectionId, state: attempt.state } : { action: 'callback', connectionId: attempt.connectionId, state: attempt.state, callbackUrl }
      const response = await fetch(withBasePath('/api/subscriptions'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!response.ok) throw new Error('authorization_refused')
      const result = await response.json()
      if (result.pending) setPending(true)
      else { setAttempt(null); setCallbackUrl(''); await mutate() }
    } catch { setFailed(true) }
    finally { setBusy(false) }
  }
  return <SettingsSection id="subscriptions-heading" title={t('title')} description={t('description')}>
    {data?.providers.map(({ provider, available }) => {
      const connection = data.connections.find(item => item.provider === provider && item.state !== 'disconnected')
      const connected = connection?.state === 'connected'
      return <SettingRow key={provider} title={provider === 'codex' ? 'ChatGPT / Codex' : 'Claude'} description={available ? t('reuse') : t('unavailable')}>
        <div className="flex flex-wrap items-center gap-2">
          {connected ? <Badge variant="secondary">{t('connected')}</Badge> : null}
          {connected ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void act(provider, connection, true)}>{t('disconnect')}</Button> : <Button size="sm" disabled={busy || !available} onClick={() => void act(provider, connection)}>{connection ? t('reconnect') : t('connect')}</Button>}
        </div>
      </SettingRow>
    })}
    {attempt ? <div className="flex flex-col gap-3 px-5 py-3">
      <p className="text-sm text-muted-foreground">{attempt.flow === 'device' ? t('deviceHelp', { seconds: attempt.interval ?? 5 }) : t('handoffHelp')}</p>
      {attempt.userCode ? <p className="font-mono text-lg" aria-label={t('deviceCode')}>{attempt.userCode}</p> : null}
      <a className="text-sm underline" href={attempt.authorizationUrl} target="_blank" rel="noopener noreferrer">{t('openProvider')}</a>
      {attempt.flow === 'callback_handoff' ? <Label className="flex flex-col gap-1 text-sm">{t('callbackUrl')}<Input type="text" autoComplete="off" spellCheck={false} value={callbackUrl} onChange={event => setCallbackUrl(event.target.value)} /></Label> : null}
      <p className="text-xs text-muted-foreground">{t('expires', { time: new Date(attempt.expiresAt).toLocaleTimeString() })}</p>
      <div className="flex gap-2"><Button size="sm" disabled={busy || (attempt.flow === 'callback_handoff' && !callbackUrl)} onClick={() => void finish()}>{t('complete')}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => { setAttempt(null); setCallbackUrl('') }}>{t('close')}</Button></div>
      {pending ? <p role="status" className="text-sm">{t('pending', { seconds: attempt.interval ?? 5 })}</p> : null}
    </div> : null}
    {failed || error ? <p role="alert" className="px-5 py-3 text-sm text-destructive">{t('error')}</p> : null}
  </SettingsSection>
}
