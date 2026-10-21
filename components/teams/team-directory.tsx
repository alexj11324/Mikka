'use client'

import { useEffect, useState } from 'react'
import { SettingsLink as Link } from '@/components/settings/settings-link'
import { pushSettingsHistory } from '@/lib/settings-navigation'
import { useRouter, useSearchParams } from 'next/navigation'
import useSWR, { useSWRConfig } from 'swr'
import { ChevronLeft, Globe2, Plus } from 'lucide-react'
import { loadTeamDirectory, changeTeamMember } from '@/app/actions/teams'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import { TeamForm } from './team-form'
import { TeamMembersSettings } from './team-members-settings'
import { TeamSettingsDetails } from './team-settings-details'

type Directory = Awaited<ReturnType<typeof loadTeamDirectory>>
export function TeamDirectory({ initial }: { initial: Directory }) {
  const router = useRouter()
  const params = useSearchParams()
  const initialTeamId = params.get('team') ?? undefined
  const createInitially = params.get('create') === '1'
  const initialView = params.get('view')
  const { mutate: refresh } = useSWRConfig()
  const { data = initial, error: readError, mutate } = useSWR(['team-directory', initial.workspace.id], () => loadTeamDirectory(initial.workspace.id), { fallbackData: initial, revalidateOnMount: false })
  useEffect(() => { void mutate(initial, { revalidate: false }) }, [initial, mutate])
  function navigate(href: string) { if (!pushSettingsHistory(href, initial.workspace.id)) router.push(href) }
  const [query, setQuery] = useState('')
  const [view, setView] = useState('all')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  function updated() { void mutate(); void refresh('teams') }
  const directoryHref = `/settings/teams?workspace=${encodeURIComponent(data.workspace.id)}`
  function teamHref(teamId: string, page?: 'general' | 'members') { return `${directoryHref}&team=${encodeURIComponent(teamId)}${page ? `&view=${page}` : ''}` }
  function createTeam() { navigate(`${directoryHref}&create=1`) }
  function saved(teamId: string) { updated(); router.push(teamHref(teamId)) }
  async function membership(teamId: string, joined: boolean) {
    if (pending) return
    setPending(true); setError('')
    try { const result = await changeTeamMember({ teamId, action: joined ? 'leave' : 'join' }); if (!result.ok) setError(result.error); else updated() }
    catch { setError('操作失败，请重试。') }
    finally { setPending(false) }
  }
  const filtered = data.teams.filter(team => (view === 'all' || !!team.role) && `${team.name} ${team.identifier} ${team.description}`.toLowerCase().includes(query.trim().toLowerCase()))
  const selectedTeam = data.teams.find(team => team.id === initialTeamId)
  if (createInitially) return <TeamForm workspaceId={data.workspace.id} onClose={() => navigate(directoryHref)} onSaved={saved} />
  if (initialTeamId && selectedTeam && initialView === 'general') return <TeamForm key={selectedTeam.id} workspaceId={data.workspace.id} team={selectedTeam} editable={selectedTeam.role === 'owner' || data.role === 'admin'} onClose={() => navigate(teamHref(selectedTeam.id))} onSaved={saved} />
  if (initialTeamId && selectedTeam) return <div className="w-full px-4 py-4 sm:px-6">
    {initialView === 'members' ? <section className="flex flex-col gap-8"><Button variant="ghost" size="sm" className="self-start" nativeButton={false} role="link" render={<Link workspaceId={data.workspace.id} href={teamHref(selectedTeam.id)} />}><ChevronLeft data-icon="inline-start" />团队设置</Button><div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pb-12 sm:pt-4"><header className="flex flex-col gap-2"><h1 className="text-2xl font-semibold tracking-tight">团队成员</h1><p className="text-sm text-muted-foreground">{selectedTeam.name} · {selectedTeam.memberCount} 位成员</p></header><TeamMembersSettings key={selectedTeam.id} team={selectedTeam} onUpdated={updated} /></div></section> : <TeamSettingsDetails key={selectedTeam.id} team={selectedTeam} />}
  </div>
  return <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-8 sm:px-10 sm:py-12">
    <div className="flex flex-wrap items-center justify-between gap-4"><div className="text-sm text-muted-foreground">{data.workspace.name} · 工作区设置</div><NativeSelect aria-label="团队目录工作区" value={data.workspace.id} onChange={event => navigate(`/settings/teams?workspace=${encodeURIComponent(event.target.value)}`)}>{data.choices.map(workspace => <NativeSelectOption key={workspace.id} value={workspace.id}>{workspace.name}</NativeSelectOption>)}</NativeSelect></div>
    {initialTeamId ? <Empty><EmptyHeader><EmptyTitle>团队不存在或不可访问</EmptyTitle><EmptyDescription>请从当前工作区的团队目录重新选择。</EmptyDescription></EmptyHeader><Button variant="outline" nativeButton={false} role="link" render={<Link workspaceId={data.workspace.id} href={directoryHref} />}>查看全部团队</Button></Empty> : <section className="flex flex-col gap-6"><div className="flex flex-wrap items-start justify-between gap-4"><div className="flex flex-col gap-2"><div className="flex items-center gap-3"><h1 className="text-2xl font-semibold tracking-tight">团队</h1><Badge variant="secondary">{data.teams.length}</Badge></div><p className="max-w-xl text-sm leading-relaxed text-muted-foreground">让成员围绕共同职责协作。团队、任务与项目对本工作区启用成员公开，不对外网公开。</p></div><Button size="sm" onClick={createTeam}><Plus data-icon="inline-start" />新建团队</Button></div>
      <div className="flex flex-wrap items-center justify-between gap-3"><ToggleGroup aria-label="团队范围" variant="outline" spacing={0} value={[view]} onValueChange={values => { if (values[0]) setView(values[0]) }}><ToggleGroupItem value="all">全部团队</ToggleGroupItem><ToggleGroupItem value="mine">我加入的</ToggleGroupItem></ToggleGroup><Input aria-label="搜索团队" placeholder="搜索名称或团队标识…" className="w-full sm:w-64" value={query} onChange={event => setQuery(event.target.value)} /></div>
      {(error || readError) && <Alert variant="destructive"><AlertDescription>{error || '团队更新失败，显示上次结果。'}{readError && <Button variant="ghost" size="sm" onClick={() => void mutate()}>重试</Button>}</AlertDescription></Alert>}
      {filtered.length ? <Table><TableHeader><TableRow><TableHead>团队</TableHead><TableHead>可见性</TableHead><TableHead>成员</TableHead><TableHead>我的角色</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{filtered.map(team => <TableRow key={team.id}><TableCell className="min-w-52 py-5"><div className="flex flex-col gap-1"><p className="font-medium"><Link workspaceId={data.workspace.id} href={teamHref(team.id)} className="rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring">{team.name}</Link><span className="ml-2 font-mono text-xs text-muted-foreground">{team.identifier}</span></p><p className="max-w-md truncate text-xs text-muted-foreground">{team.description || '暂无简介'}</p></div></TableCell><TableCell><Badge variant="outline"><Globe2 />公开</Badge></TableCell><TableCell>{team.memberCount}</TableCell><TableCell>{team.role === 'owner' ? '负责人' : team.role === 'member' ? '成员' : '未加入'}</TableCell><TableCell><div className="flex items-center justify-end gap-1"><Button variant="ghost" size="sm" onClick={() => navigate(teamHref(team.id, 'members'))}>成员</Button>{(team.role === 'owner' || data.role === 'admin') && <Button variant="ghost" size="sm" onClick={() => navigate(teamHref(team.id, 'general'))}>编辑</Button>}<Button variant={team.role ? 'outline' : 'secondary'} size="sm" disabled={pending} onClick={() => void membership(team.id, !!team.role)}>{team.role ? '退出' : '加入'}</Button></div></TableCell></TableRow>)}</TableBody></Table> : <Empty className="min-h-72"><EmptyHeader><EmptyTitle>{query ? '没有匹配的团队' : view === 'mine' ? '还没有加入团队' : '创建第一个公开团队'}</EmptyTitle><EmptyDescription>{query ? '试试其他名称或标识。' : '加入现有团队，或创建一个团队来组织任务和项目。'}</EmptyDescription></EmptyHeader><Button size="sm" onClick={createTeam}><Plus data-icon="inline-start" />新建团队</Button></Empty>}
    </section>}
  </div>
}
