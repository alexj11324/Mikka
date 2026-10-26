'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchSiteSearchPage, SiteSearchRequestError, siteSearchQuery, type SiteSearchError, type SiteSearchItem, type SiteSearchSource } from '@/lib/site-search'

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

/**
 * Server search for ⌘K: one independent page per source, each continued with
 * its own cursor (the contract promises no order across sources). A new query
 * aborts the old requests. Groups and tasks wait for the workspace; history is
 * the person's own and needs none.
 */
export function useSiteSearch(query: string, workspaceId: string | null) {
  const parsed = siteSearchQuery(query)
  const q = parsed.kind === 'ready' ? parsed.q : null
  const [state, setState] = useState<Record<ListedSource, SourceState>>({ history: IDLE, groups: IDLE, tasks: IDLE })
  const run = useRef<{ key: string; controller: AbortController } | null>(null)

  const load = useCallback((source: ListedSource, query: string, cursor: string | null, controller: AbortController) => {
    setState(current => ({ ...current, [source]: cursor ? { ...current[source], loadingMore: true, error: null } : { ...IDLE, status: 'loading' } }))
    fetchSiteSearchPage({ source, q: query, workspaceId, cursor, signal: controller.signal }).then(page => {
      if (controller.signal.aborted) return
      setState(current => ({ ...current, [source]: { status: 'ready', items: cursor ? [...current[source].items, ...page.items] : page.items, nextCursor: page.nextCursor, loadingMore: false, error: null } }))
    }, (error: unknown) => {
      if (controller.signal.aborted) return
      const code = error instanceof SiteSearchRequestError ? error.code : 'searchUnavailable'
      // A failed next page keeps what was shown; a 403 withholds the old cursor too.
      setState(current => ({ ...current, [source]: cursor && code !== 'searchAccessDenied'
        ? { ...current[source], loadingMore: false, error: code }
        : { ...IDLE, status: 'error', error: code } }))
    })
  }, [workspaceId])

  const sources = SOURCES.filter(source => source === 'history' || workspaceId)
  const key = q === null ? '' : JSON.stringify([q, workspaceId])
  useEffect(() => {
    run.current?.controller.abort()
    run.current = null
    if (q === null) { setState({ history: IDLE, groups: IDLE, tasks: IDLE }); return }
    const controller = new AbortController()
    run.current = { key, controller }
    setState({ history: { ...IDLE, status: 'loading' }, groups: workspaceId ? { ...IDLE, status: 'loading' } : IDLE, tasks: workspaceId ? { ...IDLE, status: 'loading' } : IDLE })
    const timer = setTimeout(() => { for (const source of SOURCES) if (source === 'history' || workspaceId) load(source, q, null, controller) }, DEBOUNCE_MS)
    return () => { clearTimeout(timer); controller.abort() }
    // key is q and workspaceId; load only changes with workspaceId.
  }, [key])

  const more = useCallback((source: ListedSource) => {
    const current = run.current
    const page = state[source]
    if (!current || q === null || !page.nextCursor || page.loadingMore) return
    load(source, q, page.nextCursor, current.controller)
  }, [state, q, load])
  /** After a failed next page, retries that page; otherwise reads the first page again. */
  const retry = useCallback((source: ListedSource) => {
    const current = run.current
    const page = state[source]
    if (!current || q === null) return
    load(source, q, page.status === 'ready' ? page.nextCursor : null, current.controller)
  }, [state, q, load])

  const searching = sources.some(source => state[source].status === 'loading')
  return { query: parsed, state, sources, searching, more, retry }
}
