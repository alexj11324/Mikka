'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { ArrowLeft, ChevronRight, Command, ExternalLink, Info, MoreHorizontal, Search, Shield, UserPlus, Users } from 'lucide-react'
import type { WorkspaceSettings } from '@/lib/workspace-access'
import { revokeWorkspaceInvitation, updateWorkspaceMember } from '@/app/actions/workspace'
import { InviteMembersDialog } from '@/components/workspace/invite-members-dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/reui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from '@/components/ui/empty'
import { Separator } from '@/components/ui/separator'

async function fetchSettings(url: string): Promise<WorkspaceSettings> {
  const response = await fetch(url)
  if (!response.ok) throw new Error('成员数据读取失败，请刷新页面确认权限。')
  return response.json()
}
const date = (value: string) => new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', timeZone: 'UTC' })

type Change = { userId: string; name: string; role: 'admin' | 'member'; status: 'active' | 'suspended' }

export function MembersSettings({ initial, inviteInitially }: { initial: WorkspaceSettings; inviteInitially: boolean }) {
  const router = useRouter()
  const { data = initial, error: fetchError, mutate } = useSWR(`/api/workspace?workspace=${initial.workspace.id}`, fetchSettings, { fallbackData: initial, revalidateOnMount: true })
  const [tab, setTab] = useState('active')
  const [search, setSearch] = useState('')
  const [inviteOpen, setInviteOpen] = useState(inviteInitially && initial.role === 'admin')
  const [change, setChange] = useState<Change | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const canManage = data.role === 'admin' && !fetchError
  const query = search.trim().toLowerCase()
  const members = data.members.filter(member => member.status === (tab === 'suspended' ? 'suspended' : 'active') && `${member.name} ${member.email}`.toLowerCase().includes(query))
  const invitations = data.invitations.filter(invite => invite.email.includes(query))
  const counts = { active: data.members.filter(member => member.status === 'active').length, suspended: data.members.filter(member => member.status === 'suspended').length, invited: data.invitations.length }
  async function applyChange() {
    if (!change || pending) return
    setPending(true); setError(''); setNotice('')
    try {
      const result = await updateWorkspaceMember({ workspaceId: data.workspace.id, ...change })
      if (!result.ok) { setError(result.error); return }
      setChange(null); setNotice('成员信息已更新。'); await mutate()
    } catch { setError('更新失败，请重试。') }
    finally { setPending(false) }
  }
  async function revoke(id: string) {
    if (pending) return
    setPending(true); setError(''); setNotice('')
    try {
      const result = await revokeWorkspaceInvitation(data.workspace.id, id)
      if (!result.ok) { setError(result.error); return }
      setNotice('邀请已撤销，原链接已失效。'); await mutate()
    } catch { setError('撤销失败，请重试。') }
    finally { setPending(false) }
  }
  return <div className="flex min-h-dvh flex-col bg-background text-foreground md:flex-row">
    <aside className="flex shrink-0 flex-col gap-6 border-b bg-sidebar p-4 md:w-56 md:border-r md:border-b-0" aria-label="工作区设置导航">
      <Button variant="ghost" className="justify-start" nativeButton={false} render={<Link href="/" />}><ArrowLeft data-icon="inline-start" />返回工作台</Button>
      <div className="flex items-center gap-3 px-2"><div className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground"><Command className="size-4" /></div><div className="flex min-w-0 flex-col"><span className="truncate text-sm font-medium">Orvilo3</span><span className="text-xs text-muted-foreground">工作区设置</span></div></div>
      <div className="flex flex-col gap-2"><p className="px-2 text-xs text-muted-foreground">管理</p><Button variant="secondary" className="justify-start" nativeButton={false} render={<Link href={`/settings/members?workspace=${data.workspace.id}`} />} aria-current="page"><Users data-icon="inline-start" />成员</Button></div>
      <div className="mt-auto hidden flex-col gap-3 px-2 pb-2 md:flex"><Separator /><p className="text-xs leading-relaxed text-muted-foreground">在一个工作区中连接团队，让协作有序发生。</p><Link href="https://linear.app/docs/members-roles" target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-muted-foreground">Linear 成员管理参考<ExternalLink className="size-3" /></Link></div>
    </aside>
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-14 items-center gap-2 border-b px-5 text-sm md:px-8"><span className="text-muted-foreground">设置</span><ChevronRight className="size-3 text-muted-foreground" /><span className="text-muted-foreground">管理</span><ChevronRight className="size-3 text-muted-foreground" /><span>成员</span></header>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-7 px-5 py-8 md:px-10 md:py-10">
        <div className="flex flex-wrap items-start justify-between gap-4"><div className="flex flex-col gap-2"><h1 className="text-2xl font-semibold tracking-tight">成员</h1><p className="text-sm text-muted-foreground">管理工作区中的成员、邀请与访问权限。</p></div><Button disabled={!canManage} onClick={() => setInviteOpen(true)}><UserPlus data-icon="inline-start" />邀请成员</Button></div>
        <div className="flex flex-wrap items-center justify-between gap-3"><Select value={data.workspace.id} items={data.choices.map(item => ({ value: item.id, label: item.name }))} onValueChange={value => { if (value) router.push(`/settings/members?workspace=${value}`) }}><SelectTrigger aria-label="当前工作区" className="max-w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{data.choices.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectGroup></SelectContent></Select><Badge variant="outline"><Shield />{data.role === 'admin' ? '你是管理员' : '你是成员'}</Badge></div>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b pb-3"><Tabs value={tab} onValueChange={value => setTab(String(value))}><TabsList variant="line" aria-label="成员状态"><TabsTrigger value="active">成员<Badge variant="secondary">{counts.active}</Badge></TabsTrigger>{canManage && <TabsTrigger value="invited">邀请<Badge variant="secondary">{counts.invited}</Badge></TabsTrigger>}<TabsTrigger value="suspended">已停用<Badge variant="secondary">{counts.suspended}</Badge></TabsTrigger></TabsList></Tabs><div className="w-full sm:w-56"><InputGroup><InputGroupAddon><Search /></InputGroupAddon><InputGroupInput aria-label="搜索成员或邀请" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索姓名或邮箱…" /></InputGroup></div></div>
          {(error || fetchError) && <Alert variant="destructive"><AlertTitle>操作未完成</AlertTitle><AlertDescription>{error || '无法刷新成员数据，请确认权限后重试。'}</AlertDescription></Alert>}
          {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
          <Table><TableHeader><TableRow><TableHead>{tab === 'invited' ? '邮箱' : '成员'}</TableHead><TableHead>角色</TableHead><TableHead className="hidden sm:table-cell">{tab === 'invited' ? '有效期' : '加入时间'}</TableHead><TableHead><span className="sr-only">操作</span></TableHead></TableRow></TableHeader><TableBody>
            {tab === 'invited' ? invitations.map(invite => <TableRow key={invite.id}><TableCell><div className="flex flex-col gap-1"><span>{invite.email}</span><span className="text-xs text-muted-foreground">{new Date(invite.expiresAt).getTime() > Date.now() ? '待接受 · 链接邀请' : '已过期'}</span></div></TableCell><TableCell>{invite.role === 'admin' ? '管理员' : '成员'}</TableCell><TableCell className="hidden text-muted-foreground sm:table-cell">{date(invite.expiresAt)}</TableCell><TableCell className="text-right"><Button size="sm" variant="ghost" disabled={pending || !canManage} onClick={() => void revoke(invite.id)}>撤销邀请</Button></TableCell></TableRow>) : members.map(member => <TableRow key={member.userId}><TableCell><div className="flex items-center gap-3"><Avatar><AvatarFallback>{(member.name || member.email).slice(0, 2).toUpperCase()}</AvatarFallback></Avatar><div className="flex min-w-0 flex-col gap-1"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{member.name || member.email}</span>{member.userId === data.currentUserId && <span className="text-xs text-muted-foreground">你</span>}</div><span className="break-all text-xs text-muted-foreground">{member.email}</span></div></div></TableCell><TableCell>{member.role === 'admin' ? '管理员' : '成员'}</TableCell><TableCell className="hidden text-muted-foreground sm:table-cell">{date(member.createdAt)}</TableCell><TableCell className="text-right">{canManage && <DropdownMenu><DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`管理 ${member.name || member.email}`} disabled={pending} />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuGroup><DropdownMenuItem onClick={() => setChange({ userId: member.userId, name: member.name, role: member.role === 'admin' ? 'member' : 'admin', status: member.status })}>{member.role === 'admin' ? '设为成员' : '设为管理员'}</DropdownMenuItem><DropdownMenuItem onClick={() => setChange({ userId: member.userId, name: member.name, role: member.role, status: member.status === 'active' ? 'suspended' : 'active' })}>{member.status === 'active' ? '停用成员' : '恢复成员'}</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu>}</TableCell></TableRow>)}
          </TableBody></Table>
          {(tab === 'invited' ? !invitations.length : !members.length) && <Empty className="py-14"><EmptyHeader><EmptyMedia variant="icon"><Users /></EmptyMedia><EmptyTitle>{query ? '没有匹配的结果' : tab === 'invited' ? '暂无待接受的邀请' : tab === 'suspended' ? '没有已停用的成员' : '暂无成员'}</EmptyTitle><EmptyDescription>{query ? '试试其他姓名或邮箱。' : tab === 'invited' ? '点击「邀请成员」创建邮箱专属的邀请链接。' : '成员的加入和状态变化会显示在这里。'}</EmptyDescription></EmptyHeader></Empty>}
        </div>
        <Alert><Info /><AlertTitle>关于工作区权限</AlertTitle><AlertDescription>管理员可邀请成员、调整角色和停用成员。工作区始终保留至少一位管理员；停用后无法再访问此工作区成员目录。现有任务仍按任务协作者单独授权，不会因加入工作区自动公开。</AlertDescription></Alert>
        {!canManage && <p className="text-xs text-muted-foreground">仅管理员可邀请成员和更改权限。如需操作，请联系工作区管理员。</p>}
      </div>
    </main>
    <InviteMembersDialog key={data.workspace.id} workspaceId={data.workspace.id} open={inviteOpen && canManage} onOpenChange={setInviteOpen} onCreated={async () => { setTab('invited'); await mutate() }} />
    <AlertDialog open={Boolean(change)} onOpenChange={value => { if (!value && !pending) { setChange(null); setError('') } }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认更新成员权限？</AlertDialogTitle><AlertDialogDescription>将「{change?.name || '该成员'}」{change?.status === 'suspended' ? '停用。该成员将无法访问工作区成员目录；已有任务协作权限不变。' : `设置为${change?.role === 'admin' ? '管理员' : '成员'}并保持启用。`}</AlertDialogDescription></AlertDialogHeader>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<AlertDialogFooter><AlertDialogCancel disabled={pending}>取消</AlertDialogCancel><AlertDialogAction disabled={pending} onClick={() => void applyChange()}>{pending ? '正在更新…' : '确认更新'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>
}
