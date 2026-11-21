'use client'

import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from '@/lib/intl/i18n-client'
import { useSearchParams } from '@/lib/client-runtime/navigation'
import { useLiveKey, useLiveScope } from '@/hooks/use-live-key'
import { ArrowRight, RefreshCw, Unplug } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { SettingRow, SettingsSection, settingsSectionAction } from '@/components/settings/primitives'
import { withBasePath } from '@/lib/base-path'
import { openCurrentPageInBrowser } from '@/lib/platform/open-settings'
import { useCheckOnReturn } from '@/lib/hooks/use-check-on-return'
import { disconnectLinearAccount, disableLinearTeam, enableLinearTeam, getLinearIntegrationState, listLinearTeamOptions, retryLinearDelivery, retryLinearIssue, startLinearOAuth } from '@/app/actions/linear-sync'
import { FieldError } from '@/components/ui/field'

type IntegrationState = Awaited<ReturnType<typeof getLinearIntegrationState>>
type TeamOption = Awaited<ReturnType<typeof listLinearTeamOptions>>[number]

/**
 * Linear's page as data and actions: the connection, the synced team, and failed issues and deliveries to retry.
 * Shared by the page below and UI layers (docs/ui-overlay.md).
 */
export function useLinearPlugin() {
  const t = useTranslations('Settings.linear')
  const routeWorkspace = useSearchParams().get('workspace')
  const liveScope = useLiveScope()
  const target = routeWorkspace ?? liveScope?.workspaceId
  const stateKey = `linear-integration-state:${target ?? 'active'}`
  const confirmed = useRef<string | undefined>(undefined)
  const [teams, setTeams] = useState<TeamOption[]>([])
  const [choice, setChoice] = useState<{ workspaceId: string; teamId: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { data: snapshot, error: loadError, mutate: reload } = useSWR<IntegrationState>(stateKey, async () => {
    // Check global availability before a server action can read the session
    // or integration tables. Configuration changes are delivered by live push.
    const response = await fetch(withBasePath('/api/integrations/linear/status'), { cache: 'no-store' })
    const availability = response.ok ? await response.json() as { enabled?: boolean } : null
    if (availability?.enabled !== true) return { workspaceId: null, enabled: false, configured: false, connected: false, organizationName: null, syncs: [], errors: [], inboundErrors: [] }
    const workspace = target ?? confirmed.current
    const next = workspace ? await getLinearIntegrationState(workspace) : await getLinearIntegrationState()
    confirmed.current = next.workspaceId ?? undefined
    return next
  }, { revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false })
  const state = !target || target === snapshot?.workspaceId ? snapshot ?? null : null
  const enabled = snapshot?.enabled ?? null
  // Configuration, delivery diagnostics and active-sync state share this
  // workspace settings invalidation; no timer is needed while a sync runs.
  useLiveKey('workspace_settings', state?.workspaceId, [stateKey], state?.workspaceId)
  const checkOnReturn = useCheckOnReturn(() => { void reload() })

  useEffect(() => {
    let active = true
    if (!state?.connected) { setTeams([]); return () => { active = false } }
    void listLinearTeamOptions().then(options => { if (active) setTeams(options) }).catch(() => {
      if (active) setError(t('loadError'))
    })
    return () => { active = false }
  }, [state?.connected, state?.workspaceId, t])

  const activeTeam = state?.syncs.find(sync => sync.active)
  const selectedTeam = (state?.workspaceId && choice?.workspaceId === state.workspaceId ? choice.teamId : null) ?? activeTeam?.linearTeamId ?? ''
  function setSelectedTeam(teamId: string) {
    if (state?.workspaceId) setChoice({ workspaceId: state.workspaceId, teamId })
  }
  async function refreshShownState() {
    await reload()
  }
  async function connect() {
    setBusy(true); setError('')
    try {
      const handoff = await openCurrentPageInBrowser()
      if (handoff === 'desktop') { checkOnReturn(); return }
      if (handoff === 'unsupported') { setError(t('browserUpdateRequired')); return }
      const result = await startLinearOAuth()
      window.location.assign(result.url)
    } catch { setError(t('operationError')) } finally { setBusy(false) }
  }

  async function enableTeam() {
    if (!selectedTeam || !state?.workspaceId) return
    setBusy(true); setError('')
    try {
      const result = await enableLinearTeam({ teamId: selectedTeam, workspaceId: state.workspaceId })
      if ('error' in result) throw new Error(result.error)
      await refreshShownState()
    } catch (caught) {
      setError(caught instanceof Error && caught.message === 'linearTeamAlreadyLinked' ? t('teamAlreadyLinked') : t('operationError'))
    } finally { setBusy(false) }
  }

  async function disableTeam() {
    if (!activeTeam || !state?.workspaceId) return
    setBusy(true); setError('')
    try {
      const result = await disableLinearTeam(activeTeam.id, state.workspaceId)
      if ('error' in result) throw new Error(result.error)
      await refreshShownState()
    } catch { setError(t('operationError')) }
    finally { setBusy(false) }
  }

  async function disconnect() {
    setBusy(true); setError('')
    try {
      await disconnectLinearAccount()
      await refreshShownState()
      setTeams([]); setChoice(null)
    } catch { setError(t('operationError')) }
    finally { setBusy(false) }
  }

  async function retry(issueId: string) {
    setBusy(true); setError('')
    try {
      const result = await retryLinearIssue(issueId)
      if ('error' in result) throw new Error(result.error)
      await refreshShownState()
    } catch { setError(t('operationError')) }
    finally { setBusy(false) }
  }

  async function retryDelivery(deliveryId: string) {
    setBusy(true); setError('')
    try {
      const result = await retryLinearDelivery(deliveryId)
      if ('error' in result) throw new Error(result.error)
      await refreshShownState()
    } catch { setError(t('operationError')) }
    finally { setBusy(false) }
  }

  return { state, enabled, teams, selectedTeam, setSelectedTeam, activeTeam, busy, error: error || (loadError ? t('loadError') : ''), connect, enableTeam, disableTeam, disconnect, retry, retryDelivery }
}

export function LinearSettings({ notice }: { notice?: 'connected' | 'error' | null }) {
  const t = useTranslations('Settings.linear')
  const { state, enabled, teams, selectedTeam, setSelectedTeam, activeTeam, busy, error, connect, enableTeam, disableTeam, disconnect, retry, retryDelivery } = useLinearPlugin()
  return <div className="flex flex-col gap-8">
    <SettingsSection
      id="linear-heading"
      description={enabled !== false && state?.connected ? t('connectedTo', { organization: state.organizationName ?? '' }) : undefined}
      action={<div className="flex flex-wrap items-center gap-2">{enabled === false && <Badge variant="secondary">{t('syncDisabled')}</Badge>}{state?.connected ? <><Badge variant="secondary">{t('connected')}</Badge><Button {...settingsSectionAction} size="sm" disabled={busy} onClick={() => void disconnect()}><Unplug data-icon="inline-start" />{t('disconnect')}</Button></> : <Button size="sm" disabled={busy || enabled !== true || !state?.configured} onClick={() => void connect()}>{t('connect')}<ArrowRight data-icon="inline-end" /></Button>}</div>}
    >
      {state?.connected && <SettingRow title={t('teamLabel')}>
        <div className="flex flex-col items-start gap-2">
          <NativeSelect aria-label={t('teamLabel')} id="linear-team" value={activeTeam?.linearTeamId ?? selectedTeam} disabled={busy || enabled !== true || teams.length === 0 || Boolean(activeTeam)} onChange={event => setSelectedTeam(event.target.value)}>
            <NativeSelectOption value="">{t('teamPlaceholder')}</NativeSelectOption>
            {teams.map(team => <NativeSelectOption key={team.id} value={team.id}>{team.key} · {team.name}</NativeSelectOption>)}
          </NativeSelect>
          {activeTeam && <div className="flex flex-wrap items-center gap-2">{enabled === true && <Badge variant="outline">{t('syncActive', { team: activeTeam.linearTeamName })}</Badge>}<Button variant="outline" size="sm" disabled={busy} onClick={() => void disableTeam()}>{t('pause')}</Button></div>}
          {!activeTeam && <Button size="sm" disabled={busy || enabled !== true || !selectedTeam} onClick={() => void enableTeam()}>{t('enable')}</Button>}
          {activeTeam?.lastError && <FieldError className="text-xs">{activeTeam.lastError}</FieldError>}
        </div>
      </SettingRow>}
    </SettingsSection>

    {enabled === true && state && !state.configured && <p className="text-xs text-muted-foreground">{t('notConfigured')}</p>}
    {notice === 'connected' && <p role="status" className="text-sm text-success-foreground">{t('oauthSuccess')}</p>}
    {notice === 'error' && <FieldError>{t('oauthError')}</FieldError>}
    {error && <FieldError>{error}</FieldError>}

    {!!state?.errors.length && <SettingsSection id="linear-failed-issues" title={t('failedIssues')}>
      {state.errors.map(item => <SettingRow key={item.id} title={`${item.identifier ? `${item.identifier} · ` : ''}${item.title}`} description={item.message ?? t('operationError')}><Button variant="outline" size="sm" disabled={busy || enabled !== true} onClick={() => void retry(item.issueId)}><RefreshCw data-icon="inline-start" />{t('retry')}</Button></SettingRow>)}
    </SettingsSection>}

    {!!state?.inboundErrors.length && <SettingsSection id="linear-inbound-failures" title={t('inboundFailures')}>
      {state.inboundErrors.map(item => <SettingRow key={item.id} title={t('deliveryType', { type: item.eventType })} description={item.message ?? t('operationError')}><Button variant="outline" size="sm" disabled={busy || enabled !== true} onClick={() => void retryDelivery(item.id)}><RefreshCw data-icon="inline-start" />{t('retry')}</Button></SettingRow>)}
    </SettingsSection>}
  </div>
}
