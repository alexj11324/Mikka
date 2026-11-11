'use client'

import type { SWRResponse } from 'swr'
import { useTranslations } from 'next-intl'
import { Puzzle } from 'lucide-react'
import { workspaceLink } from '@/components/workspace/workspace-navigation'
import { Link } from '@/i18n/navigation'
import { ConnectedAppRow, ConnectedAppsStatus, OWN_APPS, PluginRow, useAppInfo, type OwnAppId } from '@/components/plugins/connected-apps'
import { McpConnections, useMcpConnections } from '@/components/plugins/mcp-connections'
import { SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { Button } from '@/components/ui/button'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import type { SettingsConnectionsProps } from '@/components/slots/settings-connections-contract'

export type OwnAppState = 'connected' | 'notConnected' | 'paused' | null
/** `codes`: each failed app's raw code, shown only under 详情 (decision 2026-11-05-0330). */
export interface OwnAppStates { states: Partial<Record<OwnAppId, OwnAppState>>; failed: OwnAppId[]; codes?: Partial<Record<OwnAppId, string>> }
export type OwnAppsRead = Pick<SWRResponse<OwnAppStates>, 'data' | 'error' | 'isLoading' | 'isValidating' | 'mutate'>

/** A failed own-app read keeps its last state and says which apps could not be read. */
export function OwnAppsStatus({ read }: { read: OwnAppsRead }) {
  const t = useTranslations('Plugins')
  const info = useAppInfo()
  const failed = read.error ? OWN_APPS : read.data?.failed ?? []
  return failed.length > 0 ? <SettingsSaveError message={t('connectionStatusFailed', { names: failed.map(id => info(id).name).join('、') })} retryLabel={t('retry')} onRetry={() => { void read.mutate() }} /> : null
}

/** 设置 › 连接: only what the person has connected, one uniform row each. */
export function ConnectedList({ apps, ownRead, href, onOpen, workspaceId, workspaceName }: SettingsConnectionsProps) {
  const t = useTranslations('Plugins')
  const info = useAppInfo()
  const mcp = useMcpConnections(workspaceId)
  const mcpEmpty = !workspaceId || (mcp.data && !mcp.error && mcp.data.servers.length === 0)
  const composio = apps.connectedToolkits()
  const ownStates = ownRead.data?.states
  const ownKnown = ownRead.data && !ownRead.data.failed.length && !ownRead.error
  const loading = apps.loading || (!ownRead.data && !ownRead.error)
  const own = OWN_APPS.filter(id => ownStates?.[id] === 'connected' || ownStates?.[id] === 'paused')
  if (!apps.loading && !apps.error && ownKnown && !composio.length && !own.length && mcpEmpty) return <div className="flex flex-col gap-4">
    <ConnectedAppsStatus apps={apps} />
    <Empty className="min-h-48">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Puzzle aria-hidden="true" /></EmptyMedia>
        <EmptyTitle>{t('noConnections')}</EmptyTitle>
      </EmptyHeader>
      <Button variant="secondary" size="sm" nativeButton={false} render={<Link href={workspaceLink({ section: 'plugins' })} />}>{t('openStore')}</Button>
    </Empty>
    {workspaceId && <McpConnections workspaceId={workspaceId} workspaceName={workspaceName} read={mcp} />}
  </div>
  return <div className="flex flex-col gap-4">
    <ConnectedAppsStatus apps={apps} />
    <OwnAppsStatus read={ownRead} />
    {loading && !composio.length && !own.length ? <SettingsLoading label={t('loadingApps')} /> : composio.length > 0 || own.length > 0 ? <SettingsSection id="plugin-apps">
      {composio.map(id => <ConnectedAppRow key={id} apps={apps} app={id} href={href(id)} onOpen={() => onOpen(id)} />)}
      {own.map(id => <PluginRow key={id} app={id} name={info(id).name} href={href(id)} onOpen={() => onOpen(id)} dim={ownStates?.[id] === 'paused'}>
        <span className="text-xs text-muted-foreground">{t(`state.${ownStates![id]!}`)}</span>
      </PluginRow>)}
    </SettingsSection> : null}
    {workspaceId && <McpConnections workspaceId={workspaceId} workspaceName={workspaceName} read={mcp} />}
  </div>
}
