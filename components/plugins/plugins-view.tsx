'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import useSWRInfinite from 'swr/infinite'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ArrowUpRight, ChevronRight, Ellipsis, Plus, Puzzle, Search } from 'lucide-react'

import { goToHref, workspaceLink } from '@/components/workspace/workspace-navigation'
import { withBasePath } from '@/lib/base-path'
import { isToolkitSlug } from '@/lib/composio-accounts'
import type { SkillsSearchResult } from '@/lib/skills-search'
import type { StoreApp } from '@/lib/plugins/catalog'
import { matchesStoreQuery, storeItemState, type StoreItemState } from '@/lib/plugins/store-state'
import { getLinearIntegrationState } from '@/app/actions/linear-sync'
import { getTelegramIntegrationStatus } from '@/app/actions/telegram'
import { Link } from '@/i18n/navigation'
import { AppTile, ConnectedAppDetail, ConnectedAppRow, ConnectedAppsStatus, OWN_APPS, PluginBreadcrumb, PluginRow, isOwnApp, useAppInfo, useConnectedApps, useStoreCatalog, type ConnectedApps, type OwnAppId } from '@/components/plugins/connected-apps'
import { GitHubSettings } from '@/components/plugins/github-settings'
import { LinearSettings } from '@/components/settings/linear-settings'
import { TelegramSettings } from '@/components/settings/telegram-settings'
import { SettingsLoading, SettingsSection } from '@/components/settings/primitives'
import { IconTile } from '@/components/reui/icon-tile'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { SearchInput } from '@/components/ui/search-input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

type OwnAppState = 'connected' | 'notConnected' | 'paused' | null
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

/** The state word for GitHub, Linear and Telegram rows; null hides it (not set up, or unreadable). */
async function fetchOwnAppStates(): Promise<Record<OwnAppId, OwnAppState>> {
  const github = fetch(withBasePath('/api/integrations/github'), { cache: 'no-store' })
    .then(async response => {
      if (!response.ok) return null
      const state = await response.json() as { configured?: boolean; connected?: boolean; installed?: boolean }
      return !state.configured ? null : state.connected && state.installed ? 'connected' as const : 'notConnected' as const
    }).catch(() => null)
  const linear = fetch(withBasePath('/api/integrations/linear/status'), { cache: 'no-store' })
    .then(async response => {
      const availability = response.ok ? await response.json() as { enabled?: boolean } : null
      if (availability?.enabled !== true) return 'paused' as const
      const state = await getLinearIntegrationState()
      return !state.configured ? null : state.connected ? 'connected' as const : 'notConnected' as const
    }).catch(() => null)
  const telegram = getTelegramIntegrationStatus()
    .then(state => !state.configured ? null : state.connected ? 'connected' as const : 'notConnected' as const)
    .catch(() => null)
  const [g, l, tg] = await Promise.all([github, linear, telegram])
  return { github: g, linear: l, telegram: tg }
}

/** Where a page sits: the app (`&app=`) or a store section (`&category=`), from the URL. */
function readLocation() {
  const params = new URL(window.location.href).searchParams
  const app = params.get('app'), category = params.get('category')
  return { app: isToolkitSlug(app) ? app : null, category: category && category.length <= 80 ? category : null }
}

type StoreEntry = { id: string; name: string; description: string; iconUrl: string | null }

/**
 * 插件 and 设置 › 连接 (decision 2026-10-31). The rail's page is the store:
 * every app a person can connect, as Codex's 插件. 设置 › 连接 lists only
 * what the person has connected. An app's own page (`&app=`) is shared.
 */
export function PluginsView({ section, rootLabel, linearNotice = null }: { section: 'plugins' | 'connections'; rootLabel: string; linearNotice?: 'connected' | 'error' | null }) {
  const apps = useConnectedApps()
  const info = useAppInfo()
  const [app, setApp] = useState<string | null>(linearNotice ? 'linear' : null)
  const [category, setCategory] = useState<string | null>(null)
  // Read on the list only; an app's own page reads its full state itself.
  const { data: ownStates } = useSWR(app ? null : 'plugin-own-app-states', fetchOwnAppStates)
  useEffect(() => {
    const read = () => { const next = readLocation(); if (next.app || !linearNotice) setApp(next.app); setCategory(next.category) }
    read()
    window.addEventListener('popstate', read)
    return () => window.removeEventListener('popstate', read)
  }, [linearNotice])
  const href = (next: { app?: string | null; category?: string | null } = {}) => `?section=${section}${next.app ? `&app=${next.app}` : ''}${next.category ? `&category=${encodeURIComponent(next.category)}` : ''}`
  function go(next: { app?: string | null; category?: string | null }) {
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
  // Kept here, not in the store, so back from an app's page finds the store as it was left.
  const [tab, setTab] = useState<'apps' | 'skills'>('apps')
  const [query, setQuery] = useState('')

  if (app) {
    const back = () => go({ category })
    const root = href({ category })
    return <div className="flex flex-col gap-6">
      {!isOwnApp(app)
        ? <><ConnectedAppsStatus apps={apps} /><ConnectedAppDetail apps={apps} app={app} rootLabel={rootLabel} rootHref={root} onBack={back} /></>
        : <div className="flex flex-col gap-8">
          <PluginBreadcrumb rootLabel={rootLabel} rootHref={root} onBack={back} name={info(app).name} />
          {app === 'github' ? <GitHubSettings /> : <>
            <header className="flex flex-wrap items-center gap-4">
              <AppTile app={app} size="xl" />
              <h2 className="min-w-0 flex-1 text-xl font-semibold">{info(app).name}</h2>
            </header>
            {app === 'linear' ? <LinearSettings notice={linearNotice} /> : <TelegramSettings />}
          </>}
        </div>}
    </div>
  }
  if (section === 'connections') return <ConnectedList apps={apps} ownStates={ownStates} href={id => href({ app: id })} onOpen={openApp} />
  return <Store apps={apps} ownStates={ownStates} category={category} rootLabel={rootLabel} href={href} go={go} tab={tab} setTab={setTab} query={query} setQuery={setQuery} />
}

/** 设置 › 连接: only what the person has connected, one uniform row each. */
function ConnectedList({ apps, ownStates, href, onOpen }: { apps: ConnectedApps; ownStates: Record<OwnAppId, OwnAppState> | undefined; href: (id: string) => string; onOpen: (id: string) => void }) {
  const t = useTranslations('Plugins')
  const info = useAppInfo()
  const composio = apps.connectedToolkits()
  const own = OWN_APPS.filter(id => ownStates?.[id] === 'connected' || ownStates?.[id] === 'paused')
  if (!apps.loading && ownStates && !composio.length && !own.length) return <div className="flex flex-col gap-4">
    <ConnectedAppsStatus apps={apps} />
    <Empty className="min-h-48">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Puzzle aria-hidden="true" /></EmptyMedia>
        <EmptyTitle>{t('noConnections')}</EmptyTitle>
      </EmptyHeader>
      <Button variant="secondary" size="sm" nativeButton={false} render={<Link href={workspaceLink({ section: 'plugins' })} />}>{t('openStore')}</Button>
    </Empty>
  </div>
  return <div className="flex flex-col gap-4">
    <ConnectedAppsStatus apps={apps} />
    {apps.loading && !composio.length && !own.length ? <SettingsLoading label={t('loadingApps')} /> : <SettingsSection id="plugin-apps">
      {composio.map(id => <ConnectedAppRow key={id} apps={apps} app={id} href={href(id)} onOpen={() => onOpen(id)} />)}
      {own.map(id => <PluginRow key={id} app={id} name={info(id).name} href={href(id)} onOpen={() => onOpen(id)} dim={ownStates?.[id] === 'paused'}>
        <span className="text-xs text-muted-foreground">{t(`state.${ownStates![id]!}`)}</span>
      </PluginRow>)}
    </SettingsSection>}
  </div>
}

/** The rail's 插件: the 应用 store and the 技能 tab. */
function Store({ apps, ownStates, category, rootLabel, href, go, tab, setTab, query, setQuery }: {
  tab: 'apps' | 'skills'
  setTab: (tab: 'apps' | 'skills') => void
  query: string
  setQuery: (query: string) => void
  apps: ConnectedApps
  ownStates: Record<OwnAppId, OwnAppState> | undefined
  category: string | null
  rootLabel: string
  href: (next?: { app?: string | null; category?: string | null }) => string
  go: (next: { app?: string | null; category?: string | null }) => void
}) {
  const t = useTranslations('Plugins')
  const tApps = useTranslations('Settings.integrations')
  const common = useTranslations('Common')
  const info = useAppInfo()
  const catalog = useStoreCatalog()
  const [confirming, setConfirming] = useState<{ id: string; accountId: string } | null>(null)
  const [disconnectError, setDisconnectError] = useState('')

  const [debouncedQuery, setDebouncedQuery] = useState(query.trim())
  const trimmedQuery = query.trim()
  const shortQuery = trimmedQuery.length === 1
  const queryReady = trimmedQuery === debouncedQuery && !shortQuery
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(trimmedQuery), 300)
    return () => window.clearTimeout(timeout)
  }, [trimmedQuery])
  // skills.sh's all-time leaderboard, or the search, a page at a time as the list is scrolled.
  const { data: pages, error, isLoading, isValidating, mutate, size, setSize } = useSWRInfinite(
    (index, previous: SkillsPage | null) => tab !== 'skills' || !queryReady || (previous && !previous.hasMore) ? null : ['/api/skills/search', debouncedQuery, index] as const,
    fetchSkills,
    { shouldRetryOnError: false, revalidateFirstPage: false },
  )
  const skills = pages?.flatMap(page => page.data)
  const hasMore = Boolean(pages?.at(-1)?.hasMore)
  const loadingMore = Boolean(pages) && size > pages!.length && !error
  const moreRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const sentinel = moreRef.current
    if (!sentinel || !hasMore || loadingMore || error) return
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void setSize(current => current + 1) }, { rootMargin: '400px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, loadingMore, error, setSize, pages?.length])

  const store = catalog.data?.apps ?? []
  const byId = new Map<string, StoreApp>(store.map(item => [item.id, item]))
  const own: StoreEntry[] = OWN_APPS.map(id => ({ id, ...info(id), description: '' }))
  const entries = (ids: readonly string[]): StoreEntry[] => ids.flatMap(id => { const item = byId.get(id); return item ? [{ id, name: item.name, description: item.description, iconUrl: item.iconUrl }] : [] })
  const stateOf = (id: string) => isOwnApp(id)
    ? storeItemState({ kind: 'own', state: ownStates?.[id] })
    : storeItemState({ kind: 'composio', accounts: apps.accountsFor(id).length, canLink: apps.canLink, loading: apps.loading })
  // The sections, as Codex's: 热门 (ours first, then Composio's usage order), 新品推荐, then Composio's categories.
  const sections: { id: string; name: string; items: StoreEntry[]; preview: number }[] = [
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

  function connect(id: string) {
    if (isOwnApp(id)) go({ app: id, category })
    else void apps.connect(id)
  }
  const grid = (items: StoreEntry[]) => <ul className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
    {items.map(item => <li key={item.id}><StoreItem item={item} state={stateOf(item.id)} apps={apps} href={href({ app: item.id, category })} onOpen={() => go({ app: item.id, category })} onConnect={() => connect(item.id)} onDisconnect={accountId => { setDisconnectError(''); setConfirming({ id: item.id, accountId }) }} /></li>)}
  </ul>

  return <div className="flex flex-col gap-6">
    <Tabs value={tab} onValueChange={value => { if (value === 'apps' || value === 'skills') setTab(value) }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabsList variant="line">
          <TabsTrigger value="apps">{t('appsTab')}</TabsTrigger>
          <TabsTrigger value="skills">{t('skillsTab')}</TabsTrigger>
        </TabsList>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <SearchInput
            className="max-w-64"
            aria-label={tab === 'skills' ? t('searchAria') : t('searchAppsAria')}
            maxLength={100}
            onChange={event => setQuery(event.target.value)}
            placeholder={tab === 'skills' ? t('searchPlaceholder') : t('searchAppsPlaceholder')}
            value={query}
          />
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type="button" variant="secondary" size="sm" disabled={!addable.length || Boolean(apps.pending)} />}><Plus data-icon="inline-start" />{t('add')}</DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 w-56">
              <DropdownMenuGroup>
                {addable.map(item => <DropdownMenuItem key={item.id} onClick={() => connect(item.id)}>
                  <AppTile app={item.id} iconUrl={item.iconUrl} />{item.name}
                </DropdownMenuItem>)}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <TabsContent value="apps" className="flex flex-col gap-8 pt-4">
        <ConnectedAppsStatus apps={apps} />
        {results ? results.length ? <StoreSection title={t('results')}>{grid(results)}</StoreSection> : <Empty className="min-h-48">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Search aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>{t('noApps')}</EmptyTitle>
          </EmptyHeader>
          <Button type="button" variant="ghost" size="sm" onClick={() => setQuery('')}>{t('clearSearch')}</Button>
        </Empty>
        : openSection ? <div className="flex flex-col gap-6">
          <PluginBreadcrumb rootLabel={rootLabel} rootHref={href()} onBack={() => go({})} name={openSection.name} />
          {grid(openSection.items)}
        </div>
        : <>
          {sections.map(item => <StoreSection key={item.id} title={item.name} more={item.items.length > item.preview ? { label: t('showAll', { name: item.name }), href: href({ category: item.id }), onOpen: () => go({ category: item.id }) } : undefined}>
            {grid(item.items.slice(0, item.preview))}
          </StoreSection>)}
          {catalog.isLoading && <div role="status" aria-label={t('loadingApps')} className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
            {Array.from({ length: SECTION_PREVIEW }, (_, index) => <div key={index} aria-hidden="true" className="flex items-center gap-3 px-3 py-2.5"><Skeleton className="size-10 rounded-lg" /><Skeleton className="h-4 w-32" /></div>)}
          </div>}
          {catalog.error && !catalog.data && <Empty className="min-h-32" role="alert">
            <EmptyHeader><EmptyTitle>{t('storeLoadFailed')}</EmptyTitle></EmptyHeader>
            <Button type="button" variant="secondary" size="sm" onClick={() => void catalog.mutate()}>{t('retry')}</Button>
          </Empty>}
        </>}
      </TabsContent>
      <TabsContent value="skills" className="flex flex-col gap-5 pt-4">
        <h2 className="text-sm font-semibold">{trimmedQuery ? t('results') : t('leaderboard')}</h2>
        {shortQuery ? null : error && !skills?.length ? (
          <Empty className="min-h-48" role="alert">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Puzzle aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{t('loadFailed')}</EmptyTitle>
            </EmptyHeader>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => void mutate()}>{t('retry')}</Button>
              <Button variant="ghost" size="sm" nativeButton={false} render={<a href="https://skills.sh/" target="_blank" rel="noopener noreferrer" />}>
                {t('browseSkills')}<ArrowUpRight data-icon="inline-end" />
              </Button>
            </div>
          </Empty>
        ) : isLoading || !queryReady ? (
          <SettingsLoading label={t('loading')} />
        ) : !skills?.length ? (
          <Empty className="min-h-48">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Search aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{t('noResults')}</EmptyTitle>
            </EmptyHeader>
            <Button type="button" variant="ghost" size="sm" onClick={() => setQuery('')}>{t('clearSearch')}</Button>
          </Empty>
        ) : (
          <SettingsSection id="plugin-skills">
            {skills.map(skill => (
              <div key={skill.id} className="relative flex items-center gap-3 py-3 pr-4 pl-5 transition-colors hover:bg-muted/50">
                <a href={skill.url} target="_blank" rel="noopener noreferrer" aria-label={t('openSkill', { name: skill.name })} className="flex min-w-0 flex-1 items-center gap-3 outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring/40 focus-visible:after:ring-inset">
                  <IconTile size="sm" variant="elevated" aria-hidden="true"><Puzzle /></IconTile>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium">{skill.name}</span>
                    <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                      <span className="truncate">{skill.source}</span>
                      <span aria-hidden="true" className="size-1 shrink-0 rounded-full bg-muted-foreground/40" />
                      <span className="shrink-0">{t('installCount', { count: skill.installs.toLocaleString() })}</span>
                    </span>
                  </span>
                </a>
                <ArrowUpRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              </div>
            ))}
            {loadingMore && <div aria-hidden="true" className="flex items-center gap-3 py-3 pr-4 pl-5"><Skeleton className="size-8 rounded-lg" /><Skeleton className="h-4 w-40" /></div>}
            {error && <div className="flex justify-center py-3"><Button type="button" variant="secondary" size="sm" disabled={isValidating} onClick={() => void mutate()}>{t('retry')}</Button></div>}
            {hasMore && <div ref={moreRef} aria-hidden="true" />}
          </SettingsSection>
        )}
      </TabsContent>
    </Tabs>

    <AlertDialog open={Boolean(confirming)} onOpenChange={open => { if (!open && !apps.pending) setConfirming(null) }}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{tApps('disconnectTitle', { name: confirming ? info(confirming.id).name : '' })}</AlertDialogTitle>
          <AlertDialogDescription>{tApps('disconnectConsequence', { name: confirming ? info(confirming.id).name : '' })}</AlertDialogDescription>
        </AlertDialogHeader>
        {disconnectError && <p role="alert" className="text-xs text-destructive">{disconnectError}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel variant="secondary" disabled={Boolean(apps.pending)}>{common('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={Boolean(apps.pending)} onClick={() => {
            if (!confirming) return
            const name = info(confirming.id).name
            void apps.disconnect(confirming.accountId).then(done => {
              if (!done) { setDisconnectError(tApps('disconnectFailed')); return }
              setConfirming(null)
              toast.success(tApps('disconnected', { name }))
            })
          }}>{apps.pending ? tApps('working') : tApps('disconnect')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}

/** A store section: its title, a › to the whole section when it holds more, and the grid. */
function StoreSection({ title, more, children }: { title: string; more?: { label: string; href: string; onOpen: () => void }; children: ReactNode }) {
  return <section className="flex flex-col gap-2">
    <h2 className="flex items-center gap-1 text-sm font-semibold">
      {more ? <a href={more.href} aria-label={more.label} onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey) return; event.preventDefault(); more.onOpen() }} className="inline-flex items-center gap-0.5 rounded-md outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40">
        {title}<ChevronRight aria-hidden="true" className="size-4" />
      </a> : title}
    </h2>
    {children}
  </section>
}

/**
 * One store item, as Codex's: icon, name, Composio's one-line description when
 * it has one, and on the right `…` when connected or `+` when not. The item is
 * the link to the app's page; the control sits above it.
 */
function StoreItem({ item, state, apps, href, onOpen, onConnect, onDisconnect }: { item: StoreEntry; state: StoreItemState | null; apps: ConnectedApps; href: string; onOpen: () => void; onConnect: () => void; onDisconnect: (accountId: string) => void }) {
  const t = useTranslations('Plugins')
  const tApps = useTranslations('Settings.integrations')
  const own = isOwnApp(item.id)
  const accounts = own ? [] : apps.accountsFor(item.id)
  const usable = accounts.filter(account => account.status === 'ACTIVE')
  const on = usable.some(account => account.enabled)
  return <div className="relative flex items-center gap-3 rounded-xl py-2.5 pr-2 pl-3 transition-colors hover:bg-muted/50">
    <a href={href} aria-label={tApps('openApp', { name: item.name })} onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); onOpen() }} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring/40 focus-visible:after:ring-inset">
      <AppTile app={item.id} iconUrl={item.iconUrl} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{item.name}</span>
        {item.description && <span className="truncate text-xs text-muted-foreground">{item.description}</span>}
      </span>
    </a>
    <div className="relative z-10 flex size-8 shrink-0 items-center justify-center">
      {state === 'connected' ? <DropdownMenu>
        <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={t('appMenu', { name: item.name })} disabled={Boolean(apps.pending)} />}><Ellipsis data-icon="inline-start" /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={onOpen}>{t('manage')}</DropdownMenuItem>
            {usable.length > 0 && <DropdownMenuItem onClick={() => {
              void apps.setEnabled(usable.filter(account => account.enabled === on).map(account => account.id), !on).then(ok => {
                if (ok && on) toast.success(tApps('turnedOff', { name: item.name }))
              })
            }}>{on ? tApps('turnOff') : tApps('turnOn')}</DropdownMenuItem>}
            {/* Several accounts: each is disconnected on the app's page. */}
            {accounts.length === 1 && <DropdownMenuItem variant="destructive" onClick={() => onDisconnect(accounts[0].id)}>{tApps('disconnect')}</DropdownMenuItem>}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      : state === 'add' ? <Button type="button" variant="ghost" size="icon-sm" aria-label={t('connectApp', { name: item.name })} disabled={Boolean(apps.pending)} onClick={onConnect}>
        <Plus data-icon="inline-start" />
      </Button>
      : state === null ? <Skeleton aria-hidden="true" data-slot="app-row-pending" className="size-7 rounded-md" /> : null}
    </div>
  </div>
}

/** The rail's 插件 page: the store in its own scroll column. */
export function PluginsPage() {
  const t = useTranslations('Plugins')
  return <div className="min-h-0 flex-1 overflow-y-auto">
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6">
      <h1 className="sr-only">{t('title')}</h1>
      <PluginsView section="plugins" rootLabel={t('title')} />
    </main>
  </div>
}
