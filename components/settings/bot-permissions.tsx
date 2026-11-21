'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from '@/lib/intl/i18n-client'
import { BotPermissionsPage } from '@ui-slot/settings-bot-permissions'
import { listBots, listBotsForWorkspace } from '@/app/actions/bots'
import { listAgents } from '@/app/actions/agents'
import { SettingRow, SettingsLoading, SettingsSection } from '@/components/settings/primitives'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { withBasePath } from '@/lib/base-path'
import { CONFIGURABLE_ACTIONS, CONFIGURABLE_PERMISSIONS, type PermissionDecision } from '@mikka/protocol/agent-policy'
import type { BotPermissionAction, PermissionValue, SettingsBotPermissionsProps } from '@/components/slots/settings-bot-permissions-contract'

type PolicyLayer = { permissions?: Record<string, PermissionDecision>; networkAllow?: string[]; approvalMode?: 'ask' | 'read_only'; defaults?: unknown }
type AgentPolicy = { revision: string; layers: { workspace?: PolicyLayer } }

class PermissionsReadError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'PermissionsReadError' }
}

async function agentPolicy<T>(body: unknown): Promise<T> {
  const response = await fetch(withBasePath('/api/agent-cli-policy'), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const value = await response.json().catch(() => null) as (T & { error?: string }) | null
  if (!response.ok || !value) throw new PermissionsReadError(value?.error ?? `http_${response.status}`)
  return value
}

export function botPermissionsErrorKey(input: { bots: unknown[] | undefined; workspaceId?: string; readFailed: boolean }): 'readFailed' | 'noBotInWorkspace' | null {
  if (input.readFailed) return 'readFailed'
  if (input.workspaceId && input.bots?.length === 0) return 'noBotInWorkspace'
  return null
}

export function useBotPermissions({ admin = false, workspaceId }: { admin?: boolean; workspaceId?: string } = {}): SettingsBotPermissionsProps {
  const t = useTranslations('Settings.botPermissions')
  const tError = useTranslations('Settings.botPermissions.errors')
  const { data: bots, error: botsError } = useSWR(workspaceId ? ['bots', 'workspace', workspaceId] : 'bots', () => workspaceId ? listBotsForWorkspace(workspaceId) : listBots())
  const { data: agents, error: agentsError } = useSWR('agents', () => listAgents())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The existing workspace run-policy API resolves its scope through a Bot and an agent.
  const botId = bots?.[0]?.id ?? null
  const agentId = agents?.[0]?.id ?? null
  const run = useSWR(agentId && botId && workspaceId ? ['workspace-run-policy', workspaceId, botId, agentId] : null, () => agentId && botId ? agentPolicy<AgentPolicy>({ operation: 'readAgent', agentId, botId }) : null, { revalidateOnFocus: false })

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

  async function save(work: () => Promise<unknown>) {
    setSaving(true); setError(null)
    try { await work() } catch (failure) {
      const code = failure instanceof PermissionsReadError ? failure.code : 'unknown'
      setError(tError.has(code as never) ? tError(code as never) : tError('saveFailed'))
    } finally { setSaving(false) }
  }

  return {
    run: runActions,
    approvalMode: run.data ? { value: workspaceLayer.approvalMode ?? 'ask', editable: admin } : null,
    onApprovalMode: mode => { void save(async () => {
      if (!admin || !run.data || !agentId) return
      await agentPolicy({ operation: 'setAgent', agentId, botId, target: 'workspace', expectedRevision: run.data.revision, policy: { ...workspaceLayer, approvalMode: mode } })
      await run.mutate()
    }) },
    onAction: (id, value) => { void save(async () => {
      if (!admin || !run.data || !agentId) return
      const permissions = { ...workspaceLayer.permissions }
      if (value === 'default') delete permissions[id]
      else permissions[id] = value
      await agentPolicy({ operation: 'setAgent', agentId, botId, target: 'workspace', expectedRevision: run.data.revision, policy: { ...workspaceLayer, permissions } })
      await run.mutate()
    }) },
    saving,
    error: error ?? (() => {
      const key = botPermissionsErrorKey({ bots, workspaceId, readFailed: Boolean(run.error || botsError || agentsError) })
      return key ? tError(key) : agents?.length === 0 ? tError('noAgent') : null
    })(),
  }
}

export function BotPermissionsSettings({ admin = false, workspaceId }: { admin?: boolean; workspaceId?: string }) {
  return <BotPermissionsPage {...useBotPermissions({ admin, workspaceId })} />
}

export function BotPermissionsView({ run, approvalMode, onApprovalMode, onAction, saving, error }: SettingsBotPermissionsProps) {
  const t = useTranslations('Settings.botPermissions')
  const level = (value: PermissionValue) => value === 'default' ? t('level.runDefault') : t(`level.${value}`)
  return <div className="flex flex-col gap-4">
    {error && <p role="alert" className="text-sm text-destructive-foreground">{error}</p>}
    {!run && !error && <SettingsLoading label={t('loading')} rows={2} bare />}
    {run && <SettingsSection>
      {approvalMode && <SettingRow title={t('mode')}>
        {approvalMode.editable
          ? <NativeSelect aria-label={t('mode')} value={approvalMode.value} disabled={saving}
              onChange={event => onApprovalMode(event.target.value as typeof approvalMode.value)}>
              <NativeSelectOption value="ask">{t('modes.ask')}</NativeSelectOption>
              <NativeSelectOption value="read_only">{t('modes.read_only')}</NativeSelectOption>
            </NativeSelect>
          : <span className="text-muted-foreground">{t(`modes.${approvalMode.value}`)}</span>}
      </SettingRow>}
      {run.map(action => <SettingRow key={action.id} title={action.name}>
        {action.editable
          ? <NativeSelect aria-label={action.name} value={action.value} disabled={saving}
              onChange={event => onAction(action.id, event.target.value as PermissionValue)}>
              {action.choices.map(choice => <NativeSelectOption key={choice} value={choice}>{level(choice)}</NativeSelectOption>)}
            </NativeSelect>
          : <span className="text-muted-foreground">{level(action.value)}</span>}
      </SettingRow>)}
    </SettingsSection>}
  </div>
}
