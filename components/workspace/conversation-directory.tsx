'use client'

import { useState } from 'react'
import type { ThreadReadChange } from '@/lib/thread-reads'
import { setThreadRead } from '@/lib/thread-read-client'
import { threadKeys } from '@/lib/swr/keys'
import useSWRInfinite from 'swr/infinite'
import useSWR, {useSWRConfig} from 'swr'
import { getPreferences, updatePreferences } from '@/app/actions/preferences'
import { unstable_serialize } from 'swr/infinite'
import { useFormatter, useTranslations } from 'next-intl'
import { listConversations } from '@/app/actions/task-runs'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/ui/search-input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { useLiveKey } from '@/hooks/use-live-key'
import { archiveIdleDays, type DirectoryState } from '@/lib/conversation-directory-input'
import { navigate, openThread } from './workspace-navigation'

type Page = Awaited<ReturnType<typeof listConversations>>
const states = ['all', 'working', 'waiting', 'idle', 'failed'] as const

export function ConversationDirectory({ ownerId, workspaceId, botId }: { ownerId: string; workspaceId: string | null; botId: string | null }) {
  const t = useTranslations('ConversationDirectory')
  const format = useFormatter()
  const { mutate: refresh } = useSWRConfig()
  const [writing, setWriting] = useState(false)
  const [writeError, setWriteError] = useState(false)
  const prefs = useSWR(['conversation-archive-preferences',ownerId], () => getPreferences())
  const cache = useSWRConfig()
  const [saving,setSaving] = useState(false)
  const [failed,setFailed] = useState(false)
  const [search, setSearch] = useState('')
  const [state, setState] = useState<DirectoryState | 'all'>('all')
  const [archived, setArchived] = useState(false)
  const query = search.trim()
  const getKey = (index: number, previous: Page | null) => !workspaceId || (index > 0 && !previous?.cursor)
    ? null : ['conversation-directory', ownerId, workspaceId, botId, query, state, archived, previous?.cursor ?? null] as const
  const { data, error, mutate, size, setSize, isValidating } = useSWRInfinite<Page, Error, typeof getKey>(getKey,
    ([, , , selectedBot, text, selected, showArchive, cursor]) => listConversations({ botId:selectedBot ?? undefined, search: text, state: selected, archived: showArchive, cursor: cursor ?? undefined }),
    { revalidateOnFocus: false, shouldRetryOnError: false })
  useLiveKey('thread_list', workspaceId, workspaceId ? [unstable_serialize(getKey)] : [], workspaceId)
  useLiveKey('group_list', workspaceId, workspaceId ? [unstable_serialize(getKey)] : [], workspaceId)
  const rows = [...new Map(data?.flatMap(page => page.items).map(item => [item.id, item])).values()]
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
  async function changeDays(days:number) {
    setSaving(true); setFailed(false)
    try {
      const saved=await updatePreferences({archiveIdleAfterDays:days})
      if ('error' in saved && saved.error) throw new Error()
      await prefs.mutate()
      await Promise.all([mutate(),cache.mutate(['conversation-sidebar',ownerId,workspaceId])])
    } catch {setFailed(true)} finally {setSaving(false)}
  }
  return <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4" aria-label={t('title')}>
    <Label className="flex items-center gap-2 text-sm">{t('archiveIdle')}
      <NativeSelect value={prefs.data?.archiveIdleAfterDays ?? 30} disabled={!prefs.data || saving}
        onChange={event=>void changeDays(Number(event.target.value))}>
        {archiveIdleDays.map(days=><NativeSelectOption key={days} value={days}>{days ? t('archiveDays',{days}) : t('archiveOff')}</NativeSelectOption>)}
      </NativeSelect>
    </Label>
    {(failed || prefs.error) && <p role="alert">{t('loadError')} <Button size="sm" variant="ghost" onClick={()=>void prefs.mutate()}>{t('retry')}</Button></p>}
    <SearchInput type="search" value={search} maxLength={120} aria-label={t('search')} placeholder={t('search')}
      onChange={event => setSearch(event.target.value)} />
    <div className="flex flex-wrap items-center gap-2">
      {states.map(value => <Button key={value} size="sm" variant={value === state ? 'secondary' : 'ghost'}
        aria-pressed={value === state} onClick={() => setState(value)}>{t(value)}</Button>)}
      <Button size="sm" variant="outline" aria-pressed={archived} onClick={() => setArchived(!archived)}>{t('archived')}</Button>
      <Button size="sm" variant="ghost" disabled={writing || !workspaceId} onClick={() => void mark({ action: 'readAll' })}>{t('readAll')}</Button>
    </div>
    {writeError && <p role="alert">{t('writeError')}</p>}
    {error && <div role="alert">{t('loadError')} <Button size="sm" variant="ghost" onClick={() => void mutate()}>{t('retry')}</Button></div>}
    {!error && !data && <p role="status">{t('loading')}</p>}
    {data && !rows.length && !more && !error && <p role="status">{t('empty')}</p>}
    <ul className="flex flex-col gap-1">
      {rows.map(row => <li key={row.id} className="flex items-center gap-2"><Button type="button" variant="ghost" onClick={() => row.kind === 'chat' ? navigate({ section: 'group', group: row.id, issue: null, thread: null, task: null }) : openThread(row.id)}
        className="h-auto min-w-0 flex-1 flex-wrap justify-start gap-x-3 gap-y-1 py-3 text-start">
        <span className="min-w-0 flex-1 break-words font-medium">{row.title || t('untitled')}</span>
        {row.unread && <span className="size-2 rounded-full bg-primary" role="img" aria-label={t('unread')} />}
        {row.identifier && <bdi>{row.identifier}</bdi>}
        <span>{t(row.state)}</span><time dateTime={row.at}>{format.dateTime(new Date(row.at), { dateStyle: 'medium', timeStyle: 'short' })}</time>
      </Button>
        {!row.unread && <Button size="sm" variant="ghost" disabled={writing} onClick={() => void mark(row.kind === 'chat' ? { action: 'unread', chatId: row.id } : { action: 'unread', runId: row.id })}>{t('markUnread')}</Button>}
      </li>)}
    </ul>
    {more && <Button variant="outline" disabled={isValidating} onClick={() => void setSize(size + 1)}>{t('more')}</Button>}
  </section>
}
