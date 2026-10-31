'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { setProjectIssues } from '@/app/actions/projects'
import type { listIssues } from '@/app/actions/issues'
import { useActionError } from '@/lib/use-action-error'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldGroup, FieldLabel, FieldError } from '@/components/ui/field'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/ui/search-input'
import { issueIdentifier } from './issue-properties'
import type { Project } from './project-properties'

export function ProjectIssuePicker({ project, projects, issues, onClose, onSaved }: { project: Project; projects: Project[]; issues: Awaited<ReturnType<typeof listIssues>>; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations('Projects.issuePicker')
  const common = useTranslations('Common')
  const translateError = useActionError()
  const [selected, setSelected] = useState(() => project.issueIds.filter(id => issues.some(issue => issue.id === id)))
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const flight = useRef(false)
  const unavailable = new Set(projects.filter(item => item.id !== project.id).flatMap(item => item.issueIds))
  async function save() {
    if (flight.current) return
    flight.current = true; setPending(true); setError('')
    try {
      const result = await setProjectIssues({ id: project.id, revision: project.revision, issueIds: selected })
      if (result.error) setError(translateError(result.error))
      else onSaved()
    } catch { setError(translateError('projectIssuesSaveFailed')) }
    finally { flight.current = false; setPending(false) }
  }
  return <Dialog open onOpenChange={value => { if (!value && !pending) onClose() }}><DialogContent><DialogHeader><DialogTitle>{t('title')}</DialogTitle></DialogHeader>
    <SearchInput aria-label={t('searchAria')} placeholder={t('searchPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} />
    <FieldGroup className="max-h-80 gap-2 overflow-auto">{issues.filter(issue => `${issueIdentifier(issue)} ${issue.title}`.toLowerCase().includes(query.toLowerCase())).map(issue => <Field key={issue.id} orientation="horizontal" className="rounded-lg border p-3"><Checkbox id={`link-${issue.id}`} disabled={pending || unavailable.has(issue.id)} checked={selected.includes(issue.id)} onCheckedChange={checked => setSelected(value => checked ? [...value, issue.id] : value.filter(id => id !== issue.id))} /><FieldLabel htmlFor={`link-${issue.id}`} className="min-w-0 flex-1"><span className="flex min-w-0 flex-col gap-1"><span className="truncate">{issue.title}</span><span className="text-xs text-muted-foreground">{issueIdentifier(issue)}{unavailable.has(issue.id) ? ` · ${t('belongsToOther')}` : ''}</span></span></FieldLabel></Field>)}{!issues.length && <p className="py-6 text-sm text-muted-foreground">{t('empty')}</p>}</FieldGroup>
    {error && <FieldError>{error}</FieldError>}
    <DialogFooter><Button variant="outline" disabled={pending} onClick={onClose}>{common('cancel')}</Button><Button disabled={pending} onClick={() => void save()}>{pending ? common('saving') : t('save')}</Button></DialogFooter>
  </DialogContent></Dialog>
}
