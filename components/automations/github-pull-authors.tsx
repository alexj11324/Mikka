'use client'

import { useEffect, useId, useState } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import useSWR from 'swr'
import { searchProjectPullAuthors } from '@/app/actions/project-resources'
import { listWorkspaceProjects } from '@/app/actions/projects'
import { InlineLoadError } from '@/components/load-error'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

/** The optional Project only narrows suggestions. The saved trigger names the
 * selected repositories and authors; it never acquires a Project grant. */
export function GitHubPullAuthors({ workspaceId, userId, repository, value, onChange, disabled }: {
  workspaceId: string | null; userId: string; repository?: string; value: string; onChange: (value: string) => void; disabled?: boolean
}) {
  const t = useTranslations('Automations.editor.github')
  const common = useTranslations('Common')
  const listId = useId()
  const [projectId, setProjectId] = useState('')
  const [opened, setOpened] = useState(false)
  const [debounced, setDebounced] = useState('')
  const offset = Math.max(value.lastIndexOf(','), value.lastIndexOf('，')) + 1
  const prefix = value.slice(0, offset)
  const query = value.slice(offset).trim().replace(/^@/, '')
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 300)
    return () => clearTimeout(timer)
  }, [query])
  const config = { revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false }
  const projects = useSWR(opened && workspaceId && repository ? ['automation-author-projects', userId, workspaceId] as const : null,
    ([, , shown]) => listWorkspaceProjects(shown), config)
  const selected = projects.data?.some(item => item.id === projectId && !item.archivedAt)
  const authors = useSWR(workspaceId && repository && selected && query === debounced && /^[a-z0-9-]{1,39}$/i.test(query)
    ? ['project-pull-authors', userId, workspaceId, projectId, repository, query] as const : null,
  async ([, readerId, shown, project, repo, term]) => {
    const result = await searchProjectPullAuthors({ readerId, workspaceId: shown, projectId: project, repository: repo, query: term })
    if (result.error) throw new Error(result.error)
    return result.authors
  }, config)
  const chosen = new Set(prefix.split(/[,，]/).map(item => item.trim().replace(/^@/, '').toLowerCase()))
  return <div className="grid gap-2 sm:grid-cols-2">
    <Input aria-label={t('pullAuthors')} placeholder={t('pullAuthors')} list={listId} value={value} maxLength={1000} disabled={disabled}
      onChange={event => onChange(event.target.value)} />
    <datalist id={listId}>{authors.data?.filter(name => !chosen.has(name.toLowerCase())).map(name =>
      <option key={name} value={prefix ? `${prefix} ${name}` : name} />)}</datalist>
    {workspaceId && repository && <NativeSelect aria-label={t('authorsProject')} value={selected ? projectId : ''} disabled={disabled}
      onFocus={() => setOpened(true)} onChange={event => setProjectId(event.target.value)}>
      <NativeSelectOption value="">{t('authorsProject')}</NativeSelectOption>
      {projects.data?.filter(item => !item.archivedAt).map(item => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}
    </NativeSelect>}
    {projects.error && <InlineLoadError message={t('authorProjectsError')} retryLabel={common('retry')} onRetry={() => { void projects.mutate() }} />}
    {authors.error && <InlineLoadError message={t('authorsError')} retryLabel={common('retry')} onRetry={() => { void authors.mutate() }} />}
  </div>
}
