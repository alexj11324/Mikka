import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { api, ApiError, onWorkspaceChange } from '@/lib/api'

// The last answer per path, so a screen opened again draws at once and refreshes behind (a chat is not blank while it loads).
// Another workspace's answers are dropped.
const cache = new Map<string, unknown>()
onWorkspaceChange(() => cache.clear())

/** Loads `path` ahead of its screen, once, so opening it draws at once (对话 warms the top chats). */
export async function prefetch(path: string) {
  if (cache.has(path)) return
  try { cache.set(path, await api(path)) } catch { /* the screen loads it itself */ }
}

/** On signing out: nothing of this account is drawn for the next. */
export const clearApiCache = () => cache.clear()

/**
 * Loads `path`, reloads it every `every` ms while the app is in front (0: no
 * polling), and lets the screen reload or patch it after a write. It starts
 * from the path's last answer, when there is one.
 */
export function useApi<T>(path: string | null, every = 0) {
  const [data, setStored] = useState<T | null>(() => (path ? cache.get(path) as T | undefined : undefined) ?? null)
  const setData = useCallback((next: T | null | ((current: T | null) => T | null)) => {
    setStored(current => {
      const value = typeof next === 'function' ? (next as (current: T | null) => T | null)(current) : next
      if (path && value !== null) cache.set(path, value)
      return value
    })
  }, [path])
  const [error, setError] = useState<ApiError | Error | null>(null)
  const [loading, setLoading] = useState(Boolean(path))
  const alive = useRef(true)

  const load = useCallback(async () => {
    if (!path) return
    try {
      const next = await api<T>(path)
      if (alive.current) { setData(next); setError(null) }
    } catch (failure) {
      if (alive.current) setError(failure as Error)
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [path, setData])

  useEffect(() => {
    alive.current = true
    setStored((path ? cache.get(path) as T | undefined : undefined) ?? null)
    setLoading(Boolean(path))
    void load()
    return () => { alive.current = false }
  }, [load, path])

  useEffect(() => onWorkspaceChange(() => void load()), [load])

  useEffect(() => {
    if (!every || !path) return
    let timer: ReturnType<typeof setInterval> | null = setInterval(load, every)
    const sub = AppState.addEventListener('change', state => {
      // Back in the foreground the poll resumes on its schedule; returning never reads by itself.
      if (state === 'active' && !timer) timer = setInterval(load, every)
      if (state !== 'active' && timer) { clearInterval(timer); timer = null }
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
