'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SettingRow, SettingsSection } from './primitives'
import { useWorkspace } from '@/hooks/use-workspace'
import { withBasePath } from '@/lib/base-path'

type Connection = { id: string; provider: 'codex' | 'claude'; state: string; revision: number }
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
        if (target.protocol !== 'https:' || !['auth.openai.com', 'claude.ai'].includes(target.hostname)) throw new Error('authorization_refused')
        window.location.assign(target.href)
      } else await mutate()
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
    {failed || error ? <p role="alert" className="px-5 py-3 text-sm text-destructive">{t('error')}</p> : null}
  </SettingsSection>
}
