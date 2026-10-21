'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { changeTeamMember, listTeamMembers, type loadTeamDirectory } from '@/app/actions/teams'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'

type Directory = Awaited<ReturnType<typeof loadTeamDirectory>>
export function TeamMembersSettings({ team, onUpdated }: { team: Directory['teams'][number]; onUpdated: () => void }) {
  const { data, error: readError, mutate } = useSWR(['team-members', team.id], () => listTeamMembers(team.id))
  const [adding, setAdding] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  async function change(userId: string, action: 'add' | 'remove' | 'owner' | 'member') {
    if (pending || (action === 'remove' && !window.confirm('将此成员移出团队？公开团队的工作区访问权限不受影响。'))) return
    setPending(true); setError('')
    try {
      const result = await changeTeamMember({ teamId: team.id, userId, action })
      if (!result.ok) { setError(result.error); return }
      setAdding(''); await mutate(); onUpdated()
    } catch { setError('操作失败，请重试。') }
    finally { setPending(false) }
  }
  const memberIds = new Set(data?.members.map(member => member.userId))
  const available = data?.workspaceMembers.filter(member => !memberIds.has(member.userId)) ?? []
  return <section className="flex min-w-0 flex-col gap-6" aria-label={`${team.name} · 团队成员`}><p className="text-sm leading-relaxed text-muted-foreground">负责人管理团队。加入或退出不改变工作区内的公开访问权限；停用工作区成员会撤销访问。</p>
    {readError ? <Alert variant="destructive"><AlertDescription>成员读取失败。<Button variant="ghost" size="sm" onClick={() => void mutate()}>重试</Button></AlertDescription></Alert> : !data ? <Skeleton className="h-28 w-full" /> : <>
      {data.canManage && <FieldGroup><Field><FieldLabel htmlFor="add-team-member">添加工作区成员</FieldLabel><div className="flex flex-wrap gap-2"><NativeSelect id="add-team-member" value={adding} onChange={event => setAdding(event.target.value)} disabled={pending}><NativeSelectOption value="">选择启用中的成员</NativeSelectOption>{available.map(member => <NativeSelectOption key={member.userId} value={member.userId}>{member.name} · {member.email}</NativeSelectOption>)}</NativeSelect><Button size="sm" disabled={!adding || pending} onClick={() => void change(adding, 'add')}>添加成员</Button></div></Field></FieldGroup>}
      <Table><TableHeader><TableRow><TableHead>成员</TableHead><TableHead>角色</TableHead>{data.canManage && <TableHead className="text-right">操作</TableHead>}</TableRow></TableHeader><TableBody>{data.members.map(member => <TableRow key={member.userId}><TableCell><p className="text-sm">{member.name}</p><p className="text-xs text-muted-foreground">{member.email}</p>{member.status === 'suspended' && <Badge variant="outline">工作区已停用</Badge>}</TableCell><TableCell>{member.role === 'owner' ? '负责人' : '成员'}</TableCell>{data.canManage && <TableCell><div className="flex flex-wrap justify-end gap-1"><Button size="sm" variant="ghost" disabled={pending || member.status !== 'active'} aria-label={`${member.role === 'owner' ? '设为成员' : '设为负责人'}：${member.email}`} onClick={() => void change(member.userId, member.role === 'owner' ? 'member' : 'owner')}>{member.role === 'owner' ? '设为成员' : '设为负责人'}</Button><Button size="sm" variant="ghost" disabled={pending} aria-label={`移出团队：${member.email}`} onClick={() => void change(member.userId, 'remove')}>移出</Button></div></TableCell>}</TableRow>)}</TableBody></Table>
    </>}{error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
  </section>
}
