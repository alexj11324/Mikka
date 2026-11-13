'use client'

import { useDeferredValue, useState } from 'react'
import useSWRInfinite from 'swr/infinite'
import { unstable_serialize } from 'swr/infinite'
import { useFormatter, useTranslations } from 'next-intl'
import { listConversations } from '@/app/actions/task-runs'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/ui/search-input'
import { useLiveKey } from '@/hooks/use-live-key'
import type { DirectoryState } from '@/lib/conversation-directory-input'
import { navigate, openThread } from './workspace-navigation'

type Page = Awaited<ReturnType<typeof listConversations>>
const states = ['all', 'working', 'waiting', 'idle', 'failed'] as const

export function ConversationDirectory({ ownerId, workspaceId, revision = 0 }: { ownerId: string; workspaceId: string | null; revision?: number }) {
  const t = useTranslations('ConversationDirectory')
  const format = useFormatter()
  const [search, setSearch] = useState('')
  const [state, setState] = useState<DirectoryState | 'all'>('all')
  const [archived, setArchived] = useState(false)
  const query = useDeferredValue(search.trim())
  const getKey = (index: number, previous: Page | null) => !workspaceId || (index > 0 && !previous?.cursor)
    ? null : ['conversation-directory', ownerId, workspaceId, query, state, archived, previous?.cursor ?? null, revision] as const
  const { data, error, mutate, size, setSize, isValidating } = useSWRInfinite<Page, Error, typeof getKey>(getKey,
    ([, , , text, selected, showArchive, cursor]) => listConversations({ search: text, state: selected, archived: showArchive, cursor: cursor ?? undefined }),
    { revalidateOnFocus: false, shouldRetryOnError: false })
  useLiveKey('thread_list', workspaceId, workspaceId ? [unstable_serialize(getKey)] : [], workspaceId)
  useLiveKey('group_list', workspaceId, workspaceId ? [unstable_serialize(getKey)] : [], workspaceId)
  const rows = [...new Map(data?.flatMap(page => page.items).map(item => [item.id, item])).values()]
  const more = Boolean(data?.at(-1)?.cursor)
  return <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4" aria-label={t('title')}>
    <SearchInput type="search" value={search} maxLength={120} aria-label={t('search')} placeholder={t('search')}
      onChange={event => setSearch(event.target.value)} />
    <div className="flex flex-wrap items-center gap-2">
      {states.map(value => <Button key={value} size="sm" variant={value === state ? 'secondary' : 'ghost'}
        aria-pressed={value === state} onClick={() => setState(value)}>{t(value)}</Button>)}
      <Button size="sm" variant="outline" aria-pressed={archived} onClick={() => setArchived(!archived)}>{t('archived')}</Button>
    </div>
    {error && <div role="alert">{t('loadError')} <Button size="sm" variant="ghost" onClick={() => void mutate()}>{t('retry')}</Button></div>}
    {!error && !data && <p role="status">{t('loading')}</p>}
    {data && !rows.length && !more && !error && <p role="status">{t('empty')}</p>}
    <ul className="flex flex-col gap-1">
      {rows.map(row => <li key={row.id}><Button variant="ghost" type="button" onClick={() => row.kind === 'chat' ? navigate({ section: 'group', group: row.id, issue: null, thread: null, task: null }) : openThread(row.id)}
        className="h-auto w-full flex-wrap items-center gap-x-3 gap-y-1 py-3 text-start focus-visible:outline-ring">
        <span className="min-w-0 flex-1 break-words font-medium">{row.title || t('untitled')}</span>
        {row.identifier && <bdi>{row.identifier}</bdi>}
        <span>{t(row.state)}</span><time dateTime={row.at}>{format.dateTime(new Date(row.at), { dateStyle: 'medium', timeStyle: 'short' })}</time>
      </Button></li>)}
    </ul>
    {more && <Button variant="outline" disabled={isValidating} onClick={() => void setSize(size + 1)}>{t('more')}</Button>}
  </section>
}
