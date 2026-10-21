'use client'

import { useRef, useState } from 'react'
import { SettingsLink as Link } from '@/components/settings/settings-link'
import useSWR from 'swr'
import { listTeams } from '@/app/actions/teams'
import { listProjectTeams, setProjectTeams } from '@/app/actions/team-relations'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { Project } from '@/components/workspace/project-properties'

export function ProjectTeamControl({ project, onUpdated, disabled }: { project: Project; onUpdated: () => void; disabled: boolean }) {
  const { data: teams = [], error: teamsError } = useSWR('teams', listTeams)
  const { data: links, error: linksError, mutate } = useSWR('project-teams', listProjectTeams)
  const [open, setOpen] = useState(false)
  const current = links?.filter(link => link.projectId === project.id) ?? []
  return <section className="flex flex-col gap-3"><h2 className="text-sm font-medium">关联团队</h2><div className="flex flex-wrap gap-2">{current.map(link => { const team = teams.find(team => team.id === link.teamId); return <Badge key={link.teamId} variant={link.isPrimary ? 'secondary' : 'outline'}>{team?.name ?? '团队'}{link.isPrimary ? ' · 主责' : ''}</Badge> })}{links && !current.length && <p className="text-xs text-muted-foreground">无关联团队 · 私有项目</p>}</div><Button size="sm" variant="outline" disabled={disabled || !links || !!teamsError || !!linksError} onClick={() => setOpen(true)}>管理关联团队</Button>{(teamsError || linksError) && <p role="alert" className="text-xs text-destructive">团队关系读取失败，请刷新重试。</p>}
    {open && <ProjectTeamForm project={project} teams={teams} initialIds={current.map(link => link.teamId)} initialPrimary={current.find(link => link.isPrimary)?.teamId ?? ''} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); void mutate(); onUpdated() }} />}
  </section>
}
function ProjectTeamForm({ project, teams, initialIds, initialPrimary, onClose, onSaved }: { project: Project; teams: Awaited<ReturnType<typeof listTeams>>; initialIds: string[]; initialPrimary: string; onClose: () => void; onSaved: () => void }) {
  const [ids, setIds] = useState(initialIds)
  const [primary, setPrimary] = useState(initialPrimary)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  const workspaceId = teams.find(team => team.id === ids[0])?.workspaceId ?? teams.find(team => team.id === initialIds[0])?.workspaceId
  async function save() {
    if (busy.current) return
    if (!window.confirm(ids.length ? '关联后，项目将对团队所在工作区所有启用成员公开并允许编辑，是否继续？' : '取消所有团队关联后，项目将仅对创建者可见，是否继续？')) return
    busy.current = true; setPending(true); setError('')
    try {
      const result = await setProjectTeams({ projectId: project.id, revision: project.revision, teamIds: ids, primaryTeamId: primary || null })
      if (!result.ok) { setError(result.error); return }
      onSaved()
    } catch { setError('保存失败，选择已保留，请重试。') }
    finally { busy.current = false; setPending(false) }
  }
  return <Dialog open onOpenChange={value => { if (!value && !busy.current) onClose() }}><DialogContent className="max-h-[85svh] overflow-y-auto"><DialogHeader><DialogTitle>项目关联团队</DialogTitle><DialogDescription>可关联同一工作区的多个团队，并指定一个主责团队。项目任务须归属于所选团队；历史私有数据不会自动公开。</DialogDescription></DialogHeader><form className="flex flex-col gap-6" onSubmit={event => { event.preventDefault(); void save() }}><FieldGroup>{teams.map(team => <Field key={team.id} orientation="horizontal"><Checkbox id={`project-team-${team.id}`} checked={ids.includes(team.id)} disabled={pending || !!workspaceId && team.workspaceId !== workspaceId} onCheckedChange={checked => { const next = checked ? [...ids, team.id] : ids.filter(id => id !== team.id); setIds(next); if (!next.includes(primary)) setPrimary(next[0] ?? '') }} /><FieldLabel htmlFor={`project-team-${team.id}`}>{team.identifier} · {team.name}</FieldLabel></Field>)}{!teams.length && <p className="text-sm text-muted-foreground">暂无可关联的团队。<Link href="/settings/teams" className="underline underline-offset-4">前往创建团队</Link></p>}<Field><FieldLabel htmlFor="project-primary-team">主责团队</FieldLabel><NativeSelect id="project-primary-team" value={primary} disabled={pending || !ids.length} onChange={event => setPrimary(event.target.value)}><NativeSelectOption value="">无主责团队</NativeSelectOption>{teams.filter(team => ids.includes(team.id)).map(team => <NativeSelectOption key={team.id} value={team.id}>{team.name}</NativeSelectOption>)}</NativeSelect></Field></FieldGroup>{error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}<DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={onClose}>取消</Button><Button type="submit" disabled={pending || !!ids.length && !primary}>{pending ? '保存中…' : '保存团队关联'}</Button></DialogFooter></form></DialogContent></Dialog>
}
