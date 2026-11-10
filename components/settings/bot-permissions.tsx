'use client'

import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { BotPermissionsPage } from '@ui-slot/settings-bot-permissions'
import { listBots, listBotsForWorkspace } from '@/app/actions/bots'
import { listAgents } from '@/app/actions/agents'
import { AppTile, OWN_APPS, useAppInfo, useConnectedApps, appState } from '@/components/plugins/connected-apps'
import { OWN_APP_STATES_KEY, fetchOwnAppStates } from '@/components/plugins/plugins-view'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { withBasePath } from '@/lib/base-path'
import { CONFIGURABLE_ACTIONS, CONFIGURABLE_PERMISSIONS, type PermissionDecision } from '@mikka/protocol/agent-policy'
import { LEGACY_APP_ACTIONS, appPermissionValue, withAppPermissions } from '@/lib/operations/app-permission-keys'
import { OWN_INTEGRATIONS } from '@/lib/composio-accounts'
import type { BotPermissionAction, BotPermissionApp, BotPermissionAppTools, PermissionChoice, PermissionValue, SettingsBotPermissionsProps } from '@/components/slots/settings-bot-permissions-contract'

type WritePolicy = { permissions: Record<string, PermissionChoice>; version: string }
type PolicyLayer = { permissions?: Record<string, PermissionDecision>; networkAllow?: string[]; approvalMode?: 'ask' | 'read_only'; defaults?: unknown }
type AgentPolicy = { revision: string; layers: { workspace?: PolicyLayer } }

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

/** The page's own error: a failed read, or a workspace with no Bot to anchor
 * its policy. Without a Bot the save and catalogue routes have no target, so
 * the page says why instead of failing silently. */
export function botPermissionsErrorKey(input: { bots: unknown[] | undefined; workspaceId?: string; readFailed: boolean }): 'readFailed' | 'noBotInWorkspace' | null {
  if (input.readFailed) return 'readFailed'
  if (input.workspaceId && input.bots?.length === 0) return 'noBotInWorkspace'
  return null
}

/**
 * The current workspace's permissions: one access level per connected app, the provider's real tool catalogue, and the
 * workspace's run policy. This is not per Bot: every Bot in the workspace inherits these choices, and the workspace
 * value is the decision. Admins save; any member reads. Saves go through the same routes.
 */
export function useBotPermissions({ admin = false, workspaceId }: { admin?: boolean; workspaceId?: string } = {}): SettingsBotPermissionsProps {
  const t = useTranslations('Settings.botPermissions')
  const tError = useTranslations('Settings.botPermissions.errors')
  const info = useAppInfo()
  const apps = useConnectedApps()
  // Mikka's own apps are connected apps too; only GitHub has a real per-app tool path.
  const own = useSWR(OWN_APP_STATES_KEY, () => fetchOwnAppStates())
  // The Bot list is scoped to the workspace the page shows (`?workspace=`). The Coordinator is a Bot too; its id is
  // an execution identity, not a policy key. The workspace id keys the policy.
  const { data: bots, error: botsError } = useSWR(workspaceId ? ['bots', 'workspace', workspaceId] : 'bots', () => workspaceId ? listBotsForWorkspace(workspaceId) : listBots())
  const { data: agents } = useSWR('agents', () => listAgents())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Catalogue reads are lazy: GitHub plus the legacy write apps load with the page, every other app on open.
  const [catalogues, setCatalogues] = useState<Record<string, BotPermissionAppTools | 'loading'>>({})
  const started = useRef(new Set<string>())
  // The workspace-scoped routes resolve their workspace through a Bot the person owns in it. The page has no Bot
  // picker: any Bot in the workspace names the same workspace.
  const anchor = bots?.[0] ?? null
  const botId = anchor?.id ?? null
  // The worker the run policy is read through: the person's first agent. The workspace's run policy is the same for
  // every Bot.
  const agentId = agents?.[0]?.id ?? null

  // The workspace's policy is the page's only source of truth; no Bot layer is read or applied.
  const workspace = useSWR(botId && workspaceId ? ['workspace-write-policy', workspaceId, botId] : null, () => botId ? definition<WritePolicy>(botId, { view: 'workspace_write_policy' }) : null, { revalidateOnFocus: false })
  const run = useSWR(agentId && botId && workspaceId ? ['workspace-run-policy', workspaceId, botId, agentId] : null, () => agentId && botId ? agentPolicy<AgentPolicy>({ operation: 'readAgent', agentId, botId }) : null, { revalidateOnFocus: false })

  const stored = workspace.data?.permissions ?? {}
  const writable = admin && workspace.data !== null && workspace.data !== undefined

  const appAction = (id: string): BotPermissionAction => {
    const legacy = LEGACY_APP_ACTIONS[id] !== undefined
    // GitHub calls its hosted MCP directly; an app-level deny is the only choice that withholds it.
    const enforceable = id === 'github' || legacy || !OWN_INTEGRATIONS.has(id)
    // The workspace's value is the value; there is no second layer to compare.
    const saved = appPermissionValue(stored, id)
    // GitHub has no ask card: its default is direct allow, and deny is the only restriction.
    const value: PermissionValue = id === 'github' ? (saved === 'deny' ? 'deny' : 'allow') : saved ?? 'default'
    const catalogue = catalogues[id]
    const count = catalogue && catalogue !== 'loading' && !catalogue.error ? catalogue.count : null
    return {
      id,
      name: count ? t('allToolsCount', { count }) : t('allTools'),
      value,
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

  const workspaceLayer = run.data?.layers.workspace ?? {}
  const runActions: BotPermissionAction[] | null = !run.data ? null : CONFIGURABLE_ACTIONS.map(action => {
    const value = workspaceLayer.permissions?.[action] ?? 'default'
    return {
      id: action, name: t(`run.${action}`), value,
      choices: ['default', ...CONFIGURABLE_PERMISSIONS[action]],
      // The workspace layer stores no computer_use; computer use is set on the computer.
      editable: admin && action !== 'computer_use',
    }
  })

  function loadTools(id: string) {
    // `coordinator` is not an app-tools Bot id; without a real Bot in this workspace there is nothing to read through.
    if (!botId || started.current.has(id)) return
    started.current.add(id)
    setCatalogues(previous => ({ ...previous, [id]: 'loading' }))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12_000)
    // The route already bounds the catalogue (`private, max-age=60`), so the browser cache serves a reopen.
    fetch(withBasePath(`/api/bots/${botId}/app-tools?app=${encodeURIComponent(id)}`), { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        const body = await response.json().catch(() => null) as (BotPermissionAppTools & { error?: string }) | null
        if (!response.ok || !body || typeof body.count !== 'number') throw new Error('catalogueUnavailable')
        setCatalogues(previous => ({ ...previous, [id]: body }))
      })
      .catch(() => {
        // A failed read can be retried by opening the app again.
        started.current.delete(id)
        setCatalogues(previous => ({ ...previous, [id]: { count: 0, readOnlyCount: 0, tools: [], truncated: false, error: 'readFailed' } }))
      })
      .finally(() => clearTimeout(timer))
  }

  // A different workspace has different settings and its own catalogue reads.
  useEffect(() => { setCatalogues({}); started.current = new Set() }, [workspaceId])
  // Only GitHub and the legacy write apps load with the page; every other app is read when it is opened.
  const eagerKey = appList ? appList.filter(app => app.id === 'github' || LEGACY_APP_ACTIONS[app.id] !== undefined).map(app => app.id).sort().join(',') : ''
  useEffect(() => {
    if (!eagerKey) return
    for (const id of eagerKey.split(',')) loadTools(id)
    // `loadTools` reads the current workspace and the started set; eagerKey is the set of apps to read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eagerKey, workspaceId, botId])

  async function save(work: () => Promise<unknown>) {
    setSaving(true); setError(null)
    try { await work() } catch (failure) {
      const code = failure instanceof PermissionsReadError ? failure.code : 'unknown'
      setError(tError.has(code as never) ? tError(code as never) : tError('saveFailed'))
    } finally { setSaving(false) }
  }

  return {
    scope: 'workspace',
    apps: appList,
    run: runActions,
    approvalMode: run.data ? { value: workspaceLayer.approvalMode ?? 'ask', editable: admin } : null,
    onApprovalMode: mode => { void save(async () => {
      if (!admin || !run.data || !agentId) return
      await agentPolicy({ operation: 'setAgent', agentId, botId, target: 'workspace', expectedRevision: run.data.revision, policy: { ...workspaceLayer, approvalMode: mode } })
      await run.mutate()
    }) },
    onAction: (kind, ids, value) => { void save(async () => {
      if (kind === 'run') {
        if (!admin || !run.data || !agentId) return
        const permissions = { ...workspaceLayer.permissions }
        for (const id of ids) { if (value === 'default') delete permissions[id]; else permissions[id] = value }
        await agentPolicy({ operation: 'setAgent', agentId, botId, target: 'workspace', expectedRevision: run.data.revision, policy: { ...workspaceLayer, permissions } })
        await run.mutate()
        return
      }
      // Both kinds save the workspace's one policy.
      if (!writable || !workspace.data || !botId) return
      const permissions = withAppPermissions(workspace.data.permissions, ids, value === 'default' ? null : value)
      await definition(botId, { body: { action: 'set_workspace_write_policy', permissions, expectedVersion: workspace.data.version } })
      await workspace.mutate()
    }) },
    onLoadTools: loadTools,
    saving,
    error: error ?? (() => {
      const key = botPermissionsErrorKey({ bots, workspaceId, readFailed: Boolean(workspace.error || run.error || botsError) })
      return key ? tError(key as never) : null
    })(),
  }
}

export function BotPermissionsSettings({ admin = false, workspaceId }: { admin?: boolean; workspaceId?: string }) {
  return <BotPermissionsPage {...useBotPermissions({ admin, workspaceId })} />
}

/** The open-source page: the rule, the workspace scope, then each app's one access choice and its real tools. */
export function BotPermissionsView({ scope, apps, run, approvalMode, onLoadTools, error }: SettingsBotPermissionsProps) {
  const t = useTranslations('Settings.botPermissions')
  const level = (value: PermissionValue) => t(`level.${value}`)
  // A run action with nothing stored runs under its scoped run policy, not the Decision API.
  const runLevel = (value: PermissionValue) => value === 'default' ? t('level.runDefault') : level(value)
  if (!apps) return <div className="flex flex-col gap-4">
    <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>
    {error && <p role="alert" className="text-sm text-destructive-foreground">{error}</p>}
  </div>
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
      {run.map(action => <li key={action.id} className="flex justify-between gap-3 px-4 py-2 text-sm"><span>{action.name}</span><span className="text-muted-foreground">{runLevel(action.value)}</span></li>)}
    </ul>}
  </div>
}

/** The provider's real catalogue, read on first open. A count alone already replaces the old hand-written action list. */
function AppTools({ app, onLoadTools }: { app: BotPermissionApp; onLoadTools?: (app: string) => void }) {
  const t = useTranslations('Settings.botPermissions')
  const [open, setOpen] = useState(false)
  const tools = app.tools
  const catalogued = tools && tools !== 'loading' ? tools : null
  const failed = catalogued && 'error' in catalogued && catalogued.error ? catalogued : null
  // A failed read has a count of zero but no catalogue; keep the trigger at "View tools" so it can be retried.
  const loaded = catalogued && !failed && 'count' in catalogued ? catalogued : null
  return <Collapsible open={open} onOpenChange={next => { setOpen(next); if (next) onLoadTools?.(app.id) }}>
    <CollapsibleTrigger className="cursor-pointer text-left text-xs text-muted-foreground underline-offset-4 hover:underline">
      {loaded ? t('toolsCount', { count: loaded.count, readOnly: loaded.readOnlyCount }) : t('tools')}
    </CollapsibleTrigger>
    {/* Kept mounted while closed so an open panel can show its loading and failure states in place. */}
    <CollapsibleContent keepMounted className="text-xs text-muted-foreground">
      {tools === 'loading' && <p className="pt-1">{t('toolsLoading')}</p>}
      {failed && <p className="pt-1">{t('toolsFailed')}</p>}
      {loaded && <ul className="flex flex-col gap-0.5 pt-1">
        {loaded.tools.slice(0, 100).map(tool => <li key={tool.name}><span>{tool.displayName}</span> <span className="text-muted-foreground/70">{tool.readOnly ? t('readOnly') : t('write')}</span></li>)}
      </ul>}
    </CollapsibleContent>
  </Collapsible>
}
