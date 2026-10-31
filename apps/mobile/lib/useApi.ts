import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { api, ApiError } from '@/lib/api'

/**
 * Loads `path`, reloads it every `every` ms while the app is in front (0: no
 * polling), and lets the screen reload or patch it after a write.
 */
export function useApi<T>(path: string | null, every = 0) {
  const [data, setData] = useState<T | null>(null)
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
  }, [path])

  useEffect(() => {
    alive.current = true
    setLoading(Boolean(path))
    void load()
    return () => { alive.current = false }
  }, [load, path])

  useEffect(() => {
    if (!every || !path) return
    let timer: ReturnType<typeof setInterval> | null = setInterval(load, every)
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active' && !timer) { void load(); timer = setInterval(load, every) }
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
