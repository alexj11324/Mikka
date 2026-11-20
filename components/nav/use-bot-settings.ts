'use client'

import useSWR from 'swr'
import { withBasePath } from '@/lib/base-path'
import { useActionError } from '@/lib/use-action-error'
import { listBotEnvironments } from '@/app/actions/bots'
import type { BotOverviewSettings, BotSettingsPatch, BotSettingsValue } from '@/components/slots/bot-overview-contract'

/** The owner endpoint (app/api/bots/[botId]): the Bot's Captain settings, access and followers. */
async function request(botId: string, workspaceId: string | undefined, init?: { method: 'PATCH' | 'POST'; path?: string; body: unknown }): Promise<BotSettingsValue> {
  const query = workspaceId ? '?' + new URLSearchParams({ workspaceId }) : ''
  const response = await fetch(withBasePath(`/api/bots/${botId}${init?.path ?? ''}${query}`), init ? {
    method: init.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body),
  } : { cache: 'no-store' })
  const body = await response.json()
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'generic')
  return body as BotSettingsValue
}

/**
 * Bot Profile (Alias, Environment, Tasks run on, Default agent, effort, Access,
 * Owner), read once while 详情 is shown and saved field by field. Nothing here
 * refreshes on its own.
 */
export function useBotSettings(botId: string, workspaceId: string | undefined, visible: boolean): BotOverviewSettings {
  const actionError = useActionError()
  const { data, error, mutate } = useSWR(visible ? ['bot-settings', workspaceId ?? null, botId] : null, () => request(botId, workspaceId), { shouldRetryOnError: false, revalidateOnFocus: false })
  const environments = useSWR(visible ? ['bot-environments', workspaceId ?? null] : null, async () => {
    const result = await listBotEnvironments(workspaceId)
    if (result.error) throw new Error(result.error)
    return result.environments
  }, { shouldRetryOnError: false, revalidateOnFocus: false })
  const run = async (work: () => Promise<BotSettingsValue | null>) => {
    try {
      const next = await work()
      await mutate(next ?? undefined, { revalidate: next === null })
      return null
    } catch (failure) { return actionError(failure instanceof Error ? failure.message : null) }
  }
  return {
    loaded: !!data, loadError: !!error, retry: () => { void mutate() }, value: data ?? null,
    environments: (environments.data ?? []).map(item => ({ value: item.id, label: item.name })),
    save: (patch: BotSettingsPatch) => run(() => request(botId, workspaceId, { method: 'PATCH', body: patch })),
    transfer: (ownerId: string) => run(async () => { await request(botId, workspaceId, { method: 'POST', path: '/transfer', body: { ownerId } }); return null }),
  }
}
