'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowRight, RefreshCw, Unplug } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { withBasePath } from '@/lib/base-path'
import { disconnectLinearAccount, disableLinearTeam, enableLinearTeam, getLinearIntegrationState, listLinearTeamOptions, retryLinearDelivery, retryLinearIssue, startLinearOAuth } from '@/app/actions/linear-sync'

type IntegrationState = Awaited<ReturnType<typeof getLinearIntegrationState>>
type TeamOption = Awaited<ReturnType<typeof listLinearTeamOptions>>[number]

export function LinearSettings({ notice }: { notice?: 'connected' | 'error' | null }) {
  const t = useTranslations('Settings.linear')
  const [state, setState] = useState<IntegrationState | null>(null)
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [teams, setTeams] = useState<TeamOption[]>([])
  const [selectedTeam, setSelectedTeam] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    let inFlight = false
    let loadedTeams = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const loadState = async () => {
      if (inFlight || document.hidden) return
      inFlight = true
      window.clearTimeout(timer)
      let poll = false
      try {
        // Check global availability before a server action can read the session
        // or integration tables. Off/paused/disconnected never run a poll loop.
        const response = await fetch(withBasePath('/api/integrations/linear/status'), { cache: 'no-store' })
        const availability = response.ok ? await response.json() as { enabled?: boolean } : null
        if (!active) return
        if (availability?.enabled !== true) { setEnabled(false); return }
        const next = await getLinearIntegrationState()
        if (!active) return
        setEnabled(next.enabled)
        if (!next.enabled) return
        setState(next)
        setSelectedTeam(current => current || next.syncs.find(sync => sync.active)?.linearTeamId || '')
        poll = next.connected && next.syncs.some(sync => sync.active)
        if (next.connected && !loadedTeams) {
          const options = await listLinearTeamOptions()
          if (active) { setTeams(options); loadedTeams = true }
        }
      } catch {
        poll = false
        if (active) { setEnabled(false); setError(t('loadError')) }
      } finally {
        inFlight = false
        if (active && poll) timer = window.setTimeout(() => { void loadState() }, 10_000)
      }
    }
    void loadState()
    const refresh = () => { window.clearTimeout(timer); if (!document.hidden) void loadState() }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      active = false; window.clearTimeout(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [t, state?.connected, state?.syncs.some(sync => sync.active)])

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
      const result = await retryLinearIssue(issueId)
      if ('error' in result) throw new Error(result.error)
      setState(await getLinearIntegrationState())
    } catch { setError(t('operationError')) }
    finally { setBusy(false) }
  }

  async function retryDelivery(deliveryId: string) {
    setBusy(true); setError('')
    try {
      const result = await retryLinearDelivery(deliveryId)
      if ('error' in result) throw new Error(result.error)
      setState(await getLinearIntegrationState())
    } catch { setError(t('operationError')) }
    finally { setBusy(false) }
  }

  return <div className="flex flex-col gap-8">
    <SettingsSection
      id="linear-heading"
      title={t('title')}
      description={enabled === false ? undefined : state?.connected ? t('connectedTo', { organization: state.organizationName ?? '' }) : t('description')}
      action={<div className="flex flex-wrap items-center gap-2">{enabled === false && <Badge variant="secondary">{t('syncDisabled')}</Badge>}{state?.connected ? <><Badge variant="secondary">{t('connected')}</Badge><Button variant="outline" size="sm" disabled={busy} onClick={() => void disconnect()}><Unplug data-icon="inline-start" />{t('disconnect')}</Button></> : <Button size="sm" disabled={busy || enabled !== true || !state?.configured} onClick={() => void connect()}>{t('connect')}<ArrowRight data-icon="inline-end" /></Button>}</div>}
    >
      {state?.connected && <SettingRow title={t('teamLabel')} description={t('teamDescription')}>
        <div className="flex flex-col items-start gap-2">
          <NativeSelect aria-label={t('teamLabel')} id="linear-team" value={activeTeam?.linearTeamId ?? selectedTeam} disabled={busy || enabled !== true || teams.length === 0 || Boolean(activeTeam)} onChange={event => setSelectedTeam(event.target.value)}>
            <NativeSelectOption value="">{t('teamPlaceholder')}</NativeSelectOption>
            {teams.map(team => <NativeSelectOption key={team.id} value={team.id}>{team.key} · {team.name}</NativeSelectOption>)}
          </NativeSelect>
          {activeTeam && <div className="flex flex-wrap items-center gap-2">{enabled === true && <Badge variant="outline">{t('syncActive', { team: activeTeam.linearTeamName })}</Badge>}<Button variant="outline" size="sm" disabled={busy} onClick={() => void disableTeam()}>{t('pause')}</Button></div>}
          {!activeTeam && <Button size="sm" disabled={busy || enabled !== true || !selectedTeam} onClick={() => void enableTeam()}>{t('enable')}</Button>}
          {activeTeam?.lastError && <p role="alert" className="text-xs text-destructive">{activeTeam.lastError}</p>}
        </div>
      </SettingRow>}
    </SettingsSection>

    {enabled === true && state && !state.configured && <p className="text-xs text-muted-foreground">{t('notConfigured')}</p>}
    {notice === 'connected' && <p role="status" className="text-sm text-success-foreground">{t('oauthSuccess')}</p>}
    {notice === 'error' && <p role="alert" className="text-sm text-destructive">{t('oauthError')}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

    {!!state?.errors.length && <SettingsSection id="linear-failed-issues" title={t('failedIssues')}>
      {state.errors.map(item => <SettingRow key={item.id} title={`${item.identifier ? `${item.identifier} · ` : ''}${item.title}`} description={item.message ?? t('operationError')}><Button variant="outline" size="sm" disabled={busy || enabled !== true} onClick={() => void retry(item.issueId)}><RefreshCw data-icon="inline-start" />{t('retry')}</Button></SettingRow>)}
    </SettingsSection>}

    {!!state?.inboundErrors.length && <SettingsSection id="linear-inbound-failures" title={t('inboundFailures')}>
      {state.inboundErrors.map(item => <SettingRow key={item.id} title={t('deliveryType', { type: item.eventType })} description={item.message ?? t('operationError')}><Button variant="outline" size="sm" disabled={busy || enabled !== true} onClick={() => void retryDelivery(item.id)}><RefreshCw data-icon="inline-start" />{t('retry')}</Button></SettingRow>)}
    </SettingsSection>}
  </div>
}
