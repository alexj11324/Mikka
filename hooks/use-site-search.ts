'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchSiteSearchPage, mergeById, SiteSearchRequestError, siteSearchQuery, type SiteSearchError, type SiteSearchItem, type SiteSearchSource } from '@/lib/site-search'

export type SourceState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  items: SiteSearchItem[]
  nextCursor: string | null
  /** A further page is being read; the loaded rows stay. */
  loadingMore: boolean
  error: SiteSearchError | null
}

const IDLE: SourceState = { status: 'idle', items: [], nextCursor: null, loadingMore: false, error: null }
const SOURCES = ['history', 'groups', 'tasks'] as const satisfies SiteSearchSource[]
export type ListedSource = typeof SOURCES[number]
const DEBOUNCE_MS = 200
const IDLE_SOURCES = { history: IDLE, groups: IDLE, tasks: IDLE }
type SearchRun = { key: string; controller: AbortController; pending: Set<ListedSource> }

/**
 * Server search for ⌘K: one independent page per source, each continued with
 * its own cursor (the contract promises no order across sources). A new query
 * aborts the old requests. Groups and tasks wait for the workspace; history is
 * the person's own and needs none.
 */
export function useSiteSearch(query: string, workspaceId: string | null) {
  const parsed = siteSearchQuery(query)
  const q = parsed.kind === 'ready' ? parsed.q : null
  const key = q === null ? '' : JSON.stringify([q, workspaceId])
  const [pages, setState] = useState<Record<ListedSource, SourceState>>(IDLE_SOURCES)
  const [pageKey, setPageKey] = useState('')
  const [authRequired, setAuthRequired] = useState(false)
  const state = key === pageKey ? pages : IDLE_SOURCES
  const run = useRef<SearchRun | null>(null)

  const load = useCallback((source: ListedSource, query: string, cursor: string | null, active: SearchRun) => {
    const { controller, pending } = active
    if (controller.signal.aborted || pending.has(source)) return
    pending.add(source)
    setState(current => ({ ...current, [source]: cursor ? { ...current[source], loadingMore: true, error: null } : { ...IDLE, status: 'loading' } }))
    fetchSiteSearchPage({ source, q: query, workspaceId, cursor, signal: controller.signal }).then(page => {
      if (controller.signal.aborted) return
      setAuthRequired(false)
      setState(current => ({ ...current, [source]: { status: 'ready', items: mergeById(cursor ? current[source].items : [], page.items), nextCursor: page.nextCursor, loadingMore: false, error: null } }))
    }, (error: unknown) => {
      if (controller.signal.aborted) return
      const code = error instanceof SiteSearchRequestError ? error.code : 'searchUnavailable'
      if (code === 'authRequired') {
        controller.abort()
        setAuthRequired(true)
        setState({ ...IDLE_SOURCES, [source]: { ...IDLE, status: 'error', error: code } })
        return
      }
      // A transient failure keeps the page. A denied source must be read afresh.
      setState(current => ({ ...current, [source]: cursor && code !== 'searchAccessDenied'
        ? { ...current[source], loadingMore: false, error: code }
        : { ...IDLE, status: 'error', error: code } }))
    }).finally(() => pending.delete(source))
  }, [workspaceId])

  const sources = SOURCES.filter(source => source === 'history' || workspaceId)
  useEffect(() => {
    run.current?.controller.abort()
    run.current = null
    setPageKey(key)
    if (q === null) { setState(IDLE_SOURCES); return }
    const controller = new AbortController()
    const active: SearchRun = { key, controller, pending: new Set() }
    run.current = active
    setState({ history: { ...IDLE, status: 'loading' }, groups: workspaceId ? { ...IDLE, status: 'loading' } : IDLE, tasks: workspaceId ? { ...IDLE, status: 'loading' } : IDLE })
    const timer = setTimeout(() => { for (const source of SOURCES) if (source === 'history' || workspaceId) load(source, q, null, active) }, DEBOUNCE_MS)
    return () => { clearTimeout(timer); controller.abort() }
    // key is q and workspaceId; load only changes with workspaceId.
  }, [key])

  const more = useCallback((source: ListedSource) => {
    const current = run.current
    const page = state[source]
    if (!current || current.key !== key || q === null || !page.nextCursor || page.loadingMore) return
    load(source, q, page.nextCursor, current)
  }, [state, q, key, load])
  /** After a failed next page, retries that page; otherwise reads the first page again. */
  const retry = useCallback((source: ListedSource) => {
    const current = run.current
    const page = state[source]
    if (!current || current.key !== key || q === null || !page.error) return
    load(source, q, page.status === 'ready' ? page.nextCursor : null, current)
  }, [state, q, key, load])

  const searching = sources.some(source => state[source].status === 'loading')
  return { query: parsed, state, sources, searching, authRequired, more, retry }
}
