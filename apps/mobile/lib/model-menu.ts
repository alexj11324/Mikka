import { useCallback, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { choiceFailureLine } from '@/lib/model-choice'
import { useApi } from '@/lib/useApi'

/** The shapes `GET/PUT /api/mobile/model` return (lib/bot-model-menu-view.ts on the server). */
export const HOSTED_CHOICE = '00000000-0000-0000-0000-000000000000'
export type ModelGroupKind = 'hosted' | 'subscription' | 'apiKey' | 'shared'
export interface ModelOption { id: string; modelId: string; provider: string }
export interface ModelGroup { kind: ModelGroupKind; provider?: string; plan?: string | null; owner?: string; options: ModelOption[] }
export interface ModelMenu { groups: ModelGroup[]; current: ModelOption & { kind: ModelGroupKind; chosen: boolean; available: boolean } }

const providerName = (provider?: string) => provider === 'claude' ? 'Claude' : 'ChatGPT'

/** A group's heading, as on the web (decision 2026-10-31-2330): the plan names a subscription. */
export function groupTitle(group: ModelGroup) {
  switch (group.kind) {
    case 'hosted': return 'Mikka'
    case 'subscription': return group.plan ? `${providerName(group.provider)} ${group.plan}` : providerName(group.provider)
    case 'apiKey': return 'API Key'
    case 'shared': return '团队成员分享的'
  }
}

/** Who pays for an item in the group, shown under its name; a subscription item has none. */
export function groupTag(group: ModelGroup) {
  if (group.kind === 'hosted') return '点数'
  if (group.kind === 'apiKey') return '按量'
  if (group.kind === 'shared' && group.owner) return `${group.owner}的 Key`
  return null
}

export function optionName(option: Pick<ModelOption, 'id' | 'modelId'>) {
  return option.id === HOSTED_CHOICE ? 'Mikka 默认' : option.modelId || '未知模型'
}

/** A pick that did not save: which one, and the line naming it and why. */
export interface ChoiceFailure { id: string; line: string }

/**
 * The composer's model menu for a bot, or the Coordinator (`botId` null);
 * `choose` saves for the bot's next runs. A pick that does not save leaves the
 * chip on the saved model and sets `failure` (shown above the composer, with 重试).
 */
export function useModelMenu(botId: string | null) {
  const path = `/api/mobile/model${botId ? `?bot=${botId}` : ''}`
  const { data, setData } = useApi<ModelMenu>(path)
  const [failure, setFailure] = useState<ChoiceFailure | null>(null)
  const choose = useCallback(async (id: string) => {
    setFailure(null)
    try {
      setData(await api<ModelMenu>('/api/mobile/model', { method: 'PUT', body: { bot: botId, id } }))
    } catch (error) {
      const option = data?.groups.flatMap(group => group.options).find(item => item.id === id)
      setFailure({ id, line: choiceFailureLine(option ? optionName(option) : optionName({ id, modelId: '' }), error instanceof ApiError ? error.code : null) })
    }
  }, [botId, data, setData])
  const [refreshing, setRefreshing] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)
  /** 刷新: asks each subscription for its models, then reads the menu again. */
  const refresh = useCallback(async () => {
    setRefreshing(true)
    setRefreshFailed(false)
    try {
      setData(await api<ModelMenu>('/api/mobile/model', { method: 'POST', body: { bot: botId } }))
    } catch {
      setRefreshFailed(true)
    } finally {
      setRefreshing(false)
    }
  }, [botId, setData])
  return { menu: data, choose, failure, refresh, refreshing, refreshFailed }
}

export type ModelMenuState = ReturnType<typeof useModelMenu>
