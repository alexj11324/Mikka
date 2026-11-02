import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { api, ApiError } from '@/lib/api'
import { choiceFailureLine } from '@/lib/model-choice'
import { useApi } from '@/lib/useApi'
import { optionName, type ModelMenu } from './model-menu-view'
import { apiCache } from './api-cache'
import { ModelMenuRead } from './model-menu-read'
export { HOSTED_CHOICE, groupTitle, groupTag, optionName, modelMenuLabel, modelMenuReadLabel, modelStatusLine, type ModelOption, type ModelGroup, type ModelMenu } from './model-menu-view'

/** The shapes `GET/PUT /api/mobile/model` return (lib/bot-model-menu-view.ts on the server). */
/** A pick that did not save: which one, and the line naming it and why. */
export interface ChoiceFailure { id: string; line: string }

/**
 * The composer's model menu for a bot, or the Coordinator (`botId` null);
 * `choose` saves for the bot's next runs. A pick that does not save leaves the
 * chip on the saved model and sets `failure` (shown above the composer, with 重试).
 */
export function useModelMenu(botId: string | null) {
  const path = `/api/mobile/model${botId ? `?bot=${botId}` : ''}`
  const { data, setData, error, loading, reload } = useApi<ModelMenu>(path)
  const context = apiCache.context()
  const reader = useMemo(() => new ModelMenuRead(reload), [reload, context])
  const retrying = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot)
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
  return { menu: data, choose, failure, refresh, refreshing, refreshFailed, loading: loading || retrying, loadFailed: !data && Boolean(error), retryRead: reader.retry }
}

export type ModelMenuState = ReturnType<typeof useModelMenu>
