import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { api, ApiError } from '@/lib/api'
import { choiceFailureLine } from '@/lib/model-choice'
import { useApi } from '@/lib/useApi'
import { optionName, type ModelMenu } from './model-menu-view'
import { apiCache } from './api-cache'
import { ModelMenuRead } from './model-menu-read'
import { ModelMenuWrite } from './model-menu-write'
export { HOSTED_CHOICE, groupTitle, groupTag, optionName, modelMenuLabel, modelSourceLabel, modelMenuReadLabel, modelStatusLine, type ModelOption, type ModelGroup, type ModelMenu } from './model-menu-view'

export interface ChoiceFailure { id: string; line: string }

/** Saved per bot for its next runs. Failed writes retain the confirmed selection. */
export function useModelMenu(botId: string | null) {
  const path = `/api/mobile/model${botId ? `?bot=${botId}` : ''}`
  const { data, setData, error, loading, reload } = useApi<ModelMenu>(path)
  const context = apiCache.context()
  const identity = `${botId}:${context}`
  const active = useRef<string | null>(identity)
  active.current = identity
  const reader = useMemo(() => new ModelMenuRead(reload), [reload, context])
  const writer = useMemo(() => new ModelMenuWrite(), [identity])
  const retrying = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot)
  const busy = useSyncExternalStore(writer.subscribe, writer.snapshot, writer.snapshot)
  const [failure, setFailure] = useState<ChoiceFailure | null>(null)
  const [choosing, setChoosing] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)
  useEffect(() => {
    active.current = identity; setFailure(null); setChoosing(null); setRefreshing(false); setRefreshFailed(false)
    return () => { if (active.current === identity) active.current = null }
  }, [identity])
  const choose = useCallback((id: string) => writer.run(async () => {
    const accept = (apply: () => void) => apiCache.commit(context, () => { if (active.current === identity) apply() })
    accept(() => { setFailure(null); setChoosing(id) })
    try {
      const next = await api<ModelMenu>('/api/mobile/model', { method: 'PUT', body: { bot: botId, id } })
      accept(() => setData(next))
      return active.current === identity && apiCache.context() === context
    } catch (error) {
      const option = data?.groups.flatMap(group => group.options).find(item => item.id === id)
      accept(() => setFailure({ id, line: choiceFailureLine(option ? optionName(option) : optionName({ id, modelId: '' }), error instanceof ApiError ? error.code : null) }))
      return false
    } finally { accept(() => setChoosing(null)) }
  }), [botId, context, data, identity, setData, writer])
  const refresh = useCallback(() => writer.run(async () => {
    const accept = (apply: () => void) => apiCache.commit(context, () => { if (active.current === identity) apply() })
    accept(() => { setRefreshing(true); setRefreshFailed(false) })
    try {
      const next = await api<ModelMenu>('/api/mobile/model', { method: 'POST', body: { bot: botId } })
      accept(() => setData(next))
    } catch { accept(() => setRefreshFailed(true)) }
    finally { accept(() => setRefreshing(false)) }
  }), [botId, context, identity, setData, writer])
  return { menu: data, choose, failure, choosing, busy, refresh, refreshing, refreshFailed, loading: loading || retrying, loadFailed: !data && Boolean(error), readError: error, retryRead: reader.retry }
}

export type ModelMenuState = ReturnType<typeof useModelMenu>

export type ModelMenuControls = Pick<ModelMenuState, 'menu' | 'loading' | 'busy' | 'choosing' | 'refreshing' | 'refreshFailed'> & {
  choose: (id: string) => unknown
  refresh: () => unknown
  retryRead: () => Promise<unknown>
}
