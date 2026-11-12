'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
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
// Keep confirmed denials in the existing authenticated SWR provider when the
// palette closes. Reopening cannot authorize a cached preview. The affected
// sources then use their normal server-backed search, including recent rows.
const INITIAL_ACCESS = { workspaceDenied: false, serverTasks: false, serverHistory: false }
const SESSION_KEY = 'site-search-session-required'
type SearchAccess = typeof INITIAL_ACCESS
type SearchRun = { key: string; controller: AbortController; pending: Set<ListedSource> }

/**
 * Server search for ⌘K: one independent page per source, each continued with
 * its own cursor (the contract promises no order across sources). A new query
 * aborts the old requests. Groups and tasks wait for the workspace; history is
 * the person's own and needs none.
 */
export function useSiteSearch(query: string, workspaceId: string | null) {
  const parsed = siteSearchQuery(query)
  const { mutate } = useSWRConfig()
  const { data: authRequired = false } = useSWR<boolean>(SESSION_KEY, null)
  const { data: access = INITIAL_ACCESS } = useSWR<SearchAccess>(['site-search-access', workspaceId], null)
  const recent = parsed.kind === 'empty' && !authRequired && (access.serverHistory || Boolean(workspaceId && access.serverTasks))
  const q = parsed.kind === 'ready' ? parsed.q : recent ? '' : null
  const sources = SOURCES.filter(source => recent
    ? source === 'history' && access.serverHistory || source === 'tasks' && workspaceId && access.serverTasks
    : source === 'history' || workspaceId)
  const key = q === null ? '' : JSON.stringify([q, workspaceId, sources])
  const [pages, setState] = useState<Record<ListedSource, SourceState>>(IDLE_SOURCES)
  const [pageKey, setPageKey] = useState('')
  const state = key === pageKey ? pages : IDLE_SOURCES
  const run = useRef<SearchRun | null>(null)

  const remember = useCallback((change: Partial<SearchAccess>) => {
    void mutate<SearchAccess>(['site-search-access', workspaceId], current => ({ ...(current ?? INITIAL_ACCESS), ...change }), { revalidate: false })
  }, [mutate, workspaceId])

  const load = useCallback((source: ListedSource, query: string, cursor: string | null, active: SearchRun) => {
    const { controller, pending } = active
    if (controller.signal.aborted || pending.has(source)) return
    pending.add(source)
    setState(current => ({ ...current, [source]: cursor ? { ...current[source], loadingMore: true, error: null } : { ...IDLE, status: 'loading' } }))
    fetchSiteSearchPage({ source, q: query, workspaceId, cursor, signal: controller.signal }).then(page => {
      if (controller.signal.aborted) return
      void mutate<boolean>(SESSION_KEY, false, { revalidate: false })
      if (source === 'tasks') remember({ workspaceDenied: false })
      setState(current => ({ ...current, [source]: { status: 'ready', items: mergeById(cursor ? current[source].items : [], page.items), nextCursor: page.nextCursor, loadingMore: false, error: null } }))
    }, (error: unknown) => {
      if (controller.signal.aborted) return
      const code = error instanceof SiteSearchRequestError ? error.code : 'searchUnavailable'
      if (code === 'authRequired') {
        controller.abort()
        void mutate<boolean>(SESSION_KEY, true, { revalidate: false })
        remember({ workspaceDenied: true, serverTasks: true, serverHistory: true })
        setState({ ...IDLE_SOURCES, [source]: { ...IDLE, status: 'error', error: code } })
        return
      }
      if (code === 'searchAccessDenied') {
        if (source === 'tasks') remember({ workspaceDenied: true, serverTasks: true })
        if (source === 'history') remember({ serverHistory: true })
      }
      // A transient failure keeps the page. A denied source must be read afresh.
      setState(current => ({ ...current, [source]: cursor && code !== 'searchAccessDenied'
        ? { ...current[source], loadingMore: false, error: code }
        : { ...IDLE, status: 'error', error: code } }))
    }).finally(() => pending.delete(source))
  }, [workspaceId, mutate, remember])

  useEffect(() => {
    run.current?.controller.abort()
    run.current = null
    setPageKey(key)
    if (q === null) { setState(IDLE_SOURCES); return }
    const controller = new AbortController()
    const active: SearchRun = { key, controller, pending: new Set() }
    run.current = active
    const initial = { ...IDLE_SOURCES }
    for (const source of sources) initial[source] = { ...IDLE, status: 'loading' }
    setState(initial)
    const timer = setTimeout(() => { for (const source of sources) load(source, q, null, active) }, DEBOUNCE_MS)
    return () => { clearTimeout(timer); controller.abort() }
    // The serialized key carries the eligible sources, query and workspace.
  }, [key, load])

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
  return { query: parsed, state, sources, searching, authRequired, ...access, more, retry }
}
