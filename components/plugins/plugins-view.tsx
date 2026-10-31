'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { ArrowUpRight, Plus, Puzzle, Search } from 'lucide-react'

import { withBasePath } from '@/lib/base-path'
import { COMPOSIO_APP_IDS, type ComposioAppId } from '@/lib/composio-accounts'
import type { SkillsSearchResult } from '@/lib/skills-search'
import { getLinearIntegrationState } from '@/app/actions/linear-sync'
import { getTelegramIntegrationStatus } from '@/app/actions/telegram'
import type { PluginAppId } from '@/components/plugins/app-icons'
import { AppTile, ConnectedAppDetail, ConnectedAppRow, ConnectedAppsStatus, PluginBreadcrumb, PluginRow, isComposioAppId, useConnectedApps } from '@/components/plugins/connected-apps'
import { GitHubSettings } from '@/components/plugins/github-settings'
import { LinearSettings } from '@/components/settings/linear-settings'
import { TelegramSettings } from '@/components/settings/telegram-settings'
import { SettingsSection } from '@/components/settings/primitives'
import { Frame, FramePanel } from '@/components/reui/frame'
import { IconTile } from '@/components/reui/icon-tile'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

/** Apps Mikka links itself, after the Composio toolkits. */
const OWN_APPS = ['github', 'linear', 'telegram'] as const
type OwnAppId = typeof OWN_APPS[number]
const APP_IDS: readonly PluginAppId[] = [...COMPOSIO_APP_IDS, ...OWN_APPS]
type OwnAppState = 'connected' | 'notConnected' | 'paused' | null

function isPluginAppId(value: string | null): value is PluginAppId {
  return value !== null && (APP_IDS as readonly string[]).includes(value)
}

async function fetchSkills([path, query]: readonly [string, string]): Promise<SkillsSearchResult[]> {
  const params = new URLSearchParams()
  if (query) params.set('q', query)
  const search = params.toString()
  const response = await fetch(withBasePath(search ? path + '?' + search : path))
  if (!response.ok) throw new Error('skills search failed')
  const result = await response.json() as { data: SkillsSearchResult[] }
  return result.data
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

/**
 * 插件: the apps and skills a person's bots can use. The rail's 插件 page and
 * 设置 › 连接 both render this, so there is one list (decisions 2026-10-31).
 * `section` is the `?section=` value of the page it sits on.
 */
export function PluginsView({ section, rootLabel, linearNotice = null }: { section: 'plugins' | 'connections'; rootLabel: string; linearNotice?: 'connected' | 'error' | null }) {
  const t = useTranslations('Plugins')
  const tApps = useTranslations('Settings.integrations')
  const tLinear = useTranslations('Settings.linear')
  const tTelegram = useTranslations('Settings.telegram')
  const [tab, setTab] = useState<'apps' | 'skills'>('apps')
  const apps = useConnectedApps()
  // The open app's page is in the URL (&app=gmail), so back, reload and shared links land on it.
  const [app, setApp] = useState<PluginAppId | null>(linearNotice ? 'linear' : null)
  // Read on the list only; an app's own page reads its full state itself.
  const { data: ownStates } = useSWR(app ? null : 'plugin-own-app-states', fetchOwnAppStates)
  useEffect(() => {
    const read = () => { const value = new URL(window.location.href).searchParams.get('app'); if (isPluginAppId(value) || !linearNotice) setApp(isPluginAppId(value) ? value : null) }
    read()
    window.addEventListener('popstate', read)
    return () => window.removeEventListener('popstate', read)
  }, [linearNotice])
  const href = (next: PluginAppId | null) => `?section=${section}${next ? `&app=${next}` : ''}`
  function openApp(next: PluginAppId | null) {
    const url = new URL(window.location.href)
    url.searchParams.set('section', section)
    if (next) url.searchParams.set('app', next)
    else url.searchParams.delete('app')
    window.history.pushState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    setApp(next)
  }

  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const trimmedQuery = query.trim()
  const shortQuery = trimmedQuery.length === 1
  const queryReady = trimmedQuery === debouncedQuery && !shortQuery
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(trimmedQuery), 300)
    return () => window.clearTimeout(timeout)
  }, [trimmedQuery])
  const { data: skills, error, isLoading, mutate } = useSWR(
    tab === 'skills' && queryReady ? ['/api/skills/search', debouncedQuery] as const : null,
    fetchSkills,
    { shouldRetryOnError: false },
  )

  const name = (id: PluginAppId) => id === 'linear' ? tLinear('title') : id === 'telegram' ? tTelegram('title') : tApps(id)
  const description = (id: PluginAppId) => isComposioAppId(id) ? tApps(`${id}Description`) : t(`descriptions.${id}`)
  const needle = trimmedQuery.toLowerCase()
  const shownApps = APP_IDS.filter(id => !needle || `${name(id)} ${description(id)}`.toLowerCase().includes(needle))
  // 添加 offers what is not connected yet: Composio apps connect at once, the rest open their page.
  const addable = APP_IDS.filter(id => isComposioAppId(id) ? apps.state && !apps.accountsFor(id).length : ownStates?.[id] === 'notConnected')

  if (app) {
    const back = () => openApp(null)
    return <div className="flex flex-col gap-6">
      {isComposioAppId(app)
        ? <><ConnectedAppsStatus apps={apps} /><ConnectedAppDetail apps={apps} app={app} rootLabel={rootLabel} rootHref={href(null)} onBack={back} /></>
        : <div className="flex flex-col gap-8">
          <PluginBreadcrumb rootLabel={rootLabel} rootHref={href(null)} onBack={back} name={name(app)} />
          <header className="flex flex-wrap items-center gap-4">
            <AppTile app={app} size="xl" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <h2 className="text-xl font-semibold">{name(app)}</h2>
              <p className="text-sm text-muted-foreground">{description(app)}</p>
            </div>
          </header>
          {app === 'github' ? <GitHubSettings /> : app === 'linear' ? <LinearSettings notice={linearNotice} /> : <TelegramSettings />}
        </div>}
    </div>
  }

  return <div className="flex flex-col gap-6">
    <Tabs value={tab} onValueChange={value => { if (value === 'apps' || value === 'skills') setTab(value) }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabsList variant="line">
          <TabsTrigger value="apps">{t('appsTab')}<Badge variant="secondary">{APP_IDS.length}</Badge></TabsTrigger>
          <TabsTrigger value="skills">{t('skillsTab')}</TabsTrigger>
        </TabsList>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <InputGroup className="max-w-64">
            <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
            <InputGroupInput
              aria-label={tab === 'skills' ? t('searchAria') : t('searchAppsAria')}
              autoComplete="off"
              maxLength={100}
              onChange={event => setQuery(event.target.value)}
              placeholder={tab === 'skills' ? t('searchPlaceholder') : t('searchAppsPlaceholder')}
              value={query}
            />
          </InputGroup>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type="button" variant="secondary" size="sm" disabled={!addable.length || Boolean(apps.pending)} />}><Plus data-icon="inline-start" />{t('add')}</DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuGroup>
                {addable.map(id => <DropdownMenuItem key={id} disabled={isComposioAppId(id) && !apps.canLink} onClick={() => { if (isComposioAppId(id)) void apps.connect(id); else openApp(id) }}>
                  <AppTile app={id} />{name(id)}
                </DropdownMenuItem>)}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <TabsContent value="apps" className="flex flex-col gap-4 pt-4">
        <ConnectedAppsStatus apps={apps} />
        {shownApps.length ? <SettingsSection id="plugin-apps">
            {shownApps.map(id => isComposioAppId(id)
              ? <ConnectedAppRow key={id} apps={apps} app={id as ComposioAppId} href={href(id)} onOpen={() => openApp(id)} />
              : <PluginRow key={id} app={id} name={name(id)} description={description(id)} href={href(id)} onOpen={() => openApp(id)} dim={ownStates?.[id as OwnAppId] !== 'connected'}>
                {ownStates?.[id as OwnAppId] && <span className="text-xs text-muted-foreground">{t(`state.${ownStates[id as OwnAppId]!}`)}</span>}
              </PluginRow>)}
        </SettingsSection> : <Empty className="min-h-48">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Search aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>{t('noApps')}</EmptyTitle>
          </EmptyHeader>
          <Button type="button" variant="ghost" size="sm" onClick={() => setQuery('')}>{t('clearSearch')}</Button>
        </Empty>}
      </TabsContent>
      <TabsContent value="skills" className="flex flex-col gap-5 pt-4">
        <h2 className="text-sm font-semibold">{trimmedQuery ? t('results') : t('trending')}</h2>
        {shortQuery ? (
          <p className="text-xs text-muted-foreground">{t('searchHint')}</p>
        ) : error ? (
          <Empty className="min-h-48" role="alert">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Puzzle aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{t('loadFailed')}</EmptyTitle>
              <EmptyDescription>{t('loadFailedDescription')}</EmptyDescription>
            </EmptyHeader>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => void mutate()}>{t('retry')}</Button>
              <Button variant="ghost" size="sm" nativeButton={false} render={<a href="https://skills.sh/" target="_blank" rel="noopener noreferrer" />}>
                {t('browseSkills')}<ArrowUpRight data-icon="inline-end" />
              </Button>
            </div>
          </Empty>
        ) : isLoading || !queryReady ? (
          <Frame stacked role="status" aria-busy="true" aria-label={t('loading')}>
            {[0, 1, 2].map(index => (
              <FramePanel key={index}>
                <div className="flex items-center gap-3">
                  <Skeleton className="size-8 shrink-0" />
                  <span className="flex flex-1 flex-col gap-2">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-60 max-w-full" />
                  </span>
                </div>
              </FramePanel>
            ))}
          </Frame>
        ) : !skills?.length ? (
          <Empty className="min-h-48">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Search aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{t('noResults')}</EmptyTitle>
            </EmptyHeader>
            <Button type="button" variant="ghost" size="sm" onClick={() => setQuery('')}>{t('clearSearch')}</Button>
          </Empty>
        ) : (
          <Frame stacked>
            {skills.map(skill => (
              <FramePanel key={skill.id}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-3">
                    <IconTile size="sm" variant="elevated" aria-hidden="true"><Puzzle /></IconTile>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium">{skill.name}</span>
                      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="truncate">{skill.source}</span>
                        <span aria-hidden="true" className="size-1 shrink-0 rounded-full bg-muted-foreground/40" />
                        <span>{t('installCount', { count: skill.installs.toLocaleString() })}</span>
                      </span>
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    nativeButton={false}
                    render={<a href={skill.url} target="_blank" rel="noopener noreferrer" aria-label={t('openSkill', { name: skill.name })} />}
                  >
                    {t('openSkillAction')}<ArrowUpRight data-icon="inline-end" />
                  </Button>
                </div>
              </FramePanel>
            ))}
          </Frame>
        )}
      </TabsContent>
    </Tabs>
  </div>
}

/** The rail's 插件 page: the same list in its own scroll column. */
export function PluginsPage() {
  const t = useTranslations('Plugins')
  return <div className="min-h-0 flex-1 overflow-y-auto">
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6">
      <h1 className="sr-only">{t('title')}</h1>
      <PluginsView section="plugins" rootLabel={t('title')} />
    </main>
  </div>
}
