'use client'

import { useRef, useState } from 'react'
import { SettingsLink as Link } from '@/components/settings/settings-link'
import { pushSettingsHistory } from '@/lib/settings-navigation'
import { useRouter, useSearchParams } from 'next/navigation'
import useSWR, { useSWRConfig } from 'swr'
import { ArrowDown, ArrowUp, ChevronLeft, Search, SquareUserRound } from 'lucide-react'
import { changeTeamMember, type loadTeamDirectory } from '@/app/actions/teams'
import { fetchTeamDirectory, isSettingsAccessError, settingsReadOptions, teamDirectoryKey } from '@/lib/settings-data'
import { SettingsDataState } from '@/components/settings/settings-data-state'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { memberCsv } from '@/lib/invitation-csv'
import { TeamDirectoryMenu } from './team-directory-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import { TeamForm } from './team-form'
import { TeamMembersSettings } from './team-members-settings'
import { TeamSettingsDetails } from './team-settings-details'

type Directory = Awaited<ReturnType<typeof loadTeamDirectory>>
export function TeamDirectory({ workspaceId }: { workspaceId?: string }) {
  const router = useRouter()
  const params = useSearchParams()
  const initialTeamId = params.get('team') ?? undefined
  const createInitially = params.get('create') === '1'
  const initialView = params.get('view')
  const { mutate: refresh } = useSWRConfig()
  const { data, error: readError, mutate } = useSWR<Directory>(teamDirectoryKey(workspaceId), fetchTeamDirectory, settingsReadOptions)
  function navigate(href: string) { if (!pushSettingsHistory(href, workspaceId)) router.push(href) }
  const [query, setQuery] = useState('')
  const [view, setView] = useState('all')
  const [sortAscending, setSortAscending] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const downloadRef = useRef<HTMLAnchorElement>(null)
  const [downloadUrl, setDownloadUrl] = useState<string | undefined>()
  function updated() { void mutate(); void refresh('teams') }
  if (!data || isSettingsAccessError(readError)) return <SettingsDataState title="团队" error={readError} onRetry={() => void mutate()} />
  const directoryHref = `/settings/teams?workspace=${encodeURIComponent(data.workspace.id)}`
  function teamHref(teamId: string, page?: 'general' | 'members') { return `${directoryHref}&team=${encodeURIComponent(teamId)}${page ? `&view=${page}` : ''}` }
  function createTeam() { navigate(`${directoryHref}&create=1`) }
  async function saved(teamId: string) {
    try { await mutate(); void refresh('teams'); navigate(teamHref(teamId)) }
    catch { setError('团队已保存，但目录更新失败。请重新读取团队。') }
  }
  async function membership(teamId: string, joined: boolean) {
    if (pending) return
    setPending(true); setError('')
    try { const result = await changeTeamMember({ teamId, action: joined ? 'leave' : 'join' }); if (!result.ok) setError(result.error); else updated() }
    catch { setError('操作失败，请重试。') }
    finally { setPending(false) }
  }
  const filtered = data.teams.filter(team => (view === 'all' || !!team.role) && `${team.name} ${team.identifier} ${team.description}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => (sortAscending ? 1 : -1) * a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
  function exportTeams() {
    if (!downloadRef.current) return
    const csv = memberCsv([['名称', '团队标识', '简介', '可见性', '成员', '我的角色'], ...filtered.map(team => [team.name, team.identifier, team.description, '工作区', String(team.memberCount), team.role === 'owner' ? '负责人' : team.role === 'member' ? '成员' : '未加入'])])
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    setDownloadUrl(url)
    downloadRef.current.href = url
    downloadRef.current.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const selectedTeam = data.teams.find(team => team.id === initialTeamId)
  if (createInitially) return <TeamForm workspaceId={data.workspace.id} existingIdentifiers={data.teams.map(team => team.identifier)} onClose={() => navigate(directoryHref)} onSaved={saved} />
  if (initialTeamId && selectedTeam && initialView === 'general') return <TeamForm key={selectedTeam.id} workspaceId={data.workspace.id} team={selectedTeam} editable={selectedTeam.role === 'owner' || data.role === 'admin'} onClose={() => navigate(teamHref(selectedTeam.id))} onSaved={saved} />
  if (initialTeamId && selectedTeam) return <div className="w-full px-4 py-4 sm:px-6">
    {initialView === 'members' ? <section className="flex flex-col gap-8"><Button variant="ghost" size="sm" className="self-start" nativeButton={false} role="link" render={<Link workspaceId={data.workspace.id} href={teamHref(selectedTeam.id)} />}><ChevronLeft data-icon="inline-start" />团队设置</Button><div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pb-12 sm:pt-4"><header className="flex flex-col gap-2"><h1 className="text-2xl font-semibold tracking-tight">团队成员</h1><p className="text-sm text-muted-foreground">{selectedTeam.name} · {selectedTeam.memberCount} 位成员</p></header><TeamMembersSettings key={selectedTeam.id} team={selectedTeam} onUpdated={updated} /></div></section> : <TeamSettingsDetails key={selectedTeam.id} team={selectedTeam} />}
  </div>
  return <div data-settings-state={readError ? 'error' : 'ready'} className="flex w-full flex-col gap-8 px-5 py-10 sm:px-16 sm:py-16">
    {initialTeamId ? <Empty><EmptyHeader><EmptyTitle>团队不存在或不可访问</EmptyTitle><EmptyDescription>请从当前工作区的团队目录重新选择。</EmptyDescription></EmptyHeader><Button variant="outline" onClick={() => navigate(directoryHref)}>查看全部团队</Button></Empty> : <section aria-label="当前工作区团队" className="flex flex-col gap-6">
      <h1 aria-label="团队" className="text-2xl font-semibold tracking-tight" lang="en">Teams</h1>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <div className="min-w-0 flex-1 sm:w-80"><InputGroup><InputGroupAddon><Search /></InputGroupAddon><InputGroupInput aria-label="搜索团队" placeholder="Filter by name…" value={query} onChange={event => setQuery(event.target.value)} /></InputGroup></div>
          <Select value={view} items={[{ value: 'all', label: 'Active' }, { value: 'mine', label: 'Joined' }]} onValueChange={value => { if (value) setView(value) }}><SelectTrigger aria-label="团队范围"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">Active</SelectItem><SelectItem value="mine">Joined</SelectItem></SelectGroup></SelectContent></Select>
        </div>
        <div className="ml-auto flex items-center gap-2"><Button type="button" variant="outline" className="rounded-full" aria-label="导出团队 CSV" onClick={exportTeams}><span lang="en">Export CSV</span></Button><Button type="button" className="rounded-full" aria-label="新建团队" onClick={createTeam}><span lang="en">Create team</span></Button></div>
      </div>
      {(error || readError) && <Alert variant="destructive"><AlertDescription>{error || '团队更新失败，显示上次结果。'}{readError && <Button variant="ghost" size="sm" onClick={() => void mutate()}>重试</Button>}</AlertDescription></Alert>}
      {filtered.length ? <Table>
        <TableHeader><TableRow className="border-0 hover:bg-transparent"><TableHead aria-sort={sortAscending ? 'ascending' : 'descending'} className="w-1/3"><Button type="button" variant="ghost" size="sm" aria-label="按团队名称排序" onClick={() => setSortAscending(value => !value)}><span lang="en">Name</span>{sortAscending ? <ArrowDown data-icon="inline-end" /> : <ArrowUp data-icon="inline-end" />}</Button></TableHead><TableHead className="w-1/3" lang="en">Description</TableHead><TableHead lang="en">Visibility</TableHead><TableHead lang="en">Members</TableHead><TableHead className="w-12"><span className="sr-only">操作</span></TableHead></TableRow></TableHeader>
        <TableBody>
          <TableRow className="border-0 bg-muted/60 hover:bg-muted/60"><TableCell colSpan={5} className="rounded-lg px-4 py-2 text-muted-foreground"><span lang="en">{view === 'mine' ? 'Joined' : 'Active'}</span><span className="ml-2 tabular-nums">{filtered.length}</span></TableCell></TableRow>
          {filtered.map(team => <TableRow key={team.id} className="group border-0">
            <TableCell className="min-w-56 py-3"><div className="flex items-center gap-3"><SquareUserRound className="size-4 shrink-0 text-primary" aria-hidden="true" /><Link workspaceId={data.workspace.id} href={teamHref(team.id)} className="rounded-sm font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring">{team.name}</Link><span className="text-muted-foreground">{team.identifier}</span></div></TableCell>
            <TableCell><p className="max-w-80 truncate text-muted-foreground">{team.description}</p></TableCell>
            <TableCell className="text-muted-foreground" title="仅当前工作区的启用成员可访问" lang="en">Workspace</TableCell>
            <TableCell className="tabular-nums text-muted-foreground">{team.memberCount}</TableCell>
            <TableCell><TeamDirectoryMenu team={team} pending={pending} navigate={navigate} teamHref={teamHref} onMembership={membership} /></TableCell>
          </TableRow>)}
        </TableBody>
      </Table> : <Empty className="min-h-72"><EmptyHeader><EmptyTitle>{query ? '没有匹配的团队' : view === 'mine' ? '还没有加入团队' : '创建第一个团队'}</EmptyTitle><EmptyDescription>{query ? '试试其他名称或标识。' : '加入现有团队，或创建一个团队来组织任务和项目。'}</EmptyDescription></EmptyHeader><Button onClick={createTeam}>新建团队</Button></Empty>}
    </section>}
    <a ref={downloadRef} href={downloadUrl} download="teams.csv" className="hidden" tabIndex={-1} aria-hidden="true">下载团队 CSV</a>
  </div>
}
