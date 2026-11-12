'use client'

import { useEffect, useRef, useState } from 'react'
import { useViewState } from '@/lib/hooks/view-state'
import useSWR, { useSWRConfig } from 'swr'
import useSWRInfinite from 'swr/infinite'
import { useTranslations } from 'next-intl'

import { goToHref } from '@/components/workspace/workspace-navigation'
import { withBasePath } from '@/lib/base-path'
import { isToolkitSlug } from '@/lib/composio-accounts'
import type { SkillsSearchResult } from '@/lib/skills-search'
import type { StoreApp } from '@/lib/plugins/catalog'
import type { ConnectKind } from '@/lib/plugins/connect-kind'
import { matchesStoreQuery, storeItemState, type StoreItemState } from '@/lib/plugins/store-state'
import { getLinearIntegrationState } from '@/app/actions/linear-sync'
import { getTelegramIntegrationStatus } from '@/app/actions/telegram'
import { OWN_APPS, isOwnApp, useAppInfo, useConnectedApps, useStoreCatalog, type ConnectedApps, type OwnAppId } from '@/components/plugins/connected-apps'
import { type CredentialTarget } from '@/components/plugins/credential-dialog'
import { AppPage, ConnectionsList } from '@ui-slot/settings-connections'
import { PluginsPage } from '@ui-slot/plugins'
import { type OwnAppState, type OwnAppStates, type OwnAppsRead } from '@/components/plugins/connected-list'

export const OWN_APP_STATES_KEY = 'plugin-own-app-states'
/** Items a section shows before its ›. */
const SECTION_PREVIEW = 6
const CATEGORY_PREVIEW = 4

type SkillsPage = { data: SkillsSearchResult[]; hasMore: boolean }

async function fetchSkills([path, query, page]: readonly [string, string, number]): Promise<SkillsPage> {
  const params = new URLSearchParams()
  if (query) params.set('q', query)
  if (page) params.set('page', String(page))
  const search = params.toString()
  const response = await fetch(withBasePath(search ? path + '?' + search : path))
  if (!response.ok) throw new Error('skills search failed')
  return await response.json() as SkillsPage
}

/** An own app's status read failed: a stable code with the cause's kind, never its message (decision 2026-11-05-0330). */
class OwnAppReadError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) { super(code, options); this.name = 'OwnAppReadError' }
}
const httpDetail = (response: Response) => `http_${response.status ?? 'unknown'}`

/** The flag service (PostHog) did not answer: not this person's problem, and not ours to report. */
const FLAG_UNREADABLE = Symbol('flag unreadable')

/** A successful null means not configured; a failed read of our own endpoints rejects instead. */
async function fetchOwnAppState(id: OwnAppId): Promise<OwnAppState | typeof FLAG_UNREADABLE> {
  if (id === 'github') {
    const response = await fetch(withBasePath('/api/integrations/github'), { cache: 'no-store' })
    if (!response.ok) throw new OwnAppReadError(`github_status_failed (${httpDetail(response)})`)
    const state = await response.json() as { configured: boolean; connected: boolean; installed: boolean }
    return !state.configured ? null : state.connected && state.installed ? 'connected' : 'notConnected'
  }
  if (id === 'linear') {
    const response = await fetch(withBasePath('/api/integrations/linear/status'), { cache: 'no-store' })
    if (!response.ok) throw new OwnAppReadError(`linear_status_failed (${httpDetail(response)})`)
    const availability = await response.json() as { enabled?: boolean; state?: string }
    if (typeof availability.enabled !== 'boolean') throw new OwnAppReadError('linear_status_failed (malformed)')
    // Sync is global and off while its flag cannot be read; the row keeps what it last showed.
    if (availability.state === 'unavailable') return FLAG_UNREADABLE
    if (!availability.enabled) return 'paused'
    const state = await getLinearIntegrationState()
    return !state.configured ? null : state.connected ? 'connected' : 'notConnected'
  }
  const state = await getTelegramIntegrationStatus()
  return !state.configured ? null : state.connected ? 'connected' : 'notConnected'
}

/** A partial failure keeps that app's last successful state, with a visible error and its code under 详情.
 * An unreadable Linear flag keeps the last state too (paused when there is none), without an error. */
export async function fetchOwnAppStates(previous: Partial<Record<OwnAppId, OwnAppState>> = {}): Promise<OwnAppStates> {
  const results = await Promise.allSettled(OWN_APPS.map(fetchOwnAppState))
  const states = { ...previous }
  const failed: OwnAppId[] = []
  const codes: Partial<Record<OwnAppId, string>> = {}
  results.forEach((result, index) => {
    const id = OWN_APPS[index]
    if (result.status === 'rejected') {
      failed.push(id)
      const reason: unknown = result.reason
      codes[id] = reason instanceof OwnAppReadError ? reason.code : `${id}_status_failed (${reason instanceof Error ? reason.name : 'unknown'})`
    }
    else if (result.value === FLAG_UNREADABLE) states[id] = previous[id] ?? 'paused'
    else states[id] = result.value
  })
  return { states, failed, codes }
}

/** Where a page sits: the app (`&app=`) or a store section (`&category=`), from the URL. */
function readLocation() {
  const params = new URL(window.location.href).searchParams
  const app = params.get('app'), category = params.get('category')
  return { app: isToolkitSlug(app) ? app : null, category: category && category.length <= 80 ? category : null }
}

export type StoreEntry = { id: string; name: string; description: string; iconUrl: string | null; connect?: ConnectKind }
export type StoreSectionData = { id: string; name: string; items: StoreEntry[]; preview: number }

export type PluginsTab = 'apps' | 'skills'
export type PluginsHref = (next?: { app?: string | null; category?: string | null }) => string
export type PluginsGo = (next: { app?: string | null; category?: string | null }) => void

/**
 * What 插件 and 设置 › 连接 read and where they are: the connected apps, the own apps' states (read on the list
 * only), the app (`&app=`) or store section (`&category=`) from the URL, and the store's tab and search, kept here so
 * back from an app's page finds the store as it was left. Shared with UI layers (the `plugins` slot).
 */
export function usePluginsView(section: 'plugins' | 'connections', linearNotice: 'connected' | 'error' | null = null) {
  const apps = useConnectedApps()
  const [app, setApp] = useState<string | null>(linearNotice ? 'linear' : null)
  const [category, setCategory] = useState<string | null>(null)
  // Read on the list only; an app's own page reads its full state itself.
  const { cache } = useSWRConfig()
  const ownRead = useSWR<OwnAppStates>(app ? null : OWN_APP_STATES_KEY, () => fetchOwnAppStates((cache.get(OWN_APP_STATES_KEY)?.data as OwnAppStates | undefined)?.states))
  useEffect(() => {
    const read = () => { const next = readLocation(); if (next.app || !linearNotice) setApp(next.app); setCategory(next.category) }
    read()
    window.addEventListener('popstate', read)
    return () => window.removeEventListener('popstate', read)
  }, [linearNotice])
  const href: PluginsHref = (next = {}) => `?section=${section}${next.app ? `&app=${next.app}` : ''}${next.category ? `&category=${encodeURIComponent(next.category)}` : ''}`
  const go: PluginsGo = next => {
    const url = new URL(window.location.href)
    url.searchParams.set('section', section)
    for (const key of ['app', 'category'] as const) {
      const value = next[key]
      if (value) url.searchParams.set(key, value)
      else url.searchParams.delete(key)
    }
    goToHref(`${url.pathname}${url.search}${url.hash}`)
    setApp(next.app ?? null)
    setCategory(next.category ?? null)
  }
  const openApp = (next: string | null) => go({ app: next, category: next ? null : category })
  const [tab, setTab] = useViewState<PluginsTab>(`${section}:tab`, 'apps')
  const [query, setQuery] = useViewState(`${section}:query`, '')
  return { apps, ownRead, app, category, href, go, openApp, tab, setTab, query, setQuery }
}

export function PluginsView({ section, ...props }: { section: 'plugins' | 'connections'; rootLabel: string; linearNotice?: 'connected' | 'error' | null; workspaceId?: string; workspaceName?: string }) {
  return section === 'plugins' ? <PluginsPage /> : <ConnectionsView {...props} />
}

function ConnectionsView({ rootLabel, linearNotice = null, workspaceId, workspaceName }: {
  rootLabel: string; linearNotice?: 'connected' | 'error' | null; workspaceId?: string; workspaceName?: string
}) {
  const { apps, ownRead, app, category, href, go, openApp } = usePluginsView('connections', linearNotice)
  if (app) return <AppPage apps={apps} app={app} category={category} rootLabel={rootLabel} href={href} go={go} linearNotice={linearNotice} />
  return <ConnectionsList key={workspaceId} apps={apps} ownRead={ownRead} href={id => href({ app: id })} onOpen={openApp} workspaceId={workspaceId} workspaceName={workspaceName} />
}

export function useSkillsSearch(query: string, enabled: boolean) {
  const [debouncedQuery, setDebouncedQuery] = useState(query.trim())
  const trimmedQuery = query.trim()
  const shortQuery = trimmedQuery.length === 1
  const queryReady = trimmedQuery === debouncedQuery && !shortQuery
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(trimmedQuery), 300)
    return () => window.clearTimeout(timeout)
  }, [trimmedQuery])
  const { data: pages, error, isLoading, isValidating, mutate, size, setSize } = useSWRInfinite(
    (index, previous: SkillsPage | null) => !enabled || !queryReady || (previous && !previous.hasMore) ? null : ['/api/skills/search', debouncedQuery, index] as const,
    fetchSkills,
    { shouldRetryOnError: false, revalidateFirstPage: false },
  )
  const skills = pages?.flatMap(page => page.data)
  const hasMore = Boolean(pages?.at(-1)?.hasMore)
  const loadingMore = Boolean(pages) && size > pages!.length && !error
  /** Put on an element at the list's end: reaching it loads the next page. */
  const moreRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const sentinel = moreRef.current
    if (!sentinel || !hasMore || loadingMore || error) return
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void setSize(current => current + 1) }, { rootMargin: '400px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, loadingMore, error, setSize, pages?.length])
  return { skills, error, isLoading, isValidating, retry: () => void mutate(), hasMore, loadingMore, moreRef, trimmedQuery, shortQuery, queryReady }
}

/**
 * The 应用 store's data: its sections (热门 with ours first, 新品推荐, then Composio's categories), the open section
 * (`&category=`), search results, what 添加 offers, each item's state and what connecting it does. Shared with UI layers.
 */
export function usePluginStore({ apps, ownRead, category, query, go }: { apps: ConnectedApps; ownRead: OwnAppsRead; category: string | null; query: string; go: PluginsGo }) {
  const t = useTranslations('Plugins')
  const info = useAppInfo()
  const catalog = useStoreCatalog()
  const [keyTarget, setKeyTarget] = useState<CredentialTarget | null>(null)
  const trimmedQuery = query.trim()
  const store = catalog.data?.apps ?? []
  const byId = new Map<string, StoreApp>(store.map(item => [item.id, item]))
  // Ours have no Composio blurb: one line says what each brings (UI audit work-10).
  const own: StoreEntry[] = OWN_APPS.map(id => ({ id, ...info(id), description: t(`ownDescription.${id}`) }))
  const entries = (ids: readonly string[]): StoreEntry[] => ids.flatMap(id => { const item = byId.get(id); return item ? [{ id, name: item.name, description: item.description, iconUrl: item.iconUrl, connect: item.connect }] : [] })
  const stateOf = (id: string): StoreItemState | null => isOwnApp(id)
    ? ownRead.data?.failed.includes(id) && ownRead.data.states[id] === undefined ? 'unavailable' : storeItemState({ kind: 'own', state: ownRead.data?.states[id] })
    : storeItemState({ kind: 'composio', connect: byId.get(id)?.connect, accounts: apps.accountsFor(id).length, canLink: byId.get(id)?.connect === 'credentials' ? apps.canEnterKey : apps.canLink, loading: apps.loading })
  // The sections, as Codex's: 热门 (ours first, then Composio's usage order), 新品推荐, then Composio's categories.
  const sections: StoreSectionData[] = [
    { id: 'popular', name: t('popular'), items: [...own, ...entries(catalog.data?.popular ?? [])], preview: SECTION_PREVIEW },
    ...catalog.data ? [
      { id: 'latest', name: t('latest'), items: entries(catalog.data.latest), preview: SECTION_PREVIEW },
      ...catalog.data.categories.map(item => ({ id: `c:${item.id}`, name: item.name, items: entries(item.apps), preview: CATEGORY_PREVIEW })),
    ] : [],
  ].filter(item => item.items.length)
  const openSection = sections.find(item => item.id === category) ?? null
  const results = trimmedQuery ? [...own, ...entries(store.map(item => item.id))].filter(item => matchesStoreQuery(item, trimmedQuery)) : null
  // 添加 offers ours and Composio's 热门 that are not connected yet.
  const addable = [...own, ...entries(catalog.data?.popular ?? [])].filter(item => stateOf(item.id) === 'add')
  /** + : ours open their own page, where their connect flow lives; a key opens the key form; the rest Composio's link. */
  function connect(id: string) {
    if (isOwnApp(id)) go({ app: id, category })
    else if (byId.get(id)?.connect === 'credentials') setKeyTarget({ app: id })
    else void apps.connect(id)
  }
  return { catalog, sections, openSection, results, addable, stateOf, connect, keyTarget, setKeyTarget }
}
