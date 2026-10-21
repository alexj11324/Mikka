'use client'

import { useState } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { Box, Layers, Settings2, SquareUserRound, Users } from 'lucide-react'
import { listTeamMembers, type listTeams } from '@/app/actions/teams'
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
  const [tab, setTab] = useState('overview')
  const { data, error, mutate } = useSWR(['team-members', team.id], () => listTeamMembers(team.id))
  const members = data?.members.filter(member => member.status === 'active') ?? []
  const settingsHref = `/settings/teams?workspace=${encodeURIComponent(team.workspaceId)}&team=${encodeURIComponent(team.id)}`
  return <Tabs value={tab} onValueChange={value => setTab(String(value))} className="flex flex-1 flex-col gap-0">
    <div className="px-4 py-3"><TabsList aria-label="团队主页导航"><TabsTrigger value="overview">概览</TabsTrigger><TabsTrigger value="members">成员{data ? ` · ${members.length}` : ''}</TabsTrigger></TabsList></div>
    <div className="mx-auto grid w-full max-w-6xl gap-10 px-6 py-8 sm:px-10 sm:py-10 lg:grid-cols-[minmax(0,1fr)_13rem] lg:gap-16">
      <div className="min-w-0"><header className="mb-10 flex flex-col gap-5"><div className="flex items-center gap-4"><span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-info text-info-foreground"><SquareUserRound className="size-7" aria-hidden="true" /></span><h1 className="text-3xl font-semibold tracking-tight">{team.name}</h1></div><p className="text-base leading-relaxed text-muted-foreground">{team.description || '尚未填写团队简介。'}</p></header>
        <TabsContent value="overview"><section className="flex flex-col gap-5" aria-labelledby="team-resources-heading"><div className="flex flex-wrap items-center justify-between gap-3"><h2 id="team-resources-heading" className="text-xl font-medium">团队资源</h2><Button variant="ghost" size="sm" onClick={onProjects}>查看全部项目</Button></div>{projects.length > 0 ? <div className="flex flex-col gap-2">{projects.map(project => <Button key={project.id} variant="ghost" className="h-auto justify-start gap-3 px-3 py-3" onClick={() => onProject(project.id)}><Box data-icon="inline-start" /><span className="flex min-w-0 flex-col gap-1 text-left"><span className="truncate">{project.name}</span>{project.summary && <span className="truncate text-xs text-muted-foreground">{project.summary}</span>}</span></Button>)}</div> : <p className="text-base leading-relaxed text-muted-foreground">暂无关联项目。在团队项目中组织工作，项目会显示在这里。</p>}<p className="text-xs text-muted-foreground">团队文档与链接收藏尚未接入。</p></section></TabsContent>
        <TabsContent value="members"><section className="flex flex-col gap-5" aria-labelledby="team-roster-heading"><div className="flex items-center justify-between gap-3"><h2 id="team-roster-heading" className="text-xl font-medium">团队成员</h2><Button variant="outline" size="sm" nativeButton={false} role="link" render={<Link href={settingsHref} />}><Users data-icon="inline-start" />成员设置</Button></div>{error ? <Alert variant="destructive"><AlertDescription>成员读取失败。<Button variant="ghost" size="sm" onClick={() => void mutate()}>重试</Button></AlertDescription></Alert> : !data ? <Skeleton className="h-28 w-full" /> : members.length ? <Table><TableHeader><TableRow><TableHead>成员</TableHead><TableHead>角色</TableHead></TableRow></TableHeader><TableBody>{members.map(member => <TableRow key={member.userId}><TableCell><div className="flex items-center gap-3"><UserAvatar user={member} /><div className="flex flex-col gap-1"><span>{member.name || member.email}</span><span className="text-xs text-muted-foreground">{member.email}</span></div></div></TableCell><TableCell>{member.role === 'owner' ? '负责人' : '成员'}</TableCell></TableRow>)}</TableBody></Table> : <Empty><EmptyHeader><EmptyTitle>暂无启用中的团队成员</EmptyTitle><EmptyDescription>可在团队设置中查看和管理成员。</EmptyDescription></EmptyHeader></Empty>}</section></TabsContent>
      </div>
      <aside className="flex flex-col gap-8 pt-1" aria-label="团队快捷入口"><section className="flex flex-col gap-4"><h2 className="text-sm font-medium text-muted-foreground">成员</h2>{!data && !error ? <Skeleton className="size-8 rounded-full" /> : error ? <Button variant="ghost" size="sm" className="self-start" onClick={() => void mutate()}>重新读取成员</Button> : <div className="flex flex-wrap items-center gap-2">{members.slice(0, 6).map(member => <Button key={member.userId} variant="ghost" size="icon-sm" className="rounded-full" aria-label={`查看团队成员 ${member.name || member.email}`} title={member.name || member.email} onClick={() => setTab('members')}><UserAvatar user={member} size="md" /></Button>)}{members.length > 6 && <Button variant="ghost" size="sm" onClick={() => setTab('members')}>+{members.length - 6}</Button>}{members.length === 0 && <p className="text-sm text-muted-foreground">暂无成员</p>}</div>}</section><section className="flex flex-col gap-3"><h2 className="text-sm font-medium text-muted-foreground">前往</h2><div className="flex flex-col gap-1"><Button variant="ghost" className="justify-start" nativeButton={false} role="link" render={<Link href={settingsHref} />}><Settings2 data-icon="inline-start" />团队设置</Button><Button variant="ghost" className="justify-start" onClick={onIssues}><Layers data-icon="inline-start" />任务<span className="ml-auto text-xs text-muted-foreground">{issueCount}</span></Button><Button variant="ghost" className="justify-start" onClick={onProjects}><Box data-icon="inline-start" />项目<span className="ml-auto text-xs text-muted-foreground">{projects.length}</span></Button></div></section></aside>
    </div>
  </Tabs>
}
