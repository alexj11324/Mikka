'use client'

import { useRef, useState } from 'react'
import { setProjectIssues } from '@/app/actions/projects'
import type { listIssues } from '@/app/actions/issues'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Button } from '@/components/ui/button'
import { issueIdentifier } from './issue-properties'
import type { Project } from './project-properties'

export function ProjectIssuePicker({ project, projects, issues, onClose, onSaved }: { project: Project; projects: Project[]; issues: Awaited<ReturnType<typeof listIssues>>; onClose: () => void; onSaved: () => void }) {
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
      if (result.error) setError(result.error)
      else onSaved()
    } catch { setError('保存失败，请重试。') }
    finally { flight.current = false; setPending(false) }
  }
  return <Dialog open onOpenChange={value => { if (!value && !pending) onClose() }}><DialogContent><DialogHeader><DialogTitle>关联项目任务</DialogTitle><DialogDescription>每项任务只能属于一个项目。仅显示你有权访问的任务。</DialogDescription></DialogHeader>
    <Input aria-label="搜索可关联任务" placeholder="搜索任务…" value={query} onChange={event => setQuery(event.target.value)} />
    <FieldGroup className="max-h-80 gap-2 overflow-auto">{issues.filter(issue => `${issueIdentifier(issue.metadata.number)} ${issue.title}`.toLowerCase().includes(query.toLowerCase())).map(issue => <Field key={issue.id} orientation="horizontal" className="rounded-lg border p-3"><Checkbox id={`link-${issue.id}`} disabled={pending || unavailable.has(issue.id)} checked={selected.includes(issue.id)} onCheckedChange={checked => setSelected(value => checked ? [...value, issue.id] : value.filter(id => id !== issue.id))} /><FieldLabel htmlFor={`link-${issue.id}`} className="min-w-0 flex-1"><span className="flex min-w-0 flex-col gap-1"><span className="truncate">{issue.title}</span><span className="text-xs text-muted-foreground">{issueIdentifier(issue.metadata.number)}{unavailable.has(issue.id) ? ' · 已属于其他项目' : ''}</span></span></FieldLabel></Field>)}{!issues.length && <p className="py-6 text-sm text-muted-foreground">暂无可关联任务，请先创建任务。</p>}</FieldGroup>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <DialogFooter><Button variant="outline" disabled={pending} onClick={onClose}>取消</Button><Button disabled={pending} onClick={() => void save()}>{pending ? '正在保存…' : '保存关联'}</Button></DialogFooter>
  </DialogContent></Dialog>
}
