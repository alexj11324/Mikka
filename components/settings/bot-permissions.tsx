'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { BotPermissionsPage } from '@ui-slot/settings-bot-permissions'
import { listBots } from '@/app/actions/bots'
import { listAgents } from '@/app/actions/agents'
import { AppTile, useAppInfo, useConnectedApps, appState } from '@/components/plugins/connected-apps'
import { withBasePath } from '@/lib/base-path'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { CONFIGURABLE_ACTIONS, CONFIGURABLE_PERMISSIONS, type PermissionDecision } from '@mikka/protocol/agent-policy'
import type { BotPermissionAction, BotPermissionApp, PermissionChoice, PermissionValue, SettingsBotPermissionsProps } from '@/components/slots/settings-bot-permissions-contract'

/** The app writes stored per action (lib/operations/write-schema.ts WRITE_ACTIONS), by the toolkit they act in. */
const WRITES: Record<string, string[]> = { notion: ['append_notion_paragraph'], slack: ['send_slack_message'], googlecalendar: ['cancel_calendar_event'] }

type WritePolicy = { permissions: Record<string, PermissionChoice>; version: string }
type AgentPolicy = { policy: { permissions: Record<string, PermissionDecision>; readOnly?: boolean }; revision: string; layers: { agent: { permissions?: Record<string, PermissionDecision>; networkAllow?: string[]; approvalMode?: 'ask' | 'read_only' } } }

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
 * One Bot's permissions as Mikka stores them: each connected app's write actions with this Bot's allow / ask / deny
 * (or none, so the Decision API judges each call), the workspace's narrower choice where it has one, and the Bot's
 * own layer of the agent run policy with the person's approval mode. Saves go back through the same routes.
 */
export function useBotPermissions(): SettingsBotPermissionsProps {
  const t = useTranslations('Settings.botPermissions')
  const tAction = useTranslations('Coordinator.pendingActions')
  const tError = useTranslations('Settings.botPermissions.errors')
  const info = useAppInfo()
  const apps = useConnectedApps()
  const { data: bots } = useSWR('bots', listBots)
  const { data: agents } = useSWR('agents', () => listAgents())
  const [chosen, setChosen] = useState<string | null | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The Coordinator is a Bot too: its own id keys both its write settings and its run policy layer.
  const coordinator = bots?.find(bot => bot.coordinator)
  const botId = chosen === undefined ? coordinator?.id ?? null : chosen
  const botKey = botId ?? 'coordinator'
  // The worker the run policy is read through: the person's first agent (a Bot's own layer is the same for each).
  const agentId = agents?.[0]?.id ?? null

  const write = useSWR(bots ? ['bot-write-policy', botKey] : null, () => definition<WritePolicy>(botKey, { view: 'write_policy' }), { revalidateOnFocus: false })
  const workspace = useSWR(botId && bots ? ['bot-workspace-write-policy', botKey] : null, () => definition<WritePolicy>(botKey, { view: 'workspace_write_policy' }).catch(() => null), { revalidateOnFocus: false })
  const run = useSWR(agentId && bots ? ['bot-run-policy', botKey, agentId] : null, () => agentPolicy<AgentPolicy>({ operation: 'readAgent', agentId, botId }), { revalidateOnFocus: false })

  const stored = write.data?.permissions ?? {}
  const narrower = workspace.data?.permissions ?? {}
  const writable = write.data !== null && write.data !== undefined
  const writeAction = (action: string): BotPermissionAction => {
    const value = stored[action] ?? 'default'
    const workspaceValue = narrower[action]
    return { id: action, name: tAction(action as never), value, effective: workspaceValue && workspaceValue !== value ? workspaceValue : null, choices: ['default', 'allow', 'ask', 'deny'], editable: writable }
  }
  const connected = apps.connectedToolkits().filter(id => appState(apps.accountsFor(id)).on)
  const withSettings = Object.entries(WRITES).filter(([, actions]) => actions.some(action => stored[action])).map(([id]) => id)
  const appList: BotPermissionApp[] | null = apps.loading || !bots || write.isLoading ? null : [...new Set([...connected, ...withSettings])].map(id => {
    const account = apps.accountsFor(id).find(item => item.enabled)
    return { id, name: info(id).name, account: account?.alias ?? account?.email ?? null, iconUrl: info(id).iconUrl, actions: (WRITES[id] ?? []).map(writeAction) }
  })

  const agentLayer = run.data?.layers.agent ?? {}
  const runActions: BotPermissionAction[] | null = !run.data ? null : CONFIGURABLE_ACTIONS.map(action => {
    const value = agentLayer.permissions?.[action] ?? 'default'
    const effective = run.data!.policy.permissions[action]
    return {
      id: action, name: t(`run.${action}`), value, effective: effective !== value ? effective : null,
      choices: ['default', ...CONFIGURABLE_PERMISSIONS[action]],
      // The Bot's layer stores no computer_use (lib/agent-tool-approval/policy-store.ts): it is set on the computer.
      editable: action !== 'computer_use',
    }
  })

  async function save(work: () => Promise<unknown>) {
    setSaving(true); setError(null)
    try { await work() } catch (failure) {
      const code = failure instanceof PermissionsReadError ? failure.code : 'unknown'
      setError(tError.has(code as never) ? tError(code as never) : tError('saveFailed'))
    } finally { setSaving(false) }
  }

  return {
    bots: [...(bots ?? []).filter(bot => bot.coordinator), ...(bots ?? []).filter(bot => !bot.coordinator)].map(bot => ({ id: bot.id, name: bot.name })),
    botId, onBot: id => { setChosen(id); setError(null) },
    apps: appList,
    run: runActions,
    approvalMode: run.data ? { value: agentLayer.approvalMode ?? 'ask', editable: true } : null,
    onApprovalMode: mode => { void save(async () => {
      if (!run.data || !agentId) return
      await agentPolicy({ operation: 'setAgent', agentId, botId, target: 'agent', expectedRevision: run.data.revision, policy: { ...agentLayer, approvalMode: mode } })
      await run.mutate()
    }) },
    onAction: (kind, ids, value) => { void save(async () => {
      if (kind === 'write') {
        if (!write.data) return
        const permissions = { ...write.data.permissions }
        for (const id of ids) { if (value === 'default') delete permissions[id]; else permissions[id] = value }
        await definition(botKey, { body: { action: 'set_write_policy', permissions, expectedVersion: write.data.version } })
        await write.mutate()
      } else {
        if (!run.data || !agentId) return
        const permissions = { ...agentLayer.permissions }
        for (const id of ids) { if (value === 'default') delete permissions[id]; else permissions[id] = value }
        await agentPolicy({ operation: 'setAgent', agentId, botId, target: 'agent', expectedRevision: run.data.revision, policy: { ...agentLayer, permissions } })
        await run.mutate()
      }
    }) },
    saving,
    error: error ?? (write.error || run.error ? tError('readFailed') : null),
  }
}

export function BotPermissionsSettings() {
  return <BotPermissionsPage {...useBotPermissions()} />
}

/** The open-source page: the rule in one line, the Bot, then each app's actions and the run actions with their values. */
export function BotPermissionsView({ bots, botId, onBot, apps, run, approvalMode, error }: SettingsBotPermissionsProps) {
  const t = useTranslations('Settings.botPermissions')
  const level = (value: PermissionValue, run = false) => run && value === 'default' ? t('level.workspaceDefault') : t(`level.${value}`)
  if (!apps) return <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>
  return <div className="flex flex-col gap-4">
    <p className="text-sm text-muted-foreground">{t('rule')}</p>
    <FieldGroup><Field orientation="horizontal"><FieldLabel htmlFor="bot-permissions-bot">{t('bot')}</FieldLabel>
      <NativeSelect id="bot-permissions-bot" value={botId ?? ''} onChange={event => onBot(event.target.value || null)}>
        {bots.map(bot => <NativeSelectOption key={bot.id ?? 'coordinator'} value={bot.id ?? ''}>{bot.name}</NativeSelectOption>)}
      </NativeSelect>
    </Field></FieldGroup>
    {approvalMode && <p className="text-sm">{t('mode')}: {t(`modes.${approvalMode.value}`)}</p>}
    {error && <p role="alert" className="text-sm text-destructive-foreground">{error}</p>}
    {apps.length === 0 ? <p className="text-sm text-muted-foreground">{t('empty')}</p>
      : <ul className="flex flex-col divide-y rounded-xl border">
        {apps.map(app => <li key={app.id} className="flex items-start gap-3 px-4 py-3">
          <AppTile app={app.id} iconUrl={app.iconUrl} />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-sm font-medium">{app.name}{app.account && <span className="ml-2 font-normal text-muted-foreground">{app.account}</span>}</p>
            <p className="text-xs text-muted-foreground">{app.actions.length ? app.actions.map(action => `${action.name} · ${level(action.value)}`).join('，') : level('default')}</p>
          </div>
        </li>)}
      </ul>}
    {run && <ul className="flex flex-col divide-y rounded-xl border">
      {run.map(action => <li key={action.id} className="flex justify-between gap-3 px-4 py-2 text-sm"><span>{action.name}</span><span className="text-muted-foreground">{level(action.value, true)}</span></li>)}
    </ul>}
  </div>
}
