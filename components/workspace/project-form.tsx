'use client'

import { useEffect, useRef, useState } from 'react'
import { saveProject } from '@/app/actions/projects'
import useSWR from 'swr'
import { toast } from 'sonner'
import { listTeams } from '@/app/actions/teams'
import { setProjectTeams } from '@/app/actions/team-relations'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Box, ChevronRight, ContactRound, X, LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DEFAULT_PROJECT_PROPERTIES, type ProjectDraft } from '@/lib/project-input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { IssueEditor } from './issue-editor'
import { readProjectDescription } from '@/lib/project-description'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { PROJECT_COLORS, PROJECT_ICON_COLORS, type Project, type ProjectControlField } from './project-properties'
import { ProjectPicker, ProjectPropertyControl } from './project-property-controls'
import { ProjectMilestones } from './project-milestones'
import { WORKSPACE_NAME } from './issue-properties'
import { ShortcutKeys } from '@/components/shortcut-keys'

const FIELDS: ProjectControlField[] = ['status', 'priority', 'lead', 'members', 'startDate', 'targetDate', 'labels', 'dependencyIds']

export function ProjectForm({ project, initialTeamId = '', projects = [], userName = '我', onClose, onSaved }: { project?: Project; initialTeamId?: string; projects?: Project[]; userName?: string; onClose: () => void; onSaved: (project: Project) => void }) {
  const [initial] = useState<ProjectDraft>(() => ({ name: project?.name ?? '', summary: project?.summary ?? '', description: project?.description || project?.summary || '', status: (project?.status ?? 'backlog') as ProjectDraft['status'], priority: (project?.priority ?? 'none') as ProjectDraft['priority'], lead: (project?.lead ?? '') as '' | 'me', team: WORKSPACE_NAME, startDate: project?.startDate ?? '', targetDate: project?.targetDate ?? '', properties: project?.properties ?? DEFAULT_PROJECT_PROPERTIES }))
  const { data: teams = [], error: teamsError } = useSWR('teams', listTeams)
  const [teamId, setTeamId] = useState(initialTeamId)
  const [draft, setDraft] = useState(initial)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const submitting = useRef(false)
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial) || teamId !== initialTeamId
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
      const result = await saveProject({ ...draft, id: project?.id, revision: project?.revision })
      if (!result.project) { setError(result.error ?? '保存失败。'); return }
      if (!project && teamId) {
        try {
          const relation = await setProjectTeams({ projectId: result.project.id, revision: result.project.revision, teamIds: [teamId], primaryTeamId: teamId })
          if (relation.ok) { onSaved(relation.data); return }
          toast.warning(`项目已创建，但团队关联未保存：${relation.error} 请在项目属性重试。`)
        } catch { toast.warning('项目已创建，团队关联未保存。请在项目属性重试，不要重复创建。') }
      }
      onSaved(result.project)
    } catch { setError('保存失败，输入已保留，请重试。') }
    finally { submitting.current = false; setPending(false) }
  }
  return <Dialog open onOpenChange={value => { if (!value) close() }}><DialogContent showCloseButton={false} className="flex h-[min(88svh,58rem)] max-w-[calc(100%-1.5rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-card p-0 shadow-2xl sm:max-w-4xl">
    <DialogHeader className="flex-row items-center justify-between gap-3 px-5 pt-5 sm:px-7"><div className="flex items-center gap-2"><Badge variant="outline" className="gap-1.5 rounded-full px-2 py-1 font-normal"><ContactRound className="text-info-foreground" />项目</Badge><ChevronRight className="size-3 text-muted-foreground" /><DialogTitle className="text-sm font-normal">{project ? '编辑项目' : '新建项目'}</DialogTitle></div><Button type="button" variant="ghost" size="icon-sm" aria-label="关闭项目编辑器" disabled={pending} onClick={close}><X data-icon="inline-start" /></Button><DialogDescription className="sr-only">设置项目名称、描述、属性和里程碑，保存到工作区。</DialogDescription></DialogHeader>
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={event => { event.preventDefault(); void submit() }} onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); if (draft.name.trim()) void submit() } }}>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pt-4 pb-5 sm:px-7">
        <div className="self-start"><ProjectPicker label="项目图标颜色" choices={PROJECT_COLORS.map(item => ({ value: item.value, label: item.label, icon: Box }))} selected={[draft.properties.color]} onChange={value => setDraft(current => ({ ...current, properties: { ...current.properties, color: value as ProjectDraft['properties']['color'] } }))} disabled={pending} plain><span className={cn('flex size-8 items-center justify-center rounded-md', PROJECT_ICON_COLORS[draft.properties.color])}><Box data-icon="inline-start" /></span></ProjectPicker></div>
        <FieldGroup><Field className="gap-0"><FieldLabel className="sr-only" htmlFor="project-name">项目名称</FieldLabel><Input id="project-name" className="h-10 rounded-none border-0 bg-transparent! px-0 text-2xl font-semibold shadow-none md:text-2xl focus-visible:ring-0" value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} maxLength={200} required disabled={pending} placeholder="项目名称" /></Field></FieldGroup>
        <div className="flex flex-wrap items-center gap-2">{FIELDS.map(field => <ProjectPropertyControl key={field} field={field} value={draft} userName={userName} projects={projects} projectId={project?.id} disabled={pending} onChange={changes => setDraft(current => ({ ...current, ...changes }))} />)}</div>
        {!project && <FieldGroup><Field><FieldLabel htmlFor="new-project-team">主责团队</FieldLabel><NativeSelect id="new-project-team" value={teamId} disabled={pending || !!teamsError} onChange={event => setTeamId(event.target.value)}><NativeSelectOption value="">无团队 · 私有项目</NativeSelectOption>{teams.map(team => <NativeSelectOption key={team.id} value={team.id}>{team.identifier} · {team.name}</NativeSelectOption>)}</NativeSelect><p className="text-xs text-muted-foreground">{teamId ? '项目将对团队所在工作区的所有启用成员公开，可协作编辑。创建后可关联更多团队。' : '未关联团队的项目仅创建者可见。'}</p></Field></FieldGroup>}
        <section aria-labelledby="project-form-description-heading" className="flex min-w-0 flex-col gap-4 pt-4"><h2 id="project-form-description-heading" className="text-sm font-medium text-muted-foreground">描述</h2><IssueEditor layout="description" label="项目描述" content={readProjectDescription(initial.description)} disabled={pending} onChange={content => setDraft(current => ({ ...current, description: JSON.stringify(content) }))} /></section>
        <ProjectMilestones value={draft.properties.milestones} disabled={pending} onChange={milestones => setDraft(current => ({ ...current, properties: { ...current.properties, milestones } }))} />
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-3 px-5 py-4 sm:px-7"><span className="mr-auto hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex"><ShortcutKeys keys={['mod', 'Enter']} />{project ? '保存' : '创建'}</span><Button type="submit" className="rounded-full bg-project-action px-4 text-project-action-foreground hover:bg-project-action/90" disabled={pending || !draft.name.trim()}>{pending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}{pending ? '正在保存…' : project ? '保存修改' : '创建项目'}</Button></footer>
    </form>
  </DialogContent></Dialog>
}
