'use client'

import { useDeferredValue, useState } from 'react'
import useSWRInfinite from 'swr/infinite'
import { unstable_serialize } from 'swr/infinite'
import { useFormatter, useTranslations } from 'next-intl'
import { listConversations } from '@/app/actions/task-runs'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/ui/search-input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { PullRequestsBadge, pullRequestRef } from './pull-requests-badge'
import { directoryPullRequests } from '@/lib/pull-request-appearance'
import { useLiveKey } from '@/hooks/use-live-key'
import type { DirectoryState } from '@/lib/conversation-directory-input'
import { openTask, openThread } from './workspace-navigation'

type Page = Awaited<ReturnType<typeof listConversations>>
const states = ['all', 'working', 'waiting', 'idle', 'failed'] as const

export function ConversationDirectory({ ownerId, workspaceId, pullsOnly = false }: { ownerId: string; workspaceId: string | null; pullsOnly?: boolean }) {
  const t = useTranslations('ConversationDirectory')
  const format = useFormatter()
  const prLabel = useTranslations('Metadata.prState')
  const categories = useTranslations('ArtifactsPage.category')
  const pullStates = ['all', 'open', 'draft', 'merged', 'closed'] as const
  const [pullState, setPullState] = useState<typeof pullStates[number]>('all')
  const [search, setSearch] = useState('')
  const [state, setState] = useState<DirectoryState | 'all'>('all')
  const [archived, setArchived] = useState(false)
  const query = useDeferredValue(search.trim())
  const getKey = (index: number, previous: Page | null) => !workspaceId || (index > 0 && !previous?.cursor)
    ? null : ['conversation-directory', ownerId, workspaceId, query, state, pullsOnly ? 'any' : archived, pullsOnly && pullState === 'all' ? 'linked' : pullState, previous?.cursor ?? null] as const
  const { data, error, mutate, size, setSize, isValidating } = useSWRInfinite<Page, Error, typeof getKey>(getKey,
    ([, , , text, selected, showArchive, selectedPr, cursor]) => listConversations({ search: text, state: selected, archived: showArchive, pullState: selectedPr, cursor: cursor ?? undefined }),
    { revalidateOnFocus: false, shouldRetryOnError: false })
  useLiveKey('thread_list', workspaceId, workspaceId ? [unstable_serialize(getKey)] : [], workspaceId)
  const rows = [...new Map(data?.flatMap(page => page.items).map(item => [item.id, item])).values()]
  const more = Boolean(data?.at(-1)?.cursor)
  return <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4" aria-label={pullsOnly ? categories('pullRequests') : t('title')}>
    <SearchInput type="search" value={search} maxLength={120} aria-label={t('search')} placeholder={t('search')}
      onChange={event => setSearch(event.target.value)} />
    <div className="flex flex-wrap items-center gap-2">
      {!pullsOnly && states.map(value => <Button key={value} size="sm" variant={value === state ? 'secondary' : 'ghost'}
        aria-pressed={value === state} onClick={() => setState(value)}>{t(value)}</Button>)}
      <NativeSelect aria-label={categories('pullRequests')} value={pullState} onChange={event => setPullState(event.target.value as typeof pullState)}>
        {pullStates.map(value => <NativeSelectOption value={value} key={value}>{value === 'all' ? categories('pullRequests') : prLabel(value)}</NativeSelectOption>)}
      </NativeSelect>
      {!pullsOnly && <Button size="sm" variant="outline" aria-pressed={archived} onClick={() => setArchived(!archived)}>{t('archived')}</Button>}
    </div>
    {error && <div role="alert">{t('loadError')} <Button size="sm" variant="ghost" onClick={() => void mutate()}>{t('retry')}</Button></div>}
    {!error && !data && <p role="status">{t('loading')}</p>}
    {data && !rows.length && !more && !error && <p role="status">{t('empty')}</p>}
    <ul className="flex flex-col gap-2">
      {pullsOnly ? directoryPullRequests(rows, pullState).map(({ pull, conversations }) => {
        const ref = pullRequestRef(pull.url)
        const tasks = new Map(conversations.flatMap(row => row.issueId ? [[row.issueId, row.identifier || row.taskTitle] as const] : []))
        return <li key={pull.url} className="flex flex-wrap items-center gap-2 py-2">
          <a href={pull.url} target="_blank" rel="noopener noreferrer" className="break-words font-medium underline-offset-2 hover:underline">
            {pull.title && <>{pull.title} · </>}{ref.repo} #{ref.number}
          </a>
          <span>{prLabel(pull.state)}</span>
          {pull.additions !== undefined && pull.deletions !== undefined && <bdi>+{pull.additions} −{pull.deletions}</bdi>}
          <div className="flex basis-full flex-wrap items-center gap-2">
            {conversations.map(row => <Button key={row.id} variant="ghost" onClick={() => openThread(row.id)}>{row.title || t('untitled')}</Button>)}
            {[...tasks].map(([id, label]) => <Button key={id} size="sm" variant="link" onClick={() => openTask(id)}>{label}</Button>)}
          </div>
        </li>
      }) : rows.map(row => <li key={row.id} className="flex flex-wrap items-center gap-2 py-2">
        <Button variant="ghost" onClick={() => openThread(row.id)} className="min-w-0 flex-1 justify-start whitespace-normal text-start">
          {row.title || t('untitled')}
        </Button>
        {row.issueId && <Button size="sm" variant="link" onClick={() => openTask(row.issueId!)}>{row.identifier || row.taskTitle}</Button>}
        <PullRequestsBadge pullRequests={row.pulls} /><span>{t(row.state)}</span>
        <time dateTime={row.at}>{format.dateTime(new Date(row.at), { dateStyle: 'medium', timeStyle: 'short' })}</time>
      </li>)}
    </ul>
    {more && <Button variant="outline" disabled={isValidating} onClick={() => void setSize(size + 1)}>{t('more')}</Button>}
  </section>
}
