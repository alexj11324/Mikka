'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowRight, RefreshCw, Unplug } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { disconnectLinearAccount, disableLinearTeam, enableLinearTeam, getLinearIntegrationState, listLinearTeamOptions, retryLinearDelivery, retryLinearIssue, startLinearOAuth } from '@/app/actions/linear-sync'

type IntegrationState = Awaited<ReturnType<typeof getLinearIntegrationState>>
type TeamOption = Awaited<ReturnType<typeof listLinearTeamOptions>>[number]

export function LinearSettings({ notice }: { notice?: 'connected' | 'error' | null }) {
  const t = useTranslations('Settings.linear')
  const [state, setState] = useState<IntegrationState | null>(null)
  const [teams, setTeams] = useState<TeamOption[]>([])
  const [selectedTeam, setSelectedTeam] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const loadState = async () => {
      try {
        const next = await getLinearIntegrationState()
        if (!active) return
        setState(next)
        setSelectedTeam(current => current || next.syncs.find(sync => sync.active)?.linearTeamId || '')
        if (next.connected && teams.length === 0) {
          const options = await listLinearTeamOptions()
          if (active) setTeams(options)
        }
      } catch {
        if (active) setError(t('loadError'))
      }
    }
    void loadState()
    const timer = window.setInterval(() => { void getLinearIntegrationState().then(next => { if (active) setState(next) }).catch(() => {}) }, 10_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [t, teams.length])

  const activeTeam = state?.syncs.find(sync => sync.active)
  async function connect() {
    setBusy(true); setError('')
    try {
      const result = await startLinearOAuth()
      window.location.assign(result.url)
    } catch { setError(t('operationError')); setBusy(false) }
  }

  async function enableTeam() {
    if (!selectedTeam) return
    setBusy(true); setError('')
    try {
      const result = await enableLinearTeam({ teamId: selectedTeam })
      if ('error' in result) throw new Error(result.error)
      setState(await getLinearIntegrationState())
    } catch (caught) {
      setError(caught instanceof Error && caught.message === 'linearTeamAlreadyLinked' ? t('teamAlreadyLinked') : t('operationError'))
    } finally { setBusy(false) }
  }

  async function disableTeam() {
    if (!activeTeam) return
    setBusy(true); setError('')
    try {
      await disableLinearTeam(activeTeam.id)
      setState(await getLinearIntegrationState())
    } catch { setError(t('operationError')) }
    finally { setBusy(false) }
  }

  async function disconnect() {
    setBusy(true); setError('')
    try {
      await disconnectLinearAccount()
      setState(await getLinearIntegrationState())
      setTeams([]); setSelectedTeam('')
    } catch { setError(t('operationError')) }
    finally { setBusy(false) }
  }

  async function retry(issueId: string) {
    setBusy(true); setError('')
    try {
      await retryLinearIssue(issueId)
      setState(await getLinearIntegrationState())
    } catch { setError(t('operationError')) }
    finally { setBusy(false) }
  }

  async function retryDelivery(deliveryId: string) {
    setBusy(true); setError('')
    try {
      await retryLinearDelivery(deliveryId)
      setState(await getLinearIntegrationState())
    } catch { setError(t('operationError')) }
    finally { setBusy(false) }
  }

  return <section className="flex flex-col gap-4" aria-labelledby="linear-heading">
    <div className="rounded-xl border bg-muted/30 px-5">
      <div className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h2 id="linear-heading" className="text-sm font-medium">{t('title')}</h2>
          <p className="text-sm text-muted-foreground">{state?.connected ? t('connectedTo', { organization: state.organizationName ?? '' }) : t('description')}</p>
        </div>
        {state?.connected ? <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{t('connected')}</Badge>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void disconnect()}><Unplug data-icon="inline-start" />{t('disconnect')}</Button>
        </div> : <Button size="sm" disabled={busy || !state?.configured} onClick={() => void connect()}>{t('connect')}<ArrowRight data-icon="inline-end" /></Button>}
      </div>
    </div>

    {state && !state.configured && <p className="text-xs text-muted-foreground">{t('notConfigured')}</p>}
    {notice === 'connected' && <p role="status" className="text-sm text-success-foreground">{t('oauthSuccess')}</p>}
    {notice === 'error' && <p role="alert" className="text-sm text-destructive">{t('oauthError')}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

    {state?.connected && <div className="flex flex-col gap-4 rounded-xl border px-5 py-5">
      <div className="flex flex-col gap-2">
        <Label htmlFor="linear-team">{t('teamLabel')}</Label>
        <NativeSelect id="linear-team" value={activeTeam?.linearTeamId ?? selectedTeam} disabled={busy || teams.length === 0 || Boolean(activeTeam)} onChange={event => setSelectedTeam(event.target.value)}>
          <NativeSelectOption value="">{t('teamPlaceholder')}</NativeSelectOption>
          {teams.map(team => <NativeSelectOption key={team.id} value={team.id}>{team.key} · {team.name}</NativeSelectOption>)}
        </NativeSelect>
        <p className="text-xs text-muted-foreground">{t('teamDescription')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {activeTeam ? <>
          <Badge variant="outline">{t('syncActive', { team: activeTeam.linearTeamName })}</Badge>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void disableTeam()}>{t('pause')}</Button>
        </> : <Button size="sm" disabled={busy || !selectedTeam} onClick={() => void enableTeam()}>{t('enable')}</Button>}
        {activeTeam?.lastError && <p role="alert" className="w-full text-xs text-destructive">{activeTeam.lastError}</p>}
      </div>
    </div>}

    {!!state?.errors.length && <div className="flex flex-col gap-3 rounded-xl border px-5 py-5">
      <h3 className="text-sm font-medium">{t('failedIssues')}</h3>
      {state.errors.map(item => <div key={item.id} className="flex flex-col gap-2 rounded-lg bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{item.identifier ? `${item.identifier} · ` : ''}{item.title}</p>
          <p className="text-xs text-destructive">{item.message ?? t('operationError')}</p>
        </div>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void retry(item.issueId)}><RefreshCw data-icon="inline-start" />{t('retry')}</Button>
      </div>)}
    </div>}

    {!!state?.inboundErrors.length && <div className="flex flex-col gap-3 rounded-xl border px-5 py-5">
      <h3 className="text-sm font-medium">{t('inboundFailures')}</h3>
      {state.inboundErrors.map(item => <div key={item.id} className="flex flex-col gap-2 rounded-lg bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t('deliveryType', { type: item.eventType })}</p>
          <p className="text-xs text-destructive">{item.message ?? t('operationError')}</p>
        </div>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void retryDelivery(item.id)}><RefreshCw data-icon="inline-start" />{t('retry')}</Button>
      </div>)}
    </div>}
  </section>
}
