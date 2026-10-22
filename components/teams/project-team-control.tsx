'use client'
import { useTranslations } from 'next-intl'

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
  const i18nText = useTranslations();
  const { data: teams = [], error: teamsError } = useSWR('teams', listTeams)
  const { data: links, error: linksError, mutate } = useSWR('project-teams', listProjectTeams)
  const [open, setOpen] = useState(false)
  const current = links?.filter(link => link.projectId === project.id) ?? []
  return <section className="flex flex-col gap-3"><h2 className="text-sm font-medium">{i18nText("FeatureCopy.c_8663016b")}</h2><div className="flex flex-wrap gap-2">{current.map(link => { const team = teams.find(team => team.id === link.teamId); return <Badge key={link.teamId} variant={link.isPrimary ? 'secondary' : 'outline'}>{team?.name ?? i18nText("Settings.sections.teams.title")}{link.isPrimary ? i18nText("FeatureCopy.c_e99105b9") : ''}</Badge> })}{links && !current.length && <p className="text-xs text-muted-foreground">{i18nText("FeatureCopy.c_46147716")}</p>}</div><Button size="sm" variant="outline" disabled={disabled || !links || !!teamsError || !!linksError} onClick={() => setOpen(true)}>{i18nText("FeatureCopy.c_1ddf3032")}</Button>{(teamsError || linksError) && <p role="alert" className="text-xs text-destructive">{i18nText("FeatureCopy.c_d50b2473")}</p>}
    {open && <ProjectTeamForm project={project} teams={teams} initialIds={current.map(link => link.teamId)} initialPrimary={current.find(link => link.isPrimary)?.teamId ?? ''} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); void mutate(); onUpdated() }} />}
  </section>
}
function ProjectTeamForm({ project, teams, initialIds, initialPrimary, onClose, onSaved }: { project: Project; teams: Awaited<ReturnType<typeof listTeams>>; initialIds: string[]; initialPrimary: string; onClose: () => void; onSaved: () => void }) {
  const i18nText = useTranslations();
  const [ids, setIds] = useState(initialIds)
  const [primary, setPrimary] = useState(initialPrimary)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  const workspaceId = teams.find(team => team.id === ids[0])?.workspaceId ?? teams.find(team => team.id === initialIds[0])?.workspaceId
  async function save() {
    if (busy.current) return
    if (!window.confirm(ids.length ? i18nText("FeatureCopy.c_0e51f445") : i18nText("FeatureCopy.c_e56e5694"))) return
    busy.current = true; setPending(true); setError('')
    try {
      const result = await setProjectTeams({ projectId: project.id, revision: project.revision, teamIds: ids, primaryTeamId: primary || null })
      if (!result.ok) { setError(result.error); return }
      onSaved()
    } catch { setError(i18nText("FeatureCopy.c_281364f7")) }
    finally { busy.current = false; setPending(false) }
  }
  return <Dialog open onOpenChange={value => { if (!value && !busy.current) onClose() }}><DialogContent className="max-h-[85svh] overflow-y-auto"><DialogHeader><DialogTitle>{i18nText("FeatureCopy.c_60df03f7")}</DialogTitle><DialogDescription>{i18nText("FeatureCopy.c_fd1c9fe6")}</DialogDescription></DialogHeader><form className="flex flex-col gap-6" onSubmit={event => { event.preventDefault(); void save() }}><FieldGroup>{teams.map(team => <Field key={team.id} orientation="horizontal"><Checkbox id={`project-team-${team.id}`} checked={ids.includes(team.id)} disabled={pending || !!workspaceId && team.workspaceId !== workspaceId} onCheckedChange={checked => { const next = checked ? [...ids, team.id] : ids.filter(id => id !== team.id); setIds(next); if (!next.includes(primary)) setPrimary(next[0] ?? '') }} /><FieldLabel htmlFor={`project-team-${team.id}`}>{team.identifier} · {team.name}</FieldLabel></Field>)}{!teams.length && <p className="text-sm text-muted-foreground">{i18nText("FeatureCopy.c_4b0d21bb")}<Link href="/settings/teams" className="underline underline-offset-4">{i18nText("FeatureCopy.c_8c9b2d51")}</Link></p>}<Field><FieldLabel htmlFor="project-primary-team">{i18nText("FeatureCopy.c_7968c9e3")}</FieldLabel><NativeSelect id="project-primary-team" value={primary} disabled={pending || !ids.length} onChange={event => setPrimary(event.target.value)}><NativeSelectOption value="">{i18nText("FeatureCopy.c_d663b332")}</NativeSelectOption>{teams.filter(team => ids.includes(team.id)).map(team => <NativeSelectOption key={team.id} value={team.id}>{team.name}</NativeSelectOption>)}</NativeSelect></Field></FieldGroup>{error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}<DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={onClose}>{i18nText("Editor.richText.cancel")}</Button><Button type="submit" disabled={pending || !!ids.length && !primary}>{pending ? i18nText("FeatureCopy.c_6644f061") : i18nText("FeatureCopy.c_8503b651")}</Button></DialogFooter></form></DialogContent></Dialog>
}
