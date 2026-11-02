import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { api, ApiError, onWorkspaceChange } from '@/lib/api'
import { apiCache as cache } from './api-cache'

// The last answer per path, so a screen opened again draws at once and refreshes behind (a chat is not blank while it loads).
// Another workspace's answers are dropped.
/** Data younger than this is fresh: coming back to the app leaves it alone (decision 2026-11-01-0400-no-refetch-on-focus). */
export const FRESH_FOR_MS = 60_000
onWorkspaceChange(() => cache.clear())

/** Loads `path` ahead of its screen, once, so opening it draws at once (对话 warms the top chats). */
export async function prefetch(path: string) {
  await cache.prefetch(path, api)
}

/** On signing out: nothing of this account is drawn for the next. */
export const clearApiCache = () => cache.clear()

/**
 * Loads `path`, reloads it every `every` ms while the app is in front (0: no
 * polling), and lets the screen reload or patch it after a write. It starts
 * from the path's last answer, when there is one.
 */
export function useApi<T>(path: string | null, every = 0) {
  const [data, setStored] = useState<T | null>(() => path ? cache.get<T>(path) : null)
  const [error, setError] = useState<ApiError | Error | null>(null)
  const [loading, setLoading] = useState(Boolean(path))
  const request = useRef(0)
  const context = cache.context()
  const setData = useCallback((next: T | null | ((current: T | null) => T | null)) => {
    cache.commit(context, () => {
      // A saved mutation is newer than a read already in flight.
      request.current++; setLoading(false)
      setStored(current => {
        let value = current
        cache.commit(context, () => {
          value = typeof next === 'function' ? (next as (current: T | null) => T | null)(current) : next
          if (path && value !== null) cache.set(path, value, context)
        })
        return value
      })
    })
  }, [path, context])
  const alive = useRef(true)
  const loadedAt = useRef(0)

  const load = useCallback(async () => {
    if (!path) return
    const context = cache.context(), ticket = ++request.current
    const accept = (apply: () => void) => cache.commit(context, () => { if (alive.current && ticket === request.current) apply() })
    try {
      const next = await api<T>(path)
      accept(() => { cache.set(path, next, context); setStored(next); setError(null); loadedAt.current = Date.now() })
    } catch (failure) {
      accept(() => setError(failure as Error))
    } finally {
      accept(() => setLoading(false))
    }
  }, [path])

  useEffect(() => {
    alive.current = true
    setStored(path ? cache.get<T>(path) : null)
    setError(null)
    loadedAt.current = 0
    setLoading(Boolean(path))
    void load()
    return () => { alive.current = false; request.current++ }
  }, [load, path])

  useEffect(() => onWorkspaceChange(() => {
    setStored(null); setError(null); loadedAt.current = 0; setLoading(Boolean(path))
    void load()
  }), [load, path])

  useEffect(() => {
    if (!path) return
    let timer: ReturnType<typeof setInterval> | null = every ? setInterval(load, every) : null
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        // Stale-while-revalidate: one silent read only when the data is older than
        // FRESH_FOR_MS; the screen keeps what it shows meanwhile.
        if (loadedAt.current && Date.now() - loadedAt.current >= FRESH_FOR_MS) void load()
        if (every && !timer) timer = setInterval(load, every)
      } else if (timer) { clearInterval(timer); timer = null }
    })
    return () => { if (timer) clearInterval(timer); sub.remove() }
  }, [every, load, path])

  return { data, error, loading, reload: load, setData }
}

/** Pull to refresh for a list (the system's RefreshControl): reloads and shows the spinner until the data is back. */
export function useRefresh(reload: () => Promise<void>) {
  const [refreshing, setRefreshing] = useState(false)
  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try { await reload() } finally { setRefreshing(false) }
  }, [reload])
  return { refreshing, onRefresh }
}
