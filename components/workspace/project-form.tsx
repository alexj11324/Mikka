'use client'

import { useEffect, useRef, useState } from 'react'
import { saveProject } from '@/app/actions/projects'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Button } from '@/components/ui/button'
import { PROJECT_STATUSES, type Project } from './project-properties'
import { ISSUE_PRIORITIES, WORKSPACE_NAME } from './issue-properties'

export function ProjectForm({ project, onClose, onSaved }: { project?: Project; onClose: () => void; onSaved: (project: Project) => void }) {
  const [name, setName] = useState(project?.name ?? '')
  const [summary, setSummary] = useState(project?.summary ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [status, setStatus] = useState(project?.status ?? 'backlog')
  const [priority, setPriority] = useState(project?.priority ?? 'normal')
  const [lead, setLead] = useState(project?.lead ?? '')
  const [startDate, setStartDate] = useState(project?.startDate ?? '')
  const [targetDate, setTargetDate] = useState(project?.targetDate ?? '')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const submitting = useRef(false)
  const dirty = name !== (project?.name ?? '') || summary !== (project?.summary ?? '') || description !== (project?.description ?? '') || status !== (project?.status ?? 'backlog') || priority !== (project?.priority ?? 'normal') || lead !== (project?.lead ?? '') || startDate !== (project?.startDate ?? '') || targetDate !== (project?.targetDate ?? '')
  useEffect(() => {
    if (!dirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty])
  function close() { if (!submitting.current && (!dirty || window.confirm('放弃尚未保存的项目修改？'))) onClose() }
  async function submit() {
    if (submitting.current) return
    submitting.current = true; setPending(true); setError('')
    try {
      const result = await saveProject({ id: project?.id, revision: project?.revision, name, summary, description, status: status as 'backlog', priority: priority as 'normal', lead: lead as '' | 'me', team: WORKSPACE_NAME, startDate, targetDate })
      if (!('project' in result) || !result.project) { setError(result.error ?? '保存失败。'); return }
      onSaved(result.project)
    } catch { setError('保存失败，输入已保留，请重试。') }
    finally { submitting.current = false; setPending(false) }
  }
  return <Dialog open onOpenChange={value => { if (!value) close() }}><DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{project ? '编辑项目' : '新建项目'}</DialogTitle><DialogDescription>围绕一个明确的交付目标组织任务。</DialogDescription></DialogHeader>
    <form className="flex flex-col gap-6" onSubmit={event => { event.preventDefault(); void submit() }}>
      <FieldGroup>
        <Field><FieldLabel htmlFor="project-name">项目名称</FieldLabel><Input id="project-name" value={name} onChange={event => setName(event.target.value)} maxLength={200} required disabled={pending} placeholder="例如：发布新版本" /></Field>
        <Field><FieldLabel htmlFor="project-summary">简短摘要</FieldLabel><Input id="project-summary" value={summary} onChange={event => setSummary(event.target.value)} maxLength={500} disabled={pending} placeholder="项目要达成什么目标？" /></Field>
        <div className="grid grid-cols-2 gap-4">
          <Field><FieldLabel htmlFor="project-status">状态</FieldLabel><NativeSelect id="project-status" value={status} onChange={event => setStatus(event.target.value)} disabled={pending}>{PROJECT_STATUSES.map(item => <NativeSelectOption key={item.value} value={item.value}>{item.label}</NativeSelectOption>)}</NativeSelect></Field>
          <Field><FieldLabel htmlFor="project-priority">优先级</FieldLabel><NativeSelect id="project-priority" value={priority} onChange={event => setPriority(event.target.value)} disabled={pending}>{ISSUE_PRIORITIES.map(item => <NativeSelectOption key={item.value} value={item.value}>{item.label}</NativeSelectOption>)}</NativeSelect></Field>
          <Field><FieldLabel htmlFor="project-lead">负责人</FieldLabel><NativeSelect id="project-lead" value={lead} onChange={event => setLead(event.target.value)} disabled={pending}><NativeSelectOption value="">未指定</NativeSelectOption><NativeSelectOption value="me">我</NativeSelectOption></NativeSelect></Field>
          <Field><FieldLabel htmlFor="project-team">团队</FieldLabel><Input id="project-team" value={WORKSPACE_NAME} readOnly /></Field>
          <Field><FieldLabel htmlFor="project-start">开始日期</FieldLabel><Input id="project-start" type="date" value={startDate} onChange={event => setStartDate(event.target.value)} disabled={pending} /></Field>
          <Field><FieldLabel htmlFor="project-target">目标日期</FieldLabel><Input id="project-target" type="date" min={startDate || undefined} value={targetDate} onChange={event => setTargetDate(event.target.value)} disabled={pending} /></Field>
        </div>
        <Field><FieldLabel htmlFor="project-description">详细描述</FieldLabel><Textarea id="project-description" value={description} onChange={event => setDescription(event.target.value)} maxLength={50000} disabled={pending} rows={5} placeholder="说明背景、范围和交付标准…" /></Field>
      </FieldGroup>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button type="button" variant="outline" onClick={close} disabled={pending}>取消</Button><Button type="submit" disabled={pending || !name.trim()}>{pending ? '正在保存…' : project ? '保存修改' : '创建项目'}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>
}
