'use client'
import { useTranslations } from 'next-intl'

import { useState } from 'react'
import { SettingsLink as Link } from '@/components/settings/settings-link'
import useSWR from 'swr'
import { Box, Layers, Settings2, SquareUserRound, Users } from 'lucide-react'
import type { listTeams } from '@/app/actions/teams'
import { fetchTeamMembers, settingsReadOptions, teamMembersKey } from '@/lib/settings-data'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { UserAvatar } from '@/components/user-avatar'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty'

type Team = Awaited<ReturnType<typeof listTeams>>[number]
type Project = { id: string; name: string; summary: string }

export function TeamHome({ team, projects, issueCount, onIssues, onProjects, onProject }: { team: Team; projects: Project[]; issueCount: number; onIssues: () => void; onProjects: () => void; onProject: (id: string) => void }) {
  const i18nText = useTranslations();
  const [tab, setTab] = useState('overview')
  const { data, error, mutate } = useSWR(teamMembersKey(team.id), fetchTeamMembers, settingsReadOptions)
  const members = data?.members.filter(member => member.status === 'active') ?? []
  const settingsHref = `/settings/teams?workspace=${encodeURIComponent(team.workspaceId)}&team=${encodeURIComponent(team.id)}`
  return <Tabs value={tab} onValueChange={value => setTab(String(value))} className="flex flex-1 flex-col gap-0">
    <div className="px-4 py-3"><TabsList aria-label={i18nText("FeatureCopy.c_1a0a74c5")}><TabsTrigger value="overview">{i18nText("Projects.detail.overview")}</TabsTrigger><TabsTrigger value="members">{i18nText("Invite.roles.member")}{data ? ` · ${members.length}` : ''}</TabsTrigger></TabsList></div>
    <div className="mx-auto grid w-full max-w-6xl gap-10 px-6 py-8 sm:px-10 sm:py-10 lg:grid-cols-[minmax(0,1fr)_13rem] lg:gap-16">
      <div className="min-w-0"><header className="mb-10 flex flex-col gap-5"><div className="flex items-center gap-4"><span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-info text-info-foreground"><SquareUserRound className="size-7" aria-hidden="true" /></span><h1 className="text-3xl font-semibold tracking-tight">{team.name}</h1></div><p className="text-base leading-relaxed text-muted-foreground">{team.description || i18nText("FeatureCopy.c_651d8f98")}</p></header>
        <TabsContent value="overview"><section className="flex flex-col gap-5" aria-labelledby="team-resources-heading"><div className="flex flex-wrap items-center justify-between gap-3"><h2 id="team-resources-heading" className="text-xl font-medium">{i18nText("FeatureCopy.c_3e098713")}</h2><Button variant="ghost" size="sm" onClick={onProjects}>{i18nText("FeatureCopy.c_4090a5db")}</Button></div>{projects.length > 0 ? <div className="flex flex-col gap-2">{projects.map(project => <Button key={project.id} variant="ghost" className="h-auto justify-start gap-3 px-3 py-3" onClick={() => onProject(project.id)}><Box data-icon="inline-start" /><span className="flex min-w-0 flex-col gap-1 text-left"><span className="truncate">{project.name}</span>{project.summary && <span className="truncate text-xs text-muted-foreground">{project.summary}</span>}</span></Button>)}</div> : <p className="text-base leading-relaxed text-muted-foreground">{i18nText("FeatureCopy.c_174759ae")}</p>}<p className="text-xs text-muted-foreground">{i18nText("FeatureCopy.c_6d06b039")}</p></section></TabsContent>
        <TabsContent value="members"><section className="flex flex-col gap-5" aria-labelledby="team-roster-heading"><div className="flex items-center justify-between gap-3"><h2 id="team-roster-heading" className="text-xl font-medium">{i18nText("FeatureCopy.c_7de0251f")}</h2><Button variant="outline" size="sm" nativeButton={false} role="link" render={<Link href={settingsHref} />}><Users data-icon="inline-start" />{i18nText("FeatureCopy.c_dfacc750")}</Button></div>{error ? <Alert variant="destructive"><AlertDescription>{i18nText("FeatureCopy.c_cdbd68cd")}<Button variant="ghost" size="sm" onClick={() => void mutate()}>{i18nText("Common.retry")}</Button></AlertDescription></Alert> : !data ? <Skeleton className="h-28 w-full" /> : members.length ? <Table><TableHeader><TableRow><TableHead>{i18nText("Invite.roles.member")}</TableHead><TableHead>{i18nText("Members.csv.role")}</TableHead></TableRow></TableHeader><TableBody>{members.map(member => <TableRow key={member.userId}><TableCell><div className="flex items-center gap-3"><UserAvatar user={member} /><div className="flex flex-col gap-1"><span>{member.name || member.email}</span><span className="text-xs text-muted-foreground">{member.email}</span></div></div></TableCell><TableCell>{member.role === 'owner' ? i18nText("Projects.fields.lead") : i18nText("Invite.roles.member")}</TableCell></TableRow>)}</TableBody></Table> : <Empty><EmptyHeader><EmptyTitle>{i18nText("FeatureCopy.c_6dcbfbc6")}</EmptyTitle><EmptyDescription>{i18nText("FeatureCopy.c_b676d0fb")}</EmptyDescription></EmptyHeader></Empty>}</section></TabsContent>
      </div>
      <aside className="flex flex-col gap-8 pt-1" aria-label={i18nText("FeatureCopy.c_6e7288e8")}><section className="flex flex-col gap-4"><h2 className="text-sm font-medium text-muted-foreground">{i18nText("Invite.roles.member")}</h2>{!data && !error ? <Skeleton className="size-8 rounded-full" /> : error ? <Button variant="ghost" size="sm" className="self-start" onClick={() => void mutate()}>{i18nText("Metadata.assignee.reload")}</Button> : <div className="flex flex-wrap items-center gap-2">{members.slice(0, 6).map(member => <Button key={member.userId} variant="ghost" size="icon-sm" className="rounded-full" aria-label={i18nText("FeatureCopy.c_d3c79e1a", { value0: (member.name || member.email) })} title={member.name || member.email} onClick={() => setTab('members')}><UserAvatar user={member} size="md" /></Button>)}{members.length > 6 && <Button variant="ghost" size="sm" onClick={() => setTab('members')}>+{members.length - 6}</Button>}{members.length === 0 && <p className="text-sm text-muted-foreground">{i18nText("FeatureCopy.c_d14b5cff")}</p>}</div>}</section><section className="flex flex-col gap-3"><h2 className="text-sm font-medium text-muted-foreground">{i18nText("FeatureCopy.c_23926d61")}</h2><div className="flex flex-col gap-1"><Button variant="ghost" className="justify-start" nativeButton={false} role="link" render={<Link href={settingsHref} />}><Settings2 data-icon="inline-start" />{i18nText("FeatureCopy.c_212cf650")}</Button><Button variant="ghost" className="justify-start" onClick={onIssues}><Layers data-icon="inline-start" />{i18nText("Projects.detail.issues")}<span className="ml-auto text-xs text-muted-foreground">{issueCount}</span></Button><Button variant="ghost" className="justify-start" onClick={onProjects}><Box data-icon="inline-start" />{i18nText("Projects.title")}<span className="ml-auto text-xs text-muted-foreground">{projects.length}</span></Button></div></section></aside>
    </div>
  </Tabs>
}
