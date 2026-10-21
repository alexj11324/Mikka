'use client'

import { useRef, useState, type FormEvent } from 'react'
import useSWR from 'swr'
import { CheckCircle2, Mail, Search, ShieldCheck, UserPlus, Users } from 'lucide-react'
import { inviteMember, listMembers, removeMember } from '@/app/actions/collaboration'
import { Badge } from '@/components/reui/badge'
import { Frame, FrameHeader, FrameTitle, FrameDescription, FramePanel, FrameFooter } from '@/components/reui/frame'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { UserAvatar } from '@/components/user-avatar'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'

type Member = Awaited<ReturnType<typeof listMembers>>['owner']

export function IssueMembers({ id }: { id: string }) {
  const { data, error, isValidating, mutate } = useSWR(['members', id], () => listMembers(id), { refreshInterval: 10000 })
  const [email, setEmail] = useState('')
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const emailInput = useRef<HTMLInputElement>(null)
  const [inviteError, setInviteError] = useState('')
  const [removeError, setRemoveError] = useState('')
  const [message, setMessage] = useState('')
  const [removing, setRemoving] = useState<Member | null>(null)

  async function invite(event: FormEvent) {
    event.preventDefault()
    if (busy.current) return
    busy.current = true
    setPending(true); setInviteError(''); setMessage('')
    try {
      const result = await inviteMember(id, email)
      if (result.error) { setInviteError(result.error); return }
      if (!result.member) throw new Error('添加失败。')
      const member = result.member
      await mutate(current => current ? { ...current, members: [...current.members.filter(item => item.id !== member.id), member] } : current, { revalidate: false })
      setEmail(''); setQuery(''); setMessage('成员已添加，对方登录后可在「协作任务」中访问此任务。')
      void mutate().catch(() => {})
    } catch { setInviteError('添加失败，请稍后重试。') }
    finally { busy.current = false; setPending(false) }
  }

  async function remove() {
    if (busy.current || !removing) return
    busy.current = true
    setPending(true); setRemoveError(''); setMessage('')
    try {
      await removeMember(id, removing.id)
      await mutate(current => current ? { ...current, members: current.members.filter(member => member.id !== removing.id) } : current, { revalidate: false })
      setMessage(`已移除 ${removing.name || removing.email} 的访问权限。`)
      setRemoving(null)
      void mutate().catch(() => {})
    } catch { setRemoveError('移除失败，请稍后重试。') }
    finally { busy.current = false; setPending(false) }
  }

  const normalizedQuery = query.trim().toLowerCase()
  const visible = data ? [data.owner, ...data.members].filter(member => `${member.name} ${member.email}`.toLowerCase().includes(normalizedQuery)) : []

  return <>
    <Frame spacing="sm">
      <FrameHeader>
        <FrameTitle className="flex items-center justify-between gap-2">任务访问权限{data && <Badge variant="secondary">{data.members.length + 1} 位成员</Badge>}</FrameTitle>
        <FrameDescription>仅所有者与已添加的成员可以访问此任务。</FrameDescription>
      </FrameHeader>
      {error && <FramePanel><Alert variant="destructive"><AlertTitle>成员列表更新失败</AlertTitle><AlertDescription>{data ? '已保留上次结果，请重试以获取最新权限。' : '暂时无法读取成员，请稍后重试。'}<Button size="sm" variant="outline" disabled={isValidating} onClick={() => { void mutate().catch(() => {}) }}>重新加载</Button></AlertDescription></Alert></FramePanel>}
      {!data && !error && <FramePanel role="status" aria-label="正在加载成员"><Skeleton className="h-10 w-full" /><Skeleton className="mt-3 h-16 w-full" /></FramePanel>}
      {data?.isOwner && <FramePanel>
        <form onSubmit={invite}>
          <FieldGroup>
            <Field data-invalid={!!inviteError}>
              <FieldLabel htmlFor="member-email">添加成员</FieldLabel>
              <InputGroup>
                <InputGroupInput ref={emailInput} id="member-email" type="email" autoComplete="email" value={email} onChange={event => { setEmail(event.target.value); setInviteError('') }} onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault() }} placeholder="输入对方的注册邮箱" required maxLength={254} disabled={pending} aria-invalid={!!inviteError} aria-describedby={inviteError ? 'member-email-error' : 'member-email-help'} />
                <InputGroupAddon><Mail /></InputGroupAddon>
              </InputGroup>
              <FieldDescription id="member-email-help">对方需先注册账号。添加后即可编辑正文、评论及保存版本，不会发送邀请邮件。</FieldDescription>
              {inviteError && <FieldError id="member-email-error">{inviteError}</FieldError>}
            </Field>
            <Button type="submit" disabled={pending || !email.trim()}>{pending && !removing ? <Spinner data-icon="inline-start" /> : <UserPlus data-icon="inline-start" />}{pending && !removing ? '正在添加…' : '添加成员'}</Button>
          </FieldGroup>
        </form>
      </FramePanel>}
      {message && <FramePanel><Alert role="status"><CheckCircle2 /><AlertTitle>操作成功</AlertTitle><AlertDescription>{message}</AlertDescription></Alert></FramePanel>}
      {data && <FramePanel className="flex flex-col gap-4">
        <FieldGroup><Field><FieldLabel htmlFor="member-search" className="sr-only">搜索成员</FieldLabel><InputGroup><InputGroupInput id="member-search" placeholder="搜索姓名或邮箱" value={query} onChange={event => setQuery(event.target.value)} /><InputGroupAddon><Search /></InputGroupAddon></InputGroup></Field></FieldGroup>
        <ItemGroup aria-label="任务成员">
          {visible.map(member => <Item key={member.id} role="listitem" size="sm" variant="outline">
            <ItemMedia><UserAvatar user={member} /></ItemMedia>
            <ItemContent className="min-w-0"><ItemTitle>{member.name || member.email}{member.id === data.currentUserId && <Badge variant="outline">你</Badge>}</ItemTitle><ItemDescription className="break-all">{member.email}</ItemDescription></ItemContent>
            <ItemActions>
              {member.id === data.owner.id ? <Badge variant="secondary"><ShieldCheck />所有者</Badge> : <Badge variant="outline">协作者</Badge>}
              {data.isOwner && member.id !== data.owner.id && <Button size="sm" variant="ghost" disabled={pending} aria-label={`移除 ${member.name || member.email}`} onClick={() => { setRemoving(member); setRemoveError('') }}>移除</Button>}
            </ItemActions>
          </Item>)}
        </ItemGroup>
        {visible.length === 0 ? <Empty><EmptyHeader><EmptyMedia variant="icon"><Search /></EmptyMedia><EmptyTitle>未找到匹配的成员</EmptyTitle><EmptyDescription>试试其他姓名或邮箱。</EmptyDescription></EmptyHeader><EmptyContent><Button size="sm" variant="outline" onClick={() => setQuery('')}>清除搜索</Button></EmptyContent></Empty> : data.members.length === 0 && !normalizedQuery && <Empty><EmptyHeader><EmptyMedia variant="icon"><Users /></EmptyMedia><EmptyTitle>邀请伙伴，一起推进任务</EmptyTitle><EmptyDescription>目前只有所有者可以访问。添加成员后，即可共同编辑与讨论。</EmptyDescription></EmptyHeader>{data.isOwner && <EmptyContent><Button size="sm" variant="outline" onClick={() => emailInput.current?.focus()}><UserPlus data-icon="inline-start" />添加第一位成员</Button></EmptyContent>}</Empty>}
      </FramePanel>}
      <FrameFooter><FrameDescription>{data && !data.isOwner ? '你可以协作编辑此任务；仅所有者可添加或移除成员。' : '仅所有者可管理成员。移除成员不会删除其已保存的内容。'}</FrameDescription></FrameFooter>
    </Frame>
    <AlertDialog open={!!removing} onOpenChange={open => { if (!open && !busy.current) { setRemoving(null); setRemoveError('') } }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>移除此成员？</AlertDialogTitle><AlertDialogDescription>{removing?.name || removing?.email} 将无法继续访问、编辑或评论此任务。已保存的内容与版本会保留，可随时重新添加。</AlertDialogDescription></AlertDialogHeader>
        {removeError && <Alert variant="destructive"><AlertTitle>移除失败</AlertTitle><AlertDescription>{removeError}</AlertDescription></Alert>}
        <AlertDialogFooter><AlertDialogCancel disabled={pending}>取消</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={pending} onClick={() => { void remove() }}>{pending && <Spinner data-icon="inline-start" />}{pending ? '正在移除…' : '确认移除'}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}
