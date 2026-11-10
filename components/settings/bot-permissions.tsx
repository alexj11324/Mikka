'use client'

import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { BotPermissionsPage } from '@ui-slot/settings-bot-permissions'
import { listBots } from '@/app/actions/bots'
import { listAgents } from '@/app/actions/agents'
import { AppTile, OWN_APPS, useAppInfo, useConnectedApps, appState } from '@/components/plugins/connected-apps'
import { OWN_APP_STATES_KEY, fetchOwnAppStates } from '@/components/plugins/plugins-view'
import { withBasePath } from '@/lib/base-path'
import { CONFIGURABLE_ACTIONS, CONFIGURABLE_PERMISSIONS, type PermissionDecision } from '@mikka/protocol/agent-policy'
import { LEGACY_APP_ACTIONS, appPermissionValue, withAppPermission } from '@/lib/operations/app-permission-keys'
import { OWN_INTEGRATIONS } from '@/lib/composio-accounts'
import type { BotPermissionAction, BotPermissionApp, BotPermissionAppTools, PermissionChoice, PermissionValue, SettingsBotPermissionsProps } from '@/components/slots/settings-bot-permissions-contract'

type WritePolicy = { permissions: Record<string, PermissionChoice>; version: string }
type PolicyLayer = { permissions?: Record<string, PermissionDecision>; networkAllow?: string[]; approvalMode?: 'ask' | 'read_only'; defaults?: unknown }
type AgentPolicy = { policy: { permissions: Record<string, PermissionDecision>; readOnly?: boolean }; revision: string; layers: { agent?: PolicyLayer; workspace?: PolicyLayer } }

class PermissionsReadError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'PermissionsReadError' }
}

async function definition<T>(botKey: string, init?: { view?: string; body?: unknown }): Promise<T | null> {
  const url = withBasePath(`/api/bots/${botKey}/definition${init?.view ? `?view=${init.view}` : ''}`)
  const response = await fetch(url, init?.body ? { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) } : { credentials: 'same-origin', cache: 'no-store' })
  if (response.status === 404) return null
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null
  if (!response.ok || !body) throw new PermissionsReadError(body?.error ?? `http_${response.status}`)
  return body
}

async function agentPolicy<T>(body: unknown): Promise<T> {
  const response = await fetch(withBasePath('/api/agent-cli-policy'), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const value = await response.json().catch(() => null) as (T & { error?: string }) | null
  if (!response.ok || !value) throw new PermissionsReadError(value?.error ?? `http_${response.status}`)
  return value
}

/**
 * The current workspace's permissions: one access level per connected app, the provider's real tool catalogue, and the
 * workspace's run policy. This is not per Bot: every Bot in the workspace inherits these choices, and a Bot's own
 * stricter layer still narrows them. Admins save; any member reads. Saves go through the same routes.
 */
export function useBotPermissions({ admin = false, workspaceId }: { admin?: boolean; workspaceId?: string } = {}): SettingsBotPermissionsProps {
  const t = useTranslations('Settings.botPermissions')
  const tError = useTranslations('Settings.botPermissions.errors')
  const info = useAppInfo()
  const apps = useConnectedApps()
  // Mikka's own apps are connected apps too; only GitHub has a real per-app tool path.
  const own = useSWR(OWN_APP_STATES_KEY, () => fetchOwnAppStates())
  const { data: bots } = useSWR('bots', listBots)
  const { data: agents } = useSWR('agents', () => listAgents())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Catalogue reads are lazy: GitHub plus the legacy write apps load with the page, every other app on request.
  const [catalogues, setCatalogues] = useState<Record<string, BotPermissionAppTools | 'loading'>>({})
  const started = useRef(new Set<string>())
  // The workspace-scoped routes resolve their workspace through a Bot the person owns in it. The page has no Bot
  // picker: any Bot in the workspace names the same workspace.
  const anchor = bots?.[0] ?? null
  const botId = anchor?.id ?? null
  const botKey = botId ?? 'coordinator'
  // The worker the run policy is read through: the person's first agent (the workspace layer is the same for each).
  const agentId = agents?.[0]?.id ?? null

  // The workspace's own policy is the page's source of truth. The Bot layer is not read: it can only narrow.
  const workspace = useSWR(botId && bots && workspaceId ? ['workspace-write-policy', workspaceId, botKey] : null, () => definition<WritePolicy>(botKey, { view: 'workspace_write_policy' }), { revalidateOnFocus: false })
  const run = useSWR(agentId && botId && bots && workspaceId ? ['workspace-run-policy', workspaceId, botKey, agentId] : null, () => agentPolicy<AgentPolicy>({ operation: 'readAgent', agentId, botId }), { revalidateOnFocus: false })

  const stored = workspace.data?.permissions ?? {}
  const writable = admin && workspace.data !== null && workspace.data !== undefined

  const appAction = (id: string): BotPermissionAction => {
    const legacy = LEGACY_APP_ACTIONS[id] !== undefined
    // GitHub calls its hosted MCP directly; an app-level deny is the only choice that withholds it.
    const enforceable = id === 'github' || legacy || !OWN_INTEGRATIONS.has(id)
    const saved = appPermissionValue(stored, id)
    // GitHub has no ask card: its default is direct allow, and deny is the only restriction.
    const value: PermissionValue = id === 'github' ? (saved === 'deny' ? 'deny' : 'allow') : saved ?? 'default'
    const catalogue = catalogues[id]
    const count = catalogue && catalogue !== 'loading' && !catalogue.error ? catalogue.count : null
    return {
      id,
      name: count ? t('allToolsCount', { count }) : t('allTools'),
      value,
      effective: null,
      choices: id === 'github' ? ['allow', 'deny'] : enforceable ? ['default', 'allow', 'ask', 'deny'] : ['default'],
      editable: writable && enforceable,
    }
  }

  const connected = apps.connectedToolkits().filter(id => appState(apps.accountsFor(id)).on)
  const ownConnected = OWN_APPS.filter(id => id === 'github' && own.data?.states[id] === 'connected')
  const known = new Set([...ownConnected, ...connected])
  // A legacy write key names the same app's choice, so an app stored only under the old key still appears.
  const withSettings = [...new Set(Object.keys(stored).map(key => LEGACY_APP_ACTIONS[key] ?? key))].filter(id => known.has(id))
  const appList: BotPermissionApp[] | null = apps.loading || (!own.data && !own.error) || !bots || workspace.isLoading || !workspaceId ? null : [...new Set([...ownConnected, ...connected, ...withSettings])].map(id => {
    const account = apps.accountsFor(id).find(item => item.enabled)
    const catalogue = catalogues[id]
    return {
      id, name: info(id).name, account: account?.alias ?? account?.email ?? null, iconUrl: info(id).iconUrl,
      actions: [appAction(id)],
      ...(catalogue ? { tools: catalogue } : {}),
    }
  })

  const agentLayer = run.data?.layers.workspace ?? {}
  const runActions: BotPermissionAction[] | null = !run.data ? null : CONFIGURABLE_ACTIONS.map(action => {
    const value = agentLayer.permissions?.[action] ?? 'default'
    const effective = run.data!.policy.permissions[action]
    return {
      id: action, name: t(`run.${action}`), value, effective: effective !== value ? effective : null,
      choices: ['default', ...CONFIGURABLE_PERMISSIONS[action]],
      // The workspace layer stores no computer_use (lib/agent-tool-approval/policy-store.ts): it is set on the computer.
      editable: admin && action !== 'computer_use',
    }
  })

  function loadTools(id: string) {
    if (started.current.has(id)) return
    started.current.add(id)
    setCatalogues(previous => ({ ...previous, [id]: 'loading' }))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12_000)
    fetch(withBasePath(`/api/bots/${botKey}/app-tools?app=${encodeURIComponent(id)}`), { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const body = await response.json().catch(() => null) as (BotPermissionAppTools & { error?: string }) | null
        if (!response.ok || !body || typeof body.count !== 'number') throw new Error('catalogueUnavailable')
        setCatalogues(previous => ({ ...previous, [id]: body }))
      })
      .catch(() => setCatalogues(previous => ({ ...previous, [id]: { count: 0, readOnlyCount: 0, tools: [], truncated: false, error: 'readFailed' } })))
      .finally(() => clearTimeout(timer))
  }

  // A different workspace has different settings and its own catalogue reads.
  useEffect(() => { setCatalogues({}); started.current = new Set() }, [workspaceId])
  const eagerKey = appList ? appList.map(app => app.id).sort().join(',') : ''
  useEffect(() => {
    if (!eagerKey) return
    for (const id of eagerKey.split(',')) loadTools(id)
    // `loadTools` reads the current workspace and the started set; eagerKey is the set of apps to read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eagerKey, workspaceId])

  async function save(work: () => Promise<unknown>) {
    setSaving(true); setError(null)
    try { await work() } catch (failure) {
      const code = failure instanceof PermissionsReadError ? failure.code : 'unknown'
      setError(tError.has(code as never) ? tError(code as never) : tError('saveFailed'))
    } finally { setSaving(false) }
  }

  return {
    scope: 'workspace',
    // Kept for a layer that still names an anchor; the page itself does not pick a Bot.
    bots: bots?.map(bot => ({ id: bot.id, name: bot.name })) ?? [],
    botId, onBot: () => {},
    apps: appList,
    run: runActions,
    workspace: null,
    approvalMode: run.data ? { value: agentLayer.approvalMode ?? 'ask', editable: admin } : null,
    onApprovalMode: mode => { void save(async () => {
      if (!admin || !run.data || !agentId) return
      await agentPolicy({ operation: 'setAgent', agentId, botId, target: 'workspace', expectedRevision: run.data.revision, policy: { ...agentLayer, approvalMode: mode } })
      await run.mutate()
    }) },
    onAction: (kind, ids, value) => { void save(async () => {
      if (kind === 'run') {
        if (!admin || !run.data || !agentId) return
        const permissions = { ...agentLayer.permissions }
        for (const id of ids) { if (value === 'default') delete permissions[id]; else permissions[id] = value }
        await agentPolicy({ operation: 'setAgent', agentId, botId, target: 'workspace', expectedRevision: run.data.revision, policy: { ...agentLayer, permissions } })
        await run.mutate()
        return
      }
      // `write` is the overlay's name for an app rule; both save the workspace's one policy.
      if (!writable || !workspace.data) return
      let permissions = { ...workspace.data.permissions }
      for (const id of ids) permissions = withAppPermission(permissions, id, value === 'default' ? null : value)
      await definition(botKey, { body: { action: 'set_workspace_write_policy', permissions, expectedVersion: workspace.data.version } })
      await workspace.mutate()
    }) },
    onLoadTools: loadTools,
    saving,
    error: error ?? (workspace.error || run.error ? tError('readFailed') : null),
  }
}

export function BotPermissionsSettings({ admin = false, workspaceId }: { admin?: boolean; workspaceId?: string }) {
  return <BotPermissionsPage {...useBotPermissions({ admin, workspaceId })} />
}

/** The open-source page: the rule, the workspace scope, then each app's one access choice and its real tools. */
export function BotPermissionsView({ scope, apps, run, approvalMode, onLoadTools, error }: SettingsBotPermissionsProps) {
  const t = useTranslations('Settings.botPermissions')
  const level = (value: PermissionValue) => t(`level.${value}`)
  if (!apps) return <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>
  return <div className="flex flex-col gap-4">
    <p className="text-sm text-muted-foreground">{t('rule')}</p>
    {scope === 'workspace' && <p className="text-sm text-muted-foreground">{t('workspaceScope')}</p>}
    {approvalMode && <p className="text-sm">{t('mode')}: {t(`modes.${approvalMode.value}`)}</p>}
    {error && <p role="alert" className="text-sm text-destructive-foreground">{error}</p>}
    {apps.length === 0 ? <p className="text-sm text-muted-foreground">{t('empty')}</p>
      : <ul className="flex flex-col divide-y rounded-xl border">
        {apps.map(app => <li key={app.id} className="flex items-start gap-3 px-4 py-3">
          <AppTile app={app.id} iconUrl={app.iconUrl} />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-sm font-medium">{app.name}{app.account && <span className="ml-2 font-normal text-muted-foreground">{app.account}</span>}</p>
            <p className="text-xs text-muted-foreground">{app.actions.length ? app.actions.map(action => `${action.name} · ${level(action.value)}`).join('，') : level('default')}</p>
            <AppTools app={app} onLoadTools={onLoadTools} />
          </div>
        </li>)}
      </ul>}
    {run && <ul className="flex flex-col divide-y rounded-xl border">
      {run.map(action => <li key={action.id} className="flex justify-between gap-3 px-4 py-2 text-sm"><span>{action.name}</span><span className="text-muted-foreground">{action.effective ? `${level(action.value)} · ${level(action.effective)}` : level(action.value)}</span></li>)}
    </ul>}
  </div>
}

/** The provider's real catalogue, read on first open. A count alone already replaces the old hand-written action list. */
function AppTools({ app, onLoadTools }: { app: BotPermissionApp; onLoadTools?: (app: string) => void }) {
  const t = useTranslations('Settings.botPermissions')
  if (app.tools === 'loading') return <p className="text-xs text-muted-foreground">{t('toolsLoading')}</p>
  if (app.tools && 'error' in app.tools && app.tools.error) return <p className="text-xs text-muted-foreground">{t('toolsFailed')}</p>
  if (app.tools && 'count' in app.tools) return <details className="text-xs text-muted-foreground" onToggle={event => { if (event.currentTarget.open) onLoadTools?.(app.id) }}>
    <summary>{t('toolsCount', { count: app.tools.count, readOnly: app.tools.readOnlyCount })}</summary>
    <ul className="mt-1 flex flex-col gap-0.5">
      {app.tools.tools.slice(0, 100).map(tool => <li key={tool.name}><span>{tool.displayName}</span> <span className="text-muted-foreground/70">{tool.readOnly ? t('readOnly') : t('write')}</span></li>)}
    </ul>
  </details>
  return <details className="text-xs text-muted-foreground" onToggle={event => { if (event.currentTarget.open) onLoadTools?.(app.id) }}>
    <summary>{t('tools')}</summary>
  </details>
}
