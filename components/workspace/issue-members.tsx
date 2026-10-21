'use client'

import { useState, type FormEvent } from 'react'
import useSWR from 'swr'
import { inviteMember, listMembers, removeMember } from '@/app/actions/collaboration'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'

export function IssueMembers({ id, defaultOpen = false }: { id: string; defaultOpen?: boolean }) {
  const { data, error, mutate } = useSWR(['members', id], () => listMembers(id), { refreshInterval: 10000 })
  const [email, setEmail] = useState('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  async function invite(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    setPending(true); setMessage('')
    try {
      const result = await inviteMember(id, email)
      if (result.error) { setMessage(result.error); return }
      setEmail(''); setMessage('成员已添加，对方登录后可在任务列表中打开此任务。'); await mutate()
    } catch { setMessage('添加失败，请稍后重试。') }
    finally { setPending(false) }
  }
  async function remove(memberId: string) {
    if (pending || !window.confirm('移除此成员的任务访问权限？已保存的贡献将保留。')) return
    setPending(true); setMessage('')
    try { await removeMember(id, memberId); await mutate() }
    catch { setMessage('移除失败，请稍后重试。') }
    finally { setPending(false) }
  }
  return <Collapsible defaultOpen={defaultOpen} render={<div className="rounded-lg border p-4" />}><CollapsibleTrigger className="cursor-pointer"><span className="text-xs font-medium">协作成员 {data ? `· ${data.members.length + 1}` : ''}</span></CollapsibleTrigger><CollapsibleContent><div className="mt-4 flex flex-col gap-4">
    <p className="text-xs leading-6 text-muted-foreground">仅所有者和获授权成员可以访问、编辑正文与评论。成员均可保存版本；只有所有者可以管理成员。</p>
    {error && <p role="alert" className="text-xs text-destructive">成员读取失败，请重试。</p>}
    {data?.members.map(member => <div key={member.id} className="flex items-center justify-between gap-3 text-xs"><div className="min-w-0"><p className="truncate font-medium">{member.name}</p><p className="truncate text-muted-foreground">{member.email}</p></div>{data.isOwner && <Button size="sm" variant="ghost" disabled={pending} onClick={() => remove(member.id)}>移除<span className="sr-only">{member.name}</span></Button>}</div>)}
    {data?.isOwner && <form onSubmit={invite} className="flex flex-col gap-3 sm:flex-row sm:items-end"><FieldGroup><Field><FieldLabel htmlFor="member-email">添加已注册成员</FieldLabel><Input id="member-email" type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="输入对方的登录邮箱" required maxLength={254} disabled={pending} /></Field></FieldGroup><Button size="sm" variant="outline" type="submit" disabled={pending}>添加成员</Button></form>}
    {message && <p role="status" className="text-xs leading-6">{message}</p>}
  </div></CollapsibleContent></Collapsible>
}
