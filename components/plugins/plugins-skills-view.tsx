'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { ArrowUpRight, Puzzle, Search } from 'lucide-react'

import { Link } from '@/i18n/navigation'
import { withBasePath } from '@/lib/base-path'
import type { SkillsSearchResult } from '@/lib/skills-search'
import { IntegrationsSettings } from '@/components/settings/integrations-settings'
import { GoogleSignInSettings } from '@/components/settings/google-sign-in-settings'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { Frame, FramePanel } from '@/components/reui/frame'
import { IconTile } from '@/components/reui/icon-tile'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

async function fetchSkills([path, query]: readonly [string, string]): Promise<SkillsSearchResult[]> {
  const params = new URLSearchParams()
  if (query) params.set('q', query)
  const search = params.toString()
  const response = await fetch(withBasePath(search ? path + '?' + search : path))
  if (!response.ok) throw new Error('skills search failed')
  const result = await response.json() as { data: SkillsSearchResult[] }
  return result.data
}

export function PluginsSkillsView({ googleEnabled }: { googleEnabled: boolean }) {
  const t = useTranslations('Plugins')
  const [tab, setTab] = useState<'plugins' | 'skills'>('plugins')
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

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6">
        <h1 className="sr-only">{t('title')}</h1>
        <Tabs value={tab} onValueChange={value => {
          if (value === 'plugins' || value === 'skills') setTab(value)
        }}>
          <TabsList variant="line">
            <TabsTrigger value="plugins">{t('pluginsTab')}</TabsTrigger>
            <TabsTrigger value="skills">{t('skillsTab')}</TabsTrigger>
          </TabsList>
          <TabsContent value="plugins" className="flex flex-col gap-6 pt-4">
            <SettingsSection id="agent-runtime-heading" title={t('agentRuntime')}>
              <SettingRow title={t('agentDevices')} description={t('agentRuntimeDescription')}>
                <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/devices" />}>
                  {t('manageDevices')}
                </Button>
              </SettingRow>
            </SettingsSection>
            <GoogleSignInSettings googleEnabled={googleEnabled} />
            <IntegrationsSettings showWebhookDetails={false} />
          </TabsContent>
          <TabsContent value="skills" className="flex flex-col gap-5 pt-4">
            <div className="flex flex-col gap-3">
              <InputGroup>
                <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
                <InputGroupInput
                  aria-label={t('searchAria')}
                  autoComplete="off"
                  maxLength={100}
                  onChange={event => setQuery(event.target.value)}
                  placeholder={t('searchPlaceholder')}
                  value={query}
                />
              </InputGroup>
              <h2 className="text-sm font-semibold">{trimmedQuery ? t('results') : t('trending')}</h2>
            </div>
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
                  <Button type="button" variant="outline" size="sm" onClick={() => void mutate()}>{t('retry')}</Button>
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
      </main>
    </div>
  )
}
