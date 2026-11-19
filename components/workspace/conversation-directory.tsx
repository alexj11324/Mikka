'use client'

import { useState } from 'react'
import type { ThreadReadChange } from '@/lib/thread-reads'
import { setThreadRead } from '@/lib/thread-read-client'
import { settingsKeys, threadKeys } from '@/lib/swr/keys'
import useSWRInfinite from 'swr/infinite'
import { useSWRConfig } from 'swr'
import { usePreferences } from '@/components/settings/use-preferences'
import { unstable_serialize } from 'swr/infinite'
import { useFormatter, useTranslations } from 'next-intl'
import { listConversations } from '@/app/actions/task-runs'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/ui/search-input'
import { Label } from '@/components/ui/label'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { GitPullRequest, MessageSquare } from '@/components/icons'
import { cn } from '@/lib/utils'
import { useLiveKey } from '@/hooks/use-live-key'
import { archiveIdleDays, directoryConversationKey, directoryTaskNumbers, type DirectoryState } from '@/lib/conversation-directory-input'
import { PullRequestsBadge, pullRequestRef } from './pull-requests-badge'
import { PULL_REQUEST_COLORS } from '@/lib/pull-request-appearance'
import { directoryPullRequests, directoryPullStates as pullStates } from '@/lib/directory-pulls'
import { openGroupConversation, openTask, openThread } from './workspace-navigation'

type Page = Awaited<ReturnType<typeof listConversations>>
const states = ['all', 'working', 'waiting', 'idle', 'failed'] as const

/** The rows' shape while the first page loads, so the list does not jump when it arrives. */
function DirectorySkeleton({ label }: { label: string }) {
  // role="status" is the live region that announces the wait; aria-hidden would take it
  // out of the accessible tree and silence it, so the rows alone are hidden instead.
  return <div role="status" className="flex flex-col gap-2">
    <span className="sr-only">{label}</span>
    <div aria-hidden="true" className="flex flex-col gap-2">
      {[0, 1, 2, 3].map(row => <div key={row} className="flex items-center gap-2 py-2">
        <Skeleton className="h-4 min-w-0 flex-1 rounded-sm" />
        <Skeleton className="h-4 w-16 rounded-sm" />
        <Skeleton className="h-4 w-24 rounded-sm" />
      </div>)}
    </div>
  </div>
}

export function ConversationDirectory({ ownerId, workspaceId, botId, revision = 0, pullsOnly = false }: { ownerId: string; workspaceId: string | null; botId: string | null; revision?: number; pullsOnly?: boolean }) {
  const t = useTranslations('ConversationDirectory')
  const prLabel = useTranslations('Metadata.prState')
  const categories = useTranslations('ArtifactsPage.category')
  const [pullState,setPullState] = useState<typeof pullStates[number]>('all')
  const format = useFormatter()
  const { mutate: refresh } = useSWRConfig()
  const [writing, setWriting] = useState(false)
  const [writeError, setWriteError] = useState(false)
  const prefs = usePreferences()
  const [saving,setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [state, setState] = useState<DirectoryState | 'all'>('all')
  const [archived, setArchived] = useState(false)
  const query = search.trim()
  const getKey = (index: number, previous: Page | null) => !workspaceId || (index > 0 && !previous?.cursor)
    ? null : ['conversation-directory', ownerId, workspaceId, botId, query, state, pullsOnly ? 'any' : archived, previous?.cursor ?? null, revision, pullsOnly && pullState === 'all' ? 'linked' : pullState] as const
  const { data, error, mutate, size, setSize, isValidating } = useSWRInfinite<Page, Error, typeof getKey>(getKey,
    ([, , , selectedBot, text, selected, showArchive, cursor, , selectedPr]) => listConversations({ pullState: selectedPr, botId:selectedBot ?? undefined, search: text, state: selected, archived: showArchive, cursor: cursor ?? undefined }),
    { revalidateOnFocus: false, shouldRetryOnError: false })
  useLiveKey('thread_list', workspaceId, workspaceId ? [unstable_serialize(getKey)] : [], workspaceId)
  useLiveKey('group_list', workspaceId, workspaceId ? [unstable_serialize(getKey), settingsKeys.preferences()] : [], workspaceId)
  const rows = [...new Map(data?.flatMap(page => page.items).map(item => [directoryConversationKey(item), item])).values()]
  const more = Boolean(data?.at(-1)?.cursor)
  async function mark(change: ThreadReadChange) {
    if (writing) return
    setWriting(true)
    setWriteError(false)
    try {
      await setThreadRead(change)
      await Promise.all([mutate(), refresh(threadKeys.list(ownerId))])
    } catch { setWriteError(true) }
    finally { setWriting(false) }
  }
  async function changeDays(days: number) {
    if (saving) return
    setSaving(true)
    try {
      if (await prefs.save({ archiveIdleAfterDays: days })) {
        await Promise.all([mutate(), refresh(['conversation-sidebar', ownerId, workspaceId])])
      }
    } finally { setSaving(false) }
  }
  const failedDays = prefs.failed?.patch.archiveIdleAfterDays
  return <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4" aria-label={pullsOnly ? categories('pullRequests') : t('title')}>
    <Label className="flex items-center gap-2 text-sm">{t('archiveIdle')}
      <NativeSelect value={prefs.data?.archiveIdleAfterDays ?? 30} disabled={!prefs.data || saving}
        onChange={event=>void changeDays(Number(event.target.value))}>
        {archiveIdleDays.map(days=><NativeSelectOption key={days} value={days}>{days ? t('archiveDays',{days}) : t('archiveOff')}</NativeSelectOption>)}
      </NativeSelect>
    </Label>
    {failedDays !== undefined
      ? <p role="alert">{t('archiveSaveError')} <Button size="sm" variant="ghost" disabled={saving} onClick={() => void changeDays(failedDays)}>{t('retry')}</Button></p>
      : prefs.error && <p role="alert">{t('loadError')} <Button size="sm" variant="ghost" onClick={() => void prefs.mutate()}>{t('retry')}</Button></p>}
    <SearchInput type="search" value={search} maxLength={120} aria-label={t('search')} placeholder={t('search')}
      onChange={event => setSearch(event.target.value)} />
    {/* Every control in this row takes the same step (R-99): the old mix of 28px
        buttons beside a 32px select is what made the toolbar look broken. */}
    <div className="flex flex-wrap items-center gap-2">
      {!pullsOnly && states.map(value => <Button key={value} size="sm" variant={value === state ? 'secondary' : 'ghost'}
        aria-pressed={value === state} onClick={() => setState(value)}>{t(value)}</Button>)}
      <NativeSelect size="sm" aria-label={categories('pullRequests')} value={pullState} onChange={event => setPullState(event.target.value as typeof pullState)}>
        {pullStates.map(value => <NativeSelectOption value={value} key={value}>{value === 'all' ? categories('pullRequests') : prLabel(value)}</NativeSelectOption>)}
      </NativeSelect>
      {!pullsOnly && <Button size="sm" variant="outline" aria-pressed={archived} onClick={() => setArchived(!archived)}>{t('archived')}</Button>}
      <Button size="sm" variant="ghost" disabled={writing || !workspaceId} onClick={() => void mark({ action: 'readAll' })}>{t('readAll')}</Button>
    </div>
    {writeError && <p role="alert">{t('writeError')}</p>}
    {error && <div role="alert">{t('loadError')} <Button size="sm" variant="ghost" onClick={() => void mutate()}>{t('retry')}</Button></div>}
    {!error && !data && <DirectorySkeleton label={t('loading')} />}
    {data && !rows.length && !more && !error && <Empty className="min-h-64 border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">{pullsOnly ? <GitPullRequest aria-hidden="true" /> : <MessageSquare aria-hidden="true" />}</EmptyMedia>
        <EmptyTitle>{t('empty')}</EmptyTitle>
      </EmptyHeader>
    </Empty>}
    <ul className="flex flex-col gap-2">
      {pullsOnly ? directoryPullRequests(rows, pullState).map(({ pull, conversations }) => {
        const ref = pullRequestRef(pull.url)
        const tasks = new Map(conversations.flatMap(row => row.issueId ? [[row.issueId, row.identifier || row.taskTitle] as const] : []))
        // One line per pull, the same fixed columns as a task row: the title is
        // the only column that gives, so the edges never wander (R-97's list model).
        return <li key={pull.url} className="flex flex-col gap-1 rounded-lg px-2 py-2 hover:bg-control">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn('size-2 shrink-0 rounded-full bg-current', PULL_REQUEST_COLORS[pull.state as keyof typeof PULL_REQUEST_COLORS] ?? 'text-muted-foreground')} aria-hidden="true" />
            <a href={pull.url} target="_blank" rel="noopener noreferrer" title={pull.title ?? `${ref.repo} #${ref.number}`}
              className="min-w-0 flex-1 truncate font-medium underline-offset-2 hover:underline">
              {pull.title && <>{pull.title} · </>}{ref.repo} #{ref.number}
            </a>
            {pull.additions !== undefined && pull.deletions !== undefined && <bdi className="shrink-0 text-xs tabular-nums">
              <span className="text-github-pr-open">+{pull.additions}</span>{' '}<span className="text-github-pr-closed">−{pull.deletions}</span>
            </bdi>}
            <span className="w-16 shrink-0 text-end text-xs text-muted-foreground">{prLabel(pull.state)}</span>
          </div>
          {conversations.length > 0 && <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 ps-4">
            {conversations.map(row => <Button key={directoryConversationKey(row)} variant="link" size="sm" className="h-auto min-w-0 p-0 font-normal"
              onClick={() => row.kind === 'chat' ? openGroupConversation(row.id) : openThread(row.id)}>
              <span className="truncate">{row.title || t('untitled')}</span>
            </Button>)}
            {[...tasks].map(([id, label]) => <Button key={id} size="sm" variant="link" className="h-auto p-0" onClick={() => openTask(id)}>{label}</Button>)}
          </div>}
        </li>
      }) : rows.map(row => <li key={directoryConversationKey(row)} className="flex min-w-0 items-center gap-2">
        <Button variant="ghost" size="sm" type="button" onClick={() => row.kind === 'chat' ? openGroupConversation(row.id) : openThread(row.id)}
          className="h-auto min-h-11 min-w-0 flex-1 items-center justify-start gap-x-3 py-2 text-start">
          {row.unread && <span className="size-2 shrink-0 rounded-full bg-primary" role="img" aria-label={t('unread')} />}
          <span className="min-w-0 flex-1 truncate font-medium">{row.title || t('untitled')}</span>
          {directoryTaskNumbers(row).length > 0 && <span className="flex shrink-0 items-center gap-1">
            {directoryTaskNumbers(row).map(({ key, identifier }) => <bdi key={key} className="text-xs text-muted-foreground tabular-nums">{identifier}</bdi>)}
          </span>}
          <PullRequestsBadge pullRequests={row.pulls} />
          <span className="w-16 shrink-0 text-end text-xs text-muted-foreground">{t(row.state)}</span>
          <time className="w-24 shrink-0 text-end text-xs text-muted-foreground tabular-nums" dateTime={row.at}>{format.dateTime(new Date(row.at), { month: 'short', day: 'numeric' })}</time>
        </Button>
        {!row.unread && <Button size="sm" variant="ghost" disabled={writing} onClick={() => void mark(row.kind === 'chat' ? { action: 'unread', chatId: row.id } : { action: 'unread', runId: row.id })}>{t('markUnread')}</Button>}
      </li>)}
    </ul>
    {more && <Button variant="outline" disabled={isValidating} onClick={() => void setSize(size + 1)}>{t('more')}</Button>}
  </section>
}
